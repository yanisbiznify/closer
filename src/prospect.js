// Prospection : recherche de leads sur Google Maps via Apify, ajoutés directement au pipeline cold call
const express = require("express");
const crypto = require("crypto");
const config = require("./config");
const { q } = require("./db");
const tw = require("./twilio");
const activity = require("./activity");

const ACTOR = "compass~crawler-google-places";
const APIFY = "https://api.apify.com/v2";

async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS scrape_jobs (
      id          SERIAL PRIMARY KEY,
      query       TEXT NOT NULL,
      locations   JSONB NOT NULL DEFAULT '[]',
      max_per     INTEGER NOT NULL,
      filters     JSONB NOT NULL DEFAULT '{}',
      list_id     INTEGER,
      status      TEXT NOT NULL DEFAULT 'en_cours',
      run_id      TEXT,
      dataset_id  TEXT,
      found       INTEGER NOT NULL DEFAULT 0,
      added       INTEGER NOT NULL DEFAULT 0,
      skipped     JSONB NOT NULL DEFAULT '{}',
      cost_usd    NUMERIC(10,3),
      error       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    );
  `);
}

/* ---------- Jeton Apify (chiffré en base, ou variable APIFY_TOKEN) ---------- */
const cipherKey = () => crypto.createHash("sha256").update("apify-key:" + (config.sessionSecret || "closer")).digest();
function seal(t) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", cipherKey(), iv); const e = Buffer.concat([c.update(t, "utf8"), c.final()]); return [iv, c.getAuthTag(), e].map((b) => b.toString("base64")).join("."); }
function unseal(s) { const [iv, tag, e] = String(s).split(".").map((x) => Buffer.from(x, "base64")); const d = crypto.createDecipheriv("aes-256-gcm", cipherKey(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(e), d.final()]).toString("utf8"); }
async function state() { const r = await q(`SELECT value FROM settings WHERE key='apify'`); return r.rows[0] ? r.rows[0].value : {}; }
async function token() {
  if (process.env.APIFY_TOKEN) return process.env.APIFY_TOKEN;
  const st = await state();
  if (!st.sealed) return null;
  try { return unseal(st.sealed); } catch { return null; }
}
async function apify(method, path, body, tok) {
  const t = tok || (await token());
  if (!t) { const e = new Error("Connecte Apify pour lancer une recherche"); e.code = "apify_off"; throw e; }
  const r = await fetch(APIFY + path, { method, headers: { Authorization: `Bearer ${t}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `Apify ${r.status}`);
  return j.data !== undefined ? j.data : j;
}
async function status() {
  const st = await state();
  const t = await token();
  return { connected: !!t, account: st.username || null, source: process.env.APIFY_TOKEN ? "railway" : t ? "app" : null };
}

/* ---------- Liste cible : le pipeline cold call ---------- */
async function coldList() {
  const r = await q(`SELECT id FROM lists WHERE name ILIKE '%cold%' ORDER BY created_at LIMIT 1`);
  if (r.rows[0]) return r.rows[0].id;
  return (await q(`INSERT INTO lists (name, source) VALUES ('Cold call','manuel') RETURNING id`)).rows[0].id;
}

