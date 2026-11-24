import { Router } from 'express';
import { del, get, put } from '@vercel/blob';
import db from '../db.js';
import { isManager, MAX_SESSION_DAYS, signToken } from '../auth.js';
import { emit } from '../events.js';
import { addDays, clock, dayOfWeek, minutesBetween } from '../utils.js';
import { closeStaleBreaks } from './attendance.js';

/**
 * Desktop tracker (tracker/ Electron app). While an employee is checked in and not on a break, the app sends a
 * heartbeat every minute and one screenshot per 15-minute block. If the app stays closed for 10 minutes the
 * employee goes on a break automatically; the break ends when the app comes back.
 */
const router = Router();
const AWAY_MINUTES = 10;
const IDLE_MINUTES = 6;
const RETENTION_DAYS = 30;
const MAX_SHOT_BYTES = 600 * 1024; // base64 adds a third, which keeps the request under the 1 MB body limit

async function recomputeBreakMinutes(attendanceId) {
  await db.run(
    'UPDATE attendance SET break_minutes = (SELECT COALESCE(SUM(minutes), 0) FROM breaks WHERE attendance_id = ?) WHERE id = ?',
    [attendanceId, attendanceId]
  );
}

/** Today's attendance for the user plus what the tracker should do right now. */
async function status(user) {
  const now = clock(user.timezone);
  const record = await db.get('SELECT * FROM attendance WHERE user_id = ? AND date = ?', [user.id, now.date]);
  const open = record && await db.get('SELECT type, started_at, source FROM breaks WHERE user_id = ? AND ended_at IS NULL', [user.id]);
  let state = 'out';
  if (record?.check_out) state = 'done';
  else if (record && open) state = open.type === 'lunch' ? 'lunch' : 'break';
  else if (record) state = 'working';
  const worked = record && !record.check_out
    ? Math.max(minutesBetween(record.check_in, now.dateTime) - (record.break_minutes || 0)
      - (open ? minutesBetween(open.started_at, now.dateTime) : 0), 0)
    : record?.work_minutes || 0;
  // This week's total: the week starts Sunday 12:00 am (company time), so it resets as Sunday begins.
  const weekStart = addDays(now.date, -dayOfWeek(now.date));
  const { m: earlier } = await db.get(
    'SELECT COALESCE(SUM(work_minutes), 0)::int AS m FROM attendance WHERE user_id = ? AND date >= ? AND date < ?',
    [user.id, weekStart, now.date]
  );
  return {
    state, capture: state === 'working', now: now.dateTime,
    check_in: record?.check_in || null, check_out: record?.check_out || null,
    worked_minutes: worked, week_minutes: earlier + worked, week_start: weekStart, break_started: open?.started_at || null, break_type: open?.type || null, break_source: open?.source || null,
  };
}

/**
 * Puts anyone whose tracker has been silent for 10+ minutes on a break, starting from when it went quiet
 * (or from the end of their last break, if that was later). Only applies to people who used the tracker today.
 */
let lastSweep = 0;
export async function sweepTrackerBreaks(when = Date.now()) {
  if (when - lastSweep < 60 * 1000) return;
  lastSweep = when;
  await awayBreaks();
}

/** The sweep itself, for everyone or (unthrottled) for one person. */
async function awayBreaks(userId = null) {
  const rows = await db.all(
    `SELECT a.id AS attendance_id, a.date, a.company_id, u.id AS user_id, u.name, u.tracker_seen_at, c.timezone,
            (SELECT MAX(ended_at) FROM breaks b WHERE b.attendance_id = a.id) AS last_break_end
     FROM attendance a JOIN users u ON u.id = a.user_id JOIN companies c ON c.id = a.company_id
     WHERE a.check_out IS NULL AND u.tracker_seen_at IS NOT NULL AND u.tracker_seen_at >= a.check_in
       AND NOT EXISTS (SELECT 1 FROM breaks b WHERE b.user_id = u.id AND b.ended_at IS NULL)
       AND (?::int IS NULL OR u.id = ?::int)`,
    [userId, userId]
  );
  for (const r of rows) {
    const now = clock(r.timezone);
    if (r.date !== now.date) continue;
    const from = r.last_break_end && r.last_break_end > r.tracker_seen_at ? r.last_break_end : r.tracker_seen_at;
    if (minutesBetween(from, now.dateTime) < AWAY_MINUTES) continue;
    const brk = await db.get(
      `INSERT INTO breaks (company_id, user_id, attendance_id, type, started_at, source)
       VALUES (?, ?, ?, 'break', ?, 'tracker') ON CONFLICT DO NOTHING RETURNING id`,
      [r.company_id, r.user_id, r.attendance_id, from]
    );
    if (!brk) continue;
    await emit({ company_id: r.company_id, id: r.user_id, timezone: r.timezone }, {
      type: 'attendance.break_start', title: `${r.name} went on a break (tracker closed)`, data: { userId: r.user_id },
    });
  }
}

