// App mobile : écran « Aujourd'hui » (missions, série, objectif) et notifications push
const express = require("express");
const webpush = require("web-push");
const { q, getSettings } = require("./db");
const tw = require("./twilio");

async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS push_subs (
      id         SERIAL PRIMARY KEY,
      endpoint   TEXT NOT NULL UNIQUE,
      keys       JSONB NOT NULL,
      ua         TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/* ---------- Clés VAPID : créées une fois, gardées en base ---------- */
let vapid = null;
async function keys() {
  if (vapid) return vapid;
  const r = await q(`SELECT value FROM settings WHERE key='webpush'`);
  let v = r.rows[0] && r.rows[0].value;
  if (!v || !v.publicKey) {
    v = webpush.generateVAPIDKeys();
    await q(`INSERT INTO settings (key, value) VALUES ('webpush', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [v]);
  }
  webpush.setVapidDetails("mailto:contact@biznify.pro", v.publicKey, v.privateKey);
  vapid = v;
  return v;
}

// Envoie une notification à tous les appareils abonnés ; supprime les abonnements expirés
async function notify({ title, body, url = "/", tag }) {
  try {
    await keys();
    const subs = (await q(`SELECT * FROM push_subs`)).rows;
    const payload = JSON.stringify({ title, body, url, tag });
    await Promise.all(subs.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 3600 })
      .catch(async (e) => { if (e.statusCode === 404 || e.statusCode === 410) await q(`DELETE FROM push_subs WHERE id=$1`, [s.id]); else console.warn("Push :", e.statusCode || e.message); })));
  } catch (e) { console.warn("Push :", e.message); }
}

/* ---------- Aujourd'hui ---------- */
const TZ = "Europe/Paris";
const dayKey = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: TZ });
async function mobileSettings() {
  const r = await q(`SELECT value FROM settings WHERE key='mobile'`);
  return { callGoal: 30, rdvGoal: 2, ...(r.rows[0] ? r.rows[0].value : {}) };
}

async function today() {
  const s = await getSettings();
  const m = await mobileSettings();
  const T = `date_trunc('day', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'`;
  const M = `date_trunc('month', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'`;
  const [calls, days, rdvToday, nextAppts, tasks, unread, month, payToday, lastPay, toCall] = await Promise.all([
    q(`SELECT count(*)::int AS n, count(*) FILTER (WHERE duration >= 30)::int AS talks FROM calls WHERE date >= ${T} AND (direction IS NULL OR direction <> 'inbound')`),
    q(`SELECT DISTINCT (date AT TIME ZONE '${TZ}')::date AS d FROM calls WHERE date >= now() - interval '120 days' ORDER BY d DESC`),
    q(`SELECT count(*)::int AS n FROM appointments WHERE created_at >= ${T} AND status <> 'annule'`),
    q(`SELECT a.id, a.title, a.start_at, a.meet_url, a.lead_id, l.first_name, l.last_name, l.name, l.company, c.name AS cal_name
         FROM appointments a LEFT JOIN leads l ON l.id=a.lead_id LEFT JOIN booking_calendars c ON c.id=a.calendar_id
        WHERE a.status <> 'annule' AND a.start_at >= now() - interval '30 minutes' ORDER BY a.start_at LIMIT 3`),
    q(`SELECT t.id, t.title, t.body, t.due_at, t.lead_id FROM tasks t WHERE t.done_at IS NULL AND t.due_at <= now() + interval '12 hours' ORDER BY t.due_at LIMIT 5`),
    q(`SELECT count(*)::int AS n FROM messages WHERE direction='in' AND read_at IS NULL`),
    q(`SELECT COALESCE(sum(c),0)::bigint AS c FROM (SELECT total_cents AS c FROM invoices WHERE status='payee' AND paid_at >= ${M} UNION ALL SELECT amount_cents FROM link_payments WHERE paid_at >= ${M}) x`),
    q(`SELECT COALESCE(sum(c),0)::bigint AS c FROM (SELECT total_cents AS c FROM invoices WHERE status='payee' AND paid_at >= ${T} UNION ALL SELECT amount_cents FROM link_payments WHERE paid_at >= ${T}) x`),
    q(`SELECT title, amount_cents, created_at FROM activity WHERE type='payment' ORDER BY id DESC LIMIT 1`),
    q(`SELECT count(*)::int AS n FROM leads WHERE stage='nouveau' OR status IN ('a_appeler','rappel')`),
  ]);
  // série : jours consécutifs avec au moins un appel (aujourd'hui pas encore commencé = la série tient toujours)
  const set = new Set(days.rows.map((r) => (r.d instanceof Date ? r.d.toISOString().slice(0, 10) : String(r.d))));
  let streak = 0;
  const d = new Date();
  if (!set.has(dayKey(d))) d.setDate(d.getDate() - 1);
  while (set.has(dayKey(d))) { streak++; d.setDate(d.getDate() - 1); }
  const goal = (Number(s.objectifCA) || 0) * 100;
  return {
    name: s.prenom || "Yanis",
    calls: { done: calls.rows[0].n, talks: calls.rows[0].talks, goal: m.callGoal },
    rdv: { today: rdvToday.rows[0].n, goal: m.rdvGoal },
    streak, calledToday: set.has(dayKey(new Date())),
    money: { month: Number(month.rows[0].c), goal, today: Number(payToday.rows[0].c), last: lastPay.rows[0] || null },
    appointments: nextAppts.rows, tasks: tasks.rows, unread: unread.rows[0].n, toCall: toCall.rows[0].n,
  };
}

/* ---------- API ---------- */
const api = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
api.get("/today", wrap(async (req, res) => { const d = await today(); if (req.user && !req.user.owner && req.user.name) d.name = req.user.name.split(" ")[0]; if (!require("./team").canMoney(req.user)) d.money = null; res.json(d); }));
api.get("/badges", wrap(async (req, res) => res.json({ unread: (await q(`SELECT count(*)::int AS n FROM messages WHERE direction='in' AND read_at IS NULL`)).rows[0].n })));
api.put("/today/goals", wrap(async (req, res) => {
  const cur = await mobileSettings();
  const b = req.body || {};
  const next = { ...cur };
  if (b.callGoal !== undefined) next.callGoal = Math.max(1, Math.min(300, Math.round(Number(b.callGoal) || 30)));
  if (b.rdvGoal !== undefined) next.rdvGoal = Math.max(1, Math.min(30, Math.round(Number(b.rdvGoal) || 2)));
  await q(`INSERT INTO settings (key, value) VALUES ('mobile', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [next]);
  res.json(next);
}));
api.post("/tasks/:id/done-quick", wrap(async (req, res) => { await q(`UPDATE tasks SET done_at=now() WHERE id=$1`, [req.params.id]); res.json({ ok: true }); }));
api.get("/push/key", wrap(async (req, res) => res.json({ key: (await keys()).publicKey, count: (await q(`SELECT count(*)::int AS n FROM push_subs`)).rows[0].n })));
api.post("/push/subscribe", wrap(async (req, res) => {
  const s = req.body && req.body.subscription;
  if (!s || !s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) return res.status(400).json({ error: "Abonnement invalide" });
  if (!/^https:\/\//.test(s.endpoint)) return res.status(400).json({ error: "Abonnement invalide" });
  await q(`INSERT INTO push_subs (endpoint, keys, ua) VALUES ($1,$2,$3) ON CONFLICT (endpoint) DO UPDATE SET keys=EXCLUDED.keys, ua=EXCLUDED.ua`, [s.endpoint, s.keys, String(req.get("user-agent") || "").slice(0, 300)]);
  res.json({ ok: true });
}));
api.post("/push/unsubscribe", wrap(async (req, res) => { await q(`DELETE FROM push_subs WHERE endpoint=$1`, [String((req.body && req.body.endpoint) || "")]); res.json({ ok: true }); }));
api.post("/push/test", wrap(async (req, res) => {
  await notify({ title: "Biznify 🎉", body: "Les notifications fonctionnent. Tu seras prévenu à chaque paiement, réservation et réponse.", url: "/#dashboard", tag: "test" });
  res.json({ ok: true });
}));

module.exports = { api, migrate, notify, today };
