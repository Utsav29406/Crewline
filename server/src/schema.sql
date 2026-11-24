-- Crewline schema. Idempotent: safe to run on every start, and upgrades
-- single-company databases (pre multi-tenancy) in place.
-- Note: db.query() rewrites question marks into $n placeholders, so never use one in this file.

-- Serialize concurrent runs (e.g. several serverless cold starts); released at end of this implicit transaction.
SELECT pg_advisory_xact_lock(7263541);

CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS departments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS geofences (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL,
  lng DOUBLE PRECISION NOT NULL,
  radius_m INTEGER NOT NULL DEFAULT 150,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT date_trunc('second', localtimestamp)
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  emp_code TEXT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin','hr','employee')),
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  geofence_id INTEGER REFERENCES geofences(id) ON DELETE SET NULL,
  designation TEXT,
  phone TEXT,
  joined_on DATE,
  salary DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  face_descriptors JSONB,
  notifications_seen_id BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT date_trunc('second', localtimestamp)
);

CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  check_in TIMESTAMP,
  check_out TIMESTAMP,
  in_lat DOUBLE PRECISION, in_lng DOUBLE PRECISION,
  out_lat DOUBLE PRECISION, out_lng DOUBLE PRECISION,
  geofence_id INTEGER REFERENCES geofences(id) ON DELETE SET NULL,
  face_distance DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present','late','half_day')),
  work_minutes INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, date)
);

CREATE TABLE IF NOT EXISTS attendance_attempts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  success BOOLEAN NOT NULL,
  reason TEXT,
  lat DOUBLE PRECISION, lng DOUBLE PRECISION,
  distance_m DOUBLE PRECISION,
  face_distance DOUBLE PRECISION,
  created_at TIMESTAMP NOT NULL DEFAULT date_trunc('second', localtimestamp)
);

CREATE TABLE IF NOT EXISTS leaves (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('casual','sick','earned','unpaid')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days DOUBLE PRECISION NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  review_note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT date_trunc('second', localtimestamp)
);

CREATE TABLE IF NOT EXISTS holidays (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL
);

-- Real-time feed: every change is an event; clients poll for ids above the last one they saw.
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'managers' CHECK (audience IN ('managers','user','all')),
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notify BOOLEAN NOT NULL DEFAULT FALSE,
  title TEXT,
  body TEXT,
  data JSONB,
  created_at TIMESTAMP NOT NULL
);

-- Lunch / short breaks taken during a working day.
CREATE TABLE IF NOT EXISTS breaks (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attendance_id INTEGER NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('lunch','break')),
  started_at TIMESTAMP NOT NULL,
  ended_at TIMESTAMP,
  minutes INTEGER NOT NULL DEFAULT 0
);

-- Desktop tracker: one screenshot per 15-minute block while an employee is checked in. Images live in Vercel Blob.
CREATE TABLE IF NOT EXISTS screenshots (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attendance_id INTEGER REFERENCES attendance(id) ON DELETE SET NULL,
  taken_at TIMESTAMP NOT NULL,
  blob_path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  activity INTEGER,
  idle BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Payroll: one run per company-month; payslips are snapshots so later edits to people don't rewrite history.
CREATE TABLE IF NOT EXISTS payroll_runs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  working_days INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  generated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  generated_at TIMESTAMP NOT NULL,
  published_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  published_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payslips (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  emp_code TEXT, name TEXT NOT NULL, department TEXT, designation TEXT,
  monthly_salary DOUBLE PRECISION NOT NULL DEFAULT 0,
  working_days INTEGER NOT NULL DEFAULT 0,
  payable_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  present INTEGER NOT NULL DEFAULT 0, late INTEGER NOT NULL DEFAULT 0, half_days INTEGER NOT NULL DEFAULT 0,
  paid_leave INTEGER NOT NULL DEFAULT 0, unpaid_leave INTEGER NOT NULL DEFAULT 0, absent INTEGER NOT NULL DEFAULT 0,
  hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  basic DOUBLE PRECISION NOT NULL DEFAULT 0, hra DOUBLE PRECISION NOT NULL DEFAULT 0, special DOUBLE PRECISION NOT NULL DEFAULT 0,
  gross DOUBLE PRECISION NOT NULL DEFAULT 0, lop DOUBLE PRECISION NOT NULL DEFAULT 0,
  bonus DOUBLE PRECISION NOT NULL DEFAULT 0,
  pf DOUBLE PRECISION NOT NULL DEFAULT 0, pt DOUBLE PRECISION NOT NULL DEFAULT 0,
  other_deduction DOUBLE PRECISION NOT NULL DEFAULT 0,
  adjustment_note TEXT,
  net DOUBLE PRECISION NOT NULL DEFAULT 0,
  viewed_at TIMESTAMP
);

-- ---------- Upgrade single-company databases ----------
DO $$
DECLARE t TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM companies)
     AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = current_schema() AND table_name = 'users')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'company_id') THEN
    INSERT INTO companies (name, is_demo) VALUES ('Crewline Demo', TRUE);
  END IF;

  FOREACH t IN ARRAY ARRAY['departments','geofences','users','attendance','attendance_attempts','leaves','holidays','settings'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = current_schema() AND table_name = t AND column_name = 'company_id') THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE', t);
      EXECUTE format('UPDATE %I SET company_id = (SELECT min(id) FROM companies)', t);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN company_id SET NOT NULL', t);
    END IF;
  END LOOP;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_seen_id BIGINT NOT NULL DEFAULT 0;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS break_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'app';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_version INTEGER NOT NULL DEFAULT 0;

