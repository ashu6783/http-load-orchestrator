import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';

import testsRoutes from './routes/tests';
import { initDb, getDb } from '../infra/db';
import { initRedis, getRedis } from '../infra/redis';
import { getTestQueue } from '../queue/testQueue';
import { sendError } from '../utils/errorResponse';
import { traceIdMiddleware } from '../middleware/traceId';

dotenv.config();

// Initialize before any request or shutdown uses Redis/DB/queue
initDb();
initRedis();

const app = express();
app.use(bodyParser.json());
app.use(traceIdMiddleware);

// --------------------
// Routes
// --------------------
app.use('/tests', testsRoutes);

app.use((_req, res) => {
  sendError(res, 404, 'Not found');
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error', err);
  sendError(res, 500, 'Internal server error');
});

app.get('/health', async (_req, res) => {
  try {
    const redis = getRedis();
    await redis.ping();

    const db = getDb();
    db.prepare('SELECT 1').get();

    res.json({ status: 'ok', redis: 'ok', db: 'ok' });
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      error: err instanceof Error ? err.message : 'Health check failed'
    });
  }
});

// --------------------
// Server Startup
// --------------------
const PORT = Number(process.env.PORT) || 3000;

const server = app.listen(PORT, () => {
  console.log(`API server running on port ${PORT}`);
});

// --------------------
// Graceful Shutdown
// --------------------
const shutdown = async (signal: string) => {
  console.log(`Received ${signal}. Shutting down gracefully...`);

  try {
    // Stop accepting new jobs in queue
    await getTestQueue().close();

    // Close Redis connection
    await getRedis().quit();

    // Stop HTTP server
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  } catch (err) {
    console.error('Error during shutdown', err);
    process.exit(1);
  }
};

// Wrap for TypeScript to satisfy process.on callback type
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
