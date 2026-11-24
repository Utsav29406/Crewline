import db, { getSettings } from './db.js';
import { sendDailyLog } from './dailyLog.js';
import { emit } from './events.js';
import { clock, haversine, isWeeklyOff, minutesBetween, parseSaturdaysOff } from './utils.js';

/**
 * Test helper: checks a company's staff in every morning, sends them to lunch at 1:30 pm and out every
 * evening at varied, realistic times. Runs from four daily cron calls (vercel.json) for each company whose
 * `auto_attendance_until` setting is today or later. Rows it creates are marked source = 'auto'.
 *
 * Skips Sundays, Saturdays the company has off, company holidays, approved leave, and anyone who already checked in
 * themselves; lunch and check-out only touch the records it created, never someone's own punches.
 */

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};
// Every generated time avoids round minutes (1:30, 2:35) and :00 seconds so it reads like a real punch.
// Round minutes move a minute or two earlier, which keeps them within any "not after now" cap.
const offRound = (minutes) => (minutes % 5 === 0 ? minutes - rand(1, 2) : minutes);
const at = (date, minutes) => {
  const m = offRound(minutes);
  return `${date} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:${String(rand(1, 59)).padStart(2, '0')}`;
};
const hhmm = (dateTime) => dateTime.slice(11, 16);
const LUNCH_START = 13 * 60 + 30; // 1:30 pm
const LUNCH_MINUTES = 60;
// The odd unplanned absence (about 1 in 25), fixed per person per day so repeated runs agree.
const absentToday = (userId, date) => [...`${userId}|${date}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 25 === 0;
// ~20 m of GPS wobble around the office.
const jitter = (v) => v + (Math.random() - 0.5) * 0.0004;
// A face-match distance in the range real punches give (lower is closer; 0.27–0.44 shows as a 56–73% match).
export const faceDistance = () => Math.round((0.27 + Math.random() * 0.17) * 1000) / 1000;

/** The punch-log row a face check-in or check-out leaves behind, so automatic days read the same as real ones. */
export async function logPunch({ companyId, userId, action, lat, lng, fence, face, at: when }) {
  const distance = fence && lat != null ? Math.round(haversine(lat, lng, fence.lat, fence.lng)) : null;
  await db.run(
    `INSERT INTO attendance_attempts (company_id, user_id, action, success, lat, lng, distance_m, face_distance, created_at)
     VALUES (?, ?, ?, true, ?, ?, ?, ?, ?)`,
    [companyId, userId, action, lat, lng, distance, face, when]
  );
}

async function activeCompanies(when) {
  const rows = await db.all(
    `SELECT c.id, c.timezone, s.value AS until FROM companies c
     JOIN settings s ON s.company_id = c.id AND s.key = 'auto_attendance_until' AND s.value <> ''`
  );
  return rows
    .map((c) => ({ ...c, now: clock(c.timezone, when) }))
    .filter((c) => c.now.date <= c.until);
}

async function isWorkingDay(companyId, date) {
  const { saturdays_off: satOff } = await getSettings(companyId);
  if (isWeeklyOff(date, parseSaturdaysOff(satOff))) return false;
  return !(await db.get('SELECT 1 FROM holidays WHERE company_id = ? AND date = ?', [companyId, date]));
}

async function checkIn(company) {
  const { id: cid, now } = company;
  const s = await getSettings(cid);
  const start = minutesOf(s.shift_start);
  const grace = Number(s.grace_minutes);
  if (now.minutes < start - 20) return { skipped: 'too early' };

  const users = await db.all(
    `SELECT u.id, u.name, u.geofence_id FROM users u
     WHERE u.company_id = ? AND u.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = u.id AND a.date = ?)
       AND NOT EXISTS (SELECT 1 FROM leaves l WHERE l.user_id = u.id AND l.status = 'approved' AND ? BETWEEN l.start_date AND l.end_date)`,
    [cid, now.date, now.date]
  );
  const fences = await db.all('SELECT id, lat, lng FROM geofences WHERE company_id = ? AND active ORDER BY id', [cid]);
  let done = 0;
  for (const u of users) {
    if (absentToday(u.id, now.date)) continue;
    // Everyone arrives in the half hour after the shift starts: nearly all within grace, the odd one a little late.
    // Round-looking minutes (9:30, 9:35, 10:00) are avoided so times read like real punches (9:37, 9:43).
    let minute;
    do {
      minute = Math.random() < 0.88 ? rand(start + 1, start + grace) : rand(start + grace + 1, start + 29);
    } while (minute % 5 === 0);
    minute = Math.min(minute, now.minutes - rand(0, 4));
    const fence = fences.find((f) => f.id === u.geofence_id) || fences[0];
    const late = minute > start + grace;
    const checkInAt = at(now.date, minute);
    const lat = fence ? jitter(fence.lat) : null;
    const lng = fence ? jitter(fence.lng) : null;
    const face = faceDistance();
    const row = await db.get(
      `INSERT INTO attendance (company_id, user_id, date, check_in, in_lat, in_lng, geofence_id, face_distance, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto') ON CONFLICT (user_id, date) DO NOTHING RETURNING id`,
      [cid, u.id, now.date, checkInAt, lat, lng, fence?.id ?? null, face, late ? 'late' : 'present']
    );
    if (!row) continue;
    await logPunch({ companyId: cid, userId: u.id, action: 'check_in', lat, lng, fence, face, at: checkInAt });
    done++;
    await emit({ company_id: cid, id: u.id, timezone: company.timezone }, {
      type: 'attendance.check_in', notify: late,
      title: late ? `${u.name} checked in late at ${hhmm(checkInAt)}` : `${u.name} checked in`,
      data: { userId: u.id },
    });
  }
  return { checkedIn: done };
}

