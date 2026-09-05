/**
 * Bounded, per-object cache of complete descending entry query results.
 * Advancing the lower time bound can only remove a suffix, even with LIMIT.
 * Explicit frames and backwards-moving windows always execute SQL again.
 * Cache raw rows only: snapshot budgets and transformations still run each time.
 */
export class RealtimeEntryQueryCache<Row extends { sort_time: number }> {
  private readonly entries = new Map<string, { lower: number; rows: Row[] }>();

  clear(): void {
    this.entries.clear();
  }

  *read(
    key: string,
    lower: number,
    frame: boolean,
    load: () => Iterable<Row>,
  ): IterableIterator<Row> {
    if (frame) {
      yield* load();
      return;
    }
    const cached = this.entries.get(key);
    if (cached !== undefined && lower >= cached.lower) {
      for (const row of cached.rows) {
        if (row.sort_time >= lower) yield row;
      }
      return;
    }
    this.entries.delete(key);
    const rows: Row[] = [];
    let bytes = 0;
    for (const row of load()) {
      bytes += JSON.stringify(row).length * 2;
      if (bytes <= 512 * 1024) rows.push(row);
      yield row;
    }
    // Reaching here proves the consumer exhausted the cursor. A snapshot that
    // stops for its output budget must never cache an incomplete result set.
    if (bytes <= 512 * 1024) this.entries.set(key, { lower, rows });
  }
}
