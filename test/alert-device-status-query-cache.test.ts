import { describe, expect, it, vi } from "vitest";
import { AlertDeviceStatusQueryCache } from "../src/realtime/alert-device-status-query-cache";
import type { CachedDeviceStatusRow } from "../src/realtime/device-status-query-cache";

const row = (id: string, at: number, body: unknown = { uploader: { battery: 19 } }): CachedDeviceStatusRow =>
  ({ id, body: JSON.stringify(body), sort_time: at, updated_at: at });
const read = (cache: AlertDeviceStatusQueryCache<CachedDeviceStatusRow>, at: number,
  load: () => Iterable<CachedDeviceStatusRow>, future?: CachedDeviceStatusRow, key = "upbat") => {
  const rows = [...cache.read(key, ["uploader", "uploaderBattery"], at - 86_400_000, at, load)];
  cache.rememberFuture(future);
  return rows;
};

describe("alert raw latest-N status authority", () => {
  it("restores bounded raw input and future proof without caching an alert decision", () => {
    const cache = new AlertDeviceStatusQueryCache<CachedDeviceStatusRow>();
    const present = row("present", 1000, { uploader: { battery: 19 }, note: "raw\ud800value" });
    const future = row("future", 2000);
    expect(read(cache, 1000, () => [present], future)).toEqual([present]);
    cache.rememberFuture(cache.future("future-upbat", 1000, () => future));
    const revision = cache.checkpointRevision;
    const restored = new AlertDeviceStatusQueryCache<CachedDeviceStatusRow>();
    expect(restored.restoreCheckpoint(JSON.parse(JSON.stringify(cache.snapshotCheckpoint())))).toBe(true);
    const load = vi.fn(() => { throw new Error("must use restored raw prefix"); });
    expect(read(restored, 1999, load, future)).toEqual([present]);
    expect(restored.future("future-upbat", 1999, load)).toEqual(future);
    expect(load).not.toHaveBeenCalled();
    read(cache, 1500, load, future);
    expect(cache.checkpointRevision).toBe(revision);
    expect(read(restored, 2000, () => [future, present])).toEqual([future, present]);
    restored.rememberFuture(restored.future("future-upbat", 2000, () => undefined));
    const fork = restored.fork();
    fork.upsert(row("other", 2001), 2001);
    expect(fork.snapshotCheckpoint()).toBeUndefined();
    expect(restored.snapshotCheckpoint()).not.toBeUndefined();
  });

  it("rejects malformed, out of order, mismatched and oversized checkpoint input", () => {
    const source = new AlertDeviceStatusQueryCache<CachedDeviceStatusRow>();
    read(source, 1000, () => [row("a", 1000), row("b", 900)]);
    source.rememberFuture(source.future("future-upbat", 1000, () => undefined));
    const snapshot = () => JSON.parse(JSON.stringify(source.snapshotCheckpoint())) as {
      fields: unknown[]; future: { row: unknown; at: number }; recent: { rows: CachedDeviceStatusRow[]; lower: number; complete: boolean };
    };
    const mutations = [
      (value: ReturnType<typeof snapshot>) => { value.fields = ["unrecognized"]; },
      (value: ReturnType<typeof snapshot>) => { value.recent.rows.reverse(); },
      (value: ReturnType<typeof snapshot>) => { value.recent.rows[0]!.body = "{}"; },
      (value: ReturnType<typeof snapshot>) => { value.recent.rows[0]!.sort_time = 1001; },
      (value: ReturnType<typeof snapshot>) => { value.recent.rows[1]!.id = "a"; },
      (value: ReturnType<typeof snapshot>) => { value.future.row = row("past", 1000); },
      (value: ReturnType<typeof snapshot>) => { value.future.at = 1001; },
      (value: ReturnType<typeof snapshot>) => { value.future.row = row("large", 2000, { uploader: {}, value: "a".repeat(3 * 1024 * 1024) }); },
    ];
    for (const mutate of mutations) {
      const value = snapshot(); mutate(value);
      const restored = new AlertDeviceStatusQueryCache<CachedDeviceStatusRow>();
      expect(restored.restoreCheckpoint(value)).toBe(false);
      expect(restored.ready).toBe(false);
    }
  });

  it("round trips a lazy budget-limited prediction prefix and extends it only when requested", () => {
    const cache = new AlertDeviceStatusQueryCache<CachedDeviceStatusRow>();
    const source = Array.from({ length: 1000 }, (_, n) => row(String(n), 2000 - n,
      { uploader: { battery: 19 }, openaps: { suggested: { reason: "AAPS prediction ".repeat(150) } } }));
    let count = 0;
    for (const _row of cache.read("upbat", ["uploader"], 0, 2000, () => source)) if (++count === 41) break;
    cache.rememberFuture(cache.future("future-upbat", 2000, () => undefined));
    const restored = new AlertDeviceStatusQueryCache<CachedDeviceStatusRow>();
    expect(restored.restoreCheckpoint(JSON.parse(JSON.stringify(cache.snapshotCheckpoint())))).toBe(true);
    const load = vi.fn(() => source);
    count = 0;
    for (const _row of restored.read("upbat", ["uploader"], 0, 2001, load)) if (++count === 41) break;
    restored.rememberFuture(restored.future("future-upbat", 2001, () => undefined));
    expect(load).not.toHaveBeenCalled();
    expect(restored.checkpointRevision).toBe(1);
  });

  it("does not prefetch past the first cold consumer's JSON budget", () => {
    const cache = new AlertDeviceStatusQueryCache<CachedDeviceStatusRow>();
    let steps = 0;
    const load = vi.fn(function* () {
      for (const value of [row("a", 1000), row("b", 900), row("c", 800)]) { steps++; yield value; }
    });
    for (const value of cache.read("upbat", ["uploader"], 0, 1000, load)) {
      expect(value.id).toBe("a"); break;
    }
    cache.rememberFuture(undefined);
    expect(steps).toBe(1);
    for (const value of cache.read("upbat", ["uploader"], 0, 1001, load)) {
      expect(value.id).toBe("a"); break;
    }
    cache.rememberFuture(undefined);
    expect(steps).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(read(cache, 1002, load)).toHaveLength(3);
  });

  it("reuses a truncated 1000-row SQL prefix and never requests its unproved tail", () => {
    const cache = new AlertDeviceStatusQueryCache<CachedDeviceStatusRow>();
    const rows = Array.from({ length: 1000 }, (_, n) => row(String(n), 2000 - n));
    const load = vi.fn(() => rows);
    expect(read(cache, 2000, load)).toEqual(rows);
    expect(read(cache, 2001, load)).toEqual(rows);
    expect(load).toHaveBeenCalledTimes(1);
    cache.upsert(row("new", 2002), 2002);
    expect(read(cache, 2002, load).map(x => x.id)).toEqual(["new", ...rows.slice(0, 999).map(x => x.id)]);
    expect(load).toHaveBeenCalledTimes(1);
    // Moving a known boundary member into the unproved old suffix must reload.
    cache.upsert(row("998", 1), 2003);
    const replacement = [row("new", 2002), ...rows.slice(0, 998), row("unseen", 1001)];
    expect(read(cache, 2003, () => replacement)).toEqual(replacement);
  });

  it("expires at the earliest matching future timestamp, predicate change and clock rollback", () => {
    const cache = new AlertDeviceStatusQueryCache<CachedDeviceStatusRow>();
    const present = row("now", 1000), future = row("future", 2000);
    const load = vi.fn(() => [present]);
    read(cache, 1000, load, future);
    read(cache, 1999, load, future);
    expect(load).toHaveBeenCalledTimes(1);
    expect(read(cache, 2000, () => [future, present])).toEqual([future, present]);
    read(cache, 2001, load, undefined, "pump");
    read(cache, 1500, load, future, "pump");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("keeps forks isolated and clears changed membership and ambiguous SQL ties", () => {
    const committed = new AlertDeviceStatusQueryCache<CachedDeviceStatusRow>();
    const source = [row("a", 1000), row("b", 900)];
    const load = vi.fn(() => source);
    read(committed, 1000, load);
    const fork = committed.fork();
    fork.upsert(row("new", 1100), 1100);
    expect(read(fork, 1100, load).map(x => x.id)).toEqual(["new", "a", "b"]);
    expect(read(committed, 1100, load)).toEqual(source);
    expect(load).toHaveBeenCalledTimes(1);
    fork.upsert(row("new", 1100, { pump: {} }), 1101);
    expect(fork.ready).toBe(false);
    read(fork, 1101, load);
    fork.upsert(row("duplicate-time", 1000), 1102);
    expect(fork.ready).toBe(false);
  });

  it("retains losslessly compressed prediction bodies and refuses an oversized first row", () => {
    const cache = new AlertDeviceStatusQueryCache<CachedDeviceStatusRow>();
    const predictions = { openaps: { suggested: { predBGs: { IOB: Array.from({ length: 100 }, (_, n) => n + 100) } } },
      uploader: { battery: 19 }, note: "🩵".repeat(3000) };
    const rows = Array.from({ length: 1000 }, (_, n) => row(String(n), 2000 - n, predictions));
    const load = vi.fn(() => rows);
    expect(read(cache, 2000, load)).toEqual(rows);
    expect(read(cache, 2001, load)).toEqual(rows);
    expect(load).toHaveBeenCalledTimes(1);
    const large = new AlertDeviceStatusQueryCache<CachedDeviceStatusRow>();
    const huge = row("huge", 1000, { uploader: { battery: 19 }, text: "x".repeat(2_100_000) });
    const fallback = vi.fn(() => [huge]);
    expect(read(large, 1000, fallback)).toEqual([huge]);
    expect(large.ready).toBe(false);
    expect(read(large, 1001, fallback)).toEqual([huge]);
    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it("does not reuse an unsealed read after a future-query failure", () => {
    const cache = new AlertDeviceStatusQueryCache<CachedDeviceStatusRow>();
    const load = vi.fn(() => [row("a", 1000)]);
    expect([...cache.read("upbat", ["uploader"], 0, 1000, load)]).toHaveLength(1);
    // No rememberFuture: the caller's original future query did not succeed.
    expect(read(cache, 1001, load)).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("bounds exact future rows and empty proofs independently and expires them on mutation and time", () => {
    const cache = new AlertDeviceStatusQueryCache<CachedDeviceStatusRow>();
    read(cache, 1000, () => []);
    const empty = vi.fn(() => undefined);
    expect(cache.future("future-sql", 1000, empty)).toBeUndefined();
    expect(cache.future("future-sql", 1100, empty)).toBeUndefined();
    expect(empty).toHaveBeenCalledTimes(1);
    cache.upsert(row("unmatched", 1100, { pump: {} }), 1100);
    expect(cache.future("future-sql", 1100, empty)).toBeUndefined();
    expect(empty).toHaveBeenCalledTimes(2);
    const future = row("future", 2000);
    const load = vi.fn(() => future);
    expect(cache.future("different-sql", 1200, load)).toEqual(future);
    expect(cache.future("different-sql", 1999, load)).toEqual(future);
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.future("different-sql", 2000, empty)).toBeUndefined();
    expect(empty).toHaveBeenCalledTimes(3);
    const oversize = row("large-future", 3000, { uploader: {}, text: "x".repeat(100_000) });
    const refused = vi.fn(() => oversize);
    expect(cache.future("large", 2001, refused)).toEqual(oversize);
    expect(cache.future("large", 2002, refused)).toEqual(oversize);
    expect(refused).toHaveBeenCalledTimes(2);
  });

  it("invalidates future proofs even when an oversized recent prefix was never admitted", () => {
    const cache = new AlertDeviceStatusQueryCache<CachedDeviceStatusRow>();
    read(cache, 1000, () => [row("huge", 1000, { uploader: {}, text: "x".repeat(2_100_000) })]);
    const future = vi.fn(() => undefined);
    cache.future("future", 1000, future);
    expect(cache.ready).toBe(true);
    cache.upsert(row("new-future", 2000), 1001);
    cache.future("future", 1001, future);
    expect(future).toHaveBeenCalledTimes(2);
  });
});
