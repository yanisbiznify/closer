/* Biznify — Prospection : leads Google Maps via Apify, envoyés au pipeline cold call */
const PR = { meta: null, poll: null };

async function loadProspect() {
  try { PR.meta = await api("/prospect/meta"); } catch (e) { $("#pr-jobs").innerHTML = `<div class="panel-b muted">${esc(e.message)}</div>`; return; }
  const a = PR.meta.apify;
  $("#pr-apify").innerHTML = a.connected ? `<span class="dot-ok"></span>Apify connecté` : "Connecter Apify";
  $("#pr-apify").onclick = openApify;
  $("#pr-callout").innerHTML = a.connected ? "" : `<div class="callout"><div class="grow"><b>Connecte ton compte Apify pour lancer des recherches.</b><p>Apify récupère les fiches Google Maps (nom, téléphone, site, note, adresse). Compte gratuit avec 5 $ offerts par mois, soit environ 1 000 entreprises.</p></div><button class="btn primary" id="pr-apify2">Connecter Apify</button></div>`;
  const a2 = $("#pr-apify2"); if (a2) a2.onclick = openApify;
  const sel = $("#pr-list"), cur = sel.value;
  sel.innerHTML = PR.meta.lists.map((l) => `<option value="${l.id}">${esc(l.name)} (${l.n})</option>`).join("") + `<option value="__new">Nouvelle liste…</option>`;
  sel.value = cur && cur !== "__new" ? cur : String(PR.meta.defaultList || (PR.meta.lists[0] && PR.meta.lists[0].id) || "__new");
  $("#pr-go").disabled = !a.connected;
  estimate();
  loadJobs();
}

function estimate() {
  const cities = $("#pr-loc").value.split(/[,\n;]/).map((x) => x.trim()).filter(Boolean).length;
  const max = Number($("#pr-max").value);
  if (!cities) { $("#pr-est").textContent = ""; return; }
  const n = cities * max;
  const usd = n * ($("#pr-emails").checked ? 0.007 : 0.004);
  $("#pr-est").textContent = `Jusqu'à ${n} entreprises, pour ${usd < 1 ? "moins de 1 $" : "environ " + usd.toFixed(1).replace(".", ",") + " $"} de crédit Apify. Compte 1 à 5 minutes.`;
}
["#pr-loc", "#pr-max", "#pr-emails"].forEach((s) => $(s).addEventListener("input", estimate));

$("#pr-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#pr-err").textContent = "";
  let listId = $("#pr-list").value, newList = null;
  if (listId === "__new") { newList = prompt("Nom de la nouvelle liste", `Google Maps : ${$("#pr-q").value.trim()}`); if (!newList) return; listId = null; }
  const body = {
    query: $("#pr-q").value.trim(), locations: $("#pr-loc").value, max: Number($("#pr-max").value), listId: listId ? Number(listId) : null, newList,
    filters: { phone: true, noWebsite: $("#pr-nosite").checked, emails: $("#pr-emails").checked, minRating: Number($("#pr-rating").value), minReviews: Number($("#pr-reviews").value) },
  };
  if (!body.query || !body.locations.trim()) { $("#pr-err").textContent = "Indique un métier et au moins une ville."; return; }
  const b = $("#pr-go"); b.disabled = true; b.innerHTML = `<span class="spin"></span>Lancement`;
  try { await api("/prospect/jobs", { method: "POST", body: JSON.stringify(body) }); toast("Recherche lancée : les prospects arrivent dans quelques minutes"); if (newList) loadProspect(); else loadJobs(); }
  catch (err) { $("#pr-err").textContent = err.message; }
  b.disabled = false; b.textContent = "Lancer la recherche";
});

