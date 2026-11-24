import db, { getSettings } from './db.js';
import { addDays, isWeeklyOff, parseSaturdaysOff } from './utils.js';

/**
 * Attendance + leave summary for every active employee in a month — the basis of both
 * the Reports page and generated payslips, so the two always agree.
 */
export async function monthlySummary(companyId, month) {
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-${String(daysInMonth).padStart(2, '0')}`;

  const [holidayRows, employees, attRows, leaveRows, settings] = await Promise.all([
    db.all('SELECT date FROM holidays WHERE company_id = ? AND date BETWEEN ? AND ?', [companyId, monthStart, monthEnd]),
    db.all(
      `SELECT u.id, u.emp_code, u.name, u.salary, u.designation, u.joined_on, d.name AS department FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.company_id = ? AND (u.joined_on IS NULL OR u.joined_on <= ?)
         AND (u.status = 'active'
              -- someone who left mid-month still gets paid for the days they worked
              OR (u.status = 'inactive' AND EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = u.id AND a.date BETWEEN ? AND ?)))
       ORDER BY u.name`,
      [companyId, monthEnd, monthStart, monthEnd]
    ),
    db.all(
      `SELECT user_id, date::text AS date, status, COALESCE(work_minutes, 0) AS minutes
       FROM attendance WHERE company_id = ? AND date BETWEEN ? AND ?`,
      [companyId, monthStart, monthEnd]
    ),
    db.all(
      `SELECT user_id, type, start_date, end_date, half_day FROM leaves
       WHERE company_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?`,
      [companyId, monthEnd, monthStart]
    ),
    getSettings(companyId),
  ]);

  const holidays = new Set(holidayRows.map((h) => h.date));
  const saturdaysOff = parseSaturdaysOff(settings.saturdays_off);
  const isWorkingDay = (d) => !isWeeklyOff(d, saturdaysOff) && !holidays.has(d);
  let workingDays = 0;
  for (let d = monthStart; d <= monthEnd; d = addDays(d, 1)) if (isWorkingDay(d)) workingDays++;
  const attByUser = {};
  for (const r of attRows) (attByUser[r.user_id] ||= []).push(r);
  // Overtime is reported, not paid: worked minutes past the daily threshold, summed over the month.
  const overtimeAfter = Number(settings.overtime_after_minutes) || 480;
  const otRows = await db.all(
    `SELECT user_id, COALESCE(SUM(GREATEST(COALESCE(work_minutes, 0) - ?, 0)), 0)::int AS ot
     FROM attendance WHERE company_id = ? AND date BETWEEN ? AND ? AND check_out IS NOT NULL GROUP BY user_id`,
    [overtimeAfter, companyId, monthStart, monthEnd]
  );
  const otByUser = Object.fromEntries(otRows.map((r) => [r.user_id, r.ot]));

  const rows = employees.map((e) => {
    // Leave per working day: 1, or 0.5 for a half day (two half days on one date add up).
    const leaveDays = new Map();
    for (const l of leaveRows.filter((x) => x.user_id === e.id)) {
      for (let d = l.start_date; d <= l.end_date; d = addDays(d, 1)) {
        if (d < monthStart || d > monthEnd || !isWorkingDay(d)) continue;
        const day = leaveDays.get(d) || { paid: 0, unpaid: 0 };
        day[l.type === 'unpaid' ? 'unpaid' : 'paid'] += l.half_day ? 0.5 : 1;
        leaveDays.set(d, day);
      }
    }
    // Pay follows working days: a Sunday or holiday worked doesn't cancel out an absence (it earns comp-off
    // instead, if the company uses it). Each working day pays at most one day: attendance first, then paid leave.
    const days = attByUser[e.id] || [];
    const worked = days.filter((r) => isWorkingDay(r.date));
    const attended = new Map(worked.map((r) => [r.date, r.status === 'half_day' ? 0.5 : 1]));
    const a = {
      days: worked.length,
      late: worked.filter((r) => r.status === 'late').length,
      half: worked.filter((r) => r.status === 'half_day').length,
      minutes: days.reduce((sum, r) => sum + Number(r.minutes), 0),
    };
    let paidLeave = 0, unpaidLeave = 0, leaveCovered = 0;
    for (const [d, l] of leaveDays) {
      const room = 1 - (attended.get(d) || 0);
      const paid = Math.min(l.paid, room);
      const unpaid = Math.min(l.unpaid, room - paid);
      paidLeave += paid;
      unpaidLeave += unpaid;
      leaveCovered += paid + unpaid;
    }
    // Working days before someone joined aren't absences (they still aren't paid: pay follows payable days).
    let notJoined = 0;
    if (e.joined_on && e.joined_on > monthStart) {
      for (let d = monthStart; d < e.joined_on && d <= monthEnd; d = addDays(d, 1)) if (isWorkingDay(d)) notJoined++;
    }
    const presentDays = a.days - a.half * 0.5;
    const payableDays = Math.min(presentDays + paidLeave, workingDays);
    const absent = Math.max(workingDays - notJoined - presentDays - leaveCovered, 0);
    return {
      ...e,
      present: a.days, late: a.late, half_days: a.half,
      hours: Math.round(a.minutes / 6) / 10,
      overtime_hours: Math.round((otByUser[e.id] || 0) / 6) / 10,
      paid_leave: paidLeave, unpaid_leave: unpaidLeave,
      absent: Math.round(absent * 2) / 2,
      payable_days: payableDays,
      payable: workingDays ? Math.round((e.salary * payableDays) / workingDays) : 0,
    };
  });
  return { month, workingDays, rows };
}

const PF_RATE = 0.12;
const PF_CAP = 1800;

/**
 * Salary structure: Basic 50% / HRA 20% / Special allowance 30% of the monthly salary,
 * each pro-rated by payable days. Unpaid and absent days show up as loss of pay (LOP).
 */
export function computePayslip(row, workingDays, settings, adjustments = {}) {
  const salary = Number(row.salary) || 0;
  const ratio = workingDays ? Math.min(row.payable_days / workingDays, 1) : 0;
  const basicFull = Math.round(salary * 0.5);
  const hraFull = Math.round(salary * 0.2);
  const specialFull = salary - basicFull - hraFull;
  const basic = Math.round(basicFull * ratio);
  const hra = Math.round(hraFull * ratio);
  const special = Math.round(specialFull * ratio);
  const gross = basic + hra + special;
  const bonus = Math.max(Number(adjustments.bonus) || 0, 0);
  const otherDeduction = Math.max(Number(adjustments.other_deduction) || 0, 0);
  const pf = settings.payroll_pf === '1' ? Math.min(Math.round(basic * PF_RATE), PF_CAP) : 0;
  const pt = gross > 0 ? Math.max(Number(settings.payroll_pt) || 0, 0) : 0;
  return {
    monthly_salary: salary,
    working_days: workingDays,
    payable_days: row.payable_days,
    present: row.present, late: row.late, half_days: row.half_days,
    paid_leave: row.paid_leave, unpaid_leave: row.unpaid_leave, absent: row.absent, hours: row.hours,
    basic, hra, special, gross,
    lop: salary - gross,
    bonus, pf, pt,
    other_deduction: otherDeduction,
    adjustment_note: adjustments.adjustment_note ?? null,
    net: Math.max(gross + bonus - pf - pt - otherDeduction, 0),
  };
}
