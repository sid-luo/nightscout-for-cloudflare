import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { migrateDocumentReadIndexesV31, SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import type { JsonDocument } from "../src/entry-store";
import { advance, initialize } from "../src/treatment-read-side-index";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const CATEGORY = `((json_type(body, '$.eventType') = 'text' AND json_extract(body, '$.eventType') = ?)
  OR (json_type(body, '$.eventType') = 'array' AND EXISTS (
    SELECT 1 FROM json_each(body, '$.eventType') item WHERE item.type = 'text' AND item.value = ?)))`;

function dropNative(sql: SqlStorage): void {
  sql.exec("DROP INDEX IF EXISTS documents_treatments_created_at");
  sql.exec("DROP INDEX IF EXISTS documents_treatments_event_type_created_at");
}

function seed(sql: SqlStorage, body: string): void {
  sql.exec("DELETE FROM documents WHERE collection = 'treatments'");
  sql.exec(`WITH RECURSIVE sequence(n) AS (
    VALUES(0) UNION ALL SELECT n + 1 FROM sequence WHERE n < 999
  ) INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
    SELECT 'treatments', printf('%024x',n), json_set(?, '$._id', printf('%024x',n),
      '$.eventType', json(CASE n % 4 WHEN 0 THEN '"Note"' WHEN 1 THEN '["Note","Sensor Change"]'
        WHEN 2 THEN '"Other"' ELSE '["Other","Sensor Change"]' END)), n, n, n FROM sequence`, body);
}

function oracle(sql: SqlStorage, query: DocumentQuery, category?: string): JsonDocument[] {
  return sql.exec<{ id: string; body: string }>(`SELECT id,body FROM documents
    WHERE collection = 'treatments' AND collection IN ('treatments','devicestatus') AND json_valid(body)
      ${category === undefined ? "" : `AND ${CATEGORY}`}
    ORDER BY json_extract(body, '$.created_at') DESC,id ASC LIMIT ? OFFSET ?`,
  ...(category === undefined ? [] : [category, category]), query.limit ?? 1, query.skip ?? 0)
    .toArray().map(row => ({ ...JSON.parse(row.body) as JsonDocument, _id: row.id }));
}

function measure(sql: SqlStorage, read: () => JsonDocument[]) {
  const execute = sql.exec.bind(sql);
  const queries: { statement: string; bindings: SqlStorageValue[];
    cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = execute(statement, ...bindings); queries.push({ statement, bindings, cursor }); return cursor;
  });
  try {
    const result = read();
    const data = queries.filter(item => /^SELECT\b/.test(item.statement) && /\b(?:FROM|JOIN) documents\b/.test(item.statement));
    return { result, dataCalls: data.length, dataReads: data.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: queries.reduce((sum, item) => sum + item.cursor.rowsWritten, 0),
      seekCalls: data.filter(item => item.statement.includes("AS __date_key")).length,
      plans: data.flatMap(item => execute<{ detail: string }>(`EXPLAIN QUERY PLAN ${item.statement}`,
        ...item.bindings).toArray().map(row => row.detail)),
      statements: data.map(item => item.statement.replace(/\s+/g, " ").trim()) };
  } finally { spy.mockRestore(); }
}

