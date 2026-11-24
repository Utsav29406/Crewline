import { useState } from 'react';
import { useApp } from '../context.jsx';
import Icon from './Icon.jsx';
import { API_BASE } from '../api.js';

/**
 * The installers live in the private Blob store; the API redirects to a short-lived download link (server/src/app.js).
 * Rebuilds keep the same file names, so these links never change.
 */
const FILES = {
  windows: { label: 'Windows', size: '79 MB', url: `${API_BASE}/downloads/tracker/windows` },
  linux: { label: 'Linux (Ubuntu)', size: '71 MB', url: `${API_BASE}/downloads/tracker/linux` },
};
const SNOOZE_KEY = 'crewline.trackerCardSnoozed';
const SNOOZE_DAYS = 3;

function detectOs() {
  const ua = navigator.userAgent || '';
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Mac/i.test(platform))) return 'mobile';
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'windows';
  if (/Mac/i.test(platform)) return 'mac';
  if (/Linux|X11|Ubuntu/i.test(platform + ua)) return 'linux';
  return 'other';
}

function snoozed() {
  try {
    const until = Number(localStorage.getItem(SNOOZE_KEY));
    return until > Date.now();
  } catch {
    return false;
  }
}

/** Dashboard card asking people on a computer to install the desktop tracker, until theirs has connected once. */
export default function TrackerCard() {
  const { user, toast } = useApp();
  const [os, setOs] = useState(detectOs);
  const [hidden, setHidden] = useState(snoozed);

  if (hidden || user.tracker_connected || user.tracker_prompt !== '1' || os === 'mobile') return null;

  const later = () => {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DAYS * 86400000)); } catch { /* private window */ }
    setHidden(true);
  };
  const command = 'sudo apt install ~/Downloads/CrewlineTracker-linux.deb';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast('Command copied');
    } catch {
      toast('Select the command and copy it', 'error');
    }
  };

  const known = os === 'windows' || os === 'linux';
  return (
    <div className="card tracker-card" style={{ marginBottom: 22 }}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div className="stat-icon tone-accent" style={{ width: 48, height: 48, flexShrink: 0 }}><Icon name="monitor" /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0 }}>Install Crewline Tracker</h2>
          <div className="small muted" style={{ marginTop: 4 }}>
            The desktop app records your working time and tasks. Sign in to it with the same email and password you use here.
          </div>

          {os === 'mac' && <p className="small" style={{ margin: '12px 0 0' }}>The Mac version is coming soon. For now the tracker runs on Windows and Linux.</p>}

          {known && (
            <>
              <div className="row" style={{ flexWrap: 'wrap', gap: 10, marginTop: 14 }}>
                <a className="btn btn-primary" href={FILES[os].url}>
                  <Icon name="download" /> Download for {FILES[os].label}
                </a>
                <span className="small muted">{FILES[os].size}</span>
              </div>
              <ol className="small tracker-steps">
                {os === 'windows' ? (
                  <>
                    <li>Open <b>CrewlineTracker-Setup.exe</b> from your downloads. It installs in a few seconds and opens by itself.</li>
                    <li>If Windows shows “Windows protected your PC”, click <b>More info → Run anyway</b>.</li>
                    <li>Sign in. The tracker starts by itself whenever you turn on your PC, and installs new versions on its own.</li>
                  </>
                ) : (
                  <>
                    <li>Open a terminal and run this command:
                      <div className="row tracker-cmd">
                        <code>{command}</code>
                        <button className="btn btn-sm" onClick={copy}>Copy</button>
                      </div>
                    </li>
                    <li>Open <b>Crewline Tracker</b> from your apps and sign in.</li>
                  </>
                )}
              </ol>
            </>
          )}

          <div className="row small" style={{ flexWrap: 'wrap', gap: 14, marginTop: 12 }}>
            {(known ? Object.keys(FILES).filter((k) => k !== os) : Object.keys(FILES)).map((k) => (
              <button key={k} className="link-btn" onClick={() => setOs(k)}>
                {known ? 'Need a different version?' : 'Download for'} {FILES[k].label}
              </button>
            ))}
            <span className="spacer" />
            <button className="link-btn muted" onClick={later}>Later</button>
          </div>
        </div>
      </div>
    </div>
  );
}
