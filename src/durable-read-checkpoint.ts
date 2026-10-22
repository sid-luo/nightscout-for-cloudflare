import { Buffer } from "node:buffer";
import { deflateSync, inflateSync } from "node:zlib";

/** Disposable, tenant-local raw query proofs. Canonical documents stay authoritative. */
export interface DurableReadCheckpointCache {
  readonly checkpointRevision: number;
  readonly ready?: boolean;
  snapshotCheckpoint(): unknown | undefined;
  restoreCheckpoint(value: unknown): boolean;
  clear(): void;
}

export type DurableReadCheckpointComponent = "alert" | "api3";
const TABLE = "nscf_device_status_read_checkpoint";
const FORMAT = "device-status-read-checkpoint-v1";
const SCHEMA_REVISION = 1;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_DECODED_BYTES = 16 * 1024 * 1024;
const MAX_SAVES_PER_MINUTE = 8;
const COLUMNS = ["id", "format", "generation", "valid_mask", "schema_version", "schema_rowids", "alert_payload", "api3_payload",
  "alert_minute", "alert_saves", "api3_minute", "api3_saves"];
const TABLE_SQL = `CREATE TABLE ${TABLE} (
  id INTEGER PRIMARY KEY CHECK(id = 1), format TEXT NOT NULL,
  generation INTEGER NOT NULL, valid_mask INTEGER NOT NULL, schema_version INTEGER NOT NULL, schema_rowids TEXT NOT NULL,
  alert_payload TEXT, api3_payload TEXT,
  alert_minute INTEGER NOT NULL, alert_saves INTEGER NOT NULL,
  api3_minute INTEGER NOT NULL, api3_saves INTEGER NOT NULL
)`;
const TRIGGERS = [
  { name: "nscf_ds_checkpoint_insert", event: "INSERT", when: "NEW.collection = 'devicestatus'" },
  { name: "nscf_ds_checkpoint_update", event: "UPDATE", when: "OLD.collection = 'devicestatus' OR NEW.collection = 'devicestatus'" },
  { name: "nscf_ds_checkpoint_delete", event: "DELETE", when: "OLD.collection = 'devicestatus'" },
].map(({ name, event, when }) => ({ name, sql: `CREATE TRIGGER ${name} AFTER ${event} ON documents
  WHEN ${when} BEGIN UPDATE ${TABLE} SET generation = generation + 1, valid_mask = 0 WHERE id = 1; END` }));
type State = Record<string, SqlStorageValue> & {
  id: number; format: string; generation: number; valid_mask: number; schema_version: number; schema_rowids: string;
  alert_payload: string | null; api3_payload: string | null;
  alert_minute: number; alert_saves: number; api3_minute: number; api3_saves: number;
};
const normalizeSql = (value: string): string => value.replace(/\s+/g, " ").trim().replace(/;$/, "");

function encodePayload(snapshot: unknown): string | undefined {
  const json = JSON.stringify(snapshot);
  if (json === undefined || json.length > MAX_DECODED_BYTES) return undefined;
  const input = Buffer.from(json, "utf8");
  if (input.byteLength > MAX_DECODED_BYTES) return undefined;
  // zlib framing also checks accidental corruption with its checksum. Base64
  // has a fixed expansion; the bound applies to the complete stored envelope.
  const compressed = deflateSync(input, { level: 1 });
  const payload = JSON.stringify({ codec: "zlib-json-v1", bytes: input.byteLength, data: compressed.toString("base64") });
  return payload.length <= MAX_PAYLOAD_BYTES ? payload : undefined;
}

