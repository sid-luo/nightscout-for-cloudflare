import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore, JsonDocument } from "../src/entry-store";
import { advance, readState } from "../src/treatment-read-side-index";
import { TREATMENT_MEMBERSHIP_VIEW_KEY } from "../src/treatment-membership-read-view";
import {
  migrateDocumentReadIndexesV31,
  SqliteDocumentRepository,
  TREATMENT_EVENT_TYPE_INDEX_VALUE_SQL,
  type DocumentQuery,
} from "../src/document-repository";

const MINUTE = 60_000;
const DAY = 86_400_000;
const START = Date.parse("2026-10-18T00:00:00.000Z");
interface RawRow extends Record<string, SqlStorageValue> { id: string; body: string; sort_time: number }
interface Internal {
  treatmentCategoryIndexAvailable: boolean | undefined;
  boundedTreatmentQueries: { clear(): void };
  cachedAuxiliaryRows(sql: string, bindings: SqlStorageValue[]): Iterable<RawRow>;
  legacyTreatmentQueries: { get(key: string): string | undefined };
}

function prepareOldStore(storage: DurableObjectStorage, count: number): void {
  const sql = storage.sql;
  sql.exec("DROP INDEX IF EXISTS documents_treatments_created_at");
  sql.exec("DROP INDEX IF EXISTS documents_treatments_event_type_created_at");
  sql.exec("DROP INDEX IF EXISTS documents_treatments_api3_order");
  sql.exec("DROP INDEX IF EXISTS documents_devicestatus_recent");
  sql.exec(`WITH RECURSIVE sequence(n) AS (
      VALUES(0) UNION ALL SELECT n + 1 FROM sequence WHERE n < ${count - 1}
    ), dated AS (
      SELECT n, CASE WHEN n >= ${count - 1000} THEN ? ELSE ? - (${count} - n) * ${MINUTE} END AS at
      FROM sequence
    ) INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
      SELECT 'treatments', printf('%024x', n), json_object(
        'created_at', strftime('%Y-%m-%dT%H:%M:%fZ', at / 1000.0, 'unixepoch'),
        'eventType', CASE WHEN n % 240 = 0 THEN 'Sensor Change' ELSE 'Note' END
      ), at, at, at FROM dated`, START - MINUTE, START);
}

