// AI Studio : sites web générés par l'IA, retouchés par messages, publiés sur Cloudflare Pages
const express = require("express");
const crypto = require("crypto");
const config = require("./config");
const { q } = require("./db");
const tw = require("./twilio");
const studioRender = require("./studio/render");
const studioAi = require("./studio/ai");
const studioTemplates = require("./studio/templates");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, n = 500) => String(v ?? "").slice(0, n);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slugify = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "site";

/* ---------- Base ---------- */
async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS sites (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      slug          TEXT NOT NULL UNIQUE,
      status        TEXT NOT NULL DEFAULT 'brouillon',
      job           TEXT,
      job_error     TEXT,
      brief         JSONB NOT NULL DEFAULT '{}'::jsonb,
      html          TEXT,
      notify_email  TEXT,
      to_pipeline   BOOLEAN NOT NULL DEFAULT false,
      lead_id       INTEGER,
      public_key    TEXT NOT NULL,
      cf_project    TEXT,
      cf_subdomain  TEXT,
      custom_domain TEXT,
      published_at  TIMESTAMPTZ,
      published_html_hash TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS site_versions (
      id         SERIAL PRIMARY KEY,
      site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      html       TEXT NOT NULL,
      note       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS site_assets (
      id         SERIAL PRIMARY KEY,
      site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      name       TEXT,
      role       TEXT,
      mime       TEXT NOT NULL,
      data       BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS site_submissions (
      id         SERIAL PRIMARY KEY,
      site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      data       JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS site_versions_site ON site_versions(site_id, id DESC);
    CREATE INDEX IF NOT EXISTS site_submissions_site ON site_submissions(site_id, id DESC);
  `);
  // mode « modèle » : contenu structuré (JSON) rendu par le moteur Biznify
  await q(`ALTER TABLE sites ADD COLUMN IF NOT EXISTS template TEXT; ALTER TABLE sites ADD COLUMN IF NOT EXISTS data JSONB; ALTER TABLE site_versions ADD COLUMN IF NOT EXISTS data JSONB;`);
  // un travail interrompu par un redémarrage ne doit pas rester bloqué
  await q(`UPDATE sites SET job=NULL, job_error='Interrompu par un redémarrage, relance la demande' WHERE job IS NOT NULL`);
}

/* ---------- Cloudflare (clé chiffrée en base) ---------- */
const cipherKey = () => crypto.createHash("sha256").update("cloudflare-key:" + (config.sessionSecret || "closer")).digest();
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", cipherKey(), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}
function unseal(s) {
  const [iv, tag, enc] = String(s).split(".").map((x) => Buffer.from(x, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", cipherKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}
async function cfState() {
  const r = await q(`SELECT value FROM settings WHERE key='cloudflare'`);
  return r.rows[0] ? r.rows[0].value : {};
}
async function cfToken() {
  if (config.cloudflareToken) return config.cloudflareToken;
  const st = await cfState();
  if (!st.sealed) return null;
  try { return unseal(st.sealed); } catch { return null; }
}
async function cf(method, path, body, { token, form } = {}) {
  const t = token || (await cfToken());
  if (!t) throw new Error("Connecte Cloudflare dans AI Studio pour publier");
  const headers = { Authorization: `Bearer ${t}` };
  if (body && !form) headers["Content-Type"] = "application/json";
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) {
    const msg = (j.errors && j.errors[0] && j.errors[0].message) || `Cloudflare ${r.status}`;
    throw Object.assign(new Error(msg), { status: r.status, code: j.errors && j.errors[0] && j.errors[0].code });
  }
  return j.result;
}
async function cfConnect(raw) {
  const token = String(raw || "").trim();
  if (token.length < 30) throw new Error("Colle le jeton API Cloudflare en entier");
  let accounts;
  try { accounts = await cf("GET", "/accounts", null, { token }); }
  catch (e) { throw new Error(/Invalid|auth/i.test(e.message) ? "Cloudflare refuse ce jeton : vérifie que tu l'as copié en entier" : e.message); }
  if (!accounts || !accounts.length) throw new Error("Ce jeton n'a accès à aucun compte Cloudflare");
  const acc = accounts[0];
  try { await cf("GET", `/accounts/${acc.id}/pages/projects`, null, { token }); }
  catch { throw new Error("Il manque une autorisation à ce jeton : Compte › Cloudflare Pages › Modifier"); }
  await q(`INSERT INTO settings (key, value) VALUES ('cloudflare', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [{ sealed: seal(token), accountId: acc.id, accountName: acc.name, connectedAt: new Date().toISOString() }]);
  return cfStatus();
}
async function cfStatus() {
  const st = await cfState();
  const token = await cfToken();
  return { connected: !!(token && st.accountId), account: st.accountName || null, source: config.cloudflareToken ? "railway" : token ? "app" : null };
}

/* ---------- Publication sur Cloudflare Pages (Direct Upload) ---------- */
let blake3;
async function hashFile(buf, ext) {
  if (!blake3) blake3 = require("hash-wasm").blake3;
  return (await blake3(buf.toString("base64") + ext)).slice(0, 32);
}
const MIME_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg", "image/gif": "gif" };

async function ensureProject(site) {
  const st = await cfState();
  const acc = st.accountId;
  if (site.cf_project) {
    try { return await cf("GET", `/accounts/${acc}/pages/projects/${site.cf_project}`); } catch (e) { if (e.status !== 404) throw e; }
  }
  let name = site.cf_project || slugify(site.slug).slice(0, 50);
  for (let i = 0; i < 4; i++) {
    try {
      const p = await cf("POST", `/accounts/${acc}/pages/projects`, { name, production_branch: "main" });
      await q(`UPDATE sites SET cf_project=$2, cf_subdomain=$3 WHERE id=$1`, [site.id, p.name, p.subdomain]);
      return p;
    } catch (e) {
      if (!/already|exist|taken/i.test(e.message)) throw e;
      name = `${slugify(site.slug).slice(0, 44)}-${crypto.randomBytes(2).toString("hex")}`;
    }
  }
  throw new Error("Impossible de créer le projet Cloudflare");
}

async function publish(site) {
  const st = await cfState();
  const acc = st.accountId;
  const project = await ensureProject(site);
  const assets = (await q(`SELECT id, mime, data FROM site_assets WHERE site_id=$1`, [site.id])).rows;
  const html = renderSite(site, { assetUrl: (a) => `/img/${a.id}.${MIME_EXT[a.mime] || "bin"}`, assets, publicMode: true });
  const files = [
    { path: "/index.html", buf: Buffer.from(html, "utf8"), ext: "html", mime: "text/html" },
    { path: "/robots.txt", buf: Buffer.from("User-agent: *\nAllow: /\n"), ext: "txt", mime: "text/plain" },
    ...assets.map((a) => ({ path: `/img/${a.id}.${MIME_EXT[a.mime] || "bin"}`, buf: a.data, ext: MIME_EXT[a.mime] || "bin", mime: a.mime })),
  ];
  for (const f of files) f.hash = await hashFile(f.buf, f.ext);

  let jwt;
  try { jwt = (await cf("GET", `/accounts/${acc}/pages/projects/${project.name}/upload-token`)).jwt; }
  catch { jwt = (await cf("POST", `/accounts/${acc}/pages/projects/${project.name}/upload-token`)).jwt; }
  const missing = await cf("POST", "/pages/assets/check-missing", { hashes: files.map((f) => f.hash) }, { token: jwt });
  const todo = files.filter((f) => (missing || []).includes(f.hash));
  for (let i = 0; i < todo.length; i += 20) {
    await cf("POST", "/pages/assets/upload", todo.slice(i, i + 20).map((f) => ({ key: f.hash, value: f.buf.toString("base64"), metadata: { contentType: f.mime }, base64: true })), { token: jwt });
  }
  await cf("POST", "/pages/assets/upsert-hashes", { hashes: files.map((f) => f.hash) }, { token: jwt });

  const form = new FormData();
  form.append("manifest", JSON.stringify(Object.fromEntries(files.map((f) => [f.path, f.hash]))));
  form.append("branch", "main");
  const dep = await cf("POST", `/accounts/${acc}/pages/projects/${project.name}/deployments`, null, { form });
  await q(`UPDATE sites SET status='en_ligne', published_at=now(), cf_project=$2, cf_subdomain=$3, published_html_hash=$4, updated_at=now() WHERE id=$1`,
    [site.id, project.name, project.subdomain, crypto.createHash("sha1").update(site.html || "").digest("hex")]);
  return { url: `https://${project.subdomain}`, deployment: dep && dep.url };
}

async function addDomain(site, domain) {
  const st = await cfState();
  if (!site.cf_project) throw new Error("Publie le site une première fois avant d'ajouter un domaine");
  const d = String(domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(d)) throw new Error("Domaine invalide (ex. www.plomberie-martin.fr)");
  try { await cf("POST", `/accounts/${st.accountId}/pages/projects/${site.cf_project}/domains`, { name: d }); }
  catch (e) { if (!/already/i.test(e.message)) throw e; }
  await q(`UPDATE sites SET custom_domain=$2, updated_at=now() WHERE id=$1`, [site.id, d]);
  return domainStatus({ ...site, custom_domain: d });
}
async function domainStatus(site) {
  if (!site.custom_domain || !site.cf_project) return null;
  const st = await cfState();
  try {
    const d = await cf("GET", `/accounts/${st.accountId}/pages/projects/${site.cf_project}/domains/${site.custom_domain}`);
    return { name: d.name, status: d.status, target: site.cf_subdomain, apex: site.custom_domain.split(".").length === 2 };
  } catch { return { name: site.custom_domain, status: "inconnu", target: site.cf_subdomain, apex: site.custom_domain.split(".").length === 2 }; }
}

/* ---------- Rendu : images + formulaire relié à Biznify ---------- */
function formScript(site, preview) {
  const endpoint = `${tw.publicUrl() || ""}/site-lead/${site.public_key}`;
  return `<script>
(function(){
  var E=${JSON.stringify(endpoint)};
  document.querySelectorAll("form[data-biznify-form]").forEach(function(f){
    var hp=document.createElement("input");hp.type="text";hp.name="_website";hp.tabIndex=-1;hp.autocomplete="off";hp.setAttribute("aria-hidden","true");hp.style.cssText="position:absolute;left:-9999px;opacity:0";f.appendChild(hp);
    f.addEventListener("submit",async function(e){
      e.preventDefault();${preview ? `var p=document.createElement("div");p.setAttribute("role","status");p.textContent="Aperçu : le formulaire fonctionne. En ligne, la demande sera envoyée à ${esc(site.notify_email || "l'email du client")}.";p.style.cssText="padding:16px 18px;border-radius:12px;background:#EEF4FF;color:#1D4ED8;font-weight:600";f.replaceWith(p);return;` : ""}var b=f.querySelector("[type=submit]"),t=b?b.textContent:"";if(b){b.disabled=true;b.textContent="Envoi…";}
      var d={};new FormData(f).forEach(function(v,k){d[k]=String(v).slice(0,3000);});d._page=location.href;
      try{var r=await fetch(E,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(d)});var j=await r.json().catch(function(){return{}});
        if(!r.ok)throw new Error(j.error||"Erreur");
        var ok=document.createElement("div");ok.setAttribute("role","status");ok.className="bz-ok";ok.textContent=f.getAttribute("data-success")||"Merci ! Votre demande a bien été envoyée. Nous vous recontactons très vite.";
        ok.style.cssText="padding:18px 20px;border-radius:12px;background:#E9F8F0;color:#11643C;font-weight:600";f.replaceWith(ok);
      }catch(err){if(b){b.disabled=false;b.textContent=t;}alert(err.message||"L'envoi a échoué, réessayez.");}
    });
  });
})();
</script>`;
}
function renderSite(site, { assetUrl, assets = [], publicMode = false } = {}) {
  let html = site.html || "";
  const map = Object.fromEntries(assets.map((a) => [String(a.id), assetUrl(a)]));
  html = html.replace(/\{\{asset:(\d+)\}\}/g, (m, id) => map[id] || "");
  const inject = formScript(site, !publicMode);
  html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${inject}</body>`) : html + inject;
  if (!publicMode) html = html.replace(/<head>/i, `<head><meta name="robots" content="noindex">`);
  return html;
}

