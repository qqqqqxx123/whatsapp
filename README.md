# wa-bridge

WhatsApp Web bridge service for Ring CRM. This service handles WhatsApp Web connections using `@whatsapp/web.js` and provides a REST API for the CRM to interact with WhatsApp.

## Features

- ✅ Real WhatsApp Web QR code generation
- ✅ Persistent session management
- ✅ Inbound message forwarding to CRM
- ✅ Outbound message sending with queue
- ✅ API key authentication
- ✅ Rate limiting
- ✅ Message deduplication
- ✅ Audit logging to Supabase
- ✅ Retry logic with exponential backoff

## Architecture

wa-bridge runs as a separate Node.js service (not on Vercel serverless). It maintains a persistent WhatsApp Web session and provides REST endpoints for the CRM.

## Prerequisites

- Node.js 20+
- Docker (optional, for containerized deployment)
- Supabase account (for audit logging)

## Installation

### Local Development

1. Install dependencies:
```bash
npm install
```

2. Copy `.env.example` to `.env` and configure:
```bash
cp .env.example .env
```

3. Configure environment variables (see Configuration section)

4. Run in development mode:
```bash
npm run dev
```

5. Build for production:
```bash
npm run build
npm start
```

### Docker Deployment

1. Build the image:
```bash
docker build -t wa-bridge .
```

2. Run the container:
```bash
docker run -d \
  --name wa-bridge \
  -p 3001:3001 \
  -v $(pwd)/sessions:/app/sessions \
  --env-file .env \
  wa-bridge
```

## Configuration

### Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|---------|
| `PORT` | Server port | No | `3001` |
| `NODE_ENV` | Environment | No | `production` |
| `API_KEY` | API key for authentication | **Yes** | - |
| `SUPABASE_URL` | Supabase project URL | No | - |
| `SUPABASE_SERVICE_KEY` | Supabase service role key | No | - |
| `SESSION_DIR` | Directory for WhatsApp sessions | No | `./sessions` |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window | No | `60000` |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window | No | `20` |
| `MAX_RETRIES` | Max retry attempts | No | `3` |
| `RETRY_DELAY_MS` | Initial retry delay | No | `1000` |
| `DEDUPE_CACHE_SIZE` | Dedupe cache size | No | `1000` |
| `DEDUPE_TTL_MS` | Dedupe TTL | No | `3600000` |
| `CRM_URL` | CRM base URL (for fetching webhook) | No | `http://localhost:3000` |
| `CRM_API_KEY` | CRM API key (optional) | No | - |

## API Endpoints

### `GET /health`
Health check endpoint (no auth required).

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### `GET /qr`
Get QR code for WhatsApp connection.

**Headers:**
- `X-API-Key`: API key

**Response:**
```json
{
  "qr": "QR_CODE_STRING",
  "expiresAt": "2024-01-01T00:02:00.000Z"
}
```

### `GET /status`
Get connection status.

**Headers:**
- `X-API-Key`: API key

**Response:**
```json
{
  "connected": true,
  "phoneNumber": "+1234567890"
}
```

### `POST /disconnect`
Disconnect WhatsApp session.

**Headers:**
- `X-API-Key`: API key

**Response:**
```json
{
  "success": true,
  "message": "Disconnected successfully"
}
```

### `POST /send`
Send a message.

**Headers:**
- `X-API-Key`: API key
- `Content-Type`: application/json

**Body:**
```json
{
  "to": "+1234567890",
  "text": "Hello, world!"
}
```

**Response:**
```json
{
  "success": true,
  "messageId": "message_id",
  "message": "Message queued for sending"
}
```

## VPS Deployment

### Using Docker

1. **SSH into your VPS**

2. **Clone or upload the wa-bridge code**

3. **Create `.env` file:**
```bash
PORT=3001
NODE_ENV=production
API_KEY=your-secret-api-key-here
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
SESSION_DIR=./sessions
CRM_URL=https://your-crm-domain.com
```

4. **Build and run:**
```bash
docker build -t wa-bridge .
docker run -d \
  --name wa-bridge \
  --restart unless-stopped \
  -p 3001:3001 \
  -v $(pwd)/sessions:/app/sessions \
  --env-file .env \
  wa-bridge
```

### Using PM2 (without Docker)

1. **Install PM2:**
```bash
npm install -g pm2
```

2. **Build the project:**
```bash
npm run build
```

3. **Start with PM2:**
```bash
pm2 start dist/index.js --name wa-bridge
pm2 save
pm2 startup
```

4. **View logs:**
```bash
pm2 logs wa-bridge
```

## CRM Integration

### Update CRM Environment Variables

Add to your CRM `.env.local`:

```env
WA_BRIDGE_URL=http://localhost:3001
WA_BRIDGE_API_KEY=your-secret-api-key-here
```

For production, use your VPS IP or domain:
```env
WA_BRIDGE_URL=http://your-vps-ip:3001
# or
WA_BRIDGE_URL=https://wa-bridge.yourdomain.com
```

### Configure Webhook URL

The wa-bridge service automatically fetches the webhook URL from your CRM settings. Make sure you've configured the "Inbound – Receiving Messages" webhook URL in Settings.

## Message Flow

### Inbound Messages

1. WhatsApp message arrives → wa-bridge receives via `@whatsapp/web.js`
2. Message is deduplicated
3. Message is formatted and forwarded to CRM webhook URL
4. Audit log entry is created

### Outbound Messages

1. CRM calls `POST /send` on wa-bridge
2. Message is added to queue
3. Queue processes messages sequentially
4. Retry with exponential backoff on failure
5. Audit log entry is created

## Safety Features

- **API Key Authentication**: All endpoints (except `/health`) require `X-API-Key` header
- **Rate Limiting**: Max 20 requests per minute per IP (configurable)
- **Message Queue**: Sequential processing with retry logic
- **Deduplication**: Inbound messages are deduplicated by message ID
- **Audit Logging**: All send/receive events logged to Supabase
- **Opt-in Gating**: CRM handles opt-in checks before sending

## Troubleshooting

### QR Code Not Generating

- Check that the service is running
- Verify API key is correct
- Check logs for errors
- Ensure sessions directory is writable

### Messages Not Sending

- Verify WhatsApp is connected (`GET /status`)
- Check rate limits
- Review audit logs in Supabase
- Check queue length in logs

### Connection Drops

- WhatsApp Web sessions can expire
- Reconnect by generating a new QR code
- Check network connectivity
- Review Puppeteer/Chrome errors in logs

## Development

```bash
# Install dependencies
npm install

# Run in development mode (with hot reload)
npm run dev

# Build
npm run build

# Type check
npm run typecheck
```

## License

MIT




