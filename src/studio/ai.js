// IA du AI Studio en mode « modèle » : on part d'un modèle pro, l'IA personnalise le contenu (JSON), le moteur fait le rendu
const config = require("../config");
const { FONTS, SECTION_TYPES } = require("./render");
const { NAMES: ICONS } = require("./icons");
const { IMAGES } = require("./library");
const templates = require("./templates");

const SCHEMA = `Un site est un objet JSON :
{
 "theme": {"mode":"light"|"dark","bg":"#hex","surface":"#hex","ink":"#hex","muted":"#hex","line":"#hex","accent":"#hex","accentInk":"#hex","headFont":police,"bodyFont":police,"headWeight":400-900,"radius":0-28,"pill":bool,"headTracking":-0.05..0,"headCase":"none"|"upper","callButton":bool},
 "brand": {"name","tagline","phone","email","address","hours","area","icon":icône,"logo":image (facultatif),"legalName","siret"},
 "seo": {"title" (< 60 car., métier + ville),"description" (< 155 car.)},
 "navCta": {"label","href"},
 "schemaType": "LocalBusiness"|"Restaurant"|"Dentist"|"ProfessionalService"|"HomeAndConstructionBusiness"|…,
 "form": {"success": message affiché après l'envoi},
 "sections": [ … dans l'ordre d'affichage … ]
}
Sections (champ "type") :
- hero : {"variant":"photo"|"split"|"editorial"|"centered","eyebrow","title","subtitle","ctaPrimary":{"label","href"},"ctaSecondary":{"label","href"},"image","images":[2 images, centered seulement],"rating":{"value","label"},"badges":[≤4 courts],"stats":[{"value","label"} ≤4],"card":{"icon","title","text"} (split seulement)}
- trust : {"items":[5-8 garanties courtes],"icon"}
- services : {"variant":"cards"|"images"|"list","eyebrow","title","subtitle","items":[{"icon","title","text","image" (variant images),"price" (facultatif)}]} (3 à 6 items ; multiple de 3 pour cards/images)
- about : {"eyebrow","title","text" (paragraphes séparés par une ligne vide),"image","image2","highlight":{"value","label"},"points":[≤4],"cta":{"label","href"},"signature","reverse":bool}
- stats : {"items":[4 × {"value","label"}]}
- process : {"eyebrow","title","subtitle","steps":[3-4 × {"title","text"}]}
- gallery : {"eyebrow","title","images":[5-6 images]}
- testimonials : {"eyebrow","title","rating","items":[3 × {"quote","name","role","rating":5}]}
- pricing : {"eyebrow","title","plans":[2-3 × {"name","price","period","description","features":[],"highlight":bool,"tag","cta"}]}
- menu : {"eyebrow","title","categories":[{"name","items":[{"name","desc","price"}]}]} (restaurants)
- faq : {"eyebrow","title","items":[4-6 × {"q","a"}]}
- cta : {"title","text","button":{"label","href"},"image","showPhone":bool}
- contact : {"eyebrow","title","subtitle","options":[besoins proposés dans le formulaire],"optionsLabel","placeholder","button","consent"} (toujours en dernier)
- text : {"eyebrow","title","text"}
Liens internes : #contact, #services, #apropos, #methode, #realisations, #avis, #tarifs, #faq, #carte, tel:…, mailto:…`;

const catalog = () => Object.entries(IMAGES).map(([k, v]) => `${k} : ${v.map((id) => "u:" + id).join(" ")}`).join("\n");

