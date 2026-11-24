import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp, useLive } from '../context.jsx';
import Icon from '../components/Icon.jsx';
import FenceMap from '../components/FenceMap.jsx';
import { Badge, Field, PageHead, Switch } from '../components/ui.jsx';
import { fmtDistance } from '../format.js';

const BLANK = { name: '', lat: '', lng: '', radius_m: 150, active: true };
const BEST_FIX_WAIT_MS = 10000;
const GOOD_ACCURACY_M = 30;
const POOR_ACCURACY_M = 150;

/** Watches GPS for up to 10 s and resolves with the most precise fix (stops early once it's good). */
function bestPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation is not supported'));
    let best = null;
    const finish = () => {
      navigator.geolocation.clearWatch(id);
      clearTimeout(timer);
      best ? resolve(best) : reject(new Error('Could not read your location'));
    };
    const id = navigator.geolocation.watchPosition(
      (p) => {
        if (!best || p.coords.accuracy < best.accuracy) {
          best = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) };
        }
        if (best.accuracy <= GOOD_ACCURACY_M) finish();
      },
      (err) => { if (!best) { navigator.geolocation.clearWatch(id); clearTimeout(timer); reject(new Error(err.code === 1 ? 'Location permission denied' : 'Could not read your location')); } },
      { enableHighAccuracy: true, maximumAge: 0, timeout: BEST_FIX_WAIT_MS }
    );
    const timer = setTimeout(finish, BEST_FIX_WAIT_MS);
  });
}

