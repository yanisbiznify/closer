// Objectifs : 3 mois, mois, semaine. Certains se mesurent tout seuls (CA, appels, RDV, clients).
const express = require("express");
const { q } = require("./db");
const { PAYMENTS } = require("./revenue");

const api = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const HORIZONS = ["trimestre", "mois", "semaine"];
const DOMAINS = ["pro", "perso"];
// check : je coche quand c'est fait · nombre : je note où j'en suis · le reste se calcule tout seul
const METRICS = ["check", "nombre", "ca", "ca_mois", "appels", "conversations", "rdv", "clients"];
const AUTO = new Set(["ca", "ca_mois", "appels", "conversations", "rdv", "clients"]);

async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS goals (
      id          SERIAL PRIMARY KEY,
      horizon     TEXT NOT NULL DEFAULT 'semaine',   -- trimestre | mois | semaine
      domain      TEXT NOT NULL DEFAULT 'pro',       -- pro | perso
      title       TEXT NOT NULL,
      metric      TEXT NOT NULL DEFAULT 'check',     -- check | nombre | ca | ca_mois | appels | conversations | rdv | clients
      target      NUMERIC(14,2),
      current     NUMERIC(14,2) NOT NULL DEFAULT 0,
      unit        TEXT,
      start_date  DATE NOT NULL,
      end_date    DATE NOT NULL,
      done_at     TIMESTAMPTZ,
      notes       TEXT,
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS goals_period_idx ON goals (end_date, horizon);
    ALTER TABLE goals ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'up'; -- up : monter jusqu'à la cible · down : descendre (poids…)
    ALTER TABLE goals ADD COLUMN IF NOT EXISTS baseline NUMERIC(14,2);               -- point de départ d'un objectif « down »
  `);
}

/* ---------- Dates (AAAA-MM-JJ, dans le fuseau de l'utilisateur) ---------- */
// Le fuseau doit être connu à la fois de Node et de Postgres (certains navigateurs donnent d'anciens noms, ex. Asia/Saigon)
const TZ_ALIAS = { "Asia/Saigon": "Asia/Ho_Chi_Minh", "Asia/Calcutta": "Asia/Kolkata", "Asia/Katmandu": "Asia/Kathmandu", "Asia/Rangoon": "Asia/Yangon" };
const tzOk = new Map();
async function validTz(raw) {
  const tz = TZ_ALIAS[raw] || String(raw || "");
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return "Europe/Paris";
  if (!tzOk.has(tz)) {
    let ok = false;
    try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); ok = (await q(`SELECT 1 FROM pg_timezone_names WHERE name=$1`, [tz])).rows.length > 0; } catch {}
    tzOk.set(tz, ok);
  }
  return tzOk.get(tz) ? tz : "Europe/Paris";
}
const todayIn = (tz) => new Date().toLocaleDateString("en-CA", { timeZone: tz });
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
function addDays(d, n) { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function addMonths(d, n) {
  const [y, m, day] = d.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return x.toISOString().slice(0, 10);
}
// Période par défaut d'un horizon, autour d'une date : semaine du lundi au dimanche, mois civil, 3 mois glissants
function periodFor(horizon, d) {
  if (horizon === "semaine") {
    const wd = (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7; // lundi = 0
    const start = addDays(d, -wd);
    return { start, end: addDays(start, 6) };
  }
  if (horizon === "mois") {
    const start = d.slice(0, 8) + "01";
    return { start, end: addDays(addMonths(start, 1), -1) };
  }
  return { start: d, end: addDays(addMonths(d, 3), -1) };
}

/* ---------- Mesures automatiques ---------- */
// Bornes [début, fin] incluses, en heure locale de l'utilisateur
async function measure(metric, start, end, tz) {
  const B = [start, addDays(end, 1), tz];
  const inR = (col) => `${col} >= ($1::timestamp AT TIME ZONE $3) AND ${col} < ($2::timestamp AT TIME ZONE $3)`;
  if (metric === "ca") {
    const r = await q(`SELECT COALESCE(sum(cents),0)::bigint AS v FROM (${PAYMENTS}) p WHERE ${inR("at")}`, B);
    return Number(r.rows[0].v) / 100;
  }
  if (metric === "appels" || metric === "conversations") {
    const r = await q(`SELECT count(*)::int AS v FROM calls WHERE ${inR("date")} ${metric === "conversations" ? "AND duration >= 30" : ""}`, B);
    return r.rows[0].v;
  }
  if (metric === "rdv") {
    const r = await q(`SELECT count(*)::int AS v FROM (
        SELECT 'L' || lead_id::text AS k FROM appointments WHERE lead_id IS NOT NULL AND ${inR("created_at")}
        UNION SELECT 'A' || id::text FROM appointments WHERE lead_id IS NULL AND ${inR("created_at")}
        UNION SELECT 'L' || id::text FROM leads WHERE status = 'rdv' AND ${inR("outcome_at")}
      ) x`, B);
    return r.rows[0].v;
  }
  if (metric === "clients") {
    const r = await q(`SELECT count(*)::int AS v FROM (
        SELECT 'L' || id::text AS k FROM leads WHERE stage = 'gagne' AND ${inR("stage_at")}
        UNION SELECT client_key FROM (${PAYMENTS}) p WHERE ${inR("at")}
      ) y`, B);
    return r.rows[0].v;
  }
  return null;
}

async function withProgress(g, tz, today) {
  const out = { ...g, target: g.target == null ? null : Number(g.target), current: Number(g.current) };
  let value = null, range = null;
  if (g.metric === "ca_mois") {
    // CA du mois civil en cours (ou du dernier mois de la période si elle est finie)
    const ref = today < g.end_date ? (today > g.start_date ? today : g.start_date) : g.end_date;
    range = periodFor("mois", ref);
    value = await measure("ca", range.start, range.end, tz);
  } else if (AUTO.has(g.metric)) {
    value = await measure(g.metric, g.start_date, g.end_date, tz);
  } else if (g.metric === "nombre") {
    value = out.current;
  }
  out.value = value;
  out.auto = AUTO.has(g.metric);
  out.range = range;
  out.baseline = g.baseline == null ? null : Number(g.baseline);
  const down = g.metric === "nombre" && g.direction === "down";
  if (g.metric === "check") {
    out.pct = g.done_at ? 100 : 0;
    out.reached = !!g.done_at;
  } else if (down) {
    out.reached = !!g.done_at || (out.target != null && value <= out.target);
    const b = out.baseline;
    out.pct = out.reached ? 100 : b != null && b > out.target ? Math.max(0, Math.round(((b - value) / (b - out.target)) * 100)) : 0;
  } else {
    out.reached = !!g.done_at || (out.target != null && value >= out.target);
    out.pct = out.target ? Math.max(0, Math.round((value / out.target) * 100)) : null;
  }
  out.past = g.end_date < today;
  out.daysLeft = out.past ? 0 : Math.round((Date.parse(g.end_date) - Date.parse(today)) / 864e5) + 1;
  return out;
}

/* ---------- Validation ---------- */
function clean(b, cur = {}) {
  const g = {};
  if (b.title !== undefined) {
    g.title = String(b.title || "").trim().slice(0, 200);
    if (!g.title) throw Object.assign(new Error("Donne un titre à ton objectif."), { status: 400 });
  }
  if (b.horizon !== undefined) {
    if (!HORIZONS.includes(b.horizon)) throw Object.assign(new Error("Horizon inconnu."), { status: 400 });
    g.horizon = b.horizon;
  }
  if (b.domain !== undefined) g.domain = DOMAINS.includes(b.domain) ? b.domain : "pro";
  if (b.metric !== undefined) {
    if (!METRICS.includes(b.metric)) throw Object.assign(new Error("Mesure inconnue."), { status: 400 });
    g.metric = b.metric;
  }
  if (b.target !== undefined) {
    const n = b.target === null || b.target === "" ? null : Number(b.target);
    if (n != null && (!isFinite(n) || n < 0 || n > 1e10)) throw Object.assign(new Error("Cible invalide."), { status: 400 });
    g.target = n;
  }
  if (b.current !== undefined) {
    const n = Number(b.current);
    if (!isFinite(n) || Math.abs(n) > 1e10) throw Object.assign(new Error("Valeur invalide."), { status: 400 });
    g.current = n;
  }
  if (b.direction !== undefined) g.direction = b.direction === "down" ? "down" : "up";
  if (b.baseline !== undefined) {
    const n = b.baseline === null || b.baseline === "" ? null : Number(b.baseline);
    if (n != null && (!isFinite(n) || Math.abs(n) > 1e10)) throw Object.assign(new Error("Point de départ invalide."), { status: 400 });
    g.baseline = n;
  }
  if (b.unit !== undefined) g.unit = String(b.unit || "").trim().slice(0, 30) || null;
  if (b.notes !== undefined) g.notes = String(b.notes || "").slice(0, 4000) || null;
  for (const k of ["start_date", "end_date"]) {
    if (b[k] !== undefined) {
      if (!isDate(b[k])) throw Object.assign(new Error("Date invalide."), { status: 400 });
      g[k] = b[k];
    }
  }
  const metric = g.metric || cur.metric || "check";
  const target = g.target !== undefined ? g.target : cur.target;
  if (metric !== "check" && (target == null || Number(target) <= 0)) throw Object.assign(new Error("Indique une cible chiffrée pour cette mesure."), { status: 400 });
  const s = g.start_date || cur.start_date, e = g.end_date || cur.end_date;
  if (s && e && e < s) throw Object.assign(new Error("La date de fin doit être après la date de début."), { status: 400 });
  return g;
}

const ERR = (res, e) => res.status(e.status || 500).json({ error: e.message });

/* ---------- Routes ---------- */
api.get("/goals", wrap(async (req, res) => {
  const tz = await validTz(req.query.tz || "Europe/Paris");
  const today = todayIn(tz);
  const r = await q(`SELECT * FROM goals ORDER BY end_date DESC, position, id`);
  const goals = await Promise.all(r.rows.map((g) => withProgress(g, tz, today)));
  res.json({
    today, tz,
    periods: { semaine: periodFor("semaine", today), mois: periodFor("mois", today), trimestre: periodFor("trimestre", today) },
    goals,
  });
}));

api.post("/goals", wrap(async (req, res) => {
  try {
    const b = req.body || {};
    const tz = await validTz(b.tz || "Europe/Paris");
    const horizon = HORIZONS.includes(b.horizon) ? b.horizon : "semaine";
    const p = periodFor(horizon, isDate(b.start_date) ? b.start_date : todayIn(tz));
    const g = clean({ horizon, domain: "pro", metric: "check", start_date: p.start, end_date: p.end, ...b, horizon });
    if (!g.title) throw Object.assign(new Error("Donne un titre à ton objectif."), { status: 400 });
    if (!g.end_date) g.end_date = p.end;
    const pos = await q(`SELECT COALESCE(max(position),0)+1 AS p FROM goals WHERE horizon=$1`, [g.horizon]);
    const ins = await q(
      `INSERT INTO goals (horizon, domain, title, metric, target, current, unit, start_date, end_date, notes, position, direction, baseline)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [g.horizon, g.domain || "pro", g.title, g.metric, g.metric === "check" ? null : g.target, g.current || 0, g.unit || null, g.start_date, g.end_date, g.notes || null, pos.rows[0].p,
        g.metric === "nombre" ? g.direction || "up" : "up",
        // objectif à la baisse : on part de la valeur actuelle si aucun point de départ n'est donné
        g.metric === "nombre" && g.direction === "down" ? (g.baseline != null ? g.baseline : g.current || null) : null]
    );
    res.json(await withProgress(ins.rows[0], tz, todayIn(tz)));
  } catch (e) { ERR(res, e); }
}));

