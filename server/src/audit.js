import db from './db.js';
import { clock } from './utils.js';

/**
 * Activity history (Settings → Activity history): one line per change HR or an admin makes, with the person it
 * affected and the old → new values. Recording never fails the change itself.
 *
 *   area:    'employee' | 'attendance' | 'leave' | 'payroll' | 'settings' | 'org'
 *   action:  what happened, in words ("changed salary", "approved leave")
 *   target:  the employee it was about ({ id, name }), if any
 *   changes: { field: [before, after] } or any small details object
 */
export async function audit(req, { area, action, target = null, changes = null }) {
  try {
    await db.run(
      `INSERT INTO audit_log (company_id, actor_id, actor_name, target_user_id, target_name, area, action, changes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.company_id, req.user.id, req.user.name, target?.id ?? null, target?.name ?? null, area, action,
        changes && Object.keys(changes).length ? JSON.stringify(changes) : null, clock(req.user.timezone).dateTime]
    );
  } catch (err) {
    console.error('audit log failed', area, action, err.message);
  }
}

/** { field: [before, after] } for the fields whose value changed (secrets are never written). */
export function diff(before, after, fields = Object.keys(after)) {
  const out = {};
  for (const f of fields) {
    if (['password', 'password_hash', 'face_descriptors', 'google_sub', 'logo', 'recent_faces'].includes(f)) continue;
    const a = before?.[f] ?? null, b = after?.[f] ?? null;
    if (String(a) !== String(b)) out[f] = [a, b];
  }
  return out;
}
