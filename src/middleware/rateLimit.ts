import rateLimit from 'express-rate-limit';
import { logger } from '../utils/logger';

const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const maxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '20', 10);

export const rateLimiter = rateLimit({
  windowMs,
  max: maxRequests,
  message: 'Too many requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn({ ip: req.ip }, 'Rate limit exceeded');
    res.status(429).json({
      error: 'Rate limit exceeded',
      message: `Maximum ${maxRequests} requests per ${windowMs / 1000} seconds`,
    });
  },
});



