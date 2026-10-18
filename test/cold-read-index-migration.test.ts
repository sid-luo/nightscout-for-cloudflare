import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  COLD_READ_INDEX_NEW_KEY_LIMIT, DEVICE_STATUS_RECENT_READ_INDEX as STATUS,
  TREATMENTS_API3_ORDER_READ_INDEX as TREATMENTS,
  hasDeviceStatusRecentReadIndex, hasTreatmentsApi3OrderReadIndex,
  migrateColdReadIndexesV33, readColdReadIndexCapabilities,
} from "../src/cold-read-indexes";
import { DurableObjectWriteQuotaError } from "../src/platform-errors";

const AT = Date.parse("2026-10-18T12:00:00.000Z");

function dropOptional(sql: SqlStorage): void {
  sql.exec(`DROP INDEX IF EXISTS ${STATUS}`);
  sql.exec(`DROP INDEX IF EXISTS ${TREATMENTS}`);
}

function seed(sql: SqlStorage, collection: "treatments" | "devicestatus" | "food", count: number): void {
  if (count === 0) return;
  sql.exec(`WITH RECURSIVE sequence(n) AS (
    VALUES(0) UNION ALL SELECT n+1 FROM sequence WHERE n < ?
  ) INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,srv_modified,is_valid)
    SELECT ?, printf('%024x', ?-n), json_object('_id', printf('%024x', ?-n),
      'created_at', '2026-10-18T12:00:00.000Z', 'eventType', 'Note', 'device', 'synthetic-index-budget'),
      ?, ?, ?+(n%13), CASE WHEN n%3=0 THEN NULL ELSE n%7 END, 1 FROM sequence`,
  count - 1, collection, count, count, AT, AT, AT);
}

function rows(sql: SqlStorage) {
  return sql.exec("SELECT * FROM documents ORDER BY collection,id").toArray();
}

