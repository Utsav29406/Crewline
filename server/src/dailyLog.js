import { deliver, emailLayout, esc, mailer } from './mail.js';
import db, { getSettings } from './db.js';
import { addDays, clock, isWeeklyOff, parseSaturdaysOff } from './utils.js';

/**
 * Daily attendance log email: each person gets their day (check-in, every break and lunch, check-out, hours)
 * when they punch out. A backup run after midnight covers anyone who didn't get one: forgot to punch out,
 * absent, or on leave. Only for companies with the `daily_log_email` setting on, and only when SMTP is set up:
 *   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS, MAIL_FROM (e.g. "Crewline <attendance@example.com>")
 */

const LEAVE_NAMES = { casual: 'Casual leave', sick: 'Sick leave', earned: 'Earned leave', unpaid: 'Unpaid leave' };
const STATUS_NAMES = { present: 'Present', late: 'Late', half_day: 'Half day', absent: 'Absent' };
const BREAK_NAMES = { lunch: 'Lunch', break: 'Short break' };

const time = (dt) => {
  const h = Number(dt.slice(11, 13));
  return `${((h + 11) % 12) + 1}:${dt.slice(14, 16)} ${h < 12 ? 'am' : 'pm'}`;
};
const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m} min`);
const longDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
});
const shortDate = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
});

/** Everything the email shows for one person on one day. */
async function dayLog(user, date) {
  const record = await db.get(
    `SELECT a.*, g.name AS geofence FROM attendance a LEFT JOIN geofences g ON g.id = a.geofence_id WHERE a.user_id = ? AND a.date = ?`,
    [user.id, date]
  );
  const breaks = record
    ? await db.all('SELECT type, started_at, ended_at, minutes FROM breaks WHERE attendance_id = ? ORDER BY started_at', [record.id])
    : [];
  const leave = record ? null : await db.get(
    `SELECT type FROM leaves WHERE user_id = ? AND status = 'approved' AND ? BETWEEN start_date AND end_date`, [user.id, date]
  );
  return { record, breaks, leave };
}

function render(user, date, { record, breaks, leave }) {
  const rows = [];
  let summary;
  let note = '';
  if (record) {
    rows.push(['Checked in', time(record.check_in)]);
    for (const b of breaks) {
      rows.push([BREAK_NAMES[b.type] || 'Break', b.ended_at ? `${time(b.started_at)} – ${time(b.ended_at)} · ${dur(b.minutes)}` : `from ${time(b.started_at)}`]);
    }
    rows.push(['Checked out', record.check_out ? time(record.check_out) : 'Not punched out']);
    summary = [
      ['Worked', record.check_out ? dur(record.work_minutes) : '—'],
      ['Breaks', dur(record.break_minutes || 0)],
      ['Status', STATUS_NAMES[record.status] || record.status],
    ];
    if (!record.check_out) note = "You didn't punch out on this day. Open Attendance in Crewline and use Request fix to tell HR what time you left.";
  } else if (leave) {
    summary = [['Status', LEAVE_NAMES[leave.type] || 'On leave']];
  } else {
    summary = [['Status', 'No attendance recorded']];
    note = "There's no check-in for this day. If you were working, open Attendance in Crewline and use Fix a missing day.";
  }

  const subject = `Your attendance · ${shortDate(date)}`;
  const text = [
    `Hi ${user.name},`, '', `Your attendance for ${longDate(date)}:`, '',
    ...rows.map(([k, v]) => `${k}: ${v}`), ...(rows.length ? [''] : []),
    ...summary.map(([k, v]) => `${k}: ${v}`), ...(note ? ['', note] : []),
    '', `${user.company} · sent by Crewline`,
  ].join('\n');

  const cell = 'padding:10px 0;border-bottom:1px solid #e6e8ef';
  const html = emailLayout(`
    <div style="font-size:13px;color:#747c94;font-weight:600">${esc(user.company)}</div>
    <h1 style="margin:4px 0 2px;font-size:20px;color:#262b3d">Your attendance</h1>
    <div style="font-size:14px;color:#535b74">${esc(longDate(date))}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:16px 0 4px;font-size:14px">
      ${summary.map(([k, v]) => `<tr><td style="${cell};color:#747c94">${esc(k)}</td><td align="right" style="${cell};text-align:right;font-weight:700;color:#262b3d">${esc(v)}</td></tr>`).join('')}
    </table>
    ${rows.length ? `<div style="font-size:12px;color:#747c94;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-top:18px">Timeline</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;font-size:14px">
      ${rows.map(([k, v]) => `<tr><td style="${cell};color:#262b3d">${esc(k)}</td><td align="right" style="${cell};text-align:right;color:#262b3d">${esc(v)}</td></tr>`).join('')}
    </table>` : ''}
    ${note ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 0"><tr><td bgcolor="#fff6e0" style="padding:12px;border-radius:10px;color:#8a5a00;font-size:13px;line-height:1.5">${esc(note)}</td></tr></table>` : ''}`,
  'Sent by Crewline · your attendance log for the day.');
  return { subject, text, html };
}

