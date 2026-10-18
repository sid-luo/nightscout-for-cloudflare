import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import type { JsonDocument } from "../src/entry-store";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const DEFAULT_ORDER = "sort_time DESC, srv_modified DESC, id ASC";
const categoryWhere = `((json_type(body, '$.eventType') = 'text' AND json_extract(body, '$.eventType') = ?)
  OR (json_type(body, '$.eventType') = 'array' AND EXISTS (
    SELECT 1 FROM json_each(body, '$.eventType') AS item WHERE item.type = 'text' AND item.value = ?)))`;
interface AuditCase {
  name: string; query: DocumentQuery; where?: string; bindings?: SqlStorageValue[]; order?: string;
}

function seed(sql: SqlStorage, mode: "distinct" | "null-modified-ties" | "mixed-category-ties"): void {
  sql.exec(`WITH RECURSIVE sequence(n) AS (
    VALUES(0) UNION ALL SELECT n + 1 FROM sequence WHERE n < 4999
  ), prepared AS (SELECT n,
    ? + CASE WHEN ? THEN 0 ELSE n * 1000 END AS event_at,
    ? + CASE WHEN ? THEN (n % 25) * 1000 ELSE (5000 - n) * 1000 END AS raw_created,
    CASE WHEN ? THEN NULL ELSE ? + (n % 11) * 1000 END AS modified_at
    FROM sequence)
  INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,
    identifier_present,srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
  SELECT 'treatments', printf('%024x', n), json_object(
    '_id', printf('%024x', n), 'identifier', 'sort-audit-' || n, 'date', event_at,
    'created_at', strftime('%Y-%m-%dT%H:%M:%fZ', raw_created / 1000.0, 'unixepoch'),
    'eventType', json(CASE WHEN ? AND n % 2 = 0 THEN '["Note","Other"]'
      WHEN n % 13 = 0 THEN '"Other"' ELSE '"Note"' END),
    'rank', n % 7, 'srvCreated', event_at, 'srvModified', modified_at,
    'isValid', json(CASE WHEN n % 17 = 0 THEN 'false' ELSE 'true' END)),
    event_at, raw_created, ? + n * 1000, 'sort-audit-' || n, 1,
    event_at, modified_at, COALESCE(modified_at, raw_created),
    CASE WHEN n % 17 = 0 THEN 0 ELSE 1 END, 1, 1 FROM prepared`,
  AT, mode !== "distinct" ? 1 : 0, AT, mode !== "distinct" ? 1 : 0,
  mode === "null-modified-ties" ? 1 : 0, AT, mode === "mixed-category-ties" ? 1 : 0, AT);
}

/** Complete pre-optimization SQL, including the exact public sort/tie chain. */
function oracle(sql: SqlStorage, audit: AuditCase) {
  const cursor = sql.exec<{ id: string; body: string }>(`SELECT id,body FROM documents
    WHERE collection = ? ${audit.query.includeDeleted === true ? "" : "AND is_valid != 0"}
      ${audit.where === undefined ? "" : `AND ${audit.where}`}
    ORDER BY ${audit.order ?? DEFAULT_ORDER} LIMIT ? OFFSET ?`,
  "treatments", ...(audit.bindings ?? []), audit.query.limit ?? 1000, audit.query.skip ?? 0);
  const result = cursor.toArray().map(row => {
    const document = JSON.parse(row.body) as JsonDocument;
    delete document._id;
    if (!document.identifier) document.identifier = row.id;
    if (!document.srvModified && typeof document.created_at === "string") {
      document.srvModified = Date.parse(document.created_at);
    }
    if (document.srvModified && !document.srvCreated) document.srvCreated = document.srvModified;
    if (audit.query.fields !== undefined) {
      return Object.fromEntries(audit.query.fields.filter(field => Object.hasOwn(document, field))
        .map(field => [field, document[field]]));
    }
    return document;
  });
  return { result, reads: cursor.rowsRead };
}

