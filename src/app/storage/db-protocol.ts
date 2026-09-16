/** Messages between the app and the SQLite worker. */

export type SqlValue = string | number | null | Uint8Array;

export interface Statement {
  sql: string;
  bind?: SqlValue[];
}

export type DbRequest =
  | { id: number; type: 'init' }
  /** Several statements are run inside one transaction. */
  | { id: number; type: 'run'; statements: Statement[] };

export type DbResponse =
  | { id: number; ok: true; persistent: boolean; results: Record<string, unknown>[][] }
  | { id: number; ok: false; error: string };
