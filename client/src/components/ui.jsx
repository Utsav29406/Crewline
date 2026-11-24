import { useEffect } from 'react';
import Icon from './Icon.jsx';
import { initials, STATUS_TONE, statusLabel } from '../format.js';

export function Modal({ title, onClose, children, footer, width }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width: `min(${width}px, 100%)` } : undefined} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn btn-icon" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export const Badge = ({ status, children, tone }) => (
  <span className={`badge badge-${tone || STATUS_TONE[status] || 'muted'}`}>{children ?? statusLabel(status)}</span>
);

export const Avatar = ({ name, size }) => <div className={`avatar ${size || ''}`}>{initials(name)}</div>;

export const Who = ({ name, sub }) => (
  <div className="who">
    <Avatar name={name} />
    <div style={{ minWidth: 0 }}>
      <div className="who-name">{name}</div>
      {sub && <div className="who-sub">{sub}</div>}
    </div>
  </div>
);

export function StatCard({ icon, label, value, tone = 'accent', hint }) {
  return (
    <div className="card stat">
      <div className={`stat-icon tone-${tone}`}><Icon name={icon} size={22} /></div>
      <div>
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
        {hint && <div className="small muted">{hint}</div>}
      </div>
    </div>
  );
}

export const Field = ({ label, children, full }) => (
  <div className={`field ${full ? 'full' : ''}`}>
    <label>{label}</label>
    {children}
  </div>
);

export const Switch = ({ on, onChange, label }) => (
  <button type="button" className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on} aria-label={label} />
);

export const Loading = () => <div className="loading"><span className="spin" /></div>;
/** Shown instead of a page whose data couldn't load. */
export const LoadError = ({ message, onRetry }) => (
  <div className="card empty" style={{ textAlign: 'center' }}>
    <p style={{ margin: '0 0 12px' }}>{message || "Couldn't load this page."}</p>
    <button className="btn btn-primary" onClick={onRetry}>Try again</button>
  </div>
);

/** Heading that only appears on a printed / PDF report. */
export const PrintTitle = ({ children }) => (
  <div className="print-only">
    <h2>{children}</h2>
    <div className="small">Printed {new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · Crewline</div>
  </div>
);

export const PageHead = ({ title, subtitle, children }) => (
  <div className="page-head">
    <div>
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
    {children && <div className="row wrap">{children}</div>}
  </div>
);