async function checkOut(company) {
  const { id: cid, now } = company;
  const s = await getSettings(cid);
  const end = minutesOf(s.shift_end);
  if (now.minutes < end - 30) return { skipped: 'too early' };

  const open = await db.all(
    `SELECT a.*, u.name, u.geofence_id AS home_fence,
            (SELECT MAX(GREATEST(b.started_at, COALESCE(b.ended_at, b.started_at))) FROM breaks b WHERE b.attendance_id = a.id) AS last_break
     FROM attendance a JOIN users u ON u.id = a.user_id
     WHERE a.company_id = ? AND a.date = ? AND a.check_out IS NULL AND a.source = 'auto'`,
    [cid, now.date]
  );
  const fences = await db.all('SELECT id, lat, lng FROM geofences WHERE company_id = ? AND active ORDER BY id', [cid]);
  let done = 0;
  const emails = [];
  for (const a of open) {
    const inMinute = minutesOf(a.check_in.slice(11, 16));
    const hasBreaks = await db.get('SELECT 1 FROM breaks WHERE attendance_id = ?', [a.id]);
    // Half days leave around lunch, so only for people who haven't taken a break yet.
    const halfDay = !hasBreaks && Math.random() < 0.04;
    let minute = halfDay ? rand(13 * 60 + 20, 14 * 60 + 10) : rand(end - 15, end + 55);
    minute = Math.max(Math.min(minute, now.minutes - rand(0, 4)), inMinute + 30);
    // Never before a break that was already taken or started, never in the future, never past the day's end.
    if (a.last_break) minute = Math.max(minute, minutesOf(a.last_break.slice(11, 16)) + 3);
    minute = Math.min(minute, now.minutes, 24 * 60 - 1);
    const checkOutAt = at(now.date, minute);
    // Claim the check-out first: the cron and the catch-up can run at once, and only one may add a lunch.
    const claimed = await db.get('UPDATE attendance SET check_out = ? WHERE id = ? AND check_out IS NULL RETURNING id', [checkOutAt, a.id]);
    if (!claimed) continue;

    // Close a break someone left open: lunch lasts at most an hour, a short break 15 minutes.
    await db.run(
      `UPDATE breaks SET ended_at = LEAST(?::timestamp, started_at + make_interval(mins => CASE WHEN type = 'lunch' THEN ${LUNCH_MINUTES} ELSE 15 END))
       WHERE attendance_id = ? AND ended_at IS NULL`,
      [checkOutAt, a.id]
    );
    await db.run(
      'UPDATE breaks SET minutes = GREATEST(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60, 0)::int WHERE attendance_id = ? AND minutes = 0',
      [a.id]
    );
    // Usual lunch: 1:30 to 2:30 pm, give or take a few minutes.
    if (!hasBreaks && !halfDay && minute > 14 * 60 + 40) {
      const lunchStart = at(now.date, rand(LUNCH_START - 3, LUNCH_START + 4));
      const lunchMinutes = rand(LUNCH_MINUTES - 4, LUNCH_MINUTES + 3);
      const lunchEnd = at(now.date, minutesOf(lunchStart.slice(11, 16)) + lunchMinutes);
      await db.run(
        `INSERT INTO breaks (company_id, user_id, attendance_id, type, started_at, ended_at, minutes) VALUES (?, ?, ?, 'lunch', ?, ?, ?)`,
        [cid, a.user_id, a.id, lunchStart, lunchEnd, minutesBetween(lunchStart, lunchEnd)]
      );
    }
    const { total } = await db.get('SELECT COALESCE(SUM(minutes), 0) AS total FROM breaks WHERE attendance_id = ?', [a.id]);
    const work = Math.max(minutesBetween(a.check_in, checkOutAt) - total, 0);
    const fence = fences.find((f) => f.id === (a.geofence_id ?? a.home_fence)) || fences[0];
    const lat = fence ? jitter(fence.lat) : null;
    const lng = fence ? jitter(fence.lng) : null;
    await db.run(
      'UPDATE attendance SET out_lat = ?, out_lng = ?, work_minutes = ?, break_minutes = ?, status = ? WHERE id = ?',
      [lat, lng, work, total, work < Number(s.half_day_minutes) ? 'half_day' : a.status, a.id]
    );
    await logPunch({ companyId: cid, userId: a.user_id, action: 'check_out', lat, lng, fence, face: faceDistance(), at: checkOutAt });
    done++;
    await emit({ company_id: cid, id: a.user_id, timezone: company.timezone }, {
      type: 'attendance.check_out', title: `${a.name} checked out`, data: { userId: a.user_id },
    });
    emails.push([a.user_id, a.date]);
  }
  // Emails last, after every record is complete: a slow mail server can't leave check-outs half-written.
  for (const [userId, date] of emails) await sendDailyLog(userId, date);
  return { checkedOut: done };
}

