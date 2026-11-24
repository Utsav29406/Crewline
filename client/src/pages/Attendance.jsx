import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp, useLive } from '../context.jsx';
import { Badge, Field, Modal, PageHead, PrintTitle, Who } from '../components/ui.jsx';
import Icon from '../components/Icon.jsx';
import { addDays, fmtDate, fmtDuration, fmtTime, isoDate } from '../format.js';
import { downloadExcel, printReport } from '../exporting.js';

const AUTO_REFRESH_MS = 10_000;

/** Refresh-now button; its ring fills over 10 s, then the page refreshes and it starts again. */
function RefreshButton({ cycle, busy, onClick }) {
  return (
    <button className={`btn btn-icon refresh-btn ${busy ? 'busy' : ''}`} onClick={onClick}
      title="Refreshes every 10 seconds. Click to refresh now." aria-label="Refresh now">
      <svg className="refresh-ring" viewBox="0 0 40 40" aria-hidden="true">
        <circle key={cycle} cx="20" cy="20" r="18" style={{ animationDuration: `${AUTO_REFRESH_MS}ms` }} />
      </svg>
      <Icon name="refresh" size={16} />
    </button>
  );
}

function exportExcel(rows, from, to) {
  return downloadExcel(`attendance-${from}-to-${to}`,
    ['Date', 'Emp code', 'Name', 'Check in', 'Check out', 'Worked (h)', 'Breaks (min)', 'Overtime (h)', 'Status', 'Location', 'Edit note'],
    rows.map((r) => [r.date, r.emp_code, r.name, r.check_in?.slice(11, 16), r.check_out?.slice(11, 16),
      r.work_minutes != null ? Math.round(r.work_minutes / 6) / 10 : null, r.break_minutes || 0,
      r.overtime_minutes ? Math.round(r.overtime_minutes / 6) / 10 : 0, r.status, r.geofence, r.edit_note]),
    { sheet: 'Attendance', widths: [12, 10, 22, 9, 9, 10, 11, 11, 10, 18, 30] });
}

const timeOf = (dt) => (dt ? dt.slice(11, 16) : '');

/**
 * One form for both: HR/admin set the times directly (with a note), an employee asks for them (with a reason).
 * `record` prefills a day that exists; without it, HR picks the person and any day.
 */
