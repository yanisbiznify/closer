// Conversations : SMS (Twilio) et email (Gmail) avec les prospects, dans un seul fil par prospect
const express = require("express");
const config = require("./config");
const { q, getSettings } = require("./db");
const tw = require("./twilio");
const google = require("./google");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const smsFrom = () => config.twilioSmsFrom || config.twilioCallerId || null;

async function getState() {
  const r = await q(`SELECT value FROM settings WHERE key='inbox'`);
  return r.rows[0] ? r.rows[0].value : {};
}
async function setState(patch) {
  const v = { ...(await getState()), ...patch };
  await q(`INSERT INTO settings (key, value) VALUES ('inbox', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [v]);
  return v;
}

/* ---------- SMS : vérifie le numéro Twilio et branche la réception ---------- */
let smsSetup = null, smsCheckedAt = 0;
function ensureSms(force = false) {
  if (!tw.enabled()) return Promise.resolve({ ready: false, reason: "Twilio n'est pas configuré" });
  // un échec est revérifié au plus toutes les 10 minutes (ou sur demande)
  if (smsSetup && !force && Date.now() - smsCheckedAt < 10 * 60 * 1000) return smsSetup;
  smsCheckedAt = Date.now();
  smsSetup = (async () => {
    const from = tw.normalizePhone(smsFrom()) || smsFrom();
    const base = tw.publicUrl();
    let st;
    try {
      const nums = await tw.client().incomingPhoneNumbers.list({ phoneNumber: from, limit: 1 });
      const n = nums[0];
      if (!n) st = { ready: false, from, reason: `Le numéro ${from} n'est pas un numéro Twilio de ton compte : il sert à appeler, pas à envoyer des SMS. Achète un numéro compatible SMS dans Twilio et mets-le dans TWILIO_SMS_FROM.` };
      else if (!(n.capabilities && (n.capabilities.sms || n.capabilities.SMS))) st = { ready: false, from, reason: `Le numéro ${from} ne peut pas envoyer de SMS. Prends un numéro mobile compatible SMS dans Twilio et mets-le dans TWILIO_SMS_FROM.` };
      else {
        if (base) {
          const smsUrl = `${base}/api/twilio/sms`;
          if (n.smsUrl !== smsUrl) await tw.client().incomingPhoneNumbers(n.sid).update({ smsUrl, smsMethod: "POST" });
        }
        st = { ready: true, from, reason: null };
      }
    } catch (e) {
      st = { ready: false, from, reason: "Twilio : " + e.message };
    }
    await setState({ sms: st });
    if (st.ready) smsCheckedAt = Infinity;
    return st;
  })();
  return smsSetup;
}

async function emailStatus() {
  const g = await google.status();
  if (!g.configured) return { ready: false, connected: false, reason: "Google n'est pas configuré dans Railway" };
  if (!g.connected) return { ready: false, connected: false, reason: "Connecte ton compte Google pour envoyer des emails" };
  if (!g.gmail) return { ready: false, connected: true, from: g.email, reason: "Autorise Gmail : reconnecte ton compte Google une fois" };
  return { ready: true, connected: true, from: g.email, reason: null };
}

/* ---------- Prospects : retrouver qui écrit ---------- */
async function leadByPhone(phone) {
  const r = await q(`SELECT id FROM leads WHERE phone=$1 ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1`, [phone]);
  return r.rows[0] ? r.rows[0].id : null;
}
async function inboundList() {
  const ex = await q(`SELECT id FROM lists WHERE source='manuel' AND name='Contacts entrants' LIMIT 1`);
  return ex.rows[0] ? ex.rows[0].id : (await q(`INSERT INTO lists (name, source) VALUES ('Contacts entrants','manuel') RETURNING id`)).rows[0].id;
}

/* ---------- Envoi ---------- */
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap76 = (s) => s.replace(/.{1,76}/g, "$&\r\n");

