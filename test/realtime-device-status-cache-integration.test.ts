import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryStore } from "../src/entry-store";

describe("incremental device status loader", () => {
  it("matches fresh raw and root snapshots across mutations and a failed transaction", async () => {
    const stub = env.ENTRY_STORE.getByName(`ds-cache-${crypto.randomUUID()}`);
    const now = Date.now();
    await runInDurableObject(stub, async (instance: EntryStore) => {
      const internal = instance as unknown as {
        realtimeSnapshot: (at: number, frame?: boolean, mode?: string) => { devicestatus: unknown[] };
        realtimeDeviceStatusQueries: { clear: () => void };
        realtime: { recordApi3StorageMutationInTransaction: (event: unknown) => void };
      };
      const options = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: true };
      const document = (identifier: string, date: number, battery = 80) => ({
        identifier, date, utcOffset: 0, app: "synthetic", device: "synthetic-phone", uploaderBattery: battery,
      });
      const create = (id: string, date: number, battery = 80) => instance.api3CreateDocument(
        "devicestatus", JSON.stringify(document(id, date, battery)), JSON.stringify(options));
      const verify = (at = now) => {
        for (const mode of ["root", "ddata"]) {
          const cached = internal.realtimeSnapshot(at, false, mode);
          internal.realtimeDeviceStatusQueries.clear();
          expect(internal.realtimeSnapshot(at, false, mode)).toEqual(cached);
        }
      };
      verify();
      expect(JSON.parse(await create("recent", now - 300_000))).toMatchObject({ ok: true });
      verify();
      expect(JSON.parse(await create("history", now - 30 * 86400_000))).toMatchObject({ ok: true });
      verify();
      expect(JSON.parse(await create("future", now + 300_000))).toMatchObject({ ok: true });
      verify();
      expect(JSON.parse(await create("recent", now - 300_000, 70))).toMatchObject({ ok: true });
      verify();
      const old = internal.realtime.recordApi3StorageMutationInTransaction;
      internal.realtime.recordApi3StorageMutationInTransaction = () => {
        internal.realtimeSnapshot(now);
        throw new Error("synthetic rollback");
      };
      try {
        expect(JSON.parse(await create("failed", now - 100))).toMatchObject({ ok: false });
      } finally {
        internal.realtime.recordApi3StorageMutationInTransaction = old;
      }
      verify();
      expect(internal.realtimeSnapshot(now, false, "ddata").devicestatus).toHaveLength(2);
      expect((await instance.api3DeleteDocument("devicestatus", "recent", true, null)).deleted).toBe(true);
      verify();
      const replacement = JSON.parse(await instance.api3ReplaceDocument("devicestatus", "future",
        JSON.stringify(document("future", now + 300_000, 50)), JSON.stringify(options)));
      expect(replacement).toMatchObject({ ok: true });
      verify();
      verify(now + 25 * 3600_000);
      verify(now - 3600_000);
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, (instance: EntryStore) => {
      const internal = instance as unknown as {
        realtimeSnapshot: (at: number, frame: boolean, mode: string) => { devicestatus: unknown[] };
      };
      expect(internal.realtimeSnapshot(now, false, "ddata").devicestatus).toHaveLength(1);
    });
  });
});
