import 'dotenv/config';
import pg from 'pg';

// Vercel reserves TZ, so the business timezone can also come from APP_TIMEZONE.
if (process.env.APP_TIMEZONE) process.env.TZ = process.env.APP_TIMEZONE;

// Return DATE / TIMESTAMP as plain local strings ("2026-11-01", "2026-11-01 09:30:00")
// and BIGINT / NUMERIC as numbers, so the API stays timezone-agnostic and JSON-friendly.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1114, (v) => v.slice(0, 19));
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://crewline:crewline@localhost:5432/crewline',
  // Serverless functions each hold their own pool; keep it small and let Neon's pooler fan in.
  max: process.env.VERCEL ? 3 : 10,
});

/** Lets SQL use `?` placeholders; converts them to $1, $2… for pg. */
const toPg = (sql) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

/**
 * A bad id in a URL (Number('abc') = NaN) would make Postgres throw and the request fail with a 500. As NULL it
 * simply matches nothing, so the route answers "not found" as it does for any unknown id.
 */
const clean = (params) => params.map((v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v));

const wrap = (runner) => ({
  query: (sql, params = []) => runner.query(toPg(sql), clean(params)),
  all: async (sql, params = []) => (await runner.query(toPg(sql), clean(params))).rows,
  get: async (sql, params = []) => (await runner.query(toPg(sql), clean(params))).rows[0],
  run: async (sql, params = []) => runner.query(toPg(sql), clean(params)),
});

const db = wrap(pool);

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(wrap(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export const DEFAULT_SETTINGS = {
  shift_start: '09:30',
  shift_end: '18:30',
  grace_minutes: '10',
  half_day_minutes: '240',
  quota_casual: '12',
  quota_sick: '8',
  quota_earned: '15',
  require_face: '1',
  require_geofence: '1',
  max_gps_accuracy_m: '150',
  currency: 'INR',
  payroll_pf: '1', // deduct employee PF: 12% of basic, capped at 1,800
  payroll_pt: '200', // monthly professional tax (0 to disable)
  saturdays_off: '', // e.g. '2,4' = 2nd and 4th Saturdays off (Sundays are always off)
  daily_log_email: '0', // '1' = email each person their day's attendance log on punch-out
  tracker_prompt: '1', // '1' = dashboard asks people without a connected desktop tracker to install it
  email_notifications: '0', // '1' = also email people their own notifications (leave decisions, new tasks...)
  overtime_after_minutes: '480', // worked minutes in a day after which the rest counts as overtime (reports only)
  // Leave policy (each company sets its own):
  leave_half_day: '1', // '1' = people may take half a day of leave
  carry_casual: '0', // unused days that move into the next year (0 = none)
  carry_sick: '0',
  carry_earned: '0',
  comp_off: '0', // '1' = working a weekly off or holiday earns a comp-off day
  comp_off_expiry_days: '90', // a comp-off must be used within this many days (0 = never expires)
  join_domain: '', // e.g. 'acme.com': people with a verified @acme.com email can ask to join (HR approves)
  auto_attendance_until: '', // test helper: 'YYYY-MM-DD' to auto check staff in/out daily until that date
};

/** Inserts any missing default settings for one company (or all companies). */
export async function ensureDefaultSettings(runner = db, companyId = null) {
  const entries = Object.entries(DEFAULT_SETTINGS);
  await runner.run(
    `INSERT INTO settings (company_id, key, value)
     SELECT c.id, d.key, d.value FROM companies c
     CROSS JOIN unnest(?::text[], ?::text[]) AS d(key, value)
     WHERE ?::int IS NULL OR c.id = ?::int
     ON CONFLICT (company_id, key) DO NOTHING`,
    [entries.map((e) => e[0]), entries.map((e) => e[1]), companyId, companyId]
  );
}

export async function getSettings(companyId) {
  const rows = await db.all('SELECT key, value FROM settings WHERE company_id = ?', [companyId]);
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}

export const isUniqueViolation = (err) => err?.code === '23505';
export const end = () => pool.end();

export default db;
