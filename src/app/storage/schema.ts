/** Schema migrations, applied in order and tracked with PRAGMA user_version. */
export const MIGRATIONS: string[] = [
  // 1 — the original layout: samples pinned to one of twelve pads.
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

  CREATE TABLE sample (
    layer_id  INTEGER PRIMARY KEY REFERENCES layer(id) ON DELETE CASCADE,
    data      BLOB NOT NULL
  );
  `,

  // 2 — a sound now belongs to the kit, not to one pad, and plays in whichever
  //     key you press. Audio is stored once per distinct file and shared.
  `
  CREATE TABLE audio_blob (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    hash  TEXT NOT NULL UNIQUE,
    data  BLOB NOT NULL
  );

  CREATE TABLE sound (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    kit_id            INTEGER NOT NULL REFERENCES kit(id) ON DELETE CASCADE,
    blob_id           INTEGER NOT NULL REFERENCES audio_blob(id),
    position          INTEGER NOT NULL DEFAULT 0,
    name              TEXT    NOT NULL,
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
    starter_id        TEXT,
    created_at        TEXT    NOT NULL
  );
  CREATE INDEX idx_sound_kit ON sound (kit_id, position);

  -- Carry over anything already saved. The same file placed on several pads
  -- collapses into a single sound, which is what it always meant.
  INSERT INTO audio_blob (hash, data)
    SELECT 'v1-' || s.layer_id, s.data FROM sample s
    WHERE s.layer_id IN (SELECT MIN(id) FROM layer GROUP BY kit_id, original_name, size_bytes);

  INSERT INTO sound (kit_id, blob_id, position, name, size_bytes, sample_rate, channels,
                     bits_per_sample, duration_seconds, root_note, octave, fine_tune_cents,
                     gain, enabled, detected_key, starter_id, created_at)
    SELECT l.kit_id, b.id,
           ROW_NUMBER() OVER (PARTITION BY l.kit_id ORDER BY l.id) - 1,
           l.original_name, l.size_bytes, l.sample_rate, l.channels, l.bits_per_sample,
           l.duration_seconds, l.root_note, l.octave, l.fine_tune_cents, l.gain,
           l.enabled, l.detected_key, NULL, l.created_at
    FROM layer l JOIN audio_blob b ON b.hash = 'v1-' || l.id;

  DROP TABLE sample;
  DROP TABLE layer;
  `,
];
