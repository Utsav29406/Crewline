import { useEffect, useState } from 'react';
import { api, API_BASE } from '../api.js';
import { Link } from 'react-router-dom';
import { useApp } from '../context.jsx';
import Icon from '../components/Icon.jsx';
import Logo from '../components/Logo.jsx';
import { Field } from '../components/ui.jsx';
import { isNativeApp } from '../native.js';

const DEMO = [
  { label: 'Admin', email: 'admin@crewline.io', password: 'admin123' },
  { label: 'HR', email: 'hr@crewline.io', password: 'hr1234' },
  { label: 'Employee', email: 'arjun@crewline.io', password: 'employee123' },
];

const FEATURES = [
  { icon: 'face', title: 'Face recognition', text: 'Contactless punch-in with on-device recognition and blink liveness.' },
  { icon: 'map', title: 'Geofencing', text: 'Attendance only counts inside your office perimeter.' },
  { icon: 'chart', title: 'Payroll ready', text: 'Monthly attendance, leave and payable-days reports.' },
];

/** Google's "G" mark, as its sign-in button guidelines ask. */
export function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** Reads (and clears) what the Google sign-in left in the page address: #g=<ticket> or #g_error=<message>. */
function takeGoogleResult() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const ticket = params.get('g');
  const error = params.get('g_error');
  if (ticket || error) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return { ticket, error };
}

export default function Login() {
  const { login, verifyCode, finishGoogle } = useApp();
  const [google, setGoogle] = useState(false);
  const [step, setStep] = useState(null); // { ticket, email } once a sign-in code was emailed
  const [code, setCode] = useState('');
  const [remember, setRemember] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const { ticket, error: googleError } = takeGoogleResult();
    if (googleError) setError(googleError);
    if (ticket) {
      setBusy(true);
      finishGoogle(ticket).catch((err) => { setError(err.message); setBusy(false); });
    }
    // Google refuses sign-in inside apps' built-in browsers, so the phone app signs in with email and password.
    if (!isNativeApp()) api.get('/auth/providers').then((p) => setGoogle(Boolean(p.google))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const googleUrl = `${API_BASE}/auth/google/start?ret=${encodeURIComponent(window.location.origin)}`;

  /** Demo buttons sign straight in. */
  const tryDemo = async (d) => {
    setBusy(true);
    setError('');
    try {
      await login(d.email, d.password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (step) {
        await verifyCode(step.ticket, code, remember);
      } else {
        const next = await login(email, password);
        if (next) setStep(next);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <section className="auth-hero">
        <div className="brand" style={{ padding: 0 }}>
          <Logo />
          <div>
            <div className="brand-name">Crewline</div>
            <div className="brand-sub">Smart HRMS</div>
          </div>
        </div>
        <div>
          <h1>Your people,<br /><span className="grad">verified in a glance.</span></h1>
          <p className="muted" style={{ fontSize: 16, maxWidth: 460 }}>
            Attendance, leave and payroll in one soft, calm workspace — secured by face recognition and geofencing.
          </p>
        </div>
        <div className="stack features">
          {FEATURES.map((f) => (
            <div key={f.title} className="feature">
              <div className="stat-icon tone-accent" style={{ width: 46, height: 46 }}><Icon name={f.icon} /></div>
              <div>
                <h3>{f.title}</h3>
                <div className="muted">{f.text}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="auth-form">
        <div className="card auth-card" style={{ padding: 32 }}>
          <h2 style={{ fontSize: 24 }}>Welcome back</h2>
          <p className="muted" style={{ marginTop: 4 }}>Sign in to your workspace</p>
          {step ? (
            <form className="stack" style={{ marginTop: 22 }} onSubmit={submit}>
              <p className="small" style={{ margin: 0 }}>We emailed a 6-digit code to <b>{step.email}</b>. It works for 10 minutes.</p>
              <Field label="Sign-in code">
                <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus
                  value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} style={{ letterSpacing: 6, fontSize: 20, textAlign: 'center' }} required />
              </Field>
              <label className="row small" style={{ gap: 8 }}>
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Don't ask again on this device for 30 days
              </label>
              {error && <div className="badge badge-bad" style={{ textTransform: 'none' }}>{error}</div>}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy || code.length !== 6}>
                {busy ? <span className="spin" /> : <Icon name="shield" />} Verify and sign in
              </button>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <button type="button" className="link-btn small" onClick={() => api.post('/auth/login/resend', { ticket: step.ticket })
                  .then(() => setError('A new code is on its way.')).catch((err) => setError(err.message))}>Send a new code</button>
                <button type="button" className="link-btn muted small" onClick={() => { setStep(null); setCode(''); setError(''); }}>Back</button>
              </div>
            </form>
          ) : (
          <>
            {google && (
              <>
                <a className={`btn btn-block btn-google${busy ? ' disabled' : ''}`} href={googleUrl} aria-disabled={busy} style={{ marginTop: 22 }}>
                  <GoogleMark /> Continue with Google
                </a>
                <div className="or-line small muted">or sign in with work email</div>
              </>
            )}
            <form className="stack" style={{ marginTop: google ? 0 : 22 }} onSubmit={submit}>
              <Field label="Work email">
                <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </Field>
              <Field label="Password">
                <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </Field>
              {error && <div className="badge badge-bad" style={{ textTransform: 'none' }}>{error}</div>}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
                {busy ? <span className="spin" /> : <Icon name="login" />} Sign in
              </button>
            </form>
          </>
          )}
          <div className="auth-register">
            <Link to="/join" className="auth-tile">
              <span className="small muted">Joining a team?</span>
              <b>Sign up <Icon name="arrow" size={14} /></b>
            </Link>
            <Link to="/register" className="auth-tile">
              <span className="small muted">New company?</span>
              <b>Register it <Icon name="arrow" size={14} /></b>
            </Link>
          </div>
          <div className="auth-demo">
            <div className="small muted">Try the demo company</div>
            <div className="auth-demo-chips">
              {DEMO.map((d) => (
                <button key={d.email} type="button" className="chip" title={d.email} disabled={busy}
                  onClick={() => { setEmail(d.email); setPassword(d.password); setStep(null); tryDemo(d); }}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="auth-legal small muted">
          <Link to="/privacy">Privacy Policy</Link>
          <span aria-hidden="true">·</span>
          <Link to="/terms">Terms of Service</Link>
        </div>
      </section>
    </div>
  );
}
