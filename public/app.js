/* CLOSER — application v2 */
const ETAPES = [
  ["ouverture", "Ouverture", "Les 4 premières secondes"],
  ["tonalite", "Tonalité", ""],
  ["rapport", "Rapport", ""],
  ["qualification", "Qualification", ""],
  ["presentation", "Présentation", ""],
  ["boucles", "Boucles", "Gestion des objections"],
  ["closing", "Closing", ""],
  ["controle", "Contrôle", "Garder la ligne droite"],
];
const ISSUES = { rdv: ["RDV pris", "good"], rappel: ["À rappeler", "mid"], refus: ["Refus", "bad"], barrage: ["Barrage", "bad"], messagerie: ["Messagerie", ""], autre: ["Autre", ""] };
const ACTIVE = ["queued", "transcribing", "analyzing", "pending"];

let calls = [], counts = {}, workerState = {}, settings = null, filtre = "tous", query = "", pollTimer = null, currentId = null, currentCall = null, dTab = "analyse";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tone = (s) => (s == null ? "" : s >= 75 ? "good" : s >= 50 ? "mid" : "bad");
const col = (s) => (s == null ? "var(--faint)" : s >= 75 ? "var(--good)" : s >= 50 ? "var(--mid)" : "var(--bad)");
const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" }); } catch { return ""; } };
const fmtTime = (iso) => { try { return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
const fmtFull = (iso) => `${fmtDate(iso)} à ${fmtTime(iso)}`;
const fmtDur = (d) => (d == null ? "—" : d >= 60 ? `${Math.floor(d / 60)} min ${String(d % 60).padStart(2, "0")}` : `${d} s`);
const avg = (a) => { const v = a.filter((x) => typeof x === "number"); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };

function toast(t) { const el = $("#toast"); el.textContent = t; el.classList.add("on"); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("on"), 2600); }
function confirmBox(txt, yes = "Confirmer") {
  return new Promise((res) => {
    $("#modal-txt").textContent = txt; $("#modal-yes").textContent = yes; $("#modal").classList.add("on");
    const done = (v) => { $("#modal").classList.remove("on"); res(v); };
    $("#modal-yes").onclick = () => done(true); $("#modal-no").onclick = () => done(false);
  });
}
async function api(path, opts = {}) {
  const res = await fetch("/api" + path, { credentials: "same-origin", ...opts, headers: { ...(opts.body && !(opts.body instanceof Blob) ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) } });
  if (res.status === 401) { location.href = "/login"; throw new Error("Non connecté"); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `Erreur ${res.status}`);
  return j;
}

/* ---------- Navigation ---------- */
function show(view) {
  $$("#nav button").forEach((x) => x.classList.toggle("on", x.dataset.v === view));
  $$("section.view").forEach((s) => s.classList.toggle("on", s.id === "v-" + view));
  $("#side").classList.remove("on");
  if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
  window.scrollTo(0, 0);
  if (typeof onView === "function") onView(view);
}
$("#nav").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.v); });
document.addEventListener("click", (e) => { const g = e.target.closest("[data-go]"); if (g) show(g.dataset.go); });
$("#menu").onclick = () => $("#side").classList.toggle("on");
$("#filters").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  filtre = b.dataset.f; $$("#filters button").forEach((x) => x.classList.toggle("on", x === b)); renderCalls();
});
$("#q").addEventListener("input", (e) => { query = e.target.value.trim().toLowerCase(); renderCalls(); });

/* ---------- Données ---------- */
async function refresh() {
  try {
    const d = await api("/calls");
    calls = d.calls; counts = d.counts || {}; workerState = d.worker || {};
    renderAll();
  } catch { setStatus("Hors ligne", false); }
  schedule();
}
function schedule() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(refresh, calls.some((c) => ACTIVE.includes(c.status)) ? 4000 : 60000);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

function setStatus(txt, busy) {
  for (const id of ["#status", "#status-m"]) $(id).classList.toggle("busy", !!busy);
  $("#status-txt").textContent = txt;
}
function renderAll() {
  const n = calls.filter((c) => ACTIVE.includes(c.status)).length;
  setStatus(n ? `${n} appel${n > 1 ? "s" : ""} en analyse` : "Tout est à jour", n > 0);
  $("#nav-count").textContent = (counts.new || 0) ? counts.new : "";
  renderDashboard(); renderCalls(); renderSyncInfo();
}

