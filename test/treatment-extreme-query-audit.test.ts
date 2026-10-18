import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import type { JsonDocument, JsonValue } from "../src/entry-store";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const ORDER = "sort_time DESC,srv_modified DESC,id ASC";
const RAW_ORDER = "json_extract(body, '$.created_at') DESC,id ASC";
const CATEGORY = `((json_type(body, '$.eventType') = 'text' AND json_extract(body, '$.eventType') = ?)
  OR (json_type(body, '$.eventType') = 'array' AND EXISTS (
    SELECT 1 FROM json_each(body, '$.eventType') item WHERE item.type = 'text' AND item.value = ?)))`;
const CATEGORY_NULL = `((NOT (json_type(body, '$.eventType') IS NOT NULL) OR json_type(body, '$.eventType') = 'null')
  OR (json_type(body, '$.eventType') = 'array' AND EXISTS (
    SELECT 1 FROM json_each(body, '$.eventType') item WHERE item.type = 'null')))`;
type Mode = "all-valid-modified" | "mixed-validity-modified" | "mixed-validity-exact-tuple" | "many-validity" | "dense-arrays";
interface Audit {
  name: string; query: DocumentQuery; policy?: "api3" | "legacy";
  where?: string; bindings?: SqlStorageValue[]; order?: string;
}
interface RawRow extends Record<string, SqlStorageValue> { id: string; body: string }

function seed(sql: SqlStorage, mode: Mode): void {
  // Reproduce the existing two-read-index store, or the new optional API3
  // index's deferred case, independently of future constructor migrations.
  sql.exec("DROP INDEX IF EXISTS documents_treatments_api3_order");
  sql.exec(`WITH RECURSIVE sequence(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM sequence WHERE n < 4999),
    prepared AS (SELECT n, CASE WHEN ? = 'all-valid-modified' THEN 1
      WHEN ? = 'many-validity' THEN CASE WHEN n % 43 = 0 THEN NULL ELSE (n % 21) - 10 END
      WHEN n % 5 = 0 THEN 0 WHEN n % 5 = 1 THEN 1 WHEN n % 5 = 2 THEN 2 WHEN n % 5 = 3 THEN -1 ELSE NULL END AS valid,
      CASE WHEN n % 37 = 0 THEN NULL WHEN ? = 'mixed-validity-exact-tuple' THEN ? ELSE ? + n END AS modified
    FROM sequence)
    INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,
      identifier_present,srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
    SELECT 'treatments',printf('%024x',n),json_object('_id',printf('%024x',n),'identifier','extreme-'||n,
      'created_at',json(CASE n % 7 WHEN 0 THEN 'null' WHEN 1 THEN '7' WHEN 2 THEN 'true'
        WHEN 3 THEN '"2026-01-01T00:00:00.000Z"' WHEN 4 THEN '["z",null]' WHEN 5 THEN '{"date":"x"}' ELSE '"007"' END),
      'eventType',json(CASE WHEN ? = 'dense-arrays' AND n % 9 != 0
        THEN '["Note","Other","Note","07",7,["Absent"],{"kind":"Absent"}]' ELSE '"Note"' END),
      'rank',json(CASE n % 7 WHEN 0 THEN 'null' WHEN 1 THEN '1' WHEN 2 THEN '"1"' WHEN 3 THEN 'true'
        WHEN 4 THEN '"abc"' WHEN 5 THEN '[1]' ELSE '{"x":1}' END),
      'srvCreated',?,'srvModified',modified,'isValid',valid),
      ?,?,?, 'extreme-'||n,1,?,modified,modified,valid,1,1 FROM prepared`,
  mode, mode, mode, AT, AT, mode, AT, AT, AT, AT, AT);
}

function originalSql(audit: Audit) {
  const legacy = audit.policy === "legacy";
  return { statement: `SELECT * FROM documents WHERE collection = ?
    ${legacy ? "AND collection IN ('treatments','devicestatus') AND json_valid(body)" : audit.query.includeDeleted === true ? "" : "AND is_valid != 0"}
    ${audit.where === undefined ? "" : `AND ${audit.where}`}
    ORDER BY ${audit.order ?? (legacy ? RAW_ORDER : ORDER)} LIMIT ? OFFSET ?`,
  bindings: ["treatments", ...(audit.bindings ?? []), audit.query.limit ?? 1000, audit.query.skip ?? 0] as SqlStorageValue[] };
}

