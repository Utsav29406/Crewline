import { Router } from 'express';
import crypto from 'node:crypto';
import { cleanDomain, domainOf, DOMAIN_RE, isPublicDomain } from '../join.js';
import db, { getSettings, isUniqueViolation, DEFAULT_SETTINGS } from '../db.js';
import { requireRole } from '../auth.js';
import { audit, diff } from '../audit.js';
import { emit } from '../events.js';
import { clock, addDays, isValidTimeZone, logoError, isWeeklyOff, parseSaturdaysOff, dayOfWeek, isRealDate } from '../utils.js';
import { monthlySummary } from '../payroll.js';

const router = Router();
const manager = requireRole('admin', 'hr');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const orgChanged = (req, type) => emit(req.user, { type, audience: 'all' });

/* ---------- Geofences ---------- */
router.get('/geofences', async (req, res) => {
  res.json(
    await db.all(
      `SELECT g.*, (SELECT COUNT(*) FROM users u WHERE u.geofence_id = g.id) AS assigned
       FROM geofences g WHERE g.company_id = ? ORDER BY g.name`,
      [req.user.company_id]
    )
  );
});

function fenceInput(body) {
  const lat = Number(body.lat), lng = Number(body.lng), radius = Math.round(Number(body.radius_m));
  if (!body.name || !(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180) || !(radius >= 10 && radius <= 50000)) return null;
  return [String(body.name), lat, lng, radius, body.active !== false];
}
const FENCE_ERROR = { error: 'Name, valid coordinates and radius (10–50000 m) are required' };

router.post('/geofences', manager, async (req, res) => {
  const v = fenceInput(req.body || {});
  if (!v) return res.status(400).json(FENCE_ERROR);
  const fence = await db.get(
    'INSERT INTO geofences (company_id, name, lat, lng, radius_m, active) VALUES (?, ?, ?, ?, ?, ?) RETURNING *',
    [req.user.company_id, ...v]
  );
  await orgChanged(req, 'geofence.changed');
  await audit(req, { area: 'org', action: `added office location “${fence.name}”`, changes: { radius_m: [null, fence.radius_m] } });
  res.status(201).json(fence);
});

router.put('/geofences/:id', manager, async (req, res) => {
  const v = fenceInput(req.body || {});
  if (!v) return res.status(400).json(FENCE_ERROR);
  const oldFence = await db.get('SELECT * FROM geofences WHERE id = ? AND company_id = ?', [Number(req.params.id), req.user.company_id]);
  const fence = await db.get(
    'UPDATE geofences SET name = ?, lat = ?, lng = ?, radius_m = ?, active = ? WHERE id = ? AND company_id = ? RETURNING *',
    [...v, Number(req.params.id), req.user.company_id]
  );
  if (!fence) return res.status(404).json({ error: 'Geofence not found' });
  await orgChanged(req, 'geofence.changed');
  const changes = diff(oldFence, fence, ['name', 'lat', 'lng', 'radius_m', 'active']);
  if (Object.keys(changes).length) await audit(req, { area: 'org', action: `changed office location “${fence.name}”`, changes });
  res.json(fence);
});

router.delete('/geofences/:id', manager, async (req, res) => {
  const gone = await db.get('DELETE FROM geofences WHERE id = ? AND company_id = ? RETURNING name', [Number(req.params.id), req.user.company_id]);
  await orgChanged(req, 'geofence.changed');
  if (gone) await audit(req, { area: 'org', action: `deleted office location “${gone.name}”` });
  res.json({ ok: true });
});

/* ---------- Departments ---------- */
router.get('/departments', async (req, res) => {
  res.json(
    await db.all(
      `SELECT d.*, (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.status = 'active') AS headcount
       FROM departments d WHERE d.company_id = ? ORDER BY d.name`,
      [req.user.company_id]
    )
  );
});

router.post('/departments', manager, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const row = await db.get('INSERT INTO departments (company_id, name) VALUES (?, ?) RETURNING *', [req.user.company_id, name]);
    await orgChanged(req, 'org.changed');
    await audit(req, { area: 'org', action: `added department “${row.name}”` });
    res.status(201).json({ ...row, headcount: 0 });
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'Department already exists' });
    throw err;
  }
});