function TimesModal({ mode, record, employees, onClose, onDone }) {
  const { toast } = useApp();
  const hr = mode === 'edit';
  const [form, setForm] = useState({
    user_id: record?.user_id || '', date: record?.date || isoDate(),
    check_in: timeOf(record?.check_in) || '', check_out: timeOf(record?.check_out) || '', note: '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    try {
      if (hr) await api.put('/attendance/manual', { user_id: form.user_id, date: form.date, check_in: form.check_in, check_out: form.check_out, note: form.note });
      else await api.post('/attendance/corrections', { date: form.date, check_in: form.check_in, check_out: form.check_out, reason: form.note });
      toast(hr ? 'Attendance updated' : 'Request sent to HR');
      onDone();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const overnight = form.check_in && form.check_out && form.check_out <= form.check_in;
  return (
    <Modal title={hr ? (record ? `Edit ${record.name}'s day` : 'Add attendance') : 'Ask HR to fix a day'} onClose={onClose} width={560}
      footer={<><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !form.check_in || !form.note.trim() || (hr && !form.user_id)} onClick={save}>{hr ? 'Save' : 'Send request'}</button></>}>
      <div className="form-grid">
        {hr && !record && (
          <Field label="Employee" full>
            <select className="input" value={form.user_id} onChange={set('user_id')}>
              <option value="">Choose a person</option>
              {employees.filter((e) => e.status === 'active').map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="Day"><input className="input" type="date" value={form.date} max={isoDate()} disabled={Boolean(record)} onChange={set('date')} /></Field>
        <div />
        <Field label="Checked in at"><input className="input" type="time" value={form.check_in} onChange={set('check_in')} /></Field>
        <Field label="Checked out at"><input className="input" type="time" value={form.check_out} onChange={set('check_out')} /></Field>
        {overnight && <div className="small muted full">Check-out is earlier than check-in, so it counts as the next morning (night shift).</div>}
        <Field label={hr ? 'Note (why the times changed)' : 'What happened?'} full>
          <textarea className="input" rows={3} value={form.note} onChange={set('note')}
            placeholder={hr ? 'Forgot to punch out; confirmed with manager' : 'I forgot to punch out. I left at 6:45 pm.'} />
        </Field>
        {hr && record && <div className="small muted full">Breaks outside the new times are trimmed, and worked hours and status are recalculated.</div>}
      </div>
    </Modal>
  );
}

/** Correction requests: HR approves or rejects; an employee follows (or cancels) their own. */
function Corrections({ isManager, tick, onChanged }) {
  const { toast } = useApp();
  const [items, setItems] = useState([]);
  useEffect(() => {
    let current = true;
    api.get('/attendance/corrections').then((r) => current && setItems(r)).catch(() => {});
    return () => { current = false; };
  }, [tick]);
  const act = async (c, action, body) => {
    try {
      await api.post(`/attendance/corrections/${c.id}/${action}`, body);
      toast(action === 'cancel' ? 'Request cancelled' : `Request ${body.status}`);
      onChanged();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const shown = isManager ? items.filter((c) => c.status === 'pending') : items.slice(0, 5);
  if (!shown.length) return null;
  const tone = { pending: 'warn', approved: 'good', rejected: 'bad', cancelled: 'muted' };
  return (
    <div className="card no-print" style={{ marginBottom: 22 }}>
      <div className="card-head">
        <h2>{isManager ? 'Fix requests' : 'Your fix requests'}</h2>
        {isManager && <Badge tone="warn">{shown.length} waiting</Badge>}
      </div>
      <div className="stack">
        {shown.map((c) => (
          <div key={c.id} className="check-item" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 220 }}>
              <b>{isManager ? `${c.name} · ` : ''}{fmtDate(c.date, { weekday: 'short', day: 'numeric', month: 'short' })}</b>
              <div className="small">
                Asked: <b className="tnum">{fmtTime(c.check_in)} – {c.check_out ? fmtTime(c.check_out) : 'no check-out'}</b>
                <span className="muted"> · on record: {c.current_in ? `${fmtTime(c.current_in)} – ${c.current_out ? fmtTime(c.current_out) : 'no check-out'}` : 'nothing'}</span>
              </div>
              <div className="small muted" style={{ marginTop: 4 }}>“{c.reason}”</div>
              {c.review_note && <div className="small" style={{ marginTop: 4 }}>{c.reviewed_by_name}: {c.review_note}</div>}
            </div>
            {isManager ? (
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-sm btn-good" onClick={() => act(c, 'review', { status: 'approved' })}><Icon name="check" size={15} /> Approve</button>
                <button className="btn btn-sm btn-danger" onClick={() => {
                  const note = prompt('Reason for rejecting (optional)');
                  if (note !== null) act(c, 'review', { status: 'rejected', note });
                }}><Icon name="x" size={15} /> Reject</button>
              </div>
            ) : (
              <div className="row" style={{ gap: 8 }}>
                <Badge tone={tone[c.status]}>{c.status}</Badge>
                {c.status === 'pending' && <button className="link-btn muted small" onClick={() => act(c, 'cancel', {})}>Cancel</button>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Attendance() {
  const { isManager, user } = useApp();
  const [tab, setTab] = useState('records');
  const [from, setFrom] = useState(() => addDays(isoDate(), -30));
  const [to, setTo] = useState(isoDate());
  const [userId, setUserId] = useState('');
  const [employees, setEmployees] = useState([]);
  const [rows, setRows] = useState([]);
  const [attempts, setAttempts] = useState([]);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // { mode: 'edit' | 'request', record? }
  const refresh = () => setTick((t) => t + 1);
  useLive(['attendance'], refresh);
  // Managers: refresh every 10 s; any refresh (button, live event) restarts the countdown.
  useEffect(() => {
    if (!isManager) return undefined;
    const timer = setTimeout(refresh, AUTO_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [isManager, tick]);

  useEffect(() => {
    if (isManager) api.get('/employees').then(setEmployees);
  }, [isManager]);
  useEffect(() => {
    // Ignore a slower earlier response (an older filter, or the 10 s refresh) once a newer one is on its way.
    let current = true;
    setBusy(true);
    api.get(`/attendance?from=${from}&to=${to}${userId ? `&user_id=${userId}` : ''}`)
      .then((r) => current && setRows(r))
      .finally(() => current && setBusy(false));
    return () => { current = false; };
  }, [from, to, userId, tick]);
  useEffect(() => {
    if (isManager && tab === 'attempts') api.get('/attendance/attempts').then(setAttempts);
  }, [isManager, tab, tick]);

  return (
    <>
      <PageHead title="Attendance" subtitle={isManager ? 'Every verified punch across the company' : 'Your verified punches'}>
        {isManager && <RefreshButton cycle={tick} busy={busy} onClick={refresh} />}
        {isManager && (
          <div className="tabs">
            <button className={`tab ${tab === 'records' ? 'active' : ''}`} onClick={() => setTab('records')}>Records</button>
            <button className={`tab ${tab === 'attempts' ? 'active' : ''}`} onClick={() => setTab('attempts')}>Verification log</button>
          </div>
        )}
      </PageHead>

      {tab === 'records' && <Corrections isManager={isManager} tick={tick} onChanged={refresh} />}
      {editing && (
        <TimesModal mode={editing.mode} record={editing.record} employees={employees}
          onClose={() => setEditing(null)} onDone={() => { setEditing(null); refresh(); }} />
      )}
      {tab === 'records' ? (
        <div className="card">
          <PrintTitle>{user.company_name} · Attendance · {fmtDate(from)} – {fmtDate(to)}</PrintTitle>
          <div className="row wrap no-print filters" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
            <Field label="From"><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To"><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            {isManager && (
              <Field label="Employee">
                <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)}>
                  <option value="">All employees</option>
                  {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </Field>
            )}
            <div className="spacer" />
            {isManager
              ? <button className="btn" onClick={() => setEditing({ mode: 'edit' })}><Icon name="plus" size={15} /> Add day</button>
              : <button className="btn" onClick={() => setEditing({ mode: 'request' })}>Fix a missing day</button>}
            <button className="btn" onClick={() => exportExcel(rows, from, to)} disabled={!rows.length}><Icon name="download" size={15} /> Excel</button>
            <button className="btn" onClick={printReport} disabled={!rows.length}><Icon name="file" size={15} /> PDF</button>
          </div>
          <div className="table-wrap">
            <table className="table-cards">
              <thead>
                <tr>
                  <th>Date</th>{isManager && <th>Employee</th>}<th>In</th><th>Out</th><th className="num">Worked</th><th className="num">Breaks</th><th>Location</th><th className="num">Overtime</th><th className="num">Face match</th><th>Status</th><th className="no-print" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDate(r.date, { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                    {isManager && <td><Who name={r.name} sub={r.emp_code} /></td>}
                    <td className="tnum">{fmtTime(r.check_in)}</td>
                    <td className="tnum">{fmtTime(r.check_out)}</td>
                    <td className="num">
                      {fmtDuration(r.work_minutes)}
                      {r.in_progress && <div className="small muted">so far</div>}
                    </td>
                    <td className="num">
                      {r.open_break_type
                        ? <Badge tone="warn">{r.open_break_type === 'lunch' ? 'On lunch' : 'On break'} since {fmtTime(r.open_break_started)}</Badge>
                        : r.break_minutes ? fmtDuration(r.break_minutes) : '—'}
                    </td>
                    <td>{r.geofence || '—'}</td>
                    <td className="num">{r.overtime_minutes ? fmtDuration(r.overtime_minutes) : '—'}</td>
                    <td className="num">{r.face_distance != null ? `${Math.round((1 - r.face_distance) * 100)}%` : '—'}</td>
                    <td>
                      <Badge status={r.status} />
                      {r.edited_at && <div className="small muted" title={r.edit_note || ''}>edited</div>}
                    </td>
                    <td className="no-print">
                      <button className="btn btn-sm" onClick={() => setEditing({ mode: isManager ? 'edit' : 'request', record: r })}>
                        {isManager ? <><Icon name="edit" size={14} /> Edit</> : 'Request fix'}
                      </button>
                    </td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={11} className="empty">No records in this range</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>Every punch attempt, including rejected ones — useful for spotting proxy attempts or misconfigured geofences. <b>check</b> marks punches that were allowed but look faked (copied location, impossible travel); reused face scans are refused.</p>
          <div className="table-wrap">
            <table className="table-cards">
              <thead><tr><th>When</th><th>Employee</th><th>Action</th><th>Result</th><th>Reason</th><th className="num">Distance</th><th className="num">Face dist.</th></tr></thead>
              <tbody>
                {attempts.map((a) => (
                  <tr key={a.id}>
                    <td className="tnum">{fmtDate(a.created_at, { day: 'numeric', month: 'short' })} {fmtTime(a.created_at)}</td>
                    <td><Who name={a.name} sub={a.emp_code} /></td>
                    <td>{a.action.replace('_', ' ')}</td>
                    <td>{a.success ? (a.flags ? <Badge tone="warn">check</Badge> : <Badge tone="good">passed</Badge>) : <Badge tone="bad">rejected</Badge>}</td>
                    <td className="small" style={{ whiteSpace: 'normal', minWidth: 200 }}>{a.flags ? <>Looks unusual: {a.flags}</> : a.reason || '—'}</td>
                    <td className="num">{a.distance_m != null ? `${Math.round(a.distance_m)} m` : '—'}</td>
                    <td className="num">{a.face_distance != null ? a.face_distance.toFixed(3) : '—'}</td>
                  </tr>
                ))}
                {!attempts.length && <tr><td colSpan={7} className="empty">No attempts yet</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
