// Emails aux couleurs de Biznify : envoi (Resend, sinon Gmail), mise en page, notifications
const express = require("express");
const config = require("./config");
const { q, getSettings } = require("./db");
const google = require("./google");
const tw = require("./twilio");

const base = () => tw.publicUrl() || "";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TZ_FR = "Europe/Paris";

/* ---------- Réglages des notifications ---------- */
const DEFAULTS = {
  owner_email: "",
  owner: { booking: true, change: true, payment: true, reply_sms: true, reply_email: false, digest: true },
  client: { booking_confirm: true, booking_change: true, payment_receipt: true },
  digest_hour: 8,
};
async function getNotif() {
  const r = await q(`SELECT value FROM settings WHERE key='notifications'`);
  const v = r.rows[0] ? r.rows[0].value : {};
  return { ...DEFAULTS, ...v, owner: { ...DEFAULTS.owner, ...(v.owner || {}) }, client: { ...DEFAULTS.client, ...(v.client || {}) } };
}
async function saveNotif(b) {
  const cur = await getNotif();
  const next = { ...cur };
  if (typeof b.owner_email === "string") next.owner_email = b.owner_email.trim().slice(0, 200);
  if (b.owner) for (const k of Object.keys(DEFAULTS.owner)) if (k in b.owner) next.owner[k] = !!b.owner[k];
  if (b.client) for (const k of Object.keys(DEFAULTS.client)) if (k in b.client) next.client[k] = !!b.client[k];
  if (b.digest_hour !== undefined) next.digest_hour = Math.max(0, Math.min(23, Math.round(Number(b.digest_hour) || 8)));
  if (next.owner_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.owner_email)) throw new Error("Email de notification invalide");
  await q(`INSERT INTO settings (key, value) VALUES ('notifications', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [next]);
  return next;
}
async function brand() {
  const r = await q(`SELECT value FROM settings WHERE key='billing'`);
  const b = r.rows[0] ? r.rows[0].value : {};
  return {
    company: b.company || "Biznify Technologies Ltd",
    short: "Biznify",
    accent: /^#[0-9a-fA-F]{6}$/.test(b.accent || "") ? b.accent : "#1877F2",
    website: b.website || "biznify.pro",
    registration: b.registration || "",
    address: b.address || "",
  };
}

/* ---------- Envoi ---------- */
async function status() {
  if (config.resendApiKey && config.emailFrom) return { ready: true, via: "resend", from: config.emailFrom };
  try {
    const g = await google.status();
    if (g.connected && g.gmail) return { ready: true, via: "gmail", from: g.email, reason: "Les emails partent de ton Gmail tant que Resend n'est pas branché" };
  } catch {}
  return { ready: false, via: null, from: null, reason: "Branche Resend (RESEND_API_KEY) ou autorise Gmail pour envoyer des emails" };
}
async function ownerEmail() {
  const n = await getNotif();
  if (n.owner_email) return n.owner_email;
  try { const g = await google.status(); if (g.email) return g.email; } catch {}
  return null;
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap76 = (s) => s.replace(/.{1,76}/g, "$&\r\n");

async function send({ to, subject, html, text, replyTo, fromName, headers = {} }) {
  const st = await status();
  if (!st.ready) throw new Error(st.reason);
  const s = await getSettings();
  const name = fromName || `${s.prenom || "Yanis"} de Biznify`;
  if (st.via === "resend") {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${name} <${config.emailFrom}>`, to: Array.isArray(to) ? to : [to], subject, html, text, reply_to: replyTo || config.emailFrom, headers }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Resend : ${j.message || j.error || r.status}`);
    return { id: "rs_" + j.id, via: "resend" };
  }
  // Gmail : message HTML + texte
  const boundary = "closer_" + Date.now().toString(36);
  const head = [`From: ${encWord(name)} <${st.from}>`, `To: ${Array.isArray(to) ? to.join(", ") : to}`, `Subject: ${encWord(subject)}`, "MIME-Version: 1.0",
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), `Content-Type: multipart/alternative; boundary="${boundary}"`];
  if (replyTo) head.push(`Reply-To: ${replyTo}`);
  const raw = head.join("\r\n") + "\r\n\r\n" +
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(text || ""))}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(html))}\r\n--${boundary}--`;
  const sent = await google.gmail("/messages/send", { method: "POST", body: { raw: Buffer.from(raw).toString("base64url") } });
  return { id: sent.id, threadId: sent.threadId, via: "gmail" };
}