router.delete('/departments/:id', manager, async (req, res) => {
  const gone = await db.get('DELETE FROM departments WHERE id = ? AND company_id = ? RETURNING name', [Number(req.params.id), req.user.company_id]);
  await orgChanged(req, 'org.changed');
  if (gone) await audit(req, { area: 'org', action: `deleted department “${gone.name}”` });
  res.json({ ok: true });
});

/* ---------- Holidays ---------- */
const ORDINAL = ['', '1st', '2nd', '3rd', '4th', '5th'];

/** Next `limit` days off from `from`: company holidays plus Saturdays off (shown as e.g. "2nd Saturday off"). */
async function upcomingDaysOff(companyId, from, limit) {
  const [holidays, { saturdays_off: satOff }] = await Promise.all([
    db.all('SELECT * FROM holidays WHERE company_id = ? AND date >= ? ORDER BY date LIMIT ?', [companyId, from, limit]),
    getSettings(companyId),
  ]);
  const saturdaysOff = parseSaturdaysOff(satOff);
  const taken = new Set(holidays.map((h) => h.date));
  const weekly = [];
  for (let d = from, i = 0; i < 70 && saturdaysOff.size; d = addDays(d, 1), i++) {
    if (dayOfWeek(d) === 6 && isWeeklyOff(d, saturdaysOff) && !taken.has(d)) {
      weekly.push({ id: `sat-${d}`, date: d, name: `${ORDINAL[Math.ceil(Number(d.slice(8, 10)) / 7)]} Saturday off`, weekly: true });
    }
  }
  return [...holidays, ...weekly].sort((a, b) => a.date.localeCompare(b.date)).slice(0, limit);
}

router.get('/holidays', async (req, res) => {
  if (req.query.upcoming) {
    return res.json(await upcomingDaysOff(req.user.company_id, clock(req.user.timezone).date, 5));
  }
  res.json(await db.all('SELECT * FROM holidays WHERE company_id = ? ORDER BY date', [req.user.company_id]));
});

router.post('/holidays', manager, async (req, res) => {
  const { date, name } = req.body || {};
  if (!isRealDate(date) || !String(name || '').trim()) return res.status(400).json({ error: 'A valid date and a name are required' });
  try {
    const row = await db.get('INSERT INTO holidays (company_id, date, name) VALUES (?, ?, ?) RETURNING *', [req.user.company_id, date, name]);
    await orgChanged(req, 'org.changed');
    await audit(req, { area: 'org', action: `added holiday “${row.name}” on ${row.date}` });
    res.status(201).json(row);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'A holiday already exists on that date' });
    throw err;
  }
});

router.delete('/holidays/:id', manager, async (req, res) => {
  const gone = await db.get('DELETE FROM holidays WHERE id = ? AND company_id = ? RETURNING name, date', [Number(req.params.id), req.user.company_id]);
  await orgChanged(req, 'org.changed');
  if (gone) await audit(req, { area: 'org', action: `deleted holiday “${gone.name}” on ${gone.date}` });
  res.json({ ok: true });
});

/* ---------- Settings (policy + company profile) ---------- */
async function settingsWithCompany(companyId) {
  const [settings, company] = await Promise.all([
    getSettings(companyId),
    db.get(
      'SELECT name, timezone, is_demo, CASE WHEN logo IS NULL THEN NULL ELSE logo_version END AS logo_v FROM companies WHERE id = ?',
      [companyId]
    ),
  ]);
  delete settings.join_code; // everyone can read settings; only HR sees the join link (GET /join-link)
  return { ...settings, company_name: company.name, timezone: company.timezone, is_demo: company.is_demo, company_logo_v: company.logo_v };
}

router.get('/settings', async (req, res) => res.json(await settingsWithCompany(req.user.company_id)));

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const WHOLE = /^\d+$/;
/**
 * Why a policy value can't be saved, or null. Bad values otherwise fail quietly later: a shift start of "9"
 * stops late marking, an unknown currency code breaks payroll publishing.
 */
