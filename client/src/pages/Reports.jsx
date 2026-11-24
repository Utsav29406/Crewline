import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp, useLive } from '../context.jsx';
import Icon from '../components/Icon.jsx';
import { Badge, Field, Loading, PageHead, PrintTitle, StatCard, Who } from '../components/ui.jsx';
import { fmtDate, fmtMoney, isoDate, monthName } from '../format.js';
import { downloadExcel, printReport } from '../exporting.js';

const COLUMNS = [
  ['present', 'Present'], ['late', 'Late'], ['half_days', 'Half'], ['paid_leave', 'Paid leave'],
  ['unpaid_leave', 'Unpaid'], ['absent', 'Absent'], ['hours', 'Hours'], ['overtime_hours', 'Overtime h'], ['payable_days', 'Payable days'],
];
const hrs = (sec) => Math.round(sec / 360) / 10;
const fmtHours = (sec) => {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};
const STATUS = { todo: ['To do', 'muted'], progress: ['In progress', 'info'], done: ['Done', 'good'] };

function ExportButtons({ onExcel, disabled }) {
  return (
    <>
      <button className="btn" onClick={onExcel} disabled={disabled} style={{ alignSelf: 'flex-end' }}><Icon name="download" /> Excel</button>
      <button className="btn" onClick={printReport} disabled={disabled} style={{ alignSelf: 'flex-end' }}><Icon name="file" /> PDF</button>
    </>
  );
}

