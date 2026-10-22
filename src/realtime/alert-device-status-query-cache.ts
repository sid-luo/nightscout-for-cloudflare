import { DeviceStatusQueryCache, type CachedDeviceStatusRow } from "./device-status-query-cache";
import { packSqlRow, unpackSqlRow, PACKED_SQL_ROW_SHARED_BYTES, type PackedSqlRow } from "./raw-row-codec";

const SOURCE_LIMIT = 1000;
const MAX_FUTURE_BYTES = 128 * 1024;
const ALERT_FIELDS = new Set(["uploader", "uploaderBattery", "pump", "openaps", "xdripjs", "loop"]);
interface FutureSelection<Row> { key: string; at: number; row: PackedSqlRow<Row> | undefined }

/**
 * The original alert predicate's lazily consumed raw latest-1000 prefix. A
 * SQL LIMIT is not proof of complete history. Keep it conservative on writes,
 * and expire it when the previously observed first future match enters.
 */
export class AlertDeviceStatusQueryCache<Row extends CachedDeviceStatusRow> {
  private rows = new DeviceStatusQueryCache<Row>({ compress: true, sourceLimit: SOURCE_LIMIT, prefetch: false });
  private key: string | undefined;
  private fields: readonly string[] = [];
  private upper = Number.NEGATIVE_INFINITY;
  private nextFuture: number | undefined;
  private futureSelection: FutureSelection<Row> | undefined;
  private revision = 0;

  get ready(): boolean { return this.rows.ready || this.futureSelection !== undefined; }
  get checkpointRevision(): number { return this.revision; }

  clear(): void {
    this.revision++;
    this.rows.clear();
    this.key = undefined;
    this.fields = [];
    this.upper = Number.NEGATIVE_INFINITY;
    this.nextFuture = undefined;
    this.futureSelection = undefined;
  }

  fork(): AlertDeviceStatusQueryCache<Row> {
    const copy = new AlertDeviceStatusQueryCache<Row>();
    copy.rows = this.rows.fork();
    copy.key = this.key;
    copy.fields = this.fields;
    copy.upper = this.upper;
    copy.nextFuture = this.nextFuture;
    copy.futureSelection = this.futureSelection;
    copy.revision = this.revision;
    return copy;
  }

  snapshotCheckpoint(): unknown | undefined {
    const recent = this.rows.snapshotCheckpoint();
    const future = this.futureSelection;
    if (recent === undefined || future === undefined || this.key === undefined || this.nextFuture === undefined
      || this.nextFuture !== (future.row === undefined ? Number.POSITIVE_INFINITY : future.row.row.sort_time)
      || (future.row !== undefined && future.row.row.sort_time <= this.upper)) return undefined;
    return { format: 1, key: this.key, fields: this.fields, upper: this.upper, recent,
      future: { key: future.key, at: future.at, row: future.row === undefined ? null : unpackSqlRow(future.row) } };
  }

  restoreCheckpoint(value: unknown): boolean {
    this.clear();
    if (typeof value !== "object" || value === null) return false;
    const input = value as Record<string, unknown>;
    if (Object.keys(input).sort().join(",") !== "fields,format,future,key,recent,upper"
      || input.format !== 1 || typeof input.key !== "string" || input.key.length > 16_384
      || typeof input.upper !== "number" || !Number.isFinite(input.upper)
      || !Array.isArray(input.fields) || input.fields.length === 0 || input.fields.length > ALERT_FIELDS.size
      || new Set(input.fields).size !== input.fields.length
      || !input.fields.every(field => typeof field === "string" && ALERT_FIELDS.has(field))
      || typeof input.future !== "object" || input.future === null) return false;
    const fields = input.fields as string[];
    const upper = input.upper;
    const validRow = (value: unknown): value is Row => {
      if (typeof value !== "object" || value === null) return false;
      const row = value as Record<string, unknown>;
      if (Object.keys(row).sort().join(",") !== "body,id,sort_time,updated_at"
        || typeof row.id !== "string" || row.id.length === 0 || row.id.length > 4096
        || typeof row.body !== "string" || row.body.length > 2 * 1024 * 1024
        || typeof row.sort_time !== "number" || !Number.isFinite(row.sort_time)
        || typeof row.updated_at !== "number" || !Number.isFinite(row.updated_at)) return false;
      try {
        const body: unknown = JSON.parse(row.body);
        return typeof body === "object" && body !== null
          && fields.some(field => Object.prototype.hasOwnProperty.call(body, field));
      } catch { return false; }
    };
    const future = input.future as Record<string, unknown>;
    if (Object.keys(future).sort().join(",") !== "at,key,row"
      || typeof future.key !== "string" || future.key.length > 16_384
      || typeof future.at !== "number" || !Number.isFinite(future.at) || future.at > upper
      || (future.row !== null && (!validRow(future.row) || future.row.sort_time <= upper))) return false;
    const packed = future.row === null ? undefined : packSqlRow(future.row as Row);
    if (packed === null || 256 + 2 * (future.key.length + input.key.length + fields.join("|").length)
      + (packed?.bytes ?? 0) + (packed?.compressedBody !== undefined ? PACKED_SQL_ROW_SHARED_BYTES : 0) > MAX_FUTURE_BYTES) return false;
    if (!this.rows.restoreCheckpoint(input.recent, (row): row is Row => validRow(row) && row.sort_time <= upper)) return false;
    this.key = input.key;
    this.fields = fields;
    this.upper = upper;
    this.futureSelection = { key: future.key, at: future.at, row: packed };
    this.nextFuture = packed === undefined ? Number.POSITIVE_INFINITY : packed.row.sort_time;
    return true;
  }

