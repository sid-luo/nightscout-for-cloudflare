import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import { AlertDeviceStatusQueryCache } from "../src/realtime/alert-device-status-query-cache";
import type { CachedDeviceStatusRow } from "../src/realtime/device-status-query-cache";

const TABLE = "nscf_device_status_read_checkpoint";
const DISABLED = "ar2 simplealarms errorcodes treatmentnotify timeago pump openaps xdripjs loop bwp cage sage iage bage dbsize";
interface Internal {
  env: Record<string, unknown>;
  alertDeviceStatusQueries: AlertDeviceStatusQueryCache<CachedDeviceStatusRow>;
  alertDeviceStatusCheckpoint: unknown;
  resolvedAutomaticNotificationRuntime(at: number): unknown;
  automaticNotificationData(at: number, runtime: unknown): unknown;
}
class OriginalAlertReads extends AlertDeviceStatusQueryCache<CachedDeviceStatusRow> {
  override *read(_key: string, _fields: readonly string[], _lower: number, _upper: number,
    load: () => Iterable<CachedDeviceStatusRow>): IterableIterator<CachedDeviceStatusRow> { yield* load(); }
  override rememberFuture(_row: CachedDeviceStatusRow | undefined): void {}
  override future(_key: string, _upper: number, load: () => CachedDeviceStatusRow | undefined): CachedDeviceStatusRow | undefined { return load(); }
}
function configure(instance: EntryStore): Internal {
  const internal = instance as unknown as Internal;
  Object.assign(internal.env, { ENABLE: "upbat", DISABLE: DISABLED, UPBAT_ENABLE_ALERTS: "true", ALARM_TYPES: "predict" });
  return internal;
}
function read(internal: Internal, now: number): unknown {
  const data = internal.automaticNotificationData(now, internal.resolvedAutomaticNotificationRuntime(now)) as Record<string, unknown>;
  // The optional derived table legitimately changes SQLite's physical size.
  // Compare every clinical input; actual alert decisions are also covered by
  // the true-eviction test with the original SQL reader.
  const { dbstats: _physicalDatabaseSize, ...clinical } = data;
  return clinical;
}
function oracle(internal: Internal, now: number): unknown {
  const cache = internal.alertDeviceStatusQueries, checkpoint = internal.alertDeviceStatusCheckpoint;
  internal.alertDeviceStatusQueries = new OriginalAlertReads();
  internal.alertDeviceStatusCheckpoint = { hydrate() {}, persist() {} };
  try { return read(internal, now); }
  finally { internal.alertDeviceStatusQueries = cache; internal.alertDeviceStatusCheckpoint = checkpoint; }
}
function insert(sql: SqlStorage, id: string, at: number, battery = 19): void {
  sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
    VALUES('devicestatus',?,?,?,?,?,1)`, id, JSON.stringify({ _id: id, created_at: new Date(at).toISOString(), uploader: { battery } }), at, at, at);
}
async function measure(sql: SqlStorage, operation: () => unknown) {
  const exec = sql.exec.bind(sql), cursors: { sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...parameters) => {
    const cursor = exec(statement, ...parameters); cursors.push({ sql: statement, cursor }); return cursor;
  });
  try {
    const result = operation();
    return { result, reads: cursors.reduce((sum, row) => sum + row.cursor.rowsRead, 0),
      writes: cursors.reduce((sum, row) => sum + row.cursor.rowsWritten, 0),
      deviceReads: cursors.filter(row => row.sql.includes("collection = 'devicestatus'"))
        .reduce((sum, row) => sum + row.cursor.rowsRead, 0) };
  } finally { spy.mockRestore(); }
}

describe("durable raw DeviceStatus alert checkpoints", () => {
  it("does not create a checkpoint table or triggers for inactive alert/API3 readers", async () => {
    const stub = env.ENTRY_STORE.getByName(`alert-checkpoint-inactive-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const internal = instance as unknown as Internal;
      Object.assign(internal.env, { ENABLE: "", DISABLE: DISABLED + " upbat", UPBAT_ENABLE_ALERTS: "false" });
      await instance.createDocuments("devicestatus", JSON.stringify([{ created_at: new Date().toISOString(), uploader: { battery: 19 } }]));
      read(internal, Date.now());
      expect(state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE name LIKE 'nscf%checkpoint%'").toArray()).toEqual([]);
    });
  });

  it("keeps future activation and direct insert/update/delete/collection moves exact across cold restore", async () => {
    const stub = env.ENTRY_STORE.getByName(`alert-checkpoint-source-${crypto.randomUUID()}`), now = Date.now();
    await runInDurableObject(stub, (instance: EntryStore, state) => {
      const internal = configure(instance);
      insert(state.storage.sql, "present", now - 1000);
      expect(read(internal, now)).toEqual(oracle(internal, now));
      insert(state.storage.sql, "future", now + 60_000);
      expect(read(internal, now)).toEqual(oracle(internal, now));
      expect(state.storage.sql.exec<{ valid_mask: number }>(`SELECT valid_mask FROM ${TABLE}`).one().valid_mask & 1).toBe(1);
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const internal = configure(instance);
      const restored = await measure(state.storage.sql, () => read(internal, now + 59_999));
      expect(restored.result).toEqual(oracle(internal, now + 59_999));
      expect(restored.deviceReads).toBe(0);
      expect(restored.writes).toBe(0);
      expect(read(internal, now + 60_000)).toEqual(oracle(internal, now + 60_000));
      const unchanged = await measure(state.storage.sql, () => read(internal, now + 60_001));
      expect(unchanged.deviceReads).toBe(0); expect(unchanged.writes).toBe(0);
      state.storage.sql.exec("UPDATE documents SET body=json_set(body,'$.uploader.battery',90) WHERE collection='devicestatus' AND id='future'");
      expect(read(internal, now + 60_002)).toEqual(oracle(internal, now + 60_002));
      state.storage.sql.exec("UPDATE documents SET collection='treatments' WHERE collection='devicestatus' AND id='future'");
      expect(read(internal, now + 60_003)).toEqual(oracle(internal, now + 60_003));
      state.storage.sql.exec("DELETE FROM documents WHERE collection='devicestatus' AND id='present'");
      expect(read(internal, now + 60_004)).toEqual(oracle(internal, now + 60_004));
    });
  });

  it("discards rolled-back source/checkpoint input and fails closed after corrupted payload", async () => {
    const stub = env.ENTRY_STORE.getByName(`alert-checkpoint-rollback-${crypto.randomUUID()}`), now = Date.now();
    await runInDurableObject(stub, (instance: EntryStore, state) => {
      const internal = configure(instance); insert(state.storage.sql, "committed", now - 1000);
      const committed = read(internal, now);
      const checkpoint = state.storage.sql.exec(`SELECT * FROM ${TABLE}`).one();
      expect(() => state.storage.transactionSync(() => {
        insert(state.storage.sql, "rollback", now);
        expect(read(internal, now)).toEqual(oracle(internal, now));
        throw new Error("synthetic transaction rollback");
      })).toThrow("synthetic transaction rollback");
      expect(state.storage.sql.exec(`SELECT * FROM ${TABLE}`).one()).toEqual(checkpoint);
      expect(read(internal, now)).toEqual(committed);
      state.storage.sql.exec(`UPDATE ${TABLE} SET alert_payload = '{broken' WHERE id=1`);
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const internal = configure(instance);
      const cold = await measure(state.storage.sql, () => read(internal, now));
      expect(cold.result).toEqual(oracle(internal, now)); expect(cold.deviceReads).toBeGreaterThan(0);
      const warm = await measure(state.storage.sql, () => read(internal, now));
      expect(warm.result).toEqual(cold.result); expect(warm.deviceReads).toBe(0); expect(warm.writes).toBe(0);
    });
  });

  it("keeps original clinical input after optional snapshot writes fail", async () => {
    const stub = env.ENTRY_STORE.getByName(`alert-checkpoint-save-failure-${crypto.randomUUID()}`), now = Date.now();
    await runInDurableObject(stub, (instance: EntryStore, state) => {
      const internal = configure(instance); insert(state.storage.sql, "present", now - 1000);
      const expected = oracle(internal, now), exec = state.storage.sql.exec.bind(state.storage.sql);
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((statement, ...parameters) => {
        if (statement.includes("SET alert_payload =")) throw new Error("synthetic optional checkpoint write failure");
        return exec(statement, ...parameters);
      });
      try {
        expect(read(internal, now)).toEqual(expected);
        insert(state.storage.sql, "changed", now);
        expect(read(internal, now)).toEqual(oracle(internal, now));
      } finally { spy.mockRestore(); }
      expect(state.storage.sql.exec<{ valid_mask: number }>(`SELECT valid_mask FROM ${TABLE}`).one().valid_mask & 1).toBe(0);
    });
  });
});
