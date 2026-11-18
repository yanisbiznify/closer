/* Biznify — AI Studio : sites web générés par l'IA */
const ST = { list: [], cf: null, cur: null, poll: null, device: "desktop" };

const stStatus = (s) => s.job ? `<span class="st-chip work"><span class="spin"></span>${esc(s.has_html ? "L'IA modifie le site" : "Création en cours")}</span>`
  : s.published_at ? (s.changed ? `<span class="st-chip warn">En ligne · modifs non publiées</span>` : `<span class="st-chip ok">En ligne</span>`)
  : s.has_html ? `<span class="st-chip">Prêt à publier</span>` : s.job_error ? `<span class="st-chip bad">Erreur</span>` : `<span class="st-chip">Brouillon</span>`;

async function loadSites() {
  if (ST.cur) return openSite(ST.cur.id);
  try { const r = await api("/sites"); ST.list = r.sites; ST.cf = r.cloudflare; } catch (e) { $("#st-cards").innerHTML = `<div class="panel"><div class="panel-b muted">${esc(e.message)}</div></div>`; return; }
  $("#st-cf").innerHTML = ST.cf.connected ? `<span class="dot-ok"></span>Cloudflare connecté` : "Connecter Cloudflare";
  $("#st-cf").onclick = openCloudflare;
  $("#st-new").onclick = openNewSite;
  $("#st-cards").innerHTML = ST.list.length ? `<div class="st-grid">${ST.list.map((s) => `
    <button class="st-card" data-open="${s.id}">
      <div class="st-thumb">${s.has_html ? `<iframe src="/api/sites/${s.id}/preview" loading="lazy" tabindex="-1" aria-hidden="true" sandbox></iframe>` : `<div class="st-thumb-empty">${s.job ? `<span class="spin"></span>L'IA crée le site…` : "Pas encore de site"}</div>`}</div>
      <div class="st-meta"><b>${esc(s.name)}</b><span class="small muted">${esc([s.brief.activity, s.brief.city].filter(Boolean).join(" · "))}</span>
        <div class="st-row">${stStatus(s)}${s.submissions_count ? `<span class="small muted">${s.submissions_count} demande${s.submissions_count > 1 ? "s" : ""}</span>` : ""}</div>
        ${s.custom_domain || s.url ? `<span class="small st-url">${esc(s.custom_domain || s.url.replace("https://", ""))}</span>` : ""}</div>
    </button>`).join("")}</div>`
    : `<div class="panel"><div class="panel-b st-empty"><h3>Ton premier site en 2 minutes</h3><p class="muted">Décris l'entreprise de ton client : l'IA crée un site complet, prêt à être publié et à recevoir des demandes de devis.</p><button class="btn primary" id="st-new2">Créer un site</button></div></div>`;
  const n2 = $("#st-new2"); if (n2) n2.onclick = openNewSite;
  $$("#st-cards [data-open]").forEach((b) => (b.onclick = () => openSite(Number(b.dataset.open))));
  clearTimeout(ST.poll);
  if (ST.list.some((s) => s.job)) ST.poll = setTimeout(() => { if ($("#v-sites").classList.contains("on") && !ST.cur) loadSites(); }, 4000);
}

/* ---------- Images : réduites dans le navigateur avant l'envoi ---------- */
function stShrink(file, max = 1800) {
  return new Promise((resolve, reject) => {
    if (file.type === "image/svg+xml") { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); return; }
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      const png = file.type === "image/png" && file.size < 400000;
      resolve(c.toDataURL(png ? "image/png" : "image/jpeg", 0.84));
    };
    img.onerror = () => reject(new Error(`Image illisible : ${file.name}`));
    img.src = url;
  });
}

