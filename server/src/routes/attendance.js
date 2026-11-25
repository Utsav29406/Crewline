import { Router } from 'express';
import db, { getSettings, isUniqueViolation, tx } from '../db.js';
import { requireRole, isManager } from '../auth.js';
import { emit } from '../events.js';
import { haversine, euclidean, faceSamplesError, FACE_CHANGED, FACE_COPIED, clock, addDays, minutesBetween, isWeeklyOff, parseSaturdaysOff } from '../utils.js';
import { sendDailyLog } from '../dailyLog.js';
import { audit } from '../audit.js';

const router = Router();
// A punch sends several scans. Their average distance from the enrolled face must be within FACE_THRESHOLD,
// and no single scan may be further than FACE_WORST (genuine punches average about 0.35).
const FACE_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD || 0.45);
const FACE_WORST = FACE_THRESHOLD + 0.05;
const PUNCH_SCANS = { min: 3, max: 5 };
// GPS accuracy we are willing to forgive at the fence edge, in metres.
const MAX_ACCURACY_SLACK_M = 30;

async function activeFencesFor(user) {
  const { geofence_id } = await db.get('SELECT geofence_id FROM users WHERE id = ?', [user.id]);
  const own = geofence_id ? await db.all('SELECT * FROM geofences WHERE id = ? AND company_id = ? AND active', [geofence_id, user.company_id]) : [];
  // An assigned fence that was turned off works like a deleted one: any active office counts.
  return own.length ? own : db.all('SELECT * FROM geofences WHERE company_id = ? AND active', [user.company_id]);
}

/*
 * Spoofing checks. The browser measures the face and the location, so a determined person can send made-up values;
 * these catch the usual tricks. A face scan is never exactly the same twice (light, angle, expression), so one that
 * matches an earlier scan or the enrollment almost exactly was copied, and is refused. Location tricks are only
 * flagged for HR, because a phone that hasn't moved can honestly repeat a reading.
 */
const REPLAY_FACE_DISTANCE = 0.02; // genuine scans of the same face differ by roughly 0.1-0.4
const RECENT_FACES = 30; // the last 10 punches, 3 scans each
// After this many failed face checks in LOCK_MINUTES, face punches stop for a while (HR is told about each failure).
const LOCK_FAILS = 5;
const LOCK_MINUTES = 15;
const FACE_NO_MATCH = 'Face did not match';
const FACE_REPLAY = 'This face scan was used before. Scan your face again with the camera.';
const FACE_FAILURES = [FACE_NO_MATCH, FACE_REPLAY, FACE_CHANGED, FACE_COPIED];
const MAX_SPEED_KMH = 250;

async function locationFlags(user, { lat, lng, accuracy }, fence) {
  const flags = [];
  if (Number(accuracy) < 1) flags.push('GPS accuracy better than a phone can report');
  if (fence && lat === fence.lat && lng === fence.lng) flags.push('exactly the office centre point');
  const same = await db.get(
    `SELECT 1 FROM attendance_attempts WHERE user_id = ? AND success AND lat = ? AND lng = ?
       AND created_at < ? LIMIT 1`,
    // Times here are company wall-clock times. Within half an hour a phone that hasn't moved can repeat a reading.
    [user.id, lat, lng, clock(user.timezone, new Date(Date.now() - 30 * 60 * 1000)).dateTime]
  );
  if (same) flags.push('exactly the same coordinates as an earlier punch');
  const last = await db.get(
    `SELECT lat, lng, created_at FROM attendance_attempts WHERE user_id = ? AND success AND lat IS NOT NULL
     ORDER BY id DESC LIMIT 1`,
    [user.id]
  );
  if (last) {
    const km = haversine(lat, lng, last.lat, last.lng) / 1000;
    const hours = Math.max(minutesBetween(last.created_at, clock(user.timezone).dateTime), 1) / 60;
    if (km > 5 && km / hours > MAX_SPEED_KMH) flags.push(`moved ${Math.round(km)} km since the last punch ${Math.round(hours * 60)} min earlier`);
  }
  return flags;
}

