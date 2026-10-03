import { rateLimit } from 'express-rate-limit';

// Per-IP limiter. Counters live in memory, so use a shared store if the app runs on several instances
export const createLimiter = ({ windowMs, limit, message = 'Too many requests, please try again later' }) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: message },
  });

// Baseline for every route: 300 requests per 15 minutes
export const globalLimiter = createLimiter({ windowMs: 15 * 60 * 1000, limit: 300 });

// Strict limiter for the public contact form: 5 messages per hour
export const contactLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: 'Too many messages, please try again later',
});

// Use on upload routes (e.g. router.post('/', uploadLimiter, ...)): 20 per hour
export const uploadLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  message: 'Too many uploads, please try again later',
});
