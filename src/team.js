// Équipe : comptes utilisateurs, rôles et fonctionnalités autorisées
const crypto = require("crypto");
const express = require("express");
const { q } = require("./db");

const FEATURES = [
  { key: "dashboard", label: "Tableau de bord", desc: "Vue d'ensemble, activité et chiffre du mois", views: ["dashboard"] },
  { key: "pipeline", label: "Pipeline et prospects", desc: "Voir, ajouter et modifier les prospects", views: ["pipeline", "leads"] },
  { key: "dialer", label: "Dialer", desc: "Appeler les prospects depuis l'app", views: ["dialer"] },
  { key: "prospect", label: "Prospection Google Maps", desc: "Lancer des recherches de leads (coûte des crédits Apify)", views: ["prospect"] },
  { key: "conversations", label: "Conversations", desc: "Lire et envoyer des SMS et emails", views: ["conversations"] },
  { key: "calendar", label: "Agenda et réservations", desc: "Rendez-vous et calendriers de réservation", views: ["calendar"] },
  { key: "billing", label: "Factures et paiements", desc: "Créer, envoyer et encaisser des factures", views: ["billing"] },
  { key: "revenue", label: "Chiffre d'affaires", desc: "Voir le détail des revenus", views: ["revenue"] },
  { key: "goals", label: "Objectifs", desc: "Suivre les objectifs", views: ["goals"] },
  { key: "automations", label: "Automatisations", desc: "Créer et lancer des automatisations", views: ["automations"] },
  { key: "sites", label: "AI Studio", desc: "Créer et publier des sites web", views: ["sites"] },
  { key: "coach", label: "Appels enregistrés et coach", desc: "Écouter les appels, analyses et bilan", views: ["calls", "objections", "coach", "import"] },
  { key: "settings", label: "Réglages", desc: "Script, objectifs, notifications, connexions", views: ["settings"] },
  { key: "team", label: "Gérer l'équipe", desc: "Créer des comptes et donner des accès", views: ["settings"] },
];
const KEYS = FEATURES.map((f) => f.key);
const ROLES = {
  admin: { label: "Administrateur", desc: "Accès complet, comme toi", perms: KEYS },
  commercial: { label: "Commercial", desc: "Prospecter, appeler et prendre des RDV", perms: ["dashboard", "pipeline", "dialer", "prospect", "conversations", "calendar", "goals"] },
  assistant: { label: "Assistant", desc: "Agenda, messages et suivi des prospects", perms: ["dashboard", "pipeline", "conversations", "calendar"] },
  compta: { label: "Comptable", desc: "Factures et chiffre d'affaires", perms: ["dashboard", "billing", "revenue"] },
  custom: { label: "Personnalisé", desc: "Tu choisis chaque fonctionnalité", perms: [] },
};

// Quelle fonctionnalité ouvre quelle partie de l'API (première règle qui correspond)
const RULES = [
  [/^\/(me|badges|today|push\/|tasks\/\d+\/done-quick)/, null],
  [/^\/settings$/, null, "GET"],
  [/^\/(settings|notifications)/, ["settings"]],
  [/^\/users/, ["team"]],
  [/^\/(activity|dashboard\/)/, ["dashboard"]],
  [/^\/leads\/\d+\/money/, ["pipeline", "billing"]],
  [/^\/leads\/\d+\/(outcome|calls)/, ["dialer", "pipeline"]],
  [/^\/(dialer|objections)/, ["dialer"]],
  [/^\/(pipeline|leads|lists|ghl\/)/, ["pipeline", "dialer", "prospect"]],
  [/^\/prospect/, ["prospect"]],
  [/^\/(conversations|inbox)/, ["conversations"]],
  [/^\/(calendar|booking|google)/, ["calendar"]],
  [/^\/(billing|invoices|payment-links|stripe)/, ["billing"]],
  [/^\/revenue/, ["revenue"]],
  [/^\/goals/, ["goals"]],
  [/^\/tasks/, ["dashboard", "pipeline", "automations"]],
  [/^\/automations/, ["automations"]],
  [/^\/(sites|cloudflare)/, ["sites"]],
  [/^\/(calls|paste|upload|sync|backfill|bilan)/, ["coach"]],
];
function allowed(user, method, path) {
  if (!user || user.owner || user.role === "admin") return true;
  const perms = new Set(user.perms || []);
  for (const [re, need, onlyMethod] of RULES) {
    if (onlyMethod && onlyMethod !== method) continue;
    if (re.test(path)) return !need || need.some((k) => perms.has(k));
  }
  return false; // tout ce qui n'est pas listé reste réservé aux administrateurs
}

