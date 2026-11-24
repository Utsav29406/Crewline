import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import Icon from '../components/Icon.jsx';
import AuthLayout, { MorphLink } from '../components/AuthLayout.jsx';
import LogoPicker from '../components/LogoPicker.jsx';
import { Field } from '../components/ui.jsx';

const browserZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata'; } catch { return 'Asia/Kolkata'; }
};

const STEPS = [
  { icon: 'building', title: 'Your own private workspace', text: 'Employees, attendance and payroll are completely separate from every other company.' },
  { icon: 'map', title: 'Add your office geofence', text: 'Search your address, set the radius — check-ins only count inside it.' },
  { icon: 'face', title: 'Invite your team', text: 'Add employees; they enroll their face once and punch in from their phone.' },
];

export default function Register() {
  const { register } = useApp();
  const zones = useMemo(() => {
    try { return Intl.supportedValuesOf('timeZone'); } catch { return [browserZone()]; }
  }, []);
  const [form, setForm] = useState({ company_name: '', name: '', email: '', password: '', timezone: browserZone(), logo: null });
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Two steps: the form, then the code emailed to the work email (proves the address belongs to whoever registers).
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const run = async (fn) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const sendCode = (e) => {
    e?.preventDefault();
    run(async () => {
      await api.post('/auth/register/start', form);
      if (codeSent) setNote('A new code is on its way.');
      setCodeSent(true);
    });
  };
  const create = (e) => {
    e.preventDefault();
    run(() => register({ ...form, code }));
  };

  return (
    <AuthLayout title="Set up Crewline" accent="for your company." lead="Free to start. You'll be the admin of a brand-new workspace in under a minute." points={STEPS}>
        {codeSent ? (
          <form className="card auth-card stack" style={{ padding: 32 }} onSubmit={create}>
            <div>
              <h2 style={{ fontSize: 24 }}>Confirm your email</h2>
              <p className="muted" style={{ marginTop: 4, marginBottom: 0 }}>
                We emailed a 6-digit code to <b>{form.email}</b>. Enter it to create <b>{form.company_name}</b>.
              </p>
            </div>
            <Field label="Code">
              <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus required
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                style={{ letterSpacing: 6, fontSize: 20, textAlign: 'center' }} />
            </Field>
            {error && <div className="badge badge-bad" style={{ textTransform: 'none', whiteSpace: 'normal' }}>{error}</div>}
            {note && <div className="badge badge-good" style={{ textTransform: 'none' }}>{note}</div>}
            <button className="btn btn-primary btn-lg btn-block" disabled={busy || code.length !== 6}>
              {busy ? <span className="spin" /> : <Icon name="building" />} Create workspace
            </button>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <button type="button" className="link-btn small" onClick={sendCode} disabled={busy}>Send a new code</button>
              <button type="button" className="link-btn muted small" onClick={() => { setCodeSent(false); setCode(''); setError(''); setNote(''); }}>Change details</button>
            </div>
          </form>
        ) : (
        <form className="card auth-card stack" style={{ padding: 32 }} onSubmit={sendCode}>
          <div>
            <h2 style={{ fontSize: 24 }}>Register your company</h2>
            <p className="muted" style={{ marginTop: 4, marginBottom: 0 }}>Create a workspace and your admin account</p>
          </div>
          <Field label="Company name">
            <input className="input" value={form.company_name} onChange={set('company_name')} placeholder="Acme Pvt. Ltd." autoComplete="organization" required minLength={2} maxLength={80} />
          </Field>
          <Field label="Company logo (optional)">
            <LogoPicker value={form.logo} onChange={(logo) => setForm((f) => ({ ...f, logo }))} onError={setError} />
          </Field>
          <Field label="Your full name">
            <input className="input" value={form.name} onChange={set('name')} autoComplete="name" required minLength={2} />
          </Field>
          <Field label="Work email">
            <input className="input" type="email" value={form.email} onChange={set('email')} autoComplete="email" required />
          </Field>
          <Field label="Password">
            <input className="input" type="password" value={form.password} onChange={set('password')} autoComplete="new-password" required minLength={8} placeholder="At least 8 characters" />
          </Field>
          <Field label="Company timezone">
            <select className="input" value={form.timezone} onChange={set('timezone')}>
              {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
            </select>
          </Field>
          {error && <div className="badge badge-bad" style={{ textTransform: 'none', whiteSpace: 'normal' }}>{error}</div>}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
            {busy ? <span className="spin" /> : <Icon name="send" />} Email me a code
          </button>
          <p className="small muted" style={{ textAlign: 'center', margin: 0 }}>
            Already have an account? <MorphLink to="/">Sign in</MorphLink>
          </p>
        </form>
        )}
    </AuthLayout>
  );
}
