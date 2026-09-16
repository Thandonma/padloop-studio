/** Schema migrations, applied in order and tracked with PRAGMA user_version. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE kit (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    session_minutes  INTEGER NOT NULL DEFAULT 10 CHECK (session_minutes BETWEEN 0 AND 720),
    master_volume    REAL    NOT NULL DEFAULT 0.8 CHECK (master_volume BETWEEN 0 AND 1),
    fade_seconds     REAL    NOT NULL DEFAULT 2.0 CHECK (fade_seconds BETWEEN 0 AND 30),
    key_lock         INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL
  );

  CREATE TABLE layer (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    kit_id            INTEGER NOT NULL REFERENCES kit(id) ON DELETE CASCADE,
    pad_index         INTEGER NOT NULL CHECK (pad_index BETWEEN 0 AND 11),
    position          INTEGER NOT NULL DEFAULT 0,
    original_name     TEXT    NOT NULL,
    size_bytes        INTEGER NOT NULL,
    sample_rate       INTEGER NOT NULL,
    channels          INTEGER NOT NULL,
    bits_per_sample   INTEGER NOT NULL,
    duration_seconds  REAL    NOT NULL,
    root_note         INTEGER CHECK (root_note IS NULL OR root_note BETWEEN 0 AND 11),
    octave            INTEGER NOT NULL DEFAULT 0 CHECK (octave BETWEEN -2 AND 2),
    fine_tune_cents   INTEGER NOT NULL DEFAULT 0 CHECK (fine_tune_cents BETWEEN -100 AND 100),
    gain              REAL    NOT NULL DEFAULT 0.8 CHECK (gain BETWEEN 0 AND 2),
    enabled           INTEGER NOT NULL DEFAULT 1,
    detected_key      TEXT,
    created_at        TEXT    NOT NULL
  );
  CREATE INDEX idx_layer_kit_pad ON layer (kit_id, pad_index, position);

  -- The WAV bytes, kept apart so listing layers never touches large blobs.
  CREATE TABLE sample (
    layer_id  INTEGER PRIMARY KEY REFERENCES layer(id) ON DELETE CASCADE,
    data      BLOB NOT NULL
  );
  `,
];
