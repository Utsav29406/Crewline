import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp, useLive } from '../context.jsx';
import { Badge, LoadError, Loading, PageHead, StatCard, Who } from '../components/ui.jsx';
import TrendChart from '../components/TrendChart.jsx';
import Icon from '../components/Icon.jsx';
import TrackerCard from '../components/TrackerCard.jsx';
import { Announcements, Celebrations } from '../components/Board.jsx';
import { fmtDate, fmtTime } from '../format.js';

function SetupChecklist({ stats, company }) {
  const steps = [
    { done: stats.geofences > 0, title: 'Add your office geofence', text: 'Search your address and set a radius.', to: '/geofences', cta: 'Add geofence' },
    { done: stats.departments > 0, title: 'Create departments', text: 'Group people for reports and dashboards.', to: '/settings', cta: 'Add departments' },
    { done: stats.headcount > 1, title: 'Add your employees', text: 'They sign in with the email and password you set.', to: '/employees', cta: 'Add employees' },
    { done: stats.headcount > 1 && stats.notEnrolled === 0, title: 'Enroll everyone’s face', text: 'Each person enrolls once from Profile, or you do it from Employees.', to: '/employees', cta: 'Enroll faces' },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  return (
    <div className="card" style={{ marginBottom: 22 }}>
      <div className="card-head">
        <div>
          <h2>Set up {company}</h2>
          <div className="small muted">{done} of {steps.length} done — employees can punch in once a geofence exists and their face is enrolled.</div>
        </div>
      </div>
      <div className="progress" style={{ marginBottom: 16 }}><span style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <div className="steps">
        {steps.map((s, i) => (
          <div key={s.title} className={`step ${s.done ? 'done' : ''}`}>
            <div className="step-num">{s.done ? <Icon name="check" size={15} /> : i + 1}</div>
            <div style={{ flex: 1, minWidth: 0 }}><b>{s.title}</b><div className="small muted">{s.text}</div></div>
            {!s.done && <Link to={s.to} className="btn btn-sm">{s.cta} <Icon name="arrow" size={14} /></Link>}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { toast, user } = useApp();
  const [data, setData] = useState(null);
  const [live, setLive] = useState([]);
  const [pending, setPending] = useState([]);

  const [error, setError] = useState(null);
  const latest = useRef(0);
  const load = () => {
    const n = ++latest.current; // live reloads can overlap: only the newest result lands
    return Promise.all([api.get('/dashboard'), api.get('/attendance/live'), api.get('/leaves?status=pending')]).then(([d, l, p]) => {
      if (n !== latest.current) return;
      setData(d);
      setLive(l);
      setPending(p);
      setError(null);
    }).catch((err) => n === latest.current && setError(err.message));
  };
  useEffect(() => { load(); }, []);
  useLive(['attendance', 'leave', 'employee', 'geofence', 'org', 'settings'], load);

  const review = async (id, status) => {
    try {
      await api.post(`/leaves/${id}/review`, { status });
      toast(`Leave ${status}`);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  if (!data) return error ? <LoadError message={error} onRetry={() => { setError(null); load(); }} /> : <Loading />;
  const s = data.stats;
  return (
    <>
      <PageHead title="Overview" subtitle="Live workforce snapshot for today">
        <Link to="/punch" className="btn btn-primary"><Icon name="face" /> Punch in</Link>
      </PageHead>

      {!user.is_demo && <SetupChecklist stats={s} company={user.company_name} />}
      <TrackerCard />
      <Announcements />
      <Celebrations />

      <div className="grid grid-4" style={{ marginBottom: 22 }}>
        <StatCard icon="users" label="Active employees" value={s.headcount} tone="accent" />
        <StatCard icon="check" label="Present today" value={s.present} tone="good" hint={`${s.late} late arrivals`} />
        <StatCard icon="plane" label="On leave" value={s.onLeave} tone="info" hint={`${s.pendingLeaves} pending requests`} />
        <StatCard icon="alert" label="Not checked in" value={s.absent} tone="warn" hint={`${s.failedToday} failed verifications`} />
      </div>

      <div className="grid grid-main" style={{ marginBottom: 22 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Check-ins, last 14 days</h2>
              <div className="small muted">Employees checked in per day</div>
            </div>
          </div>
          <TrendChart data={data.trend} max={s.headcount} />
        </div>
        <div className="card">
          <div className="card-head"><h2>Attendance by department</h2></div>
          <div className="stack">
            {data.byDepartment.map((d) => (
              <div key={d.department}>
                <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                  <b>{d.department}</b>
                  <span className="small muted tnum">{d.present || 0} / {d.headcount}</span>
                </div>
                <div className="meter"><span style={{ width: `${((d.present || 0) / d.headcount) * 100}%` }} /></div>
              </div>
            ))}
          </div>
          {s.notEnrolled > 0 && (
            <div className="check-item" style={{ marginTop: 18 }}>
              <div className="check-dot badge-warn"><Icon name="face" size={16} /></div>
              <div className="small"><b>{s.notEnrolled}</b> employees haven't enrolled their face yet. <Link to="/employees">Manage</Link></div>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-main">
        <div className="card">
          <div className="card-head">
            <h2>Live board</h2>
            <Link to="/attendance" className="btn btn-sm">View all</Link>
          </div>
          <div className="table-wrap">
            <table className="table-cards">
              <thead><tr><th>Employee</th><th>In</th><th>Out</th><th>Location</th><th>Status</th></tr></thead>
              <tbody>
                {live.slice(0, 8).map((r) => (
                  <tr key={r.id}>
                    <td><Who name={r.name} sub={r.department || r.designation} /></td>
                    <td className="tnum">{fmtTime(r.check_in)}</td>
                    <td className="tnum">{fmtTime(r.check_out)}</td>
                    <td>{r.geofence || '—'}</td>
                    <td>{r.break_type ? <Badge tone="info">on {r.break_type === 'lunch' ? 'lunch' : 'break'}</Badge> : r.status ? <Badge status={r.status} /> : r.leave_type ? <Badge tone="accent">{r.leave_type} leave</Badge> : <Badge status="absent">not in</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="stack" style={{ gap: 22 }}>
          <div className="card">
            <div className="card-head"><h2>Pending leaves</h2><Badge tone="warn">{pending.length}</Badge></div>
            <div className="stack">
              {pending.slice(0, 4).map((l) => (
                <div key={l.id} className="check-item" style={{ flexWrap: 'wrap' }}>
                  <Who name={l.name} sub={`${l.type} · ${fmtDate(l.start_date, { day: 'numeric', month: 'short' })} – ${fmtDate(l.end_date, { day: 'numeric', month: 'short' })} · ${l.days}d`} />
                  <div className="spacer" />
                  {l.user_id === user.id ? <span className="small muted">Your request</span> : (
                    <>
                      <button className="btn btn-sm btn-good" onClick={() => review(l.id, 'approved')} aria-label="Approve"><Icon name="check" size={15} /></button>
                      <button className="btn btn-sm btn-danger" onClick={() => review(l.id, 'rejected')} aria-label="Reject"><Icon name="x" size={15} /></button>
                    </>
                  )}
                </div>
              ))}
              {!pending.length && <div className="empty">All caught up 🎉</div>}
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Upcoming holidays</h2></div>
            <div className="stack">
              {data.upcomingHolidays.map((h) => (
                <div key={h.id} className="row">
                  <div className="stat-icon tone-accent" style={{ width: 44, height: 44 }}><Icon name="calendar" /></div>
                  <div><b>{h.name}</b><div className="small muted">{fmtDate(h.date, { weekday: 'long', day: 'numeric', month: 'long' })}</div></div>
                </div>
              ))}
              {!data.upcomingHolidays.length && <div className="muted">No upcoming holidays</div>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
