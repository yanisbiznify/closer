// Vidéos (façon Loom) : enregistrement d'écran + caméra dans l'app, lien de partage, suivi des vues.
// Les vidéos sont stockées dans Postgres par morceaux, envoyés pendant l'enregistrement :
// le lien est prêt dès que tu cliques sur Stop.
const crypto = require("crypto");
const express = require("express");
const { q, getSettings } = require("./db");
const tw = require("./twilio");

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const str = (v, n = 200) => String(v ?? "").trim().slice(0, n);
const MAX_BYTES = 4 * 1024 ** 3; // 4 Go par vidéo (≈ 45 min en 4K)
const SLICE = 4 * 1024 * 1024; // taille maximale servie par requête Range

async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS videos (
      id              SERIAL PRIMARY KEY,
      token           TEXT NOT NULL UNIQUE,
      title           TEXT NOT NULL,
      lead_id         INTEGER,
      mode            TEXT,
      mime            TEXT NOT NULL,
      size            BIGINT NOT NULL DEFAULT 0,
      duration        INTEGER,
      status          TEXT NOT NULL DEFAULT 'uploading', -- uploading | ready
      thumb           BYTEA,
      cta_label       TEXT,
      cta_url         TEXT,
      views           INTEGER NOT NULL DEFAULT 0,
      max_pct         INTEGER NOT NULL DEFAULT 0,
      first_viewed_at TIMESTAMPTZ,
      last_viewed_at  TIMESTAMPTZ,
      created_by      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS videos_created ON videos (created_at DESC);
    CREATE TABLE IF NOT EXISTS video_chunks (
      video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      start    BIGINT NOT NULL,
      len      INTEGER NOT NULL,
      data     BYTEA NOT NULL,
      PRIMARY KEY (video_id, start)
    );
  `);
  // enregistrements abandonnés (onglet fermé en plein envoi) : on fait le ménage après 2 jours
  await q(`DELETE FROM videos WHERE status='uploading' AND created_at < now() - interval '2 days'`).catch(() => {});
}

const shareUrl = (token, req) => `${tw.publicUrl() || (req ? `${req.protocol}://${req.get("host")}` : "")}/v/${token}`;
const view = (v, req) => ({
  id: v.id, token: v.token, title: v.title, lead_id: v.lead_id, lead_name: v.lead_name || null, mode: v.mode, mime: v.mime,
  size: Number(v.size), duration: v.duration, status: v.status, cta_label: v.cta_label, cta_url: v.cta_url,
  views: v.views, max_pct: v.max_pct, first_viewed_at: v.first_viewed_at, last_viewed_at: v.last_viewed_at,
  created_at: v.created_at, has_thumb: !!(v.has_thumb || v.thumb), url: shareUrl(v.token, req),
});
const COLS = `v.id, v.token, v.title, v.lead_id, v.mode, v.mime, v.size, v.duration, v.status, v.cta_label, v.cta_url, v.views, v.max_pct,
  v.first_viewed_at, v.last_viewed_at, v.created_at, (v.thumb IS NOT NULL) AS has_thumb,
  COALESCE(NULLIF(l.name,''), NULLIF(l.company,'')) AS lead_name`;

function cleanUrl(u) {
  u = str(u, 500);
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.toString() : null; } catch { return null; }
}

/* ---------- API (connecté) ---------- */
const api = express.Router();

api.get("/videos", wrap(async (req, res) => {
  const r = await q(`SELECT ${COLS} FROM videos v LEFT JOIN leads l ON l.id=v.lead_id WHERE v.status='ready' ORDER BY v.created_at DESC LIMIT 500`);
  const tot = await q(`SELECT COALESCE(sum(size),0)::bigint AS bytes, count(*)::int AS n FROM videos WHERE status='ready'`);
  // bouton d'action par défaut : ton premier calendrier de réservation actif
  let cta = null;
  try {
    const c = (await q(`SELECT slug FROM booking_calendars WHERE active ORDER BY created_at LIMIT 1`)).rows[0];
    if (c) cta = { label: "Réserver un appel", url: tw.bookingLink(c.slug) };
  } catch {}
  res.json({ videos: r.rows.map((v) => view(v, req)), totalBytes: Number(tot.rows[0].bytes), count: tot.rows[0].n, defaultCta: cta });
}));

// Liste légère des prospects pour relier une vidéo à quelqu'un
api.get("/videos/leads", wrap(async (req, res) => {
  const r = await q(`SELECT id, COALESCE(NULLIF(name,''), NULLIF(company,''), phone, email) AS name, company FROM leads ORDER BY updated_at DESC LIMIT 2000`);
  res.json({ leads: r.rows });
}));

// 1. Création : la vidéo existe dès le début de l'enregistrement
api.post("/videos", wrap(async (req, res) => {
  const b = req.body || {};
  const mime = str(b.mime, 100).split(";")[0];
  if (!/^video\/(mp4|webm|x-matroska)$/.test(mime)) return res.status(400).json({ error: "Format vidéo non pris en charge" });
  const token = crypto.randomBytes(9).toString("base64url");
  const leadId = parseInt(b.lead_id) || null;
  const title = str(b.title, 160) || `Vidéo du ${new Date().toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", day: "numeric", month: "long" })}`;
  const r = await q(`INSERT INTO videos (token, title, lead_id, mode, mime, cta_label, cta_url, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [token, title, leadId, str(b.mode, 20) || null, mime, str(b.cta_label, 60) || null, cleanUrl(b.cta_url), req.user ? req.user.name : null]);
  res.json(view(r.rows[0], req));
}));

// 2. Morceaux envoyés pendant l'enregistrement (dans l'ordre, ré-envoyables sans doublon)
api.post("/videos/:id/chunk", express.raw({ type: () => true, limit: "16mb" }), wrap(async (req, res) => {
  const id = parseInt(req.params.id), start = Number(req.query.start);
  if (!Number.isSafeInteger(start) || start < 0) return res.status(400).json({ error: "Position invalide" });
  if (!req.body || !req.body.length) return res.status(400).json({ error: "Morceau vide" });
  if (start + req.body.length > MAX_BYTES) return res.status(413).json({ error: "Vidéo trop lourde (4 Go maximum)" });
  const v = (await q(`SELECT status FROM videos WHERE id=$1`, [id])).rows[0];
  if (!v) return res.status(404).json({ error: "Vidéo introuvable" });
  if (v.status !== "uploading") return res.status(409).json({ error: "Vidéo déjà terminée" });
  await q(`INSERT INTO video_chunks (video_id, start, len, data) VALUES ($1,$2,$3,$4)
           ON CONFLICT (video_id, start) DO UPDATE SET len=EXCLUDED.len, data=EXCLUDED.data`, [id, start, req.body.length, req.body]);
  res.json({ ok: true });
}));

// 3. Fin : durée, taille et miniature
api.post("/videos/:id/finish", express.json({ limit: "3mb" }), wrap(async (req, res) => {
  const id = parseInt(req.params.id), b = req.body || {};
  const size = Number(b.size);
  const got = (await q(`SELECT COALESCE(sum(len),0)::bigint AS n, COALESCE(max(start+len),0)::bigint AS e FROM video_chunks WHERE video_id=$1`, [id])).rows[0];
  if (!Number.isSafeInteger(size) || size <= 0 || Number(got.n) !== size || Number(got.e) !== size) {
    return res.status(409).json({ error: "Envoi incomplet", received: Number(got.n) });
  }
  let thumb = null;
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.thumb || ""));
  if (m) thumb = Buffer.from(m[1], "base64");
  const r = await q(`UPDATE videos SET status='ready', size=$2, duration=$3, thumb=COALESCE($4, thumb) WHERE id=$1 RETURNING *`,
    [id, size, Math.max(0, Math.round(Number(b.duration) || 0)) || null, thumb]);
  if (!r.rows.length) return res.status(404).json({ error: "Vidéo introuvable" });
  const v = r.rows[0];
  require("./activity").log("video", { leadId: v.lead_id, title: `Vidéo enregistrée : ${v.title}`, ref: `video:${v.id}` });
  res.json(view(v, req));
}));

api.put("/videos/:id", wrap(async (req, res) => {
  const b = req.body || {}, sets = [], vals = [parseInt(req.params.id)];
  if (typeof b.title === "string" && b.title.trim()) { vals.push(str(b.title, 160)); sets.push(`title=$${vals.length}`); }
  if ("lead_id" in b) { vals.push(parseInt(b.lead_id) || null); sets.push(`lead_id=$${vals.length}`); }
  if ("cta_label" in b) { vals.push(str(b.cta_label, 60) || null); sets.push(`cta_label=$${vals.length}`); }
  if ("cta_url" in b) { vals.push(cleanUrl(b.cta_url)); sets.push(`cta_url=$${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: "Rien à modifier" });
  const r = await q(`UPDATE videos SET ${sets.join(", ")} WHERE id=$1 RETURNING id`, vals);
  if (!r.rows.length) return res.status(404).json({ error: "Vidéo introuvable" });
  const v = (await q(`SELECT ${COLS} FROM videos v LEFT JOIN leads l ON l.id=v.lead_id WHERE v.id=$1`, [r.rows[0].id])).rows[0];
  res.json(view(v, req));
}));

