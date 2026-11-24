import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp, useLive } from '../context.jsx';
import Icon from '../components/Icon.jsx';
import TrackerCard from '../components/TrackerCard.jsx';
import InstallAppCard from '../components/InstallAppCard.jsx';
import { Announcements, Celebrations } from '../components/Board.jsx';
import { Badge, LoadError, Loading, PageHead, StatCard } from '../components/ui.jsx';
import { fmtDate, fmtDuration, fmtTime, isoDate } from '../format.js';

export default function MyDashboard() {
  const { user } = useApp();
  const [today, setToday] = useState(null);
  const [history, setHistory] = useState([]);
  const [balance, setBalance] = useState([]);
  const [holidays, setHolidays] = useState([]);

  const [error, setError] = useState(null);
  const latest = useRef(0);
  const load = () => {
    const n = ++latest.current; // live reloads can overlap: only the newest result lands
    return Promise.all([api.get('/attendance/today'), api.get('/attendance'), api.get('/leaves/balance'), api.get('/holidays?upcoming=1')]).then(
      ([t, h, b, hol]) => {
        if (n !== latest.current) return;
        setToday(t);
        setHistory(h);
        setBalance(b);
        setHolidays(hol.slice(0, 3));
        setError(null);
      }
    ).catch((err) => n === latest.current && setError(err.message));
  };
  useEffect(() => { load(); }, []);
  useLive(['leave', 'org', 'settings', 'geofence'], load);

  if (!today) return error ? <LoadError message={error} onRetry={() => { setError(null); load(); }} /> : <Loading />;
  const rec = today.record;
  const month = isoDate().slice(0, 7);
  const thisMonth = history.filter((h) => h.date.startsWith(month));
  const avgMin = thisMonth.filter((h) => h.work_minutes).reduce((a, h, _, arr) => a + h.work_minutes / arr.length, 0);

  return (
    <>
      <PageHead title="My workspace" subtitle={`${user.designation || ''}${user.department ? ` · ${user.department}` : ''}`}>
        <Link to="/leaves" className="btn"><Icon name="plane" /> Apply leave</Link>
        <Link to="/punch" className="btn btn-primary"><Icon name="face" /> {rec ? (rec.check_out ? 'View today' : 'Check out') : 'Check in'}</Link>
      </PageHead>
      <TrackerCard />
      <InstallAppCard />
      <Announcements />
      <Celebrations />

      {!user.face_enrolled && today.policy.require_face && (
        <div className="card row wrap" style={{ marginBottom: 22 }}>
          <div className="stat-icon tone-warn"><Icon name="face" size={22} /></div>
          <div className="spacer">
            <h3>Enroll your face to start punching in</h3>
            <div className="muted small">It takes about 10 seconds and only needs your camera.</div>
          </div>
          <Link to="/profile" className="btn btn-primary">Enroll now</Link>
        </div>
      )}

      <div className="grid grid-4" style={{ marginBottom: 22 }}>
        <StatCard icon="login" label="Today's check-in" value={fmtTime(rec?.check_in)} tone={rec ? (rec.status === 'late' ? 'warn' : 'good') : 'info'} hint={rec ? rec.status.replace('_', ' ') : 'Not checked in yet'} />
        <StatCard icon="check" label="Days present this month" value={thisMonth.length} tone="good" hint={`${thisMonth.filter((h) => h.status === 'late').length} late`} />
        <StatCard icon="clock" label="Avg. hours / day" value={fmtDuration(Math.round(avgMin))} tone="accent" />
        <StatCard icon="plane" label="Leave days left" value={balance.reduce((a, b) => a + b.remaining, 0)} tone="info" />
      </div>

      <div className="grid grid-main">
        <div className="card">
          <div className="card-head"><h2>Recent attendance</h2><Link to="/attendance" className="btn btn-sm">History</Link></div>
          <div className="table-wrap">
            <table className="table-cards">
              <thead><tr><th>Date</th><th>In</th><th>Out</th><th className="num">Worked</th><th>Status</th></tr></thead>
              <tbody>
                {history.slice(0, 7).map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDate(r.date, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                    <td className="tnum">{fmtTime(r.check_in)}</td>
                    <td className="tnum">{fmtTime(r.check_out)}</td>
                    <td className="num">{fmtDuration(r.work_minutes)}</td>
                    <td><Badge status={r.status} /></td>
                  </tr>
                ))}
                {!history.length && <tr><td colSpan={5} className="empty">No attendance yet</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="stack" style={{ gap: 22 }}>
          <div className="card">
            <div className="card-head"><h2>Leave balance</h2></div>
            <div className="stack">
              {balance.map((b) => (
                <div key={b.type}>
                  <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                    <b>{b.type === 'comp_off' ? 'Comp-off' : b.type[0].toUpperCase() + b.type.slice(1)}</b>
                    <span className="small muted tnum">{b.remaining} of {b.quota + (b.carried || 0)} left</span>
                  </div>
                  <div className="meter"><span style={{ width: `${b.quota + (b.carried || 0) ? Math.max(Math.min((b.remaining / (b.quota + (b.carried || 0))) * 100, 100), 0) : 0}%` }} /></div>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Upcoming holidays</h2></div>
            <div className="stack">
              {holidays.map((h) => (
                <div key={h.id} className="row">
                  <div className="stat-icon tone-accent" style={{ width: 44, height: 44 }}><Icon name="calendar" /></div>
                  <div><b>{h.name}</b><div className="small muted">{fmtDate(h.date, { weekday: 'long', day: 'numeric', month: 'long' })}</div></div>
                </div>
              ))}
              {!holidays.length && <div className="muted">No upcoming holidays</div>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
