import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, API_BASE } from '../api.js';
import { GoogleMark } from './Login.jsx';
import Icon from '../components/Icon.jsx';
import AuthLayout, { MorphLink } from '../components/AuthLayout.jsx';
import { Field } from '../components/ui.jsx';

const JOIN_STEPS = [
  { icon: 'send', title: 'Confirm your email', text: 'We email you a 6-digit code, or use Continue with Google.' },
  { icon: 'shield', title: 'HR approves you', text: 'You can sign in as soon as HR lets you in.' },
  { icon: 'face', title: 'Punch in from your phone', text: 'Enroll your face once, then check in at the office.' },
];

/**
 * Staff sign-up: email → emailed code + name + password → waits for HR approval.
 * /join works for companies that turned on their email domain; /join/<code> is HR's join link and takes any email.
 */
export default function Join() {
  const { code: link } = useParams();
  const [linkCompany, setLinkCompany] = useState('');
  const [linkError, setLinkError] = useState('');
  const [google, setGoogle] = useState(false);
  const [step, setStep] = useState('email'); // email → details → done
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [form, setForm] = useState({ code: '', name: '', password: '' });
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get('/auth/providers').then((p) => setGoogle(Boolean(p.google))).catch(() => {});
    if (link) api.get(`/auth/join/link/${encodeURIComponent(link)}`).then((r) => setLinkCompany(r.company)).catch((err) => setLinkError(err.message));
  }, [link]);
  const googleUrl = `${API_BASE}/auth/google/start?ret=${encodeURIComponent(window.location.origin)}&join=${encodeURIComponent(link || '')}`;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: k === 'code' ? e.target.value.replace(/\D/g, '') : e.target.value }));

  const go = (fn) => async (e) => {
    e?.preventDefault();
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
  const sendCode = go(async () => {
    const r = await api.post('/auth/join/start', { email, link });
    setCompany(r.company);
    setStep('details');
  });
  const resend = go(async () => {
    await api.post('/auth/join/start', { email, link });
    setNote('A new code is on its way.');
  });
  const finish = go(async () => {
    const r = await api.post('/auth/join/finish', { email, link, ...form });
    setCompany(r.company);
    setStep('done');
  });

  return (
    <AuthLayout title={linkCompany ? `Join ${linkCompany}` : 'Join your team'} accent="on Crewline." points={JOIN_STEPS}
      lead="Sign up in a minute. HR approves your request, then you punch in from your phone.">
      <div className="card auth-card" style={{ padding: 32 }}>
        {link && linkError ? (
          <div className="stack" style={{ textAlign: 'center', alignItems: 'center' }}>
            <div className="stat-icon tone-bad" style={{ width: 56, height: 56 }}><Icon name="alert" /></div>
            <h2 style={{ fontSize: 22, margin: 0 }}>Link not active</h2>
            <p className="muted" style={{ margin: 0 }}>{linkError}</p>
            <MorphLink to="/" className="btn btn-block" style={{ marginTop: 8 }}>Back to sign in</MorphLink>
          </div>
        ) : step === 'done' ? (
          <div className="stack" style={{ textAlign: 'center', alignItems: 'center' }}>
            <div className="stat-icon tone-good" style={{ width: 56, height: 56 }}><Icon name="check" /></div>
            <h2 style={{ fontSize: 22, margin: 0 }}>Request sent</h2>
            <p className="muted" style={{ margin: 0 }}>
              HR at <b>{company}</b> will review it. We'll email <b>{email}</b> when you're approved, then you can sign in.
            </p>
            <MorphLink to="/" className="btn btn-block" style={{ marginTop: 8 }}>Back to sign in</MorphLink>
          </div>
        ) : (
          <>
            <h2 style={{ fontSize: 24 }}>{linkCompany ? `Join ${linkCompany}` : 'Join your team'}</h2>
            <p className="muted" style={{ marginTop: 4 }}>
              {step !== 'email' ? <>Joining <b>{company}</b> as {email}</>
                : link ? 'Sign up with the email you use every day, Gmail included. HR approves your request.'
                : 'Sign up with your company email address.'}
            </p>
            {step === 'email' ? (
              <form className="stack" style={{ marginTop: 22 }} onSubmit={sendCode}>
                {link && google && (
                  <>
                    <a className="btn btn-block btn-google" href={googleUrl}><GoogleMark /> Continue with Google</a>
                    <div className="or-line small muted">or sign up with email</div>
                  </>
                )}
                <Field label={link ? 'Email' : 'Work email'}>
                  <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={link ? 'you@gmail.com' : 'name@yourcompany.com'} autoFocus required />
                </Field>
                {error && <div className="badge badge-bad" style={{ textTransform: 'none' }}>{error}</div>}
                <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
                  {busy ? <span className="spin" /> : <Icon name="send" />} Email me a code
                </button>
                {!link && (
                  <p className="small muted" style={{ margin: 0 }}>
                    Using Gmail or another personal email? Ask HR for your company's join link, or to invite you.
                  </p>
                )}
              </form>
            ) : (
              <form className="stack" style={{ marginTop: 22 }} onSubmit={finish}>
                <Field label={`Code we emailed to ${email}`}>
                  <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus required
                    value={form.code} onChange={set('code')} style={{ letterSpacing: 6, fontSize: 20, textAlign: 'center' }} />
                </Field>
                <Field label="Full name"><input className="input" autoComplete="name" value={form.name} onChange={set('name')} required /></Field>
                <Field label="Choose a password">
                  <input className="input" type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={set('password')} placeholder="At least 8 characters" required />
                </Field>
                {error && <div className="badge badge-bad" style={{ textTransform: 'none' }}>{error}</div>}
                {note && <div className="badge badge-good" style={{ textTransform: 'none' }}>{note}</div>}
                <button className="btn btn-primary btn-lg btn-block" disabled={busy || form.code.length !== 6}>
                  {busy ? <span className="spin" /> : <Icon name="check" />} Ask to join
                </button>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <button type="button" className="link-btn small" onClick={resend} disabled={busy}>Send a new code</button>
                  <button type="button" className="link-btn muted small" onClick={() => { setStep('email'); setError(''); setNote(''); }}>Use another email</button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
      <p className="auth-switch small muted">Already have an account? <MorphLink to="/">Sign in</MorphLink></p>
    </AuthLayout>
  );
}
