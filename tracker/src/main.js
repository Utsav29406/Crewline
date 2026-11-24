const {
  app, BrowserWindow, Tray, Menu, desktopCapturer, dialog, ipcMain, nativeImage,
  powerMonitor, safeStorage, screen, shell, systemPreferences,
} = require('electron');
const { execFile } = require('node:child_process');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Crewline Tracker. While the signed-in employee is checked in (and not on lunch or a break) it:
 *  - sends a heartbeat every minute (if it stops for 10 minutes the server starts a break),
 *  - takes one screenshot at a random moment in every block (BLOCK_MS),
 *  - measures activity as the share of 5-second samples with any keyboard or mouse input (never the keys).
 */
const API = process.env.CREWLINE_API || 'https://getcrewline.vercel.app/api';
const WEBSITE = process.env.CREWLINE_WEB || 'https://getcrewline.vercel.app';
const HEARTBEAT_MS = 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;
const SAMPLE_MS = Math.min(5 * 1000, BLOCK_MS / 5);
// Screenshots on Windows and macOS only; on Linux the tracker covers activity, breaks and idle time.
const SCREENSHOTS = process.platform !== 'linux';
// No mouse or keyboard for this long: the screenshot is marked idle and a short break starts on its own.
const IDLE_SECONDS = 6 * 60;
const MAX_UPLOAD_BYTES = 550 * 1024;
const ICONS = path.join(__dirname, '..', 'build');

// For local testing: a separate profile folder.
if (process.env.CREWLINE_PROFILE) app.setPath('userData', process.env.CREWLINE_PROFILE);
// A second copy hands over to the running one (second-instance) and exits before doing anything else.
if (!app.requestSingleInstanceLock()) app.exit(0);

let win = null;
let tray = null;
let quitting = false;
const state = {
  user: null, // { name, email, company }
  status: null, // from POST /tracker/heartbeat
  online: true,
  error: null,
  activityNow: null, // % for the current block
  tasks: [], // open tasks from the website, with today's seconds on each
  screenPermission: 'granted',
};

/* ---------- Saved session (token encrypted by Windows DPAPI / the macOS Keychain) ---------- */
// Linux keyrings often can't decrypt after a restart, which would sign people out; there the file is owner-only (0600).
const sessionFile = () => path.join(app.getPath('userData'), 'session.json');
function saveSession(token, user) {
  const raw = JSON.stringify({ token, user, savedAt: Date.now() });
  const data = process.platform !== 'linux' && safeStorage.isEncryptionAvailable()
    ? { enc: safeStorage.encryptString(raw).toString('base64') }
    : { plain: raw };
  fs.writeFileSync(sessionFile(), JSON.stringify(data), { mode: 0o600 });
  fs.chmodSync(sessionFile(), 0o600);
}
function loadSession() {
  try {
    const data = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
    return JSON.parse(data.enc ? safeStorage.decryptString(Buffer.from(data.enc, 'base64')) : data.plain);
  } catch {
    return null;
  }
}
const clearSession = () => fs.rmSync(sessionFile(), { force: true });
let session = null;

/* ---------- Task the person is working on (remembered across restarts) ---------- */
// 'auto' (the default) lets the server log time to the most urgent open task; otherwise a task id, or null for none.
const taskFile = () => path.join(app.getPath('userData'), 'task.json');
let currentTaskId = 'auto';
let activeTaskId = null; // the task time actually went to, as the server reports it
function loadTask() {
  try {
    const saved = JSON.parse(fs.readFileSync(taskFile(), 'utf8'));
    // Before Auto existed, "no task" was simply the starting value: only a real pick carries over.
    currentTaskId = saved.v === 2 ? saved.taskId : typeof saved.taskId === 'number' ? saved.taskId : 'auto';
  } catch {
    currentTaskId = 'auto';
  }
}
function saveTask(id) {
  currentTaskId = id === 'auto' ? 'auto' : Number(id) || null;
  fs.writeFileSync(taskFile(), JSON.stringify({ v: 2, taskId: currentTaskId }));
}