-- Uniqueness is now per company (old global constraints are dropped if present).
ALTER TABLE departments DROP CONSTRAINT IF EXISTS departments_name_key;
ALTER TABLE holidays DROP CONSTRAINT IF EXISTS holidays_date_key;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_emp_code_key;
ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey;
DELETE FROM settings WHERE key = 'company_name';

CREATE UNIQUE INDEX IF NOT EXISTS departments_company_name ON departments (company_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS holidays_company_date ON holidays (company_id, date);
CREATE UNIQUE INDEX IF NOT EXISTS users_company_emp_code ON users (company_id, emp_code);
CREATE UNIQUE INDEX IF NOT EXISTS settings_company_key ON settings (company_id, key);
CREATE INDEX IF NOT EXISTS users_company ON users (company_id);
CREATE INDEX IF NOT EXISTS attendance_company_date ON attendance (company_id, date);
CREATE INDEX IF NOT EXISTS attempts_company_created ON attendance_attempts (company_id, created_at);
CREATE INDEX IF NOT EXISTS leaves_company_status ON leaves (company_id, status);
CREATE INDEX IF NOT EXISTS leaves_user ON leaves (user_id, status);
CREATE INDEX IF NOT EXISTS events_company_id ON events (company_id, id);
CREATE INDEX IF NOT EXISTS breaks_attendance ON breaks (attendance_id);
CREATE UNIQUE INDEX IF NOT EXISTS breaks_one_open ON breaks (user_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_company_month ON payroll_runs (company_id, month);
CREATE INDEX IF NOT EXISTS payslips_run ON payslips (run_id);
CREATE INDEX IF NOT EXISTS payslips_user ON payslips (user_id);
CREATE INDEX IF NOT EXISTS screenshots_user_taken ON screenshots (user_id, taken_at);
CREATE INDEX IF NOT EXISTS screenshots_created ON screenshots (created_at);
-- Desktop tracker: last time the app checked in, and breaks it started on its own (app closed 10+ minutes).
ALTER TABLE users ADD COLUMN IF NOT EXISTS tracker_seen_at TIMESTAMP;
ALTER TABLE breaks ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'app';
-- Daily attendance log emails: one per person per day (sent on punch-out, or by the midnight backup).
CREATE TABLE IF NOT EXISTS daily_logs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, date)
);
-- Tasks: assigned by admin/HR, worked on by employees; the desktop tracker logs time against the selected task.
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  details TEXT,
  assignee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','progress','done')),
  due_date DATE,
  estimate_minutes INTEGER,
  completed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT date_trunc('second', localtimestamp)
);
CREATE INDEX IF NOT EXISTS tasks_company_status ON tasks (company_id, status);
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks (assignee_id, status);
-- Seconds the tracker logged to a task, per person per day.
CREATE TABLE IF NOT EXISTS task_time (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, user_id, date)
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS task_tick_at TIMESTAMP;
ALTER TABLE screenshots ADD COLUMN IF NOT EXISTS task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL;
-- Reporting line: a senior employee can assign and follow tasks for the people who report to them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS reports_to INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS users_reports_to ON users (reports_to);
-- Birthdays on the dashboard (work anniversaries come from joined_on).
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE;
-- Two-step sign-in for admins: a 6-digit code emailed at sign-in (opt-in per admin, from Profile).
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_step BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS login_codes (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT 'login',
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_codes_user ON login_codes (user_id);
-- Notice board.
CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_on DATE,
  created_at TIMESTAMP NOT NULL DEFAULT date_trunc('second', localtimestamp)
);
CREATE INDEX IF NOT EXISTS announcements_company ON announcements (company_id, id);
-- Attendance fixes: who last edited a record by hand, and employees' correction requests.
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS edited_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS edit_note TEXT;
CREATE TABLE IF NOT EXISTS attendance_corrections (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  check_in TIMESTAMP,
  check_out TIMESTAMP,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  review_note TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT date_trunc('second', localtimestamp)
);
CREATE INDEX IF NOT EXISTS corrections_company_status ON attendance_corrections (company_id, status);
CREATE INDEX IF NOT EXISTS corrections_user ON attendance_corrections (user_id, date);
-- Files: employee documents (ID proof, offer letter...) and task attachments, stored in the private Blob store.
CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'other',
  name TEXT NOT NULL,
  blob_path TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT date_trunc('second', localtimestamp)
);
CREATE INDEX IF NOT EXISTS documents_user ON documents (user_id);
-- Task discussion: a comment, a file, or both.
CREATE TABLE IF NOT EXISTS task_comments (
  id SERIAL PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT,
  file_name TEXT,
  blob_path TEXT,
  content_type TEXT,
  bytes INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT date_trunc('second', localtimestamp)
);
CREATE INDEX IF NOT EXISTS task_comments_task ON task_comments (task_id, id);

