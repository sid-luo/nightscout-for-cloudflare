import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import { SqliteDocumentRepository } from "../src/document-repository";
import { parseEntryPayload } from "../src/model";
import { encodeEngineIoV4PollingPayload, wrapSocketIoV5Packet, type SocketIoV5Packet } from "../src/protocol";

interface SqlMeasurement {
  label: string;
  reads: number;
  writes: number;
  entryRangeQueries: number;
  entryRangeStatements: string[];
  writesByStatement: { sql: string; calls: number; reads: number; writes: number }[];
}

describe("mixed CGM and AAPS uploads retain useful query results", () => {
  it("keeps all records and realtime results without rescanning unchanged entry history", async () => {
    const stub = env.ENTRY_STORE.getByName(`mixed-budget-${crypto.randomUUID()}`);
    const measurements = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const now = Date.now();
      // Keep the exact two-day boundary stable; this case measures SQL work,
      // while the realtime suites exercise advancing clock and timer behavior.
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const options = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false };
      const repository = new SqliteDocumentRepository(state.storage);
      state.storage.transactionSync(() => {
        for (let i = 0; i < 10_000; i++) {
          repository.createDocumentForApi3("devicestatus", {
            identifier: `mixed-seed-ds-${i}`, app: "AAPS", device: "synthetic-phone",
            date: now - (10_000 - i) * 300_000, utcOffset: 0,
            uploaderBattery: 80, pump: { battery: { percent: 80 }, reservoir: 50 },
          }, options);
        }
        for (let i = 0; i < 576; i++) {
          repository.createDocumentForApi3("entries", {
            identifier: `mixed-seed-bg-${i}`, app: "synthetic", device: "synthetic-cgm",
            date: now - (576 - i) * 300_000, utcOffset: 0, type: "sgv", sgv: 110,
          }, options);
        }
      });
      const internal = instance as unknown as {
        realtimeEntryQueries: { clear(): void };
        realtimeDeviceStatusQueries: { clear(): void };
        realtimeSnapshot(at: number, frame: boolean, mode: string): { sgvs: unknown[]; devicestatus: unknown[] };
        resolvedAutomaticNotificationRuntime(at: number): unknown;
        automaticNotificationData(at: number, runtime: unknown): { sgvs: unknown[] };
        pluginPropertyContext(at: number): { sgvs: unknown[] };
        realtime: { now(): number };
      };
      // RealtimeSessionService captures Date.now at construction, before the
      // global spy above. Freeze that captured clock too so the notification
      // window does not artificially move backwards relative to the root.
      const realtimeClock = vi.spyOn(internal.realtime, "now").mockReturnValue(now);
      internal.realtimeEntryQueries.clear();
      internal.realtimeDeviceStatusQueries.clear();
      const captured: { sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((statement, ...bindings) => {
        const cursor = exec(statement, ...bindings);
        captured.push({ sql: statement.replace(/\s+/g, " ").trim(), cursor });
        return cursor;
      });
      const results: SqlMeasurement[] = [];
      const report = (label: string) => {
        const groups = new Map<string, { sql: string; calls: number; reads: number; writes: number }>();
        for (const { sql, cursor } of captured) {
          const metrics = groups.get(sql) ?? { sql, calls: 0, reads: 0, writes: 0 };
          metrics.calls++;
          metrics.reads += cursor.rowsRead;
          metrics.writes += cursor.rowsWritten;
          groups.set(sql, metrics);
        }
        const queries = [...groups.values()];
        results.push({
          label,
          reads: queries.reduce((sum, item) => sum + item.reads, 0),
          writes: queries.reduce((sum, item) => sum + item.writes, 0),
          // Canonical-id predicate checks are bounded point queries, not
          // history reloads, even when they retain the original time filter.
          entryRangeQueries: queries.filter(item => /SELECT.*FROM documents.*collection = 'entries'.*sort_time >=/i.test(item.sql)
            && !/\bid\s*=\s*\?/i.test(item.sql)).reduce((sum, item) => sum + item.calls, 0),
          entryRangeStatements: queries.filter(item => /SELECT.*FROM documents.*collection = 'entries'.*sort_time >=/i.test(item.sql)
            && !/\bid\s*=\s*\?/i.test(item.sql)).map(item => item.sql),
          writesByStatement: queries.filter(item => item.writes > 0),
        });
        captured.length = 0;
      };
      const uploadStatus = async (id: number) => {
        const result = JSON.parse(await instance.api3CreateDocument("devicestatus", JSON.stringify({
          identifier: `mixed-new-ds-${id}`, app: "AAPS", device: "synthetic-phone",
          date: now + id, utcOffset: 0, uploaderBattery: 80,
          pump: { battery: { percent: 80 }, reservoir: 50 },
        }), JSON.stringify({ ...options, emitRealtime: true })));
        expect(result.ok).toBe(true);
      };
      try {
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
        await uploadStatus(1);
        report("warm-status");
        expect(JSON.parse(await instance.api3CreateDocument("entries", JSON.stringify({
          identifier: "mixed-new-bg-v3", app: "synthetic", device: "synthetic-cgm",
          date: now + 10, utcOffset: 0, type: "sgv", sgv: 111,
        }), JSON.stringify({ ...options, emitRealtime: true }))).ok).toBe(true);
        report("new-cgm-api3");
        await uploadStatus(2);
        report("status-after-api3-cgm");
        const legacyEntry = parseEntryPayload([{
          device: "synthetic-xdrip", date: now + 20,
          dateString: new Date(now + 20).toISOString(), type: "sgv", sgv: 112,
        }]);
        expect((await instance.putEntries(legacyEntry)).inserted).toBe(1);
        report("new-cgm-v1");
        await uploadStatus(3);
        report("status-after-v1-cgm");
        expect((await instance.putEntries(legacyEntry)).duplicates).toBe(1);
        report("repeated-cgm-v1");
        const oldModified = state.storage.sql.exec<{ value: number }>(
          "SELECT srv_modified AS value FROM documents WHERE collection = 'devicestatus' AND identifier = ?", "mixed-new-ds-3").one().value;
        captured.length = 0;
        await uploadStatus(3);
        report("repeated-status-api3");
        const newModified = state.storage.sql.exec<{ value: number }>(
          "SELECT srv_modified AS value FROM documents WHERE collection = 'devicestatus' AND identifier = ?", "mixed-new-ds-3").one().value;
        // Preserve API3's successful-upsert modification clock contract.
        expect(newModified).toBeGreaterThan(oldModified);
      } finally {
        spy.mockRestore();
        realtimeClock.mockRestore();
        clock.mockRestore();
      }
      const persisted = state.storage.sql.exec<{ collection: string; count: number }>(
        "SELECT collection, COUNT(*) AS count FROM documents WHERE collection IN ('entries', 'devicestatus') GROUP BY collection ORDER BY collection").toArray();
      expect(persisted).toEqual([
        { collection: "devicestatus", count: 10_003 },
        { collection: "entries", count: 578 },
      ]);
      const cached = internal.realtimeSnapshot(now, false, "ddata");
      expect(cached.sgvs).toHaveLength(578);
      const runtime = internal.resolvedAutomaticNotificationRuntime(now);
      const querySpy = vi.spyOn(state.storage.sql, "exec");
      const notifications = internal.automaticNotificationData(now, runtime);
      const properties = internal.pluginPropertyContext(now);
      expect(notifications.sgvs).toHaveLength(64);
      expect(properties.sgvs).toHaveLength(64);
      expect(querySpy.mock.calls.filter(([sql]) => sql.includes("collection = 'entries'")
        && sql.includes("$.sgv") && sql.includes("LIMIT 64"))).toHaveLength(0);
      querySpy.mockRestore();
      internal.realtimeEntryQueries.clear();
      internal.realtimeDeviceStatusQueries.clear();
      expect(internal.automaticNotificationData(now, runtime)).toEqual(notifications);
      expect(internal.pluginPropertyContext(now)).toEqual(properties);
      expect(internal.realtimeSnapshot(now, false, "ddata")).toEqual(cached);
      return results;
    });
    console.log("MIXED_UPLOAD_SQL", JSON.stringify(measurements));
    for (const measurement of measurements.filter(item => item.label !== "browser-connect")) {
      expect(measurement.entryRangeQueries, measurement.label).toBe(0);
    }
  }, 60_000);
});
