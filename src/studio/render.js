// Rendu d'un site (JSON → page HTML statique, responsive, sans dépendance)
const { icon } = require("./icons");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nl = (s) => esc(s).replace(/\n/g, "<br>");
const hex = (c, d) => (/^#[0-9a-fA-F]{6}$/.test(c || "") ? c : d);

// "u:1581578731548-c64695cc6952" → photo Unsplash optimisée ; sinon URL telle quelle
function img(src, w = 1600) {
  if (!src) return "";
  const m = /^u:([0-9]+-[0-9a-f]+)$/.exec(src);
  if (m) return `https://images.unsplash.com/photo-${m[1]}?auto=format&fit=crop&w=${w}&q=80`;
  if (/^\{\{asset:\d+\}\}$/.test(src)) return src; // photo fournie par le client (remplacée à la publication)
  if (/^https:\/\//.test(src) || src.startsWith("data:image/")) return src;
  return "";
}
const pic = (src, alt, w, cls = "", extra = "") => {
  const u = img(src, w);
  return u ? `<img class="${cls}" src="${esc(u)}" alt="${esc(alt || "")}" loading="lazy" decoding="async"${extra}>` : `<div class="${cls} ph" role="img" aria-label="${esc(alt || "")}"></div>`;
};
const href = (h) => {
  const v = String(h || "#contact").trim();
  if (/^(https?:|mailto:|tel:|#|\/)/.test(v)) return esc(v);
  return "#contact";
};
const tel = (p) => "tel:" + String(p || "").replace(/[^+\d]/g, "");
const btn = (b, cls = "b1") => (b && b.label ? `<a class="btn ${cls}" href="${href(b.href)}">${esc(b.label)}${cls === "b1" ? `<span class="ba">${icon("arrow", 18)}</span>` : ""}</a>` : "");
const head = (s, cls = "") => `${s.eyebrow ? `<p class="eb">${esc(s.eyebrow)}</p>` : ""}${s.title ? `<h2 class="h2 ${cls}">${nl(s.title)}</h2>` : ""}${s.subtitle ? `<p class="lead">${nl(s.subtitle)}</p>` : ""}`;

const FONTS = {
  "Inter": "Inter:wght@400;500;600;700;800", "Manrope": "Manrope:wght@400;500;600;700;800", "Plus Jakarta Sans": "Plus+Jakarta+Sans:wght@400;500;600;700;800",
  "Archivo": "Archivo:wght@400;500;600;700;800;900", "Sora": "Sora:wght@400;500;600;700;800", "Fraunces": "Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700",
  "Playfair Display": "Playfair+Display:wght@400;500;600;700;800", "DM Sans": "DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700",
  "Instrument Serif": "Instrument+Serif:ital@0;1", "Bricolage Grotesque": "Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700;12..96,800",
  "Outfit": "Outfit:wght@400;500;600;700;800", "Cormorant Garamond": "Cormorant+Garamond:wght@400;500;600;700", "Space Grotesk": "Space+Grotesk:wght@400;500;600;700",
  "Unbounded": "Unbounded:wght@400;500;600;700;800", "Lora": "Lora:wght@400;500;600;700",
};

/* ---------- Sections ---------- */
const S = {};

S.hero = (s, site) => {
  const v = s.variant || "split";
  const stats = (s.stats || []).filter((x) => x && x.value).slice(0, 4);
  const badges = (s.badges || []).filter(Boolean).slice(0, 4);
  const ctas = `<div class="ctas">${btn(s.ctaPrimary, "b1")}${btn(s.ctaSecondary, "b2")}</div>`;
  const badgeRow = badges.length ? `<ul class="badges">${badges.map((b) => `<li>${icon("check", 16)}${esc(b)}</li>`).join("")}</ul>` : "";
  const rating = s.rating && s.rating.value ? `<div class="rating"><span class="stars">${"★".repeat(5)}</span><b>${esc(s.rating.value)}</b><span>${esc(s.rating.label || "")}</span></div>` : "";
  if (v === "photo") {
    return `<section class="hero hero-photo" id="top">
      <div class="hp-bg">${pic(s.image, s.imageAlt || s.title, 2200, "hp-img", ' fetchpriority="high" loading="eager"')}</div>
      <div class="wrap hp-in">
        <div class="hp-copy" data-r>${rating}${s.eyebrow ? `<p class="eb eb-on">${esc(s.eyebrow)}</p>` : ""}<h1 class="h1">${nl(s.title)}</h1>${s.subtitle ? `<p class="lead">${nl(s.subtitle)}</p>` : ""}${ctas}${badgeRow}</div>
      </div>
      ${stats.length ? `<div class="wrap"><div class="hp-stats" data-r>${stats.map((x) => `<div><b>${esc(x.value)}</b><span>${esc(x.label)}</span></div>`).join("")}</div></div>` : ""}
    </section>`;
  }
  if (v === "editorial") {
    return `<section class="hero hero-ed" id="top"><div class="wrap">
      <div class="he-top" data-r>${s.eyebrow ? `<p class="eb">${esc(s.eyebrow)}</p>` : ""}<h1 class="h1 xl">${nl(s.title)}</h1></div>
      <div class="he-row" data-r>${s.subtitle ? `<p class="lead">${nl(s.subtitle)}</p>` : "<span></span>"}${ctas}</div>
      <div class="he-img" data-r>${pic(s.image, s.imageAlt || s.title, 2200, "", ' fetchpriority="high" loading="eager"')}${stats.length ? `<div class="he-stats">${stats.map((x) => `<div><b>${esc(x.value)}</b><span>${esc(x.label)}</span></div>`).join("")}</div>` : ""}</div>
    </div></section>`;
  }
  if (v === "centered") {
    return `<section class="hero hero-c" id="top"><div class="wrap">
      <div class="hc-copy" data-r>${rating}${s.eyebrow ? `<p class="eb">${esc(s.eyebrow)}</p>` : ""}<h1 class="h1">${nl(s.title)}</h1>${s.subtitle ? `<p class="lead">${nl(s.subtitle)}</p>` : ""}${ctas}${badgeRow}</div>
      <div class="hc-imgs" data-r>${[s.image, ...(s.images || [])].filter(Boolean).slice(0, 3).map((x, i) => pic(x, s.imageAlt || "", 1400, "hc-i hc-i" + i, i === 0 ? ' fetchpriority="high" loading="eager"' : "")).join("")}</div>
    </div></section>`;
  }
  // split
  const card = s.card && s.card.title ? `<div class="hs-card">${icon(s.card.icon || "shield", 22)}<div><b>${esc(s.card.title)}</b>${s.card.text ? `<span>${esc(s.card.text)}</span>` : ""}</div></div>` : "";
  return `<section class="hero hero-split" id="top"><div class="wrap hs-grid">
    <div class="hs-copy" data-r>${rating}${s.eyebrow ? `<p class="eb">${esc(s.eyebrow)}</p>` : ""}<h1 class="h1">${nl(s.title)}</h1>${s.subtitle ? `<p class="lead">${nl(s.subtitle)}</p>` : ""}${ctas}${badgeRow}
      ${stats.length ? `<div class="hs-stats">${stats.map((x) => `<div><b>${esc(x.value)}</b><span>${esc(x.label)}</span></div>`).join("")}</div>` : ""}</div>
    <div class="hs-media" data-r>${pic(s.image, s.imageAlt || s.title, 1600, "hs-img", ' fetchpriority="high" loading="eager"')}${card}</div>
  </div></section>`;
};

S.trust = (s) => {
  const items = (s.items || []).filter(Boolean);
  if (!items.length) return "";
  const row = items.map((t) => `<span>${icon(s.icon || "check", 16)}${esc(t)}</span>`).join("");
  return `<section class="trust" aria-label="${esc(s.title || "Nos garanties")}"><div class="tr-track"><div class="tr-row">${row}${row}</div></div></section>`;
};

S.services = (s) => {
  const v = s.variant || "cards";
  const items = (s.items || []).filter((x) => x && x.title).slice(0, 9);
  let body;
  if (v === "images") body = `<div class="sv-img">${items.map((it, i) => `<article class="svi" data-r style="--d:${i}">${pic(it.image, it.title, 900, "svi-p")}<div class="svi-t"><h3>${esc(it.title)}</h3>${it.text ? `<p>${nl(it.text)}</p>` : ""}${it.price ? `<span class="price">${esc(it.price)}</span>` : ""}</div></article>`).join("")}</div>`;
  else if (v === "list") body = `<div class="sv-list">${items.map((it, i) => `<article class="svl" data-r><span class="n">${String(i + 1).padStart(2, "0")}</span><h3>${esc(it.title)}</h3><p>${nl(it.text || "")}</p>${it.price ? `<span class="price">${esc(it.price)}</span>` : `<span class="svl-i">${icon(it.icon || "arrow", 22)}</span>`}</article>`).join("")}</div>`;
  else body = `<div class="sv-cards">${items.map((it, i) => `<article class="svc" data-r style="--d:${i}"><span class="ic">${icon(it.icon || "check", 24)}</span><h3>${esc(it.title)}</h3>${it.text ? `<p>${nl(it.text)}</p>` : ""}${it.price ? `<span class="price">${esc(it.price)}</span>` : ""}</article>`).join("")}</div>`;
  return `<section class="sec" id="${esc(s.anchor || "services")}"><div class="wrap"><div class="sh" data-r>${head(s)}</div>${body}</div></section>`;
};

S.about = (s) => {
  const pts = (s.points || []).filter(Boolean).slice(0, 6);
  return `<section class="sec about ${s.reverse ? "rev" : ""}" id="${esc(s.anchor || "apropos")}"><div class="wrap ab-grid">
    <div class="ab-media" data-r>${pic(s.image, s.imageAlt || s.title, 1400, "ab-img")}${s.image2 ? pic(s.image2, "", 900, "ab-img2") : ""}${s.highlight && s.highlight.value ? `<div class="ab-hl"><b>${esc(s.highlight.value)}</b><span>${esc(s.highlight.label || "")}</span></div>` : ""}</div>
    <div class="ab-copy" data-r>${head(s)}${s.text ? `<div class="prose">${String(s.text).split(/\n{2,}/).map((p) => `<p>${nl(p)}</p>`).join("")}</div>` : ""}
      ${pts.length ? `<ul class="ticks">${pts.map((p) => `<li>${icon("check", 18)}<span>${esc(p)}</span></li>`).join("")}</ul>` : ""}${btn(s.cta, "b1")}${s.signature ? `<p class="sig">${esc(s.signature)}</p>` : ""}</div>
  </div></section>`;
};

S.stats = (s) => {
  const items = (s.items || []).filter((x) => x && x.value).slice(0, 4);
  if (!items.length) return "";
  return `<section class="stats-band"><div class="wrap st-grid">${items.map((x, i) => `<div class="st" data-r style="--d:${i}"><b>${esc(x.value)}</b><span>${esc(x.label)}</span></div>`).join("")}</div></section>`;
};

S.process = (s) => {
  const steps = (s.steps || []).filter((x) => x && x.title).slice(0, 5);
  return `<section class="sec process" id="${esc(s.anchor || "methode")}"><div class="wrap"><div class="sh" data-r>${head(s)}</div>
    <ol class="steps" style="--n:${steps.length}">${steps.map((st, i) => `<li data-r style="--d:${i}"><span class="sn">${i + 1}</span><h3>${esc(st.title)}</h3><p>${nl(st.text || "")}</p></li>`).join("")}</ol></div></section>`;
};

S.gallery = (s) => {
  const ims = (s.images || []).filter(Boolean).slice(0, 8);
  if (!ims.length) return "";
  return `<section class="sec" id="${esc(s.anchor || "realisations")}"><div class="wrap"><div class="sh" data-r>${head(s)}</div>
    <div class="gal g${Math.min(ims.length, 6)}">${ims.map((x, i) => `<figure data-r style="--d:${i}">${pic(typeof x === "string" ? x : x.src, (x && x.caption) || s.title, 1000)}${x && x.caption ? `<figcaption>${esc(x.caption)}</figcaption>` : ""}</figure>`).join("")}</div></div></section>`;
};

S.testimonials = (s) => {
  const items = (s.items || []).filter((x) => x && x.quote).slice(0, 6);
  return `<section class="sec testi" id="${esc(s.anchor || "avis")}"><div class="wrap"><div class="sh" data-r>${head(s)}${s.rating ? `<p class="tg"><span class="stars">★★★★★</span> ${esc(s.rating)}</p>` : ""}</div>
    <div class="tq">${items.map((t, i) => `<figure class="tc" data-r style="--d:${i}"><span class="stars" aria-label="5 étoiles sur 5">${"★".repeat(Math.max(1, Math.min(5, t.rating || 5)))}</span><blockquote>« ${esc(t.quote)} »</blockquote><figcaption><span class="av">${esc((t.name || "?").trim().charAt(0))}</span><span><b>${esc(t.name || "")}</b>${t.role ? `<small>${esc(t.role)}</small>` : ""}</span></figcaption></figure>`).join("")}</div></div></section>`;
};

S.pricing = (s) => {
  const plans = (s.plans || []).filter((x) => x && x.name).slice(0, 4);
  return `<section class="sec" id="${esc(s.anchor || "tarifs")}"><div class="wrap"><div class="sh" data-r>${head(s)}</div>
    <div class="pr pr${plans.length}">${plans.map((p, i) => `<article class="pc ${p.highlight ? "hl" : ""}" data-r style="--d:${i}">${p.highlight ? `<span class="pc-tag">${esc(p.tag || "Le plus choisi")}</span>` : ""}<h3>${esc(p.name)}</h3>${p.description ? `<p class="pc-d">${esc(p.description)}</p>` : ""}<p class="pc-p"><b>${esc(p.price)}</b>${p.period ? `<span>${esc(p.period)}</span>` : ""}</p><ul>${(p.features || []).map((f) => `<li>${icon("check", 16)}${esc(f)}</li>`).join("")}</ul>${btn({ label: p.cta || "Demander un devis", href: p.href || "#contact" }, p.highlight ? "b1" : "b2")}</article>`).join("")}</div></div></section>`;
};

S.menu = (s) => {
  const cats = (s.categories || []).filter((c) => c && c.name).slice(0, 6);
  return `<section class="sec menu" id="${esc(s.anchor || "carte")}"><div class="wrap"><div class="sh" data-r>${head(s)}</div>
    <div class="mn">${cats.map((c) => `<div class="mn-c" data-r><h3>${esc(c.name)}</h3><ul>${(c.items || []).map((it) => `<li><div class="mn-l"><b>${esc(it.name)}</b><span class="dots"></span><span class="mn-p">${esc(it.price || "")}</span></div>${it.desc ? `<p>${esc(it.desc)}</p>` : ""}</li>`).join("")}</ul></div>`).join("")}</div></div></section>`;
};

S.faq = (s) => {
  const items = (s.items || []).filter((x) => x && x.q).slice(0, 10);
  return `<section class="sec faq" id="${esc(s.anchor || "faq")}"><div class="wrap fq-grid"><div class="sh" data-r>${head(s)}</div>
    <div class="fq">${items.map((f) => `<details data-r><summary>${esc(f.q)}<span>${icon("plus", 20)}</span></summary><p>${nl(f.a || "")}</p></details>`).join("")}</div></div></section>`;
};

S.cta = (s, site) => `<section class="ctab"><div class="wrap"><div class="ct-in" data-r>${s.image ? `<div class="ct-bg">${pic(s.image, "", 1800)}</div>` : ""}
  <div class="ct-copy"><h2 class="h2">${nl(s.title || "")}</h2>${s.text ? `<p class="lead">${nl(s.text)}</p>` : ""}</div>
  <div class="ctas">${btn(s.button || { label: "Demander un devis", href: "#contact" }, "b1")}${site.brand && site.brand.phone && s.showPhone !== false ? `<a class="btn b2" href="${tel(site.brand.phone)}">${icon("phone", 18)}${esc(site.brand.phone)}</a>` : ""}</div></div></div></section>`;

S.contact = (s, site, opt) => {
  const b = site.brand || {};
  const opts = (s.options || []).filter(Boolean).slice(0, 10);
  const info = [
    b.phone ? `<li>${icon("phone", 20)}<div><small>Téléphone</small><a href="${tel(b.phone)}">${esc(b.phone)}</a></div></li>` : "",
    b.email ? `<li>${icon("mail", 20)}<div><small>Email</small><a href="mailto:${esc(b.email)}">${esc(b.email)}</a></div></li>` : "",
    b.address ? `<li>${icon("map", 20)}<div><small>Adresse</small><span>${nl(b.address)}</span></div></li>` : "",
    b.hours ? `<li>${icon("clock", 20)}<div><small>Horaires</small><span>${nl(b.hours)}</span></div></li>` : "",
  ].join("");
  return `<section class="sec contact" id="contact"><div class="wrap co-grid">
    <div class="co-copy" data-r>${head(s)}<ul class="co-info">${info}</ul></div>
    <form class="co-form" data-r data-biznify-form data-success="${esc((site.form && site.form.success) || "Merci ! Votre demande est bien envoyée, nous vous recontactons très vite.")}">
      <div class="fr"><label>Prénom et nom<input name="nom" autocomplete="name" required></label><label>Téléphone<input name="telephone" type="tel" autocomplete="tel" required></label></div>
      <label>Email<input name="email" type="email" autocomplete="email"></label>
      ${opts.length ? `<label>${esc(s.optionsLabel || "Votre besoin")}<select name="service"><option value="">Choisir…</option>${opts.map((o) => `<option>${esc(o)}</option>`).join("")}</select></label>` : ""}
      <label>Message<textarea name="message" rows="4" placeholder="${esc(s.placeholder || "Décrivez votre demande")}"></textarea></label>
      <label class="consent"><input type="checkbox" name="consentement" value="oui" required><span>${esc(s.consent || `J'accepte d'être recontacté par ${b.name || "l'entreprise"} au sujet de ma demande.`)}</span></label>
      <button class="btn b1 wide" type="submit">${esc(s.button || "Envoyer ma demande")}<span class="ba">${icon("arrow", 18)}</span></button>
    </form></div></section>`;
};

S.text = (s) => `<section class="sec"><div class="wrap narrow" data-r>${head(s)}${s.text ? `<div class="prose">${String(s.text).split(/\n{2,}/).map((p) => `<p>${nl(p)}</p>`).join("")}</div>` : ""}</div></section>`;

/* ---------- Page ---------- */
function css(t) {
  const dark = t.mode === "dark";
  const bg = hex(t.bg, dark ? "#0E0F12" : "#FFFFFF");
  const surface = hex(t.surface, dark ? "#16181D" : "#F5F6F8");
  const ink = hex(t.ink, dark ? "#F4F4F2" : "#101114");
  const muted = hex(t.muted, dark ? "#A3A6AE" : "#5E636E");
  const accent = hex(t.accent, "#1877F2");
  const accentInk = hex(t.accentInk, "#FFFFFF");
  const line = hex(t.line, dark ? "#262930" : "#E6E8EC");
  const r = Math.max(0, Math.min(32, Number(t.radius ?? 14)));
  const hf = FONTS[t.headFont] ? t.headFont : "Inter";
  const bf = FONTS[t.bodyFont] ? t.bodyFont : "Inter";
  const hw = t.headWeight || 700;
  const track = t.headTracking ?? -0.03;
  return `:root{--bg:${bg};--sf:${surface};--ink:${ink};--mut:${muted};--ac:${accent};--aci:${accentInk};--ln:${line};--r:${r}px;--rs:${Math.round(r * 0.6)}px;--hf:"${hf}",system-ui,sans-serif;--bf:"${bf}",system-ui,sans-serif;--hw:${hw};--tr:${track}em}
*{box-sizing:border-box}html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--ink);font:400 17px/1.6 var(--bf);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
img{max-width:100%;display:block}a{color:inherit}.ph{background:linear-gradient(135deg,var(--sf),var(--ln))}
.wrap{width:min(1200px,100% - 48px);margin:0 auto}.narrow{max-width:760px}
.h1,.h2,h3{font-family:var(--hf);font-weight:var(--hw);letter-spacing:var(--tr);line-height:1.05;margin:0;${t.headCase === "upper" ? "text-transform:uppercase;" : ""}}
.h1{font-size:clamp(40px,6.4vw,84px)}.h1.xl{font-size:clamp(48px,9vw,140px);line-height:.95}.h2{font-size:clamp(32px,4.4vw,56px)}h3{font-size:21px;line-height:1.25;letter-spacing:-.01em}
.eb{display:inline-flex;align-items:center;gap:8px;font-size:14px;font-weight:600;color:var(--ac);margin:0 0 18px}.eb::before{content:"";width:22px;height:2px;background:currentColor;border-radius:2px}
.lead{font-size:clamp(17px,1.6vw,20px);color:var(--mut);margin:20px 0 0;max-width:60ch}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:52px;padding:0 24px;border-radius:${t.pill ? "999px" : "var(--rs)"};font:600 16px var(--bf);text-decoration:none;border:1.5px solid transparent;cursor:pointer;transition:transform .2s,background .2s,box-shadow .2s;white-space:nowrap}
.b1{background:var(--ac);color:var(--aci);box-shadow:0 10px 30px -10px color-mix(in srgb,var(--ac) 70%,transparent)}.b1:hover{transform:translateY(-2px)}.ba{display:inline-flex;transition:transform .2s}.b1:hover .ba{transform:translateX(3px)}
.b2{background:transparent;color:inherit;border-color:color-mix(in srgb,currentColor 25%,transparent)}.b2:hover{border-color:currentColor}.btn svg{flex:none}.wide{width:100%}
.btn:focus-visible,a:focus-visible,summary:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible{outline:3px solid var(--ac);outline-offset:3px}
.ctas{display:flex;flex-wrap:wrap;gap:12px;margin-top:34px}
.badges{list-style:none;padding:0;margin:28px 0 0;display:flex;flex-wrap:wrap;gap:10px 22px;font-size:15px;color:var(--mut)}.badges li{display:flex;align-items:center;gap:8px}.badges svg{color:var(--ac)}
.rating{display:flex;width:fit-content;align-items:center;gap:10px;font-size:14px;margin-bottom:22px;padding:7px 14px 7px 12px;border-radius:999px;background:color-mix(in srgb,var(--sf) 85%,transparent);border:1px solid var(--ln)}.rating b{font-weight:700}.rating span:last-child{color:var(--mut)}
.stars{color:#F5A623;letter-spacing:2px}
/* en-tête */
.nav{position:sticky;top:0;z-index:40;background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:saturate(1.6) blur(14px);-webkit-backdrop-filter:saturate(1.6) blur(14px);border-bottom:1px solid transparent;transition:border-color .3s}
.nav.sc{border-bottom-color:var(--ln)}.nav-in{display:flex;align-items:center;gap:28px;height:76px}
.logo{display:flex;align-items:center;gap:10px;font:var(--hw) 21px var(--hf);letter-spacing:var(--tr);text-decoration:none;margin-right:auto}.logo img{height:38px;width:auto}.logo .lm{width:34px;height:34px;border-radius:var(--rs);background:var(--ac);color:var(--aci);display:grid;place-items:center}
.links{display:flex;gap:28px;font-size:15px;font-weight:500}.links a{text-decoration:none;color:var(--mut);transition:color .2s}.links a:hover{color:var(--ink)}
.nav .btn{min-height:44px;padding:0 18px;font-size:15px}.ntel{display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px;text-decoration:none}.ntel svg{color:var(--ac)}
.burger{display:none;background:none;border:0;padding:8px;margin-right:-8px;color:inherit;cursor:pointer}
.mnav{display:none}
@media (max-width:960px){.links,.nav .ntel,.nav .btn{display:none}.burger{display:block}
  .mnav{display:block;position:fixed;inset:76px 0 0;background:var(--bg);padding:24px;transform:translateY(-8px);opacity:0;visibility:hidden;transition:.25s}.mnav.on{opacity:1;visibility:visible;transform:none}
  .mnav a{display:block;font:600 26px var(--hf);letter-spacing:var(--tr);padding:14px 0;border-bottom:1px solid var(--ln);text-decoration:none}.mnav .btn{margin-top:24px;width:100%;font-size:17px}}
/* héros */
.hero{position:relative}
.hero-split{padding:64px 0 96px}.hs-grid{display:grid;grid-template-columns:1.05fr 1fr;gap:64px;align-items:center}
.hs-media{position:relative}.hs-img{width:100%;aspect-ratio:4/4.6;object-fit:cover;border-radius:calc(var(--r) * 1.6)}
.hs-card{position:absolute;left:-28px;bottom:36px;display:flex;gap:14px;align-items:center;background:var(--bg);color:var(--ink);padding:16px 20px;border-radius:var(--r);box-shadow:0 24px 60px -20px rgba(0,0,0,.35);max-width:300px}.hs-card svg{color:var(--ac);flex:none}.hs-card b{display:block;font-size:15px}.hs-card span{font-size:13.5px;color:var(--mut)}
.hs-stats{display:flex;gap:40px;margin-top:44px;padding-top:28px;border-top:1px solid var(--ln)}.hs-stats b,.hp-stats b,.st b,.he-stats b{display:block;font:var(--hw) clamp(28px,3vw,40px)/1 var(--hf);letter-spacing:var(--tr)}.hs-stats span,.hp-stats span,.st span,.he-stats span{display:block;font-size:14px;color:var(--mut);margin-top:8px}
.hero-photo{min-height:min(92vh,880px);display:flex;flex-direction:column;justify-content:flex-end;color:#fff;padding:140px 0 40px;isolation:isolate}
.hp-bg{position:absolute;inset:0;z-index:-1;overflow:hidden}.hp-bg::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,.62),rgba(0,0,0,.18) 65%),linear-gradient(180deg,rgba(0,0,0,.2),transparent 30%,rgba(0,0,0,.7))}.hp-img{width:100%;height:100%;object-fit:cover;animation:kb 1.6s cubic-bezier(.2,.7,.2,1) both}
@keyframes kb{from{transform:scale(1.08)}to{transform:none}}
.hp-copy{max-width:780px}.hero-photo .lead{color:rgba(255,255,255,.82)}.hero-photo .b2{color:#fff}.hero-photo .badges{color:rgba(255,255,255,.85)}.hero-photo .rating{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.2);color:#fff}.hero-photo .rating span:last-child{color:rgba(255,255,255,.75)}.eb-on{color:#fff}
.hp-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;margin-top:64px;padding:26px 0 0;border-top:1px solid rgba(255,255,255,.25)}.hp-stats span{color:rgba(255,255,255,.75)}
.hero-ed{padding:72px 0 40px}.he-row{display:flex;justify-content:space-between;align-items:flex-end;gap:40px;margin-top:36px}.he-row .lead{margin:0}.he-row .ctas{margin:0;flex:none}
.he-img{position:relative;margin-top:56px}.he-img img,.he-img .ph{width:100%;aspect-ratio:21/9;object-fit:cover;border-radius:calc(var(--r) * 1.4)}
.he-stats{position:absolute;right:24px;bottom:24px;display:flex;gap:28px;background:var(--bg);padding:20px 26px;border-radius:var(--r)}
.hero-c{padding:80px 0 56px;text-align:center}.hc-copy{max-width:880px;margin:0 auto}.hc-copy .lead{margin-left:auto;margin-right:auto}.hero-c .ctas,.hero-c .badges{justify-content:center}.hero-c .eb::before{display:none}.hero-c .rating{margin-left:auto;margin-right:auto}
.hc-imgs{display:grid;grid-template-columns:1fr 1.5fr 1fr;gap:18px;margin-top:64px;align-items:end}.hc-i{width:100%;object-fit:cover;border-radius:calc(var(--r) * 1.3)}.hc-i0{aspect-ratio:4/3.2;grid-column:2;grid-row:1}.hc-i1{aspect-ratio:3/4;grid-column:1;grid-row:1}.hc-i2{aspect-ratio:3/4;grid-column:3;grid-row:1}
/* bandeau garanties */
.trust{border-block:1px solid var(--ln);overflow:hidden;padding:18px 0;background:var(--bg)}.tr-track{mask:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent)}.tr-row{display:flex;gap:56px;width:max-content;animation:mq 40s linear infinite}.tr-row span{display:flex;align-items:center;gap:10px;font-weight:600;font-size:15px;color:var(--mut);white-space:nowrap}.tr-row svg{color:var(--ac)}
@keyframes mq{to{transform:translateX(-50%)}}
/* sections */
.sec{padding:clamp(72px,10vw,128px) 0}.sec+.sec{padding-top:0}.sh{max-width:720px;margin-bottom:56px}
.sv-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.svc{background:var(--sf);border:1px solid var(--ln);border-radius:var(--r);padding:30px;transition:transform .3s,border-color .3s}.svc:hover{transform:translateY(-4px);border-color:color-mix(in srgb,var(--ac) 40%,var(--ln))}
.ic{width:52px;height:52px;border-radius:var(--rs);display:grid;place-items:center;background:color-mix(in srgb,var(--ac) 14%,transparent);color:var(--ac);margin-bottom:26px}.svc p,.svi p,.svl p{color:var(--mut);margin:10px 0 0;font-size:16px}
.price{display:inline-block;margin-top:16px;font-weight:700;color:var(--ac)}
.sv-img{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.svi{position:relative;border-radius:var(--r);overflow:hidden;background:var(--sf)}.svi-p{width:100%;aspect-ratio:4/3.4;object-fit:cover;transition:transform .6s}.svi:hover .svi-p{transform:scale(1.04)}.svi-t{padding:24px 26px 28px}
.sv-list{border-top:1px solid var(--ln)}.svl{display:grid;grid-template-columns:70px 1fr 1.3fr 60px;gap:24px;align-items:baseline;padding:32px 0;border-bottom:1px solid var(--ln)}.svl .n{font:600 15px var(--bf);color:var(--ac)}.svl h3{font-size:clamp(22px,2.4vw,30px)}.svl p{margin:0}.svl-i{justify-self:end;color:var(--ac)}.svl .price{margin:0;justify-self:end}
.ab-grid{display:grid;grid-template-columns:1fr 1fr;gap:80px;align-items:center}.about.rev .ab-media{order:2}
.ab-media{position:relative}.ab-img{width:100%;aspect-ratio:4/4.4;object-fit:cover;border-radius:calc(var(--r) * 1.4)}.ab-img2{position:absolute;width:44%;aspect-ratio:1;object-fit:cover;right:-24px;bottom:-32px;border-radius:var(--r);border:6px solid var(--bg)}
.ab-hl{position:absolute;left:24px;top:24px;background:var(--ac);color:var(--aci);padding:18px 22px;border-radius:var(--r)}.ab-hl b{display:block;font:var(--hw) 40px/1 var(--hf)}.ab-hl span{font-size:14px;opacity:.9}
.prose p{color:var(--mut);margin:20px 0 0}.ticks{list-style:none;padding:0;margin:28px 0 0;display:grid;gap:14px}.ticks li{display:flex;gap:12px;align-items:flex-start}.ticks svg{color:var(--ac);flex:none;margin-top:3px}.about .btn{margin-top:34px}.sig{font-family:var(--hf);font-style:italic;font-size:22px;margin-top:24px}
.stats-band{padding:56px 0;background:var(--sf);border-block:1px solid var(--ln)}.st-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:24px}.st b{font-size:clamp(36px,4vw,56px);color:var(--ink)}
.steps{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(var(--n),1fr);gap:20px;counter-reset:s}.steps li{position:relative;padding:28px 0 0;border-top:2px solid var(--ln)}.steps li::before{content:"";position:absolute;top:-2px;left:0;width:48px;height:2px;background:var(--ac)}
.sn{display:inline-grid;place-items:center;width:40px;height:40px;border-radius:50%;background:var(--ink);color:var(--bg);font-weight:700;font-size:15px;margin-bottom:22px}.steps p{color:var(--mut);margin:10px 0 0;font-size:16px}
.gal{display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:240px;gap:14px}.gal figure{margin:0;position:relative;overflow:hidden;border-radius:var(--r)}.gal img,.gal .ph{width:100%;height:100%;object-fit:cover;transition:transform .6s}.gal figure:hover img{transform:scale(1.05)}
.gal figure:nth-child(1){grid-column:span 2;grid-row:span 2}.gal.g3 figure:nth-child(1){grid-column:span 2}.gal figcaption{position:absolute;left:12px;bottom:12px;background:rgba(0,0,0,.6);color:#fff;font-size:13px;padding:6px 10px;border-radius:8px}
.testi{background:var(--sf);padding-top:clamp(72px,10vw,128px)!important}.tg{margin:16px 0 0;color:var(--mut)}.tq{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.tc{margin:0;background:var(--bg);border:1px solid var(--ln);border-radius:var(--r);padding:30px;display:flex;flex-direction:column}.tc blockquote{margin:16px 0 26px;font-size:17px;line-height:1.6;flex:1}
.tc figcaption{display:flex;gap:12px;align-items:center}.av{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--ac) 18%,transparent);color:var(--ac);font-weight:700}.tc small{display:block;color:var(--mut);font-size:14px}
.pr{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;align-items:stretch}.pr2{grid-template-columns:repeat(2,1fr);max-width:860px}.pr4{grid-template-columns:repeat(4,1fr)}
.pc{position:relative;background:var(--sf);border:1px solid var(--ln);border-radius:var(--r);padding:32px;display:flex;flex-direction:column}.pc.hl{background:var(--ink);color:var(--bg);border-color:var(--ink)}.pc.hl .pc-d,.pc.hl .pc-p span{color:color-mix(in srgb,var(--bg) 70%,transparent)}
.pc-tag{position:absolute;top:-13px;left:32px;background:var(--ac);color:var(--aci);font-size:13px;font-weight:600;padding:4px 12px;border-radius:999px}.pc-d{color:var(--mut);margin:8px 0 0;font-size:15px}.pc-p{margin:24px 0}.pc-p b{font:var(--hw) 44px/1 var(--hf);letter-spacing:var(--tr)}.pc-p span{color:var(--mut);margin-left:6px}
.pc ul{list-style:none;padding:0;margin:0 0 28px;display:grid;gap:12px;flex:1}.pc li{display:flex;gap:10px;font-size:15.5px}.pc li svg{color:var(--ac);flex:none;margin-top:4px}.pc.hl .b2{color:var(--bg)}
.mn{display:grid;grid-template-columns:1fr 1fr;gap:56px 72px}.mn-c h3{font-size:26px;padding-bottom:14px;border-bottom:1px solid var(--ln);margin-bottom:8px}.mn-c ul{list-style:none;padding:0;margin:0}.mn-c li{padding:16px 0}.mn-l{display:flex;align-items:baseline;gap:10px}.mn-l .dots{flex:1;border-bottom:1px dotted color-mix(in srgb,var(--mut) 60%,transparent);transform:translateY(-4px)}.mn-p{font-weight:600}.mn-c p{margin:6px 0 0;color:var(--mut);font-size:15px}
.fq-grid{display:grid;grid-template-columns:.8fr 1.2fr;gap:64px;align-items:start}.fq details{border-bottom:1px solid var(--ln)}.fq summary{list-style:none;display:flex;justify-content:space-between;gap:20px;align-items:center;padding:24px 0;font:600 18px var(--bf);cursor:pointer}.fq summary::-webkit-details-marker{display:none}.fq summary span{color:var(--ac);transition:transform .25s;flex:none}.fq details[open] summary span{transform:rotate(45deg)}.fq p{margin:0 0 24px;color:var(--mut);max-width:62ch}
.ctab{padding:0 0 clamp(72px,10vw,128px)}.ct-in{position:relative;overflow:hidden;border-radius:calc(var(--r) * 1.6);background:var(--ac);color:var(--aci);padding:clamp(40px,6vw,80px);display:flex;justify-content:space-between;align-items:flex-end;gap:40px;flex-wrap:wrap;isolation:isolate}
.ct-bg{position:absolute;inset:0;z-index:-1}.ct-bg img{width:100%;height:100%;object-fit:cover}.ct-bg::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(0,0,0,.78),rgba(0,0,0,.35))}.ct-bg+.ct-copy{color:#fff}.ct-in:has(.ct-bg){color:#fff}
.ct-copy{max-width:640px}.ct-in .lead{color:inherit;opacity:.85}.ct-in .ctas{margin:0}.ct-in .b1{background:var(--aci);color:var(--ac);box-shadow:none}.ct-in:has(.ct-bg) .b1{background:var(--ac);color:var(--aci)}.ct-in .b2{color:inherit}
.co-grid{display:grid;grid-template-columns:.9fr 1.1fr;gap:72px;align-items:start}.co-info{list-style:none;padding:0;margin:40px 0 0;display:grid;gap:22px}.co-info li{display:flex;gap:16px;align-items:flex-start}.co-info svg{color:var(--ac);flex:none;margin-top:4px}.co-info small{display:block;color:var(--mut);font-size:14px}.co-info a,.co-info span{font-weight:600;text-decoration:none}
.co-form{background:var(--sf);border:1px solid var(--ln);border-radius:calc(var(--r) * 1.3);padding:clamp(24px,4vw,40px);display:grid;gap:16px}.fr{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.co-form label{display:grid;gap:8px;font-size:14px;font-weight:600}.co-form input,.co-form select,.co-form textarea{font:400 16px var(--bf);color:var(--ink);background:var(--bg);border:1.5px solid var(--ln);border-radius:var(--rs);padding:14px 16px;width:100%;transition:border-color .2s}.co-form input:focus,.co-form select:focus,.co-form textarea:focus{border-color:var(--ac);outline:none}
.co-form .consent{display:flex;gap:10px;align-items:flex-start;font-weight:400;color:var(--mut);font-size:14px}.consent input{width:18px;height:18px;margin-top:2px;flex:none;accent-color:var(--ac)}.hp{position:absolute!important;left:-9999px}

/* pied de page */
.foot{background:${dark ? "#000" : "var(--ink)"};color:${dark ? "var(--ink)" : "var(--bg)"};padding:72px 0 32px;${dark ? "border-top:1px solid var(--ln);--bg:var(--ink);" : ""}}.ft-grid{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:48px}.foot .logo{color:var(--bg);margin:0}.foot p{color:color-mix(in srgb,var(--bg) 65%,transparent);margin:16px 0 0;max-width:38ch;font-size:15px}
.foot h4{font:600 14px var(--bf);margin:0 0 16px;color:color-mix(in srgb,var(--bg) 60%,transparent)}.foot ul{list-style:none;padding:0;margin:0;display:grid;gap:10px;font-size:15px}.foot a{text-decoration:none}.foot a:hover{text-decoration:underline}
.ft-b{margin-top:56px;padding-top:24px;border-top:1px solid color-mix(in srgb,var(--bg) 15%,transparent);display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;font-size:13.5px;color:color-mix(in srgb,var(--bg) 55%,transparent)}
.fcall{display:none}
@media (max-width:960px){.fcall{position:fixed;right:16px;bottom:16px;z-index:45;display:flex;align-items:center;gap:8px;background:var(--ac);color:var(--aci);padding:14px 20px;border-radius:999px;font-weight:700;text-decoration:none;box-shadow:0 12px 30px -8px rgba(0,0,0,.45)}}
/* animations */
[data-r]{opacity:0;transform:translateY(22px);transition:opacity .8s cubic-bezier(.2,.7,.2,1),transform .8s cubic-bezier(.2,.7,.2,1);transition-delay:calc(var(--d,0) * 70ms)}[data-r].in{opacity:1;transform:none}
.no-js [data-r]{opacity:1;transform:none}
@media (prefers-reduced-motion:reduce){[data-r]{opacity:1;transform:none;transition:none}.tr-row,.hp-img{animation:none}html{scroll-behavior:auto}}
/* mobile */
@media (max-width:960px){.hs-grid,.ab-grid,.co-grid,.fq-grid{grid-template-columns:1fr;gap:44px}.about.rev .ab-media{order:0}.hs-card{left:12px;bottom:12px}.sv-cards,.sv-img,.tq,.pr,.pr4{grid-template-columns:1fr 1fr}.steps{grid-template-columns:1fr 1fr}.st-grid,.hp-stats{grid-template-columns:1fr 1fr}.gal{grid-template-columns:1fr 1fr;grid-auto-rows:180px}.mn{grid-template-columns:1fr}.svl{grid-template-columns:44px 1fr;row-gap:8px}.svl p{grid-column:2}.svl-i,.svl .price{grid-column:2;justify-self:start}.he-row{flex-direction:column;align-items:flex-start}.he-stats{position:static;margin-top:16px;padding:0}.ft-grid{grid-template-columns:1fr}.ab-img2{right:12px}}
@media (max-width:620px){body{font-size:16px}.wrap{width:calc(100% - 36px)}.sv-cards,.sv-img,.tq,.pr,.pr2,.pr4,.steps,.fr{grid-template-columns:1fr}.hero-split{padding:32px 0 64px}.hs-stats{gap:24px}.hc-imgs{grid-template-columns:1fr 1fr}.hc-i0{grid-column:1/3;grid-row:auto}.hc-i1,.hc-i2{grid-column:auto;grid-row:auto;aspect-ratio:1}.ctas .btn{width:100%}.hero-photo{min-height:auto;padding-top:120px}.he-img img{aspect-ratio:4/3}.gal figure:nth-child(1){grid-column:span 2;grid-row:span 1}}`;
}

function render(site, opt = {}) {
  const t = site.theme || {};
  const b = site.brand || {};
  const sections = (site.sections || []).filter((s) => s && S[s.type]);
  const navTargets = { services: "Services", menu: "La carte", about: "À propos", process: "Méthode", gallery: "Réalisations", testimonials: "Avis", pricing: "Tarifs", faq: "FAQ" };
  const defaults = { services: "services", menu: "carte", about: "apropos", process: "methode", gallery: "realisations", testimonials: "avis", pricing: "tarifs", faq: "faq" };
  const links = (site.nav && site.nav.length ? site.nav : sections.filter((s) => navTargets[s.type]).slice(0, 5).map((s) => ({ label: s.navLabel || navTargets[s.type], href: "#" + (s.anchor || defaults[s.type]) })));
  const fonts = [...new Set([t.headFont, t.bodyFont].filter((f) => FONTS[f]))];
  const fontUrl = `https://fonts.googleapis.com/css2?${(fonts.length ? fonts : ["Inter"]).map((f) => "family=" + FONTS[f]).join("&")}&display=swap`;
  const cta = site.navCta || { label: "Devis gratuit", href: "#contact" };
  const logo = b.logo ? `<img src="${esc(img(b.logo, 400))}" alt="${esc(b.name)}">` : `<span class="lm">${icon(b.icon || "sparkles", 20)}</span><span>${esc(b.name || "")}</span>`;
  const title = (site.seo && site.seo.title) || `${b.name || ""}${b.tagline ? " — " + b.tagline : ""}`;
  const desc = (site.seo && site.seo.description) || "";
  const hero = sections.find((s) => s.type === "hero");
  const ogImg = hero && img(hero.image, 1200);
  const body = sections.map((s) => S[s.type](s, site, opt)).join("\n");
  const year = new Date().getFullYear();
  const schema = { "@context": "https://schema.org", "@type": site.schemaType || "LocalBusiness", name: b.name, description: desc || undefined, telephone: b.phone || undefined, email: b.email || undefined, address: b.address || undefined, areaServed: b.area || undefined, url: opt.url || undefined };
  return `<!DOCTYPE html><html lang="fr" class="no-js"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${desc ? `<meta name="description" content="${esc(desc)}">` : ""}
<meta property="og:title" content="${esc(title)}">${desc ? `<meta property="og:description" content="${esc(desc)}">` : ""}${ogImg ? `<meta property="og:image" content="${esc(ogImg)}">` : ""}<meta property="og:type" content="website">
<meta name="theme-color" content="${esc(hex(t.bg, t.mode === "dark" ? "#0E0F12" : "#FFFFFF"))}">${opt.noindex ? '<meta name="robots" content="noindex">' : ""}
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='${hex(t.accent, "#1877F2")}'/><text x='16' y='22' font-family='Arial' font-weight='700' font-size='17' text-anchor='middle' fill='${hex(t.accentInk, "#FFFFFF")}'>${esc((b.name || "S").trim().charAt(0).toUpperCase())}</text></svg>`)}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="${fontUrl}" rel="stylesheet">
<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, "\\u003c")}</script>
<style>${css(t)}</style></head><body>
<header class="nav" id="nav"><div class="wrap nav-in">
  <a class="logo" href="#top" aria-label="${esc(b.name)}, accueil">${logo}</a>
  <nav class="links" aria-label="Navigation principale">${links.map((l) => `<a href="${href(l.href)}">${esc(l.label)}</a>`).join("")}</nav>
  ${b.phone ? `<a class="ntel" href="${tel(b.phone)}">${icon("phone", 18)}${esc(b.phone)}</a>` : ""}
  ${btn(cta, "b1").replace(/<span class="ba">.*?<\/span>/, "")}
  <button class="burger" aria-label="Ouvrir le menu" aria-expanded="false" aria-controls="mnav">${icon("menu", 26)}</button>
</div><div class="mnav" id="mnav">${links.map((l) => `<a href="${href(l.href)}">${esc(l.label)}</a>`).join("")}${btn(cta, "b1")}${b.phone ? `<a class="btn b2 wide" style="margin-top:12px" href="${tel(b.phone)}">${icon("phone", 18)}${esc(b.phone)}</a>` : ""}</div></header>
<main>
${body}
</main>
<footer class="foot"><div class="wrap"><div class="ft-grid">
  <div><a class="logo" href="#top">${b.logo ? `<span>${esc(b.name)}</span>` : logo}</a>${b.tagline || desc ? `<p>${esc(b.tagline || desc)}</p>` : ""}</div>
  <div><h4>Navigation</h4><ul>${links.map((l) => `<li><a href="${href(l.href)}">${esc(l.label)}</a></li>`).join("")}<li><a href="#contact">Contact</a></li></ul></div>
  <div><h4>Contact</h4><ul>${b.phone ? `<li><a href="${tel(b.phone)}">${esc(b.phone)}</a></li>` : ""}${b.email ? `<li><a href="mailto:${esc(b.email)}">${esc(b.email)}</a></li>` : ""}${b.address ? `<li>${nl(b.address)}</li>` : ""}${b.hours ? `<li>${nl(b.hours)}</li>` : ""}</ul></div>
</div><div class="ft-b"><span>© ${year} ${esc(b.legalName || b.name || "")}${b.siret ? ` · SIRET ${esc(b.siret)}` : ""}</span><span>${esc(site.footerNote || "Tous droits réservés")}</span></div></div></footer>
${b.phone && t.callButton !== false ? `<a class="fcall" href="${tel(b.phone)}">${icon("phone", 18)}Appeler</a>` : ""}
<script>
document.documentElement.classList.remove("no-js");
(function(){
var nav=document.getElementById("nav"),bg=nav.querySelector(".burger"),mn=document.getElementById("mnav");
addEventListener("scroll",function(){nav.classList.toggle("sc",scrollY>8)},{passive:true});
bg.addEventListener("click",function(){var o=mn.classList.toggle("on");bg.setAttribute("aria-expanded",o)});
mn.addEventListener("click",function(e){if(e.target.closest("a")){mn.classList.remove("on");bg.setAttribute("aria-expanded","false")}});
var els=document.querySelectorAll("[data-r]");
if("IntersectionObserver" in window){var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add("in");io.unobserve(e.target)}})},{rootMargin:"0px 0px -8% 0px"});els.forEach(function(el){io.observe(el)})}else els.forEach(function(el){el.classList.add("in")});
})();
</script>
</body></html>`;
}

module.exports = { render, img, FONTS, SECTION_TYPES: Object.keys(S) };
