import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import type { RealtimeEntryQueryCache } from "../src/realtime/entry-query-cache";
import type { RealtimeDocument } from "../src/realtime/ddata-snapshot";

const DAY = 86_400_000;
interface RawRow extends Record<string, SqlStorageValue> {
  id: string;
  body: string;
  sort_time: number;
}
interface EntryBuckets {
  sgvs: RealtimeDocument[];
  mbgs: RealtimeDocument[];
  cals: RealtimeDocument[];
}
interface Internal {
  realtimeEntryQueries: RealtimeEntryQueryCache<RawRow>;
  cachedRealtimeEntries(at: number, frame: boolean, sql: string, limit?: number): Iterable<RawRow>;
  realtimeSnapshot(at: number, frame?: boolean, mode?: "root" | "ddata"): EntryBuckets;
  pluginPropertyContext(at: number): EntryBuckets;
}
const id = (index: number) => index.toString(16).padStart(24, "0");

function insertRaw(storage: DurableObjectStorage, index: number, at: number, body: string): void {
  storage.sql.exec(`INSERT INTO documents
    (collection,id,body,sort_time,created_at,updated_at)
    VALUES('entries',?,?,?,?,?)`, id(index), body, at, at, at);
}

function observe(internal: Internal, at: number) {
  return {
    root: internal.realtimeSnapshot(at, false, "root"),
    ddata: internal.realtimeSnapshot(at, false, "ddata"),
    frame: internal.realtimeSnapshot(at, true, "ddata"),
    properties: internal.pluginPropertyContext(at),
  };
}

/** Execute the unchanged full-body SQL instead of either projection or reuse. */
function unprojectedOracle<T>(internal: Internal, storage: DurableObjectStorage, read: () => T): T {
  const projectedCache = internal.realtimeEntryQueries;
  const projectedLoader = internal.cachedRealtimeEntries;
  internal.realtimeEntryQueries = projectedCache.fork();
  internal.realtimeEntryQueries.clear(); // Prevent cachedRecentSgvRows.peek from bypassing this oracle.
  internal.cachedRealtimeEntries = (at, frame, sql) => {
    const lower = at - 2 * DAY;
    return storage.sql.exec<RawRow>(sql, ...(frame ? [lower, at] : [lower]));
  };
  try {
    return read();
  } finally {
    internal.cachedRealtimeEntries = projectedLoader;
    internal.realtimeEntryQueries = projectedCache;
  }
}

