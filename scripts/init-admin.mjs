import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function adminSQL(email, name = 'Owner') {
  email = email.trim().toLowerCase();
  name = name.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) {
    throw new Error('Provide a valid owner email and a nonempty name.');
  }
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const now = Date.now();
  return `INSERT INTO auth_user (id, name, email, emailVerified, createdAt, updatedAt)
VALUES (${quote(randomUUID())}, ${quote(name)}, ${quote(email)}, 0, ${now}, ${now})
ON CONFLICT(email) DO NOTHING;`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let directory;
  try {
    const [target, email, name, ...extra] = process.argv.slice(2);
    if (!['--local', '--remote'].includes(target) || !email || extra.length) {
      throw new Error('Usage: pnpm run admin:init --local|--remote EMAIL [NAME]\nEMAIL must match the Worker AUTH_EMAIL. Apply database migrations first.');
    }
    const sql = adminSQL(email, name);
    directory = mkdtempSync(join(tmpdir(), 'excalidraw-admin-'));
    const file = join(directory, 'init.sql');
    writeFileSync(file, sql, { mode: 0o600 });
    console.log(`Initializing owner in ${target.slice(2)} D1. Existing users are left unchanged.`);
    const result = spawnSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'DRAWINGS', target, '--file', file], {
      cwd: new URL('../', import.meta.url),
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Wrangler failed (${result.status ?? result.signal}).`);
    console.log('Owner initialization complete. Sign in with an email OTP to verify the address.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