// A half-dropped connection (switching Wi-Fi) can leave a request hanging for minutes, holding up every heartbeat
// and screenshot behind it: give up after 20 s.
const REQUEST_TIMEOUT_MS = 20 * 1000;
async function call(method, p, body) {
  const owner = session;
  const res = await fetch(`${API}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(owner?.token && { Authorization: `Bearer ${owner.token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  // Only the session that sent the request may be signed out by its 401, not someone who signed in since.
  if (res.status === 401 && owner && session === owner) {
    signOut('Your session expired. Please sign in again.');
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------- Idle time ---------- */
// On Linux (Wayland) Electron can't see keyboard or mouse input, so ask GNOME how long the session has been idle.
let linuxIdle = null;
let linuxIdleFails = 0;
function refreshLinuxIdle() {
  execFile('gdbus', ['call', '--session', '--dest', 'org.gnome.Mutter.IdleMonitor', '--object-path', '/org/gnome/Mutter/IdleMonitor/Core',
    '--method', 'org.gnome.Mutter.IdleMonitor.GetIdletime'], { timeout: 2000 }, (err, out) => {
    const m = /uint64 (\d+)/.exec(out || '');
    if (!err && m) {
      linuxIdle = Math.floor(Number(m[1]) / 1000);
      linuxIdleFails = 0;
    } else if (++linuxIdleFails >= 3) {
      linuxIdle = null; // GNOME's idle monitor isn't answering (another desktop?): fall back to Electron's
    }
    // A single slow or failed answer keeps the last reading, so an idle break doesn't end on a hiccup.
  });
}
const idleSeconds = () => linuxIdle ?? powerMonitor.getSystemIdleTime();

/* ---------- Activity sampling ---------- */
let block = { id: null, samples: 0, active: 0, captureAt: 0, captured: false };
let capturing = false;
const blockId = (t) => Math.floor(t / BLOCK_MS);
function newBlock(t) {
  const id = blockId(t);
  const start = id * BLOCK_MS;
  // A random moment in the block, away from the very edges.
  const edge = Math.min(30 * 1000, BLOCK_MS / 5);
  const captureAt = start + edge + Math.floor(Math.random() * (BLOCK_MS - 2 * edge));
  block = { id, samples: 0, active: 0, captureAt, captured: false };
}
let idleBusy = false;
/** Starts an idle break after IDLE_SECONDS without input, and ends it as soon as the mouse or keyboard is used. */
async function checkIdle() {
  const st = state.status;
  if (!session || !st || idleBusy) return;
  const idleFor = idleSeconds();
  const away = st.state === 'working' && idleFor >= IDLE_SECONDS;
  const back = st.state === 'break' && st.break_source === 'idle' && idleFor < SAMPLE_MS / 1000;
  if (!away && !back) return;
  idleBusy = true;
  const owner = session;
  try {
    const next = await call('POST', '/tracker/idle', away ? { away: true, idleSeconds: idleFor } : { away: false });
    if (session !== owner) return; // signed out (or in as someone else) meanwhile
    state.status = next;
    push();
  } catch (err) {
    console.error('idle update failed:', err.message);
  } finally {
    idleBusy = false;
  }
}

function sample() {
  const now = Date.now();
  if (process.platform === 'linux' && session && state.status) refreshLinuxIdle(); // only needed while checked in
  if (block.id !== blockId(now)) newBlock(now);
  checkIdle();
  if (state.status?.capture) {
    block.samples++;
    if (idleSeconds() < SAMPLE_MS / 1000) block.active++;
    state.activityNow = Math.round((block.active / block.samples) * 100);
  }
  if (SCREENSHOTS && !block.captured && now >= block.captureAt && state.status?.capture) {
    block.captured = true;
    if (capturing) return; // the previous screenshot is still uploading
    capturing = true;
    capture().catch((err) => {
      if (err.status === 401) return; // signed out: keep "Your session expired" instead of a screenshot error
      state.error = `Screenshot failed: ${err.message}`;
      push();
    }).finally(() => { capturing = false; });
  }
}

/* ---------- Screenshot ---------- */
// A denied screen-recording permission hands back an all-black frame instead of an error.
function isBlank(img) {
  const px = img.resize({ width: 32, height: 20 }).toBitmap();
  for (let i = 0; i < px.length; i += 4) if (px[i] > 8 || px[i + 1] > 8 || px[i + 2] > 8) return false;
  return true;
}

/** Start with the computer (Windows and macOS login items; on Linux an XDG autostart entry). */
function enableAutoStart() {
  if (!app.isPackaged) return;
  if (process.platform !== 'linux') {
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: ['--hidden'] });
    return;
  }
  const dir = path.join(app.getPath('home'), '.config', 'autostart');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'crewline-tracker.desktop'), [
    '[Desktop Entry]', 'Type=Application', 'Name=Crewline Tracker', `Exec="${process.execPath}" --hidden`,
    'Icon=crewline-tracker', 'X-GNOME-Autostart-enabled=true', '',
  ].join('\n'));
}
/** Windows zip build: on first run, add Start menu and desktop shortcuts so it behaves like an installed app. */
function ensureShortcuts() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  // Installed with Setup.exe: the installer already made the shortcuts.
  if (fs.readdirSync(path.dirname(process.execPath)).some((f) => /^Uninstall .*\.exe$/i.test(f))) return;
  // Only once: someone who deletes a shortcut shouldn't see it come back at every start.
  const marker = path.join(app.getPath('userData'), 'shortcuts-made');
  if (fs.existsSync(marker)) return;
  fs.writeFileSync(marker, '');
  const links = [
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Crewline Tracker.lnk'),
    path.join(app.getPath('desktop'), 'Crewline Tracker.lnk'),
  ];
  for (const link of links) {
    if (fs.existsSync(link)) continue;
    shell.writeShortcutLink(link, 'create', { target: process.execPath, description: 'Crewline Tracker', icon: process.execPath, iconIndex: 0 });
  }
}