/* ---------- Mise en page ---------- */
// texte brut → paragraphes HTML avec liens cliquables
function textToHtml(t) {
  return String(t || "").trim().split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#0B1220">${esc(p).replace(/\n/g, "<br>").replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" style="color:inherit;text-decoration:underline">${u}</a>`)}</p>`).join("");
}
function button(label, url, accent) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 22px"><tr><td style="border-radius:10px;background:${accent}">
    <a href="${esc(url)}" style="display:inline-block;padding:14px 26px;font:600 15px Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#ffffff;text-decoration:none;border-radius:10px">${esc(label)}</a></td></tr></table>`;
}
function infoBox(rows) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F7FB;border-radius:12px;margin:0 0 22px"><tr><td style="padding:16px 18px">
    ${rows.filter((r) => r && r[1]).map(([k, v, isLink]) => `<div style="margin:0 0 8px;font-size:14px;line-height:1.5;color:#0B1220"><span style="color:#5B6475">${esc(k)}</span><br><b style="font-weight:600">${isLink ? `<a href="${esc(v)}" style="color:#0B1220">${esc(v)}</a>` : esc(v)}</b></div>`).join("")}
  </td></tr></table>`;
}
async function layout({ preheader = "", title, intro, html = "", text = "", rows, cta, secondary, note, audience = "client" }) {
  const b = await brand();
  const logo = `${base()}/email/logo.png`;
  const body = `${title ? `<h1 style="margin:0 0 14px;font:700 22px/1.3 Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#0B1220;letter-spacing:-.01em">${esc(title)}</h1>` : ""}
    ${intro ? textToHtml(intro) : ""}${html}${text ? textToHtml(text) : ""}
    ${rows ? infoBox(rows) : ""}
    ${cta ? button(cta.label, cta.url, b.accent) : ""}
    ${secondary ? `<p style="margin:0 0 16px;font-size:14px;color:#5B6475">${secondary}</p>` : ""}
    ${note ? `<p style="margin:12px 0 0;font-size:13px;line-height:1.5;color:#5B6475">${esc(note)}</p>` : ""}`;
  const footer = audience === "owner"
    ? `Notification Biznify · <a href="${base()}/#settings" style="color:#5B6475">Gérer les notifications</a>`
    : `${esc(b.company)}${b.registration ? " · " + esc(b.registration) : ""}<br><a href="https://${esc(b.website.replace(/^https?:\/\//, ""))}" style="color:#5B6475">${esc(b.website.replace(/^https?:\/\//, ""))}</a>`;
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(title || b.short)}</title></head>
<body style="margin:0;padding:0;background:#F5F7FB;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif">
<span style="display:none!important;opacity:0;color:transparent;height:0;width:0;overflow:hidden">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F5F7FB"><tr><td align="center" style="padding:32px 14px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;background:#ffffff;border:1px solid #E4E7EE;border-radius:16px;overflow:hidden">
    <tr><td style="height:5px;background:${b.accent};font-size:0;line-height:0">&nbsp;</td></tr>
    <tr><td style="padding:28px 32px 6px"><img src="${logo}" width="120" alt="${esc(b.short)}" style="display:block;width:120px;height:auto;border:0"></td></tr>
    <tr><td style="padding:18px 32px 12px">${body}</td></tr>
  </table>
  <p style="max-width:580px;margin:16px auto 0;font-size:12px;line-height:1.6;color:#5B6475;text-align:center">${footer}</p>
