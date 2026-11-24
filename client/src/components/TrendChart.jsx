import { useState } from 'react';

/** 14-day stacked bar: on-time (series 1) + late (series 2) check-ins. */
export default function TrendChart({ data, max }) {
  const [hover, setHover] = useState(null);
  const top = Math.max(max || 0, ...data.map((d) => d.present), 1);
  return (
    <div className="chart">
      <div className="legend" style={{ marginBottom: 10 }}>
        <span><i style={{ background: 'var(--series-1)' }} />On time</span>
        <span><i style={{ background: 'var(--series-2)' }} />Late</span>
      </div>
      <div className="chart-bars" onMouseLeave={() => setHover(null)}>
        {data.map((d, i) => {
          const onTime = d.present - d.late;
          return (
            <div key={d.date} className="chart-col" onMouseEnter={() => setHover(i)}
              aria-label={`${d.date}: ${onTime} on time, ${d.late} late`}>
              {onTime > 0 && <div className={`seg s1 ${d.late ? '' : 'top'}`} style={{ height: `${(onTime / top) * 100}%` }} />}
              {d.late > 0 && <div className="seg s2 top" style={{ height: `${(d.late / top) * 100}%` }} />}
            </div>
          );
        })}
      </div>
      <div className="chart-x">
        {data.map((d, i) => (
          <span key={d.date}>{i % 2 === data.length % 2 ? new Date(d.date + 'T00:00:00').toLocaleDateString([], { day: 'numeric', month: 'short' }) : ''}</span>
        ))}
      </div>
      {hover !== null && (
        <div className="tooltip" style={{ left: `${((hover + 0.5) / data.length) * 100}%`, top: 30 }}>
          <b>{new Date(data[hover].date + 'T00:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</b>
          <div className="tnum">On time: {data[hover].present - data[hover].late}</div>
          <div className="tnum">Late: {data[hover].late}</div>
        </div>
      )}
    </div>
  );
}