function materialize(rows: RawRow[], audit: Audit): JsonDocument[] {
  return rows.map(row => {
    const document = JSON.parse(row.body) as JsonDocument;
    if (audit.policy === "legacy") document._id = row.id;
    else {
      delete document._id;
      if (!document.identifier) document.identifier = row.id;
      if (!document.srvModified) {
        const value = document.created_at;
        const date = typeof value === "number" ? Math.trunc(value) : typeof value === "string" ? Date.parse(value) : NaN;
        if (Number.isFinite(date)) document.srvModified = date;
      }
      if (document.srvModified && !document.srvCreated) document.srvCreated = document.srvModified;
    }
    return document;
  });
}

function executeOriginal(sql: SqlStorage, audit: Audit): JsonDocument[] {
  const query = originalSql(audit);
  return materialize(sql.exec<RawRow>(query.statement, ...query.bindings).toArray(), audit);
}

function measured<T>(sql: SqlStorage, read: () => T) {
  const execute = sql.exec.bind(sql);
  const queries: { statement: string; bindings: SqlStorageValue[]; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = execute(statement, ...bindings); queries.push({ statement, bindings, cursor }); return cursor;
  });
  try {
    const result = read();
    return { result, reads: queries.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: queries.reduce((sum, item) => sum + item.cursor.rowsWritten, 0), calls: queries.length,
      plans: queries.filter(item => /^SELECT\b/.test(item.statement)).flatMap(item => execute<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${item.statement}`, ...item.bindings).toArray().map(row => row.detail)) };
  } finally { spy.mockRestore(); }
}

function fits(statement: string, bindings: SqlStorageValue[]): boolean {
  return bindings.length <= 100 && new TextEncoder().encode(statement).byteLength <= 100_000;
}

/** Test-only zero-write candidate, deliberately bounded and never an authority. */
function bucketCandidate(sql: SqlStorage, audit: Audit) {
  const original = originalSql(audit);
  if (!fits(original.statement, original.bindings)) throw new Error("original query exceeds limits");
  const fallback = (reason: string, buckets: number[] = []) => ({ documents: executeOriginal(sql, audit), reason, buckets });
  const prefix = (audit.query.limit ?? 1000) + (audit.query.skip ?? 0);
  if (audit.policy === "legacy" || audit.query.sort !== undefined || audit.query.includeDeleted === true) return fallback("unsupported-order-or-deleted");
  if (!Number.isSafeInteger(prefix) || prefix > 64) return fallback("deep-page");
  const predicate = original.statement.slice(original.statement.indexOf("WHERE ") + 6, original.statement.indexOf("ORDER BY "));
  const values = original.bindings.slice(0, -2);
  const branch = `SELECT * FROM (SELECT * FROM documents INDEXED BY documents_collection_valid_sort
    WHERE ${predicate} AND is_valid = ? ORDER BY ${ORDER} LIMIT ?)`;
  const build = (buckets: number[]) => ({ statement: `SELECT * FROM (${buckets.map(() => branch).join(" UNION ALL ")})
    ORDER BY ${ORDER} LIMIT ? OFFSET ?`, bindings: [...buckets.flatMap(bucket => [...values, bucket, prefix]),
      audit.query.limit ?? 1000, audit.query.skip ?? 0] as SqlStorageValue[] });
  const minimum = build([1]);
  if (!fits(minimum.statement, minimum.bindings)) return fallback("expanded-query");
  const buckets: number[] = [];
  // Separate strict ranges skip an arbitrarily large zero/NULL bucket. A
  // single `!=0 AND > prior` walk would scan every zero when crossing -1→1.
  for (const negative of [true, false]) {
    let prior: number | undefined;
    for (let visited = 0; visited <= 8; visited++) {
      const next = sql.exec<{ is_valid: SqlStorageValue }>(`SELECT is_valid FROM documents
        INDEXED BY documents_collection_valid_sort WHERE collection = 'treatments'
        AND is_valid ${negative ? "<" : ">"} 0 AND is_valid IS NOT NULL
        ${prior === undefined ? "" : "AND is_valid > ?"} ORDER BY is_valid ASC LIMIT 1`,
      ...(prior === undefined ? [] : [prior])).toArray()[0];
      if (next === undefined) break;
      if (typeof next.is_valid !== "number" || !Number.isFinite(next.is_valid)) return fallback("unsafe-validity-key", buckets);
      if (buckets.length === 8) return fallback("too-many-validity-buckets", buckets);
      buckets.push(next.is_valid);
      prior = next.is_valid;
    }
  }
  if (buckets.length === 0) return { documents: [], reason: "complete-empty", buckets };
  const merged = build(buckets);
  if (!fits(merged.statement, merged.bindings)) return fallback("expanded-query", buckets);
  return { documents: materialize(sql.exec<RawRow>(merged.statement, ...merged.bindings).toArray(), audit),
    reason: "complete-bucket-merge", buckets };
}

function combine(parts: string[]): string {
  if (parts.length === 1) return parts[0]!;
  const middle = Math.floor(parts.length / 2);
  return `(${combine(parts.slice(0, middle))} OR ${combine(parts.slice(middle))})`;
}

describe("extreme treatment reads on existing native indexes", () => {
  it("measures exact original API3 ordering against a zero-write nonzero-validity bucket merge, including hard fallbacks", async () => {
    const reports = [];
    for (const mode of ["all-valid-modified", "mixed-validity-modified", "mixed-validity-exact-tuple", "many-validity"] as const) {
      const stub = env.ENTRY_STORE.getByName(`treatment-extreme-${mode}-${crypto.randomUUID()}`);
      reports.push(...await runInDurableObject(stub, (_instance, state) => {
        const sql = state.storage.sql;
        seed(sql, mode);
        const repository = new SqliteDocumentRepository(state.storage);
        const cases: Audit[] = [
          { name: "default-latest", query: { limit: 5 } },
          { name: "default-page", query: { limit: 3, skip: 17 } },
          { name: "default-deep-offset", query: { limit: 3, skip: 2800 } },
          { name: "with-deleted", query: { limit: 5, includeDeleted: true } },
          { name: "custom-mixed-deep-offset", query: { limit: 3, skip: 2800, sort: { field: "rank", direction: "asc" } },
            order: "json_extract(body, '$.rank') ASC,id ASC" },
        ];
        return cases.map(audit => {
          const oracle = measured(sql, () => executeOriginal(sql, audit));
          const actual = measured(sql, () => repository.queryDocumentsForApi3("treatments", audit.query));
          const candidate = measured(sql, () => bucketCandidate(sql, audit));
          expect(actual.result, `${mode}/${audit.name}`).toEqual(oracle.result);
          expect(candidate.result.documents, `${mode}/${audit.name}`).toEqual(oracle.result);
          expect(actual.writes).toBe(0); expect(candidate.writes).toBe(0);
          if (audit.name === "default-latest" && mode === "all-valid-modified") expect(oracle.reads).toBeGreaterThanOrEqual(10_000);
          if (audit.name === "default-deep-offset") expect(candidate.result.reason).toBe("deep-page");
          if (mode === "many-validity" && ["default-latest", "default-page"].includes(audit.name)) {
            expect(candidate.result.reason).toBe("too-many-validity-buckets");
          }
          return { mode, query: audit.name, returned: oracle.result.length, originalReads: oracle.reads,
            repositoryReads: actual.reads, repositoryPlans: actual.plans, candidateReads: candidate.reads,
            candidateCalls: candidate.calls, reason: candidate.result.reason, buckets: candidate.result.buckets,
            candidatePlans: candidate.plans };
        });
      }));
    }
    console.info(`TREATMENT_EXTREME_BUCKETS=${JSON.stringify(reports)}`);
  }, 60_000);

  it("retains legal near-100 binding/100kB original SQL when the merge expansion cannot fit", async () => {
    const stub = env.ENTRY_STORE.getByName(`treatment-extreme-limits-${crypto.randomUUID()}`);
    const reports = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      seed(sql, "mixed-validity-modified");
      const note = { field: "eventType", operator: "eq", value: "Note" } as const;
      const inValues: JsonValue[] = ["Note", ...Array<null>(99).fill(null)];
      const inClause = combine([CATEGORY, ...Array<string>(99).fill(CATEGORY_NULL)]);
      const cases: Audit[] = [
        { name: "100-bindings", query: { limit: 1, filters: [...Array.from({ length: 48 }, () => note),
          { field: "_id", operator: "ne", value: "absent" }] }, where: `${Array<string>(48).fill(CATEGORY).join(" AND ")} AND id != ?`,
          bindings: [...Array<string>(96).fill("Note"), "absent"] },
        { name: "large-legal-SQL", query: { limit: 1, filters: [note,
          ...Array.from({ length: 3 }, () => ({ field: "eventType", operator: "in" as const, value: inValues }))] },
          where: `${CATEGORY} AND ${Array<string>(3).fill(inClause).join(" AND ")}`, bindings: Array<string>(8).fill("Note") },
      ];
      return cases.map(audit => {
        const query = originalSql(audit);
        expect(fits(query.statement, query.bindings)).toBe(true);
        if (audit.name === "100-bindings") expect(query.bindings).toHaveLength(100);
        else expect(new TextEncoder().encode(query.statement).byteLength).toBeGreaterThan(50_000);
        const oracle = measured(sql, () => executeOriginal(sql, audit));
        const repository = measured(sql, () => new SqliteDocumentRepository(state.storage).queryDocumentsForApi3("treatments", audit.query));
        const candidate = measured(sql, () => bucketCandidate(sql, audit));
        expect(repository.result).toEqual(oracle.result);
        expect(candidate.result.documents).toEqual(oracle.result);
        expect(candidate.result.reason).toBe("expanded-query");
        expect(candidate.writes).toBe(0);
        return { query: audit.name, originalBytes: new TextEncoder().encode(query.statement).byteLength,
          originalBindings: query.bindings.length, originalReads: oracle.reads, repositoryReads: repository.reads,
          candidateReads: candidate.reads, reason: candidate.result.reason };
      });
    });
    console.info(`TREATMENT_EXTREME_LIMITS=${JSON.stringify(reports)}`);
  }, 60_000);

  it("measures dense array misses and a test-only complete deduplicated first-level text membership index", async () => {
    const stub = env.ENTRY_STORE.getByName(`treatment-extreme-members-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      seed(sql, "dense-arrays");
      sql.exec(`CREATE TABLE audit_treatment_members(event_value TEXT,document_id TEXT,date_key,
        sort_time,srv_modified,PRIMARY KEY(event_value,document_id)) WITHOUT ROWID`);
      sql.exec("CREATE INDEX audit_members_date ON audit_treatment_members(event_value,date_key DESC,document_id ASC)");
      sql.exec("CREATE INDEX audit_members_api3 ON audit_treatment_members(event_value,sort_time DESC,srv_modified DESC,document_id ASC)");
      const built = measured(sql, () => sql.exec(`INSERT OR IGNORE INTO audit_treatment_members
        SELECT item.value,documents.id,json_extract(body,'$.created_at'),documents.sort_time,documents.srv_modified
        FROM documents,json_each(body,'$.eventType') item
        WHERE collection='treatments' AND json_valid(body)
          AND json_type(body,'$.eventType') IN ('text','array') AND item.type='text'`));
      const members = sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM audit_treatment_members").one().count;
      const repository = new SqliteDocumentRepository(state.storage);
      const queries = [];
      for (const policy of ["api3", "legacy"] as const) {
        for (const category of ["Absent", "7", "07", "Note", "Other"]) {
          const audit: Audit = { name: `${policy}/${category}`, policy, query: { limit: 3, skip: category === "Note" ? 17 : 0,
            filters: [{ field: "eventType", operator: "eq", value: category }] }, where: CATEGORY, bindings: [category, category] };
          const oracle = measured(sql, () => executeOriginal(sql, audit));
          const actual = measured(sql, () => policy === "api3" ? repository.queryDocumentsForApi3("treatments", audit.query)
            : repository.queryLegacyTreatments(audit.query));
          const candidate = measured(sql, () => materialize(sql.exec<RawRow>(`SELECT documents.*
            FROM audit_treatment_members INDEXED BY ${policy === "api3" ? "audit_members_api3" : "audit_members_date"}
            CROSS JOIN documents ON documents.collection='treatments' AND documents.id=document_id
            WHERE event_value=? ${policy === "api3" ? "AND is_valid != 0" : "AND json_valid(body)"} AND ${CATEGORY}
            ORDER BY ${policy === "api3" ? "audit_treatment_members.sort_time DESC,audit_treatment_members.srv_modified DESC,document_id ASC" : "date_key DESC,document_id ASC"}
            LIMIT ? OFFSET ?`, category, category, category, audit.query.limit!, audit.query.skip!).toArray(), audit));
          expect(actual.result, audit.name).toEqual(oracle.result);
          expect(candidate.result, audit.name).toEqual(oracle.result);
          expect(candidate.writes).toBe(0);
          if (["Absent", "7"].includes(category)) expect(candidate.result).toEqual([]);
          queries.push({ policy, category, returned: oracle.result.length, originalReads: oracle.reads,
            repositoryReads: actual.reads, candidateReads: candidate.reads, candidatePlans: candidate.plans });
        }
      }
      return { sourceRows: 5000, distinctTextMemberships: members,
        buildReads: built.reads, buildWrites: built.writes, queries };
    });
    console.info(`TREATMENT_EXTREME_MEMBERSHIP=${JSON.stringify(report)}`);
  }, 60_000);
});
