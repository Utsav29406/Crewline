import db, { getSettings } from './db.js';
import { addDays, clock, isWeeklyOff, parseSaturdaysOff } from './utils.js';

/**
 * Leave balances under each company's own policy (Settings → Leave policy):
 *  - a yearly quota per type (casual, sick, earned);
 *  - carry-forward: up to `carry_<type>` unused days move into the next year, year after year;
 *  - comp-off: working a weekly off or a holiday earns a day (half a day for a short stint), usable within
 *    `comp_off_expiry_days`. Credits come straight from attendance, so HR's attendance fixes keep them right.
 */
export const PAID_TYPES = ['casual', 'sick', 'earned'];
export const COMP_OFF_MIN_MINUTES = 120; // less than this on a day off earns nothing

/** Comp-off earned for working `minutes` on a day off. */
export const compOffFor = (minutes, settings) =>
  minutes >= Number(settings.half_day_minutes || 240) ? 1 : minutes >= COMP_OFF_MIN_MINUTES ? 0.5 : 0;

async function compOff(user, userId, s, runner, today) {
  const expiry = Number(s.comp_off_expiry_days) || 0;
  const since = expiry ? addDays(today, -expiry - 400) : '1900-01-01'; // enough history for the uses still in reach
  const [att, holidays, uses] = await Promise.all([
    runner.all(
      `SELECT date::text AS date, COALESCE(work_minutes, 0) AS minutes FROM attendance
       WHERE user_id = ? AND company_id = ? AND check_out IS NOT NULL AND date >= ? ORDER BY date`,
      [userId, user.company_id, since]
    ),
    runner.all('SELECT date::text AS date FROM holidays WHERE company_id = ? AND date >= ?', [user.company_id, since]),
    runner.all(
      `SELECT start_date::text AS start, days, status FROM leaves
       WHERE user_id = ? AND company_id = ? AND type = 'comp_off' AND status IN ('approved', 'pending') ORDER BY start_date, id`,
      [userId, user.company_id]
    ),
  ]);
  const off = new Set(holidays.map((h) => h.date));
  const sats = parseSaturdaysOff(s.saturdays_off);
  const credits = att
    .filter((a) => isWeeklyOff(a.date, sats) || off.has(a.date))
    .map((a) => ({ date: a.date, left: compOffFor(Number(a.minutes), s) }))
    .filter((c) => c.left > 0);
  const valid = (c, on) => c.date <= on && (!expiry || c.date >= addDays(on, -expiry));
  // Oldest credits are spent first.
  for (const u of uses) {
    let need = Number(u.days);
    for (const c of credits) {
      if (need <= 0) break;
      if (!c.left || !valid(c, u.start)) continue;
      const take = Math.min(c.left, need);
      c.left -= take;
      need -= take;
    }
  }
  const available = credits.filter((c) => valid(c, today)).reduce((sum, c) => sum + c.left, 0);
  const used = uses.filter((u) => u.status === 'approved').reduce((sum, u) => sum + Number(u.days), 0);
  const pending = uses.filter((u) => u.status === 'pending').reduce((sum, u) => sum + Number(u.days), 0);
  return {
    type: 'comp_off', used, pending,
    // `remaining - pending` is what can still be requested, as for the other types.
    remaining: available + pending,
    expiry_days: expiry,
  };
}

/**
 * Balances for one person in `year`. `runner` lets a transaction read through its own connection (asking the
 * pool for a second one could deadlock).
 */
export async function leaveBalance(user, userId, year, { runner = db, settings } = {}) {
  const s = settings || await getSettings(user.company_id);
  const person = await runner.get('SELECT joined_on::text AS joined_on FROM users WHERE id = ?', [userId]);
  const joinedYear = person?.joined_on ? Number(person.joined_on.slice(0, 4)) : year;
  const firstYear = Math.max(Math.min(joinedYear, year), year - 10);
  const rows = await runner.all(
    `SELECT EXTRACT(YEAR FROM start_date)::int AS y, type,
            COALESCE(SUM(days) FILTER (WHERE status = 'approved'), 0) AS used,
            COALESCE(SUM(days) FILTER (WHERE status = 'pending'), 0) AS pending
     FROM leaves WHERE user_id = ? AND company_id = ? AND status IN ('approved', 'pending') AND type = ANY(?::text[])
       AND start_date >= make_date(?, 1, 1) AND start_date < make_date(?, 1, 1)
     GROUP BY 1, 2`,
    [userId, user.company_id, PAID_TYPES, firstYear, year + 1]
  );
  const at = (y, type) => rows.find((r) => r.y === y && r.type === type) || { used: 0, pending: 0 };

  const out = PAID_TYPES.map((type) => {
    const quota = Number(s[`quota_${type}`] || 0);
    const carryMax = Number(s[`carry_${type}`] || 0);
    // Walk the years forward: each one starts with what the last one carried in.
    let carried = 0;
    for (let y = firstYear; y < year; y++) carried = Math.min(carryMax, Math.max(quota + carried - Number(at(y, type).used), 0));
    const { used, pending } = at(year, type);
    // `pending` is days already requested and awaiting review: new requests can't spend them a second time.
    return { type, quota, carried, used: Number(used), pending: Number(pending), remaining: quota + carried - Number(used) };
  });
  if (s.comp_off === '1') {
    const c = await compOff(user, userId, s, runner, clock(user.timezone).date);
    // "quota" = everything earned that is still in play (used, requested or available), for the "x of y" display.
    out.push({ ...c, quota: c.remaining + c.used, carried: 0 });
  }
  return out;
}
