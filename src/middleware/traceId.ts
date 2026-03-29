import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

declare global {
  namespace Express {
    interface Request {
      traceId?: string;
    }
  }
}

export function traceIdMiddleware(req: Request, _res: Response, next: NextFunction) {
  const id = (req.headers['x-request-id'] as string) || (req.headers['x-trace-id'] as string) || crypto.randomUUID();
  req.traceId = id;
  next();
}