async function screenImage() {
  const display = screen.getPrimaryDisplay();
  const scale = Math.min(1, 1600 / display.size.width);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) },
  });
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('Screen capture is not allowed. Give Crewline Tracker screen recording permission.');
  return src.thumbnail;
}

async function capture() {
  if (process.platform === 'darwin') {
    state.screenPermission = systemPreferences.getMediaAccessStatus('screen');
  }
  // Activity for the block this screenshot belongs to, read now: the awaits below can run past the block's end.
  const activity = block.samples ? Math.round((block.active / block.samples) * 100) : 0;
  const owner = session;
  // Status is otherwise refreshed once a minute: confirm the person is still working (not checked out, not on a
  // break) right before taking the screenshot, so none are taken after punch-out.
  await heartbeat();
  if (!session || session !== owner || !state.status?.capture) return;
  let img = await screenImage();
  if (img.isEmpty()) throw new Error('Screen capture is not allowed. Give Crewline Tracker screen recording permission.');
  if (isBlank(img)) {
    throw new Error('The screenshot came out blank. Give Crewline Tracker screen recording permission.');
  }
  if (img.getSize().width > 1280) img = img.resize({ width: 1280, quality: 'good' });
  let quality = 62;
  let jpeg = img.toJPEG(quality);
  while (jpeg.length > MAX_UPLOAD_BYTES && quality > 25) jpeg = img.toJPEG((quality -= 12));

  const idle = idleSeconds() >= IDLE_SECONDS;
  const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  try {
    await call('POST', '/tracker/screenshots', { image: dataUrl, activity, idle, taskId: activeTaskId });
  } catch (err) {
    if (err.status === 409) return heartbeat(); // checked out or went on a break meanwhile
    throw err;
  }
  state.error = null;
  heartbeat();
}

/* ---------- Heartbeat ---------- */
let lastRefresh = 0;
// One heartbeat at a time: callers arriving while one is in flight share it, and one more runs after it, so the
// latest choices (a new task, a break) still reach the server. Overlapping ones double-counted task time.
let beating = null;
let beatAgain = false;
function heartbeat() {
  if (beating) {
    beatAgain = true;
    return beating;
  }
  beating = beat().finally(() => {
    beating = null;
    if (beatAgain) {
      beatAgain = false;
      heartbeat();
    }
  });
  return beating;
}
async function beat() {
  const owner = session;
  if (!owner) return;
  try {
    const res = await call('POST', '/tracker/heartbeat', { taskId: currentTaskId, idleSeconds: idleSeconds() });
    if (session !== owner) return; // signed out (or in as someone else) while this was on its way
    const { tasks, task_id: logged, ...status } = res;
    state.status = status;
    state.tasks = tasks || [];
    activeTaskId = logged ?? null;
    // The picked task was finished or removed on the website: back to Auto.
    if (typeof currentTaskId === 'number' && !state.tasks.some((t) => t.id === currentTaskId)) saveTask('auto');
    state.online = true;
    // Connection errors are over once a heartbeat gets through; a screenshot error is moot once nothing is being
    // captured (checked out, on a break), otherwise the next good screenshot clears it.
    if (state.error?.startsWith('Can') || (!status.capture && state.error?.startsWith('Screenshot failed'))) state.error = null;
    // Keep the sign-in fresh (sessions last 7 days). Marked done only once it worked, so a failure retries soon.
    if (Date.now() - lastRefresh > 24 * 3600 * 1000) {
      const { token } = await call('POST', '/tracker/session', {});
      if (session !== owner) return;
      lastRefresh = Date.now();
      session.token = token;
      saveSession(token, session.user);
    }
  } catch (err) {
    console.error('heartbeat failed:', err.message);
    if (err.status === 401 || session !== owner) return;
    state.online = false;
    state.error = "Can't reach Crewline. Check your internet connection.";
  }
  push();
}