/* ---------- IA : génération et retouches ---------- */
const DESIGN_RULES = `Tu es le directeur artistique et développeur d'un studio web français haut de gamme. Tu crées des sites vitrines pour des entreprises locales (artisans, commerces, indépendants, PME) qui doivent inspirer confiance et générer des demandes de devis ou d'appel.

Règles de sortie (impératives) :
- Réponds UNIQUEMENT avec un document HTML complet, de <!DOCTYPE html> à </html>. Aucun texte avant ou après, pas de bloc de code markdown.
- Un seul fichier : CSS dans une balise <style>, aucun framework, aucun JavaScript externe. Tu peux ajouter un petit script inline pour le menu mobile ou une FAQ.
- Polices : Google Fonts autorisées (2 familles maximum), choisies pour le métier. Évite Inter, Roboto, Arial par défaut.
- Icônes : SVG inline uniquement. N'utilise aucune image externe (pas d'Unsplash, pas d'URL inventée). Les seules images autorisées sont les fichiers fournis, référencés exactement par {{asset:ID}} dans src ou background-image. Sans photo, construis le visuel avec la typographie, la couleur, des formes et des SVG.
- Tout le texte en français, vouvoiement, concret, spécifique au métier et à la ville. Pas de lorem ipsum, pas de faux chiffres ni faux avis présentés comme réels : si tu n'as pas d'avis fournis, ne mets pas de section avis.
- Mobile d'abord, responsive, accessible (contraste AA, alt sur les images, focus visible, balises sémantiques, un seul h1), rapide.
- SEO local : <title> et meta description avec métier + ville, données structurées JSON-LD LocalBusiness avec les infos fournies.
- Le téléphone est un lien tel: visible dès le haut de page, et l'email un lien mailto: s'il est fourni.
- Formulaire de contact obligatoire : <form data-biznify-form> avec des champs name="nom" (requis), name="telephone" (type tel, requis), name="email" (type email), name="message" (textarea), et un bouton type="submit". Ajoute d'autres champs utiles au métier si pertinent (ex. name="service" en select). Ne mets ni action ni method : Biznify gère l'envoi.
- Ajoute une case de consentement RGPD requise (name="consentement") et un pied de page avec mentions et année courante.

Direction artistique :
- Chaque site doit avoir une identité propre, tirée du métier, du lieu et du public. Évite les modèles génériques de SaaS (cartes identiques à ombre grise, dégradés décoratifs, petits labels en majuscules au-dessus de chaque titre, numérotation 01/02/03 si ce n'est pas une vraie séquence).
- Une palette de 4 à 6 couleurs cohérente avec les couleurs de marque fournies. Une échelle typographique claire. Un seul élément mémorable bien exécuté plutôt que beaucoup d'effets.
- Le haut de page dit en une phrase ce que fait l'entreprise, pour qui et où, avec deux actions : appeler et demander un devis.
- Sections typiques à adapter : accroche, services, pourquoi nous (preuves concrètes fournies), zone d'intervention, déroulé, FAQ, contact. Ne garde que ce qui sert ce métier.`;

