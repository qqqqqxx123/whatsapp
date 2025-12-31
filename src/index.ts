import 'dotenv/config';
import express from 'express';
import { WhatsAppClient } from './whatsapp/client';
import { apiKeyAuth } from './middleware/auth';
import { rateLimiter } from './middleware/rateLimit';
import { logger } from './utils/logger';
import { auditLogger } from './utils/audit';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || '';

if (!API_KEY) {
  logger.warn('API_KEY not set. Service will be insecure!');
}

// Initialize WhatsApp client
const whatsappClient = new WhatsAppClient();

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Get QR code for connection
app.get('/qr', apiKeyAuth, async (req, res) => {
  try {
    const { qr, expiresAt } = await whatsappClient.getQR();
    res.json({ qr, expiresAt });
  } catch (error) {
    logger.error({ error }, 'Failed to get QR code');
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Get connection status
app.get('/status', apiKeyAuth, async (req, res) => {
  try {
    const status = await whatsappClient.getStatus();
    res.json(status);
  } catch (error) {
    logger.error({ error }, 'Failed to get status');
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// Disconnect WhatsApp
app.post('/disconnect', apiKeyAuth, async (req, res) => {
  try {
    await whatsappClient.disconnect();
    await auditLogger.log('disconnect', { success: true });
    res.json({ success: true, message: 'Disconnected successfully' });
  } catch (error) {
    logger.error({ error }, 'Failed to disconnect');
    await auditLogger.log('disconnect', { success: false, error: String(error) });
    res.status(500).json({ error: 'Failed to disconnect' });
  }
});

// Send message
app.post('/send', apiKeyAuth, rateLimiter, async (req, res) => {
  try {
    const { to, text, template } = req.body;

    if (!to) {
      return res.status(400).json({ error: 'Missing required field: to' });
    }

    if (!text && !template) {
      return res.status(400).json({ error: 'Either text or template is required' });
    }

    // Start sending (queued)
    const messageId = await whatsappClient.sendMessage({
      to,
      text,
      template,
    });

    await auditLogger.log('send', {
      to,
      messageId,
      hasText: !!text,
      hasTemplate: !!template,
    });

    res.json({
      success: true,
      messageId,
    });
  } catch (error) {
    logger.error({ error, body: req.body }, 'Failed to send message');
    await auditLogger.log('send', {
      success: false,
      error: String(error),
      to: req.body.to,
    });
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to send message' });
  }
});

// Start server
app.listen(PORT, () => {
  logger.info(`wa-bridge server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await whatsappClient.disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await whatsappClient.disconnect();
  process.exit(0);
});

