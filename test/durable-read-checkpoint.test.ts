import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { deflateSync } from "node:zlib";
import { DurableReadCheckpoint, type DurableReadCheckpointCache } from "../src/durable-read-checkpoint";

const TABLE = "nscf_device_status_read_checkpoint";
class Cache implements DurableReadCheckpointCache {
  checkpointRevision = 0;
  value: unknown;
  clear(): void { this.value = undefined; this.checkpointRevision++; }
  set(value: unknown): void { this.value = value; this.checkpointRevision++; }
  snapshotCheckpoint(): unknown { return this.value; }
  restoreCheckpoint(value: unknown): boolean { this.set(value); return true; }
}
const stub = () => env.ENTRY_STORE.getByName(`checkpoint-unit-${crypto.randomUUID()}`);
function insert(storage: DurableObjectStorage, id: string): void {
  storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
    VALUES('devicestatus',?,'{}',1,1,1,1)`, id);
}
function row(storage: DurableObjectStorage): Record<string, SqlStorageValue> {
  return storage.sql.exec(`SELECT * FROM ${TABLE} WHERE id = 1`).one();
}

describe("durable raw-read checkpoint authority", () => {
  it("leaves tenants without participating readers uninitialized and incurs no source-row reads or writes", async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const original = state.storage.sql.exec.bind(state.storage.sql);
      const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...args) => {
        const cursor = original(sql, ...args); cursors.push(cursor); return cursor;
      });
      try {
        const checkpoint = new DurableReadCheckpoint(state.storage, "api3"), cache = new Cache();
        checkpoint.hydrate(cache, { create: false });
        checkpoint.beforeMutation(cache, { create: false });
        checkpoint.afterMutation(cache); checkpoint.persist(cache);
        expect(cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0)).toBe(0);
        expect(cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0)).toBe(0);
      } finally { spy.mockRestore(); }
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = ?", TABLE).toArray()).toEqual([]);
    });
  });

  it("restores lossless bounded snapshots and writes nothing on unchanged heartbeats", async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const cache = new Cache(), checkpoint = new DurableReadCheckpoint(state.storage, "alert");
      checkpoint.hydrate(cache, { create: true });
      const value = { rows: Array.from({ length: 1000 }, (_, id) => ({ id, body: "中文\ud800" + "predictions".repeat(300) })) };
      cache.set(value); checkpoint.persist(cache);
      expect(row(state.storage).valid_mask).toBe(1);
      const original = state.storage.sql.exec.bind(state.storage.sql);
      const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...args) => {
        const cursor = original(sql, ...args); cursors.push(cursor); return cursor;
      });
      try {
        for (let tick = 0; tick < 4; tick++) {
          const cold = new DurableReadCheckpoint(state.storage, "alert"), restored = new Cache();
          cold.hydrate(restored, { create: false });
          expect(restored.value).toEqual(value); cold.persist(restored);
        }
        expect(cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0)).toBe(0);
        expect(cursors.filter(cursor => cursor.rowsRead > 100).length).toBe(0);
      } finally { spy.mockRestore(); }
    });
  });

  it("invalidates both components on every direct mutation, including a second write while already invalid", async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const alert = new Cache(), api = new Cache();
      const a = new DurableReadCheckpoint(state.storage, "alert"), b = new DurableReadCheckpoint(state.storage, "api3");
      a.hydrate(alert, { create: true }); alert.set(["alert"]); a.persist(alert);
      b.hydrate(api, { create: true }); api.set(["api"]); b.persist(api);
      expect(row(state.storage).valid_mask).toBe(3);
      const generation = row(state.storage).generation as number;
      insert(state.storage, "first");
      expect(row(state.storage).valid_mask).toBe(0);
      expect(row(state.storage).generation).toBe(generation + 1);
      b.hydrate(api, { create: false }); expect(api.value).toBeUndefined();
      api.set(["fresh but unsaved"]);
      insert(state.storage, "second");
      b.hydrate(api, { create: false }); expect(api.value).toBeUndefined();
      expect(row(state.storage).generation).toBe(generation + 2);
      state.storage.sql.exec("UPDATE documents SET body = '{\"changed\":true}' WHERE id = 'second'");
      state.storage.sql.exec("DELETE FROM documents WHERE id = 'second'");
      expect(row(state.storage).generation).toBe(generation + 4);
    });
  });

  it("restores a valid 116848-byte stream across workerd output-buffer growth boundaries", async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const value = { body: "A".repeat(116_837) };
      expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBe(116_848);
      const cache = new Cache(), checkpoint = new DurableReadCheckpoint(state.storage, "alert");
      checkpoint.hydrate(cache, { create: true }); cache.set(value); checkpoint.persist(cache);
      const restored = new Cache(); new DurableReadCheckpoint(state.storage, "alert").hydrate(restored, { create: false });
      expect(restored.value).toEqual(value);
    });
  });

  it("rolls canonical source changes and checkpoint invalidation back together", async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const cache = new Cache(), checkpoint = new DurableReadCheckpoint(state.storage, "api3");
      checkpoint.hydrate(cache, { create: true }); cache.set({ ids: ["committed"] }); checkpoint.persist(cache);
      const before = row(state.storage);
      expect(() => state.storage.transactionSync(() => { insert(state.storage, "rollback"); throw new Error("rollback"); })).toThrow("rollback");
      expect(row(state.storage)).toEqual(before);
      const restored = new Cache(); new DurableReadCheckpoint(state.storage, "api3").hydrate(restored, { create: false });
      expect(restored.value).toEqual({ ids: ["committed"] });
      expect(state.storage.sql.exec("SELECT id FROM documents WHERE id = 'rollback'").toArray()).toEqual([]);
    });
  });

  it("repairs missing triggers and rejects their prior authority", async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const cache = new Cache(), checkpoint = new DurableReadCheckpoint(state.storage, "api3");
      checkpoint.hydrate(cache, { create: true }); cache.set({ stale: true }); checkpoint.persist(cache);
      state.storage.sql.exec("DROP TRIGGER nscf_ds_checkpoint_insert");
      insert(state.storage, "unobserved");
      const restored = new Cache(), cold = new DurableReadCheckpoint(state.storage, "api3");
      cold.hydrate(restored, { create: false });
      expect(restored.value).toBeUndefined(); expect(row(state.storage).valid_mask).toBe(0);
      const generation = row(state.storage).generation as number;
      insert(state.storage, "observed"); expect(row(state.storage).generation).toBe(generation + 1);
      cold.hydrate(restored, { create: false }); restored.set({ fresh: true }); cold.persist(restored);
      const definition = state.storage.sql.exec<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE name = 'nscf_ds_checkpoint_insert'").one().sql;
      const priorIdentity = state.storage.sql.exec<{ identity: number }>(
        "SELECT rowid AS identity FROM sqlite_master WHERE name = 'nscf_ds_checkpoint_insert'").one().identity;
      state.storage.sql.exec("DROP TRIGGER nscf_ds_checkpoint_insert");
      insert(state.storage, "during-gap");
      // SQLite can immediately reuse the highest schema rowid. This case
      // explicitly exercises a changed identity, rather than pretending to
      // detect identical privileged recreation at the exact same identity.
      state.storage.sql.exec("CREATE TABLE nscf_checkpoint_identity_probe(id INTEGER)");
      state.storage.sql.exec(definition);
      expect(state.storage.sql.exec<{ identity: number }>(
        "SELECT rowid AS identity FROM sqlite_master WHERE name = 'nscf_ds_checkpoint_insert'").one().identity).not.toBe(priorIdentity);
      state.storage.sql.exec("DROP TABLE nscf_checkpoint_identity_probe");
      cold.hydrate(restored, { create: false });
      expect(restored.value).toBeUndefined(); // same text at a new schema identity cannot retain authority
      state.storage.sql.exec("DROP TABLE nscf_device_status_read_checkpoint");
      cold.hydrate(restored, { create: false }); expect(restored.value).toBeUndefined();
    });
  });

  it("rejects corrupt and decompression-bomb payloads before restoring cache authority", async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const cache = new Cache(), checkpoint = new DurableReadCheckpoint(state.storage, "alert");
      checkpoint.hydrate(cache, { create: true }); cache.set({ fresh: true }); checkpoint.persist(cache);
      for (const payload of ["not-json", JSON.stringify({ codec: "zlib-json-v1", bytes: 2 ** 30, data: "AAAA" }),
        JSON.stringify({ codec: "zlib-json-v1", bytes: 1, data: "AAAA" }),
        JSON.stringify({ codec: "zlib-json-v1", bytes: 1, data: deflateSync(new TextEncoder().encode("{}")).toString("base64") })]) {
        state.storage.sql.exec(`UPDATE ${TABLE} SET alert_payload = ?, valid_mask = 1 WHERE id = 1`, payload);
        const restored = new Cache(); new DurableReadCheckpoint(state.storage, "alert").hydrate(restored, { create: false });
        expect(restored.value).toBeUndefined();
      }
    });
  });

  it("persists the eight-save budget across cold restore and canonical invalidation", async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      let now = 1_800_000_000_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        const cache = new Cache(), checkpoint = new DurableReadCheckpoint(state.storage, "api3");
        checkpoint.hydrate(cache, { create: true });
        const exports = vi.spyOn(cache, "snapshotCheckpoint");
        for (let attempt = 1; attempt <= 20; attempt++) { cache.set({ attempt }); checkpoint.persist(cache); }
        expect(row(state.storage).api3_saves).toBe(8);
        expect(exports).toHaveBeenCalledTimes(8); exports.mockRestore();
        const restored = new Cache(), cold = new DurableReadCheckpoint(state.storage, "api3");
        cold.hydrate(restored, { create: false }); expect(restored.value).toEqual({ attempt: 8 });
        cold.beforeMutation(restored, { create: false }); insert(state.storage, "budget");
        restored.set({ afterUpload: true }); cold.afterMutation(restored); cold.persist(restored);
        expect(row(state.storage).valid_mask).toBe(0); expect(row(state.storage).api3_saves).toBe(8);
        now += 60_000; cold.persist(restored);
        expect(row(state.storage).valid_mask).toBe(2); expect(row(state.storage).api3_saves).toBe(1);
      } finally { clock.mockRestore(); }
    });
  });

  it("contains optional setup and save failures without trusting stale input or changing canonical writes", async () => {
    await runInDurableObject(stub(), (_instance, state) => {
      const cache = new Cache(), checkpoint = new DurableReadCheckpoint(state.storage, "api3");
      const original = state.storage.sql.exec.bind(state.storage.sql);
      let mode = "setup";
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...args) => {
        if (mode === "setup" && sql.startsWith(`CREATE TABLE ${TABLE}`)
          || mode === "save" && sql.startsWith(`UPDATE ${TABLE} SET api3_payload`)) throw new Error("SQLITE_FULL: write quota");
        return original(sql, ...args);
      });
      try {
        cache.set({ untrusted: true }); checkpoint.hydrate(cache, { create: true }); expect(cache.value).toBeUndefined();
        mode = "normal"; cache.set({ untrustedAgain: true }); checkpoint.hydrate(cache, { create: true });
        expect(cache.value).toBeUndefined(); // disabled controllers cannot reuse newly learned memory proofs
        checkpoint.reset(); checkpoint.hydrate(cache, { create: true }); cache.set({ old: true }); checkpoint.persist(cache);
        checkpoint.beforeMutation(cache, { create: false }); insert(state.storage, "canonical-success");
        cache.set({ fresh: true }); checkpoint.afterMutation(cache);
        mode = "save"; expect(() => checkpoint.persist(cache)).not.toThrow();
        expect(cache.value).toBeUndefined(); expect(row(state.storage).valid_mask).toBe(0);
        mode = "normal";
        const restored = new Cache(); new DurableReadCheckpoint(state.storage, "api3").hydrate(restored, { create: false });
        expect(restored.value).toBeUndefined();
        expect(state.storage.sql.exec("SELECT id FROM documents WHERE id = 'canonical-success'").toArray()).toHaveLength(1);
      } finally { spy.mockRestore(); }
    });
  });
});