/**
 * Deletes screenshots older than 30 days, image files first. Runs at most every 6 hours per server instance and
 * at most 400 per run, so a backlog never holds up the request it runs in; later runs carry on.
 */
let lastPurge = 0;
export async function purgeOldScreenshots(when = Date.now()) {
  if (when - lastPurge < 6 * 60 * 60 * 1000) return;
  lastPurge = when;
  for (let round = 0; round < 2; round++) {
    const old = await db.all(
      `SELECT id, blob_path FROM screenshots WHERE created_at < now() - make_interval(days => ?) ORDER BY id LIMIT 200`,
      [RETENTION_DAYS]
    );
    if (!old.length) return;
    await del(old.map((s) => s.blob_path));
    await db.run('DELETE FROM screenshots WHERE id = ANY(?::int[])', [old.map((s) => s.id)]);
  }
}

/* ---------- Desktop app ---------- */

// A fresh token, so the app stays signed in past the usual 7-day session (but never past MAX_SESSION_DAYS).
// Renewal keeps the original sign-in time, so after MAX_SESSION_DAYS the person has to sign in again.
router.post('/session', (req, res) => {
  if (Date.now() / 1000 - req.sessionStart > (MAX_SESSION_DAYS - 1) * 24 * 3600) {
    return res.status(401).json({ error: 'For security, please sign in again (sign-ins last 30 days).' });
  }
  res.json({ token: signToken(req.user, { ses: req.sessionStart }) });
});

router.post('/heartbeat', async (req, res) => {
  const now = clock(req.user.timezone);
  await closeStaleBreaks(req.user, now);
  // Back from a long silence (laptop shut, app closed)? Record the gap as a break before marking the app as seen:
  // the throttled sweep may not have run in between, and afterwards the gap would no longer be visible.
  await awayBreaks(req.user.id);
  await db.run('UPDATE users SET tracker_seen_at = ? WHERE id = ?', [now.dateTime, req.user.id]);
  // Back after being away: end the break the tracker started.
  const auto = await db.get(
    `SELECT id, attendance_id, started_at FROM breaks WHERE user_id = ? AND ended_at IS NULL AND source = 'tracker'`,
    [req.user.id]
  );
  if (auto) {
    await db.run('UPDATE breaks SET ended_at = ?, minutes = ? WHERE id = ?',
      [now.dateTime, Math.max(minutesBetween(auto.started_at, now.dateTime), 0), auto.id]);
    await recomputeBreakMinutes(auto.attendance_id);
    await emit(req.user, { type: 'attendance.break_end', title: `${req.user.name} is back (tracker reopened)`, data: { userId: req.user.id } });
  }
  await sweepTrackerBreaks().catch((err) => console.error('tracker sweep failed', err));
  const st = await status(req.user);
  const pick = req.body?.taskId === 'auto' ? 'auto' : Number(req.body?.taskId) || null;
  // Idle time isn't task time: the app reports how long there's been no input, and an idle minute isn't logged.
  const idle = Number(req.body?.idleSeconds) >= 60;
  const taskId = await logTaskTime(req.user, now, idle ? { ...st, state: 'idle' } : st, pick);
  res.json({ ...st, task_id: taskId, tasks: await openTasks(req.user, now.date) });
});

/* ---------- Tasks in the tracker ---------- */
const secondsBetween = (from, to) => (Date.parse(`${to.replace(' ', 'T')}Z`) - Date.parse(`${from.replace(' ', 'T')}Z`)) / 1000;

/** The person's open tasks, with the seconds logged to each today. */
async function openTasks(user, date) {
  return db.all(
    `SELECT t.id, t.title, t.status, t.priority, t.due_date,
            COALESCE((SELECT seconds FROM task_time tt WHERE tt.task_id = t.id AND tt.user_id = t.assignee_id AND tt.date = ?), 0) AS today_seconds
     FROM tasks t WHERE t.assignee_id = ? AND t.status <> 'done'
     ORDER BY t.status = 'progress' DESC, t.due_date NULLS LAST, t.id`,
    [date, user.id]
  );
}

/**
 * Adds the time since the last heartbeat (at most 2 minutes, so a laptop waking from sleep can't add hours)
 * to the task the person picked, while they're checked in and working. Picking a To do task starts it.
 * `taskId` 'auto' means the most urgent open task: in progress first, then by due date (the openTasks order).
 */
