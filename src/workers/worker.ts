import { Worker, Job } from 'bullmq';
import crypto from 'crypto';
import qs from 'qs';
import { Pool } from 'pg';

import { initRedis, getRedis } from '../infra/redis';
import { initDb, getDb, closeDb } from '../infra/db';
import { axiosInstance } from '../utils/axios';
import { safeParseJson } from '../utils/json';
import { recoverOrphanedTestsIfSafe } from '../utils/recovery';
import { envInt } from '../utils/env';
import { TestRow } from '../types/db';

const PROGRESS_TTL = 3600;
/** 15s: 10s max request (axios) + ~50% buffer for DB writes, re-queue, worker pickup */
const STALENESS_MS = 15_000;
const WORKER_CONCURRENCY = envInt('WORKER_CONCURRENCY', 10);

let workerInstance: Worker | null = null;
let redisConnection: ReturnType<typeof getRedis> | null = null;

interface LoadTestJob {
  testId: string;
  traceId?: string;
}

async function writeMetricsForSlice(
  db: Pool,
  testId: string,
  slice: { status: number; ms: number; success: boolean }[]
) {
  if (slice.length === 0) return;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const r of slice) {
      await client.query(
        `INSERT INTO metrics
         (id, test_id, status_code, response_ms, success, error_msg, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          crypto.randomUUID(),
          testId,
          r.status,
          r.ms,
          r.success ? 1 : 0,
          r.success ? null : 'Request failed',
          new Date().toISOString()
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function runWorker() {
  await initDb();
  initRedis();

  const redis = getRedis();
  redisConnection = redis;
  const db = getDb();

  const worker = new Worker(
    'loadTests',
    async (job: Job<LoadTestJob>) => {
      const { testId, traceId = '' } = job.data;
      const PROGRESS_KEY = `test:${testId}:progress`;

      const testRes = await db.query('SELECT * FROM tests WHERE id = $1', [testId]);
      const test = testRes.rows[0] as TestRow | undefined;
      if (!test) {
        throw new Error(`Test ${testId} not found`);
      }

      // Staleness: if last checkpoint was too long ago, mark test failed and don't run
      if (test.status === 'RUNNING' && test.last_checkpoint_at) {
        const lastCheckpointMs = new Date(test.last_checkpoint_at).getTime();
        if (Date.now() - lastCheckpointMs > STALENESS_MS) {
          const now = new Date().toISOString();
          await db.query('UPDATE tests SET status = $1, completed_at = $2 WHERE id = $3', [
            'FAILED',
            now,
            testId
          ]);
          try {
            await redis.del(PROGRESS_KEY);
          } catch {
            // ignore
          }
          console.log(`[traceId=${traceId}] Test marked FAILED (stale) testId=${testId}`);
          return { totalRequests: test.completed_requests ?? 0, stale: true };
        }
      }

      // Resume point: from Redis or DB
      let startOffset = 0;
      try {
        const progressRaw = await redis.get(PROGRESS_KEY);
        if (progressRaw) {
          const progress = JSON.parse(progressRaw) as { completedRequests?: number };
          startOffset = progress.completedRequests ?? 0;
        } else if (test.completed_requests != null && test.completed_requests > 0) {
          startOffset = test.completed_requests;
        }
      } catch {
        // use startOffset 0
      }

      if (startOffset >= test.request_count) {
        const now = new Date().toISOString();
        await db.query('UPDATE tests SET status = $1, completed_at = $2 WHERE id = $3', [
          'COMPLETED',
          now,
          testId
        ]);
        try {
          await redis.del(PROGRESS_KEY);
        } catch {
          // ignore
        }
        console.log(`[traceId=${traceId}] Test already complete testId=${testId}`);
        return { totalRequests: test.request_count };
      }

      console.log(`[traceId=${traceId}] Job started testId=${testId} startOffset=${startOffset}`);
      await db.query('UPDATE tests SET status = $1 WHERE id = $2', ['RUNNING', testId]);

      const headers = safeParseJson<Record<string, string>>(test.headers, {});
      const payload = safeParseJson<any>(test.payload, null);

      const contentType =
        headers['Content-Type'] ||
        headers['content-type'] ||
        'application/json';

      let requestData: any = payload;

      if (
        payload &&
        contentType.includes('application/x-www-form-urlencoded')
      ) {
        requestData = qs.stringify(payload);
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }

      const responses: {
        status: number;
        ms: number;
        success: boolean;
      }[] = [];

      let lastWrittenMetricIndex = 0;
      let inFlight: Promise<void>[] = [];

      const checkpoint = async (totalCompleted: number, totalFailed: number) => {
        const now = new Date().toISOString();
        try {
          await redis.set(
            PROGRESS_KEY,
            JSON.stringify({ completedRequests: totalCompleted, failedRequests: totalFailed }),
            'EX',
            PROGRESS_TTL
          );
        } catch (err) {
          console.warn(`[traceId=${traceId}] Failed to update Redis progress testId=${testId}`, err);
        }
        await db.query('UPDATE tests SET last_checkpoint_at = $1, completed_requests = $2 WHERE id = $3', [
          now,
          totalCompleted,
          testId
        ]);
      };

      for (let i = startOffset; i < test.request_count; i++) {
        const p = (async () => {
          const start = Date.now();
          try {
            const res = await axiosInstance({
              url: test.url,
              method: test.method as any,
              headers,
              data: requestData
            });

            responses.push({
              status: res.status,
              ms: Date.now() - start,
              success: true
            });
          } catch {
            responses.push({
              status: 0,
              ms: Date.now() - start,
              success: false
            });
          }
        })();

        inFlight.push(p);

        if (inFlight.length >= test.concurrency) {
          await Promise.race(inFlight);
          inFlight = inFlight.filter(Boolean);
        }

        const totalCompleted = startOffset + responses.length;
        const totalFailed = responses.filter((r) => !r.success).length;
        if (responses.length - lastWrittenMetricIndex >= test.concurrency) {
          await writeMetricsForSlice(db, testId, responses.slice(lastWrittenMetricIndex, responses.length));
          lastWrittenMetricIndex = responses.length;
          await checkpoint(totalCompleted, totalFailed);
        }
      }

      await Promise.all(inFlight);

      const totalCompleted = startOffset + responses.length;
      const totalFailed = responses.filter((r) => !r.success).length;
      if (lastWrittenMetricIndex < responses.length) {
        await writeMetricsForSlice(db, testId, responses.slice(lastWrittenMetricIndex, responses.length));
      }
      await checkpoint(totalCompleted, totalFailed);

      const now = new Date().toISOString();
      await db.query('UPDATE tests SET status = $1, completed_at = $2 WHERE id = $3', [
        'COMPLETED',
        now,
        testId
      ]);

      try {
        await redis.del(PROGRESS_KEY);
      } catch (err) {
        console.warn(`[traceId=${traceId}] Failed to delete progress for testId=${testId}`, err);
      }

      console.log(`[traceId=${traceId}] Job completed testId=${testId} totalRequests=${totalCompleted}`);
      return { totalRequests: totalCompleted };
    },
    {
      connection: redis,
      concurrency: WORKER_CONCURRENCY,
      lockDuration: 600_000, // 10 minutes (load tests can run long)
      lockRenewTime: 120_000 // renew every 2 minutes
    }
  );

  workerInstance = worker;

  try {
    await recoverOrphanedTestsIfSafe();
  } catch (err) {
    console.error('Orphaned test recovery failed', err);
  }

  console.log(`Worker started with concurrency=${WORKER_CONCURRENCY}`);

  worker.on('completed', (job) => {
    console.log(`Load test ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[traceId=${job?.data?.traceId}] Job failed testId=${job?.data?.testId}`, err);
  });
}

async function shutdown(signal: string) {
  console.log(`Worker received ${signal}. Shutting down gracefully...`);
  try {
    if (workerInstance) await workerInstance.close();
    if (redisConnection) await redisConnection.quit();
    await closeDb();
    process.exit(0);
  } catch (err) {
    console.error('Error during worker shutdown', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

runWorker().catch((err) => {
  console.error('Worker failed to start', err);
  process.exit(1);
});
