import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp, useLive } from '../context.jsx';
import Icon from './Icon.jsx';
import { fmtDate } from '../format.js';

export const DOC_CATEGORIES = {
  id_proof: 'ID proof', offer_letter: 'Offer letter', contract: 'Contract', payslip: 'Payslip', certificate: 'Certificate', other: 'Other',
};
export const fileSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
export const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx,.txt,.csv,.zip';

/** One person's documents: list, open, upload; `canDelete` for admin/HR. */
export default function Documents({ userId, canDelete }) {
  const { toast } = useApp();
  const [docs, setDocs] = useState(null);
  const [category, setCategory] = useState('id_proof');
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const load = () => api.get(`/employees/${userId}/documents`).then(setDocs).catch((err) => { toast(err.message, 'error'); setDocs([]); });
  useEffect(() => { load(); }, [userId]);
  useLive(['document'], load);

  const upload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) return toast('Files can be up to 4 MB', 'error');
    setBusy(true);
    try {
      await api.upload(`/employees/${userId}/documents`, file, { category });
      toast(`${file.name} uploaded`);
      load();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const open = (d) => api.openFile(`/documents/${d.id}/url`).catch((err) => toast(err.message, 'error'));
  const remove = async (d) => {
    if (!confirm(`Delete ${d.name}? This can't be undone.`)) return;
    try {
      await api.del(`/documents/${d.id}`);
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <div className="stack">
      <div className="row wrap" style={{ gap: 10 }}>
        <select className="input" style={{ width: 'auto' }} value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Document type">
          {Object.entries(DOC_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? <span className="spin" /> : <Icon name="plus" size={15} />} Upload
        </button>
        <span className="small muted">PDF, image, Word or Excel · up to 4 MB</span>
        <input ref={input} type="file" accept={ACCEPT} hidden onChange={upload} />
      </div>
      {!docs ? <div className="muted small">Loading…</div> : docs.length ? docs.map((d) => (
        <div key={d.id} className="check-item">
          <div className="notice-icon"><Icon name="file" size={16} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <button className="link-btn" style={{ textAlign: 'left', overflowWrap: 'anywhere' }} onClick={() => open(d)}>{d.name}</button>
            <div className="small muted">{DOC_CATEGORIES[d.category] || 'Other'} · {fileSize(d.bytes)} · {fmtDate(d.created_at, { day: 'numeric', month: 'short', year: 'numeric' })}{d.uploaded_by_name ? ` · by ${d.uploaded_by_name}` : ''}</div>
          </div>
          {canDelete && <button className="btn btn-icon btn-sm" onClick={() => remove(d)} aria-label={`Delete ${d.name}`}><Icon name="trash" size={14} /></button>}
        </div>
      )) : <div className="muted small">No documents yet.</div>}
    </div>
  );
}