</td></tr></table></body></html>`;
}
// version texte (pour les boîtes qui n'affichent pas le HTML)
function plain({ title, intro = "", text = "", rows = [], cta, note }) {
  return [title, intro, text, ...(rows || []).filter((r) => r && r[1]).map(([k, v]) => `${k} : ${v}`), cta ? `${cta.label} : ${cta.url}` : "", note || ""].filter(Boolean).join("\n\n");
}
async function sendTemplate(to, subject, t, opts = {}) {
  const html = await layout(t);
  return send({ to, subject, html, text: plain(t), ...opts });
}

/* ---------- Outils ---------- */
const fmtWhen = (d, tz = TZ_FR) => { const t = new Date(d).toLocaleString("fr-FR", { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }); return t.charAt(0).toUpperCase() + t.slice(1); };
const euro = (c) => ((c || 0) / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
const leadName = (l) => (l ? [l.first_name, l.last_name].filter(Boolean).join(" ") || l.name || l.company || l.phone : "") || "Prospect";
const firstName = (l) => (l && (l.first_name || (l.name || "").split(" ")[0])) || "";
const gcalLink = (a, title, details) => {
  const f = (d) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${f(a.start_at)}/${f(a.end_at)}&details=${encodeURIComponent(details || "")}${a.meet_url ? `&location=${encodeURIComponent(a.meet_url)}` : ""}`;
};
const leadLink = (id) => `${base()}/#lead-${id}`;
async function ownerTz() { try { const g = await google.status(); return g.timeZone || "Asia/Ho_Chi_Minh"; } catch { return "Asia/Ho_Chi_Minh"; } }

// toutes les notifications passent ici : jamais d'erreur remontée à l'action d'origine
function fire(fn) { setImmediate(() => Promise.resolve().then(fn).catch((e) => console.warn("Notification email :", e.message))); }

/* ---------- Notifications ---------- */
async function bookingCreated(a, lead, cal) {
  const n = await getNotif();
  const calName = cal ? cal.name : a.title;
  const manage = a.manage_token ? `${base()}/r/m/${a.manage_token}` : null;
  if (n.client.booking_confirm && a.attendee_email) {
    await sendTemplate(a.attendee_email, `Confirmé : ${calName}, ${fmtWhen(a.start_at).toLowerCase()}`, {
      preheader: `Votre rendez-vous ${fmtWhen(a.start_at)} (heure de Paris)`,
      title: "Votre rendez-vous est confirmé",
      intro: `Bonjour ${firstName(lead)},\n\nMerci pour votre réservation. Voici le récapitulatif de notre rendez-vous.`,
      rows: [["Rendez-vous", calName], ["Date", `${fmtWhen(a.start_at)} (heure de Paris)`], a.meet_url ? ["Visio Google Meet", a.meet_url, true] : null],
      cta: a.meet_url ? { label: "Rejoindre la visio", url: a.meet_url } : null,
      secondary: `<a href="${esc(gcalLink(a, calName, a.meet_url || ""))}" style="color:#0B1220">Ajouter à mon agenda</a>${manage ? ` &nbsp;·&nbsp; <a href="${esc(manage)}" style="color:#0B1220">Déplacer ou annuler</a>` : ""}`,
      note: "Un empêchement ? Utilisez le lien ci-dessus pour choisir un autre créneau, ou répondez simplement à cet email.",
    });
  }
  if (n.owner.booking) {
    const to = await ownerEmail(); if (!to) return;
    const tz = await ownerTz();
    await sendTemplate(to, `Nouveau RDV : ${leadName(lead)}${lead && lead.company ? ` (${lead.company})` : ""}`, {
      audience: "owner", preheader: `${calName} · ${fmtWhen(a.start_at)} à Paris`,
      title: "Nouveau rendez-vous réservé",
      intro: `${leadName(lead)} vient de réserver sur « ${calName} ».`,
      rows: [["Quand (heure de Paris)", fmtWhen(a.start_at)], ["Chez toi", fmtWhen(a.start_at, tz)], ["Entreprise", lead && lead.company], ["Téléphone", lead && lead.phone], ["Email", a.attendee_email], ["Message", a.notes], a.meet_url ? ["Google Meet", a.meet_url, true] : null],
      cta: { label: "Ouvrir la fiche dans Biznify", url: leadLink(lead.id) },
    });
  }
}

