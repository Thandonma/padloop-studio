import { Injectable, signal } from '@angular/core';

import { guessKeyFromFilename } from '../audio/music';
import { MP3_HEAD_BYTES, isSupportedAudioFile, mp3KeepLength } from './audio-formats';
import { DbRequest, DbResponse, SqlValue, Statement } from './db-protocol';
import { SoundExport, decodeKitFile, encodeKitFile } from './kit-file';
import { KitDetail, KitPatch, KitSettings, KitSummary, MAX_SOUNDS_PER_KIT, Sound, SoundPatch } from './models';
import { InvalidWavError, WavInfo, inspectWav } from './wav';

type Row = Record<string, unknown>;

/**
 * The app's data layer: kits, their sounds and the WAV data, all stored in
 * SQLite inside the browser. Nothing leaves this device.
 *
 * Audio is kept once per distinct file (keyed by a content hash), so loading
 * the same sound into several kits costs no extra space.
 */
@Injectable({ providedIn: 'root' })
export class LibraryService {
  /** False when the browser can't keep data (e.g. some private windows). */
  readonly persistent = signal(true);

  private worker?: Worker;
  private seq = 0;
  private waiting = new Map<number, { resolve: (r: Row[][]) => void; reject: (e: Error) => void }>();
  private ready?: Promise<void>;

  // ------------------------------------------------------------------
  // Plumbing
  // ------------------------------------------------------------------

