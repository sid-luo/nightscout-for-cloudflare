import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { migrateDocumentReadIndexesV31, SqliteDocumentRepository, TREATMENT_READ_INDEX_MIGRATION_LIMIT, TREATMENT_READ_INDEX_TOTAL_DOCUMENT_LIMIT, type DocumentQuery } from "../src/document-repository";
import type { JsonDocument } from "../src/entry-store";

const id = (n: number) => n.toString(16).padStart(24, "0");

/** Isolate the v31 upgrade from every optional index added by fresh v34 activation. */
function restorePreV31ReadIndexes(sql: SqlStorage): void {
  for (const name of ["documents_treatments_created_at", "documents_treatments_event_type_created_at",
    "documents_treatments_api3_order", "documents_devicestatus_recent"]) {
    sql.exec(`DROP INDEX IF EXISTS ${name}`);
  }
}

describe("treatment cold-read hardening", () => {
  it("measures missing categories and large timestamp ties without relying on an in-memory cache", async () => {
    const stub = env.ENTRY_STORE.getByName(`treatment-cold-read-${crypto.randomUUID()}`);
    const measurements = await runInDurableObject(stub, (_instance, state) => {
      const repository = new SqliteDocumentRepository(state.storage);
      const sql = state.storage.sql;
      const exec = sql.exec.bind(sql);
      restorePreV31ReadIndexes(sql);
      const at = Date.parse("2026-10-18T00:00:00.000Z");
      const reports: unknown[] = [];
      state.storage.transactionSync(() => {
        for (let n = 0; n < 5_000; n++) {
          exec(`INSERT INTO documents
            (collection,id,body,sort_time,created_at,updated_at)
            VALUES('treatments',?,?,?,?,?)`, id(n), JSON.stringify({
            created_at: new Date(at).toISOString(),
            eventType: n % 4 === 0 ? "Sensor Change" : "Note",
          }), at, at, at);
        }
      });
      let captured: { sql: string; bindings: SqlStorageValue[]; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
      const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
        const cursor = exec(statement, ...bindings);
        captured.push({ sql: statement, bindings, cursor });
        return cursor;
      });
      try {
        const queries = [
          { limit: 1 },
          { limit: 1, filters: [{ field: "eventType", operator: "eq", value: "Sensor Change" }] },
          { limit: 1, filters: [{ field: "eventType", operator: "eq", value: "Absent Synthetic Type" }] },
        ] satisfies DocumentQuery[];
        // Measure the actual former broad query as well as the cold repository
        // path. Neither phase uses EntryStore's exact-result memory cache.
        for (const query of queries) {
          const category = query.filters?.[0]?.value;
          const original = exec(`SELECT * FROM documents WHERE collection = 'treatments'
            AND collection IN ('treatments', 'devicestatus') AND json_valid(body)
            ${category === undefined ? "" : `AND ((json_type(body, '$.eventType') = 'text' AND json_extract(body, '$.eventType') = ?)
              OR (json_type(body, '$.eventType') = 'array' AND EXISTS (
                SELECT 1 FROM json_each(body, '$.eventType') AS item WHERE item.type = 'text' AND item.value = ?)))`}
            ORDER BY json_extract(body, '$.created_at') DESC, id ASC LIMIT 1`,
          ...(category === undefined ? [] : [category, category]));
          const expected = original.toArray().map(row => ({ ...JSON.parse(String(row.body)), _id: row.id }));
          reports.push({ phase: "former-query", query, returned: expected.length, rowsRead: original.rowsRead });
          captured = [];
          expect(repository.queryLegacyTreatments(query)).toEqual(expected);
          const unmigratedStatements = captured.filter(item => /^SELECT\b/.test(item.sql)
            && /\b(?:FROM|JOIN) documents\b/.test(item.sql));
          // The first seek returns only the exact raw date key. A matching
          // key needs one second query for the original ascending-id winner;
          // an absent category returns empty after its first complete scan.
          expect(unmigratedStatements).toHaveLength(expected.length === 0 ? 1 : 2);
          expect(unmigratedStatements[0]!.sql).toContain("AS __date_key");
          expect(unmigratedStatements.every(item => !item.sql.includes("treatment_read_side_keys"))).toBe(true);
          expect(unmigratedStatements.reduce((sum, item) => sum + item.cursor.rowsRead, 0))
            .toBeLessThanOrEqual(original.rowsRead);
          expect(captured.reduce((sum, item) => sum + item.cursor.rowsWritten, 0)).toBe(0);
        }
        captured = [];
        state.storage.transactionSync(() => migrateDocumentReadIndexesV31(sql));
        reports.push({ phase: "migration", rowsRead: captured.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
          rowsWritten: captured.reduce((sum, item) => sum + item.cursor.rowsWritten, 0) });
        for (const query of queries) {
          captured = [];
          const documents = repository.queryLegacyTreatments(query);
          const statement = captured.find(item => item.sql.startsWith("SELECT") && item.sql.includes("FROM documents"))!;
          const rowsRead = captured.reduce((sum, item) => sum + item.cursor.rowsRead, 0);
          reports.push({ phase: "indexed-query", query, returned: documents.length, rowsRead,
            plan: exec(`EXPLAIN QUERY PLAN ${statement.sql}`, ...statement.bindings).toArray() });
          expect(documents.map(row => row._id)).toEqual(query.filters?.[0]?.value === "Absent Synthetic Type" ? [] : [id(0)]);
        }
        exec(`WITH RECURSIVE sequence(n) AS (
          VALUES(5000) UNION ALL SELECT n + 1 FROM sequence WHERE n < 19999
        ) INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
          SELECT 'treatments', printf('%024x', n),
            '{"created_at":"2026-10-18T00:00:00.000Z","eventType":"Note"}', ?, ?, ?
          FROM sequence`, at, at, at);
        for (const query of queries) {
          captured = [];
          const documents = repository.queryLegacyTreatments(query);
          reports.push({ phase: "grown-query", history: 20_000, query, returned: documents.length,
            rowsRead: captured.reduce((sum, item) => sum + item.cursor.rowsRead, 0) });
          expect(documents.map(row => row._id)).toEqual(query.filters?.[0]?.value === "Absent Synthetic Type" ? [] : [id(0)]);
        }
        let maxRowsReadAfterWrite = 0;
        for (let n = 20_000; n < 20_020; n++) {
          repository.upsertTreatment({ _id: id(n), created_at: new Date(at + n * 60_000).toISOString(), eventType: "Note" });
          captured = [];
          expect(repository.queryLegacyTreatments(queries[2])).toEqual([]);
          maxRowsReadAfterWrite = Math.max(maxRowsReadAfterWrite,
            captured.reduce((sum, item) => sum + item.cursor.rowsRead, 0));
        }
        reports.push({ phase: "after-write-query", history: 20_020, iterations: 20, rowsRead: maxRowsReadAfterWrite, returned: 0 });
        // An already completed performance migration remains a cheap no-op
        // after subsequent writes grow history above its initial build cap.
        expect(migrateDocumentReadIndexesV31(sql)).toBe(true);
      } finally { spy.mockRestore(); }
      return reports;
    });
    console.log(`TREATMENT_COLD_READ_HARDENING=${JSON.stringify(measurements)}`);
    expect(measurements).toMatchInlineSnapshot(`
      [
        {
          "phase": "former-query",
          "query": {
            "limit": 1,
          },
          "returned": 1,
          "rowsRead": 10000,
        },
        {
          "phase": "former-query",
          "query": {
            "filters": [
              {
                "field": "eventType",
                "operator": "eq",
                "value": "Sensor Change",
              },
            ],
            "limit": 1,
          },
          "returned": 1,
          "rowsRead": 6250,
        },
        {
          "phase": "former-query",
          "query": {
            "filters": [
              {
                "field": "eventType",
                "operator": "eq",
                "value": "Absent Synthetic Type",
              },
            ],
            "limit": 1,
          },
          "returned": 0,
          "rowsRead": 5001,
        },
        {
          "phase": "migration",
          "rowsRead": 30358,
          "rowsWritten": 10002,
        },
        {
          "phase": "indexed-query",
          "plan": [
            {
              "detail": "SEARCH documents USING INDEX documents_treatments_created_at (collection=?)",
              "id": 17,
              "notused": 62,
              "parent": 0,
            },
          ],
          "query": {
            "limit": 1,
          },
          "returned": 1,
          "rowsRead": 1,
        },
        {
          "phase": "indexed-query",
          "plan": [
            {
              "detail": "MERGE (UNION ALL)",
              "id": 9,
              "notused": 0,
              "parent": 0,
            },
            {
              "detail": "LEFT",
              "id": 11,
              "notused": 0,
              "parent": 9,
            },
            {
              "detail": "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
              "id": 22,
              "notused": 60,
              "parent": 11,
            },
            {
              "detail": "CORRELATED SCALAR SUBQUERY 1",
              "id": 40,
              "notused": 0,
              "parent": 11,
            },
            {
              "detail": "SCAN item VIRTUAL TABLE INDEX 3:",
              "id": 44,
              "notused": 0,
              "parent": 40,
            },
            {
              "detail": "RIGHT",
              "id": 81,
              "notused": 0,
              "parent": 9,
            },
            {
              "detail": "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
              "id": 92,
              "notused": 61,
              "parent": 81,
            },
            {
              "detail": "CORRELATED SCALAR SUBQUERY 3",
              "id": 181,
              "notused": 0,
              "parent": 81,
            },
            {
              "detail": "SCAN item VIRTUAL TABLE INDEX 3:",
              "id": 185,
              "notused": 0,
              "parent": 181,
            },
          ],
          "query": {
            "filters": [
              {
                "field": "eventType",
                "operator": "eq",
                "value": "Sensor Change",
              },
            ],
            "limit": 1,
          },
          "returned": 1,
          "rowsRead": 1,
        },
        {
          "phase": "indexed-query",
          "plan": [
            {
              "detail": "MERGE (UNION ALL)",
              "id": 9,
              "notused": 0,
              "parent": 0,
            },
            {
              "detail": "LEFT",
              "id": 11,
              "notused": 0,
              "parent": 9,
            },
            {
              "detail": "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
              "id": 22,
              "notused": 60,
              "parent": 11,
            },
            {
              "detail": "CORRELATED SCALAR SUBQUERY 1",
              "id": 40,
              "notused": 0,
              "parent": 11,
            },
            {
              "detail": "SCAN item VIRTUAL TABLE INDEX 3:",
              "id": 44,
              "notused": 0,
              "parent": 40,
            },
            {
              "detail": "RIGHT",
              "id": 81,
              "notused": 0,
              "parent": 9,
            },
            {
              "detail": "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
              "id": 92,
              "notused": 61,
              "parent": 81,
            },
            {
              "detail": "CORRELATED SCALAR SUBQUERY 3",
              "id": 181,
              "notused": 0,
              "parent": 81,
            },
            {
              "detail": "SCAN item VIRTUAL TABLE INDEX 3:",
              "id": 185,
              "notused": 0,
              "parent": 181,
            },
          ],
          "query": {
            "filters": [
              {
                "field": "eventType",
                "operator": "eq",
                "value": "Absent Synthetic Type",
              },
            ],
            "limit": 1,
          },
          "returned": 0,
          "rowsRead": 0,
        },
        {
          "history": 20000,
          "phase": "grown-query",
          "query": {
            "limit": 1,
          },
          "returned": 1,
          "rowsRead": 1,
        },
        {
          "history": 20000,
          "phase": "grown-query",
          "query": {
            "filters": [
              {
                "field": "eventType",
                "operator": "eq",
                "value": "Sensor Change",
              },
            ],
            "limit": 1,
          },
          "returned": 1,
          "rowsRead": 1,
        },
        {
          "history": 20000,
          "phase": "grown-query",
          "query": {
            "filters": [
              {
                "field": "eventType",
                "operator": "eq",
                "value": "Absent Synthetic Type",
              },
            ],
            "limit": 1,
          },
          "returned": 0,
          "rowsRead": 0,
        },
        {
          "history": 20020,
          "iterations": 20,
          "phase": "after-write-query",
          "returned": 0,
          "rowsRead": 0,
        },
      ]
    `);
    for (const report of measurements as { phase: string; rowsRead: number; query?: DocumentQuery; plan?: unknown }[]) {
      if (["indexed-query", "grown-query", "after-write-query"].includes(report.phase)) {
        expect(report.rowsRead, JSON.stringify({ query: report.query, plan: report.plan })).toBeLessThan(30);
      }
    }
  });

  it("preserves full filtering before branch prefixes, arrays, null dates, pagination and UUIDs", async () => {
    const stub = env.ENTRY_STORE.getByName(`treatment-cold-semantics-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      migrateDocumentReadIndexesV31(sql);
      const repository = new SqliteDocumentRepository(state.storage);
      const uuid = "adc99b22-98c8-41b3-90a4-87229509ee8d";
      const bodies: JsonDocument[] = [
        { created_at: "2026-10-18", eventType: "Sensor Change", keep: false },
        { created_at: "2026-10-18", eventType: ["Note", "Sensor Change"], keep: true },
        { created_at: "2026-10-18", eventType: "Sensor Change", keep: true },
        { created_at: "2026-10-18", eventType: ["Sensor Change", "Sensor Change"], keep: true },
        { created_at: "2026-10-17", eventType: "Note", keep: true },
        { created_at: ["2026-10-19", "2026-10-14"], eventType: "Sensor Change", keep: true },
        { created_at: 7, eventType: "Sensor Change", keep: true },
        { created_at: null, eventType: "Sensor Change", keep: true },
        { eventType: "Sensor Change", keep: true },
        { created_at: "2026-10-18", eventType: null, keep: true },
        { created_at: "2026-10-18", eventType: "Sensor Change", identifier: uuid, keep: true },
      ];
      state.storage.transactionSync(() => {
        for (const [n, body] of bodies.entries()) {
          sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier)
            VALUES('treatments',?,?,?,?,?,?)`, id(n), JSON.stringify(body), n, n, n,
          typeof body.identifier === "string" ? body.identifier : null);
        }
      });
      const originalWhere = `collection = 'treatments' AND
        ((json_type(body, '$.eventType') = 'text' AND json_extract(body, '$.eventType') = 'Sensor Change')
        OR (json_type(body, '$.eventType') = 'array' AND EXISTS (
          SELECT 1 FROM json_each(body, '$.eventType') AS item WHERE item.type = 'text' AND item.value = 'Sensor Change')))
        AND json_type(body, '$.keep') IN ('true', 'false') AND json_extract(body, '$.keep') = 1`;
      for (const limit of [1, 2, 4, 10]) {
        for (const skip of [0, 1, 2, 5]) {
          const query: DocumentQuery = { limit, skip, filters: [
            { field: "eventType", operator: "eq", value: "Sensor Change" },
            { field: "keep", operator: "eq", value: true },
          ] };
          const expected = sql.exec<{ id: string; body: string }>(
            `SELECT id, body FROM documents WHERE ${originalWhere}
             ORDER BY json_extract(body, '$.created_at') DESC, id ASC LIMIT ? OFFSET ?`, limit, skip,
          ).toArray().map(row => ({ ...JSON.parse(row.body), _id: row.id }));
          expect(repository.queryLegacyTreatments(query), JSON.stringify(query)).toEqual(expected);
        }
      }
      const uuidFilter: DocumentQuery = { limit: 1, filters: [
        { field: "eventType", operator: "eq", value: "Sensor Change" },
        { field: "_id", operator: "eq", value: uuid },
      ] };
      expect(repository.queryLegacyTreatments(uuidFilter).map(row => row._id)).toEqual([id(10)]);
      expect(repository.queryLegacyTreatments({ ...uuidFilter, legacyUuidHandling: false })).toEqual([]);
      const repeatedFilters: DocumentQuery = { limit: 2, filters: [
        { field: "eventType", operator: "eq", value: "Sensor Change" },
        ...Array.from({ length: 15 }, () => ({ field: "keep", operator: "eq" as const, value: true })),
      ] };
      // Duplicating these valid predicates would exceed the optimized SQL's
      // binding budget; the original query must still execute successfully.
      expect(repository.queryLegacyTreatments(repeatedFilters)).toEqual(repository.queryLegacyTreatments({
        ...repeatedFilters, filters: repeatedFilters.filters!.slice(0, 2),
      }));
    });
  });

  it("measures index write cost and keeps migration and index maintenance transactional", async () => {
    const stub = env.ENTRY_STORE.getByName(`treatment-read-index-cost-${crypto.randomUUID()}`);
    const measured = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      restorePreV31ReadIndexes(sql);
      const insert = (n: number, collection = "treatments") => sql.exec(`INSERT INTO documents
        (collection,id,body,sort_time,created_at,updated_at) VALUES(?,?,?,?,?,?)`, collection,
      id(n), JSON.stringify({ created_at: "2026-10-18", eventType: "Note" }), n, n, n);
      const before = insert(1).rowsWritten;
      const deviceBefore = insert(2, "devicestatus").rowsWritten;
      state.storage.transactionSync(() => {
        for (let n = 100; n < 10_099; n++) {
          insert(n);
          insert(n, n % 2 === 0 ? "devicestatus" : "food");
        }
      });
      const snapshot = () => JSON.stringify({
        documents: sql.exec("SELECT * FROM documents ORDER BY collection,id").toArray(),
        changes: sql.exec("SELECT * FROM document_changes ORDER BY change_id").toArray(),
        clocks: sql.exec("SELECT * FROM collection_clocks ORDER BY collection").toArray(),
      });
      const fingerprint = snapshot();
      const exec = sql.exec.bind(sql);
      let captured: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
      const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
        const cursor = exec(statement, ...bindings);
        captured.push(cursor);
        return cursor;
      });
      try {
        expect(() => state.storage.transactionSync(() => {
          migrateDocumentReadIndexesV31(sql);
          throw new Error("synthetic read-index migration interruption");
        })).toThrow("synthetic read-index migration interruption");
        expect(snapshot()).toBe(fingerprint);
        expect(sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'documents_treatments_%'").toArray()).toEqual([]);
        captured = [];
        state.storage.transactionSync(() => migrateDocumentReadIndexesV31(sql));
        const migration = { rowsRead: captured.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
          rowsWritten: captured.reduce((sum, cursor) => sum + cursor.rowsWritten, 0) };
        expect(snapshot()).toBe(fingerprint);
        captured = [];
        migrateDocumentReadIndexesV31(sql);
        expect(captured.reduce((sum, cursor) => sum + cursor.rowsWritten, 0)).toBe(0);
        const after = insert(3).rowsWritten;
        const deviceAfter = insert(4, "devicestatus").rowsWritten;
        expect(after - before).toBe(2);
        expect(deviceAfter).toBe(deviceBefore);
        const withCommitted = snapshot();
        expect(() => state.storage.transactionSync(() => {
          sql.exec("UPDATE documents SET body = ? WHERE collection='treatments' AND id=?",
            JSON.stringify({ created_at: "2026-10-19", eventType: "Sensor Change" }), id(1));
          throw new Error("synthetic treatment index maintenance rollback");
        })).toThrow("synthetic treatment index maintenance rollback");
        expect(snapshot()).toBe(withCommitted);
        const repository = new SqliteDocumentRepository(state.storage);
        expect(repository.queryLegacyTreatments({ filters: [{ field: "eventType", operator: "eq", value: "Sensor Change" }] })).toEqual([]);
        return { treatmentHistory: 10_000, excludedDocuments: 10_000,
          before, after, deviceBefore, deviceAfter, migration };
      } finally { spy.mockRestore(); }
    });
    console.log(`TREATMENT_READ_INDEX_COST=${JSON.stringify(measured)}`);
    expect(measured).toMatchInlineSnapshot(`
      {
        "after": 12,
        "before": 10,
        "deviceAfter": 10,
        "deviceBefore": 10,
        "excludedDocuments": 10000,
        "migration": {
          "rowsRead": 90576,
          "rowsWritten": 20002,
        },
        "treatmentHistory": 10000,
      }
    `);
  });

  it("defers optional indexes above the migration budget while preserving normal writes and every historical row", async () => {
    const stub = env.ENTRY_STORE.getByName(`treatment-large-history-fallback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      restorePreV31ReadIndexes(sql);
      const historySize = TREATMENT_READ_INDEX_MIGRATION_LIMIT + 1;
      sql.exec(`WITH RECURSIVE sequence(n) AS (
        VALUES(0) UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
      ) INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
        SELECT 'treatments', printf('%024x', n),
          '{"created_at":"2026-10-18T00:00:00.000Z","eventType":"Note"}', n, n, n
        FROM sequence`, historySize - 1);
      const before = sql.exec<{ count: number; total: number }>(
        "SELECT count(*) AS count, sum(sort_time) AS total FROM documents WHERE collection='treatments'",
      ).one();
      expect(before.count).toBe(historySize);
      expect(state.storage.transactionSync(() => migrateDocumentReadIndexesV31(sql))).toBe(false);
      expect(sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'documents_treatments_%'").toArray()).toEqual([]);
      expect(sql.exec("SELECT count(*) AS count, sum(sort_time) AS total FROM documents WHERE collection='treatments'").one()).toEqual(before);
      const repository = new SqliteDocumentRepository(state.storage);
      const mutation = repository.upsertTreatment({ _id: id(historySize),
        created_at: "2026-10-18T00:05:00.000Z", eventType: "Sensor Change" });
      expect(mutation.created).toBe(true);
      expect(sql.exec<{ count: number }>("SELECT count(*) AS count FROM documents WHERE collection='treatments'").one().count)
        .toBe(historySize + 1);
      expect(repository.queryLegacyTreatments({ limit: 1, filters: [
        { field: "eventType", operator: "eq", value: "Sensor Change" },
      ] }).map(row => row._id)).toEqual([id(historySize)]);
    });
  });

  it("also defers index builds when other collections make the canonical table too large", async () => {
    const stub = env.ENTRY_STORE.getByName(`treatment-total-history-fallback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      restorePreV31ReadIndexes(sql);
      const historySize = TREATMENT_READ_INDEX_TOTAL_DOCUMENT_LIMIT + 1;
      sql.exec(`WITH RECURSIVE sequence(n) AS (
        VALUES(0) UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
      ) INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
        SELECT CASE WHEN n < ? THEN 'treatments' ELSE 'food' END, printf('%024x', n),
          '{"created_at":"2026-10-18T00:00:00.000Z","eventType":"Note"}', n, n, n
        FROM sequence`, historySize - 1, TREATMENT_READ_INDEX_MIGRATION_LIMIT);
      const snapshot = () => sql.exec("SELECT collection, count(*) AS count, sum(sort_time) AS total FROM documents GROUP BY collection ORDER BY collection").toArray();
      const before = snapshot();
      expect(state.storage.transactionSync(() => migrateDocumentReadIndexesV31(sql))).toBe(false);
      expect(sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'documents_treatments_%'").toArray()).toEqual([]);
      expect(snapshot()).toEqual(before);
      const repository = new SqliteDocumentRepository(state.storage);
      expect(repository.upsertTreatment({ _id: id(historySize),
        created_at: "2026-10-18T00:05:00.000Z", eventType: "Sensor Change" }).created).toBe(true);
      expect(repository.queryLegacyTreatments({ limit: 1, filters: [
        { field: "eventType", operator: "eq", value: "Sensor Change" },
      ] }).map(row => row._id)).toEqual([id(historySize)]);
    });
  });
});