/** Runs face + geofence checks. Returns { ok, reason, fence, distanceM, faceDistance, flags }. */
async function verify(user, { descriptor, descriptors, lat, lng, accuracy, mock }, settings) {
  const result = { ok: true, fence: null, distanceM: null, faceDistance: null, flags: [] };

  // The Android app reads the location from the phone itself, which knows when a fake-GPS app supplied it.
  if (settings.require_geofence === '1' && mock === true) {
    return { ...result, ok: false, reason: 'A fake-location (mock GPS) app is active on this phone. Turn it off in Developer options, then try again.' };
  }

  if (settings.require_face === '1') {
    const row = await db.get('SELECT face_descriptors, recent_faces FROM users WHERE id = ?', [user.id]);
    if (!row.face_descriptors) return { ...result, ok: false, reason: 'Face not enrolled. Enroll your face first.' };
    // A page opened before this check got stricter sends one scan: it needs reloading.
    if (descriptor && !descriptors) return { ...result, ok: false, reason: 'This page is out of date. Reload it, then scan your face again.' };
    const since = clock(user.timezone, new Date(Date.now() - LOCK_MINUTES * 60 * 1000)).dateTime;
    const { fails } = await db.get(
      'SELECT COUNT(*)::int AS fails FROM attendance_attempts WHERE user_id = ? AND NOT success AND reason = ANY(?) AND created_at >= ?',
      [user.id, FACE_FAILURES, since]
    );
    if (fails >= LOCK_FAILS) {
      return { ...result, ok: false, reason: `Too many failed face scans. Try again in ${LOCK_MINUTES} minutes, or ask HR to check in for you.` };
    }
    if (!descriptors) return { ...result, ok: false, reason: 'No face captured' };
    const bad = faceSamplesError(descriptors, PUNCH_SCANS.min, PUNCH_SCANS.max);
    if (bad) return { ...result, ok: false, reason: bad };
    const each = descriptors.map((d) => Math.min(...row.face_descriptors.map((s) => euclidean(s, d))));
    result.faceDistance = Math.round((each.reduce((a, b) => a + b, 0) / each.length) * 1000) / 1000;
    if (result.faceDistance > FACE_THRESHOLD || Math.max(...each) > FACE_WORST) return { ...result, ok: false, reason: FACE_NO_MATCH };
    const seen = [...row.face_descriptors, ...(row.recent_faces || [])];
    if (descriptors.some((d) => seen.some((s) => euclidean(s, d) < REPLAY_FACE_DISTANCE))) return { ...result, ok: false, reason: FACE_REPLAY };
    result.descriptors = descriptors;
  }

  if (settings.require_geofence === '1') {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ...result, ok: false, reason: 'Location unavailable' };
    // Laptops without GPS report network/IP locations that can be kilometres off; don't trust those.
    const maxAccuracy = Number(settings.max_gps_accuracy_m) || 150;
    if (!(Number(accuracy) <= maxAccuracy)) {
      return {
        ...result, ok: false,
        reason: `Location too imprecise (±${Math.round(Number(accuracy)) || '?'} m, need ±${maxAccuracy} m or better). Use your phone or move near a window.`,
      };
    }
    const fences = await activeFencesFor(user);
    if (!fences.length) return { ...result, ok: false, reason: 'No active geofence assigned. Ask your admin to add your office location.' };
    const slack = Math.min(Number(accuracy) || 0, MAX_ACCURACY_SLACK_M);
    const nearest = fences
      .map((f) => ({ fence: f, d: haversine(lat, lng, f.lat, f.lng) }))
      .sort((a, b) => a.d - b.d)[0];
    result.fence = nearest.fence;
    result.distanceM = Math.round(nearest.d);
    if (nearest.d - slack > nearest.fence.radius_m) {
      return { ...result, ok: false, reason: `Outside ${nearest.fence.name} (${result.distanceM} m away, allowed ${nearest.fence.radius_m} m)` };
    }
    result.flags = await locationFlags(user, { lat, lng, accuracy }, nearest.fence);
  }
  return result;
}

