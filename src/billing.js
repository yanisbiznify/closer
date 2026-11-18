// Facturation : factures à l'image de Biznify, liens de paiement Stripe, page publique avec bouton « Payer »
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { q } = require("./db");
const stripe = require("./stripe");
const tw = require("./twilio");
const mailer = require("./mailer");
const invoicePdf = require("./invoice-pdf");

const DEFAULT_BILLING = {
  company: "Biznify Technologies Ltd",
  tagline: "",
  address: "",
  registration: "Société enregistrée au Royaume-Uni n° 17227175",
  vatNumber: "",
  email: "contact@biznify.pro",
  phone: "",
  website: "biznify.pro",
  vatRate: 0,
  vatMention: "",
  paymentTerms: "Paiement à réception de la facture, par carte bancaire via le bouton « Payer ».",
  footer: "",
  accent: "#1877F2",
  prefix: "BZ",
  logo: null, // data URL importée dans Réglages de facturation ; sinon le logo Biznify par défaut
};

const DEFAULT_LOGO = (() => {
  try { return "data:image/svg+xml;base64," + fs.readFileSync(path.join(__dirname, "..", "public", "brand", "biznify-logo.svg")).toString("base64"); }
  catch { return null; }
})();

async function getBilling() {
  const r = await q(`SELECT value FROM settings WHERE key='billing'`);
  return { ...DEFAULT_BILLING, ...(r.rows[0] ? r.rows[0].value : {}) };
}
async function saveBilling(patch) {
  const cur = await getBilling();
  const allowed = Object.keys(DEFAULT_BILLING);
  const next = { ...cur };
  for (const k of allowed) if (k in patch) next[k] = patch[k];
  next.vatRate = Math.max(0, Math.min(100, Number(next.vatRate) || 0));
  next.prefix = String(next.prefix || "BZ").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "BZ";
  if (!/^#[0-9a-fA-F]{6}$/.test(next.accent || "")) next.accent = DEFAULT_BILLING.accent;
  if (next.logo && (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(next.logo) || next.logo.length > 700000)) throw new Error("Logo : PNG, JPG, WebP ou SVG de moins de 500 Ko");
  await q(`INSERT INTO settings (key, value) VALUES ('billing', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [next]);
  return next;
}

/* ---------- Calculs ---------- */
const cents = (v) => Math.round(Number(String(v ?? "").replace(",", ".").replace(/\s/g, "")) * 100) || 0;

function cleanItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) => ({
      label: String(it.label || "").trim().slice(0, 300),
      qty: Math.max(0, Number(String(it.qty ?? 1).replace(",", ".")) || 0),
      unit_cents: Number.isInteger(it.unit_cents) ? it.unit_cents : cents(it.unit),
    }))
    .filter((it) => it.label && it.qty > 0);
}
function totals(items, vatRate) {
  const subtotal = items.reduce((s, it) => s + Math.round(it.qty * it.unit_cents), 0);
  const vat = Math.round((subtotal * (Number(vatRate) || 0)) / 100);
  return { subtotal, vat, total: subtotal + vat };
}

async function nextNumber(prefix) {
  const y = new Date().getFullYear();
  const like = `${prefix}-${y}-%`;
  const r = await q(`SELECT number FROM invoices WHERE number LIKE $1`, [like]);
  const max = r.rows.reduce((m, x) => Math.max(m, Number(x.number.split("-").pop()) || 0), 0);
  return `${prefix}-${y}-${String(max + 1).padStart(4, "0")}`;
}

const base = () => tw.publicUrl() || "";
const payBase = () => tw.payUrl() || "";
const invoiceUrl = (inv) => `${payBase()}/facture/${inv.token}`;
// lien court sur ton domaine, qui renvoie vers la page de paiement Stripe
const linkUrl = (l) => (payBase() ? `${payBase()}/p/${l.id}` : l.url);
const serializeLink = (l) => ({ ...l, stripe_url: l.url, url: linkUrl(l) });

function serialize(inv) {
  return { ...inv, url: invoiceUrl(inv), vat_rate: Number(inv.vat_rate) };
}

/* ---------- Paiement reçu ---------- */
async function markPaid(id, via, sessionId) {
  const r = await q(
    `UPDATE invoices SET status='payee', paid_at=COALESCE(paid_at, now()), paid_via=COALESCE(paid_via, $2), stripe_session_id=COALESCE($3, stripe_session_id)
     WHERE id=$1 AND status <> 'payee' RETURNING *`,
    [id, via, sessionId || null]
  );
  const inv = r.rows[0];
  if (inv) mailer.fire(() => mailer.invoicePaid(inv));
  if (inv && inv.lead_id) {
    await q(`UPDATE leads SET stage='gagne', stage_at=now() WHERE id=$1 AND stage IS DISTINCT FROM 'gagne'`, [inv.lead_id]).catch(() => {});
  }
  return inv;
}

async function handleSession(s) {
  if (!s || (s.payment_status !== "paid" && s.payment_status !== "no_payment_required")) return;
  const meta = s.metadata || {};
  let invId = Number(meta.invoice_id) || null;
  if (!invId && s.payment_link) {
    const r = await q(`SELECT id FROM invoices WHERE payment_link_id=$1`, [s.payment_link]);
    if (r.rows[0]) invId = r.rows[0].id;
  }
  if (invId) { await markPaid(invId, s.payment_link ? "lien Stripe" : "carte (facture)", s.id); return; }
  if (s.payment_link || meta.link_id) {
    const l = meta.link_id ? (await q(`SELECT id FROM payment_links WHERE id=$1`, [Number(meta.link_id)])).rows[0] : (await q(`SELECT id FROM payment_links WHERE stripe_id=$1`, [s.payment_link])).rows[0];
    if (!l) return;
    const ins = await q(`INSERT INTO link_payments (link_id, session_id, amount_cents) VALUES ($1,$2,$3) ON CONFLICT (session_id) DO NOTHING RETURNING id`, [l.id, s.id, s.amount_total || 0]);
    if (ins.rows[0]) await q(`UPDATE payment_links SET paid_count=paid_count+1, paid_cents=paid_cents+$2 WHERE id=$1`, [l.id, s.amount_total || 0]);
  }
}

// Les erreurs des routes async vont au gestionnaire d'erreurs d'Express au lieu de faire tomber le serveur
function safeRouter() {
  const r = express.Router();
  for (const m of ["get", "post", "put", "patch", "delete"]) {
    const orig = r[m].bind(r);
    r[m] = (p, ...hs) => orig(p, ...hs.map((h) => (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)));
  }
  return r;
}

/* ---------- API (connecté) ---------- */
const api = safeRouter();

api.get("/billing/settings", async (req, res) => {
  const b = await getBilling();
  res.json({ ...b, stripe: stripe.status(), defaultLogo: DEFAULT_LOGO });
});
api.put("/billing/settings", async (req, res) => {
  try { res.json(await saveBilling(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});

api.get("/invoices", async (req, res) => {
  const r = await q(`SELECT i.*, l.company AS lead_company, l.name AS lead_name FROM invoices i LEFT JOIN leads l ON l.id=i.lead_id ORDER BY i.created_at DESC LIMIT 500`);
  const links = await q(`SELECT * FROM payment_links ORDER BY created_at DESC LIMIT 200`);
  const inv = r.rows.map(serialize);
  const sum = (f) => inv.filter(f).reduce((s, x) => s + x.total_cents, 0);
  res.json({
    invoices: inv,
    links: links.rows.map(serializeLink),
    totals: {
      paid: sum((x) => x.status === "payee") + links.rows.reduce((s, l) => s + l.paid_cents, 0),
      pending: sum((x) => x.status === "emise"),
      overdue: sum((x) => x.status === "emise" && x.due_date && new Date(x.due_date) < new Date(new Date().toDateString())),
      count: inv.filter((x) => x.status !== "annulee").length,
    },
    stripe: stripe.status(),
  });
});

function readBody(b) {
  const items = cleanItems(b.items);
  if (!items.length) throw new Error("Ajoute au moins une ligne avec un libellé et un montant");
  const c = b.client || {};
  const client = {
    name: String(c.name || "").trim().slice(0, 200),
    company: String(c.company || "").trim().slice(0, 200),
    email: String(c.email || "").trim().slice(0, 200),
    address: String(c.address || "").trim().slice(0, 600),
    vat: String(c.vat || "").trim().slice(0, 60),
  };
  if (!client.name && !client.company) throw new Error("Indique le nom du client ou de son entreprise");
  if (client.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(client.email)) throw new Error("Email du client invalide");
  const vatRate = Math.max(0, Math.min(100, Number(String(b.vatRate ?? 0).replace(",", ".")) || 0));
  const t = totals(items, vatRate);
  if (t.total < 50) throw new Error("Le total doit être d'au moins 0,50 €");
  const date = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  return { items, client, vatRate, t, title: String(b.title || "").trim().slice(0, 200), notes: String(b.notes || "").trim().slice(0, 2000),
    issue: date(b.issueDate), due: date(b.dueDate), leadId: Number(b.leadId) || null };
}

api.post("/invoices", async (req, res) => {
  let d;
  try { d = readBody(req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
  const b = await getBilling();
  for (let attempt = 0; attempt < 3; attempt++) {
    const number = await nextNumber(b.prefix);
    try {
      const r = await q(
        `INSERT INTO invoices (number, token, lead_id, title, client, items, vat_rate, subtotal_cents, vat_cents, total_cents, issue_date, due_date, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::date, CURRENT_DATE),$12,$13) RETURNING *`,
        [number, crypto.randomBytes(18).toString("base64url"), d.leadId, d.title, d.client, JSON.stringify(d.items), d.vatRate, d.t.subtotal, d.t.vat, d.t.total, d.issue, d.due, d.notes]
      );
      if (d.leadId && d.client.email) await q(`UPDATE leads SET email=COALESCE(NULLIF(email,''), $2) WHERE id=$1`, [d.leadId, d.client.email]).catch(() => {});
      return res.json({ invoice: serialize(r.rows[0]) });
    } catch (e) {
      if (e.code !== "23505") throw e;
    }
  }
  res.status(409).json({ error: "Numéro de facture déjà pris, réessaie" });
});

api.patch("/invoices/:id", async (req, res) => {
  const cur = (await q(`SELECT * FROM invoices WHERE id=$1`, [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: "Facture introuvable" });
  if (cur.status === "payee") return res.status(409).json({ error: "Une facture payée ne se modifie plus" });
  let d;
  try { d = readBody(req.body || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
  const changedAmount = d.t.total !== cur.total_cents;
  const r = await q(
    `UPDATE invoices SET lead_id=$2, title=$3, client=$4, items=$5, vat_rate=$6, subtotal_cents=$7, vat_cents=$8, total_cents=$9,
       issue_date=COALESCE($10::date, issue_date), due_date=$11, notes=$12,
       payment_link_id=CASE WHEN $13 THEN NULL ELSE payment_link_id END, payment_link_url=CASE WHEN $13 THEN NULL ELSE payment_link_url END
     WHERE id=$1 RETURNING *`,
    [cur.id, d.leadId, d.title, d.client, JSON.stringify(d.items), d.vatRate, d.t.subtotal, d.t.vat, d.t.total, d.issue, d.due, d.notes, changedAmount]
  );
  if (changedAmount && cur.payment_link_id) stripe.call("POST", `/payment_links/${cur.payment_link_id}`, { active: false }).catch(() => {});
  res.json({ invoice: serialize(r.rows[0]) });
});

// Lien de paiement Stripe direct pour une facture (à coller dans un SMS, WhatsApp…)
api.post("/invoices/:id/payment-link", async (req, res) => {
  const inv = (await q(`SELECT * FROM invoices WHERE id=$1`, [req.params.id])).rows[0];
  if (!inv) return res.status(404).json({ error: "Facture introuvable" });
  if (inv.status !== "emise") return res.status(409).json({ error: "Cette facture n'est plus à payer" });
  if (inv.payment_link_url) return res.json({ url: inv.payment_link_url });
  try {
    const b = await getBilling();
    const price = await stripe.call("POST", "/prices", {
      currency: inv.currency, unit_amount: inv.total_cents,
      product_data: { name: `Facture ${inv.number}${inv.title ? " — " + inv.title : ""} · ${b.company}`.slice(0, 250) },
    });
    const link = await stripe.call("POST", "/payment_links", {
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: { invoice_id: String(inv.id), invoice_number: inv.number },
      payment_intent_data: { description: `Facture ${inv.number}`, metadata: { invoice_id: String(inv.id) } },
      after_completion: base() ? { type: "redirect", redirect: { url: invoiceUrl(inv) } } : undefined,
    });
    await q(`UPDATE invoices SET payment_link_id=$2, payment_link_url=$3 WHERE id=$1`, [inv.id, link.id, link.url]);
    res.json({ url: link.url });
  } catch (e) { res.status(e.code === "stripe_off" ? 409 : 502).json({ error: e.message }); }
});

// Connexion Stripe depuis l'app (sans passer par Railway)
api.post("/stripe/connect", async (req, res) => {
  try { res.json({ stripe: await stripe.connect(req.body && req.body.key, req.body && req.body.publishableKey) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
api.post("/stripe/publishable", async (req, res) => {
  try { res.json({ stripe: await stripe.setPublishable(req.body && req.body.publishableKey) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
api.post("/stripe/disconnect", async (req, res) => {
  if (stripe.status().source === "railway") return res.status(400).json({ error: "Ta clé est dans Railway (STRIPE_SECRET_KEY) : retire-la là-bas" });
  await stripe.disconnect(); res.json({ stripe: stripe.status() });
});

// Envoi de la facture par email (aux couleurs de Biznify, bouton « Voir et payer »)
api.post("/invoices/:id/send", async (req, res) => {
  const inv = (await q(`SELECT * FROM invoices WHERE id=$1`, [req.params.id])).rows[0];
  if (!inv) return res.status(404).json({ error: "Facture introuvable" });
  try {
    await mailer.invoiceSend(inv, { message: req.body && req.body.message ? String(req.body.message).slice(0, 3000) : null });
    await q(`UPDATE invoices SET notes=notes WHERE id=$1`, [inv.id]);
    res.json({ ok: true, to: inv.client.email });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

api.post("/invoices/:id/status", async (req, res) => {
  const st = req.body && req.body.status;
  if (st === "payee") { const inv = await markPaid(Number(req.params.id), "manuel", null); return res.json({ ok: true, changed: !!inv }); }
  if (st !== "emise" && st !== "annulee") return res.status(400).json({ error: "Statut invalide" });
  const r = await q(`UPDATE invoices SET status=$2, paid_at=CASE WHEN $2='emise' THEN NULL ELSE paid_at END, paid_via=CASE WHEN $2='emise' THEN NULL ELSE paid_via END WHERE id=$1 RETURNING *`, [req.params.id, st]);
  if (!r.rows[0]) return res.status(404).json({ error: "Facture introuvable" });
  if (st === "annulee" && r.rows[0].payment_link_id) stripe.call("POST", `/payment_links/${r.rows[0].payment_link_id}`, { active: false }).catch(() => {});
  res.json({ invoice: serialize(r.rows[0]) });
});

api.delete("/invoices/:id", async (req, res) => {
  const r = await q(`DELETE FROM invoices WHERE id=$1 AND status <> 'payee' RETURNING payment_link_id`, [req.params.id]);
  if (!r.rows[0]) return res.status(409).json({ error: "Facture introuvable ou déjà payée (annule-la plutôt)" });
  if (r.rows[0].payment_link_id) stripe.call("POST", `/payment_links/${r.rows[0].payment_link_id}`, { active: false }).catch(() => {});
  res.json({ ok: true });
});

// Lien de paiement rapide, sans facture
api.post("/payment-links", async (req, res) => {
  const label = String((req.body && req.body.label) || "").trim().slice(0, 200);
  const amount = cents(req.body && req.body.amount);
  if (!label) return res.status(400).json({ error: "Indique ce que le client paie" });
  if (amount < 50) return res.status(400).json({ error: "Montant minimum : 0,50 €" });
  try {
    const b = await getBilling();
    const price = await stripe.call("POST", "/prices", { currency: "eur", unit_amount: amount, product_data: { name: `${label} · ${b.company}`.slice(0, 250) } });
    const link = await stripe.call("POST", "/payment_links", { line_items: [{ price: price.id, quantity: 1 }], metadata: { closer: "lien" } });
    const r = await q(`INSERT INTO payment_links (label, amount_cents, lead_id, stripe_id, url) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [label, amount, Number(req.body.leadId) || null, link.id, link.url]);
    res.json({ link: serializeLink(r.rows[0]) });
  } catch (e) { res.status(e.code === "stripe_off" ? 409 : 502).json({ error: e.message }); }
});
api.post("/payment-links/:id/disable", async (req, res) => {
  const r = await q(`UPDATE payment_links SET active=false WHERE id=$1 RETURNING stripe_id`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Lien introuvable" });
  if (r.rows[0].stripe_id) await stripe.call("POST", `/payment_links/${r.rows[0].stripe_id}`, { active: false }).catch(() => {});
  res.json({ ok: true });
});

/* ---------- Webhook Stripe (corps brut) ---------- */
async function webhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  if (!(await stripe.verify(raw, req.get("stripe-signature")))) return res.status(400).send("signature invalide");
  let ev;
  try { ev = JSON.parse(raw); } catch { return res.status(400).send("json"); }
  try {
    if (ev.type === "checkout.session.completed" || ev.type === "checkout.session.async_payment_succeeded") await handleSession(ev.data.object);
  } catch (e) { console.warn("Webhook Stripe :", e.message); return res.status(500).send("erreur"); }
  res.json({ received: true });
}

