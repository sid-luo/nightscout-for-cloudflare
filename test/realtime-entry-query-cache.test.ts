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

  it("never reuses an incomplete cursor after the snapshot budget stops iteration", () => {
    const cache = new RealtimeEntryQueryCache<{ sort_time: number }>();
    const load = vi.fn(() => [{ sort_time: 30 }, { sort_time: 20 }]);
    for (const row of cache.read("sgv", 0, false, load)) {
      expect(row.sort_time).toBe(30);
      break;
    }
    expect([...cache.read("sgv", 0, false, load)]).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(2);
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

  it("does not peek incomplete, oversized or explicit-frame cursors", () => {
    const cache = new RealtimeEntryQueryCache<{ sort_time: number; body?: string }>();
    for (const _row of cache.read("partial", 0, false,
      () => [{ sort_time: 30 }, { sort_time: 20 }], 1000)) break;
    [...cache.read("oversized", 0, false,
      () => [{ sort_time: 30, body: "x".repeat(300_000) }], 1000)];
    [...cache.read("frame", 0, true, () => [{ sort_time: 30 }], 1000)];
    for (const key of ["partial", "oversized", "frame"]) {
      expect(cache.peek(key, 0, 64)).toBeUndefined();
    }
    expect(cache.ready).toBe(false);
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