async function logAttempt(user, action, v, { lat, lng }) {
  const flags = v.flags?.length ? v.flags.join('; ') : null;
  await db.run(
    `INSERT INTO attendance_attempts (company_id, user_id, action, success, reason, lat, lng, distance_m, face_distance, flags, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [user.company_id, user.id, action, v.ok, v.reason || null, lat ?? null, lng ?? null, v.distanceM, v.faceDistance, flags, clock(user.timezone).dateTime]
  );
  if (v.ok && v.descriptors) {
    // Remember the scans (oldest first), so sending one again later is caught as a replay.
    await db.run(
      `UPDATE users SET recent_faces = (
         SELECT jsonb_agg(f ORDER BY n) FROM (SELECT f, n FROM jsonb_array_elements(COALESCE(recent_faces, '[]'::jsonb) || ?::jsonb) WITH ORDINALITY AS x(f, n)
                                              ORDER BY n DESC LIMIT ?) y)
       WHERE id = ?`,
      [JSON.stringify(v.descriptors), RECENT_FACES, user.id]
    );
  }
  if (v.ok && flags) {
    await emit(user, {
      type: 'attendance.suspicious', notify: true,
      title: `${user.name}: ${action === 'check_in' ? 'check-in' : 'check-out'} looks unusual`,
      body: `Allowed, but check it: ${flags}. See Attendance → Verification log.`,
    });
  }
  if (!v.ok) {
    await emit(user, {
      type: 'attendance.failed', notify: true,
      title: `${user.name}: ${action === 'check_in' ? 'check-in' : 'check-out'} rejected`,
      body: v.reason,
    });
  }
}

const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const hhmm = (dateTime) => dateTime.slice(11, 16);
// A shift that crossed midnight still counts as "current" for this long after check-in; older open records are a
// forgotten check-out for HR to fix, not something to close with a 24-hour day.
const OVERNIGHT_MINUTES = 16 * 60;

/** Today's record, or last night's open one if the shift crossed midnight. */
async function currentRecord(user, now, columns = '*') {
  const today = await db.get(`SELECT ${columns} FROM attendance WHERE user_id = ? AND date = ?`, [user.id, now.date]);
  if (today) return today;
  const last = await db.get(
    `SELECT ${columns}, check_in AS _check_in FROM attendance WHERE user_id = ? AND date = ? AND check_out IS NULL`,
    [user.id, addDays(now.date, -1)]
  );
  return last && minutesBetween(last._check_in, now.dateTime) <= OVERNIGHT_MINUTES ? last : null;
}

/** For the phone app's reminders: shift times and the next 14 working days (no weekly offs, holidays or leave). */
router.get('/reminders', async (req, res) => {
  const now = clock(req.user.timezone);
  const s = await getSettings(req.user.company_id);
  const until = addDays(now.date, 30);
  const [holidays, leaves, today] = await Promise.all([
    db.all('SELECT date::text AS date FROM holidays WHERE company_id = ? AND date BETWEEN ? AND ?', [req.user.company_id, now.date, until]),
    db.all(
      `SELECT start_date::text AS s, end_date::text AS e, half_day FROM leaves WHERE user_id = ? AND status = 'approved' AND end_date >= ? AND start_date <= ?`,
      [req.user.id, now.date, until]
    ),
    db.get('SELECT check_in, check_out FROM attendance WHERE user_id = ? AND date = ?', [req.user.id, now.date]),
  ]);
  const off = new Set(holidays.map((h) => h.date));
  const sats = parseSaturdaysOff(s.saturdays_off);
  const onLeave = (d) => leaves.some((l) => !l.half_day && l.s <= d && d <= l.e);
  const days = [];
  for (let d = now.date; days.length < 14 && d <= until; d = addDays(d, 1)) {
    if (!isWeeklyOff(d, sats) && !off.has(d) && !onLeave(d)) days.push(d);
  }
  res.json({
    shift_start: s.shift_start, shift_end: s.shift_end, working_days: days, today: now.date,
    punched_in: Boolean(today?.check_in), punched_out: Boolean(today?.check_out),
  });
});

router.get('/today', async (req, res) => {
  const now = clock(req.user.timezone);
  const { dateTime } = now;
  const [current, fences, s] = await Promise.all([
    currentRecord(req.user, now, 'id'),
    activeFencesFor(req.user),
    getSettings(req.user.company_id),
  ]);
  const record = current && await db.get(
    'SELECT a.*, g.name AS geofence FROM attendance a LEFT JOIN geofences g ON g.id = a.geofence_id WHERE a.id = ?', [current.id]
  );
  const breaks = record
    ? await db.all('SELECT id, type, started_at, ended_at, minutes FROM breaks WHERE attendance_id = ? ORDER BY started_at', [record.id])
    : [];
  res.json({
    record: record || null,
    breaks,
    fences,
    now: dateTime, // company wall clock, so the page can time breaks without trusting the browser's timezone
    policy: {
      require_face: s.require_face === '1',
      require_geofence: s.require_geofence === '1',
      max_gps_accuracy_m: Number(s.max_gps_accuracy_m) || 150,
      shift_start: s.shift_start,
      shift_end: s.shift_end,
    },
  });
});

router.post('/check-in', async (req, res) => {
  const body = req.body || {};
  const now = clock(req.user.timezone);
  if (await db.get('SELECT 1 FROM attendance WHERE user_id = ? AND date = ?', [req.user.id, now.date])) {
    return res.status(409).json({ error: 'Already checked in today' });
  }
  const s = await getSettings(req.user.company_id);
  const v = await verify(req.user, body, s);
  await logAttempt(req.user, 'check_in', v, body);
  if (!v.ok) return res.status(422).json({ error: v.reason, distanceM: v.distanceM, faceDistance: v.faceDistance });

  const late = now.minutes > minutesOf(s.shift_start) + Number(s.grace_minutes);
  try {
    const record = await db.get(
      `INSERT INTO attendance (company_id, user_id, date, check_in, in_lat, in_lng, geofence_id, face_distance, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      [req.user.company_id, req.user.id, now.date, now.dateTime, body.lat ?? null, body.lng ?? null, v.fence?.id ?? null, v.faceDistance, late ? 'late' : 'present']
    );
    await emit(req.user, {
      type: 'attendance.check_in', notify: late,
      title: late ? `${req.user.name} checked in late at ${hhmm(now.dateTime)}` : `${req.user.name} checked in`,
      body: v.fence ? `at ${v.fence.name}` : null,
      data: { userId: req.user.id, lat: body.lat ?? null, lng: body.lng ?? null },
    });
    res.status(201).json({ record, faceDistance: v.faceDistance, distanceM: v.distanceM });
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'Already checked in today' });
    throw err;
  }
});

