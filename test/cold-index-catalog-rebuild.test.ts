import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { DEVICE_STATUS_RECENT_READ_INDEX as INDEX, hasDeviceStatusRecentReadIndex } from "../src/cold-read-indexes";

function observe(sql: SqlStorage) {
  const execute = sql.exec.bind(sql);
  const calls: { sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = execute(statement, ...bindings); calls.push({ sql: statement, cursor }); return cursor;
  });
  try {
    const ready = hasDeviceStatusRecentReadIndex(sql);
    return { ready, reads: calls.reduce((sum, call) => sum + call.cursor.rowsRead, 0),
      writes: calls.reduce((sum, call) => sum + call.cursor.rowsWritten, 0),
      statements: calls.map(call => call.sql) };
  } finally { spy.mockRestore(); }
}

describe("cold optional-index address reconstruction", () => {
  it("stops the unique name lookup before a later catalog tail after actual eviction, with no writes", async () => {
    const stub = env.ENTRY_STORE.getByName(`cold-index-tail-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      // The optional index already exists. Add unrelated later schema rows so
      // the old toArray() name lookup demonstrably scans an unnecessary tail.
      for (let n = 0; n < 60; n++) state.storage.sql.exec(`CREATE TABLE audit_catalog_tail_${n}(value INTEGER)`);
    });
    await evictDurableObject(stub);
    const report = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const old = sql.exec("SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE type='index' AND name=?", INDEX);
      expect(old.toArray()).toHaveLength(1);
      const cold = observe(sql);
      expect(cold.ready).toBe(true); expect(cold.writes).toBe(0);
      expect(cold.statements).toContain("SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE type='index' AND name=? LIMIT 1");
      expect(cold.reads).toBeLessThanOrEqual(old.rowsRead - 60);
      const warm = observe(sql);
      expect(warm).toMatchObject({ ready: true, reads: 1, writes: 0 });
      expect(warm.statements).not.toContain("SELECT rowid,type,name,tbl_name,sql FROM sqlite_master WHERE type='index' AND name=? LIMIT 1");
      return { catalogTailRows: 60, precedingNameLookupReads: old.rowsRead, cold, warm };
    });
    console.info(`COLD_INDEX_CATALOG_TAIL=${JSON.stringify(report)}`);
  });

  it("continues to inspect current definitions through DROP, incompatible recreation and outer DDL rollback", async () => {
    const stub = env.ENTRY_STORE.getByName(`cold-index-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      expect(observe(sql)).toMatchObject({ ready: true, writes: 0 });
      expect(() => state.storage.transactionSync(() => {
        sql.exec(`DROP INDEX ${INDEX}`);
        expect(observe(sql)).toMatchObject({ ready: false, writes: 0 });
        // Same columns and name are insufficient: the stricter partial
        // predicate omits canonical rows needed by the existing read path.
        sql.exec(`CREATE INDEX ${INDEX} ON documents(collection,sort_time DESC,updated_at DESC)
          WHERE collection='devicestatus' AND is_valid!=0`);
        expect(observe(sql)).toMatchObject({ ready: false, writes: 0 });
        throw new Error("rollback incompatible optional index");
      })).toThrow("rollback incompatible optional index");
      expect(observe(sql)).toMatchObject({ ready: true, writes: 0 });
    });
  });
});
