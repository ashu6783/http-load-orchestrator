import { Request, Response } from 'express';
import crypto from 'crypto';
import { LoadTestSchema } from '../../schemas/loadTestSchema';
import { generateFingerprint } from '../../utils/fingerprint';
import { addTestToQueue } from '../../queue/testQueue';
import { getDb } from '../../infra/db';
import { getRedis } from '../../infra/redis';
import { TestRow } from '../../types/db';
import { computeAggregatedMetrics } from '../../utils/metricsAggregation';
import { sendError } from '../../utils/errorResponse';

// POST /tests
export const submitTest = async (req: Request, res: Response) => {
  const traceId = (req as any).traceId ?? crypto.randomUUID();
  const parseResult = LoadTestSchema.safeParse(req.body);
  if (!parseResult.success) {
    const message =
      parseResult.error.issues.map((issue: { message?: string }) => issue.message ?? 'Invalid value').join('; ') ||
      'Validation failed';
    return sendError(res, 400, message);
  }

  const { url, method, headers, payload, requestCount, concurrency } = parseResult.data;

  try {
    const db = getDb();
    const redis = getRedis();
    const userId = (req.headers['x-user-id'] as string) || 'anonymous';

    const fingerprint = generateFingerprint(userId, {
      url,
      method,
      headers: headers ?? {},
      payload: payload ?? null,
      requestCount,
      concurrency
    });

    // Idempotency check (avoid duplicate submissions within 1 min)
    const existingTestId = await redis.get(fingerprint);
    if (existingTestId) {
      return res.status(200).json({
        testId: existingTestId,
        message: 'Duplicate submission ignored'
      });
    }

    const testId = crypto.randomUUID();

    // Insert test into DB
    const stmt = db.prepare(`
      INSERT INTO tests 
        (id, url, method, headers, payload, request_count, concurrency, status, created_at, completed_at, trace_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      testId,
      url,
      method,
      headers ? JSON.stringify(headers) : null,
      payload != null ? JSON.stringify(payload) : null,
      requestCount,
      concurrency,
      'PENDING',
      new Date().toISOString(),
      null,
      traceId
    );

    // Store fingerprint in Redis for idempotency (expires in 60s)
    await redis.set(fingerprint, testId, 'EX', 60);

    // Queue the test
    await addTestToQueue({ testId, traceId });
    console.log(`[traceId=%s] Test created and queued testId=%s`, traceId, testId);

    return res.status(202).json({ testId, message: 'Test queued successfully' });
  } catch (err) {
    console.error('[traceId=%s] Submit test failed', traceId, err);
    return sendError(res, 500, err instanceof Error ? err.message : 'Failed to submit test');
  }
};

// GET /tests/:id
export const getTestById = async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const testStmt = db.prepare('SELECT * FROM tests WHERE id = ?');
    const test = testStmt.get(req.params.id) as TestRow | undefined;

    if (!test) return sendError(res, 404, 'Test not found');

    const base = {
      testId: test.id,
      status: test.status,
      createdAt: test.created_at,
      completedAt: test.completed_at,
      ...(test.trace_id && { traceId: test.trace_id })
    };

    if (test.status === 'RUNNING' || test.status === 'PENDING') {
      let completedRequests = 0;
      let failedRequests = 0;
      try {
        const redis = getRedis();
        const progressRaw = await redis.get(`test:${test.id}:progress`);
        if (progressRaw) {
          const progress = JSON.parse(progressRaw) as { completedRequests?: number; failedRequests?: number };
          completedRequests = progress.completedRequests ?? 0;
          failedRequests = progress.failedRequests ?? 0;
        }
      } catch {
        // Fall back to 0,0 if Redis read fails
      }
      return res.json({
        ...base,
        progress: {
          totalRequests: test.request_count,
          completedRequests,
          failedRequests
        }
      });
    }

    // COMPLETED: aggregate from metrics
    const aggStmt = db.prepare(`
      SELECT
        COUNT(*) as total_requests,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
        SUM(response_ms) as sum_response_ms
      FROM metrics
      WHERE test_id = ?
    `);
    const row = aggStmt.get(test.id) as {
      total_requests: number;
      success_count: number;
      sum_response_ms: number;
    };

    const totalRequests = row?.total_requests ?? 0;
    const successCount = row?.success_count ?? 0;
    const sumResponseMs = row?.sum_response_ms ?? 0;

    const metrics = computeAggregatedMetrics(
      totalRequests,
      successCount,
      sumResponseMs,
      test.created_at,
      test.completed_at
    );

    return res.json({
      ...base,
      metrics: metrics ?? {
        totalRequests: 0,
        successRate: 0,
        errorRate: 0,
        avgResponseMs: 0,
        throughput: 0
      }
    });
  } catch (err) {
    console.error('getTestById failed', req.params.id, err);
    return sendError(res, 500, err instanceof Error ? err.message : 'Failed to fetch test');
  }
};


// GET /tests
export const listTests = async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const {
      method,
      url,
      minErrorRate,
      maxErrorRate,
      minThroughput,
      maxThroughput
    } = req.query;

    let query = `
      SELECT
        t.id,
        t.url,
        t.method,
        t.status,
        t.created_at,
        t.completed_at,
        COUNT(m.id) as total_requests,
        SUM(CASE WHEN m.success = 1 THEN 1 ELSE 0 END) as success_count,
        SUM(m.response_ms) as sum_response_ms
      FROM tests t
      LEFT JOIN metrics m ON m.test_id = t.id
      WHERE 1=1
    `;
    const params: (string | number)[] = [];

    if (method && typeof method === 'string') {
      query += ' AND t.method = ?';
      params.push(method);
    }
    if (url && typeof url === 'string') {
      query += ' AND t.url = ?';
      params.push(url);
    }

    query += ' GROUP BY t.id';

    const stmt = db.prepare(query);
    const rows = stmt.all(...params) as Array<{
      id: string;
      url: string;
      method: string;
      status: string;
      created_at: string;
      completed_at: string | null;
      total_requests: number;
      success_count: number;
      sum_response_ms: number;
    }>;

    let list = rows.map((t) => {
      const totalRequests = t.total_requests ?? 0;
      const successCount = t.success_count ?? 0;
      const sumResponseMs = t.sum_response_ms ?? 0;
      const agg = computeAggregatedMetrics(
        totalRequests,
        successCount,
        sumResponseMs,
        t.created_at,
        t.completed_at
      );
      return {
        testId: t.id,
        url: t.url,
        method: t.method,
        status: t.status,
        errorRate: agg?.errorRate ?? null,
        throughput: agg?.throughput ?? null,
        createdAt: t.created_at,
        completedAt: t.completed_at
      };
    });

    const minEr = minErrorRate != null ? Number(minErrorRate) : null;
    const maxEr = maxErrorRate != null ? Number(maxErrorRate) : null;
    const minTh = minThroughput != null ? Number(minThroughput) : null;
    const maxTh = maxThroughput != null ? Number(maxThroughput) : null;

    if (minEr != null && !Number.isNaN(minEr)) {
      list = list.filter((t) => t.errorRate != null && t.errorRate >= minEr);
    }
    if (maxEr != null && !Number.isNaN(maxEr)) {
      list = list.filter((t) => t.errorRate != null && t.errorRate <= maxEr);
    }
    if (minTh != null && !Number.isNaN(minTh)) {
      list = list.filter((t) => t.throughput != null && t.throughput >= minTh);
    }
    if (maxTh != null && !Number.isNaN(maxTh)) {
      list = list.filter((t) => t.throughput != null && t.throughput <= maxTh);
    }

    return res.json(list);
  } catch (err) {
    console.error('listTests failed', err);
    return sendError(res, 500, err instanceof Error ? err.message : 'Failed to list tests');
  }
};

