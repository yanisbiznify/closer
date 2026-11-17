// Stripe : appels REST directs (pas de SDK), webhook créé automatiquement
const crypto = require("crypto");
const config = require("./config");
const { q } = require("./db");
const tw = require("./twilio");

const API = "https://api.stripe.com/v1";
const enabled = () => !!config.stripeSecretKey;
const mode = () => (String(config.stripeSecretKey || "").startsWith("sk_live") || String(config.stripeSecretKey || "").startsWith("rk_live") ? "live" : "test");

// Encodage application/x-www-form-urlencoded avec objets et tableaux imbriqués (format Stripe)
function encode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === "object" ? encode(x, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(x)}`)));
    else if (typeof v === "object") encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}

async function call(method, path, params) {
  if (!enabled()) { const e = new Error("Ajoute STRIPE_SECRET_KEY dans Railway pour activer les paiements."); e.code = "stripe_off"; throw e; }
  const body = params && method !== "GET" ? encode(params).join("&") : undefined;
  const url = API + path + (params && method === "GET" ? "?" + encode(params).join("&") : "");
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${config.stripeSecretKey}`, "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": "2024-06-20" },
    body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `Stripe ${r.status}`);
  return j;
}

async function getState() {
  const r = await q(`SELECT value FROM settings WHERE key='stripe'`);
  return r.rows.length ? r.rows[0].value : {};
}
async function setState(v) {
  await q(`INSERT INTO settings (key, value) VALUES ('stripe', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [v]);
}

const hookUrl = () => (tw.publicUrl() || "") + "/api/stripe/webhook";

// Crée (ou recrée) l'endpoint webhook Stripe et garde son secret de signature
async function ensureWebhook() {
  if (!enabled()) return;
  const url = hookUrl();
  if (!/^https:\/\//.test(url)) return;
  const st = await getState();
  const m = mode();
  if (st.webhookId && st.webhookSecret && st.webhookUrl === url && st.mode === m) {
    try { const w = await call("GET", `/webhook_endpoints/${st.webhookId}`); if (w && w.status === "enabled") return; } catch {}
  }
  // On retire les anciens endpoints CLOSER PRO pour cette URL (secret perdu), puis on en crée un neuf
  try {
    const list = await call("GET", "/webhook_endpoints", { limit: 100 });
    for (const w of list.data || []) if (w.url === url) await call("DELETE", `/webhook_endpoints/${w.id}`).catch(() => {});
  } catch {}
  const w = await call("POST", "/webhook_endpoints", {
    url,
    description: "CLOSER PRO — paiements des factures",
    enabled_events: ["checkout.session.completed", "checkout.session.async_payment_succeeded"],
  });
  await setState({ ...st, webhookId: w.id, webhookSecret: w.secret, webhookUrl: url, mode: m });
}

async function webhookSecret() {
  return config.stripeWebhookSecret || (await getState()).webhookSecret || null;
}

// Vérifie l'en-tête Stripe-Signature (HMAC SHA-256, tolérance 5 min)
async function verify(raw, header) {
  const secret = await webhookSecret();
  if (!secret || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")).filter((x) => x.length === 2).map(([k, v]) => [k, v]));
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

module.exports = { enabled, mode, call, ensureWebhook, verify, getState };
