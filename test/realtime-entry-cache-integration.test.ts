import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryStore } from "../src/entry-store";

describe("cached realtime entry results match fresh SQLite queries", () => {
  it("preserves inserts, backfill, type changes, deletes, rollback, time windows and eviction", async () => {
    const stub = env.ENTRY_STORE.getByName(`entry-cache-${crypto.randomUUID()}`);
    const now = Date.now();
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const internal = instance as unknown as {
        realtimeSnapshot: (now: number, frame?: boolean) => { sgvs: unknown[]; mbgs: unknown[] };
        realtimeEntryQueries: { clear: () => void };
        documentRepository: () => import("../src/document-repository").SqliteDocumentRepository;
      };
      const options = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: true };
      const create = async (identifier: string, date: number, sgv: number) => {
        const result = JSON.parse(await instance.api3CreateDocument("entries",
          JSON.stringify({ identifier, date, sgv, utcOffset: 0, app: "synthetic", type: "sgv", device: "synthetic" }),
          JSON.stringify(options)));
        expect(result).toMatchObject({ ok: true });
      };
      const verify = (at = now, frame = false) => {
        const cached = internal.realtimeSnapshot(at, frame);
        internal.realtimeEntryQueries.clear();
        expect(internal.realtimeSnapshot(at, frame)).toEqual(cached);
        return cached;
      };
      verify(); // Warm an empty result: new records must still become visible.
      await create("recent", now - 300_000, 110);
      expect(verify().sgvs).toHaveLength(1);
      await create("backfill", now - 3600_000, 100);
      expect(verify().sgvs).toHaveLength(2);
      await create("future", now + 3600_000, 120);
      expect(verify().sgvs).toHaveLength(3);
      expect(verify(now, true).sgvs).toHaveLength(2);
      const changed = JSON.parse(await instance.api3ReplaceDocument("entries", "recent",
        JSON.stringify({ identifier: "recent", utcOffset: 0, app: "synthetic", date: now - 300_000, mbg: 105, type: "mbg" }),
        JSON.stringify(options)));
      expect(changed.ok).toBe(true);
      expect(verify().mbgs).toHaveLength(1);
      expect((await instance.api3DeleteDocument("entries", "recent", true, null)).deleted).toBe(true);
      expect(verify().mbgs).toHaveLength(0);
      // Force a snapshot inside an entry mutation, then roll back the outer
      // transaction; uncommitted data must never escape through the cache.
      const realtime = instance as unknown as { realtime: { recordApi3StorageMutationInTransaction: (event: unknown) => void } };
      const original = realtime.realtime.recordApi3StorageMutationInTransaction;
      realtime.realtime.recordApi3StorageMutationInTransaction = () => {
        internal.realtimeSnapshot(now);
        throw new Error("synthetic rollback");
      };
      try {
        expect(() => state.storage.transactionSync(() => {
          internal.documentRepository().createDocumentForApi3("entries", {
            identifier: "rollback", utcOffset: 0, app: "synthetic", date: now, sgv: 200,
          }, options);
        })).toThrow("synthetic rollback");
      } finally {
        realtime.realtime.recordApi3StorageMutationInTransaction = original;
      }
      expect(verify().sgvs).toHaveLength(2);
      verify(now + 25 * 3600_000);
      verify(now - 3600_000); // Clock rollback reloads, rather than hiding history.
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, (instance: EntryStore) => {
      const internal = instance as unknown as {
        realtimeSnapshot: (at: number) => { sgvs: unknown[] };
      };
      expect(internal.realtimeSnapshot(now).sgvs).toHaveLength(2);
    });
  });
});
