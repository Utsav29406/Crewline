import { Router } from 'express';
import { cleanEmail, EMAIL_RE } from '../mail.js';
import bcrypt from 'bcryptjs';
import db, { isUniqueViolation, tx } from '../db.js';
import { audit, diff } from '../audit.js';
import { requireRole, isManager, isProtectedDemoAccount } from '../auth.js';
import { emit } from '../events.js';
import { removeFiles } from '../blobs.js';
import { clock, faceSamplesError } from '../utils.js';

const clockDate = (tz) => clock(tz).date;
import { PROFILE_SQL, getProfile } from './auth.js';
import { sendInvite } from './join.js';
import crypto from 'node:crypto';
import { mailer, sendMail, simpleEmail } from '../mail.js';

const router = Router();
const MIN_FACE_SAMPLES = 3;
const MAX_FACE_SAMPLES = 5;
const DUPLICATE = { error: 'Email or employee code already exists' };
const BAD_EMAIL = { error: 'Enter a full email address, like name@company.com' };
const BAD_STATUS = { error: 'Status must be active or inactive' };
const APP_URL = process.env.APP_URL || 'https://getcrewline.vercel.app';
const DEMO_LOCKED = { error: 'Demo accounts can’t be renamed, deactivated or deleted so everyone can keep using them. Register your own company for full control.' };

// Audience 'all' so the affected employee's own session refreshes too (payload is just the id).
const changed = (req, id) => emit(req.user, { type: 'employee.changed', audience: 'all', data: { id } });

router.get('/', requireRole('admin', 'hr'), async (req, res) => {
  const q = `%${req.query.q || ''}%`;
  const params = [req.user.company_id, q, q, q];
  let sql = `${PROFILE_SQL} WHERE u.company_id = ? AND (u.name ILIKE ? OR u.email ILIKE ? OR COALESCE(u.emp_code, '') ILIKE ?)`;
  if (req.query.department_id) {
    sql += ' AND u.department_id = ?';
    params.push(Number(req.query.department_id));
  }
  res.json(await db.all(`${sql} ORDER BY u.name`, params));
});

router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!isManager(req.user) && req.user.id !== id) return res.status(403).json({ error: 'Forbidden' });
  const emp = await getProfile(id, req.user.company_id);
  if (!emp) return res.status(404).json({ error: 'Employee not found' });
  res.json(emp);
});

const FIELDS = ['emp_code', 'name', 'email', 'role', 'department_id', 'geofence_id', 'designation', 'phone', 'joined_on', 'salary', 'status', 'reports_to', 'birth_date'];

function pickFields(body) {
  const out = {};
  for (const f of FIELDS) if (body[f] !== undefined) out[f] = body[f] === '' ? null : body[f];
  if (out.email) out.email = cleanEmail(out.email);
  if (out.salary === null) out.salary = 0;
  return out;
}

/** Department, geofence and senior ids must belong to the caller's company. */
async function foreignKeysOk(data, companyId) {
  if (data.department_id && !(await db.get('SELECT 1 FROM departments WHERE id = ? AND company_id = ?', [data.department_id, companyId]))) return false;
  if (data.geofence_id && !(await db.get('SELECT 1 FROM geofences WHERE id = ? AND company_id = ?', [data.geofence_id, companyId]))) return false;
  if (data.reports_to && !(await db.get('SELECT 1 FROM users WHERE id = ? AND company_id = ?', [data.reports_to, companyId]))) return false;
  return true;
}

/** Someone can't report to themselves, or to anyone who (directly or further down) reports to them. */
async function reportingLoop(id, seniorId) {
  for (let cur = seniorId, hops = 0; cur && hops < 50; hops++) {
    if (Number(cur) === Number(id)) return true;
    cur = (await db.get('SELECT reports_to FROM users WHERE id = ?', [cur]))?.reports_to;
  }
  return false;
}

// What the activity history compares on an edit (names, not ids, so it reads well).
const AUDITED = ['name', 'email', 'emp_code', 'role', 'status', 'salary', 'department', 'designation', 'geofence', 'reports_to_name', 'phone', 'joined_on', 'birth_date'];
const who = (p) => ({ id: p.id, name: p.name });

const NEEDS_ADMIN = { error: 'The company needs at least one active admin' };

/**
 * Runs `write` only if the company still has another active admin besides `userId` afterwards. A per-company lock
 * makes two admins removing each other at the same moment take turns, so the second one sees the first change.
 * Returns false (and writes nothing) when `userId` is the last active admin.
 */