/** A company may only claim its own domain: the admin's email must be there, and no other company may have it. */
async function joinDomainError(domain, admin, isDemo) {
  if (isDemo) return "The demo company can't use email sign-up";
  if (domainOf(admin.email) !== domain) return `Your own email must be at @${domain} to turn this on (you sign in as ${admin.email})`;
  const taken = await db.get(`SELECT 1 FROM settings WHERE key = 'join_domain' AND value = ? AND company_id <> ?`, [domain, admin.company_id]);
  return taken ? `Another company on Crewline already uses @${domain}` : null;
}

function settingError(key, value) {
  switch (key) {
    case 'shift_start':
    case 'shift_end':
      return HHMM.test(value) ? null : 'Shift times must look like 09:30 (24-hour)';
    case 'max_gps_accuracy_m':
      // Below ~20 m almost no phone qualifies, and every check-in would be refused.
      return WHOLE.test(value) && Number(value) >= 20 && Number(value) <= 100000 ? null : 'Max GPS accuracy must be at least 20 metres';
    case 'grace_minutes':
    case 'half_day_minutes':
    case 'payroll_pt':
    case 'carry_casual':
    case 'carry_sick':
    case 'carry_earned':
    case 'comp_off_expiry_days':
      return WHOLE.test(value) && Number(value) <= 3650 ? null : `${key.replace(/_/g, ' ')} must be a whole number of days`;
    case 'quota_casual':
    case 'quota_sick':
    case 'quota_earned':
    case 'overtime_after_minutes':
      return WHOLE.test(value) && Number(value) <= 100000 ? null : `${key.replace(/_/g, ' ')} must be a whole number`;
    case 'require_face':
    case 'require_geofence':
    case 'payroll_pf':
    case 'daily_log_email':
    case 'tracker_prompt':
    case 'email_notifications':
    case 'leave_half_day':
    case 'comp_off':
      return value === '0' || value === '1' ? null : `${key.replace(/_/g, ' ')} must be on or off`;
    case 'currency':
      try {
        new Intl.NumberFormat('en', { style: 'currency', currency: value });
        return /^[A-Z]{3}$/.test(value) ? null : 'Currency must be a 3-letter code like INR';
      } catch {
        return 'Currency must be a 3-letter code like INR';
      }
    case 'saturdays_off':
      return /^([1-5](,[1-5])*)?$/.test(value) ? null : 'Saturdays off must be week numbers like 2,4';
    case 'join_domain':
      if (value === '') return null;
      if (!DOMAIN_RE.test(value)) return 'Enter just the email domain, like yourcompany.com';
      return isPublicDomain(value) ? `${value} is a public email provider, so it can't identify your company` : null;
    case 'auto_attendance_until':
      return value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value) ? null : 'Use a date like 2026-11-30, or leave it empty';
    default:
      return null;
  }
}

