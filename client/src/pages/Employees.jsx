import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp, useLive } from '../context.jsx';
import Icon from '../components/Icon.jsx';
import FaceCapture from '../components/FaceCapture.jsx';
import Documents from '../components/Documents.jsx';
import { Badge, Field, Modal, PageHead, Who } from '../components/ui.jsx';
import { fmtDate, fmtMoney } from '../format.js';

const EMPTY = { emp_code: '', name: '', email: '', role: 'employee', department_id: '', geofence_id: '', designation: '', phone: '', joined_on: '', birth_date: '', salary: '', status: 'active', reports_to: '', password: '' };

function EmployeeForm({ initial, departments, geofences, onClose, onSaved }) {
  const { user, toast } = useApp();
  const [form, setForm] = useState({ ...EMPTY, ...initial, password: '' });
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState(!initial?.id);
  const [people, setPeople] = useState([]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const editing = Boolean(initial?.id);
  useEffect(() => { api.get('/employees').then((list) => setPeople(list.filter((p) => p.status === 'active' && p.id !== initial?.id))).catch(() => {}); }, [initial?.id]);

  const save = async () => {
    setBusy(true);
    try {
      const body = { ...form };
      if (!body.password || (!editing && invite)) delete body.password;
      if (!editing && invite) body.invite = true;
      for (const k of ['id', 'department', 'geofence', 'face_enrolled', 'reports_to_name', 'juniors', 'invited_at']) delete body[k];
      editing ? await api.put(`/employees/${initial.id}`, body) : await api.post('/employees', body);
      toast(editing ? 'Employee updated' : invite ? `Invite sent to ${form.email}` : 'Employee added');
      onSaved();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={editing ? 'Edit employee' : 'Add employee'} onClose={onClose} width={720}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={save}>{editing ? 'Save changes' : invite ? 'Add & send invite' : 'Add employee'}</button></>}>
      <div className="form-grid">
        <Field label="Full name"><input className="input" value={form.name} onChange={set('name')} /></Field>
        <Field label="Employee code"><input className="input" value={form.emp_code || ''} onChange={set('emp_code')} placeholder="CL007" /></Field>
        <Field label="Work email"><input className="input" type="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Phone"><input className="input" value={form.phone || ''} onChange={set('phone')} /></Field>
        <Field label="Department">
          <select className="input" value={form.department_id || ''} onChange={set('department_id')}>
            <option value="">—</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
        <Field label="Designation"><input className="input" value={form.designation || ''} onChange={set('designation')} /></Field>
        <Field label="Reports to (senior)">
          <select className="input" value={form.reports_to || ''} onChange={set('reports_to')}>
            <option value="">No one</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.designation ? ` · ${p.designation}` : ''}</option>)}
          </select>
        </Field>
        <Field label="Work location (geofence)">
          <select className="input" value={form.geofence_id || ''} onChange={set('geofence_id')}>
            <option value="">Any active geofence</option>
            {geofences.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
        <Field label="Role">
          <select className="input" value={form.role} onChange={set('role')}>
            <option value="employee">Employee</option>
            <option value="hr">HR</option>
            {user.role === 'admin' && <option value="admin">Admin</option>}
          </select>
        </Field>
        <Field label="Joined on"><input className="input" type="date" value={form.joined_on || ''} onChange={set('joined_on')} /></Field>
        <Field label="Date of birth"><input className="input" type="date" value={form.birth_date || ''} onChange={set('birth_date')} /></Field>
        <Field label="Monthly salary"><input className="input" type="number" min="0" value={form.salary ?? ''} onChange={set('salary')} /></Field>
        <Field label="Status">
          <select className="input" value={form.status} onChange={set('status')}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </Field>
        {editing ? (
          <Field label="Reset password">
            <input className="input" type="password" value={form.password} onChange={set('password')} placeholder="Leave blank to keep" />
          </Field>
        ) : (
          <Field label="How they sign in">
            <select className="input" value={invite ? 'invite' : 'password'} onChange={(e) => setInvite(e.target.value === 'invite')}>
              <option value="invite">Email them an invite</option>
              <option value="password">I'll set a password</option>
            </select>
          </Field>
        )}
        {!editing && !invite && (
          <Field label="Password">
            <input className="input" type="password" value={form.password} onChange={set('password')} placeholder="Default: welcome123" />
          </Field>
        )}
      </div>
      {!editing && invite && (
        <p className="small muted" style={{ margin: '12px 0 0' }}>
          We'll email a link to choose their own password (valid 7 days). They can also use “Continue with Google” with this email.
          Use their real work email: made-up addresses never receive it.
        </p>
      )}
    </Modal>
  );
}

