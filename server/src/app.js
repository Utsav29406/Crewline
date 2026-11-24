import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import { requireAuth } from './auth.js';
import { migrate } from './migrate.js';
import { AUTO_PHASES, catchUpAutoAttendance, runAutoAttendance } from './autoAttendance.js';
import { sendMissedDailyLogs } from './dailyLog.js';
import { signedUrl } from './blobs.js';
import authRoutes from './routes/auth.js';
import googleRoutes from './routes/google.js';
import joinRoutes from './routes/join.js';
import employeeRoutes from './routes/employees.js';
import attendanceRoutes from './routes/attendance.js';
import leaveRoutes from './routes/leaves.js';
import adminRoutes from './routes/admin.js';
import liveRoutes from './routes/live.js';
import boardRoutes from './routes/board.js';
import documentRoutes from './routes/documents.js';
import payrollRoutes from './routes/payroll.js';
import taskRoutes from './routes/tasks.js';
import trackerRoutes, { purgeOldScreenshots, sweepTrackerBreaks } from './routes/tracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Behind Vercel / a reverse proxy: trust X-Forwarded-For so rate limits see real client IPs.
app.set('trust proxy', true);

// Apply the schema once per process (a serverless cold start, or a local server boot).
let schemaReady;
app.use('/api', async (req, res, next) => {
  schemaReady ||= migrate().catch((err) => {
    schemaReady = null;
    throw err;
  });
  await schemaReady;
  // Backup for a missed daily cron run; never blocks the request on failure.
  await catchUpAutoAttendance().catch((err) => console.error('auto attendance catch-up failed', err));
  // Desktop tracker upkeep: away-breaks for closed apps, and 30-day screenshot clean-up. Both throttle themselves.
  await sweepTrackerBreaks().catch((err) => console.error('tracker sweep failed', err));
  await purgeOldScreenshots().catch((err) => console.error('screenshot purge failed', err));
  next();
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Daily test check-in/out, called by Vercel Cron (vercel.json) with the CRON_SECRET bearer token.
app.get('/api/cron/attendance/:phase', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET is not set' });
  if (req.get('authorization') !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  if (!AUTO_PHASES.includes(req.params.phase)) return res.status(404).json({ error: 'Unknown phase' });
  res.json({ phase: req.params.phase, results: await runAutoAttendance(req.params.phase) });
});

// After midnight: yesterday's attendance log email for anyone who didn't get one on punch-out.
app.get('/api/cron/daily-logs', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'CRON_SECRET is not set' });
  if (req.get('authorization') !== `Bearer ${secret}`) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ results: await sendMissedDailyLogs() });
});

// Company logos are public (they appear on payslips and the sign-in screen) and cached by version.
app.get('/api/companies/:id/logo', async (req, res) => {
  const row = await db.get('SELECT logo FROM companies WHERE id = ?', [Number(req.params.id) || 0]);
  const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(row?.logo || '');
  if (!m) return res.status(404).json({ error: 'No logo' });
  res.set('Content-Type', m[1]);
  res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.set('X-Content-Type-Options', 'nosniff');
  res.send(Buffer.from(m[2], 'base64'));
});
// Desktop tracker downloads: the installers sit in the private Blob store under downloads/; this hands the browser
// a link that works for 10 minutes. Public on purpose (a plain link click carries no sign-in token), and only these two files.
// The newest installers under fixed names (each release overwrites them), so these links never change.
const TRACKER_FILES = { windows: 'downloads/CrewlineTracker-Setup.exe', linux: 'downloads/CrewlineTracker-linux.deb' };
app.get('/api/downloads/tracker/:os', async (req, res) => {
  const pathname = TRACKER_FILES[req.params.os];
  if (!pathname) return res.status(404).json({ error: 'No download for that system' });
  const url = await signedUrl(pathname, { download: true });
  res.set('Cache-Control', 'no-store');
  res.redirect(302, url);
});

// Self-update feed for installed trackers (electron-updater "generic" provider, see tracker/package.json):
// latest.yml / latest-linux.yml name the newest version, and the versioned installers sit next to them under updates/.
const UPDATE_FILE = /^(latest(-linux)?\.yml|CrewlineTracker-[0-9A-Za-z.-]+\.(exe|deb|blockmap))$/;
app.get('/api/downloads/updates/:file', async (req, res) => {
  if (!UPDATE_FILE.test(req.params.file)) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'no-store');
  res.redirect(302, await signedUrl(`updates/${req.params.file}`));
});

app.use('/api/auth', authRoutes);
app.use('/api/auth', googleRoutes);
app.use('/api/auth', joinRoutes);
app.use('/api/employees', requireAuth, employeeRoutes);
app.use('/api/attendance', requireAuth, attendanceRoutes);
app.use('/api/leaves', requireAuth, leaveRoutes);
app.use('/api/payroll', requireAuth, payrollRoutes);
app.use('/api/tracker', requireAuth, trackerRoutes);
app.use('/api/tasks', requireAuth, taskRoutes);
app.use('/api', requireAuth, liveRoutes);
app.use('/api', requireAuth, boardRoutes);
app.use('/api', requireAuth, documentRoutes);
app.use('/api', requireAuth, adminRoutes);

// Serve the built client when running as a single Node server (Vercel serves it statically instead).
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (!process.env.VERCEL && fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.use((err, req, res, next) => {
  // Postgres rejecting a value it was sent (an impossible date like 2026-02-30, a non-number id, a role outside the
  // allowed list) is bad input, not a server fault: 22xxx = data exceptions, 23514 = CHECK constraint.
  if (typeof err?.code === 'string' && (err.code.startsWith('22') || err.code === '23514')) {
    return res.status(400).json({ error: 'Some of the values sent are not valid' });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'That is too large. Files can be up to 4 MB.' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

export default app;