-- Sign in with Google: the Google account id (`sub`) linked on first sign-in. (Replaces the unused Microsoft columns.)
DROP INDEX IF EXISTS users_ms_account;
ALTER TABLE users DROP COLUMN IF EXISTS ms_tid;
ALTER TABLE users DROP COLUMN IF EXISTS ms_oid;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL;

-- Email-domain sign-up: people who join by themselves wait as 'pending' until HR approves them.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_status_check' AND pg_get_constraintdef(oid) LIKE '%pending%') THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
    ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active','inactive','pending'));
  END IF;
END $$;

-- 6-digit codes that prove someone owns the work email they're signing up with (no account exists yet).
CREATE TABLE IF NOT EXISTS signup_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HR invites: set while the invited person hasn't chosen a password yet.
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;

-- Payslips are also emailed when payroll is sent: when it went out, or why it couldn't.
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ;
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS email_error TEXT;

-- Bumped when a password or sign-in email changes: older sessions (in the JWT as `tv`) stop working.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

-- Which request is emailing a payslip right now, so two "Email the remaining" clicks don't both send it.
ALTER TABLE payslips ADD COLUMN IF NOT EXISTS email_claimed_at TIMESTAMPTZ;

-- Spoofing checks: the last accepted face scans (a scan seen before is a replay), and what looked suspicious.
ALTER TABLE users ADD COLUMN IF NOT EXISTS recent_faces JSONB;
ALTER TABLE attendance_attempts ADD COLUMN IF NOT EXISTS flags TEXT;

-- Activity history for HR: who changed what (salaries, roles, attendance, leave, payroll, settings) and when.
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT,
  target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_name TEXT,
  area TEXT NOT NULL,
  action TEXT NOT NULL,
  changes JSONB,
  created_at TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_company ON audit_log (company_id, id DESC);

-- Leave policy: comp-off leave (earned by working a day off) and half-day leave ('first' / 'second' half).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leaves_type_check' AND pg_get_constraintdef(oid) LIKE '%comp_off%') THEN
    ALTER TABLE leaves DROP CONSTRAINT IF EXISTS leaves_type_check;
    ALTER TABLE leaves ADD CONSTRAINT leaves_type_check CHECK (type IN ('casual','sick','earned','unpaid','comp_off'));
  END IF;
END $$;
ALTER TABLE leaves ADD COLUMN IF NOT EXISTS half_day TEXT;
-- Half-day leave: leave and absent counts on payslips can be halves.
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_name = 'payslips' AND column_name = 'paid_leave') = 'integer' THEN
    ALTER TABLE payslips ALTER COLUMN paid_leave TYPE DOUBLE PRECISION, ALTER COLUMN unpaid_leave TYPE DOUBLE PRECISION,
      ALTER COLUMN absent TYPE DOUBLE PRECISION;
  END IF;
END $$;
