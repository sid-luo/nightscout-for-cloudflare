import { syntheticDeviceStatus } from "./fixtures/synthetic-device-status";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import { SqliteDocumentRepository } from "../src/document-repository";
import { encodeEngineIoV4PollingPayload, wrapSocketIoV5Packet, type SocketIoV5Packet } from "../src/protocol";

describe("synthetic device-status read amplification", () => {
  it("measures uploads against 10,000 stored device statuses with a browser subscriber", async () => {
    const stub = env.ENTRY_STORE.getByName(`read-profile-${crypto.randomUUID()}`);
    const reports = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const reports: string[] = [];
      const now = Date.now();
      const repository = new SqliteDocumentRepository(state.storage);
      const options = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false };
      state.storage.transactionSync(() => {
        for (let i = 0; i < 10_000; i++) {
          repository.createDocumentForApi3("devicestatus", {
            identifier: `synthetic-ds-${i}`, app: "AAPS", device: "synthetic-phone",
            date: now - (10_000 - i) * 300_000, utcOffset: 0,
            uploaderBattery: 80, pump: { battery: { percent: 80 }, reservoir: 50 },
          }, options);
        }
        for (let i = 0; i < 288; i++) {
          repository.createDocumentForApi3("entries", {
            identifier: `synthetic-bg-${i}`, app: "AAPS", device: "synthetic-phone",
            date: now - (288 - i) * 300_000, utcOffset: 0, type: "sgv", sgv: 110,
          }, options);
        }
      });
      // Bulk fixture insertion bypasses production mutation callbacks. Drop
      // constructor caches so measurements observe every seeded document.
      const internal = instance as unknown as {
        realtimeEntryQueries: { clear: () => void };
        realtimeDeviceStatusQueries: { clear: () => void };
        realtimeSnapshot: (at: number, frame: boolean, mode: string) => { sgvs: unknown[]; devicestatus: unknown[] };
      };
      internal.realtimeEntryQueries.clear();
      internal.realtimeDeviceStatusQueries.clear();
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      const captured: { statement: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((statement, ...bindings) => {
        const cursor = exec(statement, ...bindings);
        captured.push({ statement: statement.replace(/\s+/g, " ").trim(), cursor });
        return cursor;
      });
      const report = (label: string) => {
        const groups = new Map<string, { calls: number; reads: number; writes: number }>();
        for (const { statement, cursor } of captured) {
          const row = groups.get(statement) ?? { calls: 0, reads: 0, writes: 0 };
          row.calls++; row.reads += cursor.rowsRead; row.writes += cursor.rowsWritten;
          groups.set(statement, row);
        }
        const queries = [...groups].map(([sql, metrics]) => ({ sql, ...metrics })).sort((a, b) => b.reads - a.reads);
        reports.push(JSON.stringify({ label, reads: queries.reduce((sum, q) => sum + q.reads, 0), writes: queries.reduce((sum, q) => sum + q.writes, 0), queries: queries.slice(0, 12) }));
        captured.length = 0;
      };
      const upload = async (id: number) => {
        const result = JSON.parse(await instance.api3CreateDocument("devicestatus", JSON.stringify({
          identifier: `measured-ds-${id}`, app: "AAPS", device: "synthetic-phone", date: now + id,
          utcOffset: 0, uploaderBattery: 80, pump: { battery: { percent: 80 }, reservoir: 50 },
        }), JSON.stringify({ ...options, emitRealtime: true })));
        expect(result.ok).toBe(true);
      };
      try {
        await upload(1);
        report("upload-no-browser");
        const opened = await instance.realtimeHandshake();
        if (!opened.ok) throw new Error("synthetic handshake failed");
        const sid = opened.value.sid;
        const send = async (packet: SocketIoV5Packet) => {
          const begun = await instance.realtimeBeginPost(sid);
          if (!begun.ok) throw new Error("synthetic post failed");
          const sent = await instance.realtimeSubmitPost(sid, begun.value,
            encodeEngineIoV4PollingPayload([wrapSocketIoV5Packet(packet)]));
          expect(sent.ok).toBe(true);
          expect((await instance.realtimePoll(sid)).ok).toBe(true);
        };
        await send({ type: "connect", namespace: "/" });
        await send({ type: "event", namespace: "/", id: 1, data: ["authorize", { client: "web", status: true }] });
        report("browser-connect");
        await upload(2);
        report("upload-with-browser");
      } finally {
        spy.mockRestore();
      }
      const snapshot = internal.realtimeSnapshot(now, false, "ddata");
      expect(snapshot.sgvs.length).toBeGreaterThan(250);
      expect(snapshot.devicestatus.length).toBeGreaterThan(250);
      internal.realtimeEntryQueries.clear();
      internal.realtimeDeviceStatusQueries.clear();
      expect(internal.realtimeSnapshot(now, false, "ddata")).toEqual(snapshot);
      return reports;
    });
    for (const report of reports) console.log(report);
    // This is a measured baseline, not an arbitrary production capacity limit.
    // A newly connected browser must hydrate history, unlike a single upload.
    const measurements = reports.map((report) => JSON.parse(report) as {
      reads: number; writes: number; label: string;
    });
    expect(measurements.map(({ label }) => label)).toEqual([
      "upload-no-browser", "browser-connect", "upload-with-browser",
    ]);
    // Budget applies only to the measured warm upload, not first-page hydration.
    expect(measurements[2]!.reads).toBeLessThan(100);
    expect(measurements.map(({label, reads, writes}) => ({label, reads, writes}))).toMatchInlineSnapshot(`
      [
        {
          "label": "upload-no-browser",
          "reads": 14,
          "writes": 14,
        },
        {
          "label": "browser-connect",
          "reads": 2165,
          "writes": 37,
        },
        {
          "label": "upload-with-browser",
          "reads": 41,
          "writes": 15,
        },
      ]
    `);
    expect(measurements[2]!.writes).toBe(15);
    for (const measurement of measurements) {
      expect(measurement.reads).toBeGreaterThan(0);
      expect(measurement.writes).toBeGreaterThan(0);
    }
  }, 60_000);
});


