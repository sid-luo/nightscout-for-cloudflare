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
});