function measure(sql: SqlStorage, action: () => JsonDocument[]) {
  const execute = sql.exec.bind(sql);
  const queries: { statement: string; bindings: SqlStorageValue[];
    cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = execute(statement, ...bindings);
    queries.push({ statement, bindings, cursor }); return cursor;
  });
  try {
    const result = action();
    const dataQueries = queries.filter(({ statement }) => statement.startsWith("SELECT") && statement.includes("FROM documents"));
    return { result, reads: queries.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: queries.reduce((sum, item) => sum + item.cursor.rowsWritten, 0),
      dataReads: dataQueries.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      plans: dataQueries.flatMap(({ statement, bindings }) => execute<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${statement}`, ...bindings).toArray().map(row => row.detail)),
      statements: dataQueries.map(({ statement }) => statement.replace(/\s+/g, " ").trim()),
    };
  } finally { spy.mockRestore(); }
}

describe("API3 complete sort and category read budgets", () => {
  it("measures default time ties, missing/array categories and exact custom-sort pages against the original SQL", async () => {
    const reports = [];
    for (const mode of ["distinct", "null-modified-ties", "mixed-category-ties"] as const) {
      const stub = env.ENTRY_STORE.getByName(`api3-sort-budget-${mode}-${crypto.randomUUID()}`);
      reports.push(...await runInDurableObject(stub, (_instance, state) => {
        seed(state.storage.sql, mode);
        const repository = new SqliteDocumentRepository(state.storage);
        const cases: AuditCase[] = [
          { name: "default-latest", query: { limit: 3 } },
          { name: "default-deep-page", query: { limit: 3, skip: 4000 } },
          { name: "missing-category", query: { limit: 3, filters: [
            { field: "eventType", operator: "eq", value: "Never Seen Category" },
          ] }, where: categoryWhere, bindings: ["Never Seen Category", "Never Seen Category"] },
          { name: "existing-category-default-time", query: { limit: 3, filters: [
            { field: "eventType", operator: "eq", value: "Note" },
          ] }, where: categoryWhere, bindings: ["Note", "Note"] },
          { name: "raw-created-desc", query: { limit: 3, sort: { field: "created_at", direction: "desc" } },
            order: "json_extract(body, '$.created_at') DESC, id DESC" },
          { name: "raw-created-asc", query: { limit: 3, sort: { field: "created_at", direction: "asc" } },
            order: "json_extract(body, '$.created_at') ASC, id ASC" },
          { name: "category-created-desc-page", query: { limit: 3, skip: 17,
            sort: { field: "created_at", direction: "desc" }, filters: [
              { field: "eventType", operator: "eq", value: "Note" },
            ] }, where: categoryWhere, bindings: ["Note", "Note"],
            order: "json_extract(body, '$.created_at') DESC, id DESC" },
          { name: "category-custom-rank-desc", query: { limit: 3,
            sort: { field: "rank", direction: "desc" }, filters: [
              { field: "eventType", operator: "eq", value: "Note" },
            ] }, where: categoryWhere, bindings: ["Note", "Note"],
            order: "json_extract(body, '$.rank') DESC, id DESC" },
          { name: "compound-rank-created-desc", query: { limit: 3, skip: 11,
            sort: [{ field: "rank", direction: "asc" }, { field: "created_at", direction: "desc" }] },
            order: "json_extract(body, '$.rank') ASC, json_extract(body, '$.created_at') DESC, id DESC" },
          { name: "created-projection-with-deleted", query: { limit: 3, includeDeleted: true,
            fields: ["identifier", "created_at"], sort: { field: "created_at", direction: "desc" } },
            order: "json_extract(body, '$.created_at') DESC, id DESC" },
        ];
        return cases.map(audit => {
          const expected = oracle(state.storage.sql, audit);
          const repeats = Array.from({ length: 2 }, () => {
            const actual = measure(state.storage.sql, () => repository.queryDocumentsForApi3("treatments", audit.query));
            expect(actual.result, `${mode}/${audit.name}`).toEqual(expected.result);
            expect(actual.writes).toBe(0);
            if (audit.name === "missing-category" && mode !== "mixed-category-ties") {
              expect(actual.dataReads).toBeLessThanOrEqual(20);
              expect(actual.statements.some(statement => statement.includes("UNION ALL"))).toBe(true);
            }
            if (audit.name.startsWith("raw-created-") || audit.name === "created-projection-with-deleted"
              || audit.name === "category-created-desc-page") {
              // There are 200 equal raw dates in the tie fixtures. Sorting
              // within one indexed date block is allowed; scanning all 5000
              // documents again is not.
              expect(actual.dataReads).toBeLessThanOrEqual(mode === "distinct" ? 128 : 700);
              expect(actual.plans.some(plan => /documents_(?:treatments|collection)_created_at/.test(plan))).toBe(true);
            }
            if (audit.name === "existing-category-default-time" && mode === "distinct") {
              // A common category already has a cheap time-index LIMIT read.
              // Its bounded admission probe must not turn that into a full
              // category sort, or add hundreds of reads on every request.
              expect(actual.dataReads).toBeLessThanOrEqual(40);
              expect(actual.statements.some(statement => statement.includes("UNION ALL"))).toBe(false);
            }
            return { reads: actual.reads, dataReads: actual.dataReads, plans: actual.plans,
              statements: actual.statements };
          });
          return { mode, query: audit.name, returned: expected.result.length, oracleReads: expected.reads,
            identifiers: expected.result.map(row => row.identifier), repeats };
        });
      }));
    }
    console.info(`API3_SORT_READ_BUDGET=${JSON.stringify(reports)}`);
    expect(reports).toHaveLength(30);
  }, 60_000);

  it("uses complete sparse scalar/array candidates without narrowing nonzero validity, and falls back at SQL limits", async () => {
    const stub = env.ENTRY_STORE.getByName(`api3-sparse-sort-budget-${crypto.randomUUID()}`);
    const reports = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      seed(sql, "distinct");
      for (const [offset, validity, eventType] of [[0, 1, "Sensor Change"], [1, 0, "Sensor Change"],
        [2, 2, ["Sensor Change", "Note"]]] as const) {
        const id = (6000 + offset).toString(16).padStart(24, "0");
        const at = AT - 86_400_000 + offset * 1000;
        const body = { _id: id, identifier: `sparse-${offset}`, date: at,
          created_at: new Date(at).toISOString(), eventType, rank: 1,
          srvCreated: at, srvModified: at, isValid: validity === 0 ? false : validity };
        sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,
          identifier,identifier_present,srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
          VALUES ('treatments',?,?,?,?,?,?,1,?,?,?,?,1,1)`,
        id, JSON.stringify(body), at, at, at, body.identifier, at, at, at, validity);
      }
      const repository = new SqliteDocumentRepository(state.storage);
      const categoryFilter = { field: "eventType", operator: "eq", value: "Sensor Change" } as const;
      const audits: AuditCase[] = [
        { name: "sparse-default", query: { limit: 3, filters: [categoryFilter] } },
        { name: "sparse-custom-rank", query: { limit: 3, filters: [categoryFilter],
          sort: { field: "rank", direction: "desc" } }, order: "json_extract(body, '$.rank') DESC, id DESC" },
        { name: "sparse-with-deleted", query: { limit: 3, includeDeleted: true, filters: [categoryFilter] } },
        // Each arbitrary scalar/array equality consumes six bound values.
        // The original statement fits, while duplicating both complete
        // branches would exceed SQLite's 100-parameter request limit.
        { name: "near-binding-limit", query: { limit: 3, filters: [categoryFilter,
          ...Array.from({ length: 9 }, () => ({ field: "rank", operator: "eq", value: 1 } as const))],
          sort: { field: "rank", direction: "desc" } }, order: "json_extract(body, '$.rank') DESC, id DESC" },
        // Balanced IN predicates produce a valid original statement above
        // 50kB with very few bindings. Repeating it in UNION would exceed
        // Cloudflare's 100kB SQL limit. Every sparse row matches each clause.
        { name: "near-statement-limit", query: { limit: 3, filters: [categoryFilter,
          ...Array.from({ length: 3 }, () => ({ field: "eventType", operator: "in" as const,
            value: ["Sensor Change", ...Array<null>(99).fill(null)] }))] } },
      ];
      return audits.map(audit => {
        // All three sparse rows have rank=1 and Sensor Change, so the extra
        // near-limit conjuncts preserve exactly this full original oracle.
        const expected = oracle(sql, { ...audit, where: categoryWhere,
          bindings: ["Sensor Change", "Sensor Change"] });
        const actual = measure(sql, () => repository.queryDocumentsForApi3("treatments", audit.query));
        expect(actual.result, audit.name).toEqual(expected.result);
        expect(actual.writes).toBe(0);
        if (audit.name.startsWith("sparse-")) {
          expect(actual.dataReads).toBeLessThanOrEqual(40);
          expect(actual.statements.some(statement => statement.includes("UNION ALL"))).toBe(true);
          expect(actual.result.some(row => row.identifier === "sparse-2")).toBe(true);
          expect(actual.result).toHaveLength(audit.query.includeDeleted === true ? 3 : 2);
        } else {
          expect(actual.statements.some(statement => statement.includes("UNION ALL"))).toBe(false);
          expect(actual.statements).toHaveLength(1);
          if (audit.name === "near-statement-limit") {
            const bytes = new TextEncoder().encode(actual.statements[0]).byteLength;
            expect(bytes).toBeGreaterThan(50_000);
            expect(bytes).toBeLessThanOrEqual(100_000);
          }
        }
        return { query: audit.name, returned: actual.result.length, reads: actual.reads,
          dataReads: actual.dataReads, plans: actual.plans,
          statementBytes: actual.statements.map(statement => new TextEncoder().encode(statement).byteLength) };
      });
    });
    console.info(`API3_SPARSE_SORT_READ_BUDGET=${JSON.stringify(reports)}`);
  }, 60_000);
});
