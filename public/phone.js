/* Biznify — fenêtre d'appel flottante (utilisable depuis n'importe quelle page) */
const P = { cfg: null, device: null, call: null, sid: null, lead: null, phase: "idle", t0: 0, timer: null, muted: false, pad: false, script: false, min: false, onDone: null, showCb: false };
const P_OUT = [
  ["rdv", "Rendez-vous", "var(--good)"], ["rappel", "À rappeler", "var(--mid)"], ["pas_interesse", "Pas intéressé", "var(--bad)"],
  ["messagerie", "Messagerie", "var(--faint)"], ["barrage", "Barrage", "var(--faint)"], ["injoignable", "Pas de réponse", "var(--faint)"], ["mauvais_numero", "Mauvais numéro", "var(--faint)"],
];
const P_ICON_CALL = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>`;
const P_ICON_END = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 0 1-1.41-.02L.29 13.08a1 1 0 0 1 0-1.41C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67a1 1 0 0 1 0 1.41l-2.48 2.48a1 1 0 0 1-1.41.02 11.3 11.3 0 0 0-2.66-1.85 1 1 0 0 1-.56-.9v-3.1A15 15 0 0 0 12 9z"/></svg>`;

const pFmtPhone = (p) => (p || "").replace(/^\+33(\d)(\d{2})(\d{2})(\d{2})(\d{2})$/, "0$1 $2 $3 $4 $5");
const pClock = () => { const s = Math.max(0, Math.round((Date.now() - P.t0) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const pTitle = (l) => l.company || l.name || pFmtPhone(l.phone);
const pInitials = (l) => (pTitle(l) || "?").split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

async function phoneConfig(force) {
  if (!P.cfg || force) { try { P.cfg = await api("/dialer/config"); } catch (e) { P.cfg = { enabled: false, error: e.message, missing: [] }; } }
  return P.cfg;
}

async function phoneDevice() {
  if (P.device) return P.device;
  if (!window.Twilio || !Twilio.Device) throw new Error("Le module d'appel ne s'est pas chargé. Recharge la page.");
  const { token } = await api("/dialer/token");
  const dev = new Twilio.Device(token, { codecPreferences: ["opus", "pcmu"], closeProtection: "Un appel est en cours. Quitter la page va le couper." });
  dev.on("tokenWillExpire", async () => { try { dev.updateToken((await api("/dialer/token")).token); } catch {} });
  dev.on("error", (e) => toast(e.message || "Erreur du dialer"));
  P.device = dev;
  return dev;
}

const phoneBusy = () => ["connecting", "incall", "wrap"].includes(P.phase);

async function phoneCall(lead, { onDone } = {}) {
  if (phoneBusy()) { P.min = false; renderPhone(); toast("Termine d'abord l'appel en cours"); return false; }
  if (!lead || !lead.phone) { toast("Ce prospect n'a pas de numéro de téléphone"); return false; }
  P.lead = lead; P.onDone = onDone || null; P.min = false; P.muted = false; P.pad = false; P.showCb = false; P.t0 = 0; P.sid = null;
  const cfg = await phoneConfig();
  if (!cfg.enabled) { P.phase = "setup"; renderPhone(); return false; }
  P.phase = "connecting"; renderPhone();
  try {
    const dev = await phoneDevice();
    const call = await dev.connect({ params: { To: lead.phone, LeadId: String(lead.id || "") } });
    P.call = call;
    call.on("accept", (c) => {
      P.sid = (c.parameters && c.parameters.CallSid) || P.sid;
      P.phase = "incall"; P.t0 = Date.now(); renderPhone();
      clearInterval(P.timer); P.timer = setInterval(() => { const t = $("#ph-timer"); if (t) t.textContent = pClock(); }, 500);
    });
    ["disconnect", "cancel", "reject"].forEach((ev) => call.on(ev, phoneEnded));
    call.on("error", (e) => toast(e.message || "Erreur pendant l'appel"));
    return true;
  } catch (e) {
    toast(e.message || "Impossible de lancer l'appel");
    P.phase = "idle"; renderPhone();
    return false;
  }
}

function phoneEnded() {
  if (P.phase === "wrap" || P.phase === "idle") return;
  clearInterval(P.timer);
  if (P.call && P.call.parameters && P.call.parameters.CallSid) P.sid = P.call.parameters.CallSid;
  P.call = null; P.phase = "wrap"; P.min = false; renderPhone();
  document.dispatchEvent(new CustomEvent("phone-state"));
}

async function phoneOutcome(k, cbLocal) {
  const l = P.lead; if (!l) return;
  const notes = $("#ph-notes") ? $("#ph-notes").value : undefined;
  const body = { outcome: k, notes, callSid: P.sid };
  if (k === "rappel") {
    if (!cbLocal) { P.showCb = true; renderPhone(); return; }
    body.callbackAt = new Date(cbLocal).toISOString();
  }
  let r;
  try { r = await api(`/leads/${l.id}/outcome`, { method: "POST", body: JSON.stringify(body) }); }
  catch (e) { toast(e.message); return; }
  const label = (P_OUT.find((o) => o[0] === k) || [])[1];
  toast(r.ghl && r.ghl.ok === false ? `${label}. La note GHL n'a pas pu être ajoutée.` : `${label}${r.ghl && r.ghl.ok ? ", noté dans GHL" : ""}`);
  const done = P.onDone;
  P.phase = "idle"; P.lead = null; P.onDone = null; renderPhone();
  document.dispatchEvent(new CustomEvent("lead-updated", { detail: r.lead }));
  if (typeof refresh === "function") refresh();
  if (done) done(k, r.lead);
  if (k === "rdv" && typeof openBooking === "function") setTimeout(() => openBooking({ lead: r.lead }), 350);
}

function phoneClose() {
  if (P.phase === "connecting" || P.phase === "incall") return;
  P.phase = "idle"; P.lead = null; P.onDone = null; renderPhone();
  document.dispatchEvent(new CustomEvent("phone-state"));
}

function renderPhone() {
  const el = $("#phone");
  if (P.phase === "idle" || !P.lead) { el.className = "phone"; el.innerHTML = ""; return; }
  const l = P.lead;
  el.className = "phone on" + (P.min ? " min" : "");
  const head = `<div class="ph-h">
    <div class="ph-av">${esc(pInitials(l))}</div>
    <div class="ph-t"><b>${esc(pTitle(l))}</b><span>${esc([l.company && l.name ? l.name : "", pFmtPhone(l.phone)].filter(Boolean).join(", "))}</span></div>
    ${P.phase === "incall" ? `<span class="ph-live" id="ph-timer">${pClock()}</span>` : ""}
    <button class="btn quiet ph-ic" id="ph-min" aria-label="${P.min ? "Agrandir" : "Réduire"}">${P.min ? "▴" : "▾"}</button>
    ${P.phase === "setup" || P.phase === "wrap" ? `<button class="btn quiet ph-ic" id="ph-x" aria-label="Fermer">✕</button>` : ""}
  </div>`;
  let body = "";
  if (P.phase === "setup") {
    const c = P.cfg || {};
    body = `<div class="ph-b"><p style="margin:0 0 8px"><b>${c.error ? "Twilio ne répond pas" : "Le dialer n'est pas encore connecté"}</b></p>
      <p class="muted small" style="margin:0">${c.error ? esc(c.error) : `Ajoute dans Railway : ${(c.missing || []).map(esc).join(", ")}. Biznify configure le reste tout seul.`}</p>
      <div style="margin-top:12px">${l.phone ? `<a class="btn ghost" href="tel:${esc(l.phone)}">Appeler avec mon téléphone</a>` : ""}</div></div>`;
  } else if (P.phase === "connecting" || P.phase === "incall") {
    body = `<div class="ph-b">
      <div class="ph-state">${P.phase === "incall" ? `<span class="live"></span>En ligne` : `<span class="spin"></span>Appel en cours…`}</div>
      <div class="ph-ctrls">
        <button class="ph-c ${P.muted ? "on" : ""}" id="ph-mute"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>${P.muted ? '<path d="M3 3l18 18"/>' : ""}</svg><span>${P.muted ? "Micro coupé" : "Micro"}</span></button>
        <button class="ph-c ${P.pad ? "on" : ""}" id="ph-pad"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="5" r="1.7"/><circle cx="12" cy="5" r="1.7"/><circle cx="18" cy="5" r="1.7"/><circle cx="6" cy="11" r="1.7"/><circle cx="12" cy="11" r="1.7"/><circle cx="18" cy="11" r="1.7"/><circle cx="12" cy="17" r="1.7"/></svg><span>Clavier</span></button>
        <button class="ph-c ${P.script ? "on" : ""}" id="ph-script"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg><span>Script</span></button>
        <button class="ph-c end" id="ph-end">${P_ICON_END}<span>Raccrocher</span></button>
      </div>
      ${P.pad ? `<div class="ph-pad">${[["1",""],["2","ABC"],["3","DEF"],["4","GHI"],["5","JKL"],["6","MNO"],["7","PQRS"],["8","TUV"],["9","WXYZ"],["*",""],["0","+"],["#",""]].map(([k, l]) => `<button data-k="${k}"><b>${k}</b><small>${l}</small></button>`).join("")}</div><div class="ph-digits" id="ph-digits"></div>` : ""}
      ${P.script ? `<div class="ph-script">${typeof renderScript === "function" ? renderScript(l) : ""}</div>` : ""}
      <textarea id="ph-notes" placeholder="Notes pendant l'appel…" style="margin-top:12px;min-height:64px;font-size:13px">${esc(l.notes || "")}</textarea>
    </div>`;
  } else if (P.phase === "wrap") {
    const tomorrow = new Date(Date.now() + 864e5); tomorrow.setHours(10, 0, 0, 0);
    const local = new Date(tomorrow - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    body = `<div class="ph-b">
      <div class="ph-state">Appel terminé${P.t0 ? `, ${pClock()}` : ""}</div>
      <div class="ph-out">${P_OUT.map(([k, lab, c], i) => `<button data-out="${k}" class="${k === "rdv" ? "rdv" : ""}"><span class="dot" style="background:${c}"></span>${lab}<span class="k">${i + 1}</span></button>`).join("")}</div>
      ${P.showCb ? `<div style="margin-top:10px"><label class="small muted" for="ph-cbat">Rappeler le</label><div style="display:flex;gap:8px;margin-top:6px"><input type="datetime-local" id="ph-cbat" value="${local}"><button class="btn primary" id="ph-cbok">Valider</button></div></div>` : ""}
      <textarea id="ph-notes" placeholder="Notes sur l'appel…" style="margin-top:12px;min-height:64px;font-size:13px">${esc(l.notes || "")}</textarea>
    </div>`;
  }
  el.innerHTML = head + (P.min ? "" : body);
  const on = (id, fn) => { const b = $(id); if (b) b.onclick = fn; };
  on("#ph-min", () => { P.min = !P.min; renderPhone(); });
  on("#ph-x", phoneClose);
  on("#ph-end", () => P.call ? P.call.disconnect() : phoneEnded());
  on("#ph-mute", () => { if (!P.call) return; P.muted = !P.muted; P.call.mute(P.muted); renderPhone(); });
  on("#ph-pad", () => { P.pad = !P.pad; P.digits = ""; renderPhone(); });
  on("#ph-script", () => { P.script = !P.script; renderPhone(); });
  on("#ph-cbok", () => phoneOutcome("rappel", $("#ph-cbat").value));
  const kp = el.querySelector(".ph-pad"); if (kp) kp.onclick = (e) => {
    const b = e.target.closest("[data-k]"); if (!b) return;
    if (P.call) P.call.sendDigits(b.dataset.k);
    P.digits = ((P.digits || "") + b.dataset.k).slice(-24);
    const d = $("#ph-digits"); if (d) d.textContent = P.digits;
  };
  const oc = el.querySelector(".ph-out"); if (oc) oc.onclick = (e) => { const b = e.target.closest("[data-out]"); if (b) phoneOutcome(b.dataset.out); };
  const n = $("#ph-notes"); if (n) n.oninput = () => { l.notes = n.value; };
}

document.addEventListener("keydown", (e) => {
  if (P.phase !== "wrap" || P.min) return;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
  const i = parseInt(e.key);
  if (i >= 1 && i <= P_OUT.length) { e.preventDefault(); phoneOutcome(P_OUT[i - 1][0]); }
});
