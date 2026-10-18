import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore, JsonDocument, JsonValue } from "../src/entry-store";
import { filterDocuments } from "../src/documents";
import { LegacyDeviceStatusCandidateCache } from "../src/legacy-device-status-candidate-cache";
import { LegacyDeviceStatusQuery } from "../src/legacy-device-status-query";
import worker from "../src/index";
import { syntheticDeviceStatus } from "./fixtures/synthetic-device-status";

const ORIGIN = "https://synthetic.invalid";
const RECORDS = 5105;
const CANDIDATES = 5000;
const MINUTE = 60_000;
const RAW_CACHE_CAP = 8 * 1024 * 1024;
const objectId = (n: number) => n.toString(16).padStart(24, "0");
const url = (search: string) => new URL(`${ORIGIN}/api/v1/devicestatus.json${search}`);
interface Internal {
  legacyDeviceStatusCandidates: { clear(): void; readonly ready: boolean };
  legacyDeviceStatusQueries: { clear(): void };
  realtimeDeviceStatusQueries: { clear(): void };
  realtime: { now(): number };
}

function status(n: number, at: number): JsonDocument {
  const shaped: JsonDocument = syntheticDeviceStatus(`synthetic-sort-${n}`, at);
  delete shaped.identifier;
  const choices: Array<JsonValue | undefined> = [n % 80, String(n % 80).padStart(2, "0"), null, true, false, "text", undefined];
  const percent = choices[n % choices.length];
  return { ...shaped, _id: objectId(n), date: at, created_at: new Date(at).toISOString(),
    pump: { ...syntheticDeviceStatus("synthetic", at).pump,
      battery: percent === undefined ? {} : { percent } },
    openaps: { suggested: { timestamp: new Date(at).toISOString(), IOB: 0, COB: 0,
      predBGs: Object.fromEntries(["IOB", "COB", "UAM", "ZT"].map(key => [
        key, Array.from({ length: 48 }, (_, point) => 100 + point % 30),
      ])) } },
    checks: [{ value: n % 3 }, { value: 8 }], tuple: [n % 3, String(n % 5)],
    ...(n % 2 === 0 ? { branch: {} } : {}),
    ...(n === 0 ? { onlyOutside: "yes" } : {}),
  };
}

function seed(storage: DurableObjectStorage, internal: Internal, now: number, ties = false): number {
  let prefixBytes = 0;
  storage.transactionSync(() => {
    for (let n = 0; n < RECORDS; n++) {
      const at = ties ? now : now - (RECORDS - n) * MINUTE;
      const id = objectId(n);
      const body = JSON.stringify(status(n, at));
      if (n >= RECORDS - CANDIDATES) prefixBytes += 2 * (id.length + body.length) + 128;
      storage.sql.exec(`INSERT INTO documents
        (collection,id,body,sort_time,created_at,updated_at,identifier_present,srv_metadata_version,is_valid,revision)
        VALUES('devicestatus',?,?,?,?,?,0,1,1,0)`, id, body, at, at, at);
    }
  });
  // Direct fixture SQL bypasses normal invalidation; discard any activation
  // empty-prefix cache before evaluating either correctness or read cost.
  internal.legacyDeviceStatusCandidates.clear();
  internal.legacyDeviceStatusQueries.clear();
  internal.realtimeDeviceStatusQueries.clear();
  return prefixBytes;
}

function oracle(sql: SqlStorage, search: string): JsonDocument[] {
  const documents = sql.exec<{ body: string }>(`SELECT body FROM documents
    WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT 5000`, "devicestatus")
    .toArray().map(row => JSON.parse(row.body) as JsonDocument);
  return filterDocuments(documents, url(search), 10);
}

