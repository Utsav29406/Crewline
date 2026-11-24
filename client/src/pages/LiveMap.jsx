import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useLive } from '../context.jsx';
import FenceMap from '../components/FenceMap.jsx';
import { Badge, Loading, PageHead, Who } from '../components/ui.jsx';
import { fmtTime } from '../format.js';

// Marker colours follow attendance state (same meaning as the status badges).
const STATE = {
  in: { color: '#12a150', label: 'Checked in' },
  late: { color: '#e08a00', label: 'Checked in late' },
  break: { color: '#2a78d6', label: 'On break' },
  out: { color: '#8a91a8', label: 'Checked out' },
};
const stateOf = (r) => (r.check_out ? 'out' : r.break_type ? 'break' : r.status === 'late' ? 'late' : 'in');

export default function LiveMap() {
  const [rows, setRows] = useState(null);
  const [fences, setFences] = useState([]);
  const [flash, setFlash] = useState(null);

  const load = useCallback(() => Promise.all([api.get('/attendance/live'), api.get('/geofences')]).then(([r, f]) => {
    setRows(r);
    setFences(f);
  }), []);
  useEffect(() => { load(); }, [load]);
  useLive(['attendance', 'geofence', 'employee'], (events) => {
    const latest = events.filter((e) => e.type.startsWith('attendance.check')).at(-1);
    if (latest) {
      setFlash(latest.data?.userId);
      setTimeout(() => setFlash(null), 4000);
    }
    load();
  });

  if (!rows) return <Loading />;
  const punched = rows.filter((r) => r.check_in);
  const people = punched
    .map((r) => {
      const out = Boolean(r.check_out && r.out_lat != null);
      const lat = out ? r.out_lat : r.in_lat;
      const lng = out ? r.out_lng : r.in_lng;
      if (lat == null || lng == null) return null;
      const st = STATE[stateOf(r)];
      return { id: r.id, lat, lng, color: st.color, label: `${r.name} · ${st.label} ${fmtTime(r.check_out || r.check_in)}` };
    })
    .filter(Boolean);
  const notIn = rows.filter((r) => !r.check_in);

  return (
    <>
      <PageHead title="Live map" subtitle="Where your team punched in today — updates automatically">
        <span className="badge badge-good">{punched.filter((r) => !r.check_out).length} on site</span>
        <span className="badge badge-muted">{notIn.length} not in</span>
      </PageHead>
      <div className="grid grid-main">
        <div className="card">
          <FenceMap fences={fences} people={people} height={520} />
          <div className="map-legend">
            {Object.values(STATE).map((s) => <span key={s.label}><i style={{ background: s.color }} />{s.label}</span>)}
            <span><i style={{ background: 'transparent', border: '2px solid #6366f1' }} />Geofence</span>
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Shows the verified punch location only — Crewline doesn't track people between check-in and check-out.
          </p>
        </div>
        <div className="card">
          <div className="card-head"><h2>Today</h2></div>
          <div className="stack" style={{ gap: 10 }}>
            {punched.map((r) => (
              <div key={r.id} className="check-item" style={flash === r.id ? { boxShadow: '0 0 0 2px var(--good)' } : undefined}>
                <Who name={r.name} sub={`${r.geofence || 'Outside zones'} · in ${fmtTime(r.check_in)}${r.check_out ? ` · out ${fmtTime(r.check_out)}` : ''}`} />
                <div className="spacer" />
                {r.check_out ? <Badge tone="muted">out</Badge> : r.break_type ? <Badge tone="info">on {r.break_type === 'lunch' ? 'lunch' : 'break'}</Badge> : <Badge status={r.status} />}
              </div>
            ))}
            {notIn.map((r) => (
              <div key={r.id} className="check-item" style={{ opacity: 0.65 }}>
                <Who name={r.name} sub={r.department || r.designation} />
                <div className="spacer" />
                {r.leave_type ? <Badge tone="accent">{r.leave_type} leave</Badge> : <Badge tone="bad">not in</Badge>}
              </div>
            ))}
            {!rows.length && <div className="empty">No employees yet</div>}
          </div>
        </div>
      </div>
    </>
  );
}