/* ---------- Nouveau site ---------- */
function openNewSite() {
  const f = (id, label, ph = "", type = "text", req = false) => `<div class="field"><label for="${id}">${label}${req ? " *" : ""}</label><input id="${id}" type="${type}" placeholder="${esc(ph)}" ${req ? "required" : ""}></div>`;
  const t = (id, label, ph = "") => `<div class="field"><label for="${id}">${label}</label><textarea id="${id}" rows="3" placeholder="${esc(ph)}"></textarea></div>`;
  bModal({ title: "Nouveau site", sub: "Plus tu donnes de détails, plus le site sera juste. Seuls les deux premiers champs sont obligatoires.", go: "Créer le site avec l'IA", width: 680, body: `
    <div class="st-form">
      <div class="g2">${f("sn-company", "Nom de l'entreprise", "Plomberie Martin", "text", true)}${f("sn-activity", "Activité", "Plombier chauffagiste", "text", true)}</div>
      <div class="g2">${f("sn-city", "Ville et zone d'intervention", "Tours et 30 km autour")}${f("sn-phone", "Téléphone", "06 12 34 56 78", "tel")}</div>
      ${t("sn-services", "Services proposés", "Dépannage fuite 7j/7, installation chaudière, salle de bain clé en main…")}
      ${t("sn-proofs", "Points forts et preuves", "15 ans d'expérience, certifié RGE, devis gratuit sous 24 h, garantie décennale…")}
      <div class="g2">${f("sn-email", "Email de l'entreprise", "contact@plomberie-martin.fr", "email")}${f("sn-hours", "Horaires", "Lun–Sam 8h–19h, urgences 24/7")}</div>
      ${f("sn-address", "Adresse (optionnel)", "12 rue Nationale, 37000 Tours")}
      <div class="g2">${f("sn-colors", "Couleurs de marque", "Bleu marine et orange")}${f("sn-style", "Ambiance", "Sérieux et rassurant, artisan de confiance")}</div>
      ${f("sn-goal", "Objectif du site", "Recevoir des demandes de devis et des appels")}
      <div class="g2">
        <div class="field"><label for="sn-logo">Logo</label><input id="sn-logo" type="file" accept="image/*"></div>
        <div class="field"><label for="sn-photos">Photos (chantiers, équipe, boutique)</label><input id="sn-photos" type="file" accept="image/*" multiple></div>
      </div>
      ${t("sn-notes", "Autres infos pour l'IA", "Zones précises, marques utilisées, ce qui le différencie, textes à reprendre…")}
      <div class="field"><label for="sn-notify">Où envoyer les demandes reçues par le site ?</label><input id="sn-notify" type="email" placeholder="Email du client (par défaut : l'email de l'entreprise)"></div>
      <label class="st-check"><input type="checkbox" id="sn-pipe"> C'est mon propre site : ajouter aussi les demandes à mon pipeline</label>
      <div id="sn-err" class="small c-bad" role="alert"></div>
    </div>`,
    onGo: async () => {
      const v = (id) => $(id).value.trim();
      const brief = { company: v("#sn-company"), activity: v("#sn-activity"), city: v("#sn-city"), phone: v("#sn-phone"), services: v("#sn-services"), proofs: v("#sn-proofs"), email: v("#sn-email"), hours: v("#sn-hours"), address: v("#sn-address"), colors: v("#sn-colors"), style: v("#sn-style"), goal: v("#sn-goal"), notes: v("#sn-notes") };
      if (!brief.company || !brief.activity) { $("#sn-err").textContent = "Indique le nom de l'entreprise et son activité"; return false; }
      try {
        const files = [];
        const logo = $("#sn-logo").files[0]; if (logo) files.push({ role: "logo", name: logo.name, data: await stShrink(logo, 800) });
        for (const p of [...$("#sn-photos").files].slice(0, 10)) files.push({ role: "photo", name: p.name, data: await stShrink(p) });
        const r = await api("/sites", { method: "POST", body: JSON.stringify({ brief, notify_email: v("#sn-notify"), to_pipeline: $("#sn-pipe").checked, defer: true }) });
        for (const fl of files) await api(`/sites/${r.site.id}/assets`, { method: "POST", body: JSON.stringify(fl) });
        await api(`/sites/${r.site.id}/regenerate`, { method: "POST", body: "{}" });
        toast("L'IA crée le site, ça prend environ 1 à 2 minutes");
        setTimeout(() => openSite(r.site.id), 50);
      } catch (e) { $("#sn-err").textContent = e.message; return false; }
    } });
}