async function migrate() {
  await q(`CREATE TABLE IF NOT EXISTS app_users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'commercial',
    perms JSONB NOT NULL DEFAULT '[]',
    active BOOLEAN NOT NULL DEFAULT true,
    ver INTEGER NOT NULL DEFAULT 1,
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

function hashPass(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 64);
  return `s1$${salt.toString("base64")}$${h.toString("base64")}`;
}
function checkPass(pw, stored) {
  try {
    const [, salt, h] = String(stored).split("$");
    const a = crypto.scryptSync(String(pw), Buffer.from(salt, "base64"), 64);
    const b = Buffer.from(h, "base64");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
const cleanPerms = (role, perms) => {
  if (role === "admin") return KEYS;
  const p = Array.isArray(perms) ? perms.filter((k) => KEYS.includes(k)) : (ROLES[role] || ROLES.custom).perms;
  return [...new Set(p)];
};
const serialize = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, perms: u.role === "admin" ? KEYS : u.perms || [], active: u.active, lastLogin: u.last_login, createdAt: u.created_at });

async function findForLogin(email, password) {
  const r = await q(`SELECT * FROM app_users WHERE lower(email)=lower($1)`, [String(email || "").trim()]);
  const u = r.rows[0];
  if (!u || !u.active || !checkPass(password, u.pass_hash)) { if (!u) checkPass(password, hashPass("x")); return null; }
  await q(`UPDATE app_users SET last_login=now() WHERE id=$1`, [u.id]);
  return u;
}
async function load(id, ver) {
  const r = await q(`SELECT * FROM app_users WHERE id=$1`, [id]);
  const u = r.rows[0];
  if (!u || !u.active || Number(u.ver) !== Number(ver)) return null;
  return { ...serialize(u), owner: false };
}

/* ---------- API (réservée à « Gérer l'équipe ») ---------- */
const api = express.Router();
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

api.get("/users", wrap(async (req, res) => {
  const r = await q(`SELECT * FROM app_users ORDER BY created_at`);
  res.json({ users: r.rows.map(serialize), features: FEATURES.map(({ key, label, desc }) => ({ key, label, desc })), roles: ROLES, ownerEmail: req.ownerEmail });
}));
api.post("/users", wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim().slice(0, 80);
  const email = String(b.email || "").trim().toLowerCase();
  const role = ROLES[b.role] ? b.role : "custom";
  if (!name) return res.status(400).json({ error: "Indique le prénom et le nom" });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Email invalide" });
  if (email === String(req.ownerEmail || "").toLowerCase()) return res.status(400).json({ error: "Cet email est déjà celui du compte principal" });
  if (String(b.password || "").length < 8) return res.status(400).json({ error: "Le mot de passe doit faire au moins 8 caractères" });
  if (role !== "admin" && !req.user.owner && req.user.role !== "admin" && (b.perms || []).includes("team")) return res.status(403).json({ error: "Seul un administrateur peut donner l'accès à l'équipe" });
  try {
    const r = await q(`INSERT INTO app_users (name, email, pass_hash, role, perms) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, email, hashPass(b.password), role, JSON.stringify(cleanPerms(role, b.perms))]);
    res.json({ user: serialize(r.rows[0]) });
  } catch (e) {
    if (e.code === "23505") return res.status(400).json({ error: "Un compte existe déjà avec cet email" });
    throw e;
  }
}));
api.put("/users/:id", wrap(async (req, res) => {
  const b = req.body || {};
  const cur = (await q(`SELECT * FROM app_users WHERE id=$1`, [req.params.id])).rows[0];
  if (!cur) return res.status(404).json({ error: "Compte introuvable" });
  if (!req.user.owner && req.user.id === cur.id && (b.active === false || (b.role && b.role !== cur.role))) return res.status(400).json({ error: "Tu ne peux pas changer ton propre rôle" });
  if (!req.user.owner && req.user.role !== "admin" && (cur.role === "admin" || b.role === "admin")) return res.status(403).json({ error: "Seul un administrateur peut modifier un administrateur" });
  const role = b.role && ROLES[b.role] ? b.role : cur.role;
  const name = b.name !== undefined ? String(b.name).trim().slice(0, 80) || cur.name : cur.name;
  let email = cur.email;
  if (b.email !== undefined) {
    email = String(b.email).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Email invalide" });
  }
  const perms = b.perms !== undefined || b.role ? cleanPerms(role, b.perms !== undefined ? b.perms : cur.perms) : cur.perms;
  const active = b.active !== undefined ? !!b.active : cur.active;
  let pass = cur.pass_hash, bump = false;
  if (b.password) {
    if (String(b.password).length < 8) return res.status(400).json({ error: "Le mot de passe doit faire au moins 8 caractères" });
    pass = hashPass(b.password); bump = true;
  }
  if (!active && cur.active) bump = true;
  if (email !== cur.email) bump = true;
  try {
    const r = await q(`UPDATE app_users SET name=$2, email=$3, role=$4, perms=$5, active=$6, pass_hash=$7, ver=ver+$8 WHERE id=$1 RETURNING *`,
      [cur.id, name, email, role, JSON.stringify(perms), active, pass, bump ? 1 : 0]);
    res.json({ user: serialize(r.rows[0]) });
  } catch (e) {
    if (e.code === "23505") return res.status(400).json({ error: "Un compte existe déjà avec cet email" });
    throw e;
  }
}));
api.delete("/users/:id", wrap(async (req, res) => {
  if (!req.user.owner && Number(req.params.id) === req.user.id) return res.status(400).json({ error: "Tu ne peux pas supprimer ton propre compte" });
  const cur = (await q(`SELECT role FROM app_users WHERE id=$1`, [req.params.id])).rows[0];
  if (cur && cur.role === "admin" && !req.user.owner && req.user.role !== "admin") return res.status(403).json({ error: "Seul un administrateur peut supprimer un administrateur" });
  await q(`DELETE FROM app_users WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

// voir l'argent (paiements, CA) : seulement avec Factures ou Chiffre d'affaires
const canMoney = (u) => !u || u.owner || u.role === "admin" || (u.perms || []).some((k) => k === "billing" || k === "revenue");
module.exports = { canMoney, FEATURES, KEYS, ROLES, allowed, migrate, findForLogin, load, api };
