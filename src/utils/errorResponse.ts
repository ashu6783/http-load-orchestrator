import { Response } from 'express';

export function sendError(res: Response, statusCode: number, message: string): void {
  res.status(statusCode).json({ error: message });
}