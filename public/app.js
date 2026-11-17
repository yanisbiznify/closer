/* CLOSER — application */
const ETAPES = [
  ["ouverture", "Ouverture (4 premières sec.)"],
  ["tonalite", "Tonalité"],
  ["rapport", "Rapport"],
  ["qualification", "Qualification"],
  ["presentation", "Présentation"],
  ["boucles", "Boucles / objections"],
  ["closing", "Closing"],
  ["controle", "Contrôle de la ligne droite"],
];
const ISSUES = { rdv: ["RDV pris", "g"], rappel: ["À rappeler", "m"], refus: ["Refus", "b"], barrage: ["Barrage", "b"], messagerie: ["Messagerie", ""], autre: ["Autre", ""] };
const ACTIVE = ["queued", "transcribing", "analyzing"];

let calls = [], counts = {}, workerState = {}, settings = null, filtre = "tous", pollTimer = null, currentId = null;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cls = (s) => (s == null ? "" : s >= 75 ? "g" : s >= 50 ? "m" : "b");
const col = (s) => (s == null ? "var(--ardoise)" : s >= 75 ? "var(--deal)" : s >= 50 ? "var(--ambre)" : "var(--raccroche)");
const fmtDate = (iso) => { try { return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); } catch { return iso; } };
const fmtDur = (d) => (d == null ? "" : d >= 60 ? `${Math.floor(d / 60)} min ${String(d % 60).padStart(2, "0")}` : `${d} s`);
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
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("on", x.dataset.v === view));
  document.querySelectorAll("section.view").forEach((s) => s.classList.toggle("on", s.id === "v-" + view));
  window.scrollTo(0, 0);
}
$("#tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.v); });
$("#filters").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  filtre = b.dataset.f;
  document.querySelectorAll("#filters button").forEach((x) => x.classList.toggle("on", x === b));
  renderCalls();
});
$("#sheet-close").onclick = closeSheet;
function closeSheet() { $("#sheet").classList.remove("on"); currentId = null; }
window.addEventListener("popstate", () => { if ($("#sheet").classList.contains("on")) closeSheet(); });

