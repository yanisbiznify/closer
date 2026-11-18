/* CLOSER PRO — Agenda (Google Agenda + Google Meet) */
const CAL = { status: null, start: null, events: [], upcoming: [], loading: false };
const H0 = 7, H1 = 21, PX = 1.3; // de 7 h à 21 h, 1 px par minute
const DAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const ICON_MEET = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 10l7-4v12l-7-4"/></svg>`;
const isMobile = () => window.matchMedia("(max-width:860px)").matches;
const pad2 = (n) => String(n).padStart(2, "0");
const hm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const parisTime = (d) => d.toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
const sameTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone === "Europe/Paris"; } catch { return false; } };
function mondayOf(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); const k = (x.getDay() + 6) % 7; x.setDate(x.getDate() - k); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
const span = () => (isMobile() ? 1 : 7);

async function loadCalendar() {
  if (typeof loadBookingCalendars === "function") loadBookingCalendars();
  if (!CAL.start) CAL.start = isMobile() ? (() => { const x = new Date(); x.setHours(0, 0, 0, 0); return x; })() : mondayOf(new Date());
  try { CAL.status = await api("/google/status"); } catch (e) { CAL.status = { configured: false, connected: false, missing: [] }; }
  renderCalHead();
  if (!CAL.status.connected) { renderCalSetup(); return; }
  $("#cal-setup").innerHTML = "";
  $("#cal-main").style.display = "";
  await Promise.all([loadWeek(), loadUpcoming()]);
}

function renderCalSetup() {
  $("#cal-main").style.display = "none";
  const s = CAL.status;
  if (!s.configured) {
    $("#cal-setup").innerHTML = `<div class="panel"><div class="panel-b">
      <h2 style="font-size:18px;margin-bottom:6px">Relie ton Google Agenda</h2>
      <p class="muted" style="margin:0 0 16px">Une seule fois : crée l'accès dans Google Cloud, colle deux clés dans Railway, puis connecte ton compte ici.</p>
      <ol class="setup-steps" style="line-height:1.7">
        <li>Sur <a href="https://console.cloud.google.com" target="_blank" rel="noopener">console.cloud.google.com</a>, crée un projet « CLOSER PRO », puis active <b>Google Calendar API</b>.</li>
        <li><b>OAuth consent screen</b> : type « External », ajoute ton adresse Gmail, puis passe le statut de publication sur <b>In production</b> (sinon la connexion expire au bout de 7 jours).</li>
        <li><b>Credentials → Create credentials → OAuth client ID</b> → « Web application ». Dans <b>Authorized redirect URIs</b>, colle :<br><code style="user-select:all">${esc(s.redirectUri || location.origin + "/api/google/callback")}</code></li>
        <li>Dans Railway, ajoute <code>GOOGLE_CLIENT_ID</code> et <code>GOOGLE_CLIENT_SECRET</code>, puis reviens sur cette page.</li>
      </ol></div></div>`;
    return;
  }
  $("#cal-setup").innerHTML = `<div class="panel cal-connect"><div class="panel-b">
    <div class="cal-g">${ICON_MEET}</div>
    <h2>Connecte ton Google Agenda</h2>
    <p class="muted">CLOSER PRO affichera tes rendez-vous et créera un lien Google Meet pour chaque nouveau rendez-vous, avec l'invitation envoyée au prospect.</p>
    <a class="btn primary lg" href="/api/google/auth">Connecter Google Agenda</a></div></div>`;
}

function renderCalHead() {
  const s = CAL.status || {};
  const end = addDays(CAL.start, span() - 1);
  const label = span() === 1
    ? CAL.start.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })
    : `${CAL.start.toLocaleDateString("fr-FR", { day: "numeric", month: CAL.start.getMonth() === end.getMonth() ? undefined : "short" })} – ${end.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}`;
  $("#cal-label").textContent = label;
  $("#cal-account").innerHTML = s.connected ? `Connecté à <b>${esc(s.email || "Google Agenda")}</b> · <button class="btn quiet" id="cal-disc" style="padding:0 4px;font-size:12.5px">Déconnecter</button>` : "";
  const d = $("#cal-disc"); if (d) d.onclick = async () => {
    if (!(await confirmBox("Déconnecter Google Agenda ? Tes rendez-vous restent dans Google.", "Déconnecter"))) return;
    await api("/google/disconnect", { method: "POST" }); loadCalendar();
  };
  $$(".cal-nav").forEach((b) => (b.disabled = !s.connected));
}
$("#cal-prev").onclick = () => { CAL.start = addDays(CAL.start, -span()); renderCalHead(); loadWeek(); };
$("#cal-next").onclick = () => { CAL.start = addDays(CAL.start, span()); renderCalHead(); loadWeek(); };
$("#cal-today").onclick = () => { CAL.start = isMobile() ? (() => { const x = new Date(); x.setHours(0, 0, 0, 0); return x; })() : mondayOf(new Date()); renderCalHead(); loadWeek(); };
$("#cal-new").onclick = () => openBooking({});

