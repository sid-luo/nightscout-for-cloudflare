export interface CachedDeviceStatusRow {
  id: string;
  body: string;
  sort_time: number;
  updated_at: number;
}

const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_ROWS = 5000;

/** Bounded raw loader prefix. Public filtering and output budgets always rerun. */
export class DeviceStatusQueryCache<Row extends CachedDeviceStatusRow> {
  private cached: { lower: number; rows: Row[]; complete: boolean } | undefined;

  clear(): void { this.cached = undefined; }

  fork(): DeviceStatusQueryCache<Row> {
    const copy = new DeviceStatusQueryCache<Row>();
    // Updates replace arrays; the committed version remains untouched.
    copy.cached = this.cached;
    return copy;
  }

  get ready(): boolean { return this.cached !== undefined; }

  upsert(row: Row): void {
    if (this.cached === undefined) return;
    const { lower, complete } = this.cached;
    const boundary = this.cached.rows.at(-1);
    const rows = this.cached.rows.filter((item) => item.id !== row.id);
    if (row.sort_time >= lower) {
      // SQL deliberately leaves exact ties unspecified. Reload instead of
      // inventing a tie-breaker that could change output-budget selection.
      if (rows.some((item) => item.sort_time === row.sort_time && item.updated_at === row.updated_at)) {
        this.clear();
        return;
      }
      // A partial cache is a descending prefix. Never insert a historical
      // row behind its boundary: unseen rows might need to precede it.
      if (complete || (boundary !== undefined && (
        row.sort_time > boundary.sort_time
        || (row.sort_time === boundary.sort_time && row.updated_at > boundary.updated_at)
      ))) rows.push(row);
      rows.sort((a, b) => b.sort_time - a.sort_time || b.updated_at - a.updated_at);
    }
    if (rows.length > MAX_CACHE_ROWS || JSON.stringify(rows).length * 2 > MAX_CACHE_BYTES) {
      this.clear();
      return;
    }
    this.cached = { lower, rows, complete };
  }

  *read(lower: number, frame: boolean, load: () => Iterable<Row>): IterableIterator<Row> {
    if (frame) { yield* load(); return; }
    const cached = this.cached !== undefined && lower >= this.cached.lower ? this.cached : undefined;
    const source = function* (): IterableIterator<Row> {
      const seen = new Set<string>();
      if (cached !== undefined) {
        for (const row of cached.rows) {
          if (row.sort_time >= lower) { seen.add(row.id); yield row; }
        }
        if (cached.complete) return;
      }
      // If the consumer needs more than the cached prefix, continue from SQL.
      // Re-reading here is intentional: it preserves unspecified SQL tie order
      // and never mistakes an output-budget cutoff for the end of the data.
      for (const row of load()) if (!seen.has(row.id)) yield row;
    };
    const rows: Row[] = [];
    let bytes = 0, complete = false;
    try {
      for (const row of source()) {
        bytes += JSON.stringify(row).length * 2;
        if (bytes <= MAX_CACHE_BYTES && rows.length <= MAX_CACHE_ROWS) rows.push(row);
        yield row;
      }
      complete = true;
    } finally {
      this.cached = bytes <= MAX_CACHE_BYTES && rows.length <= MAX_CACHE_ROWS
        ? { lower, rows, complete } : undefined;
    }
  }
}
