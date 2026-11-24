import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';

/** On phones: offer to add Crewline to the home screen, so punching in is one tap from an app icon. */
const KEY = 'crewline.installCardHidden';
const isPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/i.test(navigator.platform));
const isInstalled = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/i.test(navigator.platform));
const hiddenBefore = () => {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
};

export default function InstallAppCard() {
  const [prompt, setPrompt] = useState(() => window.crewlineInstallPrompt || null);
  const [hidden, setHidden] = useState(() => hiddenBefore() || !isPhone() || isInstalled());
  useEffect(() => {
    const onReady = () => setPrompt(window.crewlineInstallPrompt);
    const onInstalled = () => setHidden(true);
    window.addEventListener('crewline-installable', onReady);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('crewline-installable', onReady);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  if (hidden) return null;

  const hide = () => {
    try { localStorage.setItem(KEY, '1'); } catch { /* private window */ }
    setHidden(true);
  };
  const install = async () => {
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    window.crewlineInstallPrompt = null;
    setPrompt(null);
    if (outcome === 'accepted') setHidden(true);
  };

  return (
    <div className="card" style={{ marginBottom: 22 }}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
        <img src="/icon-192.png" alt="" width="44" height="44" style={{ borderRadius: 12, flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>Add Crewline to your home screen</b>
          <div className="small muted" style={{ marginTop: 4 }}>
            {prompt ? 'Open it like an app, full screen, to punch in with one tap.'
              : isIos() ? <>Tap <b>Share</b> <Icon name="send" size={13} /> at the bottom of Safari, then <b>Add to Home Screen</b>.</>
                : <>Open your browser menu <b>⋮</b>, then <b>Install app</b> or <b>Add to Home screen</b>.</>}
          </div>
          <div className="row" style={{ gap: 10, marginTop: 12 }}>
            {prompt && <button className="btn btn-primary btn-sm" onClick={install}><Icon name="download" size={15} /> Install</button>}
            <button className="link-btn muted small" onClick={hide}>Not now</button>
          </div>
        </div>
      </div>
    </div>
  );
}
