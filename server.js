// CLOSER — ton coach de cold call Straight Line
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const config = require("./src/config");
const { q, migrate, getSettings, saveSettings } = require("./src/db");
const worker = require("./src/worker");
const { coachReport } = require("./src/analyze");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));

/* ---------- Session (cookie signé, un seul utilisateur) ---------- */
const COOKIE = "closer_session";
const DAYS = 60;

function sign(v) {
  return crypto.createHmac("sha256", config.sessionSecret || "x").update(v).digest("base64url");
}
function makeToken() {
  const exp = String(Date.now() + DAYS * 864e5);
  return `${exp}.${sign(exp)}`;
}
function validToken(t) {
  if (!t || !config.sessionSecret) return false;
  const [exp, sig] = t.split(".");
  if (!exp || !sig) return false;
  const good = sign(exp);
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return false;
  return Number(exp) > Date.now();
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
const authed = (req) => validToken(readCookie(req, COOKIE));
function requireAuth(req, res, next) {
  if (authed(req)) return next();
  res.status(401).json({ error: "Non connecté" });
}

const attempts = new Map();
app.post("/api/login", (req, res) => {
  const ip = req.ip || "?";
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).json({ error: "Trop de tentatives. Réessaie dans 15 minutes." });
  if (!config.appPassword) return res.status(500).json({ error: "APP_PASSWORD n'est pas défini sur le serveur." });
  if (!safeEqual(req.body && req.body.password, config.appPassword)) {
    a.n++; attempts.set(ip, a);
    return res.status(401).json({ error: "Mot de passe incorrect." });
  }
  attempts.delete(ip);
  res.setHeader("Set-Cookie", `${COOKIE}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${DAYS * 86400}${req.secure ? "; Secure" : ""}`);
  res.json({ ok: true });
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

/* ---------- API ---------- */
const api = express.Router();
api.use(requireAuth);

api.get("/me", async (req, res) => {
  res.json({ ok: true, missing: config.missing(), worker: worker.state(), model: config.anthropicModel });
});

const LIST_COLS = `id, source, date, direction, phone, contact_name, label, duration, call_status, has_recording,
  status, error, score, issue, analyzed_at,
  CASE WHEN analysis IS NULL THEN NULL ELSE jsonb_build_object(
    'score', analysis->'score', 'issue', analysis->'issue', 'prospect', analysis->'prospect',
    'priorite', analysis->'priorite', 'etapes', analysis->'etapes') END AS summary`;

api.get("/calls", async (req, res) => {
  const r = await q(`SELECT ${LIST_COLS} FROM calls WHERE status <> 'skipped' ORDER BY date DESC LIMIT 1000`);
  const counts = await q(`SELECT status, count(*)::int AS n FROM calls GROUP BY status`);
  res.json({ calls: r.rows, counts: Object.fromEntries(counts.rows.map((x) => [x.status, x.n])), worker: worker.state() });
});

api.get("/calls/:id", async (req, res) => {
  const r = await q(`SELECT id, source, date, direction, phone, contact_name, label, duration, status, error, transcript, analysis, score, issue, analyzed_at FROM calls WHERE id=$1`, [req.params.id]);
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

app.use("/api", api);

/* ---------- Front ---------- */
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], maxAge: "1h", index: "index.html" }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Erreur serveur" });
});

/* ---------- Démarrage ---------- */
(async () => {
  const miss = config.missing();
  if (miss.length) console.warn("⚠️  Variables manquantes :", miss.join(", "));
  if (!config.databaseUrl) {
    console.error("DATABASE_URL est obligatoire (ajoute une base Postgres dans Railway).");
    process.exit(1);
  }
  await migrate();
  await getSettings();
  app.listen(config.port, () => console.log(`CLOSER en ligne sur le port ${config.port}`));
  worker.start();
})().catch((e) => {
  console.error("Démarrage impossible :", e);
  process.exit(1);
});