/* ---------- Lancement et suivi ---------- */
async function startJob(b) {
  const query = String(b.query || "").trim().slice(0, 120);
  const locations = (Array.isArray(b.locations) ? b.locations : String(b.locations || "").split(/[,\n;]/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 15);
  if (!query) throw Object.assign(new Error("Indique le métier ou le type d'entreprise à chercher"), { status: 400 });
  if (!locations.length) throw Object.assign(new Error("Indique au moins une ville"), { status: 400 });
  const max = Math.max(5, Math.min(300, Math.round(Number(b.max) || 50)));
  const f = b.filters || {};
  const filters = { phone: f.phone !== false, noWebsite: !!f.noWebsite, minRating: Math.max(0, Math.min(5, Number(f.minRating) || 0)), minReviews: Math.max(0, Number(f.minReviews) || 0), skipClosed: f.skipClosed !== false };
  let listId = Number(b.listId) || null;
  if (b.newList) listId = (await q(`INSERT INTO lists (name, source) VALUES ($1,'maps') RETURNING id`, [String(b.newList).trim().slice(0, 120)])).rows[0].id;
  if (!listId) listId = await coldList();
  const input = {
    searchStringsArray: locations.map((l) => `${query} ${l}`),
    maxCrawledPlacesPerSearch: max,
    language: "fr",
    countryCode: "fr",
    skipClosedPlaces: filters.skipClosed,
    scrapeContacts: !!f.emails,
    scrapePlaceDetailPage: false,
    maxImages: 0,
    maxReviews: 0,
  };
  const run = await apify("POST", `/acts/${ACTOR}/runs`, input);
  const r = await q(`INSERT INTO scrape_jobs (query, locations, max_per, filters, list_id, run_id, dataset_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [query, JSON.stringify(locations), max, { ...filters, emails: !!f.emails }, listId, run.id, run.defaultDatasetId]);
  return r.rows[0];
}

function pick(it) {
  return {
    company: it.title || it.name || null,
    phone: tw.normalizePhone(it.phoneUnformatted || it.phone || ""),
    website: it.website || null,
    maps: it.url || (it.placeId ? `https://www.google.com/maps/place/?q=place_id:${it.placeId}` : null),
    city: it.city || null,
    activity: it.categoryName || (Array.isArray(it.categories) ? it.categories[0] : null),
    rating: Number(it.totalScore) || 0,
    reviews: Number(it.reviewsCount) || 0,
    address: it.address || null,
    email: Array.isArray(it.emails) && it.emails[0] ? String(it.emails[0]).toLowerCase() : null,
    closed: !!(it.permanentlyClosed || it.temporarilyClosed),
  };
}

async function importItems(job, items) {
  const f = job.filters || {};
  const skipped = { sans_telephone: 0, deja_dans_crm: 0, filtres: 0, doublons: 0 };
  const seen = new Set();
  let added = 0;
  for (const raw of items) {
    const p = pick(raw);
    if (!p.phone) { skipped.sans_telephone++; continue; }
    if (seen.has(p.phone)) { skipped.doublons++; continue; }
    seen.add(p.phone);
    if ((f.noWebsite && p.website) || (f.minRating && p.rating < f.minRating) || (f.minReviews && p.reviews < f.minReviews) || (f.skipClosed && p.closed)) { skipped.filtres++; continue; }
    // déjà présent quelque part dans le CRM (n'importe quelle liste) : on ne le rajoute pas
    if ((await q(`SELECT 1 FROM leads WHERE phone=$1 LIMIT 1`, [p.phone])).rows.length) { skipped.deja_dans_crm++; continue; }
    const notes = [`Trouvé sur Google Maps (« ${job.query} »)`, p.rating ? `Note Google : ${String(p.rating).replace(".", ",")}/5 (${p.reviews} avis)` : "Pas d'avis Google", p.address ? `Adresse : ${p.address}` : null, p.website ? null : "Pas de site web"].filter(Boolean).join("\n");
    const ins = await q(
      `INSERT INTO leads (list_id, name, company, phone, email, city, activity, website, maps_url, source, stage, stage_at, notes)
       VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,'google maps','nouveau',now(),$9) ON CONFLICT (list_id, phone) DO NOTHING RETURNING id`,
      [job.list_id, p.company, p.phone, p.email, p.city, p.activity, p.website, p.maps, notes]
    );
    if (ins.rows[0]) added++; else skipped.deja_dans_crm++;
  }
  return { added, skipped };
}

async function check(job) {
  const run = await apify("GET", `/actor-runs/${job.run_id}`);
  if (["READY", "RUNNING"].includes(run.status)) return;
  if (run.status !== "SUCCEEDED") {
    await q(`UPDATE scrape_jobs SET status='erreur', error=$2, finished_at=now() WHERE id=$1`, [job.id, `La recherche Apify s'est arrêtée (${run.status})`]);
    return;
  }
  const items = [];
  for (let offset = 0; offset < 5000; offset += 1000) {
    const page = await apify("GET", `/datasets/${job.dataset_id}/items?clean=true&limit=1000&offset=${offset}`);
    const arr = Array.isArray(page) ? page : page.items || [];
    items.push(...arr);
    if (arr.length < 1000) break;
  }
  const { added, skipped } = await importItems(job, items);
  const cost = run.usageTotalUsd != null ? Number(run.usageTotalUsd) : null;
  await q(`UPDATE scrape_jobs SET status='termine', found=$2, added=$3, skipped=$4, cost_usd=$5, finished_at=now() WHERE id=$1`, [job.id, items.length, added, skipped, cost]);
  const list = (await q(`SELECT name FROM lists WHERE id=$1`, [job.list_id])).rows[0];
  await activity.log("prospect", { title: `${added} nouveau${added > 1 ? "x" : ""} prospect${added > 1 ? "s" : ""} « ${job.query} » ajouté${added > 1 ? "s" : ""} au pipeline`, detail: `${items.length} trouvés sur Google Maps · liste ${list ? list.name : ""}`, ref: `scrape:${job.id}` });
}

let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  try {
    const r = await q(`SELECT * FROM scrape_jobs WHERE status='en_cours' ORDER BY id`);
    for (const job of r.rows) {
      try { await check(job); }
      catch (e) {
        console.warn("Prospection :", e.message);
        if (Date.now() - new Date(job.created_at).getTime() > 3 * 3600e3) await q(`UPDATE scrape_jobs SET status='erreur', error=$2, finished_at=now() WHERE id=$1`, [job.id, e.message.slice(0, 300)]);
      }
    }
  } finally { ticking = false; }
}
function start() { setInterval(tick, 15000); setTimeout(tick, 8000); }

