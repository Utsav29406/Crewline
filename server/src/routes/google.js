import { Router } from 'express';
import crypto from 'node:crypto';
import db from '../db.js';
import { signData, signPurpose, signToken, verifyData, verifyPurpose, rateLimit } from '../auth.js';
import { cleanEmail } from '../mail.js';
import { getProfile } from './auth.js';
import { companyToJoin } from '../join.js';
import { announceJoinRequest } from './join.js';

/**
 * Sign in with Google (Gmail and Google Workspace accounts).
 *
 * Needs an OAuth client (type "Web application") from Google Cloud Console and these env vars:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *   GOOGLE_REDIRECT_URI  default https://getcrewline.vercel.app/api/auth/google/callback (must be listed on the client)
 *
 * Google must say it verified the email. Unknown emails only get a `pending` join request (company email domain or join
 * link), which HR approves. The first sign-in links the Google account (its fixed `sub` id); later sign-ins use the link.
 */
const router = Router();

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const APP_URL = process.env.APP_URL || 'https://getcrewline.vercel.app';
const COOKIE = 'crewline_google';
const COOKIE_PATH = '/api/auth/google';

const config = () => {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: secret } = process.env;
  if (!clientId || !secret) return null;
  return { clientId, secret, redirectUri: process.env.GOOGLE_REDIRECT_URI || `${APP_URL}/api/auth/google/callback` };
};

/** Where the app may be opened from; the sign-in returns to the same site. */
function returnOrigin(value) {
  const allowed = new Set([
    new URL(APP_URL).origin,
    'https://getcrewline.vercel.app', 'https://crewline-one.vercel.app',
    'https://crewline.web.app', 'https://crewline.firebaseapp.com',
    ...(process.env.GOOGLE_RETURN_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    ...(process.env.NODE_ENV === 'production' ? [] : ['http://localhost:5173', 'http://127.0.0.1:5173']),
  ]);
  try {
    const origin = new URL(String(value)).origin;
    return allowed.has(origin) ? origin : new URL(APP_URL).origin;
  } catch {
    return new URL(APP_URL).origin;
  }
}

const b64url = (buf) => buf.toString('base64url');
const readCookie = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
};
const cookie = (value, maxAge) =>
  `${COOKIE}=${encodeURIComponent(value)}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;

/** Lets the login page show the button only when Google sign-in is set up. */
router.get('/providers', (req, res) => res.json({ google: Boolean(config()) }));

router.get('/google/start', rateLimit({ windowMs: 60_000, max: 60 }), (req, res) => {
  const cfg = config();
  const ret = returnOrigin(req.query.ret);
  const join = /^[A-Za-z0-9_-]{16,64}$/.test(String(req.query.join || '')) ? String(req.query.join) : '';
  if (!cfg) return res.redirect(`${ret}/#g_error=${encodeURIComponent('Sign in with Google is not set up yet.')}`);
  // The state cookie must be set on the same host Google returns to (the app also answers on other addresses).
  const callbackHost = new URL(cfg.redirectUri).host;
  if (req.get('host') !== callbackHost) {
    return res.redirect(`${new URL(cfg.redirectUri).origin}${COOKIE_PATH}/start?ret=${encodeURIComponent(ret)}${join ? `&join=${join}` : ''}`);
  }
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  res.setHeader('Set-Cookie', cookie(signData('google-state', { state, nonce, verifier, ret, join }, '10m'), 600));
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: cfg.redirectUri,
    scope: 'openid email profile',
    state, nonce,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  res.redirect(`${AUTHORIZE_URL}?${params}`);
});

class SignInError extends Error {}