/* ---------- Composants ---------- */
const nameOf = (c) => c.contact_name || c.label || (c.summary && c.summary.prospect) || c.phone || (c.source === "paste" ? "Transcription" : c.source === "upload" ? "Audio importé" : "Appel");
const sourceOf = (c) => c.source === "ghl" ? (c.direction === "inbound" ? "Entrant" : "Sortant") : c.source === "dialer" ? "Dialer" : c.source === "paste" ? "Transcription" : "Import audio";

function statusCell(c) {
  switch (c.status) {
    case "done": return `<span class="score c-${tone(c.score)}">${esc(c.score)}</span>`;
    case "queued": return `<span class="badge"><span class="spin"></span>En file</span>`;
    case "pending": return `<span class="badge"><span class="spin"></span>Enregistrement</span>`;
    case "transcribing": return `<span class="badge"><span class="spin"></span>Transcription</span>`;
    case "analyzing": return `<span class="badge"><span class="spin"></span>Analyse</span>`;
    case "short": return `<span class="badge">Trop court</span>`;
    case "error": return `<span class="badge bad">Échec</span>`;
    default: return `<button class="btn ghost" data-analyze="${esc(c.id)}" style="padding:5px 10px">Analyser</button>`;
  }
}
function issueBadge(issue) {
  const i = ISSUES[issue]; return i ? `<span class="badge ${i[1]}">${i[0]}</span>` : `<span class="muted">—</span>`;
}
function rowsTable(list) {
  if (!list.length) return "";
  return `<table class="table"><thead><tr><th>Prospect</th><th>Date</th><th class="hide-m">Durée</th><th class="hide-m">Issue</th><th class="r">Score</th></tr></thead><tbody>
  ${list.map((c) => `<tr data-id="${esc(c.id)}">
    <td class="who"><b>${esc(nameOf(c))}</b><span>${esc(sourceOf(c))}${c.phone && nameOf(c) !== c.phone ? ", " + esc(c.phone) : ""}<span class="show-m">, ${esc(fmtDate(c.date))}</span></span></td>
    <td class="nowrap hide-m"><span>${esc(fmtDate(c.date))}</span> <span class="muted">${esc(fmtTime(c.date))}</span></td>
    <td class="hide-m nowrap muted">${esc(fmtDur(c.duration))}</td>
    <td class="hide-m">${c.status === "done" ? issueBadge(c.issue) : ""}</td>
    <td class="r">${statusCell(c)}</td></tr>`).join("")}</tbody></table>`;
}
function emptyState(title, text) {
  return `<div class="table-empty"><img src="/brand/mark.svg" alt=""><b>${title}</b>${text}</div>`;
}

/* La ligne droite : 8 étapes posées sur une seule ligne */
function straightLine(notes, { showTag = true } = {}) {
  const scored = ETAPES.map(([k]) => notes[k]).filter((v) => typeof v === "number");
  const min = scored.length ? Math.min(...scored) : null;
  return `<div class="sline">${ETAPES.map(([k, n, hint]) => {
    const v = notes[k];
    const has = typeof v === "number";
    const weak = has && v === min && scored.length > 1;
    return `<div class="st ${weak ? "weak" : ""} ${has ? "" : "na"}" title="${esc(hint || n)}">
      <div class="sc" style="color:${has ? col(v * 10) : ""}">${has ? (Number.isInteger(v) ? v : v.toFixed(1)) : "–"}${has ? "<small>/10</small>" : ""}</div>
      <div class="pt" style="${has && !weak ? `border-color:${col(v * 10)}` : ""}"></div>
      <div class="nm">${n}</div>${weak && showTag ? `<div class="tag">À travailler</div>` : ""}</div>`;
  }).join("")}</div><div class="sline-foot"><span>Premier contact</span><span>Rendez-vous</span></div>`;
}
function ring(score) {
  const r = 42, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, Number(score) || 0));
  return `<svg class="ring" viewBox="0 0 96 96"><circle cx="48" cy="48" r="${r}" fill="none" stroke="var(--raised)" stroke-width="6"/>
  <circle cx="48" cy="48" r="${r}" fill="none" stroke="${col(v)}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${(c * v) / 100} ${c}" transform="rotate(-90 48 48)"/>
  <text x="48" y="55" text-anchor="middle" style="fill:var(--text);font:600 26px var(--title)">${v}</text></svg>`;
}

