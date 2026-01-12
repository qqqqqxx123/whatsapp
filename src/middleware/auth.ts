import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = process.env.API_KEY;

  if (!apiKey) {
    logger.warn('API_KEY not configured, allowing request');
    return next();
  }

  const providedKey = req.headers['x-api-key'] as string;

  if (!providedKey) {
    logger.warn('Missing X-API-Key header');
    return res.status(401).json({ error: 'Missing API key' });
  }

  if (providedKey !== apiKey) {
    logger.warn('Invalid API key provided');
    return res.status(403).json({ error: 'Invalid API key' });
  }

  next();
}




