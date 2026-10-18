import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository } from "../src/document-repository";
import { entryStoreSchemaIsActivationReady, type EntryStore, type JsonDocument } from "../src/entry-store";
import { initialize, readState } from "../src/treatment-read-side-index";
import worker from "../src/index";

const ORIGIN = "https://synthetic.invalid";
const MINUTE = 60_000;
const DAY = 86_400_000;
const id = (n: number) => n.toString(16).padStart(24, "0");
const OPTIONS = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false };
interface Internal {
  realtimeSnapshot(at: number, frame?: boolean, mode?: "root" | "ddata"): { sgvs: { _id: string }[] };
  pluginPropertyContext(at: number): unknown;
  completeStorageInitialization(): void;
  treatmentCategoryIndexAvailable: boolean | undefined;
}
interface Statement {
  sql: string; bindings: SqlStorageValue[]; cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
}

async function measure<T>(sql: SqlStorage, action: () => T | Promise<T>) {
  const exec = sql.exec.bind(sql);
  const statements: Statement[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = exec(statement, ...bindings);
    statements.push({ sql: statement.replace(/\s+/g, " ").trim(), bindings, cursor });
    return cursor;
  });
  try {
    const result = await action();
    const metadata = statements.filter(row => /^PRAGMA\b/.test(row.sql));
    return { result, report: {
      calls: statements.length,
      reads: statements.reduce((sum, row) => sum + row.cursor.rowsRead, 0),
      writes: statements.reduce((sum, row) => sum + row.cursor.rowsWritten, 0),
      pragmaCalls: metadata.length,
      zeroReadPragmaCalls: metadata.filter(row => row.cursor.rowsRead === 0).length,
      pragmaReads: metadata.reduce((sum, row) => sum + row.cursor.rowsRead, 0),
      expensive: statements.filter(row => row.cursor.rowsRead >= 128).map(row => ({
        sql: row.sql, reads: row.cursor.rowsRead,
        plan: /^SELECT\b/.test(row.sql)
          ? exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${row.sql}`, ...row.bindings).toArray().map(row => row.detail)
          : [],
      })),
    } };
  } finally { spy.mockRestore(); }
}

function forwardingEnvironment(instance: EntryStore): Parameters<typeof worker.fetch>[1] {
  return ({ ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => new Proxy(instance, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) }, API_SECRET: "synthetic-cold-audit-secret", AUTH_DEFAULT_ROLES: "readable", AUTH_FAIL_DELAY: "0" }) as unknown as Parameters<typeof worker.fetch>[1];
}

async function get(instance: EntryStore, path: string): Promise<unknown> {
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`), forwardingEnvironment(instance));
  expect(response.status, path).toBe(200);
  return response.json();
}

function seedCommon(sql: SqlStorage, at: number): void {
  for (const collection of ["treatments", "devicestatus"] as const) {
    sql.exec(`WITH RECURSIVE sequence(n) AS (
      VALUES(0) UNION ALL SELECT n + 1 FROM sequence WHERE n < 4999
    ) INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
      SELECT ?, printf('%024x', n), json_object('_id', printf('%024x', n),
        'created_at', strftime('%Y-%m-%dT%H:%M:%fZ', (? - (5000-n)*60000) / 1000.0, 'unixepoch'),
        'date', ? - (5000-n)*60000,
        'eventType', CASE WHEN n % 200 = 0 THEN 'Sensor Change' ELSE 'Note' END,
        'device', 'synthetic-cold', 'uploaderBattery', 90),
        ? - (5000-n)*60000, ? - (5000-n)*60000, ? - (5000-n)*60000, 1
      FROM sequence`, collection, at, at, at, at, at);
  }
  sql.exec(`WITH RECURSIVE sequence(n) AS (
    VALUES(0) UNION ALL SELECT n + 1 FROM sequence WHERE n < 999
  ) INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
    SELECT 'entries', printf('%024x', n), json_object('_id', printf('%024x', n),
      'date', ?-(1000-n)*60000, 'sgv', 120+n%30, 'type', 'sgv', 'device', 'synthetic-cold'),
      ?-(1000-n)*60000, ?, ?, 1 FROM sequence`, at, at, at, at);
}

async function commonReads(instance: EntryStore, sql: SqlStorage, at: number) {
  const internal = instance as unknown as Internal;
  const readers = [
    { name: "private-root", read: () => {
      const result = internal.realtimeSnapshot(at, false, "root");
      expect(result.sgvs).toHaveLength(726);
      expect(result.sgvs.at(-1)?._id).toBe(id(999));
      return result;
    } },
    { name: "public-ddata", read: () => instance.getDdataSnapshotJson(at, false) },
    { name: "public-property-context", read: () => instance.getPluginPropertyContextJson(at) },
    { name: "HTTP-status-count5", read: async () => {
      const result = await get(instance, "/api/v1/devicestatus.json?count=5") as JsonDocument[];
      expect(result.map(row => row._id)).toEqual([4999, 4998, 4997, 4996, 4995].map(id));
      return result;
    } },
    { name: "HTTP-missing-treatment", read: async () => {
      const result = await get(instance, "/api/v1/treatments.json?find[eventType]=Absent%20Cold%20Category&count=1");
      expect(result).toEqual([]); return result;
    } },
    { name: "HTTP-properties", read: () => get(instance, "/api/v2/properties") },
  ];
  const reports = [];
  for (const reader of readers) reports.push({ reader: reader.name, ...(await measure(sql, reader.read)).report });
  return reports;
}

describe("cold sealed activation and SQL-order read audit", () => {
  it("measures common native readers warm and after actual sealed-object eviction", async () => {
    const stub = env.ENTRY_STORE.getByName(`cold-native-readers-${crypto.randomUUID()}`);
    const at = Date.now();
    await runInDurableObject(stub, (_instance, state) => state.storage.transactionSync(() => seedCommon(state.storage.sql, at)));
    await evictDurableObject(stub);
    const reports = [];
    for (let activation = 0; activation < 2; activation++) {
      if (activation > 0) await evictDurableObject(stub);
      reports.push(await runInDurableObject(stub, async (instance: EntryStore, state) => {
        const clock = vi.spyOn(Date, "now").mockReturnValue(at);
        try {
          const preflight = await measure(state.storage.sql, () => entryStoreSchemaIsActivationReady(state.storage.sql));
          expect(preflight.result).toBe(true);
          expect(preflight.report.writes).toBe(0);
          const cold = await commonReads(instance, state.storage.sql, at);
          const warm = await commonReads(instance, state.storage.sql, at);
          expect(cold.every(report => report.writes === 0)).toBe(true);
          expect(warm.every(report => report.writes === 0)).toBe(true);
          return { activation, preflight: preflight.report, cold, warm };
        } finally { clock.mockRestore(); }
      }));
    }
    console.info(`COLD_NATIVE_READ_AUDIT=${JSON.stringify(reports)}`);
    expect(reports).toMatchInlineSnapshot(`
      [
        {
          "activation": 0,
          "cold": [
            {
              "calls": 18,
              "expensive": [
                {
                  "plan": [
                    "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                    "USE TEMP B-TREE FOR LAST TERM OF ORDER BY",
                  ],
                  "reads": 4001,
                  "sql": "SELECT id, body, sort_time FROM documents WHERE collection = 'entries' AND sort_time >= ? AND ((json_type(body, '$.sgv') IN ('integer', 'real') AND json_extract(body, '$.sgv') != 0) OR (json_type(body, '$.sgv') = 'text' AND length(json_extract(body, '$.sgv')) > 0 AND json_type((CASE WHEN json_valid(trim(CAST(json_extract(body, '$.sgv') AS TEXT))) THEN trim(CAST(json_extract(body, '$.sgv') AS TEXT)) ELSE 'null' END)) IN ('integer', 'real') AND abs(CAST(json_extract(body, '$.sgv') AS REAL)) <= 1.7976931348623157e308) OR json_type(body, '$.sgv') = 'true') AND NOT COALESCE(((json_type(body, '$.mbg') IN ('integer', 'real') AND json_extract(body, '$.mbg') != 0) OR (json_type(body, '$.mbg') = 'text' AND length(json_extract(body, '$.mbg')) > 0) OR json_type(body, '$.mbg') IN ('true', 'array', 'object')), 0) ORDER BY sort_time DESC, id ASC LIMIT 1000",
                },
                {
                  "plan": [
                    "SEARCH documents USING INDEX documents_devicestatus_recent (collection=? AND sort_time>?)",
                  ],
                  "reads": 1441,
                  "sql": "SELECT id, body, sort_time, updated_at FROM documents WHERE collection = 'devicestatus' AND sort_time >= ? ORDER BY sort_time DESC, updated_at DESC",
                },
                {
                  "plan": [
                    "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                    "USE TEMP B-TREE FOR LAST TERM OF ORDER BY",
                  ],
                  "reads": 1002,
                  "sql": "SELECT id, body, sort_time FROM documents WHERE collection = 'entries' AND sort_time >= ? AND ((json_type(body, '$.mbg') IN ('integer', 'real') AND json_extract(body, '$.mbg') != 0) OR (json_type(body, '$.mbg') = 'text' AND length(json_extract(body, '$.mbg')) > 0 AND json_type((CASE WHEN json_valid(trim(CAST(json_extract(body, '$.mbg') AS TEXT))) THEN trim(CAST(json_extract(body, '$.mbg') AS TEXT)) ELSE 'null' END)) IN ('integer', 'real') AND abs(CAST(json_extract(body, '$.mbg') AS REAL)) <= 1.7976931348623157e308) OR json_type(body, '$.mbg') = 'true') ORDER BY sort_time DESC, id ASC LIMIT 1000",
                },
                {
                  "plan": [
                    "CO-ROUTINE (subquery-1)",
                    "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                    "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                    "SCAN (subquery-1)",
                    "USE TEMP B-TREE FOR ORDER BY",
                  ],
                  "reads": 2003,
                  "sql": "SELECT id, body, sort_time FROM ( SELECT id, body, sort_time, updated_at FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND sort_time >= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1000 ) ORDER BY sort_time ASC, id ASC",
                },
                {
                  "plan": [
                    "SEARCH documents USING INDEX documents_collection_modified (collection=?)",
                    "USE TEMP B-TREE FOR ORDER BY",
                  ],
                  "reads": 5002,
                  "sql": "SELECT id, body, sort_time, updated_at FROM documents WHERE collection = 'treatments' AND updated_at >= ? ORDER BY updated_at ASC, id ASC LIMIT 100",
                },
              ],
              "pragmaCalls": 2,
              "pragmaReads": 0,
              "reader": "private-root",
              "reads": 13509,
              "writes": 0,
              "zeroReadPragmaCalls": 2,
            },
            {
              "calls": 5,
              "expensive": [],
              "pragmaCalls": 4,
              "pragmaReads": 0,
              "reader": "public-ddata",
              "reads": 1,
              "writes": 0,
              "zeroReadPragmaCalls": 4,
            },
            {
              "calls": 21,
              "expensive": [
                {
                  "plan": [
                    "CO-ROUTINE (subquery-1)",
                    "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>? AND sort_time<?)",
                    "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                    "SCAN (subquery-1)",
                    "USE TEMP B-TREE FOR ORDER BY",
                  ],
                  "reads": 3001,
                  "sql": "SELECT id, body, sort_time FROM ( SELECT id, body, sort_time, updated_at FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND sort_time >= ? AND sort_time <= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1000 ) ORDER BY sort_time ASC, id ASC",
                },
              ],
              "pragmaCalls": 5,
              "pragmaReads": 0,
              "reader": "public-property-context",
              "reads": 3065,
              "writes": 0,
              "zeroReadPragmaCalls": 5,
            },
            {
              "calls": 10,
              "expensive": [],
              "pragmaCalls": 1,
              "pragmaReads": 0,
              "reader": "HTTP-status-count5",
              "reads": 82,
              "writes": 0,
              "zeroReadPragmaCalls": 1,
            },
            {
              "calls": 14,
              "expensive": [],
              "pragmaCalls": 6,
              "pragmaReads": 0,
              "reader": "HTTP-missing-treatment",
              "reads": 9,
              "writes": 0,
              "zeroReadPragmaCalls": 6,
            },
            {
              "calls": 11,
              "expensive": [],
              "pragmaCalls": 4,
              "pragmaReads": 0,
              "reader": "HTTP-properties",
              "reads": 7,
              "writes": 0,
              "zeroReadPragmaCalls": 4,
            },
          ],
          "preflight": {
            "calls": 1,
            "expensive": [],
            "pragmaCalls": 0,
            "pragmaReads": 0,
            "reads": 1,
            "writes": 0,
            "zeroReadPragmaCalls": 0,
          },
          "warm": [
            {
              "calls": 0,
              "expensive": [],
              "pragmaCalls": 0,
              "pragmaReads": 0,
              "reader": "private-root",
              "reads": 0,
              "writes": 0,
              "zeroReadPragmaCalls": 0,
            },
            {
              "calls": 5,
              "expensive": [],
              "pragmaCalls": 4,
              "pragmaReads": 0,
              "reader": "public-ddata",
              "reads": 1,
              "writes": 0,
              "zeroReadPragmaCalls": 4,
            },
            {
              "calls": 4,
              "expensive": [],
              "pragmaCalls": 4,
              "pragmaReads": 0,
              "reader": "public-property-context",
              "reads": 0,
              "writes": 0,
              "zeroReadPragmaCalls": 4,
            },
            {
              "calls": 7,
              "expensive": [],
              "pragmaCalls": 0,
              "pragmaReads": 0,
              "reader": "HTTP-status-count5",
              "reads": 7,
              "writes": 0,
              "zeroReadPragmaCalls": 0,
            },
            {
              "calls": 11,
              "expensive": [],
              "pragmaCalls": 4,
              "pragmaReads": 0,
              "reader": "HTTP-missing-treatment",
              "reads": 7,
              "writes": 0,
              "zeroReadPragmaCalls": 4,
            },
            {
              "calls": 11,
              "expensive": [],
              "pragmaCalls": 4,
              "pragmaReads": 0,
              "reader": "HTTP-properties",
              "reads": 7,
              "writes": 0,
              "zeroReadPragmaCalls": 4,
            },
          ],
        },
        {
          "activation": 1,
          "cold": [
            {
              "calls": 18,
              "expensive": [
                {
                  "plan": [
                    "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                    "USE TEMP B-TREE FOR LAST TERM OF ORDER BY",
                  ],
                  "reads": 4001,
                  "sql": "SELECT id, body, sort_time FROM documents WHERE collection = 'entries' AND sort_time >= ? AND ((json_type(body, '$.sgv') IN ('integer', 'real') AND json_extract(body, '$.sgv') != 0) OR (json_type(body, '$.sgv') = 'text' AND length(json_extract(body, '$.sgv')) > 0 AND json_type((CASE WHEN json_valid(trim(CAST(json_extract(body, '$.sgv') AS TEXT))) THEN trim(CAST(json_extract(body, '$.sgv') AS TEXT)) ELSE 'null' END)) IN ('integer', 'real') AND abs(CAST(json_extract(body, '$.sgv') AS REAL)) <= 1.7976931348623157e308) OR json_type(body, '$.sgv') = 'true') AND NOT COALESCE(((json_type(body, '$.mbg') IN ('integer', 'real') AND json_extract(body, '$.mbg') != 0) OR (json_type(body, '$.mbg') = 'text' AND length(json_extract(body, '$.mbg')) > 0) OR json_type(body, '$.mbg') IN ('true', 'array', 'object')), 0) ORDER BY sort_time DESC, id ASC LIMIT 1000",
                },
                {
                  "plan": [
                    "SEARCH documents USING INDEX documents_devicestatus_recent (collection=? AND sort_time>?)",
                  ],
                  "reads": 1441,
                  "sql": "SELECT id, body, sort_time, updated_at FROM documents WHERE collection = 'devicestatus' AND sort_time >= ? ORDER BY sort_time DESC, updated_at DESC",
                },
                {
                  "plan": [
                    "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                    "USE TEMP B-TREE FOR LAST TERM OF ORDER BY",
                  ],
                  "reads": 1002,
                  "sql": "SELECT id, body, sort_time FROM documents WHERE collection = 'entries' AND sort_time >= ? AND ((json_type(body, '$.mbg') IN ('integer', 'real') AND json_extract(body, '$.mbg') != 0) OR (json_type(body, '$.mbg') = 'text' AND length(json_extract(body, '$.mbg')) > 0 AND json_type((CASE WHEN json_valid(trim(CAST(json_extract(body, '$.mbg') AS TEXT))) THEN trim(CAST(json_extract(body, '$.mbg') AS TEXT)) ELSE 'null' END)) IN ('integer', 'real') AND abs(CAST(json_extract(body, '$.mbg') AS REAL)) <= 1.7976931348623157e308) OR json_type(body, '$.mbg') = 'true') ORDER BY sort_time DESC, id ASC LIMIT 1000",
                },
                {
                  "plan": [
                    "CO-ROUTINE (subquery-1)",
                    "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                    "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                    "SCAN (subquery-1)",
                    "USE TEMP B-TREE FOR ORDER BY",
                  ],
                  "reads": 2003,
                  "sql": "SELECT id, body, sort_time FROM ( SELECT id, body, sort_time, updated_at FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND sort_time >= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1000 ) ORDER BY sort_time ASC, id ASC",
                },
                {
                  "plan": [
                    "SEARCH documents USING INDEX documents_collection_modified (collection=?)",
                    "USE TEMP B-TREE FOR ORDER BY",
                  ],
                  "reads": 5002,
                  "sql": "SELECT id, body, sort_time, updated_at FROM documents WHERE collection = 'treatments' AND updated_at >= ? ORDER BY updated_at ASC, id ASC LIMIT 100",
                },
              ],
              "pragmaCalls": 2,
              "pragmaReads": 0,
              "reader": "private-root",
              "reads": 13509,
              "writes": 0,
              "zeroReadPragmaCalls": 2,
            },
            {
              "calls": 5,
              "expensive": [],
              "pragmaCalls": 4,
              "pragmaReads": 0,
              "reader": "public-ddata",
              "reads": 1,
              "writes": 0,
              "zeroReadPragmaCalls": 4,
            },
            {
              "calls": 21,
              "expensive": [
                {
                  "plan": [
                    "CO-ROUTINE (subquery-1)",
                    "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>? AND sort_time<?)",
                    "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                    "SCAN (subquery-1)",
                    "USE TEMP B-TREE FOR ORDER BY",
                  ],
                  "reads": 3001,
                  "sql": "SELECT id, body, sort_time FROM ( SELECT id, body, sort_time, updated_at FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND sort_time >= ? AND sort_time <= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1000 ) ORDER BY sort_time ASC, id ASC",
                },
              ],
              "pragmaCalls": 5,
              "pragmaReads": 0,
              "reader": "public-property-context",
              "reads": 3065,
              "writes": 0,
              "zeroReadPragmaCalls": 5,
            },
            {
              "calls": 10,
              "expensive": [],
              "pragmaCalls": 1,
              "pragmaReads": 0,
              "reader": "HTTP-status-count5",
              "reads": 82,
              "writes": 0,
              "zeroReadPragmaCalls": 1,
            },
            {
              "calls": 14,
              "expensive": [],
              "pragmaCalls": 6,
              "pragmaReads": 0,
              "reader": "HTTP-missing-treatment",
              "reads": 9,
              "writes": 0,
              "zeroReadPragmaCalls": 6,
            },
            {
              "calls": 11,
              "expensive": [],
              "pragmaCalls": 4,
              "pragmaReads": 0,
              "reader": "HTTP-properties",
              "reads": 7,
              "writes": 0,
              "zeroReadPragmaCalls": 4,
            },
          ],
          "preflight": {
            "calls": 1,
            "expensive": [],
            "pragmaCalls": 0,
            "pragmaReads": 0,
            "reads": 1,
            "writes": 0,
            "zeroReadPragmaCalls": 0,
          },
          "warm": [
            {
              "calls": 0,
              "expensive": [],
              "pragmaCalls": 0,
              "pragmaReads": 0,
              "reader": "private-root",
              "reads": 0,
              "writes": 0,
              "zeroReadPragmaCalls": 0,
            },
            {
              "calls": 5,
              "expensive": [],
              "pragmaCalls": 4,
              "pragmaReads": 0,
              "reader": "public-ddata",
              "reads": 1,
              "writes": 0,
              "zeroReadPragmaCalls": 4,
            },
            {
              "calls": 4,
              "expensive": [],
              "pragmaCalls": 4,
              "pragmaReads": 0,
              "reader": "public-property-context",
              "reads": 0,
              "writes": 0,
              "zeroReadPragmaCalls": 4,
            },
            {
              "calls": 7,
              "expensive": [],
              "pragmaCalls": 0,
              "pragmaReads": 0,
              "reader": "HTTP-status-count5",
              "reads": 7,
              "writes": 0,
              "zeroReadPragmaCalls": 0,
            },
            {
              "calls": 11,
              "expensive": [],
              "pragmaCalls": 4,
              "pragmaReads": 0,
              "reader": "HTTP-missing-treatment",
              "reads": 7,
              "writes": 0,
              "zeroReadPragmaCalls": 4,
            },
            {
              "calls": 11,
              "expensive": [],
              "pragmaCalls": 4,
              "pragmaReads": 0,
              "reader": "HTTP-properties",
              "reads": 7,
              "writes": 0,
              "zeroReadPragmaCalls": 4,
            },
          ],
        },
      ]
    `);
  }, 60_000);

  it("keeps partial deferred progress durable across eviction while writes and private readers cannot advance it", async () => {
    const stub = env.ENTRY_STORE.getByName(`cold-side-partial-${crypto.randomUUID()}`);
    const at = Date.now();
    await runInDurableObject(stub, (instance: EntryStore, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP INDEX documents_treatments_created_at");
      sql.exec("DROP INDEX documents_treatments_event_type_created_at");
      sql.exec("DROP INDEX documents_treatments_api3_order");
      sql.exec("DROP INDEX documents_devicestatus_recent");
      state.storage.transactionSync(() => {
        seedCommon(sql, at);
        initialize(sql);
      });
      (instance as unknown as Internal).treatmentCategoryIndexAvailable = undefined;
      expect(readState(sql)).toMatchObject({ complete: false, budgetRows: 0 });
    });
    await evictDurableObject(stub);
    const reports = [];
    for (let activation = 0; activation < 2; activation++) {
      if (activation > 0) await evictDurableObject(stub);
      reports.push(await runInDurableObject(stub, async (instance: EntryStore, state) => {
        let now = at + activation * DAY;
        const internal = instance as unknown as Internal;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        try {
          expect(entryStoreSchemaIsActivationReady(state.storage.sql)).toBe(true);
          const before = readState(state.storage.sql);
          expect(before).toMatchObject({ complete: false, budgetRows: 0 });
          const source = new SqliteDocumentRepository(state.storage);
          const stages = [];
          for (let n = 0; n < 3; n++) {
            now += MINUTE;
            const mutation = await measure(state.storage.sql, () => instance.api3CreateDocument("treatments", JSON.stringify({
              identifier: `cold-private-upload-${activation}-${n}`, app: "synthetic-cold", utcOffset: 0,
              date: now, created_at: new Date(now).toISOString(), eventType: "Note",
            }), JSON.stringify(OPTIONS)));
            expect(JSON.parse(mutation.result)).toMatchObject({ ok: true });
            const root = await measure(state.storage.sql, () => internal.realtimeSnapshot(now, false, "root"));
            const property = await measure(state.storage.sql, () => internal.pluginPropertyContext(now));
            const missing = await measure(state.storage.sql, () => source.queryLegacyTreatments({ limit: 1,
              filters: [{ field: "eventType", operator: "eq", value: "Absent Cold Category" }] }));
            expect(missing.result).toEqual([]);
            expect(readState(state.storage.sql)).toEqual(before);
            stages.push({ n, mutation: mutation.report, privateRoot: root.report,
              privateProperty: property.report, repositoryMissing: missing.report });
          }
          const sideRows = state.storage.sql.exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM treatment_read_side_keys").one().count;
          expect(sideRows).toBe((activation + 1) * 3);
          return { activation, before, after: readState(state.storage.sql), sideRows, stages };
        } finally { clock.mockRestore(); }
      }));
    }
    console.info(`COLD_DEFERRED_PRIVATE_AUDIT=${JSON.stringify(reports)}`);
    expect(reports).toMatchInlineSnapshot(`
      [
        {
          "activation": 0,
          "after": {
            "budgetDay": null,
            "budgetRows": 0,
            "complete": false,
            "cursor": null,
            "lastRunAt": null,
          },
          "before": {
            "budgetDay": null,
            "budgetRows": 0,
            "complete": false,
            "cursor": null,
            "lastRunAt": null,
          },
          "sideRows": 3,
          "stages": [
            {
              "mutation": {
                "calls": 14,
                "expensive": [],
                "pragmaCalls": 0,
                "pragmaReads": 0,
                "reads": 11,
                "writes": 19,
                "zeroReadPragmaCalls": 0,
              },
              "n": 0,
              "privateProperty": {
                "calls": 32,
                "expensive": [
                  {
                    "plan": [
                      "CO-ROUTINE (subquery-1)",
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>? AND sort_time<?)",
                      "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                      "SCAN (subquery-1)",
                      "USE TEMP B-TREE FOR ORDER BY",
                    ],
                    "reads": 3001,
                    "sql": "SELECT id, body, sort_time FROM ( SELECT id, body, sort_time, updated_at FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND sort_time >= ? AND sort_time <= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1000 ) ORDER BY sort_time ASC, id ASC",
                  },
                ],
                "pragmaCalls": 15,
                "pragmaReads": 0,
                "reads": 3116,
                "writes": 0,
                "zeroReadPragmaCalls": 15,
              },
              "privateRoot": {
                "calls": 35,
                "expensive": [
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "USE TEMP B-TREE FOR LAST TERM OF ORDER BY",
                    ],
                    "reads": 4001,
                    "sql": "SELECT id, body, sort_time FROM documents WHERE collection = 'entries' AND sort_time >= ? AND ((json_type(body, '$.sgv') IN ('integer', 'real') AND json_extract(body, '$.sgv') != 0) OR (json_type(body, '$.sgv') = 'text' AND length(json_extract(body, '$.sgv')) > 0 AND json_type((CASE WHEN json_valid(trim(CAST(json_extract(body, '$.sgv') AS TEXT))) THEN trim(CAST(json_extract(body, '$.sgv') AS TEXT)) ELSE 'null' END)) IN ('integer', 'real') AND abs(CAST(json_extract(body, '$.sgv') AS REAL)) <= 1.7976931348623157e308) OR json_type(body, '$.sgv') = 'true') AND NOT COALESCE(((json_type(body, '$.mbg') IN ('integer', 'real') AND json_extract(body, '$.mbg') != 0) OR (json_type(body, '$.mbg') = 'text' AND length(json_extract(body, '$.mbg')) > 0) OR json_type(body, '$.mbg') IN ('true', 'array', 'object')), 0) ORDER BY sort_time DESC, id ASC LIMIT 1000",
                  },
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "USE TEMP B-TREE FOR LAST TERM OF ORDER BY",
                    ],
                    "reads": 2879,
                    "sql": "SELECT id, body, sort_time, updated_at FROM documents WHERE collection = 'devicestatus' AND sort_time >= ? ORDER BY sort_time DESC, updated_at DESC",
                  },
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "USE TEMP B-TREE FOR LAST TERM OF ORDER BY",
                    ],
                    "reads": 1002,
                    "sql": "SELECT id, body, sort_time FROM documents WHERE collection = 'entries' AND sort_time >= ? AND ((json_type(body, '$.mbg') IN ('integer', 'real') AND json_extract(body, '$.mbg') != 0) OR (json_type(body, '$.mbg') = 'text' AND length(json_extract(body, '$.mbg')) > 0 AND json_type((CASE WHEN json_valid(trim(CAST(json_extract(body, '$.mbg') AS TEXT))) THEN trim(CAST(json_extract(body, '$.mbg') AS TEXT)) ELSE 'null' END)) IN ('integer', 'real') AND abs(CAST(json_extract(body, '$.mbg') AS REAL)) <= 1.7976931348623157e308) OR json_type(body, '$.mbg') = 'true') ORDER BY sort_time DESC, id ASC LIMIT 1000",
                  },
                  {
                    "plan": [
                      "CO-ROUTINE (subquery-1)",
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                      "SCAN (subquery-1)",
                      "USE TEMP B-TREE FOR ORDER BY",
                    ],
                    "reads": 2003,
                    "sql": "SELECT id, body, sort_time FROM ( SELECT id, body, sort_time, updated_at FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND sort_time >= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1000 ) ORDER BY sort_time ASC, id ASC",
                  },
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_modified (collection=?)",
                      "USE TEMP B-TREE FOR ORDER BY",
                    ],
                    "reads": 5003,
                    "sql": "SELECT id, body, sort_time, updated_at FROM documents WHERE collection = 'treatments' AND updated_at >= ? ORDER BY updated_at ASC, id ASC LIMIT 100",
                  },
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                    ],
                    "reads": 5002,
                    "sql": "SELECT id, body, sort_time FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND json_valid(body) AND json_type(body, '$.eventType') = 'text' AND CASE WHEN json_type(body, '$.eventType') = 'array' THEN NULL ELSE json_extract(body, '$.eventType') END = 'Profile Switch' AND json_type(body, '$.duration') IN ('integer', 'real') AND CAST(json_extract(body, '$.duration') AS REAL) = 0 AND sort_time >= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1",
                  },
                  {
                    "plan": [
                      "CO-ROUTINE (subquery-1)",
                      "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=?)",
                      "SCAN (subquery-1)",
                    ],
                    "reads": 5001,
                    "sql": "SELECT id,valid_json,event_kind, CASE WHEN typeof(event_value)='text' AND length(CAST(event_value AS BLOB))>65536 THEN 1 ELSE 0 END AS fragment_oversized, CASE WHEN typeof(event_value)='text' AND length(CAST(event_value AS BLOB))>65536 THEN NULL ELSE event_value END AS event_value FROM (SELECT id,json_valid(body) AS valid_json, CASE WHEN json_valid(body) THEN json_type(body,'$.eventType') END AS event_kind, CASE WHEN json_valid(body) THEN json_extract(body,'$.eventType') END AS event_value FROM documents WHERE collection='treatments' ORDER BY id ASC LIMIT 5001)",
                  },
                ],
                "pragmaCalls": 16,
                "pragmaReads": 0,
                "reads": 25002,
                "writes": 0,
                "zeroReadPragmaCalls": 16,
              },
              "repositoryMissing": {
                "calls": 4,
                "expensive": [
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
                      "CORRELATED SCALAR SUBQUERY 1",
                      "SCAN item VIRTUAL TABLE INDEX 3:",
                    ],
                    "reads": 5001,
                    "sql": "SELECT json_extract(body, '$.created_at') AS __date_key FROM documents INDEXED BY documents_collection_created_at WHERE collection = ? AND collection IN ('treatments', 'devicestatus') AND json_valid(body) AND collection = 'treatments' AND ((json_type(body, '$.eventType') = 'text' AND json_extract(body, '$.eventType') = ?) OR (json_type(body, '$.eventType') = 'array' AND CASE WHEN typeof(body) = 'text' AND json_type(body, '$.eventType[8]') IS NULL THEN CASE WHEN json_type(body, '$.eventType[0]') = 'text' AND json_extract(body, '$.eventType[0]') = ? THEN 1 WHEN json_type(body, '$.eventType[1]') = 'text' AND json_extract(body, '$.eventType[1]') = ? THEN 1 WHEN json_type(body, '$.eventType[2]') = 'text' AND json_extract(body, '$.eventType[2]') = ? THEN 1 WHEN json_type(body, '$.eventType[3]') = 'text' AND json_extract(body, '$.eventType[3]') = ? THEN 1 WHEN json_type(body, '$.eventType[4]') = 'text' AND json_extract(body, '$.eventType[4]') = ? THEN 1 WHEN json_type(body, '$.eventType[5]') = 'text' AND json_extract(body, '$.eventType[5]') = ? THEN 1 WHEN json_type(body, '$.eventType[6]') = 'text' AND json_extract(body, '$.eventType[6]') = ? THEN 1 WHEN json_type(body, '$.eventType[7]') = 'text' AND json_extract(body, '$.eventType[7]') = ? THEN 1 ELSE 0 END ELSE EXISTS ( SELECT 1 FROM json_each(body, '$.eventType') AS item WHERE item.type = 'text' AND item.value = ? ) END)) ORDER BY json_extract(body, '$.created_at') DESC LIMIT 1",
                  },
                ],
                "pragmaCalls": 2,
                "pragmaReads": 0,
                "reads": 5002,
                "writes": 0,
                "zeroReadPragmaCalls": 2,
              },
            },
            {
              "mutation": {
                "calls": 13,
                "expensive": [],
                "pragmaCalls": 0,
                "pragmaReads": 0,
                "reads": 12,
                "writes": 18,
                "zeroReadPragmaCalls": 0,
              },
              "n": 1,
              "privateProperty": {
                "calls": 32,
                "expensive": [
                  {
                    "plan": [
                      "CO-ROUTINE (subquery-1)",
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>? AND sort_time<?)",
                      "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                      "SCAN (subquery-1)",
                      "USE TEMP B-TREE FOR ORDER BY",
                    ],
                    "reads": 3001,
                    "sql": "SELECT id, body, sort_time FROM ( SELECT id, body, sort_time, updated_at FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND sort_time >= ? AND sort_time <= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1000 ) ORDER BY sort_time ASC, id ASC",
                  },
                ],
                "pragmaCalls": 15,
                "pragmaReads": 0,
                "reads": 3116,
                "writes": 0,
                "zeroReadPragmaCalls": 15,
              },
              "privateRoot": {
                "calls": 25,
                "expensive": [
                  {
                    "plan": [
                      "CO-ROUTINE (subquery-1)",
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                      "SCAN (subquery-1)",
                      "USE TEMP B-TREE FOR ORDER BY",
                    ],
                    "reads": 2003,
                    "sql": "SELECT id, body, sort_time FROM ( SELECT id, body, sort_time, updated_at FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND sort_time >= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1000 ) ORDER BY sort_time ASC, id ASC",
                  },
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_modified (collection=?)",
                      "USE TEMP B-TREE FOR ORDER BY",
                    ],
                    "reads": 5004,
                    "sql": "SELECT id, body, sort_time, updated_at FROM documents WHERE collection = 'treatments' AND updated_at >= ? ORDER BY updated_at ASC, id ASC LIMIT 100",
                  },
                ],
                "pragmaCalls": 15,
                "pragmaReads": 0,
                "reads": 7114,
                "writes": 0,
                "zeroReadPragmaCalls": 15,
              },
              "repositoryMissing": {
                "calls": 4,
                "expensive": [
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
                      "CORRELATED SCALAR SUBQUERY 1",
                      "SCAN item VIRTUAL TABLE INDEX 3:",
                    ],
                    "reads": 5002,
                    "sql": "SELECT json_extract(body, '$.created_at') AS __date_key FROM documents INDEXED BY documents_collection_created_at WHERE collection = ? AND collection IN ('treatments', 'devicestatus') AND json_valid(body) AND collection = 'treatments' AND ((json_type(body, '$.eventType') = 'text' AND json_extract(body, '$.eventType') = ?) OR (json_type(body, '$.eventType') = 'array' AND CASE WHEN typeof(body) = 'text' AND json_type(body, '$.eventType[8]') IS NULL THEN CASE WHEN json_type(body, '$.eventType[0]') = 'text' AND json_extract(body, '$.eventType[0]') = ? THEN 1 WHEN json_type(body, '$.eventType[1]') = 'text' AND json_extract(body, '$.eventType[1]') = ? THEN 1 WHEN json_type(body, '$.eventType[2]') = 'text' AND json_extract(body, '$.eventType[2]') = ? THEN 1 WHEN json_type(body, '$.eventType[3]') = 'text' AND json_extract(body, '$.eventType[3]') = ? THEN 1 WHEN json_type(body, '$.eventType[4]') = 'text' AND json_extract(body, '$.eventType[4]') = ? THEN 1 WHEN json_type(body, '$.eventType[5]') = 'text' AND json_extract(body, '$.eventType[5]') = ? THEN 1 WHEN json_type(body, '$.eventType[6]') = 'text' AND json_extract(body, '$.eventType[6]') = ? THEN 1 WHEN json_type(body, '$.eventType[7]') = 'text' AND json_extract(body, '$.eventType[7]') = ? THEN 1 ELSE 0 END ELSE EXISTS ( SELECT 1 FROM json_each(body, '$.eventType') AS item WHERE item.type = 'text' AND item.value = ? ) END)) ORDER BY json_extract(body, '$.created_at') DESC LIMIT 1",
                  },
                ],
                "pragmaCalls": 2,
                "pragmaReads": 0,
                "reads": 5003,
                "writes": 0,
                "zeroReadPragmaCalls": 2,
              },
            },
            {
              "mutation": {
                "calls": 13,
                "expensive": [],
                "pragmaCalls": 0,
                "pragmaReads": 0,
                "reads": 12,
                "writes": 18,
                "zeroReadPragmaCalls": 0,
              },
              "n": 2,
              "privateProperty": {
                "calls": 32,
                "expensive": [
                  {
                    "plan": [
                      "CO-ROUTINE (subquery-1)",
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>? AND sort_time<?)",
                      "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                      "SCAN (subquery-1)",
                      "USE TEMP B-TREE FOR ORDER BY",
                    ],
                    "reads": 3001,
                    "sql": "SELECT id, body, sort_time FROM ( SELECT id, body, sort_time, updated_at FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND sort_time >= ? AND sort_time <= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1000 ) ORDER BY sort_time ASC, id ASC",
                  },
                ],
                "pragmaCalls": 15,
                "pragmaReads": 0,
                "reads": 3116,
                "writes": 0,
                "zeroReadPragmaCalls": 15,
              },
              "privateRoot": {
                "calls": 25,
                "expensive": [
                  {
                    "plan": [
                      "CO-ROUTINE (subquery-1)",
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                      "SCAN (subquery-1)",
                      "USE TEMP B-TREE FOR ORDER BY",
                    ],
                    "reads": 2003,
                    "sql": "SELECT id, body, sort_time FROM ( SELECT id, body, sort_time, updated_at FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND sort_time >= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1000 ) ORDER BY sort_time ASC, id ASC",
                  },
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_modified (collection=?)",
                      "USE TEMP B-TREE FOR ORDER BY",
                    ],
                    "reads": 5005,
                    "sql": "SELECT id, body, sort_time, updated_at FROM documents WHERE collection = 'treatments' AND updated_at >= ? ORDER BY updated_at ASC, id ASC LIMIT 100",
                  },
                ],
                "pragmaCalls": 15,
                "pragmaReads": 0,
                "reads": 7115,
                "writes": 0,
                "zeroReadPragmaCalls": 15,
              },
              "repositoryMissing": {
                "calls": 4,
                "expensive": [
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
                      "CORRELATED SCALAR SUBQUERY 1",
                      "SCAN item VIRTUAL TABLE INDEX 3:",
                    ],
                    "reads": 5003,
                    "sql": "SELECT json_extract(body, '$.created_at') AS __date_key FROM documents INDEXED BY documents_collection_created_at WHERE collection = ? AND collection IN ('treatments', 'devicestatus') AND json_valid(body) AND collection = 'treatments' AND ((json_type(body, '$.eventType') = 'text' AND json_extract(body, '$.eventType') = ?) OR (json_type(body, '$.eventType') = 'array' AND CASE WHEN typeof(body) = 'text' AND json_type(body, '$.eventType[8]') IS NULL THEN CASE WHEN json_type(body, '$.eventType[0]') = 'text' AND json_extract(body, '$.eventType[0]') = ? THEN 1 WHEN json_type(body, '$.eventType[1]') = 'text' AND json_extract(body, '$.eventType[1]') = ? THEN 1 WHEN json_type(body, '$.eventType[2]') = 'text' AND json_extract(body, '$.eventType[2]') = ? THEN 1 WHEN json_type(body, '$.eventType[3]') = 'text' AND json_extract(body, '$.eventType[3]') = ? THEN 1 WHEN json_type(body, '$.eventType[4]') = 'text' AND json_extract(body, '$.eventType[4]') = ? THEN 1 WHEN json_type(body, '$.eventType[5]') = 'text' AND json_extract(body, '$.eventType[5]') = ? THEN 1 WHEN json_type(body, '$.eventType[6]') = 'text' AND json_extract(body, '$.eventType[6]') = ? THEN 1 WHEN json_type(body, '$.eventType[7]') = 'text' AND json_extract(body, '$.eventType[7]') = ? THEN 1 ELSE 0 END ELSE EXISTS ( SELECT 1 FROM json_each(body, '$.eventType') AS item WHERE item.type = 'text' AND item.value = ? ) END)) ORDER BY json_extract(body, '$.created_at') DESC LIMIT 1",
                  },
                ],
                "pragmaCalls": 2,
                "pragmaReads": 0,
                "reads": 5004,
                "writes": 0,
                "zeroReadPragmaCalls": 2,
              },
            },
          ],
        },
        {
          "activation": 1,
          "after": {
            "budgetDay": null,
            "budgetRows": 0,
            "complete": false,
            "cursor": null,
            "lastRunAt": null,
          },
          "before": {
            "budgetDay": null,
            "budgetRows": 0,
            "complete": false,
            "cursor": null,
            "lastRunAt": null,
          },
          "sideRows": 6,
          "stages": [
            {
              "mutation": {
                "calls": 14,
                "expensive": [],
                "pragmaCalls": 0,
                "pragmaReads": 0,
                "reads": 13,
                "writes": 18,
                "zeroReadPragmaCalls": 0,
              },
              "n": 0,
              "privateProperty": {
                "calls": 32,
                "expensive": [
                  {
                    "plan": [
                      "CO-ROUTINE (subquery-1)",
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>? AND sort_time<?)",
                      "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                      "SCAN (subquery-1)",
                      "USE TEMP B-TREE FOR ORDER BY",
                    ],
                    "reads": 3001,
                    "sql": "SELECT id, body, sort_time FROM ( SELECT id, body, sort_time, updated_at FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND sort_time >= ? AND sort_time <= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1000 ) ORDER BY sort_time ASC, id ASC",
                  },
                ],
                "pragmaCalls": 15,
                "pragmaReads": 0,
                "reads": 3116,
                "writes": 0,
                "zeroReadPragmaCalls": 15,
              },
              "privateRoot": {
                "calls": 35,
                "expensive": [
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "USE TEMP B-TREE FOR LAST TERM OF ORDER BY",
                    ],
                    "reads": 4001,
                    "sql": "SELECT id, body, sort_time FROM documents WHERE collection = 'entries' AND sort_time >= ? AND ((json_type(body, '$.sgv') IN ('integer', 'real') AND json_extract(body, '$.sgv') != 0) OR (json_type(body, '$.sgv') = 'text' AND length(json_extract(body, '$.sgv')) > 0 AND json_type((CASE WHEN json_valid(trim(CAST(json_extract(body, '$.sgv') AS TEXT))) THEN trim(CAST(json_extract(body, '$.sgv') AS TEXT)) ELSE 'null' END)) IN ('integer', 'real') AND abs(CAST(json_extract(body, '$.sgv') AS REAL)) <= 1.7976931348623157e308) OR json_type(body, '$.sgv') = 'true') AND NOT COALESCE(((json_type(body, '$.mbg') IN ('integer', 'real') AND json_extract(body, '$.mbg') != 0) OR (json_type(body, '$.mbg') = 'text' AND length(json_extract(body, '$.mbg')) > 0) OR json_type(body, '$.mbg') IN ('true', 'array', 'object')), 0) ORDER BY sort_time DESC, id ASC LIMIT 1000",
                  },
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "USE TEMP B-TREE FOR LAST TERM OF ORDER BY",
                    ],
                    "reads": 1002,
                    "sql": "SELECT id, body, sort_time FROM documents WHERE collection = 'entries' AND sort_time >= ? AND ((json_type(body, '$.mbg') IN ('integer', 'real') AND json_extract(body, '$.mbg') != 0) OR (json_type(body, '$.mbg') = 'text' AND length(json_extract(body, '$.mbg')) > 0 AND json_type((CASE WHEN json_valid(trim(CAST(json_extract(body, '$.mbg') AS TEXT))) THEN trim(CAST(json_extract(body, '$.mbg') AS TEXT)) ELSE 'null' END)) IN ('integer', 'real') AND abs(CAST(json_extract(body, '$.mbg') AS REAL)) <= 1.7976931348623157e308) OR json_type(body, '$.mbg') = 'true') ORDER BY sort_time DESC, id ASC LIMIT 1000",
                  },
                  {
                    "plan": [
                      "CO-ROUTINE (subquery-1)",
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                      "SCAN (subquery-1)",
                      "USE TEMP B-TREE FOR ORDER BY",
                    ],
                    "reads": 2003,
                    "sql": "SELECT id, body, sort_time FROM ( SELECT id, body, sort_time, updated_at FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND sort_time >= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1000 ) ORDER BY sort_time ASC, id ASC",
                  },
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_modified (collection=?)",
                      "USE TEMP B-TREE FOR ORDER BY",
                    ],
                    "reads": 5005,
                    "sql": "SELECT id, body, sort_time, updated_at FROM documents WHERE collection = 'treatments' AND updated_at >= ? ORDER BY updated_at ASC, id ASC LIMIT 100",
                  },
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                    ],
                    "reads": 5005,
                    "sql": "SELECT id, body, sort_time FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND json_valid(body) AND json_type(body, '$.eventType') = 'text' AND CASE WHEN json_type(body, '$.eventType') = 'array' THEN NULL ELSE json_extract(body, '$.eventType') END = 'Profile Switch' AND json_type(body, '$.duration') IN ('integer', 'real') AND CAST(json_extract(body, '$.duration') AS REAL) = 0 AND sort_time >= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1",
                  },
                  {
                    "plan": [
                      "CO-ROUTINE (subquery-1)",
                      "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=?)",
                      "SCAN (subquery-1)",
                    ],
                    "reads": 5001,
                    "sql": "SELECT id,valid_json,event_kind, CASE WHEN typeof(event_value)='text' AND length(CAST(event_value AS BLOB))>65536 THEN 1 ELSE 0 END AS fragment_oversized, CASE WHEN typeof(event_value)='text' AND length(CAST(event_value AS BLOB))>65536 THEN NULL ELSE event_value END AS event_value FROM (SELECT id,json_valid(body) AS valid_json, CASE WHEN json_valid(body) THEN json_type(body,'$.eventType') END AS event_kind, CASE WHEN json_valid(body) THEN json_extract(body,'$.eventType') END AS event_value FROM documents WHERE collection='treatments' ORDER BY id ASC LIMIT 5001)",
                  },
                ],
                "pragmaCalls": 16,
                "pragmaReads": 0,
                "reads": 22133,
                "writes": 0,
                "zeroReadPragmaCalls": 16,
              },
              "repositoryMissing": {
                "calls": 4,
                "expensive": [
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
                      "CORRELATED SCALAR SUBQUERY 1",
                      "SCAN item VIRTUAL TABLE INDEX 3:",
                    ],
                    "reads": 5004,
                    "sql": "SELECT json_extract(body, '$.created_at') AS __date_key FROM documents INDEXED BY documents_collection_created_at WHERE collection = ? AND collection IN ('treatments', 'devicestatus') AND json_valid(body) AND collection = 'treatments' AND ((json_type(body, '$.eventType') = 'text' AND json_extract(body, '$.eventType') = ?) OR (json_type(body, '$.eventType') = 'array' AND CASE WHEN typeof(body) = 'text' AND json_type(body, '$.eventType[8]') IS NULL THEN CASE WHEN json_type(body, '$.eventType[0]') = 'text' AND json_extract(body, '$.eventType[0]') = ? THEN 1 WHEN json_type(body, '$.eventType[1]') = 'text' AND json_extract(body, '$.eventType[1]') = ? THEN 1 WHEN json_type(body, '$.eventType[2]') = 'text' AND json_extract(body, '$.eventType[2]') = ? THEN 1 WHEN json_type(body, '$.eventType[3]') = 'text' AND json_extract(body, '$.eventType[3]') = ? THEN 1 WHEN json_type(body, '$.eventType[4]') = 'text' AND json_extract(body, '$.eventType[4]') = ? THEN 1 WHEN json_type(body, '$.eventType[5]') = 'text' AND json_extract(body, '$.eventType[5]') = ? THEN 1 WHEN json_type(body, '$.eventType[6]') = 'text' AND json_extract(body, '$.eventType[6]') = ? THEN 1 WHEN json_type(body, '$.eventType[7]') = 'text' AND json_extract(body, '$.eventType[7]') = ? THEN 1 ELSE 0 END ELSE EXISTS ( SELECT 1 FROM json_each(body, '$.eventType') AS item WHERE item.type = 'text' AND item.value = ? ) END)) ORDER BY json_extract(body, '$.created_at') DESC LIMIT 1",
                  },
                ],
                "pragmaCalls": 2,
                "pragmaReads": 0,
                "reads": 5005,
                "writes": 0,
                "zeroReadPragmaCalls": 2,
              },
            },
            {
              "mutation": {
                "calls": 13,
                "expensive": [],
                "pragmaCalls": 0,
                "pragmaReads": 0,
                "reads": 12,
                "writes": 18,
                "zeroReadPragmaCalls": 0,
              },
              "n": 1,
              "privateProperty": {
                "calls": 32,
                "expensive": [
                  {
                    "plan": [
                      "CO-ROUTINE (subquery-1)",
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>? AND sort_time<?)",
                      "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                      "SCAN (subquery-1)",
                      "USE TEMP B-TREE FOR ORDER BY",
                    ],
                    "reads": 3001,
                    "sql": "SELECT id, body, sort_time FROM ( SELECT id, body, sort_time, updated_at FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND sort_time >= ? AND sort_time <= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1000 ) ORDER BY sort_time ASC, id ASC",
                  },
                ],
                "pragmaCalls": 15,
                "pragmaReads": 0,
                "reads": 3116,
                "writes": 0,
                "zeroReadPragmaCalls": 15,
              },
              "privateRoot": {
                "calls": 25,
                "expensive": [
                  {
                    "plan": [
                      "CO-ROUTINE (subquery-1)",
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                      "SCAN (subquery-1)",
                      "USE TEMP B-TREE FOR ORDER BY",
                    ],
                    "reads": 2003,
                    "sql": "SELECT id, body, sort_time FROM ( SELECT id, body, sort_time, updated_at FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND sort_time >= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1000 ) ORDER BY sort_time ASC, id ASC",
                  },
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_modified (collection=?)",
                      "USE TEMP B-TREE FOR ORDER BY",
                    ],
                    "reads": 5007,
                    "sql": "SELECT id, body, sort_time, updated_at FROM documents WHERE collection = 'treatments' AND updated_at >= ? ORDER BY updated_at ASC, id ASC LIMIT 100",
                  },
                ],
                "pragmaCalls": 15,
                "pragmaReads": 0,
                "reads": 7117,
                "writes": 0,
                "zeroReadPragmaCalls": 15,
              },
              "repositoryMissing": {
                "calls": 4,
                "expensive": [
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
                      "CORRELATED SCALAR SUBQUERY 1",
                      "SCAN item VIRTUAL TABLE INDEX 3:",
                    ],
                    "reads": 5005,
                    "sql": "SELECT json_extract(body, '$.created_at') AS __date_key FROM documents INDEXED BY documents_collection_created_at WHERE collection = ? AND collection IN ('treatments', 'devicestatus') AND json_valid(body) AND collection = 'treatments' AND ((json_type(body, '$.eventType') = 'text' AND json_extract(body, '$.eventType') = ?) OR (json_type(body, '$.eventType') = 'array' AND CASE WHEN typeof(body) = 'text' AND json_type(body, '$.eventType[8]') IS NULL THEN CASE WHEN json_type(body, '$.eventType[0]') = 'text' AND json_extract(body, '$.eventType[0]') = ? THEN 1 WHEN json_type(body, '$.eventType[1]') = 'text' AND json_extract(body, '$.eventType[1]') = ? THEN 1 WHEN json_type(body, '$.eventType[2]') = 'text' AND json_extract(body, '$.eventType[2]') = ? THEN 1 WHEN json_type(body, '$.eventType[3]') = 'text' AND json_extract(body, '$.eventType[3]') = ? THEN 1 WHEN json_type(body, '$.eventType[4]') = 'text' AND json_extract(body, '$.eventType[4]') = ? THEN 1 WHEN json_type(body, '$.eventType[5]') = 'text' AND json_extract(body, '$.eventType[5]') = ? THEN 1 WHEN json_type(body, '$.eventType[6]') = 'text' AND json_extract(body, '$.eventType[6]') = ? THEN 1 WHEN json_type(body, '$.eventType[7]') = 'text' AND json_extract(body, '$.eventType[7]') = ? THEN 1 ELSE 0 END ELSE EXISTS ( SELECT 1 FROM json_each(body, '$.eventType') AS item WHERE item.type = 'text' AND item.value = ? ) END)) ORDER BY json_extract(body, '$.created_at') DESC LIMIT 1",
                  },
                ],
                "pragmaCalls": 2,
                "pragmaReads": 0,
                "reads": 5006,
                "writes": 0,
                "zeroReadPragmaCalls": 2,
              },
            },
            {
              "mutation": {
                "calls": 13,
                "expensive": [],
                "pragmaCalls": 0,
                "pragmaReads": 0,
                "reads": 12,
                "writes": 18,
                "zeroReadPragmaCalls": 0,
              },
              "n": 2,
              "privateProperty": {
                "calls": 32,
                "expensive": [
                  {
                    "plan": [
                      "CO-ROUTINE (subquery-1)",
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>? AND sort_time<?)",
                      "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                      "SCAN (subquery-1)",
                      "USE TEMP B-TREE FOR ORDER BY",
                    ],
                    "reads": 3001,
                    "sql": "SELECT id, body, sort_time FROM ( SELECT id, body, sort_time, updated_at FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND sort_time >= ? AND sort_time <= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1000 ) ORDER BY sort_time ASC, id ASC",
                  },
                ],
                "pragmaCalls": 15,
                "pragmaReads": 0,
                "reads": 3116,
                "writes": 0,
                "zeroReadPragmaCalls": 15,
              },
              "privateRoot": {
                "calls": 25,
                "expensive": [
                  {
                    "plan": [
                      "CO-ROUTINE (subquery-1)",
                      "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
                      "SCAN (subquery-1)",
                      "USE TEMP B-TREE FOR ORDER BY",
                    ],
                    "reads": 2003,
                    "sql": "SELECT id, body, sort_time FROM ( SELECT id, body, sort_time, updated_at FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND sort_time >= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1000 ) ORDER BY sort_time ASC, id ASC",
                  },
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_modified (collection=?)",
                      "USE TEMP B-TREE FOR ORDER BY",
                    ],
                    "reads": 5008,
                    "sql": "SELECT id, body, sort_time, updated_at FROM documents WHERE collection = 'treatments' AND updated_at >= ? ORDER BY updated_at ASC, id ASC LIMIT 100",
                  },
                ],
                "pragmaCalls": 15,
                "pragmaReads": 0,
                "reads": 7118,
                "writes": 0,
                "zeroReadPragmaCalls": 15,
              },
              "repositoryMissing": {
                "calls": 4,
                "expensive": [
                  {
                    "plan": [
                      "SEARCH documents USING INDEX documents_collection_created_at (collection=?)",
                      "CORRELATED SCALAR SUBQUERY 1",
                      "SCAN item VIRTUAL TABLE INDEX 3:",
                    ],
                    "reads": 5006,
                    "sql": "SELECT json_extract(body, '$.created_at') AS __date_key FROM documents INDEXED BY documents_collection_created_at WHERE collection = ? AND collection IN ('treatments', 'devicestatus') AND json_valid(body) AND collection = 'treatments' AND ((json_type(body, '$.eventType') = 'text' AND json_extract(body, '$.eventType') = ?) OR (json_type(body, '$.eventType') = 'array' AND CASE WHEN typeof(body) = 'text' AND json_type(body, '$.eventType[8]') IS NULL THEN CASE WHEN json_type(body, '$.eventType[0]') = 'text' AND json_extract(body, '$.eventType[0]') = ? THEN 1 WHEN json_type(body, '$.eventType[1]') = 'text' AND json_extract(body, '$.eventType[1]') = ? THEN 1 WHEN json_type(body, '$.eventType[2]') = 'text' AND json_extract(body, '$.eventType[2]') = ? THEN 1 WHEN json_type(body, '$.eventType[3]') = 'text' AND json_extract(body, '$.eventType[3]') = ? THEN 1 WHEN json_type(body, '$.eventType[4]') = 'text' AND json_extract(body, '$.eventType[4]') = ? THEN 1 WHEN json_type(body, '$.eventType[5]') = 'text' AND json_extract(body, '$.eventType[5]') = ? THEN 1 WHEN json_type(body, '$.eventType[6]') = 'text' AND json_extract(body, '$.eventType[6]') = ? THEN 1 WHEN json_type(body, '$.eventType[7]') = 'text' AND json_extract(body, '$.eventType[7]') = ? THEN 1 ELSE 0 END ELSE EXISTS ( SELECT 1 FROM json_each(body, '$.eventType') AS item WHERE item.type = 'text' AND item.value = ? ) END)) ORDER BY json_extract(body, '$.created_at') DESC LIMIT 1",
                  },
                ],
                "pragmaCalls": 2,
                "pragmaReads": 0,
                "reads": 5007,
                "writes": 0,
                "zeroReadPragmaCalls": 2,
              },
            },
          ],
        },
      ]
    `);
  }, 60_000);

  it("measures 5000 exact status-time ties and candidate composite indexes without changing legacy implicit ties", async () => {
    const stub = env.ENTRY_STORE.getByName(`cold-status-ties-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const sql = state.storage.sql;
      const at = Date.now();
      sql.exec(`WITH RECURSIVE sequence(n) AS (
        VALUES(0) UNION ALL SELECT n + 1 FROM sequence WHERE n < 4999
      ) INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
        SELECT 'devicestatus', printf('%024x', 5000-n), json_object(
          '_id', printf('%024x', 5000-n), 'device', 'synthetic-ties', 'date', ?, 'rank', n),
          ?, ?, ?+(n%13), 1 FROM sequence`, at, at, at, at);
      const legacySql = (source: string) => `SELECT id,body,sort_time,updated_at FROM ${source}
        WHERE collection = 'devicestatus' ORDER BY sort_time DESC, updated_at DESC LIMIT 5`;
      const internalSql = (source: string) => `SELECT id,body,sort_time,updated_at FROM ${source}
        WHERE collection = 'devicestatus' ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1`;
      const oldSource = "documents INDEXED BY documents_collection_sort";
      const legacyOracle = sql.exec(legacySql(oldSource)).toArray();
      const internalOracle = sql.exec(internalSql(oldSource)).toArray();
      const cold = await measure(sql, () => instance.getLegacyDeviceStatusJson(5));
      const warm = await measure(sql, () => instance.getLegacyDeviceStatusJson(5));
      expect(JSON.parse(cold.result)).toEqual(legacyOracle.map(row => JSON.parse(String(row.body))));
      expect(warm.result).toBe(cold.result);
      const originalInternal = await measure(sql, () => sql.exec(internalSql(oldSource)).toArray());
      const buildLegacy = await measure(sql, () => sql.exec(`CREATE INDEX audit_status_time_update
        ON documents(collection, sort_time DESC, updated_at DESC)`));
      const indexedLegacy = await measure(sql, () => sql.exec(legacySql("documents INDEXED BY audit_status_time_update")).toArray());
      const indexedInternal = await measure(sql, () => sql.exec(internalSql("documents INDEXED BY audit_status_time_update")).toArray());
      expect(indexedLegacy.result).toEqual(legacyOracle);
      expect(indexedInternal.result).toEqual(internalOracle);
      const buildInternal = await measure(sql, () => sql.exec(`CREATE INDEX audit_status_time_update_id
        ON documents(collection, sort_time DESC, updated_at DESC, id ASC)`));
      const fullIndexedInternal = await measure(sql, () => sql.exec(internalSql("documents INDEXED BY audit_status_time_update_id")).toArray());
      const wrongLegacyTie = await measure(sql, () => sql.exec(legacySql("documents INDEXED BY audit_status_time_update_id")).toArray());
      expect(fullIndexedInternal.result).toEqual(internalOracle);
      // Prove why adding id ASC indiscriminately would change the original
      // unspecified-but-observable legacy prefix in this fixed database.
      expect(wrongLegacyTie.result).not.toEqual(legacyOracle);
      return { cold: cold.report, warm: warm.report, originalInternal: originalInternal.report,
        legacyIds: legacyOracle.map(row => row.id), internalId: internalOracle[0]!.id,
        buildLegacy: buildLegacy.report, indexedLegacy: indexedLegacy.report, indexedInternal: indexedInternal.report,
        buildInternal: buildInternal.report, fullIndexedInternal: fullIndexedInternal.report,
        wrongLegacyIds: wrongLegacyTie.result.map(row => row.id) };
    });
    console.info(`COLD_STATUS_TIES_AUDIT=${JSON.stringify(report)}`);
    expect(report).toMatchInlineSnapshot(`
      {
        "buildInternal": {
          "calls": 1,
          "expensive": [
            {
              "plan": [],
              "reads": 10143,
              "sql": "CREATE INDEX audit_status_time_update_id ON documents(collection, sort_time DESC, updated_at DESC, id ASC)",
            },
          ],
          "pragmaCalls": 0,
          "pragmaReads": 0,
          "reads": 10143,
          "writes": 5001,
          "zeroReadPragmaCalls": 0,
        },
        "buildLegacy": {
          "calls": 1,
          "expensive": [
            {
              "plan": [],
              "reads": 10083,
              "sql": "CREATE INDEX audit_status_time_update ON documents(collection, sort_time DESC, updated_at DESC)",
            },
          ],
          "pragmaCalls": 0,
          "pragmaReads": 0,
          "reads": 10083,
          "writes": 5001,
          "zeroReadPragmaCalls": 0,
        },
        "cold": {
          "calls": 3,
          "expensive": [],
          "pragmaCalls": 1,
          "pragmaReads": 0,
          "reads": 6,
          "writes": 0,
          "zeroReadPragmaCalls": 1,
        },
        "fullIndexedInternal": {
          "calls": 1,
          "expensive": [],
          "pragmaCalls": 0,
          "pragmaReads": 0,
          "reads": 1,
          "writes": 0,
          "zeroReadPragmaCalls": 0,
        },
        "indexedInternal": {
          "calls": 1,
          "expensive": [
            {
              "plan": [
                "SEARCH documents USING INDEX audit_status_time_update (collection=?)",
                "USE TEMP B-TREE FOR LAST TERM OF ORDER BY",
              ],
              "reads": 769,
              "sql": "SELECT id,body,sort_time,updated_at FROM documents INDEXED BY audit_status_time_update WHERE collection = 'devicestatus' ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1",
            },
          ],
          "pragmaCalls": 0,
          "pragmaReads": 0,
          "reads": 769,
          "writes": 0,
          "zeroReadPragmaCalls": 0,
        },
        "indexedLegacy": {
          "calls": 1,
          "expensive": [],
          "pragmaCalls": 0,
          "pragmaReads": 0,
          "reads": 5,
          "writes": 0,
          "zeroReadPragmaCalls": 0,
        },
        "internalId": "000000000000000000000009",
        "legacyIds": [
          "00000000000000000000137c",
          "00000000000000000000136f",
          "000000000000000000001362",
          "000000000000000000001355",
          "000000000000000000001348",
        ],
        "originalInternal": {
          "calls": 1,
          "expensive": [
            {
              "plan": [
                "SEARCH documents USING INDEX documents_collection_sort (collection=?)",
                "USE TEMP B-TREE FOR LAST 2 TERMS OF ORDER BY",
              ],
              "reads": 10000,
              "sql": "SELECT id,body,sort_time,updated_at FROM documents INDEXED BY documents_collection_sort WHERE collection = 'devicestatus' ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1",
            },
          ],
          "pragmaCalls": 0,
          "pragmaReads": 0,
          "reads": 10000,
          "writes": 0,
          "zeroReadPragmaCalls": 0,
        },
        "warm": {
          "calls": 0,
          "expensive": [],
          "pragmaCalls": 0,
          "pragmaReads": 0,
          "reads": 0,
          "writes": 0,
          "zeroReadPragmaCalls": 0,
        },
        "wrongLegacyIds": [
          "000000000000000000000009",
          "000000000000000000000016",
          "000000000000000000000023",
          "000000000000000000000030",
          "00000000000000000000003d",
        ],
      }
    `);
  }, 60_000);
});
