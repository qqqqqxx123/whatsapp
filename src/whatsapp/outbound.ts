import { proto } from '@whiskeysockets/baileys';
import { logger } from '../utils/logger';
import { auditLogger } from '../utils/audit';
import { DedupeCache } from './dedupe';

export class OutboundHandler {
  private webhookUrl: string | null = null;
  private webhookUrlLastFetched: number = 0;
  private readonly WEBHOOK_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  private readonly CRM_URL = process.env.CRM_URL || 'http://localhost:3000';
  private readonly CRM_API_KEY = process.env.CRM_API_KEY || '';
  private dedupeCache: DedupeCache;

  constructor() {
    this.dedupeCache = new DedupeCache(); // Cache size configured via DEDUPE_CACHE_SIZE env var
    // Initialize webhook URL from environment variable if CRM_URL is not accessible
    // Check multiple possible env variable names
    const envWebhookUrl = process.env.OUTBOUND_WEBHOOK_URL 
      || process.env.N8N_WEBHOOK_OUTBOUND_URL 
      || process.env.N8N_WEBHOOK_URL
      || process.env.CRM_WEBHOOK_URL;
    
    logger.debug({ 
      OUTBOUND_WEBHOOK_URL: process.env.OUTBOUND_WEBHOOK_URL ? 'set' : 'not set',
      N8N_WEBHOOK_OUTBOUND_URL: process.env.N8N_WEBHOOK_OUTBOUND_URL ? 'set' : 'not set',
      N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL ? 'set' : 'not set',
      CRM_WEBHOOK_URL: process.env.CRM_WEBHOOK_URL ? 'set' : 'not set',
      found: envWebhookUrl ? 'yes' : 'no'
    }, 'Checking environment variables for outbound webhook URL');
    
    if (envWebhookUrl) {
      this.webhookUrl = envWebhookUrl;
      logger.info({ webhookUrl: envWebhookUrl, source: 'environment variable' }, 'Outbound webhook URL initialized from environment variable');
    } else {
      logger.warn('No outbound webhook URL found in environment variables (checked: OUTBOUND_WEBHOOK_URL, N8N_WEBHOOK_OUTBOUND_URL, N8N_WEBHOOK_URL, CRM_WEBHOOK_URL). Will try to fetch from CRM.');
    }
  }

  getWebhookUrl(): string | null {
    return this.webhookUrl;
  }

  setWebhookUrl(url: string): void {
    this.webhookUrl = url;
    logger.info({ webhookUrl: url }, 'Outbound webhook URL set');
  }

  private async fetchWebhookUrl(): Promise<void> {
    // Check if webhook URL is set via environment variable (highest priority - works without CRM)
    const envWebhookUrl = process.env.OUTBOUND_WEBHOOK_URL 
      || process.env.N8N_WEBHOOK_OUTBOUND_URL 
      || process.env.N8N_WEBHOOK_URL
      || process.env.CRM_WEBHOOK_URL;
    
    // If we have an env variable, use it immediately and skip CRM fetch entirely
    if (envWebhookUrl) {
      if (this.webhookUrl !== envWebhookUrl) {
        this.webhookUrl = envWebhookUrl;
        logger.info({ webhookUrl: envWebhookUrl, source: 'environment variable' }, 'Using outbound webhook URL from environment variable (skipping CRM fetch)');
      } else {
        logger.debug('Outbound webhook URL already set from environment variable, skipping CRM fetch');
      }
      return; // Skip CRM fetch when env variable is set
    }
    
    // Only try to fetch from CRM if no environment variable is set
    try {
      const response = await fetch(`${this.CRM_URL}/api/settings`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(this.CRM_API_KEY && { 'X-API-Key': this.CRM_API_KEY }),
        },
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });

      if (response.ok) {
        const data = await response.json() as { settings?: { n8n_webhook_url?: string } };
        const webhookUrl = data.settings?.n8n_webhook_url;

        if (webhookUrl) {
          const previousUrl = this.webhookUrl;
          this.webhookUrl = webhookUrl;
          if (previousUrl !== webhookUrl) {
            logger.info({ webhookUrl, previousUrl }, 'Outbound webhook URL updated from CRM');
          } else {
            logger.debug({ webhookUrl }, 'Fetched outbound webhook URL from CRM (unchanged)');
          }
        } else {
          logger.warn('Outbound webhook URL not found in CRM settings');
          // Clear cached URL if it was removed from settings
          if (this.webhookUrl) {
            logger.info('Clearing cached outbound webhook URL');
            this.webhookUrl = null;
          }
        }
      } else {
        logger.warn({ status: response.status }, 'Failed to fetch outbound webhook URL from CRM');
        // Clear webhook URL if CRM fetch failed and no env variable is set
        if (this.webhookUrl) {
          logger.info('Clearing cached outbound webhook URL due to CRM fetch failure');
          this.webhookUrl = null;
        }
      }
    } catch (error) {
      logger.error({ error }, 'Error fetching outbound webhook URL from CRM');
      // Clear webhook URL if CRM connection failed and no env variable is set
      if (this.webhookUrl) {
        logger.info('Clearing cached outbound webhook URL due to CRM connection failure');
        this.webhookUrl = null;
      }
    }
  }

  async refreshWebhookUrl(): Promise<void> {
    logger.info('Refreshing outbound webhook URL from CRM');
    await this.fetchWebhookUrl();
    this.webhookUrlLastFetched = Date.now();
  }

  async handleBaileysMessage(message: proto.IWebMessageInfo): Promise<void> {
    try {
      const messageId = message.key.id || '';
      const toJid = message.key.remoteJid || '';
      const messageText = message.message?.conversation || 
                         message.message?.extendedTextMessage?.text || 
                         '';
      const timestamp = message.messageTimestamp && typeof message.messageTimestamp === 'number'
        ? new Date(message.messageTimestamp * 1000).toISOString()
        : new Date().toISOString();
      
      // Skip if message is to a group (g.us) or status broadcast
      if (toJid.includes('@g.us') || toJid.includes('@broadcast')) {
        return;
      }

      // Deduplication check
      if (this.dedupeCache.has(messageId)) {
        logger.debug({ messageId }, 'Duplicate outbound message ignored');
        return;
      }

      this.dedupeCache.add(messageId);

      // Extract phone number from Baileys JID (format: phone@s.whatsapp.net)
      const phoneNumber = toJid.split('@')[0];

      // Normalize to E.164 format (add + if not present)
      const phoneE164 = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;

      logger.info({ messageId, to: phoneE164 }, 'Processing outbound message from mobile device');

      // Check environment variable first (highest priority - works without CRM)
      const envWebhookUrl = process.env.OUTBOUND_WEBHOOK_URL 
        || process.env.N8N_WEBHOOK_OUTBOUND_URL 
        || process.env.N8N_WEBHOOK_URL
        || process.env.CRM_WEBHOOK_URL;
      
      if (envWebhookUrl) {
        // If env variable is set, use it directly (no need to fetch from CRM)
        if (this.webhookUrl !== envWebhookUrl) {
          this.webhookUrl = envWebhookUrl;
          logger.info({ webhookUrl: envWebhookUrl }, 'Using outbound webhook URL from environment variable (direct mode - CRM not required)');
        }
      } else {
        // Only try to fetch from CRM if no environment variable is set
        const now = Date.now();
        if (!this.webhookUrl || (now - this.webhookUrlLastFetched) > this.WEBHOOK_REFRESH_INTERVAL_MS) {
          await this.fetchWebhookUrl();
          this.webhookUrlLastFetched = now;
        }
      }

      // First, save message to CRM database via API
      try {
        const crmSaveResponse = await fetch(`${this.CRM_URL}/api/whatsapp/outbound`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.CRM_API_KEY && { 'X-API-Key': this.CRM_API_KEY }),
          },
          body: JSON.stringify({
            from: phoneE164, // This is actually "to" since it's outbound
            body: messageText,
            message: messageText,
            message_id: messageId,
            timestamp,
            type: 'text',
            phone_e164: phoneE164,
            direction: 'out',
          }),
          signal: AbortSignal.timeout(10000), // 10 second timeout
        });

        if (!crmSaveResponse.ok) {
          logger.warn(
            { messageId, status: crmSaveResponse.status },
            'Failed to save outbound message to CRM database'
          );
        } else {
          logger.info({ messageId }, 'Outbound message saved to CRM database');
        }
      } catch (saveError) {
        logger.error({ error: saveError, messageId }, 'Error saving outbound message to CRM');
      }

      // Forward to outbound webhook if configured
      if (this.webhookUrl) {
        const webhookPayload = {
          action: 'message_sent',
          direction: 'out',
          from: phoneE164, // This is actually "to" since it's outbound
          body: messageText,
          message: messageText,
          message_id: messageId,
          timestamp,
          type: 'text',
          phone_e164: phoneE164,
          provider: 'wa-bridge-mobile',
        };

        try {
          const response = await fetch(this.webhookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(webhookPayload),
            signal: AbortSignal.timeout(10000), // 10 second timeout
          });

          if (!response.ok) {
            logger.error(
              { messageId, status: response.status, statusText: response.statusText },
              'Failed to forward outbound message to webhook'
            );
          } else {
            logger.info({ messageId }, 'Outbound message forwarded to webhook successfully');
          }

          await auditLogger.log('outbound', {
            messageId,
            to: phoneE164,
            success: response.ok,
            status: response.status,
          });
        } catch (error) {
          logger.error({ error, messageId }, 'Error forwarding outbound message to webhook');
          await auditLogger.log('outbound', {
            messageId,
            to: phoneE164,
            success: false,
            error: String(error),
          });
        }
      } else {
        logger.warn('Outbound webhook URL not configured, message not forwarded');
        await auditLogger.log('outbound', {
          messageId,
          to: phoneE164,
          success: false,
          error: 'Webhook URL not configured',
        });
      }
    } catch (error) {
      logger.error({ error }, 'Error handling outbound message');
      throw error;
    }
  }
}

