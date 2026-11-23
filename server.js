// CLOSER PRO — ton coach de cold call Straight Line
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const config = require("./src/config");
const { q, migrate, getSettings, saveSettings } = require("./src/db");
const worker = require("./src/worker");
const { coachReport } = require("./src/analyze");
const dialer = require("./src/dialer");
const calendar = require("./src/calendar");
const billing = require("./src/billing");
const revenue = require("./src/revenue");
const goals = require("./src/goals");
const inbox = require("./src/inbox");
const automations = require("./src/automations");
const booking = require("./src/booking");
const mailer = require("./src/mailer");
const sites = require("./src/sites");
const activity = require("./src/activity");
const prospect = require("./src/prospect");
const mobile = require("./src/mobile");
const team = require("./src/team");
const incoming = require("./src/incoming");
const stripe = require("./src/stripe");
const tw = require("./src/twilio");
const ghlApi = require("./src/ghl");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
// booking.biznify.pro : pages de réservation seulement, avec des liens courts (booking.biznify.pro/<calendrier>)
const BOOKING_HOST = (() => { try { return config.bookingUrl ? new URL(config.bookingUrl).hostname : null; } catch { return null; } })();
app.use((req, res, next) => {
  if (!BOOKING_HOST || req.hostname !== BOOKING_HOST) return next();
  if (/^\/(r\/|brand\/|email\/|robots\.txt)/.test(req.path)) return next();
  if (/^\/(m\/[A-Za-z0-9_-]+|[a-z0-9-]+)\/?$/.test(req.path)) { req.url = "/r" + req.url; return next(); }
  res.redirect(302, "https://biznify.pro");
});
// pay.biznify.pro ne sert que les pages clients (factures, liens de paiement), jamais l'app
const PAY_HOST = (() => { try { return config.payUrl ? new URL(config.payUrl).hostname : null; } catch { return null; } })();
app.use((req, res, next) => {
  if (!PAY_HOST || req.hostname !== PAY_HOST) return next();
  if (/^\/(facture\/|p\/|email\/|brand\/|api\/stripe\/webhook|robots\.txt)/.test(req.path)) return next();
  res.redirect(302, "https://biznify.pro");
});
// Webhook Stripe : corps brut pour vérifier la signature, avant le parseur JSON
app.post("/api/stripe/webhook", express.raw({ type: "*/*", limit: "1mb" }), (req, res, next) => billing.webhook(req, res).catch(next));
app.use(express.json({ limit: "2mb" }));

/* ---------- Session (cookie signé) : compte principal ou membre de l'équipe ---------- */
const COOKIE = "closer_session";
const DAYS = 60;

