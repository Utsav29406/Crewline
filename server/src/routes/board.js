import { Router } from 'express';
import db, { getSettings } from '../db.js';
import { isManager, requireRole } from '../auth.js';
import { emit } from '../events.js';
import { audit } from '../audit.js';
import { addDays, clock, isRealDate } from '../utils.js';

/** Notice board (admin/HR post, everyone reads) and the dashboard's birthdays and work anniversaries. */
const router = Router();

/*
 * Automatic announcements: worked out fresh for today on every read, so nothing is stored or posted twice.
 * Each kind has a few wordings; the one shown depends on the person and the day, so it doesn't change on reload.
 */
const WORDING = {
  birthday: [
    (p) => [`Happy birthday, ${p.first}!`, `Wishing ${p.first} a wonderful year ahead. Drop by and say happy birthday!`],
    (p) => [`It's ${p.first}'s birthday today`, `Join us in wishing ${p.name} a great day and a brilliant year ahead.`],
    (p) => [`Happy birthday to ${p.first}!`, `Cake is optional, good wishes aren't. Have a lovely day, ${p.first}!`],
  ],
  anniversary: [
    (p) => [`${p.first} completes ${p.years} ${p.years === 1 ? 'year' : 'years'} with us today`, `Thank you, ${p.first}, for everything you bring to the team. Here's to many more!`],
    (p) => [`Happy work anniversary, ${p.first}!`, `${p.years} ${p.years === 1 ? 'year' : 'years'} with the team today. Thanks for all your hard work, ${p.first}.`],
  ],
  welcome: [
    (p) => [`Welcome ${p.name} to the team!`, `${p.first} joins us${p.role}. Say hello and help ${p.first} settle in.`],
    (p) => [`Say hello to ${p.name}`, `${p.first} is new here${p.role}. Make ${p.first} feel at home!`],
  ],
  holidayToday: [
    (h) => [`Happy ${h.name}!`, 'The office is closed today. Enjoy the day with your family and friends.'],
    (h) => [`Today is a holiday: ${h.name}`, 'No work today. Rest well, and see you on the next working day!'],
  ],
  holidaySoon: [
    (h) => [`${h.name} is ${h.when}`, `The office is closed on ${h.date}. Plan your work around it.`],
    (h) => [`Holiday coming up: ${h.name}`, `We're off on ${h.date}. Wrap up anything urgent before then.`],
  ],
};
const pick = (kind, key) => {
  const list = WORDING[kind];
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return list[h % list.length];
};
const dayLabel = (iso, opts) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });

async function autoAnnouncements(companyId, today) {
  const out = [];
  const add = (kind, id, emoji, [title, body]) => out.push({ id: `auto-${kind}-${id}`, auto: true, emoji, title, body, created_at: today });

  const holidays = await db.all(
    `SELECT id, name, to_char(date, 'YYYY-MM-DD') AS date FROM holidays WHERE company_id = ? AND date BETWEEN ? AND ? ORDER BY date`,
    [companyId, today, addDays(today, 7)]
  );
  for (const h of holidays) {
    if (h.date === today) add('holiday', h.id, '🎊', pick('holidayToday', `${h.id}${today}`)(h));
    else {
      const when = h.date === addDays(today, 1) ? 'tomorrow' : `on ${dayLabel(h.date, { weekday: 'long' })}`;
      add('holiday', h.id, '🌴', pick('holidaySoon', `${h.id}${today}`)({ ...h, when, date: dayLabel(h.date, { weekday: 'long', day: 'numeric', month: 'long' }) }));
    }
  }

  const people = await db.all(
    `SELECT u.id, u.name, u.designation, d.name AS department,
            to_char(u.birth_date, 'MM-DD') AS birthday, to_char(u.joined_on, 'YYYY-MM-DD') AS joined_on
     FROM users u LEFT JOIN departments d ON d.id = u.department_id
     WHERE u.company_id = ? AND u.status = 'active'`,
    [companyId]
  );
  const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const md = today.slice(5);
  const isToday = (mmdd) => mmdd === md || (mmdd === '02-29' && md === '02-28' && !leap(Number(today.slice(0, 4))));
  for (const u of people) {
    const p = { ...u, first: u.name.split(' ')[0] };
    if (u.birthday && isToday(u.birthday)) add('birthday', u.id, '🎂', pick('birthday', `${u.id}${today}`)(p));
    if (u.joined_on && u.joined_on < today && isToday(u.joined_on.slice(5))) {
      const years = Number(today.slice(0, 4)) - Number(u.joined_on.slice(0, 4));
      add('anniversary', u.id, '🎉', pick('anniversary', `${u.id}${today}`)({ ...p, years }));
    }
    if (u.joined_on && u.joined_on <= today && u.joined_on >= addDays(today, -6)) {
      const role = [u.designation && ` as ${u.designation}`, u.department && ` in ${u.department}`].filter(Boolean).join('');
      add('welcome', u.id, '👋', pick('welcome', `${u.id}`)({ ...p, role }));
    }
  }
  return out;
}

