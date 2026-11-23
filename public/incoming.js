/* Réglages : appels entrants dans Biznify */
(() => {
  async function initIncoming() {
    if ($("#inc-panel") || document.body.classList.contains("no-settings")) return;
    const p = document.createElement("div");
    p.className = "panel"; p.id = "inc-panel"; p.style.marginTop = "18px";
    p.innerHTML = `<div class="panel-h"><div><h2>Appels entrants</h2><div class="sub">Quand on appelle ton numéro Biznify, ça sonne dans l'app.</div></div></div><div class="panel-b" id="inc-body"><div class="skeleton" style="width:40%"></div></div>`;
    const anchor = $("#v-settings .grid.g-2");
    if (anchor) anchor.before(p); else $("#v-settings").appendChild(p);
    let c;
    try { c = await api("/incoming/config"); } catch (e) { $("#inc-body").innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
    render(c);
  }
  function render(c) {
    const b = $("#inc-body");
    if (!c.twilio) { b.innerHTML = `<p class="muted small" style="margin:0">Connecte d'abord Twilio (dialer) pour recevoir des appels.</p>`; return; }
    b.innerHTML = `
      ${c.error ? `<p class="small c-bad" style="margin:0 0 10px">${esc(c.error)}</p>` : ""}
      <div class="toggle"><div><b>Recevoir les appels du ${esc(fmtPhone(c.number || ""))} dans Biznify</b><p>${c.enabled ? "Activé : l'app sonne quand elle est ouverte, sur ordinateur ou téléphone." : "Désactivé : ton numéro garde son réglage actuel."}</p></div>
        <label class="switch"><input type="checkbox" id="inc-on" ${c.enabled ? "checked" : ""}><span></span></label></div>
      <div class="grid" style="grid-template-columns:1fr 160px;gap:12px;margin-top:14px">
        <div class="field"><label for="inc-fwd">Mon portable, si je ne réponds pas dans l'app</label><input id="inc-fwd" type="tel" inputmode="tel" placeholder="06 12 34 56 78" value="${esc(c.forwardTo || "")}"></div>
        <div class="field"><label for="inc-sec">Sonnerie dans l'app</label><select id="inc-sec">${[15, 20, 25, 30, 40].map((n) => `<option value="${n}" ${Number(c.ringSeconds) === n ? "selected" : ""}>${n} secondes</option>`).join("")}</select></div>
      </div>
      <div class="field"><label>Quand faire sonner le portable</label><div class="inc-opts">
        ${[["after", "Si personne ne répond dans l'app", "L'app sonne d'abord, puis ton portable"], ["together", "En même temps que l'app", "Le premier qui décroche prend l'appel"], ["never", "Jamais", "Directement la messagerie si personne ne répond"]].map(([k, t, d]) => `<label><input type="radio" name="inc-ring" value="${k}" ${c.ringMobile === k ? "checked" : ""}><span><b>${t}</b><small>${d}</small></span></label>`).join("")}
      </div></div>
      <div class="toggle"><div><b>Messagerie vocale</b><p>Le message arrive dans ton tableau de bord, avec une notification.</p></div><label class="switch"><input type="checkbox" id="inc-vm" ${c.voicemail ? "checked" : ""}><span></span></label></div>
      <div class="field" style="margin-top:10px"><label for="inc-greet">Message d'accueil de la messagerie</label><textarea id="inc-greet" rows="2" placeholder="Bonjour, vous êtes bien chez Biznify. Laissez votre nom et votre numéro après le bip, nous vous rappelons rapidement.">${esc(c.greeting || "")}</textarea></div>
      <div style="display:flex;gap:10px;align-items:center"><button class="btn primary" id="inc-save">Enregistrer</button><span class="small muted" id="inc-msg" role="status"></span></div>`;
    const send = async (extra) => {
      const body = { forwardTo: $("#inc-fwd").value, ringSeconds: Number($("#inc-sec").value), ringMobile: ($("input[name=inc-ring]:checked") || {}).value, voicemail: $("#inc-vm").checked, greeting: $("#inc-greet").value, ...extra };
      $("#inc-msg").textContent = "Enregistrement…";
      try {
        const r = await api("/incoming/config", { method: "PUT", body: JSON.stringify(body) });
        render({ ...c, ...r, twilio: true, number: c.number });
        $("#inc-msg").textContent = "Enregistré";
        if (extra && extra.enabled) { toast("C'est branché : appelle ton numéro pour tester"); if (typeof phoneListen === "function") phoneListen(); }
      } catch (e) { $("#inc-msg").textContent = ""; toast(e.message); if (extra) $("#inc-on").checked = !extra.enabled; }
    };
    $("#inc-on").onchange = (e) => send({ enabled: e.target.checked });
    $("#inc-save").onclick = () => send();
  }
  const _show = window.show;
  window.show = function (v) { const r = _show.apply(this, arguments); if (v === "settings") initIncoming(); return r; };
  window.addEventListener("load", () => { if (location.hash === "#settings") setTimeout(initIncoming, 1500); });
})();
