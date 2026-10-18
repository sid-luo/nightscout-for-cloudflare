import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { migrateDocumentReadIndexesV31, SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import { filterDocuments } from "../src/documents";
import type { EntryStore, JsonDocument } from "../src/entry-store";
import worker from "../src/index";

const ORIGIN = "https://deep-read-audit.invalid";
const SECRET = "synthetic-deep-treatment-read-audit";
const AT = Date.parse("2026-10-18T12:00:00.000Z");
const id = (n: number) => n.toString(16).padStart(24, "0");
const LEGACY_ORDER = "json_extract(body, '$.created_at') DESC, id ASC";
const API3_ORDER = "sort_time DESC, srv_modified DESC, id ASC";
const EVENT_NOTE = `((json_type(body, '$.eventType') = 'text' AND json_extract(body, '$.eventType') = 'Note')
  OR (json_type(body, '$.eventType') = 'array' AND EXISTS (
    SELECT 1 FROM json_each(body, '$.eventType') AS item WHERE item.type = 'text' AND item.value = 'Note'))) `;
const EVENT_ABSENT = EVENT_NOTE.replaceAll("'Note'", "'Absent Synthetic Category'");

interface AuditCase {
  name: string; query: DocumentQuery; where?: string; bindings?: SqlStorageValue[]; order?: string; api3?: boolean;
}

function seedTreatments(sql: SqlStorage, count: number, arrays = false, tiedDates = false): void {
  sql.exec(`WITH RECURSIVE sequence(n) AS (
    VALUES(0) UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
  ), prepared AS (SELECT n, ? + CASE WHEN ? THEN 0 ELSE n * 1000 END AS event_at FROM sequence)
  INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,
    identifier_present,srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
  SELECT 'treatments', printf('%024x', n), json_object(
    '_id', printf('%024x', n), 'identifier', 'audit-' || n, 'date', event_at,
    'created_at', strftime('%Y-%m-%dT%H:%M:%fZ', event_at / 1000.0, 'unixepoch'),
    'eventType', json(?), 'marker', CASE WHEN n = 0 THEN 'oldest' ELSE 'other' END,
    'carbs', n % 7, 'srvCreated', event_at, 'srvModified', ? + n * 1000),
    event_at, event_at, ? + n * 1000, 'audit-' || n, 1,
    event_at, ? + n * 1000, ? + n * 1000, 1, 1, 1 FROM prepared`,
  count - 1, AT - count * 1000, tiedDates ? 1 : 0, JSON.stringify(arrays ? ["Note", "Other"] : "Note"), AT, AT, AT, AT);
}

function dropTreatmentReadIndexes(sql: SqlStorage): void {
  sql.exec("DROP INDEX IF EXISTS documents_treatments_created_at");
  sql.exec("DROP INDEX IF EXISTS documents_treatments_event_type_created_at");
}

/** Fixed pre-UNION query oracle; it does not rewrite the new query's SQL. */
function originalQuery(sql: SqlStorage, audit: AuditCase) {
  const cursor = sql.exec<{ id: string; body: string }>(`SELECT id, body FROM documents
    WHERE collection = 'treatments'
      ${audit.api3 ? "AND is_valid != 0" : "AND collection IN ('treatments', 'devicestatus') AND json_valid(body)"}
      ${audit.where === undefined ? "" : `AND ${audit.where}`}
    ORDER BY ${audit.order ?? (audit.api3 ? API3_ORDER : LEGACY_ORDER)} LIMIT ? OFFSET ?`,
  ...(audit.bindings ?? []), audit.query.limit ?? 1000, audit.query.skip ?? 0);
  const result = cursor.toArray().map(row => {
    const document = JSON.parse(row.body) as JsonDocument;
    if (audit.api3) delete document._id;
    else document._id = row.id;
    return document;
  });
  return { result, reads: cursor.rowsRead };
}

function measure<T>(sql: SqlStorage, action: () => T) {
  const exec = sql.exec.bind(sql);
  const statements: { statement: string; bindings: SqlStorageValue[]; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = exec(statement, ...bindings);
    statements.push({ statement, bindings, cursor });
    return cursor;
  });
  try {
    const result = action();
    return { result, reads: statements.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: statements.reduce((sum, item) => sum + item.cursor.rowsWritten, 0),
      dataReads: statements.filter(item => /\b(?:FROM|JOIN) documents\b/.test(item.statement))
        .reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      schemaReads: statements.filter(item => /\bFROM sqlite_master\b/.test(item.statement))
        .reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      plans: statements.filter(item => item.statement.startsWith("SELECT") && /\b(?:FROM|JOIN) documents\b/.test(item.statement)).flatMap(item =>
        exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${item.statement}`, ...item.bindings).toArray()
          .map(row => row.detail).filter(detail => detail.includes("USING") || detail.includes("TEMP B-TREE") || detail.includes("MERGE"))) };
  } finally { spy.mockRestore(); }
}

async function measureAsync<T>(sql: SqlStorage, action: () => Promise<T>) {
  const exec = sql.exec.bind(sql);
  const statements: { statement: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = exec(statement, ...bindings);
    statements.push({ statement, cursor });
    return cursor;
  });
  try {
    const result = await action();
    return { result, reads: statements.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: statements.reduce((sum, item) => sum + item.cursor.rowsWritten, 0),
      dataReads: statements.filter(item => /FROM documents\b/.test(item.statement))
        .map(item => ({ statement: item.statement.replace(/\s+/g, " ").trim(), reads: item.cursor.rowsRead })) };
  } finally { spy.mockRestore(); }
}

function forwardingEnvironment(instance: EntryStore): Parameters<typeof worker.fetch>[1] {
  const forwarded = new Proxy(instance, { get(target, property) {
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => forwarded }, API_SECRET: SECRET,
    AUTH_DEFAULT_ROLES: "readable", AUTH_FAIL_DELAY: "0" } as unknown as Parameters<typeof worker.fetch>[1];
}

describe("deep treatment and generic collection read audit", () => {
  it("audits common Profile, Activity, Food and role reads through their real HTTP handlers", async () => {
    const stub = env.ENTRY_STORE.getByName(`deep-generic-collections-${crypto.randomUUID()}`);
    const reports = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const sql = state.storage.sql;
      for (const collection of ["profile", "activity", "food", "roles"]) {
        sql.exec(`WITH RECURSIVE sequence(n) AS (
          VALUES(0) UNION ALL SELECT n + 1 FROM sequence WHERE n < 4999
        ) INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
          SELECT ?, printf('%024x', n), json_object('_id', printf('%024x', n),
            'name', 'audit-' || n, 'startDate', strftime('%Y-%m-%dT%H:%M:%fZ', (? + n * 1000) / 1000.0, 'unixepoch'),
            'created_at', strftime('%Y-%m-%dT%H:%M:%fZ', (? + n * 1000) / 1000.0, 'unixepoch'),
            'type', CASE WHEN n % 2 = 0 THEN 'food' ELSE 'quickpick' END,
            'hidden', 'false', 'position', n, 'permissions', json('[]')),
            ? + n * 1000, ? + n * 1000, ? + n * 1000 FROM sequence`,
        collection, AT, AT, AT, AT, AT);
      }
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(SECRET))),
        byte => byte.toString(16).padStart(2, "0")).join("");
      const paths = [
        "/api/v1/profile/current.json", "/api/v1/profile.json?count=1", "/api/v1/profiles.json?count=1",
        "/api/v1/activity.json?count=1", "/api/v1/food/regular.json?count=1",
        "/api/v1/food/quickpicks.json?count=1", "/api/v2/authorization/roles",
      ];
      const reports = [];
      for (const path of paths) {
        const collection = path.includes("authorization/roles") ? "roles"
          : path.includes("profile") ? "profile" : path.includes("activity") ? "activity" : "food";
        const all = JSON.parse(await instance.listDocuments(collection)) as JsonDocument[];
        const url = new URL(ORIGIN + path);
        const expected = collection === "profile"
          ? path.includes("/current") ? all[0] ?? null : all.slice(0, 1)
          : collection === "activity" ? filterDocuments(all, url, 5000)
            : collection === "food" ? all.filter(row => row.type === (path.includes("quickpicks") ? "quickpick" : "food"))
              .sort((a, b) => path.includes("quickpicks") ? Number(a.position) - Number(b.position) : 0)
              : null;
        const repeats = [];
        for (let repeat = 0; repeat < 2; repeat++) {
          const actual = await measureAsync(sql, async () => {
            const response = await worker.fetch(new Request(ORIGIN + path, { headers: { "api-secret": digest } }), forwardingEnvironment(instance));
            expect(response.status, path).toBe(200);
            return response.json<JsonDocument[] | JsonDocument | null>();
          });
          if (collection === "roles") {
            expect(Array.isArray(actual.result)).toBe(true);
            const stored = (actual.result as JsonDocument[]).filter(row => typeof row._id === "string");
            expect(stored).toEqual([...all].sort((left, right) => String(left.name).localeCompare(String(right.name))));
          } else expect(actual.result, path).toEqual(expected);
          expect(actual.writes).toBe(0);
          repeats.push({ reads: actual.reads, dataReads: actual.dataReads,
            returned: Array.isArray(actual.result) ? actual.result.length : actual.result === null ? 0 : 1 });
        }
        reports.push({ path, repeats });
      }
      const anonymous = [];
      for (let repeat = 0; repeat < 2; repeat++) {
        const actual = await measureAsync(sql, async () => {
          const response = await worker.fetch(new Request(`${ORIGIN}/api/v1/activity.json?count=1`), forwardingEnvironment(instance));
          expect(response.status).toBe(200);
          return response.json<JsonDocument[]>();
        });
        expect(actual.writes).toBe(0);
        anonymous.push({ reads: actual.reads, returned: actual.result.length, dataReads: actual.dataReads });
      }
      reports.push({ path: "/api/v1/activity.json?count=1 [anonymous/default role]", repeats: anonymous });
      return reports;
    });
    expect(reports).toMatchInlineSnapshot(`
      [
        {
          "path": "/api/v1/profile/current.json",
          "repeats": [
            {
              "dataReads": [
                {
                  "reads": 1,
                  "statement": "SELECT id, CASE WHEN typeof(body)='text' AND length(CAST(body AS BLOB))<=131072 THEN body ELSE NULL END AS body, CASE WHEN typeof(body)='text' AND length(CAST(body AS BLOB))<=131072 THEN json_valid(body) ELSE 0 END AS valid_json FROM documents WHERE collection='profile' ORDER BY id DESC LIMIT 1",
                },
                {
                  "reads": 5000,
                  "statement": "SELECT id, CASE WHEN typeof(body)='text' AND length(CAST(body AS BLOB))<=131072 THEN body ELSE NULL END AS body, CASE WHEN typeof(body)='text' AND length(CAST(body AS BLOB))<=131072 THEN json_valid(body) ELSE 0 END AS valid_json FROM documents WHERE collection='profile' AND id < ? ORDER BY id ASC LIMIT 10000",
                },
                {
                  "reads": 1,
                  "statement": "SELECT id, body, sort_time FROM documents WHERE collection='profile' AND json_valid(body) ORDER BY json_extract(body, '$.startDate') DESC, id DESC LIMIT 1",
                },
              ],
              "reads": 5008,
              "returned": 1,
            },
            {
              "dataReads": [
                {
                  "reads": 1,
                  "statement": "SELECT id, CASE WHEN typeof(body)='text' AND length(CAST(body AS BLOB))<=131072 THEN body ELSE NULL END AS body, CASE WHEN typeof(body)='text' AND length(CAST(body AS BLOB))<=131072 THEN json_valid(body) ELSE 0 END AS valid_json FROM documents WHERE collection='profile' ORDER BY id DESC LIMIT 1",
                },
                {
                  "reads": 5000,
                  "statement": "SELECT id, CASE WHEN typeof(body)='text' AND length(CAST(body AS BLOB))<=131072 THEN body ELSE NULL END AS body, CASE WHEN typeof(body)='text' AND length(CAST(body AS BLOB))<=131072 THEN json_valid(body) ELSE 0 END AS valid_json FROM documents WHERE collection='profile' AND id < ? ORDER BY id ASC LIMIT 10000",
                },
                {
                  "reads": 1,
                  "statement": "SELECT id, body, sort_time FROM documents WHERE collection='profile' AND json_valid(body) ORDER BY json_extract(body, '$.startDate') DESC, id DESC LIMIT 1",
                },
              ],
              "reads": 5008,
              "returned": 1,
            },
          ],
        },
        {
          "path": "/api/v1/profile.json?count=1",
          "repeats": [
            {
              "dataReads": [
                {
                  "reads": 10001,
                  "statement": "SELECT id, body, sort_time FROM documents WHERE collection = ? ORDER BY CASE WHEN json_valid(body) THEN json_extract(body, '$.startDate') ELSE NULL END DESC, id DESC LIMIT ?",
                },
              ],
              "reads": 10007,
              "returned": 1,
            },
            {
              "dataReads": [
                {
                  "reads": 10001,
                  "statement": "SELECT id, body, sort_time FROM documents WHERE collection = ? ORDER BY CASE WHEN json_valid(body) THEN json_extract(body, '$.startDate') ELSE NULL END DESC, id DESC LIMIT ?",
                },
              ],
              "reads": 10007,
              "returned": 1,
            },
          ],
        },
        {
          "path": "/api/v1/profiles.json?count=1",
          "repeats": [
            {
              "dataReads": [
                {
                  "reads": 10001,
                  "statement": "SELECT id, body, sort_time FROM documents WHERE collection = ? ORDER BY CASE WHEN json_valid(body) THEN json_extract(body, '$.startDate') ELSE NULL END DESC, id DESC LIMIT ?",
                },
              ],
              "reads": 10007,
              "returned": 1,
            },
            {
              "dataReads": [
                {
                  "reads": 10001,
                  "statement": "SELECT id, body, sort_time FROM documents WHERE collection = ? ORDER BY CASE WHEN json_valid(body) THEN json_extract(body, '$.startDate') ELSE NULL END DESC, id DESC LIMIT ?",
                },
              ],
              "reads": 10007,
              "returned": 1,
            },
          ],
        },
        {
          "path": "/api/v1/activity.json?count=1",
          "repeats": [
            {
              "dataReads": [
                {
                  "reads": 10001,
                  "statement": "SELECT id, body, sort_time FROM documents WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT ?",
                },
              ],
              "reads": 10007,
              "returned": 1,
            },
            {
              "dataReads": [
                {
                  "reads": 10001,
                  "statement": "SELECT id, body, sort_time FROM documents WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT ?",
                },
              ],
              "reads": 10007,
              "returned": 1,
            },
          ],
        },
        {
          "path": "/api/v1/food/regular.json?count=1",
          "repeats": [
            {
              "dataReads": [
                {
                  "reads": 10001,
                  "statement": "SELECT id, body, sort_time FROM documents WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT ?",
                },
              ],
              "reads": 10007,
              "returned": 2500,
            },
            {
              "dataReads": [
                {
                  "reads": 10001,
                  "statement": "SELECT id, body, sort_time FROM documents WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT ?",
                },
              ],
              "reads": 10007,
              "returned": 2500,
            },
          ],
        },
        {
          "path": "/api/v1/food/quickpicks.json?count=1",
          "repeats": [
            {
              "dataReads": [
                {
                  "reads": 10001,
                  "statement": "SELECT id, body, sort_time FROM documents WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT ?",
                },
              ],
              "reads": 10007,
              "returned": 2500,
            },
            {
              "dataReads": [
                {
                  "reads": 10001,
                  "statement": "SELECT id, body, sort_time FROM documents WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT ?",
                },
              ],
              "reads": 10007,
              "returned": 2500,
            },
          ],
        },
        {
          "path": "/api/v2/authorization/roles",
          "repeats": [
            {
              "dataReads": [
                {
                  "reads": 10000,
                  "statement": "SELECT id, body, sort_time FROM documents WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT ?",
                },
              ],
              "reads": 10006,
              "returned": 5007,
            },
            {
              "dataReads": [
                {
                  "reads": 10000,
                  "statement": "SELECT id, body, sort_time FROM documents WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT ?",
                },
              ],
              "reads": 10006,
              "returned": 5007,
            },
          ],
        },
        {
          "path": "/api/v1/activity.json?count=1 [anonymous/default role]",
          "repeats": [
            {
              "dataReads": [
                {
                  "reads": 10000,
                  "statement": "SELECT id, body, sort_time FROM documents WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT ?",
                },
                {
                  "reads": 10001,
                  "statement": "SELECT id, body, sort_time FROM documents WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT ?",
                },
              ],
              "reads": 20007,
              "returned": 1,
            },
            {
              "dataReads": [
                {
                  "reads": 10000,
                  "statement": "SELECT id, body, sort_time FROM documents WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT ?",
                },
                {
                  "reads": 10001,
                  "statement": "SELECT id, body, sort_time FROM documents WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT ?",
                },
              ],
              "reads": 20007,
              "returned": 1,
            },
          ],
        },
      ]
    `);
  }, 30_000);
  it("measures uncached repeats when large treatment histories defer the optional native index migration", async () => {
    const stub = env.ENTRY_STORE.getByName(`deep-deferred-treatment-${crypto.randomUUID()}`);
    const reports = await runInDurableObject(stub, (_instance, state) => {
      dropTreatmentReadIndexes(state.storage.sql);
      seedTreatments(state.storage.sql, 20_001);
      expect(migrateDocumentReadIndexesV31(state.storage.sql)).toBe(false);
      const repository = new SqliteDocumentRepository(state.storage);
      const audit: AuditCase = { name: "deferred-missing-category", query: { limit: 1,
        filters: [{ field: "eventType", operator: "eq", value: "Absent Synthetic Category" }] }, where: EVENT_ABSENT };
      const oracle = originalQuery(state.storage.sql, audit);
      return Array.from({ length: 3 }, () => {
        const actual = measure(state.storage.sql, () => repository.queryLegacyTreatments(audit.query));
        expect(actual.result).toEqual(oracle.result);
        expect(actual.writes).toBe(0);
        // An incomplete side schema contributes one committed-state read,
        // while the original all-history predicate still runs on documents.
        expect(actual.reads).toBeLessThanOrEqual(oracle.reads + 1);
        expect(actual.plans.some(plan => plan.includes("treatment_read_side"))).toBe(false);
        return { treatments: 20_001, returned: actual.result.length, oracleReads: oracle.reads,
          reads: actual.reads, plans: actual.plans };
      });
    });
    expect(reports).toMatchInlineSnapshot(`
      [
        {
          "oracleReads": 20002,
          "plans": [
            "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
          ],
          "reads": 20002,
          "returned": 0,
          "treatments": 20001,
        },
        {
          "oracleReads": 20002,
          "plans": [
            "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
          ],
          "reads": 20002,
          "returned": 0,
          "treatments": 20001,
        },
        {
          "oracleReads": 20002,
          "plans": [
            "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
          ],
          "reads": 20002,
          "returned": 0,
          "treatments": 20001,
        },
      ]
    `);
  }, 30_000);

  it("measures deferred treatment queries when unrelated canonical history exceeds the total migration cap", async () => {
    const stub = env.ENTRY_STORE.getByName(`deep-deferred-total-${crypto.randomUUID()}`);
    const reports = await runInDurableObject(stub, (_instance, state) => {
      dropTreatmentReadIndexes(state.storage.sql);
      seedTreatments(state.storage.sql, 5000);
      state.storage.sql.exec(`WITH RECURSIVE sequence(n) AS (
        VALUES(0) UNION ALL SELECT n + 1 FROM sequence WHERE n < 95000
      ) INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
        SELECT 'food', printf('%024x', n), '{"type":"food"}', n, n, n FROM sequence`);
      expect(migrateDocumentReadIndexesV31(state.storage.sql)).toBe(false);
      const repository = new SqliteDocumentRepository(state.storage);
      const audit: AuditCase = { name: "total-cap-missing-category", query: { limit: 1,
        filters: [{ field: "eventType", operator: "eq", value: "Absent Synthetic Category" }] }, where: EVENT_ABSENT };
      const oracle = originalQuery(state.storage.sql, audit);
      return Array.from({ length: 3 }, () => {
        const actual = measure(state.storage.sql, () => repository.queryLegacyTreatments(audit.query));
        expect(actual.result).toEqual(oracle.result);
        expect(actual.writes).toBe(0);
        expect(actual.reads).toBeLessThanOrEqual(oracle.reads + 1);
        expect(actual.plans.some(plan => plan.includes("treatment_read_side"))).toBe(false);
        return { treatments: 5000, totalDocuments: 100_001, returned: actual.result.length,
          oracleReads: oracle.reads, reads: actual.reads, plans: actual.plans };
      });
    });
    expect(reports).toMatchInlineSnapshot(`
      [
        {
          "oracleReads": 5001,
          "plans": [
            "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
          ],
          "reads": 5001,
          "returned": 0,
          "totalDocuments": 100001,
          "treatments": 5000,
        },
        {
          "oracleReads": 5001,
          "plans": [
            "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
          ],
          "reads": 5001,
          "returned": 0,
          "totalDocuments": 100001,
          "treatments": 5000,
        },
        {
          "oracleReads": 5001,
          "plans": [
            "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
          ],
          "reads": 5001,
          "returned": 0,
          "totalDocuments": 100001,
          "treatments": 5000,
        },
      ]
    `);
  }, 30_000);
  it("compares scalar and dense-array UNION reads to the complete former query, including selective ids and deep offsets", async () => {
    const reports = [];
    for (const arrays of [false, true]) {
      const stub = env.ENTRY_STORE.getByName(`deep-treatment-distribution-${arrays}-${crypto.randomUUID()}`);
      reports.push(...await runInDurableObject(stub, (_instance, state) => {
        seedTreatments(state.storage.sql, 5000, arrays);
        const repository = new SqliteDocumentRepository(state.storage);
        const note = { field: "eventType", operator: "eq" as const, value: "Note" };
        const cases: AuditCase[] = [
          { name: "latest-category-limit1", query: { limit: 1, filters: [note] }, where: EVENT_NOTE },
          { name: "absent-category-limit1", query: { limit: 1, filters: [{ ...note, value: "Absent Synthetic Category" }] }, where: EVENT_ABSENT },
          { name: "point-id-and-category", query: { limit: 1, filters: [note, { field: "_id", operator: "eq", value: id(0) }] }, where: `${EVENT_NOTE} AND id = ?`, bindings: [id(0)] },
          { name: "unmatched-second-predicate", query: { limit: 1, filters: [note, { field: "carbs", operator: "eq", value: -1 }] }, where: `${EVENT_NOTE} AND json_type(body, '$.carbs') IN ('integer','real') AND json_extract(body, '$.carbs') = -1` },
          { name: "oldest-marker-match", query: { limit: 1, filters: [note, { field: "marker", operator: "eq", value: "oldest" }] }, where: `${EVENT_NOTE} AND json_type(body, '$.marker') = 'text' AND json_extract(body, '$.marker') = 'oldest'` },
          { name: "category-deep-offset4000", query: { limit: 1, skip: 4000, filters: [note] }, where: EVENT_NOTE },
          { name: "unfiltered-deep-offset4000", query: { limit: 1, skip: 4000 } },
          { name: "explicit-default-equivalent-sort", query: { limit: 1, filters: [note], sort: [{ field: "created_at", direction: "desc" }, { field: "_id", direction: "asc" }] }, where: EVENT_NOTE },
          { name: "explicit-date-desc-sort", query: { limit: 1, filters: [note], sort: { field: "created_at", direction: "desc" } }, where: EVENT_NOTE, order: "json_extract(body, '$.created_at') DESC, id DESC" },
        ];
        return cases.map(audit => {
          const oracle = originalQuery(state.storage.sql, audit);
          const actual = measure(state.storage.sql, () => repository.queryLegacyTreatments(audit.query));
          expect(actual.result, `${arrays ? "array" : "scalar"}:${audit.name}`).toEqual(oracle.result);
          expect(actual.writes).toBe(0);
          if (["latest-category-limit1", "point-id-and-category", "explicit-default-equivalent-sort", "explicit-date-desc-sort"].includes(audit.name)) {
            expect(actual.reads, `${arrays ? "array" : "scalar"}:${audit.name}`).toBeLessThan(30);
          }
          if (audit.name === "category-deep-offset4000") {
            expect(actual.reads, `${arrays ? "array" : "scalar"}:streamed-offset`).toBeLessThanOrEqual(oracle.reads + 30);
          }
          return { distribution: arrays ? "dense-array" : "scalar", query: audit.name,
            returned: actual.result.length, oracleReads: oracle.reads, reads: actual.reads, plans: actual.plans };
        });
      }));
    }
    expect(reports).toMatchInlineSnapshot(`
      [
        {
          "distribution": "scalar",
          "oracleReads": 1,
          "plans": [
            "MERGE (UNION ALL)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
          ],
          "query": "latest-category-limit1",
          "reads": 1,
          "returned": 1,
        },
        {
          "distribution": "scalar",
          "oracleReads": 5000,
          "plans": [
            "MERGE (UNION ALL)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
          ],
          "query": "absent-category-limit1",
          "reads": 0,
          "returned": 0,
        },
        {
          "distribution": "scalar",
          "oracleReads": 1,
          "plans": [
            "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=? AND id=?)",
          ],
          "query": "point-id-and-category",
          "reads": 1,
          "returned": 1,
        },
        {
          "distribution": "scalar",
          "oracleReads": 5000,
          "plans": [
            "MERGE (UNION ALL)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
          ],
          "query": "unmatched-second-predicate",
          "reads": 5000,
          "returned": 0,
        },
        {
          "distribution": "scalar",
          "oracleReads": 5000,
          "plans": [
            "MERGE (UNION ALL)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
          ],
          "query": "oldest-marker-match",
          "reads": 5000,
          "returned": 1,
        },
        {
          "distribution": "scalar",
          "oracleReads": 4001,
          "plans": [
            "MERGE (UNION ALL)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
          ],
          "query": "category-deep-offset4000",
          "reads": 4001,
          "returned": 1,
        },
        {
          "distribution": "scalar",
          "oracleReads": 4001,
          "plans": [
            "SEARCH documents USING INDEX documents_treatments_created_at (collection=?)",
          ],
          "query": "unfiltered-deep-offset4000",
          "reads": 4001,
          "returned": 1,
        },
        {
          "distribution": "scalar",
          "oracleReads": 1,
          "plans": [
            "MERGE (UNION ALL)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
          ],
          "query": "explicit-default-equivalent-sort",
          "reads": 1,
          "returned": 1,
        },
        {
          "distribution": "scalar",
          "oracleReads": 1,
          "plans": [
            "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
          ],
          "query": "explicit-date-desc-sort",
          "reads": 1,
          "returned": 1,
        },
        {
          "distribution": "dense-array",
          "oracleReads": 1,
          "plans": [
            "MERGE (UNION ALL)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
          ],
          "query": "latest-category-limit1",
          "reads": 1,
          "returned": 1,
        },
        {
          "distribution": "dense-array",
          "oracleReads": 15000,
          "plans": [
            "MERGE (UNION ALL)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
          ],
          "query": "absent-category-limit1",
          "reads": 5000,
          "returned": 0,
        },
        {
          "distribution": "dense-array",
          "oracleReads": 1,
          "plans": [
            "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=? AND id=?)",
          ],
          "query": "point-id-and-category",
          "reads": 1,
          "returned": 1,
        },
        {
          "distribution": "dense-array",
          "oracleReads": 5000,
          "plans": [
            "MERGE (UNION ALL)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
          ],
          "query": "unmatched-second-predicate",
          "reads": 5000,
          "returned": 0,
        },
        {
          "distribution": "dense-array",
          "oracleReads": 5000,
          "plans": [
            "MERGE (UNION ALL)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
          ],
          "query": "oldest-marker-match",
          "reads": 5000,
          "returned": 1,
        },
        {
          "distribution": "dense-array",
          "oracleReads": 4001,
          "plans": [
            "MERGE (UNION ALL)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
          ],
          "query": "category-deep-offset4000",
          "reads": 4001,
          "returned": 1,
        },
        {
          "distribution": "dense-array",
          "oracleReads": 4001,
          "plans": [
            "SEARCH documents USING INDEX documents_treatments_created_at (collection=?)",
          ],
          "query": "unfiltered-deep-offset4000",
          "reads": 4001,
          "returned": 1,
        },
        {
          "distribution": "dense-array",
          "oracleReads": 1,
          "plans": [
            "MERGE (UNION ALL)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
            "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
          ],
          "query": "explicit-default-equivalent-sort",
          "reads": 1,
          "returned": 1,
        },
        {
          "distribution": "dense-array",
          "oracleReads": 1,
          "plans": [
            "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
          ],
          "query": "explicit-date-desc-sort",
          "reads": 1,
          "returned": 1,
        },
      ]
    `);
  }, 30_000);

  it("measures repeated API3 category and tie queries independently of legacy result caches", async () => {
    const reports = [];
    for (const tiedDates of [false, true]) {
      const stub = env.ENTRY_STORE.getByName(`deep-api3-treatment-${tiedDates}-${crypto.randomUUID()}`);
      reports.push(...await runInDurableObject(stub, (_instance, state) => {
        seedTreatments(state.storage.sql, 5000, false, tiedDates);
        const repository = new SqliteDocumentRepository(state.storage);
        const cases: AuditCase[] = [
          { name: "latest-api3-limit1", api3: true, query: { limit: 1 } },
          { name: "existing-api3-category", api3: true, query: { limit: 1, filters: [{ field: "eventType", operator: "eq", value: "Note" }] }, where: EVENT_NOTE },
          { name: "missing-api3-category", api3: true, query: { limit: 1, filters: [{ field: "eventType", operator: "eq", value: "Absent Synthetic Category" }] }, where: EVENT_ABSENT },
          { name: "point-api3-identifier", api3: true, query: { limit: 1, filters: [{ field: "identifier", operator: "eq", value: "audit-0" }] }, where: "identifier = 'audit-0'" },
        ];
        return cases.map(audit => {
          const oracle = originalQuery(state.storage.sql, audit);
          const repeats = Array.from({ length: 3 }, (_, repeat) => {
            const actual = measure(state.storage.sql, () => repository.queryTreatments(audit.query));
            expect(actual.result, audit.name).toEqual(oracle.result);
            expect(actual.writes).toBe(0);
            expect(actual.reads).toBe(actual.dataReads + actual.schemaReads);
            if (repeat > 0) expect(actual.schemaReads).toBeLessThanOrEqual(1);
            if (audit.name === "latest-api3-limit1") expect(actual.dataReads).toBeLessThanOrEqual(oracle.reads);
            if (audit.name === "point-api3-identifier") expect(actual.dataReads).toBeLessThan(30);
            if (audit.name === "missing-api3-category") expect(actual.dataReads).toBeLessThanOrEqual(20);
            if (audit.name === "existing-api3-category") {
              // The covered 17-key admission probe must leave a dense
              // category on its preceding SQL plan, with bounded overhead.
              expect(actual.dataReads).toBeLessThanOrEqual(oracle.reads + 20);
            }
            return { reads: actual.reads, dataReads: actual.dataReads, schemaReads: actual.schemaReads, plans: actual.plans };
          });
          return { timestamps: tiedDates ? "all-equal" : "distinct", query: audit.name,
            returned: oracle.result.length, oracleReads: oracle.reads, repeats };
        });
      }));
    }
    expect(reports).toMatchInlineSnapshot(`
      [
        {
          "oracleReads": 1,
          "query": "latest-api3-limit1",
          "repeats": [
            {
              "dataReads": 1,
              "plans": [
                "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              ],
              "reads": 2,
              "schemaReads": 1,
            },
            {
              "dataReads": 1,
              "plans": [
                "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              ],
              "reads": 2,
              "schemaReads": 1,
            },
            {
              "dataReads": 1,
              "plans": [
                "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              ],
              "reads": 2,
              "schemaReads": 1,
            },
          ],
          "returned": 1,
          "timestamps": "distinct",
        },
        {
          "oracleReads": 1,
          "query": "existing-api3-category",
          "repeats": [
            {
              "dataReads": 18,
              "plans": [
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              ],
              "reads": 19,
              "schemaReads": 1,
            },
            {
              "dataReads": 18,
              "plans": [
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              ],
              "reads": 19,
              "schemaReads": 1,
            },
            {
              "dataReads": 18,
              "plans": [
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              ],
              "reads": 19,
              "schemaReads": 1,
            },
          ],
          "returned": 1,
          "timestamps": "distinct",
        },
        {
          "oracleReads": 5000,
          "query": "missing-api3-category",
          "repeats": [
            {
              "dataReads": 2,
              "plans": [
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "MERGE (UNION ALL)",
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "USE TEMP B-TREE FOR ORDER BY",
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "USE TEMP B-TREE FOR ORDER BY",
              ],
              "reads": 3,
              "schemaReads": 1,
            },
            {
              "dataReads": 2,
              "plans": [
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "MERGE (UNION ALL)",
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "USE TEMP B-TREE FOR ORDER BY",
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "USE TEMP B-TREE FOR ORDER BY",
              ],
              "reads": 3,
              "schemaReads": 1,
            },
            {
              "dataReads": 2,
              "plans": [
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "MERGE (UNION ALL)",
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "USE TEMP B-TREE FOR ORDER BY",
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "USE TEMP B-TREE FOR ORDER BY",
              ],
              "reads": 3,
              "schemaReads": 1,
            },
          ],
          "returned": 0,
          "timestamps": "distinct",
        },
        {
          "oracleReads": 5000,
          "query": "point-api3-identifier",
          "repeats": [
            {
              "dataReads": 3,
              "plans": [
                "SEARCH documents USING INDEX documents_collection_identifier (collection=? AND identifier=?)",
                "USE TEMP B-TREE FOR ORDER BY",
              ],
              "reads": 3,
              "schemaReads": 0,
            },
            {
              "dataReads": 3,
              "plans": [
                "SEARCH documents USING INDEX documents_collection_identifier (collection=? AND identifier=?)",
                "USE TEMP B-TREE FOR ORDER BY",
              ],
              "reads": 3,
              "schemaReads": 0,
            },
            {
              "dataReads": 3,
              "plans": [
                "SEARCH documents USING INDEX documents_collection_identifier (collection=? AND identifier=?)",
                "USE TEMP B-TREE FOR ORDER BY",
              ],
              "reads": 3,
              "schemaReads": 0,
            },
          ],
          "returned": 1,
          "timestamps": "distinct",
        },
        {
          "oracleReads": 1,
          "query": "latest-api3-limit1",
          "repeats": [
            {
              "dataReads": 1,
              "plans": [
                "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              ],
              "reads": 2,
              "schemaReads": 1,
            },
            {
              "dataReads": 1,
              "plans": [
                "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              ],
              "reads": 2,
              "schemaReads": 1,
            },
            {
              "dataReads": 1,
              "plans": [
                "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              ],
              "reads": 2,
              "schemaReads": 1,
            },
          ],
          "returned": 1,
          "timestamps": "all-equal",
        },
        {
          "oracleReads": 1,
          "query": "existing-api3-category",
          "repeats": [
            {
              "dataReads": 18,
              "plans": [
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              ],
              "reads": 19,
              "schemaReads": 1,
            },
            {
              "dataReads": 18,
              "plans": [
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              ],
              "reads": 19,
              "schemaReads": 1,
            },
            {
              "dataReads": 18,
              "plans": [
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              ],
              "reads": 19,
              "schemaReads": 1,
            },
          ],
          "returned": 1,
          "timestamps": "all-equal",
        },
        {
          "oracleReads": 5000,
          "query": "missing-api3-category",
          "repeats": [
            {
              "dataReads": 2,
              "plans": [
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "MERGE (UNION ALL)",
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "USE TEMP B-TREE FOR ORDER BY",
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "USE TEMP B-TREE FOR ORDER BY",
              ],
              "reads": 3,
              "schemaReads": 1,
            },
            {
              "dataReads": 2,
              "plans": [
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "MERGE (UNION ALL)",
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "USE TEMP B-TREE FOR ORDER BY",
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "USE TEMP B-TREE FOR ORDER BY",
              ],
              "reads": 3,
              "schemaReads": 1,
            },
            {
              "dataReads": 2,
              "plans": [
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "MERGE (UNION ALL)",
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "USE TEMP B-TREE FOR ORDER BY",
                "SEARCH documents USING INDEX documents_treatments_event_type_created_at (collection=? AND <expr>=? AND <expr>=?)",
                "USE TEMP B-TREE FOR ORDER BY",
              ],
              "reads": 3,
              "schemaReads": 1,
            },
          ],
          "returned": 0,
          "timestamps": "all-equal",
        },
        {
          "oracleReads": 5000,
          "query": "point-api3-identifier",
          "repeats": [
            {
              "dataReads": 3,
              "plans": [
                "SEARCH documents USING INDEX documents_collection_identifier (collection=? AND identifier=?)",
                "USE TEMP B-TREE FOR ORDER BY",
              ],
              "reads": 3,
              "schemaReads": 0,
            },
            {
              "dataReads": 3,
              "plans": [
                "SEARCH documents USING INDEX documents_collection_identifier (collection=? AND identifier=?)",
                "USE TEMP B-TREE FOR ORDER BY",
              ],
              "reads": 3,
              "schemaReads": 0,
            },
            {
              "dataReads": 3,
              "plans": [
                "SEARCH documents USING INDEX documents_collection_identifier (collection=? AND identifier=?)",
                "USE TEMP B-TREE FOR ORDER BY",
              ],
              "reads": 3,
              "schemaReads": 0,
            },
          ],
          "returned": 1,
          "timestamps": "all-equal",
        },
      ]
    `);
  }, 30_000);
});
