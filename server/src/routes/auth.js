import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import db, { tx, ensureDefaultSettings, isUniqueViolation } from '../db.js';
import { signToken, signPurpose, verifyPurpose, requireAuth, rateLimit, isProtectedDemoAccount } from '../auth.js';
import { cleanEmail, EMAIL_RE as EMAIL, mailer, sendMail, simpleEmail } from '../mail.js';
import { isValidTimeZone, logoError } from '../utils.js';

const router = Router();

export const PROFILE_SQL = `
  SELECT u.id, u.company_id, u.emp_code, u.name, u.email, u.role, u.designation, u.phone, u.joined_on, u.salary,
         u.status, u.birth_date, u.two_step, u.invited_at, (u.password_hash NOT LIKE '!google-only:%') AS has_password, u.department_id, u.geofence_id, d.name AS department, g.name AS geofence,
         u.reports_to, r.name AS reports_to_name,
         (SELECT COUNT(*) FROM users j WHERE j.reports_to = u.id AND j.status = 'active')::int AS juniors,
         (u.face_descriptors IS NOT NULL) AS face_enrolled,
         COALESCE(u.tracker_seen_at >= (now() AT TIME ZONE c.timezone) - interval '14 days', false) AS tracker_connected,
         COALESCE((SELECT s.value FROM settings s WHERE s.company_id = u.company_id AND s.key = 'tracker_prompt'), '1') AS tracker_prompt,
         c.name AS company_name, c.timezone, c.is_demo,
         CASE WHEN c.logo IS NULL THEN NULL ELSE c.logo_version END AS company_logo_v
  FROM users u
  JOIN companies c ON c.id = u.company_id
  LEFT JOIN departments d ON d.id = u.department_id
  LEFT JOIN geofences g ON g.id = u.geofence_id
  LEFT JOIN users r ON r.id = u.reports_to`;

export const getProfile = (id, companyId) =>
  companyId == null
    ? db.get(`${PROFILE_SQL} WHERE u.id = ?`, [id])
    : db.get(`${PROFILE_SQL} WHERE u.id = ? AND u.company_id = ?`, [id, companyId]);

