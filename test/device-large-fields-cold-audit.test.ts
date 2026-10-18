import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore, JsonDocument } from "../src/entry-store";
import { filterDocuments } from "../src/documents";
import { LegacyDeviceStatusQuery } from "../src/legacy-device-status-query";
import { packSqlRow } from "../src/realtime/raw-row-codec";
import worker from "../src/index";
import { syntheticDeviceStatus } from "./fixtures/synthetic-device-status";

const RECORDS = 5105;
const CANDIDATES = 5000;
const CAP = 8 * 1024 * 1024;
const MINUTE = 60_000;
const id = (n: number) => n.toString(16).padStart(24, "0");
const queryUrl = (search: string) => new URL(`https://synthetic.invalid/api/v1/devicestatus.json${search}`);
interface Internal {
  legacyDeviceStatusCandidates: {
    clear(): void;
    peekProjected(fields: readonly string[], limit: number): readonly { body: string }[] | undefined;
    readonly retainedBytes: number;
    readonly entryCount: number;
  };
  legacyDeviceStatusQueries: { clear(): void };
  realtimeDeviceStatusQueries: { clear(): void };
  realtime: { now(): number };
}

// BEGIN PATH PROJECTION PROTOTYPE
// Independent design oracle; production must produce the same thin value tree.
interface PathTrie { terminal: boolean; children: Map<string, PathTrie> }
function pathTrie(paths: readonly string[]): PathTrie {
  const root: PathTrie = { terminal: false, children: new Map() };
  for (const path of paths) {
    let node = root;
    for (const segment of path.split(".")) {
      if (!node.children.has(segment)) node.children.set(segment, { terminal: false, children: new Map() });
      node = node.children.get(segment)!;
    }
    node.terminal = true;
  }
  return root;
}
function thinValue(value: unknown, trie: PathTrie): unknown {
  if (trie.terminal) return value;
  // properties() traverses array members without consuming a path segment.
  // Preserve each member and its order, including scalar/null blockers.
  if (Array.isArray(value)) return value.map(item => thinValue(item, trie));
  if (typeof value !== "object" || value === null) return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries([...trie.children].filter(([key]) => Object.hasOwn(object, key))
    .map(([key, child]) => [key, thinValue(object[key], child)]));
}
function pathsFor(search: string): readonly string[] {
  const find = /^find\[([A-Za-z0-9_.-]+)\](?:\[(\$gt|\$gte|\$lt|\$lte|\$ne|\$exists|\$in)\])?$/;
  const sort = /^sort\[([A-Za-z0-9_.-]+)\]$/;
  const paths = new Set<string>();
  let lastSort: string | undefined;
  for (const [name, value] of queryUrl(search).searchParams) {
    const match = find.exec(name);
    if (match !== null) paths.add(match[1]!);
    const selected = sort.exec(name);
    if (selected !== null && (value === "1" || value === "-1")) lastSort = selected[1]!;
  }
  if (lastSort !== undefined) paths.add(lastSort);
  return [...paths].sort();
}
function thinDocument(document: unknown, paths: readonly string[]): unknown {
  // Primitive and array-root historical bodies keep their original behavior.
  if (typeof document !== "object" || document === null || Array.isArray(document)) return document;
  return thinValue(document, pathTrie(paths));
}
// END PATH PROJECTION PROTOTYPE

