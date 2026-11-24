import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../context.jsx';
import { Loading, PageHead } from '../components/ui.jsx';
import { fmtDate, fmtTime } from '../format.js';

const AREAS = [['', 'Everything'], ['employee', 'People'], ['attendance', 'Attendance'], ['leave', 'Leave'], ['payroll', 'Payroll'], ['settings', 'Settings'], ['org', 'Offices & holidays']];
const FIELD = {
  reports_to_name: 'Reports to', joined_on: 'Joining date', birth_date: 'Birthday', emp_code: 'Employee code', geofence: 'Work location',
  check_in: 'Check-in', check_out: 'Check-out', other_deduction: 'Other deduction', radius_m: 'Radius (m)', company_name: 'Company name',
};
const label = (k) => FIELD[k] || (k[0].toUpperCase() + k.slice(1)).replace(/_/g, ' ');
const SWITCHES = new Set(['require_face', 'require_geofence', 'payroll_pf', 'daily_log_email', 'email_notifications', 'tracker_prompt', 'leave_half_day', 'comp_off']);
const show = (v, k) => (v === null || v === undefined || v === '' ? '—' : SWITCHES.has(k) && (v === '0' || v === '1') ? (v === '1' ? 'on' : 'off') : String(v));

/** Activity history: who changed salaries, roles, attendance, leave, payroll and settings, and when. */
export default function History() {
  const [area, setArea] = useState('');
  const [people, setPeople] = useState([]);
  const [person, setPerson] = useState('');
  const [rows, setRows] = useState(null);
  const [more, setMore] = useState(false);

  const query = useCallback((before) => {
    const q = new URLSearchParams({ ...(area && { area }), ...(person && { user_id: person }), ...(before && { before }) });
    return api.get(`/audit?${q}`);
  }, [area, person]);
  const load = useCallback(() => {
    let current = true;
    query().then((r) => { if (current) { setRows(r); setMore(r.length === 100); } });
    return () => { current = false; };
  }, [query]);
  useEffect(load, [load]);
  useLive(['employee', 'attendance', 'leave', 'payroll', 'settings', 'org', 'geofence'], load);
  useEffect(() => { api.get('/employees').then((list) => setPeople(list.filter((p) => p.status !== 'pending'))).catch(() => {}); }, []);
  const loadMore = async () => {
    const next = await query(rows[rows.length - 1].id);
    setRows((r) => [...r, ...next]);
    setMore(next.length === 100);
  };

  return (
    <>
      <PageHead title="Activity history" subtitle="Who changed what, and when: salaries, roles, attendance, leave, payroll and settings">
        <select className="input" value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Person">
          <option value="">Everyone</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </PageHead>
      <div className="tabs" style={{ marginBottom: 16 }}>
        {AREAS.map(([k, l]) => <button key={k || 'all'} className={`tab ${area === k ? 'active' : ''}`} onClick={() => setArea(k)}>{l}</button>)}
      </div>
      {!rows ? <Loading /> : (
        <div className="card">
          {!rows.length && <div className="empty">Nothing recorded yet. Changes appear here as HR and admins make them.</div>}
          <div className="history">
            {rows.map((r) => (
              <div key={r.id} className="history-item">
                <div className="history-when small muted tnum">{fmtDate(r.created_at, { day: 'numeric', month: 'short', year: 'numeric' })}<br />{fmtTime(r.created_at)}</div>
                <div className="history-body">
                  <div><b>{r.actor_name || 'Someone'}</b> {r.action}{r.target_name ? <> for <b>{r.target_name}</b></> : ''}</div>
                  {r.changes && (
                    <div className="history-changes">
                      {Object.entries(r.changes).map(([k, v]) => (
                        <div key={k} className="small">
                          <span className="muted">{label(k)}:</span>{' '}
                          {Array.isArray(v) ? (v[0] === null ? <b>{show(v[1], k)}</b> : v[1] === null ? <s>{show(v[0], k)}</s> : <><s className="muted">{show(v[0], k)}</s> → <b>{show(v[1], k)}</b></>) : show(v, k)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <span className={`badge history-area area-${r.area}`}>{AREAS.find(([k]) => k === r.area)?.[1] || r.area}</span>
              </div>
            ))}
          </div>
          {more && <button className="btn btn-block" style={{ marginTop: 14 }} onClick={loadMore}>Show older</button>}
        </div>
      )}
    </>
  );
}