/** The Google account → an active Crewline user (linking it on the first sign-in). */
async function findUser(claims, join) {
  if (!claims.sub) throw new SignInError('Google did not say which account this is. Try again.');
  const linked = await db.get('SELECT * FROM users WHERE google_sub = ?', [String(claims.sub)]);
  if (linked) return linked;

  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (!claims.email || !verified) throw new SignInError('Google has not verified the email on this account, so it cannot be used to sign in.');
  const email = cleanEmail(claims.email);
  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) {
    // Sign-up (company email domain, or the company's join link): Google already proved they own the address, so ask HR.
    const company = await companyToJoin(email, join);
    if (!company) {
      throw new SignInError(join
        ? 'This join link is no longer active. Ask HR for a new one.'
        : `No Crewline account uses ${email}. Ask HR to add or invite you, or for your company's join link.`);
    }
    const name = String(claims.name || email.split('@')[0]).trim().slice(0, 80);
    const created = await db.get(
      `INSERT INTO users (company_id, name, email, password_hash, role, status, google_sub)
       VALUES (?, ?, ?, ?, 'employee', 'pending', ?) ON CONFLICT DO NOTHING RETURNING id, name, email`,
      [company.id, name, email, `!google-only:${crypto.randomBytes(16).toString('hex')}`, String(claims.sub)]
    );
    if (created) await announceJoinRequest(created, company);
    throw new SignInError(`Thanks, ${name}! Your request to join ${company.name} was sent to HR. You can sign in once they approve it.`);
  }
  if (user.google_sub) throw new SignInError('This Crewline account is linked to a different Google account.');
  await db.run('UPDATE users SET google_sub = ? WHERE id = ? AND google_sub IS NULL', [String(claims.sub), user.id]);
  return user;
}

router.get('/google/callback', async (req, res) => {
  const saved = verifyData(readCookie(req, COOKIE), 'google-state');
  res.setHeader('Set-Cookie', cookie('', 0));
  const ret = saved?.ret || new URL(APP_URL).origin;
  const fail = (msg) => res.redirect(`${ret}/#g_error=${encodeURIComponent(msg)}`);
  try {
    const cfg = config();
    if (!cfg) return fail('Sign in with Google is not set up yet.');
    if (req.query.error) {
      return fail(req.query.error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google said: ${String(req.query.error).slice(0, 100)}`);
    }
    if (!saved || !req.query.code || req.query.state !== saved.state) {
      return fail('This sign-in expired or was opened in another browser. Please try again.');
    }

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId, client_secret: cfg.secret, grant_type: 'authorization_code',
        code: String(req.query.code), redirect_uri: cfg.redirectUri, code_verifier: saved.verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokens = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokens.id_token) {
      console.error('google token exchange failed', tokenRes.status, tokens.error, tokens.error_description);
      return fail("Couldn't finish the Google sign-in. Please try again.");
    }

    // The ID token came straight from Google over HTTPS in exchange for our secret, so its claims are Google's;
    // still check it was issued for this app and this sign-in.
    const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1] || '', 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (claims.aud !== cfg.clientId || claims.nonce !== saved.nonce || !(claims.exp > now) || !ISSUERS.has(claims.iss)) {
      console.error('google id token rejected', { aud: claims.aud === cfg.clientId, nonce: claims.nonce === saved.nonce, iss: claims.iss });
      return fail("Couldn't verify the Google sign-in. Please try again.");
    }

    const user = await findUser(claims, saved.join);
    if (user.status === 'pending') return fail('Your request to join is waiting for HR approval. You can sign in once they approve it.');
    if (user.status !== 'active') return fail('Your Crewline account is inactive. Please contact HR.');
    // A short-lived ticket in the URL fragment (never sent to a server); the page swaps it for a session.
    res.redirect(`${ret}/#g=${signPurpose('google-login', user.id, '2m')}`);
  } catch (err) {
    if (err instanceof SignInError) return fail(err.message);
    console.error('google sign-in failed', err);
    return fail('Something went wrong signing in with Google. Please try again.');
  }
});

router.post('/google/finish', rateLimit({ windowMs: 60_000, max: 30 }), async (req, res) => {
  const userId = verifyPurpose(req.body?.ticket, 'google-login');
  const user = userId && await db.get('SELECT * FROM users WHERE id = ? AND status = ?', [userId, 'active']);
  if (!user) return res.status(401).json({ error: 'This Google sign-in expired. Please try again.' });
  // Google already checked the password (and its own 2-Step Verification), so the emailed code isn't asked for again.
  await db.run('UPDATE users SET invited_at = NULL WHERE id = ? AND invited_at IS NOT NULL', [user.id]);
  res.json({ token: signToken(user), user: await getProfile(user.id) });
});

export default router;
