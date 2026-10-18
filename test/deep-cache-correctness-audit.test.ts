import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore, JsonDocument } from "../src/entry-store";

const DAY = 86_400_000;
const id = (value: number) => value.toString(16).padStart(24, "0");
const OPTIONS = JSON.stringify({ canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: true });

interface Internal {
  pluginPropertyContext(at: number): { treatments: JsonDocument[]; devicestatus: JsonDocument[] };
  realtimeEntryQueries: { clear(): void };
  realtimeDeviceStatusQueries: { clear(): void };
  recentTreatmentQueries: { clear(): void };
  boundedTreatmentQueries: { clear(): void };
  legacyDeviceStatusQueries: { clear(): void };
  legacyDeviceStatusCandidates: { clear(): void };
  legacyTreatmentQueries: { clear(): void };
  realtimeAuxiliaryQueries: Record<string, { clear(): void }>;
  activeProfileSwitchCache: unknown;
  realtime: { recordApi3StorageMutationInTransaction(event: unknown): void };
}

function clearReadCaches(instance: EntryStore): void {
  const internal = instance as unknown as Internal;
  for (const cache of [internal.realtimeEntryQueries, internal.realtimeDeviceStatusQueries,
    internal.recentTreatmentQueries, internal.boundedTreatmentQueries, internal.legacyDeviceStatusQueries,
    internal.legacyDeviceStatusCandidates, internal.legacyTreatmentQueries,
    ...Object.values(internal.realtimeAuxiliaryQueries)]) cache.clear();
  internal.activeProfileSwitchCache = undefined;
}

