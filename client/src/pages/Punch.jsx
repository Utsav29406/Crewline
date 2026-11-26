import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp, useLive } from '../context.jsx';
import { isNativeApp, nativeLocation, refreshReminders } from '../native.js';
import Icon from '../components/Icon.jsx';
import FaceCapture from '../components/FaceCapture.jsx';
import FenceMap from '../components/FenceMap.jsx';
import useGeolocation from '../useGeolocation.js';
import { Badge, Loading, Modal, PageHead } from '../components/ui.jsx';
import { fmtDistance, fmtDuration, fmtMinutes, fmtTime, haversine } from '../format.js';

function useNow() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Check({ ok, pending, title, detail }) {
  const tone = pending ? 'info' : ok ? 'good' : 'bad';
  return (
    <div className="check-item">
      <div className={`check-dot badge-${tone}`}>
        {pending ? <span className="spin" style={{ width: 14, height: 14 }} /> : <Icon name={ok ? 'check' : 'x'} size={16} />}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700 }}>{title}</div>
        <div className="small muted">{detail}</div>
      </div>
    </div>
  );
}

export default function Punch() {
  const { user, toast } = useApp();
  const now = useNow();
  const [data, setData] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastError, setLastError] = useState('');

  const load = useCallback(() => api.get('/attendance/today').then((d) => setData({ ...d, receivedAt: Date.now() })), []);
  useEffect(() => { load(); }, [load]);
  useLive(['geofence', 'settings', 'attendance'], load);

  const needGeo = data?.policy.require_geofence;
  const needFace = data?.policy.require_face;
  const geo = useGeolocation(true);

  const nearest = useMemo(() => {
    if (!geo.coords || !data?.fences.length) return null;
    return data.fences
      .map((f) => ({ fence: f, d: Math.round(haversine(geo.coords.lat, geo.coords.lng, f.lat, f.lng)) }))
      .sort((a, b) => a.d - b.d)[0];
  }, [geo.coords, data]);
  const inside = nearest && nearest.d - Math.min(geo.coords.accuracy || 0, 30) <= nearest.fence.radius_m;
  const maxAccuracy = data?.policy.max_gps_accuracy_m ?? 150;
  const precise = geo.coords && geo.coords.accuracy <= maxAccuracy;

  if (!data) return <Loading />;
  const rec = data.record;
  const action = !rec ? 'check-in' : !rec.check_out ? 'check-out' : null;
  const faceReady = !needFace || user.face_enrolled;
  const geoReady = !needGeo || (inside && precise);

  const submit = async (descriptors) => {
    setCapturing(false);
    setBusy(true);
    setLastError('');
    try {
      // In the phone app, take a fresh fix from Android itself: it also says if a fake-GPS app made it.
      const phone = isNativeApp() ? await nativeLocation() : null;
      const where = phone || geo.coords || {};
      await api.post(`/attendance/${action}`, {
        descriptors: descriptors || undefined,
        lat: where.lat,
        lng: where.lng,
        accuracy: where.accuracy,
        ...(phone && { mock: phone.mock, app: 'android' }),
      });
      refreshReminders(true);
      toast(action === 'check-in' ? 'Checked in — have a great day!' : 'Checked out — see you tomorrow!');
      await load();
    } catch (err) {
      setLastError(err.message);
      toast(err.message, 'error');
      load().catch(() => {}); // e.g. already checked in from another device: show the real state
    } finally {
      setBusy(false);
    }
  };

  const start = () => (needFace ? setCapturing(true) : submit(null));
  // Times from the server are company wall-clock strings. Compare them with the company clock (the server's "now"
  // plus the seconds since it answered), not the browser's, which may be in another timezone.
  const wallMs = (s) => Date.parse(`${s.replace(' ', 'T')}Z`);
  const companyNow = data.now ? wallMs(data.now) + (now - data.receivedAt) : now - new Date().getTimezoneOffset() * 60000;
  const minutesSince = (s) => Math.max(Math.round((companyNow - wallMs(s)) / 60000), 0);
  const breaks = data.breaks || [];
  const openBreak = breaks.find((b) => !b.ended_at);
  const breakMinutes = breaks.reduce((sum, b) => sum + (b.ended_at ? b.minutes : minutesSince(b.started_at)), 0);
  const worked = rec?.check_in && !rec.check_out ? Math.max(minutesSince(rec.check_in) - breakMinutes, 0) : rec?.work_minutes;

  const toggleBreak = async (type) => {
    setBusy(true);
    try {
      if (openBreak) {
        await api.post('/attendance/break/end');
        toast('Welcome back — break ended');
      } else {
        await api.post('/attendance/break/start', { type });
        toast(type === 'lunch' ? 'Enjoy your lunch!' : 'Break started');
      }
      await load();
    } catch (err) {
      toast(err.message, 'error');
      load().catch(() => {}); // the tracker or a timer may have ended the break already
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title="Punch In / Out" subtitle={`Shift ${data.policy.shift_start} – ${data.policy.shift_end}`} />
      <div className="grid grid-main">
        <div className="card" style={{ display: 'grid', placeItems: 'center', gap: 22, padding: 32, textAlign: 'center' }}>
          <div>
            <div className="clock">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
            <div className="muted" style={{ marginTop: 6 }}>{now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
          </div>
          <div className="punch-wrap">
            <button className={`punch-btn ${action === 'check-out' ? 'out' : ''}`} disabled={!action || busy || !faceReady || !geoReady} onClick={start}>
              {busy ? <span className="spin" /> : <Icon name={action ? 'face' : 'check'} size={34} />}
              <span>{action === 'check-in' ? 'Check In' : action === 'check-out' ? 'Check Out' : 'Done for today'}</span>
            </button>
          </div>
          {action === 'check-out' && (
            openBreak ? (
              <div className="break-banner">
                <Icon name={openBreak.type === 'lunch' ? 'lunch' : 'coffee'} size={20} />
                <div style={{ textAlign: 'left' }}>
                  <b>On {openBreak.type === 'lunch' ? 'lunch' : 'a short break'}</b>
                  <div className="small muted tnum">since {fmtTime(openBreak.started_at)} · {fmtMinutes(minutesSince(openBreak.started_at))}</div>
                </div>
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => toggleBreak()}>End break</button>
              </div>
            ) : (
              <div className="row wrap" style={{ justifyContent: 'center' }}>
                <button className="btn" disabled={busy} onClick={() => toggleBreak('lunch')}><Icon name="lunch" size={17} /> Lunch break</button>
                <button className="btn" disabled={busy} onClick={() => toggleBreak('break')}><Icon name="coffee" size={17} /> Short break</button>
              </div>
            )
          )}
          <div className="row wrap" style={{ justifyContent: 'center', gap: 28 }}>
            <div><div className="small muted">Check in</div><b className="tnum">{fmtTime(rec?.check_in)}</b></div>
            <div><div className="small muted">Check out</div><b className="tnum">{fmtTime(rec?.check_out)}</b></div>
            <div><div className="small muted">Worked</div><b className="tnum">{fmtDuration(worked)}</b></div>
            {breaks.length > 0 && <div><div className="small muted">Breaks</div><b className="tnum">{fmtMinutes(breakMinutes)}</b></div>}
            {rec && <div><div className="small muted">Status</div><Badge status={rec.status} /></div>}
          </div>
          {lastError && <div className="badge badge-bad" style={{ textTransform: 'none' }}>{lastError}</div>}
        </div>

        <div className="stack" style={{ gap: 22 }}>
          <div className="card stack">
            <h2>Verification</h2>
            {needFace ? (
              <Check ok={user.face_enrolled} title="Face recognition"
                detail={user.face_enrolled ? 'Enrolled · follow two quick gestures to verify' : <>Not enrolled — <Link to="/profile">enroll now</Link></>} />
            ) : <Check ok title="Face recognition" detail="Not required by policy" />}
            {needGeo ? (
              <Check ok={inside && precise} pending={geo.loading}
                title={geo.coords && !precise ? 'Location too imprecise' : inside ? `Inside ${nearest.fence.name}` : 'Geofence'}
                detail={geo.error || (geo.loading ? 'Locating you…'
                  : !precise
                    ? `Your device reports ±${fmtDistance(geo.coords.accuracy)} (needs ±${fmtDistance(maxAccuracy)}). Laptops guess location from Wi-Fi or IP — use your phone, or wait for a better fix.`
                    : nearest
                      ? `${fmtDistance(nearest.d)} from ${nearest.fence.name} · allowed ${fmtDistance(nearest.fence.radius_m)} · GPS ±${fmtDistance(geo.coords.accuracy)}`
                      : 'No geofence assigned to you')} />
            ) : <Check ok title="Geofence" detail="Not required by policy" />}
          </div>
          <div className="card">
            <div className="card-head"><h2>Your location</h2></div>
            <FenceMap fences={data.fences} position={geo.coords} height={280} />
          </div>
        </div>
      </div>

      {capturing && (
        <Modal title={action === 'check-in' ? 'Verify to check in' : 'Verify to check out'} onClose={() => setCapturing(false)} width={520}>
          <FaceCapture samples={3} onCapture={submit} actionLabel={action === 'check-in' ? 'Check-in' : 'Check-out'} />
        </Modal>
      )}
    </>
  );
}
