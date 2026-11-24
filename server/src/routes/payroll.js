import { Router } from 'express';
import db, { tx, getSettings, isUniqueViolation } from '../db.js';
import { requireRole, isManager } from '../auth.js';
import { emit } from '../events.js';
import { clock } from '../utils.js';
import { monthlySummary, computePayslip } from '../payroll.js';
import { emailPayslips } from '../payslipEmail.js';
import { payslipFileName, payslipPdf } from '../payslipPdf.js';
import { audit } from '../audit.js';

const router = Router();
const manager = requireRole('admin', 'hr');
const MONTH = /^\d{4}-\d{2}$/;
const monthLabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const PAYSLIP_COLS = [
  'monthly_salary', 'working_days', 'payable_days', 'present', 'late', 'half_days', 'paid_leave', 'unpaid_leave', 'absent', 'hours',
  'basic', 'hra', 'special', 'gross', 'lop', 'bonus', 'pf', 'pt', 'other_deduction', 'adjustment_note', 'net',
];

const RUN_SQL = `
  SELECT r.*, g.name AS generated_by_name, p.name AS published_by_name,
         (SELECT COUNT(*) FROM payslips s WHERE s.run_id = r.id) AS employees,
         (SELECT COALESCE(SUM(net), 0) FROM payslips s WHERE s.run_id = r.id) AS total_net,
         (SELECT COALESCE(SUM(gross + bonus), 0) FROM payslips s WHERE s.run_id = r.id) AS total_gross,
         (SELECT COUNT(*) FROM payslips s WHERE s.run_id = r.id AND s.viewed_at IS NOT NULL) AS viewed,
         (SELECT COUNT(*) FROM payslips s WHERE s.run_id = r.id AND s.emailed_at IS NOT NULL) AS emailed,
         (SELECT COUNT(*) FROM payslips s WHERE s.run_id = r.id AND s.user_id IS NOT NULL AND s.emailed_at IS NULL AND s.email_error IS NULL) AS email_waiting,
         (SELECT COUNT(*) FROM payslips s WHERE s.run_id = r.id AND s.email_error IS NOT NULL) AS email_failed
  FROM payroll_runs r
  LEFT JOIN users g ON g.id = r.generated_by
  LEFT JOIN users p ON p.id = r.published_by`;

const changed = (req, runId) => emit(req.user, { type: 'payroll.changed', data: { runId } });

/* ---------- Admin / HR ---------- */
router.get('/runs', manager, async (req, res) => {
  res.json(await db.all(`${RUN_SQL} WHERE r.company_id = ? ORDER BY r.month DESC`, [req.user.company_id]));
});

router.get('/runs/:id', manager, async (req, res) => {
  const run = await db.get(`${RUN_SQL} WHERE r.id = ? AND r.company_id = ?`, [Number(req.params.id), req.user.company_id]);
  if (!run) return res.status(404).json({ error: 'Payroll run not found' });
  const payslips = await db.all('SELECT * FROM payslips WHERE run_id = ? ORDER BY name', [run.id]);
  res.json({ run, payslips });
});

