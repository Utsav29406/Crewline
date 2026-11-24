import { useCallback, useEffect, useState } from 'react';
import { api, companyLogoUrl } from '../api.js';
import { useApp, useLive } from '../context.jsx';
import Icon from '../components/Icon.jsx';
import PayslipView from '../components/PayslipView.jsx';
import { Badge, Loading, Modal, PageHead } from '../components/ui.jsx';
import { fmtCurrency, fmtDate, monthName } from '../format.js';

export default function Payslips() {
  const { user, toast } = useApp();
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null);

  const load = useCallback(() => api.get('/payroll/my').then(setList), []);
  useEffect(() => { load(); }, [load]);
  useLive(['payroll'], load);

  const view = async (id) => {
    try {
      setOpen(await api.get(`/payroll/payslips/${id}`));
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  if (!list) return <Loading />;
  const latest = list[0];
  return (
    <>
      <PageHead title="Payslips" subtitle="Your monthly salary slips — view, print or save as PDF" />
      {latest && (
        <div className="card row wrap" style={{ marginBottom: 22 }}>
          <div className="stat-icon tone-good"><Icon name="wallet" size={22} /></div>
          <div className="spacer">
            <div className="small muted">Latest net pay · {monthName(latest.month)}</div>
            <div className="stat-value">{fmtCurrency(latest.net, latest.currency)}</div>
          </div>
          <button className="btn btn-primary" onClick={() => view(latest.id)}><Icon name="file" /> View payslip</button>
        </div>
      )}
      <div className="card">
        <div className="table-wrap">
          <table className="table-cards">
            <thead><tr><th>Month</th><th>Issued</th><th className="num">Gross + bonus</th><th className="num">Net pay</th><th /></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <td><b>{monthName(p.month)}</b> {!p.viewed_at && <Badge tone="accent">new</Badge>}</td>
                  <td>{fmtDate(p.published_at)}</td>
                  <td className="num">{fmtCurrency(p.gross + p.bonus, p.currency)}</td>
                  <td className="num"><b>{fmtCurrency(p.net, p.currency)}</b></td>
                  <td><div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn btn-sm" onClick={() => view(p.id)}><Icon name="file" size={14} /> View</button></div></td>
                </tr>
              ))}
              {!list.length && <tr><td colSpan={5} className="empty">No payslips yet — they appear here as soon as your employer sends payroll.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {open && (
        <Modal title={`Payslip · ${monthName(open.month)}`} onClose={() => setOpen(null)} width={860}>
          <PayslipView slip={open} companyName={open.company_name || user.company_name} companyLogo={companyLogoUrl(user)} currency={open.currency} />
        </Modal>
      )}
    </>
  );
}