async function claude(system, messages, maxTokens = 16000, model = config.anthropicModel) {
  if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY manquant");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": config.anthropicApiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
  });
  if (!res.ok) throw new Error(`IA ${res.status} : ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = await res.json();
  if (j.stop_reason === "max_tokens") throw new Error("Le site généré était trop long, simplifie la demande");
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}
function extractHtml(text) {
  const t = String(text || "").replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "");
  const a = t.search(/<!DOCTYPE html>/i), b = t.toLowerCase().lastIndexOf("</html>");
  if (a < 0 || b < 0) throw new Error("L'IA n'a pas renvoyé un site complet, réessaie");
  return t.slice(a, b + 7);
}
function briefText(brief, assets) {
  const b = brief || {};
  const lines = [
    ["Entreprise", b.company], ["Métier / activité", b.activity], ["Ville et zone d'intervention", b.city],
    ["Services proposés", b.services], ["Points forts et preuves (années d'expérience, garanties, certifications, avis réels)", b.proofs],
    ["Téléphone", b.phone], ["Email", b.email], ["Adresse", b.address], ["Horaires", b.hours],
    ["Couleurs de marque", b.colors], ["Ambiance souhaitée", b.style], ["Objectif principal du site", b.goal], ["Autres informations", b.notes],
  ].filter(([, v]) => v && String(v).trim()).map(([k, v]) => `- ${k} : ${String(v).trim()}`);
  const imgs = assets.length ? `\nFichiers fournis (à utiliser avec {{asset:ID}}) :\n${assets.map((a) => `- {{asset:${a.id}}} : ${a.role === "logo" ? "logo de l'entreprise" : "photo"}${a.name ? ` (${a.name})` : ""}`).join("\n")}` : "\nAucune photo fournie.";
  return lines.join("\n") + imgs;
}

const jobs = new Map();
function runJob(siteId, label, fn) {
  if (jobs.get(siteId)) throw Object.assign(new Error("L'IA travaille déjà sur ce site, patiente un instant"), { status: 409 });
  jobs.set(siteId, true);
  q(`UPDATE sites SET job=$2, job_error=NULL, updated_at=now() WHERE id=$1`, [siteId, label]).then(async () => {
    try { await fn(); await q(`UPDATE sites SET job=NULL, updated_at=now() WHERE id=$1`, [siteId]); }
    catch (e) { console.warn("AI Studio :", e.message); await q(`UPDATE sites SET job=NULL, job_error=$2, updated_at=now() WHERE id=$1`, [siteId, e.message.slice(0, 300)]); }
    finally { jobs.delete(siteId); }
  });
}
async function saveVersion(siteId, html, note, data = null) {
  await q(`UPDATE sites SET html=$2::text, data=COALESCE($3::jsonb, data), status=CASE WHEN status='brouillon' THEN 'pret' ELSE status END, updated_at=now() WHERE id=$1`, [siteId, html, data ? JSON.stringify(data) : null]);
  await q(`INSERT INTO site_versions (site_id, html, note, data) VALUES ($1,$2,$3,$4)`, [siteId, html, note, data ? JSON.stringify(data) : null]);
  await q(`DELETE FROM site_versions WHERE site_id=$1 AND id NOT IN (SELECT id FROM site_versions WHERE site_id=$1 ORDER BY id DESC LIMIT 30)`, [siteId]);
}
async function generate(site) {
  const assets = (await q(`SELECT id, name, role FROM site_assets WHERE site_id=$1 ORDER BY id`, [site.id])).rows;
  if (site.template && studioTemplates.get(site.template)) {
    const data = await studioAi.generate(site.template, briefText(site.brief, assets), assets);
    const tpl = studioTemplates.list().find((t) => t.key === site.template);
    await saveVersion(site.id, studioRender.render(data), `Site créé à partir du modèle « ${tpl.name} »`, data);
    return;
  }
  const text = await claude(DESIGN_RULES, [{ role: "user", content: `Crée le site vitrine complet de cette entreprise.\n\n${briefText(site.brief, assets)}\n\nAnnée en cours : ${new Date().getFullYear()}.` }], 16000, config.studioModel);
  await saveVersion(site.id, extractHtml(text), "Site généré par l'IA");
}
async function edit(site, instruction) {
  const assets = (await q(`SELECT id, name, role FROM site_assets WHERE site_id=$1 ORDER BY id`, [site.id])).rows;
  if (site.data) {
    const data = await studioAi.edit(site.data, instruction, briefText(site.brief, assets), assets);
    await saveVersion(site.id, studioRender.render(data), instruction.slice(0, 300), data);
    return;
  }
  const text = await claude(DESIGN_RULES, [{ role: "user", content:
    `Voici le site actuel :\n\n${site.html}\n\nInformations de l'entreprise :\n${briefText(site.brief, assets)}\n\nApplique cette demande de modification, en gardant tout le reste identique sauf si la demande l'exige :\n${instruction}\n\nRenvoie le document HTML complet mis à jour.` }]);
  await saveVersion(site.id, extractHtml(text), instruction.slice(0, 300));
}

/* ---------- API (connecté) ---------- */
const api = express.Router();
const serialize = async (s, full) => {
  const out = {
    id: s.id, name: s.name, slug: s.slug, status: s.status, template: s.template || null, job: s.job, job_error: s.job_error, brief: s.brief, notify_email: s.notify_email, to_pipeline: s.to_pipeline,
    cf_project: s.cf_project, url: s.cf_subdomain ? `https://${s.cf_subdomain}` : null, custom_domain: s.custom_domain, published_at: s.published_at,
    changed: !!(s.published_at && s.html && crypto.createHash("sha1").update(s.html).digest("hex") !== s.published_html_hash),
    has_html: !!s.html, updated_at: s.updated_at, created_at: s.created_at,
  };
  if (full) {
    out.assets = (await q(`SELECT id, name, role, mime FROM site_assets WHERE site_id=$1 ORDER BY id`, [s.id])).rows;
    out.versions = (await q(`SELECT id, note, created_at FROM site_versions WHERE site_id=$1 ORDER BY id DESC LIMIT 30`, [s.id])).rows;
    out.submissions = (await q(`SELECT id, data, created_at FROM site_submissions WHERE site_id=$1 ORDER BY id DESC LIMIT 50`, [s.id])).rows;
  }
  return out;
};
const getSite = async (id) => (await q(`SELECT * FROM sites WHERE id=$1`, [id])).rows[0];
function cleanBrief(b = {}) {
  const k = ["company", "activity", "city", "services", "proofs", "phone", "email", "address", "hours", "colors", "style", "goal", "notes"];
  return Object.fromEntries(k.map((x) => [x, str(b[x], x === "notes" || x === "services" || x === "proofs" ? 3000 : 300).trim()]));
}