export default function Geofences() {
  const { toast } = useApp();
  const [fences, setFences] = useState([]);
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState(null);
  const [locating, setLocating] = useState(false);
  const [fix, setFix] = useState(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  const load = () => api.get('/geofences').then(setFences);
  useEffect(() => { load(); }, []);
  useLive(['geofence', 'employee'], load);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  // Only a complete pair of numbers: a half-typed "-" is NaN, and the map can't draw NaN.
  const hasPoint = form.lat !== '' && form.lng !== '' && Number.isFinite(Number(form.lat)) && Number.isFinite(Number(form.lng));
  const draft = hasPoint ? { lat: Number(form.lat), lng: Number(form.lng), radius_m: Number(form.radius_m) || 0 } : null;

  const placeAt = (lat, lng) => {
    setForm((f) => ({ ...f, lat: lat.toFixed(6), lng: lng.toFixed(6) }));
    setFocus({ lat, lng, radius: Number(form.radius_m) || 150 });
  };

  const useMyLocation = async () => {
    setLocating(true);
    try {
      const p = await bestPosition();
      setFix(p);
      placeAt(p.lat, p.lng);
      if (p.accuracy > POOR_ACCURACY_M) {
        toast(`Your device's location is only accurate to ±${fmtDistance(p.accuracy)} — search the address or drag the pin instead`, 'error');
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setLocating(false);
    }
  };

  const search = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(query.trim())}`;
      const rows = await (await fetch(url, { headers: { 'Accept-Language': navigator.language || 'en' } })).json();
      setResults(rows);
      if (!rows.length) toast('No matching place found', 'error');
    } catch {
      toast('Address search is unavailable right now', 'error');
    } finally {
      setSearching(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      form.id ? await api.put(`/geofences/${form.id}`, form) : await api.post('/geofences', form);
      toast(form.id ? 'Geofence updated' : 'Geofence created');
      setForm(BLANK);
      setFix(null);
      load();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (f) => {
    if (!confirm(`Delete geofence "${f.name}"? ${f.assigned} employees will fall back to any active geofence.`)) return;
    try {
      await api.del(`/geofences/${f.id}`);
      toast('Geofence deleted');
      if (form.id === f.id) setForm(BLANK);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <>
      <PageHead title="Geofences" subtitle="Employees can only punch in inside these zones" />
      <div className="grid grid-main">
        <div className="card">
          <div className="card-head">
            <h2>Map</h2>
            <span className="small muted">Click the map or drag the pin to place {form.id ? 'the selected' : 'a new'} zone</span>
          </div>
          <form className="row" style={{ marginBottom: 14 }} onSubmit={search}>
            <input className="input" placeholder="Search an address or place, e.g. office building, street, city" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button className="btn" disabled={searching || !query.trim()}>{searching ? <span className="spin" /> : <Icon name="search" />} Search</button>
          </form>
          {results.length > 0 && (
            <div className="search-results" style={{ marginBottom: 14 }}>
              {results.map((r) => (
                <button key={r.place_id} className="btn btn-sm" onClick={() => { placeAt(Number(r.lat), Number(r.lon)); setResults([]); }}>
                  <Icon name="map" size={15} /> {r.display_name}
                </button>
              ))}
            </div>
          )}
          <FenceMap fences={fences.filter((f) => f.id !== form.id)} draft={draft} focus={focus}
            position={fix} onPick={({ lat, lng }) => setForm((f) => ({ ...f, lat: lat.toFixed(6), lng: lng.toFixed(6) }))} height={460} />
          {fix && (
            <p className={`small ${fix.accuracy > POOR_ACCURACY_M ? 'tone-bad' : 'muted'}`} style={{ marginBottom: 0 }}>
              Your location fix: ±{fmtDistance(fix.accuracy)}
              {fix.accuracy > POOR_ACCURACY_M && ' — too rough to place a zone. Laptops guess location from Wi-Fi/IP; search the address or drag the pin.'}
            </p>
          )}
        </div>
        <div className="stack" style={{ gap: 22 }}>
          <div className="card stack">
            <h2>{form.id ? 'Edit zone' : 'New zone'}</h2>
            <Field label="Name"><input className="input" value={form.name} onChange={set('name')} placeholder="Head Office" /></Field>
            <div className="form-grid">
              <Field label="Latitude"><input className="input" value={form.lat} onChange={set('lat')} /></Field>
              <Field label="Longitude"><input className="input" value={form.lng} onChange={set('lng')} /></Field>
            </div>
            <Field label={`Radius — ${form.radius_m} m`}>
              <input type="range" min="25" max="2000" step="25" value={form.radius_m} onChange={set('radius_m')} style={{ accentColor: 'var(--accent)' }} />
            </Field>
            <div className="row">
              <Switch on={form.active} onChange={(v) => setForm((f) => ({ ...f, active: v }))} label="Active" />
              <span style={{ fontWeight: 600 }}>Active</span>
            </div>
            <div className="row wrap">
              <button className="btn" onClick={useMyLocation} disabled={locating}>
                {locating ? <span className="spin" /> : <Icon name="crosshair" />} {locating ? 'Getting best fix…' : 'Use my location'}
              </button>
              <div className="spacer" />
              {form.id && <button className="btn" onClick={() => { setForm(BLANK); setFix(null); }}>Cancel</button>}
              <button className="btn btn-primary" disabled={busy || !form.name || !hasPoint} onClick={save}>{form.id ? 'Save' : 'Create'}</button>
            </div>
          </div>
          <div className="card stack">
            <h2>Zones</h2>
            {fences.map((f) => (
              <div key={f.id} className="check-item">
                <div className="check-dot badge-accent"><Icon name="map" size={16} /></div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{f.name} {!f.active && <Badge status="inactive" />}</div>
                  <div className="small muted">{fmtDistance(f.radius_m)} · {f.assigned} assigned</div>
                </div>
                <div className="spacer" />
                <button className="btn btn-icon" aria-label="Edit"
                  onClick={() => { setForm({ ...f }); setFocus({ lat: f.lat, lng: f.lng, radius: f.radius_m }); }}>
                  <Icon name="edit" size={16} />
                </button>
                <button className="btn btn-icon btn-danger" aria-label="Delete" onClick={() => remove(f)}><Icon name="trash" size={16} /></button>
              </div>
            ))}
            {!fences.length && <div className="muted">No geofences yet — click the map to add one.</div>}
          </div>
        </div>
      </div>
    </>
  );
}
