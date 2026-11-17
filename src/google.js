// Google Agenda : connexion OAuth, lecture des événements, rendez-vous avec lien Google Meet
const crypto = require("crypto");
const config = require("./config");
const { q } = require("./db");
const { publicUrl } = require("./twilio");

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"];
const SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.readonly", ...GMAIL_SCOPES];
const API = "https://www.googleapis.com/calendar/v3";

const configured = () => !!(config.googleClientId && config.googleClientSecret);
const missing = () => ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"].filter((k) => !process.env[k]);
const redirectUri = () => `${publicUrl()}/api/google/callback`;

async function getStore() {
  const r = await q(`SELECT value FROM settings WHERE key='google'`);
  return r.rows[0] ? r.rows[0].value : {};
}
async function setStore(v) {
  await q(`INSERT INTO settings (key, value) VALUES ('google', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [v]);
}

function sign(v) { return crypto.createHmac("sha256", config.sessionSecret || "x").update(v).digest("base64url"); }
function authUrl() {
  const nonce = crypto.randomBytes(12).toString("base64url") + "." + Date.now();
  const p = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: `${nonce}.${sign(nonce)}`,
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + p;
}
function validState(state) {
  const parts = String(state || "").split(".");
  if (parts.length !== 3) return false;
  const nonce = parts[0] + "." + parts[1];
  if (sign(nonce) !== parts[2]) return false;
  return Date.now() - Number(parts[1]) < 15 * 60 * 1000;
}

async function tokenRequest(body) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret, ...body }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`Google : ${j.error_description || j.error || res.status}`); e.code = j.error; throw e; }
  return j;
}

async function exchangeCode(code) {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  const cur = await getStore();
  const next = { ...cur, refresh_token: t.refresh_token || cur.refresh_token, access_token: t.access_token, expires_at: Date.now() + (t.expires_in - 60) * 1000, scope: t.scope || cur.scope || "" };
  await setStore(next);
  // adresse et fuseau de l'agenda principal
  try {
    const cal = await gapi("/calendars/primary");
    next.email = cal.id; next.timeZone = cal.timeZone;
    await setStore(next);
  } catch {}
  return next;
}

async function accessToken() {
  const s = await getStore();
  if (!s.refresh_token) { const e = new Error("Google Agenda n'est pas connecté"); e.code = "not_connected"; throw e; }
  if (s.access_token && s.expires_at > Date.now()) return s.access_token;
  try {
    const t = await tokenRequest({ refresh_token: s.refresh_token, grant_type: "refresh_token" });
    await setStore({ ...s, access_token: t.access_token, expires_at: Date.now() + (t.expires_in - 60) * 1000 });
    return t.access_token;
  } catch (e) {
    if (e.code === "invalid_grant") { await setStore({ ...s, refresh_token: null, access_token: null }); e.code = "not_connected"; e.message = "La connexion Google a expiré : reconnecte Google Agenda."; }
    throw e;
  }
}

async function gapi(path, { method = "GET", body, query } = {}) {
  const tok = await accessToken();
  const url = API + path + (query ? "?" + new URLSearchParams(query) : "");
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${tok}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Agenda : ${(j.error && j.error.message) || res.status}`);
  return j;
}

function mapEvent(e) {
  const meet = e.hangoutLink || (e.conferenceData && (e.conferenceData.entryPoints || []).find((x) => x.entryPointType === "video") || {}).uri || null;
  return {
    id: e.id,
    title: e.summary || "(Sans titre)",
    start: e.start && (e.start.dateTime || e.start.date),
    end: e.end && (e.end.dateTime || e.end.date),
    allDay: !!(e.start && e.start.date),
    meet,
    link: e.htmlLink,
    description: e.description || "",
    attendees: (e.attendees || []).filter((a) => !a.self).map((a) => ({ email: a.email, status: a.responseStatus })),
    leadId: e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.closerLeadId ? Number(e.extendedProperties.private.closerLeadId) : null,
    closer: !!(e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.closer),
  };
}

async function listEvents(from, to) {
  const out = [];
  let pageToken;
  for (let i = 0; i < 5; i++) {
    const d = await gapi("/calendars/primary/events", {
      query: { timeMin: from, timeMax: to, singleEvents: "true", orderBy: "startTime", maxResults: "250", ...(pageToken ? { pageToken } : {}) },
    });
    (d.items || []).filter((e) => e.status !== "cancelled").forEach((e) => out.push(mapEvent(e)));
    pageToken = d.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

async function createEvent({ title, start, end, email, description, meet, notify, leadId, timeZone }) {
  const body = {
    summary: title,
    description: description || undefined,
    start: { dateTime: start, ...(timeZone ? { timeZone } : {}) },
    end: { dateTime: end, ...(timeZone ? { timeZone } : {}) },
    attendees: email ? [{ email }] : undefined,
    reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 10 }, { method: "email", minutes: 60 }] },
    extendedProperties: { private: { closer: "1", ...(leadId ? { closerLeadId: String(leadId) } : {}) } },
  };
  if (meet) body.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
  const e = await gapi("/calendars/primary/events", {
    method: "POST",
    body,
    query: { conferenceDataVersion: meet ? "1" : "0", sendUpdates: notify && email ? "all" : "none" },
  });
  return mapEvent(e);
}

async function deleteEvent(id, notify) {
  await gapi(`/calendars/primary/events/${encodeURIComponent(id)}`, { method: "DELETE", query: { sendUpdates: notify ? "all" : "none" } });
}

async function status() {
  const s = await getStore();
  return { configured: configured(), missing: missing(), connected: !!s.refresh_token, gmail: !!s.refresh_token && hasGmail(s), email: s.email || null, timeZone: s.timeZone || null, redirectUri: publicUrl() ? redirectUri() : null };
}

const hasGmail = (s) => GMAIL_SCOPES.every((x) => String(s.scope || "").split(" ").includes(x));

// Appel à l'API Gmail avec le même jeton
async function gmail(path, { method = "GET", body, query } = {}) {
  const tok = await accessToken();
  const url = "https://gmail.googleapis.com/gmail/v1/users/me" + path + (query ? "?" + new URLSearchParams(query) : "");
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${tok}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`Gmail : ${(j.error && j.error.message) || res.status}`);
    if (res.status === 403 || res.status === 401) e.code = "gmail_scope";
    throw e;
  }
  return j;
}

async function disconnect() {
  const s = await getStore();
  if (s.refresh_token) { try { await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(s.refresh_token), { method: "POST" }); } catch {} }
  await setStore({});
}

module.exports = { configured, missing, authUrl, validState, exchangeCode, listEvents, createEvent, deleteEvent, status, disconnect, gmail, getStore, hasGmail };
