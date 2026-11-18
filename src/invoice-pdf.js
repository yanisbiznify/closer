// Facture en vrai PDF (A4), aux couleurs de Biznify
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const DEFAULT_PNG = (() => { try { return fs.readFileSync(path.join(__dirname, "..", "public", "brand", "biznify-logo.png")); } catch { return null; } })();
// Helvetica (WinAnsi) : on remplace les espaces fines de l'écriture française
const clean = (s) => String(s ?? "").replace(/[  ]/g, " ").replace(/[’]/g, "'");
const money = (c, cur = "eur") => clean(new Intl.NumberFormat("fr-FR", { style: "currency", currency: cur.toUpperCase() }).format((c || 0) / 100));
const day = (d) => (d ? clean(new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" })) : "");

function logoBuffer(b) {
  const m = b.logo && /^data:image\/(png|jpe?g);base64,(.+)$/.exec(b.logo);
  if (m) return Buffer.from(m[2], "base64");
  return DEFAULT_PNG;
}

function render(inv, b) {
  const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true, info: { Title: `Facture ${inv.number}`, Author: b.company } });
  const accent = /^#[0-9a-fA-F]{6}$/.test(b.accent || "") ? b.accent : "#1877F2";
  const INK = "#0B1220", MUT = "#5B6475", LINE = "#E4E7EE";
  const W = doc.page.width, L = 48, R = W - 48, CW = R - L;
  const c = inv.client || {};
  const paid = inv.status === "payee";
  const cancelled = inv.status === "annulee";

  doc.rect(0, 0, W, 6).fill(accent);

  // En-tête : logo + titre
  const logo = logoBuffer(b);
  if (logo) { try { doc.image(logo, L, 44, { height: 34 }); } catch { doc.font("Helvetica-Bold").fontSize(20).fillColor(INK).text(clean(b.company), L, 48); } }
  else doc.font("Helvetica-Bold").fontSize(20).fillColor(INK).text(clean(b.company), L, 48);
  doc.font("Helvetica-Bold").fontSize(24).fillColor(INK).text("Facture", L, 42, { width: CW, align: "right" });
  doc.font("Helvetica").fontSize(10.5).fillColor(MUT).text(`N° ${clean(inv.number)}`, L, 72, { width: CW, align: "right" });
  const badge = paid ? ["PAYÉE" + (inv.paid_at ? " LE " + day(inv.paid_at).toUpperCase() : ""), "#11643C", "#E9F8F0"] : cancelled ? ["ANNULÉE", MUT, "#EEF0F4"] : ["À PAYER", "#1D4ED8", "#EEF4FF"];
  doc.font("Helvetica-Bold").fontSize(8.5);
  const bw = doc.widthOfString(badge[0]) + 16;
  doc.roundedRect(R - bw, 90, bw, 18, 9).fill(badge[2]);
  doc.fillColor(badge[1]).text(badge[0], R - bw, 95, { width: bw, align: "center" });

  // Parties
  let y = 132;
  const col = (x, title, lines, w) => {
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(MUT).text(title.toUpperCase(), x, y, { width: w, characterSpacing: 0.4 });
    let yy = y + 15;
    lines.filter(Boolean).forEach((l, i) => {
      doc.font(i === 0 ? "Helvetica-Bold" : "Helvetica").fontSize(i === 0 ? 10.5 : 9.5).fillColor(i === 0 ? INK : "#2B3445");
      doc.text(clean(l), x, yy, { width: w }); yy = doc.y + 2;
    });
    return yy;
  };
  const cw = (CW - 40) / 3;
  const from = [b.company, b.address, b.registration, b.vatNumber ? "N° TVA : " + b.vatNumber : "", [b.email, b.phone].filter(Boolean).join(" · "), b.website];
  const to = [c.company || c.name, c.company && c.name ? c.name : "", c.address, c.vat ? "N° TVA : " + c.vat : "", c.email];
  const dates = ["Émise le " + day(inv.issue_date), inv.due_date ? "Échéance le " + day(inv.due_date) : ""];
  const y1 = col(L, "Émise par", from, cw), y2 = col(L + cw + 20, "Facturée à", to, cw);
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(MUT).text("DATES", L + 2 * (cw + 20), y, { width: cw, characterSpacing: 0.4 });
  let y3 = y + 15; dates.filter(Boolean).forEach((d) => { doc.font("Helvetica").fontSize(9.5).fillColor("#2B3445").text(d, L + 2 * (cw + 20), y3, { width: cw }); y3 = doc.y + 2; });
  y = Math.max(y1, y2, y3) + 18;
  doc.moveTo(L, y).lineTo(R, y).lineWidth(1).strokeColor(LINE).stroke();
  y += 16;
  if (inv.title) { doc.font("Helvetica-Bold").fontSize(12).fillColor(INK).text(clean(inv.title), L, y, { width: CW }); y = doc.y + 12; }

  // Lignes
  const cx = [L, R - 250, R - 170, R - 80];
  const head = (yy) => {
    doc.font("Helvetica-Bold").fontSize(8.5).fillColor(MUT);
    doc.text("DESCRIPTION", cx[0], yy); doc.text("QTÉ", cx[1], yy, { width: 60, align: "right" });
    doc.text("PRIX UNIT. HT", cx[2], yy, { width: 80, align: "right" }); doc.text("TOTAL HT", cx[3], yy, { width: 80, align: "right" });
    doc.moveTo(L, yy + 15).lineTo(R, yy + 15).strokeColor(LINE).stroke();
    return yy + 24;
  };
  y = head(y);
  for (const it of inv.items || []) {
    doc.font("Helvetica").fontSize(10).fillColor(INK);
    const h = Math.max(doc.heightOfString(clean(it.label), { width: cx[1] - L - 16 }), 12);
    if (y + h > doc.page.height - 200) { doc.addPage(); y = head(60); }
    doc.text(clean(it.label), L, y, { width: cx[1] - L - 16 });
    doc.text(String(it.qty).replace(".", ","), cx[1], y, { width: 60, align: "right" });
    doc.text(money(it.unit_cents, inv.currency), cx[2], y, { width: 80, align: "right" });
    doc.text(money(Math.round(it.qty * it.unit_cents), inv.currency), cx[3], y, { width: 80, align: "right" });
    y += h + 10;
    doc.moveTo(L, y - 4).lineTo(R, y - 4).strokeColor(LINE).stroke();
    y += 6;
  }

  // Totaux
  y += 6;
  const tl = R - 230;
  const row = (lab, val, bold) => {
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 13 : 10).fillColor(bold ? INK : MUT).text(lab, tl, y, { width: 120 });
    doc.fillColor(INK).text(val, tl + 110, y, { width: 120, align: "right" });
    y = doc.y + 7;
  };
  row("Total HT", money(inv.subtotal_cents, inv.currency));
  row(`TVA ${String(Number(inv.vat_rate)).replace(".", ",")} %`, money(inv.vat_cents, inv.currency));
  doc.moveTo(tl, y).lineTo(R, y).lineWidth(1.5).strokeColor(INK).stroke(); y += 8;
  row("Total TTC", money(inv.total_cents, inv.currency), true);
  if (b.vatMention) { doc.font("Helvetica").fontSize(8.5).fillColor(MUT).text(clean(b.vatMention), L, y + 2, { width: CW, align: "right" }); y = doc.y + 6; }

  // Encadré paiement
  y += 14;
  if (y > doc.page.height - 170) { doc.addPage(); y = 60; }
  const boxH = 58;
  doc.roundedRect(L, y, CW, boxH, 10).fill(paid ? "#E9F8F0" : "#F5F7FB");
  if (paid) {
    doc.font("Helvetica-Bold").fontSize(11.5).fillColor("#11643C").text("Facture réglée. Merci !", L + 18, y + 14);
    doc.font("Helvetica").fontSize(9.5).text(`Paiement de ${money(inv.total_cents, inv.currency)} reçu${inv.paid_at ? " le " + day(inv.paid_at) : ""}${inv.paid_via ? " (" + clean(inv.paid_via) + ")" : ""}.`, L + 18, y + 32);
  } else if (!cancelled) {
    doc.font("Helvetica").fontSize(9.5).fillColor(MUT).text("Montant à régler", L + 18, y + 12);
    doc.font("Helvetica-Bold").fontSize(17).fillColor(INK).text(money(inv.total_cents, inv.currency), L + 18, y + 26);
    if (inv.pay_url) doc.font("Helvetica").fontSize(9.5).fillColor(accent).text("Payer en ligne par carte", R - 200, y + 23, { width: 182, align: "right", link: inv.pay_url, underline: true });
  } else {
    doc.font("Helvetica-Bold").fontSize(11).fillColor(MUT).text("Facture annulée : aucun paiement n'est demandé.", L + 18, y + 22);
  }
  y += boxH + 18;

  if (inv.notes) { doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK).text("Note", L, y); doc.font("Helvetica").fillColor(MUT).text(clean(inv.notes), L, doc.y + 2, { width: CW }); y = doc.y + 10; }
  if (b.paymentTerms) { doc.font("Helvetica-Bold").fontSize(9.5).fillColor(INK).text("Conditions de paiement", L, y); doc.font("Helvetica").fillColor(MUT).text(clean(b.paymentTerms), L, doc.y + 2, { width: CW }); }

  // Pied de page
  const foot = clean([b.company, b.registration, b.footer].filter(Boolean).join(" — "));
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(8).fillColor(MUT).text(foot, L, doc.page.height - 40, { width: CW, align: "center", lineBreak: false });
  }
  doc.end();
  return doc;
}

module.exports = { render };
