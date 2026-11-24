const $ = (id) => document.getElementById(id);
const dur = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
const hm = (dt) => {
  const h = Number(dt.slice(11, 13));
  return `${((h + 11) % 12) + 1}:${dt.slice(14, 16)} ${h < 12 ? 'am' : 'pm'}`;
};

const PILLS = {
  working: ['Tracking', 'good'], lunch: ['Paused for lunch', 'warn'], break: ['Paused for a break', 'warn'],
  out: ['Not checked in', 'muted-pill'], done: ['Checked out', 'muted-pill'],
};

function button(label, onClick, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.className = cls;
  b.onclick = async () => {
    b.disabled = true;
    try { await onClick(); } finally { b.disabled = false; }
  };
  return b;
}

/** "Working on" picker plus today's time per task. Time only counts while working, so the picker sleeps otherwise. */
function renderTasks(s, st) {
  const tasks = s.tasks || [];
  const sel = $('task');
  // Auto shows the task it would log to: the server's pick while working, otherwise the first (most urgent) task.
  const autoTask = tasks.find((t) => t.id === s.activeTaskId) || tasks[0];
  const options = [
    ['auto', autoTask ? `Auto · ${autoTask.title}` : 'Auto (no open tasks)'],
    ...tasks.map((t) => [String(t.id), t.title]),
    ['', 'No task'],
  ];
  const picked = s.taskId === 'auto' ? 'auto' : s.taskId ? String(s.taskId) : '';
  const key = JSON.stringify(options) + picked;
  if (sel.dataset.key !== key && document.activeElement !== sel) {
    sel.replaceChildren(...options.map(([value, label]) => Object.assign(document.createElement('option'), { value, textContent: label })));
    sel.value = picked;
    sel.dataset.key = key;
  }
  const current = s.taskId === 'auto' ? s.activeTaskId ?? autoTask?.id : s.taskId;
  const mins = (sec) => Math.round(sec / 60);
  const rows = tasks.filter((t) => t.today_seconds > 0 || t.id === current)
    .map((t) => [t.title, mins(t.today_seconds), t.id === current]);
  const untracked = Math.max((st.worked_minutes || 0) - rows.reduce((a, [, m]) => a + m, 0), 0);
  if (untracked > 0) rows.push(['No task', untracked, !current]);
  $('today').replaceChildren(...rows.map(([label, m, on]) => {
    const d = document.createElement('div');
    if (on) d.className = 'on';
    const a = document.createElement('span');
    a.textContent = label;
    a.title = label;
    const b = document.createElement('span');
    b.textContent = dur(m);
    d.append(a, b);
    return d;
  }));
}