/** HR shares this link (WhatsApp, email…); anyone with it can ask to join with any email, Gmail included. */
function JoinLink({ onClose }) {
  const { toast } = useApp();
  const [code, setCode] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/join-link').then((r) => setCode(r.code)).catch((err) => toast(err.message, 'error')); }, [toast]);
  const url = code ? `${window.location.origin}/join/${code}` : '';
  const run = async (fn, msg) => {
    setBusy(true);
    try {
      setCode((await fn()).code);
      if (msg) toast(msg);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Join link copied');
    } catch {
      toast('Select the link and copy it', 'error');
    }
  };
  return (
    <Modal title="Join link" onClose={onClose} width={520}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          Share this link with new staff. They sign up with any email they use (Gmail too) or with Google, and wait here
          under <b>Waiting for approval</b> until you approve them.
        </p>
        {code === null ? <span className="spin" /> : code ? (
          <>
            <input className="input" readOnly value={url} onFocus={(e) => e.target.select()} />
            <div className="row wrap" style={{ gap: 8 }}>
              <button className="btn btn-primary" onClick={copy}><Icon name="paperclip" size={16} /> Copy link</button>
              <button className="btn" disabled={busy} onClick={() => confirm('Make a new link? The current one stops working.') && run(() => api.post('/join-link'), 'New join link made')}>
                <Icon name="refresh" size={16} /> New link
              </button>
              <button className="btn" disabled={busy} onClick={() => confirm('Turn off the join link? Nobody can use it to sign up.') && run(() => api.del('/join-link'), 'Join link turned off')}>
                <Icon name="x" size={16} /> Turn off
              </button>
            </div>
            <p className="small muted" style={{ margin: 0 }}>Anyone who gets the link can send a request, so only approve people you know.</p>
          </>
        ) : (
          <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api.post('/join-link'), 'Join link is on')}>
            <Icon name="users" size={16} /> Turn on join link
          </button>
        )}
      </div>
    </Modal>
  );
}