async function measure<T>(storage: DurableObjectStorage, read: () => T | Promise<T>) {
  const execute = storage.sql.exec.bind(storage.sql);
  const cursors: { sql: string; bindings: SqlStorageValue[]; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(storage.sql, "exec").mockImplementation((sql, ...bindings) => {
    const cursor = execute(sql, ...bindings);
    cursors.push({ sql, bindings, cursor });
    return cursor;
  });
  let result: T;
  try { result = await read(); }
  finally { spy.mockRestore(); }
  return { result, reads: cursors.reduce((sum, row) => sum + row.cursor.rowsRead, 0),
    writes: cursors.reduce((sum, row) => sum + row.cursor.rowsWritten, 0), calls: cursors.length,
    plans: cursors.filter(row => /^SELECT\b/.test(row.sql.trim()) && /\bdocuments\b/.test(row.sql))
      .map(row => execute(`EXPLAIN QUERY PLAN ${row.sql}`, ...row.bindings).toArray().map(plan => String(plan.detail))),
  };
}

function fixtureDocuments(sql: SqlStorage): JsonDocument[] {
  return sql.exec<{ id: string; body: string }>(
    "SELECT id, body FROM documents WHERE collection = 'treatments'",
  ).toArray().map(row => ({ ...JSON.parse(row.body) as JsonDocument, _id: row.id }));
}

function fixtureOracle(documents: JsonDocument[], query: DocumentQuery): JsonDocument[] {
  // This independent oracle is intentionally limited to this canonical ISO /
  // scalar fixture; mixed JSON/array semantics have their own regression set.
  return documents.filter(document => (query.filters ?? []).every(filter => {
    const value = document[filter.field];
    if (filter.operator === "eq") return value === filter.value;
    if (filter.operator === "gte") return String(value) >= String(filter.value);
    throw new Error("unsupported audit fixture predicate");
  })).sort((left, right) => {
    const a = String(left.created_at), b = String(right.created_at);
    if (a !== b) return a < b ? 1 : -1;
    return String(left._id) < String(right._id) ? -1 : String(left._id) > String(right._id) ? 1 : 0;
  }).slice(query.skip ?? 0, (query.skip ?? 0) + (query.limit ?? 1000));
}

const EVENT_EQUAL = `AND ((json_type(body, '$.eventType') = 'text' AND json_extract(body, '$.eventType') = ?)
  OR (json_type(body, '$.eventType') = 'array' AND EXISTS (
    SELECT 1 FROM json_each(body, '$.eventType') item WHERE item.type = 'text' AND item.value = ?)))`;

/** A candidate only: the old index can reverse id order inside one exact date key. */
function twoPhaseLatest(sql: SqlStorage, eventType?: string): JsonDocument[] {
  const where = `collection = 'treatments' AND collection IN ('treatments', 'devicestatus') AND json_valid(body)
    ${eventType === undefined ? "" : EVENT_EQUAL}`;
  const bindings: SqlStorageValue[] = eventType === undefined ? [] : [eventType, eventType];
  const first = sql.exec<{ date_key: SqlStorageValue }>(
    `SELECT json_extract(body, '$.created_at') AS date_key
     FROM documents INDEXED BY documents_collection_created_at WHERE ${where}
     ORDER BY json_extract(body, '$.created_at') DESC LIMIT 1`, ...bindings,
  ).toArray()[0];
  if (first === undefined) return [];
  return sql.exec<{ id: string; body: string }>(
    `SELECT id, body FROM documents INDEXED BY documents_collection_created_at WHERE ${where}
     AND json_extract(body, '$.created_at') IS ? ORDER BY id ASC LIMIT 1`, ...bindings, first.date_key,
  ).toArray().map(row => ({ ...JSON.parse(row.body) as JsonDocument, _id: row.id }));
}

const AGE_SQL = `SELECT id, body, sort_time FROM documents
  WHERE collection = 'treatments' AND json_valid(body)
    AND json_type(body, '$.eventType') = 'text'
    AND ${TREATMENT_EVENT_TYPE_INDEX_VALUE_SQL} = ?
    AND sort_time >= ? AND sort_time <= ?
  ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1`;
const WINDOW_SQL = `SELECT id, body, sort_time FROM (
    SELECT id, body, sort_time, updated_at FROM documents
    WHERE collection = 'treatments' AND sort_time >= ? AND sort_time <= ?
    ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1000
  ) ORDER BY sort_time ASC, id ASC`;

describe("large old stores that defer native treatment read indexes", () => {
  it("measures uncached legacy queries and an existing-index count-one tie candidate above 20k treatments", async () => {
    const stub = env.ENTRY_STORE.getByName(`large-treatment-legacy-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (_instance, state) => {
      prepareOldStore(state.storage, 20_001);
      const evaluation = await measure(state.storage, () => migrateDocumentReadIndexesV31(state.storage.sql));
      expect(evaluation.result).toBe(false);
      expect(evaluation.writes).toBeLessThanOrEqual(16);
      const documents = fixtureDocuments(state.storage.sql);
      const repository = new SqliteDocumentRepository(state.storage);
      const cases = [
        { name: "latest-one-in-1000-ties", query: { limit: 1 } },
        { name: "present-category-in-1000-ties", query: { limit: 1, filters: [
          { field: "eventType", operator: "eq", value: "Sensor Change" }] } },
        { name: "missing-category-all-history", query: { limit: 1, filters: [
          { field: "eventType", operator: "eq", value: "Pump Battery Change" }] } },
        { name: "missing-category-four-days", query: { limit: 1, filters: [
          { field: "eventType", operator: "eq", value: "Pump Battery Change" },
          { field: "created_at", operator: "gte", value: new Date(START - 4 * DAY).toISOString() }] } },
        { name: "date-window-latest-one", query: { limit: 1, filters: [
          { field: "created_at", operator: "gte", value: new Date(START - 4 * DAY).toISOString() }] } },
      ] satisfies { name: string; query: DocumentQuery }[];
      const queries = [];
      for (const audit of cases) {
        const expected = fixtureOracle(documents, audit.query);
        const repeats = [];
        for (let repeat = 0; repeat < 2; repeat++) {
          const measured = await measure(state.storage, () => repository.queryLegacyTreatments(audit.query));
          expect(measured.result).toEqual(expected);
          expect(measured.writes).toBe(0);
          repeats.push({ repeat, returned: measured.result.length, reads: measured.reads, plans: measured.plans });
        }
        queries.push({ name: audit.name, repeats });
      }
      const candidates = [];
      for (const eventType of [undefined, "Sensor Change", "Pump Battery Change"]) {
        const measured = await measure(state.storage, () => twoPhaseLatest(state.storage.sql, eventType));
        const query: DocumentQuery = { limit: 1, ...(eventType === undefined ? {} : {
          filters: [{ field: "eventType", operator: "eq", value: eventType }],
        }) };
        expect(measured.result).toEqual(fixtureOracle(documents, query));
        candidates.push({ name: eventType ?? "all-categories", returned: measured.result.length,
          reads: measured.reads, writes: measured.writes, plans: measured.plans });
      }
      return { treatments: documents.length, nativeIndexesDeferred: true,
        evaluation: { reads: evaluation.reads, writes: evaluation.writes }, queries, twoPhaseCountOneCandidates: candidates };
    });
    console.info(`LARGE_TREATMENT_LEGACY=${JSON.stringify(report)}`);
    expect(report).toMatchInlineSnapshot(`
      {
        "evaluation": {
          "reads": 20010,
          "writes": 11,
        },
        "nativeIndexesDeferred": true,
        "queries": [
          {
            "name": "latest-one-in-1000-ties",
            "repeats": [
              {
                "plans": [
                  [
                    "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
                  ],
                  [
                    "SEARCH documents USING INDEX documents_collection_created_at (collection=? AND <expr>=?)",
                  ],
                ],
                "reads": 3,
                "repeat": 0,
                "returned": 1,
              },
              {
                "plans": [
                  [
                    "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
                  ],
                  [
                    "SEARCH documents USING INDEX documents_collection_created_at (collection=? AND <expr>=?)",
                  ],
                ],
                "reads": 3,
                "repeat": 1,
                "returned": 1,
              },
            ],
          },
          {
            "name": "present-category-in-1000-ties",
            "repeats": [
              {
                "plans": [
                  [
                    "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
                    "CORRELATED SCALAR SUBQUERY 1",
                    "SCAN item VIRTUAL TABLE INDEX 3:",
                  ],
                  [
                    "SEARCH documents USING INDEX documents_collection_created_at (collection=? AND <expr>=?)",
                    "CORRELATED SCALAR SUBQUERY 1",
                    "SCAN item VIRTUAL TABLE INDEX 3:",
                  ],
                ],
                "reads": 282,
                "repeat": 0,
                "returned": 1,
              },
              {
                "plans": [
                  [
                    "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
                    "CORRELATED SCALAR SUBQUERY 1",
                    "SCAN item VIRTUAL TABLE INDEX 3:",
                  ],
                  [
                    "SEARCH documents USING INDEX documents_collection_created_at (collection=? AND <expr>=?)",
                    "CORRELATED SCALAR SUBQUERY 1",
                    "SCAN item VIRTUAL TABLE INDEX 3:",
                  ],
                ],
                "reads": 282,
                "repeat": 1,
                "returned": 1,
              },
            ],
          },
          {
            "name": "missing-category-all-history",
            "repeats": [
              {
                "plans": [
                  [
                    "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
                    "CORRELATED SCALAR SUBQUERY 1",
                    "SCAN item VIRTUAL TABLE INDEX 3:",
                  ],
                ],
                "reads": 20002,
                "repeat": 0,
                "returned": 0,
              },
              {
                "plans": [
                  [
                    "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
                    "CORRELATED SCALAR SUBQUERY 1",
                    "SCAN item VIRTUAL TABLE INDEX 3:",
                  ],
                ],
                "reads": 20002,
                "repeat": 1,
                "returned": 0,
              },
            ],
          },
          {
            "name": "missing-category-four-days",
            "repeats": [
              {
                "plans": [
                  [
                    "SEARCH documents USING INDEX documents_collection_created_at (collection=? AND <expr>>?)",
                    "CORRELATED SCALAR SUBQUERY 1",
                    "SCAN item VIRTUAL TABLE INDEX 3:",
                    "CORRELATED SCALAR SUBQUERY 2",
                    "SCAN item VIRTUAL TABLE INDEX 3:",
                  ],
                ],
                "reads": 5762,
                "repeat": 0,
                "returned": 0,
              },
              {
                "plans": [
                  [
                    "SEARCH documents USING INDEX documents_collection_created_at (collection=? AND <expr>>?)",
                    "CORRELATED SCALAR SUBQUERY 1",
                    "SCAN item VIRTUAL TABLE INDEX 3:",
                    "CORRELATED SCALAR SUBQUERY 2",
                    "SCAN item VIRTUAL TABLE INDEX 3:",
                  ],
                ],
                "reads": 5762,
                "repeat": 1,
                "returned": 0,
              },
            ],
          },
          {
            "name": "date-window-latest-one",
            "repeats": [
              {
                "plans": [
                  [
                    "SEARCH documents USING INDEX documents_collection_created_at (collection=? AND <expr>>?)",
                    "CORRELATED SCALAR SUBQUERY 1",
                    "SCAN item VIRTUAL TABLE INDEX 3:",
                  ],
                  [
                    "SEARCH documents USING INDEX documents_collection_created_at (collection=? AND <expr>=?)",
                    "CORRELATED SCALAR SUBQUERY 1",
                    "SCAN item VIRTUAL TABLE INDEX 3:",
                  ],
                ],
                "reads": 3,
                "repeat": 0,
                "returned": 1,
              },
              {
                "plans": [
                  [
                    "SEARCH documents USING INDEX documents_collection_created_at (collection=? AND <expr>>?)",
                    "CORRELATED SCALAR SUBQUERY 1",
                    "SCAN item VIRTUAL TABLE INDEX 3:",
                  ],
                  [
                    "SEARCH documents USING INDEX documents_collection_created_at (collection=? AND <expr>=?)",
                    "CORRELATED SCALAR SUBQUERY 1",
                    "SCAN item VIRTUAL TABLE INDEX 3:",
                  ],
                ],
                "reads": 3,
                "repeat": 1,
                "returned": 1,
              },
            ],
          },
        ],
        "treatments": 20001,
        "twoPhaseCountOneCandidates": [
          {
            "name": "all-categories",
            "plans": [
              [
                "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
              ],
              [
                "SEARCH documents USING INDEX documents_collection_created_at (collection=? AND <expr>=?)",
              ],
            ],
            "reads": 2,
            "returned": 1,
            "writes": 0,
          },
          {
            "name": "Sensor Change",
            "plans": [
              [
                "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
                "CORRELATED SCALAR SUBQUERY 1",
                "SCAN item VIRTUAL TABLE INDEX 3:",
              ],
              [
                "SEARCH documents USING INDEX documents_collection_created_at (collection=? AND <expr>=?)",
                "CORRELATED SCALAR SUBQUERY 1",
                "SCAN item VIRTUAL TABLE INDEX 3:",
              ],
            ],
            "reads": 281,
            "returned": 1,
            "writes": 0,
          },
          {
            "name": "Pump Battery Change",
            "plans": [
              [
                "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
                "CORRELATED SCALAR SUBQUERY 1",
                "SCAN item VIRTUAL TABLE INDEX 3:",
              ],
            ],
            "reads": 20001,
            "returned": 0,
            "writes": 0,
          },
        ],
      }
    `);
  }, 60_000);

  it("measures common auxiliary misses, ordinary windows and repeated cold reads after genuine uploads", async () => {
    const stub = env.ENTRY_STORE.getByName(`large-treatment-aux-${crypto.randomUUID()}`);
    const { report, amortization } = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      prepareOldStore(state.storage, 20_001);
      expect(migrateDocumentReadIndexesV31(state.storage.sql)).toBe(false);
      const internal = instance as unknown as Internal;
      internal.treatmentCategoryIndexAvailable = undefined;
      internal.boundedTreatmentQueries.clear();
      const queries = [];
      const originalCategoryReads: number[] = [];
      const originalAge = async (bindings: SqlStorageValue[]): Promise<RawRow[]> => {
        // Execute the complete original indexed category predicate at the same
        // durable state, without shared candidates. This lower bound excludes
        // the old loader's future lookahead and metadata; no multiplication.
        const selected = await measure(state.storage, () => state.storage.sql.exec<RawRow>(
          AGE_SQL.replace("FROM documents", "FROM documents INDEXED BY documents_collection_sort"), ...bindings,
        ).toArray());
        expect(selected.writes).toBe(0);
        originalCategoryReads.push(selected.reads);
        return selected.result;
      };
      for (const [name, eventType, days] of [
        ["profile-switch", "Profile Switch", 372], ["age-battery", "Pump Battery Change", 62],
      ] as const) {
        internal.boundedTreatmentQueries.clear();
        const original = await originalAge([eventType, START - days * DAY, START]);
        const cold = await measure(state.storage, () => [...internal.cachedAuxiliaryRows(
          AGE_SQL, [eventType, START - days * DAY, START],
        )]);
        const warm = await measure(state.storage, () => [...internal.cachedAuxiliaryRows(
          AGE_SQL, [eventType, START - days * DAY + 1_000, START + 1_000],
        )]);
        expect(cold.result).toEqual([]);
        expect(cold.result).toEqual(original);
        expect(cold.writes).toBe(0); expect(warm.writes).toBe(0);
        expect(warm.result).toEqual([]);
        expect(warm.reads).toBe(0);
        queries.push({ name, cold: { reads: cold.reads, plans: cold.plans }, warm: { reads: warm.reads, calls: warm.calls } });
      }
      internal.boundedTreatmentQueries.clear();
      const window = await measure(state.storage, () => [...internal.cachedAuxiliaryRows(
        WINDOW_SQL, [START - 2.5 * DAY, START],
      )]);
      const warmWindow = await measure(state.storage, () => [...internal.cachedAuxiliaryRows(
        WINDOW_SQL, [START - 2.5 * DAY + 1_000, START + 1_000],
      )]);
      expect(window.result).toHaveLength(1000);
      expect(warmWindow.result).toEqual(window.result);

      const afterWrites = [];
      const options = JSON.stringify({ canCreate: true, canUpdate: true, actor: null,
        ifUnmodifiedSince: null, emitRealtime: true });
      for (let n = 0; n < 3; n++) {
        const at = START + (n + 2) * 1_000;
        expect(JSON.parse(await instance.api3CreateDocument("treatments", JSON.stringify({
          identifier: `large-old-store-note-${n}`, date: at, eventType: "Note", created_at: new Date(at).toISOString(),
          utcOffset: 0, app: "synthetic", note: "actual invalidating upload",
        }), options))).toMatchObject({ ok: true });
        const original = await originalAge(["Pump Battery Change", START - 62 * DAY + (n + 2) * 1_000, at]);
        const measured = await measure(state.storage, () => [...internal.cachedAuxiliaryRows(
          AGE_SQL, ["Pump Battery Change", START - 62 * DAY + (n + 2) * 1_000, at],
        )]);
        expect(measured.result).toEqual([]);
        expect(measured.result).toEqual(original); expect(measured.writes).toBe(0);
        afterWrites.push({ returned: 0, reads: measured.reads, plans: measured.plans });
      }
      const firstFiveReads = queries.reduce((sum, row) => sum+row.cold.reads, 0)
        + afterWrites.reduce((sum, row) => sum+row.reads, 0);
      const phase = () => {
        const value = internal.legacyTreatmentQueries.get(TREATMENT_MEMBERSHIP_VIEW_KEY);
        return value === undefined || value === "pending" || value === "rejected" ? value
          : String((JSON.parse(value) as unknown[])[1]);
      };
      const extra = [];
      for (let n = 3; n < 5; n++) {
        const at = START + (n + 2)*1000;
        const upload = await measure(state.storage, () => instance.api3CreateDocument("treatments", JSON.stringify({
          identifier: `large-old-store-note-${n}`, date: at, eventType: "Note", created_at: new Date(at).toISOString(),
          utcOffset: 0, app: "synthetic", note: "actual invalidating upload",
        }), options));
        expect(JSON.parse(upload.result)).toMatchObject({ ok: true });
        const bindings = ["Pump Battery Change", START - 62*DAY + (n + 2)*1000, at];
        const original = await originalAge(bindings);
        const selected = await measure(state.storage, () => [...internal.cachedAuxiliaryRows(AGE_SQL, bindings)]);
        expect(selected.result).toEqual(original); expect(selected.result).toEqual([]);
        expect(selected.writes).toBe(0); expect(phase()).toBe("complete");
        const sourceBuilds = selected.plans.filter(plan => plan.some(step => step.includes("sqlite_autoindex_documents_1"))).length;
        expect(sourceBuilds).toBe(n === 3 ? 1 : 0);
        if (n === 4) expect(selected.reads).toBeLessThan(10);
        extra.push({ request: n+3, reads: selected.reads, writes: selected.writes, phase: phase(), sourceBuilds,
          uploadReads: upload.reads, uploadWrites: upload.writes });
      }
      const currentSevenReads = firstFiveReads + extra.reduce((sum, row) => sum+row.reads, 0);
      const originalSevenCategoryReads = originalCategoryReads.reduce((sum, reads) => sum+reads, 0);
      expect(originalCategoryReads).toHaveLength(7);
      expect(currentSevenReads).toBeLessThan(originalSevenCategoryReads);
      return { report: { treatmentsBeforeUploads: 20_001, nativeIndexesDeferred: true, queries,
        ordinaryWindow: { returned: window.result.length, coldReads: window.reads, coldPlans: window.plans,
          warmReads: warmWindow.reads, warmCalls: warmWindow.calls },
        readCostsAfterEachUploadExcludeUploadItself: afterWrites }, amortization: {
        scope: "Seven selected category reads; current loader includes learning/future/metadata, original category SQL lower bound excludes lookahead/metadata; genuine uploads, ordinary window, warm repeats and oracles excluded from read totals.",
        firstFiveReads, extra, currentSevenReads, originalCategoryReads, originalSevenCategoryReads,
        extraReadWrites: extra.reduce((sum, row) => sum+row.writes, 0) } };
    });
    console.info(`LARGE_TREATMENT_AUX=${JSON.stringify(report)}`);
    console.info(`LARGE_AUX_AMORTIZATION=${JSON.stringify(amortization)}`);
    expect(report).toMatchInlineSnapshot(`
      {
        "nativeIndexesDeferred": true,
        "ordinaryWindow": {
          "coldPlans": [
            [
              "CO-ROUTINE (subquery-1)",
              "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>? AND sort_time<?)",
              "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
              "SCAN (subquery-1)",
              "USE TEMP B-TREE FOR ORDER BY",
            ],
            [
              "SEARCH documents USING COVERING INDEX documents_collection_sort (collection=? AND sort_time>?)",
            ],
          ],
          "coldReads": 3002,
          "returned": 1000,
          "warmCalls": 0,
          "warmReads": 0,
        },
        "queries": [
          {
            "cold": {
              "plans": [
                [
                  "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>? AND sort_time<?)",
                  "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                ],
                [
                  "SEARCH documents USING COVERING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                ],
              ],
              "reads": 20004,
            },
            "name": "profile-switch",
            "warm": {
              "calls": 0,
              "reads": 0,
            },
          },
          {
            "cold": {
              "plans": [
                [
                  "CO-ROUTINE (subquery-1)",
                  "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=?)",
                  "SCAN (subquery-1)",
                ],
                [
                  "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>? AND sort_time<?)",
                  "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                ],
                [
                  "SEARCH documents USING COVERING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                ],
              ],
              "reads": 25005,
            },
            "name": "age-battery",
            "warm": {
              "calls": 0,
              "reads": 0,
            },
          },
        ],
        "readCostsAfterEachUploadExcludeUploadItself": [
          {
            "plans": [
              [
                "CO-ROUTINE (subquery-1)",
                "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=? AND id>?)",
                "SCAN (subquery-1)",
              ],
              [
                "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>? AND sort_time<?)",
                "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
              ],
              [
                "SEARCH documents USING COVERING INDEX documents_collection_sort (collection=? AND sort_time>?)",
              ],
            ],
            "reads": 25006,
            "returned": 0,
          },
          {
            "plans": [
              [
                "CO-ROUTINE (subquery-1)",
                "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=? AND id>?)",
                "SCAN (subquery-1)",
              ],
              [
                "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>? AND sort_time<?)",
                "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
              ],
              [
                "SEARCH documents USING COVERING INDEX documents_collection_sort (collection=? AND sort_time>?)",
              ],
            ],
            "reads": 25007,
            "returned": 0,
          },
          {
            "plans": [
              [
                "CO-ROUTINE (subquery-1)",
                "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=? AND id>?)",
                "SCAN (subquery-1)",
              ],
              [
                "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>? AND sort_time<?)",
                "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
              ],
              [
                "SEARCH documents USING COVERING INDEX documents_collection_sort (collection=? AND sort_time>?)",
              ],
            ],
            "reads": 25008,
            "returned": 0,
          },
        ],
        "treatmentsBeforeUploads": 20001,
      }
    `);
  }, 60_000);

  it("measures total-table deferral and an isolated bounded side-table backfill prototype", async () => {
    const stub = env.ENTRY_STORE.getByName(`large-treatment-total-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (_instance, state) => {
      prepareOldStore(state.storage, 5000);
      state.storage.sql.exec(`WITH RECURSIVE sequence(n) AS (
        VALUES(0) UNION ALL SELECT n + 1 FROM sequence WHERE n < 95000
      ) INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
        SELECT 'food', printf('%024x', n), '{"type":"food"}', n, n, n FROM sequence`);
      const evaluation = await measure(state.storage, () => migrateDocumentReadIndexesV31(state.storage.sql));
      expect(evaluation.result).toBe(false);
      expect(evaluation.writes).toBeLessThanOrEqual(16);
      const repository = new SqliteDocumentRepository(state.storage);
      const missing = await measure(state.storage, () => repository.queryLegacyTreatments({ limit: 1,
        filters: [{ field: "eventType", operator: "eq", value: "Pump Battery Change" }] }));
      expect(missing.result).toEqual([]);

      // Prototype only, never a production read path. Empty side tables can
      // receive native indexes without scanning the canonical 100,001 rows.
      const setup = await measure(state.storage, () => {
        state.storage.sql.exec(`CREATE TABLE audit_treatment_read_keys (
          id TEXT PRIMARY KEY, date_key, event_type TEXT, event_value,
          sort_time INTEGER NOT NULL, updated_at INTEGER NOT NULL
        ) WITHOUT ROWID`);
        state.storage.sql.exec("CREATE INDEX audit_treatment_date ON audit_treatment_read_keys(date_key DESC, id ASC)");
        state.storage.sql.exec("CREATE INDEX audit_treatment_category ON audit_treatment_read_keys(event_type, event_value, date_key DESC, id ASC)");
        state.storage.sql.exec("CREATE TABLE audit_treatment_progress(singleton INTEGER PRIMARY KEY, last_id TEXT NOT NULL)");
        state.storage.sql.exec("INSERT INTO audit_treatment_progress VALUES(1, '')");
        return null;
      });
      const backfill = () => {
        const lastId = state.storage.sql.exec<{ last_id: string }>(
          "SELECT last_id FROM audit_treatment_progress WHERE singleton = 1",
        ).one().last_id;
        // Bound the unfiltered primary-key prefix first. Filtering valid JSON
        // before LIMIT could otherwise skip arbitrarily many malformed rows.
        const ids = state.storage.sql.exec<{ id: string }>(
          "SELECT id FROM documents WHERE collection = 'treatments' AND id > ? ORDER BY id ASC LIMIT 64", lastId,
        ).toArray();
        const nextId = ids.at(-1)?.id;
        if (nextId === undefined) return 0;
        state.storage.sql.exec(`INSERT OR REPLACE INTO audit_treatment_read_keys
          SELECT id, json_extract(body, '$.created_at'), json_type(body, '$.eventType'),
            ${TREATMENT_EVENT_TYPE_INDEX_VALUE_SQL}, sort_time, updated_at
          FROM documents WHERE collection = 'treatments' AND id > ? AND id <= ? AND json_valid(body)`, lastId, nextId);
        state.storage.sql.exec("UPDATE audit_treatment_progress SET last_id = ? WHERE singleton = 1", nextId);
        return ids.length;
      };
      const firstBatch = await measure(state.storage, () => state.storage.transactionSync(backfill));
      expect(firstBatch.result).toBe(64);
      expect(firstBatch.reads).toBeLessThan(300);
      const checkpoint = state.storage.sql.exec<{ last_id: string }>(
        "SELECT last_id FROM audit_treatment_progress WHERE singleton = 1",
      ).one().last_id;
      const rollbackAttempt = await measure(state.storage, () => {
        expect(() => state.storage.transactionSync(() => {
          expect(backfill()).toBe(64);
          throw new Error("synthetic side-backfill rollback");
        })).toThrow("synthetic side-backfill rollback");
        return null;
      });
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM audit_treatment_read_keys",
      ).one().count).toBe(64);
      expect(state.storage.sql.exec<{ last_id: string }>(
        "SELECT last_id FROM audit_treatment_progress WHERE singleton = 1",
      ).one().last_id).toBe(checkpoint);
      const resumed = await measure(state.storage, () => state.storage.transactionSync(backfill));
      expect(resumed.result).toBe(64);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM audit_treatment_read_keys",
      ).one().count).toBe(128);
      return { treatments: 5000, totalCanonicalDocuments: 100_001, nativeIndexesDeferred: true,
        evaluation: { reads: evaluation.reads, writes: evaluation.writes },
        missingCategory: { returned: missing.result.length, reads: missing.reads, plans: missing.plans },
        prototypeDoesNotServePartialResults: true,
        emptySideSchema: { reads: setup.reads, writes: setup.writes },
        first64: { reads: firstBatch.reads, writes: firstBatch.writes, plans: firstBatch.plans },
        rolledBack64Attempt: { reads: rollbackAttempt.reads, writes: rollbackAttempt.writes },
        resumed64: { reads: resumed.reads, writes: resumed.writes, plans: resumed.plans } };
    });
    console.info(`LARGE_TREATMENT_SIDE_PROTOTYPE=${JSON.stringify(report)}`);
    expect(report).toMatchInlineSnapshot(`
      {
        "emptySideSchema": {
          "reads": 7,
          "writes": 7,
        },
        "evaluation": {
          "reads": 105010,
          "writes": 11,
        },
        "first64": {
          "plans": [
            [
              "SEARCH documents USING COVERING INDEX sqlite_autoindex_documents_1 (collection=? AND id>?)",
            ],
          ],
          "reads": 131,
          "writes": 193,
        },
        "missingCategory": {
          "plans": [
            [
              "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
          ],
          "reads": 5001,
          "returned": 0,
        },
        "nativeIndexesDeferred": true,
        "prototypeDoesNotServePartialResults": true,
        "resumed64": {
          "plans": [
            [
              "SEARCH documents USING COVERING INDEX sqlite_autoindex_documents_1 (collection=? AND id>?)",
            ],
          ],
          "reads": 131,
          "writes": 193,
        },
        "rolledBack64Attempt": {
          "reads": 131,
          "writes": 193,
        },
        "totalCanonicalDocuments": 100001,
        "treatments": 5000,
      }
    `);
  }, 60_000);
  it("uses only the complete progressive index for large-history misses, date ties and genuine uploads", async () => {
    const stub = env.ENTRY_STORE.getByName(`large-treatment-completed-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      prepareOldStore(state.storage, 20_001);
      expect(migrateDocumentReadIndexesV31(state.storage.sql)).toBe(false);
      const internal = instance as unknown as Internal;
      internal.treatmentCategoryIndexAvailable = false;
      const repository = new SqliteDocumentRepository(state.storage);
      const documents = fixtureDocuments(state.storage.sql);
      const missingQuery: DocumentQuery = { limit: 1, filters: [
        { field: "eventType", operator: "eq", value: "Pump Battery Change" },
      ] };
      advance(state.storage, START);
      expect(readState(state.storage.sql)?.complete).toBe(false);
      const partial = await measure(state.storage, () => repository.queryLegacyTreatments(missingQuery));
      expect(partial.result).toEqual([]);
      expect(partial.reads).toBeGreaterThan(20_000);
      let at = START + MINUTE;
      const progress = await measure(state.storage, () => {
        const days = new Map<number, { rows: number; batches: number }>();
        while (!readState(state.storage.sql)!.complete) {
          const step = advance(state.storage, at);
          if (step.reason === "daily-budget") { at = (Math.floor(at / DAY) + 1) * DAY; continue; }
          if (step.advanced) {
            const day = Math.floor(at / DAY);
            const total = days.get(day) ?? { rows: 0, batches: 0 };
            total.rows += step.processed; total.batches++; days.set(day, total);
          }
          at += MINUTE;
        }
        for (const day of days.values()) expect(day.rows).toBeLessThanOrEqual(5000);
        return [...days.values()];
      });
      expect(readState(state.storage.sql)?.complete).toBe(true);
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM treatment_read_side_keys").one().count)
        .toBe(20_001);
      const queries = [];
      for (const query of [{ limit: 1 }, missingQuery, { limit: 3, skip: 17, filters: [
        { field: "eventType", operator: "eq", value: "Sensor Change" },
      ] }] satisfies DocumentQuery[]) {
        const measured = await measure(state.storage, () => repository.queryLegacyTreatments(query));
        expect(measured.result).toEqual(fixtureOracle(documents, query));
        expect(measured.writes).toBe(0);
        expect(measured.reads).toBeLessThan(100);
        queries.push({ query, reads: measured.reads, plans: measured.plans });
      }
      const auxiliaries = [];
      for (let upload = 0; upload < 3; upload++) {
        if (upload > 0) {
          const created = JSON.parse(await instance.api3CreateDocument("treatments", JSON.stringify({
          identifier: `side-complete-note-${upload}`, date: START + upload * MINUTE,
          eventType: "Note", created_at: new Date(START + upload * MINUTE).toISOString(), utcOffset: 0, app: "synthetic",
        }), JSON.stringify({ canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: true })));
          expect(created.ok, JSON.stringify(created)).toBe(true);
        }
        internal.boundedTreatmentQueries.clear();
        const measured = await measure(state.storage, () => [...internal.cachedAuxiliaryRows(
          AGE_SQL, ["Pump Battery Change", START - 62 * DAY, START + upload * MINUTE],
        )]);
        expect(measured.result).toEqual([]);
        expect(measured.reads).toBeLessThan(20);
        auxiliaries.push({ upload, reads: measured.reads, writes: measured.writes, plans: measured.plans });
      }
      return { treatments: 20_001, partialReads: partial.reads,
        remainingBackfill: { reads: progress.reads, writes: progress.writes, days: progress.result }, queries, auxiliaries };
    });
    console.info(`LARGE_TREATMENT_COMPLETE=${JSON.stringify(report)}`);
    expect(report).toMatchSnapshot();
  }, 60_000);

});
