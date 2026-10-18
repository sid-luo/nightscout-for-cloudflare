import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import type { JsonDocument, JsonValue } from "../src/entry-store";

const LOWER = "2026-10-14T12:00:00.000Z";
const RECENT = "2026-10-15T12:00:00.000Z";
const OLD = "2026-10-01T12:00:00.000Z";
const datePredicate = `((json_type(body, '$.created_at') = 'text' AND json_extract(body, '$.created_at') >= ?)
  OR (json_type(body, '$.created_at') = 'array' AND EXISTS (
    SELECT 1 FROM json_each(body, '$.created_at') AS item WHERE item.type = 'text' AND item.value >= ?)))`;
const categoryPredicate = `((json_type(body, '$.eventType') = 'text' AND json_extract(body, '$.eventType') = 'Note')
  OR (json_type(body, '$.eventType') = 'array' AND EXISTS (
    SELECT 1 FROM json_each(body, '$.eventType') AS item WHERE item.type = 'text' AND item.value = 'Note')))`;

interface LowerBoundReport {
  phase: string; category: boolean; lower: string; extraFilters: number;
  returned: number; oracleReads: number; necessaryReads: number; reads: number; customSort: boolean;
}

describe("treatment ISO date lower-bound budget", () => {
  it("retains the complete scalar/array predicate while comparing a necessary raw ISO bound", async () => {
    const stub = env.ENTRY_STORE.getByName(`treatment-iso-lower-${crypto.randomUUID()}`);
    const reports = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const repository = new SqliteDocumentRepository(state.storage);
      sql.exec(`WITH RECURSIVE sequence(n) AS (
        VALUES(0) UNION ALL SELECT n + 1 FROM sequence WHERE n < 4999
      ) INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
        SELECT 'treatments', printf('%024x', n),
          json_object('created_at', strftime('%Y-%m-%dT%H:%M:%fZ', ? + n, 'unixepoch'), 'eventType', 'Note'),
          (? + n) * 1000, (? + n) * 1000, (? + n) * 1000 FROM sequence`,
      Date.parse(OLD) / 1000, Date.parse(OLD) / 1000, Date.parse(OLD) / 1000, Date.parse(OLD) / 1000);
      const exec = sql.exec.bind(sql);
      const reports: LowerBoundReport[] = [];
      const check = (phase: string, category: boolean, lower = LOWER, extraFilters = 0, customSort = false) => {
        const filters: NonNullable<DocumentQuery["filters"]> = [{ field: "created_at", operator: "gte", value: lower }];
        if (category) filters.push({ field: "eventType", operator: "eq", value: "Note" });
        for (let n = 0; n < extraFilters; n++) filters.push({ field: "eventType", operator: "eq", value: "Note" });
        if (extraFilters > 0) filters.push({ field: "_id", operator: "ne", value: "absent-id" });
        const query: DocumentQuery = { filters, limit: phase === "old-history" ? 1 : 100 };
        if (customSort) query.sort = { field: "marker", direction: "asc" };
        const order = customSort ? "json_extract(body, '$.marker') ASC, id ASC" : "json_extract(body, '$.created_at') DESC, id ASC";
        const baseline = exec<{ id: string; body: string }>(`SELECT id, body FROM documents
          WHERE collection = 'treatments' AND collection IN ('treatments', 'devicestatus') AND json_valid(body)
            AND ${datePredicate} ${category ? `AND ${categoryPredicate}` : ""}
          ORDER BY ${order} LIMIT ?`, lower, lower, query.limit!);
        const expected = baseline.toArray().map(row => ({ ...JSON.parse(row.body), _id: row.id }));
        const necessary = exec<{ id: string; body: string }>(`SELECT id, body FROM documents
          WHERE collection = 'treatments' AND collection IN ('treatments', 'devicestatus') AND json_valid(body)
            AND ${datePredicate} ${category ? `AND ${categoryPredicate}` : ""}
            AND json_extract(body, '$.created_at') >= ?
          ORDER BY ${order} LIMIT ?`, lower, lower, lower, query.limit!);
        const candidateResult = necessary.toArray().map(row => ({ ...JSON.parse(row.body), _id: row.id }));
        // The added raw bound is asserted only for canonical ISO lower bounds.
        if (lower === LOWER) expect(candidateResult, `${phase}:${category}`).toEqual(expected);
        let cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
        const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
          const cursor = exec(statement, ...bindings); cursors.push(cursor); return cursor;
        });
        try {
          const actual = repository.queryLegacyTreatments(query);
          expect(actual, `${phase}:${category}`).toEqual(expected);
          reports.push({ phase, category, lower, extraFilters, customSort, returned: actual.length, oracleReads: baseline.rowsRead,
            necessaryReads: necessary.rowsRead, reads: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0) });
        } finally { spy.mockRestore(); cursors = []; }
      };
      check("old-history", false);
      check("old-history", true);
      const mixed: (JsonValue | undefined)[] = [RECENT, OLD, [], [RECENT, OLD], [null, 7, { when: RECENT }, RECENT],
        [RECENT, RECENT], null, 7, true, { when: RECENT }, undefined, ["zz-not-iso"], "[not-iso", "中文", ["中文"],
        [[RECENT]], [false, null, 7, {}]];
      for (const [n, createdAt] of mixed.entries()) {
        const body: JsonDocument = { eventType: "Note", marker: `mixed-${n}` };
        if (createdAt !== undefined) body.created_at = createdAt;
        sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
          VALUES('treatments',?,?,?,?,?)`, (5000 + n).toString(16).padStart(24, "0"), JSON.stringify(body), n, n, n);
      }
      check("mixed-types", false);
      check("mixed-types", true);
      check("mixed-custom-sort", false, LOWER, 0, true);
      // 2 date bindings + 47 * 2 category bindings + one id binding + collection/limit/skip
      // remains legal, but repeating predicates for UNION cannot fit.
      check("binding-cap", false, LOWER, 47);
      // Non-ISO text must keep the full original array predicate: an array
      // containing zzzz can match even though its raw JSON starts with '['.
      sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
        VALUES('treatments','ffffffffffffffffffffffff','{"eventType":"Note","created_at":["zzzz"]}',0,0,0)`);
      check("non-iso-control", false, "zzz");
      return reports;
    });
    expect(reports).toMatchInlineSnapshot(`
      [
        {
          "category": false,
          "customSort": false,
          "extraFilters": 0,
          "lower": "2026-10-14T12:00:00.000Z",
          "necessaryReads": 1,
          "oracleReads": 5000,
          "phase": "old-history",
          "reads": 1,
          "returned": 0,
        },
        {
          "category": true,
          "customSort": false,
          "extraFilters": 0,
          "lower": "2026-10-14T12:00:00.000Z",
          "necessaryReads": 1,
          "oracleReads": 5000,
          "phase": "old-history",
          "reads": 2,
          "returned": 0,
        },
        {
          "category": false,
          "customSort": false,
          "extraFilters": 0,
          "lower": "2026-10-14T12:00:00.000Z",
          "necessaryReads": 21,
          "oracleReads": 5025,
          "phase": "mixed-types",
          "reads": 21,
          "returned": 8,
        },
        {
          "category": true,
          "customSort": false,
          "extraFilters": 0,
          "lower": "2026-10-14T12:00:00.000Z",
          "necessaryReads": 21,
          "oracleReads": 5025,
          "phase": "mixed-types",
          "reads": 22,
          "returned": 8,
        },
        {
          "category": false,
          "customSort": true,
          "extraFilters": 0,
          "lower": "2026-10-14T12:00:00.000Z",
          "necessaryReads": 29,
          "oracleReads": 5033,
          "phase": "mixed-custom-sort",
          "reads": 29,
          "returned": 8,
        },
        {
          "category": false,
          "customSort": false,
          "extraFilters": 47,
          "lower": "2026-10-14T12:00:00.000Z",
          "necessaryReads": 21,
          "oracleReads": 5025,
          "phase": "binding-cap",
          "reads": 5025,
          "returned": 8,
        },
        {
          "category": false,
          "customSort": false,
          "extraFilters": 0,
          "lower": "zzz",
          "necessaryReads": 3,
          "oracleReads": 5032,
          "phase": "non-iso-control",
          "reads": 5032,
          "returned": 3,
        },
      ]
    `);
  }, 30_000);
});
