import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import db, { isUniqueViolation } from '../db.js';
import { rateLimit, signData, signToken, verifyData } from '../auth.js';
import { cleanEmail, EMAIL_RE, mailer, sendMail, simpleEmail } from '../mail.js';
import { emit } from '../events.js';
import { companyForJoinCode, companyToJoin, domainOf } from '../join.js';
import { getProfile } from './auth.js';

/**
 * Two ways in for staff, besides HR typing them in:
 *  1. Sign up (/join or /join/<code>): the company turned on its email domain, or HR shared its join link (any email,
 *     Gmail included). The person proves they own the address with an emailed code (or Google), and waits as
 *     `pending` until HR approves.
 *  2. An HR invite (/invite?token=…): HR created the employee and emailed them a link to choose a password.
 */
const router = Router();

const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const APP_URL = process.env.APP_URL || 'https://getcrewline.vercel.app';
const hash = (email, code) => crypto.createHash('sha256').update(`${process.env.JWT_SECRET || 'crewline-dev-secret'}|signup|${email}|${code}`).digest('hex');
const passwordError = (p) => (String(p || '').length < 8 ? 'Choose a password of at least 8 characters' : null);

/** Tells HR someone is waiting; shared with Google sign-up. */
export async function announceJoinRequest(user, company) {
  await emit({ id: user.id, company_id: company.id, timezone: company.timezone }, {
    type: 'employee.join_requested', notify: true, title: `${user.name} wants to join`,
    body: `${user.email} asked to join. Approve or reject them in Employees.`, data: { userId: user.id },
  });
}

/** The join link's page shows which company it's for. */
router.get('/join/link/:code', rateLimit({ windowMs: 60_000, max: 30 }), async (req, res) => {
  const company = await companyForJoinCode(req.params.code);
  if (!company) return res.status(404).json({ error: 'This join link is no longer active. Ask HR for a new one.' });
  res.json({ company: company.name });
});

/** Step 1: check the domain (or join link) and email a code. */
router.post('/join/start', rateLimit({ windowMs: 60_000, max: 20 }), rateLimit({ windowMs: 60_000, max: 3, key: (req) => cleanEmail(req.body?.email) }), async (req, res) => {
  const email = cleanEmail(req.body?.email);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter your full work email, like name@company.com' });
  const link = req.body?.link ? String(req.body.link) : '';
  const company = await companyToJoin(email, link);
  if (!company) {
    return res.status(404).json({
      error: link
        ? 'This join link is no longer active. Ask HR for a new one.'
        : `No company on Crewline accepts sign-ups from @${domainOf(email)}. Ask HR for your company's join link, or to invite you.`,
    });
  }
  const existing = await db.get('SELECT status FROM users WHERE email = ?', [email]);
  if (existing?.status === 'pending') return res.status(409).json({ error: 'You already asked to join. HR will approve you soon.' });
  if (existing) return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
  if (!mailer()) return res.status(503).json({ error: 'Email is not set up on the server, so we cannot send a code' });

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await db.run(
    `INSERT INTO signup_codes (email, code_hash, attempts, expires_at) VALUES (?, ?, 0, now() + make_interval(mins => ?))
     ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, attempts = 0, expires_at = EXCLUDED.expires_at, created_at = now()`,
    [email, hash(email, code), CODE_MINUTES]
  );
  const { html, text } = simpleEmail({
    company: company.name, heading: 'Confirm your email', code,
    lines: [`Enter this code in Crewline to ask to join ${company.name}. It works for ${CODE_MINUTES} minutes.`, "If you didn't ask for it, ignore this email."],
  });
  try {
    await sendMail({ to: email, subject: `${code} is your Crewline code`, text, html });
  } catch (err) {
    console.error('sign-up code email failed', email, err.message);
    return res.status(503).json({ error: "We couldn't email your code. Check the address and try again." });
  }
  res.json({ company: company.name });
});

