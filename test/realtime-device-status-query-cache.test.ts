import { describe, expect, it, vi } from "vitest";
import { DeviceStatusQueryCache, type CachedDeviceStatusRow } from "../src/realtime/device-status-query-cache";

const row = (id: string, time: number, updated = time): CachedDeviceStatusRow =>
  ({ id, body: "{}", sort_time: time, updated_at: updated });

describe("device status cache transaction forks", () => {
  it("merges into a fork without changing committed rows and reloads ambiguous ties", () => {
    const committed = new DeviceStatusQueryCache<CachedDeviceStatusRow>();
    const load = vi.fn(() => [row("a", 20), row("b", 10)]);
    [...committed.read(0, false, load)];
    const fork = committed.fork();
    fork.upsert(row("c", 30));
    expect([...fork.read(0, false, load)].map(r => r.id)).toEqual(["c", "a", "b"]);
    expect([...committed.read(0, false, load)].map(r => r.id)).toEqual(["a", "b"]);
    fork.upsert(row("d", 30));
    expect(fork.ready).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reloads a partial tail and does not retain oversized or framed results", () => {
    const cache = new DeviceStatusQueryCache<CachedDeviceStatusRow>();
    const load = vi.fn(() => [row("a", 20), row("b", 10)]);
    for (const value of cache.read(0, false, load)) { expect(value.id).toBe("a"); break; }
    expect(cache.ready).toBe(true);
    const fork = cache.fork();
    fork.upsert(row("older", 5));
    expect([...fork.read(0, false, () => [row("a", 20), row("b", 10), row("older", 5)])].map(r => r.id)).toEqual(["a", "b", "older"]);
    cache.clear();
    [...cache.read(0, true, load)];
    expect(cache.ready).toBe(false);
    [...cache.read(0, false, () => [{ ...row("big", 20), body: "x".repeat(3_000_000) }])];
    expect(cache.ready).toBe(false);
  });
});
