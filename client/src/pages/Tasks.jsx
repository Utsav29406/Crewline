import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp, useLive } from '../context.jsx';
import Icon from '../components/Icon.jsx';
import { Badge, Field, Modal, PageHead, StatCard, Who } from '../components/ui.jsx';
import { addDays, fmtDate, fmtMinutes, fmtTime, isoDate } from '../format.js';
import { ACCEPT, fileSize } from '../components/Documents.jsx';

const STATUS = { todo: 'To do', progress: 'In progress', done: 'Done' };
const NEXT = { todo: 'progress', progress: 'done', done: 'todo' };
const PRIORITY_TONE = { high: 'bad', medium: 'warn', low: 'muted' };
const cap = (s) => s[0].toUpperCase() + s.slice(1);

const today = () => isoDate();
const isOverdue = (t) => t.status !== 'done' && t.due_date && t.due_date < today();
const dueLabel = (t) => {
  if (!t.due_date) return 'No due date';
  if (t.status !== 'done' && t.due_date === today()) return 'Due today';
  return `${isOverdue(t) ? 'Overdue · ' : 'Due '}${fmtDate(t.due_date, { weekday: 'short', day: 'numeric', month: 'short' })}`;
};

/** Click to move a task along: To do → In progress → Done → To do. */
function StatusDot({ task, onChange }) {
  return (
    <button type="button" className={`task-dot ${task.status}`} onClick={() => onChange(task, NEXT[task.status])}
      title={`${STATUS[task.status]}: click for ${STATUS[NEXT[task.status]]}`} aria-label={`${STATUS[task.status]}. Mark ${STATUS[NEXT[task.status]]}`} />
  );
}

