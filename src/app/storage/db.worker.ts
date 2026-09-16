/// <reference lib="webworker" />
/**
 * Runs SQLite (official WebAssembly build) in a dedicated worker. The database
 * is stored in the browser's Origin Private File System through the
 * "opfs-sahpool" VFS, which needs no special server headers, so the app can be
 * served from any static host (Vercel, GitHub Pages, ...).
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { DbRequest, DbResponse, Statement } from './db-protocol';
import { MIGRATIONS } from './schema';

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
type Db = InstanceType<Sqlite3['oo1']['DB']>;

let ready: Promise<{ db: Db; persistent: boolean }> | undefined;

async function open(): Promise<{ db: Db; persistent: boolean }> {
  // The wasm file is copied to /sqlite/ by angular.json; point the loader at it.
  const init = sqlite3InitModule as unknown as (opts: object) => Promise<Sqlite3>;
  const sqlite3 = await init({
    locateFile: (file: string) => new URL(`sqlite/${file}`, self.location.href).href,
    print: () => undefined,
    printErr: (...args: unknown[]) => console.warn('[sqlite]', ...args),
  });

  let db: Db;
  let persistent = true;
  try {
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'padloop-pool', directory: '.padloop' });
    db = new pool.OpfsSAHPoolDb('/padloop.sqlite3');
  } catch (err) {
    console.warn('OPFS storage is not available; using a temporary in-memory database.', err);
    db = new sqlite3.oo1.DB(':memory:', 'c');
    persistent = false;
  }
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return { db, persistent };
}

function migrate(db: Db): void {
  const version = Number(db.selectValue('PRAGMA user_version') ?? 0);
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

function run(db: Db, st: Statement): Record<string, unknown>[] {
  return db.exec({
    sql: st.sql,
    bind: (st.bind ?? []) as never,
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Record<string, unknown>[];
}

function transferables(results: Record<string, unknown>[][]): Transferable[] {
  const out: Transferable[] = [];
  for (const rows of results)
    for (const row of rows)
      for (const v of Object.values(row)) if (v instanceof Uint8Array) out.push(v.buffer as ArrayBuffer);
  return out;
}

self.onmessage = async (ev: MessageEvent<DbRequest>) => {
  const req = ev.data;
  const reply = (msg: DbResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);
  try {
    ready ??= open();
    const { db, persistent } = await ready;
    switch (req.type) {
      case 'init':
        reply({ id: req.id, ok: true, persistent, results: [] });
        break;
      case 'run': {
        let results: Record<string, unknown>[][] = [];
        if (req.statements.length === 1) {
          results = [run(db, req.statements[0])];
        } else {
          db.transaction(() => {
            results = req.statements.map((st) => run(db, st));
          });
        }
        reply({ id: req.id, ok: true, persistent, results }, transferables(results));
        break;
      }
    }
  } catch (err) {
    reply({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
