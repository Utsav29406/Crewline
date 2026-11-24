import { useState } from 'react';
import { api, setToken } from '../api.js';
import { useApp } from '../context.jsx';
import Icon from '../components/Icon.jsx';
import FaceCapture from '../components/FaceCapture.jsx';
import Documents from '../components/Documents.jsx';
import { Avatar, Badge, Field, PageHead } from '../components/ui.jsx';
import { fmtDate } from '../format.js';

/** Admins: two-step sign-in (a code emailed at each sign-in on a new device). */
function TwoStep() {
  const { user, refreshUser, toast } = useApp();
  const [stage, setStage] = useState(null); // null | 'code' | 'off'
  const [value, setValue] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn) => {
    setBusy(true);
    try { await fn(); } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  const start = () => run(async () => {
    const r = await api.post('/auth/two-step/start', {});
    setSentTo(r.email);
    setValue('');
    setStage('code');
  });
  const enable = () => run(async () => {
    const r = await api.post('/auth/two-step/enable', { code: value });
    try { if (r.device) localStorage.setItem('crewline.device', r.device); } catch { /* private window */ }
    toast('Two-step sign-in is on');
    setStage(null);
    refreshUser();
  });
  const disable = () => run(async () => {
    await api.post('/auth/two-step/disable', { password: value });
    toast('Two-step sign-in is off');
    setStage(null);
    refreshUser();
  });
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Two-step sign-in</h2>
        <Badge tone={user.two_step ? 'good' : 'muted'}>{user.two_step ? 'On' : 'Off'}</Badge>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        After your password, Crewline emails a 6-digit code to <b>{user.email}</b>, so a stolen password alone can't open the admin account.
        A device you trust can skip the code for 30 days.
      </p>
      {stage === 'code' && (
        <>
          <Field label={`Code sent to ${sentTo}`}>
            <input className="input" inputMode="numeric" maxLength={6} autoFocus value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <div className="row" style={{ gap: 10 }}>
            <button className="btn btn-primary" disabled={busy || value.length !== 6} onClick={enable}>Turn on</button>
            <button className="btn" onClick={() => setStage(null)}>Cancel</button>
          </div>
        </>
      )}
      {stage === 'off' && (
        <>
          <Field label="Your password"><input type="password" className="input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} /></Field>
          <div className="row" style={{ gap: 10 }}>
            <button className="btn btn-danger" disabled={busy || !value} onClick={disable}>Turn off</button>
            <button className="btn" onClick={() => setStage(null)}>Cancel</button>
          </div>
        </>
      )}
      {!stage && (user.two_step
        ? <button className="btn" onClick={() => { setValue(''); setStage('off'); }}>Turn off</button>
        : <button className="btn btn-primary" disabled={busy} onClick={start}><Icon name="shield" /> Turn on (we'll email you a code)</button>)}
    </div>
  );
}

export default function Profile() {
  const { user, refreshUser, toast, isManager } = useApp();
  const [enrolling, setEnrolling] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '' });

  const enroll = async (descriptors) => {
    try {
      await api.post(`/employees/${user.id}/face`, { descriptors });
      toast('Face enrolled — you can now punch in');
      setEnrolling(false);
      refreshUser();
    } catch (err) {
      toast(err.message, 'error');
      setEnrolling(false);
    }
  };

  const changePassword = async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/auth/change-password', pw);
      if (r.token) setToken(r.token); // other devices are signed out; this one carries on
      toast('Password updated. Other devices were signed out.');
      setPw({ current: '', next: '' });
      refreshUser();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  // In the shared demo company anyone may re-enroll, so every visitor can try face check-in.
  const canEnroll = !user.face_enrolled || isManager || user.is_demo;
  const demoLogin = user.is_demo && user.email.endsWith('@crewline.io');
  const info = [
    ['Employee code', user.emp_code], ['Email', user.email], ['Phone', user.phone], ['Department', user.department],
    ['Designation', user.designation], ['Work location', user.geofence || 'Any active geofence'], ['Joined', fmtDate(user.joined_on)],
  ];

  return (
    <>
      <PageHead title="My profile" />
      <div className="grid grid-main">
        <div className="card">
          <div className="row" style={{ marginBottom: 22 }}>
            <Avatar name={user.name} size="lg" />
            <div>
              <h2 style={{ fontSize: 22 }}>{user.name}</h2>
              <div className="row" style={{ gap: 8, marginTop: 4 }}>
                <Badge tone="accent">{user.role}</Badge>
                <Badge status={user.status} />
              </div>
            </div>
          </div>
          <div className="form-grid">
            {info.map(([k, v]) => (
              <div key={k} className="inset" style={{ padding: '12px 16px' }}>
                <div className="small muted">{k}</div>
                <div style={{ fontWeight: 600 }}>{v || '—'}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="stack" style={{ gap: 22 }}>
          <div className="card stack">
            <div className="card-head" style={{ margin: 0 }}>
              <h2>Face ID</h2>
              {user.face_enrolled ? <Badge tone="good">enrolled</Badge> : <Badge tone="warn">not enrolled</Badge>}
            </div>
            {enrolling ? (
              <FaceCapture samples={3} onCapture={enroll} onCancel={() => setEnrolling(false)} actionLabel="Enrollment" />
            ) : (
              <>
                <p className="muted" style={{ margin: 0 }}>
                  {user.face_enrolled
                    ? 'Your face signature is on file. Ask HR if you need to re-enroll (new glasses, beard, etc.).'
                    : 'We capture 3 samples to build your face signature. Use good lighting and look at the camera.'}
                </p>
                {canEnroll && (
                  <button className="btn btn-primary" onClick={() => setEnrolling(true)}>
                    <Icon name="face" /> {user.face_enrolled ? 'Re-enroll face' : 'Enroll my face'}
                  </button>
                )}
              </>
            )}
          </div>
          {demoLogin ? (
            <div className="card stack">
              <h2>Change password</h2>
              <p className="muted" style={{ margin: 0 }}>Demo account passwords are fixed so everyone can sign in. To get a private workspace, sign out and choose <b>Register your workspace</b>.</p>
            </div>
          ) : (
          <form className="card stack" onSubmit={changePassword}>
            <h2>{user.has_password === false ? 'Set a password' : 'Change password'}</h2>
            {user.has_password === false && <p className="small muted" style={{ margin: 0 }}>You signed up with Google. Set a password to also sign in with your email, for example in the desktop tracker.</p>}
            {user.has_password !== false && <Field label="Current password"><input type="password" className="input" autoComplete="current-password" value={pw.current} onChange={(e) => setPw((p) => ({ ...p, current: e.target.value }))} /></Field>}
            <Field label="New password"><input type="password" className="input" autoComplete="new-password" value={pw.next} onChange={(e) => setPw((p) => ({ ...p, next: e.target.value }))} /></Field>
            <button className="btn" disabled={(user.has_password !== false && !pw.current) || pw.next.length < 8}>Update password</button>
          </form>
          )}
          {user.role === 'admin' && !demoLogin && <TwoStep />}
          <div className="card stack">
            <h2 style={{ margin: 0 }}>My documents</h2>
            <p className="small muted" style={{ margin: 0 }}>Your ID proof, offer letter and other papers. Only you and HR can see them.</p>
            <Documents userId={user.id} canDelete={isManager} />
          </div>
        </div>
      </div>
    </>
  );
}
