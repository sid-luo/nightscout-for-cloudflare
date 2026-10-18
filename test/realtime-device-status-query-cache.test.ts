import { describe, expect, it, vi } from "vitest";
import { DeviceStatusQueryCache, type CachedDeviceStatusRow } from "../src/realtime/device-status-query-cache";

const row = (id: string, time: number, updated = time): CachedDeviceStatusRow =>
  ({ id, body: "{}", sort_time: time, updated_at: updated });
// The codec intentionally does not compress bodies beyond 65536 code units.
// This row therefore exceeds the cache's 4MiB cap independently of its content.
const oversized = (id = "tail", time = 5): CachedDeviceStatusRow =>
  ({ ...row(id, time), body: "x".repeat(2_100_000) });
function first(cache: DeviceStatusQueryCache<CachedDeviceStatusRow>, load: () => Iterable<CachedDeviceStatusRow>) {
  for (const value of cache.read(0, false, load)) return value;
  return undefined;
}
function capturedThrow(operation: () => unknown): { threw: boolean; error?: unknown } {
  try { operation(); return { threw: false }; }
  catch (error) { return { threw: true, error }; }
}

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

  it("admits true raw EOF before output cutoff and isolates rows on cold/hit/fork reads", () => {
    const cache = new DeviceStatusQueryCache<CachedDeviceStatusRow>();
    const input = [row("a", 30), row("b", 20), row("c", 10)];
    let steps = 0, closes = 0;
    const load = vi.fn(() => ({ [Symbol.iterator]() {
      let index = 0;
      return { next() { steps++; return index < input.length
        ? { done: false as const, value: input[index++]! } : { done: true as const, value: undefined }; },
      return() { closes++; return { done: true as const, value: undefined }; } };
    } }));
    const cold = first(cache, load)!;
    expect(steps).toBe(4); // Three raw rows and an actual EOF, despite one output.
    expect(closes).toBe(0); // An exhausted cursor needs no IteratorClose.
    cold.body = "mutated output";
    input[1]!.body = "mutated input";
    const fork = cache.fork();
    const hit = [...cache.read(0, false, load)];
    expect(hit.map(value => value.body)).toEqual(["{}", "{}", "{}"]);
    hit[0]!.body = "mutated warm output";
    expect([...fork.read(0, false, load)].map(value => value.body)).toEqual(["{}", "{}", "{}"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps an oversize partial prefix across small consumers and resumes its exact original tail", () => {
    const cache = new DeviceStatusQueryCache<CachedDeviceStatusRow>();
    const input = [row("a", 30), row("b", 20), oversized()];
    let closes = 0;
    const load = vi.fn(function* () { try { yield* input; } finally { closes++; } });
    expect(first(cache, load)?.id).toBe("a");
    expect(cache.ready).toBe(true);
    expect(closes).toBe(1);
    for (let repeat = 0; repeat < 3; repeat++) {
      expect(first(cache, load)?.id).toBe("a");
      const prefix = cache.read(0, false, load);
      expect(prefix.next().value?.id).toBe("a");
      expect(prefix.next().value?.id).toBe("b");
      prefix.return!();
    }
    expect(load).toHaveBeenCalledTimes(1);
    expect([...cache.read(0, false, load)]).toEqual(input);
    expect(load).toHaveBeenCalledTimes(2);
    expect(first(cache, load)?.id).toBe("a");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not publish an empty incomplete prefix for an oversize first row", () => {
    const cache = new DeviceStatusQueryCache<CachedDeviceStatusRow>();
    const input = [oversized("first", 30), row("second", 20)];
    const load = vi.fn(() => input);
    expect(first(cache, load)?.id).toBe("first");
    expect(cache.ready).toBe(false);
    expect([...cache.read(0, false, load)]).toEqual(input);
    expect(cache.ready).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("distinguishes EOF at 5000 rows from a 5001-row prefix without truncating the original result", () => {
    const cache = new DeviceStatusQueryCache<CachedDeviceStatusRow>();
    const input = Array.from({ length: 5001 }, (_, index) => row(`id-${index}`, 10_000 - index));
    const load = vi.fn(() => input);
    expect(first(cache, load)?.id).toBe("id-0");
    const prefix = cache.read(0, false, load);
    for (let index = 0; index < 5000; index++) expect(prefix.next().value?.id).toBe(`id-${index}`);
    prefix.return!();
    expect(load).toHaveBeenCalledTimes(1);
    expect([...cache.read(0, false, load)]).toEqual(input);
    expect(load).toHaveBeenCalledTimes(2);
    const complete = new DeviceStatusQueryCache<CachedDeviceStatusRow>();
    const exact = vi.fn(() => input.slice(0, 5000));
    first(complete, exact);
    expect([...complete.read(0, false, exact)]).toEqual(input.slice(0, 5000));
    expect(exact).toHaveBeenCalledTimes(1);
  });

  it("delays a prefetched throw undefined until the caller asks past its valid output", () => {
    const cache = new DeviceStatusQueryCache<CachedDeviceStatusRow>();
    let closes = 0;
    const load = () => ({ [Symbol.iterator]() {
      let index = 0;
      return { next() { if (index++ === 0) return { done: false as const, value: row("a", 30) }; throw undefined; },
        return() { closes++; return { done: true as const, value: undefined }; } };
    } });
    expect(capturedThrow(() => first(cache, load))).toEqual({ threw: false });
    expect(cache.ready).toBe(false);
    expect(closes).toBe(1);
    const complete = cache.read(0, false, load);
    expect(complete.next().value?.id).toBe("a");
    expect(capturedThrow(() => complete.next())).toEqual({ threw: true, error: undefined });
    expect(closes).toBe(2);
    expect(cache.ready).toBe(false);
  });

  it("invalidates after a close getter error and preserves a preceding tail error over close failure", () => {
    const cache = new DeviceStatusQueryCache<CachedDeviceStatusRow>();
    const closeError = new Error("synthetic close getter");
    let gets = 0;
    const load = () => ({ [Symbol.iterator]() {
      let index = 0;
      return { next() { return { done: false as const, value: index++ === 0 ? row("a", 30) : oversized() }; },
        get return(): () => IteratorResult<CachedDeviceStatusRow> { gets++; throw closeError; } };
    } });
    const consumer = cache.read(0, false, load);
    expect(consumer.next().value?.id).toBe("a");
    expect(cache.ready).toBe(true);
    expect(capturedThrow(() => consumer.return!())).toEqual({ threw: true, error: closeError });
    expect(cache.ready).toBe(false);
    expect(gets).toBe(1);
    const tailError = new Error("synthetic raw tail");
    const failure = cache.read(0, false, () => ({ [Symbol.iterator]() { return {
      next(): IteratorResult<CachedDeviceStatusRow> { throw tailError; },
      get return(): () => IteratorResult<CachedDeviceStatusRow> { gets++; throw closeError; },
    }; } }));
    expect(capturedThrow(() => failure.next())).toEqual({ threw: true, error: tailError });
    expect(cache.ready).toBe(false);
    expect(gets).toBe(2);
  });

  it("invalidates a warm partial prefix if its original SQL tail later fails", () => {
    const cache = new DeviceStatusQueryCache<CachedDeviceStatusRow>();
    const input = [row("a", 30), row("b", 20), oversized()];
    first(cache, () => input);
    expect(cache.ready).toBe(true);
    let closes = 0;
    const failed = cache.read(0, false, () => ({ [Symbol.iterator]() {
      let index = 0;
      return { next() { if (index < 2) return { done: false as const, value: input[index++]! }; throw undefined; },
        return(): IteratorResult<CachedDeviceStatusRow> { closes++; throw new Error("secondary warm close failure"); } };
    } }));
    expect(failed.next().value?.id).toBe("a");
    expect(failed.next().value?.id).toBe("b");
    expect(capturedThrow(() => failed.next())).toEqual({ threw: true, error: undefined });
    expect(cache.ready).toBe(false);
    // for-of alone would not close after next() throws; the cache owns it.
    expect(closes).toBe(1);
    const recovered = vi.fn(() => input);
    expect(first(cache, recovered)?.id).toBe("a");
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it("cannot restore a prior generation after clear/upsert during prefetch or consumer cutoff", () => {
    for (const mutation of ["clear", "upsert"] as const) {
      const cache = new DeviceStatusQueryCache<CachedDeviceStatusRow>();
      const input = [row("a", 30), row("b", 20), row("c", 10)];
      const load = function* () {
        yield input[0]!;
        if (mutation === "clear") cache.clear(); else cache.upsert(row("new", 40));
        yield* input.slice(1);
      };
      expect([...cache.read(0, false, load)]).toEqual(input);
      expect(cache.ready).toBe(false);
      const consumer = cache.read(0, false, () => input);
      expect(consumer.next().value?.id).toBe("a");
      expect(cache.ready).toBe(true);
      if (mutation === "clear") cache.clear(); else cache.upsert(row("new", 40));
      consumer.return!();
      if (mutation === "clear") expect(cache.ready).toBe(false);
      else expect([...cache.read(0, false, () => input)].map(value => value.id)).toEqual(["new", "a", "b", "c"]);
    }
  });

  it("preserves committed partial forks and invalidates selected movement across the known historical boundary", () => {
    const committed = new DeviceStatusQueryCache<CachedDeviceStatusRow>();
    const input = [row("a", 30), row("b", 20), oversized()];
    const load = vi.fn(() => input);
    first(committed, load);
    const fork = committed.fork();
    fork.upsert(row("new", 25));
    const warm = fork.read(0, false, load);
    expect([warm.next().value?.id, warm.next().value?.id, warm.next().value?.id]).toEqual(["a", "new", "b"]);
    warm.return!();
    expect(load).toHaveBeenCalledTimes(1);
    fork.upsert(row("older", 1)); // Never append behind an unknown suffix.
    expect(first(fork, load)?.id).toBe("a");
    expect(load).toHaveBeenCalledTimes(1);
    fork.upsert(row("a", 15)); // Hidden rows could now precede this selected row.
    expect(fork.ready).toBe(false);
    const original = committed.read(0, false, load);
    expect([original.next().value?.id, original.next().value?.id]).toEqual(["a", "b"]);
    original.return!();
    expect(load).toHaveBeenCalledTimes(1);
    const lower = committed.fork();
    lower.upsert(row("b", -1));
    expect(lower.ready).toBe(false);
  });
});