function configuration(instance: EntryStore): Parameters<typeof worker.fetch>[1] {
  const forward = new Proxy(instance, { get(target, key) {
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => forward },
    API_SECRET: "synthetic-custom-sort-secret", AUTH_DEFAULT_ROLES: "readable", AUTH_FAIL_DELAY: "0",
  } as unknown as Parameters<typeof worker.fetch>[1];
}

async function measured<T>(storage: DurableObjectStorage, read: () => T | Promise<T>) {
  const execute = storage.sql.exec.bind(storage.sql);
  const queries: { sql: string; bindings: SqlStorageValue[];
    cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(storage.sql, "exec").mockImplementation((sql, ...bindings) => {
    const cursor = execute(sql, ...bindings);
    queries.push({ sql, bindings, cursor });
    return cursor;
  });
  let result: T;
  try { result = await read(); }
  finally { spy.mockRestore(); }
  const device = queries.filter(({ sql, bindings }) => sql.includes("FROM documents")
    && (sql.includes("collection = 'devicestatus'") || bindings[0] === "devicestatus"));
  return { result, reads: queries.reduce((sum, { cursor }) => sum + cursor.rowsRead, 0),
    writes: queries.reduce((sum, { cursor }) => sum + cursor.rowsWritten, 0),
    deviceReads: device.reduce((sum, { cursor }) => sum + cursor.rowsRead, 0),
    deviceQueries: device.map(({ sql, cursor }) => ({ sql: sql.replace(/\s+/g, " ").trim(),
      reads: cursor.rowsRead, writes: cursor.rowsWritten })) };
}

async function read(instance: EntryStore, search: string): Promise<JsonDocument[]> {
  const response = await worker.fetch(new Request(url(search)), configuration(instance));
  expect(response.status, search).toBe(200);
  return response.json<JsonDocument[]>();
}

describe("large-prediction custom device status queries", () => {
  it("measures original JS sort/coercion/array and absent-filter costs over the unchanged 5000-row window", async () => {
    const stub = env.ENTRY_STORE.getByName(`custom-device-sort-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      let now = Date.now();
      const internal = instance as unknown as Internal;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const realtimeClock = vi.spyOn(internal.realtime, "now").mockImplementation(() => now);
      try {
        const prefixBytes = seed(state.storage, internal, now);
        expect(prefixBytes).toBeGreaterThan(RAW_CACHE_CAP);
        const samples = [];
        for (const search of [
          "?sort[created_at]=-1&count=5",
          "?sort[pump.battery.percent]=1&count=7",
          "?find[checks.value][$in]=1,8&sort[checks.value]=-1&count=5",
          "?sort[tuple]=1&count=3",
          "?sort[device]=1&sort[created_at]=-1&sort[tuple]=invalid&count=5",
          "?find[onlyOutside]=yes&count=1",
          "?find[missing.child][$exists]=false&count=1",
          "?find[branch.child][$exists]=false&sort[created_at]=-1&count=5",
          "?find[openaps.suggested.predBGs.IOB][$exists]=true&sort[checks.value]=1&count=5",
        ]) for (let repeat = 0; repeat < 2; repeat++) {
          now += 1000;
          const measurement = await measured(state.storage, () => read(instance, search));
          // The independent oracle is outside the measured business SQL.
          expect(measurement.result, search).toEqual(oracle(state.storage.sql, search));
          if (search.includes("onlyOutside") || search.includes("missing.child")) expect(measurement.result).toEqual([]);
          for (const document of measurement.result) {
            const openaps = document.openaps as { suggested: { predBGs: { IOB: unknown[] } } };
            expect(openaps.suggested.predBGs.IOB).toHaveLength(48);
          }
          expect(measurement.deviceReads, search).toBeLessThanOrEqual(10_500);
          if (repeat === 1) {
            expect(measurement.deviceReads, search).toBeLessThan(100);
            if (measurement.result.length === 0) expect(measurement.deviceReads).toBe(0);
          }
          expect(measurement.writes).toBe(0);
          samples.push({ search, repeat, reads: measurement.reads, deviceReads: measurement.deviceReads,
            writes: measurement.writes, returned: measurement.result.length,
            ids: measurement.result.map(document => document._id),
            candidateReady: internal.legacyDeviceStatusCandidates.ready,
            queries: measurement.deviceQueries });
        }
        return { records: RECORDS, candidates: CANDIDATES, prefixBytes, rawCacheCap: RAW_CACHE_CAP, samples };
      } finally { realtimeClock.mockRestore(); clock.mockRestore(); }
    });
    console.info(`CUSTOM_DEVICE_SORT_READ_BUDGET=${JSON.stringify(report)}`);
  }, 60_000);

  it("measures repeated sorted and absent reads during distinct-time real uploads", async () => {
    const stub = env.ENTRY_STORE.getByName(`custom-device-writes-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      let now = Date.now();
      const internal = instance as unknown as Internal;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const realtimeClock = vi.spyOn(internal.realtime, "now").mockImplementation(() => now);
      try {
        const prefixBytes = seed(state.storage, internal, now);
        expect(prefixBytes).toBeGreaterThan(RAW_CACHE_CAP);
        const samples = [];
        for (let cycle = 0; cycle < 3; cycle++) {
          now += MINUTE;
          const nextId = 90_000 + cycle;
          await instance.createDocuments("devicestatus", JSON.stringify([status(nextId, now)]));
          for (const search of ["?sort[created_at]=-1&count=5",
            "?sort[pump.battery.percent]=1&count=7", "?find[onlyOutside]=yes&count=1"]) {
            now += 1000;
            const measurement = await measured(state.storage, () => read(instance, search));
            expect(measurement.result, search).toEqual(oracle(state.storage.sql, search));
            if (search.includes("sort[created_at]")) expect(measurement.result[0]!._id).toBe(objectId(nextId));
            if (search.includes("onlyOutside")) expect(measurement.result).toEqual([]);
            expect(measurement.deviceReads, search).toBeLessThanOrEqual(10_500);
            if (cycle > 0) {
              expect(measurement.deviceReads, search).toBeLessThan(100);
              if (measurement.result.length === 0) expect(measurement.deviceReads).toBe(0);
            }
            expect(measurement.writes).toBe(0);
            samples.push({ cycle, search, deviceReads: measurement.deviceReads, reads: measurement.reads,
              returned: measurement.result.length, ids: measurement.result.map(document => document._id),
              queries: measurement.deviceQueries });
          }
        }
        expect(state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM documents WHERE collection = 'devicestatus'",
        ).one().count).toBe(RECORDS + 3);
        return { prefixBytes, samples };
      } finally { realtimeClock.mockRestore(); clock.mockRestore(); }
    });
    console.info(`CUSTOM_DEVICE_SORT_WRITES_READ_BUDGET=${JSON.stringify(report)}`);
  }, 60_000);

  it("preserves exact SQL ties while measuring same-clock and advancing-clock writes", async () => {
    const stub = env.ENTRY_STORE.getByName(`custom-device-ties-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      let now = Date.now();
      const internal = instance as unknown as Internal;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const realtimeClock = vi.spyOn(internal.realtime, "now").mockImplementation(() => now);
      try {
        const tiedAt = now;
        seed(state.storage, internal, tiedAt, true);
        const samples = [];
        for (const [cycle, advance] of [false, false, true].entries()) {
          if (cycle > 0) {
            if (advance) now += 1000;
            await instance.createDocuments("devicestatus", JSON.stringify([status(95_000 + cycle, tiedAt)]));
          }
          for (const search of ["?count=5", "?sort[created_at]=-1&count=5", "?find[device]=absent&count=1"]) {
            const measurement = await measured(state.storage, () => read(instance, search));
            expect(measurement.result, search).toEqual(oracle(state.storage.sql, search));
            if (cycle === 0 && search !== "?count=5") expect(measurement.deviceReads, search).toBeGreaterThanOrEqual(5000);
            else expect(measurement.deviceReads, search).toBeLessThan(100);
            expect(measurement.writes).toBe(0);
            samples.push({ cycle, advance, search, deviceReads: measurement.deviceReads,
              returned: measurement.result.length, ids: measurement.result.map(document => document._id),
              queries: measurement.deviceQueries });
          }
        }
        return { samples };
      } finally { realtimeClock.mockRestore(); clock.mockRestore(); }
    });
    console.info(`CUSTOM_DEVICE_TIES_READ_BUDGET=${JSON.stringify(report)}`);
  }, 60_000);
});

describe("bounded query-field device candidate representations", () => {
  const row = (id: string, sort_time: number, document: unknown = { a: 1, b: 2 }) => ({
    id, sort_time, updated_at: sort_time, body: JSON.stringify(document),
  });

  it("preserves the original helper over complete referenced leaves, including missing parents and inherited roots", () => {
    const originals = Array.from({ length: 24 }, (_, n) => ({ ...status(n, 1_800_000_000_000 - n), _id: `public-${n}` }));
    const rows = originals.map((document, n) => row(`canonical-${n}`, 24 - n, document));
    for (const search of [
      "?sort[pump.battery.percent]=1&count=7", "?sort[tuple]=1&count=8",
      "?find[checks.value][$ne]=8&count=3", "?find[tuple]=[1,\"1\"]&count=9",
      "?find[branch.child][$exists]=false&sort[created_at]=-1&count=5",
      "?find[missing][$exists]=false&count=5", "?find[missing.child][$exists]=false&count=5",
      "?find[constructor][$exists]=true&sort[constructor]=1&count=5",
      "?sort[device]=1&sort[created_at]=-1&sort[tuple]=invalid&count=5",
      "?find[unrecognized][$unknown]=1&sort[bad$field]=1&count=5",
    ]) {
      const query = new LegacyDeviceStatusQuery(search);
      const expected = filterDocuments(originals, url(search), 10).map(document =>
        `canonical-${Number((document._id as string).slice("public-".length))}`);
      expect(query.selectCandidateRows(rows.map(item => query.projectCandidate(item))).map(item => item.id), search)
        .toEqual(expected);
    }
    expect(new LegacyDeviceStatusQuery("?find[pump.a]=1&sort[device]=1&sort[created_at]=-1&sort[tuple]=invalid")
      .projectionFields).toEqual(["created_at", "pump.a"]);
  });

  it("returns original cold rows and projected warm rows without retaining mutable aliases", () => {
    const cache = new LegacyDeviceStatusCandidateCache();
    const originals = [row("r2", 2, { a: 2, unrelated: "kept in the response" }), row("r1", 1, { a: 1, unrelated: "also kept" })];
    const load = vi.fn(() => originals);
    const cold = [...cache.readProjected(["a"], 2, load, true)];
    expect(cold).toEqual(originals);
    cold[0]!.body = "caller mutation";
    originals[0]!.body = "source mutation";
    const warm = [...cache.readProjected(["a"], 2, load, true)];
    expect(warm.map(item => JSON.parse(item.body))).toEqual([{ a: 2 }, { a: 1 }]);
    warm[0]!.body = "warm caller mutation";
    expect(JSON.parse(cache.peekProjected(["a"], 2)![0]!.body)).toEqual({ a: 2 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("sorts referenced original values without retaining unrelated parsed prediction arrays", () => {
    const search = "?find[__proto__.flag]=yes&sort[value]=-1&count=2";
    const query = new LegacyDeviceStatusQuery(search);
    const predictions = JSON.stringify({ predBGs: Object.fromEntries(["IOB", "COB", "UAM", "ZT"]
      .map(key => [key, Array(2048).fill(110)])) });
    const originals = [
      { ...row("canonical-infinity", 2), body: `{"value":1e309,"__proto__":{"flag":"yes"},"openaps":${predictions}}` },
      { ...row("canonical-negative-zero", 1), body: `{"value":-0,"__proto__":{"flag":"yes"},"openaps":${predictions}}` },
    ];
    const observed: JsonDocument[] = [];
    const originalRead = query.read.bind(query);
    const spy = vi.spyOn(query, "read").mockImplementation(documents => {
      const values = [...documents];
      observed.push(...values);
      return originalRead(values);
    });
    try {
      const selected = query.selectCandidateRows(originals);
      expect(selected).toEqual(originals);
      const expected = filterDocuments(originals.map(item => JSON.parse(item.body) as JsonDocument), url(search), 10);
      expect(selected.map(item => (JSON.parse(item.body) as JsonDocument).value))
        .toEqual(expected.map(document => document.value));
      expect(observed[0]!.value).toBe(Infinity);
      expect(Object.is(observed[1]!.value, -0)).toBe(true);
      for (const document of observed) {
        expect(Object.keys(document).sort()).toEqual(["__proto__", "value"]);
        expect(Object.hasOwn(document, "openaps")).toBe(false);
        expect(Object.hasOwn(document, "__proto__")).toBe(true);
        expect(Object.getPrototypeOf(document)).toBe(Object.prototype);
      }
    } finally { spy.mockRestore(); }
  });

  it("admits only real EOF or the complete boundary, leaving early matching queries lazy", () => {
    const cache = new LegacyDeviceStatusCandidateCache();
    let visited = 0, closed = 0;
    const load = function* () {
      try { for (let n = 0; n < 5005; n++) { visited++; yield row(`r${n}`, 6000 - n); } }
      finally { closed++; }
    };
    const early = new LegacyDeviceStatusQuery("?find[a]=1&count=1");
    expect(early.selectCandidateRows(cache.readProjected(early.projectionFields, 5000, load, true))).toHaveLength(1);
    expect(visited).toBe(1);
    expect(closed).toBe(1);
    expect(cache.peekProjected(["a"], 5000)).toBeUndefined();
    visited = 0;
    const sorted = new LegacyDeviceStatusQuery("?sort[a]=1&count=1");
    expect(sorted.selectCandidateRows(cache.readProjected(sorted.projectionFields, 5000, load, true))).toHaveLength(1);
    expect(visited).toBe(5000);
    expect(closed).toBe(2);
    expect(cache.peekProjected(["a"], 5000)).toHaveLength(5000);
    const small = new LegacyDeviceStatusCandidateCache();
    [...small.readProjected(["a"], 5000, () => [row("only", 1)])];
    expect(small.peekProjected(["a"], 5000)).toHaveLength(1);
  });

  it("shares one byte budget across raw and field-set prefixes with LRU eviction", () => {
    const cache = new LegacyDeviceStatusCandidateCache(3500);
    const rows = [row("r3", 3), row("r2", 2), row("r1", 1)];
    cache.read(1, () => rows.slice(0, 1));
    [...cache.readProjected(["a"], 3, () => rows)];
    expect(cache.peek(1)).toHaveLength(1);
    [...cache.readProjected(["b"], 3, () => rows)];
    expect(cache.retainedBytes).toBeLessThanOrEqual(3500);
    expect(cache.peek(1)).toHaveLength(1);
    expect(cache.peekProjected(["a"], 3)).toBeUndefined();
    expect(cache.peekProjected(["b"], 3)).toHaveLength(3);
    const load = vi.fn(() => rows);
    const shared = new LegacyDeviceStatusCandidateCache();
    [...shared.readProjected(["b", "a", "a"], 3, load)];
    [...shared.readProjected(["a", "b"], 3, load)];
    expect(load).toHaveBeenCalledTimes(1);
    for (let n = 0; n < 40; n++) [...shared.readProjected([`field${n}`], 5000, () => [])];
    expect(shared.entryCount).toBeLessThanOrEqual(32);
  });

  it("falls back for oversized subtrees and bounds even an infinite source to the original candidate window", () => {
    const cache = new LegacyDeviceStatusCandidateCache(700);
    const large = [row("large", 1, { a: "x".repeat(1000) })];
    expect([...cache.readProjected(["a"], 5000, () => large, true)]).toEqual(large);
    expect(cache.peekProjected(["a"], 5000)).toBeUndefined();
    let visited = 0, closed = 0;
    const source = function* () {
      try { while (true) { visited++; yield row(`r${visited}`, 10_000 - visited); } }
      finally { closed++; }
    };
    expect([...cache.readProjected(["a"], 5000, source)]).toHaveLength(5000);
    expect(visited).toBe(5000);
    expect(closed).toBe(1);
    expect(cache.retainedBytes).toBe(0);
  });

  it("keeps forks immutable and invalidates unknown suffixes, exact ties and in-progress generations", () => {
    const cache = new LegacyDeviceStatusCandidateCache();
    const rows = [row("r3", 3), row("r2", 2), row("r1", 1)];
    [...cache.readProjected(["a"], 3, () => rows)];
    const fork = cache.fork();
    fork.upsert(row("new", 4, { a: 9, other: true }));
    expect(fork.peekProjected(["a"], 3)!.map(item => item.id)).toEqual(["new", "r3", "r2"]);
    expect(cache.peekProjected(["a"], 3)!.map(item => item.id)).toEqual(["r3", "r2", "r1"]);
    fork.upsert(row("history", 0));
    expect(fork.peekProjected(["a"], 3)).toHaveLength(3);
    fork.upsert(row("r2", -1));
    expect(fork.peekProjected(["a"], 3)).toBeUndefined();
    const tied = cache.fork();
    tied.upsert(row("tie", 3));
    expect(tied.peekProjected(["a"], 3)).toBeUndefined();
    const boundary = cache.fork();
    boundary.upsert(row("r1", 1, { a: 8 }));
    expect(boundary.peekProjected(["a"], 3)).toBeUndefined();
    cache.clear();
    const pending = cache.readProjected(["a"], 3, () => rows);
    pending.next();
    cache.clear();
    [...pending];
    expect(cache.peekProjected(["a"], 3)).toBeUndefined();
  });

  it("keeps non-object/nonfinite/-0 bodies untouched and maps repeated primitives by original order", () => {
    const query = new LegacyDeviceStatusQuery("?sort[a]=1&count=3");
    const bodies = ["-0", "0", "null", "[]", '{"a":1e309}', '{"a":-0}', "not-json"];
    for (const body of bodies) {
      const candidate = { ...row("raw", 1), body };
      expect(query.projectCandidate(candidate)).toBe(candidate);
    }
    const rows = bodies.slice(0, 4).map((body, n) => ({ ...row(`canonical-${n}`, 10 - n), body }));
    expect(query.selectCandidateRows(rows.map(item => query.projectCandidate(item))).map(item => item.id))
      .toEqual(["canonical-0", "canonical-1", "canonical-2"]);
    const ownProto = { ...row("own-proto", 1), body: '{"__proto__":{"value":"08"},"drop":true}' };
    const projected = new LegacyDeviceStatusQuery("?find[__proto__.value]=8").projectCandidate(ownProto);
    expect(JSON.parse(projected.body)).toEqual(JSON.parse('{"__proto__":{"value":"08"}}'));
  });

  it("does not admit a failed load or close and preserves the original storage error", () => {
    const cache = new LegacyDeviceStatusCandidateCache();
    const original = new Error("original storage failure"), close = new Error("close failure");
    const source = () => ({ [Symbol.iterator]: () => ({
      next(): IteratorResult<ReturnType<typeof row>> { throw original; },
      return(): IteratorResult<ReturnType<typeof row>> { throw close; },
    }) });
    expect(() => [...cache.readProjected(["a"], 5000, source)]).toThrow(original);
    expect(cache.ready).toBe(false);
    const tail = () => ({ [Symbol.iterator]: () => ({
      next: () => ({ done: false as const, value: row("only", 1) }),
      return(): IteratorResult<ReturnType<typeof row>> { throw close; },
    }) });
    const iterator = cache.readProjected(["a"], 1, tail);
    iterator.next();
    expect(() => iterator.return!()).toThrow(close);
    expect(cache.ready).toBe(false);
  });
});