/* ---------- Page publique de la facture ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (c, cur = "eur") => new Intl.NumberFormat("fr-FR", { style: "currency", currency: cur.toUpperCase() }).format((c || 0) / 100);
const day = (d) => (d ? new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" }) : "");
const nl = (s) => esc(s).replace(/\n/g, "<br>");

function page(inv, b, flash) {
  const logo = b.logo || DEFAULT_LOGO;
  const paid = inv.status === "payee";
  const cancelled = inv.status === "annulee";
  const c = inv.client || {};
  const accent = b.accent || "#1877F2";
  const items = (inv.items || []).map((it) => `<tr><td>${esc(it.label)}</td><td class="n">${String(it.qty).replace(".", ",")}</td><td class="n hide-s">${money(it.unit_cents, inv.currency)}</td><td class="n">${money(Math.round(it.qty * it.unit_cents), inv.currency)}</td></tr>`).join("");
  const overdue = !paid && !cancelled && inv.due_date && new Date(inv.due_date) < new Date(new Date().toDateString());
  const status = paid ? `<span class="st ok">Payée${inv.paid_at ? " le " + day(inv.paid_at) : ""}</span>` : cancelled ? `<span class="st off">Annulée</span>` : overdue ? `<span class="st late">En retard</span>` : `<span class="st due">À payer</span>`;
  const canPay = !paid && !cancelled && stripe.enabled();
  const inPage = canPay && !!stripe.publishableKey();
  const pdf = `/facture/${esc(inv.token)}/pdf`;
  const payBox = paid
    ? `<div class="paybox done"><div><b>Merci, cette facture est réglée.</b><p>Paiement de ${money(inv.total_cents, inv.currency)} reçu${inv.paid_at ? " le " + day(inv.paid_at) : ""}.</p></div><a class="dl" href="${pdf}">Télécharger la facture (PDF)</a></div>`
    : cancelled ? `<div class="paybox"><div><b>Cette facture a été annulée.</b><p>Aucun paiement n'est demandé.</p></div></div>`
    : `<div class="paybox"><div><span class="lbl">Montant à régler</span><span class="big">${money(inv.total_cents, inv.currency)}</span>${inv.due_date ? `<p>Échéance : ${day(inv.due_date)}</p>` : ""}</div>
       ${canPay ? `<form method="post" action="/facture/${esc(inv.token)}/payer" id="payform"><button class="pay" type="submit" id="paybtn">Payer ${money(inv.total_cents, inv.currency)}</button><p class="secure">Paiement sécurisé par carte bancaire avec Stripe</p></form>` : `<p class="secure">Le paiement en ligne n'est pas encore disponible. Contacte ${esc(b.email || b.company)}.</p>`}</div>
`;
  const fromLines = [b.address, b.registration, b.vatNumber ? "N° TVA : " + b.vatNumber : "", [b.email, b.phone].filter(Boolean).join(" · "), b.website].filter(Boolean);
  const toLines = [c.company && c.name ? c.name : "", c.address, c.vat ? "N° TVA : " + c.vat : "", c.email].filter(Boolean);
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Facture ${esc(inv.number)} — ${esc(b.company)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--a:${accent};--ink:#0B1220;--mut:#5B6475;--line:#E4E7EE;--soft:#F5F7FB}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--soft);color:var(--ink);font:15px/1.55 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:40px 20px 64px}
.flash{background:#E9F8F0;color:#11643C;border:1px solid #BDE8D0;border-radius:12px;padding:12px 16px;margin-bottom:18px;font-weight:500}
.flash.warn{background:#FFF6E5;color:#7A4D00;border-color:#F5DDA8}
.paper{background:#fff;border:1px solid var(--line);border-radius:18px;box-shadow:0 1px 2px rgba(11,18,32,.04),0 12px 40px rgba(11,18,32,.06);overflow:hidden}
.band{height:6px;background:var(--a)}
.top{display:flex;justify-content:space-between;gap:24px;padding:36px 44px 8px;align-items:flex-start}
.logo{height:40px;width:auto;display:block}
.brandtxt{font-weight:700;font-size:22px;letter-spacing:-.02em}
.tag{color:var(--mut);font-size:13px;margin-top:6px}
.meta{text-align:right}
.meta h1{margin:0;font-size:28px;letter-spacing:-.025em}
.meta .num{color:var(--mut);font-size:14px;margin-top:2px}
.st{display:inline-block;margin-top:10px;font-size:12.5px;font-weight:600;padding:4px 10px;border-radius:999px}
.st.ok{background:#E9F8F0;color:#11643C}.st.due{background:#EEF4FF;color:#1D4ED8}.st.late{background:#FDECEC;color:#A12A2A}.st.off{background:#EEF0F4;color:var(--mut)}
.parties{display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;padding:28px 44px;border-bottom:1px solid var(--line)}
.parties h2{margin:0 0 6px;font-size:12px;font-weight:600;color:var(--mut)}
.parties p{margin:0;font-size:14px}.parties b{font-size:15px}
.title{padding:24px 44px 0;font-weight:600;font-size:16px}
table{width:100%;border-collapse:collapse;margin-top:12px}
th{font-size:12px;font-weight:600;color:var(--mut);text-align:left;padding:12px 44px 10px;border-bottom:1px solid var(--line)}
td{padding:14px 44px;border-bottom:1px solid var(--line);vertical-align:top}
th.n,td.n{text-align:right;white-space:nowrap;padding-left:8px}
th:not(:first-child),td:not(:first-child){padding-left:8px}
th:not(:last-child),td:not(:last-child){padding-right:8px}
.sum{display:flex;justify-content:flex-end;padding:18px 44px 8px}
.sum dl{margin:0;min-width:280px;display:grid;grid-template-columns:1fr auto;gap:8px 0;font-size:14px}
.sum dt{color:var(--mut)}.sum dd{margin:0;padding-left:24px;text-align:right;font-variant-numeric:tabular-nums}
.sum .tot{font-size:18px;font-weight:700;color:var(--ink);padding-top:10px;border-top:2px solid var(--ink)}
.vatm{padding:0 44px;text-align:right;font-size:12.5px;color:var(--mut)}
.paybox{margin:28px 44px;border:1px solid var(--line);background:var(--soft);border-radius:14px;padding:22px 24px;display:flex;justify-content:space-between;align-items:center;gap:20px;flex-wrap:wrap}
.paybox.done{background:#E9F8F0;border-color:#BDE8D0;color:#11643C}
.paybox p{margin:4px 0 0;font-size:13px;color:var(--mut)}.paybox.done p{color:#11643C}
.paybox .lbl{display:block;font-size:13px;color:var(--mut)}
.paybox .big{display:block;font-size:30px;font-weight:700;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.paybox form{text-align:center;margin:0}
.pay{appearance:none;border:0;background:var(--a);color:#fff;font:600 16px Inter,system-ui,sans-serif;padding:16px 34px;border-radius:12px;cursor:pointer;min-width:240px;box-shadow:0 6px 18px color-mix(in srgb,var(--a) 35%,transparent)}
.pay:hover{filter:brightness(1.07)}.pay:focus-visible{outline:3px solid var(--ink);outline-offset:3px}
.secure{font-size:12px;color:var(--mut);margin:8px 0 0}
.notes{padding:0 44px 24px;font-size:13.5px;color:var(--mut)}
.notes b{color:var(--ink);font-weight:600;display:block;margin-bottom:2px}
.foot{padding:20px 44px 28px;border-top:1px solid var(--line);font-size:12px;color:var(--mut)}
.tools{display:flex;justify-content:center;gap:10px;margin-top:18px}
.dl{display:inline-block;background:#11643C;color:#fff;text-decoration:none;font:600 14px Inter,system-ui,sans-serif;padding:12px 18px;border-radius:10px;white-space:nowrap}
.dl:focus-visible{outline:3px solid var(--ink);outline-offset:3px}
.checkout{margin:0 44px 28px;min-height:120px}
.tools a,.tools button{text-decoration:none;appearance:none;background:none;border:1px solid var(--line);background:#fff;color:var(--ink);border-radius:10px;padding:10px 16px;font:500 13.5px Inter,system-ui,sans-serif;cursor:pointer}
@media (max-width:680px){.top{flex-direction:column;padding:28px 22px 4px}.meta{text-align:left}.parties{grid-template-columns:1fr;padding:22px}.title{padding:20px 22px 0}th,td{padding-left:22px;padding-right:22px}.hide-s{display:none}.sum{padding:16px 22px 6px}.sum dl{min-width:0;width:100%}.vatm,.notes{padding-left:22px;padding-right:22px}.paybox{margin:22px;flex-direction:column;align-items:stretch;text-align:center}.pay{width:100%}.foot{padding:18px 22px 24px}}
@media (max-width:680px){.checkout{margin:0 12px 22px}.dl{width:100%;text-align:center}}
@media print{body{background:#fff}.wrap{padding:0;max-width:none}.paper{border:0;box-shadow:none;border-radius:0}.paybox form,.tools,.flash,.checkout,.dl{display:none}.paybox{background:#fff}}
</style></head><body><main class="wrap">
${flash ? `<div class="flash${flash.warn ? " warn" : ""}" role="status">${esc(flash.text)}</div>` : ""}
<article class="paper" aria-label="Facture ${esc(inv.number)}">
<div class="band"></div>
<header class="top">
  <div>${logo ? `<img class="logo" src="${logo}" alt="${esc(b.company)}">` : `<div class="brandtxt">${esc(b.company)}</div>`}${b.tagline ? `<div class="tag">${esc(b.tagline)}</div>` : ""}</div>
  <div class="meta"><h1>Facture</h1><div class="num">N° ${esc(inv.number)}</div>${status}</div>
</header>
<section class="parties">
  <div><h2>Émise par</h2><p><b>${esc(b.company)}</b></p>${fromLines.map((l) => `<p>${nl(l)}</p>`).join("")}</div>
  <div><h2>Facturée à</h2><p><b>${esc(c.company || c.name)}</b></p>${toLines.map((l) => `<p>${nl(l)}</p>`).join("")}</div>
  <div><h2>Dates</h2><p>Émise le ${day(inv.issue_date)}</p>${inv.due_date ? `<p>Échéance le ${day(inv.due_date)}</p>` : ""}</div>
</section>
${inv.title ? `<div class="title">${esc(inv.title)}</div>` : ""}
<table><thead><tr><th>Description</th><th class="n">Qté</th><th class="n hide-s">Prix unitaire HT</th><th class="n">Total HT</th></tr></thead><tbody>${items}</tbody></table>
<div class="sum"><dl><dt>Total HT</dt><dd>${money(inv.subtotal_cents, inv.currency)}</dd><dt>TVA ${String(Number(inv.vat_rate)).replace(".", ",")} %</dt><dd>${money(inv.vat_cents, inv.currency)}</dd><dt class="tot">Total TTC</dt><dd class="tot">${money(inv.total_cents, inv.currency)}</dd></dl></div>
${b.vatMention ? `<div class="vatm">${esc(b.vatMention)}</div>` : ""}
${payBox}
${inv.notes || b.paymentTerms ? `<div class="notes">${inv.notes ? `<p><b>Note</b>${nl(inv.notes)}</p>` : ""}${b.paymentTerms ? `<p><b>Conditions de paiement</b>${nl(b.paymentTerms)}</p>` : ""}</div>` : ""}
<footer class="foot">${esc([b.company, b.registration, b.footer].filter(Boolean).join(" — "))}</footer>
</article>
<div class="tools"><a href="${pdf}">Télécharger la facture (PDF)</a></div>
</main>
${inPage ? payPopup(`/facture/${inv.token}/session`, `/facture/${inv.token}`, accent) : ""}
${flash && flash.warn && /confirmation/.test(flash.text) ? `<script>
(function(){var n=0;var t=setInterval(async function(){n++;try{var r=await fetch("/facture/${esc(inv.token)}/etat");var j=await r.json();if(j.status==="payee"){clearInterval(t);location.replace(location.pathname+"?paye=1");}}catch(e){}if(n>40)clearInterval(t);},3000);})();
</script>` : ""}
</body></html>`;
}

// Fenêtre de paiement par carte (Stripe Embedded Checkout dans une fenêtre par-dessus la page)
function payPopup(sessionUrl, backUrl, accent) {
  return `<div class="pp" id="pp" role="dialog" aria-modal="true" aria-labelledby="pp-t" hidden>
  <div class="pp-box"><div class="pp-head"><b id="pp-t">Paiement sécurisé</b><button type="button" class="pp-x" id="pp-x" aria-label="Fermer">&times;</button></div>
  <div id="pp-co" class="pp-co"><p class="pp-wait">Chargement du formulaire de paiement…</p></div></div></div>
<style>
.pp{position:fixed;inset:0;z-index:50;background:rgba(11,18,32,.55);display:flex;align-items:flex-start;justify-content:center;padding:4vh 14px;overflow-y:auto}
.pp[hidden]{display:none}
.pp-box{background:#fff;border-radius:18px;width:100%;max-width:560px;box-shadow:0 30px 80px rgba(11,18,32,.35);overflow:hidden}
.pp-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #E4E7EE;border-top:5px solid ${accent}}
.pp-head b{font:600 15px Inter,system-ui,sans-serif;color:#0B1220}
.pp-x{appearance:none;border:0;background:#F5F7FB;width:34px;height:34px;border-radius:50%;font-size:22px;line-height:1;cursor:pointer;color:#0B1220}
.pp-x:focus-visible{outline:3px solid ${accent};outline-offset:2px}
.pp-co{min-height:200px;padding:8px 4px}
.pp-wait{text-align:center;color:#5B6475;font:14px Inter,system-ui,sans-serif;padding:60px 0}
body.pp-on{overflow:hidden}
@media (max-width:560px){.pp{padding:0}.pp-box{border-radius:0;min-height:100%}}
</style>
<script src="https://js.stripe.com/v3/"></script>
<script>
(function(){
  var form=document.getElementById("payform"),btn=document.getElementById("paybtn"),pp=document.getElementById("pp"),mount=document.getElementById("pp-co"),co=null,sid=null;
  if(!form)return;
  function close(){pp.hidden=true;document.body.classList.remove("pp-on");if(co){co.destroy();co=null;}mount.innerHTML='<p class="pp-wait">Chargement du formulaire de paiement…</p>';btn.disabled=false;btn.focus();}
  document.getElementById("pp-x").onclick=close;
  pp.addEventListener("click",function(e){if(e.target===pp)close();});
  document.addEventListener("keydown",function(e){if(e.key==="Escape"&&!pp.hidden)close();});
  form.addEventListener("submit",async function(e){
    if(!window.Stripe)return;
    e.preventDefault();btn.disabled=true;pp.hidden=false;document.body.classList.add("pp-on");
    try{
      var r=await fetch("${sessionUrl}",{method:"POST"});var j=await r.json();
      if(j.reload){location.reload();return;}
      if(!r.ok||!j.clientSecret)throw new Error(j.error||"erreur");
      sid=j.sessionId;
      var stripe=Stripe(j.publishableKey,{locale:"fr"});
      co=await stripe.initEmbeddedCheckout({clientSecret:j.clientSecret,onComplete:function(){
        mount.innerHTML='<p class="pp-wait"><b style="color:#11643C">Paiement reçu. Merci !</b><br>Mise à jour…</p>';
        setTimeout(function(){location.replace("${backUrl}?session_id="+encodeURIComponent(sid));},900);
      }});
      mount.innerHTML="";co.mount(mount);
    }catch(err){close();form.submit();}
  });
})();
</script>`;
}

async function checkoutParams(inv) {
  const b = await getBilling();
  return {
    mode: "payment",
    locale: "fr",
    line_items: [{ quantity: 1, price_data: { currency: inv.currency, unit_amount: inv.total_cents,
      product_data: { name: `Facture ${inv.number}`, description: (inv.title || `${b.company}`).slice(0, 300) } } }],
    customer_email: inv.client && inv.client.email ? inv.client.email : undefined,
    client_reference_id: String(inv.id),
    metadata: { invoice_id: String(inv.id), invoice_number: inv.number },
    payment_intent_data: { description: `Facture ${inv.number} — ${b.company}`, metadata: { invoice_id: String(inv.id) } },
  };
}

function linkPage(l, b, done) {
  const logo = b.logo || DEFAULT_LOGO;
  const accent = b.accent || "#1877F2";
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(l.label)} — ${esc(b.company)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box}body{margin:0;background:#F5F7FB;color:#0B1220;font:15px/1.55 Inter,system-ui,sans-serif}
.w{max-width:480px;margin:0 auto;padding:48px 18px}.c{background:#fff;border:1px solid #E4E7EE;border-radius:18px;overflow:hidden;box-shadow:0 12px 40px rgba(11,18,32,.06)}
.band{height:6px;background:${accent}}.in{padding:30px 30px 28px}.logo{height:34px;display:block;margin-bottom:26px}
.lbl{color:#5B6475;font-size:13px}.t{font-size:19px;font-weight:600;margin:2px 0 14px}.amt{font-size:34px;font-weight:700;letter-spacing:-.03em;margin-bottom:22px}
.pay{appearance:none;border:0;width:100%;background:${accent};color:#fff;font:600 16px Inter,system-ui,sans-serif;padding:16px;border-radius:12px;cursor:pointer}
.pay:focus-visible{outline:3px solid #0B1220;outline-offset:3px}.sec{text-align:center;font-size:12px;color:#5B6475;margin:10px 0 0}
.ok{background:#E9F8F0;color:#11643C;border-radius:12px;padding:16px;font-weight:600;text-align:center}.f{text-align:center;font-size:12px;color:#5B6475;margin-top:18px}</style></head>
<body><main class="w"><div class="c"><div class="band"></div><div class="in">
${logo ? `<img class="logo" src="${logo}" alt="${esc(b.company)}">` : ""}
<div class="lbl">Paiement à ${esc(b.company)}</div><div class="t">${esc(l.label)}</div><div class="amt">${money(l.amount_cents, l.currency || "eur")}</div>
${done ? `<div class="ok" role="status">Paiement reçu. Merci !</div>` : `<form id="payform" method="get" action="${esc(l.url)}"><button class="pay" id="paybtn" type="submit">Payer ${money(l.amount_cents, l.currency || "eur")}</button><p class="sec">Paiement sécurisé par carte bancaire avec Stripe</p></form>`}
</div></div><p class="f">${esc([b.company, b.registration].filter(Boolean).join(" — "))}</p></main>
${done ? "" : payPopup(`/p/${l.id}/session`, `/p/${l.id}`, accent)}
</body></html>`;
}

function publicRoutes(isOwner) {
  const r = safeRouter();
  // lien de paiement court : pay.biznify.pro/p/12 → page de paiement Stripe
  r.get("/p/:id", async (req, res) => {
    const l = /^\d+$/.test(req.params.id) ? (await q(`SELECT url, active FROM payment_links WHERE id=$1`, [req.params.id])).rows[0] : null;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex");
    if (!l || !l.active) return res.status(404).send("<!DOCTYPE html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Lien expiré</title><p style=\"font-family:system-ui;padding:40px;color:#0B1220\">Ce lien de paiement n'est plus actif. Contactez Biznify pour en recevoir un nouveau.</p>");
    if (!stripe.publishableKey()) return res.redirect(302, l.url);
    const link = (await q(`SELECT * FROM payment_links WHERE id=$1`, [req.params.id])).rows[0];
    let done = false;
    const sid = String(req.query.session_id || "");
    if (/^cs_[A-Za-z0-9_]+$/.test(sid)) {
      try { const s = await stripe.call("GET", `/checkout/sessions/${sid}`); if (Number((s.metadata || {}).link_id) === link.id) { await handleSession(s); done = s.payment_status === "paid"; } } catch (e) { console.warn("Vérification Stripe :", e.message); }
    }
    res.send(linkPage(link, await getBilling(), done));
  });
  r.post("/p/:id/session", async (req, res) => {
    const l = /^\d+$/.test(req.params.id) ? (await q(`SELECT * FROM payment_links WHERE id=$1`, [req.params.id])).rows[0] : null;
    if (!l || !l.active) return res.status(404).json({ error: "Lien inactif", reload: true });
    if (!stripe.publishableKey()) return res.status(409).json({ error: "Paiement intégré indisponible" });
    try {
      const b = await getBilling();
      const back = `${payBase() || `${req.protocol}://${req.get("host")}`}/p/${l.id}`;
      const s = await stripe.call("POST", "/checkout/sessions", {
        mode: "payment", locale: "fr", ui_mode: "embedded", redirect_on_completion: "if_required", return_url: `${back}?session_id={CHECKOUT_SESSION_ID}`,
        line_items: [{ quantity: 1, price_data: { currency: l.currency || "eur", unit_amount: l.amount_cents, product_data: { name: l.label.slice(0, 250), description: b.company } } }],
        metadata: { link_id: String(l.id) },
        payment_intent_data: { description: `${l.label} — ${b.company}`.slice(0, 500), metadata: { link_id: String(l.id) } },
      });
      res.json({ clientSecret: s.client_secret, sessionId: s.id, publishableKey: stripe.publishableKey() });
    } catch (e) { console.warn("Checkout lien :", e.message); res.status(502).json({ error: "Le paiement en ligne est momentanément indisponible" }); }
  });
  r.get("/facture/:token", async (req, res) => {
    const inv = (await q(`SELECT * FROM invoices WHERE token=$1`, [req.params.token])).rows[0];
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex");
    if (!inv) return res.status(404).send("<!DOCTYPE html><meta charset=utf-8><title>Facture introuvable</title><p style=\"font-family:system-ui;padding:40px\">Cette facture n'existe pas ou a été supprimée.</p>");
    let flash = null;
    const sid = String(req.query.session_id || "");
    if (sid && inv.status === "emise" && /^cs_[A-Za-z0-9_]+$/.test(sid)) {
      try {
        const s = await stripe.call("GET", `/checkout/sessions/${sid}`);
        if (Number((s.metadata || {}).invoice_id) === inv.id) await handleSession(s);
      } catch (e) { console.warn("Vérification Stripe :", e.message); }
    }
    const cur = (await q(`SELECT * FROM invoices WHERE id=$1`, [inv.id])).rows[0];
    if ((sid || req.query.paye) && cur.status === "payee") flash = { text: "Paiement reçu. Merci ! Votre facture est à jour et téléchargeable en PDF." };
    else if (sid) flash = { text: "Paiement en cours de confirmation. Cette page se met à jour dès que Stripe le valide.", warn: true };
    else if (req.query.annule) flash = { text: "Paiement annulé. Vous pouvez réessayer quand vous voulez.", warn: true };
    if (!cur.viewed_at && !isOwner(req)) await q(`UPDATE invoices SET viewed_at=now() WHERE id=$1`, [cur.id]).catch(() => {});
    res.send(page(cur, await getBilling(), flash));
  });

  // PDF de la facture (client et propriétaire)
  r.get("/facture/:token/pdf", async (req, res) => {
    const inv = (await q(`SELECT * FROM invoices WHERE token=$1`, [req.params.token])).rows[0];
    if (!inv) return res.status(404).send("Facture introuvable");
    const b = await getBilling();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex");
    res.setHeader("Content-Disposition", `${req.query.voir ? "inline" : "attachment"}; filename="Facture-${inv.number.replace(/[^A-Za-z0-9-]/g, "")}.pdf"`);
    invoicePdf.render({ ...inv, pay_url: inv.status === "emise" && stripe.enabled() ? invoiceUrl(inv) : null }, b).pipe(res);
  });

  // Paiement intégré dans la page (Stripe Embedded Checkout)
  r.post("/facture/:token/session", async (req, res) => {
    const inv = (await q(`SELECT * FROM invoices WHERE token=$1`, [req.params.token])).rows[0];
    if (!inv) return res.status(404).json({ error: "Facture introuvable" });
    if (inv.status !== "emise") return res.status(409).json({ error: "Cette facture n'est plus à payer", reload: true });
    if (!stripe.publishableKey()) return res.status(409).json({ error: "Paiement intégré indisponible" });
    try {
      const url = invoiceUrl(inv) || `${req.protocol}://${req.get("host")}/facture/${inv.token}`;
      const s = await stripe.call("POST", "/checkout/sessions", { ...(await checkoutParams(inv)), ui_mode: "embedded", redirect_on_completion: "if_required", return_url: `${url}?session_id={CHECKOUT_SESSION_ID}` });
      res.json({ clientSecret: s.client_secret, sessionId: s.id, publishableKey: stripe.publishableKey() });
    } catch (e) { console.warn("Checkout intégré :", e.message); res.status(502).json({ error: "Le paiement en ligne est momentanément indisponible" }); }
  });

  // État de paiement (la page se met à jour toute seule)
  r.get("/facture/:token/etat", async (req, res) => {
    const inv = (await q(`SELECT status FROM invoices WHERE token=$1`, [req.params.token])).rows[0];
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: inv ? inv.status : null });
  });

  r.post("/facture/:token/payer", async (req, res) => {
    const inv = (await q(`SELECT * FROM invoices WHERE token=$1`, [req.params.token])).rows[0];
    if (!inv) return res.status(404).send("Facture introuvable");
    if (inv.status !== "emise") return res.redirect(303, `/facture/${inv.token}`);
    try {
      const b = await getBilling();
      const url = invoiceUrl(inv) || `${req.protocol}://${req.get("host")}/facture/${inv.token}`;
      const s = await stripe.call("POST", "/checkout/sessions", {
        ...(await checkoutParams(inv)),
        success_url: `${url}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${url}?annule=1`,
      });
      res.redirect(303, s.url);
    } catch (e) {
      console.warn("Checkout Stripe :", e.message);
      res.status(502).send(`<!DOCTYPE html><meta charset=utf-8><title>Paiement indisponible</title><p style="font-family:system-ui;padding:40px">Le paiement en ligne est momentanément indisponible. <a href="/facture/${esc(inv.token)}">Revenir à la facture</a></p>`);
    }
  });
  return r;
}

module.exports = { api, webhook, publicRoutes };
