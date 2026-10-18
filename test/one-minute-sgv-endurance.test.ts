import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore, JsonDocument } from "../src/entry-store";
import { parseEntryPayload } from "../src/model";

const MINUTE = 60_000;
const SEED_ROWS = 1000;
const DAY_MINUTES = 24 * 60;
const ROOT_ROWS = 726;
const DEVICE = "synthetic-cgm";
const RAW_CACHE_CAP = 512 * 1024;
interface Row extends Record<string, SqlStorageValue> {
  id: string; body: string; sort_time: number;
}
interface Sgv {
  _id: string; mgdl: number; mills: number; device: string; direction: string; type: string;
}
interface Snapshot { sgvs: Sgv[] }
interface Internal {
  realtimeEntryQueries: {
    clear(): void;
    readonly entries: Map<string, { lower: number; rows: Row[]; limit: number; bytes: number }>;
  };
  realtimeSnapshot(now: number, frame: boolean, mode: string): Snapshot;
  pluginPropertyContext(now: number): Snapshot;
  realtimeDeviceStatusQueries: { clear(): void };
  realtimeAuxiliaryQueries: Record<string, { clear(): void }>;
  recentTreatmentQueries: { clear(): void };
  boundedTreatmentQueries: { clear(): void };
  realtime: { now(): number };
}
interface Counts {
  reads: number; writes: number; calls: number;
  sgv1000Loads: number; sgv1000LoadReads: number;
  sgv1000Points: number; sgv1000PointReads: number;
}
interface Hour extends Counts { hour: number; maxMinuteReads: number }
const emptyCounts = (): Counts => ({ reads: 0, writes: 0, calls: 0,
  sgv1000Loads: 0, sgv1000LoadReads: 0, sgv1000Points: 0, sgv1000PointReads: 0 });
const objectId = (n: number) => n.toString(16).padStart(24, "0");
function isSgv1000(sql: string): boolean {
  return sql.includes("collection = 'entries'") && sql.includes("sort_time >= ?")
    && sql.includes("'$.sgv'") && !sql.includes("'$.type'") && sql.includes("LIMIT 1000");
}
function assertSgvs(sgvs: Sgv[], count: number, id: string, value: number, at: number): void {
  expect(sgvs).toHaveLength(count);
  expect(sgvs.at(-1)).toMatchObject({ _id: id, mgdl: value, mills: at, type: "sgv" });
  // Every fixture/real upload is one minute apart; duplicate/correction writes
  // retain its original instant. This also catches shifted/widened selections.
  expect(sgvs[0]!.mills).toBe(at - (count - 1) * MINUTE);
}