api.put("/goals/:id", wrap(async (req, res) => {
  try {
    const cur = (await q(`SELECT * FROM goals WHERE id=$1`, [req.params.id])).rows[0];
    if (!cur) return res.status(404).json({ error: "Objectif introuvable" });
    const b = req.body || {};
    const g = clean(b, cur);
    if (b.done !== undefined) g.done_at = b.done ? cur.done_at || new Date() : null;
    if ((g.metric || cur.metric) === "check") g.target = null;
    const keys = Object.keys(g);
    if (!keys.length) return res.json(cur);
    const r = await q(
      `UPDATE goals SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(", ")}, updated_at=now() WHERE id=$1 RETURNING *`,
      [cur.id, ...keys.map((k) => g[k])]
    );
    const tz = await validTz(b.tz || "Europe/Paris");
    res.json(await withProgress(r.rows[0], tz, todayIn(tz)));
  } catch (e) { ERR(res, e); }
}));

// Reporter un objectif sur la période suivante (même horizon), sans toucher à l'original
api.post("/goals/:id/report", wrap(async (req, res) => {
  const cur = (await q(`SELECT * FROM goals WHERE id=$1`, [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: "Objectif introuvable" });
  const tz = await validTz((req.body && req.body.tz) || "Europe/Paris");
  const today = todayIn(tz);
  // période suivante après la fin de l'objectif, ou la période en cours s'il est déjà passé
  const from = cur.end_date < today ? today : addDays(cur.end_date, 1);
  const p = cur.horizon === "trimestre"
    ? { start: from, end: addDays(from, Math.round((Date.parse(cur.end_date) - Date.parse(cur.start_date)) / 864e5)) }
    : periodFor(cur.horizon, from);
  const dup = await q(`SELECT id FROM goals WHERE title=$1 AND horizon=$2 AND start_date=$3`, [cur.title, cur.horizon, p.start]);
  if (dup.rows.length) return res.status(409).json({ error: "Cet objectif est déjà prévu sur la période suivante." });
  const ins = await q(
    `INSERT INTO goals (horizon, domain, title, metric, target, current, unit, start_date, end_date, notes, position, direction, baseline)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    // un objectif à la baisse repart de la dernière valeur notée ; les autres repartent de zéro
    [cur.horizon, cur.domain, cur.title, cur.metric, cur.target, cur.direction === "down" ? cur.current : 0, cur.unit, p.start, p.end, cur.notes, cur.position,
      cur.direction, cur.direction === "down" ? cur.current : null]
  );
  res.json(await withProgress(ins.rows[0], tz, today));
}));

api.delete("/goals/:id", wrap(async (req, res) => {
  const r = await q(`DELETE FROM goals WHERE id=$1 RETURNING id`, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: "Objectif introuvable" });
  res.json({ ok: true });
}));

module.exports = { api, migrate, periodFor };
