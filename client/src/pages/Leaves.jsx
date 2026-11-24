import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp, useLive } from '../context.jsx';
import Icon from '../components/Icon.jsx';
import { Badge, Field, Modal, PageHead, Who } from '../components/ui.jsx';
import { fmtDate, isoDate } from '../format.js';

const LABELS = { casual: 'Casual', sick: 'Sick', earned: 'Earned', comp_off: 'Comp-off', unpaid: 'Unpaid' };
const halfLabel = (h) => (h === 'first' ? 'first half' : 'second half');

function ApplyLeave({ onClose, onDone, policy }) {
  const { toast } = useApp();
  const types = ['casual', 'sick', 'earned', ...(policy.compOff ? ['comp_off'] : []), 'unpaid'];
  const [form, setForm] = useState({ type: 'casual', start_date: isoDate(), end_date: isoDate(), half_day: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async () => {
    setBusy(true);
    try {
      const oneDay = form.start_date === form.end_date;
      await api.post('/leaves', { ...form, half_day: oneDay && form.half_day ? form.half_day : null });
      toast('Leave request submitted');
      onDone();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Apply for leave" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={submit}>Submit request</button></>}>
      <div className="form-grid">
        <Field label="Leave type" full>
          <select className="input" value={form.type} onChange={set('type')}>
            {types.map((t) => <option key={t} value={t}>{LABELS[t]}</option>)}
          </select>
        </Field>
        <Field label="From"><input type="date" className="input" value={form.start_date}
          onChange={(e) => { const v = e.target.value; setForm((f) => ({ ...f, start_date: v, end_date: f.end_date < v ? v : f.end_date })); }} /></Field>
        <Field label="To"><input type="date" className="input" value={form.end_date} min={form.start_date} onChange={set('end_date')} /></Field>
        {policy.halfDay && form.start_date === form.end_date && (
          <Field label="How long" full>
            <select className="input" value={form.half_day} onChange={set('half_day')}>
              <option value="">Full day</option>
              <option value="first">Half day: first half (morning)</option>
              <option value="second">Half day: second half (afternoon)</option>
            </select>
          </Field>
        )}
        <Field label="Reason" full><textarea className="input" value={form.reason} onChange={set('reason')} placeholder="Optional" /></Field>
      </div>
      <p className="small muted">Sundays, Saturdays off and company holidays are not counted.</p>
    </Modal>
  );
}

export default function Leaves() {
  const { isManager, user, toast } = useApp();
  const [tab, setTab] = useState(isManager ? 'team' : 'mine');
  const [rows, setRows] = useState([]);
  const [balance, setBalance] = useState([]);
  const [applying, setApplying] = useState(false);
  const [filter, setFilter] = useState('pending');
  const [settings, setSettings] = useState(null);

  const latest = useRef(0);
  const load = useCallback(() => {
    const q = tab === 'mine' ? '?mine=1' : filter ? `?status=${filter}` : '';
    // Switching tabs quickly must not leave the team list showing under "My leaves".
    const n = ++latest.current;
    api.get(`/leaves${q}`).then((r) => n === latest.current && setRows(r));
    api.get('/leaves/balance').then(setBalance);
    api.get('/settings').then(setSettings).catch(() => {});
  }, [tab, filter]);
  const policy = { halfDay: settings?.leave_half_day === '1', compOff: settings?.comp_off === '1' };
  const carries = ['casual', 'sick', 'earned'].some((t) => Number(settings?.[`carry_${t}`]) > 0);
  useEffect(() => { load(); }, [load]);
  useLive(['leave', 'org', 'settings'], load);

  const act = async (path, msg) => {
    try {
      await api.post(path);
      toast(msg);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const review = async (id, status) => {
    try {
      await api.post(`/leaves/${id}/review`, { status });
      toast(`Leave ${status}`);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <>
      <PageHead title="Leaves" subtitle="Requests, approvals and balances">
        {isManager && (
          <div className="tabs">
            <button className={`tab ${tab === 'team' ? 'active' : ''}`} onClick={() => setTab('team')}>Team requests</button>
            <button className={`tab ${tab === 'mine' ? 'active' : ''}`} onClick={() => setTab('mine')}>My leaves</button>
          </div>
        )}
        <button className="btn btn-primary" onClick={() => setApplying(true)}><Icon name="plus" /> Apply leave</button>
      </PageHead>

      <div className={`grid ${balance.length > 3 ? 'grid-4' : 'grid-3'}`} style={{ marginBottom: 10 }}>
        {balance.map((b) => {
          const total = b.quota + (b.carried || 0);
          return (
            <div key={b.type} className="card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <h3>{LABELS[b.type]} leave</h3>
                <span className="stat-value">{b.remaining}</span>
              </div>
              <div className="meter" style={{ margin: '12px 0 8px' }}><span style={{ width: `${total ? Math.max(Math.min((b.remaining / total) * 100, 100), 0) : 0}%` }} /></div>
              <div className="small muted tnum">
                {b.type === 'comp_off'
                  ? <>{b.used} used · earned by working days off{b.expiry_days ? `, valid ${b.expiry_days} days` : ''}</>
                  : <>{b.used} used of {b.quota} this year{b.carried ? ` + ${b.carried} carried from last year` : ''}</>}
                {b.pending ? ` · ${b.pending} waiting` : ''}
              </div>
            </div>
          );
        })}
      </div>
      {balance.length > 0 && (
        <p className="small muted" style={{ margin: '0 0 22px' }}>
          Balances start on 1 January. {carries ? 'Some unused leave carries over to next year, up to your company\'s limit.' : 'Unused leave doesn\'t carry over to the next year.'}
          {policy.halfDay ? ' You can take half days.' : ''}
        </p>
      )}

      <div className="card">
        {tab === 'team' && (
          <div className="tabs" style={{ marginBottom: 12 }}>
            {['pending', 'approved', 'rejected', ''].map((s) => (
              <button key={s || 'all'} className={`tab ${filter === s ? 'active' : ''}`} onClick={() => setFilter(s)}>{s || 'all'}</button>
            ))}
          </div>
        )}
        <div className="table-wrap">
          <table className="table-cards">
            <thead><tr>{tab === 'team' && <th>Employee</th>}<th>Type</th><th>Dates</th><th className="num">Days</th><th>Reason</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  {tab === 'team' && <td><Who name={l.name} sub={l.emp_code} /></td>}
                  <td>{LABELS[l.type] || l.type}</td>
                  <td>
                    {l.start_date === l.end_date ? fmtDate(l.start_date) : <>{fmtDate(l.start_date, { day: 'numeric', month: 'short' })} – {fmtDate(l.end_date)}</>}
                    {l.half_day && <div className="small muted">{halfLabel(l.half_day)}</div>}
                  </td>
                  <td className="num">{l.days}</td>
                  <td className="small" style={{ whiteSpace: 'normal', minWidth: 160 }}>{l.reason || '—'}</td>
                  <td><Badge status={l.status} />{l.reviewer && <div className="small muted">by {l.reviewer}</div>}</td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      {tab === 'team' && l.status === 'pending' && l.user_id !== user.id && (
                        <>
                          <button className="btn btn-sm btn-good" onClick={() => review(l.id, 'approved')}>Approve</button>
                          <button className="btn btn-sm btn-danger" onClick={() => review(l.id, 'rejected')}>Reject</button>
                        </>
                      )}
                      {tab === 'mine' && l.status === 'pending' && (
                        <button className="btn btn-sm" onClick={() => act(`/leaves/${l.id}/cancel`, 'Leave cancelled')}>Cancel</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={7} className="empty">No leave requests</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {applying && <ApplyLeave policy={policy} onClose={() => setApplying(false)} onDone={() => { setApplying(false); load(); }} />}
    </>
  );
}