function insert(sql: SqlStorage, collection: string, id: string): number {
  return sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,srv_modified,is_valid)
    VALUES(?,?,'{"created_at":"2026-10-18T12:00:00.000Z","eventType":"Note"}',?,?,?,NULL,1)`,
  collection, id, AT, AT, AT).rowsWritten;
}

function measure<T>(sql: SqlStorage, operation: () => T) {
  const exec = sql.exec.bind(sql);
  const executed: { sql: string; bindings: SqlStorageValue[];
    cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = exec(statement, ...bindings);
    executed.push({ sql: statement.replace(/\s+/g, " ").trim(), bindings, cursor });
    return cursor;
  });
  try {
    const result = operation();
    return { result, reads: executed.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: executed.reduce((sum, item) => sum + item.cursor.rowsWritten, 0),
      statements: executed.map(item => item.sql),
      collectionProbes: executed.filter(item => item.sql.startsWith("SELECT COUNT(*)"))
        .map(item => ({ collection: item.bindings[0], limit: item.bindings[1], reads: item.cursor.rowsRead })) };
  } finally { spy.mockRestore(); }
}

function createExisting(sql: SqlStorage, name: typeof STATUS | typeof TREATMENTS): void {
  sql.exec(name === STATUS
    ? `CREATE INDEX ${STATUS} ON documents(collection,sort_time DESC,updated_at DESC) WHERE collection='devicestatus'`
    : `CREATE INDEX ${TREATMENTS} ON documents(collection,sort_time DESC,srv_modified DESC,id ASC) WHERE collection='treatments'`);
}

/** New address-hint identity, while every lookup still uses the real SQLite. */
function uncachedSqlIdentity(sql: SqlStorage): SqlStorage {
  return new Proxy(sql, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("optional v33 native cold read indexes", () => {
  it("preserves legacy implicit rowid ties, API3 NULL-modified ties and malformed bodies, adding one write per matching row", async () => {
    const stub = env.ENTRY_STORE.getByName(`cold-index-semantics-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      dropOptional(sql);
      seed(sql, "treatments", 8);
      seed(sql, "devicestatus", 10);
      seed(sql, "food", 5);
      sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,srv_modified,is_valid)
        VALUES('treatments','malformed','{',?,?,?,NULL,1)`, AT + 1, AT, AT);
      const treatmentBeforeWrites = insert(sql, "treatments", "before-treatment");
      const statusBeforeWrites = insert(sql, "devicestatus", "before-status");
      const before = rows(sql);
      const legacy = sql.exec(`SELECT id,body FROM documents INDEXED BY documents_collection_sort
        WHERE collection='devicestatus' ORDER BY sort_time DESC,updated_at DESC LIMIT 5`).toArray();
      const api3 = sql.exec(`SELECT id,body FROM documents INDEXED BY documents_collection_sort
        WHERE collection='treatments' ORDER BY sort_time DESC,srv_modified DESC,id ASC LIMIT 20`).toArray();
      expect(readColdReadIndexCapabilities(sql)).toEqual({ deviceStatusRecent: false, treatmentsApi3Order: false });
      const migration = measure(sql, () => state.storage.transactionSync(() => migrateColdReadIndexesV33(sql)));
      expect(migration.result).toEqual({ deviceStatusRecent: true, treatmentsApi3Order: true });
      expect(rows(sql)).toEqual(before);
      expect(sql.exec(`SELECT id,body FROM documents INDEXED BY ${STATUS}
        WHERE collection='devicestatus' ORDER BY sort_time DESC,updated_at DESC LIMIT 5`).toArray()).toEqual(legacy);
      expect(sql.exec(`SELECT id,body FROM documents INDEXED BY ${TREATMENTS}
        WHERE collection='treatments' ORDER BY sort_time DESC,srv_modified DESC,id ASC LIMIT 20`).toArray()).toEqual(api3);
      expect(api3[0]!.id).toBe("malformed");
      expect(insert(sql, "treatments", "after-treatment")).toBe(treatmentBeforeWrites + 1);
      expect(insert(sql, "devicestatus", "after-status")).toBe(statusBeforeWrites + 1);
      const again = measure(sql, () => state.storage.transactionSync(() => migrateColdReadIndexesV33(sql)));
      expect(again.writes).toBe(0);
      expect(again.statements.every(statement => statement.startsWith("PRAGMA") || statement.includes("FROM sqlite_master"))).toBe(true);
      return { migration, existing: again, legacyIds: legacy.map(row => row.id), api3Ids: api3.map(row => row.id),
        treatmentExtraWrites: 1, statusExtraWrites: 1 };
    });
    expect(report).toMatchInlineSnapshot(`
      {
        "api3Ids": [
          "malformed",
          "000000000000000000000003",
          "000000000000000000000004",
          "000000000000000000000006",
          "000000000000000000000007",
          "000000000000000000000001",
          "000000000000000000000002",
          "000000000000000000000005",
          "000000000000000000000008",
          "before-treatment",
        ],
        "existing": {
          "collectionProbes": [],
          "reads": 2,
          "result": {
            "deviceStatusRecent": true,
            "treatmentsApi3Order": true,
          },
          "statements": [
            "PRAGMA index_xinfo(documents_devicestatus_recent)",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
            "PRAGMA index_xinfo(documents_treatments_api3_order)",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
          ],
          "writes": 0,
        },
        "legacyIds": [
          "000000000000000000000001",
          "000000000000000000000002",
          "000000000000000000000003",
          "000000000000000000000004",
          "000000000000000000000005",
        ],
        "migration": {
          "collectionProbes": [
            {
              "collection": "treatments",
              "limit": 20001,
              "reads": 10,
            },
            {
              "collection": "devicestatus",
              "limit": 19991,
              "reads": 12,
            },
          ],
          "reads": 272,
          "result": {
            "deviceStatusRecent": true,
            "treatmentsApi3Order": true,
          },
          "statements": [
            "PRAGMA index_xinfo(documents_devicestatus_recent)",
            "PRAGMA index_xinfo(documents_treatments_api3_order)",
            "SELECT EXISTS( SELECT 1 FROM documents LIMIT 1 OFFSET 100000 ) AS present",
            "SELECT COUNT(*) AS count FROM ( SELECT 1 FROM documents WHERE collection = ? LIMIT ? )",
            "CREATE INDEX IF NOT EXISTS documents_treatments_api3_order ON documents(collection, sort_time DESC, srv_modified DESC, id ASC) WHERE collection = 'treatments'",
            "SELECT COUNT(*) AS count FROM ( SELECT 1 FROM documents WHERE collection = ? LIMIT ? )",
            "CREATE INDEX IF NOT EXISTS documents_devicestatus_recent ON documents(collection, sort_time DESC, updated_at DESC) WHERE collection = 'devicestatus'",
            "PRAGMA index_xinfo(documents_devicestatus_recent)",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE type='index' AND name=? LIMIT 1",
            "PRAGMA index_xinfo(documents_treatments_api3_order)",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE type='index' AND name=? LIMIT 1",
          ],
          "writes": 23,
        },
        "statusExtraWrites": 1,
        "treatmentExtraWrites": 1,
      }
    `);
  });

  it("shares a strict 20000-new-key budget, preferring treatment API3 ordering and probing only the remaining prefix", async () => {
    const reports = [];
    for (const [treatments, statuses] of [[12_000, 12_000], [20_000, 1], [10_000, 10_000]] as const) {
      const stub = env.ENTRY_STORE.getByName(`cold-index-aggregate-${treatments}-${statuses}-${crypto.randomUUID()}`);
      reports.push(await runInDurableObject(stub, (_instance, state) => {
        const sql = state.storage.sql;
        dropOptional(sql);
        seed(sql, "treatments", treatments);
        seed(sql, "devicestatus", statuses);
        const before = rows(sql);
        const migration = measure(sql, () => state.storage.transactionSync(() => migrateColdReadIndexesV33(sql)));
        const bothFit = treatments + statuses <= COLD_READ_INDEX_NEW_KEY_LIMIT;
        expect(migration.result).toEqual({ deviceStatusRecent: bothFit, treatmentsApi3Order: true });
        expect(migration.collectionProbes.map(probe => [probe.collection, probe.limit])).toEqual([
          ["treatments", 20_001], ["devicestatus", 20_001 - treatments],
        ]);
        expect(migration.writes).toBeGreaterThanOrEqual(treatments + (bothFit ? statuses : 0));
        expect(migration.writes).toBeLessThanOrEqual(COLD_READ_INDEX_NEW_KEY_LIMIT + 16);
        expect(rows(sql)).toEqual(before);
        return { treatments, statuses, ...migration };
      }));
    }
    expect(reports).toMatchInlineSnapshot(`
      [
        {
          "collectionProbes": [
            {
              "collection": "treatments",
              "limit": 20001,
              "reads": 12000,
            },
            {
              "collection": "devicestatus",
              "limit": 8001,
              "reads": 8001,
            },
          ],
          "reads": 80373,
          "result": {
            "deviceStatusRecent": false,
            "treatmentsApi3Order": true,
          },
          "statements": [
            "PRAGMA index_xinfo(documents_devicestatus_recent)",
            "PRAGMA index_xinfo(documents_treatments_api3_order)",
            "SELECT EXISTS( SELECT 1 FROM documents LIMIT 1 OFFSET 100000 ) AS present",
            "SELECT COUNT(*) AS count FROM ( SELECT 1 FROM documents WHERE collection = ? LIMIT ? )",
            "CREATE INDEX IF NOT EXISTS documents_treatments_api3_order ON documents(collection, sort_time DESC, srv_modified DESC, id ASC) WHERE collection = 'treatments'",
            "SELECT COUNT(*) AS count FROM ( SELECT 1 FROM documents WHERE collection = ? LIMIT ? )",
            "PRAGMA index_xinfo(documents_devicestatus_recent)",
            "PRAGMA index_xinfo(documents_treatments_api3_order)",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE type='index' AND name=? LIMIT 1",
          ],
          "statuses": 12000,
          "treatments": 12000,
          "writes": 12001,
        },
        {
          "collectionProbes": [
            {
              "collection": "treatments",
              "limit": 20001,
              "reads": 20000,
            },
            {
              "collection": "devicestatus",
              "limit": 1,
              "reads": 1,
            },
          ],
          "reads": 80575,
          "result": {
            "deviceStatusRecent": false,
            "treatmentsApi3Order": true,
          },
          "statements": [
            "PRAGMA index_xinfo(documents_devicestatus_recent)",
            "PRAGMA index_xinfo(documents_treatments_api3_order)",
            "SELECT EXISTS( SELECT 1 FROM documents LIMIT 1 OFFSET 100000 ) AS present",
            "SELECT COUNT(*) AS count FROM ( SELECT 1 FROM documents WHERE collection = ? LIMIT ? )",
            "CREATE INDEX IF NOT EXISTS documents_treatments_api3_order ON documents(collection, sort_time DESC, srv_modified DESC, id ASC) WHERE collection = 'treatments'",
            "SELECT COUNT(*) AS count FROM ( SELECT 1 FROM documents WHERE collection = ? LIMIT ? )",
            "PRAGMA index_xinfo(documents_devicestatus_recent)",
            "PRAGMA index_xinfo(documents_treatments_api3_order)",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE type='index' AND name=? LIMIT 1",
          ],
          "statuses": 1,
          "treatments": 20000,
          "writes": 20001,
        },
        {
          "collectionProbes": [
            {
              "collection": "treatments",
              "limit": 20001,
              "reads": 10000,
            },
            {
              "collection": "devicestatus",
              "limit": 10001,
              "reads": 10001,
            },
          ],
          "reads": 100562,
          "result": {
            "deviceStatusRecent": true,
            "treatmentsApi3Order": true,
          },
          "statements": [
            "PRAGMA index_xinfo(documents_devicestatus_recent)",
            "PRAGMA index_xinfo(documents_treatments_api3_order)",
            "SELECT EXISTS( SELECT 1 FROM documents LIMIT 1 OFFSET 100000 ) AS present",
            "SELECT COUNT(*) AS count FROM ( SELECT 1 FROM documents WHERE collection = ? LIMIT ? )",
            "CREATE INDEX IF NOT EXISTS documents_treatments_api3_order ON documents(collection, sort_time DESC, srv_modified DESC, id ASC) WHERE collection = 'treatments'",
            "SELECT COUNT(*) AS count FROM ( SELECT 1 FROM documents WHERE collection = ? LIMIT ? )",
            "CREATE INDEX IF NOT EXISTS documents_devicestatus_recent ON documents(collection, sort_time DESC, updated_at DESC) WHERE collection = 'devicestatus'",
            "PRAGMA index_xinfo(documents_devicestatus_recent)",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE type='index' AND name=? LIMIT 1",
            "PRAGMA index_xinfo(documents_treatments_api3_order)",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE type='index' AND name=? LIMIT 1",
          ],
          "statuses": 10000,
          "treatments": 10000,
          "writes": 20002,
        },
      ]
    `);
  }, 60_000);

  it("can index a small status collection when treatment keys alone exceed the entire new-key budget", async () => {
    const stub = env.ENTRY_STORE.getByName(`cold-index-independent-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      dropOptional(sql);
      seed(sql, "treatments", 20_001);
      seed(sql, "devicestatus", 5);
      const before = rows(sql);
      const migration = measure(sql, () => state.storage.transactionSync(() => migrateColdReadIndexesV33(sql)));
      expect(migration.result).toEqual({ deviceStatusRecent: true, treatmentsApi3Order: false });
      expect(migration.collectionProbes.map(probe => [probe.collection, probe.limit]))
        .toEqual([["treatments", 20_001], ["devicestatus", 20_001]]);
      expect(migration.writes).toBeGreaterThanOrEqual(5);
      expect(migration.writes).toBeLessThanOrEqual(16);
      expect(rows(sql)).toEqual(before);
      return migration;
    });
    expect(report).toMatchInlineSnapshot(`
      {
        "collectionProbes": [
          {
            "collection": "treatments",
            "limit": 20001,
            "reads": 20001,
          },
          {
            "collection": "devicestatus",
            "limit": 20001,
            "reads": 6,
          },
        ],
        "reads": 60099,
        "result": {
          "deviceStatusRecent": true,
          "treatmentsApi3Order": false,
        },
        "statements": [
          "PRAGMA index_xinfo(documents_devicestatus_recent)",
          "PRAGMA index_xinfo(documents_treatments_api3_order)",
          "SELECT EXISTS( SELECT 1 FROM documents LIMIT 1 OFFSET 100000 ) AS present",
          "SELECT COUNT(*) AS count FROM ( SELECT 1 FROM documents WHERE collection = ? LIMIT ? )",
          "SELECT COUNT(*) AS count FROM ( SELECT 1 FROM documents WHERE collection = ? LIMIT ? )",
          "CREATE INDEX IF NOT EXISTS documents_devicestatus_recent ON documents(collection, sort_time DESC, updated_at DESC) WHERE collection = 'devicestatus'",
          "PRAGMA index_xinfo(documents_devicestatus_recent)",
          "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
          "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE type='index' AND name=? LIMIT 1",
          "PRAGMA index_xinfo(documents_treatments_api3_order)",
        ],
        "writes": 6,
      }
    `);
  }, 60_000);

  it("does not count an existing large treatment index against the missing status index's new-key budget", async () => {
    const stub = env.ENTRY_STORE.getByName(`cold-index-existing-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      dropOptional(sql);
      seed(sql, "treatments", 20_001);
      seed(sql, "devicestatus", 20_000);
      createExisting(sql, TREATMENTS);
      const before = rows(sql);
      const migration = measure(sql, () => state.storage.transactionSync(() => migrateColdReadIndexesV33(sql)));
      expect(migration.result).toEqual({ deviceStatusRecent: true, treatmentsApi3Order: true });
      expect(migration.collectionProbes.map(probe => [probe.collection, probe.limit])).toEqual([["devicestatus", 20_001]]);
      expect(migration.writes).toBeGreaterThanOrEqual(20_000);
      expect(migration.writes).toBeLessThanOrEqual(20_016);
      expect(migration.statements.filter(statement => statement.startsWith("CREATE INDEX"))).toHaveLength(1);
      expect(rows(sql)).toEqual(before);
      return migration;
    });
    expect(report).toMatchInlineSnapshot(`
      {
        "collectionProbes": [
          {
            "collection": "devicestatus",
            "limit": 20001,
            "reads": 20001,
          },
        ],
        "reads": 120485,
        "result": {
          "deviceStatusRecent": true,
          "treatmentsApi3Order": true,
        },
        "statements": [
          "PRAGMA index_xinfo(documents_devicestatus_recent)",
          "PRAGMA index_xinfo(documents_treatments_api3_order)",
          "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
          "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE type='index' AND name=? LIMIT 1",
          "SELECT EXISTS( SELECT 1 FROM documents LIMIT 1 OFFSET 100000 ) AS present",
          "SELECT COUNT(*) AS count FROM ( SELECT 1 FROM documents WHERE collection = ? LIMIT ? )",
          "CREATE INDEX IF NOT EXISTS documents_devicestatus_recent ON documents(collection, sort_time DESC, updated_at DESC) WHERE collection = 'devicestatus'",
          "PRAGMA index_xinfo(documents_devicestatus_recent)",
          "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
          "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE type='index' AND name=? LIMIT 1",
          "PRAGMA index_xinfo(documents_treatments_api3_order)",
          "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
        ],
        "writes": 20001,
      }
    `);
  }, 60_000);

  it("defers every missing native index beyond 100000 canonical rows and skips all scans when both indexes already exist", async () => {
    const stub = env.ENTRY_STORE.getByName(`cold-index-total-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      dropOptional(sql);
      seed(sql, "food", 99_999);
      seed(sql, "treatments", 1);
      seed(sql, "devicestatus", 1);
      const preservedSentinels = () => [
        sql.exec("SELECT * FROM documents WHERE collection='food' AND id IN (?,?) ORDER BY id", "000000000000000000000001", (99_999).toString(16).padStart(24, "0")).toArray(),
        sql.exec("SELECT * FROM documents WHERE collection='treatments' ORDER BY id").toArray(),
        sql.exec("SELECT * FROM documents WHERE collection='devicestatus' ORDER BY id").toArray(),
      ];
      const before = preservedSentinels();
      const deferred = measure(sql, () => state.storage.transactionSync(() => migrateColdReadIndexesV33(sql)));
      expect(deferred.result).toEqual({ deviceStatusRecent: false, treatmentsApi3Order: false });
      expect(deferred.writes).toBe(0);
      expect(deferred.reads).toBeGreaterThanOrEqual(100_001);
      expect(deferred.reads).toBeLessThanOrEqual(100_010);
      expect(deferred.collectionProbes).toEqual([]);
      expect(deferred.statements.some(statement => statement.startsWith("CREATE INDEX"))).toBe(false);
      createExisting(sql, TREATMENTS);
      createExisting(sql, STATUS);
      const existing = measure(sql, () => state.storage.transactionSync(() => migrateColdReadIndexesV33(sql)));
      expect(existing.result).toEqual({ deviceStatusRecent: true, treatmentsApi3Order: true });
      expect(existing.writes).toBe(0);
      expect(existing.statements.every(statement => statement.startsWith("PRAGMA") || statement.includes("FROM sqlite_master"))).toBe(true);
      expect(preservedSentinels()).toEqual(before);
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM documents").one().count).toBe(100_001);
      return { deferred, existing };
    });
    expect(report).toMatchInlineSnapshot(`
      {
        "deferred": {
          "collectionProbes": [],
          "reads": 100001,
          "result": {
            "deviceStatusRecent": false,
            "treatmentsApi3Order": false,
          },
          "statements": [
            "PRAGMA index_xinfo(documents_devicestatus_recent)",
            "PRAGMA index_xinfo(documents_treatments_api3_order)",
            "SELECT EXISTS( SELECT 1 FROM documents LIMIT 1 OFFSET 100000 ) AS present",
          ],
          "writes": 0,
        },
        "existing": {
          "collectionProbes": [],
          "reads": 147,
          "result": {
            "deviceStatusRecent": true,
            "treatmentsApi3Order": true,
          },
          "statements": [
            "PRAGMA index_xinfo(documents_devicestatus_recent)",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE type='index' AND name=? LIMIT 1",
            "PRAGMA index_xinfo(documents_treatments_api3_order)",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE type='index' AND name=? LIMIT 1",
          ],
          "writes": 0,
        },
      }
    `);
  }, 60_000);

  it("propagates quota failure and outer rollback without caching transient capabilities or dropping preexisting indexes", async () => {
    const stub = env.ENTRY_STORE.getByName(`cold-index-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      dropOptional(sql);
      seed(sql, "treatments", 3);
      seed(sql, "devicestatus", 4);
      const before = rows(sql);
      const exec = sql.exec.bind(sql);
      const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
        const cursor = exec(statement, ...bindings);
        if (statement.includes(`CREATE INDEX IF NOT EXISTS ${STATUS}`)) {
          expect(readColdReadIndexCapabilities(sql)).toEqual({ deviceStatusRecent: true, treatmentsApi3Order: true });
          throw new DurableObjectWriteQuotaError();
        }
        return cursor;
      });
      try {
        expect(() => state.storage.transactionSync(() => migrateColdReadIndexesV33(sql)))
          .toThrow("Exceeded allowed rows written in Durable Objects free tier.");
      } finally { spy.mockRestore(); }
      expect(readColdReadIndexCapabilities(sql)).toEqual({ deviceStatusRecent: false, treatmentsApi3Order: false });
      expect(rows(sql)).toEqual(before);
      createExisting(sql, TREATMENTS);
      expect(() => state.storage.transactionSync(() => {
        expect(migrateColdReadIndexesV33(sql)).toEqual({ deviceStatusRecent: true, treatmentsApi3Order: true });
        throw new Error("outer v33 marker rollback");
      })).toThrow("outer v33 marker rollback");
      expect(readColdReadIndexCapabilities(sql)).toEqual({ deviceStatusRecent: false, treatmentsApi3Order: true });
      expect(rows(sql)).toEqual(before);
      expect(state.storage.transactionSync(() => migrateColdReadIndexesV33(sql)))
        .toEqual({ deviceStatusRecent: true, treatmentsApi3Order: true });
    });
  });

  it("does not trust or replace same-name indexes with a different direction, tie, collation or collection predicate", async () => {
    const stub = env.ENTRY_STORE.getByName(`cold-index-untrusted-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const variants = [
        { name: STATUS, columns: "collection,sort_time ASC,updated_at DESC", predicate: "collection='devicestatus'" },
        { name: STATUS, columns: "collection,sort_time DESC,updated_at DESC,id ASC", predicate: "collection='devicestatus'" },
        { name: STATUS, columns: "collection COLLATE NOCASE,sort_time DESC,updated_at DESC", predicate: "collection='devicestatus'" },
        { name: STATUS, columns: "collection,sort_time DESC,updated_at DESC", predicate: "collection='food'" },
        { name: STATUS, columns: "collection,sort_time DESC,updated_at DESC", predicate: "collection='DEVICESTATUS'" },
        { name: STATUS, columns: "collection,sort_time DESC,updated_at DESC", predicate: "collection='devicestatus' AND is_valid=1" },
        { name: TREATMENTS, columns: "collection,sort_time DESC,srv_modified ASC,id ASC", predicate: "collection='treatments'" },
        { name: TREATMENTS, columns: "collection,sort_time DESC,srv_modified DESC,id ASC", predicate: "collection='devicestatus'" },
      ];
      for (const variant of variants) {
        dropOptional(sql);
        sql.exec(`CREATE INDEX ${variant.name} ON documents(${variant.columns}) WHERE ${variant.predicate}`);
        const definition = () => sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name=?", variant.name).one().sql;
        const before = definition();
        expect(readColdReadIndexCapabilities(sql)).toEqual({ deviceStatusRecent: false, treatmentsApi3Order: false });
        const migration = state.storage.transactionSync(() => migrateColdReadIndexesV33(sql));
        expect(migration).toEqual(variant.name === STATUS
          ? { deviceStatusRecent: false, treatmentsApi3Order: true }
          : { deviceStatusRecent: true, treatmentsApi3Order: false });
        expect(definition()).toBe(before);
      }
    });
  });

  it("rechecks individual live definitions with rowid hints using one data row on repeated lookups", async () => {
    const stub = env.ENTRY_STORE.getByName(`cold-index-address-budget-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      dropOptional(sql);
      createExisting(sql, STATUS);
      createExisting(sql, TREATMENTS);
      const lookupSql = uncachedSqlIdentity(sql);
      const statusCold = measure(sql, () => hasDeviceStatusRecentReadIndex(lookupSql));
      const statusWarm = measure(sql, () => hasDeviceStatusRecentReadIndex(lookupSql));
      expect(statusCold.result).toBe(true);
      expect(statusWarm.result).toBe(true);
      expect(statusWarm.reads).toBe(1);
      expect(statusCold.reads).toBeGreaterThan(statusWarm.reads);
      expect(statusWarm.statements).toEqual([
        `PRAGMA index_xinfo(${STATUS})`, "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
      ]);
      const treatmentCold = measure(sql, () => hasTreatmentsApi3OrderReadIndex(lookupSql));
      const treatmentWarm = measure(sql, () => hasTreatmentsApi3OrderReadIndex(lookupSql));
      expect(treatmentCold.result).toBe(true);
      expect(treatmentWarm.result).toBe(true);
      expect(treatmentWarm.reads).toBe(1);
      expect(treatmentCold.reads).toBeGreaterThan(treatmentWarm.reads);
      const both = measure(sql, () => readColdReadIndexCapabilities(lookupSql));
      expect(both.result).toEqual({ deviceStatusRecent: true, treatmentsApi3Order: true });
      expect(both.reads).toBe(2);
      expect([statusCold, statusWarm, treatmentCold, treatmentWarm, both].every(item => item.writes === 0)).toBe(true);
      return { statusCold, statusWarm, treatmentCold, treatmentWarm, both };
    });
    expect(report).toMatchInlineSnapshot(`
      {
        "both": {
          "collectionProbes": [],
          "reads": 2,
          "result": {
            "deviceStatusRecent": true,
            "treatmentsApi3Order": true,
          },
          "statements": [
            "PRAGMA index_xinfo(documents_devicestatus_recent)",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
            "PRAGMA index_xinfo(documents_treatments_api3_order)",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
          ],
          "writes": 0,
        },
        "statusCold": {
          "collectionProbes": [],
          "reads": 72,
          "result": true,
          "statements": [
            "PRAGMA index_xinfo(documents_devicestatus_recent)",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE type='index' AND name=? LIMIT 1",
          ],
          "writes": 0,
        },
        "statusWarm": {
          "collectionProbes": [],
          "reads": 1,
          "result": true,
          "statements": [
            "PRAGMA index_xinfo(documents_devicestatus_recent)",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
          ],
          "writes": 0,
        },
        "treatmentCold": {
          "collectionProbes": [],
          "reads": 73,
          "result": true,
          "statements": [
            "PRAGMA index_xinfo(documents_treatments_api3_order)",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE type='index' AND name=? LIMIT 1",
          ],
          "writes": 0,
        },
        "treatmentWarm": {
          "collectionProbes": [],
          "reads": 1,
          "result": true,
          "statements": [
            "PRAGMA index_xinfo(documents_treatments_api3_order)",
            "SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE rowid=?",
          ],
          "writes": 0,
        },
      }
    `);
  });

  it("validates the name after rollback reuses a hinted rowid and observes definitions changing at the same address", async () => {
    const stub = env.ENTRY_STORE.getByName(`cold-index-address-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      dropOptional(sql);
      const lookupSql = uncachedSqlIdentity(sql);
      const rowid = (name: string) => sql.exec<{ rowid: number }>(
        "SELECT rowid FROM sqlite_master WHERE type='index' AND name=?", name,
      ).one().rowid;
      let transientAddress = 0;
      expect(() => state.storage.transactionSync(() => {
        createExisting(sql, STATUS);
        transientAddress = rowid(STATUS);
        expect(hasDeviceStatusRecentReadIndex(lookupSql)).toBe(true);
        throw new Error("rollback transient index and retain only its address hint");
      })).toThrow("rollback transient index");
      // A valid-looking definition at the reused address has a different
      // name. The target index exists elsewhere with the wrong predicate.
      sql.exec(`CREATE INDEX audit_reused_definition_address ON documents(collection,sort_time DESC,updated_at DESC)
        WHERE collection='devicestatus'`);
      expect(rowid("audit_reused_definition_address")).toBe(transientAddress);
      sql.exec(`CREATE INDEX ${STATUS} ON documents(collection,sort_time DESC,updated_at DESC) WHERE collection='food'`);
      expect(hasDeviceStatusRecentReadIndex(lookupSql)).toBe(false);
      const targetAddress = rowid(STATUS);
      sql.exec(`DROP INDEX ${STATUS}`);
      createExisting(sql, STATUS);
      expect(rowid(STATUS)).toBe(targetAddress);
      expect(hasDeviceStatusRecentReadIndex(lookupSql)).toBe(true);
      expect(() => state.storage.transactionSync(() => {
        sql.exec(`DROP INDEX ${STATUS}`);
        sql.exec(`CREATE INDEX audit_uncommitted_address_fill ON documents(collection,sort_time DESC,updated_at DESC)
          WHERE collection='devicestatus'`);
        sql.exec(`CREATE INDEX ${STATUS} ON documents(collection,sort_time DESC,updated_at DESC) WHERE collection='food'`);
        expect(hasDeviceStatusRecentReadIndex(lookupSql)).toBe(false);
        throw new Error("restore prior committed index definition");
      })).toThrow("restore prior committed index definition");
      sql.exec(`CREATE INDEX audit_second_reused_address ON documents(collection,sort_time DESC,updated_at DESC)
        WHERE collection='devicestatus'`);
      expect(hasDeviceStatusRecentReadIndex(lookupSql)).toBe(true);
      sql.exec(`DROP INDEX ${STATUS}`);
      expect(hasDeviceStatusRecentReadIndex(lookupSql)).toBe(false);
    });
  });
});
