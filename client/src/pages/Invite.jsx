import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import Icon from '../components/Icon.jsx';
import Logo from '../components/Logo.jsx';
import { Field, Loading } from '../components/ui.jsx';

/** Opened from an HR invite email: choose a password and you're signed in. */
export default function Invite() {
  const { acceptInvite } = useApp();
  const navigate = useNavigate();
  const token = new URLSearchParams(window.location.search).get('token') || '';
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get(`/auth/invite?token=${encodeURIComponent(token)}`).then(setInfo).catch((err) => setInfo({ dead: err.message }));
  }, [token]);

  const submit = async (e) => {
    e.preventDefault();
    if (password !== confirm) return setError("The two passwords don't match");
    setBusy(true);
    setError('');
    try {
      await acceptInvite(token, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="auth-solo">
      <Link to="/" className="brand auth-solo-brand"><Logo /><div className="brand-name">Crewline</div></Link>
      <div className="card auth-card" style={{ padding: 32 }}>
        {!info ? <Loading /> : info.dead ? (
          <div className="stack">
            <h2 style={{ fontSize: 22, margin: 0 }}>This link no longer works</h2>
            <p className="muted" style={{ margin: 0 }}>{info.dead}</p>
            <Link to="/" className="btn btn-primary btn-block">Go to sign in</Link>
          </div>
        ) : (
          <>
            <h2 style={{ fontSize: 24 }}>Welcome to {info.company}</h2>
            <p className="muted" style={{ marginTop: 4 }}>Hi {info.name}, choose a password for <b>{info.email}</b>.</p>
            <form className="stack" style={{ marginTop: 22 }} onSubmit={submit}>
              <Field label="New password">
                <input className="input" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" autoFocus required />
              </Field>
              <Field label="Type it again">
                <input className="input" type="password" autoComplete="new-password" minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
              </Field>
              {error && <div className="badge badge-bad" style={{ textTransform: 'none' }}>{error}</div>}
              <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
                {busy ? <span className="spin" /> : <Icon name="login" />} Set password and sign in
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