function render(s) {
  $('signin').hidden = s.signedIn;
  $('app').hidden = !s.signedIn;
  $('signout-row').hidden = !s.signedIn;
  $('who').textContent = s.user ? [s.user.name, s.user.company].filter(Boolean).join(' · ') : 'Not signed in';
  $('foot').textContent = s.signedIn ? `Your timer is set to ${s.idleMinutes} minutes` : '';
  $('update').hidden = !s.update?.ready;
  if (s.update?.ready) $('update-text').textContent = `Version ${s.update.version} is ready.`;
  $('error').hidden = !s.error;
  $('error').textContent = s.error || '';
  $('perm').hidden = !(s.platform === 'darwin' && s.screenPermission && s.screenPermission !== 'granted');

  const pill = $('pill');
  if (!s.signedIn) { pill.textContent = 'Signed out'; pill.className = 'pill muted-pill'; return; }
  if (!s.online) { pill.textContent = 'Offline'; pill.className = 'pill bad'; }
  const st = s.status;
  if (!st) {
    // No status yet (just signed in, or offline from the start): don't leave the previous person's day on screen.
    $('worked').textContent = dur(0);
    $('clock-sub').textContent = '';
    $('activity').textContent = '—';
    $('week').textContent = '—';
    $('week-since').textContent = '';
    $('task').replaceChildren();
    $('task').dataset.key = '';
    $('today').replaceChildren();
    $('actions').replaceChildren();
    return;
  }
  if (s.online) {
    const [text, cls] = PILLS[st.state] || ['…', 'muted-pill'];
    pill.textContent = text;
    pill.className = `pill ${cls}`;
  }

  $('worked').textContent = dur(st.worked_minutes || 0);
  // Week total from the server (older servers don't send it); it starts over every Sunday at 12:00 am.
  $('week').textContent = st.week_minutes == null ? '—' : dur(st.week_minutes);
  $('week-since').textContent = st.week_start ? `(since Sun ${Number(st.week_start.slice(8, 10))} ${new Date(`${st.week_start}T00:00:00`).toLocaleDateString('en-GB', { month: 'short' })})` : '';
  $('clock-sub').textContent = {
    working: `worked today · checked in ${st.check_in ? hm(st.check_in) : ''}`,
    lunch: `lunch since ${st.break_started ? hm(st.break_started) : ''} · not tracked`,
    break: st.break_source === 'idle'
      ? `idle since ${st.break_started ? hm(st.break_started) : ''} · move the mouse to resume`
      : `on a break since ${st.break_started ? hm(st.break_started) : ''} · not tracked`,
    out: 'check in on the Crewline website or phone to start',
    done: `checked out ${st.check_out ? hm(st.check_out) : ''} · see you tomorrow`,
  }[st.state];
  $('activity').textContent = st.state === 'working' && s.activityNow != null ? `${s.activityNow}%` : '—';

  renderTasks(s, st);

  const actions = $('actions');
  actions.replaceChildren();
  if (st.state === 'working') {
    actions.append(
      button('Start lunch', () => window.tracker.startBreak('lunch')),
      button('Short break', () => window.tracker.startBreak('break')),
      button('Open Crewline to check out', () => window.tracker.openWebsite(), 'wide'),
    );
  } else if (st.state === 'lunch' || st.state === 'break') {
    actions.append(button('End break, resume work', () => window.tracker.endBreak(), 'primary wide'));
  } else if (st.state === 'out') {
    actions.append(button('Open Crewline to check in', () => window.tracker.openWebsite(), 'primary wide'));
  }
}

// Two-step sign-in: after the password, admins enter the code Crewline emailed them.
let awaitingCode = false;
function showCodeStep(on, email) {
  awaitingCode = on;
  $('creds').hidden = on;
  $('code-step').hidden = !on;
  $('email').required = !on;
  $('password').required = !on;
  $('code').required = on;
  $('code').value = '';
  if (on) {
    $('code-sent').textContent = `We emailed a 6-digit code to ${email}. It works for 10 minutes.`;
    $('code').focus();
  }
  $('signin-btn').textContent = on ? 'Verify' : 'Sign in';
}
$('code-back').onclick = () => {
  window.tracker.signInCancel();
  showCodeStep(false);
};
$('signin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const label = $('signin-btn').textContent;
  $('signin-btn').disabled = true;
  $('signin-btn').textContent = awaitingCode ? 'Checking…' : 'Signing in…';
  let r;
  try {
    r = awaitingCode
      ? await window.tracker.signInCode($('code').value.trim())
      : await window.tracker.signIn($('email').value.trim(), $('password').value);
  } catch {
    r = { error: 'Sign-in failed. Please try again.' };
  } finally {
    $('signin-btn').disabled = false;
    $('signin-btn').textContent = label;
  }
  if (r.error) {
    $('error').hidden = false;
    $('error').textContent = r.error;
    if (r.restart) showCodeStep(false);
  } else if (r.twoStep) {
    $('error').hidden = true;
    showCodeStep(true, r.email);
  } else {
    $('password').value = '';
    showCodeStep(false);
  }
});
$('update-btn').onclick = () => window.tracker.installUpdate();
$('signout').onclick = () => window.tracker.signOut();
$('task').onchange = (e) => {
  e.target.blur(); // the list only refreshes while it isn't focused
  window.tracker.pickTask(e.target.value);
};
// Opened and closed without picking, or the window hidden while it's focused: let the list refresh again.
document.addEventListener('visibilitychange', () => document.hidden && $('task').blur());
window.addEventListener('blur', () => $('task').blur());
$('task').addEventListener('keydown', (e) => e.key === 'Escape' && e.target.blur());
$('perm-open').onclick = () => window.tracker.openScreenSettings();

window.tracker.onState(render);
window.tracker.state().then(render);