/* ---------- UI ---------- */
function snapshot() {
  return {
    signedIn: Boolean(session), user: session?.user || null, status: state.status, online: state.online, error: state.error,
    activityNow: state.activityNow, screenPermission: state.screenPermission, tasks: state.tasks, taskId: currentTaskId, activeTaskId,
    platform: process.platform, website: WEBSITE, idleMinutes: IDLE_SECONDS / 60,
    update: state.update || null, version: app.getVersion(),
  };
}
function push() {
  win?.webContents.send('state', snapshot());
  updateTray();
}

const STATE_TEXT = {
  working: 'Tracking', lunch: 'Paused for lunch', break: 'Paused for a break', out: 'Not checked in', done: 'Checked out',
};
function updateTray() {
  if (!tray) return;
  const s = state.status;
  const label = !session ? 'Signed out' : !state.online ? 'Offline' : STATE_TEXT[s?.state] || 'Starting…';
  tray.setToolTip(`Crewline Tracker · ${label}`);
  const worked = s?.worked_minutes != null ? `Worked ${Math.floor(s.worked_minutes / 60)}h ${String(s.worked_minutes % 60).padStart(2, '0')}m today` : '';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Crewline · ${label}`, enabled: false },
    ...(worked ? [{ label: worked, enabled: false }] : []),
    { type: 'separator' },
    { label: 'Open Crewline Tracker', click: showWindow },
    ...(s?.state === 'working' ? [
      { label: 'Start lunch', click: () => breakAction('start', 'lunch') },
      { label: 'Short break', click: () => breakAction('start', 'break') },
    ] : []),
    ...(s?.state === 'lunch' || s?.state === 'break' ? [{ label: 'End break', click: () => breakAction('end') }] : []),
    { label: 'Open Crewline website', click: () => shell.openExternal(WEBSITE) },
    { type: 'separator' },
    { label: 'Quit', click: confirmQuit },
  ]));
}

function showWindow() {
  if (!win) createWindow();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 400, height: 660, resizable: false, maximizable: false, fullscreenable: false, show: false,
    title: 'Crewline Tracker', icon: path.join(ICONS, 'icon.png'), autoHideMenuBar: true,
    backgroundColor: '#e2e6ee',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  // The window only ever shows the app's own page: no following links or dropped files, no new windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => { win.show(); push(); });
  // Closing the window keeps tracking in the tray.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
}

async function confirmQuit() {
  const checkedIn = ['working', 'lunch', 'break'].includes(state.status?.state);
  if (checkedIn) {
    const { response } = await dialog.showMessageBox(win?.isVisible() ? win : null, {
      type: 'warning', buttons: ['Keep running', 'Quit anyway'], defaultId: 0, cancelId: 0,
      title: 'Quit Crewline Tracker?',
      message: "You're checked in.",
      detail: 'If Crewline Tracker stays closed for 10 minutes, you go on a break automatically and that time is not counted as work. The break ends when you open the app again.',
    });
    if (response !== 1) return;
  }
  quitting = true;
  app.quit();
}

async function breakAction(kind, type) {
  try {
    await call('POST', kind === 'start' ? '/attendance/break/start' : '/attendance/break/end', kind === 'start' ? { type } : {});
    state.error = null;
  } catch (err) {
    if (err.status !== 401) state.error = err.message; // a 401 already signed out with its own message
  }
  await heartbeat();
}

function signOut(message) {
  session = null;
  state.status = null;
  state.tasks = [];
  state.online = true;
  state.activityNow = null;
  activeTaskId = null;
  newBlock(Date.now());
  state.error = message || null;
  clearSession();
  saveTask('auto');
  push();
}

/* ---------- IPC from the window ---------- */
ipcMain.handle('state', () => snapshot());
/** POST to the sign-in API without a session; returns the JSON, or { error }. */
async function authPost(p, body) {
  let res;
  try {
    res = await fetch(`${API}${p}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { error: "Can't reach Crewline. Check your internet connection." };
  }
  const data = await res.json().catch(() => ({}));
  return res.ok ? data : { error: data.error || 'Sign-in failed' };
}
// Two-step sign-in (admins): the ticket stays here, the window only sends the emailed code.
let pendingTicket = null;
ipcMain.handle('sign-in', async (_e, { email, password }) => {
  const data = await authPost('/auth/login', { email, password });
  if (data.error) return data;
  if (data.twoStep) {
    pendingTicket = data.ticket;
    return { twoStep: true, email: data.email };
  }
  return finishSignIn(data);
});
ipcMain.handle('sign-in-code', async (_e, { code }) => {
  if (!pendingTicket) return { error: 'This sign-in expired. Enter your password again.', restart: true };
  const data = await authPost('/auth/login/verify', { ticket: pendingTicket, code });
  if (data.error) return data;
  pendingTicket = null;
  return finishSignIn(data);
});
ipcMain.handle('sign-in-cancel', () => { pendingTicket = null; });
async function finishSignIn(data) {
  const user = { name: data.user?.name, email: data.user?.email, company: data.user?.company_name || '', designation: data.user?.designation || '' };
  session = { token: data.token, user };
  saveSession(data.token, user);
  lastRefresh = Date.now();
  state.error = null;
  try {
    enableAutoStart();
  } catch (err) {
    console.error('autostart failed:', err.message); // signing in still worked
  }
  await heartbeat();
  return { ok: true };
}
ipcMain.handle('sign-out', () => signOut());
ipcMain.handle('install-update', () => installUpdate());
ipcMain.handle('break', (_e, { kind, type }) => breakAction(kind, type));
ipcMain.handle('task', async (_e, { taskId }) => { saveTask(taskId); await heartbeat(); });
ipcMain.handle('open-website', () => shell.openExternal(WEBSITE));
ipcMain.handle('open-screen-settings', () =>
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'));

/* ---------- Updates ---------- */
// New versions come from the Crewline website (build.publish in package.json). They download in the background;
// on Windows they install by themselves when nobody is working (signed out, not checked in or already checked out),
// otherwise the window offers "Restart to update". Linux asks for the password to install, so it always waits for a click.
function installUpdate() {
  if (!state.update?.ready) return;
  quitting = true;
  autoUpdater.quitAndInstall(true, true);
}
function maybeInstallUpdate() {
  if (!state.update?.ready || process.platform !== 'win32') return;
  const st = state.status?.state;
  if (!session || st === 'out' || st === 'done') installUpdate();
}
function setupUpdates() {
  if (!app.isPackaged || process.platform === 'darwin') return; // the Mac build isn't signed, so it can't self-update
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-downloaded', (info) => {
    state.update = { version: info.version, ready: true };
    push();
    maybeInstallUpdate();
  });
  autoUpdater.on('error', (err) => console.error('update check failed:', err?.message || err));
  const check = () => autoUpdater.checkForUpdates().catch((err) => console.error('update check failed:', err?.message || err));
  setTimeout(check, 30 * 1000);
  setInterval(check, 4 * 60 * 60 * 1000);
  setInterval(maybeInstallUpdate, 10 * 60 * 1000);
}

