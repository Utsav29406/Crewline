import db from './db.js';

/**
 * Email-domain auto-join: a company names its email domain (Settings → `join_domain`), and anyone who proves they own
 * an address at that domain (emailed code, or Google's verified email) can ask to join. They arrive as `pending` and
 * HR approves or rejects them. Pending people can't sign in and are left out of attendance, payroll and lists.
 */

/** Free/personal mailbox providers: anyone can get an address there, so they can't identify a company. */
const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'outlook.in', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'live.in',
  'msn.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'ymail.com', 'rocketmail.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'zoho.com', 'zohomail.com', 'zohomail.in', 'gmx.com', 'gmx.net',
  'mail.com', 'yandex.com', 'yandex.ru', 'rediffmail.com', 'tutanota.com', 'tuta.io', 'hey.com', 'fastmail.com',
  'qq.com', '163.com', 'mail.ru',
]);

export const domainOf = (email) => String(email || '').split('@')[1]?.toLowerCase() || '';
export const isPublicDomain = (domain) => PUBLIC_DOMAINS.has(String(domain).toLowerCase());

/** Normalises what an admin typed ("@Acme.com", "https://acme.com") to "acme.com". */
export const cleanDomain = (value) => String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^@/, '').replace(/\/.*$/, '');
export const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The company whose join link carries this code (HR shares it; any email, Gmail included, can ask to join). */
export async function companyForJoinCode(code) {
  const value = String(code || '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(value)) return null;
  return db.get(
    `SELECT c.id, c.name, c.timezone FROM settings s JOIN companies c ON c.id = s.company_id
     WHERE s.key = 'join_code' AND s.value = ? AND c.is_demo = false LIMIT 1`,
    [value]
  );
}

/** The company someone may ask to join: by its join link when they used one, otherwise by their email's domain. */
export const companyToJoin = (email, link) => (link ? companyForJoinCode(link) : companyForEmail(email));

/** The company that lets people with this email's domain join, if any. */
export async function companyForEmail(email) {
  const domain = domainOf(email);
  if (!domain || isPublicDomain(domain)) return null;
  return db.get(
    `SELECT c.id, c.name, c.timezone FROM settings s JOIN companies c ON c.id = s.company_id
     WHERE s.key = 'join_domain' AND s.value = ? AND c.is_demo = false ORDER BY c.id LIMIT 1`,
    [domain]
  );
}