/**
 * Emails one person their log for `date`, once. Never throws; returns what happened.
 * The daily_logs row is claimed first so a punch-out and the midnight run can't both send it.
 */
export async function sendDailyLog(userId, date) {
  try {
    const user = await db.get(
      `SELECT u.id, u.name, u.email, u.company_id, c.name AS company FROM users u JOIN companies c ON c.id = u.company_id
       WHERE u.id = ? AND u.status = 'active'`,
      [userId]
    );
    if (!user?.email) return { skipped: 'no user' };
    if ((await getSettings(user.company_id)).daily_log_email !== '1') return { skipped: 'off' };
    const smtp = mailer();
    if (!smtp) return { skipped: 'smtp not set up' };
    const claimed = await db.get(
      'INSERT INTO daily_logs (user_id, date, company_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING user_id',
      [user.id, date, user.company_id]
    );
    if (!claimed) return { skipped: 'already sent' };
    try {
      const { subject, text, html } = render(user, date, await dayLog(user, date));
      await deliver(smtp, { to: user.email, subject, text, html });
      return { sent: user.email };
    } catch (err) {
      await db.run('DELETE FROM daily_logs WHERE user_id = ? AND date = ?', [user.id, date]);
      throw err;
    }
  } catch (err) {
    console.error('daily log email failed', userId, date, err.message);
    return { error: err.message };
  }
}

/** After midnight: yesterday's log for everyone who didn't get one on punch-out (on working days, or anyone with a record). */
export async function sendMissedDailyLogs(when = new Date()) {
  const companies = await db.all(
    `SELECT c.id, c.timezone FROM companies c JOIN settings s ON s.company_id = c.id AND s.key = 'daily_log_email' AND s.value = '1'`
  );
  const results = [];
  for (const c of companies) {
    const date = addDays(clock(c.timezone, when).date, -1);
    const s = await getSettings(c.id);
    const holiday = await db.get('SELECT 1 FROM holidays WHERE company_id = ? AND date = ?', [c.id, date]);
    const workingDay = !holiday && !isWeeklyOff(date, parseSaturdaysOff(s.saturdays_off));
    const users = await db.all(
      `SELECT u.id FROM users u
       WHERE u.company_id = ? AND u.status = 'active' AND (u.joined_on IS NULL OR u.joined_on <= ?::date)
         AND NOT EXISTS (SELECT 1 FROM daily_logs d WHERE d.user_id = u.id AND d.date = ?)
         AND (?::boolean OR EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = u.id AND a.date = ?))`,
      [c.id, date, date, workingDay, date]
    );
    for (const u of users) results.push({ userId: u.id, date, ...(await sendDailyLog(u.id, date)) });
  }
  return results;
}

export const renderDailyLog = render; // for previews and tests