/* ---------- Start ---------- */
app.on('second-instance', showWindow);
app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => { quitting = true; });

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.hide();
  const trayIcon = process.platform === 'darwin'
    ? nativeImage.createFromPath(path.join(ICONS, 'trayTemplate.png'))
    : nativeImage.createFromPath(path.join(ICONS, 'tray.png'));
  if (process.platform === 'darwin') trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.on('click', showWindow);

  ensureShortcuts();
  session = loadSession();
  loadTask();
  newBlock(Date.now());
  // Started at login: stay in the tray. Started by hand: show the window.
  const atLogin = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;
  if (!atLogin || !session) createWindow();
  updateTray();
  // Keep "start with the computer" pointing at this copy (an install replaces an older zip copy, for example).
  if (session) {
    try { enableAutoStart(); } catch (err) { console.error('autostart failed:', err.message); }
  }
  setupUpdates();
  heartbeat();
  setInterval(heartbeat, HEARTBEAT_MS);
  setInterval(sample, SAMPLE_MS);
  // Waking from sleep: report straight away instead of waiting for the next minute.
  powerMonitor.on('resume', () => { newBlock(Date.now()); heartbeat(); });
  powerMonitor.on('unlock-screen', heartbeat);
}).catch((err) => {
  console.error('Crewline Tracker failed to start:', err);
  dialog.showErrorBox('Crewline Tracker could not start', String(err?.message || err));
});
