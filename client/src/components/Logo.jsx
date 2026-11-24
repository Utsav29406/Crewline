import { useId } from 'react';

/** Animated "Crew Line" mark: three teammates on a line that draws itself, then hop in a wave. */
export default function Logo({ size = 42, animated = true }) {
  const grad = `logo-grad-${useId().replace(/:/g, '')}`;
  return (
    <svg className={`logo ${animated ? 'logo-animated' : ''}`} width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="Crewline">
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="1" y2="1">
          <stop className="logo-stop-1" offset="0" />
          <stop className="logo-stop-2" offset="1" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill={`url(#${grad})`} />
      <g className="logo-person">
        <circle cx="14" cy="18.5" r="3.4" />
        <path d="M9 29a5 5 0 0 1 10 0" />
      </g>
      <g className="logo-person">
        <circle cx="24" cy="15" r="3.8" />
        <path d="M18.5 26.5a5.5 5.5 0 0 1 11 0" />
      </g>
      <g className="logo-person">
        <circle cx="34" cy="18.5" r="3.4" />
        <path d="M29 29a5 5 0 0 1 10 0" />
      </g>
      <path className="logo-line" d="M10 35.5h28" />
    </svg>
  );
}