router.post('/check-out', async (req, res) => {
  const body = req.body || {};
  const now = clock(req.user.timezone);
  // Today's record, or last night's if the shift crossed midnight and is still open.
  const rec = await currentRecord(req.user, now);
  if (!rec) return res.status(409).json({ error: 'You have not checked in today' });
  if (rec.check_out) return res.status(409).json({ error: 'Already checked out today' });
  const s = await getSettings(req.user.company_id);
  const v = await verify(req.user, body, s);
  await logAttempt(req.user, 'check_out', v, body);
  if (!v.ok) return res.status(422).json({ error: v.reason, distanceM: v.distanceM, faceDistance: v.faceDistance });

  await closeOpenBreak(req.user, now);
  const breakMinutes = await totalBreakMinutes(rec.id);
  const workMinutes = Math.max(minutesBetween(rec.check_in, now.dateTime) - breakMinutes, 0);
  const halfDay = workMinutes < Number(s.half_day_minutes);
  const record = await db.get(
    `UPDATE attendance SET check_out = ?, out_lat = ?, out_lng = ?, work_minutes = ?, break_minutes = ?, status = ?
     WHERE id = ? AND check_out IS NULL RETURNING *`,
    [now.dateTime, body.lat ?? null, body.lng ?? null, workMinutes, breakMinutes, halfDay ? 'half_day' : rec.status, rec.id]
  );
  if (!record) return res.status(409).json({ error: 'Already checked out today' });
  await emit(req.user, {
    type: 'attendance.check_out',
    title: `${req.user.name} checked out`,
    data: { userId: req.user.id, lat: body.lat ?? null, lng: body.lng ?? null },
  });
  await sendDailyLog(req.user.id, rec.date);
  res.json({ record });
});

/* ---------- Breaks (lunch / short break) ---------- */
const BREAK_TYPES = { lunch: 'lunch', break: 'short break' };

async function totalBreakMinutes(attendanceId) {
  return (await db.get('SELECT COALESCE(SUM(minutes), 0) AS m FROM breaks WHERE attendance_id = ?', [attendanceId])).m;
}

/**
 * A break left open on an earlier day (no check-out that day) would block every later break, and ending it now
 * would charge it a day's worth of minutes. Close it at a normal length instead: lunch an hour, a short break 15 min.
 */
