import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../context.jsx';
import { Avatar, Badge, Modal, PageHead } from '../components/ui.jsx';
import Icon from '../components/Icon.jsx';
import { addDays, fmtDate, fmtMinutes, isoDate } from '../format.js';

// Wall-clock helpers for the server's 'YYYY-MM-DD HH:MM:SS' strings.
const minuteOf = (dt) => Number(dt.slice(11, 13)) * 60 + Number(dt.slice(14, 16));
const clockLabel = (m) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')}`;
const hourLabel = (h) => `${((h + 11) % 12) + 1} ${h < 12 ? 'am' : 'pm'}`;
const shotTime = (dt) => `${clockLabel(minuteOf(dt))}:${dt.slice(17, 19)}`;
const tone = (a) => (a == null ? 'muted' : a >= 60 ? 'good' : a >= 40 ? 'warn' : 'bad');
const trackerOn = (seen, now) => seen && now && seen.slice(0, 10) === now.slice(0, 10) && minuteOf(now) - minuteOf(seen) <= 2;

/** Loads a screenshot through the API (it needs the sign-in token) once it scrolls into view. */
function Shot({ id, onOpen, alt }) {
  const ref = useRef(null);
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let url;
    let cancelled = false;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      api.blobUrl(`/tracker/screenshots/${id}/image`).then((u) => {
        if (cancelled) return URL.revokeObjectURL(u); // scrolled away before it arrived
        url = u;
        setSrc(u);
      }).catch(() => {});
    }, { rootMargin: '200px' });
    if (ref.current) io.observe(ref.current);
    return () => {
      cancelled = true;
      io.disconnect();
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  return (
    <div ref={ref} className="shot-img">
      {src ? <img src={src} alt={alt} onClick={onOpen} /> : <span className="spin" />}
    </div>
  );
}

/** One row per hour, four 15-minute slots: a screenshot, a break, or a gap where the tracker wasn't running. */
function buildHours(day) {
  const { record, breaks, screenshots, now, date } = day;
  if (!record) return [];
  const start = minuteOf(record.check_in);
  const isToday = now.slice(0, 10) === date;
  const end = record.check_out ? minuteOf(record.check_out) : isToday ? minuteOf(now) : 24 * 60;
  const spans = breaks.map((b) => ({
    ...b, from: minuteOf(b.started_at), to: b.ended_at ? minuteOf(b.ended_at) : end,
  }));
  const hours = [];
  for (let h = Math.floor(start / 60); h * 60 < end; h++) {
    const slots = [];
    for (let q = 0; q < 4; q++) {
      const from = h * 60 + q * 15;
      const to = from + 15;
      const shots = screenshots.filter((s) => minuteOf(s.taken_at) >= from && minuteOf(s.taken_at) < to);
      if (shots.length) slots.push(...shots.map((s) => ({ kind: 'shot', shot: s })));
      else if (to <= start || from >= end) slots.push({ kind: from >= end && isToday && !record.check_out ? 'later' : 'off' });
      else {
        const brk = spans.find((b) => b.from < to && b.to > from && Math.min(b.to, to) - Math.max(b.from, from) >= 8);
        slots.push(brk ? { kind: 'break', brk } : { kind: 'missing' });
      }
    }
    const withShots = slots.filter((s) => s.kind === 'shot');
    const avg = withShots.length ? Math.round(withShots.reduce((a, s) => a + (s.shot.activity ?? 0), 0) / withShots.length) : null;
    hours.push({ h, slots, avg });
  }
  return hours;
}

function Timeline({ day }) {
  const { record, breaks, screenshots, now, date } = day;
  if (!record) return null;
  const startM = minuteOf(record.check_in);
  const endM = record.check_out ? minuteOf(record.check_out) : now.slice(0, 10) === date ? minuteOf(now) : startM;
  const lo = Math.min(9 * 60, Math.floor(startM / 60) * 60);
  const hi = Math.max(19 * 60, Math.ceil(endM / 60) * 60);
  const pct = (m) => `${((m - lo) / (hi - lo)) * 100}%`;
  const w = (a, b) => `${((Math.max(b, a) - a) / (hi - lo)) * 100}%`;
  const ticks = [];
  for (let m = lo; m <= hi; m += 120) ticks.push(m);
  return (
    <div className="tl">
      <div className="tl-bar">
        <i className="tl-work" style={{ left: pct(startM), width: w(startM, endM) }} />
        {breaks.map((b) => {
          const f = minuteOf(b.started_at);
          const t = b.ended_at ? minuteOf(b.ended_at) : endM;
          return <i key={b.id} className={`tl-break ${b.source === 'tracker' ? 'away' : ''}`} style={{ left: pct(f), width: w(f, t) }} />;
        })}
        {screenshots.filter((s) => s.idle).map((s) => {
          const m = minuteOf(s.taken_at);
          return <i key={s.id} className="tl-idle" style={{ left: pct(m - 5), width: w(m - 5, m + 5) }} />;
        })}
      </div>
      <div className="tl-axis tnum">{ticks.map((m) => <span key={m}>{hourLabel(m / 60)}</span>)}</div>
      <div className="tl-legend small">
        <span><i className="tl-work" />Working</span>
        <span><i className="tl-idle" />Idle</span>
        <span><i className="tl-break" />Lunch or break</span>
        <span><i className="tl-break away" />Tracker closed</span>
      </div>
    </div>
  );
}

