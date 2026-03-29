import type { NextFunction, Request, Response } from 'express';

const RATE_LIMIT_MESSAGE = 'Too many test submissions, please try again later';
const BUCKET_CAPACITY = 5;
const REFILL_WINDOW_MS = 60 * 1000;
const REFILL_RATE_PER_MS = BUCKET_CAPACITY / REFILL_WINDOW_MS;

type TokenBucket = {
  tokens: number;
  lastRefillAtMs: number;
};

const buckets = new Map<string, TokenBucket>();

function getRateLimitKey(req: Request): string {
  const userIdHeader = req.headers['x-user-id'];
  if (typeof userIdHeader === 'string' && userIdHeader.length > 0) return userIdHeader;
  if (Array.isArray(userIdHeader) && userIdHeader.length > 0) return userIdHeader[0] ?? 'anonymous';
  return req.ip ?? req.socket.remoteAddress ?? 'anonymous';
}

function getRemainingTokens(key: string): TokenBucket {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket) {
    const initialBucket: TokenBucket = { tokens: BUCKET_CAPACITY, lastRefillAtMs: now };
    buckets.set(key, initialBucket);
    return initialBucket;
  }

  const elapsedMs = Math.max(0, now - bucket.lastRefillAtMs);
  const refilledTokens = Math.min(BUCKET_CAPACITY, bucket.tokens + elapsedMs * REFILL_RATE_PER_MS);
  bucket.tokens = refilledTokens;
  bucket.lastRefillAtMs = now;
  return bucket;
}

export function testSubmissionLimiter(req: Request, res: Response, next: NextFunction): void {
  const key = getRateLimitKey(req);
  const bucket = getRemainingTokens(key);

  if (bucket.tokens < 1) {
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
    return;
  }

  bucket.tokens -= 1;
  next();
}