async function bookingChanged(a, lead, cal, kind, newStart) {
  const n = await getNotif();
  const calName = cal ? cal.name : a.title;
  if (n.client.booking_change && a.attendee_email) {
    if (kind === "moved") {
      await sendTemplate(a.attendee_email, `Rendez-vous déplacé : ${fmtWhen(newStart).toLowerCase()}`, {
        title: "Votre rendez-vous a bien été déplacé",
        intro: `Bonjour ${firstName(lead)},\n\nC'est noté, voici votre nouveau créneau.`,
        rows: [["Rendez-vous", calName], ["Nouvelle date", `${fmtWhen(newStart)} (heure de Paris)`], a.meet_url ? ["Visio Google Meet", a.meet_url, true] : null],
        cta: a.meet_url ? { label: "Rejoindre la visio", url: a.meet_url } : null,
      });
    } else {
      await sendTemplate(a.attendee_email, "Votre rendez-vous est annulé", {
        title: "Rendez-vous annulé",
        intro: `Bonjour ${firstName(lead)},\n\nVotre rendez-vous du ${fmtWhen(a.start_at).toLowerCase()} est bien annulé.`,
        cta: cal && cal.active ? { label: "Choisir un nouveau créneau", url: `${base()}/r/${cal.slug}` } : null,
        note: "Vous pouvez reprendre rendez-vous quand vous voulez.",
      });
    }
  }
  if (n.owner.change) {
    const to = await ownerEmail(); if (!to) return;
    const tz = await ownerTz();
    await sendTemplate(to, `${kind === "moved" ? "RDV déplacé" : "RDV annulé"} : ${leadName(lead)}`, {
      audience: "owner",
      title: kind === "moved" ? "Un prospect a déplacé son RDV" : "Un prospect a annulé son RDV",
      intro: `${leadName(lead)}${lead && lead.company ? ` (${lead.company})` : ""} a ${kind === "moved" ? "déplacé" : "annulé"} son rendez-vous « ${calName} ».`,
      rows: [["Avant", fmtWhen(a.start_at)], kind === "moved" ? ["Nouveau créneau (Paris)", fmtWhen(newStart)] : null, kind === "moved" ? ["Chez toi", fmtWhen(newStart, tz)] : null, ["Téléphone", lead && lead.phone]],
      cta: lead ? { label: "Ouvrir la fiche", url: leadLink(lead.id) } : null,
    });
  }
}

async function invoicePaid(inv) {
  const n = await getNotif();
  const c = inv.client || {};
  const url = `${tw.payUrl() || base()}/facture/${inv.token}`;
  if (n.client.payment_receipt && c.email) {
    await sendTemplate(c.email, `Paiement reçu : facture ${inv.number}`, {
      preheader: `Merci, ${euro(inv.total_cents)} bien reçus`,
      title: "Merci, paiement bien reçu",
      intro: `Bonjour ${(c.name || "").split(" ")[0] || ""},\n\nNous confirmons la bonne réception de votre paiement. Merci pour votre confiance !`.replace("Bonjour ,", "Bonjour,"),
      rows: [["Facture", inv.number], ["Montant réglé", euro(inv.total_cents)], ["Date", fmtWhen(inv.paid_at || new Date())]],
      cta: { label: "Voir ma facture", url },
      note: "Vous pouvez télécharger votre facture en PDF depuis ce lien à tout moment.",
    });
  }
  if (n.owner.payment) {
    const to = await ownerEmail(); if (!to) return;
    await sendTemplate(to, `💰 ${euro(inv.total_cents)} encaissés : ${c.company || c.name || inv.number}`, {
      audience: "owner", title: `Paiement reçu : ${euro(inv.total_cents)}`,
      intro: `${c.company || c.name || "Ton client"} vient de payer la facture ${inv.number}${inv.paid_via ? ` (${inv.paid_via})` : ""}.`,
      rows: [["Facture", inv.number], ["Objet", inv.title], ["Montant", euro(inv.total_cents)]],
      cta: { label: "Voir mon chiffre d'affaires", url: `${base()}/#revenue` },
    });
  }
}

