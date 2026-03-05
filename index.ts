import { Hono } from "hono";
import { cors } from "hono/cors";

type Bindings = {
  UPFILE_BUCKET: R2Bucket;
  UPFILE_META: KVNamespace;
  UPFILE_API_KEY_SALT: string;
  POLAR_API_KEY?: string;
  POLAR_PRODUCT_ID?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  ENVIRONMENT: string;
};

const app = new Hono<{ Bindings: Bindings }>();

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const FREE_STORAGE_GB = 1;
const PRO_STORAGE_GB = 100;

app.use("/*", cors({
  origin: ["https://upfile.sh", "https://www.upfile.sh", "http://localhost:3000"],
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["Authorization", "Content-Type"],
}));

function nanoid(len = 10): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

async function hashKey(key: string, salt: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key + salt));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getKeyHash(c: any): Promise<string | null> {
  const auth = c.req.header("Authorization") || "";
  const key = auth.replace(/^Bearer\s+/, "").trim() || c.req.query("api_key") || "";
  if (!key) return null;
  return hashKey(key, c.env.UPFILE_API_KEY_SALT);
}

async function getUserByKeyHash(c: any, keyHash: string): Promise<any | null> {
  const userStr = await c.env.UPFILE_META.get(`user:${keyHash}`);
  return userStr ? JSON.parse(userStr) : null;
}

// POST /signup - Create account (agent-friendly)
app.post("/signup", async (c) => {
  const { email, owner_email } = await c.req.json();
  if (!email || !email.includes("@")) {
    return c.json({ error: "Valid email required" }, 400);
  }

  // Generate API key
  const key = `upf_${nanoid(24)}`;
  const keyHash = await hashKey(key, c.env.UPFILE_API_KEY_SALT);

  // Store user
  const user = {
    email,
    owner_email: owner_email || email,
    tier: "free",
    storage_used: 0,
    storage_limit: FREE_STORAGE_GB * 1024 * 1024 * 1024,
    created_at: new Date().toISOString(),
    key_hash: keyHash,
  };

  await c.env.UPFILE_META.put(`user:${keyHash}`, JSON.stringify(user));
  await c.env.UPFILE_META.put(`email:${email}`, keyHash);

  return c.json({
    api_key: key,
    tier: "free",
    storage_limit_gb: FREE_STORAGE_GB,
    message: "Welcome to upfile. Upgrade anytime: upfile upgrade"
  });
});

// GET /status - Check storage
app.get("/status", async (c) => {
  const keyHash = await getKeyHash(c);
  if (!keyHash) return c.json({ error: "Unauthorized" }, 401);

  const user = await getUserByKeyHash(c, keyHash);
  if (!user) return c.json({ error: "User not found" }, 404);

  return c.json({
    tier: user.tier,
    storage_used: user.storage_used,
    storage_limit: user.storage_limit,
    storage_used_gb: (user.storage_used / (1024**3)).toFixed(2),
    storage_limit_gb: (user.storage_limit / (1024**3)).toFixed(0),
  });
});

// GET /upgrade - Get Polar checkout URL
app.get("/upgrade", async (c) => {
  const keyHash = await getKeyHash(c);
  if (!keyHash) return c.json({ error: "Unauthorized" }, 401);

  const user = await getUserByKeyHash(c, keyHash);
  if (!user) return c.json({ error: "User not found" }, 404);

  if (!c.env.POLAR_API_KEY) {
    // Fallback: manual upgrade path
    return c.json({
      checkout_url: null,
      message: "Visit https://upfile.sh/dashboard to upgrade",
      current_tier: user.tier,
      upgrade_to: "pro",
      price: "$9/month",
    });
  }

  // Create Polar checkout
  const productId = c.env.POLAR_PRODUCT_ID || "pro";
  const polarApiUrl = c.env.ENVIRONMENT === "production"
    ? "https://api.polar.sh/v1/checkouts"
    : "https://sandbox-api.polar.sh/v1/checkouts";

  const checkout = await fetch(polarApiUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${c.env.POLAR_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      product_id: productId,
      customer_email: user.owner_email,
      metadata: { key_hash: keyHash },
      success_url: "https://upfile.sh/dashboard?upgraded=1",
    }),
  });

  if (!checkout.ok) {
    const err = await checkout.text();
    console.error("[POLAR] Checkout creation failed:", err);
    return c.json({ error: "Failed to create checkout", details: err }, 500);
  }

  const data = await checkout.json();

  // Email notification to owner
  await sendUpgradeEmail(c, user.owner_email, data.url);

  return c.json({
    checkout_url: data.url,
    message: `Upgrade link sent to ${user.owner_email}`,
  });
});

