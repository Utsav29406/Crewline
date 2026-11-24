import PDFDocument from 'pdfkit';
import fs from 'node:fs';

/**
 * The payslip as a PDF, built on the server so the emailed attachment and the "Download PDF" button are the same
 * file (no browser print headers, page footers or app menus). Noto Sans is bundled because PDF's built-in fonts
 * have no ₹ sign.
 */
// Read with fs + import.meta.url so Vercel's file tracing bundles the fonts with the function.
let fonts;
const loadFonts = () => (fonts ||= {
  regular: fs.readFileSync(new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)),
  bold: fs.readFileSync(new URL('../assets/fonts/NotoSans-Bold.ttf', import.meta.url)),
});

const INK = '#1d2233', MUTED = '#6b7288', LINE = '#e3e6ee', ACCENT = '#6366f1', NET_BG = '#f3f1ff';

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const under1000 = (n) => {
  const h = Math.floor(n / 100), r = n % 100;
  const rest = r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? ` ${ONES[r % 10]}` : ''}`;
  return [h ? `${ONES[h]} Hundred` : '', rest].filter(Boolean).join(' ');
};
/** Indian grouping (lakh, crore) for INR, international otherwise — same as the app. */
export function amountInWords(amount, currency = 'INR') {
  let n = Math.round(Math.abs(amount || 0));
  if (!n) return 'Zero';
  const units = currency === 'INR' ? [[1e7, 'Crore'], [1e5, 'Lakh'], [1e3, 'Thousand']] : [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']];
  const parts = [];
  for (const [size, name] of units) {
    if (n >= size) {
      const chunk = Math.floor(n / size);
      parts.push(`${chunk >= 1000 ? amountInWords(chunk, currency) : under1000(chunk)} ${name}`);
      n %= size;
    }
  }
  if (n) parts.push(under1000(n));
  return parts.join(' ');
}

export function money(currency) {
  try {
    const f = new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en', { style: 'currency', currency, maximumFractionDigits: 0 });
    return (n) => f.format(Math.round(Number(n) || 0));
  } catch {
    return (n) => `${currency || ''} ${Math.round(Number(n) || 0).toLocaleString('en-IN')}`.trim();
  }
}

export const monthLabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dateLabel = (d) => (d ? new Date(String(d).replace(' ', 'T')).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/** A PNG/JPEG data URL → Buffer (PDFKit can't draw SVG or WebP, so those are left out). */
function logoBuffer(logo) {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(String(logo || ''));
  return m ? Buffer.from(m[2], 'base64') : null;
}

/**
 * slip: a payslips row plus month, currency, published_at; company: { name, logo }.
 * Resolves to the PDF bytes.
 */
export function payslipPdf(slip, company) {
  const { regular: FONT, bold: BOLD } = loadFonts();
  const doc = new PDFDocument({ size: 'A4', margin: 48, font: FONT, info: { Title: `Payslip ${monthLabel(slip.month)} - ${slip.name}`, Author: company.name } });
  doc.registerFont('r', FONT);
  doc.registerFont('b', BOLD);
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

  const fmt = money(slip.currency);
  const L = 48, R = doc.page.width - 48, W = R - L;
  let y = 48;

  // Header: logo, PAYSLIP / company name; month and issue date on the right.
  let textX = L;
  const logo = logoBuffer(company.logo);
  if (logo) {
    try {
      doc.image(logo, L, y, { fit: [56, 56], valign: 'center' });
      textX = L + 70;
    } catch { /* unreadable image: skip the logo */ }
  }
  doc.font('b').fontSize(9).fillColor(MUTED).text('PAYSLIP', textX, y + 6, { characterSpacing: 1 });
  doc.font('b').fontSize(20).fillColor(INK).text(company.name, textX, y + 20, { width: R - textX - 160, lineBreak: false, ellipsis: true });
  doc.font('b').fontSize(14).fillColor(INK).text(monthLabel(slip.month), R - 160, y + 6, { width: 160, align: 'right' });
  doc.font('r').fontSize(9.5).fillColor(MUTED).text(slip.published_at ? `Issued ${dateLabel(slip.published_at)}` : 'Draft — not yet sent', R - 160, y + 26, { width: 160, align: 'right' });
  y += 70;
  doc.moveTo(L, y).lineTo(R, y).lineWidth(1.5).strokeColor(INK).stroke();
  y += 16;

  // Employee details: 4 columns.
  const info = [
    ['Employee', slip.name], ['Employee code', slip.emp_code || '—'], ['Department', slip.department || '—'], ['Designation', slip.designation || '—'],
    ['Working days', slip.working_days], ['Payable days', slip.payable_days], ['Present', slip.present], ['Paid leave', slip.paid_leave],
    ['Unpaid leave', slip.unpaid_leave], ['Absent', slip.absent], ['Hours worked', slip.hours], ['Monthly salary', fmt(slip.monthly_salary)],
  ];
  const colW = W / 4;
  info.forEach(([k, v], i) => {
    const x = L + (i % 4) * colW, yy = y + Math.floor(i / 4) * 38;
    doc.font('b').fontSize(7.5).fillColor(MUTED).text(k.toUpperCase(), x, yy, { width: colW - 10, characterSpacing: 0.5 });
    doc.font('b').fontSize(10.5).fillColor(INK).text(String(v ?? '—'), x, yy + 12, { width: colW - 10, lineBreak: false, ellipsis: true });
  });
  y += 3 * 38 + 4;
  doc.moveTo(L, y).lineTo(R, y).lineWidth(0.75).strokeColor(LINE).stroke();
  y += 18;

  // Earnings and deductions side by side.
  const earnings = [['Basic', slip.basic, true], ['House Rent Allowance', slip.hra, true], ['Special Allowance', slip.special, true], ['Bonus', slip.bonus]]
    .filter(([, v, always]) => always || v);
  const deductions = [['Provident Fund (PF)', slip.pf, true], ['Professional Tax', slip.pt, true], ['Other deductions', slip.other_deduction]]
    .filter(([, v, always]) => always || v);
  const gap = 24, tW = (W - gap) / 2;
  const table = (x, title, rows, totalLabel, total) => {
    let ty = y;
    doc.font('b').fontSize(8).fillColor(MUTED).text(title.toUpperCase(), x, ty, { characterSpacing: 0.5 });
    doc.text('AMOUNT', x, ty, { width: tW, align: 'right', characterSpacing: 0.5 });
    ty += 16;
    doc.moveTo(x, ty).lineTo(x + tW, ty).lineWidth(0.75).strokeColor(LINE).stroke();
    for (const [k, v] of rows) {
      ty += 8;
      doc.font('r').fontSize(10).fillColor(INK).text(k, x, ty, { width: tW - 90 });
      doc.text(fmt(v), x, ty, { width: tW, align: 'right' });
      ty += 16;
      doc.moveTo(x, ty).lineTo(x + tW, ty).lineWidth(0.5).strokeColor('#f0f2f6').stroke();
    }
    return { ty, draw: (atY) => {
      doc.moveTo(x, atY).lineTo(x + tW, atY).lineWidth(1.5).strokeColor(INK).stroke();
      doc.font('b').fontSize(10.5).fillColor(INK).text(totalLabel, x, atY + 8);
      doc.text(fmt(total), x, atY + 8, { width: tW, align: 'right' });
    } };
  };
  const e = table(L, 'Earnings', earnings, 'Total earnings', slip.gross + slip.bonus);
  const d = table(L + tW + gap, 'Deductions', deductions, 'Total deductions', slip.pf + slip.pt + slip.other_deduction);
  const totalsY = Math.max(e.ty, d.ty) + 4; // totals line up across both columns
  e.draw(totalsY);
  d.draw(totalsY);
  y = totalsY + 40;

  if (slip.adjustment_note && (slip.bonus || slip.other_deduction)) {
    doc.font('r').fontSize(9.5).fillColor(MUTED).text(`Note from HR: ${slip.adjustment_note}`, L, y, { width: W });
    y = doc.y + 12;
  }

  // Net pay band.
  doc.roundedRect(L, y, W, 64, 12).fill(NET_BG);
  doc.font('b').fontSize(9).fillColor(ACCENT).text('NET PAY', L + 18, y + 14, { characterSpacing: 1 });
  const words = `${slip.currency === 'INR' ? 'Rupees' : slip.currency} ${amountInWords(slip.net, slip.currency)} only`;
  doc.font('r').fontSize(9.5).fillColor(INK).text(words, L + 18, y + 30, { width: W - 200 });
  doc.font('b').fontSize(22).fillColor(INK).text(fmt(slip.net), R - 200, y + 18, { width: 182, align: 'right' });
  y += 84;

  const foot = [
    slip.lop > 0 ? `Loss of pay for unpaid / absent days: ${fmt(slip.lop)} (already reflected in earnings).` : '',
    'This is a system-generated payslip and does not require a signature.',
  ].filter(Boolean).join(' ');
  doc.font('r').fontSize(8.5).fillColor(MUTED).text(foot, L, y, { width: W });
  doc.end();
  return done;
}

export const payslipFileName = (slip) =>
  `Payslip-${slip.month}-${String(slip.name).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}.pdf`;