it("reuses a budget-limited realistic AAPS prefix without changing the full snapshot", async () => {
  const stub = env.ENTRY_STORE.getByName(`realistic-status-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: EntryStore, state) => {
    const now = Date.now();
    const options = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: true };
    for (let i = 0; i < 288; i++) {
      expect(JSON.parse(await instance.api3CreateDocument("devicestatus",
        JSON.stringify(syntheticDeviceStatus(`realistic-${i}`, now - (288 - i) * 300_000)), JSON.stringify(options)))).toMatchObject({ ok: true });
    }
    const internal = instance as unknown as {
      realtimeSnapshot: (at: number, frame: boolean, mode: string) => { devicestatus: unknown[] };
      realtimeDeviceStatusQueries: { clear: () => void };
    };
    const before = internal.realtimeSnapshot(now, false, "ddata");
    // Enough nested data to reach the existing snapshot node budget.
    expect(before.devicestatus.length).toBeLessThan(288);
    expect(before.devicestatus.length).toBeGreaterThan(50);
    const sql = vi.spyOn(state.storage.sql, "exec");
    try {
      expect(JSON.parse(await instance.api3CreateDocument("devicestatus",
        JSON.stringify(syntheticDeviceStatus("new-realistic", now - 1)), JSON.stringify(options)))).toMatchObject({ ok: true });
      const cached = internal.realtimeSnapshot(now, false, "ddata");
      const fullScans = sql.mock.calls.filter(([query]) => query.includes("collection = 'devicestatus'") && query.includes("sort_time >="));
      expect(fullScans).toHaveLength(0);
      internal.realtimeDeviceStatusQueries.clear();
      expect(internal.realtimeSnapshot(now, false, "ddata")).toEqual(cached);
    } finally { sql.mockRestore(); }
  });
});