function sign(v) {
  return crypto.createHmac("sha256", config.sessionSecret || "x").update(v).digest("base64url");
}
// compte principal : "exp.sig" ; membre : "exp.u<id>-<ver>.sig"
function makeToken(user) {
  const exp = String(Date.now() + DAYS * 864e5);
  const body = user ? `${exp}.u${user.id}-${user.ver}` : exp;
  return `${body}.${sign(body)}`;
}
function parseToken(t) {
  if (!t || !config.sessionSecret) return null;
  const parts = t.split(".");
  if (parts.length < 2 || parts.length > 3) return null;
  const sig = parts.pop(), body = parts.join(".");
  const good = sign(body);
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  if (!(Number(parts[0]) > Date.now())) return null;
  if (parts.length === 1) return { owner: true };
  const m = /^u(\d+)-(\d+)$/.exec(parts[1]);
  return m ? { id: Number(m[1]), ver: Number(m[2]) } : null;
}
function readCookie(req, name) {
  const h = req.headers.cookie || "";
  for (const part of h.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const OWNER = () => ({ id: 0, owner: true, role: "admin", name: (config.appEmail || "").split("@")[0] || "Moi", email: config.appEmail, perms: team.KEYS });
// utilisé par les pages publiques (factures) : vrai pour toute session valide
const authed = (req) => !!parseToken(readCookie(req, COOKIE));
async function currentUser(req) {
  const t = parseToken(readCookie(req, COOKIE));
  if (!t) return null;
  if (t.owner) { const o = OWNER(); try { const st = await getSettings(); if (st.prenom && st.prenom !== "Moi") o.name = st.prenom; } catch {} return o; }
  return team.load(t.id, t.ver);
}
function requireAuth(req, res, next) {
  currentUser(req).then((u) => {
    if (!u) return res.status(401).json({ error: "Non connecté" });
    req.user = u; req.ownerEmail = config.appEmail;
    if (!team.allowed(u, req.method, req.path)) return res.status(403).json({ error: "Ton compte n'a pas accès à cette partie de l'app. Demande à ton administrateur.", forbidden: true });
    next();
  }).catch(next);
}

const attempts = new Map();
const setSession = (req, res, user) => res.setHeader("Set-Cookie", `${COOKIE}=${makeToken(user)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${req.secure ? "; Secure" : ""}`);
app.post("/api/login", async (req, res, next) => {
  try {
    const ip = req.ip || "?";
    const a = attempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 10) return res.status(429).json({ error: "Trop de tentatives. Réessaie dans 15 minutes." });
    const email = String((req.body && req.body.email) || "").trim().toLowerCase();
    const password = (req.body && req.body.password) || "";
    const isOwner = safeEqual(email, String(config.appEmail || "").trim().toLowerCase());
    if (isOwner) {
      if (!config.appPassword) return res.status(500).json({ error: "APP_PASSWORD n'est pas défini sur le serveur." });
      if (safeEqual(password, config.appPassword)) { attempts.delete(ip); setSession(req, res, null); return res.json({ ok: true }); }
    } else {
      const u = await team.findForLogin(email, password);
      if (u) { attempts.delete(ip); setSession(req, res, u); return res.json({ ok: true }); }
    }
    a.n++; attempts.set(ip, a);
    res.status(401).json({ error: "Email ou mot de passe incorrect." });
  } catch (e) { next(e); }
});
app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.get("/health", (req, res) => res.json({ ok: true }));

/* ---------- Webhook GHL (optionnel) : déclenche une synchro immédiate ---------- */
app.post("/api/webhook/ghl", (req, res) => {
  if (!config.webhookSecret || req.query.secret !== config.webhookSecret) return res.status(403).json({ error: "forbidden" });
  // GHL enregistre l'appel quelques secondes après la fin : on laisse le temps
  setTimeout(() => worker.sync().catch(() => {}), 20000);
  res.json({ ok: true });
});

/* ---------- Webhooks Twilio (signature vérifiée) ---------- */
app.use("/api/twilio", dialer.hooks);
app.use("/api/twilio", inbox.hooks);
app.use("/api/twilio", incoming.hooks);

/* ---------- API ---------- */
const api = express.Router();
api.use(requireAuth);

api.get("/me", async (req, res) => {
  const u = req.user;
  const views = new Set(team.FEATURES.filter((f) => u.owner || u.role === "admin" || u.perms.includes(f.key)).flatMap((f) => f.views));
  res.json({ ok: true, missing: config.missing(), dialerMissing: tw.missing(), worker: worker.state(), model: config.anthropicModel,
    user: { id: u.id, name: u.name, email: u.email, role: u.role, owner: !!u.owner, perms: u.owner || u.role === "admin" ? team.KEYS : u.perms, roleLabel: u.owner ? "Propriétaire" : (team.ROLES[u.role] || {}).label },
    views: [...views] });
});

const LIST_COLS = `id, source, date, direction, phone, contact_name, label, duration, call_status, has_recording,
  status, error, score, issue, analyzed_at, lead_id, outcome,
  CASE WHEN analysis IS NULL THEN NULL ELSE jsonb_build_object(
    'score', analysis->'score', 'issue', analysis->'issue', 'prospect', analysis->'prospect',
    'priorite', analysis->'priorite', 'etapes', analysis->'etapes') END AS summary`;

api.get("/calls", async (req, res) => {
  const r = await q(`SELECT ${LIST_COLS} FROM calls WHERE status <> 'skipped' ORDER BY date DESC LIMIT 1000`);
  const counts = await q(`SELECT status, count(*)::int AS n FROM calls GROUP BY status`);
  res.json({ calls: r.rows, counts: Object.fromEntries(counts.rows.map((x) => [x.status, x.n])), worker: worker.state() });
});

// Écoute de l'enregistrement
api.get("/calls/:id/audio", async (req, res) => {
  const r = await q(`SELECT id, source, recording_url, has_recording FROM calls WHERE id=$1`, [req.params.id]);
  const c = r.rows[0];
  if (!c || !c.has_recording) return res.status(404).json({ error: "Pas d'enregistrement" });
  try {
    const a = c.source === "dialer" ? await tw.downloadRecording(c.recording_url) : c.source === "ghl" ? await ghlApi.getRecording(c.id) : null;
    if (!a) return res.status(404).json({ error: "Pas d'enregistrement" });
    res.setHeader("Content-Type", a.type || "audio/mpeg");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(a.buffer);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

api.get("/calls/:id", async (req, res) => {
  const r = await q(`SELECT id, source, date, direction, phone, contact_name, label, duration, status, error, transcript, analysis, score, issue, analyzed_at, has_recording, lead_id, outcome FROM calls WHERE id=$1`, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: "Appel introuvable" });
  res.json(r.rows[0]);
});

// Lancer (ou relancer) l'analyse d'un appel. ?retranscribe=1 pour refaire la transcription.
api.post("/calls/:id/analyze", async (req, res) => {
  const re = req.query.retranscribe === "1";
  const r = await q(
    `UPDATE calls SET status='queued', error=NULL ${re ? ", transcript=NULL" : ""}, updated_at=now()
     WHERE id=$1 AND status NOT IN ('transcribing','analyzing') RETURNING id`,
    [req.params.id]
  );
  if (!r.rows.length) return res.status(409).json({ error: "Appel introuvable ou déjà en cours de traitement" });
  worker.kick();
  res.json({ ok: true });
});

api.delete("/calls/:id", async (req, res) => {
  const r = await q(`SELECT source FROM calls WHERE id=$1`, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: "Appel introuvable" });
  if (r.rows[0].source === "ghl") {
    await q(`UPDATE calls SET status='new', analysis=NULL, score=NULL, issue=NULL, analyzed_at=NULL, error=NULL WHERE id=$1`, [req.params.id]);
  } else {
    await q(`DELETE FROM calls WHERE id=$1`, [req.params.id]);
  }
  res.json({ ok: true });
});

// Transcription collée
api.post("/paste", async (req, res) => {
  const { transcript, label } = req.body || {};
  if (!transcript || String(transcript).trim().length < 40) return res.status(400).json({ error: "Transcription trop courte" });
  const id = "p-" + crypto.randomUUID();
  await q(`INSERT INTO calls (id, source, label, transcript, status, has_recording) VALUES ($1,'paste',$2,$3,'queued',false)`, [
    id, (label || "").slice(0, 120) || null, String(transcript).slice(0, 200000),
  ]);
  worker.kick();
  res.json({ ok: true, id });
});

// Fichier audio envoyé depuis le téléphone (appel passé hors GHL, mémo vocal, jeu de rôle…)
api.post("/upload", express.raw({ type: () => true, limit: "60mb" }), async (req, res) => {
  if (!req.body || !req.body.length) return res.status(400).json({ error: "Fichier vide" });
  const id = "u-" + crypto.randomUUID();
  const label = decodeURIComponent(req.headers["x-label"] || "").slice(0, 120) || null;
  await q(`INSERT INTO calls (id, source, label, audio, audio_type, status, has_recording) VALUES ($1,'upload',$2,$3,$4,'queued',true)`, [
    id, label, req.body, (req.headers["content-type"] || "audio/mpeg").split(";")[0],
  ]);
  worker.kick();
  res.json({ ok: true, id });
});

api.post("/sync", async (req, res) => {
  try {
    const r = await worker.sync({ full: req.query.full === "1" });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Analyser tout l'historique pas encore traité
api.post("/backfill", async (req, res) => {
  const r = await q(`UPDATE calls SET status='queued', error=NULL WHERE status IN ('new','error') RETURNING id`);
  worker.kick();
  res.json({ ok: true, queued: r.rows.length });
});

api.get("/settings", async (req, res) => res.json(await getSettings()));
api.put("/settings", async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (typeof b.prenom === "string") patch.prenom = b.prenom.trim().slice(0, 60) || "Moi";
  if (typeof b.offre === "string") patch.offre = b.offre.trim().slice(0, 3000);
  if (b.minDuree !== undefined) patch.minDuree = Math.max(0, Math.min(600, parseInt(b.minDuree) || 0));
  if (b.autoAnalyze !== undefined) patch.autoAnalyze = !!b.autoAnalyze;
  if (typeof b.script === "string") patch.script = b.script.slice(0, 8000);
  if (b.objectifAppels !== undefined) patch.objectifAppels = Math.max(1, Math.min(500, parseInt(b.objectifAppels) || 50));
  if (b.objectifRdv !== undefined) patch.objectifRdv = Math.max(1, Math.min(100, parseInt(b.objectifRdv) || 3));
  if (b.maxTentatives !== undefined) patch.maxTentatives = Math.max(1, Math.min(10, parseInt(b.maxTentatives) || 3));
  if (b.objectifCA !== undefined) patch.objectifCA = Math.max(0, Math.min(10000000, Math.round(Number(b.objectifCA) || 0)));
  res.json(await saveSettings(patch));
});

api.get("/bilan", async (req, res) => {
  const r = await q(`SELECT created_at, data FROM bilans ORDER BY id DESC LIMIT 1`);
  res.json(r.rows[0] || null);
});
api.post("/bilan", async (req, res) => {
  try {
    const r = await q(`SELECT date, analysis FROM calls WHERE status='done' ORDER BY date DESC LIMIT 15`);
    if (r.rows.length < 2) return res.status(400).json({ error: "Analyse au moins 2 appels pour obtenir un bilan." });
    const calls = r.rows.reverse();
    const data = await coachReport(calls, await getSettings());
    data.n = calls.length;
    const ins = await q(`INSERT INTO bilans (data) VALUES ($1) RETURNING created_at, data`, [data]);
    res.json(ins.rows[0]);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

api.use(dialer.api);
api.use(calendar.api);
api.use(billing.api);
api.use(revenue.api);
api.use(goals.api);
api.use(inbox.api);
api.use(automations.api);
api.use(booking.api);
api.use(mailer.api);
api.use(sites.api);
api.use(activity.api);
api.use(prospect.api);
api.use(mobile.api);
api.use(team.api);
api.use(incoming.api);
app.use("/api", api);

/* ---------- Factures publiques (lien envoyé au client) ---------- */
app.use(billing.publicRoutes(authed));
app.use(booking.publicRoutes());
app.use(mailer.publicRoutes);
app.use(sites.publicRoutes);

/* ---------- Front ---------- */
app.use("/vendor/xlsx", express.static(path.join(__dirname, "node_modules/xlsx/dist"), { maxAge: "7d" }));
app.use("/vendor/twilio", express.static(path.join(__dirname, "node_modules/@twilio/voice-sdk/dist"), { maxAge: "7d" }));
// HTML, JS, CSS et service worker : toujours revalidés, pour voir chaque nouvelle version tout de suite
app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  index: "index.html",
  setHeaders(res, file) {
    if (/\.(html|js|css|webmanifest)$/.test(file)) res.setHeader("Cache-Control", "no-cache");
    else res.setHeader("Cache-Control", "public, max-age=86400");
  },
}));
app.get("*", (req, res) => { res.setHeader("Cache-Control", "no-cache"); res.sendFile(path.join(__dirname, "public", "index.html")); });

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Erreur serveur" });
});

process.on("unhandledRejection", (e) => console.error("Erreur non gérée :", e && e.message ? e.message : e));

/* ---------- Démarrage ---------- */
(async () => {
  const miss = config.missing();
  if (miss.length) console.warn("⚠️  Variables manquantes :", miss.join(", "));
  if (!config.databaseUrl) {
    console.error("DATABASE_URL est obligatoire (ajoute une base Postgres dans Railway).");
    process.exit(1);
  }
  await migrate();
  await sites.migrate();
  await goals.migrate();
  await activity.migrate();
  await prospect.migrate();
  await mobile.migrate();
  await team.migrate();
  await getSettings();
  app.listen(config.port, () => console.log(`CLOSER PRO en ligne sur le port ${config.port}`));
  worker.start();
  prospect.start();
  inbox.start();
  automations.start();
  mailer.start();
  stripe.load().then(() => stripe.enabled() && stripe.ensureWebhook()).then(() => console.log(`Stripe prêt (${stripe.mode()})`)).catch((e) => console.warn("Stripe :", e.message));
  if (tw.enabled()) tw.ensureSetup().then(() => console.log("Dialer Twilio prêt")).catch((e) => console.warn("Dialer Twilio :", e.message));
})().catch((e) => {
  console.error("Démarrage impossible :", e);
  process.exit(1);
});