async function lunchStart(company) {
  const { id: cid, now } = company;
  if (now.minutes < LUNCH_START - 5) return { skipped: 'too early' };
  // Everyone still at work who hasn't had lunch and isn't on a break.
  const rows = await db.all(
    `SELECT a.id, a.user_id, a.check_in, u.name,
            (SELECT MAX(b.ended_at) FROM breaks b WHERE b.attendance_id = a.id) AS last_break_end
     FROM attendance a JOIN users u ON u.id = a.user_id
     WHERE a.company_id = ? AND a.date = ? AND a.check_out IS NULL AND a.source = 'auto'
       AND NOT EXISTS (SELECT 1 FROM breaks b WHERE b.attendance_id = a.id AND (b.type = 'lunch' OR b.ended_at IS NULL))`,
    [cid, now.date]
  );
  let done = 0;
  for (const a of rows) {
    let minute = Math.max(Math.min(rand(LUNCH_START - 3, LUNCH_START + 4), now.minutes), minutesOf(a.check_in.slice(11, 16)) + 1);
    // Back-dated lunch must start after any break that already ended (at() can round a minute or two earlier).
    if (a.last_break_end) minute = Math.max(minute, minutesOf(a.last_break_end.slice(11, 16)) + 3);
    if (minute > now.minutes) continue; // that break only just ended: the next run starts lunch
    const row = await db.get(
      `INSERT INTO breaks (company_id, user_id, attendance_id, type, started_at) VALUES (?, ?, ?, 'lunch', ?)
       ON CONFLICT DO NOTHING RETURNING id`,
      [cid, a.user_id, a.id, at(now.date, minute)]
    );
    if (!row) continue;
    done++;
    await emit({ company_id: cid, id: a.user_id, timezone: company.timezone }, {
      type: 'attendance.break_start', title: `${a.name} started lunch`, data: { userId: a.user_id },
    });
  }
  return { lunchStarted: done };
}

