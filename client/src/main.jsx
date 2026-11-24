import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import 'leaflet/dist/leaflet.css';
import './styles.css';
import { AppProvider } from './context.jsx';
import App from './App.jsx';
import Splash from './components/Splash.jsx';
import { setupBackButton } from './native.js';

setupBackButton();

// Android/Chrome offers "install this app" once, early; keep the offer for the install card (components/InstallAppCard.jsx).
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.crewlineInstallPrompt = e;
  window.dispatchEvent(new Event('crewline-installable'));
});

// Installable phone app + offline page (public/sw.js). Production builds only, so local development isn't cached.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// After a new release, a tab opened earlier may ask for page code that no longer exists. Reload once to get the
// new version instead of showing an error (the flag stops a reload loop if the file is really missing).
window.addEventListener('vite:preloadError', (e) => {
  let reloaded = false;
  try { reloaded = sessionStorage.getItem('crewline.reloaded') === '1'; sessionStorage.setItem('crewline.reloaded', '1'); } catch { /* ignore */ }
  if (reloaded) return;
  e.preventDefault();
  window.location.reload();
});
window.addEventListener('load', () => setTimeout(() => { try { sessionStorage.removeItem('crewline.reloaded'); } catch { /* ignore */ } }, 10_000));

/** One page throwing while it renders shouldn't blank the whole app: show a way back instead. */
class ErrorBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err) {
    console.error(err);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="card" style={{ maxWidth: 420, margin: '15vh auto', textAlign: 'center', display: 'grid', gap: 14 }}>
        <h2 style={{ margin: 0 }}>Something went wrong on this page</h2>
        <p className="muted" style={{ margin: 0 }}>Your data is safe. Reload to carry on.</p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppProvider>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
        <Splash />
      </AppProvider>
    </BrowserRouter>
  </React.StrictMode>
);