/* ---------- Données ---------- */
async function refresh() {
  try {
    const d = await api("/calls");
    calls = d.calls; counts = d.counts || {}; workerState = d.worker || {};
    renderAll();
  } catch (e) { $("#chip-txt").textContent = "Hors ligne"; }
  schedule();
}
function schedule() {
  clearTimeout(pollTimer);
  const busy = calls.some((c) => ACTIVE.includes(c.status));
  pollTimer = setTimeout(refresh, busy ? 4000 : 60000);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

function renderAll() { renderChip(); renderCalls(); renderProgres(); renderSyncInfo(); }

function renderChip() {
  const n = calls.filter((c) => ACTIVE.includes(c.status)).length;
  $("#chip").classList.toggle("busy", n > 0);
  $("#chip-txt").textContent = n ? `${n} en analyse` : "À jour";
}

/* ---------- Appels ---------- */
function pillFor(c) {
  switch (c.status) {
    case "done": return `<span class="pill score ${cls(c.score)}">${esc(c.score)}</span>`;
    case "queued": return `<span class="pill"><span class="spin"></span>En file</span>`;
    case "transcribing": return `<span class="pill"><span class="spin"></span>Transcription</span>`;
    case "analyzing": return `<span class="pill"><span class="spin"></span>Analyse</span>`;
    case "short": return `<span class="pill">Trop court</span>`;
    case "error": return `<span class="pill b">Erreur ↻</span>`;
    default: return `<span class="pill a">Analyser</span>`;
  }
}
function nameOf(c) {
  return c.contact_name || c.label || (c.summary && c.summary.prospect) || c.phone || (c.source === "paste" ? "Transcription collée" : c.source === "upload" ? "Audio importé" : "Appel");
}
function renderCalls() {
  const top = $("#calls-top");
  const toDo = counts.new || 0;
  top.innerHTML = toDo
    ? `<div class="notice"><b>${toDo} ancien${toDo > 1 ? "s" : ""} appel${toDo > 1 ? "s" : ""} pas encore analysé${toDo > 1 ? "s" : ""}.</b> Tu peux les analyser un par un, ou tous d'un coup (≈ 0,05 € par appel).<div style="margin-top:10px"><button class="btn" id="btn-backfill">Analyser tout l'historique</button></div></div>`
    : "";
  const bf = $("#btn-backfill");
  if (bf) bf.onclick = async () => {
    if (!(await confirmBox(`Analyser ${toDo} appel${toDo > 1 ? "s" : ""} ? Coût estimé : environ ${Math.max(1, Math.round(toDo * 0.05))} €.`, "Lancer"))) return;
    try { const r = await api("/backfill", { method: "POST" }); toast(`${r.queued} appels en file`); refresh(); } catch (e) { toast(e.message); }
  };

  const list = calls.filter((c) =>
    filtre === "tous" ? true :
    filtre === "faits" ? c.status === "done" :
    filtre === "afaire" ? ["new", "error"].includes(c.status) :
    filtre === "encours" ? ACTIVE.includes(c.status) :
    c.status === "short");
  const box = $("#calls");
  if (!list.length) {
    box.innerHTML = `<div class="empty"><img src="/brand/mark.svg" alt=""><div>${filtre === "tous" ? "Aucun appel pour l'instant. Passe tes appels depuis GHL : ils apparaîtront ici tout seuls." : "Rien dans cette catégorie."}</div></div>`;
    return;
  }
  box.innerHTML = list.map((c) => {
    const sub = [fmtDate(c.date), c.source === "ghl" ? (c.direction === "inbound" ? "entrant" : "sortant") : c.source === "paste" ? "collé" : "importé", fmtDur(c.duration)].filter(Boolean).join(" · ");
    const iss = c.status === "done" && c.issue && ISSUES[c.issue] ? ` · ${ISSUES[c.issue][0]}` : "";
    return `<div class="call" data-id="${esc(c.id)}"><div class="meta"><b>${esc(nameOf(c))}</b><span class="small mut">${esc(sub + iss)}</span></div>${pillFor(c)}</div>`;
  }).join("");
}
$("#calls").addEventListener("click", async (e) => {
  const row = e.target.closest(".call"); if (!row) return;
  const c = calls.find((x) => x.id === row.dataset.id); if (!c) return;
  if (c.status === "new") {
    try { await api(`/calls/${encodeURIComponent(c.id)}/analyze`, { method: "POST" }); c.status = "queued"; renderAll(); toast("Analyse lancée"); schedule(); } catch (err) { toast(err.message); }
    return;
  }
  openDetail(c.id);
});

/* ---------- Détail ---------- */
function ring(score) {
  const r = 37, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, Number(score) || 0));
  return `<svg class="ring" viewBox="0 0 88 88"><circle cx="44" cy="44" r="${r}" fill="none" stroke="var(--surface2)" stroke-width="8"/>
  <circle cx="44" cy="44" r="${r}" fill="none" stroke="${col(v)}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${(c * v) / 100} ${c}" transform="rotate(-90 44 44)"/>
  <text x="44" y="51" text-anchor="middle" style="fill:var(--ivoire);font:700 22px var(--font-title)">${v}</text></svg>`;
}
const bar10 = (n) => `<div class="bar"><i style="width:${n == null ? 0 : n * 10}%;background:${col(n == null ? null : n * 10)}"></i></div>`;

