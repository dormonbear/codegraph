import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseConnection } from '../src/db';

let dir = '';
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('WAL maintenance', () => {
  it('runMaintenance bounds the WAL file and preserves rows', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-wal-'));
    const dbPath = path.join(dir, 'codegraph.db');
    const conn = DatabaseConnection.initialize(dbPath);
    const db = conn.getDb();

    // Bulk-write enough rows to push the WAL well past the default
    // autocheckpoint threshold (~1000 pages ≈ 4 MB).
    const insert = db.prepare(
      'INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    );
    db.transaction(() => {
      for (let i = 0; i < 20000; i++) {
        insert.run(`n${i}`, 'function', `f${i}`, `f${i}`, 'a.ts', 'ts', 1, 2, 0, 1, Date.now());
      }
    })();

    conn.runMaintenance();

    const walPath = `${dbPath}-wal`;
    const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    // PASSIVE checkpoint leaves the WAL file at full size; TRUNCATE shrinks it.
    expect(walSize).toBeLessThan(1_000_000);

    const count = (db.prepare('SELECT count(*) AS c FROM nodes').get() as { c: number }).c;
    expect(count).toBe(20000);

    conn.close();
  });
});
