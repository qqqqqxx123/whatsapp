import { logger } from '../utils/logger';

interface CacheEntry {
  messageId: string;
  timestamp: number;
}

export class DedupeCache {
  private cache: Map<string, CacheEntry>;
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor() {
    this.maxSize = parseInt(process.env.DEDUPE_CACHE_SIZE || '1000', 10);
    this.ttlMs = parseInt(process.env.DEDUPE_TTL_MS || '3600000', 10); // 1 hour default

    this.cache = new Map();

    // Cleanup old entries every 5 minutes
    setInterval(() => {
      this.cleanup();
    }, 5 * 60 * 1000);
  }

  has(messageId: string): boolean {
    const entry = this.cache.get(messageId);

    if (!entry) {
      return false;
    }

    // Check if expired
    const age = Date.now() - entry.timestamp;
    if (age > this.ttlMs) {
      this.cache.delete(messageId);
      return false;
    }

    return true;
  }

  add(messageId: string): void {
    // If cache is full, remove oldest entry
    if (this.cache.size >= this.maxSize) {
      const oldest = Array.from(this.cache.entries()).sort(
        (a, b) => a[1].timestamp - b[1].timestamp
      )[0];
      if (oldest) {
        this.cache.delete(oldest[0]);
      }
    }

    this.cache.set(messageId, {
      messageId,
      timestamp: Date.now(),
    });
  }

  private cleanup(): void {
    const now = Date.now();
    let removed = 0;

    for (const [messageId, entry] of this.cache.entries()) {
      const age = now - entry.timestamp;
      if (age > this.ttlMs) {
        this.cache.delete(messageId);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug({ removed, remaining: this.cache.size }, 'Cleaned up expired dedupe entries');
    }
  }

  getSize(): number {
    return this.cache.size;
  }
}