api.delete("/videos/:id", wrap(async (req, res) => {
  await q(`DELETE FROM videos WHERE id=$1`, [parseInt(req.params.id)]);
  res.json({ ok: true });
}));

/* ---------- Pages publiques (lien envoyé au prospect) ---------- */
async function brand() {
  let b = {};
  try { const r = await q(`SELECT value FROM settings WHERE key='billing'`); b = r.rows[0] ? r.rows[0].value : {}; } catch {}
  let prenom = "";
  try { const s = await getSettings(); prenom = s.prenom && s.prenom !== "Moi" ? s.prenom : ""; } catch {}
  return { company: b.company || "Biznify", logo: b.logo || "/brand/biznify-logo.svg", accent: /^#[0-9a-f]{6}$/i.test(b.accent || "") ? b.accent : "#1877F2", website: b.website || "", prenom };
}

// Lit l'intervalle [from, to] (inclus) à partir des morceaux stockés
async function readRange(id, from, to) {
  const r = await q(`SELECT start, len, data FROM video_chunks WHERE video_id=$1 AND start <= $3 AND start + len > $2 ORDER BY start`, [id, from, to]);
  const parts = r.rows.map((c) => {
    const s = Number(c.start);
    return c.data.subarray(Math.max(0, from - s), Math.min(c.len, to - s + 1));
  });
  return Buffer.concat(parts);
}

function publicRoutes(isOwner) {
  const r = express.Router();
  const find = async (token) => (await q(`SELECT v.*, COALESCE(NULLIF(l.name,''), NULLIF(l.company,'')) AS lead_name FROM videos v LEFT JOIN leads l ON l.id=v.lead_id WHERE v.token=$1 AND v.status='ready'`, [token])).rows[0];
  const notFound = (res) => res.status(404).send(`<!DOCTYPE html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Vidéo introuvable</title><p style="font-family:system-ui;padding:40px;color:#5B6475">Cette vidéo n'existe pas ou a été supprimée.</p>`);

  r.get("/v/:token", wrap(async (req, res) => {
    const v = await find(req.params.token);
    res.setHeader("X-Robots-Tag", "noindex");
    res.setHeader("Cache-Control", "no-store");
    if (!v) return notFound(res);
    res.send(page(v, await brand(), shareUrl(v.token, req), isOwner(req)));
  }));

  r.get("/v/:token/thumb.jpg", wrap(async (req, res) => {
    const v = (await q(`SELECT thumb FROM videos WHERE token=$1 AND status='ready'`, [req.params.token])).rows[0];
    if (!v || !v.thumb) return res.status(404).end();
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(v.thumb);
  }));

  // Lecture en streaming, avec les requêtes Range (indispensable pour avancer dans la vidéo, et pour Safari/iPhone)
  r.get("/v/:token/video", wrap(async (req, res) => {
    const v = (await q(`SELECT id, mime, size, title FROM videos WHERE token=$1 AND status='ready'`, [req.params.token])).rows[0];
    if (!v) return res.status(404).end();
    const size = Number(v.size);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", v.mime);
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (req.query.dl) {
      const ext = v.mime === "video/mp4" ? "mp4" : "webm";
      const name = (v.title || "video").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w -]+/g, "").trim().slice(0, 80) || "video";
      res.setHeader("Content-Disposition", `attachment; filename="${name}.${ext}"`);
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (m && (m[1] || m[2])) {
      let from, to;
      if (m[1]) { from = Number(m[1]); to = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
      else { from = Math.max(0, size - Number(m[2])); to = size - 1; }
      if (from >= size || from > to) { res.setHeader("Content-Range", `bytes */${size}`); return res.status(416).end(); }
      to = Math.min(to, from + SLICE - 1);
      const buf = await readRange(v.id, from, to);
      res.status(206);
      res.setHeader("Content-Range", `bytes ${from}-${from + buf.length - 1}/${size}`);
      res.setHeader("Content-Length", buf.length);
      return res.end(buf);
    }
    // pas de Range : on envoie tout, morceau par morceau
    res.setHeader("Content-Length", size);
    for (let from = 0; from < size; from += SLICE) {
      if (res.destroyed) return;
      const buf = await readRange(v.id, from, Math.min(size, from + SLICE) - 1);
      if (!res.write(buf)) await new Promise((ok) => res.once("drain", ok));
    }
    res.end();
  }));

  // Suivi des vues : 1 vue par visiteur et par jour, sans compter tes propres visites
  const seen = new Map();
  r.post("/v/:token/seen", express.json({ limit: "4kb" }), wrap(async (req, res) => {
    res.json({ ok: true });
    if (isOwner(req)) return;
    const b = req.body || {};
    const pct = Math.max(0, Math.min(100, Math.round(Number(b.pct) || 0)));
    const visitor = str(b.visitor, 40) || req.ip || "?";
    const key = `${req.params.token}:${visitor}:${new Date().toISOString().slice(0, 10)}`;
    const isNew = !!b.start && !seen.has(key);
    if (isNew) { seen.set(key, 1); if (seen.size > 5000) seen.clear(); }
    const r2 = await q(`UPDATE videos SET views = views + $2, max_pct = GREATEST(max_pct, $3),
        first_viewed_at = COALESCE(first_viewed_at, CASE WHEN $2 > 0 THEN now() END),
        last_viewed_at = CASE WHEN $2 > 0 THEN now() ELSE last_viewed_at END
      WHERE token=$1 AND status='ready' RETURNING id, title, lead_id, views, (SELECT COALESCE(NULLIF(name,''), NULLIF(company,'')) FROM leads WHERE id=videos.lead_id) AS lead_name`,
      [req.params.token, isNew ? 1 : 0, pct]);
    const v = r2.rows[0];
    if (v && isNew) {
      const who = v.lead_name || "Quelqu'un";
      require("./activity").log("video_view", {
        leadId: v.lead_id, title: `${who} regarde ta vidéo « ${v.title} »`,
        detail: v.views > 1 ? `${v.views}e vue` : "Première vue", ref: `video_view:${v.id}:${v.views}`,
      });
    }
  }));
  return r;
}

const fmtDur = (d) => (d ? `${Math.floor(d / 60)}:${String(d % 60).padStart(2, "0")}` : "");

function page(v, b, url, owner) {
  const title = v.title;
  const by = [b.prenom, b.company].filter(Boolean).join(" · ");
  const thumb = v.thumb ? `${url}/thumb.jpg` : "";
  const cta = v.cta_url ? `<a class="cta" href="${esc(v.cta_url)}" target="_blank" rel="noopener">${esc(v.cta_label || "En savoir plus")}<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a>` : "";
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}${by ? " — " + esc(by) : ""}</title>
<meta property="og:type" content="video.other"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(by ? `Une vidéo de ${by}` : "Une vidéo pour vous")}${v.duration ? " · " + fmtDur(v.duration) : ""}">
${thumb ? `<meta property="og:image" content="${esc(thumb)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(thumb)}">` : ""}
<meta property="og:url" content="${esc(url)}">
<link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--a:${b.accent};--ink:#0B1220;--mut:#5B6475;--line:#E4E7EE;--soft:#F5F7FB}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--soft);color:var(--ink);font:15px/1.55 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;align-items:center;justify-content:space-between;gap:16px;max-width:1080px;margin:0 auto;padding:22px 20px}
header img{height:28px;width:auto;display:block}
header .site{color:var(--mut);font-size:13.5px;text-decoration:none}
main{max-width:1080px;margin:0 auto;padding:0 20px 56px}
h1{font-size:clamp(22px,3vw,30px);letter-spacing:-.025em;line-height:1.2;margin:6px 0 6px}
.by{color:var(--mut);font-size:14px;margin-bottom:20px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.by .dot{width:4px;height:4px;border-radius:50%;background:#C3C9D4}
.player{position:relative;background:#0B1220;border-radius:18px;overflow:hidden;box-shadow:0 1px 2px rgba(11,18,32,.06),0 24px 60px rgba(11,18,32,.16);aspect-ratio:16/9}
.player video{width:100%;height:100%;display:block;background:#0B1220;object-fit:contain}
.play{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;border:0;background:linear-gradient(180deg,rgba(11,18,32,0) 40%,rgba(11,18,32,.45));cursor:pointer;padding:0}
.play span{width:84px;height:84px;border-radius:50%;background:var(--a);display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(0,0,0,.3);transition:transform .15s}
.play:hover span{transform:scale(1.06)}
.play svg{width:34px;height:34px;margin-left:5px;fill:#fff}
.play .len{position:absolute;right:16px;bottom:14px;color:#fff;font-weight:600;font-size:13px;background:rgba(0,0,0,.55);padding:3px 9px;border-radius:6px}
.bar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:22px;flex-wrap:wrap}
.cta{display:inline-flex;align-items:center;gap:10px;background:var(--a);color:#fff;text-decoration:none;font-weight:600;font-size:16px;padding:14px 24px;border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,.12)}
.cta:hover{filter:brightness(1.06)}
.own{background:#FFF6E5;color:#7A4D00;border:1px solid #F5DDA8;border-radius:10px;padding:9px 14px;font-size:13px;margin-bottom:16px}
footer{color:#8A93A3;font-size:12.5px;text-align:center;padding:0 20px 32px}
@media (max-width:640px){header{padding:16px}main{padding:0 12px 40px}.player{border-radius:12px}.play span{width:68px;height:68px}.cta{width:100%;justify-content:center}}
</style></head><body>
<header><img src="${esc(b.logo)}" alt="${esc(b.company)}">${b.website ? `<a class="site" href="${esc(/^https?:/.test(b.website) ? b.website : "https://" + b.website)}" target="_blank" rel="noopener">${esc(b.website.replace(/^https?:\/\//, ""))}</a>` : ""}</header>
<main>
${owner ? `<div class="own">Aperçu : tes propres visites ne comptent pas dans les vues.</div>` : ""}
<h1>${esc(title)}</h1>
<div class="by">${by ? `<span>${esc(by)}</span>` : ""}${v.duration ? `${by ? '<span class="dot"></span>' : ""}<span>${fmtDur(v.duration)}</span>` : ""}</div>
<div class="player">
  <video id="vid" playsinline preload="metadata" ${thumb ? `poster="${esc(thumb)}"` : ""} src="/v/${esc(v.token)}/video"></video>
  <button class="play" id="play" aria-label="Lire la vidéo"><span><svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z"/></svg></span>${v.duration ? `<em class="len">${fmtDur(v.duration)}</em>` : ""}</button>
</div>
${cta ? `<div class="bar"><div></div>${cta}</div>` : ""}
</main>
<footer>${esc(b.company)}</footer>
<script>
(function(){
  var v=document.getElementById("vid"),p=document.getElementById("play"),tok=${JSON.stringify(v.token)},dur=${Number(v.duration) || 0},started=false,max=0,sent=0;
  var vis;try{vis=localStorage.getItem("v_vis");if(!vis){vis=Math.random().toString(36).slice(2,12);localStorage.setItem("v_vis",vis);}}catch(e){vis="";}
  function send(start){var body=JSON.stringify({pct:max,start:!!start,visitor:vis});
    if(!start&&navigator.sendBeacon){navigator.sendBeacon("/v/"+tok+"/seen",new Blob([body],{type:"application/json"}));return;}
    fetch("/v/"+tok+"/seen",{method:"POST",headers:{"Content-Type":"application/json"},body:body,keepalive:true}).catch(function(){});}
  // les vidéos WebM enregistrées dans le navigateur n'ont pas toujours de durée : on la force
  var fixing=false;
  function fix(){if(v.duration===Infinity&&!fixing){fixing=true;v.currentTime=1e101;}}
  v.addEventListener("loadedmetadata",fix);if(v.readyState>=1)fix();
  v.addEventListener("durationchange",function(){if(fixing&&isFinite(v.duration)){fixing=false;v.currentTime=0;}});
  p.onclick=function(){p.style.display="none";v.controls=true;v.play();};
  v.addEventListener("play",function(){if(!started){started=true;send(true);}});
  v.addEventListener("timeupdate",function(){var d=isFinite(v.duration)&&v.duration>0?v.duration:dur;if(d){var pc=Math.min(100,Math.round(100*v.currentTime/d));if(pc>max)max=pc;}
    if(max-sent>=25){sent=max;send(false);}});
  v.addEventListener("ended",function(){max=100;sent=100;send(false);});
  document.addEventListener("visibilitychange",function(){if(document.hidden&&started&&max>sent){sent=max;send(false);}});
})();
</script>
</body></html>`;
}

module.exports = { migrate, api, publicRoutes };