async function logTaskTime(user, now, st, taskId) {
  const task = taskId === 'auto'
    ? await db.get(
      `SELECT id, status FROM tasks WHERE assignee_id = ? AND status <> 'done'
       ORDER BY status = 'progress' DESC, due_date NULLS LAST, id LIMIT 1`, [user.id])
    : taskId && await db.get(`SELECT id, status FROM tasks WHERE id = ? AND assignee_id = ? AND status <> 'done'`, [taskId, user.id]);
  const { task_tick_at: tick } = await db.get('SELECT task_tick_at FROM users WHERE id = ?', [user.id]);
  const working = st.state === 'working';
  if (task && working) {
    if (task.status === 'todo') {
      await db.run(`UPDATE tasks SET status = 'progress' WHERE id = ? AND status = 'todo'`, [task.id]);
      await emit(user, { type: 'task.changed', audience: 'all', data: { taskId: task.id } });
    }
    const seconds = tick && tick.slice(0, 10) === now.date ? Math.round(Math.min(Math.max(secondsBetween(tick, now.dateTime), 0), 120)) : 0;
    if (seconds) {
      await db.run(
        `INSERT INTO task_time (task_id, user_id, date, seconds) VALUES (?, ?, ?, ?)
         ON CONFLICT (task_id, user_id, date) DO UPDATE SET seconds = task_time.seconds + EXCLUDED.seconds`,
        [task.id, user.id, now.date, seconds]
      );
    }
  }
  await db.run('UPDATE users SET task_tick_at = ? WHERE id = ?', [working && task ? now.dateTime : null, user.id]);
  return task ? task.id : null;
}

/**
 * No mouse or keyboard for IDLE_MINUTES (measured by the app): a short break from the moment input stopped,
 * ended by the app (`away: false`) as soon as the person is back.
 */
router.post('/idle', async (req, res) => {
  const now = clock(req.user.timezone);
  if (req.body?.away === false) {
    const brk = await db.get(`SELECT id, attendance_id, started_at FROM breaks WHERE user_id = ? AND ended_at IS NULL AND source = 'idle'`, [req.user.id]);
    if (brk) {
      await db.run('UPDATE breaks SET ended_at = ?, minutes = ? WHERE id = ?',
        [now.dateTime, Math.max(minutesBetween(brk.started_at, now.dateTime), 0), brk.id]);
      await recomputeBreakMinutes(brk.attendance_id);
      await emit(req.user, { type: 'attendance.break_end', title: `${req.user.name} is back (was idle)`, data: { userId: req.user.id } });
    }
    return res.json(await status(req.user));
  }
  const seconds = Math.min(Math.max(Number(req.body?.idleSeconds) || 0, IDLE_MINUTES * 60), 2 * 60 * 60);
  const rec = await db.get(
    `SELECT a.id, a.check_in, (SELECT MAX(ended_at) FROM breaks b WHERE b.attendance_id = a.id) AS last_break_end
     FROM attendance a WHERE a.user_id = ? AND a.date = ? AND a.check_out IS NULL`,
    [req.user.id, now.date]
  );
  if (!rec) return res.json(await status(req.user));
  // Back-dated to when input stopped, but never before check-in or the end of the last break.
  let from = clock(req.user.timezone, new Date(Date.now() - seconds * 1000)).dateTime;
  for (const floor of [rec.check_in, rec.last_break_end]) if (floor && floor > from) from = floor;
  const brk = await db.get(
    `INSERT INTO breaks (company_id, user_id, attendance_id, type, started_at, source)
     VALUES (?, ?, ?, 'break', ?, 'idle') ON CONFLICT DO NOTHING RETURNING id`,
    [req.user.company_id, req.user.id, rec.id, from]
  );
  if (brk) {
    await emit(req.user, { type: 'attendance.break_start', title: `${req.user.name} went on a short break (idle ${IDLE_MINUTES} min)`, data: { userId: req.user.id } });
  }
  res.json(await status(req.user));
});