function insert(storage: DurableObjectStorage, collection: string, key: string, at: number, body: JsonDocument): void {
  storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
    VALUES(?,?,?,?,?,?)`, collection, key, JSON.stringify(body), at, at, at);
}

function treatment(storage: DurableObjectStorage, key: number, at: number, extra: JsonDocument = {}): void {
  insert(storage, "treatments", id(key), at, { created_at: new Date(at).toISOString(), eventType: "Note", ...extra });
}

function isOrdinaryWindow(sql: string): boolean {
  return sql.includes("collection = 'treatments'") && sql.includes("LIMIT 1000") && sql.includes("FROM (");
}

async function comparePropertyContext(instance: EntryStore, at: number): Promise<unknown> {
  const warm = JSON.parse(await instance.getPluginPropertyContextJson(at));
  clearReadCaches(instance);
  const fresh = JSON.parse(await instance.getPluginPropertyContextJson(at));
  expect(warm, `warm/fresh properties at ${at}`).toEqual(fresh);
  return warm;
}

describe("deep real EntryStore cache correctness audit", () => {
  it("preserves tied latest-N frames through future boundaries, long jumps and clock reversals", async () => {
    const stub = env.ENTRY_STORE.getByName(`deep-window-clock-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const start = Date.now();
      state.storage.transactionSync(() => {
        for (let n = 0; n < 1050; n++) treatment(state.storage, n, start - Math.floor(n / 50) * 60_000);
        treatment(state.storage, 2000, start + 30_000, { eventType: "Sensor Change" });
        treatment(state.storage, 2001, start + 60_000, { eventType: "Profile Switch", duration: 0, profile: "Future" });
      });
      // Constructor activation can cache an empty root snapshot. Direct SQL
      // fixtures bypass mutation hooks, so invalidate before the first read.
      clearReadCaches(instance);
      const clock = vi.spyOn(Date, "now");
      try {
        clock.mockReturnValue(start);
        const initial = JSON.parse(await instance.getPluginPropertyContextJson(start)) as { treatments: JsonDocument[] };
        expect(initial.treatments).toHaveLength(1000);
        expect(initial.treatments.some(row => row._id === id(2000))).toBe(false);
        const scan = vi.spyOn(state.storage.sql, "exec");
        clock.mockReturnValue(start + 1000);
        await instance.getPluginPropertyContextJson(start + 1000);
        expect(scan.mock.calls.filter(([sql]) => isOrdinaryWindow(sql))).toHaveLength(0);
        scan.mockRestore();
        for (const delta of [29_999, 30_000, 59_999, 60_000, 60_001, 0, -60_000, 3 * DAY, 2 * DAY,
          64 * DAY, 63 * DAY, 366 * DAY, 365 * DAY, 0]) {
          const at = start + delta;
          clock.mockReturnValue(at);
          await comparePropertyContext(instance, at);
          const warmFrame = JSON.parse(await instance.getDdataSnapshotJson(at, true));
          clearReadCaches(instance);
          expect(JSON.parse(await instance.getDdataSnapshotJson(at, true)), `warm/fresh ddata frame at ${at}`).toEqual(warmFrame);
          if (delta === 30_000) expect((warmFrame.treatments as JsonDocument[]).some(row => row._id === id(2000))).toBe(true);
          if (delta === 60_000) expect((warmFrame.treatments as JsonDocument[]).some(row => row._id === id(2001))).toBe(true);
        }
      } finally { clock.mockRestore(); }
    });
  }, 30_000);

  it("does not persist treatment windows warmed inside a transaction that later fails", async () => {
    const stub = env.ENTRY_STORE.getByName(`deep-window-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const now = Date.now();
      treatment(state.storage, 1, now - 1000);
      clearReadCaches(instance);
      const before = JSON.parse(await instance.getPluginPropertyContextJson(now));
      const internal = instance as unknown as Internal;
      const original = internal.realtime.recordApi3StorageMutationInTransaction;
      let warmedUncommitted = false;
      internal.realtime.recordApi3StorageMutationInTransaction = () => {
        const uncommitted = internal.pluginPropertyContext(now);
        warmedUncommitted = uncommitted.treatments.some(row => row.identifier === "rolled-back-treatment");
        throw new Error("synthetic failure after the real treatment/cache callbacks");
      };
      try {
        expect(JSON.parse(await instance.api3CreateDocument("treatments", JSON.stringify({
          identifier: "rolled-back-treatment", app: "synthetic", utcOffset: 0, date: now,
          created_at: new Date(now).toISOString(), eventType: "Sensor Change",
        }), OPTIONS))).toMatchObject({ ok: false });
      } finally { internal.realtime.recordApi3StorageMutationInTransaction = original; }
      expect(warmedUncommitted).toBe(true);
      expect(await instance.findApi3Document("treatments", "rolled-back-treatment", "null")).toBeNull();
      const after = await comparePropertyContext(instance, now);
      expect(after).toEqual(before);
    });
  });

  it("caches the complete raw treatment window while preserving a real output byte cutoff", async () => {
    const stub = env.ENTRY_STORE.getByName(`deep-window-output-budget-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const now = Date.now();
      state.storage.transactionSync(() => {
        for (let n = 0; n < 1000; n++) treatment(state.storage, n, now - n * 1000);
        insert(state.storage, "devicestatus", id(5000), now, { device: "large-synthetic-status", date: now,
          created_at: new Date(now).toISOString(), pump: { battery: 90 },
          part1: "x".repeat(215_000), part2: "x".repeat(215_000), part3: "x".repeat(215_000), part4: "x".repeat(215_000) });
      });
      clearReadCaches(instance);
      const scan = vi.spyOn(state.storage.sql, "exec");
      const first = JSON.parse(await instance.getPluginPropertyContextJson(now)) as { treatments: JsonDocument[]; devicestatus: JsonDocument[] };
      const second = JSON.parse(await instance.getPluginPropertyContextJson(now)) as { treatments: JsonDocument[] };
      expect(first.devicestatus).toHaveLength(1);
      const statusBytes = new TextEncoder().encode(JSON.stringify(first.devicestatus)).byteLength;
      expect(statusBytes).toBeGreaterThan(850_000);
      console.info(JSON.stringify({ label: "deep-real-output-cutoff", statusBytes, treatmentCount: first.treatments.length }));
      expect(first.treatments.length).toBeLessThan(1000);
      expect(second).toEqual(first);
      expect(scan.mock.calls.filter(([sql]) => isOrdinaryWindow(sql))).toHaveLength(1);
      scan.mockRestore();
      await instance.deleteDocuments("devicestatus", [id(5000)]);
      const recovered = await comparePropertyContext(instance, now) as { treatments: JsonDocument[] };
      expect(recovered.treatments).toHaveLength(1000);
    });
  });

  it("reuses a complete raw window when predictions and canonical treatment nodes truncate output", async () => {
    const stub = env.ENTRY_STORE.getByName(`deep-window-node-budget-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const now = Date.now();
      expect(await instance.createLegacyTreatments(JSON.stringify([{
        _id: id(9000), created_at: new Date(now).toISOString(), eventType: "Note",
      }]))).toMatchObject({ ok: true });
      const canonical = JSON.parse(state.storage.sql.exec<{ body: string }>(
        "SELECT body FROM documents WHERE collection='treatments' LIMIT 1",
      ).one().body) as JsonDocument;
      state.storage.transactionSync(() => {
        state.storage.sql.exec("DELETE FROM documents WHERE collection='treatments'");
        for (let n = 0; n < 1000; n++) {
          const at = now - (1000 - n) * 60_000;
          insert(state.storage, "treatments", id(n), at, n >= 800
            ? { ...canonical, _id: id(n), created_at: new Date(at).toISOString() }
            : { _id: id(n), created_at: new Date(at).toISOString(), eventType: "Note" });
        }
        for (let n = 0; n < 64; n++) {
          const at = now - n * 300_000;
          insert(state.storage, "entries", id(n), at, {
            _id: id(n), date: at, dateString: new Date(at).toISOString(),
            sgv: 110, type: "sgv", device: "synthetic-cgm", direction: "NONE",
          });
        }
        for (let n = 0; n < 10; n++) {
          const at = now - n * 60_000;
          insert(state.storage, "devicestatus", id(n), at, {
            _id: id(n), device: "synthetic-loop", date: at, created_at: new Date(at).toISOString(),
            pump: { clock: new Date(at).toISOString(), battery: { percent: 80 }, reservoir: 50 },
            openaps: { suggested: { timestamp: new Date(at).toISOString(), IOB: 0, COB: 0,
              predBGs: Object.fromEntries(["IOB", "COB", "UAM", "ZT"].map(key =>
                [key, Array.from({ length: 48 }, (_, point) => 100 + point % 30)])) } },
          });
        }
      });
      clearReadCaches(instance);
      const scan = vi.spyOn(state.storage.sql, "exec");
      let first: { treatments: JsonDocument[]; sgvs: unknown[]; devicestatus: unknown[] };
      try {
        first = JSON.parse(await instance.getPluginPropertyContextJson(now));
        const second = JSON.parse(await instance.getPluginPropertyContextJson(now));
        expect(first.sgvs).toHaveLength(64);
        expect(first.devicestatus).toHaveLength(10);
        expect(first.treatments.length).toBeGreaterThan(900);
        expect(first.treatments.length).toBeLessThan(1000);
        expect(second).toEqual(first);
        expect(scan.mock.calls.filter(([sql]) => isOrdinaryWindow(sql))).toHaveLength(1);
      } finally { scan.mockRestore(); }
      // Cold normalization remains the oracle for the exact truncated prefix.
      clearReadCaches(instance);
      expect(JSON.parse(await instance.getPluginPropertyContextJson(now))).toEqual(first);
      console.info(JSON.stringify({ label: "deep-real-node-cutoff", returned: first.treatments.length }));
    });
  });

  it("preserves a committed legacy batch item when a later tied insert fails, then exposes the correct suffix", async () => {
    const stub = env.ENTRY_STORE.getByName(`deep-status-boundary-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const now = Date.now();
      state.storage.transactionSync(() => {
        for (let n = 0; n < 5102; n++) {
          const at = now - Math.floor(n / 100) * 1000;
          insert(state.storage, "devicestatus", id(n), at, { _id: id(n), device: "synthetic", date: at,
            created_at: new Date(at).toISOString(), payload: "x".repeat(100) });
        }
      });
      clearReadCaches(instance);
      const oracle = () => state.storage.sql.exec<{ body: string }>(
        "SELECT body FROM documents WHERE collection='devicestatus' ORDER BY sort_time DESC,updated_at DESC LIMIT 5000",
      ).toArray().map(row => JSON.parse(row.body));
      const first = JSON.parse(await instance.getLegacyDeviceStatusJson(5000));
      expect(first).toEqual(oracle());
      await expect(instance.createDocuments("devicestatus", JSON.stringify([
        { _id: id(6000), device: "new", created_at: new Date(now + 1000).toISOString() },
        { _id: id(0), device: "duplicate", created_at: new Date(now + 2000).toISOString() },
      ]))).rejects.toThrow();
      expect(JSON.parse(await instance.getLegacyDeviceStatusJson(5000))).toEqual(oracle());
      expect(await instance.findDocumentByField("devicestatus", "_id", id(6000))).not.toBeNull();
      await instance.saveDocuments("devicestatus", JSON.stringify([
        { _id: id(6000), device: "backdated", created_at: new Date(now - 100 * DAY).toISOString() },
      ]));
      expect(JSON.parse(await instance.getLegacyDeviceStatusJson(5000))).toEqual(oracle());
      await instance.deleteDocuments("devicestatus", [id(0), id(1), id(2)]);
      expect(JSON.parse(await instance.getLegacyDeviceStatusJson(5000))).toEqual(oracle());
    });
  }, 30_000);

  it("falls back to fresh SQL for a real candidate prefix larger than the default 8 MiB", async () => {
    const stub = env.ENTRY_STORE.getByName(`deep-status-oversize-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const now = Date.now();
      state.storage.transactionSync(() => {
        for (let n = 0; n < 64; n++) insert(state.storage, "devicestatus", id(n), now - n, {
          _id: id(n), device: "synthetic", created_at: new Date(now - n).toISOString(), payload: "x".repeat(70000),
        });
      });
      clearReadCaches(instance);
      const scan = vi.spyOn(state.storage.sql, "exec");
      const first = await instance.getLegacyDeviceStatusJson(5000);
      const second = await instance.getLegacyDeviceStatusJson(5000);
      expect(second).toBe(first);
      expect(JSON.parse(second)).toHaveLength(64);
      expect(scan.mock.calls.filter(([sql]) => sql.includes("ORDER BY sort_time DESC, updated_at DESC LIMIT ?"))).toHaveLength(2);
      scan.mockRestore();
    });
  }, 30_000);
});
