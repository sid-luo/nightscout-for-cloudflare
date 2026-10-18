import { describe, expect, it, vi } from "vitest";
import { LegacyDeviceStatusCandidateCache } from "../src/legacy-device-status-candidate-cache";
import { packSqlRow } from "../src/realtime/raw-row-codec";
import { LegacyDeviceStatusQuery } from "../src/legacy-device-status-query";

const row = (id: string, sort_time: number, updated_at = sort_time, body = "{}") => ({ id, sort_time, updated_at, body });

describe("legacy device status raw candidate cache", () => {
  it("shares prefixes, expands only when necessary, and keeps committed forks immutable", () => {
    const cache = new LegacyDeviceStatusCandidateCache();
    const load = vi.fn(() => [row("new", 3), row("middle", 2), row("old", 1)]);
    expect(cache.peek(5000)).toBeUndefined();
    expect(cache.read(2, () => load().slice(0, 2))).toHaveLength(2);
    expect(cache.peek(5000)).toBeUndefined();
    expect(cache.peek(1)).toEqual([row("new", 3)]);
    expect(cache.read(1, load)).toEqual([row("new", 3)]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.read(5000, load)).toHaveLength(3);
    expect(cache.peek(5000)).toHaveLength(3);
    expect(load).toHaveBeenCalledTimes(2);
    const fork = cache.fork();
    fork.upsert(row("newer", 4));
    expect(fork.read(5000, load).map(item => item.id)).toEqual(["newer", "new", "middle", "old"]);
    expect(cache.read(5000, load).map(item => item.id)).toEqual(["new", "middle", "old"]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("decodes only consumed warm rows for unsorted queries while valid sorts traverse the full prefix", () => {
    const cache = new LegacyDeviceStatusCandidateCache();
    const source = Array.from({ length: 100 }, (_, n) => row(`canonical-${n}`, 100 - n, 100 - n,
      JSON.stringify({ a: { value: n % 2 }, openaps: { predBGs: Array(200).fill(110) } })));
    cache.read(5000, () => source);
    const decoded: string[] = [];
    type ObservedPacked = { row: { id: string }; compressedBody?: Uint8Array };
    const retained = (cache as unknown as { entries: Map<string, { rows: ObservedPacked[] }> }).entries.get("raw")!.rows;
    // Observe the private decode boundary without mocking the codec: only
    // unpackSqlRow reads a retained compressed body during a warm cache hit.
    for (const packed of retained) {
      const data = packed.compressedBody;
      expect(data).toBeDefined();
      Object.defineProperty(packed, "compressedBody", { configurable: true,
        get: () => { decoded.push(packed.row.id); return data; } });
    }
    const lazy = cache.peekRows(5000)!;
    expect(decoded).toEqual([]);
    const query = new LegacyDeviceStatusQuery("?find[a.value]=1&count=5");
    expect(query.selectCandidateRows(lazy)).toEqual(source.filter((_, n) => n % 2 === 1).slice(0, 5));
    expect([...new Set(decoded)]).toEqual(source.slice(0, 10).map(item => item.id));
    expect(lazy.next().done).toBe(true);
    decoded.length = 0;
    const sorted = new LegacyDeviceStatusQuery("?sort[a.value]=-1&count=5");
    expect(sorted.selectCandidateRows(cache.peekRows(5000)!)).toEqual(source.filter((_, n) => n % 2 === 1).slice(0, 5));
    expect(new Set(decoded).size).toBe(100);
  });

  it("keeps lazy raw/projected snapshots and decoded caller rows isolated from forks and clearing", () => {
    const cache = new LegacyDeviceStatusCandidateCache();
    const source = [row("new", 3, 3, '{"a":{"value":3},"unused":true}'),
      row("middle", 2, 2, '{"a":{"value":2},"unused":true}'), row("old", 1, 1, '{"a":{"value":1},"unused":true}')];
    cache.read(5000, () => source);
    [...cache.readProjected(["a.value"], 5000, () => source)];
    const raw = cache.peekRows(5000)!;
    const projected = cache.peekProjectedRows(["a.value"], 5000)!;
    const fork = cache.fork();
    fork.upsert(row("new", 4, 4, '{"a":{"value":4}}'));
    cache.clear();
    const oldRows = [...raw];
    expect(oldRows).toEqual(source);
    oldRows[0]!.body = "caller mutation";
    expect([...projected].map(item => JSON.parse(item.body))).toEqual([{ a: { value: 3 } }, { a: { value: 2 } }, { a: { value: 1 } }]);
    expect(JSON.parse(fork.peekRows(5000)!.next().value!.body)).toEqual({ a: { value: 4 } });
    expect(JSON.parse(fork.peekProjectedRows(["a.value"], 5000)!.next().value!.body)).toEqual({ a: { value: 4 } });
    expect(cache.peekRows(5000)).toBeUndefined();
    expect(cache.peekProjectedRows(["a.value"], 5000)).toBeUndefined();
  });

  it("uses identical prefix admission and LRU touching for lazy and array peek APIs", () => {
    const cache = new LegacyDeviceStatusCandidateCache(3500);
    const source = [row("r3", 3, 3, '{"a":1,"b":2}'), row("r2", 2, 2, '{"a":1,"b":2}'), row("r1", 1, 1, '{"a":1,"b":2}')];
    cache.read(1, () => source.slice(0, 1));
    expect(cache.peekRows(5000)).toBeUndefined();
    [...cache.readProjected(["a"], 3, () => source)];
    expect(cache.peekProjectedRows(["a"], 5000)).toBeUndefined();
    const raw = cache.peekRows(1)!; // Touch raw immediately, before consumption.
    [...cache.readProjected(["b"], 3, () => source)];
    expect(cache.peekProjectedRows(["a"], 3)).toBeUndefined();
    expect([...raw]).toEqual(source.slice(0, 1));
    const projected = cache.peekProjectedRows(["b"], 3)!;
    const first = projected.next().value!;
    first.body = "caller mutation";
    projected.return?.();
    expect(projected.next().done).toBe(true);
    expect(JSON.parse(cache.peekProjected(["b"], 3)![0]!.body)).toEqual({ b: 2 });
    expect(cache.retainedBytes).toBeLessThanOrEqual(3500);
  });

  it("ignores old inserts beyond a partial prefix and reloads when an existing row leaves it", () => {
    const cache = new LegacyDeviceStatusCandidateCache();
    const initial = [row("new", 3), row("boundary", 2)];
    const load = vi.fn(() => initial);
    cache.read(2, load);
    cache.upsert(row("history", 1));
    expect(cache.read(2, load)).toEqual(initial);
    cache.upsert(row("latest", 4));
    expect(cache.read(2, load).map(item => item.id)).toEqual(["latest", "new"]);
    expect(load).toHaveBeenCalledTimes(1);
    cache.upsert(row("new", 0));
    expect(cache.ready).toBe(false);
    expect(cache.read(2, () => [row("latest", 4), row("boundary", 2)])).toEqual([row("latest", 4), row("boundary", 2)]);
  });

  it("retains loaded SQL ties exactly and reloads ambiguous mutation ties", () => {
    const cache = new LegacyDeviceStatusCandidateCache();
    const ties = [row("z", 3), row("a", 3), row("boundary", 2)];
    cache.read(3, () => ties);
    expect(cache.read(3, () => [])).toEqual(ties);
    cache.upsert(row("another", 3));
    expect(cache.ready).toBe(false);
  });

  it("retains proven storage-order ties across same-clock inserts, replacements and immutable forks", () => {
    const native = (id: string, order: number, body = "{}") => ({ ...row(id, 3, 3, body), storage_order: order });
    const initial = [native("z", 2), native("a", 7), { ...row("older", 2), storage_order: 1 }];
    const cache = new LegacyDeviceStatusCandidateCache();
    cache.read(5000, () => initial);
    const fork = cache.fork();
    fork.upsert(native("middle", 4));
    expect(fork.peek(5000)!.map(item => item.id)).toEqual(["z", "middle", "a", "older"]);
    fork.upsert(native("a", 7, '{"a":"updated"}'));
    expect(fork.peek(5000)!.map(item => item.id)).toEqual(["z", "middle", "a", "older"]);
    expect(fork.peek(5000)![2]!.body).toBe('{"a":"updated"}');
    fork.upsert(native("negative-rowid", -2));
    expect(fork.peek(5000)![0]!.id).toBe("negative-rowid");
    expect(cache.peek(5000)).toEqual(initial);
  });

  it("uses the proven third key at the partial boundary without guessing the unknown suffix", () => {
    const native = (id: string, order: number, body = "{}") => ({ ...row(id, 3, 3, body), storage_order: order });
    const cache = new LegacyDeviceStatusCandidateCache();
    cache.read(2, () => [native("z", 2), native("a", 7)]);
    cache.upsert(native("suffix", 8));
    expect(cache.peek(2)!.map(item => item.id)).toEqual(["z", "a"]);
    cache.upsert(native("a", 7, '{"changed":true}'));
    expect(cache.peek(2)![1]!.body).toBe('{"changed":true}');
    cache.upsert(native("middle", 4));
    expect(cache.peek(2)!.map(item => item.id)).toEqual(["z", "middle"]);
    cache.upsert(native("front", 1));
    expect(cache.peek(2)!.map(item => item.id)).toEqual(["front", "z"]);
    cache.upsert(native("z", 10));
    expect(cache.peek(2)).toBeUndefined();
  });

  it("keeps missing, unsafe or contradictory storage-order metadata on the original conservative path", () => {
    const native = (id: string, storage_order: number | undefined) => ({ ...row(id, 3),
      ...(storage_order === undefined ? {} : { storage_order }) });
    for (const invalid of [undefined, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const cache = new LegacyDeviceStatusCandidateCache();
      cache.read(2, () => [native("z", 1), native("a", 2)]);
      cache.upsert(native("other", invalid));
      expect(cache.ready, String(invalid)).toBe(false);
      const missingSource = new LegacyDeviceStatusCandidateCache();
      missingSource.read(2, () => [native("z", invalid), native("a", 2)]);
      missingSource.upsert(native("other", 3));
      // The new row lies after the known boundary and cannot enter the prefix.
      // An insertion within the prefix must still encounter the invalid tie.
      missingSource.upsert(native("earlier", 0));
      expect(missingSource.ready, String(invalid)).toBe(false);
    }
    const duplicate = new LegacyDeviceStatusCandidateCache();
    duplicate.read(2, () => [native("z", 1), native("a", 2)]);
    duplicate.upsert(native("different-id-same-rowid", 1));
    expect(duplicate.ready).toBe(false);
  });

  it("preserves the original 5000 tied-row window with exact source metadata", () => {
    const cache = new LegacyDeviceStatusCandidateCache();
    const source = Array.from({ length: 5000 }, (_, n) => ({ ...row(`canonical-${6000 - n}`, 3), storage_order: n + 1 }));
    cache.read(5000, () => source);
    cache.upsert({ ...row("outside-window", 3), storage_order: 5106 });
    expect(cache.peek(5000)).toEqual(source);
    cache.upsert({ ...source[4999]!, body: '{"changed":true}' });
    expect(cache.peek(5000)![4999]!.body).toBe('{"changed":true}');
    cache.upsert({ ...row("explicit-earlier-rowid", 3), storage_order: 0 });
    expect(cache.peek(5000)!.map(item => item.id)).toEqual(["explicit-earlier-rowid", ...source.slice(0, 4999).map(item => item.id)]);
  });

  it("applies the same dotted representation on cache load and incremental upsert", () => {
    const paths = ["openaps.suggested.IOB", "checks.value"];
    const candidate = (id: string, at: number, iob: number) => row(id, at, at, JSON.stringify({
      openaps: { suggested: { IOB: iob, predBGs: { IOB: Array(2048).fill(100) } } },
      checks: [{ value: 1, unused: [1, 2] }, {}], unrelated: "complete response only",
    }));
    const cache = new LegacyDeviceStatusCandidateCache(4096);
    [...cache.readProjected(paths, 5000, () => [candidate("first", 1, 2)])];
    const fork = cache.fork();
    fork.upsert(candidate("first", 2, 7));
    expect(JSON.parse(fork.peekProjected(paths, 5000)![0]!.body))
      .toEqual({ checks: [{ value: 1 }, {}], openaps: { suggested: { IOB: 7 } } });
    expect(JSON.parse(cache.peekProjected(paths, 5000)![0]!.body))
      .toEqual({ checks: [{ value: 1 }, {}], openaps: { suggested: { IOB: 2 } } });
    expect(fork.retainedBytes).toBeLessThanOrEqual(4096);
  });

  it("falls back without caching oversized prefixes or single rows", () => {
    const cache = new LegacyDeviceStatusCandidateCache(1000);
    // Beyond the codec's bounded compression input, so this remains a genuine
    // oversized raw row rather than a highly compressible success case.
    const large = vi.fn(() => [row("large", 1, 1, "x".repeat(65_537))]);
    expect(cache.read(5000, large)).toHaveLength(1);
    expect(cache.read(5000, large)).toHaveLength(1);
    expect(large).toHaveBeenCalledTimes(2);
    expect(cache.ready).toBe(false);
    const many = vi.fn(() => Array.from({ length: 8 }, (_, index) => row(String(index), 10 - index)));
    cache.read(5000, many);
    expect(cache.ready).toBe(false);
    cache.read(5000, () => [row("small", 1)]);
    expect(cache.ready).toBe(true);
    cache.upsert(row("large", 2, 2, "x".repeat(65_537)));
    expect(cache.ready).toBe(false);
  });

  it("losslessly retains compressible raw and whole-parent bodies inside the original byte cap", () => {
    const cap = 1024 * 1024;
    const body = '{"openaps":{"predBGs":[' + Array(2048).fill("110").join(",")
      + ']},"negative":-0,"overflow":1e309,"unicode":"\\ud800","unrelated":"exact response"}';
    const source = Array.from({ length: 100 }, (_, n) => ({ ...row(`row-${n}`, 100 - n, 100 - n, body), storage_order: n + 1 }));
    expect(source.reduce((sum, item) => sum + 2 * item.body.length, 0)).toBeGreaterThan(cap);
    const cache = new LegacyDeviceStatusCandidateCache(cap);
    cache.read(5000, () => source);
    expect(cache.peek(5000)).toEqual(source);
    expect(cache.retainedBytes).toBeLessThanOrEqual(cap);
    const warm = cache.peek(5000)!;
    warm[0]!.body = "caller mutation";
    expect(cache.peek(5000)![0]!.body).toBe(body);
    const fork = cache.fork();
    fork.upsert({ ...source[0]!, body: body.replace("exact response", "updated response") });
    expect(fork.peek(5000)![0]!.body).toContain("updated response");
    expect(cache.peek(5000)![0]!.body).toBe(body);
    const projected = new LegacyDeviceStatusCandidateCache(cap);
    const paths = ["openaps"];
    [...projected.readProjected(paths, 5000, () => source, true)];
    // Infinity/-0 force the projector to retain original bodies. The private
    // codec still stores those exact strings without changing any JSON values.
    expect(projected.peekProjected(paths, 5000)).toEqual(source);
    expect(projected.retainedBytes).toBeLessThanOrEqual(cap);
  });

  it("rejects compression bombs that fit packed bytes but exceed the bounded decoded prefix", () => {
    const cap = 8 * 1024 * 1024;
    const body = JSON.stringify({ a: "x".repeat(64_000) });
    const source = Array.from({ length: 200 }, (_, n) => row(`bomb-${n}`, 200 - n, 200 - n, body));
    expect(source.reduce((sum, item) => sum + packSqlRow(item)!.bytes, 0)).toBeLessThan(cap);
    expect(source.reduce((sum, item) => sum + item.body.length, 0)).toBeGreaterThan(cap);
    const raw = new LegacyDeviceStatusCandidateCache();
    expect(raw.read(5000, () => source)).toEqual(source);
    expect(raw.peek(5000)).toBeUndefined();
    expect(raw.retainedBytes).toBe(0);
    const projected = new LegacyDeviceStatusCandidateCache();
    expect([...projected.readProjected(["a"], 5000, () => source, true)]).toEqual(source);
    expect(projected.peekProjected(["a"], 5000)).toBeUndefined();
    expect(projected.retainedBytes).toBe(0);
    const safe = source.slice(0, 64);
    raw.read(5000, () => safe);
    expect(raw.peek(5000)).toEqual(safe);
    expect(raw.retainedBytes).toBeGreaterThanOrEqual(safe.reduce((sum, item) => sum + item.body.length, 0));
    expect(raw.retainedBytes).toBeLessThanOrEqual(cap);
  });
});