/** Time logged by the tracker, against the estimate when there is one. */
function TimeLogged({ task }) {
  const logged = Math.round(task.logged_seconds / 60);
  if (!task.estimate_minutes) return <span className="tnum">{logged ? fmtMinutes(logged) : '—'}</span>;
  const pct = Math.min(100, Math.round((logged / task.estimate_minutes) * 100));
  return (
    <div className="task-time">
      <span className="tnum">{fmtMinutes(logged)} <span className="muted">/ {fmtMinutes(task.estimate_minutes)}</span></span>
      <div className={`meter task-meter ${logged > task.estimate_minutes ? 'over' : ''}`}><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function TaskForm({ task, employees, onClose, onDone }) {
  const { toast } = useApp();
  const [form, setForm] = useState(() => ({
    title: task?.title || '',
    details: task?.details || '',
    assignee_id: task?.assignee_id || '',
    priority: task?.priority || 'medium',
    due_date: task?.due_date || '',
    estimate_hours: task?.estimate_minutes ? String(task.estimate_minutes / 60) : '',
  }));
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    try {
      const body = {
        title: form.title, details: form.details, assignee_id: Number(form.assignee_id), priority: form.priority,
        due_date: form.due_date, estimate_minutes: form.estimate_hours === '' ? null : Math.round(Number(form.estimate_hours) * 60),
      };
      // Only send the assignee when it changes: the server re-checks it, and someone since deactivated would fail.
      if (task && body.assignee_id === task.assignee_id) delete body.assignee_id;
      if (task) await api.patch(`/tasks/${task.id}`, body);
      else await api.post('/tasks', body);
      toast(task ? 'Task updated' : 'Task assigned');
      onDone();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/tasks/${task.id}`);
      toast('Task deleted');
      onDone();
    } catch (err) {
      toast(err.message, 'error');
      setBusy(false);
    }
  };
  return (
    <Modal title={task ? 'Edit task' : 'New task'} onClose={onClose}
      footer={<>
        {task && <button className="btn btn-danger" disabled={busy} onClick={remove} style={{ marginRight: 'auto' }}><Icon name="trash" /> Delete</button>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !form.title.trim() || !form.assignee_id} onClick={save}>{task ? 'Save changes' : 'Assign task'}</button>
      </>}>
      <div className="form-grid">
        <Field label="Title" full><input className="input" value={form.title} onChange={set('title')} placeholder="e.g. Prepare GST return for October" autoFocus /></Field>
        <Field label="Details" full><textarea className="input" value={form.details} onChange={set('details')} placeholder="Optional" /></Field>
        <Field label="Assign to">
          <select className="input" value={form.assignee_id} onChange={set('assignee_id')}>
            <option value="">Choose a person</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            {task && !employees.some((e) => e.id === task.assignee_id) && <option value={task.assignee_id}>{task.assignee}</option>}
          </select>
        </Field>
        <Field label="Priority">
          <select className="input" value={form.priority} onChange={set('priority')}>
            {['high', 'medium', 'low'].map((p) => <option key={p} value={p}>{cap(p)}</option>)}
          </select>
        </Field>
        <Field label="Due date"><input type="date" className="input" value={form.due_date} onChange={set('due_date')} /></Field>
        <Field label="Estimate (hours)"><input type="number" min="0" step="0.5" className="input" value={form.estimate_hours} onChange={set('estimate_hours')} placeholder="Optional" /></Field>
      </div>
      {!task && <p className="small muted">They get a notification, and the task appears in their desktop tracker's "Working on" list.</p>}
    </Modal>
  );
}

/** Button showing how many comments a task has; opens its discussion. */
const TalkButton = ({ task, onOpen }) => (
  <button className="btn btn-sm" onClick={() => onOpen(task)} title="Comments and files" aria-label={`Comments on ${task.title}`}>
    <Icon name="chat" size={14} />{task.comment_count > 0 && <span className="tnum">{task.comment_count}</span>}
  </button>
);

/** A task's discussion: comments and files, newest at the bottom. */
function Discussion({ task, onClose }) {
  const { user, isManager, toast } = useApp();
  const [items, setItems] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const end = useRef(null);
  const load = useCallback(() => api.get(`/tasks/${task.id}/comments`).then(setItems).catch((err) => toast(err.message, 'error')), [task.id, toast]);
  useEffect(() => { load(); }, [load]);
  useLive(['task'], load);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [items?.length]);

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api.post(`/tasks/${task.id}/comments`, { body: text });
      setText('');
      load();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const attach = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) return toast('Files can be up to 4 MB', 'error');
    setBusy(true);
    try {
      await api.upload(`/tasks/${task.id}/files`, file);
      load();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (c) => {
    if (!confirm(c.file_name ? `Delete ${c.file_name}?` : 'Delete this comment?')) return;
    try {
      await api.del(`/tasks/${task.id}/comments/${c.id}`);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const canRemove = (c) => c.user_id === user.id || isManager || user.juniors > 0;

  return (
    <Modal title={task.title} onClose={onClose} width={620}>
      <div className="small muted" style={{ marginTop: -6, marginBottom: 12 }}>{task.assignee} · {STATUS[task.status]}{task.details ? ` · ${task.details}` : ''}</div>
      <div className="thread">
        {!items ? <div className="muted small">Loading…</div> : items.map((c) => (
          <div key={c.id} className={`bubble ${c.user_id === user.id ? 'mine' : ''}`}>
            <div className="bubble-head small">
              <b>{c.user_id === user.id ? 'You' : c.author || 'Someone'}</b>
              <span className="muted">{fmtDate(c.created_at, { day: 'numeric', month: 'short' })} {fmtTime(c.created_at)}</span>
              {canRemove(c) && <button className="link-btn muted small" onClick={() => remove(c)} aria-label="Delete">✕</button>}
            </div>
            {c.body && <div className="bubble-body">{c.body}</div>}
            {c.file_name && (
              <button className="file-chip" onClick={() => api.openFile(`/tasks/${task.id}/comments/${c.id}/url`).catch((err) => toast(err.message, 'error'))}>
                <Icon name="paperclip" size={14} /> <span>{c.file_name}</span> <span className="muted">{fileSize(c.bytes)}</span>
              </button>
            )}
          </div>
        ))}
        {items && !items.length && <div className="muted small" style={{ textAlign: 'center', padding: 16 }}>No comments yet. Ask a question, share an update or attach a file.</div>}
        <div ref={end} />
      </div>
      <form className="row" style={{ gap: 8, marginTop: 12 }} onSubmit={send}>
        <button type="button" className="btn btn-icon" title="Attach a file (up to 4 MB)" aria-label="Attach a file" disabled={busy} onClick={() => input.current?.click()}>
          <Icon name="paperclip" size={16} />
        </button>
        <input ref={input} type="file" accept={ACCEPT} hidden onChange={attach} />
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a comment…" maxLength={2000} />
        <button className="btn btn-primary" disabled={busy || !text.trim()}>{busy ? <span className="spin" /> : <Icon name="send" size={16} />}</button>
      </form>
    </Modal>
  );
}

function TeamTasks({ tasks, employees, onStatus, onEdit, onTalk }) {
  const [filter, setFilter] = useState('open');
  const [who, setWho] = useState('');
  const rows = tasks.filter((t) => (filter === 'open' ? t.status !== 'done' : filter === 'all' || t.status === filter)
    && (!who || t.assignee_id === Number(who)));
  return (
    <div className="card">
      <div className="row wrap" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
        <div className="tabs">
          {[['open', 'Open'], ['todo', 'To do'], ['progress', 'In progress'], ['done', 'Done'], ['all', 'All']].map(([k, label]) => (
            <button key={k} className={`tab ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
        <select className="input" style={{ width: 'auto' }} value={who} onChange={(e) => setWho(e.target.value)} aria-label="Employee">
          <option value="">Everyone</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </div>
      <div className="table-wrap">
        <table className="table-cards">
          <thead><tr><th>Task</th><th>Assigned to</th><th>Priority</th><th>Due</th><th className="num">Time logged</th><th /></tr></thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className={t.status === 'done' ? 'task-done' : ''}>
                <td style={{ whiteSpace: 'normal', minWidth: 220 }}>
                  <div className="task-title">
                    <StatusDot task={t} onChange={onStatus} />
                    <div style={{ minWidth: 0 }}>
                      <b>{t.title}</b>
                      <div className="small muted">{STATUS[t.status]}{t.details ? ` · ${t.details}` : ''}</div>
                    </div>
                  </div>
                </td>
                <td><Who name={t.assignee} sub={t.emp_code} /></td>
                <td><Badge tone={PRIORITY_TONE[t.priority]}>{cap(t.priority)}</Badge></td>
                <td className={isOverdue(t) ? 'tone-bad' : ''} style={{ fontWeight: isOverdue(t) ? 700 : undefined }}>{dueLabel(t)}</td>
                <td className="num"><TimeLogged task={t} /></td>
                <td>
                  <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                    <TalkButton task={t} onOpen={onTalk} />
                    <button className="btn btn-icon btn-sm" onClick={() => onEdit(t)} aria-label={`Edit ${t.title}`} title="Edit"><Icon name="edit" /></button>
                  </div>
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="empty">No tasks here. Use “New task” to assign one.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MyTasks({ tasks, onStatus, onTalk }) {
  const open = tasks.filter((t) => t.status !== 'done');
  const soon = open.filter((t) => !t.due_date || t.due_date <= addDays(isoDate(), 6));
  const groups = [
    ['Due this week', soon],
    ['Later', open.filter((t) => !soon.includes(t))],
    ['Done', tasks.filter((t) => t.status === 'done')],
  ].filter(([, list]) => list.length);
  return (
    <div className="card">
      {groups.map(([title, list]) => (
        <div key={title} className="task-group">
          <div className="task-group-title">{title}</div>
          {list.map((t) => (
            <div key={t.id} className={`my-task ${t.status === 'done' ? 'task-done' : ''}`}>
              <StatusDot task={t} onChange={onStatus} />
              <div style={{ minWidth: 0 }}>
                <b>{t.title}</b>
                <div className="my-task-meta small">
                  <Badge tone={PRIORITY_TONE[t.priority]}>{cap(t.priority)}</Badge>
                  <span className={isOverdue(t) ? 'tone-bad' : 'muted'}>{dueLabel(t)}</span>
                  {t.logged_seconds > 0 && <span className="muted tnum">· {fmtMinutes(Math.round(t.logged_seconds / 60))} logged{t.estimate_minutes ? ` of ${fmtMinutes(t.estimate_minutes)}` : ''}</span>}
                  {t.created_by_name && <span className="muted">· from {t.created_by_name}</span>}
                </div>
                {t.details && <div className="small muted" style={{ marginTop: 4 }}>{t.details}</div>}
              </div>
              <div className="row">
                <TalkButton task={t} onOpen={onTalk} />
                {t.status === 'todo' && <button className="btn btn-sm" onClick={() => onStatus(t, 'progress')}>Start</button>}
                {t.status === 'progress' && <button className="btn btn-sm btn-good" onClick={() => onStatus(t, 'done')}><Icon name="check" /> Mark done</button>}
              </div>
            </div>
          ))}
        </div>
      ))}
      {!groups.length && <div className="empty">No tasks yet. When admin or HR assigns you one, it shows up here and in your desktop tracker.</div>}
    </div>
  );
}

export default function Tasks() {
  const { isManager, user, toast } = useApp();
  // Admin/HR lead everyone; a senior leads the people who report to them.
  const leads = isManager || user.juniors > 0;
  const [tab, setTab] = useState(leads ? 'team' : 'mine');
  const [tasks, setTasks] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [editing, setEditing] = useState(null); // null, 'new' or a task
  const [talking, setTalking] = useState(null); // the task whose discussion is open

  // Switching tabs while a slower load is still out: only the newest response may land.
  const latest = useRef(0);
  const load = useCallback(() => {
    const n = ++latest.current;
    api.get(`/tasks${tab === 'mine' ? '?mine=1' : isManager ? '' : '?team=1'}`)
      .then((r) => n === latest.current && setTasks(r))
      .catch((err) => n === latest.current && toast(err.message, 'error'));
  }, [tab, isManager, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (leads) api.get('/tasks/people').then(setEmployees);
  }, [leads]);
  useLive(['task'], load);

  const setStatus = async (task, status) => {
    try {
      await api.patch(`/tasks/${task.id}`, { status });
      if (status === 'done') toast(`Done: ${task.title}`);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const open = tasks.filter((t) => t.status !== 'done');
  const weekAgo = addDays(isoDate(), -6);
  const stats = [
    ['To do', tasks.filter((t) => t.status === 'todo').length, 'file', 'muted'],
    ['In progress', tasks.filter((t) => t.status === 'progress').length, 'clock', 'info'],
    ['Done this week', tasks.filter((t) => t.status === 'done' && t.completed_at?.slice(0, 10) >= weekAgo).length, 'check', 'good'],
    ['Overdue', open.filter(isOverdue).length, 'alert', 'bad'],
  ];

  return (
    <>
      <PageHead title={tab === 'mine' ? 'My tasks' : 'Tasks'}
        subtitle={tab === 'mine' ? `${user.name} · ${open.length} open`
          : `${open.length} open across ${new Set(open.map((t) => t.assignee_id)).size} people${isManager ? '' : ` · your team of ${employees.length}`}`}>
        {leads && (
          <div className="tabs">
            <button className={`tab ${tab === 'team' ? 'active' : ''}`} onClick={() => setTab('team')}>Team tasks</button>
            <button className={`tab ${tab === 'mine' ? 'active' : ''}`} onClick={() => setTab('mine')}>My tasks</button>
          </div>
        )}
        {leads && <button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" /> New task</button>}
      </PageHead>

      <div className="grid grid-4" style={{ marginBottom: 22 }}>
        {stats.map(([label, value, icon, tone]) => <StatCard key={label} icon={icon} label={label} value={value} tone={tone} />)}
      </div>

      {tab === 'team'
        ? <TeamTasks tasks={tasks} employees={employees} onStatus={setStatus} onEdit={setEditing} onTalk={setTalking} />
        : <MyTasks tasks={tasks} onStatus={setStatus} onTalk={setTalking} />}
      {talking && <Discussion task={talking} onClose={() => setTalking(null)} />}

      {editing && (
        <TaskForm task={editing === 'new' ? null : editing} employees={employees}
          onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} />
      )}
    </>
  );
}
