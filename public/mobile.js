/* Biznify sur téléphone : barre d'onglets, écran « Aujourd'hui », notifications, installation, petits plaisirs */
(() => {
const MOB = { data: null, deferredInstall: null, mq: window.matchMedia("(max-width: 860px)") };
const isMobile = () => MOB.mq.matches;
const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const buzz = (ms = 8) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) {} };
const I = (d, s = 22) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  pipe: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  euro: '<path d="M4 10h12M4 14h9"/><path d="M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2"/>',
  bill: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  video: '<path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
};

/* ---------- Barre d'onglets ---------- */
function buildTabbar() {
  if ($("#tabbar")) return;
  const bar = document.createElement("nav");
  bar.id = "tabbar"; bar.className = "tabbar"; bar.setAttribute("aria-label", "Navigation");
  bar.innerHTML = `
    <button data-tab="dashboard">${I(ICONS.home)}<span>Accueil</span></button>
    <button data-tab="pipeline">${I(ICONS.pipe)}<span>Pipeline</span></button>
    <button data-tab="dialer" class="tb-call" aria-label="Appeler"><span class="tb-fab">${I(ICONS.phone, 26)}</span></button>
    <button data-tab="conversations">${I(ICONS.chat)}<span>Messages</span><i class="tb-dot" id="tb-unread" hidden></i></button>
    <button data-tab="__more">${I(ICONS.grid)}<span>Plus</span></button>`;
  document.body.appendChild(bar);
  bar.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    buzz();
    if (b.dataset.tab === "__more") return openMore();
    show(b.dataset.tab);
  });
  syncTabs();
}
function syncTabs() {
  const on = (($("section.view.on") || {}).id || "").replace("v-", "");
  $$("#tabbar [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === on || (b.dataset.tab === "__more" && !["dashboard", "pipeline", "dialer", "conversations"].includes(on))));
}

function openMore() {
  const items = [...$$("#nav button")].filter((b) => !["dashboard", "pipeline", "dialer", "conversations"].includes(b.dataset.v));
  const sheet = document.createElement("div");
  sheet.className = "sheet-wrap";
  sheet.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="Toutes les rubriques"><div class="sheet-grip"></div>
    <div class="more-grid">${items.map((b) => `<button data-v="${b.dataset.v}">${b.querySelector("svg").outerHTML}<span>${esc(b.textContent.trim().replace(/\d+$/, ""))}</span></button>`).join("")}</div>
    <div class="more-foot">${pushSupported() ? `<button class="btn ghost" id="mo-push">${I(ICONS.bell, 18)}Notifications</button>` : ""}${!standalone() ? `<button class="btn ghost" id="mo-install">${I(ICONS.download, 18)}Installer l'app</button>` : ""}<button class="btn quiet" id="mo-out">Se déconnecter</button></div></div>`;
  document.body.appendChild(sheet);
  requestAnimationFrame(() => sheet.classList.add("on"));
  const close = () => { sheet.classList.remove("on"); setTimeout(() => sheet.remove(), 220); };
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) return close();
    const v = e.target.closest("[data-v]"); if (v) { buzz(); close(); show(v.dataset.v); }
  });
  const p = $("#mo-push"); if (p) p.onclick = () => { close(); enablePush(); };
  const i = $("#mo-install"); if (i) i.onclick = () => { close(); installApp(); };
  $("#mo-out").onclick = () => $("#btn-logout").click();
}

/* ---------- Écran « Aujourd'hui » ---------- */
const ring = (pct, size = 116, stroke = 11) => {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, pct));
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--raised)" stroke-width="${stroke}"/>
    <circle class="ring-p" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--or)" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - p)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>`;
};
const hi = () => { const h = Number(new Date().toLocaleString("fr-FR", { hour: "numeric", hour12: false })); return h < 5 ? "Bonne nuit" : h < 18 ? "Bonjour" : "Bonsoir"; };

async function loadToday() {
  const box = $("#mhome"); if (!box || !isMobile()) return;
  let d;
  try { d = MOB.data = await api("/today"); } catch (e) { box.innerHTML = ""; return; }
  const cp = d.calls.goal ? d.calls.done / d.calls.goal : 0;
  const hasMoney = !!d.money;
  if (!hasMoney) d.money = { goal: 0, month: 0, today: 0, last: null };
  const mp = d.money.goal ? d.money.month / d.money.goal : 0;
  const missions = [
    { done: d.calls.done >= d.calls.goal, label: `${d.calls.goal} appels`, val: `${Math.min(d.calls.done, d.calls.goal)}/${d.calls.goal}` },
    { done: d.rdv.today >= d.rdv.goal, label: `${d.rdv.goal} RDV posés`, val: `${Math.min(d.rdv.today, d.rdv.goal)}/${d.rdv.goal}` },
    { done: d.money.today > 0, label: "Un encaissement", val: d.money.today ? eur0(d.money.today) : "0 €" },
  ].slice(0, hasMoney ? 3 : 2);
  const doneN = missions.filter((m) => m.done).length;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hour = (iso) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const dayLbl = (iso) => { const x = new Date(iso), n = new Date(); const t = new Date(n.getFullYear(), n.getMonth(), n.getDate()); const dd = Math.round((new Date(x.getFullYear(), x.getMonth(), x.getDate()) - t) / 864e5); return dd === 0 ? "Aujourd'hui" : dd === 1 ? "Demain" : x.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" }); };
  box.innerHTML = `
    <div class="mh-top">
      <div><p class="mh-date">${esc((() => { const t = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" }); return t.charAt(0).toUpperCase() + t.slice(1); })())}</p><h1>${hi()} ${esc(d.name)} 👋</h1></div>
      <div class="mh-streak ${d.streak ? "" : "off"}" title="Jours d'affilée avec des appels">${I(ICONS.flame, 18)}<b>${d.streak}</b></div>
    </div>
    ${installCard()}
    <section class="mh-card mh-hero" aria-label="Appels du jour">
      <div class="mh-ring">${ring(cp)}<div class="mh-ring-t"><b>${d.calls.done}</b><span>/ ${d.calls.goal}</span></div></div>
      <div class="mh-hero-t">
        <p class="mh-k">Appels aujourd'hui</p>
        <p class="mh-msg">${d.calls.done >= d.calls.goal ? "Objectif atteint, champion 🏆" : d.calls.done === 0 ? (d.streak ? `Garde ta série de ${d.streak} jour${d.streak > 1 ? "s" : ""} en vie 🔥` : "C'est parti pour la première série 💪") : `Plus que ${d.calls.goal - d.calls.done} pour l'objectif`}</p>
        <button class="btn primary mh-go" data-go-tab="dialer">${I(ICONS.phone, 18)}Lancer les appels</button>
        <p class="mh-sub">${d.toCall} prospect${d.toCall > 1 ? "s" : ""} à appeler · <button class="link" id="mh-goal">Modifier l'objectif</button></p>
      </div>
    </section>
    <section class="mh-card" aria-label="Missions du jour">
      <div class="mh-h"><h2>Missions du jour</h2><span class="mh-pill ${doneN === 3 ? "ok" : ""}">${doneN}/3</span></div>
      <ul class="mh-miss">${missions.map((m) => `<li class="${m.done ? "done" : ""}"><span class="mh-tick">${m.done ? I(ICONS.check, 14) : ""}</span><span>${esc(m.label)}</span><b>${esc(m.val)}</b></li>`).join("")}</ul>
    </section>
    ${hasMoney ? "" : "<!--"}<button class="mh-card mh-money" data-go-tab="revenue" aria-label="Chiffre d'affaires du mois">
      <div class="mh-h"><h2>Ce mois-ci</h2>${d.money.goal ? `<span class="mh-pill">${Math.round(mp * 100)} %</span>` : ""}</div>
      <p class="mh-big">${eur0(d.money.month)}${d.money.goal ? `<span> / ${eur0(d.money.goal)}</span>` : ""}</p>
      ${d.money.goal ? `<div class="mh-bar"><span style="width:${Math.min(100, mp * 100)}%"></span></div>` : ""}
      ${d.money.last ? `<p class="mh-sub">Dernier : ${esc(d.money.last.title)} · ${esc(eur0(d.money.last.amount_cents))}</p>` : ""}
    </button>${hasMoney ? "" : "-->"}
    <section class="mh-card" aria-label="Prochains rendez-vous">
      <div class="mh-h"><h2>Prochains RDV</h2><button class="link" data-go-tab="calendar">Agenda</button></div>
      ${d.appointments.length ? `<ul class="mh-list">${d.appointments.map((a) => `<li>
        <div class="mh-when"><b>${esc(hour(a.start_at))}</b><span>${esc(dayLbl(a.start_at))}</span></div>
        <div class="mh-what"><b>${esc([a.first_name, a.last_name].filter(Boolean).join(" ") || a.name || a.title)}</b><span>${esc(a.company || a.cal_name || "")}</span></div>
        ${a.meet_url ? `<a class="mh-icon" href="${esc(a.meet_url)}" target="_blank" rel="noopener" aria-label="Rejoindre la visio">${I(ICONS.video, 18)}</a>` : a.lead_id ? `<button class="mh-icon" data-lead="${a.lead_id}" aria-label="Ouvrir la fiche">${I(ICONS.phone, 18)}</button>` : ""}
      </li>`).join("")}</ul>` : `<p class="mh-empty">Aucun RDV prévu. Les appels du jour vont changer ça 😉</p>`}
    </section>
    ${d.tasks.length ? `<section class="mh-card" aria-label="À faire">
      <div class="mh-h"><h2>À faire</h2><span class="mh-pill">${d.tasks.length}</span></div>
      <ul class="mh-tasks">${d.tasks.map((t) => `<li><button class="mh-check" data-task="${t.id}" aria-label="Marquer comme fait"></button><div ${t.lead_id ? `data-lead="${t.lead_id}"` : ""}><b>${esc(t.title)}</b>${t.body ? `<span>${esc(t.body)}</span>` : ""}</div></li>`).join("")}</ul>
    </section>` : ""}
    <section class="mh-quick" aria-label="Actions rapides">
      <button data-go-tab="billing" data-act="invoice">${I(ICONS.bill)}<span>Facture</span></button>
      <button data-go-tab="billing" data-act="link">${I(ICONS.link)}<span>Lien de paiement</span></button>
      <button data-go-tab="prospect">${I(ICONS.pin)}<span>Trouver des leads</span></button>
      <button data-go-tab="conversations">${I(ICONS.chat)}<span>Messages${d.unread ? ` (${d.unread})` : ""}</span></button>
    </section>
    ${pushSupported() && Notification.permission !== "granted" ? `<button class="mh-card mh-notif" id="mh-push">${I(ICONS.bell)}<div><b>Active les notifications</b><span>Sois prévenu à chaque paiement, RDV et réponse.</span></div></button>` : ""}`;
  // interactions
  box.querySelectorAll("[data-go-tab]").forEach((b) => (b.onclick = (e) => {
    e.preventDefault(); buzz(); show(b.dataset.goTab);
    if (b.dataset.act === "invoice") setTimeout(() => { const n = $("#bl-new"); if (n) n.click(); }, 400);
    if (b.dataset.act === "link") setTimeout(() => { const n = $("#bl-quick"); if (n) n.click(); }, 400);
  }));
  box.querySelectorAll("[data-lead]").forEach((b) => (b.onclick = () => openLead(Number(b.dataset.lead))));
  box.querySelectorAll("[data-task]").forEach((b) => (b.onclick = async () => {
    buzz(15); b.classList.add("on"); b.innerHTML = I(ICONS.check, 14);
    try { await api(`/tasks/${b.dataset.task}/done-quick`, { method: "POST", body: "{}" }); confetti(40); setTimeout(loadToday, 700); } catch (e) { toast(e.message); }
  }));
  const g = $("#mh-goal"); if (g) g.onclick = async () => {
    const v = prompt("Ton objectif d'appels par jour", d.calls.goal);
    if (!v) return;
    await api("/today/goals", { method: "PUT", body: JSON.stringify({ callGoal: Number(v) }) }); loadToday();
  };
  const p = $("#mh-push"); if (p) p.onclick = enablePush;
  const ic = $("#mh-install"); if (ic) ic.onclick = installApp;
  const ix = $("#mh-install-x"); if (ix) ix.onclick = (e) => { e.stopPropagation(); try { localStorage.setItem("bz_install_x", "1"); } catch (_) {} $("#mh-installcard").remove(); };
  // petite fête quand l'objectif tombe
  const key = "bz_goal_" + new Date().toDateString();
  try { if (d.calls.done >= d.calls.goal && !localStorage.getItem(key)) { localStorage.setItem(key, "1"); confetti(120); buzz([20, 40, 20]); } } catch (_) {}
}

/* ---------- Installation ---------- */
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
function installCard() {
  if (standalone()) return "";
  try { if (localStorage.getItem("bz_install_x")) return ""; } catch (_) {}
  return `<div class="mh-card mh-install" id="mh-installcard"><img src="/brand/icon-192.png" alt="" width="44" height="44"><div><b>Installe Biznify sur ton téléphone</b><span>${isIOS() ? "Une icône sur ton écran d'accueil, en plein écran." : "En un clic, comme une vraie app."}</span></div><button class="btn primary" id="mh-install">Installer</button><button class="mh-x" id="mh-install-x" aria-label="Masquer">×</button></div>`;
}
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); MOB.deferredInstall = e; });
async function installApp() {
  if (MOB.deferredInstall) { MOB.deferredInstall.prompt(); const r = await MOB.deferredInstall.userChoice; MOB.deferredInstall = null; if (r.outcome === "accepted") toast("Biznify est installée 🎉"); return; }
  bModal({ title: "Installer Biznify", cancel: "Compris", width: 420, body: isIOS()
    ? `<ol class="inst"><li>Ouvre cette page dans <b>Safari</b>.</li><li>Touche le bouton <b>Partager</b> <span aria-hidden="true">⬆️</span> en bas de l'écran.</li><li>Choisis <b>« Sur l'écran d'accueil »</b>, puis <b>Ajouter</b>.</li></ol><p class="small muted">Ouvre ensuite Biznify depuis l'icône pour recevoir les notifications.</p>`
    : `<ol class="inst"><li>Ouvre le menu du navigateur <span aria-hidden="true">⋮</span>.</li><li>Choisis <b>« Installer l'application »</b> ou <b>« Ajouter à l'écran d'accueil »</b>.</li></ol>` });
}

/* ---------- Notifications push ---------- */
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
function b64ToUint8(b) { const p = "=".repeat((4 - (b.length % 4)) % 4); const raw = atob((b + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); }
async function enablePush() {
  if (!pushSupported()) { toast(isIOS() ? "Installe d'abord l'app sur ton écran d'accueil pour activer les notifications" : "Ce navigateur ne gère pas les notifications"); if (isIOS() && !standalone()) installApp(); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Notifications refusées : tu peux les réactiver dans les réglages du téléphone"); return; }
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api("/push/key");
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(key) });
    await api("/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub.toJSON() }) });
    await api("/push/test", { method: "POST", body: "{}" });
    toast("Notifications activées 🔔");
    loadToday();
  } catch (e) { toast("Impossible d'activer les notifications : " + e.message); }
}

/* ---------- Confettis ---------- */
function confetti(n = 80) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const c = document.createElement("canvas"); c.className = "confetti"; document.body.appendChild(c);
  const ctx = c.getContext("2d"), W = (c.width = innerWidth * devicePixelRatio), H = (c.height = innerHeight * devicePixelRatio);
  const cols = ["#1877F2", "#F5B301", "#12A150", "#FF6B6B", "#7A3FD1"];
  const ps = Array.from({ length: n }, () => ({ x: W / 2 + (Math.random() - 0.5) * W * 0.3, y: H * 0.35, vx: (Math.random() - 0.5) * 18 * devicePixelRatio, vy: (-Math.random() * 16 - 6) * devicePixelRatio, r: Math.random() * 6 + 4, c: cols[(Math.random() * cols.length) | 0], a: Math.random() * 6, s: Math.random() * 0.3 - 0.15 }));
  let t = 0;
  (function frame() {
    ctx.clearRect(0, 0, W, H);
    ps.forEach((p) => { p.vy += 0.55 * devicePixelRatio; p.x += p.vx; p.y += p.vy; p.vx *= 0.99; p.a += p.s; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c; ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); ctx.restore(); });
    if (++t < 140) requestAnimationFrame(frame); else c.remove();
  })();
}
window.confetti = confetti;