export async function closeStaleBreaks(user, now) {
  const stale = await db.all(
    `UPDATE breaks SET ended_at = started_at + make_interval(mins => CASE WHEN type = 'lunch' THEN 60 ELSE 15 END),
       minutes = CASE WHEN type = 'lunch' THEN 60 ELSE 15 END
     WHERE user_id = ? AND ended_at IS NULL AND started_at < ?::timestamp RETURNING attendance_id`,
    [user.id, `${now.date} 00:00:00`]
  );
  for (const { attendance_id: id } of stale) {
    await db.run('UPDATE attendance SET break_minutes = ? WHERE id = ?', [await totalBreakMinutes(id), id]);
  }
}

/** Ends the user's open break (if any) at `now`; returns it. */
async function closeOpenBreak(user, now) {
  const open = await db.get('SELECT * FROM breaks WHERE user_id = ? AND ended_at IS NULL', [user.id]);
  if (!open) return null;
  return db.get(
    'UPDATE breaks SET ended_at = ?, minutes = ? WHERE id = ? AND ended_at IS NULL RETURNING *',
    [now.dateTime, Math.max(minutesBetween(open.started_at, now.dateTime), 0), open.id]
  );
}

router.post('/break/start', async (req, res) => {
  const type = BREAK_TYPES[req.body?.type] ? req.body.type : 'break';
  const now = clock(req.user.timezone);
  const rec = await currentRecord(req.user, now, 'id, check_out');
  if (!rec) return res.status(409).json({ error: 'Check in before taking a break' });
  if (rec.check_out) return res.status(409).json({ error: 'You have already checked out today' });
  await closeStaleBreaks(req.user, now);
  try {
    const brk = await db.get(
      'INSERT INTO breaks (company_id, user_id, attendance_id, type, started_at) VALUES (?, ?, ?, ?, ?) RETURNING *',
      [req.user.company_id, req.user.id, rec.id, type, now.dateTime]
    );
    await emit(req.user, { type: 'attendance.break_start', title: `${req.user.name} started ${BREAK_TYPES[type]}`, data: { userId: req.user.id } });
    res.status(201).json(brk);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'You are already on a break' });
    throw err;
  }
});

router.post('/break/end', async (req, res) => {
  const now = clock(req.user.timezone);
  await closeStaleBreaks(req.user, now);
  const brk = await closeOpenBreak(req.user, now);
  if (!brk) return res.status(409).json({ error: 'You are not on a break' });
  await db.run('UPDATE attendance SET break_minutes = ? WHERE id = ?', [await totalBreakMinutes(brk.attendance_id), brk.attendance_id]);
  await emit(req.user, { type: 'attendance.break_end', title: `${req.user.name} is back from ${BREAK_TYPES[brk.type]}`, data: { userId: req.user.id } });
  res.json(brk);
});

router.get('/', async (req, res) => {
  const today = clock(req.user.timezone).date;
  const { from = addDays(today, -30), to = today } = req.query;
  if (!isRealDay(from) || !isRealDay(to)) return res.status(400).json({ error: 'Dates must look like 2026-11-30' });
  if (req.query.user_id && !/^\d{1,9}$/.test(String(req.query.user_id))) return res.status(400).json({ error: 'Unknown employee' });
  const params = [req.user.company_id, from, to];
  let sql = `SELECT a.*, u.name, u.emp_code, g.name AS geofence,
               ob.type AS open_break_type, ob.started_at AS open_break_started
             FROM attendance a
             LEFT JOIN breaks ob ON ob.attendance_id = a.id AND ob.ended_at IS NULL
             JOIN users u ON u.id = a.user_id LEFT JOIN geofences g ON g.id = a.geofence_id
             WHERE a.company_id = ? AND a.date BETWEEN ? AND ?`;
  if (!isManager(req.user)) {
    sql += ' AND a.user_id = ?';
    params.push(req.user.id);
  } else if (req.query.user_id) {
    sql += ' AND a.user_id = ?';
    params.push(Number(req.query.user_id));
  }
  const rows = await db.all(`${sql} ORDER BY a.date DESC, a.check_in DESC`, params);
  // Overtime (shown only, never paid): worked minutes beyond the company's daily threshold.
  const overtimeAfter = Number((await getSettings(req.user.company_id)).overtime_after_minutes) || 480;
  for (const r of rows) r.overtime_minutes = r.check_out ? Math.max((r.work_minutes || 0) - overtimeAfter, 0) : 0;
  // Still checked in today: worked minutes so far (time since check-in, less breaks taken and any break running now).
  const now = clock(req.user.timezone);
  for (const r of rows) {
    if (r.check_out || r.date !== now.date) continue;
    const running = r.open_break_started ? minutesBetween(r.open_break_started, now.dateTime) : 0;
    r.work_minutes = Math.max(minutesBetween(r.check_in, now.dateTime) - (r.break_minutes || 0) - running, 0);
    r.in_progress = true;
  }
  res.json(rows);
});

