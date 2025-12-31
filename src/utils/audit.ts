import { createClient } from '@supabase/supabase-js';
import { logger } from './logger';

interface AuditLogEntry {
  event_type: string;
  metadata: Record<string, any>;
  success: boolean;
  timestamp: string;
}

class AuditLogger {
  private supabase: ReturnType<typeof createClient> | null = null;
  private enabled: boolean = false;

  constructor() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

    if (supabaseUrl && supabaseKey) {
      this.supabase = createClient(supabaseUrl, supabaseKey);
      this.enabled = true;
      logger.info('Audit logging enabled');
    } else {
      logger.warn('Audit logging disabled: SUPABASE_URL or SUPABASE_SERVICE_KEY not set');
    }
  }

  async log(eventType: string, metadata: Record<string, any>): Promise<void> {
    if (!this.enabled || !this.supabase) {
      return;
    }

    try {
      const entry: AuditLogEntry = {
        event_type: eventType,
        metadata,
        success: metadata.success !== false,
        timestamp: new Date().toISOString(),
      };

      const { error } = await this.supabase.from('message_events').insert(entry as any);

      if (error) {
        logger.error({ error, eventType }, 'Failed to log audit event');
      } else {
        logger.debug({ eventType }, 'Audit event logged');
      }
    } catch (error) {
      logger.error({ error, eventType }, 'Error logging audit event');
    }
  }
}

export const auditLogger = new AuditLogger();