router.get('/announcements', async (req, res) => {
  const today = clock(req.user.timezone).date;
  const posted = await db.all(
    `SELECT a.id, a.title, a.body, a.expires_on, a.created_at, u.name AS author
     FROM announcements a LEFT JOIN users u ON u.id = a.created_by
     WHERE a.company_id = ? AND (a.expires_on IS NULL OR a.expires_on >= ?)
     ORDER BY a.id DESC LIMIT 20`,
    [req.user.company_id, today]
  );
  const on = (await getSettings(req.user.company_id)).auto_announcements !== '0';
  const auto = on ? await autoAnnouncements(req.user.company_id, today) : [];
  res.json({ items: [...auto, ...posted], auto: on });
});

/** Turns the automatic announcements on or off (on by default). HR can do this from the board itself. */
router.put('/announcements/auto', requireRole('admin', 'hr'), async (req, res) => {
  if (typeof req.body?.on !== 'boolean') return res.status(400).json({ error: 'Say on or off' });
  const value = req.body.on ? '1' : '0';
  await db.run(
    `INSERT INTO settings (company_id, key, value) VALUES (?, 'auto_announcements', ?)
     ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [req.user.company_id, value]
  );
  await audit(req, { area: 'settings', action: `turned ${req.body.on ? 'on' : 'off'} automatic announcements` });
  await emit(req.user, { type: 'announcement.auto', audience: 'all', data: { on: req.body.on } });
  res.json({ auto: req.body.on });
});

router.post('/announcements', requireRole('admin', 'hr'), async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const body = String(req.body?.body || '').trim().slice(0, 2000) || null;
  const expires = req.body?.expires_on || null;
  if (!title) return res.status(400).json({ error: 'Give the announcement a title' });
  if (title.length > 150) return res.status(400).json({ error: 'Keep the title under 150 characters' });
  if (expires && !isRealDate(expires)) return res.status(400).json({ error: 'Invalid date' });
  const row = await db.get(
    `INSERT INTO announcements (company_id, title, body, created_by, expires_on, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    [req.user.company_id, title, body, req.user.id, expires, clock(req.user.timezone).dateTime]
  );
  await emit(req.user, { type: 'announcement.posted', audience: 'all', notify: true, title: `📢 ${title}`, body, data: { id: row.id } });
  res.status(201).json(row);
});

router.delete('/announcements/:id', requireRole('admin', 'hr'), async (req, res) => {
  const gone = await db.get('DELETE FROM announcements WHERE id = ? AND company_id = ? RETURNING id',
    [/^\d{1,9}$/.test(req.params.id) ? Number(req.params.id) : 0, req.user.company_id]);
  if (!gone) return res.status(404).json({ error: 'Announcement not found' });
  await emit(req.user, { type: 'announcement.removed', audience: 'all', data: { id: gone.id } });
  res.json({ ok: true });
});

/** This year's (or next year's) date of a yearly event; 29 Feb falls on 28 Feb in other years. */
function nextOccurrence(date, today) {
  const md = date.slice(5);
  for (const year of [Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1]) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const day = `${year}-${md === '02-29' && !leap ? '02-28' : md}`;
    if (day >= today) return day;
  }
  return null;
}

/** Birthdays and work anniversaries in the next 14 days (today first). */
router.get('/celebrations', async (req, res) => {
  const today = clock(req.user.timezone).date;
  const until = addDays(today, 14);
  const people = await db.all(
    `SELECT u.id, u.name, u.designation, to_char(u.birth_date, 'YYYY-MM-DD') AS birth_date, to_char(u.joined_on, 'YYYY-MM-DD') AS joined_on
     FROM users u WHERE u.company_id = ? AND u.status = 'active' AND (u.birth_date IS NOT NULL OR u.joined_on IS NOT NULL)`,
    [req.user.company_id]
  );
  const out = [];
  for (const p of people) {
    if (p.birth_date) {
      const on = nextOccurrence(p.birth_date, today);
      if (on && on <= until) out.push({ user_id: p.id, name: p.name, designation: p.designation, kind: 'birthday', on });
    }
    if (p.joined_on && p.joined_on < today) {
      const on = nextOccurrence(p.joined_on, today);
      const years = on ? Number(on.slice(0, 4)) - Number(p.joined_on.slice(0, 4)) : 0;
      if (on && on <= until && years > 0) out.push({ user_id: p.id, name: p.name, designation: p.designation, kind: 'anniversary', years, on });
    }
  }
  out.sort((a, b) => a.on.localeCompare(b.on) || a.name.localeCompare(b.name));
  res.json({ today, items: out, canPost: isManager(req.user) });
});

export default router;
