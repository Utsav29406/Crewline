import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db, { end, ensureDefaultSettings } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Applies schema.sql, retrying while the database is still starting up. */
export async function migrate(retries = 20) {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
      return await ensureDefaultSettings();
    } catch (err) {
      if (attempt >= retries || !['ECONNREFUSED', '57P03'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => console.log('Schema is up to date.'))
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    })
    .finally(end);
}
