import { packSqlRow, unpackSqlRow, PACKED_SQL_ROW_SHARED_BYTES, type PackedSqlRow } from "./raw-row-codec";

export interface CachedDeviceStatusRow {
  id: string;
  body: string;
  sort_time: number;
  updated_at: number;
}

const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_ROWS = 5000;
interface Prefix<Row> { lower: number; rows: readonly PackedSqlRow<Row>[]; complete: boolean; bytes: number }
const prefixBytes = <Row>(rows: readonly PackedSqlRow<Row>[]): number =>
  rows.reduce((sum, row) => sum + row.bytes, 0)
    + (rows.some(row => row.compressedBody !== undefined) ? PACKED_SQL_ROW_SHARED_BYTES : 0);

// Existing loaders retain eager bounded EOF. Alerts opt into lazy prefixes so
// their first read performs only the original normalization budget's SQL work.
interface CacheOptions { compress?: boolean; sourceLimit?: number; prefetch?: boolean }
interface PrefixCheckpoint<Row> { format: 1; lower: number; complete: boolean; rows: Row[] }

/** Lossless bounded loader prefixes; filtering and output budgets always rerun. */
export class DeviceStatusQueryCache<Row extends CachedDeviceStatusRow> {
  private cached: Prefix<Row> | undefined;
  private generation = 0;
  private readonly compress: boolean;
  private readonly sourceLimit: number;
  private readonly prefetch: boolean;

  constructor(options: CacheOptions = {}) {
    this.compress = options.compress ?? false;
    this.prefetch = options.prefetch ?? true;
    this.sourceLimit = options.sourceLimit !== undefined && Number.isSafeInteger(options.sourceLimit)
      && options.sourceLimit > 0 ? options.sourceLimit : Number.POSITIVE_INFINITY;
  }

  clear(): void { this.generation++; this.cached = undefined; }
  fork(): DeviceStatusQueryCache<Row> {
    const copy = new DeviceStatusQueryCache<Row>({ compress: this.compress, sourceLimit: this.sourceLimit, prefetch: this.prefetch });
    copy.cached = this.cached;
    copy.generation = this.generation;
    return copy;
  }
  get ready(): boolean { return this.cached !== undefined; }

  /** Raw input only. The containing checkpoint bounds its serialized size. */
  snapshotCheckpoint(): PrefixCheckpoint<Row> | undefined {
    if (this.cached === undefined) return undefined;
    const rows: Row[] = [];
    // Stop before accumulating an unbounded inflated copy of compressed rows.
    // Leave room for the containing query/future metadata below the codec cap.
    let bytes = 1024 * 1024;
    for (const packed of this.cached.rows) {
      const row = unpackSqlRow(packed);
      bytes += new TextEncoder().encode(JSON.stringify(row)).byteLength + 1;
      if (bytes > 16 * 1024 * 1024) return undefined;
      rows.push(row);
    }
    return { format: 1, lower: this.cached.lower, complete: this.cached.complete, rows };
  }

  /** Repack and re-account restored data rather than trusting persisted sizes. */
  restoreCheckpoint(value: unknown, validate: (row: unknown) => row is Row): boolean {
    this.clear();
    if (typeof value !== "object" || value === null) return false;
    const input = value as Record<string, unknown>;
    if (Object.keys(input).sort().join(",") !== "complete,format,lower,rows"
      || input.format !== 1 || typeof input.lower !== "number" || !Number.isFinite(input.lower)
      || typeof input.complete !== "boolean" || !Array.isArray(input.rows)
      || input.rows.length > MAX_CACHE_ROWS || input.rows.length > this.sourceLimit
      || (!input.complete && input.rows.length === 0)
      || (input.complete && input.rows.length >= this.sourceLimit)) return false;
    const rows: PackedSqlRow<Row>[] = [];
    const ids = new Set<string>();
    let bytes = 0, sharedBytes = 0;
    let previous: Row | undefined;
    for (const candidate of input.rows) {
      if (!validate(candidate) || ids.has(candidate.id) || candidate.sort_time < input.lower) return false;
      if (previous !== undefined && (candidate.sort_time > previous.sort_time
        || (candidate.sort_time === previous.sort_time && candidate.updated_at > previous.updated_at)
        || (candidate.sort_time === previous.sort_time && candidate.updated_at === previous.updated_at
          && candidate.id < previous.id))) return false;
      const packed = packSqlRow(candidate, this.compress);
      if (packed === null) return false;
      const addedSharedBytes = packed.compressedBody !== undefined && sharedBytes === 0 ? PACKED_SQL_ROW_SHARED_BYTES : 0;
      bytes += packed.bytes + addedSharedBytes; sharedBytes += addedSharedBytes;
      if (bytes > MAX_CACHE_BYTES) return false;
      rows.push(packed);
      ids.add(candidate.id);
      previous = candidate;
    }
    this.cached = { lower: input.lower, complete: input.complete, rows, bytes };
    return true;
  }

