// Génère les assets de marque CLOSER (SVG + PNG) dans public/brand
// Usage : npm i opentype.js @expo-google-fonts/space-grotesk @resvg/resvg-js && node scripts/brand.js public/brand
const fs = require("fs");
const path = require("path");
const opentype = require("opentype.js");
const { Resvg } = require("@resvg/resvg-js");

const OUT = process.argv[2] || "./out";
fs.mkdirSync(OUT, { recursive: true });

const C = {
  noir: "#0B0B0F",
  graphite: "#16171D",
  ivoire: "#F4F1EA",
  or: "#F5B301",
};

const buf = fs.readFileSync(require.resolve("@expo-google-fonts/space-grotesk/700Bold/SpaceGrotesk_700Bold.ttf"));
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

// ---- Le symbole : un « C » (la boucle de la conversation) traversé par la ligne droite qui mène au close
function mark({ ring = C.ivoire, line = C.or, scale = 1, tx = 0, ty = 0 } = {}) {
  const cx = 249, cy = 256, r = 138, a = (40 * Math.PI) / 180;
  const x = (cx + r * Math.cos(a)).toFixed(2);
  const y1 = (cy + r * Math.sin(a)).toFixed(2);
  const y2 = (cy - r * Math.sin(a)).toFixed(2);
  return `<g transform="translate(${tx} ${ty}) scale(${scale})">
    <path d="M ${x} ${y1} A ${r} ${r} 0 1 1 ${x} ${y2}" fill="none" stroke="${ring}" stroke-width="58" stroke-linecap="round"/>
    <circle cx="${cx + r}" cy="${cy}" r="42" fill="${line}"/>
  </g>`;
}

// ---- Le logotype « CLOSER » en tracés (aucune police requise)
function wordmark(size, color, tracking = 0.06) {
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)); // police fraîche : contourne un bug de cache d'opentype.js
  const scale = size / font.unitsPerEm;
  let x = 0, maxX = 0;
  const parts = [];
  for (const ch of "CLOSER") {
    const g = font.charToGlyph(ch);
    const gp = font.getPath(ch, x, 0, size, { kerning: false, hinting: false });
    const d = gp.toPathData(2);
    if (d.includes("NaN")) throw new Error("NaN dans le glyphe " + ch);
    parts.push(d);
    const bb = gp.getBoundingBox();
    maxX = Math.max(maxX, bb.x2);
    const adv = Number.isFinite(g.advanceWidth) ? g.advanceWidth * scale : bb.x2 - x;
    x = Math.round((x + adv + size * tracking) * 100) / 100;
  }
  return { d: parts.join(" "), width: maxX, color };
}

function svg(w, h, body, bg) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${
    bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ""
  }${body}</svg>`;
}
function write(name, content) { fs.writeFileSync(path.join(OUT, name), content); }
function png(name, svgStr, width) {
  const r = new Resvg(svgStr, { fitTo: { mode: "width", value: width } });
  fs.writeFileSync(path.join(OUT, name), r.render().asPng());
}

// Icône d'app (fond arrondi)
const icon = (rx = 112) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="${rx}" fill="${C.noir}"/>${mark({ scale: 0.78, tx: 50, ty: 56 })}</svg>`;
// Icône maskable (fond plein, symbole dans la zone de sécurité)
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${C.noir}"/>${mark({ scale: 0.62, tx: 92, ty: 97 })}</svg>`;

write("icon.svg", icon());
write("favicon.svg", icon(120));
write("mark.svg", svg(512, 512, mark()));
write("mark-light.svg", svg(512, 512, mark({ ring: C.noir })));
png("icon-192.png", icon(), 192);
png("icon-512.png", icon(), 512);
png("maskable-512.png", maskable, 512);
png("apple-touch-icon.png", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${C.noir}"/>${mark({ scale: 0.78, tx: 50, ty: 56 })}</svg>`, 180);
png("favicon-32.png", icon(120), 32);

// Lockups horizontaux
function lockup(dark) {
  const wm = wordmark(150, dark ? C.ivoire : C.noir);
  const markScale = 0.42, markW = 512 * markScale, gap = 34, pad = 40;
  const W = Math.ceil(pad + markW + gap + wm.width + pad), H = 300;
  const body = `${mark({ ring: dark ? C.ivoire : C.noir, scale: markScale, tx: pad, ty: (H - 512 * markScale) / 2 })}
    <path d="${wm.d}" fill="${wm.color}" transform="translate(${pad + markW + gap} ${H / 2 + 52})"/>`;
  return svg(W, H, body, dark ? C.noir : null);
}
write("logo-dark.svg", lockup(true));
write("logo-dark-transparent.svg", lockup(true).replace(/<rect width="[0-9.]+" height="300" fill="#0B0B0F"\/>/, ""));
write("logo-light.svg", lockup(false));
png("logo-dark.png", lockup(true), 1200);

// Logotype seul (pour l'en-tête de l'app)
const wm = wordmark(100, C.ivoire);
write("wordmark.svg", svg(Math.ceil(wm.width) + 4, 100, `<path d="${wm.d}" fill="${C.ivoire}" transform="translate(2 74)"/>`));

// Image de partage (Open Graph)
const og = (() => {
  const w2 = wordmark(120, C.ivoire);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <rect width="1200" height="630" fill="${C.noir}"/>
  <line x1="0" y1="470" x2="1200" y2="470" stroke="${C.or}" stroke-width="2" opacity=".35"/>
  ${mark({ scale: 0.5, tx: 110, ty: 140 })}
  <path d="${w2.d}" fill="${C.ivoire}" transform="translate(400 310)"/>
  <rect x="404" y="345" width="70" height="8" rx="4" fill="${C.or}"/>
  </svg>`;
})();
png("og.png", og, 1200);
console.log("ok", fs.readdirSync(OUT).join(", "));
