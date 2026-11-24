// Local PostgreSQL for development (no install needed). Data persists in server/.pgdata.
delete process.env.LOCPATH;
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.pgdata');
const port = Number(process.env.LOCAL_PG_PORT || 5432);
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'crewline', password: 'crewline', port, persistent: true });

const portInUse = () =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });

if (await portInUse()) {
  // Another `npm run dev` (or a system Postgres) already owns the port — reuse it instead of crashing.
  console.log(`Postgres already running on port ${port}; reusing it.`);
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}

const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
if (fresh) await pg.initialise();

// If the port is not in use, any leftover pid/socket lock files are stale from a previous unclean shutdown.
const pidFile = path.join(dataDir, 'postmaster.pid');
const sockLockFile = `/tmp/.s.PGSQL.${port}.lock`;
const sockFile = `/tmp/.s.PGSQL.${port}`;
try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); } catch {}
try { if (fs.existsSync(sockLockFile)) fs.unlinkSync(sockLockFile); } catch {}
try { if (fs.existsSync(sockFile)) fs.unlinkSync(sockFile); } catch {}

await pg.start();
if (fresh) await pg.createDatabase('crewline');
console.log(`Local Postgres ready on postgres://crewline:crewline@localhost:${port}/crewline`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