function status(n: number, at: number): JsonDocument {
  const shaped: JsonDocument = syntheticDeviceStatus(`synthetic-large-${n}`, at);
  delete shaped.identifier;
  return { ...shaped, _id: id(n), date: at, created_at: new Date(at).toISOString(),
    openaps: { suggested: { timestamp: new Date(at).toISOString(), IOB: n % 5, COB: n % 3,
      predBGs: Object.fromEntries(["IOB", "COB", "UAM", "ZT"].map(key => [
        key, Array.from({ length: 48 }, (_, point) => 100 + point % 30),
      ])) } },
    ...(n === 0 ? { onlyOutside: "yes" } : {}),
  };
}
function clear(internal: Internal): void {
  internal.legacyDeviceStatusCandidates.clear();
  internal.legacyDeviceStatusQueries.clear();
  internal.realtimeDeviceStatusQueries.clear();
}
function seed(storage: DurableObjectStorage, internal: Internal, now: number): void {
  storage.transactionSync(() => {
    for (let n = 0; n < RECORDS; n++) {
      const at = now - (RECORDS - n) * MINUTE;
      storage.sql.exec(`INSERT INTO documents
        (collection,id,body,sort_time,created_at,updated_at,identifier_present,srv_metadata_version,is_valid,revision)
        VALUES('devicestatus',?,?,?,?,?,0,1,1,0)`, id(n), JSON.stringify(status(n, at)), at, at, at);
    }
  });
  clear(internal);
}
function oracle(sql: SqlStorage, search: string): JsonDocument[] {
  return filterDocuments(sql.exec<{ body: string }>(`SELECT body FROM documents WHERE collection = ?
    ORDER BY sort_time DESC, updated_at DESC LIMIT 5000`, "devicestatus").toArray()
    .map(row => JSON.parse(row.body) as JsonDocument), queryUrl(search), 10);
}
function configuration(instance: EntryStore): Parameters<typeof worker.fetch>[1] {
  const forward = new Proxy(instance, { get(target, key) {
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => forward }, API_SECRET: "synthetic-large-fields-secret",
    AUTH_DEFAULT_ROLES: "readable", AUTH_FAIL_DELAY: "0" } as unknown as Parameters<typeof worker.fetch>[1];
}
async function measured(storage: DurableObjectStorage, instance: EntryStore, search: string) {
  const started = performance.now();
  const exec = storage.sql.exec.bind(storage.sql);
  const queries: { sql: string; bindings: SqlStorageValue[]; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(storage.sql, "exec").mockImplementation((sql, ...bindings) => {
    const cursor = exec(sql, ...bindings);
    queries.push({ sql, bindings, cursor });
    return cursor;
  });
  let documents: JsonDocument[];
  try {
    const response = await worker.fetch(new Request(queryUrl(search)), configuration(instance));
    expect(response.status, search).toBe(200);
    documents = await response.json<JsonDocument[]>();
  } finally { spy.mockRestore(); }
  const device = queries.filter(({ sql, bindings }) => sql.includes("FROM documents")
    && (bindings[0] === "devicestatus" || sql.includes("collection = 'devicestatus'")));
  return { documents, reads: queries.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
    elapsedMs: performance.now() - started,
    writes: queries.reduce((sum, item) => sum + item.cursor.rowsWritten, 0),
    deviceReads: device.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
    queries: device.map(({ sql, cursor }) => ({ sql: sql.replace(/\s+/g, " ").trim(), reads: cursor.rowsRead })) };
}

describe("large dotted device fields and cold prefix audit", () => {
  it("records repeated and evicted costs for large top-level roots with exact full-body HTTP results", async () => {
    const stub = env.ENTRY_STORE.getByName(`large-dotted-cold-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const internal = instance as unknown as Internal;
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const realtimeClock = vi.spyOn(internal.realtime, "now").mockImplementation(() => now);
      try {
        seed(state.storage, internal, now);
        const samples = [];
        for (const search of [
          "?find[openaps.suggested.IOB][$gte]=0&sort[created_at]=-1&count=5",
          "?find[openaps.suggested.predBGs.IOB][$exists]=true&sort[created_at]=-1&count=5",
          "?sort[openaps.suggested.IOB]=1&count=7",
          "?find[openaps.missing.child][$exists]=false&sort[created_at]=-1&count=5",
          "?find[openaps.suggested][$ne]=absent&sort[created_at]=-1&count=5",
          "?sort[openaps]=1&count=3",
        ]) {
          clear(internal);
          const query = new LegacyDeviceStatusQuery(search);
          const originalRows = state.storage.sql.exec<{ id: string; body: string }>(`SELECT id,body FROM documents
            WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT 5000`, "devicestatus").toArray();
          let beforeRootBytes = 0, projectedBytes = 0, packedBytes = 0;
          for (const row of originalRows) {
            const document = JSON.parse(row.body) as Record<string, unknown>;
            const roots = [...new Set(pathsFor(search).map(path => path.split(".")[0]!))];
            const beforeBody = JSON.stringify(Object.fromEntries(roots.filter(root => Object.hasOwn(document, root))
              .map(root => [root, document[root]])));
            beforeRootBytes += 128 + 2 * (row.id.length + beforeBody.length);
            const projected = query.projectCandidate(row);
            expect(JSON.parse(projected.body)).toEqual(thinDocument(document, pathsFor(search)));
            projectedBytes += 128 + 2 * (row.id.length + projected.body.length);
            const packed = packSqlRow({ ...projected, sort_time: now, updated_at: now });
            expect(packed).not.toBeNull();
            packedBytes += packed!.bytes;
          }
          expect(beforeRootBytes, search).toBeGreaterThan(CAP);
          const wholeSubtree = search.includes("find[openaps.suggested][$ne]") || search.includes("sort[openaps]");
          if (wholeSubtree) expect(projectedBytes, search).toBeGreaterThan(CAP);
          else expect(projectedBytes, search).toBeLessThan(CAP);
          expect(packedBytes, search).toBeLessThan(CAP - 4096);
          for (const phase of ["cold", "repeat", "explicitly-cleared"] as const) {
            if (phase === "explicitly-cleared") clear(internal);
            now += 1000;
            const measurement = await measured(state.storage, instance, search);
            expect(measurement.documents, `${search} ${phase}`).toEqual(oracle(state.storage.sql, search));
            for (const document of measurement.documents) {
              const value = document.openaps as { suggested: { predBGs: Record<string, unknown[]> } };
              for (const key of ["IOB", "COB", "UAM", "ZT"]) expect(value.suggested.predBGs[key]).toHaveLength(48);
            }
            // Full parent values are preserved, then losslessly compressed.
            // All prefixes warm only at the complete original candidate bound.
            if (phase === "repeat") {
              expect(measurement.deviceReads, `${search} ${phase}`).toBeLessThan(100);
              if (measurement.documents.length === 0) expect(measurement.deviceReads).toBe(0);
            } else expect(measurement.deviceReads, `${search} ${phase}`).toBeGreaterThan(0);
            expect(measurement.deviceReads).toBeLessThanOrEqual(10_500);
            expect(measurement.writes).toBe(0);
            const cached = internal.legacyDeviceStatusCandidates.peekProjected(query.projectionFields, CANDIDATES);
            expect(cached).toHaveLength(CANDIDATES);
            expect(internal.legacyDeviceStatusCandidates.retainedBytes).toBeLessThanOrEqual(CAP);
            samples.push({ search, phase, beforeRootBytes, projectedBytes, packedBytes, wholeSubtree,
              elapsedMs: measurement.elapsedMs,
              reads: measurement.reads, deviceReads: measurement.deviceReads, writes: measurement.writes,
              returned: measurement.documents.length, ids: measurement.documents.map(document => document._id),
              retainedBytes: internal.legacyDeviceStatusCandidates.retainedBytes,
              entries: internal.legacyDeviceStatusCandidates.entryCount, queries: measurement.queries });
          }
        }
        return { records: RECORDS, candidates: CANDIDATES, cap: CAP, samples };
      } finally { realtimeClock.mockRestore(); clock.mockRestore(); }
    });
    console.info(`LARGE_FIELDS_COLD_AFTER=${JSON.stringify(report)}`);
  }, 60_000);

  it("leaves recent unsorted predicates lazy rather than preloading a future reusable prefix", async () => {
    const stub = env.ENTRY_STORE.getByName(`large-dotted-lazy-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const internal = instance as unknown as Internal;
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const realtimeClock = vi.spyOn(internal.realtime, "now").mockImplementation(() => now);
      try {
        seed(state.storage, internal, now);
        const samples = [];
        const search = "?find[openaps.suggested.IOB][$gte]=0&count=5";
        for (let repeat = 0; repeat < 2; repeat++) {
          now += 1000;
          const measurement = await measured(state.storage, instance, search);
          expect(measurement.documents).toEqual(oracle(state.storage.sql, search));
          expect(measurement.deviceReads).toBeLessThan(100);
          expect(internal.legacyDeviceStatusCandidates.peekProjected(new LegacyDeviceStatusQuery(search).projectionFields, CANDIDATES))
            .toBeUndefined();
          samples.push({ repeat, deviceReads: measurement.deviceReads, reads: measurement.reads,
            returned: measurement.documents.length, queries: measurement.queries });
        }
        return { samples };
      } finally { realtimeClock.mockRestore(); clock.mockRestore(); }
    });
    console.info(`LARGE_FIELDS_LAZY_AFTER=${JSON.stringify(report)}`);
  }, 60_000);
});

describe("test-only dotted path projection oracle", () => {
  it("preserves missing ancestors, empty arrays, scalar blockers and every/some differences", () => {
    const documents = [{}, { a: {} }, { a: null }, { a: 1 }, { a: [] }, { a: [{}] },
      { a: [null, 1, {}, { b: 2 }, [{ b: 3 }]] }, { a: { b: null } }, { a: { b: [] } }];
    for (const search of ["?find[a.b][$exists]=false&count=100", "?find[a.b][$exists]=true&count=100",
      "?find[a.b][$ne]=2&count=100", "?find[a.b.c][$exists]=false&count=100", "?sort[a.b]=1&count=100"]) {
      const projected = documents.map(document => thinDocument(document, pathsFor(search)) as JsonDocument);
      const expected = filterDocuments(documents as JsonDocument[], queryUrl(search), 10).map(document => documents.indexOf(document));
      const actual = filterDocuments(projected, queryUrl(search), 10).map(document => projected.indexOf(document));
      expect(actual, search).toEqual(expected);
    }
    const missing = filterDocuments([{}, { a: {} }], queryUrl("?find[a.b][$exists]=false&count=2"), 10);
    expect(missing).toEqual([{ a: {} }]);
    // A flat leaf-only map that invents an a object changes [] to [undefined].
    expect(filterDocuments([{ a: {} }, { a: {} }], queryUrl("?find[a.b][$exists]=false&count=2"), 10)).toHaveLength(2);
  });

  it("preserves inherited constructors/prototypes, own __proto__ and array traversal", () => {
    const documents = [{}, { nested: {} }, { nested: [{}, { constructor: 3 }] },
      JSON.parse('{"__proto__":{"flag":"yes","huge":[1,2]},"nested":{"__proto__":{"flag":"yes"}}}'),
      { nested: { constructor: { prototype: { flag: "yes", unrelated: [1, 2] } } } }];
    for (const search of ["?find[constructor][$exists]=true&sort[constructor]=1&count=100",
      "?find[__proto__.constructor][$exists]=true&count=100", "?find[__proto__.flag]=yes&count=100",
      "?find[nested.constructor][$ne]=3&sort[nested.constructor]=1&count=100",
      "?find[nested.__proto__.flag]=yes&count=100", "?find[nested.constructor.prototype.flag]=yes&count=100",
      "?find[nested.0][$exists]=false&count=100", "?find[nested.length][$exists]=true&count=100"]) {
      const projected = documents.map(document => thinDocument(document, pathsFor(search)) as JsonDocument);
      const expected = filterDocuments(documents as JsonDocument[], queryUrl(search), 10).map(document => documents.indexOf(document));
      const actual = filterDocuments(projected, queryUrl(search), 10).map(document => projected.indexOf(document));
      expect(actual, search).toEqual(expected);
      for (const document of projected) expect(Object.getPrototypeOf(document)).toBe(Object.prototype);
    }
    const projected = thinDocument(documents[3], ["__proto__.flag"]) as object;
    expect(Object.hasOwn(projected, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
  });

  it("retains complete terminal objects and array leaves, key insertion order and overlapping parent paths", () => {
    const documents: JsonDocument[] = [{ a: { b: { z: 1, a: 2 }, predictions: [1, 2], ignored: [9] } },
      { a: { b: { a: 2, z: 1 }, predictions: [2, 1], ignored: [8] } },
      { a: [{ b: { z: 1, a: 2 }, predictions: [1, 2] }, { b: { z: 2 } }] }];
    for (const search of ["?find[a.b]={%22z%22:1,%22a%22:2}&count=100", "?sort[a.b]=1&count=100",
      "?find[a.predictions]=[1,2]&sort[a.b]=1&count=100", "?find[a.b][$ne]=absent&find[a][$ne]=absent&count=100"]) {
      const projected = documents.map(document => thinDocument(document, pathsFor(search)) as JsonDocument);
      const expected = filterDocuments(documents as JsonDocument[], queryUrl(search), 10).map(document => documents.indexOf(document));
      const actual = filterDocuments(projected, queryUrl(search), 10).map(document => projected.indexOf(document));
      expect(actual, search).toEqual(expected);
    }
    expect((thinDocument(documents[0], ["a.b"]) as { a: { b: object } }).a.b)
      .toBe((documents[0]!.a as { b: object }).b);
    expect(thinDocument(documents[0], ["a", "a.b"])).toEqual(documents[0]);
    // Keeping only the first array actual value is invalid for find's some/every.
    const full = [{ a: [{ b: 0 }, { b: 2 }] }];
    const firstOnly = [{ a: [{ b: 0 }] }];
    expect(filterDocuments(full, queryUrl("?find[a.b]=2"), 10)).toHaveLength(1);
    expect(filterDocuments(firstOnly, queryUrl("?find[a.b]=2"), 10)).toHaveLength(0);
    expect(filterDocuments(full, queryUrl("?find[a.b][$ne]=2"), 10)).toHaveLength(0);
    expect(filterDocuments(firstOnly, queryUrl("?find[a.b][$ne]=2"), 10)).toHaveLength(1);
  });

  it("does not change historical primitive/array roots or JSON-inexpressible original leaf values", () => {
    for (const document of [null, 1, "string", [1, { a: 2 }]]) expect(thinDocument(document, ["a"])).toBe(document);
    const original = JSON.parse('{"a":{"x":1e309,"negative":-0},"irrelevant":[1,2]}') as { a: { x: number; negative: number } };
    const projected = thinDocument(original, ["a.x", "a.negative"]) as typeof original;
    expect(projected.a.x).toBe(Infinity);
    expect(Object.is(projected.a.negative, -0)).toBe(true);
    // This prototype is only the graph transformation. A production JSON cache
    // must retain original rows for nonfinite/-0 rather than stringify these.
    expect(JSON.stringify(projected)).toBe('{"a":{"x":null,"negative":0}}');
    const query = new LegacyDeviceStatusQuery("?sort[a.x]=1");
    const row = { body: '{"a":{"x":1e309,"negative":-0},"irrelevant":[1,2]}' };
    expect(query.projectCandidate(row)).toBe(row);
  });
});
