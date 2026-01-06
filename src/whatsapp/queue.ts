import { logger } from '../utils/logger';

interface QueueItem<T> {
  id: string;
  data: T;
  retries: number;
  execute: (data: T) => Promise<string>;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

export class MessageQueue {
  private queue: QueueItem<any>[] = [];
  private processing: boolean = false;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor() {
    this.maxRetries = parseInt(process.env.MAX_RETRIES || '3', 10);
    this.retryDelayMs = parseInt(process.env.RETRY_DELAY_MS || '1000', 10);
  }

  async add<T>(data: T, execute: (data: T) => Promise<string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const item: QueueItem<T> = {
        id: `${Date.now()}-${Math.random()}`,
        data,
        retries: 0,
        execute,
        resolve,
        reject,
      };

      this.queue.push(item);
      logger.debug({ queueLength: this.queue.length, itemId: item.id }, 'Message added to queue');

      this.process();
    });
  }

  private async process() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;

      try {
        const result = await this.executeWithRetry(item);
        item.resolve(result);
      } catch (error) {
        logger.error({ error, itemId: item.id, retries: item.retries }, 'Message failed after retries');
        item.reject(error instanceof Error ? error : new Error('Unknown error'));
      }
    }

    this.processing = false;
  }

  private async executeWithRetry<T>(item: QueueItem<T>): Promise<string> {
    while (item.retries <= this.maxRetries) {
      try {
        logger.debug({ itemId: item.id, attempt: item.retries + 1 }, 'Executing message');
        const result = await item.execute(item.data);
        logger.info({ itemId: item.id, result }, 'Message sent successfully');
        return result;
      } catch (error) {
        item.retries++;

        if (item.retries > this.maxRetries) {
          throw error;
        }

        // Exponential backoff
        const delay = this.retryDelayMs * Math.pow(2, item.retries - 1);
        logger.warn(
          { itemId: item.id, retry: item.retries, delay, error: String(error) },
          'Message failed, retrying'
        );

        await this.sleep(delay);
      }
    }

    throw new Error('Max retries exceeded');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  getQueueLength(): number {
    return this.queue.length;
  }
}



