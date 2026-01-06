# wa-bridge Deployment Guide

## Quick Start

### 1. Prerequisites

- VPS with Ubuntu 20.04+ or similar Linux distribution
- Docker installed (optional but recommended)
- Node.js 20+ (if not using Docker)
- Domain name or static IP address

### 2. Server Setup

#### Option A: Docker Deployment (Recommended)

```bash
# SSH into your VPS
ssh user@your-vps-ip

# Clone or upload wa-bridge code
git clone <your-repo> wa-bridge
cd wa-bridge

# Create .env file
cat > .env << EOF
PORT=3001
NODE_ENV=production
API_KEY=$(openssl rand -hex 32)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
SESSION_DIR=./sessions
CRM_URL=https://your-crm-domain.com
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=20
MAX_RETRIES=3
RETRY_DELAY_MS=1000
DEDUPE_CACHE_SIZE=1000
DEDUPE_TTL_MS=3600000
EOF

# Build Docker image
docker build -t wa-bridge .

# Run container
docker run -d \
  --name wa-bridge \
  --restart unless-stopped \
  -p 3001:3001 \
  -v $(pwd)/sessions:/app/sessions \
  --env-file .env \
  wa-bridge

# Check logs
docker logs -f wa-bridge
```

#### Option B: PM2 Deployment

```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2
sudo npm install -g pm2

# Clone or upload wa-bridge code
git clone <your-repo> wa-bridge
cd wa-bridge

# Install dependencies
npm install

# Create .env file (same as above)

# Build
npm run build

# Start with PM2
pm2 start dist/index.js --name wa-bridge
pm2 save
pm2 startup
```

### 3. Configure Firewall

```bash
# Allow port 3001
sudo ufw allow 3001/tcp
sudo ufw enable
```

### 4. Configure Reverse Proxy (Optional but Recommended)

Using Nginx:

```nginx
server {
    listen 80;
    server_name wa-bridge.yourdomain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

### 5. Update CRM Configuration

Add to your CRM `.env.local`:

```env
WA_BRIDGE_URL=http://your-vps-ip:3001
# or if using domain:
WA_BRIDGE_URL=https://wa-bridge.yourdomain.com

WA_BRIDGE_API_KEY=your-api-key-from-wa-bridge-env
```

### 6. Test Connection

```bash
# Health check
curl http://your-vps-ip:3001/health

# Get status (requires API key)
curl -H "X-API-Key: your-api-key" http://your-vps-ip:3001/status
```

## End-to-End Testing

### 1. Start wa-bridge

```bash
# On VPS
cd wa-bridge
docker-compose up -d
# or
pm2 start wa-bridge
```

### 2. Open CRM Connect Page

1. Navigate to `/connect-whatsapp` in your CRM
2. Click "Generate QR Code"
3. QR code should appear (from wa-bridge, not placeholder)

### 3. Scan QR Code

1. Open WhatsApp on your phone
2. Go to Settings → Linked Devices → Link a Device
3. Scan the QR code displayed in CRM
4. Wait for connection status to update to "Connected"

### 4. Test Inbound Messages

1. Send a WhatsApp message to the connected phone number
2. Check CRM messages interface
3. Message should appear in the conversation
4. Check wa-bridge logs: `docker logs wa-bridge` or `pm2 logs wa-bridge`

### 5. Test Outbound Messages

1. Go to CRM messages interface
2. Select a contact
3. Send a message
4. Check that message arrives in WhatsApp
5. Check audit logs in Supabase `message_events` table

## Monitoring

### Check Service Status

```bash
# Docker
docker ps | grep wa-bridge
docker logs wa-bridge --tail 100

# PM2
pm2 status
pm2 logs wa-bridge --lines 100
```

### Check Connection Status

```bash
curl -H "X-API-Key: your-api-key" http://your-vps-ip:3001/status
```

### View Audit Logs

Query Supabase `message_events` table:

```sql
SELECT * FROM message_events 
ORDER BY timestamp DESC 
LIMIT 100;
```

## Troubleshooting

### QR Code Not Generating

1. Check wa-bridge logs for errors
2. Verify API key is correct
3. Ensure sessions directory is writable
4. Check that Puppeteer dependencies are installed (Docker handles this)

### Connection Drops

1. WhatsApp Web sessions can expire
2. Generate new QR code to reconnect
3. Check network connectivity
4. Review Puppeteer/Chrome errors in logs

### Messages Not Sending

1. Verify connection status: `GET /status`
2. Check rate limits (max 20/min by default)
3. Review audit logs for errors
4. Check queue length in logs

### Messages Not Receiving

1. Verify webhook URL is configured in CRM Settings
2. Check wa-bridge logs for forwarding errors
3. Verify CRM webhook endpoint is accessible
4. Check deduplication cache (messages might be filtered)

## Security Best Practices

1. **Use Strong API Key**: Generate with `openssl rand -hex 32`
2. **Use HTTPS**: Set up reverse proxy with SSL certificate
3. **Firewall**: Only expose port 3001 to CRM server IP
4. **Environment Variables**: Never commit `.env` file
5. **Regular Updates**: Keep dependencies updated
6. **Monitor Logs**: Set up log rotation and monitoring

## Backup

### Session Backup

WhatsApp sessions are stored in `./sessions` directory. Backup regularly:

```bash
# Backup sessions
tar -czf sessions-backup-$(date +%Y%m%d).tar.gz sessions/

# Restore sessions
tar -xzf sessions-backup-YYYYMMDD.tar.gz
```

## Scaling

For high-volume deployments:

1. Increase rate limits in `.env`
2. Use Redis for deduplication cache (modify code)
3. Use message queue service (RabbitMQ, etc.)
4. Deploy multiple instances with load balancer

## Support

For issues or questions:
1. Check logs first
2. Review audit logs in Supabase
3. Test endpoints with curl
4. Check CRM and wa-bridge connectivity



