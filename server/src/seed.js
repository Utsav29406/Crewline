import bcrypt from 'bcryptjs';
import db, { tx, end, ensureDefaultSettings } from './db.js';
import { migrate } from './migrate.js';
import { clock, addDays, dayOfWeek } from './utils.js';

const TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';

/** Creates the public demo company (protected demo logins) if it doesn't exist yet. */
async function seed() {
  await migrate();
  if (await db.get("SELECT 1 FROM users WHERE email = 'admin@crewline.io'")) {
    console.log('Demo company already exists — skipping seed.');
    return;
  }

  await tx(async (t) => {
    const { id: cid } = await t.get(
      'INSERT INTO companies (name, timezone, is_demo) VALUES (?, ?, TRUE) RETURNING id',
      ['Crewline Demo', TIMEZONE]
    );
    await ensureDefaultSettings(t, cid);

    const depts = [];
    for (const name of ['Engineering', 'Design', 'Human Resources', 'Sales', 'Operations']) {
      depts.push((await t.get('INSERT INTO departments (company_id, name) VALUES (?, ?) RETURNING id', [cid, name])).id);
    }
    const hq = (await t.get(
      'INSERT INTO geofences (company_id, name, lat, lng, radius_m) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [cid, 'Head Office', 23.0225, 72.5714, 200]
    )).id;

    const addUser = async (code, name, email, password, role, dept, fence, title, joined, salary) =>
      t.run(
        `INSERT INTO users (company_id, emp_code, name, email, password_hash, role, department_id, geofence_id, designation, joined_on, salary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [cid, code, name, email, await bcrypt.hash(password, 10), role, dept, fence, title, joined, salary]
      );
    await addUser('CL001', 'Admin User', 'admin@crewline.io', 'admin123', 'admin', depts[2], null, 'System Administrator', '2023-01-02', 90000);
    await addUser('CL002', 'Riya Shah', 'hr@crewline.io', 'hr1234', 'hr', depts[2], hq, 'HR Manager', '2023-03-15', 70000);
    const staff = [
      ['CL003', 'Arjun Mehta', 'arjun@crewline.io', depts[0], 'Senior Engineer', 85000],
      ['CL004', 'Sara Khan', 'sara@crewline.io', depts[1], 'Product Designer', 65000],
      ['CL005', 'Dev Patel', 'dev@crewline.io', depts[3], 'Sales Executive', 50000],
      ['CL006', 'Neha Joshi', 'neha@crewline.io', depts[4], 'Operations Lead', 60000],
    ];
    for (const [code, name, email, d, title, salary] of staff) {
      await addUser(code, name, email, 'employee123', 'employee', d, hq, title, '2024-06-01', salary);
    }
    const userIds = (await t.all("SELECT id FROM users WHERE company_id = ? AND role <> 'admin' ORDER BY id", [cid])).map((r) => r.id);

    const today = clock(TIMEZONE).date;
    const year = today.slice(0, 4);
    for (const [md, name] of [['01-26', 'Republic Day'], ['08-15', 'Independence Day'], ['10-02', 'Gandhi Jayanti'], ['12-25', 'Christmas']]) {
      await t.run('INSERT INTO holidays (company_id, date, name) VALUES (?, ?, ?)', [cid, `${year}-${md}`, name]);
    }

    // Two weeks of sample attendance so the dashboard has something to show.
    const at = (date, m) => `${date} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
    for (let i = 14; i >= 1; i--) {
      const date = addDays(today, -i);
      if (dayOfWeek(date) === 0) continue;
      for (const uid of userIds) {
        if (Math.random() < 0.12) continue;
        const late = Math.random() < 0.2;
        const inMin = late ? 9 * 60 + 45 + Math.floor(Math.random() * 40) : 9 * 60 + Math.floor(Math.random() * 35);
        const outMin = 18 * 60 + Math.floor(Math.random() * 60);
        await t.run(
          `INSERT INTO attendance (company_id, user_id, date, check_in, check_out, in_lat, in_lng, geofence_id, status, work_minutes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [cid, uid, date, at(date, inMin), at(date, outMin), 23.0225 + (Math.random() - 0.5) * 0.002, 72.5714 + (Math.random() - 0.5) * 0.002, hq, late ? 'late' : 'present', outMin - inMin]
        );
      }
    }
  });

  console.log(`Seeded demo company. Logins:
  admin@crewline.io / admin123
  hr@crewline.io    / hr1234
  arjun@crewline.io / employee123`);
}

seed()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(end);
