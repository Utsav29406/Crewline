import { Router } from 'express';
import db from '../db.js';
import { isManager, requireRole } from '../auth.js';
import { emit } from '../events.js';
import { addDays, clock, isRealDate } from '../utils.js';

/** Notice board (admin/HR post, everyone reads) and the dashboard's birthdays and work anniversaries. */
const router = Router();

router.get('/announcements', async (req, res) => {
  const today = clock(req.user.timezone).date;
  res.json(await db.all(
    `SELECT a.id, a.title, a.body, a.expires_on, a.created_at, u.name AS author
     FROM announcements a LEFT JOIN users u ON u.id = a.created_by
     WHERE a.company_id = ? AND (a.expires_on IS NULL OR a.expires_on >= ?)
     ORDER BY a.id DESC LIMIT 20`,
    [req.user.company_id, today]
  ));
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
