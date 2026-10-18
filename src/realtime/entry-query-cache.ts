function entryRowOrder(
  left: { sort_time: number; id?: string },
  right: { sort_time: number; id?: string },
): number {
  return right.sort_time - left.sort_time ||
    (left.id! < right.id! ? -1 : left.id! > right.id! ? 1 : 0);
}

/**
 * Bounded, per-object cache of complete descending entry query results.
 * Advancing the lower time bound can only remove a suffix, even with LIMIT.
 * Explicit frames and backwards-moving windows always execute SQL again.
 * Cache raw rows only: snapshot budgets and transformations still run each time.
 */
export class RealtimeEntryQueryCache<Row extends { sort_time: number; id?: string }> {
  private readonly entries = new Map<string, { lower: number; rows: Row[]; limit: number; bytes: number }>();
  private generation = 0;

  get ready(): boolean { return this.entries.size > 0; }

  fork(): RealtimeEntryQueryCache<Row> {
    const copy = new RealtimeEntryQueryCache<Row>();
    copy.generation = this.generation;
    // Every update replaces its array/map value; committed rows are immutable.
    for (const [key, value] of this.entries) copy.entries.set(key, value);
    return copy;
  }

  clear(): void {
    this.generation++;
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
    this.generation++;
    for (const [key, cached] of this.entries) {
      // The production canonical ids are ASCII ObjectIds. Fall back to SQLite
      // for unfamiliar ids rather than assume JS and SQLite collation agree.
      if (!/^[\x00-\x7f]+$/.test(id) || cached.rows.some((row) =>
        typeof row.id !== "string" || !/^[\x00-\x7f]+$/.test(row.id))) {
        this.entries.delete(key);
        continue;
      }
      const prior = cached.rows.find((row) => row.id === id);
      const oldLast = cached.rows.at(-1);
      const changed = resolve(key, cached.lower);
      if (changed === null || (changed !== undefined && changed.id !== id)) {
        this.entries.delete(key);
        continue;
      }
      if (prior !== undefined && cached.rows.length >= cached.limit &&
        (changed === undefined || !(changed.sort_time >= cached.lower) ||
          oldLast === undefined || entryRowOrder(changed, oldLast) > 0)) {
        // An unknown suffix can enter only if a selected row disappears or
        // moves behind the original last selected (time DESC, ASCII id ASC).
        // Use that original boundary even when the changed row was last.
        this.entries.delete(key);
        continue;
      }
      const rows = cached.rows.filter((row) => row.id !== id);
      let bytes = cached.bytes - (prior === undefined ? 0 : JSON.stringify(prior).length * 2);
      if (changed !== undefined && changed.sort_time >= cached.lower) {
        rows.push(structuredClone(changed));
        bytes += JSON.stringify(changed).length * 2;
      }
      rows.sort(entryRowOrder);
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
        if (row.sort_time >= lower) yield structuredClone(row);
      }
      return;
    }
    this.entries.delete(key);
    const generation = this.generation;
    const rows: Row[] = [];
    let bytes = 0;
    let cacheable = Number.isFinite(lower);
    let cursor: Iterator<Row> | undefined;
    let done = false;
    let pending: IteratorYieldResult<Row> | undefined;
    let failed = false;
    let deferredError: unknown;
    let throwing = false;
    try {
      cursor = load()[Symbol.iterator]();
      // Preserve complete raw SQL results independently of the consumer's
      // byte/node cutoff. Stop preloading at the existing 512 KiB boundary.
      while (cacheable && generation === this.generation) {
        try {
          const next = cursor.next();
          if (next.done) { done = true; break; }
          const rowBytes = JSON.stringify(next.value).length * 2;
          if (generation !== this.generation || bytes + rowBytes > 512 * 1024) {
            cacheable = false;
            pending = next;
            break;
          }
          let copy: Row;
          try { copy = structuredClone(next.value); }
          catch {
            cacheable = false;
            pending = next;
            break;
          }
          rows.push(copy);
          bytes += rowBytes;
        } catch (error) {
          // A budget break must not newly surface an error beyond the prefix
          // that the original streaming consumer would have requested.
          failed = true;
          deferredError = error;
          break;
        }
      }
      if (done && cacheable && !failed && generation === this.generation) {
        this.entries.set(key, { lower, rows, limit, bytes });
      }
      for (const row of rows) yield structuredClone(row);
      if (failed) throw deferredError;
      if (pending !== undefined) yield this.copyUncachedRow(pending.value);
      if (!done) {
        while (true) {
          const next = cursor.next();
          if (next.done) { done = true; break; }
          yield this.copyUncachedRow(next.value);
        }
      }
    } catch (error) {
      throwing = true;
      throw error;
    } finally {
      if (!done && cursor !== undefined) {
        try { cursor.return?.(); }
        catch (error) { if (!throwing) throw error; }
      }
    }
  }

  private copyUncachedRow(row: Row): Row {
    try { return structuredClone(row); }
    catch { return { ...row }; }
  }
}