router.post('/screenshots', async (req, res) => {
  const { image, activity, idle, taskId } = req.body || {};
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(image || '');
  if (!m) return res.status(400).json({ error: 'Screenshot must be a JPEG, PNG or WebP data URL' });
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > MAX_SHOT_BYTES) return res.status(413).json({ error: 'Screenshot is too large' });
  const s = await status(req.user);
  if (!s.capture) return res.status(409).json({ error: 'Not capturing: you are not checked in, or you are on a break', status: s });

  const now = clock(req.user.timezone);
  const record = await db.get('SELECT id FROM attendance WHERE user_id = ? AND date = ? AND check_out IS NULL', [req.user.id, now.date]);
  // A request straddling midnight (or a check-out landing in between) has no open record left to attach to.
  if (!record) return res.status(409).json({ error: 'Not capturing: you are not checked in', status: await status(req.user) });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const blob = await put(`c${req.user.company_id}/u${req.user.id}/${now.date}/${now.dateTime.slice(11).replace(/:/g, '')}.${ext}`, bytes, {
    access: 'private', contentType: `image/${m[1]}`, addRandomSuffix: true,
  });
  const pct = Number.isFinite(Number(activity)) ? Math.min(Math.max(Math.round(Number(activity)), 0), 100) : null;
  const task = taskId && await db.get('SELECT id FROM tasks WHERE id = ? AND assignee_id = ?', [Number(taskId) || 0, req.user.id]);
  const row = await db.get(
    `INSERT INTO screenshots (company_id, user_id, attendance_id, taken_at, blob_path, bytes, activity, idle, task_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, taken_at, activity, idle, task_id`,
    [req.user.company_id, req.user.id, record.id, now.dateTime, blob.pathname, bytes.length, pct, Boolean(idle), task?.id ?? null]
  );
  await db.run('UPDATE users SET tracker_seen_at = ? WHERE id = ?', [now.dateTime, req.user.id]);
  res.status(201).json(row);
});

/* ---------- Activity page (website) ---------- */

/** Managers: everyone's day at a glance. Employees: just themselves. */
router.get('/summary', async (req, res) => {
  const now = clock(req.user.timezone);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : now.date;
  const params = [date, req.user.company_id];
  let only = '';
  if (!isManager(req.user)) {
    only = 'AND u.id = ?';
    params.push(req.user.id);
  }
  const rows = await db.all(
    `SELECT u.id, u.name, u.emp_code, u.designation, u.tracker_seen_at,
            a.check_in, a.check_out, a.work_minutes, a.break_minutes,
            COUNT(s.id)::int AS screenshots, ROUND(AVG(s.activity))::int AS activity,
            COUNT(s.id) FILTER (WHERE s.idle)::int AS idle_shots
     FROM users u
     LEFT JOIN attendance a ON a.user_id = u.id AND a.date = ?
     LEFT JOIN screenshots s ON s.attendance_id = a.id
     WHERE u.company_id = ? AND u.status = 'active' ${only}
     GROUP BY u.id, a.id
     ORDER BY (a.id IS NULL), u.name`,
    params
  );
  res.json({ date, today: now.date, now: now.dateTime, people: rows });
});

router.get('/day', async (req, res) => {
  const now = clock(req.user.timezone);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : now.date;
  const userId = isManager(req.user) && req.query.user_id ? Number(req.query.user_id) : req.user.id;
  const person = await db.get(
    'SELECT id, name, emp_code, designation, tracker_seen_at FROM users WHERE id = ? AND company_id = ?',
    [userId, req.user.company_id]
  );
  if (!person) return res.status(404).json({ error: 'Employee not found' });
  const record = await db.get('SELECT * FROM attendance WHERE user_id = ? AND date = ?', [userId, date]);
  const [breaks, screenshots] = record
    ? await Promise.all([
      db.all('SELECT id, type, started_at, ended_at, minutes, source FROM breaks WHERE attendance_id = ? ORDER BY started_at', [record.id]),
      db.all('SELECT id, taken_at, activity, idle FROM screenshots WHERE attendance_id = ? ORDER BY taken_at', [record.id]),
    ])
    : [[], []];
  res.json({ date, now: now.dateTime, person, record: record || null, breaks, screenshots });
});

router.get('/screenshots/:id/image', async (req, res) => {
  const shot = await db.get('SELECT user_id, blob_path FROM screenshots WHERE id = ? AND company_id = ?',
    [Number(req.params.id) || 0, req.user.company_id]);
  if (!shot || (!isManager(req.user) && shot.user_id !== req.user.id)) return res.status(404).json({ error: 'Screenshot not found' });
  const file = await get(shot.blob_path, { access: 'private' });
  if (!file || file.statusCode !== 200) return res.status(404).json({ error: 'Screenshot file is missing' });
  res.set('Content-Type', file.blob.contentType || 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(Buffer.from(await new Response(file.stream).arrayBuffer()));
});

router.delete('/screenshots/:id', async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Only admins and HR can delete screenshots' });
  const shot = await db.get('SELECT id, blob_path FROM screenshots WHERE id = ? AND company_id = ?',
    [Number(req.params.id) || 0, req.user.company_id]);
  if (!shot) return res.status(404).json({ error: 'Screenshot not found' });
  await del(shot.blob_path);
  await db.run('DELETE FROM screenshots WHERE id = ?', [shot.id]);
  res.json({ ok: true });
});

export default router;
