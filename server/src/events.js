import db, { getSettings } from './db.js';
import { clock } from './utils.js';
import { mailer, sendMail, simpleEmail } from './mail.js';

const APP_URL = process.env.APP_URL || 'https://getcrewline.vercel.app';

/** A notification meant for one person also goes to their email when the company has that turned on. */
async function emailNotification(companyId, userId, title, body) {
  if (!mailer() || (await getSettings(companyId)).email_notifications !== '1') return;
  const u = await db.get(
    `SELECT u.email, u.name, c.name AS company FROM users u JOIN companies c ON c.id = u.company_id
     WHERE u.id = ? AND u.company_id = ? AND u.status = 'active'`,
    [userId, companyId]
  );
  if (!u?.email) return;
  const { html, text } = simpleEmail({ company: u.company, heading: title, lines: body ? [body] : [], button: { label: 'Open Crewline', url: APP_URL } });
  await sendMail({ to: u.email, subject: title, text, html });
}

const RETENTION_DAYS = 30;

/**
 * Publishes a real-time event to a company's feed.
 *  audience: 'managers' (admins + HR), 'user' (only userId), or 'all'
 *  notify:   true shows it in the bell and as a toast; false only refreshes open screens
 *  email:    false skips the optional notification email (when the caller sends its own, e.g. payslips)
 */
export async function emit(actor, { type, audience = 'managers', userId = null, notify = false, title = null, body = null, data = null, email = true }) {
  await db.run(
    `INSERT INTO events (company_id, type, audience, user_id, actor_id, notify, title, body, data, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [actor.company_id, type, audience, userId, actor.id, notify, title, body, data && JSON.stringify(data), clock(actor.timezone).dateTime]
  );
  if (email && notify && audience === 'user' && userId && title) {
    await emailNotification(actor.company_id, userId, title, body)
      .catch((err) => console.error('notification email failed', userId, err.message)); // the in-app one already went out
  }
  if (Math.random() < 0.01) {
    await db.run(`DELETE FROM events WHERE created_at < now() - make_interval(days => ?)`, [RETENTION_DAYS]);
  }
}

/** SQL fragment: events in the caller's company that the caller is allowed to see. Params: company_id, isManager, userId. */
export const VISIBLE_EVENTS = `company_id = ? AND (audience = 'all' OR (audience = 'managers' AND ?::boolean) OR (audience = 'user' AND user_id = ?))`;
