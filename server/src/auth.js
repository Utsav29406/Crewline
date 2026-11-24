import jwt from 'jsonwebtoken';
import db from './db.js';

const SECRET = process.env.JWT_SECRET || 'crewline-dev-secret';

/** How long a sign-in can be kept alive by renewing it (the desktop tracker renews daily); then sign in again. */
export const MAX_SESSION_DAYS = 30;
const DAY = 24 * 3600;

/**
 * A session token. `ses` is when the person actually signed in; a renewed token keeps it, so renewing can never
 * stretch a sign-in past MAX_SESSION_DAYS.
 */
export function signToken(user, { ses = Math.floor(Date.now() / 1000) } = {}) {
  const left = ses + MAX_SESSION_DAYS * DAY - Math.floor(Date.now() / 1000);
  const expiresIn = Math.max(Math.min(7 * DAY, left), 60);
  return jwt.sign({ id: user.id, cid: user.company_id, role: user.role, tv: user.token_version || 0, ses }, SECRET, { expiresIn });
}

/**
 * Short-lived tokens for one job (the two-step sign-in ticket, a remembered device). They carry `uid`, never `id`,
 * and a `purpose`, so requireAuth never accepts one as a session.
 */
export const signPurpose = (purpose, uid, expiresIn) => jwt.sign({ purpose, uid }, SECRET, { expiresIn });
export function verifyPurpose(token, purpose) {
  try {
    const p = jwt.verify(String(token || ''), SECRET);
    return p.purpose === purpose && p.uid ? p.uid : null;
  } catch {
    return null;
  }
}

/** Signed short-lived data (e.g. the Google sign-in state cookie); `kind` keeps one kind from passing as another. */
export const signData = (kind, data, expiresIn) => jwt.sign({ kind, data }, SECRET, { expiresIn });
export function verifyData(token, kind) {
  try {
    const p = jwt.verify(String(token || ''), SECRET);
    return p.kind === kind ? p.data : null;
  } catch {
    return null;
  }
}

/** Loads the user and their company; every route below scopes its queries by req.user.company_id. */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  if (payload.purpose || !payload.id) return res.status(401).json({ error: 'Invalid or expired session' });
  const user = await db.get(
    `SELECT u.id, u.name, u.email, u.role, u.status, u.company_id, u.token_version, c.timezone, c.is_demo
     FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = ?`,
    [payload.id]
  );
  if (!user || user.status !== 'active') return res.status(401).json({ error: 'Account inactive' });
  // A password or email change since this token was issued ends the session.
  if ((payload.tv || 0) !== (user.token_version || 0)) return res.status(401).json({ error: 'Your password or email changed. Please sign in again.' });
  req.user = user;
  // Tokens from before `ses` existed count from their issue time.
  req.sessionStart = payload.ses || payload.iat;
  next();
}

export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden' });

export const isManager = (user) => user.role === 'admin' || user.role === 'hr';

// The seeded demo logins must keep working for every visitor.
const DEMO_EMAILS = new Set(['admin@crewline.io', 'hr@crewline.io', 'arjun@crewline.io', 'sara@crewline.io', 'dev@crewline.io', 'neha@crewline.io']);
export const isProtectedDemoAccount = (companyIsDemo, email) => Boolean(companyIsDemo) && DEMO_EMAILS.has(email);

/**
 * Small fixed-window limiter for login/signup. In-memory, so per server instance —
 * enough to blunt casual brute force; put a WAF or Redis limiter in front for more.
 */
export function rateLimit({ windowMs, max, key: keyOf = () => '' }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = `${req.ip}|${req.path}|${keyOf(req)}`;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) hits.set(key, { start: now, count: 1 });
    else if (++entry.count > max) return res.status(429).json({ error: 'Too many attempts. Please wait a minute and try again.' });
    if (hits.size > 5000) {
      // Drop finished windows first, then the oldest entries; clearing everything would reset a targeted account's count.
      for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
      for (const k of hits.keys()) { if (hits.size <= 4000) break; hits.delete(k); }
    }
    next();
  };
}