describe("one-minute CGM full-window cache endurance", () => {
  it("keeps root/ddata/properties fresh for 24 hours of uploads and selected-row replay/corrections", async () => {
    const stub = env.ENTRY_STORE.getByName(`one-minute-sgv-day-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      let now = Date.now();
      const startedAt = now;
      const internal = instance as unknown as Internal;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const realtimeClock = vi.spyOn(internal.realtime, "now").mockImplementation(() => now);
      try {
        // Keep fixture setup outside all business SQL counters. The template
        // comes from the real putEntries boundary, including canonical fields.
        expect((await instance.putEntries(parseEntryPayload([{
          date: now, dateString: new Date(now).toISOString(),
          sgv: 120, type: "sgv", device: DEVICE,
        }]))).inserted).toBe(1);
        const source = state.storage.sql.exec<Row>(
          "SELECT id, body, sort_time FROM documents WHERE collection = 'entries' LIMIT 1",
        ).one();
        const template = JSON.parse(source.body) as JsonDocument;
        let unprojectedRawCacheBytes = 0;
        state.storage.transactionSync(() => {
          state.storage.sql.exec("DELETE FROM documents WHERE collection = 'entries'");
          // The template upload also created a v1 shadow at startedAt. Remove
          // that fixture-only row so minute zero is a new canonical upload,
          // without an orphan shadow choosing the template's unrelated id.
          state.storage.sql.exec("DELETE FROM entries");
          for (let n = 0; n < SEED_ROWS; n++) {
            const at = startedAt - (SEED_ROWS - n) * MINUTE;
            const id = objectId(n);
            const dateString = new Date(at).toISOString();
            const body = JSON.stringify({ ...template, _id: id, date: at, dateString,
              sysTime: dateString, sgv: 120 + n % 60 });
            unprojectedRawCacheBytes += JSON.stringify({ id, body, sort_time: at }).length * 2;
            state.storage.sql.exec(`INSERT INTO documents
              (collection,id,body,sort_time,created_at,updated_at)
              VALUES('entries',?,?,?,?,?)`, id, body, at, at, at);
          }
        });
        internal.realtimeEntryQueries.clear();
        internal.realtimeDeviceStatusQueries.clear();
        internal.recentTreatmentQueries.clear();
        internal.boundedTreatmentQueries.clear();
        for (const cache of Object.values(internal.realtimeAuxiliaryQueries)) cache.clear();
        expect(unprojectedRawCacheBytes).toBeGreaterThan(RAW_CACHE_CAP);

        let captured: { sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
        const execute = state.storage.sql.exec.bind(state.storage.sql);
        const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...bindings) => {
          const cursor = execute(sql, ...bindings);
          captured.push({ sql, cursor });
          return cursor;
        });
        const totals = emptyCounts();
        const hours: Hour[] = [];
        let hour: Hour = { hour: 0, ...emptyCounts(), maxMinuteReads: 0 };
        let duplicates = 0;
        let corrections = 0;
        let lastRoot: Sgv[] = [], lastDdata: Sgv[] = [], lastProperties: Sgv[] = [];
        let finalCache: { key: string; rows: number; bytes: number; limit: number } | undefined;
        try {
          for (let minute = 0; minute < DAY_MINUTES; minute++) {
            now = startedAt + minute * MINUTE;
            const at = now;
            const id = objectId(100_000 + minute);
            const value = 120 + minute % 60;
            const input = { _id: id, date: at, dateString: new Date(at).toISOString(),
              type: "sgv", sgv: value, device: DEVICE };
            const uploaded = await instance.putEntries(parseEntryPayload([input]));
            expect(uploaded.inserted).toBe(1);
            expect(uploaded.duplicates).toBe(0);
            let latestValue = value;
            if (minute % 10 === 9) {
              const correction = Math.floor(minute / 10) % 2 === 1;
              latestValue += correction ? 1 : 0;
              const repeated = await instance.putEntries(parseEntryPayload([{ ...input, sgv: latestValue }]));
              expect(repeated.inserted).toBe(0);
              expect(repeated.duplicates).toBe(1);
              duplicates++;
              if (correction) corrections++;
            }

            now += 1000;
            const root = internal.realtimeSnapshot(now, false, "root");
            assertSgvs(root.sgvs, ROOT_ROWS, id, latestValue, at);
            now += 1000;
            const ddata = JSON.parse(await instance.getDdataSnapshotJson(now, false)) as Snapshot;
            assertSgvs(ddata.sgvs, ROOT_ROWS, id, latestValue, at);
            // Compare wire results, since undefined raw fields are deliberately
            // retained in the in-memory budget object but omitted on the wire.
            expect(ddata.sgvs).toEqual(JSON.parse(JSON.stringify(root.sgvs)));
            now += 1000;
            const properties = internal.pluginPropertyContext(now);
            assertSgvs(properties.sgvs, 64, id, latestValue, at);
            expect(JSON.parse(JSON.stringify(properties.sgvs)))
              .toEqual(ddata.sgvs.slice(-64));
            lastRoot = JSON.parse(JSON.stringify(root.sgvs)) as Sgv[];
            lastDdata = ddata.sgvs;
            lastProperties = JSON.parse(JSON.stringify(properties.sgvs)) as Sgv[];

            const fullCaches = [...internal.realtimeEntryQueries.entries]
              .filter(([sql]) => isSgv1000(sql) && !/\bAND id = \?/.test(sql));
            expect(fullCaches).toHaveLength(1);
            const [key, cache] = fullCaches[0]!;
            expect(cache.rows).toHaveLength(SEED_ROWS);
            expect(cache.limit).toBe(SEED_ROWS);
            expect(cache.bytes).toBeLessThanOrEqual(RAW_CACHE_CAP);
            expect(cache.rows[0]!.id).toBe(id);
            expect(cache.rows[0]!.sort_time).toBe(at);
            expect(cache.rows.at(-1)!.sort_time).toBe(at - (SEED_ROWS - 1) * MINUTE);
            finalCache = { key: key.replace(/\s+/g, " ").trim(), rows: cache.rows.length,
              bytes: cache.bytes, limit: cache.limit };

            const counts = emptyCounts();
            for (const { sql, cursor } of captured) {
              counts.calls++;
              counts.reads += cursor.rowsRead;
              counts.writes += cursor.rowsWritten;
              if (isSgv1000(sql)) {
                if (/\bAND id = \?/.test(sql)) {
                  counts.sgv1000Points++;
                  counts.sgv1000PointReads += cursor.rowsRead;
                } else {
                  counts.sgv1000Loads++;
                  counts.sgv1000LoadReads += cursor.rowsRead;
                }
              }
            }
            captured = [];
            for (const field of Object.keys(totals) as Array<keyof Counts>) {
              totals[field] += counts[field];
              hour[field] += counts[field];
            }
            hour.maxMinuteReads = Math.max(hour.maxMinuteReads, counts.reads);
            if (minute % 60 === 59) {
              hours.push(hour);
              console.info(`ONE_MINUTE_SGV_HOUR=${JSON.stringify(hour)}`);
              hour = { hour: hours.length, ...emptyCounts(), maxMinuteReads: 0 };
            }
          }
        } finally { spy.mockRestore(); }

        // These persistence/oracle SQL queries are outside the measured region.
        const persisted = state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM documents WHERE collection = 'entries'",
        ).one().count;
        expect(persisted).toBe(SEED_ROWS + DAY_MINUTES);
        expect(state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM entries",
        ).one().count).toBe(DAY_MINUTES);
        const oracle = state.storage.sql.exec<Row>(`SELECT id, body, sort_time FROM documents
          WHERE collection = 'entries' AND sort_time >= ?
          ORDER BY sort_time DESC, id ASC LIMIT ?`, now - 2 * 24 * 60 * MINUTE, ROOT_ROWS)
          .toArray().map(({ body }) => {
            const document = JSON.parse(body) as JsonDocument;
            return { _id: document._id, mgdl: document.sgv, mills: document.date,
              device: document.device, direction: document.direction, type: "sgv" };
          }).reverse();
        expect(lastRoot).toEqual(oracle);
        expect(lastDdata).toEqual(oracle);
        expect(lastProperties).toEqual(oracle.slice(-64));
        expect(duplicates).toBe(144);
        expect(corrections).toBe(72);
        expect(hours).toHaveLength(24);
        expect(totals.reads).toBeLessThan(1_000_000);
        // One bounded cold load; both normal uploads and repeated selected-row
        // writes then maintain the complete existing window by point queries.
        expect(totals.sgv1000Loads).toBe(1);
        expect(totals.sgv1000LoadReads).toBeLessThanOrEqual(SEED_ROWS * 5 + 8);
        expect(totals.sgv1000Points).toBeGreaterThanOrEqual(DAY_MINUTES - 1);
        for (const later of hours.slice(1)) expect(later.sgv1000Loads).toBe(0);
        const stableMax = Math.max(...hours.slice(1, -1).map(item => item.reads));
        expect(hours.at(-1)!.reads).toBeLessThanOrEqual(stableMax * 1.25 + 1000);
        return { seededRows: SEED_ROWS, addedRows: DAY_MINUTES, persisted, duplicates, corrections,
          readerCalls: DAY_MINUTES * 3, unprojectedRawCacheBytes, rawCacheCap: RAW_CACHE_CAP,
          expectedRootRows: ROOT_ROWS, expectedPropertiesRows: 64, totals, hours, finalCache,
          lastSgv: lastRoot.at(-1), firstSgv: lastRoot[0] };
      } finally { realtimeClock.mockRestore(); clock.mockRestore(); }
    });
    console.info(`ONE_MINUTE_SGV_ENDURANCE=${JSON.stringify(report)}`);
  }, 180_000);
});
