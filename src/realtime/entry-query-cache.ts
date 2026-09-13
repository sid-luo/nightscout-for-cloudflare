/**
 * Bounded, per-object cache of complete descending entry query results.
 * Advancing the lower time bound can only remove a suffix, even with LIMIT.
 * Explicit frames and backwards-moving windows always execute SQL again.
 * Cache raw rows only: snapshot budgets and transformations still run each time.
 */
export class RealtimeEntryQueryCache<Row extends { sort_time: number; id?: string }> {
  private readonly entries = new Map<string, { lower: number; rows: Row[]; limit: number; bytes: number }>();

  get ready(): boolean { return this.entries.size > 0; }

  fork(): RealtimeEntryQueryCache<Row> {
    const copy = new RealtimeEntryQueryCache<Row>();
    // Every update replaces its array/map value; committed rows are immutable.
    for (const [key, value] of this.entries) copy.entries.set(key, value);
    return copy;
  }

  clear(): void {
    this.entries.clear();
  }

  /**
   * Read a smaller prefix of an already complete query without filling or
   * narrowing its cache. The key must be the exact original SQL query: callers
   * may share its projection/predicate/order, never infer equivalent queries.
   */
  peek(key: string, lower: number, count: number): Row[] | undefined {
    const cached = this.entries.get(key);
    if (cached === undefined || !Number.isFinite(lower) || lower < cached.lower ||
      !Number.isInteger(count) || count < 1 || count > cached.limit) return undefined;
    // An advancing lower bound removes only an older suffix, including any
    // rows hidden behind the original SQL LIMIT. Fewer surviving rows are a
    // complete answer for this window, not a reason to widen the query.
    return structuredClone(cached.rows.filter((row) => row.sort_time >= lower).slice(0, count));
  }

  /** Resolve a canonical changed row using each original query's SQL predicate. */
  upsert(id: string, resolve: (key: string, lower: number) => Row | undefined | null): void {
    for (const [key, cached] of this.entries) {
      // The production canonical ids are ASCII ObjectIds. Fall back to SQLite
      // for unfamiliar ids rather than assume JS and SQLite collation agree.
      if (!/^[\x00-\x7f]+$/.test(id) || cached.rows.some((row) =>
        typeof row.id !== "string" || !/^[\x00-\x7f]+$/.test(row.id))) {
        this.entries.delete(key);
        continue;
      }
      const prior = cached.rows.find((row) => row.id === id);
      if (prior !== undefined && cached.rows.length >= cached.limit) {
        // A LIMIT-complete cursor can still hide an older suffix. Replacing a
        // selected row may expose it; do not invent the next matching row.
        this.entries.delete(key);
        continue;
      }
      const changed = resolve(key, cached.lower);
      if (changed === null || (changed !== undefined && changed.id !== id)) {
        this.entries.delete(key);
        continue;
      }
      const rows = cached.rows.filter((row) => row.id !== id);
      let bytes = cached.bytes - (prior === undefined ? 0 : JSON.stringify(prior).length * 2);
      if (changed !== undefined && changed.sort_time >= cached.lower) {
        rows.push(changed);
        bytes += JSON.stringify(changed).length * 2;
      }
      rows.sort((left, right) => right.sort_time - left.sort_time ||
        (left.id! < right.id! ? -1 : left.id! > right.id! ? 1 : 0));
      while (rows.length > cached.limit) bytes -= JSON.stringify(rows.pop()!).length * 2;
      if (bytes > 512 * 1024) this.entries.delete(key);
      else this.entries.set(key, { ...cached, rows, bytes });
    }
  }

  *read(
    key: string,
    lower: number,
    frame: boolean,
    load: () => Iterable<Row>,
    limit = Number.POSITIVE_INFINITY,
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
    if (bytes <= 512 * 1024) this.entries.set(key, { lower, rows, limit, bytes });
  }
}
