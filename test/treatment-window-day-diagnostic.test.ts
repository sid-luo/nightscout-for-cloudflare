import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { packSqlRow, unpackSqlRow, PACKED_SQL_ROW_SHARED_BYTES, type PackedSqlRow } from "../src/realtime/raw-row-codec";
import type { EntryStore } from "../src/entry-store";
import { parseEntryPayload } from "../src/model";
import worker from "../src/index";
import { REALTIME_SNAPSHOT_MAX_BYTES, REALTIME_SNAPSHOT_MAX_DOCUMENTS,
  REALTIME_SNAPSHOT_MAX_NODES } from "../src/realtime/constants";

const MINUTE = 60_000;
const MINUTES = 1440;
const id = (n: number) => n.toString(16).padStart(24, "0");
interface Row extends Record<string, SqlStorageValue> { id: string; body: string; sort_time: number }
interface CachedWindow {
  rows: PackedSqlRow<Row>[]; bytes: number; lower: number; upper: number;
  lastLower: number; lastUpper: number; nextFuture: number;
}
interface BudgetState { usedNodes: number; usedBytes: number; usedDocuments: number }
type RealtimeDocumentsArguments = [string, SqlStorageValue[], BudgetState,
  (document: Record<string, unknown>) => Record<string, unknown>, Iterable<Row>?];
interface Internal {
  realtimeEntryQueries: { clear(): void };
  realtimeDeviceStatusQueries: { clear(): void };
  legacyDeviceStatusCandidates: { clear(): void };
  boundedTreatmentQueries: {
    clear(): void;
    entries: Map<string, CachedWindow>; bytes: number; generation: number;
    maxEntryBytes: number; maxBytes: number; maxEntries: number;
  };
  realtimeAuxiliaryQueries: Record<string, { clear(): void }>;
  realtime: { now(): number };
  realtimeDocuments(...args: RealtimeDocumentsArguments): Record<string, unknown>[];
}

function status(n: number, at: number) {
  return { _id: id(n), device: "synthetic-loop", date: at, created_at: new Date(at).toISOString(),
    pump: { clock: new Date(at).toISOString(), battery: { percent: 80 }, reservoir: 50 },
    openaps: { suggested: { timestamp: new Date(at).toISOString(), IOB: 0, COB: 0,
      predBGs: Object.fromEntries(["IOB", "COB", "UAM", "ZT"].map(key => [key,
        Array.from({ length: 48 }, (_, point) => 100 + point % 30)])) } } };
}

function ordinaryWindow(sql: string): boolean {
  return sql.includes("collection = 'treatments'") && sql.includes("FROM (")
    && sql.includes("LIMIT 1000") && sql.includes("sort_time <= ?")
    && sql.includes("ORDER BY sort_time ASC, id ASC");
}

