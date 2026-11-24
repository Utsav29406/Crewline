import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { api, companyLogoUrl } from '../api.js';
import { useApp, useLive } from '../context.jsx';
import Icon from './Icon.jsx';
import Logo from './Logo.jsx';
import { Avatar } from './ui.jsx';
import { fmtDate, fmtTime } from '../format.js';
import { refreshReminders } from '../native.js';

const NAV = [
  { section: 'Workspace' },
  { to: '/', icon: 'dashboard', label: 'Dashboard', end: true },
  { to: '/punch', icon: 'face', label: 'Punch In / Out' },
  { to: '/attendance', icon: 'clock', label: 'Attendance' },
  { to: '/leaves', icon: 'plane', label: 'Leaves' },
  { to: '/tasks', icon: 'tasks', label: 'Tasks' },
  { to: '/activity', icon: 'monitor', label: 'Activity' },
  { to: '/payslips', icon: 'file', label: 'Payslips' },
  { section: 'Administration', manager: true },
  { to: '/live-map', icon: 'radar', label: 'Live Map', manager: true },
  { to: '/employees', icon: 'users', label: 'Employees', manager: true },
  { to: '/geofences', icon: 'map', label: 'Geofences', manager: true },
  { to: '/payroll', icon: 'wallet', label: 'Payroll', manager: true },
  { to: '/reports', icon: 'chart', label: 'Reports', manager: true },
  { to: '/history', icon: 'refresh', label: 'Activity history', manager: true },
  { to: '/settings', icon: 'settings', label: 'Settings', manager: true },
];

/** Phone tab bar: the four places people go most, plus More (the full menu). */
const TABS_EMPLOYEE = [
  { to: '/', icon: 'dashboard', label: 'Home', end: true },
  { to: '/punch', icon: 'face', label: 'Punch' },
  { to: '/attendance', icon: 'clock', label: 'Attendance' },
  { to: '/tasks', icon: 'tasks', label: 'Tasks' },
];
const TABS_MANAGER = [
  { to: '/', icon: 'dashboard', label: 'Home', end: true },
  { to: '/attendance', icon: 'clock', label: 'Attendance' },
  { to: '/employees', icon: 'users', label: 'People' },
  { to: '/tasks', icon: 'tasks', label: 'Tasks' },
];

/**
 * Tables marked .table-cards turn into one card per row on phones; each cell shows its column name, copied here
 * from the table's header (so pages don't have to repeat every label).
 */
