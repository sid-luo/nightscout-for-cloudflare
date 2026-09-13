import { syntheticDeviceStatus } from "./fixtures/synthetic-device-status";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import { encodeEngineIoV4PollingPayload, wrapSocketIoV5Packet, type SocketIoV5Packet } from "../src/protocol";

describe("complete synthetic API3 device-status backfill", () => {
  it("uploads and retains all 10,000 records with a live browser within the read budget", async () => {
    const stub = env.ENTRY_STORE.getByName(`backfill-budget-${crypto.randomUUID()}`);
    const metrics = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const now = Date.now();
      // Measure a continuous burst independently of machine speed. Real
      // heartbeat/reconnect semantics are covered by the realtime suites.
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const options = JSON.stringify({ canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: true });
      for (let i = 0; i < 288; i++) {
        expect(JSON.parse(await instance.api3CreateDocument("entries", JSON.stringify({
          identifier: `bg-${i}`, date: now - (288 - i) * 300_000, sgv: 110, type: "sgv", app: "synthetic", utcOffset: 0,
        }), options))).toMatchObject({ ok: true });
      }
      const opened = await instance.realtimeHandshake();
      if (!opened.ok) throw new Error("handshake failed");
      const sid = opened.value.sid;
      const send = async (packet: SocketIoV5Packet) => {
        const begun = await instance.realtimeBeginPost(sid);
        if (!begun.ok) throw new Error("post failed");
        expect((await instance.realtimeSubmitPost(sid, begun.value,
          encodeEngineIoV4PollingPayload([wrapSocketIoV5Packet(packet)]))).ok).toBe(true);
        expect((await instance.realtimePoll(sid)).ok).toBe(true);
      };
      await send({ type: "connect", namespace: "/" });
      await send({ type: "event", namespace: "/", id: 1, data: ["authorize", { client: "web", status: true }] });
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
      let reads = 0, writes = 0;
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...bindings) => {
        const cursor = exec(sql, ...bindings);
        cursors.push(cursor);
        return cursor;
      });
      try {
        for (let i = 0; i < 10_000; i++) {
          const result = JSON.parse(await instance.api3CreateDocument("devicestatus", JSON.stringify(syntheticDeviceStatus(`ds-${i}`, now - (10_000 - i) * 300_000)), options));
          expect(result).toMatchObject({ ok: true });
          // Drain accepted updates and keep the browser polling throughout.
          if (i % 100 === 0) {
            const queued = state.storage.sql.exec<{ count: number }>(
              "SELECT outbound_packets AS count FROM realtime_sessions WHERE sid = ?", sid,
            ).one().count;
            if (queued > 0) expect((await instance.realtimePoll(sid)).ok).toBe(true);
          }
          for (const cursor of cursors) { reads += cursor.rowsRead; writes += cursor.rowsWritten; }
          cursors.length = 0;
        }
      } finally { spy.mockRestore(); clock.mockRestore(); }
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM documents WHERE collection = 'devicestatus'",
      ).one().count).toBe(10_000);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(DISTINCT identifier) AS count FROM documents WHERE collection = 'devicestatus'",
      ).one().count).toBe(10_000);
      const internal = instance as unknown as {
        realtimeSnapshot: (at: number, frame: boolean, mode: string) => unknown;
        realtimeEntryQueries: { clear: () => void };
        realtimeDeviceStatusQueries: { clear: () => void };
      };
      const cached = internal.realtimeSnapshot(now, false, "ddata");
      internal.realtimeEntryQueries.clear();
      internal.realtimeDeviceStatusQueries.clear();
      expect(internal.realtimeSnapshot(now, false, "ddata")).toEqual(cached);
      return { uploaded: 10_000, reads, writes };
    });
    expect(metrics.reads).toBeLessThan(600_000);
    expect(metrics.uploaded).toBe(10_000);
    expect(metrics).toMatchInlineSnapshot(`
      {
        "reads": 410098,
        "uploaded": 10000,
        "writes": 150001,
      }
    `);
  }, 120_000);
});