/* ---------- Tableau de bord ---------- */
function analysed() { return calls.filter((c) => c.status === "done" && typeof c.score === "number").slice().sort((a, b) => new Date(a.date) - new Date(b.date)); }

function renderDashboard() {
  const all = analysed();
  const last10 = all.slice(-10), prev10 = all.slice(-20, -10);
  const a1 = avg(last10.map((x) => x.score)), a0 = avg(prev10.map((x) => x.score));
  if (settings && settings.prenom) $("#hello").textContent = `Bonjour ${settings.prenom}`;

  $("#k-n").textContent = all.length;
  const week = all.filter((x) => Date.now() - new Date(x.date) < 7 * 864e5).length;
  $("#k-n-d").textContent = `${week} cette semaine`;
  $("#k-avg").innerHTML = a1 == null ? "–" : `<span class="c-${tone(a1)}">${Math.round(a1)}</span>`;
  $("#k-delta").innerHTML = a1 != null && a0 != null ? `<span class="${a1 >= a0 ? "c-good" : "c-bad"}">${a1 >= a0 ? "+" : "−"}${Math.abs(Math.round(a1 - a0))} pts</span> vs les 10 précédents` : "&nbsp;";
  const conv = all.filter((x) => !["messagerie", "barrage"].includes(x.issue));
  const rdv = conv.filter((x) => x.issue === "rdv").length;
  $("#k-rdv").textContent = conv.length ? Math.round((100 * rdv) / conv.length) + " %" : "–";
  const best = all.length ? all.reduce((a, b) => (b.score > a.score ? b : a)) : null;
  $("#k-best").textContent = best ? best.score : "–";
  $("#k-best-d").textContent = best ? `${nameOf(best)}, ${fmtDate(best.date)}` : " ";

  // Ligne droite moyenne
  const notes = {};
  ETAPES.forEach(([k]) => { notes[k] = avg(last10.map((x) => x.summary && x.summary.etapes && x.summary.etapes[k] && x.summary.etapes[k].note)); if (notes[k] != null) notes[k] = Math.round(notes[k] * 10) / 10; });
  const scored = ETAPES.filter(([k]) => notes[k] != null);
  $("#sline-dash").innerHTML = scored.length ? straightLine(notes) : emptyState("Ta ligne droite apparaîtra ici", "Dès ton premier appel analysé, tu verras ta note sur chaque étape de la méthode.");
  const weakest = scored.length ? scored.reduce((a, b) => (notes[a[0]] <= notes[b[0]] ? a : b)) : null;
  $("#sline-badge").style.display = weakest ? "" : "none";
  if (weakest) $("#sline-badge").textContent = `Priorité : ${weakest[1].toLowerCase()}`;

  // Priorité
  const last = all[all.length - 1];
  $("#prio").innerHTML = weakest
    ? `<div class="k">Ta priorité cette semaine</div><h3>${esc(weakest[1])}</h3>
       <p>C'est l'étape où tu perds le plus de points : ${notes[weakest[0]].toFixed(1)}/10 en moyenne sur tes ${last10.length} derniers appels.</p>
       ${last && last.summary && last.summary.priorite ? `<div class="advice"><b>Dernier conseil du coach</b><br>${esc(last.summary.priorite)}</div>` : ""}
       <div style="margin-top:18px"><button class="btn ghost" data-go="coach">Ouvrir le bilan du coach</button></div>`
    : `<div class="k">Pour commencer</div><h3>Analyse ton premier appel</h3><p>Passe tes appels depuis GoHighLevel : CLOSER les récupère tout seul. Tu peux aussi importer un enregistrement.</p><div style="margin-top:18px"><button class="btn primary" data-go="calls">Voir mes appels</button></div>`;

  // Graphique
  if (all.length >= 2) {
    const pts = all.slice(-30), W = 640, H = 220, L = 30, R = 8, T = 10, B = 26;
    const xs = (i) => L + (i * (W - L - R)) / (pts.length - 1), ys = (s) => T + (H - T - B) * (1 - s / 100);
    const mm = pts.map((p, i) => avg(pts.slice(Math.max(0, i - 4), i + 1).map((x) => x.score)));
    const line = mm.map((s, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)} ${ys(s).toFixed(1)}`).join(" ");
    const area = `${line} L${xs(pts.length - 1).toFixed(1)} ${ys(0)} L${xs(0)} ${ys(0)} Z`;
    const step = Math.max(1, Math.ceil(pts.length / 6));
    $("#chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Évolution du score">
      <defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F5B301" stop-opacity=".22"/><stop offset="1" stop-color="#F5B301" stop-opacity="0"/></linearGradient></defs>
      ${[0, 25, 50, 75, 100].map((g) => `<line x1="${L}" x2="${W - R}" y1="${ys(g)}" y2="${ys(g)}" stroke="var(--line-soft)"/><text x="${L - 8}" y="${ys(g) + 4}" text-anchor="end">${g}</text>`).join("")}
      <path d="${area}" fill="url(#ga)"/>
      <path d="${line}" fill="none" stroke="var(--or)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
      ${pts.map((p, i) => `<circle cx="${xs(i).toFixed(1)}" cy="${ys(p.score).toFixed(1)}" r="3" fill="var(--panel)" stroke="${col(p.score)}" stroke-width="1.6"><title>${esc(nameOf(p))} : ${p.score}</title></circle>`).join("")}
      ${pts.map((p, i) => (i % step === 0 || i === pts.length - 1) ? `<text x="${xs(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(fmtDate(p.date))}</text>` : "").join("")}
    </svg>`;
  } else {
    $("#chart").innerHTML = emptyState("Pas encore assez de données", "La courbe apparaît après deux appels analysés.");
  }

  // Derniers appels
  const recent = calls.filter((c) => c.status !== "skipped").slice(0, 6);
  $("#recent").innerHTML = recent.length ? rowsTable(recent) : emptyState("Aucun appel pour l'instant", "Tes appels GoHighLevel apparaîtront ici automatiquement.");

  // Bandeau historique
  const toDo = counts.new || 0;
  $("#dash-callout").innerHTML = toDo && !all.length
    ? `<div class="callout"><div class="grow"><b>${toDo} appel${toDo > 1 ? "s" : ""} de ton historique attend${toDo > 1 ? "ent" : ""} d'être analysé${toDo > 1 ? "s" : ""}.</b><p>Lance l'analyse pour remplir ton tableau de bord dès aujourd'hui.</p></div><button class="btn primary" data-backfill>Analyser l'historique</button></div>`
    : "";
}

/* ---------- Appels ---------- */
function filtered() {
  return calls.filter((c) => {
    const f = filtre === "tous" ? true : filtre === "faits" ? c.status === "done" : filtre === "afaire" ? ["new", "error"].includes(c.status) : filtre === "encours" ? ACTIVE.includes(c.status) : c.status === "short";
    if (!f) return false;
    if (!query) return true;
    return [nameOf(c), c.phone, c.label].filter(Boolean).join(" ").toLowerCase().includes(query);
  });
}
function renderCalls() {
  const n = { tous: calls.length, faits: 0, afaire: 0, encours: 0, courts: 0 };
  calls.forEach((c) => { if (c.status === "done") n.faits++; else if (["new", "error"].includes(c.status)) n.afaire++; else if (ACTIVE.includes(c.status)) n.encours++; else if (c.status === "short") n.courts++; });
  Object.entries(n).forEach(([k, v]) => { const el = $("#n-" + k); if (el) el.textContent = v || ""; });

  const toDo = counts.new || 0;
  $("#calls-callout").innerHTML = toDo
    ? `<div class="callout"><div class="grow"><b>${toDo} appel${toDo > 1 ? "s" : ""} pas encore analysé${toDo > 1 ? "s" : ""}.</b><p>Analyse-les un par un, ou tous d'un coup pour environ ${Math.max(1, Math.round(toDo * 0.05))} €.</p></div><button class="btn primary" data-backfill>Tout analyser</button></div>`
    : "";
  const list = filtered();
  $("#calls").innerHTML = list.length ? rowsTable(list)
    : emptyState(query ? "Aucun résultat" : filtre === "tous" ? "Aucun appel pour l'instant" : "Rien dans cette catégorie", query ? "Essaie un autre nom ou numéro." : filtre === "tous" ? "Passe tes appels depuis GoHighLevel : ils apparaîtront ici tout seuls." : "");
}

document.addEventListener("click", async (e) => {
  const bf = e.target.closest("[data-backfill]");
  if (bf) {
    const toDo = counts.new || 0;
    if (!(await confirmBox(`Analyser ${toDo} appel${toDo > 1 ? "s" : ""} ? Coût estimé : environ ${Math.max(1, Math.round(toDo * 0.05))} €.`, "Lancer l'analyse"))) return;
    try { const r = await api("/backfill", { method: "POST" }); toast(`${r.queued} appels en cours d'analyse`); refresh(); } catch (err) { toast(err.message); }
    return;
  }
  const an = e.target.closest("[data-analyze]");
  if (an) {
    e.stopPropagation();
    try { await api(`/calls/${encodeURIComponent(an.dataset.analyze)}/analyze`, { method: "POST" }); const c = calls.find((x) => x.id === an.dataset.analyze); if (c) c.status = "queued"; renderAll(); toast("Analyse lancée"); schedule(); } catch (err) { toast(err.message); }
    return;
  }
  const row = e.target.closest("tr[data-id]");
  if (row) openDrawer(row.dataset.id);
});

/* ---------- Panneau de détail ---------- */
function closeDrawer() { $("#drawer").classList.remove("on"); $("#scrim").classList.remove("on"); $("#drawer").setAttribute("aria-hidden", "true"); currentId = null; }
$("#d-close").onclick = closeDrawer; $("#scrim").onclick = closeDrawer;
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
$("#d-tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; dTab = b.dataset.t; $$("#d-tabs button").forEach((x) => x.classList.toggle("on", x === b)); renderDrawerBody(); });

async function openDrawer(id) {
  currentId = id; dTab = "analyse";
  $$("#d-tabs button").forEach((x) => x.classList.toggle("on", x.dataset.t === "analyse"));
  $("#d-title").textContent = "…"; $("#d-meta").textContent = ""; $("#d-foot").innerHTML = "";
  $("#d-body").innerHTML = `<div class="skeleton" style="width:60%"></div><div class="skeleton" style="width:90%;margin-top:12px"></div><div class="skeleton" style="width:75%;margin-top:12px"></div>`;
  $("#drawer").classList.add("on"); $("#scrim").classList.add("on"); $("#drawer").setAttribute("aria-hidden", "false");
  let a;
  try { a = await api(`/calls/${encodeURIComponent(id)}`); } catch (e) { $("#d-body").innerHTML = `<div class="callout err"><div>${esc(e.message)}</div></div>`; return; }
  if (currentId !== id) return;
  currentCall = a;
  const x = a.analysis || {};
  $("#d-title").textContent = a.contact_name || a.label || x.prospect || a.phone || "Appel";
  $("#d-meta").textContent = [fmtFull(a.date), a.duration ? fmtDur(a.duration) : "", a.phone && (a.contact_name || a.label) ? a.phone : ""].filter(Boolean).join(", ");
  renderDrawerBody(); renderDrawerFoot();
}

function renderDrawerBody() {
  const a = currentCall; if (!a) return;
  const body = $("#d-body");
  if (dTab === "transcript") {
    if (!a.transcript) { body.innerHTML = emptyState("Pas encore de transcription", "Elle apparaîtra ici une fois l'appel transcrit."); return; }
    const lines = a.transcript.split("\n").map((l) => {
      const m = l.match(/^\[(\d+:\d+)\]\s*([^:]{1,40})\s*:\s*(.*)$/);
      if (m) return `<div class="ln"><span class="ts">${esc(m[1])}</span><div><span class="sp">${esc(m[2])}</span>${esc(m[3])}</div></div>`;
      const m2 = l.match(/^([^:]{1,30})\s*:\s*(.*)$/);
      if (m2) return `<div class="ln"><span class="ts"></span><div><span class="sp">${esc(m2[1])}</span>${esc(m2[2])}</div></div>`;
      return l.trim() ? `<div class="ln"><span class="ts"></span><div>${esc(l)}</div></div>` : "";
    }).join("");
    body.innerHTML = `${a.has_recording ? `<audio controls preload="none" src="/api/calls/${encodeURIComponent(a.id)}/audio"></audio>` : ""}<div class="transcript" style="white-space:normal">${lines}</div>`;
    return;
  }
  if (a.status !== "done") {
    const msg = {
      short: ["Appel trop court", "Messagerie, barrage ou raccroché : il n'y a pas assez d'échange pour une analyse."],
      error: ["L'analyse a échoué", a.error || "Erreur inconnue."],
      queued: ["En file d'attente", "L'analyse démarre dans quelques instants."],
      transcribing: ["Transcription en cours", "Compte environ une minute."],
      analyzing: ["Analyse en cours", "Le coach écoute ton appel."],
      new: ["Pas encore analysé", "Lance l'analyse pour obtenir ton score et tes conseils."],
    }[a.status] || ["", ""];
    body.innerHTML = `<div class="callout ${a.status === "error" ? "err" : ""}"><div class="grow"><b>${esc(msg[0])}</b><p>${esc(msg[1])}</p></div></div>`;
    return;
  }
  const x = a.analysis || {};
  const et = x.etapes || {}, t10 = x.trois_dix || {};
  const notes = {}; ETAPES.forEach(([k]) => (notes[k] = et[k] ? et[k].note : null));
  body.innerHTML = `
    <div class="verdict">${ring(x.score)}<div>${issueBadge(x.issue)}<p>${esc(x.resume)}</p></div></div>
    ${a.has_recording ? `<audio controls preload="none" src="/api/calls/${encodeURIComponent(a.id)}/audio"></audio>` : ""}
    ${x.priorite ? `<div class="callout"><div class="grow"><b>Priorité pour le prochain appel</b><p>${esc(x.priorite)}</p></div></div>` : ""}
    <div class="block"><h3>La ligne droite</h3><div class="panel" style="padding:20px 12px 14px">${straightLine(notes)}</div></div>
    <div class="block"><h3>Détail par étape</h3><div class="steps">${ETAPES.map(([k, n, hint]) => { const s = et[k] || {}; const v = s.note;
      return `<div class="step"><div><div class="n">${n}</div>${hint ? `<div class="small muted">${hint}</div>` : ""}<div class="bar"><i style="width:${v == null ? 0 : v * 10}%;background:${col(v == null ? null : v * 10)}"></i></div></div>
        <div class="tx">${s.constat ? esc(s.constat) : '<span class="muted">Étape non atteinte.</span>'}${s.conseil ? `<div class="fix">${esc(s.conseil)}</div>` : ""}</div>
        <div class="score c-${tone(v == null ? null : v * 10)}">${v == null ? "–" : v}</div></div>`; }).join("")}</div></div>
    <div class="block"><h3>Les 3 dix<span class="sub">Certitude du prospect en fin d'appel</span></h3><div class="meters">
      ${[["Produit", t10.produit], ["Toi", t10.vendeur], ["Entreprise", t10.entreprise], ["Seuil d'action", x.seuil_action], ["Douleur", x.douleur]].map(([l, v]) =>
        `<div class="meter"><div class="l">${l}</div><div class="v" style="color:${col(v == null ? null : v * 10)}">${v ?? "–"}<small>/10</small></div></div>`).join("")}</div></div>
    ${(x.erreurs || []).length ? `<div class="block"><h3>Ce qu'il fallait dire</h3>${x.erreurs.map((r) => `<div class="pair"><div class="a">« ${esc(r.citation)} »</div><div class="why">${esc(r.probleme)}</div><div class="b">${esc(r.a_dire)}</div></div>`).join("")}</div>` : ""}
    ${(x.objections || []).length ? `<div class="block"><h3>Objections</h3>${x.objections.map((o) => `<div class="pair obj"><div class="a"><b style="color:var(--text)">${esc(o.objection)}</b><br>Ta réponse : ${esc(o.reponse)}</div><div class="b">${esc(o.boucle)}</div></div>`).join("")}</div>` : ""}
    ${(x.points_forts || []).length ? `<div class="block"><h3>Points forts</h3><ul class="list">${x.points_forts.map((p) => `<li><span class="mk c-good">+</span><span>${esc(p)}</span></li>`).join("")}</ul></div>` : ""}
    ${x.exercice ? `<div class="block"><h3>Exercice de 5 minutes</h3><p style="margin:0;color:var(--text-2)">${esc(x.exercice)}</p></div>` : ""}`;
  body.scrollTop = 0;
}

function renderDrawerFoot() {
  const a = currentCall; const enc = encodeURIComponent(a.id);
  const btns = [];
  if (["new", "error", "short"].includes(a.status)) btns.push(`<button class="btn primary" data-act="analyze">Analyser cet appel</button>`);
  if (a.status === "done") btns.push(`<button class="btn danger" data-act="delete">${a.source === "ghl" ? "Effacer l'analyse" : "Supprimer"}</button>`);
  if (a.source !== "paste" && !ACTIVE.includes(a.status)) btns.push(`<button class="btn ghost" data-act="retx">Retranscrire</button>`);
  if (a.transcript && a.status === "done") btns.push(`<button class="btn ghost" data-act="redo">Relancer l'analyse</button>`);
  $("#d-foot").innerHTML = btns.join("");
  $("#d-foot").onclick = async (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const act = b.dataset.act;
    try {
      if (act === "delete") {
        if (!(await confirmBox(a.source === "ghl" ? "Effacer cette analyse ? L'appel reste dans GoHighLevel." : "Supprimer cet appel et son analyse ?", "Effacer"))) return;
        await api(`/calls/${enc}`, { method: "DELETE" }); toast("Analyse effacée");
      } else {
        await api(`/calls/${enc}/analyze${act === "retx" ? "?retranscribe=1" : ""}`, { method: "POST" });
        toast(act === "retx" ? "Nouvelle transcription lancée" : "Analyse lancée");
      }
      closeDrawer(); refresh();
    } catch (err) { toast(err.message); }
  };
}

/* ---------- Bilan du coach ---------- */
function renderBilan(b) {
  if (!b) {
    $("#bilan").innerHTML = `<div class="panel">${emptyState("Aucun bilan pour l'instant", "Génère ton premier bilan dès que tu as au moins deux appels analysés.")}</div>`;
    return;
  }
  const d = b.data || b;
  $("#bilan").innerHTML = `
    <div class="panel" style="margin-bottom:20px"><div class="panel-h"><h2>Diagnostic</h2><span class="sub">${esc(fmtFull(b.created_at))}, ${esc(d.n)} appels</span></div>
      <div class="panel-b"><p class="coach-text">${esc(d.diagnostic)}</p>${d.phrase_cle ? `<div style="margin-top:22px"><div class="small muted" style="margin-bottom:8px">Ta phrase de la semaine</div><p class="quote">${esc(d.phrase_cle)}</p></div>` : ""}</div></div>
    <div class="grid g-eq" style="margin-bottom:20px">
      <div class="panel"><div class="panel-h"><h2>Ce qui marche</h2></div><div class="panel-b"><ul class="list">${(d.forces || []).map((x) => `<li><span class="mk c-good">+</span><span>${esc(x)}</span></li>`).join("")}</ul></div></div>
      <div class="panel"><div class="panel-h"><h2>Ce qui te coûte des rendez-vous</h2></div><div class="panel-b"><ul class="list">${(d.faiblesses || []).map((x) => `<li><span class="mk c-bad">−</span><span>${esc(x)}</span></li>`).join("")}</ul></div></div>
    </div>
    ${(d.plan || []).length ? `<div class="panel"><div class="panel-h"><h2>Plan d'entraînement</h2><span class="sub">5 prochains jours de prospection</span></div><div class="panel-b"><ul class="list">${d.plan.map((x, i) => `<li><span class="mk">${i + 1}</span><span><b>${esc(x.jour)}</b><br><span class="muted">${esc(x.action)}</span></span></li>`).join("")}</ul></div></div>` : ""}`;
  $("#btn-bilan").textContent = "Générer un nouveau bilan";
}
$("#btn-bilan").onclick = async () => {
  const btn = $("#btn-bilan"); btn.disabled = true; btn.innerHTML = `<span class="spin"></span>Le coach relit tes appels…`;
  try { renderBilan(await api("/bilan", { method: "POST" })); toast("Bilan prêt"); }
  catch (e) { toast(e.message); btn.textContent = "Générer un bilan"; }
  btn.disabled = false;
};

/* ---------- Importer ---------- */
async function uploadFile(f) {
  if (!f) return;
  if (f.size > 60 * 1024 * 1024) { toast("Fichier trop lourd : 60 Mo maximum"); return; }
  const drop = $("#u-drop"); const old = drop.innerHTML;
  drop.innerHTML = `<span class="spin"></span><b>Envoi de ${esc(f.name)}</b>`;
  try {
    await api("/upload", { method: "POST", body: f, headers: { "Content-Type": f.type || "audio/mpeg", "X-Label": encodeURIComponent($("#u-nom").value.trim() || f.name.replace(/\.[^.]+$/, "")) } });
    toast("Audio reçu, transcription en cours"); $("#u-nom").value = ""; await refresh(); show("calls");
  } catch (err) { toast(err.message); }
  drop.innerHTML = old;
}
$("#u-file").onchange = (e) => { uploadFile(e.target.files[0]); e.target.value = ""; };
const drop = $("#u-drop");
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => uploadFile(e.dataTransfer.files[0]));
$("#btn-coller").onclick = async () => {
  const t = $("#p-txt").value.trim();
  if (t.length < 40) { toast("La transcription est trop courte pour être analysée"); return; }
  const btn = $("#btn-coller"); btn.disabled = true;
  try {
    await api("/paste", { method: "POST", body: JSON.stringify({ transcript: t, label: $("#p-nom").value.trim() }) });
    $("#p-txt").value = ""; $("#p-nom").value = ""; toast("Analyse lancée"); await refresh(); show("calls");
  } catch (e) { toast(e.message); }
  btn.disabled = false;
};

/* ---------- Réglages ---------- */
function fillSettings() {
  if (!settings) return;
  $("#c-prenom").value = settings.prenom || ""; $("#c-offre").value = settings.offre || "";
  $("#c-min").value = settings.minDuree ?? 20; $("#c-auto").checked = !!settings.autoAnalyze;
  $("#c-script").value = settings.script || ""; $("#c-obj-appels").value = settings.objectifAppels ?? 50;
  $("#c-obj-rdv").value = settings.objectifRdv ?? 3; $("#c-max").value = settings.maxTentatives ?? 3;
}
function renderSyncInfo() {
  const w = workerState || {};
  $("#sync-info").innerHTML = w.lastSyncError
    ? `<span class="c-bad">La dernière synchronisation a échoué : ${esc(w.lastSyncError)}</span>`
    : w.lastSync ? `Dernière synchronisation ${esc(fmtFull(w.lastSync))}. CLOSER vérifie tes nouveaux appels toutes les 10 minutes.` : "CLOSER vérifie tes nouveaux appels toutes les 10 minutes.";
}
$("#btn-save").onclick = async () => {
  try {
    settings = await api("/settings", { method: "PUT", body: JSON.stringify({ prenom: $("#c-prenom").value, offre: $("#c-offre").value, minDuree: $("#c-min").value, autoAnalyze: $("#c-auto").checked, script: $("#c-script").value, objectifAppels: $("#c-obj-appels").value, objectifRdv: $("#c-obj-rdv").value, maxTentatives: $("#c-max").value }) });
    fillSettings(); renderDashboard(); toast("Réglages enregistrés");
  } catch (e) { toast(e.message); }
};
async function doSync(full, btn) {
  btn.disabled = true;
  try { const r = await api("/sync" + (full ? "?full=1" : ""), { method: "POST" }); toast(r.skipped ? "Une synchronisation est déjà en cours" : `${r.added || 0} nouvel${(r.added || 0) > 1 ? "s" : ""} appel${(r.added || 0) > 1 ? "s" : ""}`); await refresh(); }
  catch (e) { toast(e.message); }
  btn.disabled = false;
}
$("#btn-sync").onclick = (e) => doSync(false, e.currentTarget);
$("#btn-sync-2").onclick = (e) => doSync(false, e.currentTarget);
$("#btn-sync-full").onclick = (e) => doSync(true, e.currentTarget);
$("#btn-logout").onclick = async () => { await fetch("/api/logout", { method: "POST" }); location.href = "/login"; };

/* ---------- Démarrage ---------- */
(async () => {
  const start = (location.hash || "").slice(1);
  if (["dashboard", "pipeline", "dialer", "leads", "objections", "calls", "coach", "import", "settings"].includes(start)) setTimeout(() => show(start), 0);
  try {
    const me = await api("/me");
    window.__me = me;
    if (me.missing && me.missing.length) {
      $("#cfg-warn").innerHTML = `<div class="callout err"><div class="grow"><b>Configuration incomplète</b><p>Ajoute ces variables dans Railway : ${me.missing.map(esc).join(", ")}.</p></div></div>`;
    }
  } catch { return; }
  try { settings = await api("/settings"); fillSettings(); } catch {}
  try { renderBilan(await api("/bilan")); } catch { renderBilan(null); }
  refresh();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
