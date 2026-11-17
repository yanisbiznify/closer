/* CLOSER — dialer, prospects, objections */
const OUT = {
  rdv: { label: "Rendez-vous", color: "var(--good)", key: "1" },
  rappel: { label: "À rappeler", color: "var(--mid)", key: "2" },
  pas_interesse: { label: "Pas intéressé", color: "var(--bad)", key: "3" },
  messagerie: { label: "Messagerie", color: "var(--faint)", key: "4" },
  barrage: { label: "Barrage", color: "var(--faint)", key: "5" },
  injoignable: { label: "Pas de réponse", color: "var(--faint)", key: "6" },
  mauvais_numero: { label: "Mauvais numéro", color: "var(--faint)", key: "7" },
};
const LEAD_STATUS = { a_appeler: ["À appeler", ""], rappel: ["Rappel", "mid"], rdv: ["RDV", "good"], pas_interesse: ["Pas intéressé", "bad"], messagerie: ["Messagerie", ""], barrage: ["Barrage", ""], injoignable: ["Pas de réponse", ""], mauvais_numero: ["Mauvais numéro", "bad"] };
const leadBadge = (st) => { const x = LEAD_STATUS[st] || [st, ""]; return `<span class="badge ${x[1]}">${x[0]}</span>`; };
const fmtPhone = (p) => (p || "").replace(/^\+33(\d)(\d{2})(\d{2})(\d{2})(\d{2})$/, "0$1 $2 $3 $4 $5");
const firstName = (n) => (n || "").split(" ")[0];
const dt = (iso) => { try { return new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };

const D = { cfg: null, device: null, call: null, callSid: null, queue: [], cur: null, phase: "idle", t0: 0, timer: null, list: "", tab: "script", lists: [], objections: [], auto: false, autoTimer: null, muted: false, pad: false, loaded: false };

function onView(v) {
  if (v === "dialer") initDialer();
  if (v === "leads") loadLeadsView();
  if (v === "objections") loadObjections();
}

/* ---------- Dialer ---------- */
async function initDialer() {
  if (!D.loaded) {
    D.loaded = true;
    try { D.cfg = await api("/dialer/config"); } catch (e) { D.cfg = { enabled: false, missing: [], error: e.message }; }
    try { D.auto = localStorage.getItem("closer-auto") === "1"; } catch {}
    renderSetup();
  }
  await loadLists();
  await Promise.all([loadQueue(), loadStats(), loadObjectionsData()]);
}

function renderSetup() {
  const c = D.cfg || {};
  $("#dl-state").textContent = c.enabled ? `Prêt, numéro ${fmtPhone(c.callerId)}` : "Non configuré";
  if (c.enabled) { $("#dl-setup").innerHTML = ""; return; }
  $("#dl-setup").innerHTML = `<div class="callout ${c.error ? "err" : ""}"><div class="grow">
    <b>${c.error ? "Le dialer n'a pas pu se connecter à Twilio" : "Connecte Twilio pour passer tes appels depuis CLOSER"}</b>
    <p>${c.error ? esc(c.error) : "Tu peux déjà préparer tes listes et ta file d'appels. Pour appeler :"}</p>
    ${c.error ? "" : `<ol class="setup-steps">
      <li>Crée un compte sur twilio.com et achète un numéro français, ou vérifie ton numéro actuel comme identifiant d'appel.</li>
      <li>Dans Railway, ajoute <code>TWILIO_ACCOUNT_SID</code>, <code>TWILIO_AUTH_TOKEN</code> et <code>TWILIO_CALLER_ID</code> (ton numéro au format +33…).</li>
      <li>C'est tout : CLOSER configure le reste au démarrage.</li></ol>`}
  </div></div>`;
}

async function loadLists() {
  try { D.lists = (await api("/lists")).lists; } catch { D.lists = []; }
  const opts = `<option value="">Toutes les listes</option>` + D.lists.map((l) => `<option value="${l.id}">${esc(l.name)} (${l.total})</option>`).join("");
  for (const id of ["#dl-list", "#lead-list"]) { const el = $(id); const v = el.value; el.innerHTML = opts; el.value = v; }
}
$("#dl-list").onchange = (e) => { D.list = e.target.value; loadQueue(); };

async function loadQueue() {
  try { D.queue = (await api("/dialer/queue" + (D.list ? "?list=" + D.list : ""))).leads; } catch (e) { D.queue = []; }
  if (D.cur && D.phase === "idle" && !D.queue.find((l) => l.id === D.cur.id)) D.cur = null;
  if (!D.cur && D.queue.length) D.cur = D.queue[0];
  renderQueue(); renderCall(); renderAide();
}

function renderQueue() {
  $("#dl-qcount").textContent = D.queue.length ? `${D.queue.length} prospect${D.queue.length > 1 ? "s" : ""}` : "";
  if (!D.queue.length) {
    $("#dl-queue").innerHTML = `<div class="table-empty" style="padding:40px 18px"><b>File vide</b>Importe des prospects ou change de liste.<div style="margin-top:14px"><button class="btn ghost" data-go="leads">Importer des prospects</button></div></div>`;
    return;
  }
  $("#dl-queue").innerHTML = D.queue.map((l) => {
    const due = l.status === "rappel";
    return `<div class="qi ${D.cur && D.cur.id === l.id ? "on" : ""}" data-lead="${l.id}"><div class="t"><b>${esc(l.company || l.name || fmtPhone(l.phone))}</b>
      <span class="s">${esc([l.company ? l.name : "", l.city].filter(Boolean).join(", ") || fmtPhone(l.phone))}</span></div>
      ${due ? `<span class="badge mid">Rappel${l.callback_at ? " " + esc(fmtTime(l.callback_at)) : ""}</span>` : l.attempts ? `<span class="badge">${l.attempts}ᵉ essai</span>` : ""}</div>`;
  }).join("");
}
$("#dl-queue").addEventListener("click", (e) => {
  const q = e.target.closest("[data-lead]"); if (!q || D.phase !== "idle") return;
  D.cur = D.queue.find((l) => String(l.id) === q.dataset.lead); renderQueue(); renderCall(); renderAide();
});

async function loadStats() {
  let s; try { s = await api("/dialer/stats"); } catch { return; }
  const pct = (a, b) => Math.min(100, Math.round((100 * a) / Math.max(1, b)));
  $("#nav-rappels").textContent = s.rappels || "";
  $("#dl-goals").innerHTML = `
    <div class="goal"><div class="l"><span>Appels aujourd'hui</span><span>${pct(s.appels, s.objectifAppels)} %</span></div><div class="v">${s.appels}<small> / ${s.objectifAppels}</small></div><div class="bar"><i style="width:${pct(s.appels, s.objectifAppels)}%"></i></div></div>
    <div class="goal"><div class="l"><span>Conversations</span></div><div class="v">${s.conversations}</div><div class="small muted" style="margin-top:6px">${s.appels ? Math.round((100 * s.conversations) / s.appels) + " % de décroché" : "Appels de plus de 30 s"}</div></div>
    <div class="goal"><div class="l"><span>Rendez-vous</span><span>${pct(s.rdv, s.objectifRdv)} %</span></div><div class="v">${s.rdv}<small> / ${s.objectifRdv}</small></div><div class="bar"><i style="width:${pct(s.rdv, s.objectifRdv)}%;background:var(--good)"></i></div></div>
    <div class="goal"><div class="l"><span>Rappels du jour</span></div><div class="v">${s.rappels}</div><div class="small muted" style="margin-top:6px">${s.rappels ? "En tête de file" : "Aucun rappel prévu"}</div></div>`;
}

const ICON_CALL = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>`;
const ICON_END = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 0 1-1.41-.02L.29 13.08a1 1 0 0 1 0-1.41C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67a1 1 0 0 1 0 1.41l-2.48 2.48a1 1 0 0 1-1.41.02 11.3 11.3 0 0 0-2.66-1.85 1 1 0 0 1-.56-.9v-3.1A15 15 0 0 0 12 9z"/></svg>`;

function renderCall() {
  const el = $("#dl-call");
  const l = D.cur;
  if (!l) {
    el.innerHTML = `<div class="table-empty" style="margin:auto"><img src="/brand/mark.svg" alt=""><b>Aucun prospect sélectionné</b>Choisis une liste ou importe des prospects pour commencer ta session.</div>`;
    return;
  }
  const top = `<div class="call-top"><div class="co">${esc(l.company || l.name || fmtPhone(l.phone))}</div>
    ${l.company && l.name ? `<div class="pe">${esc(l.name)}</div>` : ""}
    <div class="meta"><span><b>${esc(fmtPhone(l.phone))}</b></span>${l.city ? `<span>${esc(l.city)}</span>` : ""}${l.email ? `<span>${esc(l.email)}</span>` : ""}
    <span>${leadBadge(l.status)}</span>${l.attempts ? `<span>${l.attempts} tentative${l.attempts > 1 ? "s" : ""}</span>` : ""}${l.list_name ? `<span>${esc(l.list_name)}</span>` : ""}</div></div>`;
  let mid = "";
  if (D.phase === "idle") {
    mid = `<div class="call-state">${D.cfg && D.cfg.enabled ? "Prêt à appeler" : "Dialer non configuré"}</div>
      <button class="call-btn go" id="dl-go" aria-label="Appeler" ${D.cfg && D.cfg.enabled ? "" : "disabled style='opacity:.4'"}>${ICON_CALL}</button>
      <div class="call-ctrls"><button class="btn quiet" id="dl-skip">Passer ce prospect</button></div>
      <label class="auto"><span class="switch"><input type="checkbox" id="dl-auto" ${D.auto ? "checked" : ""}><span></span></span>Appeler le suivant automatiquement</label>
      ${D.autoTimer ? `<div class="small muted">Appel automatique dans quelques secondes… <button class="btn quiet" id="dl-stopauto" style="padding:2px 6px">Annuler</button></div>` : ""}`;
  } else if (D.phase === "connecting" || D.phase === "incall") {
    mid = `<div class="call-state">${D.phase === "incall" ? `<span class="live"></span>En ligne` : `<span class="spin"></span>Appel en cours…`}</div>
      <div class="call-timer" id="dl-timer">${D.phase === "incall" ? fmtClock() : "00:00"}</div>
      <div class="call-ctrls"><button class="btn ghost ${D.muted ? "on" : ""}" id="dl-mute">${D.muted ? "Micro coupé" : "Couper le micro"}</button><button class="btn ghost ${D.pad ? "on" : ""}" id="dl-pad">Clavier</button></div>
      ${D.pad ? `<div class="keypad">${"123456789*0#".split("").map((k) => `<button data-k="${k}">${k}</button>`).join("")}</div>` : ""}
      <button class="call-btn end" id="dl-end" aria-label="Raccrocher">${ICON_END}</button>`;
  } else if (D.phase === "wrap") {
    const tomorrow = new Date(Date.now() + 864e5); tomorrow.setHours(10, 0, 0, 0);
    const local = new Date(tomorrow - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    mid = `<div class="call-state">Appel terminé${D.t0 ? `, ${fmtClock()}` : ""}. Comment ça s'est passé ?</div>
      <div class="outcomes">${Object.entries(OUT).map(([k, o]) => `<button data-out="${k}" class="${k === "rdv" ? "rdv" : ""}"><span class="dot" style="background:${o.color}"></span>${o.label}<span class="k">${o.key}</span></button>`).join("")}</div>
      <div id="dl-cb" style="display:none;width:100%;max-width:440px"><label class="small muted" for="dl-cbat">Rappeler le</label><div style="display:flex;gap:8px;margin-top:6px"><input type="datetime-local" id="dl-cbat" value="${local}"><button class="btn primary" id="dl-cbok">Valider</button></div></div>`;
  }
  el.innerHTML = `<div class="call-panel">${top}<div class="call-mid">${mid}</div>
    <div class="call-notes"><label class="small muted" for="dl-notes">Notes sur ce prospect</label><textarea id="dl-notes" placeholder="Ce qu'il t'a dit, son besoin, le bon moment pour rappeler…" style="margin-top:6px">${esc(l.notes || "")}</textarea></div></div>`;
  bindCall();
}

function bindCall() {
  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  on("#dl-go", startCall);
  on("#dl-end", () => D.call && D.call.disconnect());
  on("#dl-skip", () => nextLead(true));
  on("#dl-stopauto", () => { clearTimeout(D.autoTimer); D.autoTimer = null; renderCall(); });
  on("#dl-mute", () => { if (!D.call) return; D.muted = !D.muted; D.call.mute(D.muted); renderCall(); });
  on("#dl-pad", () => { D.pad = !D.pad; renderCall(); });
  on("#dl-cbok", () => saveOutcome("rappel", $("#dl-cbat").value));
  const a = $("#dl-auto"); if (a) a.onchange = (e) => { D.auto = e.target.checked; try { localStorage.setItem("closer-auto", D.auto ? "1" : "0"); } catch {} };
  const kp = $(".keypad"); if (kp) kp.onclick = (e) => { const b = e.target.closest("[data-k]"); if (b && D.call) D.call.sendDigits(b.dataset.k); };
  const oc = $(".outcomes"); if (oc) oc.onclick = (e) => { const b = e.target.closest("[data-out]"); if (b) pickOutcome(b.dataset.out); };
  const n = $("#dl-notes"); if (n) n.onblur = () => saveNotes();
}

function pickOutcome(k) {
  if (k === "rappel") { $("#dl-cb").style.display = ""; $("#dl-cbat").focus(); return; }
  saveOutcome(k);
}

document.addEventListener("keydown", (e) => {
  if (!$("#v-dialer").classList.contains("on") || D.phase !== "wrap") return;
  if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  const k = Object.entries(OUT).find(([, o]) => o.key === e.key);
  if (k) { e.preventDefault(); pickOutcome(k[0]); }
});

async function saveNotes() {
  if (!D.cur) return;
  const v = $("#dl-notes").value;
  if (v === (D.cur.notes || "")) return;
  D.cur.notes = v;
  try { await api(`/leads/${D.cur.id}`, { method: "PATCH", body: JSON.stringify({ notes: v }) }); } catch {}
}

function fmtClock() {
  const s = Math.max(0, Math.round((Date.now() - D.t0) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

async function ensureDevice() {
  if (D.device) return D.device;
  if (!window.Twilio || !Twilio.Device) throw new Error("Le module d'appel ne s'est pas chargé. Recharge la page.");
  const { token } = await api("/dialer/token");
  const dev = new Twilio.Device(token, { codecPreferences: ["opus", "pcmu"], closeProtection: "Un appel est en cours. Quitter la page va le couper." });
  dev.on("tokenWillExpire", async () => { try { dev.updateToken((await api("/dialer/token")).token); } catch {} });
  dev.on("error", (e) => toast(e.message || "Erreur du dialer"));
  D.device = dev;
  return dev;
}

async function startCall() {
  if (!D.cur || D.phase !== "idle") return;
  clearTimeout(D.autoTimer); D.autoTimer = null;
  D.phase = "connecting"; D.muted = false; D.pad = false; D.t0 = 0; D.callSid = null;
  renderCall();
  try {
    const dev = await ensureDevice();
    const call = await dev.connect({ params: { To: D.cur.phone, LeadId: String(D.cur.id) } });
    D.call = call;
    call.on("accept", (c) => {
      D.callSid = (c.parameters && c.parameters.CallSid) || D.callSid;
      D.phase = "incall"; D.t0 = Date.now(); renderCall();
      clearInterval(D.timer); D.timer = setInterval(() => { const t = $("#dl-timer"); if (t) t.textContent = fmtClock(); }, 500);
    });
    call.on("disconnect", endCall);
    call.on("cancel", endCall);
    call.on("reject", endCall);
    call.on("error", (e) => { toast(e.message || "Erreur pendant l'appel"); });
  } catch (e) {
    toast(e.message || "Impossible de lancer l'appel");
    D.phase = "idle"; renderCall();
  }
}

function endCall() {
  if (D.phase === "wrap") return;
  clearInterval(D.timer);
  if (D.call && D.call.parameters && D.call.parameters.CallSid) D.callSid = D.call.parameters.CallSid;
  D.call = null; D.phase = "wrap"; renderCall();
}

async function saveOutcome(k, cbLocal) {
  if (!D.cur) return;
  const notes = $("#dl-notes") ? $("#dl-notes").value : undefined;
  const body = { outcome: k, notes, callSid: D.callSid };
  if (k === "rappel" && cbLocal) body.callbackAt = new Date(cbLocal).toISOString();
  try {
    const r = await api(`/leads/${D.cur.id}/outcome`, { method: "POST", body: JSON.stringify(body) });
    toast(r.ghl && r.ghl.ok === false ? `${OUT[k].label}. Note GHL non enregistrée : vérifie les droits du jeton.` : `${OUT[k].label}${r.ghl && r.ghl.ok ? ", noté dans GHL" : ""}`);
  } catch (e) { toast(e.message); return; }
  D.phase = "idle"; D.t0 = 0;
  nextLead(false);
  loadStats(); refresh();
}

async function nextLead(skip) {
  const idx = D.queue.findIndex((l) => D.cur && l.id === D.cur.id);
  if (skip) { const [l] = D.queue.splice(idx, 1); if (l) D.queue.push(l); }
  else if (idx >= 0) D.queue.splice(idx, 1);
  D.cur = D.queue[skip ? Math.max(0, idx) % Math.max(1, D.queue.length) : 0] || null;
  renderQueue(); renderCall(); renderAide();
  if (!skip && D.auto && D.cur && D.cfg && D.cfg.enabled) {
    D.autoTimer = setTimeout(() => { D.autoTimer = null; startCall(); }, 3000);
    renderCall();
  }
}

/* Aide : script, objections, historique */
$("#dl-tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; D.tab = b.dataset.t; $$("#dl-tabs button").forEach((x) => x.classList.toggle("on", x === b)); renderAide(); });

function renderScript() {
  const sc = (settings && settings.script) || (D.cfg && D.cfg.script) || "";
  if (!sc.trim()) return `<div class="table-empty" style="padding:30px 0"><b>Pas encore de script</b>Écris-le dans les réglages.</div>`;
  const me = (settings && settings.prenom) || "";
  const fn = D.cur ? firstName(D.cur.name) : "";
  return `<div class="script">${sc.split("\n").map((line) => {
    const t = line.trim();
    const head = t.split("(")[0].trim();
    if (head && head === head.toUpperCase() && /[A-ZÀ-Ý]{3}/.test(head)) return `<h4>${esc(head)}${t.length > head.length ? ` <span style="color:var(--faint);font-weight:500">${esc(t.slice(head.length).trim())}</span>` : ""}</h4>`;
    return esc(line).replace(/\{ton pr[ée]nom\}/gi, `<span class="hl">${esc(me || "ton prénom")}</span>`).replace(/\{pr[ée]nom\}/gi, `<span class="hl">${esc(fn || "Monsieur/Madame")}</span>`);
  }).join("\n").replace(/<\/h4>\n/g, "</h4>")}</div>`;
}

async function renderAide() {
  const el = $("#dl-aide");
  if (D.tab === "script") { el.innerHTML = renderScript(); return; }
  if (D.tab === "obj") { el.innerHTML = objectionList(D.objections.slice(0, 40), true); return; }
  if (!D.cur) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="skeleton" style="width:70%"></div>`;
  let calls = [];
  try { calls = (await api(`/leads/${D.cur.id}/calls`)).calls; } catch {}
  el.innerHTML = calls.length
    ? `<div class="small muted" style="margin-bottom:8px">Appels avec ce prospect</div>${calls.map((c) => `<div class="hist" data-open="${esc(c.id)}" style="cursor:pointer"><span>${esc(dt(c.date))}${c.outcome && OUT[c.outcome] ? ", " + OUT[c.outcome].label.toLowerCase() : ""}</span>${c.status === "done" ? `<span class="score c-${tone(c.score)}">${c.score}</span>` : `<span class="muted small">${c.duration ? fmtDur(c.duration) : "—"}</span>`}</div>`).join("")}`
    : `<div class="table-empty" style="padding:30px 0"><b>Premier appel</b>Aucun échange avec ce prospect pour l'instant.</div>`;
}
$("#dl-aide").addEventListener("click", (e) => { const h = e.target.closest("[data-open]"); if (h) openDrawer(h.dataset.open); });

/* ---------- Objections ---------- */
function groupObjections(list) {
  const key = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, "").split(" ").filter((w) => w.length > 3).slice(0, 4).join(" ");
  const g = new Map();
  for (const o of list) {
    if (!o.objection) continue;
    const k = key(o.objection) || o.objection;
    if (!g.has(k)) g.set(k, { ...o, n: 0 });
    g.get(k).n++;
  }
  return [...g.values()].sort((a, b) => b.n - a.n);
}
function objectionList(list, compact) {
  const g = groupObjections(list);
  if (!g.length) return `<div class="table-empty" style="padding:30px 0"><b>Pas encore d'objections</b>Elles apparaîtront ici au fil de tes appels analysés.</div>`;
  return g.map((o) => `<div class="objc"><b>« ${esc(o.objection)} »</b><p>${esc(o.boucle)}</p>${o.n > 1 ? `<div class="n">Entendue ${o.n} fois</div>` : ""}</div>`).join("");
}
async function loadObjectionsData() {
  try { D.objections = (await api("/objections")).objections; } catch { D.objections = []; }
}
async function loadObjections() {
  await loadObjectionsData();
  renderObjections();
}
function renderObjections() {
  const q = ($("#obj-q").value || "").toLowerCase();
  const g = groupObjections(D.objections).filter((o) => !q || (o.objection + " " + o.boucle).toLowerCase().includes(q));
  $("#objections").innerHTML = g.length
    ? `<div class="objgrid">${g.map((o) => `<div class="panel"><p class="q1">« ${esc(o.objection)} »</p><div class="cnt">${o.n > 1 ? `Entendue ${o.n} fois` : "Entendue 1 fois"}, dernière le ${esc(fmtDate(o.date))}</div>
        <div class="loop">${esc(o.boucle)}</div>${o.reponse ? `<div class="was">Ce que tu avais répondu : ${esc(o.reponse)}</div>` : ""}</div>`).join("")}</div>`
    : `<div class="panel">${emptyState(q ? "Aucune objection trouvée" : "Ta bibliothèque est vide", q ? "Essaie un autre mot." : "Chaque objection entendue dans un appel analysé s'ajoute ici, avec la boucle pour la retourner.")}</div>`;
}
$("#obj-q").addEventListener("input", renderObjections);

/* ---------- Prospects ---------- */
let LV = { leads: [], filtre: "tous", q: "" };
async function loadLeadsView() {
  await loadLists();
  renderLists();
  try { LV.leads = (await api("/leads" + ($("#lead-list").value ? "?list=" + $("#lead-list").value : ""))).leads; } catch { LV.leads = []; }
  renderLeads();
}
function renderLists() {
  $("#lists").innerHTML = D.lists.length
    ? `<table class="table"><thead><tr><th>Liste</th><th class="hide-m">Source</th><th>Prospects</th><th class="hide-m">À appeler</th><th class="hide-m">RDV</th><th class="r"></th></tr></thead><tbody>
      ${D.lists.map((l) => `<tr data-list="${l.id}"><td class="who"><b>${esc(l.name)}</b><span>Créée le ${esc(fmtDate(l.created_at))}</span></td>
        <td class="hide-m">${l.source === "ghl" ? `<span class="badge">GHL${l.source_ref ? " : " + esc(l.source_ref) : ""}</span>` : `<span class="badge">CSV</span>`}</td>
        <td class="num">${l.total}</td><td class="hide-m num">${l.a_appeler}</td><td class="hide-m num c-good">${l.rdv || ""}</td>
        <td class="r nowrap"><button class="btn ghost" data-dial="${l.id}" style="padding:5px 10px">Appeler</button> <button class="btn quiet" data-del="${l.id}" style="padding:5px 8px">Supprimer</button></td></tr>`).join("")}</tbody></table>`
    : emptyState("Aucune liste pour l'instant", "Importe tes contacts GoHighLevel par tag, ou un fichier CSV.");
}
$("#lists").addEventListener("click", async (e) => {
  const d = e.target.closest("[data-dial]");
  if (d) { e.stopPropagation(); D.list = d.dataset.dial; $("#dl-list").value = D.list; D.cur = null; show("dialer"); return; }
  const x = e.target.closest("[data-del]");
  if (x) {
    e.stopPropagation();
    if (!(await confirmBox("Supprimer cette liste et tous ses prospects ? Les appels déjà analysés sont conservés.", "Supprimer"))) return;
    await api(`/lists/${x.dataset.del}`, { method: "DELETE" }); toast("Liste supprimée"); loadLeadsView(); return;
  }
  const r = e.target.closest("tr[data-list]");
  if (r) { $("#lead-list").value = r.dataset.list; loadLeadsView(); }
});
$("#lead-list").onchange = loadLeadsView;
$("#lead-q").addEventListener("input", (e) => { LV.q = e.target.value.trim().toLowerCase(); renderLeads(); });
$("#lead-filters").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; LV.filtre = b.dataset.f; $$("#lead-filters button").forEach((x) => x.classList.toggle("on", x === b)); renderLeads(); });

function renderLeads() {
  const list = LV.leads.filter((l) => (LV.filtre === "tous" || l.status === LV.filtre) && (!LV.q || [l.name, l.company, l.phone, l.city].filter(Boolean).join(" ").toLowerCase().includes(LV.q)));
  $("#leads").innerHTML = list.length
    ? `<table class="table"><thead><tr><th>Prospect</th><th class="hide-m">Téléphone</th><th class="hide-m">Ville</th><th>Statut</th><th class="hide-m">Tentatives</th><th class="r"></th></tr></thead><tbody>
      ${list.slice(0, 500).map((l) => `<tr data-lead="${l.id}"><td class="who"><b>${esc(l.company || l.name || "Sans nom")}</b><span>${esc(l.company ? l.name || "" : "")}${l.list_name ? (l.company && l.name ? ", " : "") + esc(l.list_name) : ""}</span></td>
        <td class="hide-m nowrap">${esc(fmtPhone(l.phone))}</td><td class="hide-m">${esc(l.city || "")}</td>
        <td>${leadBadge(l.status)}${l.status === "rappel" && l.callback_at ? `<div class="small muted">${esc(dt(l.callback_at))}</div>` : ""}</td>
        <td class="hide-m num muted">${l.attempts || ""}</td>
        <td class="r"><button class="btn ghost" data-call="${l.id}" style="padding:5px 10px">Appeler</button></td></tr>`).join("")}</tbody></table>
      ${list.length > 500 ? `<div class="small muted" style="padding:12px 20px">500 premiers affichés sur ${list.length}. Utilise la recherche pour affiner.</div>` : ""}`
    : emptyState(LV.leads.length ? "Aucun prospect ne correspond" : "Aucun prospect", LV.leads.length ? "Change de filtre ou de recherche." : "Importe une liste pour commencer.");
}
$("#leads").addEventListener("click", (e) => {
  const c = e.target.closest("[data-call]"); if (!c) return;
  e.stopPropagation();
  const l = LV.leads.find((x) => String(x.id) === c.dataset.call);
  if (!l) return;
  if (D.phase !== "idle") { toast("Termine l'appel en cours d'abord"); return; }
  D.cur = l; if (!D.queue.find((x) => x.id === l.id)) D.queue.unshift(l);
  show("dialer"); renderQueue(); renderCall(); renderAide();
});

/* Import */
function openImport(title, sub, body, onGo) {
  $("#imp-title").textContent = title; $("#imp-sub").textContent = sub; $("#imp-body").innerHTML = body;
  $("#imp").classList.add("on");
  $("#imp-no").onclick = () => $("#imp").classList.remove("on");
  $("#imp-go").disabled = false; $("#imp-go").textContent = "Importer";
  $("#imp-go").onclick = async () => {
    $("#imp-go").disabled = true; $("#imp-go").innerHTML = `<span class="spin"></span>Import…`;
    try { const r = await onGo(); if (r !== false) $("#imp").classList.remove("on"); } catch (e) { toast(e.message); }
    $("#imp-go").disabled = false; $("#imp-go").textContent = "Importer";
  };
}
const importDone = (r) => {
  toast(`${r.added} prospect${r.added > 1 ? "s" : ""} importé${r.added > 1 ? "s" : ""}${r.invalid ? `, ${r.invalid} sans numéro valide` : ""}${r.dup ? `, ${r.dup} en double` : ""}`);
  $("#lead-list").value = r.listId; loadLeadsView(); D.loaded && loadQueue();
};

$("#btn-imp-ghl").onclick = async () => {
  openImport("Importer depuis GoHighLevel", "Tous les contacts qui portent ce tag deviennent une liste d'appels.",
    `<div class="field"><label for="imp-tag">Tag GHL</label><select id="imp-tag"><option>Chargement…</option></select></div>
     <div class="field"><label for="imp-name">Nom de la liste</label><input id="imp-name" placeholder="Chauffagistes Tours"></div>`,
    async () => {
      const tag = $("#imp-tag").value; if (!tag) { toast("Choisis un tag"); return false; }
      importDone(await api("/leads/import-ghl", { method: "POST", body: JSON.stringify({ tag, listName: $("#imp-name").value.trim() || tag }) }));
    });
  try {
    const { tags } = await api("/ghl/tags");
    $("#imp-tag").innerHTML = `<option value="">Choisis un tag</option>` + tags.map((t) => `<option>${esc(t)}</option>`).join("");
  } catch (e) { $("#imp-tag").innerHTML = `<option value="">${esc(e.message)}</option>`; }
};

function parseCSV(text) {
  const first = text.split(/\r?\n/)[0] || "";
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : (first.includes("\t") ? "\t" : ",");
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
function mapCSV(rows) {
  const h = rows[0].map((x) => x.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim());
  const find = (...keys) => h.findIndex((x) => keys.some((k) => x.includes(k)));
  const idx = {
    phone: find("telephone", "phone", "tel", "mobile", "portable", "numero"),
    company: find("entreprise", "societe", "company", "raison", "etablissement", "business"),
    first: find("prenom", "first"), last: find("nom de famille", "last"),
    name: find("contact", "nom", "name", "dirigeant"),
    email: find("email", "mail"), city: find("ville", "city", "commune"), notes: find("note", "commentaire"),
  };
  if (idx.name === idx.company) idx.name = -1;
  const get = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : "");
  return { idx, leads: rows.slice(1).map((r) => ({
    phone: get(r, idx.phone), company: get(r, idx.company),
    name: [get(r, idx.first), get(r, idx.last)].filter(Boolean).join(" ") || get(r, idx.name),
    email: get(r, idx.email), city: get(r, idx.city), notes: get(r, idx.notes),
  })) };
}
$("#btn-imp-csv").onclick = () => {
  let parsed = null;
  openImport("Importer un fichier CSV", "Colonnes reconnues automatiquement : téléphone, entreprise, nom, prénom, email, ville, notes.",
    `<div class="field"><label for="imp-file">Fichier</label><input type="file" id="imp-file" accept=".csv,text/csv,.txt"></div>
     <div class="field"><label for="imp-cname">Nom de la liste</label><input id="imp-cname" placeholder="Couvreurs Lyon"></div><div id="imp-prev" class="small muted"></div>`,
    async () => {
      if (!parsed || !parsed.leads.length) { toast("Choisis un fichier CSV"); return false; }
      importDone(await api("/leads/import", { method: "POST", body: JSON.stringify({ listName: $("#imp-cname").value.trim() || "Import CSV", leads: parsed.leads }) }));
    });
  $("#imp-file").onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const rows = parseCSV(await f.text());
    if (rows.length < 2) { $("#imp-prev").textContent = "Fichier vide ou illisible."; parsed = null; return; }
    parsed = mapCSV(rows);
    if (!$("#imp-cname").value) $("#imp-cname").value = f.name.replace(/\.[^.]+$/, "");
    $("#imp-prev").innerHTML = parsed.idx.phone < 0
      ? `<span class="c-bad">Aucune colonne téléphone trouvée. Renomme-la « Téléphone ».</span>`
      : `${parsed.leads.length} lignes détectées. Exemple : <b style="color:var(--text)">${esc(parsed.leads[0].company || parsed.leads[0].name || "")}</b>, ${esc(parsed.leads[0].phone)}`;
    if (parsed.idx.phone < 0) parsed = null;
  };
};

// Compteur de rappels dans la navigation
setTimeout(() => api("/dialer/stats").then((s) => { $("#nav-rappels").textContent = s.rappels || ""; }).catch(() => {}), 800);
