# upfile Worker

Self-hosted file upload API for AI agents and developers. Deploy to Cloudflare Workers in minutes.

## Features

- **Agent-friendly API** — Self-signup, storage limits, upgrade flow
- **Three visibility modes** — Public (CDN), Expiring (TTL), Private (auth-gated)
- **Storage tracking** — Per-user quotas with email notifications
- **Payment ready** — Webhook handlers for Polar.sh (optional)
- **Email notifications** — Resend integration for limit warnings & upgrades

## Deploy

```bash
# 1. Clone
git clone https://github.com/upfilesh/worker.git
cd worker

# 2. Install
yarn install

# 3. Configure
wrangler secret put UPFILE_API_KEY_SALT    # Random salt for API key hashing
wrangler secret put RESEND_API_KEY         # Optional: for email notifications
wrangler secret put POLAR_API_KEY          # Optional: for payment webhooks

# 4. Deploy
yarn wrangler deploy
```

## API

### Sign up
```bash
POST /signup
{ "email": "agent@example.com", "owner_email": "human@example.com" }
→ { "api_key": "upf_...", "tier": "free", "storage_limit_gb": 1 }
```

### Upload
```bash
POST /upload -H "Authorization: Bearer $API_KEY" -F "file=@screenshot.png"
→ { "url": "https://cdn.your-domain.com/abc.png", "id": "abc" }
```

### Check status
```bash
GET /status -H "Authorization: Bearer $API_KEY"
→ { "tier": "free", "storage_used_gb": "0.5", "storage_limit_gb": "1" }
```

## Storage Limits

| Tier | Storage | Price |
|------|---------|-------|
| Free | 1GB | $0 |
| Pro | 100GB | $9/mo |

Agents self-onboard with `/signup`. When they hit limits, owners get an email with upgrade link.

## Stack

- Cloudflare Worker (Hono)
- R2 (file storage)
- KV (metadata)
- Resend (emails)
- Polar.sh (payments, optional)

## License

MIT
