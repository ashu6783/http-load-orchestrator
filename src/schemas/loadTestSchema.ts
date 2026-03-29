import { z } from 'zod';
import { envInt } from '../utils/env';

const MAX_REQUEST_COUNT = envInt('LOADTEST_MAX_REQUEST_COUNT', 100_000);
const MAX_CONCURRENCY = envInt('LOADTEST_MAX_CONCURRENCY', 1000);

export const LoadTestSchema = z.object({
  url: z.string().url({ message: 'Invalid URL format' }),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
  headers: z.record(z.string(), z.string()).optional().default({}),
  payload: z.any().optional().default(null),
  requestCount: z
    .number()
    .int()
    .positive()
    .max(MAX_REQUEST_COUNT, { message: `requestCount must be at most ${MAX_REQUEST_COUNT}` }),
  concurrency: z
    .number()
    .int()
    .positive()
    .max(MAX_CONCURRENCY, { message: `concurrency must be at most ${MAX_CONCURRENCY}` })
});