// A whole office signs in from one internet address at 9:30, so the tight limit is per account (password guessing),
// with a looser one per address on top.
const loginPerAccount = rateLimit({ windowMs: 60_000, max: 10, key: (req) => String(req.body?.email || '').toLowerCase().trim() });
const loginPerAddress = rateLimit({ windowMs: 60_000, max: 300 });
router.post('/login', loginPerAddress, loginPerAccount, async (req, res) => {
  const { email, password } = req.body || {};
  const user = await db.get('SELECT * FROM users WHERE email = ?', [cleanEmail(email)]);
  if (!user || !(await bcrypt.compare(String(password || ''), user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (user.status === 'pending') return res.status(403).json({ error: 'Your request to join is waiting for HR approval. You can sign in once they approve it.' });
  if (user.status !== 'active') return res.status(403).json({ error: 'Account is inactive' });
  // Two-step sign-in: an admin who turned it on also needs the code we email, unless this device was remembered.
  if (user.two_step && user.role === 'admin' && verifyPurpose(req.body?.device, 'device') !== user.id) {
    try {
      await sendCode(user, 'login');
    } catch (err) {
      console.error('sign-in code email failed', user.id, err.message);
      return res.status(503).json({ error: "We couldn't email your sign-in code. Try again in a minute." });
    }
    return res.json({ twoStep: true, ticket: signPurpose('login', user.id, '10m'), email: maskEmail(user.email) });
  }
  res.json({ token: signToken(user), user: await getProfile(user.id) });
});

/* ---------- Two-step sign-in (admins): a 6-digit code by email ---------- */
const CODE_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;
const hashCode = (userId, code) => crypto.createHash('sha256').update(`${process.env.JWT_SECRET || 'crewline-dev-secret'}|${userId}|${code}`).digest('hex');
const maskEmail = (email) => email.replace(/^(.{2})[^@]*(@.*)$/, (_, a, b) => `${a}•••${b}`);

/** Emails a fresh code (replacing any earlier one for the same purpose). */
async function sendCode(user, purpose) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await db.run('DELETE FROM login_codes WHERE user_id = ? AND purpose = ?', [user.id, purpose]);
  await db.run(
    `INSERT INTO login_codes (user_id, purpose, code_hash, expires_at) VALUES (?, ?, ?, now() + make_interval(mins => ?))`,
    [user.id, purpose, hashCode(user.id, code), CODE_MINUTES]
  );
  const company = (await db.get('SELECT name FROM companies WHERE id = ?', [user.company_id]))?.name;
  const heading = purpose === 'login' ? 'Your Crewline sign-in code' : 'Confirm two-step sign-in';
  const { html, text } = simpleEmail({
    company, heading, code,
    lines: [`Enter this code in Crewline. It works for ${CODE_MINUTES} minutes.`, "If you didn't try to sign in, change your password: someone else knows it."],
  });
  await sendMail({ to: user.email, subject: `${code} is your Crewline code`, text, html });
}

/** True when the code matches; each wrong try counts, and a code is used once. */
async function checkCode(userId, purpose, code) {
  const row = await db.get(
    `UPDATE login_codes SET attempts = attempts + 1 WHERE user_id = ? AND purpose = ? AND expires_at > now() AND attempts < ? RETURNING id, code_hash`,
    [userId, purpose, MAX_CODE_ATTEMPTS]
  );
  if (!row) return false;
  const a = Buffer.from(row.code_hash);
  const b = Buffer.from(hashCode(userId, String(code || '').replace(/[^0-9]/g, '')));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  await db.run('DELETE FROM login_codes WHERE id = ?', [row.id]);
  return true;
}

router.post('/login/verify', rateLimit({ windowMs: 60_000, max: 20 }), async (req, res) => {
  const userId = verifyPurpose(req.body?.ticket, 'login');
  const user = userId && await db.get('SELECT * FROM users WHERE id = ? AND status = ?', [userId, 'active']);
  if (!user) return res.status(401).json({ error: 'This sign-in expired. Enter your password again.' });
  if (!(await checkCode(user.id, 'login', req.body?.code))) {
    return res.status(400).json({ error: 'That code is wrong or has expired' });
  }
  res.json({
    token: signToken(user), user: await getProfile(user.id),
    ...(req.body?.remember && { device: signPurpose('device', user.id, '30d') }),
  });
});

router.post('/login/resend', rateLimit({ windowMs: 60_000, max: 3 }), async (req, res) => {
  const userId = verifyPurpose(req.body?.ticket, 'login');
  const user = userId && await db.get('SELECT * FROM users WHERE id = ? AND status = ?', [userId, 'active']);
  if (!user) return res.status(401).json({ error: 'This sign-in expired. Enter your password again.' });
  try {
    await sendCode(user, 'login');
  } catch (err) {
    console.error('sign-in code email failed', user.id, err.message);
    return res.status(503).json({ error: "We couldn't email your sign-in code. Try again in a minute." });
  }
  res.json({ ok: true });
});

/** Profile: an admin turns it on by proving they receive the email, and off with their password. */
router.post('/two-step/start', requireAuth, rateLimit({ windowMs: 60_000, max: 3 }), async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Two-step sign-in is for admins' });
  if (!mailer()) return res.status(503).json({ error: 'Email is not set up on the server, so codes cannot be sent' });
  try {
    await sendCode(req.user, 'enable');
  } catch (err) {
    console.error('two-step code email failed', req.user.id, err.message);
    return res.status(503).json({ error: "We couldn't email the code. Try again in a minute." });
  }
  res.json({ email: maskEmail(req.user.email) });
});
router.post('/two-step/enable', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Two-step sign-in is for admins' });
  if (!(await checkCode(req.user.id, 'enable', req.body?.code))) return res.status(400).json({ error: 'That code is wrong or has expired' });
  await db.run('UPDATE users SET two_step = TRUE WHERE id = ?', [req.user.id]);
  res.json({ ok: true, device: signPurpose('device', req.user.id, '30d') });
});
router.post('/two-step/disable', requireAuth, async (req, res) => {
  const row = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!(await bcrypt.compare(String(req.body?.password || ''), row.password_hash))) {
    return res.status(400).json({ error: 'Password is incorrect' });
  }
  await db.run('UPDATE users SET two_step = FALSE WHERE id = ?', [req.user.id]);
  await db.run('DELETE FROM login_codes WHERE user_id = ?', [req.user.id]);
  res.json({ ok: true });
});

/** Self-service signup: creates an isolated company workspace and its first admin. */
/* ---------- Register a company: the admin's email is confirmed with a code before the workspace exists ---------- */

const REGISTER_CODE_MINUTES = 10;
// Stored in signup_codes under "register:<email>", so it never mixes with a staff sign-up code for the same address.
const registerKey = (email) => `register:${email}`;
const registerHash = (email, code) =>
  crypto.createHash('sha256').update(`${process.env.JWT_SECRET || 'crewline-dev-secret'}|register|${email}|${code}`).digest('hex');

/** The register form, checked the same way at both steps; returns the clean values or an error. */
function registerInput(body = {}) {
  const v = {
    company: String(body.company_name || '').trim(),
    name: String(body.name || '').trim(),
    email: cleanEmail(body.email),
    password: String(body.password || ''),
    timezone: String(body.timezone || 'Asia/Kolkata'),
    logo: body.logo ? String(body.logo) : null,
  };
  if (v.company.length < 2 || v.company.length > 80) return { error: 'Company name must be 2–80 characters' };
  if (v.name.length < 2) return { error: 'Please enter your full name' };
  if (!EMAIL.test(v.email)) return { error: 'Please enter a valid work email' };
  if (v.password.length < 8) return { error: 'Password must be at least 8 characters' };
  if (!isValidTimeZone(v.timezone)) return { error: 'Unknown timezone' };
  if (v.logo && logoError(v.logo)) return { error: logoError(v.logo) };
  return v;
}
const EXISTS = { error: 'An account with this email already exists. Sign in instead.' };

