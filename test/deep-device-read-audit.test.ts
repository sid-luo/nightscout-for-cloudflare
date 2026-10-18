import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { filterDocuments } from "../src/documents";
import type { EntryStore, JsonDocument } from "../src/entry-store";
import worker from "../src/index";
import { LegacyDeviceStatusQuery } from "../src/legacy-device-status-query";
import { syntheticDeviceStatus } from "./fixtures/synthetic-device-status";

const ORIGIN = "https://synthetic.invalid";
const DAY = 86_400_000;
const RECORDS = 5105;
const CACHE_BYTES = 8 * 1024 * 1024;
const OPTIONS = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false };
const id = (index: number) => index.toString(16).padStart(24, "0");

/** Uses the four 48-value prediction arrays from the existing Trio fixture. */
function document(index: number, at: number, predictions: boolean): JsonDocument {
  const common = {
    _id: id(index), device: "openaps://synthetic-phone", date: at, created_at: new Date(at).toISOString(),
    uploaderBattery: index % 2 === 0 ? 80 : "80", checks: [{ value: index % 3 }, { value: 8 }],
    ...(index === 0 ? { onlyOldest: "yes" } : {}),
  };
  const suggested = {
    timestamp: new Date(at).toISOString(), IOB: 0, COB: 0,
    ...(predictions ? { predBGs: Object.fromEntries(["IOB", "COB", "UAM", "ZT"].map(key => [
      key, Array.from({ length: 48 }, (_, point) => 100 + (point % 30)),
    ])) } : {}),
  };
  const shaped: JsonDocument = syntheticDeviceStatus("synthetic-aaps-shape", at);
  // Raw legacy documents have no identifier; preserve that distinction.
  delete shaped.identifier;
  return predictions ? {
    ...shaped, ...common, openaps: { suggested },
    pump: { ...syntheticDeviceStatus("synthetic-aaps-shape", at).pump, battery: { percent: 20 + index % 80 } },
  } : {
    ...common, app: "Trio", utcOffset: 0, openaps: { suggested },
    pump: { clock: new Date(at).toISOString(), battery: { percent: 20 + index % 80 }, reservoir: 50 },
  };
}

function seed(storage: DurableObjectStorage, now: number, predictions: boolean, ties = false, omitDate = false): void {
  storage.transactionSync(() => {
    for (let index = 0; index < RECORDS; index++) {
      const at = ties ? now : now - (RECORDS - index) * 60_000;
      const value = document(index, at, predictions);
      if (omitDate) delete value.date;
      storage.sql.exec(`INSERT INTO documents
        (collection,id,body,sort_time,created_at,updated_at,identifier_present,srv_metadata_version,is_valid,revision)
        VALUES('devicestatus',?,?,?,?,?,0,1,1,0)`,
      id(index), JSON.stringify(value), at, at, at);
    }
  });
}

function forwardingEnvironment(instance: EntryStore): Parameters<typeof worker.fetch>[1] {
  return {
    ASSETS: env.ASSETS,
    ENTRY_STORE: { getByName: () => new Proxy(instance, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) },
    API_SECRET: "synthetic-deep-device-audit", AUTH_DEFAULT_ROLES: "readable", AUTH_FAIL_DELAY: "0",
  } as unknown as Parameters<typeof worker.fetch>[1];
}

function url(query: string): URL { return new URL(`${ORIGIN}/api/v1/devicestatus.json${query}`); }

async function read(instance: EntryStore, query: string): Promise<JsonDocument[]> {
  const response = await worker.fetch(new Request(url(query)), forwardingEnvironment(instance));
  expect(response.status, query).toBe(200);
  return response.json<JsonDocument[]>();
}

function oracle(sql: SqlStorage, query: string): JsonDocument[] {
  return filterDocuments(sql.exec<{ body: string }>(
    "SELECT body FROM documents WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT 5000",
    "devicestatus",
  ).toArray().map(row => JSON.parse(row.body)), url(query), 10);
}

// The historical diagnostic measures unpacked body text. A prefix above this
// bound may now fit the same cache after its lossless private representation.
function prefixBytes(sql: SqlStorage): number {
  return sql.exec<{ bytes: number }>(`SELECT sum(2 * (length(id) + length(body)) + 128) AS bytes
    FROM (SELECT id, body FROM documents WHERE collection='devicestatus'
      ORDER BY sort_time DESC, updated_at DESC LIMIT 5000)`).one().bytes;
}