describe("ordinary treatment window daily cache diagnostic", () => {
  it("observes cache retention through a full upload day with one properties reader", async () => {
    const stub = env.ENTRY_STORE.getByName(`treatment-window-day-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      let now = Date.now();
      const start = now;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      state.storage.transactionSync(() => {
        for (let n = 0; n < 5000; n++) {
          const at = start - (5000 - n) * MINUTE;
          const glucoseAt = start - (5000 - n) * 5 * MINUTE;
          for (const [collection, body, time] of [
            ["devicestatus", status(n, at), at],
            ["treatments", { _id: id(n), created_at: new Date(at).toISOString(),
              eventType: n % 200 === 0 ? "Sensor Change" : "Note" }, at],
            ["entries", { _id: id(n), device: "synthetic-cgm", type: "sgv", sgv: 110,
              date: glucoseAt, dateString: new Date(glucoseAt).toISOString() }, glucoseAt],
          ] as const) state.storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
            VALUES(?,?,?,?,?,?)`, collection, id(n), JSON.stringify(body), time, time, time);
        }
      });
      const internal = instance as unknown as Internal;
      const cache = internal.boundedTreatmentQueries;
      internal.realtimeEntryQueries.clear(); internal.realtimeDeviceStatusQueries.clear();
      internal.legacyDeviceStatusCandidates.clear(); cache.clear();
      for (const auxiliary of Object.values(internal.realtimeAuxiliaryQueries)) auxiliary.clear();
      const realtimeClock = vi.spyOn(internal.realtime, "now").mockImplementation(() => now);
      const appEnv = { ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => new Proxy(instance, {
        get(target, key) { const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value; },
      }) }, API_SECRET: "synthetic-window-day-secret", AUTH_DEFAULT_ROLES: "readable", AUTH_FAIL_DELAY: "0" } as unknown as Parameters<typeof worker.fetch>[1];
      // Keep the bound original function for checkpoint probes. Those cursors
      // intentionally bypass the measuring spy and are reported separately.
      const execute = state.storage.sql.exec.bind(state.storage.sql);
      const measured: { sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
      let windowSql: string | undefined;
      let windowFixedBindings: SqlStorageValue[] = [];
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...bindings) => {
        const cursor = execute(sql, ...bindings);
        measured.push({ sql, cursor });
        if (ordinaryWindow(sql)) { windowSql = sql; windowFixedBindings = bindings.slice(0, -2); }
        return cursor;
      });
      const phases: { minute: number; reads: number; windowReads: number; windowCalls: number }[] = [];
      const checkpoints = [];
      const budgetObservations: unknown[] = [];
      let observedMinute = -1;
      const documentLoader = internal.realtimeDocuments;
      const loaderSpy = vi.spyOn(internal, "realtimeDocuments").mockImplementation(function (...args) {
        if (!ordinaryWindow(args[0]) || ![0, 1370, 1439].includes(observedMinute)) {
          return documentLoader.apply(internal, args);
        }
        const budget = args[2];
        const before = { usedNodes: budget.usedNodes, usedBytes: budget.usedBytes,
          usedDocuments: budget.usedDocuments };
        const result = documentLoader.apply(internal, args);
        budgetObservations.push({ minute: observedMinute, returned: result.length, before,
          after: { usedNodes: budget.usedNodes, usedBytes: budget.usedBytes,
            usedDocuments: budget.usedDocuments },
          reservedNodes: budget.usedNodes - before.usedNodes,
          firstReturnedFields: result[0] === undefined ? [] : Object.keys(result[0]),
          lastReturnedFields: result.at(-1) === undefined ? [] : Object.keys(result.at(-1)!),
          limits: { nodes: REALTIME_SNAPSHOT_MAX_NODES, bytes: REALTIME_SNAPSHOT_MAX_BYTES,
            documents: REALTIME_SNAPSHOT_MAX_DOCUMENTS },
        });
        return result;
      });
      let latestSgv = 110, latestSgvAt = start - 5 * MINUTE;
      try {
        for (let minute = 0; minute < MINUTES; minute++) {
          observedMinute = minute;
          now = start + minute * MINUTE;
          expect(JSON.parse(await instance.createDocuments("devicestatus", JSON.stringify([status(10000 + minute, now)]))))
            .toMatchObject([{ _id: id(10000 + minute) }]);
          if (minute % 5 === 0) {
            latestSgv = 120 + minute % 60; latestSgvAt = now;
            expect((await instance.putEntries(parseEntryPayload([{
              date: now, dateString: new Date(now).toISOString(), sgv: latestSgv, type: "sgv", device: "synthetic-cgm",
            }]))).inserted).toBe(1);
          }
          if (minute % 10 === 0) expect(await instance.createLegacyTreatments(JSON.stringify([{
            _id: id(20000 + minute), eventType: "Note", created_at: new Date(now).toISOString(),
          }]))).toMatchObject({ ok: true });
          const response = await worker.fetch(new Request("https://synthetic.invalid/api/v2/properties"), appEnv);
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ bgnow: { last: latestSgv, mills: latestSgvAt } });
          const windowCursors = measured.filter(({ sql }) => ordinaryWindow(sql));
          phases.push({ minute, reads: measured.reduce((sum, { cursor }) => sum + cursor.rowsRead, 0),
            windowReads: windowCursors.reduce((sum, { cursor }) => sum + cursor.rowsRead, 0),
            windowCalls: windowCursors.length });
          if ([0, 1370, 1439].includes(minute)) {
            const entries = [...cache.entries].filter(([key]) => ordinaryWindow(JSON.parse(key)[0] as string));
            const entryStates = entries.map(([key, value]) => ({ key, bytes: value.bytes,
              rows: value.rows.length, lower: value.lower, upper: value.upper,
              lastLower: value.lastLower, lastUpper: value.lastUpper, nextFuture: value.nextFuture,
              nextFutureIsInfinity: value.nextFuture === Number.POSITIVE_INFINITY,
              rowFields: value.rows[0] === undefined ? [] : Object.keys(unpackSqlRow(value.rows[0])),
              bodyFields: value.rows[0] === undefined ? [] : Object.keys(JSON.parse(unpackSqlRow(value.rows[0]).body)),
            }));
            let missingProbe: unknown = null;
            if (entries.length === 0) {
              expect(windowSql).toBeDefined();
              const key = JSON.stringify([windowSql, windowFixedBindings]);
              const rows = execute<Row>(windowSql!, ...windowFixedBindings,
                now - 2.5 * 86_400_000, now).toArray();
              const keyBytes = 256 + 2 * key.length;
              const rowBudgets = rows.map(row => packSqlRow(row)?.bytes ?? null);
              const rowBytes = rowBudgets.reduce<number>((sum, bytes) => sum + (bytes ?? 0), 0);
              const totalBytes = keyBytes + rowBytes + (rows.some(row => packSqlRow(row)?.compressedBody !== undefined) ? PACKED_SQL_ROW_SHARED_BYTES : 0);
              missingProbe = { sql: windowSql, key, keyBytes, rowBytes, totalBytes,
                rows: rows.length, maxEntryBytes: cache.maxEntryBytes,
                reason: rowBudgets.includes(null) ? "row contains an unsupported value"
                  : totalBytes > cache.maxEntryBytes ? "complete raw window exceeds per-key byte cap"
                    : "not explained by raw capacity; inspect incomplete consumption, generation, LRU or future boundary",
                rowFields: [...new Set(rows.flatMap(row => Object.keys(row)))],
                bodyShapes: [...new Set(rows.map(row => Object.keys(JSON.parse(row.body)).sort().join(",")))],
                samples: [rows[0], rows.at(-1)].filter(Boolean).map(row => ({ ...row,
                  parsedBody: JSON.parse(row!.body), budgetBytes: packSqlRow(row!)?.bytes ?? null,
                })),
              };
            }
            checkpoints.push({ minute, now, aggregateCacheBytes: cache.bytes,
              cacheEntries: cache.entries.size, generation: cache.generation,
              entries: entryStates, missingProbe });
          }
          measured.length = 0;
        }
      } finally { loaderSpy.mockRestore(); spy.mockRestore(); realtimeClock.mockRestore(); clock.mockRestore(); }
      return { propertiesRequests: MINUTES, statusUploads: MINUTES, glucoseUploads: MINUTES / 5,
        treatmentUploads: MINUTES / 10, checkpoints, budgetObservations,
        hours: Array.from({ length: 24 }, (_, hour) => {
          const group = phases.slice(hour * 60, (hour + 1) * 60);
          return { hour, reads: group.reduce((sum, phase) => sum + phase.reads, 0),
            windowReads: group.reduce((sum, phase) => sum + phase.windowReads, 0),
            windowCalls: group.reduce((sum, phase) => sum + phase.windowCalls, 0) };
        }) };
    });
    console.info(`TREATMENT_WINDOW_DAY_DIAGNOSTIC=${JSON.stringify(report)}`);
    expect(report.checkpoints).toHaveLength(3);
    expect(report.propertiesRequests).toBe(1440);
    // A changed treatment invalidates once every ten minutes. Node-budget
    // truncation must not turn the final hour into a SQL miss on every poll.
    expect(report.hours.at(-1)!.windowCalls).toBe(6);
    expect(report.checkpoints.at(-1)!.entries).toHaveLength(1);
    expect(report.checkpoints.at(-1)!.entries[0]!.rows).toBe(1000);
  }, 120_000);
});
