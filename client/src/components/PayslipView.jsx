import { useState } from 'react';
import Icon from './Icon.jsx';
import { API_BASE, getToken } from '../api.js';
import { useApp } from '../context.jsx';
import { amountInWords, fmtCurrency, fmtDate, isoDate, monthName } from '../format.js';

/** Saves the server-made PDF (the same file that's emailed). */
async function downloadPdf(slip) {
  const token = getToken();
  const res = await fetch(`${API_BASE}/payroll/payslips/${slip.id}/pdf`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Couldn't download the payslip");
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || `Payslip-${slip.month}.pdf`;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Prints only the payslip (the browser's print dialog also offers "Save as PDF"). */
export function printPayslip() {
  document.body.classList.add('print-payslip');
  const done = () => {
    document.body.classList.remove('print-payslip');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
}

function Rows({ rows, currency, total, totalLabel }) {
  return (
    <table>
      <thead><tr><th>{totalLabel === 'Total earnings' ? 'Earnings' : 'Deductions'}</th><th className="num">Amount</th></tr></thead>
      <tbody>
        {rows.filter(([, v, always]) => always || v).map(([label, value, , hint]) => (
          <tr key={label}>
            <td>{label}{hint && <div className="small muted">{hint}</div>}</td>
            <td className="num tnum">{fmtCurrency(value, currency)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot><tr><td>{totalLabel}</td><td className="num tnum">{fmtCurrency(total, currency)}</td></tr></tfoot>
    </table>
  );
}

export default function PayslipView({ slip, companyName, companyLogo, currency = 'INR', draft }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      await downloadPdf(slip);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const earnings = [
    ['Basic', slip.basic, true],
    ['House Rent Allowance', slip.hra, true],
    ['Special Allowance', slip.special, true],
    ['Bonus', slip.bonus, false, slip.bonus && slip.adjustment_note ? slip.adjustment_note : null],
  ];
  const deductions = [
    ['Provident Fund (PF)', slip.pf, true],
    ['Professional Tax', slip.pt, true],
    ['Other deductions', slip.other_deduction, false, slip.other_deduction && slip.adjustment_note ? slip.adjustment_note : null],
  ];
  const totalEarnings = slip.gross + slip.bonus;
  const totalDeductions = slip.pf + slip.pt + slip.other_deduction;
  const info = [
    ['Employee', slip.name], ['Employee code', slip.emp_code || '—'], ['Department', slip.department || '—'], ['Designation', slip.designation || '—'],
    ['Working days', slip.working_days], ['Payable days', slip.payable_days], ['Present', slip.present], ['Paid leave', slip.paid_leave],
    ['Unpaid leave', slip.unpaid_leave], ['Absent', slip.absent], ['Hours worked', slip.hours], ['Monthly salary', fmtCurrency(slip.monthly_salary, currency)],
  ];

  return (
    <div className="stack">
      <div className="payslip">
        <div className="payslip-head">
          <div className="payslip-company">
            {companyLogo && <img className="payslip-logo" src={companyLogo} alt="" />}
            <div>
              <div className="muted small" style={{ fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Payslip</div>
              <h1>{companyName}</h1>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{monthName(slip.month)}</div>
            <div className="muted small">{draft ? 'Draft — not yet sent' : slip.published_at ? `Issued ${fmtDate(slip.published_at)}` : ''}</div>
          </div>
        </div>
        <div className="payslip-grid">
          {info.map(([k, v]) => <div key={k}><div className="k">{k}</div><div className="v tnum">{v}</div></div>)}
        </div>
        <div className="payslip-cols">
          <Rows rows={earnings} currency={currency} total={totalEarnings} totalLabel="Total earnings" />
          <Rows rows={deductions} currency={currency} total={totalDeductions} totalLabel="Total deductions" />
        </div>
        <div className="payslip-net">
          <div>
            <div className="muted small" style={{ fontWeight: 700 }}>NET PAY</div>
            <div className="small">{currency === 'INR' ? 'Rupees' : currency} {amountInWords(slip.net, currency)} only</div>
          </div>
          <div className="amount tnum">{fmtCurrency(slip.net, currency)}</div>
        </div>
        <div className="payslip-foot">
          {slip.lop > 0 && <>Loss of pay for unpaid / absent days: {fmtCurrency(slip.lop, currency)} (already reflected in earnings). </>}
          This is a system-generated payslip and does not require a signature.
          <div className="payslip-printed">Printed on {fmtDate(isoDate())}</div>
        </div>
      </div>
      <div className="row no-print" style={{ justifyContent: 'flex-end', gap: 10 }}>
        <button className="btn" onClick={printPayslip}><Icon name="file" /> Print</button>
        {slip.id && <button className="btn btn-primary" onClick={download} disabled={busy}>{busy ? <span className="spin" /> : <Icon name="download" />} Download PDF</button>}
      </div>
    </div>
  );
}
