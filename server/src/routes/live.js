import { Router } from 'express';
import db from '../db.js';
import { isManager } from '../auth.js';
import { VISIBLE_EVENTS } from '../events.js';

const router = Router();
const MAX_BATCH = 50;

const visible = (req) => [req.user.company_id, isManager(req.user), req.user.id];
// Notifications exclude the reader's own actions (you don't need a bell for leave you approved).
const NOTIFICATIONS = `${VISIBLE_EVENTS} AND notify AND actor_id IS DISTINCT FROM ?`;

async function unreadCount(req) {
  const { n } = await db.get(
    `SELECT COUNT(*) AS n FROM events WHERE ${NOTIFICATIONS}
     AND id > (SELECT notifications_seen_id FROM users WHERE id = ?)`,
    [...visible(req), req.user.id, req.user.id]
  );
  return n;
}

/**
 * Real-time pulse. Clients poll with the last event id they saw and get anything newer.
 * Without `since` it only returns the current cursor, so a fresh tab doesn't replay history.
 */
router.get('/live', async (req, res) => {
  // `since=0` is a valid cursor (a company with no events yet), so test for presence, not truthiness.
  const since = req.query.since === undefined ? NaN : Number(req.query.since);
  const latest = (await db.get('SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE company_id = ?', [req.user.company_id])).id;
  const events = Number.isFinite(since) && since >= 0
    ? await db.all(
        `SELECT id, type, actor_id, notify, title, body, data, created_at FROM events
         WHERE ${VISIBLE_EVENTS} AND id > ? ORDER BY id LIMIT ?`,
        [...visible(req), since, MAX_BATCH]
      )
    : [];
  res.set('Cache-Control', 'no-store');
  res.json({ cursor: events.length === MAX_BATCH ? events.at(-1).id : latest, events, unread: await unreadCount(req) });
});

router.get('/notifications', async (req, res) => {
  const { notifications_seen_id: seen } = await db.get('SELECT notifications_seen_id FROM users WHERE id = ?', [req.user.id]);
  const rows = await db.all(
    `SELECT id, type, title, body, created_at FROM events WHERE ${NOTIFICATIONS} ORDER BY id DESC LIMIT 30`,
    [...visible(req), req.user.id]
  );
  res.json({ items: rows.map((r) => ({ ...r, unread: r.id > seen })), unread: await unreadCount(req) });
});

router.post('/notifications/read', async (req, res) => {
  await db.run(
    `UPDATE users SET notifications_seen_id = GREATEST(notifications_seen_id,
       (SELECT COALESCE(MAX(id), 0) FROM events WHERE company_id = ?)) WHERE id = ?`,
    [req.user.company_id, req.user.id]
  );
  res.json({ ok: true, unread: 0 });
});

export default router;