/** Generates (or regenerates) the draft for a month. Bonuses/deductions already entered are kept. */
router.post('/runs', manager, async (req, res) => {
  const month = String(req.body?.month || '');
  if (!MONTH.test(month)) return res.status(400).json({ error: 'Pick a month' });
  const cid = req.user.company_id;
  const existing = await db.get('SELECT * FROM payroll_runs WHERE company_id = ? AND month = ?', [cid, month]);
  if (existing?.status === 'published') {
    return res.status(409).json({ error: `Payroll for ${monthLabel(month)} has already been sent to employees` });
  }
  const [summary, settings] = await Promise.all([monthlySummary(cid, month), getSettings(cid)]);
  // Only people with a salary get a payslip (owners/admins without one would get a ₹0 slip).
  summary.rows = summary.rows.filter((r) => Number(r.salary) > 0);
  if (!summary.rows.length) return res.status(400).json({ error: 'No active employees with a salary for this month. Set salaries in Employees.' });
  const now = clock(req.user.timezone).dateTime;

  let runId;
  try {
    runId = await tx(async (t) => {
      let id = existing?.id;
      const kept = {};
      if (id) {
        // Locked, and checked again: someone may have published it since the check above.
        const current = await t.get('SELECT status FROM payroll_runs WHERE id = ? FOR UPDATE', [id]);
        if (current?.status !== 'draft') throw Object.assign(new Error('published'), { published: true });
        for (const p of await t.all('SELECT user_id, bonus, other_deduction, adjustment_note FROM payslips WHERE run_id = ? FOR UPDATE', [id])) kept[p.user_id] = p;
        await t.run('DELETE FROM payslips WHERE run_id = ?', [id]);
        await t.run('UPDATE payroll_runs SET working_days = ?, currency = ?, generated_by = ?, generated_at = ? WHERE id = ?',
          [summary.workingDays, settings.currency, req.user.id, now, id]);
      } else {
        id = (await t.get(
          `INSERT INTO payroll_runs (company_id, month, working_days, currency, generated_by, generated_at)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
          [cid, month, summary.workingDays, settings.currency, req.user.id, now]
        )).id;
      }
      for (const row of summary.rows) {
        const slip = computePayslip(row, summary.workingDays, settings, kept[row.id]);
        const cols = ['company_id', 'run_id', 'user_id', 'emp_code', 'name', 'department', 'designation', ...PAYSLIP_COLS];
        const vals = [cid, id, row.id, row.emp_code, row.name, row.department, row.designation, ...PAYSLIP_COLS.map((c) => slip[c])];
        await t.run(`INSERT INTO payslips (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
      }
      return id;
    });
  } catch (err) {
    if (err.published) return res.status(409).json({ error: `Payroll for ${monthLabel(month)} has already been sent to employees` });
    // Two "Generate" clicks at once for a new month: the second loses the insert race.
    if (isUniqueViolation(err)) return res.status(409).json({ error: `Payroll for ${monthLabel(month)} is already being generated. Refresh in a moment.` });
    throw err;
  }
  await changed(req, runId);
  await audit(req, { area: 'payroll', action: `${existing ? 'recalculated' : 'generated'} payroll for ${monthLabel(month)}`, changes: { employees: [null, summary.rows.length] } });
  res.status(existing ? 200 : 201).json(await db.get(`${RUN_SQL} WHERE r.id = ?`, [runId]));
});

/** Bonus / extra deduction on one payslip while the run is still a draft. */
router.put('/payslips/:id', manager, async (req, res) => {
  const slip = await db.get(
    `SELECT s.*, r.status, r.working_days AS run_days FROM payslips s JOIN payroll_runs r ON r.id = s.run_id
     WHERE s.id = ? AND s.company_id = ?`,
    [Number(req.params.id), req.user.company_id]
  );
  if (!slip) return res.status(404).json({ error: 'Payslip not found' });
  if (slip.status !== 'draft') return res.status(409).json({ error: 'This payroll has already been sent' });
  // Whole currency units (the payslip, PDF and email all show whole amounts), within a sane range.
  const amount = (v) => Math.min(Math.max(Math.round(Number(v) || 0), 0), 100_000_000);
  const bonus = amount(req.body?.bonus);
  const other = amount(req.body?.other_deduction);
  const note = String(req.body?.adjustment_note || '').slice(0, 200) || null;
  const net = Math.max(slip.gross + bonus - slip.pf - slip.pt - other, 0);
  // The draft check is repeated in the UPDATE so an edit can't land on a run published in the meantime.
  const updated = await db.get(
    `UPDATE payslips SET bonus = ?, other_deduction = ?, adjustment_note = ?, net = ? WHERE id = ?
     AND EXISTS (SELECT 1 FROM payroll_runs r WHERE r.id = payslips.run_id AND r.status = 'draft') RETURNING *`,
    [bonus, other, note, net, slip.id]
  );
  if (!updated) return res.status(409).json({ error: 'This payroll has already been sent' });
  await changed(req, slip.run_id);
  const changes = {};
  if (slip.bonus !== bonus) changes.bonus = [slip.bonus, bonus];
  if (slip.other_deduction !== other) changes.other_deduction = [slip.other_deduction, other];
  if ((slip.adjustment_note || null) !== note) changes.note = [slip.adjustment_note || null, note];
  if (Object.keys(changes).length) {
    const run = await db.get('SELECT month FROM payroll_runs WHERE id = ?', [slip.run_id]);
    await audit(req, { area: 'payroll', action: `adjusted ${monthLabel(run.month)} payslip`, target: { id: slip.user_id, name: slip.name }, changes });
  }
  res.json(updated);
});

/** Publishes the run: every employee can now see their payslip and gets a notification. */
router.post('/runs/:id/publish', manager, async (req, res) => {
  const started = Date.now();
  const now = clock(req.user.timezone).dateTime;
  const run = await db.get(
    `UPDATE payroll_runs SET status = 'published', published_by = ?, published_at = ?
     WHERE id = ? AND company_id = ? AND status = 'draft' RETURNING *`,
    [req.user.id, now, Number(req.params.id), req.user.company_id]
  );
  if (!run) return res.status(409).json({ error: 'Payroll not found or already sent' });
  const slips = await db.all('SELECT id, user_id, net FROM payslips WHERE run_id = ? AND user_id IS NOT NULL', [run.id]);
  // The run is already published here, so a bad currency code must not stop the notifications.
  let fmt;
  try {
    fmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: run.currency, maximumFractionDigits: 0 });
  } catch {
    fmt = { format: (n) => `${run.currency || ''} ${Math.round(n).toLocaleString('en-IN')}`.trim() };
  }
  // In batches, not one by one: with email notifications on, each one also sends an email.
  for (let i = 0; i < slips.length; i += 10) {
    await Promise.all(slips.slice(i, i + 10).map((s) => emit(req.user, {
      type: 'payroll.published', audience: 'user', userId: s.user_id, notify: true,
      title: `Your payslip for ${monthLabel(run.month)} is ready`,
      body: `Net pay ${fmt.format(s.net)} · open Payslips to view or download`,
      data: { payslipId: s.id }, email: false, // the payslip email below replaces the notification email
    })));
  }
  // Each employee also gets their payslip by email (the rest continue via POST /runs/:id/email if time runs out).
  const email = await emailPayslips(run, { deadline: started + 7000 });
  await audit(req, { area: 'payroll', action: `sent ${monthLabel(run.month)} payslips`, changes: { employees: [null, slips.length] } });
  await changed(req, run.id);
  res.json({ ...run, sent: slips.length, email });
});

/**
 * Emails payslips of a sent run: those not emailed yet, or `{ retry: true }` also the ones that failed,
 * or `{ payslipId }` one again.
 */
router.post('/runs/:id/email', manager, async (req, res) => {
  const run = await db.get(`SELECT * FROM payroll_runs WHERE id = ? AND company_id = ? AND status = 'published'`, [Number(req.params.id), req.user.company_id]);
  if (!run) return res.status(404).json({ error: 'Sent payroll not found' });
  let slipIds = null;
  if (req.body?.payslipId) {
    if (!/^\d{1,9}$/.test(String(req.body.payslipId))) return res.status(400).json({ error: 'Payslip not found' });
    slipIds = [Number(req.body.payslipId)];
  }
  else if (req.body?.retry) await db.run('UPDATE payslips SET email_error = NULL WHERE run_id = ? AND emailed_at IS NULL', [run.id]);
  const email = await emailPayslips(run, { slipIds, deadline: Date.now() + 8000 });
  if (email.noSmtp) return res.status(503).json({ error: 'Email is not set up on the server' });
  await changed(req, run.id);
  res.json(email);
});

router.delete('/runs/:id', manager, async (req, res) => {
  const run = await db.get('SELECT status FROM payroll_runs WHERE id = ? AND company_id = ?', [Number(req.params.id), req.user.company_id]);
  if (!run) return res.status(404).json({ error: 'Payroll run not found' });
  if (run.status !== 'draft') return res.status(409).json({ error: 'Sent payroll cannot be deleted' });
  // Checked again in the DELETE: a publish may have landed in between.
  const gone = await db.get(`DELETE FROM payroll_runs WHERE id = ? AND company_id = ? AND status = 'draft' RETURNING id`, [Number(req.params.id), req.user.company_id]);
  if (!gone) return res.status(409).json({ error: 'Sent payroll cannot be deleted' });
  await audit(req, { area: 'payroll', action: 'deleted a payroll draft' });
  await changed(req, Number(req.params.id));
  res.json({ ok: true });
});

/* ---------- Employee ---------- */
router.get('/my', async (req, res) => {
  res.json(
    await db.all(
      `SELECT s.id, r.month, r.currency, r.published_at, s.gross, s.bonus, s.net, s.viewed_at
       FROM payslips s JOIN payroll_runs r ON r.id = s.run_id
       WHERE s.user_id = ? AND s.company_id = ? AND r.status = 'published' ORDER BY r.month DESC`,
      [req.user.id, req.user.company_id]
    )
  );
});

/** One payslip: its owner (once published) or a manager of the same company. */
router.get('/payslips/:id', async (req, res) => {
  const slip = await db.get(
    `SELECT s.*, r.month, r.currency, r.status, r.published_at, c.name AS company_name
     FROM payslips s JOIN payroll_runs r ON r.id = s.run_id JOIN companies c ON c.id = s.company_id
     WHERE s.id = ? AND s.company_id = ?`,
    [Number(req.params.id), req.user.company_id]
  );
  const own = slip && slip.user_id === req.user.id && slip.status === 'published';
  if (!slip || !(own || isManager(req.user))) return res.status(404).json({ error: 'Payslip not found' });
  if (own && !slip.viewed_at) {
    await db.run('UPDATE payslips SET viewed_at = ? WHERE id = ?', [clock(req.user.timezone).dateTime, slip.id]);
    await changed(req, slip.run_id); // lets the payroll page tick "viewed" live
  }
  res.json(slip);
});

/** The payslip as a PDF (same file that's attached to the email); same access as viewing it. */
router.get('/payslips/:id/pdf', async (req, res) => {
  const slip = await db.get(
    `SELECT s.*, r.month, r.currency, r.status, r.published_at, c.name AS company_name, c.logo AS company_logo
     FROM payslips s JOIN payroll_runs r ON r.id = s.run_id JOIN companies c ON c.id = s.company_id
     WHERE s.id = ? AND s.company_id = ?`,
    [Number(req.params.id), req.user.company_id]
  );
  const own = slip && slip.user_id === req.user.id && slip.status === 'published';
  if (!slip || !(own || isManager(req.user))) return res.status(404).json({ error: 'Payslip not found' });
  const pdf = await payslipPdf({ ...slip, published_at: slip.status === 'published' ? slip.published_at : null }, { name: slip.company_name, logo: slip.company_logo });
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${payslipFileName(slip)}"`,
    'Cache-Control': 'private, no-store',
  });
  res.send(pdf);
});

export default router;
