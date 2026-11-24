import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { api, getToken, setToken } from './api.js';
import { setCompanyTimezone } from './format.js';
import Icon from './components/Icon.jsx';

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

const THEME_KEY = 'crewline.theme';
const POLL_MS = 4000;
const readTheme = () => {
  try { return localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
};
const applyTheme = (theme) => {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
};

/**
 * Re-runs `onChange` whenever a live event whose type starts with one of `prefixes` arrives
 * (e.g. ['attendance', 'leave']). Pages use it to refetch instead of polling on their own.
 */
export function useLive(prefixes, onChange) {
  const { subscribe } = useApp();
  const cb = useRef(onChange);
  cb.current = onChange;
  const key = prefixes.join(',');
  useEffect(
    () => subscribe((events) => {
      if (events.some((e) => key.split(',').some((p) => e.type.startsWith(p)))) cb.current(events);
    }),
    [key, subscribe]
  );
}

export function AppProvider({ children }) {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  const [toasts, setToasts] = useState([]);
  const [theme, setThemeState] = useState(readTheme);
  const [unread, setUnread] = useState(0);
  const [live, setLive] = useState(true);
  const listeners = useRef(new Set());
  // Set during render (not in an effect) so pages computing "today" in their first render already use it.
  setCompanyTimezone(user?.timezone);

  const firstTheme = useRef(true);
  useEffect(() => {
    const root = document.documentElement;
    let timer;
    // A view transition (toggleTheme) already applied it; otherwise fade colours (skipped on first paint).
    const applied = (root.getAttribute('data-theme') || 'system') === theme;
    if (!firstTheme.current && !applied) {
      root.classList.add('theme-switching');
      timer = setTimeout(() => root.classList.remove('theme-switching'), 400);
    }
    firstTheme.current = false;
    applyTheme(theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
    return () => clearTimeout(timer);
  }, [theme]);

  const refreshUser = useCallback(async () => {
    if (!getToken()) return setUser(null);
    // Only a rejected session signs out; a network blip or cold-start error keeps the current user.
    try { setUser(await api.get('/auth/me')); } catch (err) { if (err?.status === 401) setUser(null); }
  }, []);

  useEffect(() => {
    refreshUser().finally(() => setBooting(false));
    const onLogout = () => setUser(null);
    window.addEventListener('crewline:logout', onLogout);
    return () => window.removeEventListener('crewline:logout', onLogout);
  }, [refreshUser]);

  const toast = useCallback((message, type = 'success', detail) => {
    const id = Math.random();
    setToasts((t) => [...t.slice(-3), { id, message, type, detail }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), type === 'info' ? 6500 : 4200);
  }, []);

  const subscribe = useCallback((fn) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);

  // Real-time pulse: poll for events newer than the cursor; pause while the tab is hidden.
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    let cursor = null;
    let timer;
    let stopped = false;
    let inFlight = false;
    const poll = async () => {
      clearTimeout(timer);
      if (stopped || inFlight) return;
      if (document.hidden) {
        timer = setTimeout(poll, POLL_MS);
        return;
      }
      inFlight = true;
      try {
        const r = await api.get(`/live${cursor !== null ? `?since=${cursor}` : ''}`);
        setUnread(r.unread);
        setLive(true);
        if (cursor !== null && r.events.length) {
          listeners.current.forEach((fn) => fn(r.events));
          r.events.filter((e) => e.notify && e.actor_id !== userId).forEach((e) => toast(e.title, 'info', e.body));
        }
        cursor = r.cursor;
      } catch {
        setLive(false);
      } finally {
        inFlight = false;
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };
    poll();
    const onVisible = () => !document.hidden && poll();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [userId, toast]);

  // Keep the signed-in profile fresh when someone (e.g. HR) changes it. Any employee change can matter: moving a
  // junior to or from this person changes their team (user.juniors), and the event carries the junior's id.
  useEffect(() => subscribe((events) => {
    if (events.some((e) => e.type === 'employee.changed' || e.type === 'settings.changed')) refreshUser();
  }), [subscribe, refreshUser]);

  const startSession = ({ token, user }) => {
    setToken(token);
    setUser(user);
  };
  // Two-step sign-in: a remembered device skips the emailed code for 30 days.
  const DEVICE_KEY = 'crewline.device';
  const readDevice = () => { try { return localStorage.getItem(DEVICE_KEY) || undefined; } catch { return undefined; } };
  const saveDevice = (device) => { try { if (device) localStorage.setItem(DEVICE_KEY, device); } catch { /* private window */ } };
  /** Signs in, or returns { twoStep, ticket, email } when an emailed code is needed first. */
  const login = async (email, password) => {
    const r = await api.post('/auth/login', { email, password, device: readDevice() });
    if (r.twoStep) return r;
    startSession(r);
    return null;
  };
  const verifyCode = async (ticket, code, remember) => {
    const r = await api.post('/auth/login/verify', { ticket, code, remember });
    saveDevice(r.device);
    startSession(r);
  };
  /** Sign in with Google: the server hands back a short-lived ticket in the page address after Google's sign-in. */
  const finishGoogle = async (ticket) => startSession(await api.post('/auth/google/finish', { ticket }));
  /** HR invite: choose a password from the emailed link, then you're signed in. */
  const acceptInvite = async (token, password) => startSession(await api.post('/auth/invite', { token, password }));
  const register = async (form) => startSession(await api.post('/auth/register', form));
  const logout = () => {
    setToken(null);
    setUser(null);
    setUnread(0);
  };

  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  // Crossfade the whole page in one piece where the browser supports it, so nothing flickers mid-switch.
  const toggleTheme = () => {
    const next = isDark ? 'light' : 'dark';
    if (!document.startViewTransition || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return setThemeState(next);
    document.startViewTransition(() => {
      applyTheme(next);
      flushSync(() => setThemeState(next));
    });
  };
  const isManager = user && (user.role === 'admin' || user.role === 'hr');

  return (
    <AppContext.Provider
      value={{ user, booting, login, verifyCode, finishGoogle, acceptInvite, register, logout, refreshUser, toast, isDark, toggleTheme, isManager, subscribe, unread, setUnread, live }}
    >
      {children}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            <Icon name={t.type === 'error' ? 'alert' : t.type === 'info' ? 'bell' : 'check'} />
            <div>
              <div>{t.message}</div>
              {t.detail && <div className="small muted" style={{ fontWeight: 500 }}>{t.detail}</div>}
            </div>
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}