async function loadWeek() {
  if (!CAL.status || !CAL.status.connected) return;
  const from = CAL.start, to = addDays(CAL.start, span());
  $("#cal-grid").classList.add("loading");
  try { CAL.events = (await api(`/calendar/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)).events; }
  catch (e) { CAL.events = []; toast(e.message); if (/connect/i.test(e.message)) { CAL.status.connected = false; renderCalSetup(); } }
  $("#cal-grid").classList.remove("loading");
  renderWeek();
}
async function loadUpcoming() {
  const now = new Date();
  try { CAL.upcoming = (await api(`/calendar/events?from=${encodeURIComponent(now.toISOString())}&to=${encodeURIComponent(addDays(now, 30).toISOString())}`)).events.filter((e) => !e.allDay).slice(0, 8); }
  catch { CAL.upcoming = []; }
  renderUpcoming();
}

function renderWeek() {
  const n = span();
  const days = Array.from({ length: n }, (_, i) => addDays(CAL.start, i));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const hours = Array.from({ length: H1 - H0 }, (_, i) => H0 + i);
  const height = (H1 - H0) * 60 * PX;
  const allDay = days.map((d) => CAL.events.filter((e) => e.allDay && new Date(e.start) <= d && addDays(new Date(e.end), 0) > d));
  const hasAllDay = allDay.some((x) => x.length);
  $("#cal-grid").style.setProperty("--cols", n);
  $("#cal-grid").innerHTML = `
    <div class="cal-h"><div></div>${days.map((d) => `<div class="cal-dh ${+d === +today ? "today" : ""}"><span>${DAYS[(d.getDay() + 6) % 7]}</span><b>${d.getDate()}</b></div>`).join("")}</div>
    ${hasAllDay ? `<div class="cal-ad"><div class="small muted" style="text-align:right;padding-right:8px">Journée</div>${allDay.map((list) => `<div>${list.map((e) => `<div class="cal-adev" data-ev="${esc(e.id)}">${esc(e.title)}</div>`).join("")}</div>`).join("")}</div>` : ""}
    <div class="cal-body" id="cal-body"><div class="cal-times">${hours.map((h) => `<div style="height:${60 * PX}px">${pad2(h)}:00</div>`).join("")}</div>
      ${days.map((d, di) => `<div class="cal-col ${+d === +today ? "today" : ""}" data-day="${di}" style="height:${height}px">${hours.map(() => `<div class="cal-slot" style="height:${60 * PX}px"></div>`).join("")}${dayEvents(d)}${+d === +today ? nowLine() : ""}</div>`).join("")}
    </div>`;
  const body = $("#cal-body");
  const scrollTo = (8 - H0) * 60 * PX - 10;
  body.scrollTop = scrollTo;
}

function nowLine() {
  const n = new Date(); const m = (n.getHours() - H0) * 60 + n.getMinutes();
  if (m < 0 || m > (H1 - H0) * 60) return "";
  return `<div class="cal-now" style="top:${m * PX}px"></div>`;
}

function dayEvents(day) {
  const d0 = new Date(day), d1 = addDays(day, 1);
  const evs = CAL.events.filter((e) => !e.allDay && new Date(e.start) < d1 && new Date(e.end) > d0)
    .map((e) => ({ e, s: new Date(Math.max(new Date(e.start), d0)), en: new Date(Math.min(new Date(e.end), d1)) }))
    .sort((a, b) => a.s - b.s || b.en - a.en);
  // répartition en colonnes quand des rendez-vous se chevauchent
  const lanes = []; const groups = []; let g = [];
  let gEnd = 0;
  for (const it of evs) {
    if (g.length && it.s >= gEnd) { groups.push(g); g = []; lanes.length = 0; }
    let lane = lanes.findIndex((end) => end <= it.s);
    if (lane < 0) { lane = lanes.length; lanes.push(it.en); } else lanes[lane] = it.en;
    it.lane = lane; g.push(it); gEnd = Math.max(gEnd, +it.en);
  }
  if (g.length) groups.push(g);
  groups.forEach((gr) => { const n = Math.max(...gr.map((x) => x.lane)) + 1; gr.forEach((x) => (x.n = n)); });
  return evs.map(({ e, s, en, lane, n }) => {
    const top = Math.max(0, ((s.getHours() - H0) * 60 + s.getMinutes()) * PX);
    const h = Math.max(26, ((en - s) / 60000) * PX - 2);
    const short = (en - s) / 60000 < 45;
    if (top > (H1 - H0) * 60 * PX) return "";
    return `<div class="cal-ev ${e.closer ? "closer" : ""} ${short ? "short" : ""}" data-ev="${esc(e.id)}" title="${esc(e.title)}, ${hm(s)} – ${hm(en)}" style="top:${top}px;height:${h}px;left:calc(${(100 / n) * lane}% + 3px);width:calc(${100 / n}% - 6px)">
      ${short ? `<b><span>${hm(s)}</span> ${esc(e.title)}</b>` : `<b>${esc(e.title)}</b><span>${hm(s)} – ${hm(en)}${e.meet ? ", Meet" : ""}</span>`}</div>`;
  }).join("");
}

$("#cal-grid").addEventListener("click", (e) => {
  const ev = e.target.closest("[data-ev]");
  if (ev) { const x = CAL.events.find((y) => y.id === ev.dataset.ev); if (x) openEvent(x); return; }
  const col = e.target.closest(".cal-col"); if (!col) return;
  const r = col.getBoundingClientRect();
  const mins = Math.floor((e.clientY - r.top) / PX / 30) * 30;
  const d = addDays(CAL.start, Number(col.dataset.day)); d.setHours(H0, 0, 0, 0); d.setMinutes(mins);
  openBooking({ start: d });
});

function renderUpcoming() {
  const el = $("#cal-up");
  if (!CAL.upcoming.length) { el.innerHTML = `<p class="muted small" style="margin:0">Aucun rendez-vous dans les 30 prochains jours.</p>`; return; }
  el.innerHTML = CAL.upcoming.map((e) => {
    const s = new Date(e.start);
    return `<div class="up" data-up="${esc(e.id)}"><div class="up-d"><b>${s.getDate()}</b><span>${s.toLocaleDateString("fr-FR", { month: "short" })}</span></div>
      <div class="up-t"><b>${esc(e.title)}</b><span>${s.toLocaleDateString("fr-FR", { weekday: "long" })} à ${hm(s)}${sameTz() ? "" : `, ${parisTime(s)} à Paris`}</span></div>
      ${e.meet ? `<a class="ic call" href="${esc(e.meet)}" target="_blank" rel="noopener" title="Rejoindre Google Meet">${ICON_MEET}</a>` : ""}</div>`;
  }).join("");
}
$("#cal-up").addEventListener("click", (e) => {
  if (e.target.closest("a")) return;
  const u = e.target.closest("[data-up]"); if (!u) return;
  const x = CAL.upcoming.find((y) => y.id === u.dataset.up); if (x) openEvent(x);
});

/* ---------- Détail d'un rendez-vous ---------- */
function openEvent(e) {
  const s = new Date(e.start), en = new Date(e.end);
  openImport(e.title, e.allDay ? s.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }) :
    `${s.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}, ${hm(s)} – ${hm(en)}${sameTz() ? "" : ` (${parisTime(s)} à Paris)`}`,
    `<div class="ev-d">
      ${e.meet ? `<a class="btn primary" href="${esc(e.meet)}" target="_blank" rel="noopener">${ICON_MEET.replace("<svg", '<svg width="16" height="16"')}Rejoindre Google Meet</a><div class="small muted" style="margin-top:8px;user-select:all">${esc(e.meet)}</div>` : ""}
      ${e.attendees.length ? `<div class="field" style="margin-top:16px"><label>Invités</label>${e.attendees.map((a) => `<div class="small">${esc(a.email)} <span class="muted">${{ accepted: "a accepté", declined: "a refusé", tentative: "peut-être", needsAction: "en attente" }[a.status] || ""}</span></div>`).join("")}</div>` : ""}
      ${e.lead ? `<div class="field" style="margin-top:16px"><label>Prospect</label><button class="btn ghost" id="ev-lead">${esc(e.lead.company || e.lead.name || "Ouvrir la fiche")}</button></div>` : ""}
      ${e.description ? `<div class="field" style="margin-top:16px"><label>Notes</label><div class="small" style="white-space:pre-wrap;color:var(--text-2)">${esc(e.description)}</div></div>` : ""}
      <div id="ev-status"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:18px"><a class="btn ghost" href="${esc(e.link || "https://calendar.google.com")}" target="_blank" rel="noopener">Ouvrir dans Google Agenda</a><button class="btn danger" id="ev-del">Annuler le rendez-vous</button></div>
    </div>`, async () => true);
  $("#imp-go").style.display = "none"; $("#imp-no").textContent = "Fermer";
  const l = $("#ev-lead"); if (l) l.onclick = () => { $("#imp").classList.remove("on"); openLead(e.leadId); };
  api(`/calendar/appointments?events=${encodeURIComponent(e.id)}`).then(({ appointments }) => {
    const a = appointments[0]; if (!a || !$("#ev-status")) return;
    const lab = { planifie: "Prévu", present: "Présent", absent: "Absent", annule: "Annulé" };
    const draw = (st) => {
      $("#ev-status").innerHTML = `<div class="field" style="margin-top:16px"><label>Le prospect est-il venu ?</label>
        ${a.calendar_name ? `<div class="small muted" style="margin-bottom:8px">Calendrier « ${esc(a.calendar_name)} »${a.source === "booking" ? ", réservé en ligne" : ""}</div>` : ""}
        <div class="seg ev-st">${["present", "absent"].map((k) => `<button data-st="${k}" class="${st === k ? "on" : ""}">${lab[k]}</button>`).join("")}</div>
        <div class="small muted" style="margin-top:6px">Le marquer lance les automatisations liées (suite de l'onboarding, relance des absents…).</div></div>`;
      $$("#ev-status [data-st]").forEach((b) => (b.onclick = async () => {
        const next = st === b.dataset.st ? "planifie" : b.dataset.st;
        try { await api(`/calendar/events/${encodeURIComponent(e.id)}/status`, { method: "POST", body: JSON.stringify({ status: next }) }); toast(next === "planifie" ? "Statut retiré" : `Marqué ${lab[next].toLowerCase()}`); draw(next); }
        catch (err) { toast(err.message); }
      }));
    };
    draw(a.status);
  }).catch(() => {});
  $("#ev-del").onclick = async () => {
    $("#imp").classList.remove("on");
    if (!(await confirmBox(`Annuler « ${e.title} » ? ${e.attendees.length ? "Les invités seront prévenus par email." : ""}`, "Annuler le rendez-vous"))) return;
    try { await api(`/calendar/events/${encodeURIComponent(e.id)}`, { method: "DELETE" }); toast("Rendez-vous annulé"); loadWeek(); loadUpcoming(); } catch (err) { toast(err.message); }
  };
}

/* ---------- Prise de rendez-vous ---------- */
async function openBooking({ lead = null, start = null } = {}) {
  if (!CAL.status) { try { CAL.status = await api("/google/status"); } catch {} }
  if (!CAL.status || !CAL.status.connected) {
    toast("Connecte d'abord Google Agenda dans l'onglet Agenda"); show("calendar"); return;
  }
  if (!start) { start = new Date(Date.now() + 864e5); start.setHours(10, 0, 0, 0); }
  const leads = (CRM.leads && CRM.leads.length ? CRM.leads : (await api("/pipeline").catch(() => ({ leads: [] }))).leads) || [];
  if (!CRM.leads.length) CRM.leads = leads;
  const opts = leads.map((l) => `<option value="${esc((l.company || l.name || "") + (l.company && l.name ? " — " + l.name : "") + " #" + l.id)}"></option>`).join("");
  const dateV = `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`;
  const label = (l) => (l ? `${l.company || l.name || ""}${l.company && l.name ? " — " + l.name : ""} #${l.id}` : "");
  openImport("Nouveau rendez-vous", "Le lien Google Meet est créé automatiquement et l'invitation part au prospect.",
    `<div class="field"><label for="bk-lead">Prospect</label><input id="bk-lead" list="bk-leads" placeholder="Rechercher un prospect…" value="${esc(label(lead))}"><datalist id="bk-leads">${opts}</datalist></div>
     <div class="field"><label for="bk-cal">Calendrier</label><select id="bk-cal"><option value="">Aucun (RDV libre)</option>${(window.BC && BC.list || []).map((c) => `<option value="${c.id}" data-dur="${c.duration_min}">${esc(c.name)}</option>`).join("")}</select></div>
     <div class="field"><label for="bk-title">Titre</label><input id="bk-title"></div>
     <div class="bk-row">
       <div class="field"><label for="bk-date">Date</label><input type="date" id="bk-date" value="${dateV}"></div>
       <div class="field"><label for="bk-time">Heure</label><input type="time" id="bk-time" step="900" value="${hm(start)}"></div>
       <div class="field"><label for="bk-dur">Durée</label><select id="bk-dur"><option value="15">15 min</option><option value="30" selected>30 min</option><option value="45">45 min</option><option value="60">1 h</option></select></div>
     </div>
     <div class="small muted" id="bk-paris" style="margin:-6px 0 14px"></div>
     <div class="field"><label for="bk-email">Email du prospect</label><input id="bk-email" type="email" placeholder="prospect@entreprise.fr"></div>
     <div class="field"><label for="bk-desc">Notes pour le rendez-vous</label><textarea id="bk-desc" style="min-height:70px"></textarea></div>
     <label class="bk-chk"><input type="checkbox" id="bk-meet" checked> Créer un lien Google Meet</label>
     <label class="bk-chk"><input type="checkbox" id="bk-notify" checked> Envoyer l'invitation par email au prospect</label>`,
    async () => {
      const l = pickLead();
      const [y, mo, d] = $("#bk-date").value.split("-").map(Number);
      const [h, mi] = ($("#bk-time").value || "10:00").split(":").map(Number);
      const s = new Date(y, mo - 1, d, h, mi);
      const e = new Date(s.getTime() + Number($("#bk-dur").value) * 60000);
      if (isNaN(s)) { toast("Date invalide"); return false; }
      const body = { leadId: l ? l.id : null, title: $("#bk-title").value.trim(), start: s.toISOString(), end: e.toISOString(),
        email: $("#bk-email").value.trim() || null, description: $("#bk-desc").value.trim(), meet: $("#bk-meet").checked, notify: $("#bk-notify").checked, calendarId: $("#bk-cal").value || null };
      const r = await api("/calendar/events", { method: "POST", body: JSON.stringify(body) });
      toast(r.event.meet ? "Rendez-vous créé avec son lien Meet" : "Rendez-vous créé");
      if (l) { l.stage = "rdv"; l.status = "rdv"; document.dispatchEvent(new CustomEvent("lead-updated", { detail: { id: l.id, stage: "rdv", status: "rdv" } })); }
      if ($("#v-calendar").classList.contains("on")) { loadWeek(); loadUpcoming(); }
      if (r.event.meet && navigator.clipboard) navigator.clipboard.writeText(r.event.meet).catch(() => {});
    });
  $("#imp-go").textContent = "Planifier le rendez-vous";
  function pickLead() {
    const v = $("#bk-lead").value; const m = v.match(/#(\d+)\s*$/);
    return m ? leads.find((x) => x.id === Number(m[1])) || null : null;
  }
  function fill() {
    const l = pickLead();
    const t = $("#bk-title");
    if (!t.dataset.edited) t.value = l ? `Démo — ${l.company || l.name}` : "Rendez-vous";
    if (l && l.email && !$("#bk-email").value) $("#bk-email").value = l.email;
  }
  function paris() {
    const [y, mo, d] = $("#bk-date").value.split("-").map(Number); const [h, mi] = ($("#bk-time").value || "0:0").split(":").map(Number);
    const s = new Date(y, mo - 1, d, h, mi);
    $("#bk-paris").textContent = isNaN(s) || sameTz() ? "" : `Soit ${parisTime(s)} heure de Paris pour ton prospect.`;
  }
  $("#bk-lead").addEventListener("change", fill); $("#bk-lead").addEventListener("input", fill);
  $("#bk-cal").onchange = (ev) => {
    const o = ev.target.selectedOptions[0]; const dur = o && o.dataset.dur;
    if (dur) { if (![...$("#bk-dur").options].some((x) => x.value === dur)) $("#bk-dur").insertAdjacentHTML("beforeend", `<option value="${dur}">${dur} min</option>`); $("#bk-dur").value = dur; }
    const t = $("#bk-title"); if (!t.dataset.edited && o && o.value) { const l = pickLead(); t.value = `${o.textContent}${l ? " — " + (l.company || l.name) : ""}`; }
  };
  $("#bk-title").addEventListener("input", (e) => (e.target.dataset.edited = "1"));
  $("#bk-date").addEventListener("change", paris); $("#bk-time").addEventListener("input", paris);
  fill(); paris();
}

// Ouvre l'agenda au retour de la connexion Google
if (location.hash === "#calendar-refus") { setTimeout(() => { toast("Connexion Google annulée"); show("calendar"); }, 300); }