async function loadJobs() {
  let r;
  try { r = await api("/prospect/jobs"); } catch (e) { return; }
  const jobs = r.jobs;
  const sk = (s) => {
    const parts = [s.deja_dans_crm ? `${s.deja_dans_crm} déjà dans ton CRM` : "", s.sans_telephone ? `${s.sans_telephone} sans téléphone` : "", s.filtres ? `${s.filtres} écartés par tes filtres` : "", s.doublons ? `${s.doublons} doublons` : ""].filter(Boolean);
    return parts.length ? parts.join(" · ") : "";
  };
  $("#pr-jobs").innerHTML = jobs.length ? `<ul class="pr-jobs">${jobs.map((j) => `
    <li>
      <div class="pr-j-t"><b>${esc(j.query)}</b><span class="small muted">${esc((j.locations || []).join(", "))} · ${esc(new Date(j.created_at).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}</span></div>
      ${j.status === "en_cours" ? `<span class="badge or"><span class="spin"></span>Recherche en cours</span>`
        : j.status === "erreur" ? `<span class="badge bad" title="${esc(j.error || "")}">Erreur</span>`
        : `<span class="badge good">+${j.added} prospect${j.added > 1 ? "s" : ""}</span>`}
      ${j.status === "termine" ? `<div class="pr-j-d small muted">${j.found} trouvé${j.found > 1 ? "s" : ""} sur Google Maps${sk(j.skipped || {}) ? ` · ${esc(sk(j.skipped))}` : ""}${j.cost_usd != null ? ` · ${String(Number(j.cost_usd).toFixed(2)).replace(".", ",")} $` : ""}</div>
        <div class="pr-j-a"><span class="small muted">→ ${esc(j.list_name || "liste supprimée")}</span>${j.added ? `<button class="btn quiet" data-open-list="${j.list_id}">Voir dans le pipeline</button>` : ""}</div>` : ""}
      ${j.status === "erreur" ? `<div class="pr-j-d small c-bad">${esc(j.error || "")}</div>` : ""}
    </li>`).join("")}</ul>` : `<div class="panel-b muted small">Aucune recherche pour l'instant. Lance ta première à gauche.</div>`;
  $$("#pr-jobs [data-open-list]").forEach((b) => (b.onclick = () => { CRM.list = b.dataset.openList; show("pipeline"); }));
  clearTimeout(PR.poll);
  if (jobs.some((j) => j.status === "en_cours")) PR.poll = setTimeout(() => { if ($("#v-prospect").classList.contains("on")) loadJobs(); }, 10000);
}

function openApify() {
  const a = PR.meta && PR.meta.apify;
  if (a && a.connected) {
    bModal({ title: "Apify", cancel: "Fermer", width: 480, body: `<div class="stc-ok"><span class="dot-ok"></span><div><b>${esc(a.account || "Compte Apify")} est connecté</b><p class="small muted" style="margin:2px 0 0">${a.source === "railway" ? "Jeton dans Railway (APIFY_TOKEN)" : "Jeton enregistré chiffré"}</p></div></div>
      ${a.source === "railway" ? "" : `<div style="margin-top:16px"><button class="btn quiet" id="ap-off">Déconnecter</button></div>`}` });
    const off = $("#ap-off"); if (off) off.onclick = async () => { await api("/prospect/apify/disconnect", { method: "POST", body: "{}" }); $("#bm").classList.remove("on"); toast("Apify déconnecté"); loadProspect(); };
    return;
  }
  bModal({ title: "Connecter Apify", sub: "Une seule fois.", go: "Connecter", width: 540, body: `
    <ol class="stc-steps">
      <li><b>Ouvre tes clés Apify</b> (compte gratuit si tu n'en as pas).<br><a class="btn primary" style="margin-top:8px" href="https://console.apify.com/settings/integrations" target="_blank" rel="noopener">Ouvrir Apify</a>
        <p class="small muted" style="margin:8px 0 0">Dans « API tokens », copie ton jeton personnel (il commence par apify_api_).</p></li>
      <li><b>Colle-le ici</b><div class="field" style="margin:8px 0 0"><input id="ap-tok" type="password" autocomplete="off" spellcheck="false" placeholder="apify_api_…" aria-label="Jeton Apify"></div>
        <p class="small muted" style="margin:6px 0 0">Il est vérifié puis enregistré chiffré.</p></li>
    </ol><div id="ap-err" class="small c-bad" role="alert" style="min-height:18px;margin-top:6px"></div>`,
    onGo: async () => {
      try { const r = await api("/prospect/apify/connect", { method: "POST", body: JSON.stringify({ token: $("#ap-tok").value.trim() }) }); toast(`Apify connecté${r.apify.account ? " : " + r.apify.account : ""}`); loadProspect(); }
      catch (e) { $("#ap-err").textContent = e.message; return false; }
    } });
}
