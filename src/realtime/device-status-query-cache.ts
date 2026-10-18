import { packSqlRow, unpackSqlRow, type PackedSqlRow } from "./raw-row-codec";

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
  rows.reduce((sum, row) => sum + row.bytes, 0);

/** Lossless bounded loader prefixes; filtering and output budgets always rerun. */
export class DeviceStatusQueryCache<Row extends CachedDeviceStatusRow> {
  private cached: Prefix<Row> | undefined;
  private generation = 0;

  clear(): void { this.generation++; this.cached = undefined; }
  fork(): DeviceStatusQueryCache<Row> {
    const copy = new DeviceStatusQueryCache<Row>();
    copy.cached = this.cached;
    copy.generation = this.generation;
    return copy;
  }
  get ready(): boolean { return this.cached !== undefined; }

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
        const packed = packSqlRow(row, false);
        if (packed === null) { this.clear(); return; }
        rows.push(packed);
      }
      rows.sort((a, b) => b.row.sort_time - a.row.sort_time || b.row.updated_at - a.row.updated_at);
    }
    const bytes = prefixBytes(rows);
    if (rows.length > MAX_CACHE_ROWS || bytes > MAX_CACHE_BYTES) { this.clear(); return; }
    this.cached = { lower, rows, complete, bytes };
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
      let canExtend = true;
      let done = false;
      let cursor: Iterator<Row> | undefined;
      let throwing = false;
      try {
        cursor = load()[Symbol.iterator]();
        while (true) {
          const next = cursor.next();
          if (next.done) { done = true; break; }
          const row = next.value;
          if (seen.has(row.id)) continue;
          const packed = canExtend && Number.isFinite(row.sort_time) && Number.isFinite(row.updated_at)
            ? packSqlRow(row, false) : null;
          if (packed === null || extended.length >= MAX_CACHE_ROWS || bytes + packed.bytes > MAX_CACHE_BYTES) {
            canExtend = false;
          } else {
            extended.push(packed); bytes += packed.bytes;
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
        if (done && canExtend && generation === this.generation) this.cached = { lower, rows: extended, complete: true, bytes };
      }
      return;
    }
    this.cached = undefined;
    const rows: PackedSqlRow<Row>[] = [];
    let bytes = 0;
    let cursor: Iterator<Row> | undefined;
    let done = false;
    let pending: IteratorYieldResult<Row> | undefined;
    let failed = false;
    let deferredError: unknown;
    let throwing = false;
    try {
      cursor = load()[Symbol.iterator]();
      // Complete bounded EOF is independent of the consumer's output cutoff.
      while (generation === this.generation) {
        try {
          const next = cursor.next();
          if (next.done) { done = true; break; }
          const packed = Number.isFinite(next.value.sort_time) && Number.isFinite(next.value.updated_at)
            ? packSqlRow(next.value, false) : null;
          if (packed === null || rows.length >= MAX_CACHE_ROWS || bytes + packed.bytes > MAX_CACHE_BYTES) {
            pending = next; break;
          }
          rows.push(packed); bytes += packed.bytes;
        } catch (error) { failed = true; deferredError = error; break; }
      }
      if (!failed && generation === this.generation && (done || rows.length > 0)) {
        this.cached = { lower, rows, complete: done, bytes };
      }
      for (const packed of rows) yield unpackSqlRow(packed);
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