/* ---------- API ---------- */
const api = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => res.status(e.status || (e.code === "apify_off" ? 409 : 502)).json({ error: e.message, code: e.code }));

api.get("/prospect/meta", wrap(async (req, res) => {
  const lists = (await q(`SELECT l.id, l.name, count(le.id)::int AS n FROM lists l LEFT JOIN leads le ON le.list_id=l.id GROUP BY l.id ORDER BY l.created_at DESC`)).rows;
  res.json({ apify: await status(), lists, defaultList: (await q(`SELECT id FROM lists WHERE name ILIKE '%cold%' ORDER BY created_at LIMIT 1`)).rows[0]?.id || null });
}));
api.get("/prospect/jobs", wrap(async (req, res) => {
  const r = await q(`SELECT j.*, l.name AS list_name FROM scrape_jobs j LEFT JOIN lists l ON l.id=j.list_id ORDER BY j.id DESC LIMIT 30`);
  res.json({ jobs: r.rows });
}));
api.post("/prospect/jobs", wrap(async (req, res) => { const job = await startJob(req.body || {}); res.json({ job }); }));
api.post("/prospect/jobs/:id/refresh", wrap(async (req, res) => {
  const job = (await q(`SELECT * FROM scrape_jobs WHERE id=$1`, [req.params.id])).rows[0];
  if (job && job.status === "en_cours") await check(job);
  res.json({ job: (await q(`SELECT * FROM scrape_jobs WHERE id=$1`, [req.params.id])).rows[0] });
}));
api.post("/prospect/apify/connect", wrap(async (req, res) => {
  const tok = String((req.body && req.body.token) || "").trim();
  if (!/^apify_api_[A-Za-z0-9]{20,}$/.test(tok)) return res.status(400).json({ error: "Colle le jeton API Apify (il commence par apify_api_)" });
  let me;
  try { me = await apify("GET", "/users/me", null, tok); } catch { return res.status(400).json({ error: "Apify refuse ce jeton : vérifie que tu l'as copié en entier" }); }
  await q(`INSERT INTO settings (key, value) VALUES ('apify', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [{ sealed: seal(tok), username: me.username || me.email || null, connectedAt: new Date().toISOString() }]);
  res.json({ apify: await status() });
}));
api.post("/prospect/apify/disconnect", wrap(async (req, res) => { await q(`DELETE FROM settings WHERE key='apify'`); res.json({ apify: await status() }); }));

module.exports = { api, migrate, start, importItems, pick };