router.put('/settings', requireRole('admin'), async (req, res) => {
  const body = req.body || {};
  const before = await settingsWithCompany(req.user.company_id);
  const { is_demo: isDemo } = await db.get('SELECT is_demo FROM companies WHERE id = ?', [req.user.company_id]);
  if (!isDemo && (body.company_name !== undefined || body.timezone !== undefined)) {
    const name = String(body.company_name ?? '').trim();
    const tz = String(body.timezone ?? '');
    if (body.company_name !== undefined && (name.length < 2 || name.length > 80)) return res.status(400).json({ error: 'Company name must be 2–80 characters' });
    if (body.timezone !== undefined && !isValidTimeZone(tz)) return res.status(400).json({ error: 'Unknown timezone' });
    await db.run(
      'UPDATE companies SET name = COALESCE(?, name), timezone = COALESCE(?, timezone) WHERE id = ?',
      [body.company_name !== undefined ? name : null, body.timezone !== undefined ? tz : null, req.user.company_id]
    );
  }
  if (body.join_domain !== undefined) {
    body.join_domain = cleanDomain(body.join_domain);
    // Only a change is checked, so another admin can still save the policy form with the domain already set.
    const current = (await db.get(`SELECT value FROM settings WHERE company_id = ? AND key = 'join_domain'`, [req.user.company_id]))?.value || '';
    const err = body.join_domain && body.join_domain !== current && await joinDomainError(body.join_domain, req.user, isDemo);
    if (err) return res.status(400).json({ error: err });
  }
  const bad = Object.entries(body).find(([k, v]) => k in DEFAULT_SETTINGS && settingError(k, String(v)));
  if (bad) return res.status(400).json({ error: settingError(bad[0], String(bad[1])) });
  for (const [k, v] of Object.entries(body)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    await db.run(
      `INSERT INTO settings (company_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [req.user.company_id, k, String(v)]
    );
  }
  await orgChanged(req, 'settings.changed');
  const after = await settingsWithCompany(req.user.company_id);
  const changes = diff(before, after, [...Object.keys(DEFAULT_SETTINGS), 'company_name', 'timezone']);
  if (Object.keys(changes).length) await audit(req, { area: 'settings', action: `changed ${Object.keys(changes).map((k) => k.replace(/_/g, ' ')).join(', ')}`, changes });
  res.json(after);
});

/* ---------- Activity history (admins and HR) ---------- */

router.get('/audit', manager, async (req, res) => {
  const params = [req.user.company_id];
  let sql = 'SELECT * FROM audit_log WHERE company_id = ?';
  const areas = ['employee', 'attendance', 'leave', 'payroll', 'settings', 'org'];
  if (areas.includes(req.query.area)) { sql += ' AND area = ?'; params.push(req.query.area); }
  if (/^\d{1,9}$/.test(String(req.query.user_id || ''))) { sql += ' AND (target_user_id = ? OR actor_id = ?)'; params.push(Number(req.query.user_id), Number(req.query.user_id)); }
  if (/^\d{1,9}$/.test(String(req.query.before || ''))) { sql += ' AND id < ?'; params.push(Number(req.query.before)); }
  res.json(await db.all(`${sql} ORDER BY id DESC LIMIT 100`, params));
});

/* ---------- Join link: anyone with it (any email, Gmail included) can ask to join; HR approves ---------- */

const joinLink = async (companyId) =>
  (await db.get(`SELECT value FROM settings WHERE company_id = ? AND key = 'join_code'`, [companyId]))?.value || '';

router.get('/join-link', manager, async (req, res) => res.json({ code: await joinLink(req.user.company_id) }));

/** Turns the link on, or replaces it (the old link stops working). */
router.post('/join-link', manager, async (req, res) => {
  const { is_demo: isDemo } = await db.get('SELECT is_demo FROM companies WHERE id = ?', [req.user.company_id]);
  if (isDemo) return res.status(403).json({ error: "The demo company can't have a join link. Register your own company." });
  const code = crypto.randomBytes(18).toString('base64url');
  await db.run(
    `INSERT INTO settings (company_id, key, value) VALUES (?, 'join_code', ?)
     ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [req.user.company_id, code]
  );
  await audit(req, { area: 'settings', action: 'made a new join link' });
  res.json({ code });
});

router.delete('/join-link', manager, async (req, res) => {
  await db.run(`DELETE FROM settings WHERE company_id = ? AND key = 'join_code'`, [req.user.company_id]);
  await audit(req, { area: 'settings', action: 'turned off the join link' });
  res.json({ code: '' });
});

/** Company logo: PUT { logo: dataUrl } replaces it, DELETE removes it. Served publicly by app.js. */
async function setLogo(req, res, logo) {
  const { is_demo: isDemo } = await db.get('SELECT is_demo FROM companies WHERE id = ?', [req.user.company_id]);
  if (isDemo) return res.status(403).json({ error: "The shared demo company's logo is fixed. Register your own company to add one." });
  await db.run('UPDATE companies SET logo = ?, logo_version = logo_version + 1 WHERE id = ?', [logo, req.user.company_id]);
  await orgChanged(req, 'settings.changed');
  res.json(await settingsWithCompany(req.user.company_id));
}

router.put('/company/logo', requireRole('admin'), async (req, res) => {
  const logo = String(req.body?.logo || '');
  const error = logoError(logo);
  if (error) return res.status(400).json({ error });
  await setLogo(req, res, logo);
});

router.delete('/company/logo', requireRole('admin'), (req, res) => setLogo(req, res, null));

/* ---------- Dashboard ---------- */
router.get('/dashboard', manager, async (req, res) => {
  const cid = req.user.company_id;
  const today = clock(req.user.timezone).date;
  const from = addDays(today, -13);
  const [stats, trendRows, byDepartment, upcomingHolidays] = await Promise.all([
    db.get(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE company_id = ? AND status = 'active') AS headcount,
         (SELECT COUNT(*) FROM attendance WHERE company_id = ? AND date = ?) AS present,
         (SELECT COUNT(*) FROM attendance WHERE company_id = ? AND date = ? AND status = 'late') AS late,
         (SELECT COUNT(DISTINCT user_id) FROM leaves WHERE company_id = ? AND status = 'approved' AND ?::date BETWEEN start_date AND end_date) AS "onLeave",
         (SELECT COUNT(*) FROM leaves WHERE company_id = ? AND status = 'pending') AS "pendingLeaves",
         (SELECT COUNT(*) FROM attendance_attempts WHERE company_id = ? AND NOT success AND created_at::date = ?) AS "failedToday",
         (SELECT COUNT(*) FROM users WHERE company_id = ? AND status = 'active' AND face_descriptors IS NULL) AS "notEnrolled",
         (SELECT COUNT(*) FROM geofences WHERE company_id = ? AND active) AS geofences,
         (SELECT COUNT(*) FROM departments WHERE company_id = ?) AS departments`,
      [cid, cid, today, cid, today, cid, today, cid, cid, today, cid, cid, cid]
    ),
    db.all(
      `SELECT date, COUNT(*) AS present, COUNT(*) FILTER (WHERE status = 'late') AS late
       FROM attendance WHERE company_id = ? AND date BETWEEN ? AND ? GROUP BY date`,
      [cid, from, today]
    ),
    db.all(
      `SELECT COALESCE(d.name, 'Unassigned') AS department, COUNT(u.id) AS headcount, COUNT(a.id) AS present
       FROM users u LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN attendance a ON a.user_id = u.id AND a.date = ?
       WHERE u.company_id = ? AND u.status = 'active' GROUP BY d.name ORDER BY headcount DESC`,
      [today, cid]
    ),
    upcomingDaysOff(cid, today, 4),
  ]);

  const byDate = Object.fromEntries(trendRows.map((r) => [r.date, r]));
  const trend = [];
  for (let d = from; d <= today; d = addDays(d, 1)) {
    trend.push({ date: d, present: byDate[d]?.present || 0, late: byDate[d]?.late || 0 });
  }
  stats.absent = Math.max(stats.headcount - stats.present - stats.onLeave, 0);
  res.json({ stats, trend, byDepartment, upcomingHolidays, today });
});

/* ---------- Monthly report ---------- */
/** Time the desktop tracker logged to each task between two days, and the total per person. */
router.get('/reports/tasks', manager, async (req, res) => {
  const today = clock(req.user.timezone).date;
  const from = isRealDate(req.query.from) ? req.query.from : `${today.slice(0, 7)}-01`;
  const to = isRealDate(req.query.to) ? req.query.to : today;
  const tasks = await db.all(
    `SELECT t.id, t.title, t.status, t.priority, t.estimate_minutes, t.due_date, u.id AS user_id, u.name AS assignee, u.emp_code,
            SUM(tt.seconds)::int AS seconds, COUNT(DISTINCT tt.date)::int AS days
     FROM task_time tt JOIN tasks t ON t.id = tt.task_id JOIN users u ON u.id = tt.user_id
     WHERE t.company_id = ? AND tt.date BETWEEN ? AND ?
     GROUP BY t.id, u.id ORDER BY seconds DESC`,
    [req.user.company_id, from, to]
  );
  const people = {};
  for (const t of tasks) {
    const p = (people[t.user_id] ||= { user_id: t.user_id, name: t.assignee, emp_code: t.emp_code, seconds: 0, tasks: 0 });
    p.seconds += t.seconds;
    p.tasks += 1;
  }
  res.json({ from, to, tasks, people: Object.values(people).sort((a, b) => b.seconds - a.seconds) });
});

router.get('/reports/monthly', manager, async (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : clock(req.user.timezone).date.slice(0, 7);
  res.json(await monthlySummary(req.user.company_id, month));
});

export default router;