// POST /webhooks/polar - Handle Polar webhook
app.post("/webhooks/polar", async (c) => {
  const body = await c.req.json();

  // Verify webhook signature (simplified - add proper verification)
  if (body.type === "checkout.completed" || body.type === "subscription.active") {
    const keyHash = body.metadata?.key_hash;
    if (!keyHash) return c.json({ error: "Missing key_hash" }, 400);

    const userStr = await c.env.UPFILE_META.get(`user:${keyHash}`);
    if (!userStr) return c.json({ error: "User not found" }, 404);

    const user = JSON.parse(userStr);
    user.tier = "pro";
    user.storage_limit = PRO_STORAGE_GB * 1024 * 1024 * 1024;
    user.upgraded_at = new Date().toISOString();

    await c.env.UPFILE_META.put(`user:${keyHash}`, JSON.stringify(user));

    // Send confirmation email
    await sendConfirmationEmail(c, user.owner_email);

    return c.json({ upgraded: true, tier: "pro" });
  }

  return c.json({ received: true });
});

// POST /upload (with storage limits)
app.post("/upload", async (c) => {
  const keyHash = await getKeyHash(c);
  if (!keyHash) return c.json({ error: "Unauthorized" }, 401);

  const user = await getUserByKeyHash(c, keyHash);
  if (!user) return c.json({ error: "User not found. Run: upfile signup" }, 404);

  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "No file provided" }, 400);
  if (file.size > MAX_FILE_SIZE) return c.json({ error: "File too large (max 100MB)" }, 413);

  // Check storage limit
  if (user.storage_used + file.size > user.storage_limit) {
    const usedGb = (user.storage_used / (1024**3)).toFixed(2);
    const limitGb = (user.storage_limit / (1024**3)).toFixed(0);
    const upgradeMsg = user.tier === "free"
      ? "Upgrade to Pro for 100GB: upfile upgrade"
      : "Contact support for more storage";

    // Notify owner
    await sendLimitWarningEmail(c, user.owner_email, usedGb);

    return c.json({
      error: "Storage limit reached",
      used_gb: usedGb,
      limit_gb: limitGb,
      message: upgradeMsg,
      owner_notified: user.owner_email,
    }, 403);
  }

  const visibility = (formData.get("visibility") as string) || "public";
  if (!["public", "expiring", "private"].includes(visibility)) {
    return c.json({ error: "Invalid visibility. Use: public, expiring, private" }, 400);
  }

  const ttl = parseInt(formData.get("ttl") as string) || null;
  if (visibility === "expiring" && !ttl) {
    return c.json({ error: "Expiring files require a ttl (seconds)" }, 400);
  }

  const id = nanoid();
  const originalName = file.name || "upload";
  const ext = originalName.includes(".") ? originalName.split(".").pop()! : "bin";
  const key = `${id}.${ext}`;

  await c.env.UPFILE_BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: { visibility, owner: keyHash, originalName },
  });

  const expiresAt = ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null;
  const createdAt = new Date().toISOString();

  const meta = { id, key, visibility, size: file.size, type: file.type || "application/octet-stream",
    originalName, expires_at: expiresAt, created_at: createdAt, owner_key_hash: keyHash };

  await c.env.UPFILE_META.put(`file:${id}`, JSON.stringify(meta), {
    ...(ttl ? { expirationTtl: ttl } : {}),
  });

  // Index by owner
  const indexKey = `owner:${keyHash}:${createdAt}:${id}`;
  await c.env.UPFILE_META.put(indexKey, id, { ...(ttl ? { expirationTtl: ttl } : {}) });

  // Update user storage
  user.storage_used += file.size;
  await c.env.UPFILE_META.put(`user:${keyHash}`, JSON.stringify(user));

  const url = visibility === "public"
    ? `https://cdn.upfile.sh/${key}`
    : `https://api.upfile.sh/f/${id}`;

  return c.json({ id, url, visibility, size: file.size, type: meta.type,
    originalName, expires_at: expiresAt, created_at: createdAt,
    storage_used: user.storage_used,
    storage_limit: user.storage_limit,
  });
});

