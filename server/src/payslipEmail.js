import db from './db.js';
import { deliver, emailLayout, EMAIL_RE, esc, mailer } from './mail.js';
import { payslipFileName, payslipPdf } from './payslipPdf.js';

/**
 * Emails each employee their own payslip when HR sends payroll: the full breakdown in the email, the payslip PDF
 * attached, and a link to open it in Crewline. Sending stops at a time budget (Vercel ends a request at 15 s), and whatever
 * is left is picked up by the next call, so the Payroll page keeps calling until nothing remains.
 */
const APP_URL = process.env.APP_URL || 'https://getcrewline.vercel.app';
const monthLabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function money(currency) {
  try {
    const f = new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 });
    return (n) => f.format(Number(n) || 0);
  } catch {
    return (n) => `${currency || ''} ${(Number(n) || 0).toLocaleString('en-IN')}`.trim();
  }
}

export function payslipEmail(slip, run, company) {
  const fmt = money(run.currency);
  const month = monthLabel(run.month);
  const earnings = [['Basic', slip.basic, true], ['House Rent Allowance', slip.hra, true], ['Special Allowance', slip.special, true], ['Bonus', slip.bonus]]
    .filter(([, v, always]) => always || v);
  const deductions = [['Provident Fund (PF)', slip.pf, true], ['Professional Tax', slip.pt, true], ['Other deductions', slip.other_deduction]]
    .filter(([, v, always]) => always || v);
  const totalEarnings = slip.gross + slip.bonus;
  const totalDeductions = slip.pf + slip.pt + slip.other_deduction;
  const info = [['Employee code', slip.emp_code || '—'], ['Department', slip.department || '—'], ['Designation', slip.designation || '—'],
    ['Working days', slip.working_days], ['Payable days', slip.payable_days], ['Paid leave', slip.paid_leave], ['Unpaid leave', slip.unpaid_leave], ['Absent', slip.absent]];

  const cell = 'padding:7px 0;font-size:14px;border-bottom:1px solid #eef0f5';
  const section = (title, rows, totalLabel, total) => `
  <tr><td colspan="2" style="padding:16px 0 4px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#8a90a6">${title}</td></tr>
  ${rows.map(([k, v]) => `<tr><td style="${cell};color:#535b74">${esc(k)}</td><td align="right" style="${cell};color:#262b3d">${esc(fmt(v))}</td></tr>`).join('')}
  <tr><td style="padding:7px 0;font-size:14px;font-weight:700">${totalLabel}</td><td align="right" style="padding:7px 0;font-size:14px;font-weight:700">${esc(fmt(total))}</td></tr>`;
  const link = `${APP_URL}/payslips`;
  const html = emailLayout(`
  <div style="font-size:13px;color:#747c94;font-weight:600">${esc(company)}</div>
  <h1 style="margin:4px 0 4px;font-size:20px;color:#262b3d">Payslip for ${esc(month)}</h1>
  <p style="margin:0 0 14px;font-size:14px;color:#535b74">Hi ${esc(slip.name.split(' ')[0])}, your payslip is ready. The PDF is attached.</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef2ff" style="background:#eef2ff;border-radius:12px">
    <tr><td style="padding:14px 16px;font-family:'Segoe UI',Helvetica,Arial,sans-serif">
      <div style="font-size:12px;font-weight:700;color:#6366f1;letter-spacing:.06em">NET PAY</div>
      <div style="font-size:26px;font-weight:700;color:#262b3d">${esc(fmt(slip.net))}</div>
    </td></tr>
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;font-family:'Segoe UI',Helvetica,Arial,sans-serif">
    <tr><td colspan="2" style="padding:16px 0 4px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#8a90a6">Details</td></tr>
    ${info.map(([k, v]) => `<tr><td style="${cell};color:#535b74">${esc(k)}</td><td align="right" style="${cell};color:#262b3d">${esc(v)}</td></tr>`).join('')}
    ${section('Earnings', earnings, 'Total earnings', totalEarnings)}
    ${section('Deductions', deductions, 'Total deductions', totalDeductions)}
  </table>
  ${slip.adjustment_note ? `<p style="margin:12px 0 0;font-size:13px;color:#535b74">Note from HR: ${esc(slip.adjustment_note)}</p>` : ''}
  ${slip.lop > 0 ? `<p style="margin:8px 0 0;font-size:13px;color:#747c94">Loss of pay for unpaid / absent days: ${esc(fmt(slip.lop))} (already reflected in earnings).</p>` : ''}
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0"><tr><td bgcolor="#6366f1" style="border-radius:10px">
    <a href="${esc(link)}" style="display:inline-block;padding:10px 18px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;font-family:'Segoe UI',Helvetica,Arial,sans-serif">Open in Crewline</a></td></tr></table>`,
  `${company} · sent with Crewline. This payslip is confidential.`);

  const line = ([k, v]) => `${k}: ${fmt(v)}`;
  const text = [
    company, `Payslip for ${month}`, '', `Net pay: ${fmt(slip.net)}`, '',
    ...info.map(([k, v]) => `${k}: ${v}`), '', 'Earnings', ...earnings.map(line), `Total earnings: ${fmt(totalEarnings)}`,
    '', 'Deductions', ...deductions.map(line), `Total deductions: ${fmt(totalDeductions)}`,
    ...(slip.adjustment_note ? ['', `Note from HR: ${slip.adjustment_note}`] : []),
    '', `Open and download it in Crewline: ${link}`,
  ].join('\n');
  return { subject: `Your payslip for ${month} · ${company}`, html, text };
}