/* ---------- Éditeur ---------- */
async function openSite(id) {
  let r;
  try { r = await api(`/sites/${id}`); } catch (e) { toast(e.message); ST.cur = null; return loadSites(); }
  const s = r.site; ST.cf = r.cloudflare;
  const first = !ST.cur || ST.cur.id !== s.id;
  const wasBusy = ST.cur && ST.cur.job;
  ST.cur = s;
  $("#st-list").hidden = true; $("#st-editor").hidden = false;
  if (first) renderEditor();
  else updateEditor(wasBusy && !s.job);
  clearTimeout(ST.poll);
  if (s.job) ST.poll = setTimeout(() => { if (ST.cur && ST.cur.id === s.id && $("#v-sites").classList.contains("on")) openSite(s.id); }, 3000);
}
function closeEditor() {
  clearTimeout(ST.poll); ST.cur = null;
  $("#st-editor").hidden = true; $("#st-editor").innerHTML = ""; $("#st-list").hidden = false; loadSites();
}
function renderEditor() {
  const s = ST.cur;
  $("#st-editor").innerHTML = `
    <div class="st-top">
      <button class="btn quiet" id="se-back" aria-label="Retour aux sites"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>Sites</button>
      <div class="st-title"><h1>${esc(s.name)}</h1><span id="se-status"></span></div>
      <div class="actions">
        <div class="seg" role="group" aria-label="Aperçu"><button data-dev="desktop" class="${ST.device === "desktop" ? "on" : ""}">Ordinateur</button><button data-dev="mobile" class="${ST.device === "mobile" ? "on" : ""}">Mobile</button></div>
        <button class="btn ghost" id="se-settings">Réglages</button>
        <button class="btn primary" id="se-publish">Publier</button>
      </div>
    </div>
    <div class="st-work">
      <aside class="st-side">
        <div class="st-chat" id="se-chat" aria-live="polite"></div>
        <div class="st-sugg" id="se-sugg">${["Rends le titre plus percutant", "Ajoute une FAQ de 5 questions", "Change l'ambiance : plus haut de gamme", "Mets le téléphone plus en avant"].map((x) => `<button type="button">${esc(x)}</button>`).join("")}</div>
        <form class="st-ask" id="se-ask"><textarea id="se-msg" rows="3" placeholder="Dis à l'IA ce que tu veux changer… ex. « remplace la couleur orange par du vert sapin »" aria-label="Modification à faire"></textarea><button class="btn primary" id="se-send" type="submit">Envoyer</button></form>
        <div class="st-assets" id="se-assets"></div>
      </aside>
      <div class="st-stage"><div class="st-frame ${ST.device}" id="se-frame-wrap"><iframe id="se-frame" title="Aperçu du site" sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"></iframe><div class="st-busy" id="se-busy" hidden><span class="spin"></span><b id="se-busy-t"></b><span class="small muted">Ça prend en général 1 à 2 minutes.</span></div></div></div>
    </div>`;
  $("#se-back").onclick = closeEditor;
  $$("#st-editor [data-dev]").forEach((b) => (b.onclick = () => { ST.device = b.dataset.dev; $$("#st-editor [data-dev]").forEach((x) => x.classList.toggle("on", x === b)); $("#se-frame-wrap").className = `st-frame ${ST.device}`; }));
  $("#se-settings").onclick = openSiteSettings;
  $("#se-publish").onclick = publishSite;
  $("#se-ask").onsubmit = async (e) => {
    e.preventDefault();
    const msg = $("#se-msg").value.trim(); if (!msg) return $("#se-msg").focus();
    $("#se-send").disabled = true;
    try { await api(`/sites/${ST.cur.id}/edit`, { method: "POST", body: JSON.stringify({ instruction: msg }) }); $("#se-msg").value = ""; openSite(ST.cur.id); }
    catch (err) { toast(err.message); }
    $("#se-send").disabled = false;
  };
  $("#se-msg").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#se-ask").requestSubmit(); });
  $$("#se-sugg button").forEach((b) => (b.onclick = () => { $("#se-msg").value = b.textContent; $("#se-msg").focus(); }));
  updateEditor(true);
}
function updateEditor(reloadFrame) {
  const s = ST.cur;
  $("#se-status").innerHTML = stStatus(s);
  $("#se-publish").textContent = s.published_at ? (s.changed ? "Publier les modifs" : "En ligne") : "Publier";
  $("#se-publish").disabled = !s.has_html || !!s.job;
  $("#se-send").disabled = !!s.job;
  $("#se-busy").hidden = !s.job; $("#se-busy-t").textContent = s.job ? (s.has_html ? `L'IA applique : « ${s.job} »` : "L'IA crée le site…") : "";
  const hist = [...(s.versions || [])].reverse();
  $("#se-chat").innerHTML = (hist.length ? hist.map((v, i) => `<div class="st-msg"><div class="st-bub">${esc(v.note || "Version")}</div><div class="st-msg-meta"><span>${esc(new Date(v.created_at).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}</span>${i < hist.length - 1 ? `<button class="link" data-restore="${v.id}">Revenir à cette version</button>` : `<span>version actuelle</span>`}</div></div>`).join("") : `<p class="small muted">L'historique de tes demandes apparaîtra ici.</p>`)
    + (s.job_error && !s.job ? `<div class="callout" style="margin:10px 0 0"><div class="grow"><b>L'IA n'a pas pu terminer.</b><p>${esc(s.job_error)}</p></div></div>` : "");
  $("#se-chat").scrollTop = 1e6;
  $$("#se-chat [data-restore]").forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox("Revenir à cette version ? La version actuelle reste dans l'historique."))) return;
    try { await api(`/sites/${s.id}/versions/${b.dataset.restore}/restore`, { method: "POST", body: "{}" }); toast("Version restaurée"); ST.cur.job = "x"; openSite(s.id); } catch (e) { toast(e.message); }
  }));
  $("#se-assets").innerHTML = `<div class="st-assets-h"><b>Images</b><label class="btn quiet sm">Ajouter<input type="file" accept="image/*" multiple hidden id="se-up"></label></div>
    ${(s.assets || []).length ? `<div class="st-thumbs">${s.assets.map((a) => `<figure><img src="/api/sites/${s.id}/assets/${a.id}" alt="${esc(a.name || a.role)}"><figcaption>${a.role === "logo" ? "Logo" : "Photo"} ${a.id}</figcaption><button class="st-del" data-del="${a.id}" aria-label="Supprimer cette image">&times;</button></figure>`).join("")}</div><p class="small muted" style="margin:6px 0 0">Après un ajout, demande à l'IA de l'utiliser : « mets la photo ${s.assets[s.assets.length - 1].id} en haut de page ».</p>` : `<p class="small muted" style="margin:0">Aucune image. Sans photo, l'IA compose le visuel avec la typo et les couleurs.</p>`}`;
  $("#se-up").onchange = async (e) => {
    for (const f of [...e.target.files].slice(0, 10)) {
      try { await api(`/sites/${s.id}/assets`, { method: "POST", body: JSON.stringify({ role: "photo", name: f.name, data: await stShrink(f) }) }); } catch (err) { toast(err.message); }
    }
    toast("Images ajoutées"); openSite(s.id);
  };
  $$("#se-assets [data-del]").forEach((b) => (b.onclick = async () => { await api(`/sites/${s.id}/assets/${b.dataset.del}`, { method: "DELETE" }); openSite(s.id); }));
  if (reloadFrame && s.has_html) $("#se-frame").src = `/api/sites/${s.id}/preview?t=${Date.now()}`;
  else if (!s.has_html) $("#se-frame").removeAttribute("src");
}

