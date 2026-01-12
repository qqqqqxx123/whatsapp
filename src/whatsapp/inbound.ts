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
    // Initialize webhook URL from environment variable if CRM_URL is not accessible
    // Check multiple possible env variable names
    const envWebhookUrl = process.env.INBOUND_WEBHOOK_URL 
      || process.env.N8N_WEBHOOK_INBOUND_URL 
      || process.env.CRM_WEBHOOK_URL
      || process.env.N8N_WEBHOOK_URL;
    
    logger.debug({ 
      INBOUND_WEBHOOK_URL: process.env.INBOUND_WEBHOOK_URL ? 'set' : 'not set',
      N8N_WEBHOOK_INBOUND_URL: process.env.N8N_WEBHOOK_INBOUND_URL ? 'set' : 'not set',
      CRM_WEBHOOK_URL: process.env.CRM_WEBHOOK_URL ? 'set' : 'not set',
      N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL ? 'set' : 'not set',
      found: envWebhookUrl ? 'yes' : 'no'
    }, 'Checking environment variables for webhook URL');
    
    if (envWebhookUrl) {
      this.webhookUrl = envWebhookUrl;
      logger.info({ webhookUrl: envWebhookUrl, source: 'environment variable' }, 'Webhook URL initialized from environment variable');
    } else {
      logger.warn('No webhook URL found in environment variables (checked: INBOUND_WEBHOOK_URL, N8N_WEBHOOK_INBOUND_URL, CRM_WEBHOOK_URL, N8N_WEBHOOK_URL). Will try to fetch from CRM.');
    }
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
    // Check if webhook URL is set via environment variable (highest priority - works without CRM)
    const envWebhookUrl = process.env.INBOUND_WEBHOOK_URL 
      || process.env.N8N_WEBHOOK_INBOUND_URL 
      || process.env.CRM_WEBHOOK_URL
      || process.env.N8N_WEBHOOK_URL;
    
    // If we have an env variable, use it immediately and skip CRM fetch entirely
    if (envWebhookUrl) {
      if (this.webhookUrl !== envWebhookUrl) {
        this.webhookUrl = envWebhookUrl;
        logger.info({ webhookUrl: envWebhookUrl, source: 'environment variable' }, 'Using webhook URL from environment variable (skipping CRM fetch)');
      } else {
        logger.debug('Webhook URL already set from environment variable, skipping CRM fetch');
      }
      return; // Skip CRM fetch when env variable is set
    }
    
    // Only try to fetch from CRM if no environment variable is set
    try {
      const crmUrl = process.env.CRM_URL || 'http://localhost:3000';
      const crmApiKey = process.env.CRM_API_KEY || '';
      const settingsUrl = `${crmUrl}/api/settings`;

      logger.info({ crmUrl, settingsUrl, hasApiKey: !!crmApiKey }, 'Fetching webhook URL from CRM');

      const response = await fetch(settingsUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(crmApiKey ? { 'X-API-Key': crmApiKey } : {}),
        },
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      logger.debug({ 
        status: response.status, 
        statusText: response.statusText,
        url: settingsUrl 
      }, 'CRM settings API response');

      if (response.ok) {
        const data = await response.json() as { settings?: { n8n_webhook_inbound_url?: string } };
        logger.debug({ data }, 'CRM settings data received');
        
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
          logger.warn({ settings: data.settings }, 'Webhook URL not found in CRM settings');
          if (this.webhookUrl) {
            logger.info('Clearing cached webhook URL');
            this.webhookUrl = null;
          }
        }
      } else {
        const errorText = await response.text().catch(() => 'Unable to read response body');
        logger.warn({ 
          status: response.status, 
          statusText: response.statusText,
          url: settingsUrl,
          errorBody: errorText.substring(0, 200) // First 200 chars
        }, 'Failed to fetch webhook URL from CRM');
        
        // Clear webhook URL if CRM fetch failed and no env variable is set
        if (this.webhookUrl) {
          logger.info('Clearing cached webhook URL due to CRM fetch failure');
          this.webhookUrl = null;
        }
      }
    } catch (error) {
      logger.error({ 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        crmUrl: process.env.CRM_URL 
      }, 'Error fetching webhook URL from CRM');
      
      // Clear webhook URL if CRM connection failed and no env variable is set
      if (this.webhookUrl) {
        logger.info('Clearing cached webhook URL due to CRM connection failure');
        this.webhookUrl = null;
      }
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

      // Check environment variable first (highest priority - works without CRM)
      const envWebhookUrl = process.env.INBOUND_WEBHOOK_URL 
        || process.env.N8N_WEBHOOK_INBOUND_URL 
        || process.env.CRM_WEBHOOK_URL
        || process.env.N8N_WEBHOOK_URL;
      
      if (envWebhookUrl) {
        // If env variable is set, use it directly (no need to fetch from CRM)
        if (this.webhookUrl !== envWebhookUrl) {
          this.webhookUrl = envWebhookUrl;
          logger.info({ webhookUrl: envWebhookUrl }, 'Using webhook URL from environment variable (direct mode - CRM not required)');
        }
      } else {
        // Only try to fetch from CRM if no environment variable is set
        const now = Date.now();
        if (!this.webhookUrl || (now - this.webhookUrlLastFetched) > this.WEBHOOK_REFRESH_INTERVAL_MS) {
          await this.fetchWebhookUrl();
          this.webhookUrlLastFetched = now;
        }
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
            const errorText = await response.text().catch(() => 'Unable to read response body');
            logger.error(
              { 
                messageId, 
                status: response.status, 
                statusText: response.statusText,
                errorBody: errorText.substring(0, 500),
                webhookUrl: this.webhookUrl
              },
              'Failed to forward message to CRM'
            );
          } else {
            const responseText = await response.text().catch(() => '');
            logger.info({ 
              messageId, 
              status: response.status,
              responseBody: responseText.substring(0, 200),
              webhookUrl: this.webhookUrl
            }, 'Message forwarded to CRM successfully');
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