export default function Employees() {
  const { user, toast } = useApp();
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [departments, setDepartments] = useState([]);
  const [geofences, setGeofences] = useState([]);
  const [editing, setEditing] = useState(null);
  const [enrolling, setEnrolling] = useState(null);
  const [docsFor, setDocsFor] = useState(null);
  const [linkOpen, setLinkOpen] = useState(false);

  const load = useCallback(() => api.get(`/employees?q=${encodeURIComponent(q)}`).then(setRows), [q]);
  useEffect(() => {
    const id = setTimeout(load, 200);
    return () => clearTimeout(id);
  }, [load]);
  const loadOptions = () => {
    api.get('/departments').then(setDepartments);
    api.get('/geofences').then(setGeofences);
  };
  useEffect(loadOptions, []);
  useLive(['employee'], load);
  useLive(['org', 'geofence'], loadOptions);

  const enroll = async (descriptors) => {
    try {
      await api.post(`/employees/${enrolling.id}/face`, { descriptors });
      toast(`Face enrolled for ${enrolling.name}`);
      setEnrolling(null);
      load();
    } catch (err) {
      // The camera has already stopped, so close and let them start again rather than leave a dead dialog.
      toast(err.message, 'error');
      setEnrolling(null);
    }
  };
  const resetFace = async (e) => {
    if (!confirm(`Remove ${e.name}'s face enrollment?`)) return;
    try {
      await api.del(`/employees/${e.id}/face`);
      toast('Face enrollment removed');
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const act = async (fn, msg) => {
    try {
      await fn();
      toast(msg);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const approve = (e) => act(() => api.post(`/employees/${e.id}/approve`), `${e.name} can sign in now`);
  const reject = (e) => confirm(`Reject ${e.name}'s request to join? Their sign-up is deleted.`)
    && act(() => api.post(`/employees/${e.id}/reject`), 'Request rejected');
  const resend = (e) => act(() => api.post(`/employees/${e.id}/invite`), `Invite sent again to ${e.email}`);
  const pending = rows.filter((e) => e.status === 'pending');
  const people = rows.filter((e) => e.status !== 'pending');

  const remove = async (e) => {
    if (!confirm(`Delete ${e.name}? This also removes their attendance and leave history.`)) return;
    try {
      await api.del(`/employees/${e.id}`);
      toast('Employee deleted');
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <>
      <PageHead title="Employees" subtitle={`${people.length} people`}>
        <div className="row inset" style={{ padding: '0 14px' }}>
          <Icon name="search" />
          <input className="input" style={{ boxShadow: 'none', background: 'transparent', paddingLeft: 4 }} placeholder="Search name, email, code" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!user.is_demo && <button className="btn" onClick={() => setLinkOpen(true)}><Icon name="users" /> Join link</button>}
        <button className="btn btn-primary" onClick={() => setEditing({})}><Icon name="plus" /> Add employee</button>
      </PageHead>
      {linkOpen && <JoinLink onClose={() => setLinkOpen(false)} />}
      {pending.length > 0 && (
        <div className="card" style={{ marginBottom: 22 }}>
          <div className="card-head"><h2>Waiting for approval</h2><Badge tone="warn">{pending.length}</Badge></div>
          <p className="small muted" style={{ marginTop: 0 }}>They asked to join. Approve to let them sign in, then set their department, salary and the rest.</p>
          <div className="stack">
            {pending.map((e) => (
              <div key={e.id} className="row wrap" style={{ justifyContent: 'space-between', gap: 12 }}>
                <Who name={e.name} sub={e.email} />
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn btn-sm" onClick={() => reject(e)}><Icon name="x" size={16} /> Reject</button>
                  <button className="btn btn-sm btn-primary" onClick={() => approve(e)}><Icon name="check" size={16} /> Approve</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="card">
        <div className="table-wrap">
          <table className="table-cards">
            <thead><tr><th>Employee</th><th>Department</th><th>Location</th><th>Role</th><th>Face</th><th>Joined</th><th className="num">Salary</th><th>Status</th><th /></tr></thead>
            <tbody>
              {people.map((e) => (
                <tr key={e.id}>
                  <td><Who name={e.name} sub={`${e.emp_code || '—'} · ${e.email}`} /></td>
                  <td>{e.department || '—'}<div className="small muted">{e.designation}</div>
                    {e.reports_to_name && <div className="small muted">Reports to {e.reports_to_name}</div>}
                    {e.juniors > 0 && <div className="small tone-accent">Senior · {e.juniors} junior{e.juniors === 1 ? '' : 's'}</div>}</td>
                  <td>{e.geofence || <span className="muted">Any</span>}</td>
                  <td><Badge tone={e.role === 'employee' ? 'muted' : 'accent'}>{e.role}</Badge></td>
                  <td>{e.face_enrolled ? <Badge tone="good">enrolled</Badge> : <Badge tone="warn">missing</Badge>}</td>
                  <td>{fmtDate(e.joined_on)}</td>
                  <td className="num">{fmtMoney(e.salary)}</td>
                  <td><Badge status={e.status} />{e.invited_at && <div style={{ marginTop: 4 }}><Badge tone="info">invited</Badge></div>}</td>
                  <td>
                    <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                      {e.invited_at && <button className="btn btn-icon" title="Send invite again" aria-label={`Send invite again to ${e.name}`} onClick={() => resend(e)}><Icon name="send" size={17} /></button>}
                      <button className="btn btn-icon" title="Documents" aria-label={`Documents of ${e.name}`} onClick={() => setDocsFor(e)}><Icon name="file" size={17} /></button>
                      <button className="btn btn-icon" title="Enroll face" aria-label="Enroll face" onClick={() => setEnrolling(e)}><Icon name="face" size={17} /></button>
                      {e.face_enrolled && <button className="btn btn-icon" title="Reset face" aria-label="Reset face" onClick={() => resetFace(e)}><Icon name="refresh" size={17} /></button>}
                      {(user.role === 'admin' || e.role !== 'admin') && (
                        <button className="btn btn-icon" title="Edit" aria-label="Edit" onClick={() => setEditing(e)}><Icon name="edit" size={17} /></button>
                      )}
                      {user.role === 'admin' && e.id !== user.id && (
                        <button className="btn btn-icon btn-danger" title="Delete" aria-label="Delete" onClick={() => remove(e)}><Icon name="trash" size={17} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!people.length && <tr><td colSpan={9} className="empty">No employees found</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <EmployeeForm initial={editing} departments={departments} geofences={geofences}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
      {docsFor && (
        <Modal title={`Documents · ${docsFor.name}`} onClose={() => setDocsFor(null)} width={620}>
          <Documents userId={docsFor.id} canDelete />
        </Modal>
      )}
      {enrolling && (
        <Modal title={`Enroll face · ${enrolling.name}`} onClose={() => setEnrolling(null)} width={520}>
          <FaceCapture samples={5} onCapture={enroll} actionLabel="Enrollment" />
        </Modal>
      )}
    </>
  );
}
