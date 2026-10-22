import { SqliteDocumentRepository, type DocumentQuery } from "../document-repository";
import { isDurableObjectReadQuotaError } from "../platform-errors";

export interface Api3DeviceStatusRow extends Record<string, SqlStorageValue> {
  id: string;
  body: string;
}

export interface Api3DeviceStatusPlan {
  where: string;
  bindings: SqlStorageValue[];
  order: string;
  orderBindings: SqlStorageValue[];
  limit: number;
  skip: number;
}

export interface Api3DeviceStatusCacheReader<Row extends Api3DeviceStatusRow> {
  read(query: DocumentQuery, plan: Api3DeviceStatusPlan, load: () => Row[], sql?: () => SqlStorage): Row[];
}

interface NarrowingWindow { key: string; lower: string | number }
interface CachedQuery<Row> {
  query: DocumentQuery;
  plan: Api3DeviceStatusPlan;
  rows: Row[];
  window?: NarrowingWindow;
  bytes: number;
}

const CHECKPOINT_FORMAT = "nscf-api3-devicestatus-query:v1";
const QUERY_KEYS = ["filters", "sort", "limit", "skip", "includeDeleted", "legacyUuidHandling"] as const;
const ROW_KEYS = ["collection", "id", "body", "sort_time", "created_at", "updated_at", "identifier",
  "identifier_present", "srv_created", "srv_modified", "effective_modified", "is_valid", "fallback_key",
  "revision", "srv_metadata_version"];
const NUMBER_KEYS = ["sort_time", "created_at", "updated_at"];
const NULLABLE_NUMBER_KEYS = ["identifier_present", "srv_created", "srv_modified", "effective_modified",
  "is_valid", "revision", "srv_metadata_version"];
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
  && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function canonicalQuery(query: DocumentQuery): DocumentQuery {
  return structuredClone(Object.fromEntries(QUERY_KEYS.flatMap(key => query[key] === undefined ? [] : [[key, query[key]]]))) as DocumentQuery;
}

function checkpointRow(value: unknown): value is Api3DeviceStatusRow {
  if (!object(value) || Object.keys(value).length !== ROW_KEYS.length || Object.keys(value).some(key => !ROW_KEYS.includes(key))
    || value.collection !== "devicestatus" || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 512
    || typeof value.body !== "string" || !NUMBER_KEYS.every(key => typeof value[key] === "number" && Number.isFinite(value[key]))
    || !NULLABLE_NUMBER_KEYS.every(key => value[key] === null || typeof value[key] === "number" && Number.isFinite(value[key]))
    || !["identifier", "fallback_key"].every(key => value[key] === null || typeof value[key] === "string")) return false;
  try { return object(JSON.parse(value.body)); } catch { return false; }
}

/** Only a lower-bound increase proves that an already empty set stays empty. */
function narrowingWindow(query: DocumentQuery): NarrowingWindow | undefined {
  // Checkpoint restoration reconstructs the public query. Use one stable key
  // order for both live and restored plans, independent of caller key order.
  const normalized = canonicalQuery(query);
  const filters = normalized.filters;
  if (!Array.isArray(filters)) return undefined;
  const index = filters.findIndex(filter => (filter.operator === "gte" || filter.operator === "gt")
    && (filter.field === "created_at" || filter.field === "date")
    && (typeof filter.value === "string" && /^[\x00-\x7f]*$/.test(filter.value)
      || typeof filter.value === "number" && Number.isFinite(filter.value)));
  if (index < 0) return undefined;
  const lower = filters[index]!.value as string | number;
  // Keep predicate position, operator, value type and every residual parameter.
  // No parsing, scalar/array assumption or equality between date and sort_time.
  return { key: JSON.stringify({ ...normalized, filters: filters.map((filter, position) =>
    position === index ? { ...filter, value: { lowerBoundType: typeof lower } } : filter) }), lower };
}

/**
 * Disposable native-SQL result prefixes, never a capped substitute for history.
 * Changed rows are matched and ordered by the original SQLite expressions.
 * Values are immutable; transaction forks share values until replacement.
 */
export class Api3DeviceStatusQueryCache<Row extends Api3DeviceStatusRow = Api3DeviceStatusRow> {
  private readonly entries = new Map<string, CachedQuery<Row>>();
  private bytes = 0;
  private generation = 0;
  private checkpointGeneration = 0;

  get checkpointRevision(): number { return this.checkpointGeneration; }
  get ready(): boolean { return this.entries.size > 0; }

