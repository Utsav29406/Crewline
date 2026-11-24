/**
 * Extras when Crewline runs inside the Android app (mobile/, Capacitor). The app loads this same website, and
 * Capacitor adds `window.Capacitor` with the phone's native plugins. In a normal browser all of this does nothing.
 *  - Location for punches comes from Android itself, which says whether a fake-GPS ("mock location") app made it.
 *  - Punch reminders are scheduled on the phone, so they arrive even when the app is closed.
 */
const cap = () => window.Capacitor;
export const isNativeApp = () => Boolean(cap()?.isNativePlatform?.());
const plugin = (name) => cap()?.Plugins?.[name];

/** { lat, lng, accuracy, mock } from the phone's GPS, or null when not in the app (or it failed). */
export async function nativeLocation() {
  const device = plugin('CrewlineDevice');
  if (!isNativeApp() || !device) return null;
  try {
    const p = await device.getLocation({ timeoutMs: 15000 });
    return { lat: p.lat, lng: p.lng, accuracy: Math.round(p.accuracy), mock: Boolean(p.mock) };
  } catch {
    return null;
  }
}

/** Android's back button goes back a page, and only leaves the app from the first page. */
export function setupBackButton() {
  const app = plugin('App');
  if (!isNativeApp() || !app) return;
  app.addListener('backButton', ({ canGoBack }) => (canGoBack ? window.history.back() : app.exitApp()));
}

const REMINDER_BASE = 7300; // notification ids: base + day offset * 2 (+1 for the punch-out reminder)
const hm = (s) => s.split(':').map(Number);

/**
 * Schedules the next 14 days of punch reminders on the phone: 5 minutes before the shift starts and 10 minutes
 * after it ends, on working days only. Called on every app start and after each punch, so today's reminder
 * disappears once the person has punched.
 * workingDays: ISO dates that are working days; punchedIn / punchedOut: today's state.
 */
export async function scheduleReminders({ shiftStart, shiftEnd, workingDays, today, punchedIn, punchedOut }) {
  const notes = plugin('LocalNotifications');
  if (!isNativeApp() || !notes) return;
  try {
    const perm = await notes.checkPermissions();
    if (perm.display !== 'granted' && (await notes.requestPermissions()).display !== 'granted') return;
    const pending = await notes.getPending();
    const ours = (pending.notifications || []).filter((n) => n.id >= REMINDER_BASE && n.id < REMINDER_BASE + 100);
    if (ours.length) await notes.cancel({ notifications: ours.map((n) => ({ id: n.id })) });
    const now = Date.now();
    const list = [];
    workingDays.slice(0, 14).forEach((date, i) => {
      const [sh, sm] = hm(shiftStart);
      const [eh, em] = hm(shiftEnd);
      const inAt = new Date(`${date}T00:00:00`); inAt.setHours(sh, sm - 5, 0, 0);
      const outAt = new Date(`${date}T00:00:00`); outAt.setHours(eh, em + 10, 0, 0);
      const isToday = date === today;
      if (inAt.getTime() > now && !(isToday && punchedIn)) {
        list.push({ id: REMINDER_BASE + i * 2, title: 'Time to punch in', body: 'Your shift starts in 5 minutes. Open Crewline to check in.', schedule: { at: inAt, allowWhileIdle: true } });
      }
      if (outAt.getTime() > now && !(isToday && punchedOut)) {
        list.push({ id: REMINDER_BASE + i * 2 + 1, title: "Don't forget to punch out", body: 'Your shift has ended. Open Crewline to check out.', schedule: { at: outAt, allowWhileIdle: true } });
      }
    });
    if (list.length) await notes.schedule({ notifications: list });
  } catch (err) {
    console.error('reminders failed', err);
  }
}

/**
 * Fetches today's state and working days, then (re)schedules the phone's reminders. At most once a minute
 * (company-wide events would otherwise call it constantly), unless `force` (right after this person's punch).
 */
let lastRefresh = 0;
export async function refreshReminders(force = false) {
  if (!isNativeApp() || (!force && Date.now() - lastRefresh < 60_000)) return;
  lastRefresh = Date.now();
  try {
    const { api } = await import('./api.js');
    const r = await api.get('/attendance/reminders');
    await scheduleReminders({
      shiftStart: r.shift_start, shiftEnd: r.shift_end, workingDays: r.working_days, today: r.today,
      punchedIn: r.punched_in, punchedOut: r.punched_out,
    });
  } catch (err) {
    console.error('reminders failed', err);
  }
}
