import type { LegacyReadCache } from "./legacy-read-cache";

export const TREATMENT_ORDER_SOURCE_KEY = "\0treatment-order-source:v1";
const BOUNDED_SOURCE_PREFIX = "\0treatment-order-bounded-source:v1:";
const LEARNING_PREFIX = "\0treatment-order-learning:v1:";
const MAX_SOURCE_ROWS = 5_000;
const PENDING = "pending";
const REJECTED = "rejected";
// A fallback refusal must fit whenever the pending marker fit the same key.
const SHORT_REJECTED = "reject";
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const fitsSql = (statement: string, bindings: SqlStorageValue[]): boolean => bindings.length <= 100
  && new TextEncoder().encode(statement).byteLength <= 100_000;

/** The repository proves the indexed source is a complete necessary superset. */
export interface TreatmentOrderReadSource {
  probeStatement: string;
  probeBindings: SqlStorageValue[];
  /** Full original residual/order over that same indexed source, with page binds last. */
  buildStatement: string;
  buildBindings: SqlStorageValue[];
}

/** Complete native order only; pagination never compares document values in JS. */
export class TreatmentOrderReadView {
  constructor(
    private readonly sql: SqlStorage,
    private readonly cache: LegacyReadCache,
    private readonly minExpensivePages = 1,
  ) {}

  key(statement: string, bindings: SqlStorageValue[]): string {
    return "\0treatment-order:v1:" + JSON.stringify([statement, bindings.slice(0, -2)]);
  }

  private reject(key: string): void {
    if (!this.cache.set(key, REJECTED)) this.cache.set(key, SHORT_REJECTED);
  }

  /** Reuse an already successful native page only when it proves complete EOF. */
  observeCompleteRead(
    key: string,
    rows: readonly { id: SqlStorageValue }[],
    limit: number,
    skip: number,
    generation: number,
  ): boolean {
    if (generation !== this.cache.generation || skip !== 0 || !Number.isSafeInteger(limit) || limit <= 0
      || rows.length >= limit || rows.length > MAX_SOURCE_ROWS) return false;
    const ids: string[] = [];
    const unique = new Set<string>();
    for (const row of rows) {
      const id = row.id;
      if (typeof id !== "string" || !SAFE_ID.test(id) || unique.has(id)) return false;
      unique.add(id);
      ids.push(id);
    }
    if (generation !== this.cache.generation) return false;
    const value = JSON.stringify(ids);
    if (this.cache.set(key, value)) return true;
    this.reject(key);
    return false;
  }

  noteExpensiveRead(key: string, rowsRead: number, pageKey?: string): void {
    if (!(rowsRead > 512) || this.cache.get(key) !== undefined) return;
    const needed = Number.isSafeInteger(this.minExpensivePages)
      ? Math.max(1, Math.min(8, this.minExpensivePages)) : 1;
    if (needed === 1) { this.cache.set(key, PENDING); return; }
    const learningKey = LEARNING_PREFIX + key;
    const stored = this.cache.get(learningKey);
    const pages = stored === undefined ? [] : JSON.parse(stored) as string[];
    const page = pageKey ?? "";
    if (pages.includes(page)) return;
    pages.push(page);
    if (pages.length >= needed) this.cache.set(key, PENDING);
    else this.cache.set(learningKey, JSON.stringify(pages));
  }

  private sourceFits(source?: TreatmentOrderReadSource): boolean {
    const key = source === undefined ? TREATMENT_ORDER_SOURCE_KEY
      : BOUNDED_SOURCE_PREFIX + JSON.stringify([source.probeStatement, source.probeBindings]);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      const count = Number(cached);
      return Number.isSafeInteger(count) && count >= 0 && count <= MAX_SOURCE_ROWS && String(count) === cached;
    }
    const generation = this.cache.generation;
    // Bound source rows, rather than matching output. A rare/missing predicate
    // may otherwise scan millions of rows before returning its 5001st match.
    const count = source === undefined ? this.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM (
      SELECT 1 FROM documents WHERE collection = 'treatments' LIMIT 5001
    )`).one().count : this.sql.exec<{ count: number }>(source.probeStatement, ...source.probeBindings).one().count;
    if (generation !== this.cache.generation) return false;
    if (!Number.isSafeInteger(count) || count < 0) return false;
    this.cache.set(key, count > MAX_SOURCE_ROWS ? REJECTED : String(count));
    return count <= MAX_SOURCE_ROWS;
  }

  read<Row extends Record<string, SqlStorageValue>>(
    key: string,
    statement: string,
    bindings: SqlStorageValue[],
    limit: number,
    skip: number,
    source?: TreatmentOrderReadSource,
    buildPending = true,
  ): Row[] | undefined {
    let cached = this.cache.get(key);
    if (cached === undefined || cached === REJECTED || cached === SHORT_REJECTED) return undefined;
    if (cached === PENDING && !buildPending) return undefined;
    const generation = this.cache.generation;
    if (cached === PENDING) {
      if (source !== undefined && (!fitsSql(source.probeStatement, source.probeBindings)
        || !fitsSql(source.buildStatement, source.buildBindings) || source.buildBindings.length < 2
        || !/^SELECT \*/.test(source.buildStatement))) {
        this.reject(key);
        return undefined;
      }
      if (!this.sourceFits(source)) {
        if (generation === this.cache.generation) this.reject(key);
        return undefined;
      }
      const buildStatement = source?.buildStatement ?? statement;
      const buildBindings = source?.buildBindings ?? bindings;
      const cursor = this.sql.exec<{ id: string }>(buildStatement.replace(/^SELECT \*/, "SELECT id"),
        ...buildBindings.slice(0, -2), MAX_SOURCE_ROWS + 1, 0)[Symbol.iterator]();
      const ids: string[] = [];
      let complete = false;
      let rejected = false;
      let throwing = false;
      try {
        while (true) {
          const next = cursor.next();
          if (next.done) { complete = true; break; }
          if (ids.length >= MAX_SOURCE_ROWS || !SAFE_ID.test(next.value.id)) { rejected = true; break; }
          ids.push(next.value.id);
        }
      } catch (error) { throwing = true; throw error; }
      finally {
        if (!complete) {
          try { cursor.return?.(); }
          catch (error) { if (!throwing) throw error; }
        }
      }
      if (generation !== this.cache.generation) return undefined;
      cached = rejected ? REJECTED : JSON.stringify(ids);
      if (!this.cache.set(key, cached)) {
        if (generation !== this.cache.generation) return undefined;
        this.reject(key);
        // Complete safe IDs remain usable for this request even when the
        // shared entry budget cannot retain them. Do not repeat the full SQL.
      }
      if (rejected) return undefined;
    }
    const ids = (JSON.parse(cached) as string[]).slice(skip, skip + limit);
    if (ids.length === 0) return [];
    // CROSS JOIN fixes the loop order to a bounded page of canonical PK seeks.
    // json_each.key supplies the already-proven native ordinal, including ties.
    const rows = this.sql.exec<Row>(`SELECT documents.* FROM json_each(?) AS page
      CROSS JOIN documents ON documents.collection = 'treatments' AND documents.id = page.value
      ORDER BY CAST(page.key AS INTEGER)`, JSON.stringify(ids)).toArray();
    return generation === this.cache.generation ? rows : undefined;
  }
}