function useTableCardLabels() {
  useEffect(() => {
    const label = () => {
      for (const table of document.querySelectorAll('table.table-cards')) {
        const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
        for (const tr of table.querySelectorAll('tbody tr')) {
          [...tr.children].forEach((td, i) => {
            if (td.colSpan > 1) return;
            if (td.dataset.label !== heads[i]) td.dataset.label = heads[i] || '';
          });
        }
      }
    };
    label();
    const observer = new MutationObserver(label);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
}

const NOTIF_ICON = { leave: 'plane', attendance: 'clock', payroll: 'wallet' };
const notifTone = (type) => (type === 'attendance.failed' ? 'bad' : type === 'attendance.check_in' ? 'warn' : 'accent');

function Bell() {
  const { unread, setUnread } = useApp();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const ref = useRef(null);

  const load = () => api.get('/notifications').then((r) => {
    setItems(r.items);
    setUnread(r.unread);
  });
  useLive(['leave', 'attendance', 'payroll'], () => open && load());

  useEffect(() => {
    if (!open) return;
    load();
    const onDown = (e) => !ref.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const markRead = async () => {
    await api.post('/notifications/read');
    setUnread(0);
    setItems((list) => list?.map((i) => ({ ...i, unread: false })));
  };

  return (
    <div className="bell-wrap" ref={ref}>
      <button className="btn btn-icon" onClick={() => setOpen((o) => !o)} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
        <Icon name="bell" />
      </button>
      {unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8, padding: '0 4px' }}>
            <h3>Notifications</h3>
            {unread > 0 && <button className="btn btn-sm" onClick={markRead}>Mark all read</button>}
          </div>
          {items === null ? (
            <div className="loading" style={{ minHeight: 100 }}><span className="spin" /></div>
          ) : items.length ? (
            items.map((n) => (
              <div key={n.id} className={`notif-item ${n.unread ? 'unread' : ''}`}>
                <div className={`check-dot badge-${notifTone(n.type)}`}><Icon name={NOTIF_ICON[n.type.split('.')[0]] || 'bell'} size={15} /></div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{n.title}</div>
                  {n.body && <div className="small muted">{n.body}</div>}
                  <div className="small muted">{fmtDate(n.created_at, { day: 'numeric', month: 'short' })} · {fmtTime(n.created_at)}</div>
                </div>
              </div>
            ))
          ) : (
            <div className="empty">You're all caught up</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { user, logout, isManager, isDark, toggleTheme, live } = useApp();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  // Phone app only: keep the punch reminders for the coming days up to date (shift times, holidays, leave).
  useEffect(() => { refreshReminders(); }, []);
  useLive(['settings', 'org', 'leave', 'attendance'], () => refreshReminders());
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  // The logo goes home; on the home screen it remounts the page so its data reloads.
  const [pageKey, setPageKey] = useState(0);
  const goHome = () => {
    if (location.pathname === '/') setPageKey((k) => k + 1);
    setOpen(false);
  };

  useTableCardLabels();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <Link to="/" className="brand" onClick={goHome} title="Home" aria-label="Crewline home">
          <Logo />
          <div className="brand-text" style={{ minWidth: 0 }}>
            <div className="brand-name">Crewline</div>
            <div className="brand-company" title={user.company_name}>
              {companyLogoUrl(user) && <img className="company-logo-sm" src={companyLogoUrl(user)} alt="" />}
              <span>{user.company_name}</span>
            </div>
          </div>
        </Link>
        {NAV.filter((n) => !n.manager || isManager).map((n) =>
          n.section ? (
            <div key={n.section} className="nav-section">{n.section}</div>
          ) : (
            <NavLink key={n.to} to={n.to} end={n.end} className="nav-link" title={n.label} onClick={() => setOpen(false)}>
              <span className="nav-icon"><Icon name={n.icon} size={21} /></span>
              <span className="nav-label">{n.label}</span>
            </NavLink>
          )
        )}
        <div className="sidebar-foot">
          <div className="phone-only sidebar-actions">
            <button className="nav-link" onClick={toggleTheme}>
              <span className="nav-icon"><Icon name={isDark ? 'sun' : 'moon'} size={21} /></span>
              <span className="nav-label">{isDark ? 'Light mode' : 'Dark mode'}</span>
            </button>
            <button className="nav-link" onClick={logout}>
              <span className="nav-icon"><Icon name="logout" size={21} /></span>
              <span className="nav-label">Sign out</span>
            </button>
          </div>
          <NavLink to="/profile" className="nav-link" title="My profile">
            <Avatar name={user.name} />
            <div className="nav-label" style={{ minWidth: 0 }}>
              <div className="who-name">{user.name}</div>
              <div className="who-sub" style={{ textTransform: 'capitalize' }}>{user.role}</div>
            </div>
          </NavLink>
        </div>
      </aside>
      {open && <div className="sidebar-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />}

      <main className="main">
        <div className="topbar">
          <button className="btn btn-icon menu-btn" onClick={() => setOpen((o) => !o)} aria-label="Menu"><Icon name="menu" /></button>
          <Link to="/" className="topbar-logo phone-only" onClick={goHome} aria-label="Crewline home"><Logo /></Link>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="muted small topbar-date">{new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</div>
            <div className="topbar-greeting">{greeting}, {user.name.split(' ')[0]} 👋</div>
          </div>
          <span className={`live-dot ${live ? '' : 'off'}`} title={live ? 'Updates arrive automatically' : 'Reconnecting…'}>
            {live ? 'Live' : 'Offline'}
          </span>
          <Bell />
          <button className="btn btn-icon desk-only" onClick={toggleTheme} aria-label="Toggle theme">
            <Icon name={isDark ? 'sun' : 'moon'} />
          </button>
          <button className="btn btn-icon desk-only" onClick={logout} aria-label="Sign out" title="Sign out">
            <Icon name="logout" />
          </button>
        </div>
        <Outlet key={pageKey} />
      </main>

      <nav className="tabbar" aria-label="Main">
        {(isManager ? TABS_MANAGER : TABS_EMPLOYEE).map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className="tab-item" onClick={t.to === '/' ? goHome : undefined}>
            <Icon name={t.icon} size={22} />
            <span>{t.label}</span>
          </NavLink>
        ))}
        <button className={`tab-item ${open ? 'active' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <Icon name="menu" size={22} />
          <span>More</span>
        </button>
      </nav>
    </div>
  );
}
