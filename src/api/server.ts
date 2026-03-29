import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';

import testsRoutes from './routes/tests';
import { initDb, getDb, closeDb } from '../infra/db';
import { initRedis, getRedis } from '../infra/redis';
import { getTestQueue } from '../queue/testQueue';
import { sendError } from '../utils/errorResponse';
import { traceIdMiddleware } from '../middleware/traceId';

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(traceIdMiddleware);

// --------------------
// Routes
// --------------------
app.use('/tests', testsRoutes);

app.get('/health', async (_req, res) => {
  try {
    const redis = getRedis();
    await redis.ping();

    const db = getDb();
    await db.query('SELECT 1');

    res.json({ status: 'ok', redis: 'ok', db: 'ok' });
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      error: err instanceof Error ? err.message : 'Health check failed'
    });
  }
});

app.use((_req, res) => {
  sendError(res, 404, 'Not found');
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error', err);
  sendError(res, 500, 'Internal server error');
});

// --------------------
// Server Startup
// --------------------
const PORT = Number(process.env.PORT) || 3000;

async function main() {
  await initDb();
  initRedis();

  const server = app.listen(PORT, () => {
    console.log(`API server running on port ${PORT}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}. Shutting down gracefully...`);

    try {
      await getTestQueue().close();
      await getRedis().quit();
      await closeDb();

      server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
      });
    } catch (err) {
      console.error('Error during shutdown', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Failed to start API server', err);
  process.exit(1);
});