router.get('/attempts', requireRole('admin', 'hr'), async (req, res) => {
  res.json(
    await db.all(
      `SELECT t.*, u.name, u.emp_code FROM attendance_attempts t JOIN users u ON u.id = t.user_id
       WHERE t.company_id = ? ORDER BY t.id DESC LIMIT ?`,
      [req.user.company_id, Math.min(Number(req.query.limit) || 100, 500)]
    )
  );
});

/** Today's board: every active employee with their attendance / leave state and punch locations. */
router.get('/live', requireRole('admin', 'hr'), async (req, res) => {
  const today = clock(req.user.timezone).date;
  res.json(
    await db.all(
      `SELECT u.id, u.name, u.emp_code, u.designation, d.name AS department,
              a.check_in, a.check_out, a.status, g.name AS geofence,
              a.in_lat, a.in_lng, a.out_lat, a.out_lng, a.break_minutes,
              b.type AS break_type, b.started_at AS break_started,
              (SELECT type FROM leaves l WHERE l.user_id = u.id AND l.status = 'approved'
                 AND ?::date BETWEEN l.start_date AND l.end_date LIMIT 1) AS leave_type
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN attendance a ON a.user_id = u.id AND a.date = ?
       LEFT JOIN geofences g ON g.id = a.geofence_id
       LEFT JOIN breaks b ON b.user_id = u.id AND b.ended_at IS NULL AND b.attendance_id = a.id
       WHERE u.company_id = ? AND u.status = 'active' ORDER BY a.check_in IS NULL, a.check_in DESC, u.name`,
      [today, today, req.user.company_id]
    )
  );
});

/* ---------- Fixing mistakes: HR edits, and employees' correction requests ---------- */
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isRealDay = (d) => ISO_DAY.test(d || '') && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

/**
 * Turns a day plus 'HH:MM' check-in/check-out into timestamps. A check-out earlier than the check-in is the next
 * morning (a night shift). Returns { error } or { checkIn, checkOut }.
 */
function parseTimes(date, inHHMM, outHHMM, now) {
  if (!isRealDay(date)) return { error: 'Pick a valid day' };
  if (date > now.date) return { error: "You can't record a day that hasn't happened yet" };
  if (!HHMM.test(inHHMM || '')) return { error: 'Check-in time must look like 09:30' };
  if (outHHMM && !HHMM.test(outHHMM)) return { error: 'Check-out time must look like 18:30' };
  const checkIn = `${date} ${inHHMM}:00`;
  let checkOut = outHHMM ? `${date} ${outHHMM}:00` : null;
  if (checkOut && checkOut <= checkIn) checkOut = `${addDays(date, 1)} ${outHHMM}:00`;
  if (checkIn > now.dateTime) return { error: 'Check-in is later than now' };
  if (checkOut && checkOut > now.dateTime) return { error: 'Check-out is later than now' };
  if (checkOut && minutesBetween(checkIn, checkOut) > 20 * 60) return { error: 'That is more than 20 hours of work. Check the times.' };
  return { checkIn, checkOut };
}

/**
 * Writes the corrected times into the person's record for that day (creating it if there was none), keeps their
 * breaks inside the new times, and recomputes worked minutes and status. Runs inside a transaction.
 */