function decodePayload(payload: string): unknown {
  const envelope: unknown = JSON.parse(payload);
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) throw new Error("Invalid checkpoint envelope");
  const value = envelope as Record<string, unknown>;
  if (value.codec !== "zlib-json-v1" || typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes)
    || value.bytes < 1 || value.bytes > MAX_DECODED_BYTES || typeof value.data !== "string"
    || value.data.length > MAX_PAYLOAD_BYTES || value.data.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) {
    throw new Error("Invalid checkpoint encoding");
  }
  // workerd may grow its output buffer in 16 KiB chunks. An exact byte cap
  // can fail below the next chunk even with valid data. Permit only bounded
  // chunk/end-marker headroom, then still require the exact declared length.
  const outputCap = Math.ceil(value.bytes / 16_384) * 16_384 + 1;
  const decoded = inflateSync(Buffer.from(value.data, "base64"), { maxOutputLength: outputCap });
  if (decoded.byteLength !== value.bytes) throw new Error("Invalid checkpoint length");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
}

/**
 * An optional singleton, initialized only by a participating reader. Every
 * canonical device-status DML advances its generation transactionally. This
 * detects a second direct write even while the valid bit was already zero.
 * Each component has independent authority and a persisted save budget.
 */
export class DurableReadCheckpoint {
  private present = false;
  private disabled = false;
  private generation: number | undefined;
  private savedRevision: number | undefined;
  private dirty = false;
  private budgetMinute = -1;
  private budgetSaves = 0;
  private readonly bit: number;

  constructor(private readonly storage: DurableObjectStorage, private readonly component: DurableReadCheckpointComponent) {
    this.bit = component === "alert" ? 1 : 2;
  }

  fork(): DurableReadCheckpoint {
    const copy = new DurableReadCheckpoint(this.storage, this.component);
    copy.present = this.present; copy.disabled = this.disabled;
    copy.generation = this.generation; copy.savedRevision = this.savedRevision; copy.dirty = this.dirty;
    copy.budgetMinute = this.budgetMinute; copy.budgetSaves = this.budgetSaves;
    return copy;
  }

  reset(): void {
    this.present = false; this.disabled = false;
    this.generation = undefined; this.savedRevision = undefined; this.dirty = false;
    this.budgetMinute = -1; this.budgetSaves = 0;
  }

  private columns(): boolean {
    const columns = this.storage.sql.exec<{ name: string }>(`PRAGMA table_info('${TABLE}')`).toArray();
    return columns.length === COLUMNS.length && columns.every((column, index) => column.name === COLUMNS[index]);
  }

  private row(): State | undefined {
    const row = this.storage.sql.exec<State>(`SELECT * FROM ${TABLE} WHERE id = 1`).toArray()[0];
    if (row !== undefined) {
      const minute = row[`${this.component}_minute`], saves = row[`${this.component}_saves`];
      if (typeof minute === "number" && Number.isSafeInteger(minute) && minute >= -1
        && typeof saves === "number" && Number.isSafeInteger(saves) && saves >= 0 && saves <= MAX_SAVES_PER_MINUTE) {
        this.budgetMinute = minute; this.budgetSaves = saves;
      }
    }
    return row;
  }

  private validState(row: State): boolean {
    return row.id === 1 && row.format === FORMAT && Number.isSafeInteger(row.generation) && row.generation >= 0
      && Number.isSafeInteger(row.valid_mask) && row.valid_mask >= 0 && row.valid_mask <= 3
      && Number.isSafeInteger(row.schema_version) && row.schema_version >= 0
      && this.schemaRowids(row.schema_rowids) !== undefined
      && ["alert", "api3"].every(component => {
        const minute = row[`${component}_minute`], saves = row[`${component}_saves`], payload = row[`${component}_payload`];
        return typeof minute === "number" && Number.isSafeInteger(minute) && minute >= -1
          && typeof saves === "number" && Number.isSafeInteger(saves) && saves >= 0 && saves <= MAX_SAVES_PER_MINUTE
          && (payload === null || typeof payload === "string" && payload.length <= MAX_PAYLOAD_BYTES);
      });
  }

