import { useCallback, useEffect, useState } from 'react';
import { api, companyLogoUrl } from '../api.js';
import { useApp, useLive } from '../context.jsx';
import Icon from '../components/Icon.jsx';
import PayslipView from '../components/PayslipView.jsx';
import { Badge, Field, Loading, Modal, PageHead, StatCard, Who } from '../components/ui.jsx';
import { addDays, fmtCurrency, fmtDate, isoDate, monthName } from '../format.js';

const previousMonth = () => addDays(`${isoDate().slice(0, 7)}-01`, -1).slice(0, 7);

function AdjustModal({ slip, currency, onClose, onSaved }) {
  const { toast } = useApp();
  const [form, setForm] = useState({ bonus: slip.bonus || '', other_deduction: slip.other_deduction || '', adjustment_note: slip.adjustment_note || '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const net = Math.max(slip.gross + (Number(form.bonus) || 0) - slip.pf - slip.pt - (Number(form.other_deduction) || 0), 0);
  const save = async () => {
    setBusy(true);
    try {
      await api.put(`/payroll/payslips/${slip.id}`, form);
      toast(`Updated ${slip.name}'s payslip`);
      onSaved();
    } catch (err) {
      toast(err.message, 'error');
      setBusy(false);
    }
  };
  return (
    <Modal title={`Adjust · ${slip.name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={save}>Save</button></>}>
      <div className="form-grid">
        <Field label="Bonus / incentive"><input className="input" type="number" min="0" value={form.bonus} onChange={set('bonus')} placeholder="0" /></Field>
        <Field label="Other deduction"><input className="input" type="number" min="0" value={form.other_deduction} onChange={set('other_deduction')} placeholder="0" /></Field>
        <Field label="Note (shown on payslip)" full><input className="input" maxLength={200} value={form.adjustment_note} onChange={set('adjustment_note')} placeholder="e.g. Diwali bonus, salary advance recovery" /></Field>
      </div>
      <div className="check-item" style={{ marginTop: 18 }}>
        <div style={{ flex: 1 }}>
          <div className="small muted">Gross {fmtCurrency(slip.gross, currency)} − PF {fmtCurrency(slip.pf, currency)} − PT {fmtCurrency(slip.pt, currency)}</div>
          <b>New net pay</b>
        </div>
        <span className="stat-value">{fmtCurrency(net, currency)}</span>
      </div>
    </Modal>
  );
}

export default function Payroll() {
  const { toast, user } = useApp();
  const [runs, setRuns] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [month, setMonth] = useState(previousMonth());
  const [busy, setBusy] = useState(false);
  const [adjusting, setAdjusting] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirmSend, setConfirmSend] = useState(false);

  const loadRuns = useCallback(() => api.get('/payroll/runs').then((r) => {
    setRuns(r);
    setSelected((cur) => (cur && r.some((x) => x.id === cur) ? cur : r[0]?.id ?? null));
  }), []);
  const loadDetail = useCallback(() => (selected ? api.get(`/payroll/runs/${selected}`).then(setDetail) : setDetail(null)), [selected]);
  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => { loadDetail(); }, [loadDetail]);
  useLive(['payroll'], () => { loadRuns(); loadDetail(); });

  const generate = async () => {
    setBusy(true);
    try {
      const run = await api.post('/payroll/runs', { month });
      toast(`Payroll for ${monthName(month)} generated — review it, then send`);
      await loadRuns();
      setSelected(run.id);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  /** Emails go out in rounds (each request stops before the server's time limit); keep asking until none are left. */
  const emailRest = async (runId, first, body = {}) => {
    let total = { emailed: first?.emailed || 0, failed: first?.failed || 0 };
    let remaining = first ? first.remaining : 1;
    for (let round = 0; remaining > 0 && round < 20; round++) {
      const r = await api.post(`/payroll/runs/${runId}/email`, round === 0 && !first ? body : {});
      total = { emailed: total.emailed + r.emailed, failed: total.failed + r.failed };
      remaining = r.remaining;
    }
    return total;
  };
  const emailNote = (e) => (e.noSmtp ? ' (email is not set up, so nothing was emailed)'
    : `, emailed to ${e.emailed}${e.failed ? ` · ${e.failed} couldn't be emailed` : ''}`);
  const publish = (r) => act(async () => {
    const res = await api.post(`/payroll/runs/${r.id}/publish`);
    return { sent: res.sent, email: res.email?.noSmtp ? res.email : await emailRest(r.id, res.email) };
  }, (res) => `Payslips sent to ${res.sent} employees${emailNote(res.email)}`);
  const emailAgain = (body, label) => act(() => emailRest(run.id, null, body),
    (e) => `${label}: emailed ${e.emailed}${e.failed ? `, ${e.failed} failed` : ''}`);

  const act = async (fn, msg, { deleted = false } = {}) => {
    setBusy(true);
    try {
      const r = await fn();
      toast(typeof msg === 'function' ? msg(r) : msg);
      await loadRuns();
      // A deleted run has no detail to reload: loadRuns already moved the selection, which loads the new one.
      if (!deleted) await loadDetail();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!runs) return <Loading />;
  const run = detail?.run;
  const slips = detail?.payslips || [];
  const currency = run?.currency || 'INR';
  const isDraft = run?.status === 'draft';
  const currentMonth = isoDate().slice(0, 7);

  return (
    <>
      <PageHead title="Payroll" subtitle="Generate payslips from attendance, review, then send them to every employee">
        <Field label="Month"><input type="month" className="input" value={month} max={currentMonth} onChange={(e) => setMonth(e.target.value)} /></Field>
        <button className="btn btn-primary" style={{ alignSelf: 'flex-end' }} disabled={busy || !month} onClick={generate}>
          {busy ? <span className="spin" /> : <Icon name="wallet" />} Generate payroll
        </button>
      </PageHead>
      {month === currentMonth && (
        <div className="check-item" style={{ marginBottom: 18 }}>
          <div className="check-dot badge-warn"><Icon name="alert" size={15} /></div>
          <div className="small">{monthName(month)} isn't over yet — days still to come count as absent. You can generate now and regenerate later; the draft keeps any bonuses you've entered.</div>
        </div>
      )}

      {!runs.length ? (
        <div className="card empty">
          <Icon name="wallet" size={32} />
          <h3 style={{ margin: '10px 0 4px' }}>No payroll yet</h3>
          <div>Pick a month and click <b>Generate payroll</b>. Nothing is sent to employees until you publish.</div>
        </div>
      ) : (
        <div className="grid payroll-grid">
          <div className="card stack" style={{ gap: 10 }}>
            <h3>Payroll runs</h3>
            {runs.map((r) => (
              <button key={r.id} className={`check-item btn ${selected === r.id ? 'active-run' : ''}`} style={{ justifyContent: 'flex-start', textAlign: 'left', width: '100%' }} onClick={() => setSelected(r.id)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{monthName(r.month)}</div>
                  <div className="small muted">{r.employees} people · {fmtCurrency(r.total_net, r.currency)}</div>
                </div>
                {r.status === 'published' ? <Badge tone="good">sent</Badge> : <Badge tone="warn">draft</Badge>}
              </button>
            ))}
          </div>

          {!run ? <Loading /> : (
            <div className="stack" style={{ gap: 22 }}>
              <div className="card">
                <div className="card-head" style={{ flexWrap: 'wrap' }}>
                  <div>
                    <h2>{monthName(run.month)} {isDraft ? <Badge tone="warn">draft</Badge> : <Badge tone="good">sent</Badge>}</h2>
                    <div className="small muted">
                      {run.working_days} working days · generated {fmtDate(run.generated_at)} by {run.generated_by_name || '—'}
                      {!isDraft && ` · sent ${fmtDate(run.published_at)} by ${run.published_by_name || '—'} · emailed to ${run.emailed} · opened by ${run.viewed} of ${run.employees}`}
                    </div>
                  </div>
                  {!isDraft && (Number(run.email_waiting) > 0 || Number(run.email_failed) > 0) && (
                    <button className="btn btn-sm" disabled={busy}
                      onClick={() => emailAgain({ retry: true }, 'Payslip emails')}>
                      {busy ? <span className="spin" /> : <Icon name="send" size={15} />} Email the remaining {Number(run.email_waiting) + Number(run.email_failed)}
                    </button>
                  )}
                  {isDraft && (
                    <div className="row wrap">
                      <button className="btn btn-sm btn-danger" disabled={busy}
                        onClick={() => confirm(`Delete the ${monthName(run.month)} draft?`) && act(() => api.del(`/payroll/runs/${run.id}`), 'Draft deleted', { deleted: true })}>
                        <Icon name="trash" size={15} /> Delete draft
                      </button>
                      <button className="btn btn-sm" disabled={busy} onClick={() => act(() => api.post('/payroll/runs', { month: run.month }), 'Recalculated from latest attendance')}>
                        <Icon name="refresh" size={15} /> Recalculate
                      </button>
                      <button className="btn btn-primary" disabled={busy} onClick={() => setConfirmSend(true)}>
                        <Icon name="send" /> Publish & send to {run.employees}
                      </button>
                    </div>
                  )}
                </div>
                <div className="grid grid-4">
                  <StatCard icon="users" label="Employees" value={run.employees} tone="accent" />
                  <StatCard icon="briefcase" label="Gross + bonus" value={fmtCurrency(run.total_gross, currency)} tone="info" />
                  <StatCard icon="wallet" label="Deductions" value={fmtCurrency(run.total_gross - run.total_net, currency)} tone="warn" />
                  <StatCard icon="check" label="Net payout" value={fmtCurrency(run.total_net, currency)} tone="good" />
                </div>
              </div>

              <div className="card">
                <div className="table-wrap">
                  <table className="table-cards">
                    <thead>
                      <tr>
                        <th>Employee</th><th className="num">Payable days</th><th className="num">Gross</th><th className="num">Bonus</th>
                        <th className="num">Deductions</th><th className="num">Net pay</th>{!isDraft && <><th>Email</th><th>Opened</th></>}<th />
                      </tr>
                    </thead>
                    <tbody>
                      {slips.map((p) => (
                        <tr key={p.id}>
                          <td><Who name={p.name} sub={`${p.emp_code || '—'} · ${p.designation || p.department || ''}`} /></td>
                          <td className="num">{p.payable_days} / {p.working_days}</td>
                          <td className="num">{fmtCurrency(p.gross, currency)}</td>
                          <td className="num">{p.bonus ? fmtCurrency(p.bonus, currency) : '—'}</td>
                          <td className="num">{fmtCurrency(p.pf + p.pt + p.other_deduction, currency)}</td>
                          <td className="num"><b>{fmtCurrency(p.net, currency)}</b></td>
                          {!isDraft && (
                            <td title={p.email_error || ''}>
                              {p.emailed_at ? <Badge tone="good">emailed</Badge> : p.email_error ? <Badge tone="bad">failed</Badge> : <Badge tone="muted">{p.user_id ? 'waiting' : '—'}</Badge>}
                              {p.email_error && <div className="small muted" style={{ maxWidth: 180 }}>{p.email_error}</div>}
                            </td>
                          )}
                          {!isDraft && <td>{p.viewed_at ? <Badge tone="good">opened</Badge> : <Badge tone="muted">not yet</Badge>}</td>}
                          <td>
                            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                              {isDraft && <button className="btn btn-sm" onClick={() => setAdjusting(p)}><Icon name="edit" size={14} /> Adjust</button>}
                              {!isDraft && p.user_id && (
                                <button className="btn btn-sm" disabled={busy} title="Email this payslip again"
                                  onClick={() => confirm(`Email ${p.name}'s payslip again?`) && emailAgain({ payslipId: p.id }, p.name)}>
                                  <Icon name="send" size={14} />
                                </button>
                              )}
                              <button className="btn btn-sm" onClick={() => setPreview(p)}><Icon name="file" size={14} /> View</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="small muted" style={{ marginBottom: 0 }}>
                  Salary split: Basic 50% · HRA 20% · Special 30%, pro-rated by payable days. PF and professional tax follow Settings → Payroll.
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {adjusting && <AdjustModal slip={adjusting} currency={currency} onClose={() => setAdjusting(null)} onSaved={() => { setAdjusting(null); loadDetail(); loadRuns(); }} />}
      {preview && (
        <Modal title={`Payslip · ${preview.name}`} onClose={() => setPreview(null)} width={860}>
          <PayslipView slip={{ ...preview, month: run.month, published_at: run.published_at }} companyName={user.company_name} companyLogo={companyLogoUrl(user)} currency={currency} draft={isDraft} />
        </Modal>
      )}
      {confirmSend && run && (
        <Modal title={`Send ${monthName(run.month)} payslips?`} onClose={() => setConfirmSend(false)}
          footer={<>
            <button className="btn" onClick={() => setConfirmSend(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy}
              onClick={() => { setConfirmSend(false); publish(run); }}>
              <Icon name="send" /> Send to {run.employees} employees
            </button>
          </>}>
          <p style={{ marginTop: 0 }}>
            Each employee gets their payslip by email and a notification, and can view and download it under <b>Payslips</b>. Total net payout:{' '}
            <b>{fmtCurrency(run.total_net, currency)}</b>.
          </p>
          <p className="muted small" style={{ marginBottom: 0 }}>Once sent, this month's payroll is locked — it can't be edited, recalculated or deleted.</p>
        </Modal>
      )}
    </>
  );
}
