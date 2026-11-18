/* Biznify sur téléphone, partie 2 : pipeline en cartes, session d'appels plein écran, fiche prospect simplifiée */
(() => {
  const mob = () => window.matchMedia("(max-width: 860px)").matches;
  const buzz = (ms = 8) => { try { navigator.vibrate && navigator.vibrate(ms); } catch (_) {} };
  const SV = (d, s = 20) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const IC = {
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    next: '<path d="m5 4 10 8-10 8V4zM19 5v14"/>',
    card: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>',
    script: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    star: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
    euro: '<path d="M4 10h12M4 14h9"/><path d="M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2"/>',
    cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  };
  const STAGE_COL = ["#1877F2", "#7A3FD1", "#E8590C", "#0F9D8B", "#D7263D", "#12A150", "#C77700", "#5B6475", "#2F5FD0", "#A07A3F"];
  const initials = (l) => ((l.company || l.name || "?").split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("") || "?").toUpperCase();
  const title = (l) => l.company || l.name || fmtPhone(l.phone);
  const person = (l) => [l.first_name, l.last_name].filter(Boolean).join(" ") || (l.company && l.name !== l.company ? l.name : "");

  /* ---------- Pipeline en cartes ---------- */
  const MP = { stage: "", q: "" };
  try { MP.stage = localStorage.getItem("bz_mp_stage") || ""; } catch (_) {}
  function ensurePipe() {
    if ($("#mpipe")) return;
    const box = document.createElement("div");
    box.id = "mpipe"; box.className = "mpipe";
    $("#v-pipeline .toolbar").after(box);
  }
  function renderMobilePipe() {
    if (!mob()) return;
    ensurePipe();
    const stages = CRM.stages || [], leads = CRM.leads || [];
    const colOf = Object.fromEntries(stages.map((s, i) => [s.id, STAGE_COL[i % STAGE_COL.length]]));
    const counts = {}; leads.forEach((l) => { const k = l.stage || "nouveau"; counts[k] = (counts[k] || 0) + 1; });
    if (MP.stage && !stages.find((s) => s.id === MP.stage)) MP.stage = "";
    const q = MP.q.toLowerCase();
    const shown = leads.filter((l) => (!MP.stage || (l.stage || "nouveau") === MP.stage) && (!q || [l.company, l.name, l.city, l.phone, l.activity].filter(Boolean).join(" ").toLowerCase().includes(q)));
    const total = shown.reduce((s, l) => s + Number(l.value || 0), 0);
    $("#mpipe").innerHTML = `
      <div class="mp-search">${SV(IC.search, 18)}<input id="mp-q" placeholder="Rechercher" value="${esc(MP.q)}" aria-label="Rechercher un prospect"></div>
      <div class="mp-chips" role="tablist">
        <button role="tab" class="${!MP.stage ? "on" : ""}" data-st="">Tous <b>${leads.length}</b></button>
        ${stages.map((s) => `<button role="tab" class="${MP.stage === s.id ? "on" : ""}" data-st="${esc(s.id)}" style="--c:${colOf[s.id]}"><i></i>${esc(s.label)} <b>${counts[s.id] || 0}</b></button>`).join("")}
      </div>
      <p class="mp-sum">${shown.length} prospect${shown.length > 1 ? "s" : ""}${total ? ` · ${fmtEur(total)}` : ""}</p>
      ${shown.length ? `<ul class="mp-list">${shown.slice(0, 150).map((l) => `
        <li class="mp-card" data-id="${l.id}" style="--c:${colOf[l.stage || "nouveau"] || "#1877F2"}">
          <span class="mp-av">${esc(initials(l))}</span>
          <div class="mp-t"><b>${esc(title(l))}</b><span>${esc([person(l), l.city].filter(Boolean).join(" · ") || fmtPhone(l.phone))}</span>
            <span class="mp-tags"><em>${esc((stages.find((s) => s.id === (l.stage || "nouveau")) || {}).label || "")}</em>${Number(l.value) ? `<strong>${esc(fmtEur(l.value))}</strong>` : ""}</span></div>
          ${l.phone ? `<button class="mp-call" data-call="${l.id}" aria-label="Appeler ${esc(title(l))}">${SV(IC.phone, 20)}</button>` : ""}
        </li>`).join("")}</ul>` : `<div class="mp-empty"><b>Rien ici pour l'instant</b><span>Ajoute des prospects ou lance une recherche Google Maps.</span><button class="btn primary" data-go="prospect">${SV(IC.pin, 18)}Trouver des leads</button></div>`}`;
    $("#mp-q").oninput = (e) => { MP.q = e.target.value; const pos = e.target.selectionStart; renderMobilePipe(); const i = $("#mp-q"); i.focus(); i.setSelectionRange(pos, pos); };
    $$("#mpipe [data-st]").forEach((b) => (b.onclick = () => { buzz(); MP.stage = b.dataset.st; try { localStorage.setItem("bz_mp_stage", MP.stage); } catch (_) {} renderMobilePipe(); }));
    $$("#mpipe .mp-card").forEach((li) => (li.onclick = (e) => {
      const c = e.target.closest("[data-call]");
      const l = CRM.leads.find((x) => x.id === Number(li.dataset.id));
      if (c) { e.stopPropagation(); buzz(15); phoneCall(l, { onDone: () => loadPipeline() }); return; }
      buzz(); openLead(l.id);
    }));
  }
  const _renderPipeline = window.renderPipeline;
  window.renderPipeline = function () { _renderPipeline.apply(this, arguments); renderMobilePipe(); };

  /* ---------- Session d'appels plein écran ---------- */
  const MS = { stats: null };
  function ensureSess() {
    if ($("#msess")) return;
    const box = document.createElement("div");
    box.id = "msess"; box.className = "msess";
    $("#v-dialer .head").after(box);
  }
  async function refreshStats() { try { MS.stats = await api("/dialer/stats"); } catch (_) {} renderSess(); }
  function renderSess() {
    if (!mob()) return;
    ensureSess();
    const s = MS.stats || { appels: 0, objectifAppels: 30, rdv: 0, objectifRdv: 3, conversations: 0 };
    const l = D.cur;
    const pos = l ? D.queue.findIndex((x) => x.id === l.id) + 1 : 0;
    const busy = typeof phoneBusy === "function" && phoneBusy();
    const pct = Math.min(100, Math.round((100 * s.appels) / Math.max(1, s.objectifAppels)));
    const listOpts = `<option value="">Toutes les listes</option>` + (D.lists || []).map((x) => `<option value="${x.id}" ${String(D.list) === String(x.id) ? "selected" : ""}>${esc(x.name)} (${x.total})</option>`).join("");
    const notes = l && l.notes ? String(l.notes).split("\n").filter((x) => !/^\[/.test(x)).slice(0, 2).join(" · ") : "";
    $("#msess").innerHTML = `
      <div class="ms-top">
        <div class="ms-stat"><span>Appels</span><b>${s.appels}<small>/${s.objectifAppels}</small></b><i style="--p:${pct}%"></i></div>
        <div class="ms-stat"><span>Décrochés</span><b>${s.conversations}</b></div>
        <div class="ms-stat ok"><span>RDV</span><b>${s.rdv}<small>/${s.objectifRdv}</small></b></div>
      </div>
      <select id="ms-list" class="ms-list" aria-label="Liste à appeler">${listOpts}</select>
      ${l ? `
      <div class="ms-card">
        <p class="ms-pos">Prospect ${pos} sur ${D.queue.length}${l.status === "rappel" ? ` · <span class="ms-cb">À rappeler${l.callback_at ? " " + esc(fmtTime(l.callback_at)) : ""}</span>` : l.attempts ? ` · ${l.attempts}ᵉ essai` : ""}</p>
        <div class="ms-av">${esc(initials(l))}</div>
        <h2>${esc(title(l))}</h2>
        <p class="ms-sub">${esc([person(l), l.activity].filter(Boolean).join(" · "))}</p>
        <p class="ms-meta">${l.city ? `<span>${SV(IC.pin, 14)}${esc(l.city)}</span>` : ""}<span>${SV(IC.phone, 14)}${esc(fmtPhone(l.phone))}</span>${Number(l.value) ? `<span>${SV(IC.euro, 14)}${esc(fmtEur(l.value))}</span>` : ""}</p>
        ${notes ? `<p class="ms-notes">${esc(notes)}</p>` : ""}
        <button class="ms-go ${busy ? "busy" : ""}" id="ms-go" ${busy ? "disabled" : ""} aria-label="Appeler ${esc(title(l))}">${SV(IC.phone, 34)}</button>
        <p class="ms-hint">${busy ? "Appel en cours…" : D.cfg && D.cfg.enabled ? "Touche pour appeler" : "Dialer non connecté : l'appel passera par ton téléphone"}</p>
        <div class="ms-acts">
          <button id="ms-skip">${SV(IC.next, 18)}<span>Passer</span></button>
          <button id="ms-script">${SV(IC.script, 18)}<span>Script</span></button>
          <button id="ms-card">${SV(IC.card, 18)}<span>Fiche</span></button>
        </div>
      </div>
      ${D.queue.length > 1 ? `<div class="ms-next"><p>Ensuite</p>${D.queue.filter((x) => x.id !== l.id).slice(0, 3).map((x) => `<button data-pick="${x.id}"><span class="mp-av sm">${esc(initials(x))}</span><span><b>${esc(title(x))}</b><small>${esc(x.city || fmtPhone(x.phone))}</small></span></button>`).join("")}</div>` : ""}`
      : `<div class="mp-empty"><b>File d'appels vide 🎉</b><span>Tu as appelé tout le monde. Trouve de nouveaux prospects sur Google Maps.</span><button class="btn primary" data-go="prospect">${SV(IC.pin, 18)}Trouver des leads</button></div>`}`;
    const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
    $("#ms-list").onchange = (e) => { D.list = e.target.value; $("#dl-list").value = D.list; loadQueue(); };
    on("#ms-go", async () => {
      buzz(20);
      if (D.cfg && !D.cfg.enabled && l.phone) { location.href = "tel:" + l.phone; return; }
      await startCall(); renderSess();
    });
    on("#ms-skip", () => { buzz(); nextLead(true); });
    on("#ms-card", () => openLead(l.id));
    on("#ms-script", () => {
      bModal({ title: "Script d'appel", cancel: "Fermer", width: 560, body: `<div class="ms-scr">${typeof renderScript === "function" ? renderScript(l) : ""}</div>` });
    });
    $$("#msess [data-pick]").forEach((b) => (b.onclick = () => { if (busy) return; buzz(); D.cur = D.queue.find((x) => x.id === Number(b.dataset.pick)); renderQueue(); renderCall(); window.scrollTo({ top: 0, behavior: "smooth" }); }));
  }
  const _renderCall = window.renderCall;
  window.renderCall = function () { _renderCall.apply(this, arguments); renderSess(); };
  const _loadStats = window.loadStats;
  window.loadStats = async function () { await _loadStats.apply(this, arguments); refreshStats(); };

  // un RDV décroché = fête
  const _outcome = window.phoneOutcome;
  if (typeof _outcome === "function") window.phoneOutcome = async function (k) {
    const r = await _outcome.apply(this, arguments);
    if (k === "rdv" && typeof window.confetti === "function") { window.confetti(160); buzz([30, 60, 30]); toast("🎉 Rendez-vous décroché, bravo !"); }
    else buzz(10);
    refreshStats();
    return r;
  };

  /* ---------- Fiche prospect : étape en pastilles, infos repliées ---------- */
  const _renderLead = window.renderLead;
  window.renderLead = async function () {
    await _renderLead.apply(this, arguments);
    if (!mob() || !LD.lead) return;
    const sel = $("#ld-stage"); if (!sel) return;
    const chips = document.createElement("div");
    chips.className = "ld-chips";
    chips.innerHTML = [...sel.options].map((o, i) => `<button type="button" data-v="${esc(o.value)}" class="${o.selected ? "on" : ""}" style="--c:${STAGE_COL[i % STAGE_COL.length]}">${esc(o.textContent)}</button>`).join("");
    sel.closest(".ld-stage").prepend(chips);
    chips.onclick = (e) => { const b = e.target.closest("[data-v]"); if (!b) return; buzz(); sel.value = b.dataset.v; sel.dispatchEvent(new Event("change")); chips.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); if (b.dataset.v === "gagne" && window.confetti) window.confetti(120); };
    const grid = $("#ld-body .ld-grid");
    if (grid && !grid.closest("details")) {
      const det = document.createElement("details");
      det.className = "ld-more";
      det.innerHTML = `<summary>Coordonnées et notes</summary>`;
      grid.before(det); det.appendChild(grid);
    }
  };

  window.addEventListener("load", () => {
    if ($("#v-pipeline").classList.contains("on")) renderMobilePipe();
    window.matchMedia("(max-width: 860px)").addEventListener("change", () => { renderMobilePipe(); renderSess(); });
  });
})();