  private schemaRowids(value: unknown): number[] | undefined {
    if (typeof value !== "string" || value.length > 128) return undefined;
    try {
      const ids: unknown = JSON.parse(value);
      return Array.isArray(ids) && ids.length === 4 && new Set(ids).size === 4
        && ids.every(id => typeof id === "number" && Number.isSafeInteger(id) && id > 0) ? ids as number[] : undefined;
    } catch { return undefined; }
  }

  private definitions(rowids?: number[]): { name: string; sql: string; schema_rowid: number }[] {
    const names = [TABLE, ...TRIGGERS.map(trigger => trigger.name)];
    return this.storage.sql.exec<{ name: string; sql: string; schema_rowid: number }>(
      `SELECT rowid AS schema_rowid, name, sql FROM sqlite_master WHERE ${rowids === undefined ? "name" : "rowid"} IN (?, ?, ?, ?)`,
      ...(rowids ?? names)).toArray();
  }

  private prepare(create: boolean): State | undefined {
    if (this.disabled) return undefined;
    if (!this.present) this.present = this.columns();
    if (!this.present && !create) return undefined;
    // workerd denies PRAGMA schema_version. Verify the bounded set of actual
    // definitions with its supported schema API instead of assuming a header
    // epoch exists. This deliberately costs schema reads, included in budgets.
    let row = this.present ? this.row() : undefined;
    const rowids = row === undefined ? undefined : this.schemaRowids(row.schema_rowids);
    const selected = this.definitions(rowids);
    const definitions = new Map(selected.map(item => [item.name, normalizeSql(item.sql)]));
    const current = selected.length === 4 && definitions.get(TABLE) === normalizeSql(TABLE_SQL)
      && TRIGGERS.every(trigger => definitions.get(trigger.name) === normalizeSql(trigger.sql));
    if (current && row !== undefined && this.validState(row) && row.schema_version === SCHEMA_REVISION) return row;
    // Missing/changed definitions cannot authorize an old snapshot, even when
    // repairing them makes their text match the current implementation again.
    this.storage.transactionSync(() => {
      if (!this.present) {
        const existing = this.storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", TABLE).toArray();
        if (existing.length !== 0) throw new Error("Unsupported checkpoint table");
        this.storage.sql.exec(TABLE_SQL);
      }
      const table = this.storage.sql.exec<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", TABLE).one();
      if (normalizeSql(table.sql) !== normalizeSql(TABLE_SQL)) throw new Error("Unsupported checkpoint table definition");
      for (const trigger of TRIGGERS) {
        const current = this.storage.sql.exec<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?", trigger.name).toArray()[0];
        if (current?.sql !== undefined && normalizeSql(current.sql) === normalizeSql(trigger.sql)) continue;
        this.storage.sql.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
        this.storage.sql.exec(trigger.sql);
      }
      const sealedDefinitions = this.definitions();
      const names = [TABLE, ...TRIGGERS.map(trigger => trigger.name)];
      const sealedRowids = names.map(name => sealedDefinitions.find(item => item.name === name)?.schema_rowid);
      const schemaRowids = JSON.stringify(sealedRowids);
      if (this.schemaRowids(schemaRowids) === undefined) throw new Error("Invalid checkpoint schema identities");
      const previous = this.row();
      if (previous === undefined) {
        this.storage.sql.exec(`INSERT INTO ${TABLE} VALUES (1, ?, 0, 0, ?, ?, NULL, NULL, -1, 0, -1, 0)`, FORMAT, SCHEMA_REVISION, schemaRowids);
      } else {
        // Do not reset a valid component's rate budget on source invalidation
        // or trigger repair. Malformed budget data disables this optimization.
        if (!this.validState(previous)) throw new Error("Invalid checkpoint metadata");
        this.storage.sql.exec(`UPDATE ${TABLE} SET generation = generation + 1, valid_mask = 0,
          schema_version = ?, schema_rowids = ?, alert_payload = NULL, api3_payload = NULL WHERE id = 1`, SCHEMA_REVISION, schemaRowids);
      }
    });
    this.present = true;
    row = this.row();
    if (row === undefined || !this.validState(row) || row.schema_version !== SCHEMA_REVISION) throw new Error("Unsealed checkpoint");
    return row;
  }

