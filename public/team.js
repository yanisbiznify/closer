/* Équipe : accès par fonctionnalité + gestion des comptes dans les Réglages */
(() => {
const TM = { users: [], features: [], roles: {}, ownerEmail: "" };
const ALL_VIEWS = ["dashboard", "revenue", "goals", "pipeline", "prospect", "conversations", "automations", "sites", "calendar", "billing", "dialer", "leads", "calls", "objections", "coach", "import", "settings"];

function applyPerms(me) {
  const views = me.views || ALL_VIEWS;
  const hide = ALL_VIEWS.filter((v) => !views.includes(v));
  let st = document.getElementById("perm-style");
  if (!st) { st = document.createElement("style"); st.id = "perm-style"; document.head.appendChild(st); }
  st.textContent = hide.map((v) => `#nav [data-v="${v}"],#tabbar [data-tab="${v}"],.more-grid [data-v="${v}"],[data-go="${v}"],[data-go-tab="${v}"]`).join(",") + (hide.length ? "{display:none!important}" : "");
  const perms = new Set((me.user && me.user.perms) || []);
  document.body.classList.toggle("no-settings", !perms.has("settings"));
  document.body.classList.toggle("no-coach", !perms.has("coach"));
  // qui est connecté
  const foot = $("#side .foot");
  if (foot && me.user && !$("#me-chip")) {
    const c = document.createElement("div");
    c.id = "me-chip"; c.className = "me-chip";
    c.innerHTML = `<span class="me-av">${esc((me.user.name || "?").slice(0, 1).toUpperCase())}</span><span><b>${esc(me.user.name || "")}</b><small>${esc(me.user.roleLabel || "")}</small></span>`;
    foot.prepend(c);
  }
  if (perms.has("team")) initTeam();
}

function initTeam() {
  if ($("#tm-panel")) return;
  const p = document.createElement("div");
  p.className = "panel"; p.id = "tm-panel"; p.style.marginTop = "18px";
  p.innerHTML = `<div class="panel-h"><h2>Équipe et accès</h2><button class="btn primary sm" id="tm-add">Ajouter un compte</button></div><div class="panel-b" id="tm-body"><div class="skeleton" style="width:40%"></div></div>`;
  const sec = $("#v-settings");
  const anchor = $("#v-settings .grid.g-2");
  if (anchor) anchor.before(p); else sec.appendChild(p);
  $("#tm-add").onclick = () => editUser(null);
  loadTeam();
}

async function loadTeam() {
  try { Object.assign(TM, await api("/users")); } catch (e) { $("#tm-body").innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  renderTeam();
}
const roleLabel = (r) => (TM.roles[r] || {}).label || r;
const ago = (d) => { if (!d) return "Jamais connecté"; const m = Math.round((Date.now() - new Date(d)) / 60000); return m < 60 ? `Vu il y a ${Math.max(1, m)} min` : m < 1440 ? `Vu il y a ${Math.round(m / 60)} h` : `Vu le ${new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}`; };

function renderTeam() {
  const me = window.__me && window.__me.user;
  const rows = [
    `<li class="tm-row"><span class="me-av">${esc((TM.ownerEmail || "?")[0].toUpperCase())}</span><div class="tm-t"><b>Compte principal</b><span>${esc(TM.ownerEmail || "")}</span></div><span class="tm-role owner">Propriétaire</span><span class="tm-perm">Tout</span><span></span></li>`,
    ...TM.users.map((u) => `<li class="tm-row ${u.active ? "" : "off"}" data-id="${u.id}">
      <span class="me-av">${esc(u.name[0].toUpperCase())}</span>
      <div class="tm-t"><b>${esc(u.name)}${me && me.id === u.id ? " (toi)" : ""}</b><span>${esc(u.email)} · ${u.active ? esc(ago(u.lastLogin)) : "Désactivé"}</span></div>
      <span class="tm-role">${esc(roleLabel(u.role))}</span>
      <span class="tm-perm">${u.role === "admin" ? "Tout" : `${u.perms.length} accès`}</span>
      <button class="btn ghost sm" data-edit="${u.id}">Modifier</button></li>`),
  ];
  $("#tm-body").innerHTML = `<p class="muted small" style="margin:0 0 12px">Chaque personne se connecte avec son email et son mot de passe sur la même page de connexion. Elle ne voit que les fonctionnalités que tu coches.</p><ul class="tm-list">${rows.join("")}</ul>
    ${TM.users.length ? "" : `<p class="small muted" style="margin:12px 0 0">Aucun autre compte pour l'instant.</p>`}`;
  $$("#tm-body [data-edit]").forEach((b) => (b.onclick = () => editUser(TM.users.find((u) => u.id === Number(b.dataset.edit)))));
}

function genPass() {
  const a = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const r = crypto.getRandomValues(new Uint32Array(12));
  return [...r].map((x) => a[x % a.length]).join("");
}

function editUser(u) {
  const isNew = !u;
  const role = u ? u.role : "commercial";
  const perms = new Set(u ? u.perms : TM.roles.commercial.perms);
  const pw = isNew ? genPass() : "";
  const close = bModal({
    title: isNew ? "Nouveau compte" : `Modifier ${u.name}`,
    sub: isNew ? "La personne se connectera avec cet email et ce mot de passe." : "",
    go: isNew ? "Créer le compte" : "Enregistrer", width: 640,
    body: `
      <div class="grid" style="grid-template-columns:1fr 1fr;gap:12px">
        <div class="field"><label for="tu-name">Prénom et nom</label><input id="tu-name" value="${esc(u ? u.name : "")}" autocomplete="off"></div>
        <div class="field"><label for="tu-email">Email</label><input id="tu-email" type="email" value="${esc(u ? u.email : "")}" autocomplete="off"></div>
      </div>
      <div class="field"><label for="tu-pass">${isNew ? "Mot de passe" : "Nouveau mot de passe (laisse vide pour ne pas le changer)"}</label>
        <div style="display:flex;gap:8px"><input id="tu-pass" value="${esc(pw)}" autocomplete="new-password" spellcheck="false" style="font-family:ui-monospace,monospace"><button type="button" class="btn ghost" id="tu-gen">Générer</button><button type="button" class="btn ghost" id="tu-copy">Copier</button></div>
        ${isNew ? `<div class="hint">Copie-le et envoie-le à la personne : il ne sera plus affiché ensuite.</div>` : ""}</div>
      <div class="field"><label>Rôle</label><div class="tm-roles">${Object.entries(TM.roles).map(([k, r]) => `<button type="button" data-role="${k}" class="${k === role ? "on" : ""}"><b>${esc(r.label)}</b><span>${esc(r.desc)}</span></button>`).join("")}</div></div>
      <div class="field"><label>Fonctionnalités autorisées</label><div class="tm-feats" id="tu-feats">${TM.features.map((f) => `<label class="tm-f"><input type="checkbox" value="${f.key}" ${perms.has(f.key) || role === "admin" ? "checked" : ""} ${role === "admin" ? "disabled" : ""}><span><b>${esc(f.label)}</b><small>${esc(f.desc)}</small></span></label>`).join("")}</div></div>
      ${isNew ? "" : `<div class="toggle" style="margin-top:6px"><div><b>Compte actif</b><p>Désactivé, la personne est déconnectée et ne peut plus se connecter.</p></div><label class="switch"><input type="checkbox" id="tu-active" ${u.active ? "checked" : ""}><span></span></label></div>
        <div style="margin-top:14px"><button type="button" class="btn quiet" id="tu-del" style="color:var(--bad)">Supprimer ce compte</button></div>`}
      <div id="tu-err" class="small c-bad" role="alert" style="min-height:16px;margin-top:8px"></div>`,
    onGo: async () => {
      const body = {
        name: $("#tu-name").value.trim(), email: $("#tu-email").value.trim(),
        role: ($("#bm-body [data-role].on") || {}).dataset.role || "custom",
        perms: [...$$("#tu-feats input:checked")].map((x) => x.value),
      };
      const p = $("#tu-pass").value.trim(); if (p) body.password = p;
      if (!isNew) body.active = $("#tu-active").checked;
      try {
        await api(isNew ? "/users" : `/users/${u.id}`, { method: isNew ? "POST" : "PUT", body: JSON.stringify(body) });
        toast(isNew ? `Compte créé pour ${body.name}` : "Compte mis à jour");
        loadTeam();
      } catch (e) { $("#tu-err").textContent = e.message; return false; }
    },
  });
  const feats = () => $$("#tu-feats input");
  $$("#bm-body [data-role]").forEach((b) => (b.onclick = () => {
    $$("#bm-body [data-role]").forEach((x) => x.classList.toggle("on", x === b));
    const r = b.dataset.role;
    if (r === "custom") { feats().forEach((x) => (x.disabled = false)); return; }
    const set = new Set(TM.roles[r].perms);
    feats().forEach((x) => { x.checked = r === "admin" || set.has(x.value); x.disabled = r === "admin"; });
  }));
  // cocher à la main bascule en « Personnalisé » si ça ne correspond plus au rôle
  $("#tu-feats").onchange = () => {
    const on = $("#bm-body [data-role].on"); if (!on || on.dataset.role === "custom") return;
    const cur = [...$$("#tu-feats input:checked")].map((x) => x.value).sort().join();
    const ref = [...TM.roles[on.dataset.role].perms].sort().join();
    if (cur !== ref) { on.classList.remove("on"); $('#bm-body [data-role="custom"]').classList.add("on"); }
  };
  $("#tu-gen").onclick = () => { $("#tu-pass").value = genPass(); };
  $("#tu-copy").onclick = async () => { const v = $("#tu-pass").value; if (!v) return; try { await navigator.clipboard.writeText(v); toast("Mot de passe copié"); } catch { $("#tu-pass").select(); } };
  const del = $("#tu-del"); if (del) del.onclick = async () => {
    if (!confirm(`Supprimer le compte de ${u.name} ? La personne ne pourra plus se connecter.`)) return;
    try { await api(`/users/${u.id}`, { method: "DELETE" }); close(); toast("Compte supprimé"); loadTeam(); } catch (e) { $("#tu-err").textContent = e.message; }
  };
}
window.applyPerms = applyPerms;
})();