async function sendSms(lead, body) {
  const st = await ensureSms();
  if (!st.ready) throw new Error(st.reason);
  if (!lead.phone) throw new Error("Ce prospect n'a pas de numéro");
  const base = tw.publicUrl();
  const m = await tw.client().messages.create({ from: st.from, to: lead.phone, body, ...(base ? { statusCallback: `${base}/api/twilio/sms-status` } : {}) });
  const r = await q(`INSERT INTO messages (lead_id, channel, direction, address, body, status, external_id, read_at) VALUES ($1,'sms','out',$2,$3,$4,$5,now()) RETURNING *`,
    [lead.id, lead.phone, body, m.status || "queued", m.sid]);
  return r.rows[0];
}

async function sendEmail(lead, subject, body) {
  const st = await emailStatus();
  if (!st.ready) throw new Error(st.reason);
  if (!lead.email) throw new Error("Ce prospect n'a pas d'email");
  // On répond dans le même fil que le dernier email échangé
  const last = (await q(`SELECT thread_id, mid_header, subject FROM messages WHERE lead_id=$1 AND channel='email' ORDER BY created_at DESC LIMIT 1`, [lead.id])).rows[0];
  const lastIn = (await q(`SELECT mid_header FROM messages WHERE lead_id=$1 AND channel='email' AND mid_header IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [lead.id])).rows[0];
  if (!subject) subject = last && last.subject ? (/^re\s*:/i.test(last.subject) ? last.subject : "Re: " + last.subject) : "Biznify";
  const s = await getSettings();
  const fromName = `${s.prenom || "Yanis"} de Biznify`;
  const headers = [
    `From: ${encWord(fromName)} <${st.from}>`,
    `To: ${lead.email}`,
    `Subject: ${encWord(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  if (lastIn && lastIn.mid_header) headers.push(`In-Reply-To: ${lastIn.mid_header}`, `References: ${lastIn.mid_header}`);
  const raw = headers.join("\r\n") + "\r\n\r\n" + wrap76(b64(body.replace(/\r?\n/g, "\r\n")));
  const sent = await google.gmail("/messages/send", { method: "POST", body: { raw: Buffer.from(raw).toString("base64url"), ...(last && last.thread_id ? { threadId: last.thread_id } : {}) } });
  let mid = null;
  try { const full = await google.gmail(`/messages/${sent.id}`, { query: { format: "metadata", metadataHeaders: "Message-ID" } }); mid = header(full.payload, "Message-ID"); } catch {}
  const r = await q(`INSERT INTO messages (lead_id, channel, direction, address, subject, body, status, external_id, thread_id, mid_header, read_at)
                     VALUES ($1,'email','out',$2,$3,$4,'sent',$5,$6,$7,now()) RETURNING *`,
    [lead.id, lead.email, subject, body, sent.id, sent.threadId || null, mid]);
  return r.rows[0];
}

/* ---------- Réception des emails (Gmail, toutes les 2 minutes) ---------- */
const header = (payload, name) => ((payload && payload.headers) || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || null;
const decode = (d) => Buffer.from(String(d || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
function textOf(payload) {
  let plain = null, html = null;
  (function walk(p) {
    if (!p) return;
    if (p.mimeType === "text/plain" && p.body && p.body.data && plain == null) plain = decode(p.body.data);
    else if (p.mimeType === "text/html" && p.body && p.body.data && html == null) html = decode(p.body.data);
    (p.parts || []).forEach(walk);
  })(payload);
  let t = plain != null ? plain : (html || "").replace(/<(br|\/p|\/div)[^>]*>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  // On retire le message cité dans la réponse
  const lines = t.replace(/\r/g, "").split("\n");
  const cut = lines.findIndex((l) => /^(Le .+a écrit ?:|On .+wrote:|-{2,} ?(Original|Message d'origine)|De ?: .+@)/i.test(l.trim()) || /^>/.test(l));
  return (cut > 0 ? lines.slice(0, cut) : lines).join("\n").trim();
}
const emailAddr = (from) => ((/<([^>]+)>/.exec(from || "") || [])[1] || from || "").trim().toLowerCase();

let syncing = false;
async function syncEmail() {
  if (syncing) return { added: 0 };
  syncing = true;
  try {
    const st = await emailStatus();
    if (!st.ready) return { added: 0 };
    const state = await getState();
    const since = state.gmailAfter || Math.floor(Date.now() / 1000) - 3 * 86400;
    const startedAt = Math.floor(Date.now() / 1000);
    let added = 0, pageToken;
    for (let i = 0; i < 5; i++) {
      const list = await google.gmail("/messages", { query: { q: `in:inbox after:${since - 300}`, maxResults: "100", ...(pageToken ? { pageToken } : {}) } });
      const ids = (list.messages || []).map((m) => m.id);
      if (ids.length) {
        const known = new Set((await q(`SELECT external_id FROM messages WHERE external_id = ANY($1)`, [ids])).rows.map((r) => r.external_id));
        for (const id of ids.filter((x) => !known.has(x))) {
          const m = await google.gmail(`/messages/${id}`, { query: { format: "full" } });
          const from = emailAddr(header(m.payload, "From"));
          if (!from || from === String(st.from || "").toLowerCase()) continue;
          const lead = (await q(`SELECT id FROM leads WHERE lower(email)=$1 ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [from])).rows[0];
          if (!lead) continue; // seuls les emails de tes prospects entrent dans CLOSER PRO
          const ins = await q(
            `INSERT INTO messages (lead_id, channel, direction, address, subject, body, status, external_id, thread_id, mid_header, created_at)
             VALUES ($1,'email','in',$2,$3,$4,'received',$5,$6,$7, to_timestamp($8::double precision / 1000)) ON CONFLICT (external_id) DO NOTHING RETURNING id`,
            [lead.id, from, header(m.payload, "Subject"), textOf(m.payload) || m.snippet || "", m.id, m.threadId, header(m.payload, "Message-ID"), Number(m.internalDate) || Date.now()]
          );
          if (ins.rows[0]) { added++; await q(`UPDATE leads SET updated_at=now() WHERE id=$1`, [lead.id]); }
        }
      }
      pageToken = list.nextPageToken;
      if (!pageToken) break;
    }
    await setState({ gmailAfter: startedAt, gmailError: null });
    return { added };
  } catch (e) {
    await setState({ gmailError: e.message }).catch(() => {});
    throw e;
  } finally { syncing = false; }
}

function start() {
  setTimeout(() => { ensureSms().catch(() => {}); syncEmail().catch((e) => console.warn("Gmail :", e.message)); }, 8000);
  setInterval(() => syncEmail().catch((e) => console.warn("Gmail :", e.message)), 2 * 60 * 1000);
}

/* ---------- Webhooks Twilio SMS ---------- */
const hooks = express.Router();
hooks.use(express.urlencoded({ extended: false }));
hooks.post("/sms", wrap(async (req, res) => {
  res.type("text/xml");
  if (!tw.validRequest(req)) return res.status(403).send("<Response/>");
  const from = tw.normalizePhone(req.body.From) || req.body.From;
  let body = String(req.body.Body || "");
  const media = Number(req.body.NumMedia || 0);
  if (media) body += (body ? "\n" : "") + `[${media} pièce${media > 1 ? "s" : ""} jointe${media > 1 ? "s" : ""} (MMS)]`;
  let leadId = await leadByPhone(from);
  if (!leadId) {
    const r = await q(`INSERT INTO leads (list_id, name, phone, source, stage, stage_at) VALUES ($1,$2,$3,'sms entrant','nouveau',now()) RETURNING id`, [await inboundList(), "Nouveau contact", from]);
    leadId = r.rows[0].id;
  }
  await q(`INSERT INTO messages (lead_id, channel, direction, address, body, status, external_id) VALUES ($1,'sms','in',$2,$3,'received',$4) ON CONFLICT (external_id) DO NOTHING`,
    [leadId, from, body, req.body.MessageSid || null]);
  await q(`UPDATE leads SET updated_at=now() WHERE id=$1`, [leadId]);
  res.send("<Response/>");
}));
hooks.post("/sms-status", wrap(async (req, res) => {
  if (!tw.validRequest(req)) return res.status(403).end();
  const st = String(req.body.MessageStatus || "");
  const err = req.body.ErrorCode ? `Erreur Twilio ${req.body.ErrorCode}` : null;
  await q(`UPDATE messages SET status=$2, error=COALESCE($3, error) WHERE external_id=$1`, [req.body.MessageSid, st, err]);
  res.status(204).end();
}));

/* ---------- API ---------- */
const api = express.Router();

api.get("/inbox/status", wrap(async (req, res) => {
  const [sms, email, state, unread] = await Promise.all([
    tw.enabled() ? ensureSms(req.query.refresh === "1") : { ready: false, reason: "Ajoute tes identifiants Twilio dans Railway" },
    emailStatus(), getState(),
    q(`SELECT count(*)::int AS n FROM messages WHERE direction='in' AND read_at IS NULL`),
  ]);
  res.json({ sms, email: { ...email, error: state.gmailError || null }, unread: unread.rows[0].n });
}));

api.get("/conversations", wrap(async (req, res) => {
  const term = String(req.query.q || "").trim().toLowerCase();
  const r = await q(
    `SELECT l.id, l.name, l.first_name, l.last_name, l.company, l.phone, l.email, l.stage,
            m.channel AS last_channel, m.direction AS last_direction, m.body AS last_body, m.subject AS last_subject, m.created_at AS last_at, m.status AS last_status,
            (SELECT count(*) FROM messages u WHERE u.lead_id=l.id AND u.direction='in' AND u.read_at IS NULL)::int AS unread
       FROM leads l
       JOIN LATERAL (SELECT * FROM messages x WHERE x.lead_id=l.id ORDER BY x.created_at DESC LIMIT 1) m ON true
      WHERE ($1 = '' OR lower(concat_ws(' ', l.name, l.first_name, l.last_name, l.company, l.phone, l.email)) LIKE '%' || $1 || '%')
        AND ($2 <> 'unread' OR EXISTS (SELECT 1 FROM messages u WHERE u.lead_id=l.id AND u.direction='in' AND u.read_at IS NULL))
      ORDER BY m.created_at DESC LIMIT 300`,
    [term, req.query.filter === "unread" ? "unread" : "all"]
  );
  res.json({ conversations: r.rows });
}));

api.get("/conversations/:leadId", wrap(async (req, res) => {
  const l = (await q(`SELECT l.*, li.name AS list_name FROM leads l LEFT JOIN lists li ON li.id=l.list_id WHERE l.id=$1`, [req.params.leadId])).rows[0];
  if (!l) return res.status(404).json({ error: "Prospect introuvable" });
  const m = await q(`SELECT id, channel, direction, address, subject, body, status, error, created_at, read_at FROM messages WHERE lead_id=$1 ORDER BY created_at ASC LIMIT 500`, [l.id]);
  if (req.query.markRead !== "0") await q(`UPDATE messages SET read_at=now() WHERE lead_id=$1 AND direction='in' AND read_at IS NULL`, [l.id]);
  res.json({ lead: l, messages: m.rows });
}));

api.post("/conversations/:leadId/send", wrap(async (req, res) => {
  const l = (await q(`SELECT * FROM leads WHERE id=$1`, [req.params.leadId])).rows[0];
  if (!l) return res.status(404).json({ error: "Prospect introuvable" });
  const channel = req.body && req.body.channel;
  const body = String((req.body && req.body.body) || "").trim();
  if (!body) return res.status(400).json({ error: "Écris un message" });
  try {
    let msg;
    if (channel === "sms") {
      if (body.length > 1500) return res.status(400).json({ error: "SMS trop long (1 500 caractères max)" });
      msg = await sendSms(l, body);
    } else if (channel === "email") {
      msg = await sendEmail(l, String(req.body.subject || "").trim().slice(0, 200), body.slice(0, 20000));
    } else return res.status(400).json({ error: "Canal inconnu" });
    await q(`UPDATE leads SET updated_at=now() WHERE id=$1`, [l.id]);
    res.json({ message: msg });
  } catch (e) { res.status(e.code === "gmail_scope" ? 409 : 502).json({ error: e.message }); }
}));

api.post("/inbox/sync", wrap(async (req, res) => {
  try { res.json(await syncEmail()); } catch (e) { res.status(502).json({ error: e.message }); }
}));

module.exports = { api, hooks, start };
