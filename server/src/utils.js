const EARTH_RADIUS_M = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres between two lat/lng points. */
export function haversine(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

export function euclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

export function isValidDescriptor(d) {
  return Array.isArray(d) && d.length === 128 && d.every((n) => typeof n === 'number' && Number.isFinite(n));
}

const LOGO = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
export const MAX_LOGO_BYTES = 200 * 1024;

/** Validates a company logo sent as a data URL. Returns an error message, or null when it's fine. */
export function logoError(dataUrl) {
  const m = LOGO.exec(String(dataUrl || ''));
  if (!m) return 'Logo must be a PNG, JPEG or WebP image';
  if (Math.floor((m[2].length * 3) / 4) > MAX_LOGO_BYTES) return 'Logo must be 200 KB or smaller';
  return null;
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return Boolean(tz);
  } catch {
    return false;
  }
}

/**
 * Wall-clock time in a company's timezone: { date: 'YYYY-MM-DD', dateTime: 'YYYY-MM-DD HH:MM:SS', minutes }.
 * Every company can sit in a different timezone, so "today" and "late" are always computed per company.
 */
export function clock(timeZone, at = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(at).map((x) => [x.type, x.value])
  );
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, dateTime: `${date} ${p.hour}:${p.minute}:${p.second}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

// Calendar arithmetic on 'YYYY-MM-DD' strings, done in UTC so it never depends on the server's timezone.
const asUtc = (date) => new Date(`${date}T00:00:00Z`);
export const addDays = (date, n) => {
  const d = asUtc(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const dayOfWeek = (date) => asUtc(date).getUTCDay();

/** Minutes between two 'YYYY-MM-DD HH:MM:SS' wall-clock strings of the same timezone. */
export const minutesBetween = (from, to) =>
  Math.round((Date.parse(`${to.replace(' ', 'T')}Z`) - Date.parse(`${from.replace(' ', 'T')}Z`)) / 60000);

/** Parses the `saturdays_off` setting ('2,4' = 2nd and 4th Saturdays of the month) into a Set of week numbers. */
export const parseSaturdaysOff = (value) =>
  new Set(String(value || '').split(',').map(Number).filter((n) => n >= 1 && n <= 5));

/** Sundays are always off; Saturdays are off when their week-of-month is in `saturdaysOff`. */
export const isWeeklyOff = (date, saturdaysOff = new Set()) => {
  const dow = dayOfWeek(date);
  return dow === 0 || (dow === 6 && saturdaysOff.has(Math.ceil(Number(date.slice(8, 10)) / 7)));
};

/** Count working days between two ISO dates inclusive, skipping weekly offs and holidays. */
export function countLeaveDays(start, end, holidaySet = new Set(), saturdaysOff = new Set()) {
  let days = 0;
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (isWeeklyOff(d, saturdaysOff) || holidaySet.has(d)) continue;
    days++;
  }
  return days;
}

/** A real calendar day like 2026-02-28 (the format alone would also pass 2026-02-31, which Postgres rejects). */
export const isRealDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