async function measure<T>(sql: SqlStorage, action: () => T | Promise<T>) {
  const exec = sql.exec.bind(sql);
  const queries: { statement: string; bindings: SqlStorageValue[]; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = exec(statement, ...bindings);
    queries.push({ statement, bindings, cursor });
    return cursor;
  });
  try {
    const result = await action();
    return {
      result,
      reads: queries.reduce((sum, query) => sum + query.cursor.rowsRead, 0),
      deviceReads: queries.filter(query => /FROM documents/.test(query.statement)
        && (/collection = 'devicestatus'/.test(query.statement) || query.bindings[0] === "devicestatus"))
        .reduce((sum, query) => sum + query.cursor.rowsRead, 0),
      writes: queries.reduce((sum, query) => sum + query.cursor.rowsWritten, 0),
    };
  } finally { spy.mockRestore(); }
}

function rawCacheReady(instance: EntryStore): boolean {
  // ready now also includes compact field-set prefixes. This audit explicitly
  // checks whether the original full 5,000-body prefix is reusable.
  return (instance as unknown as { legacyDeviceStatusCandidates: { peek(limit: number): readonly unknown[] | undefined } })
    .legacyDeviceStatusCandidates.peek(5000) !== undefined;
}

/** Experimental query-aware consumption only, without modifying runtime code. */
function streamed(sql: SqlStorage, query: string): JsonDocument[] {
  const cursor = sql.exec<{ body: string }>(`SELECT id, body, sort_time, updated_at FROM documents
    WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT 5000`, "devicestatus");
  function* documents(): IterableIterator<JsonDocument> {
    for (const row of cursor) yield JSON.parse(row.body) as JsonDocument;
  }
  return new LegacyDeviceStatusQuery(query).read(documents());
}