async function keepingAnAdmin(companyId, userId, write) {
  return tx(async (t) => {
    await t.run('SELECT pg_advisory_xact_lock(7311, ?::int)', [companyId]);
    const { n } = await t.get(
      `SELECT COUNT(*)::int AS n FROM users WHERE company_id = ? AND role = 'admin' AND status = 'active' AND id <> ?`,
      [companyId, userId]
    );
    if (!n) return false;
    await write(t);
    return true;
  });
}

const SHORT_PASSWORD = { error: 'Passwords must be at least 8 characters' };

router.post('/', requireRole('admin', 'hr'), async (req, res) => {
  const data = pickFields(req.body || {});
  if (!data.name || !data.email) return res.status(400).json({ error: 'Name and email are required' });
  if (!EMAIL_RE.test(data.email)) return res.status(400).json(BAD_EMAIL);
  if (data.status && !['active', 'inactive'].includes(data.status)) return res.status(400).json(BAD_STATUS);
  if (data.role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can create admins' });
  if (!(await foreignKeysOk(data, req.user.company_id))) return res.status(400).json({ error: 'Unknown department, geofence or senior' });
  // Invite: nobody knows the starting password; the person chooses one from the emailed link.
  const invite = Boolean(req.body.invite);
  if (invite && !mailer()) return res.status(503).json({ error: 'Email is not set up on the server, so invites cannot be sent' });
  if (!invite && req.body.password && String(req.body.password).length < 8) return res.status(400).json(SHORT_PASSWORD);
  const password = invite ? crypto.randomBytes(24).toString('hex') : req.body.password || 'welcome123';
  data.company_id = req.user.company_id;
  if (invite) data.status = 'active';
  const cols = [...Object.keys(data), 'password_hash', ...(invite ? ['invited_at'] : [])];
  try {
    const { id } = await db.get(
      `INSERT INTO users (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING id`,
      [...Object.values(data), await bcrypt.hash(String(password), 10), ...(invite ? [new Date()] : [])]
    );
    if (invite) {
      const user = await db.get('SELECT u.*, c.name AS company FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ?', [id]);
      try {
        await sendInvite(user, user.company, req.user.name);
      } catch (err) {
        // No half-made accounts: without the email nobody could sign in to it.
        console.error('invite email failed', data.email, err.message);
        await db.run('DELETE FROM users WHERE id = ?', [id]);
        return res.status(502).json({ error: `We couldn't email ${data.email}. Check the address and try again.` });
      }
    }
    await changed(req, id);
    const created = await getProfile(id, req.user.company_id);
    await audit(req, { area: 'employee', action: invite ? 'added and invited employee' : 'added employee', target: who(created),
      changes: diff({}, created, ['email', 'role', 'salary', 'department', 'designation']) });
    res.status(201).json(created);
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json(DUPLICATE);
    throw err;
  }
});

router.put('/:id', requireRole('admin', 'hr'), async (req, res) => {
  const id = Number(req.params.id);
  const target = await db.get('SELECT email, role, status FROM users WHERE id = ? AND company_id = ?', [id, req.user.company_id]);
  if (!target) return res.status(404).json({ error: 'Employee not found' });
  const before = await getProfile(id, req.user.company_id);
  const data = pickFields(req.body || {});
  if (data.status && !['active', 'inactive'].includes(data.status)) return res.status(400).json(BAD_STATUS);
  if (target.status === 'pending' && data.status) return res.status(400).json({ error: 'Approve or reject this sign-up first' });
  if (data.email === null || (data.email !== undefined && !EMAIL_RE.test(data.email))) return res.status(400).json(BAD_EMAIL);
  if (data.role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can grant admin' });
  // HR could otherwise reset an admin's password or email and sign in as them.
  if (target.role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can edit an admin' });
  // Same for one HR user and another HR user's sign-in details.
  const changesLogin = (data.email !== undefined && String(data.email).toLowerCase() !== target.email) || req.body.password;
  // Role and status too: otherwise HR could demote another HR user first and then reset their password.
  const changesAccess = (data.role && data.role !== target.role) || (data.status && data.status !== target.status);
  if (target.role === 'hr' && req.user.role !== 'admin' && id !== req.user.id && (changesLogin || changesAccess)) {
    return res.status(403).json({ error: "Only an admin can change another HR user's email, password, role or status" });
  }
  if (req.body.password && String(req.body.password).length < 8) return res.status(400).json(SHORT_PASSWORD);
  const losesAdmin = target.role === 'admin' && target.status === 'active'
    && ((data.role && data.role !== 'admin') || (data.status && data.status !== 'active'));
  // (Checked for real, under a lock, when the change is written below.)
  if (!(await foreignKeysOk(data, req.user.company_id))) return res.status(400).json({ error: 'Unknown department, geofence or senior' });
  if (data.reports_to && (await reportingLoop(id, data.reports_to))) {
    return res.status(400).json({ error: "Someone can't report to themselves or to one of their own juniors" });
  }
  if (isProtectedDemoAccount(req.user.is_demo, target.email)) {
    // Keep the demo logins usable: identity, role, status and password are fixed.
    for (const k of ['email', 'role', 'status']) delete data[k];
    if (req.body.password) return res.status(403).json(DEMO_LOCKED);
  }
  // A new email is a new sign-in identity: drop the linked Google account so it's matched again by the new address.
  // It also ends their current sessions (token_version).
  const emailChanged = Boolean(data.email && data.email !== target.email);
  if (emailChanged) Object.assign(data, { google_sub: null });
  const keys = Object.keys(data);
  if (keys.length) {
    const update = (runner) => runner.run(
      `UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')}${emailChanged ? ', token_version = token_version + 1' : ''} WHERE id = ? AND company_id = ?`,
      [...Object.values(data), id, req.user.company_id]
    );
    try {
      if (losesAdmin) {
        if (!(await keepingAnAdmin(req.user.company_id, id, update))) return res.status(400).json(NEEDS_ADMIN);
      } else {
        await update(db);
      }
    } catch (err) {
      if (isUniqueViolation(err)) return res.status(409).json(DUPLICATE);
      throw err;
    }
  }
  if (req.body.password) {
    // A reset password signs them out everywhere (e.g. after a lost phone).
    await db.run('UPDATE users SET password_hash = ?, invited_at = NULL, token_version = token_version + 1 WHERE id = ? AND company_id = ?', [await bcrypt.hash(String(req.body.password), 10), id, req.user.company_id]);
  }
  await changed(req, id);
  const after = await getProfile(id, req.user.company_id);
  const changes = diff(before, after, AUDITED);
  if (req.body.password) changes.password = ['—', 'reset by HR'];
  if (Object.keys(changes).length) {
    const what = Object.keys(changes).map((k) => ({ reports_to_name: 'reports to', joined_on: 'joining date', birth_date: 'birthday', emp_code: 'employee code', geofence: 'work location' })[k] || k);
    await audit(req, { area: 'employee', action: `changed ${what.join(', ')}`, target: who(after), changes });
  }
  res.json(after);
});

/** Sign-ups by company email wait here until HR lets them in. */
router.post('/:id/approve', requireRole('admin', 'hr'), async (req, res) => {
  const id = Number(req.params.id);
  const user = await db.get(
    `UPDATE users SET status = 'active', joined_on = COALESCE(joined_on, ?::date) WHERE id = ? AND company_id = ? AND status = 'pending'
     RETURNING id, name, email`,
    [clockDate(req.user.timezone), id, req.user.company_id]
  );
  if (!user) return res.status(404).json({ error: 'This sign-up was already handled' });
  await changed(req, id);
  await audit(req, { area: 'employee', action: 'approved sign-up', target: who(user), changes: { email: [null, user.email] } });
  // They proved they own this address when signing up, so it's safe to email.
  if (mailer()) {
    const company = (await db.get('SELECT name FROM companies WHERE id = ?', [req.user.company_id]))?.name;
    const { html, text } = simpleEmail({
      company, heading: "You're in!",
      lines: [`Hi ${user.name}, HR approved your request to join. You can sign in to Crewline now.`],
      button: { label: 'Sign in', url: APP_URL },
    });
    await sendMail({ to: user.email, subject: 'Your Crewline account is approved', text, html }).catch((err) => console.error('approval email failed', user.email, err.message));
  }
  res.json(await getProfile(id, req.user.company_id));
});

router.post('/:id/reject', requireRole('admin', 'hr'), async (req, res) => {
  const gone = await db.get(`DELETE FROM users WHERE id = ? AND company_id = ? AND status = 'pending' RETURNING id, name, email`, [Number(req.params.id), req.user.company_id]);
  if (!gone) return res.status(404).json({ error: 'This sign-up was already handled' });
  await audit(req, { area: 'employee', action: 'rejected sign-up', target: { id: null, name: gone.name }, changes: { email: [gone.email, null] } });
  await changed(req, gone.id);
  res.json({ ok: true });
});

/** Emails a fresh invite to someone who hasn't set their password yet. */
router.post('/:id/invite', requireRole('admin', 'hr'), async (req, res) => {
  const user = await db.get(
    `SELECT u.*, c.name AS company FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ? AND u.company_id = ? AND u.status = 'active'`,
    [Number(req.params.id), req.user.company_id]
  );
  if (!user) return res.status(404).json({ error: 'Employee not found' });
  if (!user.invited_at) return res.status(400).json({ error: 'This person already set their password' });
  if (user.role === 'admin' && req.user.role !== 'admin') return res.status(403).json({ error: 'Only an admin can invite an admin' });
  // A new invite time first: the link carries it, so earlier links (e.g. sent to a mistyped address) stop working.
  const fresh = await db.get('UPDATE users SET invited_at = now() WHERE id = ? RETURNING invited_at', [user.id]);
  user.invited_at = fresh.invited_at;
  try {
    await sendInvite(user, user.company, req.user.name);
  } catch (err) {
    console.error('invite email failed', user.email, err.message);
    return res.status(502).json({ error: `We couldn't email ${user.email}. Check the address and try again.` });
  }
  res.json({ ok: true });
});

router.delete('/:id', requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  const target = await db.get('SELECT name, email, role, status FROM users WHERE id = ? AND company_id = ?', [id, req.user.company_id]);
  if (!target) return res.status(404).json({ error: 'Employee not found' });
  if (isProtectedDemoAccount(req.user.is_demo, target.email)) return res.status(403).json(DEMO_LOCKED);
  // Their files go with them: documents, screenshots, and files on tasks assigned to them.
  const files = await db.all(
    `SELECT blob_path FROM documents WHERE user_id = ?
     UNION ALL SELECT blob_path FROM screenshots WHERE user_id = ?
     UNION ALL SELECT c.blob_path FROM task_comments c JOIN tasks t ON t.id = c.task_id WHERE t.assignee_id = ? AND c.blob_path IS NOT NULL`,
    [id, id, id]
  );
  const remove = (runner) => runner.run('DELETE FROM users WHERE id = ? AND company_id = ?', [id, req.user.company_id]);
  // Two admins deleting each other at once would otherwise leave nobody in charge.
  if (target.role === 'admin' && target.status === 'active') {
    if (!(await keepingAnAdmin(req.user.company_id, id, remove))) return res.status(400).json(NEEDS_ADMIN);
  } else {
    await remove(db);
  }
  await removeFiles(files.map((f) => f.blob_path));
  await audit(req, { area: 'employee', action: 'deleted employee', target: { id: null, name: target.name }, changes: { email: [target.email, null], role: [target.role, null] } });
  await changed(req, id);
  res.json({ ok: true });
});

/**
 * Enroll face samples. Employees may enroll themselves once (re-enrolling needs HR),
 * except in the demo company where anyone may re-enroll so every visitor can try it.
 */
router.post('/:id/face', async (req, res) => {
  const id = Number(req.params.id);
  const { descriptors } = req.body || {};
  const existing = await db.get('SELECT face_descriptors FROM users WHERE id = ? AND company_id = ?', [id, req.user.company_id]);
  if (!existing) return res.status(404).json({ error: 'Employee not found' });
  const self = req.user.id === id;
  if (!isManager(req.user) && !(self && (!existing.face_descriptors || req.user.is_demo))) {
    return res.status(403).json({ error: 'Face already enrolled. Ask HR to reset it.' });
  }
  // Several scans of one person, so a single bad frame (or someone else's face) can't become the reference.
  const bad = faceSamplesError(descriptors, MIN_FACE_SAMPLES, MAX_FACE_SAMPLES);
  if (bad) return res.status(400).json({ error: bad });
  const samples = descriptors;
  await db.run('UPDATE users SET face_descriptors = ? WHERE id = ? AND company_id = ?', [JSON.stringify(samples), id, req.user.company_id]);
  await changed(req, id);
  res.json({ ok: true, samples: samples.length });
});

router.delete('/:id/face', requireRole('admin', 'hr'), async (req, res) => {
  const person = await db.get('UPDATE users SET face_descriptors = NULL, recent_faces = NULL WHERE id = ? AND company_id = ? RETURNING id, name', [Number(req.params.id), req.user.company_id]);
  if (!person) return res.status(404).json({ error: 'Employee not found' });
  await changed(req, person.id);
  await audit(req, { area: 'employee', action: 'removed face enrollment', target: person });
  res.json({ ok: true });
});

export default router;
