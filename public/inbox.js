/* CLOSER PRO — Conversations SMS et email */
const CV = { status: null, list: [], filter: "all", q: "", leadId: null, thread: null, channel: null, timer: null, drafts: {} };

const CV_ICON = {
  sms: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>`,
  email: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5 12 13l8.5-6.5"/></svg>`,
};
const CV_TEMPLATES = [
  ["Suite à notre appel", "Bonjour {prénom},\n\nMerci pour notre échange de tout à l'heure. Comme promis, voici un petit récapitulatif : notre IA répond à vos appels 24 h/24, qualifie vos clients et vous cale les rendez-vous directement dans votre agenda.\n\nOn se cale 15 minutes pour que je vous montre ?\n\n{ton prénom}"],
  ["Confirmation de RDV", "Bonjour {prénom}, c'est {ton prénom} de Biznify. Je vous confirme notre rendez-vous. À très vite !"],
  ["Relance", "Bonjour {prénom}, c'est {ton prénom} de Biznify. Je reviens vers vous suite à notre échange : avez-vous eu le temps d'y réfléchir ?"],
  ["Je n'ai pas pu vous joindre", "Bonjour {prénom}, {ton prénom} de Biznify. J'ai essayé de vous appeler, quand puis-je vous rappeler ?"],
];
const cvName = (l) => [l.first_name, l.last_name].filter(Boolean).join(" ") || l.name || l.company || l.phone || l.email || "Prospect";
const cvWhen = (iso) => {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Hier";
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
};
const cvFull = (iso) => new Date(iso).toLocaleString("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
// Un SMS fait 160 caractères (70 avec accents ou emojis hors alphabet GSM)
function smsParts(t) {
  const gsm = /^[\n\r @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/.test(t);
  const len = t.length; if (!len) return { len, parts: 0, gsm };
  const one = gsm ? 160 : 70, many = gsm ? 153 : 67;
  return { len, gsm, parts: len <= one ? 1 : Math.ceil(len / many) };
}

async function cvStatus(refresh) {
  try { CV.status = await api("/inbox/status" + (refresh ? "?refresh=1" : "")); } catch { return; }
  $("#nav-unread").textContent = CV.status.unread || "";
}

function cvOnView(v) {
  clearInterval(CV.timer);
  if (v !== "conversations") return;
  loadConversations();
  CV.timer = setInterval(() => { if (document.visibilityState === "visible") loadConversations(true); }, 15000);
}

async function loadConversations(quiet) {
  await cvStatus();
  renderSetup();
  try {
    const r = await api(`/conversations?filter=${CV.filter}&q=${encodeURIComponent(CV.q)}`);
    CV.list = r.conversations;
  } catch (e) { if (!quiet) toast(e.message); return; }
  renderList();
  if (CV.leadId) loadThread(CV.leadId, quiet);
  else if (!quiet) renderEmptyMain();
}

// la zone de conversation remplit l'écran sous l'en-tête
function cvFit() {
  const w = $("#v-conversations .cv-wrap"); if (!w || !$("#v-conversations").classList.contains("on")) return;
  w.style.height = Math.max(460, window.innerHeight - w.getBoundingClientRect().top - window.scrollY - 24) + "px";
}
window.addEventListener("resize", cvFit);

function renderSetup() {
  const s = CV.status; if (!s) return;
  const items = [];
  if (!s.email.ready) items.push(`<div class="cv-chan"><span class="cv-ic">${CV_ICON.email}</span><div class="grow"><b>Email</b><p>${esc(s.email.reason)}</p></div>${s.email.connected !== undefined && /Google/.test(s.email.reason) && !/Railway/.test(s.email.reason) ? `<a class="btn primary" href="/api/google/auth?ret=conversations">${s.email.connected ? "Autoriser Gmail" : "Connecter Google"}</a>` : ""}</div>`);
  if (!s.sms.ready) items.push(`<div class="cv-chan"><span class="cv-ic">${CV_ICON.sms}</span><div class="grow"><b>SMS</b><p>${esc(s.sms.reason || "SMS indisponible")}</p></div><button class="btn ghost" id="cv-sms-retry">Revérifier</button></div>`);
  if (s.email.ready && s.email.receive && !s.email.receive.ready) items.push(`<div class="cv-chan"><span class="cv-ic">${CV_ICON.email}</span><div class="grow"><b>Réponses par email</b><p>${esc(s.email.receive.reason)}. Tes emails partent bien de ${esc(s.email.from)}.</p></div>${/Railway/.test(s.email.receive.reason) ? "" : `<a class="btn primary" href="/api/google/auth?ret=conversations">${s.email.connected ? "Autoriser Gmail" : "Connecter Google"}</a>`}</div>`);
  if (s.email.ready && s.email.error) items.push(`<div class="cv-chan"><span class="cv-ic">${CV_ICON.email}</span><div class="grow"><b>Réception des emails</b><p>${esc(s.email.error)}</p></div></div>`);
  $("#cv-setup").innerHTML = items.length ? `<div class="cv-setup">${items.join("")}</div>` : "";
  cvFit();
  const rb = $("#cv-sms-retry"); if (rb) rb.onclick = async () => { rb.disabled = true; await cvStatus(true); renderSetup(); if (CV.thread) renderComposer(); };
}

function renderList() {
  const el = $("#cv-list");
  if (!CV.list.length) {
    el.innerHTML = `<div class="cv-empty">${CV.q || CV.filter === "unread" ? "Aucune conversation ne correspond." : "Pas encore de conversation. Écris à un prospect avec « Nouveau message »."}</div>`;
    return;
  }
  el.innerHTML = CV.list.map((c) => `<button class="cv-item ${c.id === CV.leadId ? "on" : ""} ${c.unread ? "unread" : ""}" data-id="${c.id}">
      <div class="cv-i-top"><b>${esc(cvName(c))}</b><span>${cvWhen(c.last_at)}</span></div>
      ${c.company && cvName(c) !== c.company ? `<div class="cv-i-co">${esc(c.company)}</div>` : ""}
      <div class="cv-i-last"><span class="cv-ic sm">${CV_ICON[c.last_channel]}</span><span class="txt">${c.last_direction === "out" ? "Toi : " : ""}${esc((c.last_channel === "email" && c.last_subject ? c.last_subject + " — " : "") + (c.last_body || "").replace(/\s+/g, " ")).slice(0, 140)}</span>${c.unread ? `<span class="cv-dot" aria-label="${c.unread} non lu${c.unread > 1 ? "s" : ""}">${c.unread}</span>` : ""}</div>
    </button>`).join("");
  $$("#cv-list .cv-item").forEach((b) => (b.onclick = () => openConversation(Number(b.dataset.id))));
}

function renderEmptyMain() {
  $("#cv-main").innerHTML = `<div class="cv-none"><span class="cv-ic lg">${CV_ICON.sms}</span><b>Choisis une conversation</b><p class="muted">ou démarre-en une avec « Nouveau message ».</p></div>`;
}

async function openConversation(leadId) {
  if (!$("#v-conversations").classList.contains("on")) { CV.leadId = leadId; CV.channel = null; show("conversations"); return; }
  if (CV.leadId !== leadId) CV.channel = null;
  CV.leadId = leadId;
  $$("#cv-list .cv-item").forEach((b) => b.classList.toggle("on", Number(b.dataset.id) === leadId));
  $("#v-conversations").classList.add("cv-open");
  await loadThread(leadId);
}

async function loadThread(leadId, quiet) {
  let r;
  try { r = await api(`/conversations/${leadId}`); } catch (e) { if (!quiet) toast(e.message); return; }
  if (CV.leadId !== leadId) return;
  const sameCount = CV.thread && CV.thread.lead.id === leadId && CV.thread.messages.length === r.messages.length && CV.thread.messages.every((m, i) => m.status === r.messages[i].status);
  CV.thread = r;
  // la conversation ouverte est lue : on retire le badge
  const it = CV.list.find((c) => c.id === leadId); if (it && it.unread) { it.unread = 0; renderList(); cvStatus(); }
  if (quiet && sameCount) return;
  renderThread(!quiet || !sameCount);
}

function renderThread(scroll) {
  const { lead: l, messages } = CV.thread;
  if (!CV.channel) {
    const last = messages[messages.length - 1];
    CV.channel = last ? last.channel : l.phone ? "sms" : "email";
  }
  const draft = CV.drafts[l.id] || {};
  const keepText = $("#cv-text") ? $("#cv-text").value : null;
  const keepSubj = $("#cv-subj") ? $("#cv-subj").value : null;
  const sameLead = $("#cv-main").dataset.lead === String(l.id);
  let day = "";
  $("#cv-main").dataset.lead = l.id;
  $("#cv-main").innerHTML = `
    <header class="cv-head">
      <button class="btn quiet cv-back" aria-label="Retour aux conversations">‹</button>
      <div class="grow"><h2>${esc(cvName(l))}</h2><div class="small muted">${esc([l.company && cvName(l) !== l.company ? l.company : "", l.phone ? fmtPhone(l.phone) : "", l.email].filter(Boolean).join(" · ")) || "Pas de coordonnées"}</div></div>
      ${l.phone ? `<button class="btn ghost" id="cv-call">${ICON_PHONE.replace("<svg", '<svg width="15" height="15"')}<span class="cv-lbl">Appeler</span></button>` : ""}
      <button class="btn ghost" id="cv-lead" aria-label="Fiche prospect">${ICON_NOTE.replace("<svg", '<svg width="15" height="15"')}<span class="cv-lbl">Fiche prospect</span></button>
    </header>
    <div class="cv-msgs" id="cv-msgs">${messages.length ? messages.map((m) => {
      const d = new Date(m.created_at).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
      const sep = d !== day ? `<div class="cv-day">${esc(d)}</div>` : ""; day = d;
      const fail = m.status === "failed" || m.status === "undelivered";
      return `${sep}<div class="cv-msg ${m.direction} ${m.channel}">
        <div class="cv-bub">${m.channel === "email" && m.subject ? `<div class="cv-subj">${esc(m.subject)}</div>` : ""}${esc(m.body).replace(/\n/g, "<br>")}</div>
        <div class="cv-meta"><span class="cv-ic sm">${CV_ICON[m.channel]}</span>${m.channel === "sms" ? "SMS" : "Email"} · <time title="${esc(cvFull(m.created_at))}">${new Date(m.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</time>${m.direction === "out" ? ` · ${fail ? `<span class="cv-fail">Non distribué${m.error ? " (" + esc(m.error) + ")" : ""}</span>` : m.status === "delivered" ? "Distribué" : m.status === "sent" ? "Envoyé" : m.status === "queued" || m.status === "accepted" || m.status === "sending" ? "En cours d'envoi" : esc(m.status || "")}` : ""}</div>
      </div>`;
    }).join("") : `<div class="cv-first">Aucun message avec ${esc(cvName(l))} pour l'instant. Écris le premier ci-dessous.</div>`}</div>
    <div class="cv-compose" id="cv-compose"></div>`;
  renderComposer();
  if (sameLead && keepText != null) { $("#cv-text").value = keepText; if ($("#cv-subj") && keepSubj != null) $("#cv-subj").value = keepSubj; updateCount(); }
  else if (draft.text) { $("#cv-text").value = draft.text; updateCount(); }
  const box = $("#cv-msgs"); if (scroll) box.scrollTop = box.scrollHeight;
  $(".cv-back").onclick = () => { $("#v-conversations").classList.remove("cv-open"); cvFit(); };
  cvFit();
  $("#cv-lead").onclick = () => openLead(l.id);
  const cb = $("#cv-call"); if (cb) cb.onclick = () => phoneCall(l);
}

function renderComposer() {
  if (!CV.thread) return;
  const l = CV.thread.lead, s = CV.status || { sms: {}, email: {} };
  const can = {
    sms: !l.phone ? "Ce prospect n'a pas de numéro" : !s.sms.ready ? (s.sms.reason || "SMS indisponible") : null,
    email: !l.email ? "Ce prospect n'a pas d'email : ajoute-le sur sa fiche" : !s.email.ready ? (s.email.reason || "Email indisponible") : null,
  };
  const ch = CV.channel;
  const last = CV.thread.messages.filter((m) => m.channel === "email").pop();
  const prevText = $("#cv-text") ? $("#cv-text").value : "";
  $("#cv-compose").innerHTML = `
    <div class="cv-c-top">
      <div class="seg cv-chans" role="tablist" aria-label="Canal d'envoi">
        <button role="tab" data-ch="sms" class="${ch === "sms" ? "on" : ""}" aria-selected="${ch === "sms"}" title="${esc(can.sms || "Envoyer par SMS")}">${CV_ICON.sms}SMS</button>
        <button role="tab" data-ch="email" class="${ch === "email" ? "on" : ""}" aria-selected="${ch === "email"}" title="${esc(can.email || "Envoyer par email")}">${CV_ICON.email}Email</button>
      </div>
      <span class="small muted cv-to">${ch === "sms" ? (l.phone ? "À " + esc(fmtPhone(l.phone)) : "") : l.email ? `À ${esc(l.email)}${s.email.from ? ` · depuis ${esc(s.email.from)}` : ""}` : ""}</span>
      <select id="cv-tpl" aria-label="Insérer un modèle"><option value="">Modèles</option>${CV_TEMPLATES.map(([n], i) => `<option value="${i}">${esc(n)}</option>`).join("")}</select>
    </div>
    ${can[ch] ? `<div class="cv-warn">${esc(can[ch])}</div>` : ""}
    ${ch === "email" ? `<input id="cv-subj" placeholder="Objet" aria-label="Objet" value="${esc(last && last.subject ? (/^re\s*:/i.test(last.subject) ? last.subject : "Re: " + last.subject) : "")}">` : ""}
    <div class="cv-c-row">
      <textarea id="cv-text" rows="3" placeholder="${ch === "sms" ? "Ton SMS…" : "Ton email…"}" aria-label="Message"></textarea>
      <button class="btn primary" id="cv-send" ${can[ch] ? "disabled" : ""}>Envoyer</button>
    </div>
    <div class="cv-c-foot"><span id="cv-count" class="small muted"></span><span class="small muted">Ctrl + Entrée pour envoyer</span></div>`;
  $("#cv-text").value = prevText;
  $$(".cv-chans button").forEach((b) => (b.onclick = () => { CV.channel = b.dataset.ch; renderComposer(); $("#cv-text").focus(); }));
  $("#cv-text").oninput = () => { CV.drafts[l.id] = { text: $("#cv-text").value }; updateCount(); };
  $("#cv-text").onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } };
  $("#cv-tpl").onchange = (e) => {
    const t = CV_TEMPLATES[Number(e.target.value)]; e.target.value = ""; if (!t) return;
    const prenom = l.first_name || (l.name || "").split(" ")[0] || "";
    const me = (window.__me && window.__me.prenom) || (typeof settings !== "undefined" && settings && settings.prenom) || "Yanis";
    let txt = t[1].replace(/\{prénom\}/g, prenom).replace(/\{ton prénom\}/g, me).replace(/Bonjour ,/g, "Bonjour,").replace(/Bonjour  /g, "Bonjour ");
    if (CV.channel === "sms") txt = txt.replace(/\n\n/g, "\n");
    $("#cv-text").value = txt; CV.drafts[l.id] = { text: txt }; updateCount(); $("#cv-text").focus();
    if (CV.channel === "email" && $("#cv-subj") && !$("#cv-subj").value) $("#cv-subj").value = t[0] === "Suite à notre appel" ? "Suite à notre appel" : t[0];
  };
  $("#cv-send").onclick = send;
  updateCount();
}

function updateCount() {
  const t = $("#cv-text"); if (!t) return;
  const v = t.value;
  if (CV.channel === "sms") {
    const p = smsParts(v);
    $("#cv-count").textContent = v ? `${p.len} caractère${p.len > 1 ? "s" : ""} · ${p.parts} SMS${!p.gsm ? " (accents ou emojis spéciaux : 70 caractères par SMS)" : ""}` : "";
  } else $("#cv-count").textContent = "";
}

async function send() {
  const b = $("#cv-send"); if (!b || b.disabled) return;
  const l = CV.thread.lead;
  const text = $("#cv-text").value.trim();
  if (!text) { toast("Écris un message"); return; }
  b.disabled = true; b.innerHTML = `<span class="spin"></span>Envoi`;
  try {
    await api(`/conversations/${l.id}/send`, { method: "POST", body: JSON.stringify({ channel: CV.channel, body: text, subject: $("#cv-subj") ? $("#cv-subj").value : "" }) });
    $("#cv-text").value = ""; delete CV.drafts[l.id];
    toast(CV.channel === "sms" ? "SMS envoyé" : "Email envoyé");
    await loadThread(l.id);
    loadConversations(true);
  } catch (e) { toast(e.message); }
  if ($("#cv-send")) { $("#cv-send").disabled = false; $("#cv-send").textContent = "Envoyer"; }
}

/* ---------- Nouveau message ---------- */
$("#cv-new").onclick = async () => {
  const leads = (CRM.leads && CRM.leads.length ? CRM.leads : (await api("/pipeline").catch(() => ({ leads: [] }))).leads) || [];
  if (!CRM.leads.length) CRM.leads = leads;
  const label = (l) => `${cvName(l)}${l.company && cvName(l) !== l.company ? " — " + l.company : ""} #${l.id}`;
  bModal({
    title: "Nouveau message", sub: "Choisis le prospect à qui écrire.", go: "Ouvrir la conversation", width: 460,
    body: `<div class="field" style="margin-bottom:0"><label for="cv-pick">Prospect</label><input id="cv-pick" list="cv-picks" placeholder="Nom, entreprise ou numéro…"><datalist id="cv-picks">${leads.map((l) => `<option value="${esc(label(l))}"></option>`).join("")}</datalist></div>`,
    onGo: async () => {
      const m = $("#cv-pick").value.match(/#(\d+)\s*$/);
      if (!m) { toast("Choisis un prospect dans la liste"); return false; }
      openConversation(Number(m[1]));
    },
  });
};

$("#cv-q").oninput = (e) => { CV.q = e.target.value.trim(); clearTimeout(CV._qt); CV._qt = setTimeout(() => loadConversations(true), 250); };
$("#cv-filter").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  CV.filter = b.dataset.f; $$("#cv-filter button").forEach((x) => x.classList.toggle("on", x === b)); loadConversations(true);
};

// badge des messages non lus dans le menu
setTimeout(cvStatus, 1200);
setInterval(() => { if (document.visibilityState === "visible" && !$("#v-conversations").classList.contains("on")) cvStatus(); }, 60000);