describe("deep devicestatus read audit", () => {
  it("keeps common queries bounded when unpacked prediction bodies exceed the raw-cache budget", async () => {
    const stub = env.ENTRY_STORE.getByName(`deep-device-large-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const now = Date.now();
      seed(state.storage, now, true);
      const bytes = prefixBytes(state.storage.sql);
      expect(bytes).toBeGreaterThan(CACHE_BYTES);
      const queries = [
        "?count=5",
        `?find[created_at][$gte]=${new Date(now - 7 * DAY).toISOString()}&count=5`,
        "?find[device]=openaps://synthetic-phone&count=5",
        "?find[openaps.suggested.timestamp][$exists]=true&count=5",
        "?find[checks.value]=8&count=5",
        "?sort[created_at]=-1&count=5",
        "?sort[pump.battery.percent]=1&count=5",
        "?find[onlyOldest]=yes&count=1",
      ];
      const samples = [];
      for (const query of queries) {
        const expected = oracle(state.storage.sql, query);
        for (let repeat = 0; repeat < 2; repeat++) {
          const measured = await measure(state.storage.sql, () => read(instance, query));
          expect(measured.result, query).toEqual(expected);
          expect(measured.writes).toBe(0);
          if (query.includes("sort[") || query.includes("onlyOldest")) {
            if (repeat === 0) {
              // Native (sort_time,updated_at) ordering needs the complete
              // 5000 candidates for JS sorting/absence, once rather than twice.
              expect(measured.deviceReads).toBeGreaterThanOrEqual(5000);
              expect(measured.deviceReads).toBeLessThanOrEqual(5001);
            } else {
              // A projected hit fetches only its selected canonical bodies.
              expect(measured.deviceReads).toBeLessThanOrEqual(2 * measured.result.length);
              if (measured.result.length === 0) expect(measured.deviceReads).toBe(0);
            }
          } else {
            expect(measured.deviceReads).toBeLessThanOrEqual(6);
            if (query === "?count=5" && repeat === 1) expect(measured.deviceReads).toBe(0);
          }
          samples.push({ query: query.replace(new Date(now - 7 * DAY).toISOString(), "<cutoff>"), repeat,
            reads: measured.reads, deviceReads: measured.deviceReads, returned: measured.result.length });
        }
      }
      expect(rawCacheReady(instance)).toBe(false);
      // Fetching a short count does not promote it to a complete prefix. A
      // genuine complete raw load can now fit through lossless compression.
      const expectedRaw = oracle(state.storage.sql, "?count=5000");
      const coldRaw = await measure(state.storage.sql, () => instance.getLegacyDeviceStatusJson(5000));
      const warmRaw = await measure(state.storage.sql, () => instance.getLegacyDeviceStatusJson(5000));
      expect(JSON.parse(coldRaw.result)).toEqual(expectedRaw);
      expect(JSON.parse(warmRaw.result)).toEqual(expectedRaw);
      expect(coldRaw.deviceReads).toBeGreaterThanOrEqual(5000);
      expect(coldRaw.deviceReads).toBeLessThanOrEqual(5001);
      expect(warmRaw.deviceReads).toBe(0);
      expect(coldRaw.writes + warmRaw.writes).toBe(0);
      expect(rawCacheReady(instance)).toBe(true);
      const retainedBytes = (instance as unknown as { legacyDeviceStatusCandidates: { retainedBytes: number } })
        .legacyDeviceStatusCandidates.retainedBytes;
      expect(retainedBytes).toBeLessThanOrEqual(CACHE_BYTES);
      return { shape: "AAPS pump metadata plus existing Trio four-by-48 predBGs", records: RECORDS, prefixBytes: bytes, samples,
        packedRaw: { cold: coldRaw.deviceReads, warm: warmRaw.deviceReads, retainedBytes } };
    });
    console.log(`DEEP_DEVICE_LARGE=${JSON.stringify(report)}`);
    // Read-cost changes are asserted against the complete result oracle above;
    // the former exact costs remain preserved in the before diagnostic logs.
    expect(report.records).toBe(RECORDS);
    expect(report.prefixBytes).toBeGreaterThan(CACHE_BYTES);
    expect(report.samples).toHaveLength(16);
  }, 60_000);

  it("measures a correct cold reload after each eviction even when the complete prefix fits", async () => {
    const stub = env.ENTRY_STORE.getByName(`deep-device-eviction-${crypto.randomUUID()}`);
    const query = "?find[device]=openaps://synthetic-phone&count=5";
    const reports = [];
    reports.push(await runInDurableObject(stub, async (instance: EntryStore, state) => {
      seed(state.storage, Date.now(), false);
      const bytes = prefixBytes(state.storage.sql);
      expect(bytes).toBeLessThan(CACHE_BYTES);
      const expected = oracle(state.storage.sql, query);
      const cold = await measure(state.storage.sql, () => read(instance, query));
      const warm = await measure(state.storage.sql, () => read(instance, query));
      expect(cold.result).toEqual(expected);
      expect(warm.result).toEqual(expected);
      expect(cold.deviceReads).toBeLessThanOrEqual(6);
      expect(warm.deviceReads).toBeLessThanOrEqual(6);
      expect(rawCacheReady(instance)).toBe(false);
      return { phase: "initial", prefixBytes: bytes, cold: cold.deviceReads, warm: warm.deviceReads };
    }));
    for (let eviction = 0; eviction < 2; eviction++) {
      await evictDurableObject(stub);
      reports.push(await runInDurableObject(stub, async (instance: EntryStore, state) => {
        const expected = oracle(state.storage.sql, query);
        const cold = await measure(state.storage.sql, () => read(instance, query));
        const warm = await measure(state.storage.sql, () => read(instance, query));
        expect(cold.result).toEqual(expected);
        expect(warm.result).toEqual(expected);
        expect(cold.deviceReads).toBeLessThanOrEqual(6);
        expect(warm.deviceReads).toBeLessThanOrEqual(6);
        return { phase: `eviction-${eviction}`, prefixBytes: prefixBytes(state.storage.sql), cold: cold.deviceReads, warm: warm.deviceReads };
      }));
    }
    console.log(`DEEP_DEVICE_EVICTION=${JSON.stringify(reports)}`);
    expect(reports).toMatchInlineSnapshot(`
      [
        {
          "cold": 6,
          "phase": "initial",
          "prefixBytes": 4690000,
          "warm": 6,
        },
        {
          "cold": 6,
          "phase": "eviction-0",
          "prefixBytes": 4690000,
          "warm": 6,
        },
        {
          "cold": 6,
          "phase": "eviction-1",
          "prefixBytes": 4690000,
          "warm": 6,
        },
      ]
    `);
  }, 60_000);

  it("distinguishes harmless old inserts from patches that repeatedly expose an unknown window successor", async () => {
    const stub = env.ENTRY_STORE.getByName(`deep-device-history-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const now = Date.now();
      // API3 date is immutable. Legacy device statuses commonly have only
      // created_at; that mutable field supplies their storage sort_time.
      seed(state.storage, now, false, false, true);
      const query = `?find[created_at][$gte]=${new Date(now - 7 * DAY).toISOString()}&count=5`;
      // Exercise an existing complete cache as well as its safe stream fallback.
      await instance.getLegacyDeviceStatusJson(5000);
      expect(await read(instance, query)).toEqual(oracle(state.storage.sql, query));
      expect(rawCacheReady(instance)).toBe(true);
      const samples = [];
      await instance.createDocuments("devicestatus", JSON.stringify([document(70_000, now - 100 * DAY, false)]));
      const oldInsert = await measure(state.storage.sql, () => read(instance, query));
      expect(oldInsert.result).toEqual(oracle(state.storage.sql, query));
      expect(oldInsert.deviceReads).toBe(0);
      samples.push({ phase: "old-insert", reads: oldInsert.reads, deviceReads: oldInsert.deviceReads });
      for (let patch = 0; patch < 3; patch++) {
        const patched = JSON.parse(await instance.api3PatchDocument("devicestatus", id(RECORDS - 1 - patch),
          JSON.stringify({ created_at: new Date(now - (100 + patch) * DAY).toISOString() }), JSON.stringify(OPTIONS)));
        expect(patched, JSON.stringify(patched)).toMatchObject({ ok: true });
        expect(rawCacheReady(instance)).toBe(false);
        const measured = await measure(state.storage.sql, () => read(instance, query));
        expect(measured.result).toEqual(oracle(state.storage.sql, query));
        expect(measured.deviceReads).toBeLessThanOrEqual(6);
        samples.push({ phase: `patch-outside-${patch}`, reads: measured.reads, deviceReads: measured.deviceReads });
      }
      return samples;
    });
    console.log(`DEEP_DEVICE_HISTORY=${JSON.stringify(report)}`);
    expect(report).toMatchInlineSnapshot(`
      [
        {
          "deviceReads": 0,
          "phase": "old-insert",
          "reads": 7,
        },
        {
          "deviceReads": 6,
          "phase": "patch-outside-0",
          "reads": 14,
        },
        {
          "deviceReads": 6,
          "phase": "patch-outside-1",
          "reads": 14,
        },
        {
          "deviceReads": 6,
          "phase": "patch-outside-2",
          "reads": 14,
        },
      ]
    `);
  }, 60_000);

  it("keeps the original streaming/tie fallback when the optional native index is deferred", async () => {
    const distinct = env.ENTRY_STORE.getByName(`deep-device-stream-${crypto.randomUUID()}`);
    const streamReport = await runInDurableObject(distinct, async (_instance: EntryStore, state) => {
      // Explicitly reproduce a deferred native assessment. This remains a
      // separate oracle for the old SQL path, not a claim about current native.
      state.storage.sql.exec("DROP INDEX documents_devicestatus_recent");
      const now = Date.now();
      seed(state.storage, now, true);
      const reports = [];
      for (const query of [
        `?find[date][$gte]=${now - 7 * DAY}&count=5`,
        "?find[device]=openaps://synthetic-phone&count=5",
        "?find[checks.value]=8&count=5",
        "?find[onlyOldest]=yes&count=1",
        "?sort[pump.battery.percent]=1&count=5",
      ]) {
        const expected = oracle(state.storage.sql, query);
        const measured = await measure(state.storage.sql, () => streamed(state.storage.sql, query));
        expect(measured.result, query).toEqual(expected);
        if (query.includes("onlyOldest") || query.includes("sort[")) expect(measured.deviceReads).toBeGreaterThanOrEqual(10_000);
        else expect(measured.deviceReads).toBeLessThan(100);
        reports.push({ query: query.replace(String(now - 7 * DAY), "<cutoff>"), reads: measured.deviceReads, returned: measured.result.length });
      }
      return reports;
    });
    const tied = env.ENTRY_STORE.getByName(`deep-device-ties-${crypto.randomUUID()}`);
    const tieReport = await runInDurableObject(tied, async (instance: EntryStore, state) => {
      state.storage.sql.exec("DROP INDEX documents_devicestatus_recent");
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        seed(state.storage, now, false, true);
        const query = "?count=5";
        const initial = await measure(state.storage.sql, () => read(instance, query));
        expect(initial.result).toEqual(oracle(state.storage.sql, query));
        expect(initial.deviceReads).toBeGreaterThanOrEqual(RECORDS);
        const mutations = [];
        for (let upload = 0; upload < 2; upload++) {
          await instance.createDocuments("devicestatus", JSON.stringify([document(80_000 + upload, now, false)]));
          const measured = await measure(state.storage.sql, () => read(instance, query));
          expect(measured.result).toEqual(oracle(state.storage.sql, query));
          expect(measured.deviceReads).toBeGreaterThanOrEqual(RECORDS);
          mutations.push({ upload, reads: measured.deviceReads });
        }
        const beforeIndex = await measure(state.storage.sql, () => streamed(state.storage.sql, "?find[checks.value]=8&count=5"));
        expect(beforeIndex.result).toEqual(oracle(state.storage.sql, "?find[checks.value]=8&count=5"));
        expect(beforeIndex.deviceReads).toBeGreaterThanOrEqual(RECORDS);
        // Experimental disposable-tenant index only; no application migration.
        state.storage.sql.exec(`CREATE INDEX synthetic_device_sort_updated
          ON documents(collection, sort_time DESC, updated_at DESC)`);
        const afterIndex = await measure(state.storage.sql, () => streamed(state.storage.sql, "?find[checks.value]=8&count=5"));
        expect(afterIndex.result).toEqual(oracle(state.storage.sql, "?find[checks.value]=8&count=5"));
        expect(afterIndex.result).toEqual(beforeIndex.result);
        expect(afterIndex.deviceReads).toBeLessThan(100);
        return { initialSimpleCount: initial.deviceReads, mutations,
          streamedWithoutIndex: beforeIndex.deviceReads, streamedWithIndex: afterIndex.deviceReads };
      } finally { clock.mockRestore(); }
    });
    const report = { streamReport, tieReport };
    console.log(`DEEP_DEVICE_STREAM_AND_TIES=${JSON.stringify(report)}`);
    expect(report).toMatchInlineSnapshot(`
      {
        "streamReport": [
          {
            "query": "?find[date][$gte]=<cutoff>&count=5",
            "reads": 13,
            "returned": 5,
          },
          {
            "query": "?find[device]=openaps://synthetic-phone&count=5",
            "reads": 13,
            "returned": 5,
          },
          {
            "query": "?find[checks.value]=8&count=5",
            "reads": 13,
            "returned": 5,
          },
          {
            "query": "?find[onlyOldest]=yes&count=1",
            "reads": 10001,
            "returned": 0,
          },
          {
            "query": "?sort[pump.battery.percent]=1&count=5",
            "reads": 10001,
            "returned": 5,
          },
        ],
        "tieReport": {
          "initialSimpleCount": 10210,
          "mutations": [
            {
              "reads": 10212,
              "upload": 0,
            },
            {
              "reads": 10214,
              "upload": 1,
            },
          ],
          "streamedWithIndex": 6,
          "streamedWithoutIndex": 5220,
        },
      }
    `);
  }, 60_000);

  it("repeats the exact full query when a selected leaf exceeds both packing and shared prefix limits", async () => {
    const stub = env.ENTRY_STORE.getByName(`deep-device-unpacked-fallback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const count = 64;
      const now = Date.now();
      state.storage.transactionSync(() => {
        for (let index = 0; index < count; index++) {
          const at = now - index * 60_000;
          const value = { ...document(index, at, false), largeText: "x".repeat(70_000) };
          const body = JSON.stringify(value);
          // The codec's 65536-code-unit input bound disables compression;
          // projecting this terminal field must still keep all 70000 units.
          expect(body.length).toBeGreaterThan(65_536);
          state.storage.sql.exec(`INSERT INTO documents
            (collection,id,body,sort_time,created_at,updated_at,identifier_present,srv_metadata_version,is_valid,revision)
            VALUES('devicestatus',?,?,?,?,?,0,1,1,0)`, id(index), body, at, at, at);
        }
      });
      expect(count * 70_000 * 2).toBeGreaterThan(CACHE_BYTES);
      const query = "?sort[largeText]=1&count=5";
      const expected = oracle(state.storage.sql, query);
      for (let repeat = 0; repeat < 2; repeat++) {
        const measured = await measure(state.storage.sql, () => read(instance, query));
        expect(measured.result).toEqual(expected);
        expect(measured.result).toHaveLength(5);
        expect(measured.result.every(value => value.largeText === "x".repeat(70_000))).toBe(true);
        expect(measured.deviceReads).toBeGreaterThanOrEqual(count);
        expect(measured.deviceReads).toBeLessThanOrEqual(count + 1);
        expect(measured.writes).toBe(0);
        const cached = (instance as unknown as { legacyDeviceStatusCandidates: {
          peekProjected(fields: readonly string[], limit: number): readonly unknown[] | undefined;
        } }).legacyDeviceStatusCandidates.peekProjected(new LegacyDeviceStatusQuery(query).projectionFields, 5000);
        expect(cached).toBeUndefined();
        expect(rawCacheReady(instance)).toBe(false);
      }
    });
  }, 60_000);
});
