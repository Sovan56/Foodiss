import http from 'http';
import crypto from 'crypto';
import path from 'path';
import { exec } from 'child_process';

import app from './src/app.js';
import { config } from './src/config/env.js';
import { validateConfig } from './src/config/validateEnv.js';
import { connectDB, disconnectDB } from './src/config/db.js';
import { connectRedis, closeRedis } from './src/config/redis.js';
import { initSocket } from './src/config/socket.js';
import { initializeQueues, closeBullMQConnection } from './src/queues/index.js';
import { expireExpiredOffers } from './src/modules/food/admin/services/admin.service.js';
import { syncExpiredFssaiNotifications } from './src/modules/food/restaurant/services/fssaiExpiry.service.js';

import { logger } from './src/utils/logger.js';
import { initializeFirebaseRealtime } from './src/config/firebase.js';
import { ensureUploadStorageReady } from './src/services/storage.service.js';

const SHUTDOWN_TIMEOUT_MS = 10000;
let server = null;
let expireOffersInterval = null;
let fssaiExpiryInterval = null;
let stuckOrdersInterval = null;

const gracefulShutdown = async (signal) => {
    logger.info(`${signal} received, starting graceful shutdown`);
    if (!server) {
        process.exit(0);
        return;
    }
    server.close(async () => {
        try {
            await disconnectDB();
            await closeRedis();
            await closeBullMQConnection();
            if (expireOffersInterval) clearInterval(expireOffersInterval);
            if (fssaiExpiryInterval) clearInterval(fssaiExpiryInterval);
            if (stuckOrdersInterval) clearInterval(stuckOrdersInterval);
            logger.info('Graceful shutdown complete');
            process.exit(0);
        } catch (err) {
            logger.error(`Shutdown error: ${err.message}`);
            process.exit(1);
        }
    });
    setTimeout(() => {
        logger.error('Shutdown timeout, forcing exit');
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
};

const startBackgroundJobs = async () => {
    if (!config.serverBackgroundJobsEnabled) {
        logger.info('Server background jobs are disabled for this process.');
        return;
    }

    try {
        const { recoverStuckOrders } = await import('./src/modules/food/orders/services/order.service.js');
        await recoverStuckOrders();
        stuckOrdersInterval = setInterval(async () => {
            try {
                await recoverStuckOrders();
            } catch (err) {
                logger.error(`Watchdog recovery periodic error: ${err.message}`);
            }
        }, 2 * 60 * 1000);
    } catch (err) {
        logger.error(`Watchdog startup error: ${err.message}`);
    }

    const runExpire = async () => {
        try {
            await expireExpiredOffers();
        } catch (err) {
            logger.error(`Expire offers error: ${err.message}`);
        }
    };
    await runExpire();
    expireOffersInterval = setInterval(runExpire, 5 * 60 * 1000);

    const runFssaiExpirySync = async () => {
        try {
            await syncExpiredFssaiNotifications();
        } catch (err) {
            logger.error(`FSSAI expiry sync error: ${err.message}`);
        }
    };
    await runFssaiExpirySync();
    fssaiExpiryInterval = setInterval(runFssaiExpirySync, 60 * 60 * 1000);
};

const startServer = async () => {
    try {
        validateConfig();
        initializeFirebaseRealtime();

        await ensureUploadStorageReady();
        logger.info(`Upload storage ready at ${path.resolve(config.uploadStorageRoot)}`);

        await connectDB();

        const httpServer = http.createServer(app);

        await initSocket(httpServer);

        if (config.redisEnabled) {
            await connectRedis();
        }

        if (config.bullmqEnabled && config.redisEnabled && config.serverQueueBootstrapEnabled) {
            try {
                initializeQueues();
            } catch (err) {
                logger.error(`BullMQ initialization error (server continues): ${err.message}`);
            }
        } else if (config.bullmqEnabled && !config.redisEnabled) {
            logger.warn('BullMQ is enabled but Redis is disabled. Queue initialization skipped.');
        } else if (config.bullmqEnabled && !config.serverQueueBootstrapEnabled) {
            logger.info('BullMQ queue bootstrap disabled for this server process.');
        }

        app.post('/api/deploy', (req, res) => {
            const signature = req.headers['x-hub-signature-256'];
            const secret = 'mysecret123';

            const hash = 'sha256=' + crypto
                .createHmac('sha256', secret)
                .update(JSON.stringify(req.body))
                .digest('hex');

            if (signature !== hash) {
                return res.status(403).send('Unauthorized');
            }

            exec('cd ~ && ./deploy.sh', (err, stdout) => {
                if (err) {
                    console.error(err);
                    return res.send('Deploy failed');
                }

                console.log(stdout);
                res.send('Deploy success');
            });
        });

        server = httpServer.listen(config.port, config.host, () => {
            logger.info(`Server running in ${config.nodeEnv} mode on ${config.host}:${config.port}`);
            console.log(`Server URL http://localhost:${config.port}`);
        });

        await startBackgroundJobs();

        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                logger.error(`Port ${config.port} is already in use. Please kill the process or use a different port.`);
            } else {
                logger.error(`Server Error: ${err.message}`);
            }
            process.exit(1);
        });

        process.on('unhandledRejection', (err) => {
            logger.error(`Unhandled Rejection: ${err?.message || err}`);
            if (config.nodeEnv === 'production') {
                if (server) server.close(() => process.exit(1));
                else process.exit(1);
            }
        });

        process.on('uncaughtException', (err) => {
            logger.error(`Uncaught Exception: ${err?.message || err}`);
            if (config.nodeEnv === 'production') {
                process.exit(1);
            }
        });

    } catch (error) {
        logger.error(`Error starting server: ${error.message}`);
        process.exit(1);
    }
};

startServer();