/**
 * Emails the run's payslips that haven't gone out yet (or only `slipIds`, to send again). Each batch is claimed
 * first, so two requests running at once never email the same payslip. No new batch starts after `deadline`
 * (Vercel ends a request at 15 s); the caller asks again for the rest.
 */
export async function emailPayslips(run, { slipIds = null, deadline = Date.now() + 8000 } = {}) {
  const smtp = mailer();
  if (!smtp) return { emailed: 0, failed: 0, remaining: 0, noSmtp: true };
  const companyRow = await db.get('SELECT name, logo FROM companies WHERE id = ?', [run.company_id]);
  const company = companyRow.name;
  const SLIP_SQL = 'SELECT s.*, u.email FROM payslips s JOIN users u ON u.id = s.user_id WHERE s.id = ANY(?::int[]) ORDER BY s.name';
  // Not yet emailed, not failed, and not being emailed by another request (a claim older than 2 minutes was lost).
  const WAITING = `s.run_id = ? AND s.user_id IS NOT NULL AND s.emailed_at IS NULL AND s.email_error IS NULL
    AND (s.email_claimed_at IS NULL OR s.email_claimed_at < now() - interval '2 minutes')`;
  const claim = async () => (await db.all(
    `UPDATE payslips SET email_claimed_at = now() WHERE id IN (
       SELECT s.id FROM payslips s WHERE ${WAITING} ORDER BY s.name LIMIT 4 FOR UPDATE SKIP LOCKED) RETURNING id`,
    [run.id]
  )).map((r) => r.id);

  const send = async (s) => {
    try {
      if (!EMAIL_RE.test(s.email || '')) throw new Error('No valid email address');
      const { subject, html, text } = payslipEmail(s, run, company);
      const slip = { ...s, month: run.month, currency: run.currency, published_at: run.published_at };
      const pdf = await payslipPdf(slip, companyRow);
      await deliver(smtp, { to: s.email, subject, text, html, attachments: [{ filename: payslipFileName(slip), content: pdf, contentType: 'application/pdf' }] });
      await db.run('UPDATE payslips SET emailed_at = now(), email_error = NULL, email_claimed_at = NULL WHERE id = ?', [s.id]);
      return true;
    } catch (err) {
      console.error('payslip email failed', s.id, err.message);
      await db.run('UPDATE payslips SET email_error = ?, email_claimed_at = NULL WHERE id = ?', [String(err.message).slice(0, 200), s.id]);
      return false;
    }
  };

  let emailed = 0, failed = 0;
  const tally = (ok) => (ok ? emailed++ : failed++);
  if (slipIds) {
    const rows = await db.all(SLIP_SQL.replace('WHERE', 'WHERE s.run_id = ? AND'), [run.id, slipIds]);
    for (const s of rows) tally(await send(s));
    return { emailed, failed, remaining: 0 };
  }
  while (Date.now() < deadline) {
    const ids = await claim();
    if (!ids.length) break;
    const rows = await db.all(SLIP_SQL, [ids]);
    (await Promise.all(rows.map(send))).forEach(tally);
  }
  const { n } = await db.get(`SELECT COUNT(*)::int AS n FROM payslips s WHERE ${WAITING}`, [run.id]);
  return { emailed, failed, remaining: n };
}