  upsert(row: Row): void {
    this.generation++;
    if (this.cached === undefined) return;
    const { lower, complete } = this.cached;
    const boundary = this.cached.rows.at(-1)?.row;
    const existing = this.cached.rows.some(item => item.row.id === row.id);
    const before = (left: Row, right: Row): boolean => left.sort_time > right.sort_time
      || (left.sort_time === right.sort_time && left.updated_at > right.updated_at);
    const rows = this.cached.rows.filter(item => item.row.id !== row.id);
    if (!complete && existing && (row.sort_time < lower || (boundary !== undefined && before(boundary, row)))) {
      this.clear(); return;
    }
    if (row.sort_time >= lower) {
      // Exact SQL ties still need the original cursor; never invent an id tie.
      if (rows.some(item => item.row.sort_time === row.sort_time && item.row.updated_at === row.updated_at)
        || (!complete && boundary !== undefined && boundary.sort_time === row.sort_time
          && boundary.updated_at === row.updated_at && boundary.id !== row.id)) {
        this.clear(); return;
      }
      if (complete || (boundary !== undefined && before(row, boundary)) || existing) {
        const packed = packSqlRow(row, this.compress);
        if (packed === null) { this.clear(); return; }
        rows.push(packed);
      }
      rows.sort((a, b) => b.row.sort_time - a.row.sort_time || b.row.updated_at - a.row.updated_at);
    }
    const retained = rows.length > this.sourceLimit ? rows.slice(0, this.sourceLimit) : rows;
    const bytes = prefixBytes(retained);
    if (retained.length > MAX_CACHE_ROWS || bytes > MAX_CACHE_BYTES) { this.clear(); return; }
    this.cached = { lower, rows: retained, complete: complete && rows.length <= this.sourceLimit, bytes };
  }

