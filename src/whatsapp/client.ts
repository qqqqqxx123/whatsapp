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
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { readdir, unlink } from 'fs/promises';

export interface SendMessageOptions {
  to: string;
  text?: string;
  template?: any;
}

export class WhatsAppClient {
  private sock: WASocket | null = null;
  private qrCode: string | null = null;
  private qrExpiresAt: Date | null = null;
  private phoneNumber: string | null = null;
  private isConnected: boolean = false;
  private messageQueue: MessageQueue;
  private inboundHandler: InboundHandler;
  private authStatePath: string;

  constructor() {
    this.messageQueue = new MessageQueue();
    this.inboundHandler = new InboundHandler();
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

    // Handle incoming messages
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const message of messages) {
        // Skip if message is from us
        if (message.key.fromMe) continue;

        try {
          await this.inboundHandler.handleBaileysMessage(message);
        } catch (error) {
          logger.error({ error, messageId: message.key.id }, 'Failed to handle inbound message');
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

    const { to, text } = options;

    if (!text) {
      throw new Error('Text is required');
    }

    // Normalize phone number from E.164 format (+852...) to Baileys JID format
    // Remove + and any non-digit characters
    const normalizedPhone = to.replace(/[^\d]/g, '');
    
    // Baileys JID format: phone@s.whatsapp.net (for individual) or phone@g.us (for groups)
    // We'll use @s.whatsapp.net for individual messages
    const jid = `${normalizedPhone}@s.whatsapp.net`;

    try {
      const result = await this.sock.sendMessage(jid, { text });

      // Extract message ID from Baileys response
      // Baileys returns the message key which has id property
      const messageId = result?.key?.id || `${Date.now()}-${Math.random()}`;

      return messageId;
    } catch (error) {
      logger.error({ error, to, jid }, 'Failed to execute send');
      throw error;
    }
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
    await this.inboundHandler.refreshWebhookUrl();
  }
}