  *read(key: string, fields: readonly string[], lower: number, upper: number,
    load: () => Iterable<Row>): IterableIterator<Row> {
    if (this.key !== key || upper < this.upper) this.futureSelection = undefined;
    if (this.key !== key || upper < this.upper || this.nextFuture === undefined
      || upper >= this.nextFuture) this.rows.clear();
    this.key = key;
    this.fields = [...fields];
    this.upper = upper;
    // The caller seals this only after the original future query succeeds.
    this.nextFuture = undefined;
    let count = 0;
    for (const row of this.rows.read(lower, false, () => { this.revision++; return load(); })) {
      yield row;
      // Do not request a tail solely to prove EOF beyond the original LIMIT.
      if (++count === SOURCE_LIMIT) return;
    }
  }

  rememberFuture(row: Row | undefined): void {
    this.nextFuture = row === undefined ? Number.POSITIVE_INFINITY : row.sort_time;
  }

  /** One exact future row or empty proof; any DeviceStatus mutation drops it. */
  future(key: string, upper: number, load: () => Row | undefined): Row | undefined {
    const cached = this.futureSelection;
    if (cached !== undefined && cached.key === key && upper >= cached.at
      && (cached.row === undefined || upper < cached.row.row.sort_time)) {
      return cached.row === undefined ? undefined : unpackSqlRow(cached.row);
    }
    this.futureSelection = undefined;
    this.revision++;
    const row = load();
    const packed = row === undefined ? undefined : packSqlRow(row);
    const bytes = 256 + 2 * (key.length + (this.key?.length ?? 0)) + 2 * this.fields.join("|").length
      + (packed?.bytes ?? 0)
      + (packed?.compressedBody !== undefined ? PACKED_SQL_ROW_SHARED_BYTES : 0);
    if ((row === undefined || packed !== null) && bytes <= MAX_FUTURE_BYTES) {
      this.futureSelection = { key, at: upper, row: packed ?? undefined };
    }
    return row;
  }

  upsert(row: Row, now: number): void {
    this.revision++;
    // Even an unmatched/new future record can invalidate the exact future
    // result. This proof must not depend on recent-prefix admission.
    this.futureSelection = undefined;
    if (!this.rows.ready) return;
    let matches = false;
    try {
      const body: unknown = JSON.parse(row.body);
      matches = typeof body === "object" && body !== null
        && this.fields.some(field => Object.prototype.hasOwnProperty.call(body, field));
    } catch { /* The original json_valid predicate excludes malformed bodies. */ }
    if (!matches || now < this.upper || this.nextFuture === undefined || now >= this.nextFuture
      || row.sort_time > now) {
      this.rows.clear();
      return;
    }
    // Other readers may fetch extra canonical columns for their own cache.
    // This fixed alert selection retains only the original four raw columns.
    this.rows.upsert({ id: row.id, body: row.body, sort_time: row.sort_time, updated_at: row.updated_at } as Row);
    this.upper = now;
  }
}
