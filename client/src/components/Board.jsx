import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp, useLive } from '../context.jsx';
import Icon from './Icon.jsx';
import { Field, Modal } from './ui.jsx';
import { addDays, fmtDate } from '../format.js';

function PostModal({ onClose, onPosted }) {
  const { toast } = useApp();
  const [form, setForm] = useState({ title: '', body: '', expires_on: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const post = async () => {
    setBusy(true);
    try {
      await api.post('/announcements', form);
      toast('Announcement posted');
      onPosted();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="New announcement" onClose={onClose} width={560}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !form.title.trim()} onClick={post}>Post to everyone</button></>}>
      <div className="form-grid">
        <Field label="Title" full><input className="input" value={form.title} onChange={set('title')} placeholder="Office closed on Friday" maxLength={150} autoFocus /></Field>
        <Field label="Message" full><textarea className="input" rows={4} value={form.body} onChange={set('body')} placeholder="Optional details" /></Field>
        <Field label="Show until (optional)"><input className="input" type="date" value={form.expires_on} onChange={set('expires_on')} /></Field>
      </div>
    </Modal>
  );
}

/** Notice board: everyone reads, admin/HR post and remove. */
export function Announcements() {
  const { isManager, toast } = useApp();
  const [items, setItems] = useState(null);
  const [posting, setPosting] = useState(false);
  const load = () => api.get('/announcements').then(setItems).catch(() => setItems([]));
  useEffect(() => { load(); }, []);
  useLive(['announcement'], load);

  const remove = async (a) => {
    if (!confirm(`Remove "${a.title}"?`)) return;
    try {
      await api.del(`/announcements/${a.id}`);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  if (!items || (!items.length && !isManager)) return null;
  return (
    <div className="card" style={{ marginBottom: 22 }}>
      <div className="card-head">
        <h2>Announcements</h2>
        {isManager && <button className="btn btn-sm" onClick={() => setPosting(true)}><Icon name="plus" size={15} /> New</button>}
      </div>
      <div className="stack">
        {items.map((a) => (
          <div key={a.id} className="notice">
            <div className="notice-icon"><Icon name="bell" size={16} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{a.title}</b>
              {a.body && <div className="notice-body">{a.body}</div>}
              <div className="small muted">
                {a.author || 'Admin'} · {fmtDate(a.created_at, { day: 'numeric', month: 'short' })}
                {a.expires_on && ` · until ${fmtDate(a.expires_on, { day: 'numeric', month: 'short' })}`}
              </div>
            </div>
            {isManager && <button className="btn btn-icon btn-sm" onClick={() => remove(a)} aria-label={`Remove ${a.title}`}><Icon name="x" size={14} /></button>}
          </div>
        ))}
        {!items.length && <div className="muted small">Nothing posted. Use New to tell everyone about a holiday, an office closure or news.</div>}
      </div>
      {posting && <PostModal onClose={() => setPosting(false)} onPosted={() => { setPosting(false); load(); }} />}
    </div>
  );
}

/** Birthdays and work anniversaries over the next two weeks. */
export function Celebrations() {
  const [data, setData] = useState(null);
  const load = () => api.get('/celebrations').then(setData).catch(() => setData(null));
  useEffect(() => { load(); }, []);
  useLive(['employee'], load);
  if (!data?.items.length) return null;
  const when = (on) => (on === data.today ? 'Today' : on === addDays(data.today, 1) ? 'Tomorrow'
    : fmtDate(on, { weekday: 'short', day: 'numeric', month: 'short' }));
  return (
    <div className="card" style={{ marginBottom: 22 }}>
      <div className="card-head"><h2>Celebrations</h2><span className="small muted">Next 2 weeks</span></div>
      <div className="celebrations">
        {data.items.map((c) => (
          <div key={`${c.kind}-${c.user_id}`} className={`celebration ${c.on === data.today ? 'today' : ''}`}>
            <div className="celebration-emoji" aria-hidden="true">{c.kind === 'birthday' ? '🎂' : '🎉'}</div>
            <div style={{ minWidth: 0 }}>
              <b>{c.name}</b>
              <div className="small muted">
                {c.kind === 'birthday' ? 'Birthday' : `${c.years} year${c.years === 1 ? '' : 's'} at work`} · {when(c.on)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
