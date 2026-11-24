import { Router } from 'express';
import db, { getSettings, tx } from '../db.js';
import { requireRole, isManager } from '../auth.js';
import { emit } from '../events.js';
import { clock, countLeaveDays, parseSaturdaysOff } from '../utils.js';
import { leaveBalance } from '../leavePolicy.js';
import { audit } from '../audit.js';

export { leaveBalance };

const router = Router();
const TYPES = ['casual', 'sick', 'earned', 'unpaid', 'comp_off'];
const LABEL = { casual: 'casual', sick: 'sick', earned: 'earned', unpaid: 'unpaid', comp_off: 'comp-off' };
const HALVES = ['first', 'second'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LEAVE_SPAN_DAYS = 366;
// A real calendar date (2026-02-30 matches the pattern but isn't one).
const isRealDate = (d) => ISO_DATE.test(d || '') && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const spanDays = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5 + 1;
const shortDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const range = (l) => (l.start_date === l.end_date
  ? `${shortDate(l.start_date)}${l.half_day ? ` (${l.half_day} half)` : ''}`
  : `${shortDate(l.start_date)} – ${shortDate(l.end_date)}`);

const idParam = (req) => (/^\d{1,9}$/.test(String(req.params.id)) ? Number(req.params.id) : 0);

router.get('/balance', async (req, res) => {
  if (req.query.user_id && !/^\d{1,9}$/.test(String(req.query.user_id))) return res.status(400).json({ error: 'Unknown employee' });
  const userId = isManager(req.user) && req.query.user_id ? Number(req.query.user_id) : req.user.id;
  res.json(await leaveBalance(req.user, userId, Number(clock(req.user.timezone).date.slice(0, 4))));
});

router.get('/', async (req, res) => {
  const params = [req.user.company_id];
  let sql = `SELECT l.*, u.name, u.emp_code, r.name AS reviewer FROM leaves l
             JOIN users u ON u.id = l.user_id LEFT JOIN users r ON r.id = l.reviewed_by WHERE l.company_id = ?`;
  if (!isManager(req.user) || req.query.mine) {
    sql += ' AND l.user_id = ?';
    params.push(req.user.id);
  }
  if (req.query.status) {
    sql += ' AND l.status = ?';
    params.push(req.query.status);
  }
  res.json(await db.all(`${sql} ORDER BY l.created_at DESC`, params));
});

router.post('/', async (req, res) => {
  const { type, start_date, end_date, reason } = req.body || {};
  if (!TYPES.includes(type)) return res.status(400).json({ error: 'Invalid leave type' });
  const half = req.body?.half_day ? String(req.body.half_day) : null;
  if (half && !HALVES.includes(half)) return res.status(400).json({ error: 'Pick the first or second half of the day' });
  if (half && start_date !== end_date) return res.status(400).json({ error: 'Half-day leave is for a single day' });
  // Each year has its own quota, so one request can't span two years (it would all count against the first).
  if (isRealDate(start_date) && isRealDate(end_date) && start_date.slice(0, 4) !== end_date.slice(0, 4)) {
    return res.status(400).json({ error: `Leave can't cross into a new year. Request up to 31 Dec, then the rest from 1 Jan separately.` });
  }
  if (!isRealDate(start_date) || !isRealDate(end_date) || end_date < start_date) {
    return res.status(400).json({ error: 'Invalid date range' });
  }
  if (spanDays(start_date, end_date) > MAX_LEAVE_SPAN_DAYS) {
    return res.status(400).json({ error: 'A leave request can cover at most a year' });
  }
  const holidays = new Set((await db.all('SELECT date FROM holidays WHERE company_id = ?', [req.user.company_id])).map((h) => h.date));
  const settings = await getSettings(req.user.company_id);
  if (half && settings.leave_half_day !== '1') return res.status(400).json({ error: 'Your company does not allow half-day leave' });
  if (type === 'comp_off' && settings.comp_off !== '1') return res.status(400).json({ error: 'Your company does not use comp-off' });
  const whole = countLeaveDays(start_date, end_date, holidays, parseSaturdaysOff(settings.saturdays_off));
  if (!whole) return res.status(400).json({ error: 'Selected range has no working days' });
  const days = half ? 0.5 : whole;

  // One request per person at a time: two sent together must not both pass the overlap and balance checks.
  const result = await tx(async (t) => {
    await t.get('SELECT pg_advisory_xact_lock(1, ?::int)', [req.user.id]);
    // Two half days on the same date (first + second half) may sit side by side; anything else may not overlap.
    const overlap = await t.get(
      `SELECT 1 FROM leaves WHERE user_id = ? AND status IN ('pending','approved')
       AND NOT (end_date < ? OR start_date > ?)
       AND NOT (?::text IS NOT NULL AND half_day IS NOT NULL AND half_day <> ?::text)`,
      [req.user.id, start_date, end_date, half, half]
    );
    if (overlap) return { status: 409, error: 'Overlaps an existing leave request' };
    if (type !== 'unpaid') {
      const bal = (await leaveBalance(req.user, req.user.id, Number(start_date.slice(0, 4)), { runner: t, settings })).find((b) => b.type === type);
      const available = bal.remaining - bal.pending;
      if (!bal || available < days) {
        return { status: 400, error: `Not enough ${LABEL[type]} leave (${available || 0} left${bal?.pending ? `, ${bal.pending} already requested` : ''})` };
      }
    }
    return {
      leave: await t.get(
        `INSERT INTO leaves (company_id, user_id, type, start_date, end_date, days, half_day, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        [req.user.company_id, req.user.id, type, start_date, end_date, days, half, reason || null, clock(req.user.timezone).dateTime]
      ),
    };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  const { leave } = result;
  await emit(req.user, {
    type: 'leave.requested', notify: true,
    title: `${req.user.name} requested ${LABEL[type]} leave`,
    body: `${range(leave)} · ${days} day${days === 1 ? '' : 's'}${reason ? ` · “${reason}”` : ''}`,
    data: { leaveId: leave.id },
  });
  res.status(201).json(leave);
});

router.post('/:id/review', requireRole('admin', 'hr'), async (req, res) => {
  const { status, note } = req.body || {};
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const leave = await db.get('SELECT * FROM leaves WHERE id = ? AND company_id = ?', [idParam(req), req.user.company_id]);
  if (!leave) return res.status(404).json({ error: 'Leave not found' });
  if (leave.status !== 'pending') return res.status(409).json({ error: 'Leave already reviewed' });
  if (leave.user_id === req.user.id) return res.status(403).json({ error: 'You cannot review your own leave' });
  if (status === 'approved' && leave.type !== 'unpaid') {
    // Requests are checked when made, but approving several of them could still go past the quota.
    const bal = (await leaveBalance(req.user, leave.user_id, Number(leave.start_date.slice(0, 4)))).find((b) => b.type === leave.type);
    if (!bal || bal.remaining < leave.days) {
      return res.status(409).json({ error: `Not enough ${LABEL[leave.type]} leave left to approve this (${bal?.remaining ?? 0} left)` });
    }
  }
  // Only a still-pending leave: the employee may have cancelled it, or another reviewer got there first.
  const updated = await db.get(
    `UPDATE leaves SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'pending' RETURNING *`,
    [status, req.user.id, clock(req.user.timezone).dateTime, note || null, leave.id]
  );
  if (!updated) return res.status(409).json({ error: 'This leave was cancelled or reviewed meanwhile' });
  const person = await db.get('SELECT id, name FROM users WHERE id = ?', [leave.user_id]);
  await audit(req, {
    area: 'leave', action: `${status} ${LABEL[leave.type]} leave`, target: person,
    changes: { dates: [null, range(leave)], days: [null, leave.days], ...(note ? { note: [null, note] } : {}) },
  });
  await emit(req.user, {
    type: 'leave.reviewed', audience: 'user', userId: leave.user_id, notify: true,
    title: `Your ${LABEL[leave.type]} leave was ${status}`,
    body: `${range(leave)} · by ${req.user.name}${note ? ` · “${note}”` : ''}`,
    data: { leaveId: leave.id, status },
  });
  await emit(req.user, { type: 'leave.reviewed', data: { leaveId: leave.id, status } });
  res.json(updated);
});

router.post('/:id/cancel', async (req, res) => {
  const leave = await db.get('SELECT * FROM leaves WHERE id = ? AND user_id = ?', [idParam(req), req.user.id]);
  if (!leave) return res.status(404).json({ error: 'Leave not found' });
  if (leave.status !== 'pending') return res.status(409).json({ error: 'Only pending leaves can be cancelled' });
  const cancelled = await db.get("UPDATE leaves SET status = 'cancelled' WHERE id = ? AND status = 'pending' RETURNING id", [leave.id]);
  if (!cancelled) return res.status(409).json({ error: 'Only pending leaves can be cancelled' });
  await emit(req.user, { type: 'leave.cancelled', data: { leaveId: leave.id } });
  res.json({ ok: true });
});

export default router;
