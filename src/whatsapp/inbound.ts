import { proto } from '@whiskeysockets/baileys';
import { logger } from '../utils/logger';
import { auditLogger } from '../utils/audit';
import { DedupeCache } from './dedupe';

export class InboundHandler {
  private webhookUrl: string | null = null;
  private webhookUrlLastFetched: number = 0;
  private dedupeCache: DedupeCache;
  private readonly WEBHOOK_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // Refresh every 5 minutes

  constructor() {
    this.dedupeCache = new DedupeCache();
  }

  setWebhookUrl(url: string): void {
    this.webhookUrl = url;
    logger.info({ webhookUrl: url }, 'CRM webhook URL set');
  }

  getWebhookUrl(): string | null {
    return this.webhookUrl;
  }

  async refreshWebhookUrl(): Promise<void> {
    this.webhookUrlLastFetched = 0; // Force refresh
    await this.fetchWebhookUrl();
    this.webhookUrlLastFetched = Date.now();
  }

  private async fetchWebhookUrl(): Promise<void> {
    try {
      const crmUrl = process.env.CRM_URL || 'http://localhost:3000';
      const crmApiKey = process.env.CRM_API_KEY || '';

      const response = await fetch(`${crmUrl}/api/settings`, {
        headers: crmApiKey ? { 'X-API-Key': crmApiKey } : {},
      });

      if (response.ok) {
        const data = await response.json() as { settings?: { n8n_webhook_inbound_url?: string } };
        const webhookUrl = data.settings?.n8n_webhook_inbound_url;

        if (webhookUrl) {
          const previousUrl = this.webhookUrl;
          this.webhookUrl = webhookUrl;
          if (previousUrl !== webhookUrl) {
            logger.info({ webhookUrl, previousUrl }, 'Webhook URL updated from CRM');
          } else {
            logger.debug({ webhookUrl }, 'Fetched webhook URL from CRM (unchanged)');
          }
        } else {
          logger.warn('Webhook URL not found in CRM settings');
          // Clear cached URL if it was removed from settings
          if (this.webhookUrl) {
            logger.info('Clearing cached webhook URL');
            this.webhookUrl = null;
          }
        }
      } else {
        logger.warn({ status: response.status }, 'Failed to fetch webhook URL from CRM');
      }
    } catch (error) {
      logger.error({ error }, 'Error fetching webhook URL from CRM');
    }
  }

  async handleBaileysMessage(message: proto.IWebMessageInfo): Promise<void> {
    try {
      const messageId = message.key.id || '';
      const fromJid = message.key.remoteJid || '';
      const messageText = message.message?.conversation || 
                         message.message?.extendedTextMessage?.text || 
                         '';
      const timestamp = message.messageTimestamp && typeof message.messageTimestamp === 'number'
        ? new Date(message.messageTimestamp * 1000).toISOString()
        : new Date().toISOString();
      
      // Skip if message is from a group (g.us) or status broadcast
      if (fromJid.includes('@g.us') || fromJid.includes('@broadcast')) {
        return;
      }

      // Deduplication check
      if (this.dedupeCache.has(messageId)) {
        logger.debug({ messageId }, 'Duplicate message ignored');
        return;
      }

      this.dedupeCache.add(messageId);

      // Extract phone number from Baileys JID (format: phone@s.whatsapp.net)
      const phoneNumber = fromJid.split('@')[0];

      // Normalize to E.164 format (add + if not present)
      const phoneE164 = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;

      // Map to CRM format
      const crmMessage = {
        provider: 'baileys',
        from: phoneE164,
        body: messageText,
        message: messageText, // Alternative field name
        message_id: messageId,
        timestamp,
        type: 'text',
        phone_e164: phoneE164,
      };

      logger.info({ messageId, from: phoneE164 }, 'Processing inbound message');

      // Always fetch latest webhook URL from CRM (refresh every 5 minutes or if not set)
      const now = Date.now();
      if (!this.webhookUrl || (now - this.webhookUrlLastFetched) > this.WEBHOOK_REFRESH_INTERVAL_MS) {
        await this.fetchWebhookUrl();
        this.webhookUrlLastFetched = now;
      }

      // Forward to CRM webhook if configured
      if (this.webhookUrl) {
        try {
          const response = await fetch(this.webhookUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(crmMessage),
            signal: AbortSignal.timeout(10000), // 10 second timeout
          });

          if (!response.ok) {
            logger.error(
              { messageId, status: response.status, statusText: response.statusText },
              'Failed to forward message to CRM'
            );
          } else {
            logger.info({ messageId }, 'Message forwarded to CRM successfully');
          }

          await auditLogger.log('inbound', {
            messageId,
            from: phoneE164,
            success: response.ok,
            status: response.status,
          });
        } catch (error) {
          logger.error({ error, messageId }, 'Error forwarding message to CRM');
          await auditLogger.log('inbound', {
            messageId,
            from: phoneE164,
            success: false,
            error: String(error),
          });
        }
      } else {
        logger.warn('CRM webhook URL not configured, message not forwarded');
        await auditLogger.log('inbound', {
          messageId,
          from: phoneE164,
          success: false,
          error: 'Webhook URL not configured',
        });
      }
    } catch (error) {
      logger.error({ error }, 'Error handling inbound message');
      throw error;
    }
  }
}