/** Step 2: the code, name and password → a pending account. */
router.post('/join/finish', rateLimit({ windowMs: 60_000, max: 20 }), async (req, res) => {
  const email = cleanEmail(req.body?.email);
  const name = String(req.body?.name || '').trim();
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Enter your full name' });
  const pwErr = passwordError(req.body?.password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const row = await db.get(
    `UPDATE signup_codes SET attempts = attempts + 1 WHERE email = ? AND expires_at > now() AND attempts < ? RETURNING code_hash`,
    [email, MAX_ATTEMPTS]
  );
  const given = hash(email, String(req.body?.code || '').replace(/\D/g, ''));
  if (!row || !crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(given))) {
    return res.status(400).json({ error: 'That code is wrong or has expired' });
  }
  const company = await companyToJoin(email, req.body?.link ? String(req.body.link) : '');
  if (!company) return res.status(404).json({ error: 'Your company turned off sign-up. Ask HR to add you.' });
  try {
    const user = await db.get(
      `INSERT INTO users (company_id, name, email, password_hash, role, status) VALUES (?, ?, ?, ?, 'employee', 'pending') RETURNING id, name, email`,
      [company.id, name, email, await bcrypt.hash(String(req.body.password), 10)]
    );
    await db.run('DELETE FROM signup_codes WHERE email = ?', [email]);
    await announceJoinRequest(user, company);
    res.status(201).json({ pending: true, company: company.name });
  } catch (err) {
    if (isUniqueViolation(err)) return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
    throw err;
  }
});

/* ---------- HR invites ---------- */

/**
 * The token carries a fingerprint of the password, email and invite time, so the link stops working once a password
 * is set, the email is corrected, or a newer invite is sent.
 */
const fingerprint = (user) => crypto.createHash('sha256')
  .update(`${user.password_hash}|${user.email}|${user.invited_at ? new Date(user.invited_at).getTime() : ''}`).digest('hex').slice(0, 16);
export const inviteToken = (user) => signData('invite', { uid: user.id, fp: fingerprint(user) }, '7d');

/** Emails an invite; throws when it can't be sent. */
export async function sendInvite(user, company, invitedBy) {
  const link = `${APP_URL}/invite?token=${encodeURIComponent(inviteToken(user))}`;
  const { html, text } = simpleEmail({
    company, heading: `You're invited to ${company} on Crewline`,
    lines: [`${invitedBy} added you to ${company}. Choose a password to start using Crewline for attendance, leave and tasks.`,
      'This link works for 7 days. You can also use “Continue with Google” on the sign-in page with this email.'],
    button: { label: 'Set your password', url: link },
  });
  await sendMail({ to: user.email, subject: `You're invited to ${company} on Crewline`, text, html });
}

async function invitedUser(token) {
  const data = verifyData(token, 'invite');
  if (!data?.uid) return null;
  const user = await db.get(
    `SELECT u.*, c.name AS company FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ? AND u.status = 'active' AND u.invited_at IS NOT NULL`,
    [data.uid]
  );
  return user && fingerprint(user) === data.fp ? user : null;
}

const EXPIRED = { error: 'This invite link has expired or was already used. Sign in, or ask HR to send a new invite.' };

router.get('/invite', rateLimit({ windowMs: 60_000, max: 30 }), async (req, res) => {
  const user = await invitedUser(req.query.token);
  if (!user) return res.status(410).json(EXPIRED);
  res.json({ name: user.name, email: user.email, company: user.company });
});

router.post('/invite', rateLimit({ windowMs: 60_000, max: 20 }), async (req, res) => {
  const user = await invitedUser(req.body?.token);
  if (!user) return res.status(410).json(EXPIRED);
  const pwErr = passwordError(req.body?.password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  const changed = await db.get(
    'UPDATE users SET password_hash = ?, invited_at = NULL WHERE id = ? AND password_hash = ? RETURNING id',
    [await bcrypt.hash(String(req.body.password), 10), user.id, user.password_hash]
  );
  if (!changed) return res.status(410).json(EXPIRED);
  res.json({ token: signToken(user), user: await getProfile(user.id) });
});

export default router;