async function invoiceSend(inv, { message } = {}) {
  const c = inv.client || {};
  if (!c.email) throw new Error("Ajoute l'email du client sur la facture");
  const url = `${tw.payUrl() || base()}/facture/${inv.token}`;
  const s = await getSettings();
  const due = inv.due_date ? new Date(inv.due_date).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) : null;
  return sendTemplate(c.email, `Facture ${inv.number}${inv.title ? ` : ${inv.title}` : ""}`, {
    preheader: `${euro(inv.total_cents)} · réglable en ligne par carte`,
    title: `Votre facture ${inv.number}`,
    intro: message || `Bonjour ${(c.name || "").split(" ")[0] || ""},\n\nVeuillez trouver ci-dessous votre facture. Vous pouvez la consulter et la régler en un clic par carte bancaire.`.replace("Bonjour ,", "Bonjour,"),
    rows: [["Facture", inv.number], ["Objet", inv.title], ["Montant TTC", euro(inv.total_cents)], due ? ["Échéance", due] : null],
    cta: { label: `Voir et payer ${euro(inv.total_cents)}`, url },
    note: `Paiement sécurisé par Stripe. Une question ? Répondez simplement à cet email. ${s.prenom || "Yanis"}`,
  });
}

async function replyReceived(lead, channel, body) {
  const n = await getNotif();
  if (!(channel === "sms" ? n.owner.reply_sms : n.owner.reply_email)) return;
  const to = await ownerEmail(); if (!to) return;
  await sendTemplate(to, `${leadName(lead)} t'a répondu par ${channel === "sms" ? "SMS" : "email"}`, {
    audience: "owner", preheader: String(body || "").slice(0, 120),
    title: `Nouveau message de ${leadName(lead)}`,
    intro: lead.company ? `${lead.company} · ${lead.phone || ""}` : lead.phone || "",
    html: `<div style="border-left:3px solid #E4E7EE;padding:4px 0 4px 14px;margin:0 0 20px;font-size:15px;line-height:1.6;color:#0B1220">${esc(body).replace(/\n/g, "<br>")}</div>`,
    cta: { label: "Répondre dans Biznify", url: `${base()}/#conversations` },
  });
}

