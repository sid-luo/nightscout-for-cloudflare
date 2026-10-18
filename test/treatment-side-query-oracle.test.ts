import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import type { JsonDocument, JsonValue } from "../src/entry-store";
import { advance, initialize, readState } from "../src/treatment-read-side-index";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const CATEGORY = `((json_type(body, '$.eventType') = 'text' AND json_extract(body, '$.eventType') = ?)
  OR (json_type(body, '$.eventType') = 'array' AND EXISTS (
    SELECT 1 FROM json_each(body, '$.eventType') item WHERE item.type = 'text' AND item.value = ?)))`;
const LOWER = `((json_type(body, '$.created_at') = 'text' AND json_extract(body, '$.created_at') >= ?)
  OR (json_type(body, '$.created_at') = 'array' AND EXISTS (
    SELECT 1 FROM json_each(body, '$.created_at') item WHERE item.type = 'text' AND item.value >= ?)))`;
interface Audit {
  name: string; policy: "api3" | "legacy"; query: DocumentQuery;
  where?: string; bindings?: SqlStorageValue[]; order?: string;
}

function finiteTimestamp(value: JsonValue | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.trunc(timestamp) : null;
}

/** Full original query: never use side keys, candidate truncation, or a JS sort. */
function original(sql: SqlStorage, audit: Audit): JsonDocument[] {
  return sql.exec<{ id: string; body: string }>(`SELECT id,body FROM documents WHERE collection = 'treatments'
    ${audit.policy === "legacy" ? "AND collection IN ('treatments','devicestatus') AND json_valid(body)" : audit.query.includeDeleted === true ? "" : "AND is_valid != 0"}
    ${audit.where === undefined ? "" : `AND ${audit.where}`}
    ORDER BY ${audit.order ?? (audit.policy === "legacy" ? "json_extract(body, '$.created_at') DESC,id ASC" : "sort_time DESC,srv_modified DESC,id ASC")}
    LIMIT ? OFFSET ?`, ...(audit.bindings ?? []), audit.query.limit ?? 1000, audit.query.skip ?? 0)
    .toArray().map(row => {
      let document = JSON.parse(row.body) as JsonDocument;
      if (audit.policy === "legacy") document._id = row.id;
      else {
        if (!document.identifier) document.identifier = row.id;
        delete document._id;
        if (!document.srvModified) {
          const fallback = finiteTimestamp(document.created_at);
          if (fallback !== null) document.srvModified = fallback;
        }
        if (document.srvModified && !document.srvCreated) {
          const modified = finiteTimestamp(document.srvModified);
          if (modified !== null) document.srvCreated = modified;
        }
      }
      if (audit.query.fields !== undefined) document = Object.fromEntries(audit.query.fields
        .filter(field => document[field] !== undefined).map(field => [field, document[field]!])) as JsonDocument;
      return document;
    });
}

function measure(sql: SqlStorage, read: () => JsonDocument[]) {
  const execute = sql.exec.bind(sql);
  const cursors: { statement: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = execute(statement, ...bindings); cursors.push({ statement, cursor }); return cursor;
  });
  try {
    const result = read();
    const data = cursors.filter(item => /^SELECT\b/.test(item.statement) && /\b(?:FROM|JOIN) documents\b/.test(item.statement));
    return { result, reads: cursors.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: cursors.reduce((sum, item) => sum + item.cursor.rowsWritten, 0),
      side: data.some(item => item.statement.includes("treatment_read_side_keys")),
      union: data.some(item => item.statement.includes("UNION ALL")) };
  } finally { spy.mockRestore(); }
}