  *read(lower: number, frame: boolean, load: () => Iterable<Row>): IterableIterator<Row> {
    if (frame) { yield* load(); return; }
    const cached = this.cached !== undefined && lower >= this.cached.lower ? this.cached : undefined;
    const generation = this.generation;
    if (cached !== undefined) {
      const rows = cached.rows.filter(item => item.row.sort_time >= lower);
      // A rising SQL lower bound safely drops an old suffix, independently of
      // consumer cutoffs. Keep the unchanged raw byte cap and avoid repeatedly
      // inflating ordinary realtime status bodies on every snapshot.
      if (generation === this.generation) this.cached = rows.length > 0 || cached.complete
        ? { lower, rows, complete: cached.complete, bytes: prefixBytes(rows) } : undefined;
      for (const packed of rows) yield unpackSqlRow(packed);
      if (cached.complete) return;
      // A valid partial prefix serves small consumers without touching SQL.
      // Only a consumer that asks past it pays the unchanged original tail.
      const seen = new Set(rows.map(item => item.row.id));
      const extended = [...rows];
      let bytes = prefixBytes(extended);
      let sharedBytes = rows.some(row => row.compressedBody !== undefined) ? PACKED_SQL_ROW_SHARED_BYTES : 0;
      let canExtend = true;
      let done = false;
      let sourceRows = 0;
      let cursor: Iterator<Row> | undefined;
      let throwing = false;
      try {
        cursor = load()[Symbol.iterator]();
        while (true) {
          const next = cursor.next();
          if (next.done) { done = true; break; }
          sourceRows++;
          const row = next.value;
          if (seen.has(row.id)) continue;
          const packed = canExtend && Number.isFinite(row.sort_time) && Number.isFinite(row.updated_at)
            ? packSqlRow(row, this.compress) : null;
          const newSharedBytes = packed?.compressedBody !== undefined && sharedBytes === 0 ? PACKED_SQL_ROW_SHARED_BYTES : 0;
          if (packed === null || extended.length >= MAX_CACHE_ROWS || extended.length >= this.sourceLimit
            || bytes + packed.bytes + newSharedBytes > MAX_CACHE_BYTES) {
            canExtend = false;
          } else {
            extended.push(packed); bytes += packed.bytes + newSharedBytes; sharedBytes += newSharedBytes;
          }
          if (canExtend && generation === this.generation) {
            this.cached = { lower, rows: [...extended], complete: false, bytes };
          }
          yield { ...row };
        }
      } catch (error) {
        throwing = true;
        if (generation === this.generation) this.cached = undefined;
        throw error;
      } finally {
        if (!done && cursor !== undefined) {
          try { cursor.return?.(); }
          catch (error) {
            if (generation === this.generation) this.cached = undefined;
            if (!throwing) throw error;
          }
        }
        if (done && canExtend && generation === this.generation) this.cached = {
          lower, rows: extended, complete: sourceRows < this.sourceLimit, bytes,
        };
      }
      return;
    }
    this.cached = undefined;
    const rows: PackedSqlRow<Row>[] = [];
    let bytes = 0;
    let sharedBytes = 0;
    let cursor: Iterator<Row> | undefined;
    let done = false;
    let pending: IteratorYieldResult<Row> | undefined;
    let failed = false;
    let deferredError: unknown;
    let throwing = false;
    let streamingCacheable = !this.prefetch;
    try {
      cursor = load()[Symbol.iterator]();
      // Complete bounded EOF is independent of the consumer's output cutoff.
      while (this.prefetch && generation === this.generation) {
        try {
          const next = cursor.next();
          if (next.done) { done = true; break; }
          const packed = Number.isFinite(next.value.sort_time) && Number.isFinite(next.value.updated_at)
            ? packSqlRow(next.value, this.compress) : null;
          const newSharedBytes = packed?.compressedBody !== undefined && sharedBytes === 0 ? PACKED_SQL_ROW_SHARED_BYTES : 0;
          if (packed === null || rows.length >= MAX_CACHE_ROWS || rows.length >= this.sourceLimit
            || bytes + packed.bytes + newSharedBytes > MAX_CACHE_BYTES) {
            pending = next; break;
          }
          rows.push(packed); bytes += packed.bytes + newSharedBytes; sharedBytes += newSharedBytes;
        } catch (error) { failed = true; deferredError = error; break; }
      }
      if (!failed && generation === this.generation && (done || rows.length > 0)) {
        this.cached = { lower, rows, complete: done && rows.length < this.sourceLimit, bytes };
      }
      for (const packed of rows) yield unpackSqlRow(packed);
      if (failed) throw deferredError;
      if (pending !== undefined) yield { ...pending.value };
      if (!done) {
        while (true) {
          const next = cursor.next();
          if (next.done) { done = true; break; }
          if (!this.prefetch && streamingCacheable && generation === this.generation) {
            const row = next.value;
            const packed = Number.isFinite(row.sort_time) && Number.isFinite(row.updated_at)
              ? packSqlRow(row, this.compress) : null;
            const newSharedBytes = packed?.compressedBody !== undefined && sharedBytes === 0 ? PACKED_SQL_ROW_SHARED_BYTES : 0;
            if (packed === null || rows.length >= MAX_CACHE_ROWS || rows.length >= this.sourceLimit
              || bytes + packed.bytes + newSharedBytes > MAX_CACHE_BYTES) {
              streamingCacheable = false;
            } else {
              rows.push(packed); bytes += packed.bytes + newSharedBytes; sharedBytes += newSharedBytes;
              this.cached = { lower, rows: [...rows], complete: false, bytes };
            }
          }
          yield { ...next.value };
        }
        if (!this.prefetch && streamingCacheable && generation === this.generation) {
          this.cached = { lower, rows, complete: rows.length < this.sourceLimit, bytes };
        }
      }
    } catch (error) {
      throwing = true;
      if (generation === this.generation) this.cached = undefined;
      throw error;
    }
    finally {
      if (!done && cursor !== undefined) {
        try { cursor.return?.(); }
        catch (error) {
          if (generation === this.generation) this.cached = undefined;
          if (!throwing) throw error;
        }
      }
    }
  }
}