/* ---------- Réglages du site ---------- */
function openSiteSettings() {
  const s = ST.cur;
  const subs = s.submissions || [];
  bModal({ title: "Réglages du site", width: 640, go: "Enregistrer", body: `
    <div class="field"><label for="ss-notify">Les demandes du formulaire sont envoyées à</label><input id="ss-notify" type="email" value="${esc(s.notify_email || "")}" placeholder="email du client"></div>
    <label class="st-check"><input type="checkbox" id="ss-pipe" ${s.to_pipeline ? "checked" : ""}> Ajouter aussi les demandes à mon pipeline</label>
    <h3 class="st-h3">Demandes reçues (${subs.length})</h3>
    ${subs.length ? `<div class="st-subs">${subs.map((x) => `<div class="st-sub"><b>${esc(x.data.nom || "Visiteur")}</b> <span class="small muted">${esc(new Date(x.created_at).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}</span><p class="small" style="margin:2px 0 0">${esc([x.data.telephone, x.data.email].filter(Boolean).join(" · "))}</p>${x.data.message ? `<p class="small muted" style="margin:2px 0 0">${esc(x.data.message)}</p>` : ""}</div>`).join("")}</div>` : `<p class="small muted">Aucune demande pour l'instant.</p>`}
    <h3 class="st-h3">Autres actions</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn ghost" href="/api/sites/${s.id}/download">Télécharger le HTML</a><button class="btn ghost" id="ss-regen">Nouvelle proposition de l'IA</button><button class="btn quiet" id="ss-del">Supprimer le site</button></div>`,
    onGo: async () => {
      try { await api(`/sites/${s.id}`, { method: "PUT", body: JSON.stringify({ notify_email: $("#ss-notify").value.trim(), to_pipeline: $("#ss-pipe").checked }) }); toast("Réglages enregistrés"); openSite(s.id); }
      catch (e) { toast(e.message); return false; }
    } });
  $("#ss-regen").onclick = async () => {
    if (!(await confirmBox("Demander à l'IA un site entièrement nouveau ? L'actuel reste dans l'historique."))) return;
    try { await api(`/sites/${s.id}/regenerate`, { method: "POST", body: "{}" }); $("#bm").classList.remove("on"); openSite(s.id); } catch (e) { toast(e.message); }
  };
  $("#ss-del").onclick = async () => {
    if (!(await confirmBox(s.cf_project ? "Supprimer ce site ? Il sera aussi retiré d'Internet." : "Supprimer ce site ?"))) return;
    await api(`/sites/${s.id}?cloudflare=1`, { method: "DELETE" }); $("#bm").classList.remove("on"); toast("Site supprimé"); closeEditor();
  };
}

