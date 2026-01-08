import makeWASocket, {
  ConnectionState,
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  proto,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { logger } from '../utils/logger';
import { MessageQueue } from './queue';
import { InboundHandler } from './inbound';
import { OutboundHandler } from './outbound';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { readdir, unlink } from 'fs/promises';

export interface SendMessageOptions {
  to: string;
  text?: string;
  template?: {
    name: string;
    language: string;
    variables?: string[];
  };
}

export class WhatsAppClient {
  private sock: WASocket | null = null;
  private qrCode: string | null = null;
  private qrExpiresAt: Date | null = null;
  private phoneNumber: string | null = null;
  private isConnected: boolean = false;
  private messageQueue: MessageQueue;
  private inboundHandler: InboundHandler;
  private outboundHandler: OutboundHandler;
  private authStatePath: string;

  constructor() {
    this.messageQueue = new MessageQueue();
    this.inboundHandler = new InboundHandler();
    this.outboundHandler = new OutboundHandler();
    const sessionDir = process.env.SESSION_DIR || './sessions';
    this.authStatePath = join(sessionDir, 'baileys-auth');
    
    // Ensure session directory exists
    if (!existsSync(this.authStatePath)) {
      mkdirSync(this.authStatePath, { recursive: true });
    }
    
    this.initializeClient();
  }

  private async initializeClient() {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authStatePath);
      const { version } = await fetchLatestBaileysVersion();

      this.sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: logger.child({ name: 'baileys' }),
      });

      this.setupEventHandlers(saveCreds);
    } catch (error) {
      logger.error({ error }, 'Failed to initialize Baileys client');
    }
  }

  private setupEventHandlers(saveCreds: () => Promise<void>) {
    if (!this.sock) return;

    // Save credentials when they update
    this.sock.ev.on('creds.update', saveCreds);

    // Connection state updates
    this.sock.ev.on('connection.update', (update: Partial<ConnectionState>) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info('QR code generated');
        this.qrCode = qr;
        this.qrExpiresAt = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes
      }

      if (connection === 'close') {
        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
        
        logger.warn(
          { 
            shouldReconnect,
            statusCode: (lastDisconnect?.error as Boom)?.output?.statusCode,
            error: lastDisconnect?.error 
          },
          'Connection closed'
        );

        this.isConnected = false;
        this.phoneNumber = null;
        this.qrCode = null;
        this.qrExpiresAt = null;

        if (shouldReconnect) {
          logger.info('Reconnecting...');
          this.initializeClient();
        }
      } else if (connection === 'open') {
        logger.info('WhatsApp connected');
        this.isConnected = true;
        this.qrCode = null;
        this.qrExpiresAt = null;

        // Get phone number from socket
        if (this.sock?.user) {
          this.phoneNumber = this.sock.user.id.split(':')[0]; // Extract phone number from JID
        }
      } else if (connection === 'connecting') {
        logger.info('Connecting to WhatsApp...');
        this.isConnected = false;
      }
    });

    // Handle incoming and outgoing messages
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const message of messages) {
        try {
          if (message.key.fromMe) {
            // Outbound message (sent from mobile device)
            await this.outboundHandler.handleBaileysMessage(message);
          } else {
            // Inbound message (received on mobile device)
            await this.inboundHandler.handleBaileysMessage(message);
          }
        } catch (error) {
          const direction = message.key.fromMe ? 'outbound' : 'inbound';
          logger.error({ error, messageId: message.key.id, direction }, `Failed to handle ${direction} message`);
        }
      }
    });
  }

  async getQR(): Promise<{ qr: string; expiresAt: string | null }> {
    // If QR exists and not expired, return it
    if (this.qrCode && this.qrExpiresAt && this.qrExpiresAt > new Date()) {
      return {
        qr: this.qrCode,
        expiresAt: this.qrExpiresAt.toISOString(),
      };
    }

    // If already connected, return error
    if (this.isConnected) {
      throw new Error('Already connected. Disconnect first to generate new QR.');
    }

    // If socket not initialized, initialize it
    if (!this.sock) {
      await this.initializeClient();
    }

    // Wait for QR (with timeout)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('QR code generation timeout'));
      }, 30000); // 30 seconds

      const connectionHandler = (update: Partial<ConnectionState>) => {
        if (update.qr) {
          clearTimeout(timeout);
          this.sock?.ev.off('connection.update', connectionHandler);
          this.qrCode = update.qr;
          this.qrExpiresAt = new Date(Date.now() + 2 * 60 * 1000);
          resolve({
            qr: update.qr,
            expiresAt: this.qrExpiresAt.toISOString(),
          });
        } else if (update.connection === 'open') {
          clearTimeout(timeout);
          this.sock?.ev.off('connection.update', connectionHandler);
          reject(new Error('Already connected'));
        }
      };

      if (this.qrCode && this.qrExpiresAt && this.qrExpiresAt > new Date()) {
        clearTimeout(timeout);
        resolve({
          qr: this.qrCode,
          expiresAt: this.qrExpiresAt.toISOString(),
        });
        return;
      }

      this.sock?.ev.on('connection.update', connectionHandler);
    });
  }

  async getStatus(): Promise<{ connected: boolean; phoneNumber?: string }> {
    return {
      connected: this.isConnected,
      phoneNumber: this.phoneNumber || undefined,
    };
  }

  async sendMessage(options: SendMessageOptions): Promise<string> {
    if (!this.sock) {
      throw new Error('WhatsApp client not initialized');
    }

    if (!this.isConnected) {
      const status = await this.getStatus();
      if (!status.connected) {
        throw new Error('WhatsApp not connected. Please connect first.');
      }
    }

    // Add to queue for processing
    return this.messageQueue.add(options, async (opts) => {
      return this.executeSend(opts);
    });
  }

  private async executeSend(options: SendMessageOptions): Promise<string> {
    if (!this.sock) {
      throw new Error('WhatsApp client not initialized');
    }

    const { to, text, template } = options;

    // Normalize phone number from E.164 format (+852...) to Baileys JID format
    // Remove + and any non-digit characters
    const normalizedPhone = to.replace(/[^\d]/g, '');
    
    // Baileys JID format: phone@s.whatsapp.net (for individual) or phone@g.us (for groups)
    // We'll use @s.whatsapp.net for individual messages
    const jid = `${normalizedPhone}@s.whatsapp.net`;

    try {
      let result;

      if (template) {
        // Fetch template from CRM API
        const templateData = await this.fetchTemplate(template.name, template.language);
        if (!templateData) {
          throw new Error(`Template ${template.name} (${template.language}) not found`);
        }

        // Build message with images and buttons
        result = await this.sendTemplateMessage(jid, templateData, template.variables || []);
      } else if (text) {
        // Simple text message
        result = await this.sock.sendMessage(jid, { text });
      } else {
        throw new Error('Either text or template is required');
      }

      // Extract message ID from Baileys response
      const messageId = result?.key?.id || `${Date.now()}-${Math.random()}`;

      return messageId;
    } catch (error) {
      logger.error({ error, to, jid }, 'Failed to execute send');
      throw error;
    }
  }

  private async fetchTemplate(name: string, language: string): Promise<any> {
    const CRM_URL = process.env.CRM_URL || 'http://localhost:3000';
    const CRM_API_KEY = process.env.CRM_API_KEY || '';

    try {
      const response = await fetch(
        `${CRM_URL}/api/whatsapp/templates?name=${encodeURIComponent(name)}&language=${encodeURIComponent(language)}&is_custom=true`,
        {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(CRM_API_KEY && { 'X-API-Key': CRM_API_KEY }),
          },
          signal: AbortSignal.timeout(10000), // 10 second timeout
        }
      );

      if (!response.ok) {
        logger.warn({ name, language, status: response.status }, 'Failed to fetch template from CRM');
        return null;
      }

      const data = await response.json();
      const templates = data.templates || [];
      
      // Find exact match
      const template = templates.find((t: any) => t.name === name && t.language === language);
      
      if (!template) {
        logger.warn({ name, language }, 'Template not found in CRM');
        return null;
      }

      return template;
    } catch (error) {
      logger.error({ error, name, language }, 'Error fetching template from CRM');
      return null;
    }
  }

  private async sendTemplateMessage(jid: string, template: any, variables: string[]): Promise<proto.WebMessageInfo> {
    if (!this.sock) {
      throw new Error('WhatsApp client not initialized');
    }

    // Sort components: BUTTONS, HEADER, BODY
    const sortedComponents = (template.components || []).sort((a: any, b: any) => {
      const order = { BUTTONS: 0, HEADER: 1, BODY: 2 };
      return (order[a.type as keyof typeof order] || 999) - (order[b.type as keyof typeof order] || 999);
    });

    // Build message parts
    const messageParts: any[] = [];
    let bodyText = '';
    let headerText = '';
    const images: string[] = [];
    const buttons: Array<{ type: 'URL' | 'PHONE_NUMBER'; text: string; url?: string; phone_number?: string }> = [];

    // Process components
    for (const component of sortedComponents) {
      if (component.type === 'HEADER') {
        headerText = this.replaceVariables(component.text || '', variables);
      } else if (component.type === 'BODY') {
        bodyText = this.replaceVariables(component.text || '', variables);
        
        // Collect images from component.images or image1-image8 columns
        if (component.format === 'IMAGE') {
          if (component.images && component.images.length > 0) {
            images.push(...component.images);
          } else {
            // Get from image1-image8 columns
            for (let i = 1; i <= 8; i++) {
              const imageField = `image${i}` as keyof typeof template;
              const imageUrl = template[imageField] as string | undefined;
              if (imageUrl) {
                images.push(imageUrl);
              }
            }
          }
        }
      } else if (component.type === 'BUTTONS') {
        // Get buttons from component or button1-button2 columns
        if (component.buttons && component.buttons.length > 0) {
          buttons.push(...component.buttons);
        } else {
          if (template.button1_text && template.button1_type) {
            buttons.push({
              type: template.button1_type,
              text: template.button1_text,
              url: template.button1_url,
              phone_number: template.button1_phone,
            });
          }
          if (template.button2_text && template.button2_type) {
            buttons.push({
              type: template.button2_type,
              text: template.button2_text,
              url: template.button2_url,
              phone_number: template.button2_phone,
            });
          }
        }
      }
    }

    // Build Baileys message
    // If we have images, send them first, then text, then buttons
    if (images.length > 0) {
      // Send first image with caption (header + body text)
      const caption = [headerText, bodyText].filter(Boolean).join('\n\n');
      
      // Download and send image
      const imageUrl = images[0];
      const imageBuffer = await this.downloadImage(imageUrl);
      
      if (imageBuffer) {
        const result = await this.sock.sendMessage(jid, {
          image: imageBuffer,
          caption: caption || undefined,
        });
        
        // Send remaining images if any
        for (let i = 1; i < images.length; i++) {
          const imgBuffer = await this.downloadImage(images[i]);
          if (imgBuffer) {
            await this.sock.sendMessage(jid, {
              image: imgBuffer,
            });
          }
        }
        
        // Send buttons as separate text message if any
        if (buttons.length > 0) {
          const buttonTexts = buttons.map(btn => {
            if (btn.type === 'URL' && btn.url) {
              return `${btn.text}\n${btn.url}`;
            } else if (btn.type === 'PHONE_NUMBER' && btn.phone_number) {
              return `${btn.text}\n${btn.phone_number}`;
            }
            return btn.text;
          });
          await this.sock.sendMessage(jid, { 
            text: buttonTexts.join('\n\n') 
          });
        }
        
        return result;
      }
    }

    // If no images, send text message with buttons
    let fullText = [headerText, bodyText].filter(Boolean).join('\n\n');
    
    // Append buttons as clickable text
    if (buttons.length > 0) {
      const buttonTexts = buttons.map(btn => {
        if (btn.type === 'URL' && btn.url) {
          return `${btn.text}\n${btn.url}`;
        } else if (btn.type === 'PHONE_NUMBER' && btn.phone_number) {
          return `${btn.text}\n${btn.phone_number}`;
        }
        return btn.text;
      });
      fullText += '\n\n' + buttonTexts.join('\n\n');
    }

    // Simple text message (buttons are included as text with URLs/phone numbers)
    const result = await this.sock.sendMessage(jid, { text: fullText });
    return result;
  }

  private async downloadImage(url: string): Promise<Buffer | null> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        logger.warn({ url, status: response.status }, 'Failed to download image');
        return null;
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (error) {
      logger.error({ error, url }, 'Error downloading image');
      return null;
    }
  }


  private replaceVariables(text: string, variables: string[]): string {
    let result = text;
    variables.forEach((value, index) => {
      const placeholder = `{{${index + 1}}}`;
      result = result.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value);
    });
    return result;
  }

  async disconnect(): Promise<void> {
    if (this.sock) {
      try {
        await this.sock.logout();
        this.sock.end(undefined);
      } catch (error) {
        logger.error({ error }, 'Error during disconnect');
      }
    }

    this.isConnected = false;
    this.phoneNumber = null;
    this.qrCode = null;
    this.qrExpiresAt = null;
    this.sock = null;

    // Clear auth state for fresh connection
    try {
      const files = await readdir(this.authStatePath);
      await Promise.all(
        files.map((file) => unlink(join(this.authStatePath, file)))
      );
      logger.info('Auth state cleared');
    } catch (error) {
      logger.error({ error }, 'Error clearing auth state');
    }

    // Reinitialize for next connection
    await this.initializeClient();
  }

  // Get CRM webhook URL (to be called by inbound handler)
  getCRMWebhookUrl(): string | null {
    return this.inboundHandler.getWebhookUrl();
  }

  setCRMWebhookUrl(url: string): void {
    this.inboundHandler.setWebhookUrl(url);
  }

  // Refresh webhook URL from CRM settings
  async refreshCRMWebhookUrl(): Promise<void> {
    await Promise.all([
      this.inboundHandler.refreshWebhookUrl(),
      this.outboundHandler.refreshWebhookUrl(),
    ]);
  }
}