export default function Activity() {
  const { isManager, user, toast } = useApp();
  const [date, setDate] = useState(isoDate());
  const [summary, setSummary] = useState(null);
  const [selected, setSelected] = useState(isManager ? null : user.id);
  const [day, setDay] = useState(null);
  const [open, setOpen] = useState(null);
  const [tick, setTick] = useState(0);

  // Today refreshes every minute so new screenshots appear on their own.
  useEffect(() => {
    if (date !== isoDate()) return undefined;
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, [date]);
  useEffect(() => {
    if (!isManager) return;
    let current = true;
    api.get(`/tracker/summary?date=${date}`).then((s) => {
      if (!current) return;
      setSummary(s);
      setSelected((cur) => cur ?? s.people.find((p) => p.check_in)?.id ?? s.people[0]?.id ?? null);
    });
    return () => { current = false; };
  }, [isManager, date, tick]);
  useEffect(() => {
    if (!selected) return;
    // Only the latest pick: a slow answer for the previous person must not show under the new one.
    let current = true;
    api.get(`/tracker/day?date=${date}&user_id=${selected}`).then((d) => current && setDay(d));
    return () => { current = false; };
  }, [selected, date, tick]);

  const hours = useMemo(() => (day ? buildHours(day) : []), [day]);
  const shots = day?.screenshots || [];
  const avg = shots.length ? Math.round(shots.reduce((a, s) => a + (s.activity ?? 0), 0) / shots.length) : null;
  // Still checked in: time so far (to now today, to the end of the day for an earlier day), less breaks,
  // counting a break that is still running up to that point.
  const isToday = day?.now?.slice(0, 10) === date;
  const until = isToday ? minuteOf(day?.now || '') : 24 * 60;
  const breakMin = (day?.breaks || []).reduce((a, b) => a + (b.ended_at ? (b.minutes || 0) : Math.max(until - minuteOf(b.started_at), 0)), 0);
  const worked = day?.record
    ? day.record.check_out ? day.record.work_minutes : Math.max(until - minuteOf(day.record.check_in) - breakMin, 0)
    : 0;
  const openIdx = open ? shots.findIndex((s) => s.id === open) : -1;

  const remove = async (id) => {
    try {
      await api.del(`/tracker/screenshots/${id}`);
      toast('Screenshot deleted');
      setOpen(null);
      setTick((n) => n + 1);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <>
      <PageHead title="Activity" subtitle={isManager ? 'Screenshots and activity from the Crewline desktop app' : 'Your screenshots from the Crewline desktop app'}>
        <div className="row">
          <button className="btn btn-icon" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day"><Icon name="arrow" size={16} style={{ transform: 'rotate(180deg)' }} /></button>
          <input type="date" className="input" value={date} max={isoDate()} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="Day" />
          <button className="btn btn-icon" onClick={() => setDate(addDays(date, 1))} disabled={date >= isoDate()} aria-label="Next day"><Icon name="arrow" size={16} /></button>
        </div>
      </PageHead>

      <div className={isManager ? 'activity-layout' : ''}>
        {isManager && (
          <div className="card activity-people">
            <div className="small muted activity-people-head">{summary ? `${summary.people.filter((p) => p.check_in).length} checked in · ${fmtDate(date, { weekday: 'short', day: 'numeric', month: 'short' })}` : 'Loading…'}</div>
            {summary?.people.map((p) => (
              <button key={p.id} className={`activity-person ${p.id === selected ? 'active' : ''}`} onClick={() => setSelected(p.id)}>
                <Avatar name={p.name} />
                <span className="activity-person-text">
                  <b>{p.name}</b>
                  <span className="small muted">
                    {!p.check_in ? 'Not checked in' : `${p.screenshots} screenshot${p.screenshots === 1 ? '' : 's'}`}
                    {trackerOn(p.tracker_seen_at, summary.now) && <span className="tracker-dot" title="Desktop app running" />}
                  </span>
                </span>
                {p.activity != null && <span className={`activity-pct tone-${tone(p.activity)}`}>{p.activity}%</span>}
              </button>
            ))}
          </div>
        )}

        <div className="card">
          {!day ? (
            <div className="empty">Choose an employee</div>
          ) : (
            <>
              <div className="card-head">
                <div>
                  <h2 style={{ margin: 0 }}>{day.person.name}</h2>
                  <div className="muted small">
                    {[day.person.designation, day.record ? `checked in ${clockLabel(minuteOf(day.record.check_in))}` : null,
                      day.record?.check_out ? `out ${clockLabel(minuteOf(day.record.check_out))}` : null].filter(Boolean).join(' · ')}
                  </div>
                </div>
                {trackerOn(day.person.tracker_seen_at, day.now)
                  ? <Badge tone="good">Desktop app running</Badge>
                  : <Badge tone="muted">Desktop app not running</Badge>}
              </div>

              {!day.record ? (
                <div className="empty">No attendance on this day</div>
              ) : (
                <>
                  <div className="activity-stats tnum">
                    <div><span>Worked</span><b>{fmtMinutes(worked)}</b></div>
                    <div><span>Avg activity</span><b className={`tone-${tone(avg)}`}>{avg == null ? '—' : `${avg}%`}</b></div>
                    <div><span>Breaks</span><b>{fmtMinutes(breakMin)}</b></div>
                    <div><span>Screenshots</span><b>{shots.length}</b></div>
                  </div>
                  <Timeline day={day} />
                  {!shots.length && (
                    <p className="muted small" style={{ marginBottom: 0 }}>
                      No screenshots yet. They appear here once the Crewline desktop app is running on {isManager ? 'their' : 'your'} computer.
                    </p>
                  )}
                  <div className="activity-hours">
                    {hours.map(({ h, slots, avg: ha }) => (
                      <div key={h} className="activity-hour">
                        <div className="activity-hour-label tnum">{hourLabel(h)}<span className="small muted">{ha == null ? '' : `${ha}% active`}</span></div>
                        <div className="activity-slots">
                          {slots.map((s, i) => {
                            if (s.kind === 'shot') {
                              const a = s.shot.activity;
                              return (
                                <div key={s.shot.id} className="activity-slot">
                                  <Shot id={s.shot.id} onOpen={() => setOpen(s.shot.id)} alt={`Screenshot at ${shotTime(s.shot.taken_at)}`} />
                                  {s.shot.idle && <span className="badge badge-warn activity-idle">Idle</span>}
                                  <div className="row small tnum" style={{ justifyContent: 'space-between' }}>
                                    <b>{shotTime(s.shot.taken_at)}</b>
                                    <span className={`tone-${tone(a)}`} style={{ fontWeight: 800 }}>{a == null ? '—' : `${a}%`}</span>
                                  </div>
                                  <div className="activity-meter"><i className={`bg-${tone(a)}`} style={{ width: `${a ?? 0}%` }} /></div>
                                </div>
                              );
                            }
                            const text = {
                              off: '', later: '',
                              missing: 'No screenshot · app not running',
                              break: s.brk?.source === 'tracker' ? 'Tracker closed · on break' : s.brk?.source === 'idle' ? 'Idle · short break' : s.brk?.type === 'lunch' ? 'Lunch · not captured' : 'Break · not captured',
                            }[s.kind];
                            return <div key={`${h}-${i}`} className={`activity-slot empty-slot ${s.kind}`}>{text}</div>;
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {openIdx >= 0 && (
        <Modal
          title={`${day.person.name} · ${shotTime(shots[openIdx].taken_at)}`}
          width={980}
          onClose={() => setOpen(null)}
          footer={(
            <>
              <button className="btn" disabled={openIdx === 0} onClick={() => setOpen(shots[openIdx - 1].id)}>Previous</button>
              <button className="btn" disabled={openIdx === shots.length - 1} onClick={() => setOpen(shots[openIdx + 1].id)}>Next</button>
              <span className="muted small">
                {openIdx + 1} of {shots.length} · activity {shots[openIdx].activity ?? '—'}% · deleted automatically after 30 days
              </span>
              <div className="spacer" />
              {isManager && <button className="btn btn-danger" onClick={() => remove(shots[openIdx].id)}>Delete screenshot</button>}
            </>
          )}
        >
          <Shot key={shots[openIdx].id} id={shots[openIdx].id} alt="Screenshot" />
        </Modal>
      )}
    </>
  );
}