/* ---------- Publication et domaine ---------- */
async function publishSite() {
  if (!ST.cf || !ST.cf.connected) return openCloudflare(publishSite);
  const s = ST.cur, b = $("#se-publish");
  b.disabled = true; b.innerHTML = `<span class="spin"></span>Publication`;
  try { const r = await api(`/sites/${s.id}/publish`, { method: "POST", body: "{}" }); toast("Site en ligne"); await openSite(s.id); showOnline(r.url); }
  catch (e) { toast(e.message); updateEditor(false); }
}
function showOnline(url) {
  const s = ST.cur, d = s.domain;
  bModal({ title: "Le site est en ligne", cancel: "Fermer", width: 600, body: `
    <div class="st-live"><span class="dot-ok"></span><a href="${esc(url || s.url)}" target="_blank" rel="noopener">${esc((url || s.url || "").replace("https://", ""))}</a><button class="btn quiet sm" id="sl-copy">Copier</button></div>
    <p class="small muted">Les prochaines modifications ne seront visibles qu'après avoir cliqué à nouveau sur « Publier ».</p>
    <h3 class="st-h3">Le nom de domaine du client</h3>
    ${d ? `<div class="st-dns"><p style="margin:0 0 8px"><b>${esc(d.name)}</b> · ${d.status === "active" ? `<span class="st-chip ok">Actif</span>` : `<span class="st-chip warn">En attente du réglage DNS</span>`}</p>
      ${d.status === "active" ? "" : d.apex ? `<p class="small">Pour un domaine sans « www » (${esc(d.name)}), le domaine doit être géré par Cloudflare : ajoute-le dans Cloudflare (gratuit) et change ses serveurs DNS chez le registraire. Plus simple : utilise <b>www.${esc(d.name)}</b>.</p>` : `<p class="small">Chez le registraire du domaine (OVH, Namecheap, GoDaddy…), ajoute cet enregistrement :</p><table class="st-rec"><tr><th>Type</th><th>Nom</th><th>Valeur</th></tr><tr><td>CNAME</td><td>${esc(d.name.split(".")[0])}</td><td>${esc(d.target || "")}</td></tr></table><p class="small muted">Le cadenas https s'active tout seul quelques minutes après.</p>`}</div>` : ""}
    <div style="display:flex;gap:8px;margin-top:10px"><input id="sl-domain" placeholder="www.plomberie-martin.fr" aria-label="Nom de domaine" style="flex:1" value=""><button class="btn primary" id="sl-add">${d ? "Changer" : "Brancher"}</button></div>
    <div id="sl-err" class="small c-bad" role="alert" style="min-height:16px;margin-top:6px"></div>` });
  $("#sl-copy").onclick = () => { navigator.clipboard.writeText(url || s.url); toast("Lien copié"); };
  $("#sl-add").onclick = async () => {
    try { await api(`/sites/${s.id}/domain`, { method: "POST", body: JSON.stringify({ domain: $("#sl-domain").value }) }); await openSite(s.id); showOnline(url); }
    catch (e) { $("#sl-err").textContent = e.message; }
  };
}
function openCloudflare(after) {
  const cf = ST.cf || {};
  if (cf.connected) {
    bModal({ title: "Cloudflare", cancel: "Fermer", width: 520, body: `<div class="stc-ok"><span class="dot-ok"></span><div><b>Compte ${esc(cf.account || "Cloudflare")} connecté</b><p class="small muted" style="margin:2px 0 0">Tes sites sont publiés sur Cloudflare Pages, gratuitement.</p></div></div>
      ${cf.source === "railway" ? "" : `<div style="margin-top:16px"><button class="btn quiet" id="cf-off">Déconnecter</button></div>`}` });
    const off = $("#cf-off"); if (off) off.onclick = async () => { await api("/cloudflare/disconnect", { method: "POST", body: "{}" }); $("#bm").classList.remove("on"); toast("Cloudflare déconnecté"); ST.cf = { connected: false }; if (!ST.cur) loadSites(); };
    return;
  }
  bModal({ title: "Connecter Cloudflare", sub: "Une seule fois. L'hébergement de tes sites est gratuit.", go: "Connecter", width: 580, body: `
    <ol class="stc-steps">
      <li><b>Crée un compte Cloudflare gratuit</b> si tu n'en as pas, puis ouvre la page des jetons API.<br><a class="btn primary" style="margin-top:8px" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener">Ouvrir mes jetons Cloudflare</a></li>
      <li><b>Crée un jeton</b> : « Créer un jeton » → « Créer un jeton personnalisé ». Nom : <b>Biznify</b>. Autorisation : <b>Compte › Cloudflare Pages › Modifier</b>. Puis « Continuer » et « Créer le jeton ».</li>
      <li><b>Colle le jeton ici</b><div class="field" style="margin:8px 0 0"><input id="cf-token" type="password" autocomplete="off" spellcheck="false" placeholder="Jeton API Cloudflare" aria-label="Jeton API Cloudflare"></div>
        <p class="small muted" style="margin:6px 0 0">Il est vérifié puis enregistré chiffré.</p></li>
    </ol><div id="cf-err" class="small c-bad" role="alert" style="min-height:16px"></div>`,
    onGo: async () => {
      const token = $("#cf-token").value.trim();
      if (!token) { $("#cf-err").textContent = "Colle ton jeton Cloudflare"; return false; }
      try {
        const r = await api("/cloudflare/connect", { method: "POST", body: JSON.stringify({ token }) });
        ST.cf = r.cloudflare; toast(`Cloudflare connecté : ${r.cloudflare.account || ""}`);
        if (!ST.cur) loadSites(); else updateEditor(false);
        if (typeof after === "function") setTimeout(after, 50);
      } catch (e) { $("#cf-err").textContent = e.message; return false; }
    } });
}