  init(): Promise<void> {
    this.ready ??= (async () => {
      this.worker = new Worker(new URL('./db.worker', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<DbResponse>) => {
        const msg = ev.data;
        const w = this.waiting.get(msg.id);
        if (!w) return;
        this.waiting.delete(msg.id);
        if (msg.ok) {
          this.persistent.set(msg.persistent);
          w.resolve(msg.results);
        } else {
          w.reject(new Error(msg.error));
        }
      };
      this.worker.onerror = (ev) => {
        const err = new Error(ev.message || 'The storage worker failed to start');
        for (const w of this.waiting.values()) w.reject(err);
        this.waiting.clear();
      };
      await this.post({ id: 0, type: 'init' });
      // Ask the browser not to evict our data under storage pressure.
      void navigator.storage?.persist?.().catch(() => undefined);
    })();
    return this.ready;
  }

  private post(req: DbRequest, transfer: Transferable[] = []): Promise<Row[][]> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker!.postMessage({ ...req, id }, transfer);
    });
  }

  private async run(...statements: Statement[]): Promise<Row[][]> {
    await this.init();
    return this.post({ id: 0, type: 'run', statements });
  }

  private async query(sql: string, ...bind: SqlValue[]): Promise<Row[]> {
    return (await this.run({ sql, bind }))[0];
  }

  // ------------------------------------------------------------------
  // Kits
  // ------------------------------------------------------------------

  async listKits(): Promise<KitSummary[]> {
    const rows = await this.query(`
      SELECT k.id, k.name, k.updated_at, COUNT(s.id) AS sound_count
      FROM kit k LEFT JOIN sound s ON s.kit_id = k.id
      GROUP BY k.id ORDER BY k.updated_at DESC, k.id DESC`);
    return rows.map((r) => ({
      id: Number(r['id']),
      name: String(r['name']),
      soundCount: Number(r['sound_count']),
      updatedAt: String(r['updated_at']),
    }));
  }

  async getKit(id: number): Promise<KitDetail> {
    const [kits, sounds] = await this.run(
      { sql: 'SELECT * FROM kit WHERE id = ?', bind: [id] },
      { sql: 'SELECT * FROM sound WHERE kit_id = ? ORDER BY position, id', bind: [id] },
    );
    const k = kits[0];
    if (!k) throw new Error('That kit no longer exists');
    return {
      id: Number(k['id']),
      name: String(k['name']),
      sessionMinutes: Number(k['session_minutes']),
      masterVolume: Number(k['master_volume']),
      fadeSeconds: Number(k['fade_seconds']),
      keyLock: Number(k['key_lock']) !== 0,
      createdAt: String(k['created_at']),
      updatedAt: String(k['updated_at']),
      sounds: sounds.map(toSound),
    };
  }

  async createKit(name: string, settings: Partial<KitSettings> = {}): Promise<KitDetail> {
    const trimmed = name.trim().slice(0, 80);
    if (!trimmed) throw new Error('Kit name must not be blank');
    const now = new Date().toISOString();
    const [rows] = await this.run({
      sql: `INSERT INTO kit (name, session_minutes, master_volume, fade_seconds, key_lock, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      bind: [
        trimmed,
        settings.sessionMinutes ?? 10,
        settings.masterVolume ?? 0.8,
        settings.fadeSeconds ?? 2,
        (settings.keyLock ?? true) ? 1 : 0,
        now,
        now,
      ],
    });
    return this.getKit(Number(rows[0]['id']));
  }

  async updateKit(id: number, patch: KitPatch): Promise<void> {
    const cols: string[] = [];
    const bind: SqlValue[] = [];
    const set = (col: string, v: SqlValue) => {
      cols.push(`${col} = ?`);
      bind.push(v);
    };
    if (patch.name != null) set('name', patch.name.trim().slice(0, 80));
    if (patch.sessionMinutes != null) set('session_minutes', clamp(Math.round(patch.sessionMinutes), 0, 720));
    if (patch.masterVolume != null) set('master_volume', clamp(patch.masterVolume, 0, 1));
    if (patch.fadeSeconds != null) set('fade_seconds', clamp(patch.fadeSeconds, 0, 30));
    if (patch.keyLock != null) set('key_lock', patch.keyLock ? 1 : 0);
    set('updated_at', new Date().toISOString());
    await this.query(`UPDATE kit SET ${cols.join(', ')} WHERE id = ?`, ...bind, id);
  }

  async deleteKit(id: number): Promise<void> {
    await this.run({ sql: 'DELETE FROM kit WHERE id = ?', bind: [id] }, { sql: COLLECT_GARBAGE });
  }

  // ------------------------------------------------------------------
  // Sounds
  // ------------------------------------------------------------------

  /**
   * Validates an audio file and adds it to the kit. It can then be played in
   * any key.
   *
   * `info` is the metadata the caller already worked out while decoding the
   * file. Without it, only WAV files can be measured here, since they are the
   * only format with a header we can read without a decoder.
   */
  async addSound(
    kitId: number,
    file: File,
    opts: {
      rootNote?: number | null;
      detectedKey?: string | null;
      starterId?: string;
      name?: string;
      info?: WavInfo;
    } = {},
  ): Promise<Sound> {
    if (!isSupportedAudioFile(file.name)) {
      throw new InvalidWavError('That file type is not supported');
    }
    const data = new Uint8Array(await file.arrayBuffer());
    return this.insertSound(
      kitId,
      opts.name ?? file.name,
      data,
      {
        rootNote: opts.rootNote !== undefined ? opts.rootNote : guessKeyFromFilename(file.name),
        detectedKey: opts.detectedKey ?? null,
        starterId: opts.starterId ?? null,
      },
      opts.info,
    );
  }

  private async insertSound(
    kitId: number,
    name: string,
    data: Uint8Array,
    extra: Partial<Sound>,
    known?: WavInfo,
  ): Promise<Sound> {
    const info = known ?? inspectWav(data);
    const count = await this.query('SELECT COUNT(*) AS n FROM sound WHERE kit_id = ?', kitId);
    if (Number(count[0]['n']) >= MAX_SOUNDS_PER_KIT) {
      throw new Error(`A kit holds up to ${MAX_SOUNDS_PER_KIT} sounds. Remove one first.`);
    }
    const hash = await hashBytes(data);
    const now = new Date().toISOString();
    const [, inserted] = await this.run(
      // Store the audio only if this exact file isn't here already.
      { sql: 'INSERT OR IGNORE INTO audio_blob (hash, data) VALUES (?, ?)', bind: [hash, data] },
      {
        sql: `INSERT INTO sound (kit_id, blob_id, position, name, size_bytes, sample_rate, channels,
                                 bits_per_sample, duration_seconds, root_note, octave, fine_tune_cents,
                                 gain, enabled, detected_key, starter_id, created_at)
              VALUES (?1, (SELECT id FROM audio_blob WHERE hash = ?2),
                      (SELECT COALESCE(MAX(position), -1) + 1 FROM sound WHERE kit_id = ?1),
                      ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
              RETURNING *`,
        bind: [
          kitId,
          hash,
          cleanName(name),
          data.byteLength,
          info.sampleRate,
          info.channels,
          info.bitsPerSample,
          info.durationSeconds,
          extra.rootNote ?? null,
          clamp(extra.octave ?? 0, -2, 2),
          clamp(extra.fineTuneCents ?? 0, -100, 100),
          clamp(extra.gain ?? 0.8, 0, 2),
          (extra.enabled ?? true) ? 1 : 0,
          extra.detectedKey?.slice(0, 40) ?? null,
          extra.starterId ?? null,
          now,
        ],
      },
      { sql: 'UPDATE kit SET updated_at = ? WHERE id = ?', bind: [now, kitId] },
    );
    return toSound(inserted[0]);
  }

  async updateSound(id: number, patch: SoundPatch): Promise<void> {
    const cols: string[] = [];
    const bind: SqlValue[] = [];
    const set = (col: string, v: SqlValue) => {
      cols.push(`${col} = ?`);
      bind.push(v);
    };
    if (patch.name != null) set('name', cleanName(patch.name));
    if (patch.clearRootNote) set('root_note', null);
    else if (patch.rootNote != null) set('root_note', clamp(patch.rootNote, 0, 11));
    if (patch.octave != null) set('octave', clamp(patch.octave, -2, 2));
    if (patch.fineTuneCents != null) set('fine_tune_cents', clamp(patch.fineTuneCents, -100, 100));
    if (patch.gain != null) set('gain', clamp(patch.gain, 0, 2));
    if (patch.enabled != null) set('enabled', patch.enabled ? 1 : 0);
    if (patch.detectedKey !== undefined) set('detected_key', patch.detectedKey);
    if (!cols.length) return;
    await this.run(
      { sql: `UPDATE sound SET ${cols.join(', ')} WHERE id = ?`, bind: [...bind, id] },
      {
        sql: 'UPDATE kit SET updated_at = ? WHERE id = (SELECT kit_id FROM sound WHERE id = ?)',
        bind: [new Date().toISOString(), id],
      },
    );
  }

  async deleteSound(id: number): Promise<void> {
    await this.run({ sql: 'DELETE FROM sound WHERE id = ?', bind: [id] }, { sql: COLLECT_GARBAGE });
  }

  /** The stored WAV bytes for a sound. */
  async getAudio(soundId: number): Promise<ArrayBuffer> {
    const rows = await this.query(
      'SELECT b.data FROM sound s JOIN audio_blob b ON b.id = s.blob_id WHERE s.id = ?',
      soundId,
    );
    const data = rows[0]?.['data'];
    if (!(data instanceof Uint8Array)) throw new Error(`Audio for sound ${soundId} is missing`);
    return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? (data.buffer as ArrayBuffer)
      : (data.slice().buffer as ArrayBuffer);
  }

  /**
   * The audio to play for a sound. Long MP3s saved before they were shortened
   * on upload are cut down here, so a kit holding one can still open on a phone.
   */
  async getPlaybackAudio(soundId: number): Promise<ArrayBuffer> {
    const rows = await this.query(
      `SELECT substr(b.data, 1, ?) AS head, LENGTH(b.data) AS size
       FROM sound s JOIN audio_blob b ON b.id = s.blob_id WHERE s.id = ?`,
      MP3_HEAD_BYTES,
      soundId,
    );
    const head = rows[0]?.['head'];
    if (!(head instanceof Uint8Array)) throw new Error(`Audio for sound ${soundId} is missing`);
    const size = Number(rows[0]['size']);
    const keep = mp3KeepLength(head, size);
    if (keep >= size) return this.getAudio(soundId);
    const cut = await this.query(
      'SELECT substr(b.data, 1, ?) AS data FROM sound s JOIN audio_blob b ON b.id = s.blob_id WHERE s.id = ?',
      keep,
      soundId,
    );
    return (cut[0]['data'] as Uint8Array).slice().buffer as ArrayBuffer;
  }

  /** Roughly how much space the stored audio takes, in bytes. */
  async storageUsed(): Promise<number> {
    const rows = await this.query('SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM audio_blob');
    return Number(rows[0]['n']);
  }

  // ------------------------------------------------------------------
  // Backup / move between devices
  // ------------------------------------------------------------------

  async exportKit(id: number): Promise<Blob> {
    const kit = await this.getKit(id);
    const sounds = [];
    for (const sound of kit.sounds) {
      sounds.push({ sound, data: new Uint8Array(await this.getAudio(sound.id)) });
    }
    return encodeKitFile(kit, sounds);
  }

  async importKit(file: File): Promise<KitDetail> {
    const { header, samples } = decodeKitFile(new Uint8Array(await file.arrayBuffer()));
    const existing = new Set((await this.listKits()).map((k) => k.name));
    let name = header.kit.name || 'Imported kit';
    for (let i = 2; existing.has(name); i++) name = `${header.kit.name} (${i})`;
    const kit = await this.createKit(name, header.kit);
    try {
      for (const [i, s] of header.sounds.entries()) {
        await this.insertSound(kit.id, s.name, samples[i], s, infoFromExport(s));
      }
    } catch (err) {
      await this.deleteKit(kit.id);
      throw err;
    }
    return this.getKit(kit.id);
  }
}

/** Drops audio that no sound points at any more. */
const COLLECT_GARBAGE = 'DELETE FROM audio_blob WHERE id NOT IN (SELECT blob_id FROM sound)';

/** Metadata saved with an exported sound, when the file carries one. */
function infoFromExport(s: SoundExport): WavInfo | undefined {
  return s.sampleRate && s.durationSeconds
    ? {
        formatCode: 0,
        channels: s.channels ?? 2,
        sampleRate: s.sampleRate,
        bitsPerSample: s.bitsPerSample ?? 0,
        durationSeconds: s.durationSeconds,
      }
    : undefined;
}

function toSound(r: Row): Sound {
  return {
    id: Number(r['id']),
    kitId: Number(r['kit_id']),
    position: Number(r['position']),
    name: String(r['name']),
    sizeBytes: Number(r['size_bytes']),
    sampleRate: Number(r['sample_rate']),
    channels: Number(r['channels']),
    bitsPerSample: Number(r['bits_per_sample']),
    durationSeconds: Number(r['duration_seconds']),
    rootNote: r['root_note'] == null ? null : Number(r['root_note']),
    octave: Number(r['octave']),
    fineTuneCents: Number(r['fine_tune_cents']),
    gain: Number(r['gain']),
    enabled: Number(r['enabled']) !== 0,
    detectedKey: r['detected_key'] == null ? null : String(r['detected_key']),
    starterId: r['starter_id'] == null ? null : String(r['starter_id']),
    createdAt: String(r['created_at']),
  };
}

function cleanName(name: string): string {
  const n = name.replace(/\.wave?$/i, '').trim();
  return (n || 'Sound').slice(0, 80);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** SHA-256 where available, with a plain fallback for insecure contexts. */
async function hashBytes(data: Uint8Array): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < data.length; i++) {
      h1 = Math.imul(h1 ^ data[i], 16777619) >>> 0;
      h2 = Math.imul(h2 + data[i] + i, 2246822519) >>> 0;
    }
    return `fnv-${data.length}-${h1.toString(16)}${h2.toString(16)}`;
  }
}