// GET /f/:id - private/expiring proxy
app.get("/f/:id", async (c) => {
  const id = c.req.param("id");
  const metaStr = await c.env.UPFILE_META.get(`file:${id}`);
  if (!metaStr) return c.json({ error: "Not found" }, 404);

  const meta = JSON.parse(metaStr);

  if (meta.expires_at && new Date(meta.expires_at) < new Date()) {
    return c.json({ error: "File expired" }, 410);
  }

  if (meta.visibility === "private") {
    const keyHash = await getKeyHash(c);
    const cookie = c.req.header("Cookie") || "";
    const cookieKey = cookie.match(/upfile_key=([^;]+)/)?.[1];
    const cookieHash = cookieKey ? await hashKey(cookieKey, c.env.UPFILE_API_KEY_SALT) : null;
    if (keyHash !== meta.owner_key_hash && cookieHash !== meta.owner_key_hash) {
      return c.json({ error: "Forbidden" }, 403);
    }
  }

  const obj = await c.env.UPFILE_BUCKET.get(meta.key);
  if (!obj) return c.json({ error: "Not found" }, 404);

  const disposition = meta.visibility === "public" ? "inline" : `attachment; filename="${meta.originalName}"`;
  return new Response(obj.body, {
    headers: {
      "Content-Type": meta.type,
      "Content-Disposition": disposition,
      "Cache-Control": meta.visibility === "public" ? "public, max-age=31536000, immutable" : "private, no-cache",
    },
  });
});

// GET /files - list files
app.get("/files", async (c) => {
  const keyHash = await getKeyHash(c);
  if (!keyHash) return c.json({ error: "Unauthorized" }, 401);

  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);
  const prefix = `owner:${keyHash}:`;
  const list = await c.env.UPFILE_META.list({ prefix, limit });

  const files = await Promise.all(
    list.keys.map(async ({ name }) => {
      const id = await c.env.UPFILE_META.get(name);
      if (!id) return null;
      const metaStr = await c.env.UPFILE_META.get(`file:${id}`);
      if (!metaStr) return null;
      const meta = JSON.parse(metaStr);
      const url = meta.visibility === "public"
        ? `https://cdn.upfile.sh/${meta.key}`
        : `https://api.upfile.sh/f/${meta.id}`;
      return { ...meta, url, owner_key_hash: undefined };
    })
  );

  return c.json({ files: files.filter(Boolean), cursor: list.list_complete ? null : list.cursor });
});

// DELETE /f/:id
app.delete("/f/:id", async (c) => {
  const keyHash = await getKeyHash(c);
  if (!keyHash) return c.json({ error: "Unauthorized" }, 401);

  const id = c.req.param("id");
  const metaStr = await c.env.UPFILE_META.get(`file:${id}`);
  if (!metaStr) return c.json({ error: "Not found" }, 404);

  const meta = JSON.parse(metaStr);
  if (meta.owner_key_hash !== keyHash) return c.json({ error: "Forbidden" }, 403);

  // Update storage
  const user = await getUserByKeyHash(c, keyHash);
  if (user) {
    user.storage_used = Math.max(0, user.storage_used - meta.size);
    await c.env.UPFILE_META.put(`user:${keyHash}`, JSON.stringify(user));
  }

  await Promise.all([
    c.env.UPFILE_BUCKET.delete(meta.key),
    c.env.UPFILE_META.delete(`file:${id}`),
  ]);

  return c.json({ deleted: true, id });
});