async function openDetail(id) {
  currentId = id;
  $("#sheet-title").textContent = "…"; $("#sheet-sub").textContent = "";
  $("#sheet-body").innerHTML = `<div class="empty"><span class="spin"></span></div>`;
  if (!$("#sheet").classList.contains("on")) { $("#sheet").classList.add("on"); history.pushState({ sheet: 1 }, ""); }
  $("#sheet").scrollTop = 0;
  let a;
  try { a = await api(`/calls/${encodeURIComponent(id)}`); } catch (e) { $("#sheet-body").innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  if (currentId !== id) return;
  const x = a.analysis || {};
  $("#sheet-title").textContent = a.contact_name || a.label || x.prospect || a.phone || "Appel";
  $("#sheet-sub").textContent = [fmtDate(a.date), fmtDur(a.duration), a.phone && (a.contact_name || a.label) ? a.phone : ""].filter(Boolean).join(" · ");

  const actions = `<div class="row" style="margin-top:16px">
      ${a.transcript ? `<button class="btn sec" id="d-redo" style="flex:1">Ré-analyser</button>` : ""}
      ${a.source !== "paste" ? `<button class="btn ghost" id="d-retx" style="flex:1">Retranscrire</button>` : ""}
      ${a.status === "done" ? `<button class="btn danger" id="d-del" style="flex:1">${a.source === "ghl" ? "Effacer l'analyse" : "Supprimer"}</button>` : ""}
    </div>`;
  const transcriptBlock = a.transcript ? `<h3>Transcription</h3><details class="card"><summary class="mut small" style="cursor:pointer">Afficher la transcription</summary><div class="transcript">${esc(a.transcript)}</div></details>` : "";

  if (a.status !== "done") {
    const msg = {
      short: "Appel trop court pour être analysé (messagerie, barrage ou raccroché).",
      error: `L'analyse a échoué : ${esc(a.error || "erreur inconnue")}`,
      queued: "En file d'attente…", transcribing: "Transcription en cours…", analyzing: "Analyse Straight Line en cours…",
      new: "Pas encore analysé.",
    }[a.status] || "";
    $("#sheet-body").innerHTML = `<div class="${a.status === "error" ? "err" : "notice"}">${msg}</div>
      ${["new", "error", "short"].includes(a.status) ? `<button class="btn full" id="d-go">Analyser cet appel</button>` : ""}
      ${transcriptBlock}${a.status === "short" || a.status === "error" ? actions : ""}`;
  } else {
    const iss = ISSUES[x.issue] || ISSUES.autre;
    const et = x.etapes || {}, t10 = x.trois_dix || {};
    $("#sheet-body").innerHTML = `
      <div class="card score-box hero">${ring(x.score)}
        <div><span class="pill ${iss[1]}">${iss[0]}</span><p style="margin:8px 0 0;font-size:14px">${esc(x.resume)}</p></div></div>
      ${x.priorite ? `<div class="notice"><b>Priorité n°1 :</b> ${esc(x.priorite)}</div>` : ""}
      <h3>La ligne droite</h3>
      <div class="card">${ETAPES.map(([k, n]) => { const s = et[k] || {}; return `
        <div class="step"><div class="hd"><span>${n}</span><span style="color:${col(s.note == null ? null : s.note * 10)}">${s.note == null ? "—" : s.note + "/10"}</span></div>${bar10(s.note)}
        ${s.constat ? `<p>${esc(s.constat)}</p>` : ""}${s.conseil ? `<p class="tip">→ ${esc(s.conseil)}</p>` : ""}</div>`; }).join("")}</div>
      <h3>Les 3 dix · certitude du prospect</h3>
      <div class="card">${[["produit", "Produit"], ["vendeur", "Toi"], ["entreprise", "Entreprise"]].map(([k, n]) => `
        <div class="step"><div class="hd"><span>${n}</span><span>${t10[k] ?? "—"}/10</span></div>${bar10(t10[k])}</div>`).join("")}
        <div class="step"><div class="hd"><span>Seuil d'action</span><span>${x.seuil_action ?? "—"}/10</span></div>${bar10(x.seuil_action)}</div>
        <div class="step"><div class="hd"><span>Douleur ressentie</span><span>${x.douleur ?? "—"}/10</span></div>${bar10(x.douleur)}</div></div>
      ${(x.erreurs || []).length ? `<h3>Ce qu'il fallait dire</h3><div class="card">${x.erreurs.map((r) => `
        <div class="q"><div class="said">« ${esc(r.citation)} »</div><div>${esc(r.probleme)}</div><div class="fix">✓ ${esc(r.a_dire)}</div></div>`).join("")}</div>` : ""}
      ${(x.objections || []).length ? `<h3>Objections</h3><div class="card">${x.objections.map((o) => `
        <div class="q"><b>${esc(o.objection)}</b><div class="said">Ta réponse : ${esc(o.reponse)}</div><div class="fix">↻ ${esc(o.boucle)}</div></div>`).join("")}</div>` : ""}
      ${(x.points_forts || []).length ? `<h3>Points forts</h3><div class="card"><ul class="clean">${x.points_forts.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}
      ${x.exercice ? `<h3>Exercice de 5 min</h3><div class="card" style="font-size:14px">${esc(x.exercice)}</div>` : ""}
      ${transcriptBlock}${actions}`;
  }
  const go = async (path, label) => {
    try { await api(path, { method: "POST" }); toast(label); closeSheet(); refresh(); } catch (e) { toast(e.message); }
  };
  const enc = encodeURIComponent(id);
  if ($("#d-go")) $("#d-go").onclick = () => go(`/calls/${enc}/analyze`, "Analyse lancée");
  if ($("#d-redo")) $("#d-redo").onclick = () => go(`/calls/${enc}/analyze`, "Nouvelle analyse lancée");
  if ($("#d-retx")) $("#d-retx").onclick = () => go(`/calls/${enc}/analyze?retranscribe=1`, "Nouvelle transcription lancée");
  if ($("#d-del")) $("#d-del").onclick = async () => {
    if (!(await confirmBox(a.source === "ghl" ? "Effacer cette analyse ? L'appel reste dans GHL." : "Supprimer cet appel et son analyse ?", "Effacer"))) return;
    try { await api(`/calls/${enc}`, { method: "DELETE" }); closeSheet(); refresh(); } catch (e) { toast(e.message); }
  };
}

/* ---------- Progrès ---------- */
function renderProgres() {
  const all = calls.filter((c) => c.status === "done" && typeof c.score === "number").slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  $("#k-n").textContent = all.length;
  const last10 = all.slice(-10), prev10 = all.slice(-20, -10);
  const a1 = avg(last10.map((x) => x.score)), a0 = avg(prev10.map((x) => x.score));
  $("#k-avg").textContent = a1 == null ? "–" : Math.round(a1);
  $("#k-avg").style.color = a1 == null ? "" : col(a1);
  $("#k-delta").textContent = a1 != null && a0 != null ? `${a1 - a0 >= 0 ? "▲ +" : "▼ "}${Math.round(a1 - a0)} vs 10 précédents` : "";
  const conv = all.filter((x) => !["messagerie", "barrage"].includes(x.issue));
  $("#k-rdv").textContent = conv.length ? Math.round((100 * conv.filter((x) => x.issue === "rdv").length) / conv.length) + " %" : "–";
  $("#k-best").textContent = all.length ? Math.max(...all.map((x) => x.score)) : "–";

  const means = ETAPES.map(([k, n]) => [k, n, avg(last10.map((x) => x.summary && x.summary.etapes && x.summary.etapes[k] && x.summary.etapes[k].note))]);
  const scored = means.filter((m) => m[2] != null);
  const weakest = scored.length ? scored.reduce((a, b) => (a[2] <= b[2] ? a : b)) : null;
  const lastPrio = all.length ? all[all.length - 1].summary && all[all.length - 1].summary.priorite : null;
  $("#hero-prio").textContent = weakest ? weakest[1].replace(/ \(.*\)/, "") : "Analyse ton premier appel";
  $("#hero-sub").textContent = lastPrio ? `Dernier conseil : ${lastPrio}` : weakest ? "Ton étape la plus faible sur tes 10 derniers appels." : "Chaque appel analysé te rapproche du close.";

  $("#etapes-avg").innerHTML = scored.length
    ? means.map(([k, n, v]) => `<div class="step"><div class="hd"><span>${n}${weakest && k === weakest[0] ? ' <span class="pill a" style="padding:2px 8px;font-size:11px">Priorité</span>' : ""}</span><span>${v == null ? "—" : v.toFixed(1) + "/10"}</span></div>${bar10(v)}</div>`).join("")
    : `<span class="mut small">—</span>`;

  if (all.length >= 2) {
    const pts = all.slice(-30), W = 320, H = 150, P = 22;
    const xs = (i) => P + (i * (W - 2 * P)) / (pts.length - 1), ys = (s) => H - P - (s * (H - 2 * P)) / 100;
    const path = pts.map((p, i) => (i ? "L" : "M") + xs(i).toFixed(1) + " " + ys(p.score).toFixed(1)).join(" ");
    const mm = pts.map((p, i) => avg(pts.slice(Math.max(0, i - 4), i + 1).map((x) => x.score)));
    const path2 = mm.map((s, i) => (i ? "L" : "M") + xs(i).toFixed(1) + " " + ys(s).toFixed(1)).join(" ");
    $("#chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%">
      ${[0, 50, 75, 100].map((g) => `<line x1="${P}" x2="${W - P}" y1="${ys(g)}" y2="${ys(g)}" stroke="var(--ardoise)" ${g ? 'stroke-dasharray="3 3"' : ""}/><text x="0" y="${ys(g) + 3}">${g}</text>`).join("")}
      <path d="${path}" fill="none" stroke="var(--gris)" stroke-width="1.2" opacity=".5"/>
      <path d="${path2}" fill="none" stroke="var(--or)" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
      ${pts.map((p, i) => `<circle cx="${xs(i)}" cy="${ys(p.score)}" r="3.2" fill="${col(p.score)}"/>`).join("")}
    </svg><div class="small mut">Points : chaque appel · <span style="color:var(--or)">ligne or : moyenne sur 5 appels</span></div>`;
  } else {
    $("#chart").innerHTML = `<span class="mut small">Le graphique apparaît après 2 appels analysés.</span>`;
  }
}

/* ---------- Bilan ---------- */
function renderBilan(b) {
  if (!b) return;
  const d = b.data || b;
  $("#bilan").innerHTML = `<div style="margin-top:14px">
    <p class="small mut" style="margin:0 0 6px">Bilan du ${esc(fmtDate(b.created_at))} · ${esc(d.n)} appels</p>
    <p style="margin:0 0 8px">${esc(d.diagnostic)}</p>
    ${(d.forces || []).length ? `<h3>Ce qui marche</h3><ul class="clean">${d.forces.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${(d.faiblesses || []).length ? `<h3>Erreurs récurrentes</h3><ul class="clean">${d.faiblesses.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${(d.plan || []).length ? `<h3>Plan de la semaine</h3><ul class="clean">${d.plan.map((x) => `<li><b>${esc(x.jour)} :</b> ${esc(x.action)}</li>`).join("")}</ul>` : ""}
    ${d.phrase_cle ? `<div class="notice" style="margin-top:12px"><b>Ta phrase de la semaine :</b> ${esc(d.phrase_cle)}</div>` : ""}
  </div>`;
  $("#btn-bilan").textContent = "Générer un nouveau bilan";
}
$("#btn-bilan").onclick = async () => {
  const btn = $("#btn-bilan"); btn.disabled = true; btn.innerHTML = `<span class="spin" style="vertical-align:-2px;margin-right:6px"></span>Le coach analyse tes appels…`;
  try { renderBilan(await api("/bilan", { method: "POST" })); }
  catch (e) { $("#bilan").innerHTML = `<div class="err">${esc(e.message)}</div>`; btn.textContent = "Générer mon bilan"; }
  btn.disabled = false;
};

/* ---------- Ajouter ---------- */
$("#u-file").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 60 * 1024 * 1024) { toast("Fichier trop lourd (60 Mo max)"); return; }
  const drop = $("#u-drop"); const old = drop.innerHTML;
  drop.innerHTML = `<span class="spin"></span> Envoi de ${esc(f.name)}…`;
  try {
    await api("/upload", { method: "POST", body: f, headers: { "Content-Type": f.type || "audio/mpeg", "X-Label": encodeURIComponent($("#u-nom").value.trim() || f.name.replace(/\.[^.]+$/, "")) } });
    toast("Audio reçu : transcription en cours"); $("#u-nom").value = ""; await refresh(); show("appels");
  } catch (err) { toast(err.message); }
  drop.innerHTML = old; e.target.value = "";
};
$("#btn-coller").onclick = async () => {
  const t = $("#p-txt").value.trim();
  if (t.length < 40) { toast("Colle une transcription un peu plus longue"); return; }
  const btn = $("#btn-coller"); btn.disabled = true;
  try {
    await api("/paste", { method: "POST", body: JSON.stringify({ transcript: t, label: $("#p-nom").value.trim() }) });
    $("#p-txt").value = ""; $("#p-nom").value = ""; toast("Analyse lancée"); await refresh(); show("appels");
  } catch (e) { toast(e.message); }
  btn.disabled = false;
};

/* ---------- Réglages ---------- */
function fillSettings() {
  if (!settings) return;
  $("#c-prenom").value = settings.prenom || ""; $("#c-offre").value = settings.offre || "";
  $("#c-min").value = settings.minDuree ?? 20; $("#c-auto").checked = !!settings.autoAnalyze;
}
function renderSyncInfo() {
  const w = workerState || {};
  $("#sync-info").innerHTML = w.lastSyncError
    ? `<span style="color:var(--raccroche)">Dernière synchro en erreur : ${esc(w.lastSyncError)}</span>`
    : w.lastSync ? `Dernière synchro : ${esc(fmtDate(w.lastSync))}. CLOSER vérifie tes nouveaux appels GHL toutes les 10 minutes.` : "CLOSER vérifie tes nouveaux appels GHL toutes les 10 minutes.";
}
$("#btn-save").onclick = async () => {
  try {
    settings = await api("/settings", { method: "PUT", body: JSON.stringify({ prenom: $("#c-prenom").value, offre: $("#c-offre").value, minDuree: $("#c-min").value, autoAnalyze: $("#c-auto").checked }) });
    fillSettings(); toast("Enregistré");
  } catch (e) { toast(e.message); }
};
async function doSync(full) {
  const b = full ? $("#btn-sync-full") : $("#btn-sync"); b.disabled = true;
  try { const r = await api("/sync" + (full ? "?full=1" : ""), { method: "POST" }); toast(r.skipped ? "Synchro déjà en cours" : `${r.added || 0} nouveaux appels`); await refresh(); }
  catch (e) { toast(e.message); }
  b.disabled = false;
}
$("#btn-sync").onclick = () => doSync(false);
$("#btn-sync-full").onclick = () => doSync(true);
$("#btn-logout").onclick = async () => { await fetch("/api/logout", { method: "POST" }); location.href = "/login"; };

/* ---------- Démarrage ---------- */
(async () => {
  try {
    const me = await api("/me");
    if (me.missing && me.missing.length) {
      $("#cfg-warn").innerHTML = `<div class="err"><b>Configuration incomplète.</b> Ajoute ces variables dans Railway : ${me.missing.map(esc).join(", ")}</div>`;
    }
  } catch { return; }
  try { settings = await api("/settings"); fillSettings(); } catch {}
  try { const b = await api("/bilan"); if (b) renderBilan(b); } catch {}
  refresh();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
