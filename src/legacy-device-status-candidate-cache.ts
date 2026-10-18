import { projectLegacyDeviceStatusCandidate } from "./legacy-device-status-query";
import { PACKED_SQL_ROW_SHARED_BYTES, packSqlRow, unpackSqlRow, type PackedSqlRow } from "./realtime/raw-row-codec";

export interface LegacyDeviceStatusCandidate {
  id: string;
  body: string;
  sort_time: number;
  updated_at: number;
  /** Original SQLite rowid, only when the loader proves its ASC tie order. */
  storage_order?: number;
}

interface CandidatePrefix<Row extends object> {
  rows: readonly PackedSqlRow<Row>[];
  limit: number;
  complete: boolean;
  fields: readonly string[] | undefined;
  bytes: number;
}

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 32;
const RAW_KEY = "raw";
const ENTRY_BYTES = 256;

/** Raw and query-path prefixes share one bounded per-object allocation. */
export class LegacyDeviceStatusCandidateCache<Row extends LegacyDeviceStatusCandidate> {
  private readonly entries = new Map<string, CandidatePrefix<Row>>();
  private bytes = 0;
  private bufferBytes = 0;
  private generation = 0;
  private readonly maxBytes: number;

  constructor(maxBytes = MAX_BYTES) {
    this.maxBytes = Number.isFinite(maxBytes) ? Math.max(0, Math.min(MAX_BYTES, Math.trunc(maxBytes))) : MAX_BYTES;
  }

  clear(): void { this.generation++; this.entries.clear(); this.bytes = 0; }
  get ready(): boolean { return this.entries.size > 0; }
  get retainedBytes(): number { return this.bytes; }
  get entryCount(): number { return this.entries.size; }

  fork(): LegacyDeviceStatusCandidateCache<Row> {
    const copy = new LegacyDeviceStatusCandidateCache<Row>(this.maxBytes);
    for (const [key, value] of this.entries) copy.entries.set(key, value);
    copy.bytes = this.bytes;
    copy.generation = this.generation;
    return copy;
  }

  peek(limit: number): readonly Row[] | undefined {
    return this.peekKey(RAW_KEY, limit);
  }

  /** Decode only rows the caller consumes from a complete usable prefix. */
  peekRows(limit: number): IterableIterator<Row> | undefined {
    return this.peekKeyRows(RAW_KEY, limit);
  }

  read(limit: number, load: () => Row[]): readonly Row[] {
    const cached = this.peek(limit);
    if (cached !== undefined) return cached;
    this.remove(RAW_KEY);
    const generation = this.generation;
    const rows = load();
    if (rows.length > 5000 || generation !== this.generation) return rows;
    let bytes = this.metadataBytes(RAW_KEY, undefined);
    let reserved = 0;
    let shared = false;
    const packed: PackedSqlRow<Row>[] = [];
    try {
      if (!this.reserveBuffer(0, bytes)) return rows;
      reserved = bytes;
      for (const row of rows) {
        const item = this.pack(row);
        const sharedBytes = !shared && item?.compressedBody !== undefined ? PACKED_SQL_ROW_SHARED_BYTES : 0;
        if (item === null || bytes + item.bytes + sharedBytes > this.maxBytes ||
          !this.reserveBuffer(reserved, bytes + item.bytes + sharedBytes)) return rows;
        packed.push(item);
        bytes += item.bytes + sharedBytes;
        shared ||= item.compressedBody !== undefined;
        reserved = bytes;
      }
      if (generation === this.generation) {
        this.storeReserved(RAW_KEY, { rows: packed, limit,
          complete: rows.length < limit, fields: undefined, bytes }, reserved);
        reserved = 0;
      }
    } finally { this.bufferBytes -= reserved; }
    return rows;
  }

  peekProjected(fields: readonly string[], limit: number): readonly Row[] | undefined {
    return this.peekKey(this.projectionKey(this.normalizedFields(fields)), limit);
  }

  peekProjectedRows(fields: readonly string[], limit: number): IterableIterator<Row> | undefined {
    return this.peekKeyRows(this.projectionKey(this.normalizedFields(fields)), limit);
  }