  constructor(
    private readonly maxEntries = 16,
    private readonly maxBytes = 4 * 1024 * 1024,
    private readonly maxEntryBytes = 1024 * 1024,
    private readonly maxRows = 128,
    private readonly maxMutationSourceRows = 256,
  ) {}

  fork(): Api3DeviceStatusQueryCache<Row> {
    const copy = new Api3DeviceStatusQueryCache<Row>(
      this.maxEntries, this.maxBytes, this.maxEntryBytes, this.maxRows, this.maxMutationSourceRows,
    );
    copy.bytes = this.bytes;
    copy.generation = this.generation;
    copy.checkpointGeneration = this.checkpointGeneration;
    for (const [key, value] of this.entries) copy.entries.set(key, value);
    return copy;
  }

  clear(): void {
    if (this.entries.size > 0) this.checkpointGeneration++;
    this.generation++;
    this.entries.clear();
    this.bytes = 0;
  }

  private key(plan: Api3DeviceStatusPlan): string { return JSON.stringify(plan); }

  private remember(key: string, plan: Api3DeviceStatusPlan, rows: Row[], query: DocumentQuery, window?: NarrowingWindow): void {
    if (rows.length > this.maxRows || this.maxEntries < 1) return;
    // Charge all retained strings, predicate/bindings, native ids and metadata;
    // there is no uncharged query-name or refusal ledger alongside this Map.
    const storedQuery = canonicalQuery(query);
    const bytes = 1024 + 2 * (key.length + JSON.stringify({ plan, rows, query: storedQuery, window }).length);
    if (bytes > this.maxEntryBytes || bytes > this.maxBytes) return;
    const previous = this.entries.get(key);
    if (previous !== undefined) { this.entries.delete(key); this.bytes -= previous.bytes; }
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest[0]); this.bytes -= oldest[1].bytes;
    }
    this.entries.set(key, { query: storedQuery, plan: structuredClone(plan), rows: structuredClone(rows),
      ...(window === undefined ? {} : { window }), bytes });
    this.bytes += bytes;
    this.checkpointGeneration++;
  }

  read(query: DocumentQuery, plan: Api3DeviceStatusPlan, load: () => Row[], sql?: () => SqlStorage): Row[] {
    const key = this.key(plan);
    const exact = this.entries.get(key);
    if (exact !== undefined) return structuredClone(exact.rows);
    const window = narrowingWindow(query);
    if (window !== undefined) {
      for (const cached of this.entries.values()) {
        if (cached.window?.key === window.key
          && typeof cached.window.lower === typeof window.lower && window.lower >= cached.window.lower) {
          if (cached.rows.length === 0) return [];
          if (sql === undefined || plan.skip !== 0 || plan.bindings.length + plan.orderBindings.length + 2 > 100) break;
          const statement = `SELECT * FROM (
            SELECT * FROM documents INDEXED BY sqlite_autoindex_documents_1 WHERE collection = 'devicestatus'
              AND id IN (SELECT value FROM json_each(?)) LIMIT -1
          ) WHERE ${plan.where} ORDER BY ${plan.order} LIMIT ? OFFSET 0`;
          if (new TextEncoder().encode(statement).byteLength > 100_000) break;
          try {
            const rows = sql().exec<Row>(statement, JSON.stringify(cached.rows.map(row => row.id)),
              ...plan.bindings, ...plan.orderBindings, plan.limit).toArray();
            // Narrowing cannot add a predecessor. A complete old result can
            // lose rows; a full prefix is sufficient only if every row survives.
            // Keep the broader persisted proof rather than saving each clock tick.
            if (rows.length === cached.rows.length || cached.rows.length < cached.plan.limit) return rows;
          } catch (error) {
            if (isDurableObjectReadQuotaError(error)) throw error;
          }
          // Charge at most one bounded prefix before the canonical fallback.
          break;
        }
      }
    }
    const generation = this.generation;
    const rows = load();
    if (generation === this.generation) this.remember(key, plan, rows, query, window);
    return rows;
  }

  snapshotCheckpoint(): unknown | undefined {
    // Retained accounting includes twice every UTF-16 code unit in rows and
    // query metadata. Even the 3-byte UTF-8 case stays below the controller's
    // 16 MiB decode ceiling; decline larger custom cache configurations before
    // allocating copies of all rows.
    if (this.entries.size === 0 || this.bytes > 8 * 1024 * 1024) return undefined;
    return { format: CHECKPOINT_FORMAT, entries: [...this.entries].map(([planKey, cached]) => ({
      query: structuredClone(cached.query), planKey, rows: structuredClone(cached.rows),
    })) };
  }

  /** Persisted SQL is an equality fingerprint only. Recompile every plan from
   * validated public query parameters; never execute SQL read from a snapshot.
   */
  restoreCheckpoint(value: unknown): boolean {
    try {
      if (!object(value) || value.format !== CHECKPOINT_FORMAT || Object.keys(value).length !== 2
        || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > this.maxEntries
        || JSON.stringify(value).length * 2 > this.maxBytes) return false;
      const candidate = new Api3DeviceStatusQueryCache<Row>(
        this.maxEntries, this.maxBytes, this.maxEntryBytes, this.maxRows, this.maxMutationSourceRows,
      );
      for (const entry of value.entries) {
        if (!object(entry) || Object.keys(entry).length !== 3 || !object(entry.query)
          || Object.keys(entry.query).some(key => !(QUERY_KEYS as readonly string[]).includes(key))
          || typeof entry.planKey !== "string" || !Array.isArray(entry.rows) || entry.rows.length > this.maxRows
          || !entry.rows.every(checkpointRow) || new Set(entry.rows.map(row => row.id)).size !== entry.rows.length) return false;
        const query = entry.query as DocumentQuery;
        const plan = SqliteDocumentRepository.compileApi3DeviceStatusPlan(query);
        const key = candidate.key(plan);
        if (key !== entry.planKey || entry.rows.length > plan.limit || candidate.entries.has(key)) return false;
        candidate.remember(key, plan, entry.rows as Row[], query, narrowingWindow(query));
      }
      if (candidate.entries.size !== value.entries.length) return false;
      this.clear();
      for (const [key, cached] of candidate.entries) this.entries.set(key, cached);
      this.bytes = candidate.bytes;
      this.checkpointGeneration++;
      return true;
    } catch { return false; }
  }

  /**
   * Clear before any canonical DML, including callbacks which might read
   * uncommitted state. The owning mutation wrapper restores the committed
   * cache if its transaction fails. Deletes/unknown paths simply clear.
   */
  beforeMutation(sql: SqlStorage, id: string, previousBody?: string, nextBody?: string): () => void {
    const previous = [...this.entries];
    this.clear();
    const generation = this.generation;
    return () => {
      if (nextBody === undefined || generation !== this.generation) return;
      let remaining = this.maxMutationSourceRows;
      try {
        for (const [key, cached] of previous) {
          const { plan } = cached;
          // OFFSET hides predecessors. Likewise an updated selected row from a
          // full prefix could let an unknown suffix enter. Re-read SQL later.
          if (plan.skip !== 0 || previousBody !== undefined && cached.rows.length >= plan.limit
            && cached.rows.some(row => row.id === id)) continue;
          if (remaining < 1 || plan.bindings.length + plan.orderBindings.length + 3 > 100) continue;
          remaining--;
          const pointSql = `SELECT * FROM (
            SELECT * FROM documents INDEXED BY sqlite_autoindex_documents_1
            WHERE collection = 'devicestatus' AND id = ? LIMIT -1
          ) WHERE ${plan.where} ORDER BY ${plan.order} LIMIT 1`;
          const rankedSql = `SELECT * FROM (
            SELECT * FROM documents INDEXED BY sqlite_autoindex_documents_1 WHERE collection = 'devicestatus'
              AND id IN (SELECT value FROM json_each(?)) LIMIT -1
          ) WHERE ${plan.where} ORDER BY ${plan.order} LIMIT ? OFFSET 0`;
          if (new TextEncoder().encode(pointSql).byteLength > 100_000
            || new TextEncoder().encode(rankedSql).byteLength > 100_000) continue;
          const point = sql.exec<Row>(pointSql,
          id, ...plan.bindings, ...plan.orderBindings).toArray();
          let rows = cached.rows;
          if (point.length > 0 || rows.some(row => row.id === id)) {
            const ids = [...new Set([...rows.map(row => row.id), id])];
            if (ids.length > remaining || ids.length > this.maxRows + 1) continue;
            remaining -= ids.length;
            // LIMIT -1 prevents flattening. This source is at most the charged
            // selected ids plus the changed PK, not a planner-chosen history scan.
            rows = sql.exec<Row>(rankedSql,
            JSON.stringify(ids), ...plan.bindings, ...plan.orderBindings, plan.limit).toArray();
          }
          this.remember(key, plan, rows, cached.query, cached.window);
        }
      } catch (error) {
        // Only these optional SELECTs are caught. Canonical DML and caller
        // transaction errors stay outside this boundary. A native expression
        // limit must cost a cache miss, not reject an otherwise valid upload.
        this.clear();
        if (isDurableObjectReadQuotaError(error)) throw error;
      }
    };
  }
}