// `settings` is read before the transaction: asking the pool for a second connection inside one can deadlock.
async function applyTimes(t, { settings: s, companyId, userId, date, checkIn, checkOut, editorId, note, at }) {
  await t.run(
    `INSERT INTO attendance (company_id, user_id, date, check_in, status, source) VALUES (?, ?, ?, ?, 'present', 'manual')
     ON CONFLICT DO NOTHING`,
    [companyId, userId, date, checkIn]
  );
  const rec = await t.get('SELECT * FROM attendance WHERE user_id = ? AND date = ? FOR UPDATE', [userId, date]);
  // Breaks: drop the ones entirely outside the new times, clip the rest, close one left open.
  const end = checkOut || '9999-12-31 00:00:00';
  await t.run('DELETE FROM breaks WHERE attendance_id = ? AND (started_at >= ? OR COALESCE(ended_at, started_at) <= ?)', [rec.id, end, checkIn]);
  await t.run('UPDATE breaks SET started_at = ? WHERE attendance_id = ? AND started_at < ?', [checkIn, rec.id, checkIn]);
  if (checkOut) {
    await t.run('UPDATE breaks SET ended_at = ? WHERE attendance_id = ? AND (ended_at IS NULL OR ended_at > ?)', [checkOut, rec.id, checkOut]);
  }
  await t.run(
    `UPDATE breaks SET minutes = GREATEST(EXTRACT(EPOCH FROM (ended_at - started_at))::int / 60, 0)
     WHERE attendance_id = ? AND ended_at IS NOT NULL`, [rec.id]
  );
  const { m: breakMinutes } = await t.get('SELECT COALESCE(SUM(minutes), 0)::int AS m FROM breaks WHERE attendance_id = ?', [rec.id]);
  const work = checkOut ? Math.max(minutesBetween(checkIn, checkOut) - breakMinutes, 0) : null;
  const late = minutesOf(hhmm(checkIn)) > minutesOf(s.shift_start) + Number(s.grace_minutes);
  const status = work != null && work < Number(s.half_day_minutes) ? 'half_day' : late ? 'late' : 'present';
  return t.get(
    `UPDATE attendance SET check_in = ?, check_out = ?, work_minutes = ?, break_minutes = ?, status = ?,
       edited_by = ?, edited_at = ?, edit_note = ? WHERE id = ? RETURNING *`,
    [checkIn, checkOut, work ?? 0, breakMinutes, status, editorId, at, note || null, rec.id]
  );
}

/** HR/admin: set someone's times for a day (fixes a forgotten punch-out, or adds a day they forgot entirely). */
router.put('/manual', requireRole('admin', 'hr'), async (req, res) => {
  const { user_id, date, check_in, check_out, note } = req.body || {};
  const now = clock(req.user.timezone);
  const person = await db.get(`SELECT id, name FROM users WHERE id = ? AND company_id = ?`,
    [/^\d{1,9}$/.test(String(user_id)) ? Number(user_id) : 0, req.user.company_id]);
  if (!person) return res.status(404).json({ error: 'Employee not found' });
  const times = parseTimes(date, check_in, check_out, now);
  if (times.error) return res.status(400).json(times);
  if (!String(note || '').trim()) return res.status(400).json({ error: 'Add a short note on why the times changed' });
  const settings = await getSettings(req.user.company_id);
  const old = await db.get('SELECT check_in, check_out FROM attendance WHERE user_id = ? AND date = ?', [person.id, date]);
  const record = await tx((t) => applyTimes(t, {
    settings, companyId: req.user.company_id, userId: person.id, date, ...times, editorId: req.user.id, note: String(note).trim().slice(0, 300), at: now.dateTime,
  }));
  await emit(req.user, {
    type: 'attendance.edited', audience: 'user', userId: person.id, notify: person.id !== req.user.id,
    title: `${req.user.name} updated your attendance for ${date}`, body: String(note).trim().slice(0, 300), data: { userId: person.id },
  });
  await emit(req.user, { type: 'attendance.edited', data: { userId: person.id } });
  await audit(req, {
    area: 'attendance', action: old ? `edited attendance for ${date}` : `added attendance for ${date}`, target: person,
    changes: { check_in: [old?.check_in ?? null, record.check_in], check_out: [old?.check_out ?? null, record.check_out], note: [null, String(note).trim().slice(0, 300)] },
  });
  res.json(record);
});

const CORRECTION_SQL = `
  SELECT c.*, u.name, u.emp_code, r.name AS reviewed_by_name,
         a.check_in AS current_in, a.check_out AS current_out
  FROM attendance_corrections c JOIN users u ON u.id = c.user_id
  LEFT JOIN users r ON r.id = c.reviewed_by
  LEFT JOIN attendance a ON a.user_id = c.user_id AND a.date = c.date`;

