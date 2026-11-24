import { Fragment, useEffect, useMemo, useState } from 'react';
import { api, companyLogoUrl } from '../api.js';
import { useApp, useLive } from '../context.jsx';
import Icon from '../components/Icon.jsx';
import LogoPicker from '../components/LogoPicker.jsx';
import { Field, Loading, PageHead, Switch } from '../components/ui.jsx';
import { fmtDate } from '../format.js';

export default function Settings() {
  const { user, toast, refreshUser } = useApp();
  const [logoBusy, setLogoBusy] = useState(false);
  const isAdmin = user.role === 'admin';
  const [settings, setSettings] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [holidays, setHolidays] = useState([]);
  const [dept, setDept] = useState('');
  const [holiday, setHoliday] = useState({ date: '', name: '' });

  const zones = useMemo(() => {
    try { return Intl.supportedValuesOf('timeZone'); } catch { return []; }
  }, []);

  const loadLists = () => {
    api.get('/departments').then(setDepartments);
    api.get('/holidays').then(setHolidays);
  };
  const load = () => {
    api.get('/settings').then(setSettings);
    loadLists();
  };
  useEffect(load, []);
  useLive(['org'], loadLists);

  const set = (k) => (e) => setSettings((s) => ({ ...s, [k]: e.target.value }));
  // `reload` re-fetches the policy too (only after saving it); list edits refresh just the lists so unsaved
  // policy changes in the form survive adding a department or holiday.
  const run = async (fn, msg, reload = loadLists) => {
    try {
      await fn();
      toast(msg);
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const saveLogo = async (logo) => {
    setLogoBusy(true);
    try {
      const saved = await (logo ? api.put('/company/logo', { logo }) : api.del('/company/logo'));
      setSettings((s) => ({ ...s, company_logo_v: saved.company_logo_v })); // keep unsaved policy edits
      await refreshUser();
      toast(logo ? 'Company logo updated' : 'Company logo removed');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setLogoBusy(false);
    }
  };

  if (!settings) return <Loading />;
  return (
    <>
      <PageHead title="Settings" subtitle={isAdmin ? 'Company policy, departments and holidays' : 'Only admins can change attendance policy'} />
      <div className="grid grid-2">
        <div className="card stack">
          <h2>Company &amp; attendance policy</h2>
          <fieldset disabled={!isAdmin} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
            <div className="form-grid">
              <Field label="Company logo" full>
                <LogoPicker
                  value={companyLogoUrl({ company_id: user.company_id, company_logo_v: settings.company_logo_v })}
                  onChange={saveLogo} busy={logoBusy} disabled={!isAdmin || settings.is_demo} onError={(m) => toast(m, 'error')}
                />
              </Field>
              <Field label="Company name" full>
                <input className="input" value={settings.company_name} onChange={set('company_name')} disabled={settings.is_demo} />
              </Field>
              <Field label="Company timezone" full>
                <select className="input" value={settings.timezone} onChange={set('timezone')} disabled={settings.is_demo}>
                  {(zones.includes(settings.timezone) ? zones : [settings.timezone, ...zones]).map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
                </select>
              </Field>
              {settings.is_demo && <div className="small muted full">The shared demo company's name, logo and timezone are fixed. Register your own company to change them.</div>}
              {!settings.is_demo && (
                <Field label="Staff sign-up by company email" full>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="muted" style={{ fontWeight: 700 }}>@</span>
                    <input className="input" value={settings.join_domain || ''} onChange={set('join_domain')} placeholder="yourcompany.com (leave empty to turn off)" />
                  </div>
                  <div className="small muted" style={{ marginTop: 6 }}>
                    Anyone who proves they own an address at this domain (by emailed code, or with Google) can ask to join; they wait in Employees until HR approves.
                    Your own email must be at this domain. For staff on Gmail or other personal emails, share the <b>Join link</b> from Employees instead.
                  </div>
                </Field>
              )}
              <Field label="Shift start"><input type="time" className="input" value={settings.shift_start} onChange={set('shift_start')} /></Field>
              <Field label="Shift end"><input type="time" className="input" value={settings.shift_end} onChange={set('shift_end')} /></Field>
              <Field label="Late grace (minutes)"><input type="number" className="input" value={settings.grace_minutes} onChange={set('grace_minutes')} /></Field>
              <Field label="Half day below (minutes)"><input type="number" className="input" value={settings.half_day_minutes} onChange={set('half_day_minutes')} /></Field>
              <Field label="Saturdays off">
                <select className="input" value={settings.saturdays_off ?? ''} onChange={set('saturdays_off')}>
                  {[['', 'None (all Saturdays working)'], ['2,4', '2nd & 4th Saturdays'], ['1,3', '1st & 3rd Saturdays'], ['1,3,5', '1st, 3rd & 5th Saturdays'], ['1,2,3,4,5', 'Every Saturday']]
                    .map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
              </Field>
              <Field label="About days off"><div className="small muted" style={{ padding: '12px 4px' }}>Sundays are always off. Days off don't count for payroll, leave or attendance.</div></Field>
              <Field label="Max GPS accuracy (m)"><input type="number" min="20" className="input" value={settings.max_gps_accuracy_m ?? 150} onChange={set('max_gps_accuracy_m')} /></Field>
              <Field label="About GPS accuracy"><div className="small muted" style={{ padding: '12px 4px' }}>Check-ins with a rougher location are rejected. Phones usually report ±5–30 m; laptops can be off by kilometres.</div></Field>
              <div className="full leave-policy">
                <div className="leave-policy-head"><b>Leave policy</b><span className="small muted">Days per year, and how many unused days move into next year</span></div>
                <div className="leave-policy-grid">
                  <span className="small muted" />
                  <span className="small muted">Per year</span>
                  <span className="small muted">Carry forward (max)</span>
                  {[['casual', 'Casual'], ['sick', 'Sick'], ['earned', 'Earned']].map(([t, label]) => (
                    <Fragment key={t}>
                      <b className="leave-policy-type">{label}</b>
                      <input type="number" min="0" className="input" aria-label={`${label} leave per year`} value={settings[`quota_${t}`]} onChange={set(`quota_${t}`)} />
                      <input type="number" min="0" className="input" aria-label={`${label} leave carried forward`} value={settings[`carry_${t}`] ?? 0} onChange={set(`carry_${t}`)} />
                    </Fragment>
                  ))}
                </div>
                <div className="small muted">0 to carry forward means unused days end on 31 December.</div>
              </div>
              {settings.comp_off === '1' && (
                <Field label="Comp-off valid for (days)">
                  <input type="number" min="0" className="input" value={settings.comp_off_expiry_days ?? 90} onChange={set('comp_off_expiry_days')} />
                </Field>
              )}
              {settings.comp_off === '1' && <Field label="About comp-off"><div className="small muted" style={{ padding: '12px 4px' }}>Working a Sunday, Saturday off or holiday earns 1 day (½ day for 2 h up to the half-day limit). 0 days = never expires.</div></Field>}
              <Field label="Payroll currency">
                <select className="input" value={settings.currency} onChange={set('currency')}>
                  {['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD'].map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Overtime after (hours worked a day)">
                <input type="number" min="1" max="24" step="0.5" className="input"
                  value={settings.overtime_after_minutes ? Number(settings.overtime_after_minutes) / 60 : 8}
                  onChange={(e) => setSettings((s) => ({ ...s, overtime_after_minutes: String(Math.round(Number(e.target.value) * 60) || 480) }))} />
              </Field>
              <Field label="Professional tax / month"><input type="number" min="0" className="input" value={settings.payroll_pt} onChange={set('payroll_pt')} /></Field>
            </div>
            {[
              ['require_face', 'Require face recognition', 'Employees must pass a live face match to punch'],
              ['require_geofence', 'Require geofence', 'Employees must be inside an assigned zone to punch'],
              ['leave_half_day', 'Allow half-day leave', 'People can take the first or second half of a day off (counts as ½ day)'],
              ['comp_off', 'Comp-off for working a day off', 'Working on a Sunday, Saturday off or holiday earns a comp-off leave day'],
              ['payroll_pf', 'Deduct Provident Fund', 'Payroll deducts 12% of basic pay, capped at 1,800 a month'],
              ['daily_log_email', 'Email daily attendance log', 'Each person gets their day (check-in, breaks, lunch, check-out, hours) at their work email when they punch out'],
              ['email_notifications', 'Email notifications', 'People also get their own notifications by email: leave decisions, new tasks, attendance fixes, payslips'],
              ['tracker_prompt', 'Ask people to install the tracker', 'The dashboard shows a download card on computers until that person’s desktop tracker connects'],
            ].map(([k, title, hint]) => (
              <div key={k} className="check-item">
                <div style={{ flex: 1 }}><b>{title}</b><div className="small muted">{hint}</div></div>
                <Switch on={settings[k] === '1'} onChange={(v) => isAdmin && setSettings((s) => ({ ...s, [k]: v ? '1' : '0' }))} label={title} />
              </div>
            ))}
            {isAdmin && (
              <button className="btn btn-primary" style={{ alignSelf: 'flex-end' }} onClick={() => run(() => api.put('/settings', settings), 'Settings saved', load)}>
                Save policy
              </button>
            )}
          </fieldset>
        </div>

        <div className="stack" style={{ gap: 22 }}>
          <div className="card stack">
            <h2>Departments</h2>
            <div className="row">
              <input className="input" placeholder="New department" value={dept} onChange={(e) => setDept(e.target.value)} />
              <button className="btn btn-primary" disabled={!dept.trim()} onClick={() => run(async () => { await api.post('/departments', { name: dept }); setDept(''); }, 'Department added')}>
                <Icon name="plus" />
              </button>
            </div>
            {departments.map((d) => (
              <div key={d.id} className="check-item">
                <div style={{ flex: 1 }}><b>{d.name}</b><div className="small muted">{d.headcount} active</div></div>
                <button className="btn btn-icon btn-danger" aria-label={`Delete ${d.name}`}
                  onClick={() => confirm(`Delete ${d.name}?`) && run(() => api.del(`/departments/${d.id}`), 'Department deleted')}>
                  <Icon name="trash" size={16} />
                </button>
              </div>
            ))}
          </div>
          <div className="card stack">
            <h2>Holidays</h2>
            <div className="row wrap">
              <input type="date" className="input" style={{ width: 170 }} value={holiday.date} onChange={(e) => setHoliday((h) => ({ ...h, date: e.target.value }))} />
              <input className="input" style={{ flex: 1, minWidth: 140 }} placeholder="Holiday name" value={holiday.name} onChange={(e) => setHoliday((h) => ({ ...h, name: e.target.value }))} />
              <button className="btn btn-primary" disabled={!holiday.date || !holiday.name}
                onClick={() => run(async () => { await api.post('/holidays', holiday); setHoliday({ date: '', name: '' }); }, 'Holiday added')}>
                <Icon name="plus" />
              </button>
            </div>
            {holidays.map((h) => (
              <div key={h.id} className="check-item">
                <div style={{ flex: 1 }}><b>{h.name}</b><div className="small muted">{fmtDate(h.date, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}</div></div>
                <button className="btn btn-icon btn-danger" aria-label={`Delete ${h.name}`} onClick={() => run(() => api.del(`/holidays/${h.id}`), 'Holiday removed')}>
                  <Icon name="trash" size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