function system(assets) {
  const own = assets && assets.length
    ? `\nPhotos fournies par le client (À UTILISER EN PRIORITÉ, valeur exacte à mettre dans les champs image) :\n${assets.map((a) => `- {{asset:${a.id}}} : ${a.role === "logo" ? "logo (à mettre dans brand.logo)" : "photo"}${a.name ? ` (${a.name})` : ""}`).join("\n")}`
    : "";
  return `Tu es le directeur artistique et rédacteur web d'un studio français haut de gamme. Tu personnalises des modèles de sites vitrines pour des entreprises locales, afin qu'ils inspirent confiance et génèrent des demandes de devis et des appels.

${SCHEMA}

Polices disponibles : ${Object.keys(FONTS).join(", ")}.
Icônes disponibles : ${ICONS.join(", ")}.
Photos de banque d'images disponibles (choisis selon le sujet ; une même photo une seule fois) :
${catalog()}${own}

Règles :
- Français impeccable, vouvoiement, concret, bénéfices clients avant caractéristiques. Titres courts et marquants (hero : 4 à 9 mots). Pas de superlatifs creux.
- Utilise uniquement les vraies informations fournies (nom, ville, téléphone, services, preuves). N'invente pas de certification, d'année de création, de nombre d'avis ou de chiffres précis : si l'info manque, retire la statistique, la note ou le badge concerné, ou reste générique (« devis gratuit », « artisan assuré »).
- Pas d'avis inventés présentés comme réels : si aucun avis n'est fourni, retire la section testimonials et le champ hero.rating.
- SEO local : métier + ville dans seo.title, le hero et au moins une question de la FAQ.
- Couleurs : si des couleurs de marque sont données, adapte accent (et au besoin bg, surface) en gardant un contraste AA ; accentInk doit rester lisible sur accent.
- Les champs image n'acceptent que les valeurs listées ci-dessus (u:… ou {{asset:ID}}).
Réponds UNIQUEMENT avec le JSON complet du site, sans texte autour ni bloc markdown.`;
}

async function claude(sys, user, maxTokens = 14000, model = config.anthropicModel) {
  if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY manquant");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": config.anthropicApiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: sys, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`IA ${res.status} : ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j = await res.json();
  if (j.stop_reason === "max_tokens") throw new Error("La réponse de l'IA était trop longue, simplifie la demande");
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

function clean(d) {
  if (!d || typeof d !== "object") throw new Error("L'IA n'a pas renvoyé un site lisible, réessaie");
  const o = (x) => (x && typeof x === "object" && !Array.isArray(x) ? x : undefined);
  const out = {
    theme: o(d.theme) || {}, brand: o(d.brand) || {}, seo: o(d.seo) || {},
    navCta: o(d.navCta), nav: Array.isArray(d.nav) ? d.nav.slice(0, 6) : undefined, form: o(d.form),
    schemaType: typeof d.schemaType === "string" ? d.schemaType.slice(0, 40) : undefined,
    footerNote: typeof d.footerNote === "string" ? d.footerNote.slice(0, 200) : undefined,
    sections: (Array.isArray(d.sections) ? d.sections : []).filter((s) => s && SECTION_TYPES.includes(s.type)).slice(0, 16),
  };
  if (out.theme.headFont && !FONTS[out.theme.headFont]) delete out.theme.headFont;
  if (out.theme.bodyFont && !FONTS[out.theme.bodyFont]) delete out.theme.bodyFont;
  if (!out.sections.length) throw new Error("L'IA n'a pas renvoyé de sections, réessaie");
  if (!out.sections.some((s) => s.type === "contact")) out.sections.push({ type: "contact", title: "Contactez-nous" });
  return out;
}
function parse(text) {
  const t = String(text || "").replace(/```json|```/g, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("L'IA n'a pas renvoyé un site lisible, réessaie");
  return clean(JSON.parse(t.slice(a, b + 1)));
}

async function generate(templateKey, brief, assets) {
  const base = templates.get(templateKey);
  if (!base) throw new Error("Modèle introuvable");
  return parse(await claude(system(assets), `Modèle de départ (garde sa direction artistique, ses polices, ses variantes de sections et son rythme ; adapte la couleur d'accent seulement si le client a des couleurs de marque) :
${JSON.stringify(base)}

Informations sur l'entreprise :
${brief}

Personnalise entièrement le contenu pour cette entreprise : textes, coordonnées, services, déroulé, FAQ, photos adaptées au métier, options du formulaire. Ajoute ou retire des sections si le métier le justifie. Année en cours : ${new Date().getFullYear()}. Renvoie le JSON complet.`, 14000, config.studioModel));
}

async function edit(data, instruction, brief, assets) {
  return parse(await claude(system(assets) + "\nTu modifies un site existant : applique exactement la demande et garde tout le reste identique.", `Site actuel :
${JSON.stringify(data)}

Informations sur l'entreprise :
${brief}

Demande de modification : ${instruction}

Renvoie le JSON complet du site modifié.`));
}

module.exports = { generate, edit, clean };