describe("realtime projected entry rows match the original full-body SQL pipeline", () => {
  it("preserves mixed entry values, future frames, advancing/backwards clocks and full public entries", async () => {
    const stub = env.ENTRY_STORE.getByName(`entry-projection-oracle-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const internal = instance as unknown as Internal;
      let now = Date.now();
      const start = now;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const documents = [
        { date: start - 500_000, sgv: " 110 ", device: ["CGM", null], direction: { name: "Flat" },
          filtered: { reading: "100" }, unfiltered: [100, null], noise: null, rssi: false,
          identifier: "full-public-entry", custom: { keep: "public metadata", points: [1, 2] },
          dateString: new Date(start - 500_000).toISOString(), sysTime: "ignored by realtime", app: "uploader" },
        { date: start - 400_000, sgv: true, device: null, direction: false, noise: [1], rssi: { value: 2 } },
        { date: start - 300_000, sgv: "0", direction: "Flat" },
        { date: start - 200_000, sgv: 111, mbg: "0", type: "mbg", device: ["meter"] },
        { date: start - 100_000, mbg: true, type: "mbg", device: { name: "meter" } },
        { date: start - 90_000, type: "cal", sgv: false, mbg: 0,
          scale: ["1.0"], intercept: { amount: "2" }, slope: null },
        { date: start + 120_000, type: "cal", scale: "1.25", intercept: [0], slope: true },
        { date: start + 60_000, sgv: 125, device: "future-cgm" },
        { date: start - 2 * DAY - 1, sgv: 90, device: "outside-original-window" },
        { date: start - 80_000, type: "cal", sgv: [], scale: 1, slope: 2 }, // JS-truthy array excludes CAL.
        { date: start - 70_000, sgv: [120], device: "SQL-excludes-array-measurement" },
        { date: start - 60_000, sgv: "0x10", device: "original-SQL-numeric-coercion" },
      ];
      try {
        state.storage.transactionSync(() => {
          for (const [index, document] of documents.entries()) {
            insertRaw(state.storage, index, document.date, JSON.stringify({ _id: id(index), ...document }));
          }
          // Historical JSON can express values JSON.stringify would change.
          // Keep their original body/date/id behavior via projection fallback.
          insertRaw(state.storage, 20, start - 50_000,
            `{"_id":"${id(20)}","date":${start - 50_000},"sgv":112,"device":{"nested":1e309}}`);
          insertRaw(state.storage, 21, start - 40_000,
            `{"_id":"${id(21)}","date":-0,"sgv":113,"noise":[-0]}`);
          insertRaw(state.storage, 22, start - 30_000,
            `{"_id":"body-id-differs-from-storage","date":${start - 31_000},"sgv":114,"extra":true}`);
        });
        // Fixture SQL bypasses the normal mutation hooks and activation can
        // already have completed empty notification queries.
        internal.realtimeEntryQueries.clear();
        const first = observe(internal, now);
        expect(first).toEqual(unprojectedOracle(internal, state.storage, () => observe(internal, now)));
        expect(first.root.sgvs.some(entry => entry._id === id(7))).toBe(true);
        expect(first.frame.sgvs.some(entry => entry._id === id(7))).toBe(false);
        expect(first.root.sgvs.some(entry => entry._id === id(8))).toBe(false);
        expect(first.properties.cals.map(entry => entry._id)).toEqual([id(6)]); // Original future-CAL behavior.
        expect(first.root.sgvs.find(entry => entry._id === id(20))?.device).toEqual({ nested: Infinity });
        expect(Object.is(first.root.sgvs.find(entry => entry._id === id(21))?.mills, -0)).toBe(true);
        expect(first.root.sgvs.find(entry => entry._id === "body-id-differs-from-storage")?.mills).toBe(start - 31_000);

        for (const at of [start + 30_000, start + 60_000, start + 120_000, start - 60_000,
          start + 3 * DAY, start]) {
          now = at;
          const projected = observe(internal, at);
          expect(projected).toEqual(unprojectedOracle(internal, state.storage, () => observe(internal, at)));
          if (at === start + 60_000) expect(projected.frame.sgvs.some(entry => entry._id === id(7))).toBe(true);
          if (at === start - 60_000) expect(projected.root.sgvs.some(entry => entry._id === id(8))).toBe(true);
          if (at === start + 3 * DAY) expect(projected.root.sgvs).toEqual([]);
        }
        const publicEntries = await instance.getEntryById(id(0));
        expect(publicEntries).toHaveLength(1);
        expect(publicEntries[0]).toMatchObject({
          identifier: "full-public-entry", custom: { keep: "public metadata", points: [1, 2] },
          dateString: documents[0]!.dateString, sysTime: "ignored by realtime", app: "uploader",
        });
      } finally {
        clock.mockRestore();
      }
    });
  }, 30_000);

  it("retains strict public-field errors from the unprojected consumer", async () => {
    for (const [name, body] of [
      ["missing-id", '{"date":100,"sgv":110}'],
      ["string-date", '{"_id":"body-id","date":"100","sgv":110}'],
    ] as const) {
      const stub = env.ENTRY_STORE.getByName(`entry-projection-error-${name}-${crypto.randomUUID()}`);
      await runInDurableObject(stub, (instance: EntryStore, state) => {
        const internal = instance as unknown as Internal;
        const now = Date.now();
        insertRaw(state.storage, 0, now, body);
        internal.realtimeEntryQueries.clear();
        const outcome = () => {
          try { return { result: internal.realtimeSnapshot(now) }; }
          catch (error) {
            return { error: error instanceof Error
              ? { name: error.name, message: error.message } : String(error) };
          }
        };
        const projected = outcome();
        expect(projected).toEqual(unprojectedOracle(internal, state.storage, outcome));
        expect(projected).toHaveProperty("error");
        expect(projected).toMatchObject({
          error: { message: "stored entry is missing its legacy public fields" },
        });
      });
    }
  }, 30_000);

  it("reuses a nonempty CAL window after the consumer's first-row break and keeps real mutations fresh", async () => {
    const stub = env.ENTRY_STORE.getByName(`entry-cal-prefetch-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const internal = instance as unknown as Internal;
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const latestCalAt = now - 30_000;
      const options = JSON.stringify({ canCreate: true, canUpdate: true, actor: null,
        ifUnmodifiedSince: null, emitRealtime: true, validate: false });
      try {
        const create = async (identifier: string, date: number, fields: Record<string, unknown>) => {
          expect(JSON.parse(await instance.api3CreateDocument("entries", JSON.stringify({
            identifier, date, utcOffset: 0, app: "synthetic", ...fields,
          }), options))).toMatchObject({ ok: true });
          const publicJson = await instance.findApi3Document("entries", identifier, "null");
          expect(publicJson).not.toBeNull();
          expect(JSON.parse(publicJson!)).toMatchObject({ identifier, date, ...fields });
          // API3 intentionally removes _id. Observe the actual stored body
          // after the real write rather than assuming an SQL fixture identity.
          const stored = state.storage.sql.exec<{ id: string; body: string }>(
            "SELECT id, body FROM documents WHERE collection = 'entries' AND identifier = ?", identifier,
          ).one();
          expect(JSON.parse(stored.body)._id).toBe(stored.id);
          return stored.id;
        };
        await create("cal-cgm", now - 10_000, { type: "sgv", sgv: 110 });
        const latestId = await create("cal-latest", latestCalAt,
          { type: "cal", scale: 1, intercept: 0, slope: 2 });
        const olderId = await create("cal-older", now - 60_000,
          { type: "cal", scale: 3, intercept: 1, slope: 4 });
        internal.realtimeEntryQueries.clear();
        const coldSql = vi.spyOn(state.storage.sql, "exec");
        let first: EntryBuckets;
        let calSql: string;
        try {
          first = internal.pluginPropertyContext(now);
          const calls = coldSql.mock.calls.filter(([sql]) =>
            sql.includes("json_extract(body, '$.type') = 'cal'") && /\bLIMIT 10\s*$/.test(sql));
          expect(calls).toHaveLength(1);
          calSql = calls[0]![0];
          expect(coldSql.mock.calls.filter(([sql]) => sql === calSql)).toHaveLength(1);
        } finally {
          coldSql.mockRestore();
        }
        expect(first.cals).toEqual([{
          _id: latestId, mills: latestCalAt, scale: 1, intercept: 0, slope: 2, type: "cal",
        }]);
        now += 1_000;
        const warmSql = vi.spyOn(state.storage.sql, "exec");
        let second: EntryBuckets;
        try {
          second = internal.pluginPropertyContext(now);
          // Match the complete original CAL SQL key, not just a cache-ready flag.
          expect(warmSql.mock.calls.filter(([sql]) => sql === calSql)).toHaveLength(0);
        } finally {
          warmSql.mockRestore();
        }
        expect(second.cals).toEqual(first.cals);
        expect(second).toEqual(unprojectedOracle(internal, state.storage, () => internal.pluginPropertyContext(now)));

        expect(JSON.parse(await instance.api3PatchDocument("entries", "cal-latest",
          JSON.stringify({ scale: 1.5, slope: 5 }), options))).toMatchObject({ ok: true });
        const changed = internal.pluginPropertyContext(now);
        expect(changed.cals).toEqual([{
          _id: latestId, mills: latestCalAt, scale: 1.5, intercept: 0, slope: 5, type: "cal",
        }]);
        expect(changed).toEqual(unprojectedOracle(internal, state.storage, () => internal.pluginPropertyContext(now)));
        expect((await instance.api3DeleteDocument("entries", "cal-latest", true, null)).deleted).toBe(true);
        const deleted = internal.pluginPropertyContext(now);
        expect(deleted.cals.map(entry => entry._id)).toEqual([olderId]);
        expect(deleted).toEqual(unprojectedOracle(internal, state.storage, () => internal.pluginPropertyContext(now)));
        expect((await instance.api3DeleteDocument("entries", "cal-older", true, null)).deleted).toBe(true);
        const empty = internal.pluginPropertyContext(now);
        expect(empty.cals).toEqual([]);
        expect(empty).toEqual(unprojectedOracle(internal, state.storage, () => internal.pluginPropertyContext(now)));
      } finally {
        clock.mockRestore();
      }
    });
  }, 30_000);
});