/** Attendance-adjusted monthly summary (the basis of payroll). */
function Monthly({ company }) {
  const [month, setMonth] = useState(isoDate().slice(0, 7));
  const [data, setData] = useState(null);
  // Only the latest request may fill the table, so a slow answer for an earlier month can't replace this one.
  const latest = useRef(0);
  const load = useCallback(() => {
    const n = ++latest.current;
    api.get(`/reports/monthly?month=${month}`).then((d) => n === latest.current && setData(d));
  }, [month]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  useLive(['attendance', 'leave', 'employee', 'org'], load);

  const excel = () => downloadExcel(`attendance-${month}`,
    ['Emp code', 'Name', 'Department', ...COLUMNS.map((c) => c[1]), 'Salary', 'Payable'],
    data.rows.map((r) => [r.emp_code, r.name, r.department, ...COLUMNS.map((c) => r[c[0]]), r.salary, r.payable]),
    { sheet: monthName(month) });

  const total = data?.rows.reduce((a, r) => a + r.payable, 0) || 0;
  const avgAttendance = data?.rows.length && data.workingDays
    ? Math.round((data.rows.reduce((a, r) => a + r.present, 0) / (data.rows.length * data.workingDays)) * 100)
    : 0;
  const overtime = data?.rows.reduce((a, r) => a + (r.overtime_hours || 0), 0) || 0;

  return (
    <>
      <div className="row wrap no-print filters" style={{ marginBottom: 18, alignItems: 'flex-end' }}>
        <Field label="Month"><input type="month" className="input" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
        <div className="spacer" />
        <ExportButtons onExcel={excel} disabled={!data} />
      </div>
      <PrintTitle>{company} · Attendance & payroll · {monthName(month)}</PrintTitle>
      {!data ? <Loading /> : (
        <>
          <div className="grid grid-4" style={{ marginBottom: 22 }}>
            <StatCard icon="calendar" label="Working days" value={data.workingDays} tone="accent" hint="Excludes Sundays & holidays" />
            <StatCard icon="check" label="Average attendance" value={`${avgAttendance}%`} tone="good" />
            <StatCard icon="clock" label="Overtime" value={`${Math.round(overtime * 10) / 10} h`} tone="warn" hint="Shown only, not paid" />
            <StatCard icon="briefcase" label="Total payable" value={fmtMoney(total)} tone="info" />
          </div>
          <div className="card">
            <div className="table-wrap">
              <table className="table-cards">
                <thead>
                  <tr><th>Employee</th>{COLUMNS.map(([k, l]) => <th key={k} className="num">{l}</th>)}<th className="num">Salary</th><th className="num">Payable</th></tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td><Who name={r.name} sub={r.department || r.emp_code} /></td>
                      {COLUMNS.map(([k]) => <td key={k} className="num">{r[k] || (k === 'overtime_hours' ? '—' : r[k])}</td>)}
                      <td className="num">{fmtMoney(r.salary)}</td>
                      <td className="num"><b>{fmtMoney(r.payable)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted">Payable = salary × (present days − ½ × half days + paid leave) ÷ working days. Overtime is the time worked past the daily limit set in Settings; it isn't added to pay.</p>
          </div>
        </>
      )}
    </>
  );
}

/** Time the desktop tracker logged per task and per person. */
function TaskTime({ company }) {
  const [from, setFrom] = useState(() => `${isoDate().slice(0, 7)}-01`);
  const [to, setTo] = useState(isoDate());
  const [data, setData] = useState(null);
  const latest = useRef(0);
  const load = useCallback(() => {
    const n = ++latest.current;
    api.get(`/reports/tasks?from=${from}&to=${to}`).then((d) => n === latest.current && setData(d));
  }, [from, to]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  useLive(['task'], load);

  const excel = () => downloadExcel(`task-time-${from}-to-${to}`,
    ['Task', 'Assigned to', 'Emp code', 'Status', 'Priority', 'Hours logged', 'Estimate (h)', 'Days worked', 'Due'],
    data.tasks.map((t) => [t.title, t.assignee, t.emp_code, STATUS[t.status][0], t.priority, hrs(t.seconds),
      t.estimate_minutes ? Math.round(t.estimate_minutes / 6) / 10 : null, t.days, t.due_date]),
    { sheet: 'Time by task', widths: [40, 22, 10, 12, 10, 12, 12, 11, 12] });

  const total = data?.tasks.reduce((a, t) => a + t.seconds, 0) || 0;
  const top = data?.people[0]?.seconds || 1;
  return (
    <>
      <div className="row wrap no-print filters" style={{ marginBottom: 18, alignItems: 'flex-end' }}>
        <Field label="From"><input type="date" className="input" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" className="input" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></Field>
        <div className="spacer" />
        <ExportButtons onExcel={excel} disabled={!data?.tasks.length} />
      </div>
      <PrintTitle>{company} · Time by task · {fmtDate(from)} – {fmtDate(to)}</PrintTitle>
      {!data ? <Loading /> : (
        <>
          <div className="grid grid-3" style={{ marginBottom: 22 }}>
            <StatCard icon="clock" label="Time on tasks" value={fmtHours(total)} tone="accent" />
            <StatCard icon="tasks" label="Tasks worked on" value={new Set(data.tasks.map((t) => t.id)).size} tone="info" />
            <StatCard icon="users" label="People" value={data.people.length} tone="good" />
          </div>
          <div className="grid grid-main">
            <div className="card">
              <div className="card-head"><h2>By task</h2></div>
              <div className="table-wrap">
                <table className="table-cards">
                  <thead><tr><th>Task</th><th>Assigned to</th><th>Status</th><th className="num">Logged</th><th className="num">Estimate</th></tr></thead>
                  <tbody>
                    {data.tasks.map((t) => (
                      <tr key={`${t.id}-${t.user_id}`}>
                        <td style={{ whiteSpace: 'normal', minWidth: 180 }}><b>{t.title}</b></td>
                        <td><Who name={t.assignee} sub={t.emp_code} /></td>
                        <td><Badge tone={STATUS[t.status][1]}>{STATUS[t.status][0]}</Badge></td>
                        <td className="num">
                          <b>{fmtHours(t.seconds)}</b>
                          {t.estimate_minutes > 0 && t.seconds / 60 > t.estimate_minutes && <div className="small" style={{ color: 'var(--bad)' }}>over estimate</div>}
                        </td>
                        <td className="num">{t.estimate_minutes ? fmtHours(t.estimate_minutes * 60) : '—'}</td>
                      </tr>
                    ))}
                    {!data.tasks.length && <tr><td colSpan={5} className="empty">No task time in these days. Time is logged by the desktop tracker while someone works on a task.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <div className="card-head"><h2>By person</h2></div>
              <div className="stack">
                {data.people.map((p) => (
                  <div key={p.user_id}>
                    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                      <b>{p.name}</b>
                      <span className="small muted tnum">{fmtHours(p.seconds)} · {p.tasks} task{p.tasks === 1 ? '' : 's'}</span>
                    </div>
                    <div className="meter"><span style={{ width: `${(p.seconds / top) * 100}%` }} /></div>
                  </div>
                ))}
                {!data.people.length && <div className="muted small">Nobody logged task time in these days.</div>}
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default function Reports() {
  const { user } = useApp();
  const [tab, setTab] = useState('monthly');
  return (
    <>
      <PageHead title="Reports" subtitle={tab === 'monthly' ? 'Attendance-adjusted monthly payroll' : 'Where tracked time went'}>
        <div className="tabs">
          <button className={`tab ${tab === 'monthly' ? 'active' : ''}`} onClick={() => setTab('monthly')}>Monthly</button>
          <button className={`tab ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setTab('tasks')}>Time by task</button>
        </div>
      </PageHead>
      {tab === 'monthly' ? <Monthly company={user.company_name} /> : <TaskTime company={user.company_name} />}
    </>
  );
}