function seed(sql: SqlStorage): void {
  for (let index = 0; index < 211; index++) {
    const id = (index + 1).toString(16).padStart(24, "0");
    const eventType: JsonValue = index < 5 ? ["Note", "Sensor Change", "Sensor Change"]
      : index < 11 ? "Sensor Change" : index % 3 ? "Note" : "Other";
    const createdAt: JsonValue | undefined = [undefined, null, -7, true, false,
      "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", ["2026-02-01T00:00:00.000Z", null],
      { time: "2026-01-01" }, [7, {}]][index % 10];
    const validity = [0, 1, 2, -1][index % 4]!;
    const modified = index % 4 === 0 ? null : AT + index % 7;
    const document: JsonDocument = { _id: id, eventType, rank: index % 5, srvModified: modified,
      isValid: validity === 0 ? false : validity };
    if (createdAt !== undefined) document.created_at = createdAt;
    if (index % 13 === 0) document.identifier = "duplicate";
    sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,
      identifier_present,srv_modified,is_valid,revision,srv_metadata_version)
      VALUES('treatments',?,?,?,?,?,?,?, ?,?,1,1)`, id, JSON.stringify(document), AT + index % 9,
    AT, AT, document.identifier as string | undefined ?? null, document.identifier === undefined ? 0 : 1, modified, validity);
  }
}

const note = { field: "eventType", operator: "eq", value: "Note" } as const;
const sensor = { field: "eventType", operator: "eq", value: "Sensor Change" } as const;
const audits: Audit[] = [
  { name: "legacy-date-page", policy: "legacy", query: { limit: 7, skip: 3 } },
  { name: "legacy-category-page", policy: "legacy", query: { limit: 4, skip: 2, filters: [note] },
    where: CATEGORY, bindings: ["Note", "Note"] },
  { name: "legacy-array-ISO-lower", policy: "legacy", query: { limit: 7, filters: [
    { field: "created_at", operator: "gte", value: "2026-02-01T00:00:00.000Z" }] },
    where: LOWER, bindings: ["2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"] },
  { name: "api3-default-NULL-ties", policy: "api3", query: { limit: 9, skip: 3 } },
  { name: "api3-all-nonzero-validity", policy: "api3", query: { limit: 1000, fields: ["identifier", "isValid"] } },
  { name: "api3-with-deleted", policy: "api3", query: { limit: 13, includeDeleted: true } },
  { name: "api3-raw-created-desc", policy: "api3", query: { limit: 7, skip: 2,
    sort: { field: "created_at", direction: "desc" } }, order: "json_extract(body, '$.created_at') DESC,id DESC" },
  { name: "api3-raw-created-asc", policy: "api3", query: { limit: 7,
    sort: { field: "created_at", direction: "asc" } }, order: "json_extract(body, '$.created_at') ASC,id ASC" },
  { name: "api3-dense-Note", policy: "api3", query: { limit: 5, filters: [note] },
    where: CATEGORY, bindings: ["Note", "Note"] },
  { name: "api3-sparse-array-category-custom", policy: "api3", query: { limit: 6, filters: [sensor],
    sort: { field: "rank", direction: "desc" } }, where: CATEGORY, bindings: ["Sensor Change", "Sensor Change"],
    order: "json_extract(body, '$.rank') DESC,id DESC" },
  { name: "api3-missing-category", policy: "api3", query: { limit: 3, filters: [
    { field: "eventType", operator: "eq", value: "Missing" }] }, where: CATEGORY, bindings: ["Missing", "Missing"] },
  { name: "api3-multiple-members", policy: "api3", query: { limit: 5, filters: [note,
    { field: "eventType", operator: "eq", value: "Other" }] }, where: `(${CATEGORY}) AND (${CATEGORY})`,
    bindings: ["Note", "Note", "Other", "Other"] },
  { name: "api3-unindexed-compound", policy: "api3", query: { limit: 8, skip: 1,
    sort: [{ field: "rank", direction: "asc" }, { field: "created_at", direction: "desc" }] },
    order: "json_extract(body, '$.rank') ASC,json_extract(body, '$.created_at') DESC,id DESC" },
];

describe("complete treatment side-index query oracle", () => {
  it("keeps partial indexes unused, then preserves original mixed-type/API3/array/page queries and trigger/rollback semantics", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-query-oracle-${crypto.randomUUID()}`);
    const reports = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP INDEX IF EXISTS documents_treatments_created_at");
      sql.exec("DROP INDEX IF EXISTS documents_treatments_event_type_created_at");
  sql.exec("DROP INDEX IF EXISTS documents_treatments_api3_order");
  sql.exec("DROP INDEX IF EXISTS documents_devicestatus_recent");
      seed(sql);
      state.storage.transactionSync(() => initialize(sql));
      expect(advance(state.storage, AT).processed).toBe(64);
      expect(readState(sql)?.complete).toBe(false);
      const repository = new SqliteDocumentRepository(state.storage);
      const reports: { phase: string; query: string; reads: number; returned: number; side: boolean; union: boolean }[] = [];
      const check = (phase: string, partial = false) => {
        for (const audit of audits) {
          const expected = original(sql, audit);
          const actual = measure(sql, () => audit.policy === "legacy" ? repository.queryLegacyTreatments(audit.query)
            : repository.queryDocumentsForApi3("treatments", audit.query));
          expect(actual.result, `${phase}/${audit.name}`).toEqual(expected);
          expect(actual.writes).toBe(0);
          if (partial) expect(actual.side).toBe(false);
          else if (["legacy-date-page", "api3-default-NULL-ties"].includes(audit.name)) {
            expect(actual.side).toBe(true);
          }
          if (phase === "dense-arrays" && audit.name === "api3-missing-category") expect(actual.union).toBe(false);
          reports.push({ phase, query: audit.name, reads: actual.reads, returned: actual.result.length,
            side: actual.side, union: actual.union });
        }
      };
      check("partial", true);
      for (let batch = 1; batch < 4; batch++) advance(state.storage, AT + batch * 60_000);
      expect(readState(sql)?.complete).toBe(true);
      check("ready");
      // Insert behind the completed keyset cursor; then move category/date and
      // API3 ordering metadata, delete, and roll all changes back atomically.
      sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
        VALUES('treatments','000000000000000000000000','{"created_at":"zzz","eventType":["Note","Other"],"rank":9}',?,?,?,1)`, AT + 99, AT, AT);
      check("insert-behind-cursor");
      sql.exec(`UPDATE documents SET body = '{"created_at":null,"eventType":["Sensor Change","Other"],"rank":10}',
        sort_time = ?,srv_modified = ?,updated_at = ? WHERE collection='treatments' AND id='000000000000000000000001'`, AT + 100, AT + 100, AT + 100);
      check("update-multiple-keys");
      sql.exec("DELETE FROM documents WHERE collection='treatments' AND id='000000000000000000000000'");
      check("delete");
      expect(() => state.storage.transactionSync(() => {
        sql.exec("UPDATE documents SET collection='food' WHERE collection='treatments' AND id='000000000000000000000001'");
        sql.exec("DELETE FROM documents WHERE collection='treatments' AND id='000000000000000000000002'");
        check("inside-rollback");
        throw new Error("rollback side oracle");
      })).toThrow("rollback side oracle");
      check("after-rollback");
      for (let index = 0; index < 20; index++) {
        sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
          VALUES('treatments',?,'{"created_at":"yyy","eventType":["Note","Other"],"rank":1}',?,?,?,1)`,
        (1000 + index).toString(16).padStart(24, "0"), AT + index, AT, AT);
      }
      check("dense-arrays");
      // Default API3 must still encounter this row and its original JSON
      // parse error; a side index containing only valid JSON would hide it.
      sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
        VALUES('treatments','ffffffffffffffffffffffff','{malformed',?,?,?,1)`, AT + 999, AT, AT);
      const malformed: Audit = { name: "malformed-default", policy: "api3", query: { limit: 1 } };
      expect(() => original(sql, malformed)).toThrow(SyntaxError);
      expect(() => repository.queryDocumentsForApi3("treatments", malformed.query)).toThrow(SyntaxError);
      const legacy: Audit = { name: "malformed-legacy-exclusion", policy: "legacy", query: { limit: 3 } };
      expect(repository.queryLegacyTreatments(legacy.query)).toEqual(original(sql, legacy));
      return reports;
    });
    console.info(`TREATMENT_SIDE_QUERY_ORACLE=${JSON.stringify(reports)}`);
    expect(reports).toHaveLength(104);
  }, 60_000);
});