/* ---------- Démarrage ---------- */
function mobInit() {
  buildTabbar();
  const full = $("#mh-full");
  if (full) full.onclick = () => { const on = $("#v-dashboard").classList.toggle("full"); full.textContent = on ? "Revenir à l'écran Aujourd'hui" : "Voir le tableau de bord complet"; if (on && typeof loadBusiness === "function") loadBusiness(); window.scrollTo({ top: 0 }); };
  const _show = window.show;
  window.show = function (v) { _show(v); syncTabs(); if (v === "dashboard") loadToday(); };
  if ($("#v-dashboard").classList.contains("on")) loadToday();
  MOB.mq.addEventListener("change", () => { if (isMobile() && $("#v-dashboard").classList.contains("on")) loadToday(); });
  // pastille de messages non lus sur l'onglet
  const upd = async () => { try { const r = await api("/badges"); const n = r.unread || 0; const dot = $("#tb-unread"); if (dot) { dot.hidden = !n; dot.textContent = n > 9 ? "9+" : n || ""; } } catch (_) {} };
  upd(); setInterval(() => { if (document.visibilityState === "visible") upd(); }, 45000);
  // un paiement qui tombe = confettis
  const prevPoll = window.actPoll;
  if (typeof prevPoll === "function") {
    window.actPoll = async function () {
      const before = ACT.last;
      await prevPoll();
      if (before !== null && ACT.last !== before && isMobile() && $("#v-dashboard").classList.contains("on")) loadToday();
    };
  }
}
window.addEventListener("load", mobInit);

window.loadToday = loadToday;
})();