  /**
   * Cold reads stay lazy. Admit only real EOF or the complete original SQL
   * candidate boundary; an early successful filter cannot cache a short prefix.
   */
  *readProjected(
    fields: readonly string[],
    limit: number,
    load: () => Iterable<Row>,
    yieldOriginalOnCold = false,
  ): IterableIterator<Row> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new RangeError("invalid candidate limit");
    const paths = this.normalizedFields(fields);
    const key = this.projectionKey(paths);
    const cached = this.peekKeyRows(key, limit);
    if (cached !== undefined) { yield* cached; return; }
    this.remove(key);
    const generation = this.generation;
    let bytes = this.metadataBytes(key, paths);
    let cacheable = bytes <= this.maxBytes;
    let rows: PackedSqlRow<Row>[] = [];
    let reserved = 0;
    let shared = false;
    let cursor: Iterator<Row> | undefined;
    let done = false;
    let visited = 0;
    let failed = false;
    let throwing = false;
    try {
      if (cacheable) {
        cacheable = this.reserveBuffer(0, bytes);
        if (cacheable) reserved = bytes;
      }
      cursor = load()[Symbol.iterator]();
      while (visited < limit) {
        const next = cursor.next();
        if (next.done) { done = true; break; }
        const projected = projectLegacyDeviceStatusCandidate(next.value, paths);
        const copy = { ...projected };
        visited++;
        if (cacheable) {
          const packed = this.pack(copy);
          const sharedBytes = !shared && packed?.compressedBody !== undefined ? PACKED_SQL_ROW_SHARED_BYTES : 0;
          if (generation !== this.generation || packed === null ||
            bytes + packed.bytes + sharedBytes > this.maxBytes ||
            !this.reserveBuffer(reserved, bytes + packed.bytes + sharedBytes)) {
            cacheable = false;
            rows = [];
            this.bufferBytes -= reserved;
            reserved = 0;
          } else {
            rows.push(packed);
            bytes += packed.bytes + sharedBytes;
            shared ||= packed.compressedBody !== undefined;
            reserved = bytes;
          }
        }
        // A cold caller can return selected original bodies directly. The
        // retained buffer still contains only the bounded projection; warm
        // callers fetch complete bodies for their selected canonical ids.
        yield yieldOriginalOnCold ? { ...next.value } : { ...copy };
      }
    } catch (error) {
      failed = true;
      throwing = true;
      throw error;
    } finally {
      try {
        if (!done && cursor !== undefined) {
          try { cursor.return?.(); }
          catch (error) { failed = true; if (!throwing) throw error; }
        }
        if (!failed && cacheable && generation === this.generation && (done || visited === limit)) {
          this.storeReserved(key, { rows, limit, complete: done && visited < limit,
            fields: paths, bytes }, reserved);
          reserved = 0;
        }
      } finally { this.bufferBytes -= reserved; }
    }
  }

  upsert(row: Row): void {
    this.generation++;
    for (const [key, cached] of [...this.entries]) {
      if (this.entries.get(key) !== cached) continue;
      const { limit, complete } = cached;
      const boundary = cached.rows.at(-1)?.row;
      const existing = cached.rows.some(item => item.row.id === row.id);
      const sameTimes = (left: Row, right: Row) => left.sort_time === right.sort_time
        && left.updated_at === right.updated_at;
      const knownTieOrder = (left: Row, right: Row) => Number.isSafeInteger(left.storage_order)
        && Number.isSafeInteger(right.storage_order)
        && (left.id === right.id ? left.storage_order === right.storage_order : left.storage_order !== right.storage_order);
      const before = (left: Row, right: Row) => left.sort_time > right.sort_time
        || (left.sort_time === right.sort_time && left.updated_at > right.updated_at)
        || (sameTimes(left, right) && knownTieOrder(left, right) && left.storage_order! < right.storage_order!);
      if (!complete && boundary !== undefined && before(boundary, row)) {
        if (existing) this.remove(key);
        continue;
      }
      const rows = cached.rows.filter(item => item.row.id !== row.id);
      if ((!complete && boundary !== undefined && sameTimes(boundary, row) && !knownTieOrder(boundary, row)) ||
        rows.some(item => sameTimes(item.row, row) && !knownTieOrder(item.row, row))) {
        this.remove(key);
        continue;
      }
      const changed = cached.fields === undefined ? row : projectLegacyDeviceStatusCandidate(row, cached.fields);
      const packed = this.pack(changed);
      if (packed === null) { this.remove(key); continue; }
      rows.push(packed);
      rows.sort((left, right) => {
        const a = left.row, b = right.row;
        return b.sort_time - a.sort_time || b.updated_at - a.updated_at
          || (knownTieOrder(a, b) ? (a.storage_order! < b.storage_order! ? -1 : a.storage_order! > b.storage_order! ? 1 : 0) : 0);
      });
      const prefix = rows.slice(0, limit);
      const bytes = this.prefixBytes(key, cached.fields, prefix);
      this.remove(key);
      if (bytes !== null) this.store(key, { rows: prefix, limit,
        complete: complete && rows.length <= limit, fields: cached.fields, bytes });
    }
  }

  private normalizedFields(fields: readonly string[]): readonly string[] {
    return Object.freeze([...new Set(fields)].sort());
  }
  private projectionKey(fields: readonly string[]): string { return `projection:${JSON.stringify(fields)}`; }
  private metadataBytes(key: string, fields: readonly string[] | undefined): number {
    // Account for the compiled path nodes as well as field/key strings. Shared
    // prefixes are deliberately charged per field, giving a conservative bound.
    return ENTRY_BYTES + 2 * key.length + (fields ?? []).reduce(
      (sum, field) => sum + 32 + 2 * field.length + 128 * field.split(".").length, 0,
    );
  }
  private pack(row: Row): PackedSqlRow<Row> | null {
    if (typeof row.id !== "string" || typeof row.body !== "string" ||
      !Number.isFinite(row.sort_time) || !Number.isFinite(row.updated_at)) return null;
    const packed = packSqlRow(row);
    // A highly compressible prefix must not inflate to an unbounded set of
    // strings during peek(). Charge at least one byte per UTF-16 code unit as
    // well as the codec's complete retained allocation/metadata. At the shared
    // 8 MiB cap, a complete peek contains at most 16 MiB of decoded body text.
    return packed === null ? null : { ...packed, bytes: Math.max(packed.bytes, row.body.length) };
  }
  private prefixBytes(key: string, fields: readonly string[] | undefined, rows: readonly PackedSqlRow<Row>[]): number | null {
    if (rows.length > 5000) return null;
    let bytes = this.metadataBytes(key, fields);
    if (rows.some(row => row.compressedBody !== undefined)) bytes += PACKED_SQL_ROW_SHARED_BYTES;
    for (const row of rows) {
      bytes += row.bytes;
      if (bytes > this.maxBytes) return null;
    }
    return bytes <= this.maxBytes ? bytes : null;
  }
  private peekKey(key: string, limit: number): readonly Row[] | undefined {
    const rows = this.peekKeyRows(key, limit);
    return rows === undefined ? undefined : [...rows];
  }
  private peekKeyRows(key: string, limit: number): IterableIterator<Row> | undefined {
    const cached = this.entries.get(key);
    if (cached === undefined || (cached.rows.length < limit && !cached.complete)) return undefined;
    this.entries.delete(key);
    this.entries.set(key, cached);
    // Capture the immutable packed prefix, so a fork/upsert/clear cannot alter
    // an already returned iterator. Nothing is decoded until its first next().
    return (function* () {
      // Preserve the array API's slice(0, limit) semantics as well as its usual
      // positive integer limits, without first allocating a sliced row array.
      const integer = Math.trunc(limit) || 0;
      const end = integer < 0 ? Math.max(0, cached.rows.length + integer) : Math.min(integer, cached.rows.length);
      for (let index = 0; index < end; index++) yield unpackSqlRow(cached.rows[index]!);
    })();
  }
  private reserveBuffer(current: number, desired: number): boolean {
    while (this.bytes + this.bufferBytes - current + desired > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return false;
      this.remove(oldest);
    }
    this.bufferBytes += desired - current;
    return true;
  }
  private store(key: string, entry: CandidatePrefix<Row>): void {
    if (!this.reserveBuffer(0, entry.bytes)) return;
    this.storeReserved(key, entry, entry.bytes);
  }
  private storeReserved(key: string, entry: CandidatePrefix<Row>, reserved: number): void {
    this.remove(key);
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    this.bufferBytes -= reserved;
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
  }
  private remove(key: string): void {
    const cached = this.entries.get(key);
    if (cached === undefined) return;
    this.bytes -= cached.bytes;
    this.entries.delete(key);
  }
}