/** Step 1: check the form and email a code to the address, which proves the person owns it. */
router.post('/register/start', rateLimit({ windowMs: 60_000, max: 10 }), rateLimit({ windowMs: 60_000, max: 3, key: (req) => cleanEmail(req.body?.email) }), async (req, res) => {
  const v = registerInput(req.body);
  if (v.error) return res.status(400).json(v);
  if (await db.get('SELECT 1 FROM users WHERE email = ?', [v.email])) return res.status(409).json(EXISTS);
  if (!mailer()) return res.status(503).json({ error: 'Email is not set up on the server, so we cannot send a code' });
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await db.run(
    `INSERT INTO signup_codes (email, code_hash, attempts, expires_at) VALUES (?, ?, 0, now() + make_interval(mins => ?))
     ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, attempts = 0, expires_at = EXCLUDED.expires_at, created_at = now()`,
    [registerKey(v.email), registerHash(v.email, code), REGISTER_CODE_MINUTES]
  );
  const { html, text } = simpleEmail({
    company: v.company, heading: 'Confirm your email', code,
    lines: [`Enter this code in Crewline to create the ${v.company} workspace. It works for ${REGISTER_CODE_MINUTES} minutes.`,
      "If you didn't try to register, ignore this email; nothing is created without the code."],
  });
  try {
    await sendMail({ to: v.email, subject: `${code} is your Crewline code`, text, html });
  } catch (err) {
    console.error('register code email failed', v.email, err.message);
    return res.status(503).json({ error: "We couldn't email your code. Check the address and try again." });
  }
  res.json({ sent: true });
});

/** Step 2: the same form plus the emailed code creates the company and its admin. */
router.post('/register', rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
  const v = registerInput(req.body);
  if (v.error) return res.status(400).json(v);
  const row = await db.get(
    'UPDATE signup_codes SET attempts = attempts + 1 WHERE email = ? AND expires_at > now() AND attempts < 5 RETURNING code_hash',
    [registerKey(v.email)]
  );
  const given = registerHash(v.email, String(req.body?.code || '').replace(/\D/g, ''));
  if (!row || !crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(given))) {
    return res.status(400).json({ error: 'That code is wrong or has expired' });
  }
  try {
    const userId = await tx(async (t) => {
      const { id: companyId } = await t.get(
        'INSERT INTO companies (name, timezone, logo, logo_version) VALUES (?, ?, ?, ?) RETURNING id',
        [v.company, v.timezone, v.logo, v.logo ? 1 : 0]
      );
      await ensureDefaultSettings(t, companyId);
      const { id } = await t.get(
        `INSERT INTO users (company_id, emp_code, name, email, password_hash, role, designation, joined_on)
         VALUES (?, 'EMP001', ?, ?, ?, 'admin', 'Administrator', CURRENT_DATE) RETURNING id`,
        [companyId, v.name, v.email, await bcrypt.hash(v.password, 10)]
      );
      await t.run('DELETE FROM signup_codes WHERE email = ?', [registerKey(v.email)]);
      return id;
    });
    const profile = await getProfile(userId);
    res.status(201).json({ token: signToken(profile), user: profile });
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json(EXISTS);
    throw err;
  }
});

router.get('/me', requireAuth, async (req, res) => {
  res.json(await getProfile(req.user.id));
});

router.post('/change-password', requireAuth, async (req, res) => {
  if (isProtectedDemoAccount(req.user.is_demo, req.user.email)) {
    return res.status(403).json({ error: 'Demo account passwords are fixed so everyone can sign in. Register your own company to change it.' });
  }
  const { current, next } = req.body || {};
  const row = await db.get('SELECT password_hash, token_version FROM users WHERE id = ?', [req.user.id]);
  // People who joined with Google never had a password, so they can set one without a current password.
  const googleOnly = String(row.password_hash).startsWith('!google-only:');
  if (!googleOnly && !(await bcrypt.compare(String(current || ''), row.password_hash))) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  if (!next || String(next).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  // Other sessions end; this one gets a fresh token below.
  const updated = await db.get(
    'UPDATE users SET password_hash = ?, invited_at = NULL, token_version = token_version + 1 WHERE id = ? RETURNING id, company_id, role, token_version',
    [await bcrypt.hash(String(next), 10), req.user.id]
  );
  res.json({ ok: true, token: signToken(updated) });
});

export default router;