/** Managers see everyone's requests (pending first); employees see their own. */
router.get('/corrections', async (req, res) => {
  const params = [req.user.company_id];
  let sql = `${CORRECTION_SQL} WHERE c.company_id = ?`;
  if (!isManager(req.user)) {
    sql += ' AND c.user_id = ?';
    params.push(req.user.id);
  }
  if (req.query.status) {
    sql += ' AND c.status = ?';
    params.push(String(req.query.status));
  }
  res.json(await db.all(`${sql} ORDER BY c.status = 'pending' DESC, c.id DESC LIMIT 100`, params));
});

/** Employee: "these were my real times on that day". */
router.post('/corrections', async (req, res) => {
  const { date, check_in, check_out, reason } = req.body || {};
  const now = clock(req.user.timezone);
  const times = parseTimes(date, check_in, check_out, now);
  if (times.error) return res.status(400).json(times);
  const why = String(reason || '').trim();
  if (!why) return res.status(400).json({ error: 'Tell HR what happened' });
  const open = await db.get(`SELECT 1 FROM attendance_corrections WHERE user_id = ? AND date = ? AND status = 'pending'`, [req.user.id, date]);
  if (open) return res.status(409).json({ error: 'You already have a request waiting for this day' });
  const row = await db.get(
    `INSERT INTO attendance_corrections (company_id, user_id, date, check_in, check_out, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [req.user.company_id, req.user.id, date, times.checkIn, times.checkOut, why.slice(0, 500), now.dateTime]
  );
  await emit(req.user, {
    type: 'attendance.correction', notify: true,
    title: `${req.user.name} asked to fix attendance for ${date}`, body: why.slice(0, 200), data: { id: row.id },
  });
  res.status(201).json(await db.get(`${CORRECTION_SQL} WHERE c.id = ?`, [row.id]));
});

router.post('/corrections/:id/review', requireRole('admin', 'hr'), async (req, res) => {
  const { status, note } = req.body || {};
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Approve or reject' });
  const id = /^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : 0;
  const now = clock(req.user.timezone);
  const settings = await getSettings(req.user.company_id);
  const result = await tx(async (t) => {
    // Claimed in the same statement, so two reviewers can't both act on it.
    const c = await t.get(
      `UPDATE attendance_corrections SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?
       WHERE id = ? AND company_id = ? AND status = 'pending' RETURNING *`,
      [status, req.user.id, now.dateTime, String(note || '').trim().slice(0, 300) || null, id, req.user.company_id]
    );
    if (!c || status !== 'approved') return c;
    await applyTimes(t, {
      settings, companyId: c.company_id, userId: c.user_id, date: c.date, checkIn: c.check_in, checkOut: c.check_out,
      editorId: req.user.id, note: `Correction request: ${c.reason}`.slice(0, 300), at: now.dateTime,
    });
    return c;
  });
  if (!result) return res.status(409).json({ error: 'This request was already handled' });
  const person = await db.get('SELECT id, name FROM users WHERE id = ?', [result.user_id]);
  await audit(req, {
    area: 'attendance', action: `${status} attendance fix for ${result.date}`, target: person,
    changes: status === 'approved' ? { check_in: [null, result.check_in], check_out: [null, result.check_out], reason: [null, result.reason] } : { reason: [null, result.reason] },
  });
  await emit(req.user, {
    type: 'attendance.correction_reviewed', audience: 'user', userId: result.user_id, notify: true,
    title: `Your attendance fix for ${result.date} was ${status}`, body: result.review_note, data: { id: result.id },
  });
  await emit(req.user, { type: 'attendance.correction_reviewed', data: { id: result.id } });
  res.json(await db.get(`${CORRECTION_SQL} WHERE c.id = ?`, [result.id]));
});

router.post('/corrections/:id/cancel', async (req, res) => {
  const id = /^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : 0;
  const c = await db.get(
    `UPDATE attendance_corrections SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'pending' RETURNING id`,
    [id, req.user.id]
  );
  if (!c) return res.status(409).json({ error: 'Only a waiting request can be cancelled' });
  await emit(req.user, { type: 'attendance.correction_reviewed', data: { id } });
  res.json({ ok: true });
});

export default router;
