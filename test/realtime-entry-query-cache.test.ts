import { describe, expect, it, vi } from "vitest";
import { RealtimeEntryQueryCache } from "../src/realtime/entry-query-cache";

describe("realtime entry query reuse", () => {
  it("filters advancing windows, reloads backwards windows and explicit frames", () => {
    const cache = new RealtimeEntryQueryCache<{ sort_time: number }>();
    const load = vi.fn(() => [{ sort_time: 30 }, { sort_time: 20 }, { sort_time: 10 }]);
    expect([...cache.read("sgv", 10, false, load)]).toHaveLength(3);
    expect([...cache.read("sgv", 21, false, load)]).toEqual([{ sort_time: 30 }]);
    expect(load).toHaveBeenCalledTimes(1);
    [...cache.read("sgv", 9, false, load)];
    [...cache.read("sgv", 21, true, load)];
    expect(load).toHaveBeenCalledTimes(3);
    cache.clear();
    [...cache.read("sgv", 21, false, load)];
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("retains a complete raw EOF independently of an early snapshot budget stop", () => {
    const cache = new RealtimeEntryQueryCache<{ sort_time: number }>();
    const load = vi.fn(() => [{ sort_time: 30 }, { sort_time: 20 }]);
    for (const row of cache.read("sgv", 0, false, load)) {
      expect(row.sort_time).toBe(30);
      break;
    }
    expect([...cache.read("sgv", 0, false, load)]).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not retain oversized rows or alter results", () => {
    const cache = new RealtimeEntryQueryCache<{ sort_time: number; body: string }>();
    const rows = [{ sort_time: 30, body: "x".repeat(300_000) }];
    const load = vi.fn(() => rows);
    expect([...cache.read("sgv", 0, false, load)]).toEqual(rows);
    expect([...cache.read("sgv", 0, false, load)]).toEqual(rows);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("peeks a smaller exact-query prefix without narrowing or filling the cache", () => {
    const cache = new RealtimeEntryQueryCache<{ sort_time: number }>();
    const rows = Array.from({ length: 100 }, (_, index) => ({ sort_time: 100 - index }));
    const load = vi.fn(() => rows);
    expect(cache.peek("sgv LIMIT 1000", 0, 64)).toBeUndefined();
    expect(cache.ready).toBe(false);
    [...cache.read("sgv LIMIT 1000", 0, false, load, 1000)];
    expect(cache.peek("sgv LIMIT 1000", 0, 64)).toEqual(rows.slice(0, 64));
    expect(cache.peek("sgv LIMIT 64", 0, 64)).toBeUndefined();
    expect([...cache.read("sgv LIMIT 1000", 0, false, load, 1000)]).toEqual(rows);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("rejects insufficient source capacity, backwards windows and invalid bounds", () => {
    const cache = new RealtimeEntryQueryCache<{ sort_time: number }>();
    // Even an exhausted short result must not promote a LIMIT 64 cache to 1000.
    [...cache.read("sgv LIMIT 64", 10, false, () => [{ sort_time: 30 }], 64)];
    expect(cache.peek("sgv LIMIT 64", 10, 64)).toEqual([{ sort_time: 30 }]);
    for (const count of [0, -1, 1.5, 65, 1000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(cache.peek("sgv LIMIT 64", 10, count)).toBeUndefined();
    }
    for (const lower of [9, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(cache.peek("sgv LIMIT 64", lower, 1)).toBeUndefined();
    }
  });

  it("returns complete smaller or empty prefixes as the window advances past a SQL limit", () => {
    const cache = new RealtimeEntryQueryCache<{ sort_time: number }>();
    const load = vi.fn(() => [{ sort_time: 30 }, { sort_time: 20 }, { sort_time: 10 }]);
    [...cache.read("sgv LIMIT 3", 0, false, load, 3)];
    expect(cache.peek("sgv LIMIT 3", 20, 3)).toEqual([{ sort_time: 30 }, { sort_time: 20 }]);
    expect(cache.peek("sgv LIMIT 3", 21, 3)).toEqual([{ sort_time: 30 }]);
    expect(cache.peek("sgv LIMIT 3", 31, 3)).toEqual([]);
    // Peek must not move the cache's original lower bound or discard its rows.
    expect(cache.peek("sgv LIMIT 3", 0, 3)).toEqual(load.mock.results[0]!.value);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("isolates returned prefixes, row fields and nested values from the cache and its forks", () => {
    const cache = new RealtimeEntryQueryCache<{ id: string; sort_time: number; payload: { value: number } }>();
    const rows = [{ id: "a", sort_time: 30, payload: { value: 1 } }];
    [...cache.read("sgv", 0, false, () => rows, 1000)];
    const fork = cache.fork();
    const prefix = cache.peek("sgv", 0, 64)!;
    expect(prefix).toHaveLength(1);
    prefix[0]!.sort_time = -1;
    prefix[0]!.payload.value = 9;
    prefix.push({ id: "b", sort_time: 40, payload: { value: 2 } });
    expect(cache.peek("sgv", 0, 64)).toEqual(rows);
    expect(fork.peek("sgv", 0, 64)).toEqual(rows);
    expect(rows).toEqual([{ id: "a", sort_time: 30, payload: { value: 1 } }]);
  });

  it("peeks fully preloaded raw rows after output cutoff but not oversized or explicit-frame cursors", () => {
    const cache = new RealtimeEntryQueryCache<{ sort_time: number; body?: string }>();
    for (const _row of cache.read("partial", 0, false,
      () => [{ sort_time: 30 }, { sort_time: 20 }], 1000)) break;
    [...cache.read("oversized", 0, false,
      () => [{ sort_time: 30, body: "x".repeat(300_000) }], 1000)];
    [...cache.read("frame", 0, true, () => [{ sort_time: 30 }], 1000)];
    expect(cache.peek("partial", 0, 64)).toEqual([{ sort_time: 30 }, { sort_time: 20 }]);
    for (const key of ["oversized", "frame"]) {
      expect(cache.peek(key, 0, 64)).toBeUndefined();
    }
    expect(cache.ready).toBe(true);
  });

  it("defers prefetched tail failures until a consumer actually requests the failing next", () => {
    for (const undefinedError of [false, true]) {
      const cache = new RealtimeEntryQueryCache<{ id: string; sort_time: number }>();
      const load = vi.fn(function* () {
        yield { id: "a", sort_time: 30 }; yield { id: "b", sort_time: 20 };
        throw undefinedError ? undefined : new Error("entry cursor failed");
      });
      for (const _row of cache.read("sgv", 0, false, load, 1000)) break;
      expect(cache.ready).toBe(false);
      const pending = cache.read("sgv", 0, false, load, 1000);
      expect(pending.next().value).toEqual({ id: "a", sort_time: 30 });
      expect(pending.next().value).toEqual({ id: "b", sort_time: 20 });
      let caught = false;
      try { pending.next(); } catch (error) {
        caught = true;
        if (undefinedError) expect(error).toBeUndefined();
        else expect(String(error)).toContain("entry cursor failed");
      }
      expect(caught).toBe(true);
      expect(cache.ready).toBe(false);
      expect(load).toHaveBeenCalledTimes(2);
    }
  });

  it("replays the buffered prefix and unbuffered tail exactly once after clear, upsert or oversize", () => {
    for (const mutation of ["clear", "upsert", "size"] as const) {
      const cache = new RealtimeEntryQueryCache<{ id: string; sort_time: number; body: string }>();
      const result = [{ id: "a", sort_time: 30, body: "{}" },
        { id: "b", sort_time: 20, body: mutation === "size" ? "x".repeat(300_000) : "{}" },
        { id: "c", sort_time: 10, body: "{}" }];
      let closed = 0;
      const load = vi.fn(function* () {
        try {
          yield result[0]!;
          if (mutation === "clear") cache.clear();
          if (mutation === "upsert") cache.upsert("z", () => undefined);
          yield result[1]!; yield result[2]!;
        } finally { closed++; }
      });
      expect([...cache.read("sgv", 0, false, load, 1000)]).toEqual(result);
      expect(cache.ready).toBe(false);
      for (const _row of cache.read("sgv", 0, false, load, 1000)) break;
      expect(closed).toBe(2);
    }
  });

  it("keeps prefetched rows and fork values isolated across early return, writes and rollback", () => {
    const cache = new RealtimeEntryQueryCache<{ id: string; sort_time: number; payload: { score: number } }>();
    const source = [{ id: "a", sort_time: 30, payload: { score: 1 } }, { id: "b", sort_time: 20, payload: { score: 2 } }];
    const pending = cache.read("sgv", 0, false, () => source, 1000);
    pending.next().value!.payload.score = 90;
    pending.return!();
    const fork = cache.fork();
    const changed = { id: "a", sort_time: 40, payload: { score: 3 } };
    fork.upsert("a", () => changed);
    changed.payload.score = 99;
    expect(cache.peek("sgv", 0, 64)).toEqual(source);
    expect(fork.peek("sgv", 0, 64)?.[0]?.payload.score).toBe(3);
    source[0]!.payload.score = 88;
    const hit = [...cache.read("sgv", 0, false, () => source, 1000)];
    expect(hit[0]!.payload.score).toBe(1);
    hit[0]!.payload.score = 77;
    expect(cache.peek("sgv", 0, 64)?.[0]?.payload.score).toBe(1);
    const reading = cache.read("sgv", 0, false, () => source, 1000);
    reading.next(); cache.clear(); [...reading];
    expect(cache.ready).toBe(false);
  });

  it("bounds an infinite cursor and closes it once, with original errors taking precedence", () => {
    const cache = new RealtimeEntryQueryCache<{ sort_time: number; body: string }>();
    let pulled = 0, closed = 0;
    const infinite = function* () {
      try { while (true) { pulled++; yield { sort_time: 30, body: "x".repeat(100_000) }; } }
      finally { closed++; }
    };
    const pending = cache.read("sgv", 0, false, infinite, 1000);
    pending.next(); pending.return!();
    expect(pulled).toBeLessThanOrEqual(4);
    expect(closed).toBe(1);
    expect(cache.ready).toBe(false);
    let returnGets = 0;
    const broken = () => ({ [Symbol.iterator]: () => {
      let index = 0;
      return { next(): IteratorResult<{ sort_time: number; body: string }> {
        if (index++ === 0) return { done: false, value: { sort_time: 30, body: "x".repeat(300_000) } };
        throw new Error("original entry tail");
      }, get return(): never { returnGets++; throw new Error("entry close getter"); } };
    } });
    const failed = cache.read("sgv", 0, false, broken, 1000);
    failed.next();
    expect(() => failed.next()).toThrow("original entry tail");
    const stopped = cache.read("sgv", 0, false, broken, 1000);
    stopped.next();
    expect(() => stopped.return!()).toThrow("entry close getter");
    expect(returnGets).toBe(2);
  });

  it("forks without modifying committed rows and merges by time then ASCII id", () => {
    const cache = new RealtimeEntryQueryCache<{ id: string; sort_time: number }>();
    const load = vi.fn(() => [{ id: "b", sort_time: 30 }, { id: "a", sort_time: 20 }]);
    [...cache.read("sgv", 10, false, load, 1000)];
    const candidate = cache.fork();
    candidate.upsert("a", () => ({ id: "a", sort_time: 30 }));
    candidate.upsert("history", () => ({ id: "history", sort_time: 9 }));
    expect([...candidate.read("sgv", 10, false, load)]).toEqual([
      { id: "a", sort_time: 30 }, { id: "b", sort_time: 30 },
    ]);
    expect([...cache.read("sgv", 10, false, load)]).toEqual([
      { id: "b", sort_time: 30 }, { id: "a", sort_time: 20 },
    ]);
    candidate.upsert("b", () => undefined);
    expect([...candidate.read("sgv", 10, false, load)]).toEqual([{ id: "a", sort_time: 30 }]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("retains the original SQL limit for inserts and reloads updates that can expose its unknown suffix", () => {
    const cache = new RealtimeEntryQueryCache<{ id: string; sort_time: number }>();
    const load = vi.fn(() => [{ id: "a", sort_time: 30 }, { id: "b", sort_time: 20 }]);
    [...cache.read("sgv", 10, false, load, 2)];
    cache.upsert("new", () => ({ id: "new", sort_time: 40 }));
    expect([...cache.read("sgv", 10, false, load, 2)]).toEqual([
      { id: "new", sort_time: 40 }, { id: "a", sort_time: 30 },
    ]);
    cache.upsert("old", () => ({ id: "old", sort_time: 15 }));
    expect([...cache.read("sgv", 10, false, load, 2)]).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(1);
    cache.upsert("a", () => undefined);
    [...cache.read("sgv", 10, false, load, 2)];
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retains full top-N updates only inside the original known boundary, against a complete sorting oracle", () => {
    interface Candidate { id: string; sort_time: number; kind: string; value: number }
    const cases = [
      { name: "same time and value", id: "a", patch: {}, reload: false },
      { name: "same time corrected value", id: "b", patch: { value: 9 }, reload: false },
      { name: "move toward the front", id: "c", patch: { sort_time: 110 }, reload: false },
      { name: "move back within the known boundary", id: "a", patch: { sort_time: 85 }, reload: false },
      { name: "tie remains before old last by id", id: "a", patch: { sort_time: 80 }, reload: false },
      { name: "tie falls after old last by id", id: "z", patch: { sort_time: 80 }, reload: true },
      { name: "old last moves back relative to other selected rows but forward from its original boundary", id: "d", patch: { sort_time: 85 }, reload: false },
      { name: "old last stays on its tie boundary", id: "d", patch: { value: 9 }, reload: false },
      { name: "cross the old last", id: "a", patch: { sort_time: 79 }, reload: true },
      { name: "old last crosses its own old boundary", id: "d", patch: { sort_time: 79 }, reload: true },
      { name: "leave the SQL classification", id: "b", patch: { kind: "mbg" }, reload: true },
      { name: "leave the original lower bound", id: "c", patch: { sort_time: -1 }, reload: true },
    ];
    for (const scenario of cases) {
      const cache = new RealtimeEntryQueryCache<Candidate>();
      const candidates: Candidate[] = [
        { id: "a", sort_time: 100, kind: "sgv", value: 1 },
        { id: "b", sort_time: 100, kind: "sgv", value: 2 },
        { id: "c", sort_time: 90, kind: "sgv", value: 3 },
        { id: "d", sort_time: 80, kind: "sgv", value: 4 },
        // This unknown row has the last selected time but follows its ASCII
        // id. An unsafe replacement must expose it through a fresh load.
        { id: "e", sort_time: 80, kind: "sgv", value: 5 },
        { id: "f", sort_time: 70, kind: "sgv", value: 6 },
      ];
      if (scenario.id === "z") candidates[0]!.id = "z";
      const oracle = (lower = 0) => candidates.filter(row => row.kind === "sgv" && row.sort_time >= lower)
        .sort((left, right) => right.sort_time - left.sort_time || left.id.localeCompare(right.id)).slice(0, 4);
      const load = vi.fn(() => oracle());
      expect([...cache.read("sgv-limit-4", 0, false, load, 4)]).toEqual(oracle());
      const selected = candidates.find(row => row.id === scenario.id)!;
      Object.assign(selected, scenario.patch);
      cache.upsert(selected.id, (_key, lower) =>
        selected.kind === "sgv" && selected.sort_time >= lower ? selected : undefined);
      expect([...cache.read("sgv-limit-4", 0, false, load, 4)], scenario.name).toEqual(oracle());
      expect(load, scenario.name).toHaveBeenCalledTimes(scenario.reload ? 2 : 1);
    }
  });

  it("falls back after oversized changed rows or ids outside the canonical collation", () => {
    const cache = new RealtimeEntryQueryCache<{ id: string; sort_time: number; body?: string }>();
    const load = vi.fn(() => [{ id: "a", sort_time: 30 }]);
    [...cache.read("sgv", 10, false, load)];
    cache.upsert("new", () => ({ id: "new", sort_time: 40, body: "x".repeat(300_000) }));
    [...cache.read("sgv", 10, false, load)];
    cache.upsert("😀", () => ({ id: "😀", sort_time: 40 }));
    [...cache.read("sgv", 10, false, load)];
    expect(load).toHaveBeenCalledTimes(3);
  });
});