  private fail(cache: DurableReadCheckpointCache): void {
    cache.clear(); this.disabled = true; this.generation = undefined; this.savedRevision = undefined; this.dirty = false;
  }

  hydrate(cache: DurableReadCheckpointCache, options: { create: boolean }): void {
    if (this.disabled) { cache.clear(); return; }
    try {
      const row = this.prepare(options.create);
      if (row === undefined) {
        if (this.generation !== undefined) cache.clear();
        this.generation = undefined; this.savedRevision = undefined; this.dirty = false;
        return;
      }
      if (this.generation === row.generation) return;
      cache.clear(); this.generation = row.generation; this.savedRevision = undefined; this.dirty = false;
      const payload = row[`${this.component}_payload`];
      if ((row.valid_mask & this.bit) === 0 || typeof payload !== "string"
        || new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES) return;
      try {
        if (cache.restoreCheckpoint(decodePayload(payload))) this.savedRevision = cache.checkpointRevision;
        else cache.clear();
      } catch { cache.clear(); }
    } catch { this.fail(cache); }
  }

  beforeMutation(cache: DurableReadCheckpointCache, options: { create: boolean }): void {
    this.hydrate(cache, options);
  }

  afterMutation(cache: DurableReadCheckpointCache): void {
    if (cache.ready === false) {
      this.generation = undefined; this.savedRevision = undefined; this.dirty = false;
      return;
    }
    try {
      const row = this.prepare(false);
      if (row === undefined) return;
      // Call only after the synchronous canonical transaction and its cache
      // maintenance succeed. Rollback restores both the row and controller fork.
      this.generation = row.generation; this.savedRevision = undefined; this.dirty = true;
    } catch { this.fail(cache); }
  }

  persist(cache: DurableReadCheckpointCache): void {
    if (this.disabled || !this.present) return;
    // These branches cannot publish authority or write anything. A subsequent
    // reader still hydrates and checks generation before using its cache.
    if (!this.dirty && this.savedRevision === cache.checkpointRevision) return;
    const currentMinute = Math.floor(Date.now() / 60_000);
    if (currentMinute < this.budgetMinute || currentMinute === this.budgetMinute && this.budgetSaves >= MAX_SAVES_PER_MINUTE) return;
    try {
      const snapshot = cache.snapshotCheckpoint();
      if (snapshot === undefined) return;
      const row = this.prepare(false);
      if (row === undefined) return;
      if (row.generation !== this.generation) {
        cache.clear(); this.generation = row.generation; this.savedRevision = undefined; this.dirty = false;
        return;
      }
      if (!this.dirty && this.savedRevision === cache.checkpointRevision && (row.valid_mask & this.bit) !== 0) return;
      const minute = Math.floor(Date.now() / 60_000), bucket = row[`${this.component}_minute`] as number;
      const count = row[`${this.component}_saves`] as number;
      if (!Number.isSafeInteger(minute) || minute < bucket || minute === bucket && count >= MAX_SAVES_PER_MINUTE) return;
      const payload = encodePayload(snapshot);
      if (payload === undefined) return;
      this.storage.sql.exec(`UPDATE ${TABLE} SET ${this.component}_payload = ?, valid_mask = valid_mask | ?,
        ${this.component}_minute = ?, ${this.component}_saves = ? WHERE id = 1 AND generation = ? AND schema_version = ?`,
      payload, this.bit, minute, minute === bucket ? count + 1 : 1, row.generation, row.schema_version);
      this.budgetMinute = minute; this.budgetSaves = minute === bucket ? count + 1 : 1;
      this.savedRevision = cache.checkpointRevision; this.dirty = false;
    } catch { this.fail(cache); }
  }
}
