# upfile Worker

Self-hosted file upload API for AI agents and developers. Deploy to Cloudflare Workers in minutes.

## Features

- **Agent-friendly API** — Self-signup, storage limits, upgrade flow
- **Three visibility modes** — Public (CDN), Expiring (TTL), Private (auth-gated)
- **Storage tracking** — Per-user quotas with email notifications
- **Payment ready** — Webhook handlers for Polar.sh (optional)
- **Email notifications** — Resend integration for limit warnings & upgrades
- **Error tracking** — Honeybadger integration for production monitoring

---

## Quick Deploy

```bash
# 1. Clone
git clone https://github.com/upfilesh/worker.git
cd worker

# 2. Install
yarn install

# 3. Configure secrets
yarn wrangler secret put UPFILE_API_KEY_SALT    # Random salt (required)
yarn wrangler secret put RESEND_API_KEY         # For email notifications
yarn wrangler secret put RESEND_FROM_EMAIL      # e.g., billing@yourdomain.com
yarn wrangler secret put POLAR_API_KEY          # For payment webhooks
yarn wrangler secret put POLAR_PRODUCT_ID       # Your Polar product ID
yarn wrangler secret put HONEYBADGER_API_KEY    # For error tracking

# 4. Deploy
yarn wrangler deploy
```

---

## API

### Sign up
```bash
POST /signup
{
  "email": "agent@example.com",
  "owner_email": "human@example.com"
}
→ {
  "api_key": "upf_xxxxx",
  "tier": "free",
  "storage_limit_gb": 1
}
```

### Upload
```bash
POST /upload -H "Authorization: Bearer $API_KEY" -F "file=@screenshot.png"
→ {
  "url": "https://cdn.your-domain.com/abc.png",
  "id": "abc",
  "visibility": "public",
  "size": 1024
}
```

| Visibility | Description |
|------------|-------------|
| `public` | Direct CDN URL, permanent, no auth required |
| `expiring` | Auto-deleted after TTL, auth-gated |
| `private` | Auth-gated, only owner can access |

### Check status
```bash
GET /status -H "Authorization: Bearer $API_KEY"
→ {
  "tier": "free",
  "storage_used_gb": "0.5",
  "storage_limit_gb": "1"
}
```

### Upgrade
```bash
GET /upgrade -H "Authorization: Bearer $API_KEY"
→ {
  "checkout_url": "https://polar.sh/checkout/...",
  "message": "Upgrade link sent to owner"
}
```

---

## Storage Limits & Email Flow

| Tier | Storage | Price |
|------|---------|-------|
| Free | 1GB | $0 |
| Pro | 100GB | $9/mo |

**Automatic email notifications:**

1. **90% threshold** — Warning email sent once
   - Subject: "90% Limit Reached: Your agent needs you!"
   - Tone: Friendly heads up with upgrade option

2. **100% limit** — Urgent email, uploads blocked
   - Subject: "🚨 Storage Full: Uploads blocked until you upgrade"
   - Tone: Action required, red CTA button

3. **Upgrade confirmation** — After successful payment
   - Subject: "You're all set — thanks for upgrading!"
   - Tone: Confirmation, next steps

Requires Resend integration with verified domain.

---

## Webhook: Polar.sh

Handle subscription events:

```bash
POST /webhooks/polar
```

Events:
- `checkout.completed` → Upgrade user to Pro
- `subscription.active` → Confirm Pro tier

Configure webhook URL in Polar dashboard:
`https://api.your-domain.com/webhooks/polar`

---

## Error Tracking (Honeybadger)

Production errors are automatically reported to Honeybadger:
- Checkout creation failures
- Payment webhook errors
- Email sending failures

Context includes:
- Request URL/method
- User email
- Key hash (for debugging)

---

## Architecture

```
Client ──▶ Cloudflare Worker ──▶ R2 (files)
                    │
                    ├─▶ KV (metadata)
                    │
                    ├─▶ Resend (emails)
                    │
                    └─▶ Polar (payments)
```

**Stack:**
- Hono (web framework)
- R2 (object storage)
- KV (metadata & user storage)
- Resend (transactional email)
- Polar.sh (subscription billing)
- Honeybadger (error tracking)

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `UPFILE_API_KEY_SALT` | ✅ | Random salt for hashing API keys |
| `RESEND_API_KEY` | ❌ | Resend API key for emails |
| `RESEND_FROM_EMAIL` | ❌ | Sender address (verified domain) |
| `POLAR_API_KEY` | ❌ | Polar API key for checkouts |
| `POLAR_PRODUCT_ID` | ❌ | Polar product ID for upgrades |
| `HONEYBADGER_API_KEY` | ❌ | Honeybadger project API key |

---

## Local Development

```bash
# Install
yarn install

# Dev server (uses wrangler dev)
yarn dev

# Test email endpoint
curl -X POST http://localhost:8787/test/email \
  -H "Content-Type: application/json" \
  -d '{"to":"test@example.com"}'
```

Note: Local dev requires Cloudflare auth for R2/KV.

---

## Testing Storage Notifications

To trigger the 90% email:
1. Upload files until storage crosses 90% of 1GB (~900MB)
2. Email sends automatically on next upload

To test without large files:
```bash
# Use wrangler tail to monitor
curl -X POST /test/email -d '{"to":"you@example.com"}'
```

---

## Custom Domain

1. Add custom domain in Cloudflare dashboard
2. Update `wrangler.toml`:
```toml
routes = [
  { pattern = "api.your-domain.com/*", custom_domain = true }
]
```
3. Deploy: `yarn wrangler deploy`

---

## License

MIT
