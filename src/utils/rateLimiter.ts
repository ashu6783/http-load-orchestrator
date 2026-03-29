import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const RATE_LIMIT_MESSAGE = 'Too many test submissions, please try again later';

export const testSubmissionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: RATE_LIMIT_MESSAGE,
  keyGenerator: (req) => {
    const userId = req.headers['x-user-id'];
    if (userId && typeof userId === 'string') return userId;
    return ipKeyGenerator(req.ip ?? 'anonymous');
  },
  handler: (req, res) => {
    res.status(429).json({ error: RATE_LIMIT_MESSAGE });
  }
});