/* ---------- Résumé du jour (heure du propriétaire) ---------- */
async function digest(force = false) {
  const n = await getNotif();
  if (!n.owner.digest && !force) return null;
  const to = await ownerEmail(); if (!to) return null;
  const tz = await ownerTz();
  const s = await getSettings();
  const [appts, tasks, late, month] = await Promise.all([
    q(`SELECT a.*, l.first_name, l.last_name, l.name, l.company, c.name AS cal_name FROM appointments a LEFT JOIN leads l ON l.id=a.lead_id LEFT JOIN booking_calendars c ON c.id=a.calendar_id
       WHERE a.status <> 'annule' AND a.start_at >= now() AND a.start_at < now() + interval '24 hours' ORDER BY a.start_at`),
    q(`SELECT t.*, l.first_name, l.last_name, l.name, l.company FROM tasks t LEFT JOIN leads l ON l.id=t.lead_id WHERE t.done_at IS NULL AND t.due_at <= now() + interval '12 hours' ORDER BY t.due_at LIMIT 15`),
    q(`SELECT number, total_cents, client FROM invoices WHERE status='emise' AND due_date < CURRENT_DATE ORDER BY due_date LIMIT 10`),
    q(`SELECT COALESCE(sum(total_cents),0)::bigint AS c FROM invoices WHERE status='payee' AND paid_at >= date_trunc('month', now() AT TIME ZONE 'Europe/Paris') AT TIME ZONE 'Europe/Paris'`),
  ]);
  const goal = (Number(s.objectifCA) || 0) * 100;
  const list = (items) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px">${items.join("")}</table>`;
  const li = (left, right, sub) => `<tr><td style="padding:10px 0;border-bottom:1px solid #E4E7EE;font-size:14px;color:#0B1220"><b style="font-weight:600">${left}</b>${sub ? `<br><span style="color:#5B6475;font-size:13px">${sub}</span>` : ""}</td><td align="right" style="padding:10px 0;border-bottom:1px solid #E4E7EE;font-size:13px;color:#5B6475;white-space:nowrap">${right}</td></tr>`;
  const h2 = (t) => `<h2 style="margin:6px 0 6px;font:600 15px Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#0B1220">${t}</h2>`;
  const time = (d) => new Date(d).toLocaleTimeString("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  let html = "";
  html += h2(`Tes RDV des prochaines 24 h (${appts.rows.length})`);
  html += appts.rows.length ? list(appts.rows.map((a) => li(esc(leadName(a)) + (a.company ? ` · ${esc(a.company)}` : ""), `${time(a.start_at)} chez toi`, esc(a.cal_name || a.title)))) : `<p style="margin:0 0 20px;color:#5B6475;font-size:14px">Aucun RDV prévu.</p>`;
  html += h2(`Tâches à faire (${tasks.rows.length})`);
  html += tasks.rows.length ? list(tasks.rows.map((t) => li(esc(t.title), "", esc(t.body || "")))) : `<p style="margin:0 0 20px;color:#5B6475;font-size:14px">Rien en attente.</p>`;
  if (late.rows.length) { html += h2(`Factures en retard (${late.rows.length})`); html += list(late.rows.map((i) => li(esc((i.client && (i.client.company || i.client.name)) || i.number), euro(i.total_cents), esc(i.number)))); }
  const pct = goal ? Math.min(100, Math.round((Number(month.rows[0].c) / goal) * 100)) : null;
  html += h2("Ce mois-ci");
  html += `<p style="margin:0 0 6px;font-size:14px;color:#0B1220"><b style="font-size:20px">${euro(Number(month.rows[0].c))}</b>${goal ? ` encaissés sur ${euro(goal)} (${pct} %)` : " encaissés"}</p>`;
  if (goal) html += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px"><tr><td style="background:#E4E7EE;border-radius:6px;height:10px;font-size:0"><div style="width:${pct}%;height:10px;background:#1877F2;border-radius:6px"></div></td></tr></table>`;
  const today = new Date().toLocaleDateString("fr-FR", { timeZone: tz, weekday: "long", day: "numeric", month: "long" });
  return sendTemplate(to, `Ta journée : ${appts.rows.length} RDV, ${tasks.rows.length} tâche${tasks.rows.length > 1 ? "s" : ""}`, {
    audience: "owner", preheader: `${appts.rows.length} RDV et ${tasks.rows.length} tâches aujourd'hui`,
    title: `Bonjour ${s.prenom || "Yanis"}, voici ta journée`, intro: today.charAt(0).toUpperCase() + today.slice(1), html,
    cta: { label: "Ouvrir Biznify", url: `${base()}/` },
  });
}
async function digestTick() {
  try {
    const n = await getNotif();
    if (!n.owner.digest) return;
    const tz = await ownerTz();
    const now = new Date();
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(now));
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    if (hour !== n.digest_hour) return;
    const st = (await q(`SELECT value FROM settings WHERE key='digest_sent'`)).rows[0];
    if (st && st.value && st.value.day === day) return;
    await q(`INSERT INTO settings (key, value) VALUES ('digest_sent', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [{ day }]);
    await digest();
  } catch (e) { console.warn("Résumé du jour :", e.message); }
}
function start() { setInterval(digestTick, 5 * 60 * 1000); setTimeout(digestTick, 20000); }

/* ---------- API ---------- */
const api = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
api.get("/notifications", wrap(async (req, res) => res.json({ settings: await getNotif(), status: await status(), owner: await ownerEmail() })));
api.put("/notifications", wrap(async (req, res) => {
  try { res.json({ settings: await saveNotif(req.body || {}) }); } catch (e) { res.status(400).json({ error: e.message }); }
}));
api.post("/notifications/test", wrap(async (req, res) => {
  const kind = req.body && req.body.kind;
  const to = await ownerEmail();
  if (!to) return res.status(400).json({ error: "Indique l'email où recevoir les notifications" });
  try {
    if (kind === "digest") { await digest(true); return res.json({ ok: true, to }); }
    const sample = { id: 0, first_name: "Paul", last_name: "Martin", company: "Martin Climatisation", phone: "+33612345678" };
    const start = new Date(Date.now() + 2 * 864e5); start.setUTCHours(14, 0, 0, 0);
    const a = { title: "Démo", start_at: start, end_at: new Date(start.getTime() + 3600e3), meet_url: "https://meet.google.com/abc-defg-hij", attendee_email: to, manage_token: "exemple", notes: "Je perds des appels quand je suis sur les chantiers." };
    const cal = { name: "Biznify - Turn Leads into Sales", slug: "biznifymeeting", active: true };
    if (kind === "client_booking") {
      const n = await getNotif(); const saved = n.owner.booking; n.owner.booking = false;
      await sendTemplate(to, `[Test] Confirmé : ${cal.name}`, { preheader: "Exemple d'email reçu par ton prospect", title: "Votre rendez-vous est confirmé", intro: "Bonjour Paul,\n\nMerci pour votre réservation. Voici le récapitulatif de notre rendez-vous.", rows: [["Rendez-vous", cal.name], ["Date", `${fmtWhen(a.start_at)} (heure de Paris)`], ["Visio Google Meet", a.meet_url, true]], cta: { label: "Rejoindre la visio", url: a.meet_url }, secondary: `<a href="#" style="color:#0B1220">Ajouter à mon agenda</a> &nbsp;·&nbsp; <a href="#" style="color:#0B1220">Déplacer ou annuler</a>`, note: "Un empêchement ? Utilisez le lien ci-dessus pour choisir un autre créneau, ou répondez simplement à cet email." });
      n.owner.booking = saved;
    } else if (kind === "owner_booking") {
      await sendTemplate(to, "[Test] Nouveau RDV : Paul Martin (Martin Climatisation)", { audience: "owner", title: "Nouveau rendez-vous réservé", intro: `Paul Martin vient de réserver sur « ${cal.name} ».`, rows: [["Quand (heure de Paris)", fmtWhen(a.start_at)], ["Chez toi", fmtWhen(a.start_at, await ownerTz())], ["Entreprise", sample.company], ["Téléphone", sample.phone], ["Message", a.notes], ["Google Meet", a.meet_url, true]], cta: { label: "Ouvrir Biznify", url: `${base()}/` } });
    } else if (kind === "invoice") {
      await sendTemplate(to, "[Test] Facture BZ-2026-0001 : Réceptionniste IA", { preheader: "1 068,00 € · réglable en ligne par carte", title: "Votre facture BZ-2026-0001", intro: "Bonjour Paul,\n\nVeuillez trouver ci-dessous votre facture. Vous pouvez la consulter et la régler en un clic par carte bancaire.", rows: [["Facture", "BZ-2026-0001"], ["Objet", "Réceptionniste IA — mise en place"], ["Montant TTC", "1 068,00 €"], ["Échéance", "25 novembre 2026"]], cta: { label: "Voir et payer 1 068,00 €", url: `${base()}/` }, note: "Paiement sécurisé par Stripe. Une question ? Répondez simplement à cet email." });
    } else return res.status(400).json({ error: "Type de test inconnu" });
    res.json({ ok: true, to });
  } catch (e) { res.status(502).json({ error: e.message }); }
}));

/* Logo des emails (PNG : les boîtes mail n'affichent pas les SVG) */
const fs = require("fs");
const path = require("path");
const LOGO = (() => { try { return fs.readFileSync(path.join(__dirname, "..", "public", "brand", "biznify-logo.png")); } catch { return null; } })();
const publicRoutes = express.Router();
publicRoutes.get("/email/logo.png", wrap(async (req, res) => {
  const r = await q(`SELECT value FROM settings WHERE key='billing'`);
  const logo = r.rows[0] && r.rows[0].value && r.rows[0].value.logo;
  const m = logo && /^data:image\/(png|jpeg);base64,(.+)$/.exec(logo);
  res.setHeader("Cache-Control", "public, max-age=86400");
  if (m) { res.type(m[1]); return res.send(Buffer.from(m[2], "base64")); }
  if (!LOGO) return res.status(404).end();
  res.type("png").send(LOGO);
}));

module.exports = { api, publicRoutes, start, fire, send, layout, textToHtml, sendTemplate, bookingCreated, bookingChanged, invoicePaid, invoiceSend, replyReceived, digest, status };