// Email helpers using Resend
async function sendEmail(c: any, to: string, subject: string, html: string, text: string, fromName: string, fromEmail: string, headers?: Record<string, string>) {
  if (!c.env.RESEND_API_KEY) {
    console.log(`[EMAIL SKIPPED] No RESEND_API_KEY set. Would send to ${to}: ${subject}`);
    return;
  }

  // Format: "Sender Name <email@domain.com>"
  const from = `${fromName} <${fromEmail}>`;

  const body: any = {
    from,
    to,
    subject,
    html,
    text,
    headers: headers || {},
  };

  // Add reply_to for billing emails
  if (fromEmail === "billing@upfile.sh") {
    body.reply_to = "hi@upfile.sh";
    body.headers["List-Unsubscribe"] = "<mailto:hi@upfile.sh?subject=unsubscribe>";
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${c.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseText = await res.text();

  if (!res.ok) {
    console.error(`[EMAIL FAILED] ${res.status}: ${responseText}`);
  } else {
    const data = JSON.parse(responseText);
    console.log(`[EMAIL SENT] ${to}: ${subject} (id: ${data.id})`);
  }
}

async function sendUpgradeEmail(c: any, email: string, checkoutUrl: string) {
  const subject = "Your upfile storage is almost full — Upgrade to Pro";
  const text = `Your upfile storage is almost full.

An agent using your upfile account is requesting more storage.

Upgrade to Pro for $9/month:
${checkoutUrl}

Pro includes 100GB storage, unlimited uploads, and private files.

Questions? Reply to this email or contact hi@upfile.sh

—
upfile.sh
https://upfile.sh`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Upgrade your upfile storage</title>
</head>
<body style="margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5;">
  <div style="max-width: 600px; margin: 0 auto; background: #fff; padding: 40px 20px;">
    <!-- Preheader (hidden) -->
    <div style="display: none; max-height: 0; overflow: hidden;">
      Your agent needs more storage. Upgrade to Pro for 100GB at $9/month.
    </div>

    <h1 style="color: #000; font-size: 24px; margin: 0 0 20px;">Your upfile storage is almost full</h1>

    <p style="color: #333; font-size: 16px; line-height: 1.5; margin: 0 0 20px;">
      An agent using your upfile account is requesting more storage.
    </p>

    <div style="margin: 30px 0;">
      <a href="${checkoutUrl}" style="display: inline-block; background: #000; color: #fff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 500;">
        Upgrade to Pro — $9/month
      </a>
    </div>

    <p style="color: #666; font-size: 14px; line-height: 1.5; margin: 0 0 20px;">
      Pro includes 100GB storage, unlimited uploads, and private files.
    </p>

    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">

    <p style="color: #999; font-size: 13px; line-height: 1.5; margin: 0;">
      Questions? Reply to this email or contact <a href="mailto:hi@upfile.sh" style="color: #666;">hi@upfile.sh</a><br>
      <a href="https://upfile.sh" style="color: #666;">upfile.sh</a>
    </p>
  </div>
</body>
</html>`;

  await sendEmail(c, email, subject, html, text, "upfile billing", "billing@upfile.sh");
}

async function sendConfirmationEmail(c: any, email: string) {
  const subject = "Welcome to upfile Pro — Your account is upgraded";
  const text = `Welcome to upfile Pro!

Your upfile account now has 100GB of storage.

All agents using your API key can continue uploading without limits.

View your dashboard: https://upfile.sh/dashboard

Questions? Contact hi@upfile.sh

—
upfile.sh
https://upfile.sh`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to upfile Pro</title>
</head>
<body style="margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5;">
  <div style="max-width: 600px; margin: 0 auto; background: #fff; padding: 40px 20px;">
    <!-- Preheader (hidden) -->
    <div style="display: none; max-height: 0; overflow: hidden;">
      Your account now has 100GB of storage. All agents can continue uploading.
    </div>

    <h1 style="color: #000; font-size: 24px; margin: 0 0 20px;">You're upgraded to Pro</h1>

    <p style="color: #333; font-size: 16px; line-height: 1.5; margin: 0 0 20px;">
      Your upfile account now has <strong>100GB of storage</strong>.
    </p>

    <p style="color: #333; font-size: 16px; line-height: 1.5; margin: 0 0 30px;">
      All agents using your API key can continue uploading without limits.
    </p>

    <div style="margin: 30px 0;">
      <a href="https://upfile.sh/dashboard" style="display: inline-block; background: #000; color: #fff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 500;">
        View dashboard
      </a>
    </div>

    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">

    <p style="color: #999; font-size: 13px; line-height: 1.5; margin: 0;">
      Questions? Contact <a href="mailto:hi@upfile.sh" style="color: #666;">hi@upfile.sh</a><br>
      <a href="https://upfile.sh" style="color: #666;">upfile.sh</a>
    </p>
  </div>
</body>
</html>`;

  await sendEmail(c, email, subject, html, text, "upfile billing", "billing@upfile.sh");
}

async function sendLimitWarningEmail(c: any, email: string, usedGb: string) {
  const subject = "Your upfile storage limit has been reached";
  const text = `Your upfile storage limit has been reached.

An agent tried to upload a file but your free tier is full (${usedGb}GB used).

Run "upfile upgrade" to get a checkout link, or visit:
https://upfile.sh/dashboard

Questions? Contact hi@upfile.sh

—
upfile.sh
https://upfile.sh`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Storage limit reached</title>
</head>
<body style="margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; background: #f5f5f5;">
  <div style="max-width: 600px; margin: 0 auto; background: #fff; padding: 40px 20px;">
    <!-- Preheader (hidden) -->
    <div style="display: none; max-height: 0; overflow: hidden;">
      Your free tier is full. Upgrade to Pro for 100GB of storage.
    </div>

    <h1 style="color: #000; font-size: 24px; margin: 0 0 20px;">Storage limit reached</h1>

    <p style="color: #333; font-size: 16px; line-height: 1.5; margin: 0 0 20px;">
      An agent tried to upload a file but your free tier is full (<strong>${usedGb}GB used</strong>).
    </p>

    <p style="color: #333; font-size: 16px; line-height: 1.5; margin: 0 0 30px;">
      Run <code style="background: #f5f5f5; padding: 2px 6px; border-radius: 3px;">upfile upgrade</code> to get a checkout link, or visit your dashboard.
    </p>

    <div style="margin: 30px 0;">
      <a href="https://upfile.sh/dashboard" style="display: inline-block; background: #000; color: #fff; padding: 14px 28px; text-decoration: none; border-radius: 6px; font-weight: 500;">
        View dashboard
      </a>
    </div>

    <hr style="border: none; border-top: 1px solid #e5e5e5; margin: 30px 0;">

    <p style="color: #999; font-size: 13px; line-height: 1.5; margin: 0;">
      Questions? Contact <a href="mailto:hi@upfile.sh" style="color: #666;">hi@upfile.sh</a><br>
      <a href="https://upfile.sh" style="color: #666;">upfile.sh</a>
    </p>
  </div>
</body>
</html>`;

  await sendEmail(c, email, subject, html, text, "upfile billing", "billing@upfile.sh");
}

// GET /health
app.get("/health", (c) => c.json({ ok: true, version: "1.1.0" }));

// POST /test/email - Debug endpoint
app.post("/test/email", async (c) => {
  const { to } = await c.req.json();
  await sendEmail(c, to || "perry@raskin.me", "Test from upfile", "<h1>Test email</h1>", "This is a test email from upfile.", "upfile billing", "billing@upfile.sh");
  return c.json({ sent: true, to: to || "perry@raskin.me" });
});

export default app;
