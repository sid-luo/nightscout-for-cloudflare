import { packSqlRow, unpackSqlRow, PACKED_SQL_ROW_SHARED_BYTES, type PackedSqlRow } from "./raw-row-codec";

export interface BoundedWindowRow {
  id: string;
  sort_time: number;
}

interface CachedWindow<Row> {
  rows: readonly PackedSqlRow<Row>[];
  lower: number;
  upper: number;
  lastLower: number;
  lastUpper: number;
  nextFuture: number;
  bytes: number;
}

interface WindowCacheLimits {
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
}

const MAX_ENTRIES = 32;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024;
const ENTRY_METADATA_BYTES = 256;

function boundedMaximum(value: number | undefined, maximum: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(0, Math.min(maximum, Math.trunc(value))) : maximum;
}

/**
 * Complete raw latest-N SQL windows only. The caller must include every fixed
 * predicate/order/limit in key, load an inclusive sort_time window, and clear
 * after every write, delete or rollback. nextFuture is the earliest excluded
 * sort_time above upper (or Infinity); an earlier global future row is safe.
 *
 * A rising lower bound only removes an old suffix of a DESC latest-N result.
 * Its presentation may be ASC, but an ASC LIMIT prefix must not use this cache.
 */
export class BoundedWindowQueryCache<Row extends BoundedWindowRow> {
  private readonly entries = new Map<string, CachedWindow<Row>>();
  private bytes = 0;
  private bufferBytes = 0;
  private generation = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;

  constructor(limits: WindowCacheLimits = {}) {
    this.maxEntries = boundedMaximum(limits.maxEntries, MAX_ENTRIES);
    this.maxBytes = boundedMaximum(limits.maxBytes, MAX_BYTES);
    this.maxEntryBytes = boundedMaximum(limits.maxEntryBytes, MAX_ENTRY_BYTES);
  }

  clear(): void {
    this.generation++;
    this.entries.clear();
    this.bytes = 0;
  }

  *read(
    key: string,
    lower: number,
    upper: number,
    load: () => Iterable<Row>,
    nextFuture: () => number,
  ): IterableIterator<Row> {
    const cached = this.entries.get(key);
    if (cached !== undefined && lower >= cached.lower && upper >= cached.upper
      && lower >= cached.lastLower && upper >= cached.lastUpper && upper < cached.nextFuture) {
      this.entries.delete(key);
      this.entries.set(key, { ...cached, lastLower: lower, lastUpper: upper });
      for (const packed of cached.rows) {
        if (packed.row.sort_time >= lower) yield unpackSqlRow(packed);
      }
      return;
    }
    this.remove(key);
    const generation = this.generation;
    let bytes = ENTRY_METADATA_BYTES + 2 * key.length;
    let cacheable = this.maxEntries > 0 && bytes <= this.maxEntryBytes && bytes <= this.maxBytes
      && !Number.isNaN(lower) && !Number.isNaN(upper) && lower <= upper;
    let rows: PackedSqlRow<Row>[] = [];
    let sharedBytes = 0;
    let reserved = 0;
    let cursor: Iterator<Row> | undefined;
    let done = false;
    let pending: IteratorYieldResult<Row> | undefined;
    let failed = false;
    let deferredError: unknown;
    let throwing = false;
    try {
      if (cacheable) {
        cacheable = this.reserveBuffer(0, bytes);
        if (cacheable) reserved = bytes;
      }
      cursor = load()[Symbol.iterator]();
      // A bounded raw cursor may reach EOF before an output budget accepts
      // all its rows. Admit only that complete raw result, independently of
      // the caller's byte/node cutoff; never retain an incomplete SQL prefix.
      while (cacheable && generation === this.generation) {
        try {
          const next = cursor.next();
          if (next.done) { done = true; break; }
          const packed = Number.isFinite(next.value.sort_time) ? packSqlRow(next.value) : null;
          const rowBytes = packed?.bytes ?? null;
          const newSharedBytes = packed?.compressedBody !== undefined && sharedBytes === 0
            ? PACKED_SQL_ROW_SHARED_BYTES : 0;
          if (generation !== this.generation || rowBytes === null ||
            bytes + rowBytes + newSharedBytes > this.maxEntryBytes || !this.reserveBuffer(reserved, bytes + rowBytes + newSharedBytes)) {
            cacheable = false;
            pending = next;
            break;
          }
          bytes += rowBytes + newSharedBytes;
          sharedBytes += newSharedBytes;
          reserved = bytes;
          rows.push(packed!);
        } catch (error) {
          // Read-ahead must not expose a tail failure to a consumer whose
          // output budget would have stopped before that failing next().
          failed = true;
          deferredError = error;
          break;
        }
      }
      if (done && !failed && cacheable && generation === this.generation) {
        try {
          const future = nextFuture();
          if (generation === this.generation && !Number.isNaN(future) && future > upper &&
            this.reserveBuffer(reserved, bytes)) {
            while (this.entries.size >= this.maxEntries) {
              const oldest = this.entries.keys().next().value;
              if (oldest === undefined) break;
              this.remove(oldest);
            }
            this.remove(key);
            this.bufferBytes -= reserved;
            reserved = 0;
            this.entries.set(key, { rows, lower, upper, lastLower: lower, lastUpper: upper, nextFuture: future, bytes });
            this.bytes += bytes;
          }
        } catch (error) {
          // A probe previously ran only when the consumer requested EOF.
          // Preserve that observable error boundary despite raw preloading.
          failed = true;
          deferredError = error;
        }
      }
      for (const packed of rows) yield unpackSqlRow(packed);
      rows = [];
      this.bufferBytes -= reserved;
      reserved = 0;
      if (failed) throw deferredError;
      if (pending !== undefined) yield { ...pending.value };
      if (!done) {
        while (true) {
          const next = cursor.next();
          if (next.done) { done = true; break; }
          yield { ...next.value };
        }
      }
    } catch (error) {
      throwing = true;
      throw error;
    } finally {
      this.bufferBytes -= reserved;
      if (!done && cursor !== undefined) {
        try { cursor.return?.(); }
        catch (error) { if (!throwing) throw error; }
      }
    }
  }

  /** Count unfinished miss buffers against retained-entry bytes while collecting. */
  private reserveBuffer(current: number, desired: number): boolean {
    while (this.bytes + this.bufferBytes - current + desired > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return false;
      this.remove(oldest);
    }
    this.bufferBytes += desired - current;
    return true;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

}
