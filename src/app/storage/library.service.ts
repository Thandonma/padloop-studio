import { Injectable, signal } from '@angular/core';

import { guessKeyFromFilename } from '../audio/music';
import { inspectAudio, isSupportedAudioFile, isWavFile } from './audio-formats';
import { DbRequest, DbResponse, SqlValue, Statement } from './db-protocol';
import { decodeKitFile, encodeKitFile } from './kit-file';
import { KitDetail, KitPatch, KitSettings, KitSummary, Layer, LayerPatch, MAX_LAYERS_PER_PAD } from './models';
import { inspectWav } from './wav';

type Row = Record<string, unknown>;

/**
 * The app's data layer: kits, layers and audio data stored in SQLite inside
 * the browser. Everything stays on this device; no server is involved.
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
      SELECT k.id, k.name, k.updated_at, COUNT(l.id) AS layer_count
      FROM kit k LEFT JOIN layer l ON l.kit_id = k.id
      GROUP BY k.id ORDER BY k.updated_at DESC, k.id DESC`);
    return rows.map((r) => ({
      id: Number(r['id']),
      name: String(r['name']),
      layerCount: Number(r['layer_count']),
      updatedAt: String(r['updated_at']),
    }));
  }

  async getKit(id: number): Promise<KitDetail> {
    const [kits, layers] = await this.run(
      { sql: 'SELECT * FROM kit WHERE id = ?', bind: [id] },
      { sql: 'SELECT * FROM layer WHERE kit_id = ? ORDER BY pad_index, position, id', bind: [id] },
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
      layers: layers.map(toLayer),
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
    await this.query('DELETE FROM kit WHERE id = ?', id); // layers + samples cascade
  }

  // ------------------------------------------------------------------
  // Layers
  // ------------------------------------------------------------------

  /** Validates and stores an audio file as a new layer. `buffer` is the file already decoded (e.g. for key detection), reused here to avoid decoding twice. */
  async addLayer(
    kitId: number,
    padIndex: number,
    file: File,
    buffer: AudioBuffer,
    opts: { rootNote?: number | null; detectedKey?: string | null } = {},
  ): Promise<Layer> {
    if (!isSupportedAudioFile(file.name)) throw new Error(`${file.name}: unsupported audio format`);
    const data = new Uint8Array(await file.arrayBuffer());
    const bitsPerSample = isWavFile(file.name) ? inspectWav(data).bitsPerSample : 0;
    const root = opts.rootNote !== undefined ? opts.rootNote : guessKeyFromFilename(file.name);
    return this.insertLayer(
      kitId,
      padIndex,
      file.name,
      data,
      { sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, bitsPerSample, durationSeconds: buffer.duration },
      { rootNote: root, detectedKey: opts.detectedKey ?? null },
    );
  }

  private async insertLayer(
    kitId: number,
    padIndex: number,
    name: string,
    data: Uint8Array,
    info: { sampleRate: number; channels: number; bitsPerSample: number; durationSeconds: number },
    extra: Partial<Layer>,
  ): Promise<Layer> {
    if (!(padIndex >= 0 && padIndex <= 11)) throw new Error('Pad index must be between 0 and 11');
    const count = await this.query('SELECT COUNT(*) AS n FROM layer WHERE kit_id = ? AND pad_index = ?', kitId, padIndex);
    if (Number(count[0]['n']) >= MAX_LAYERS_PER_PAD) {
      throw new Error(`That pad already has ${MAX_LAYERS_PER_PAD} layers`);
    }
    const now = new Date().toISOString();
    const [inserted] = await this.run(
      {
        sql: `INSERT INTO layer (kit_id, pad_index, position, original_name, size_bytes, sample_rate, channels,
                                 bits_per_sample, duration_seconds, root_note, octave, fine_tune_cents, gain,
                                 enabled, detected_key, created_at)
              VALUES (?1, ?2, (SELECT COALESCE(MAX(position), -1) + 1 FROM layer WHERE kit_id = ?1 AND pad_index = ?2),
                      ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
              RETURNING *`,
        bind: [
          kitId,
          padIndex,
          name.slice(-200),
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
          now,
        ],
      },
      { sql: 'INSERT INTO sample (layer_id, data) VALUES (last_insert_rowid(), ?)', bind: [data] },
      { sql: 'UPDATE kit SET updated_at = ? WHERE id = ?', bind: [now, kitId] },
    );
    return toLayer(inserted[0]);
  }

  async updateLayer(id: number, patch: LayerPatch): Promise<void> {
    const cols: string[] = [];
    const bind: SqlValue[] = [];
    const set = (col: string, v: SqlValue) => {
      cols.push(`${col} = ?`);
      bind.push(v);
    };
    if (patch.padIndex != null) set('pad_index', clamp(patch.padIndex, 0, 11));
    if (patch.clearRootNote) set('root_note', null);
    else if (patch.rootNote != null) set('root_note', clamp(patch.rootNote, 0, 11));
    if (patch.octave != null) set('octave', clamp(patch.octave, -2, 2));
    if (patch.fineTuneCents != null) set('fine_tune_cents', clamp(patch.fineTuneCents, -100, 100));
    if (patch.gain != null) set('gain', clamp(patch.gain, 0, 2));
    if (patch.enabled != null) set('enabled', patch.enabled ? 1 : 0);
    if (patch.detectedKey !== undefined) set('detected_key', patch.detectedKey);
    if (!cols.length) return;
    await this.run(
      { sql: `UPDATE layer SET ${cols.join(', ')} WHERE id = ?`, bind: [...bind, id] },
      {
        sql: 'UPDATE kit SET updated_at = ? WHERE id = (SELECT kit_id FROM layer WHERE id = ?)',
        bind: [new Date().toISOString(), id],
      },
    );
  }

  async deleteLayer(id: number): Promise<void> {
    await this.query('DELETE FROM layer WHERE id = ?', id);
  }

  /** The stored audio bytes for a layer. */
  async getAudio(layerId: number): Promise<ArrayBuffer> {
    const rows = await this.query('SELECT data FROM sample WHERE layer_id = ?', layerId);
    const data = rows[0]?.['data'];
    if (!(data instanceof Uint8Array)) throw new Error(`Audio for layer ${layerId} is missing`);
    return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? (data.buffer as ArrayBuffer)
      : (data.slice().buffer as ArrayBuffer);
  }

  // ------------------------------------------------------------------
  // Backup / move between devices
  // ------------------------------------------------------------------

  async exportKit(id: number): Promise<Blob> {
    const kit = await this.getKit(id);
    const layers = [];
    for (const layer of kit.layers) {
      layers.push({ layer, data: new Uint8Array(await this.getAudio(layer.id)) });
    }
    return encodeKitFile(kit, layers);
  }

  async importKit(file: File): Promise<KitDetail> {
    const { header, samples } = decodeKitFile(new Uint8Array(await file.arrayBuffer()));
    const existing = new Set((await this.listKits()).map((k) => k.name));
    let name = header.kit.name || 'Imported kit';
    for (let i = 2; existing.has(name); i++) name = `${header.kit.name} (${i})`;
    const kit = await this.createKit(name, header.kit);
    const ctx = new AudioContext();
    try {
      for (const [i, l] of header.layers.entries()) {
        const info = await inspectAudio(samples[i], l.originalName, ctx);
        await this.insertLayer(kit.id, l.padIndex, l.originalName, samples[i], info, l);
      }
    } catch (err) {
      await this.deleteKit(kit.id);
      throw err;
    } finally {
      void ctx.close();
    }
    return this.getKit(kit.id);
  }
}

function toLayer(r: Row): Layer {
  return {
    id: Number(r['id']),
    kitId: Number(r['kit_id']),
    padIndex: Number(r['pad_index']),
    position: Number(r['position']),
    originalName: String(r['original_name']),
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
    createdAt: String(r['created_at']),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