async function lunchEnd(company) {
  const { id: cid, now } = company;
  if (now.minutes < LUNCH_START + LUNCH_MINUTES - 5) return { skipped: 'too early' };
  const open = await db.all(
    `SELECT b.id, b.user_id, b.attendance_id, b.started_at, u.name FROM breaks b JOIN users u ON u.id = b.user_id
     JOIN attendance a ON a.id = b.attendance_id
     WHERE b.company_id = ? AND a.date = ? AND b.type = 'lunch' AND b.ended_at IS NULL AND a.source = 'auto' AND b.source IS DISTINCT FROM 'tracker'`,
    [cid, now.date]
  );
  let done = 0;
  for (const b of open) {
    const started = minutesOf(b.started_at.slice(11, 16));
    if (now.minutes < started + LUNCH_MINUTES - 4) continue; // not an hour yet
    // About an hour, never later than now.
    const minute = Math.min(started + rand(LUNCH_MINUTES - 4, LUNCH_MINUTES + 3), now.minutes);
    const endAt = at(now.date, minute);
    const row = await db.get(
      'UPDATE breaks SET ended_at = ?, minutes = ? WHERE id = ? AND ended_at IS NULL RETURNING id',
      [endAt, Math.max(minutesBetween(b.started_at, endAt), 0), b.id]
    );
    if (!row) continue;
    await db.run(
      'UPDATE attendance SET break_minutes = (SELECT COALESCE(SUM(minutes), 0) FROM breaks WHERE attendance_id = ?) WHERE id = ?',
      [b.attendance_id, b.attendance_id]
    );
    done++;
    await emit({ company_id: cid, id: b.user_id, timezone: company.timezone }, {
      type: 'attendance.break_end', title: `${b.name} is back from lunch`, data: { userId: b.user_id },
    });
  }
  return { lunchEnded: done };
}

const PHASES = { in: checkIn, out: checkOut, 'lunch-start': lunchStart, 'lunch-end': lunchEnd };
export const AUTO_PHASES = Object.keys(PHASES);

/** phase: 'in' (morning), 'lunch-start', 'lunch-end' or 'out' (evening); `when` is only overridden by tests. Returns a per-company summary. */
export async function runAutoAttendance(phase, when = new Date()) {
  const results = [];
  for (const company of await activeCompanies(when)) {
    if (!(await isWorkingDay(company.id, company.now.date))) {
      results.push({ company: company.id, date: company.now.date, skipped: 'holiday or weekly off' });
      continue;
    }
    const r = await PHASES[phase](company);
    results.push({ company: company.id, date: company.now.date, ...r });
  }
  return results;
}

/**
 * Backup for missed cron runs: called on API traffic (at most every 5 minutes per server instance) and runs any
 * step that is already due today, plus check-out for records left open on earlier days. Every step is idempotent.
 */
let lastCatchUp = 0;
export async function catchUpAutoAttendance(when = new Date()) {
  if (when.getTime() - lastCatchUp < 5 * 60 * 1000) return;
  lastCatchUp = when.getTime();
  for (const company of await activeCompanies(when)) {
    const { id: cid, now } = company;
    const stale = await db.all(
      `SELECT DISTINCT date FROM attendance WHERE company_id = ? AND check_out IS NULL AND source = 'auto' AND date < ? ORDER BY date`,
      [cid, now.date]
    );
    for (const { date } of stale) await checkOut({ ...company, now: { ...now, date, minutes: 24 * 60 - 1 } });
    if (!(await isWorkingDay(cid, now.date))) continue;
    const s = await getSettings(cid);
    const start = minutesOf(s.shift_start);
    const end = minutesOf(s.shift_end);
    const m = now.minutes;
    if (m >= start + 30 && m < end) await checkIn(company);
    if (m >= LUNCH_START + 10 && m < LUNCH_START + LUNCH_MINUTES) await lunchStart(company);
    if (m >= LUNCH_START + LUNCH_MINUTES + 5) await lunchEnd(company);
    if (m >= end + 60) await checkOut(company);
  }
}
