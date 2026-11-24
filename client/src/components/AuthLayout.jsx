import { useLayoutEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Icon from './Icon.jsx';
import Logo from './Logo.jsx';

/**
 * Shared layout for Sign in, Join and Register: the brand panel on the left, the card on the right.
 *
 * Moving between them "morphs" the card: the old fields drift up and fade, then the card eases from its old
 * height to the new one while the new fields rise in one after another (and the panel's text changes with it).
 * Each page is its own route, so MorphLink plays the first half before navigating and AuthLayout plays the
 * second half when the next page mounts. Browser back/forward simply shows the page without the animation.
 */
const EASE = 'cubic-bezier(.22,.8,.24,1)';
const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
let pending = null; // { height, at } from the card that just left

async function leave(root) {
  const card = root?.querySelector('.auth-card');
  if (!card || !card.animate) return;
  pending = { height: card.offsetHeight, at: Date.now() };
  if (reduced()) return; // the next card just fades in
  const out = [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-10px)' }];
  const parts = [...card.children, ...root.querySelectorAll('.auth-hero-copy, .auth-switch')];
  await Promise.all(parts.map((el) => el.animate(out, { duration: 170, easing: 'ease-in', fill: 'forwards' }).finished)).catch(() => {});
}

function enter(root) {
  const from = pending;
  pending = null;
  const card = root?.querySelector('.auth-card');
  if (!from || !card || Date.now() - from.at > 1500 || !card.animate) return;
  // Reduce motion: no movement or resizing, only a short fade.
  if (reduced()) return void card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
  const to = card.offsetHeight;
  card.style.overflow = 'hidden';
  card.animate([{ height: `${from.height}px` }, { height: `${to}px` }], { duration: 380, easing: EASE })
    .finished.catch(() => {}).finally(() => { card.style.overflow = ''; });
  const rise = [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'translateY(0)' }];
  [...card.children].forEach((el, i) => el.animate(rise, { duration: 360, delay: 40 + i * 45, easing: EASE, fill: 'backwards' }));
  root.querySelectorAll('.auth-hero-copy, .auth-switch').forEach((el) => el.animate(rise, { duration: 420, delay: 60, easing: EASE, fill: 'backwards' }));
}

/** A link between the sign-in pages that plays the morph. Opening in a new tab works as usual. */
export function MorphLink({ to, onClick, ...props }) {
  const navigate = useNavigate();
  return (
    <Link
      to={to}
      {...props}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        leave(e.currentTarget.closest('.auth')).then(() => navigate(to));
      }}
    />
  );
}

/** title + accent make the headline ("Set up Crewline" / "for your company."). */
export default function AuthLayout({ title, accent, lead, points, children }) {
  const root = useRef(null);
  useLayoutEffect(() => { enter(root.current); }, []);
  return (
    <div className="auth" ref={root}>
      <section className="auth-hero">
        <div className="brand" style={{ padding: 0 }}>
          <Logo />
          <div>
            <div className="brand-name">Crewline</div>
            <div className="brand-sub">Smart HRMS</div>
          </div>
        </div>
        <div className="auth-hero-copy">
          <h1>{title}<br /><span className="grad">{accent}</span></h1>
          <p className="muted" style={{ fontSize: 16, maxWidth: 460 }}>{lead}</p>
        </div>
        <div className="stack features auth-hero-copy">
          {points.map((f) => (
            <div key={f.title} className="feature">
              <div className="stat-icon tone-accent" style={{ width: 46, height: 46 }}><Icon name={f.icon} /></div>
              <div>
                <h3>{f.title}</h3>
                <div className="muted">{f.text}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="auth-form">{children}</section>
    </div>
  );
}
