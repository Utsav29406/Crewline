export const initials = (name = '') =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');

const toDate = (s) => (s instanceof Date ? s : new Date(String(s).replace(' ', 'T')));

export const fmtTime = (s) => (s ? toDate(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtDate = (s, opts = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  s ? toDate(s.length === 10 ? `${s}T00:00:00` : s).toLocaleDateString([], opts) : '—';
export const fmtDuration = (min) => (min ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : '—');
/** Like fmtDuration, but shows 0 as "0m" and short spans as "25m" (for timers and break totals). */
export const fmtMinutes = (min = 0) => (min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : `${Math.max(min, 0)}m`);
export const fmtDistance = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`);
export const fmtCurrency = (n, currency = 'INR') => {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(n || 0);
  } catch {
    return `${currency} ${fmtMoney(n)}`;
  }
};

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const under1000 = (n) => {
  const h = Math.floor(n / 100), r = n % 100;
  const rest = r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? ` ${ONES[r % 10]}` : ''}`;
  return [h ? `${ONES[h]} Hundred` : '', rest].filter(Boolean).join(' ');
};
/** Amount in words for payslips — Indian grouping (lakh, crore) for INR, international otherwise. */
export function amountInWords(amount, currency = 'INR') {
  let n = Math.round(Math.abs(amount || 0));
  if (!n) return 'Zero';
  const units = currency === 'INR'
    ? [[1e7, 'Crore'], [1e5, 'Lakh'], [1e3, 'Thousand']]
    : [[1e9, 'Billion'], [1e6, 'Million'], [1e3, 'Thousand']];
  const parts = [];
  for (const [size, name] of units) {
    if (n >= size) {
      const chunk = Math.floor(n / size);
      parts.push(`${chunk >= 1000 ? amountInWords(chunk, currency) : under1000(chunk)} ${name}`);
      n %= size;
    }
  }
  if (n) parts.push(under1000(n));
  return parts.join(' ');
}

export const monthName = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString([], { month: 'long', year: 'numeric' });
export const fmtMoney = (n) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n || 0);

/**
 * "Today" and other calendar dates follow the company's timezone, not the browser's, so someone opening the app
 * from another country still lands on the company's day. context.jsx sets it from the signed-in user.
 */
let companyTz;
export const setCompanyTimezone = (tz) => { companyTz = tz || undefined; };
export const isoDate = (d = new Date()) => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: companyTz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }
};
/** Pure calendar arithmetic on 'YYYY-MM-DD' (no timezone involved). */
export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

export const STATUS_TONE = {
  present: 'good', late: 'warn', half_day: 'info', absent: 'bad',
  pending: 'warn', approved: 'good', rejected: 'bad', cancelled: 'muted',
  active: 'good', inactive: 'muted', on_leave: 'accent',
};
export const statusLabel = (s) => String(s || '').replace('_', ' ');

/** Great-circle distance in metres (mirrors the server check, for live UI feedback only). */
export function haversine(lat1, lng1, lat2, lng2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}