api.get("/sites/templates", wrap(async (req, res) => {
  res.json({ templates: studioTemplates.list().map((t) => ({ ...t, image: studioRender.img(t.image, 900) })) });
}));
api.get("/sites/templates/:key/preview", wrap(async (req, res) => {
  const d = studioTemplates.get(req.params.key);
  if (!d) return res.status(404).send("Modèle introuvable");
  res.setHeader("Cache-Control", "private, max-age=600");
  res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox");
  res.send(renderSite({ html: studioRender.render(d), notify_email: "", public_key: "apercu" }, { assets: [], assetUrl: () => "" }));
}));
api.get("/sites", wrap(async (req, res) => {
  const r = await q(`SELECT * FROM sites ORDER BY updated_at DESC`);
  const counts = Object.fromEntries((await q(`SELECT site_id, count(*)::int AS n FROM site_submissions GROUP BY site_id`)).rows.map((x) => [x.site_id, x.n]));
  res.json({ sites: await Promise.all(r.rows.map(async (s) => ({ ...(await serialize(s)), submissions_count: counts[s.id] || 0 }))), cloudflare: await cfStatus() });
}));
api.get("/sites/:id", wrap(async (req, res) => {
  const s = await getSite(req.params.id);
  if (!s) return res.status(404).json({ error: "Site introuvable" });
  res.json({ site: { ...(await serialize(s, true)), domain: await domainStatus(s) }, cloudflare: await cfStatus() });
}));
api.post("/sites", wrap(async (req, res) => {
  const brief = cleanBrief(req.body && req.body.brief);
  if (!brief.company || !brief.activity) return res.status(400).json({ error: "Indique au moins le nom de l'entreprise et son activité" });
  let slug = slugify(`${brief.company} ${brief.city || ""}`);
  if ((await q(`SELECT 1 FROM sites WHERE slug=$1`, [slug])).rows.length) slug = `${slug}-${crypto.randomBytes(2).toString("hex")}`;
  const notify = str(req.body.notify_email, 200).trim() || brief.email || null;
  const template = studioTemplates.get(req.body.template) ? req.body.template : null;
  const s = (await q(`INSERT INTO sites (name, slug, brief, notify_email, to_pipeline, lead_id, public_key, template) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [brief.company, slug, brief, notify, !!req.body.to_pipeline, Number(req.body.lead_id) || null, crypto.randomBytes(12).toString("base64url"), template])).rows[0];
  for (const f of (req.body.files || []).slice(0, 12)) await addAsset(s.id, f);
  if (!req.body.defer) runJob(s.id, "Création du site", () => generate(s));
  res.json({ site: await serialize(await getSite(s.id)) });
}));
async function addAsset(siteId, f) {
  const m = /^data:(image\/(?:png|jpeg|webp|svg\+xml|gif));base64,(.+)$/.exec(String(f && f.data || ""));
  if (!m) return null;
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 4 * 1024 * 1024) throw Object.assign(new Error("Image trop lourde (4 Mo maximum)"), { status: 400 });
  return (await q(`INSERT INTO site_assets (site_id, name, role, mime, data) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, role, mime`,
    [siteId, str(f.name, 120), f.role === "logo" ? "logo" : "photo", m[1], buf])).rows[0];
}
api.post("/sites/:id/assets", wrap(async (req, res) => {
  const s = await getSite(req.params.id);
  if (!s) return res.status(404).json({ error: "Site introuvable" });
  try { const a = await addAsset(s.id, req.body || {}); if (!a) return res.status(400).json({ error: "Format d'image non pris en charge" }); res.json({ asset: a }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
}));
api.delete("/sites/:id/assets/:aid", wrap(async (req, res) => {
  await q(`DELETE FROM site_assets WHERE id=$1 AND site_id=$2`, [req.params.aid, req.params.id]);
  res.json({ ok: true });
}));
api.get("/sites/:id/assets/:aid", wrap(async (req, res) => {
  const a = (await q(`SELECT mime, data FROM site_assets WHERE id=$1 AND site_id=$2`, [req.params.aid, req.params.id])).rows[0];
  if (!a) return res.status(404).end();
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.type(a.mime).send(a.data);
}));
api.put("/sites/:id", wrap(async (req, res) => {
  const s = await getSite(req.params.id);
  if (!s) return res.status(404).json({ error: "Site introuvable" });
  const b = req.body || {};
  const brief = b.brief ? cleanBrief({ ...s.brief, ...b.brief }) : s.brief;
  const notify = b.notify_email !== undefined ? (str(b.notify_email, 200).trim() || null) : s.notify_email;
  if (notify && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notify)) return res.status(400).json({ error: "Email de réception invalide" });
  await q(`UPDATE sites SET name=$2, brief=$3, notify_email=$4, to_pipeline=$5, updated_at=now() WHERE id=$1`,
    [s.id, str(b.name || s.name, 160), brief, notify, b.to_pipeline !== undefined ? !!b.to_pipeline : s.to_pipeline]);
  res.json({ site: await serialize(await getSite(s.id)) });
}));
api.post("/sites/:id/edit", wrap(async (req, res) => {
  const s = await getSite(req.params.id);
  if (!s) return res.status(404).json({ error: "Site introuvable" });
  const instruction = str(req.body && req.body.instruction, 3000).trim();
  if (!instruction) return res.status(400).json({ error: "Dis à l'IA ce que tu veux changer" });
  try {
    if (!s.html) runJob(s.id, "Création du site", () => generate(s));
    else runJob(s.id, instruction.slice(0, 120), () => edit(s, instruction));
  } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  res.json({ ok: true });
}));
api.post("/sites/:id/regenerate", wrap(async (req, res) => {
  const s = await getSite(req.params.id);
  if (!s) return res.status(404).json({ error: "Site introuvable" });
  try { runJob(s.id, "Nouvelle proposition", () => generate(s)); } catch (e) { return res.status(e.status || 500).json({ error: e.message }); }
  res.json({ ok: true });
}));
api.post("/sites/:id/versions/:vid/restore", wrap(async (req, res) => {
  const v = (await q(`SELECT html, data, created_at FROM site_versions WHERE id=$1 AND site_id=$2`, [req.params.vid, req.params.id])).rows[0];
  if (!v) return res.status(404).json({ error: "Version introuvable" });
  await saveVersion(Number(req.params.id), v.html, `Retour à la version du ${new Date(v.created_at).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}`, v.data);
  res.json({ ok: true });
}));
api.get("/sites/:id/preview", wrap(async (req, res) => {
  const s = await getSite(req.params.id);
  if (!s || !s.html) return res.status(404).send("<p style='font-family:system-ui;padding:40px;color:#5B6475'>Le site est en cours de création…</p>");
  // images en ligne : l'aperçu tourne dans un cadre isolé (sans accès à l'app)
  const assets = (await q(`SELECT id, mime, data FROM site_assets WHERE site_id=$1`, [s.id])).rows;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox");
  res.send(renderSite(s, { assets, assetUrl: (a) => `data:${a.mime};base64,${a.data.toString("base64")}` }));
}));
api.get("/sites/:id/download", wrap(async (req, res) => {
  const s = await getSite(req.params.id);
  if (!s || !s.html) return res.status(404).end();
  res.setHeader("Content-Disposition", `attachment; filename="${s.slug}.html"`);
  res.type("html").send(s.html);
}));
api.post("/sites/:id/publish", wrap(async (req, res) => {
  const s = await getSite(req.params.id);
  if (!s || !s.html) return res.status(404).json({ error: "Le site n'est pas encore prêt" });
  try { res.json(await publish(s)); } catch (e) { console.warn("Publication :", e.message); res.status(502).json({ error: `Publication impossible : ${e.message}` }); }
}));
api.post("/sites/:id/domain", wrap(async (req, res) => {
  const s = await getSite(req.params.id);
  if (!s) return res.status(404).json({ error: "Site introuvable" });
  try { res.json({ domain: await addDomain(s, req.body && req.body.domain) }); } catch (e) { res.status(400).json({ error: e.message }); }
}));
api.delete("/sites/:id", wrap(async (req, res) => {
  const s = await getSite(req.params.id);
  if (!s) return res.status(404).json({ error: "Site introuvable" });
  if (s.cf_project && req.query.cloudflare) {
    const st = await cfState();
    await cf("DELETE", `/accounts/${st.accountId}/pages/projects/${s.cf_project}`).catch((e) => console.warn("Suppression Cloudflare :", e.message));
  }
  await q(`DELETE FROM sites WHERE id=$1`, [s.id]);
  res.json({ ok: true });
}));
api.post("/cloudflare/connect", wrap(async (req, res) => {
  try { res.json({ cloudflare: await cfConnect(req.body && req.body.token) }); } catch (e) { res.status(400).json({ error: e.message }); }
}));
api.post("/cloudflare/disconnect", wrap(async (req, res) => {
  await q(`DELETE FROM settings WHERE key='cloudflare'`);
  res.json({ cloudflare: await cfStatus() });
}));

/* ---------- Formulaires des sites (public, CORS) ---------- */
const hits = new Map();
const publicRoutes = express.Router();
// aperçu public des modèles (aucune donnée client) : utile pour montrer un style à un prospect
publicRoutes.get("/modeles/:key", wrap(async (req, res) => {
  const d = studioTemplates.get(req.params.key);
  if (!d) return res.status(404).send("Modèle introuvable");
  res.setHeader("Cache-Control", "public, max-age=600");
  res.setHeader("X-Robots-Tag", "noindex");
  res.send(renderSite({ html: studioRender.render(d, { noindex: true }), notify_email: "", public_key: "apercu" }, { assets: [], assetUrl: () => "" }));
}));
publicRoutes.options("/site-lead/:key", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Max-Age", "86400");
  res.status(204).end();
});
publicRoutes.post("/site-lead/:key", express.json({ limit: "64kb" }), wrap(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const s = (await q(`SELECT * FROM sites WHERE public_key=$1`, [req.params.key])).rows[0];
  if (!s) return res.status(404).json({ error: "Formulaire inconnu" });
  const ip = req.ip || "?";
  const now = Date.now(), h = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (h.length >= 10) return res.status(429).json({ error: "Trop d'envois, réessayez plus tard" });
  h.push(now); hits.set(ip, h);
  const b = req.body || {};
  if (b._website) return res.json({ ok: true }); // robot
  const data = {};
  for (const [k, v] of Object.entries(b).slice(0, 30)) if (!k.startsWith("_") || k === "_page") data[str(k, 40)] = str(v, 3000);
  const nom = (data.nom || data.name || "").trim(), tel = (data.telephone || data.phone || data.tel || "").trim(), email = (data.email || "").trim();
  if (!nom) return res.status(400).json({ error: "Indiquez votre nom" });
  if (!tel && !email) return res.status(400).json({ error: "Indiquez un téléphone ou un email" });
  await q(`INSERT INTO site_submissions (site_id, data) VALUES ($1,$2)`, [s.id, data]);
  res.json({ ok: true });
  // suite en arrière-plan : email au client du site, et pipeline si demandé
  const mailer = require("./mailer");
  mailer.fire(() => mailer.siteSubmission(s, data));
  require("./activity").log("site_lead", { title: `Nouvelle demande sur le site ${s.name}`, detail: [nom, tel || email, data.service].filter(Boolean).join(" · ") });
  if (s.to_pipeline) {
    const phone = tw.normalizePhone(tel);
    const [first, ...rest] = nom.split(" ");
    (async () => {
      let list = (await q(`SELECT id FROM lists WHERE source='manuel' AND name=$1 LIMIT 1`, [`Site : ${s.name}`])).rows[0];
      if (!list) list = (await q(`INSERT INTO lists (name, source) VALUES ($1,'manuel') RETURNING id`, [`Site : ${s.name}`])).rows[0];
      await q(`INSERT INTO leads (list_id, first_name, last_name, name, phone, email, notes, source, stage, stage_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'nouveau',now())`,
        [list.id, first, rest.join(" ") || null, nom, phone, email || null, data.message || null, `site ${s.slug}`]);
    })().catch((e) => console.warn("Lead du site :", e.message));
  }
}));

module.exports = { api, publicRoutes, migrate, cfStatus };