describe("legacy latest-one exact raw-date seek", () => {
  it("matches the complete original query through thousand-row NULL/numeric/bool/text/array/object ties", async () => {
    const stub = env.ENTRY_STORE.getByName(`latest-one-mixed-${crypto.randomUUID()}`);
    const reports = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      dropNative(sql);
      const fixtures = [
        ["missing", {}], ["null", { created_at: null }], ["integer", { created_at: 7 }],
        ["fraction", { created_at: 7.25 }], ["false", { created_at: false }], ["true", { created_at: true }],
        ["text", { created_at: "2026-10-18T00:00:00.000Z" }], ["array", { created_at: ["x", 7, null] }],
        ["object", { created_at: { time: "x" } }],
      ] as const;
      const reports = [];
      for (const [kind, document] of fixtures) {
        seed(sql, JSON.stringify(document));
        const repository = new SqliteDocumentRepository(state.storage);
        for (const category of [undefined, "Note", "Sensor Change", "Missing"]) {
          const query: DocumentQuery = { limit: 1, ...(category === undefined ? {} : {
            filters: [{ field: "eventType", operator: "eq", value: category }],
          }) };
          const expected = oracle(sql, query, category);
          const actual = measure(sql, () => repository.queryLegacyTreatments(query));
          expect(actual.result, `${kind}/${category}`).toEqual(expected);
          expect(actual.writes).toBe(0);
          expect(actual.seekCalls).toBe(1);
          expect(actual.dataCalls).toBe(expected.length === 0 ? 1 : 2);
          if (expected.length > 0) {
            expect(actual.dataReads).toBeLessThanOrEqual(20);
            expect(actual.plans.every(plan => !plan.includes("TEMP B-TREE"))).toBe(true);
          }
          reports.push({ kind, category: category ?? "all", id: actual.result[0]?._id,
            dataCalls: actual.dataCalls, dataReads: actual.dataReads });
        }
      }
      // json_valid accepts out-of-range JSON numbers; binding the resulting
      // Infinity would change the old behavior. The query must fall back.
      seed(sql, '{"created_at":1e999}');
      const expected = oracle(sql, { limit: 1 });
      const actual = measure(sql, () => new SqliteDocumentRepository(state.storage).queryLegacyTreatments({ limit: 1 }));
      expect(actual.result).toEqual(expected);
      expect(actual.seekCalls).toBe(1);
      expect(actual.dataCalls).toBe(2);
      reports.push({ kind: "nonfinite-fallback", category: "all", id: actual.result[0]?._id,
        dataCalls: actual.dataCalls, dataReads: actual.dataReads });
      return reports;
    });
    console.info(`TREATMENT_LATEST_ONE_SEEK=${JSON.stringify(reports)}`);
  }, 60_000);

  it("preserves legal 100-binding reads and the original 101-binding rejection; count/skip/identity/native/ready-side retain their paths", async () => {
    const stub = env.ENTRY_STORE.getByName(`latest-one-gates-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      dropNative(sql);
      seed(sql, '{"created_at":"2026-10-18T00:00:00.000Z"}');
      const repository = new SqliteDocumentRepository(state.storage);
      const repeated = Array.from({ length: 48 }, () => ({ field: "eventType", operator: "eq", value: "Note" } as const));
      const valid: DocumentQuery = { limit: 1, filters: [...repeated, { field: "_id", operator: "ne", value: "absent" }] };
      const validRead = measure(sql, () => repository.queryLegacyTreatments(valid));
      expect(validRead.result).toEqual(oracle(sql, valid, "Note"));
      expect(validRead.seekCalls).toBe(1);
      let failure: unknown;
      const rejected = measure(sql, () => {
        try { return repository.queryLegacyTreatments({ limit: 1, filters: [...repeated, repeated[0]!] }); }
        catch (error) { failure = error; return []; }
      });
      expect(failure).toMatchObject({ code: "QUERY_BINDING_LIMIT" });
      expect(rejected.dataCalls).toBe(0);
      for (const query of [{ limit: 2 }, { limit: 1, skip: 1 },
        { limit: 1, filters: [{ field: "_id", operator: "eq", value: "000000000000000000000000" }] }] satisfies DocumentQuery[]) {
        const actual = measure(sql, () => repository.queryLegacyTreatments(query));
        expect(actual.seekCalls).toBe(0);
        expect(actual.dataCalls).toBe(1);
      }
      expect(migrateDocumentReadIndexesV31(sql)).toBe(true);
      const native = measure(sql, () => new SqliteDocumentRepository(state.storage).queryLegacyTreatments({ limit: 1 }));
      expect(native.result).toEqual(oracle(sql, { limit: 1 }));
      expect(native.seekCalls).toBe(0);
      dropNative(sql);
      state.storage.transactionSync(() => initialize(sql));
      for (let batch = 0; batch < 16; batch++) advance(state.storage, AT + batch * 60_000);
      const ready = measure(sql, () => new SqliteDocumentRepository(state.storage).queryLegacyTreatments({ limit: 1 }));
      expect(ready.result).toEqual(oracle(sql, { limit: 1 }));
      expect(ready.seekCalls).toBe(0);
      expect(ready.statements.some(statement => statement.includes("treatment_read_side_keys"))).toBe(true);
    });
  }, 60_000);
});
