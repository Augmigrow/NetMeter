'use strict';

// One-off maintenance: this conversation ran `git init` inside the project, so the
// coordinator's project identity key changed from `dir:<root>` to `git:<root>/.git`.
// The physical directory is unchanged, so the stored state is rebound to the new key.
// Sessions, claims, manager authority and audit records are preserved verbatim.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(process.argv[2] || '.');
const stateDir = path.join(root, '.neat-sync');
const dbPath = path.join(stateDir, 'coordination.sqlite');

const common = fs.realpathSync.native(path.join(root, '.git'));
const newKey = 'git:' + common.toLowerCase();

const backupDir = path.join(stateDir, 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, 'coordination.sqlite.' + stamp + '.bak');
fs.copyFileSync(dbPath, backupPath);

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 15000; PRAGMA synchronous = FULL;');
db.exec('BEGIN IMMEDIATE;');
let previous = null;
try {
  const row = db.prepare("SELECT value FROM meta WHERE key='project_identity'").get();
  if (!row) throw new Error('missing project_identity');
  previous = row.value;
  db.prepare("UPDATE meta SET value=? WHERE key='project_identity'").run(newKey);
  db.prepare('INSERT INTO audit(event,data_json,created_at) VALUES(?,?,?)').run(
    'project_identity_rebound',
    JSON.stringify({ from: row.value, to: newKey, reason: 'git init in the same project root during this session' }),
    new Date().toISOString(),
  );
  db.exec('COMMIT;');
} catch (error) {
  db.exec('ROLLBACK;');
  db.close();
  throw error;
}
const after = db.prepare("SELECT value FROM meta WHERE key='project_identity'").get();
db.close();
console.log(JSON.stringify({ backup: backupPath, from: previous, to: after.value }));
