import { useEffect, useState } from 'react';
import Logo from './Logo.jsx';

const SEEN_KEY = 'crewline.splash-seen';
const DURATION_MS = 3150;

/** Plays once per browser session, and never for people who prefer reduced motion. */
function shouldPlay() {
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
    if (sessionStorage.getItem(SEEN_KEY)) return false;
    sessionStorage.setItem(SEEN_KEY, '1');
    return true;
  } catch {
    return false;
  }
}
const playOnLoad = shouldPlay();

/** Opening screen: the logo tile rises out of the surface, the crew settles in, each letter of "Crewline" rises, then it blurs into the app. */
export default function Splash() {
  const [visible, setVisible] = useState(playOnLoad);
  useEffect(() => {
    if (!visible) return;
    const done = () => setVisible(false);
    const timer = setTimeout(done, DURATION_MS);
    window.addEventListener('keydown', done);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', done);
    };
  }, [visible]);
  if (!visible) return null;
  return (
    <div className="splash" onClick={() => setVisible(false)} aria-hidden="true">
      <div className="splash-lockup">
        <Logo size={104} animated={false} />
        <div>
          <div className="splash-word">
            {[...'Crewline'].map((c, i) => <span key={i} style={{ '--i': i }}>{c}</span>)}
          </div>
          <div className="splash-tagline">People · Time · Pay</div>
        </div>
      </div>
    </div>
  );
}
