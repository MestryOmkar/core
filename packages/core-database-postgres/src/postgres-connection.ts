import { app } from "@arkecosystem/core-container";
import { Database, EventEmitter, Logger } from "@arkecosystem/core-interfaces";
import { roundCalculator } from "@arkecosystem/core-utils";
import { models } from "@arkecosystem/crypto";
import fs from "fs";
import chunk from "lodash/chunk";
import path from "path";
import pgPromise from "pg-promise";
import { migrations } from "./migrations";
import { Model } from "./models";
import { repositories } from "./repositories";
import { MigrationsRepository } from "./repositories/migrations";
import { SPV } from "./spv";
import { QueryExecutor } from "./sql/query-executor";
import { camelizeColumns } from "./utils";

export class PostgresConnection implements Database.IDatabaseConnection {

    public logger = app.resolvePlugin<Logger.ILogger>("logger");
    public models: { [key: string]: Model } = {};
    public query: QueryExecutor;
    public db: any;
    public blocksRepository: Database.IBlocksRepository;
    public roundsRepository: Database.IRoundsRepository;
    public transactionsRepository: Database.ITransactionsRepository;
    public walletsRepository: Database.IWalletsRepository;
    public pgp: any;
    private emitter = app.resolvePlugin<EventEmitter.EventEmitter>("event-emitter");
    private migrationsRepository : MigrationsRepository;
    private cache: Map<any, any>;
    private queuedQueries: any[];


    public constructor(readonly options: any, private walletManager: Database.IWalletManager) {

    }


    public async buildWallets(height: number) {
        const spvPath = `${process.env.CORE_PATH_CACHE}/spv.json`;

        if (fs.existsSync(spvPath)) {
            (fs as any).removeSync(spvPath);

            this.logger.info("Ark Core ended unexpectedly - resuming from where we left off :runner:");

            return true;
        }

        try {
            const spv = new SPV(this.query, this.walletManager);
            return await spv.build(height);
        } catch (error) {
            this.logger.error(error.stack);
        }

        return false;
    }

    public async commitQueuedQueries() {
        if (!this.queuedQueries || this.queuedQueries.length === 0) {
            return;
        }

        this.logger.debug("Committing database transactions.");

        try {
            await this.db.tx(t => t.batch(this.queuedQueries));
        } catch (error) {
            this.logger.error(error);

            throw error;
        } finally {
            this.queuedQueries = null;
        }
    }

    public async connect() {

        this.emitter.emit(Database.DatabaseEvents.PRE_CONNECT);
        const initialization = {
            receive(data, result, e) {
                camelizeColumns(pgp, data);
            },
            extend(object) {
                for (const repository of Object.keys(repositories)) {
                    object[repository] = new repositories[repository](object, pgp);
                }
            },
        };

        const pgp = pgPromise({ ...this.options.initialization, ...initialization });

        this.pgp = pgp;
        this.db = this.pgp(this.options.connection);
    }

    public async deleteBlock(block: models.Block) {
        try {
            const queries = [this.transactionsRepository.deleteByBlockId(block.data.id), this.blocksRepository.delete(block.data.id)];

            await this.db.tx(t => t.batch(queries));
        } catch (error) {
            this.logger.error(error.stack);

            throw error;
        }
    }

    public async disconnect() {
        this.logger.debug("Disconnecting from database");
        this.emitter.emit(Database.DatabaseEvents.PRE_DISCONNECT);

        try {
            await this.commitQueuedQueries();
            this.cache.clear();
        } catch (error) {
            this.logger.warn("Issue in commiting blocks, database might be corrupted");
            this.logger.warn(error.message);
        }

        await this.pgp.end();
        this.emitter.emit(Database.DatabaseEvents.POST_DISCONNECT);
        this.logger.debug("Disconnected from database");
    }

    public enqueueDeleteBlock(block: models.Block): any {
        const queries = [this.transactionsRepository.deleteByBlockId(block.data.id), this.blocksRepository.delete(block.data.id)];

        this.enqueueQueries(queries);
    }

    public enqueueDeleteRound(height: number): any {
        const { round, nextRound, maxDelegates } = roundCalculator.calculateRound(height);

        if (nextRound === round + 1 && height >= maxDelegates) {
            this.enqueueQueries([this.roundsRepository.delete(nextRound)]);
        }
    }

    public enqueueSaveBlock(block: models.Block): any {
        const queries = [this.blocksRepository.insert(block.data)];

        if (block.transactions.length > 0) {
            queries.push(this.transactionsRepository.insert(block.transactions));
        }

        this.enqueueQueries(queries);
    }

    public async make(): Promise<Database.IDatabaseConnection> {
        if (this.db) {
            throw new Error("Database connection already initialised");
        }

        this.logger.debug("Connecting to database");

        this.queuedQueries = null;
        this.cache = new Map();

        try {
            await this.connect();
            this.exposeRepositories();
            await this.registerQueryExecutor();
            await this.runMigrations();
            await this.registerModels();
            this.logger.debug("Connected to database.");
            this.emitter.emit(Database.DatabaseEvents.POST_CONNECT);

            return this;
        } catch (error) {
            app.forceExit("Unable to connect to the database!", error);
        }

        return null;
    }

    public async saveBlock(block: models.Block) {
        try {
            const queries = [this.blocksRepository.insert(block.data)];

            if (block.transactions.length > 0) {
                queries.push(this.transactionsRepository.insert(block.transactions));
            }

            await this.db.tx(t => t.batch(queries));
        } catch (err) {
            this.logger.error(err.message);
        }
    }

    public async saveWallets(wallets: any[], force?: boolean) {
        if (force) {
            // all wallets to be updated, performance is better without upsert
            await this.walletsRepository.truncate();

            try {
                const chunks = chunk(wallets, 5000).map(c => this.walletsRepository.insert(c)); // this 5000 figure should be configurable...
                await this.db.tx(t => t.batch(chunks));
            } catch (error) {
                this.logger.error(error.stack);
            }
        } else {
            // NOTE: The list of delegates is calculated in-memory against the WalletManager,
            // so it is safe to perform the costly UPSERT non-blocking during round change only:
            // 'await saveWallets(false)' -> 'saveWallets(false)'
            try {
                const queries = wallets.map(wallet => this.walletsRepository.updateOrCreate(wallet));
                await this.db.tx(t => t.batch(queries));
            } catch (error) {
                this.logger.error(error.stack);
            }
        }
    }

    /**
     * Run all migrations.
     * @return {void}
     */

    private async runMigrations() {
        for (const migration of migrations) {
            const { name } = path.parse(migration.file);

            if (name === "20180304100000-create-migrations-table") {
                await this.query.none(migration);
            } else {
                const row = await this.migrationsRepository.findByName(name);

                if (row === null) {
                    this.logger.debug(`Migrating ${name}`);

                    await this.query.none(migration);

                    await this.migrationsRepository.insert({ name });
                }
            }
        }
    }


    /**
     * Register all models.
     * @return {void}
     */
    private async registerModels() {
        for (const [key, Value] of Object.entries(require("./models"))) {
            this.models[key.toLowerCase()] = new (Value as any)(this.pgp);
        }
    }

    /**
     * Register the query builder.
     * @return {void}
     */
    private registerQueryExecutor() {
        this.query = new QueryExecutor(this);
    }

    private enqueueQueries(queries) {
        if (!this.queuedQueries) {
            this.queuedQueries = [];
        }

        (this.queuedQueries as any).push(...queries);
    }

    private exposeRepositories() {
        this.blocksRepository = this.db.blocks;
        this.transactionsRepository = this.db.transactions;
        this.roundsRepository = this.db.rounds;
        this.walletsRepository = this.db.wallets;
        this.migrationsRepository = this.db.migrations;
    }
}
