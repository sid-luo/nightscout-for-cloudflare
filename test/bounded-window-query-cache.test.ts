import { describe, expect, it, vi } from "vitest";
import { BoundedWindowQueryCache } from "../src/realtime/bounded-window-query-cache";

interface Row { id: string; sort_time: number; body: string }
const row = (sort_time: number, body = "{}", id = String(sort_time)): Row => ({ id, sort_time, body });

describe("bounded raw treatment window cache", () => {
  it("reuses advancing latest-N windows, including ASC presentation, without probing again", () => {
    const cache = new BoundedWindowQueryCache<Row>();
    const load = vi.fn(() => [row(60), row(80), row(100)]);
    const future = vi.fn(() => 150);
    expect([...cache.read("frame-3-ascending", 0, 100, load, future)]).toEqual([row(60), row(80), row(100)]);
    expect([...cache.read("frame-3-ascending", 70, 120, load, future)]).toEqual([row(80), row(100)]);
    expect([...cache.read("frame-3-ascending", 90, 149, load, future)]).toEqual([row(100)]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(future).toHaveBeenCalledTimes(1);
  });

  it("loads future rows exactly at the boundary, including rows excluded by a different category", () => {
    const cache = new BoundedWindowQueryCache<Row>();
    let result = [row(90)];
    let next = 150;
    const load = vi.fn(() => result);
    const future = vi.fn(() => next);
    expect([...cache.read("category", 0, 100, load, future)]).toEqual(result);
    expect([...cache.read("category", 0, 149, load, future)]).toEqual(result);
    next = 180; // The global row at 150 was in a different category.
    expect([...cache.read("category", 0, 150, load, future)]).toEqual(result);
    expect(load).toHaveBeenCalledTimes(2);
    result = [row(180), row(90)];
    next = Infinity;
    expect([...cache.read("category", 0, 180, load, future)]).toEqual(result);
    expect(load).toHaveBeenCalledTimes(3);
    expect(future).toHaveBeenCalledTimes(3);
  });

  it("reloads either clock boundary moving backwards, even inside the original loaded window", () => {
    const cache = new BoundedWindowQueryCache<Row>();
    const load = vi.fn(() => [row(90), row(50)]);
    const future = () => Infinity;
    [...cache.read("window", 0, 100, load, future)];
    [...cache.read("window", 20, 120, load, future)];
    [...cache.read("window", 10, 120, load, future)];
    expect(load).toHaveBeenCalledTimes(2);
    [...cache.read("window", 10, 110, load, future)];
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("caches empty results while respecting a future arrival", () => {
    const cache = new BoundedWindowQueryCache<Row>();
    let result: Row[] = [];
    const load = vi.fn(() => result);
    const future = vi.fn(() => result.length === 0 ? 120 : Infinity);
    expect([...cache.read("empty", 0, 100, load, future)]).toEqual([]);
    expect([...cache.read("empty", 10, 119, load, future)]).toEqual([]);
    result = [row(120)];
    expect([...cache.read("empty", 10, 120, load, future)]).toEqual(result);
    expect(load).toHaveBeenCalledTimes(2);
    expect(future).toHaveBeenCalledTimes(2);
  });

  it("retains only a complete raw EOF despite an output budget break, including on the final row", () => {
    for (const result of [[row(100)], [row(100), row(90)]]) {
      const cache = new BoundedWindowQueryCache<Row>();
      const load = vi.fn(() => result);
      const future = vi.fn(() => Infinity);
      for (const _row of cache.read("partial", 0, 100, load, future)) break;
      expect(future).toHaveBeenCalledTimes(1);
      expect([...cache.read("partial", 0, 100, load, future)]).toEqual(result);
      expect(load).toHaveBeenCalledTimes(1);
      expect(future).toHaveBeenCalledTimes(1);
    }
  });

  it("clears writes/deletions and prevents an invalidated rollback iterator from repopulating", () => {
    const cache = new BoundedWindowQueryCache<Row>();
    let result = [row(100, "committed")];
    const load = vi.fn(() => result);
    const future = vi.fn(() => Infinity);
    [...cache.read("write", 0, 100, load, future)];
    result = [row(100, "replacement")];
    cache.clear();
    expect([...cache.read("write", 0, 100, load, future)]).toEqual(result);
    result = [];
    cache.clear();
    expect([...cache.read("write", 0, 100, load, future)]).toEqual([]);
    cache.clear();
    result = [row(100, "uncommitted"), row(90, "uncommitted")];
    const pending = cache.read("write", 0, 100, load, future);
    pending.next();
    cache.clear(); // The enclosing transaction rolled back before exhaustion.
    result = [row(100, "replacement")];
    [...pending];
    expect(future).toHaveBeenCalledTimes(4);
    expect([...cache.read("write", 0, 100, load, future)]).toEqual(result);
    expect(load).toHaveBeenCalledTimes(5);
  });

  it("does not repopulate if the future probe itself invalidates the cache", () => {
    const cache = new BoundedWindowQueryCache<Row>();
    const load = vi.fn(() => [row(100)]);
    const future = vi.fn(() => { cache.clear(); return Infinity; });
    [...cache.read("probe-clear", 0, 100, load, future)];
    [...cache.read("probe-clear", 0, 100, load, future)];
    expect(load).toHaveBeenCalledTimes(2);
    expect(future).toHaveBeenCalledTimes(2);
  });

  it("does not cache loader/probe errors or probe after a loader fails", () => {
    const cache = new BoundedWindowQueryCache<Row>();
    const future = vi.fn(() => Infinity);
    const broken = vi.fn(function* () { yield row(100); throw new Error("load failed"); });
    expect(() => [...cache.read("error", 0, 100, broken, future)]).toThrow("load failed");
    expect(future).toHaveBeenCalledTimes(0);
    const load = vi.fn(() => [row(100)]);
    const probe = vi.fn((): number => { throw new Error("probe failed"); });
    expect(() => [...cache.read("error", 0, 100, load, probe)]).toThrow("probe failed");
    [...cache.read("error", 0, 100, load, future)];
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("defers pre-read cursor and future-probe failures until the consumer requests their original tail", () => {
    for (const probeFails of [false, true]) {
      const cache = new BoundedWindowQueryCache<Row>();
      const load = vi.fn(function* () {
        yield row(100); yield row(90);
        if (!probeFails) throw new Error("tail failed");
      });
      const future = vi.fn((): number => { throw new Error("probe failed"); });
      // Both an early break and a break on the final available row must hide
      // an error the old streaming consumer would never have requested.
      expect(() => { for (const _row of cache.read("error", 0, 100, load, future)) break; }).not.toThrow();
      expect(() => {
        let count = 0;
        for (const _row of cache.read("error", 0, 100, load, future)) if (++count === 2) break;
      }).not.toThrow();
      const iterator = cache.read("error", 0, 100, load, future);
      expect(iterator.next().value).toEqual(row(100));
      expect(iterator.next().value).toEqual(row(90));
      expect(() => iterator.next()).toThrow(probeFails ? "probe failed" : "tail failed");
      expect(load).toHaveBeenCalledTimes(3); // Errors never admit a cache entry.
      if (!probeFails) expect(future).not.toHaveBeenCalled();
    }
  });

  it("replays a bounded prefix and the original tail once on oversize, unsupported rows or mid-load invalidation", () => {
    for (const failure of ["size", "row", "clear"] as const) {
      const cache = new BoundedWindowQueryCache<Row>({ maxEntryBytes: 1800 });
      let closed = 0;
      const result = [row(100), row(90, failure === "size" ? "x".repeat(65_537) : "{}"), row(80)];
      if (failure === "row") Object.assign(result[1]!, { parsed: {} });
      const load = vi.fn(function* () {
        try {
          yield result[0]!;
          if (failure === "clear") cache.clear();
          yield result[1]!; yield result[2]!;
        } finally { closed++; }
      });
      const future = vi.fn(() => Infinity);
      expect([...cache.read("fallback", 0, 100, load, future)]).toEqual(result);
      expect([...cache.read("fallback", 0, 100, load, future)]).toEqual(result);
      expect(load).toHaveBeenCalledTimes(2);
      expect(future).not.toHaveBeenCalled();
      for (const _row of cache.read("fallback", 0, 100, load, future)) break;
      expect(closed).toBe(3);
    }
  });

  it("closes streaming cursors and preserves an original tail failure over a close failure", () => {
    const cache = new BoundedWindowQueryCache<Row>({ maxEntryBytes: 1000 });
    const close = vi.fn((): IteratorResult<Row> => { throw new Error("close failed"); });
    const load = () => ({ [Symbol.iterator]: () => {
      let index = 0;
      return { next(): IteratorResult<Row> {
        if (index++ === 0) return { done: false, value: row(100, "x".repeat(1000)) };
        throw new Error("original tail failed");
      }, return: close };
    } });
    const interrupted = cache.read("stream", 0, 100, load, () => Infinity);
    expect(interrupted.next().value?.sort_time).toBe(100);
    expect(() => interrupted.return!()).toThrow("close failed");
    const completed = cache.read("stream", 0, 100, load, () => Infinity);
    expect(completed.next().value?.sort_time).toBe(100);
    expect(() => completed.next()).toThrow("original tail failed");
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("preserves a thrown undefined tail or probe value without confusing it with successful EOF", () => {
    for (const probeFails of [false, true]) {
      const cache = new BoundedWindowQueryCache<Row>();
      const load = function* () { yield row(100); if (!probeFails) throw undefined; };
      const future = (): number => { throw undefined; };
      for (const _row of cache.read("undefined", 0, 100, load, future)) break;
      const iterator = cache.read("undefined", 0, 100, load, future);
      expect(iterator.next().value).toEqual(row(100));
      let caught = false;
      try { iterator.next(); } catch (error) { caught = true; expect(error).toBeUndefined(); }
      expect(caught).toBe(true);
    }
  });

  it("reads the close method once and preserves an original error if its getter throws", () => {
    const cache = new BoundedWindowQueryCache<Row>({ maxEntryBytes: 1000 });
    let reads = 0;
    const close = vi.fn(() => ({ done: true as const, value: undefined }));
    const load = (getterThrows = false) => ({ [Symbol.iterator]: () => {
      let index = 0;
      return {
        next(): IteratorResult<Row> {
          if (index++ === 0) return { done: false, value: row(100, "x".repeat(1000)) };
          throw new Error("original next failed");
        },
        get return() {
          reads++;
          if (getterThrows) throw new Error("close getter failed");
          return close;
        },
      };
    } });
    const early = cache.read("getter", 0, 100, () => load(), () => Infinity);
    early.next(); early.return!();
    expect(reads).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    const failed = cache.read("getter", 0, 100, () => load(true), () => Infinity);
    failed.next();
    expect(() => failed.next()).toThrow("original next failed");
    const stopped = cache.read("getter", 0, 100, () => load(true), () => Infinity);
    stopped.next();
    expect(() => stopped.return!()).toThrow("close getter failed");
    expect(reads).toBe(3);
  });

  it("bounds pre-reading even an infinite scalar cursor and releases its reservation on return", () => {
    const cache = new BoundedWindowQueryCache<Row>({ maxEntryBytes: 1800 });
    let pulled = 0, closed = 0;
    const load = function* () {
      try { while (true) { pulled++; yield row(100); } }
      finally { closed++; }
    };
    const future = vi.fn(() => Infinity);
    const iterator = cache.read("infinite", 0, 100, load, future);
    expect(iterator.next().value).toEqual(row(100));
    expect(pulled).toBeLessThanOrEqual(8);
    iterator.return!();
    expect(closed).toBe(1);
    expect(future).not.toHaveBeenCalled();
    expect((cache as unknown as { bufferBytes: number }).bufferBytes).toBe(0);
  });

  it("counts UTF-16 strings and metadata, skips oversized results and avoids extra probes", () => {
    const cache = new BoundedWindowQueryCache<Row>();
    // This is under 512 KiB in UTF-8 but exceeds it as retained UTF-16.
    const load = vi.fn(() => [row(100, "x".repeat(262_144))]);
    const future = vi.fn(() => Infinity);
    expect([...cache.read("large", 0, 100, load, future)]).toHaveLength(1);
    expect([...cache.read("large", 0, 100, load, future)]).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(future).toHaveBeenCalledTimes(0);
    const metadata = new BoundedWindowQueryCache<Row>({ maxEntryBytes: 512 });
    const small = vi.fn(() => [row(100)]);
    [...metadata.read("x".repeat(100), 0, 100, small, future)];
    [...metadata.read("x".repeat(100), 0, 100, small, future)];
    expect(small).toHaveBeenCalledTimes(2);
    expect(future).toHaveBeenCalledTimes(0);
  });

  it("keeps body strings raw and does not retain parsed object graphs or mutable caller rows", () => {
    const cache = new BoundedWindowQueryCache<Row>();
    const result = [row(100, '{"nested":{"score":1}}')];
    const load = vi.fn(() => result);
    const future = vi.fn(() => Infinity);
    const first = [...cache.read("raw", 0, 100, load, future)];
    first[0]!.body = "caller changed the row";
    const second = [...cache.read("raw", 0, 100, load, future)];
    expect(second[0]!.body).toBe('{"nested":{"score":1}}');
    second[0]!.body = "changed cached hit";
    expect([...cache.read("raw", 0, 100, load, future)][0]!.body).toBe('{"nested":{"score":1}}');
    expect(load).toHaveBeenCalledTimes(1);
    const parsed = vi.fn(() => [{ ...row(100), parsed: { score: 1 } }]);
    [...cache.read("parsed", 0, 100, parsed, future)];
    [...cache.read("parsed", 0, 100, parsed, future)];
    expect(parsed).toHaveBeenCalledTimes(2);
    expect(future).toHaveBeenCalledTimes(1);
  });

  it("bounds total retained bytes with LRU eviction", () => {
    const cache = new BoundedWindowQueryCache<Row>();
    const load = vi.fn(() => [row(100, "x".repeat(240_000))]);
    const future = () => Infinity;
    for (let index = 0; index < 8; index++) [...cache.read(String(index), 0, 100, load, future)];
    [...cache.read("0", 0, 100, load, future)]; // Refresh entry zero before eviction.
    [...cache.read("8", 0, 100, load, future)];
    [...cache.read("0", 0, 100, load, future)];
    expect(load).toHaveBeenCalledTimes(9);
    [...cache.read("1", 0, 100, load, future)];
    expect(load).toHaveBeenCalledTimes(10);
  });

  it("bounds keys to 32 and refreshes recency on hits", () => {
    const cache = new BoundedWindowQueryCache<Row>();
    const load = vi.fn(() => [] as Row[]);
    const future = () => Infinity;
    for (let index = 0; index < 32; index++) [...cache.read(String(index), 0, 100, load, future)];
    [...cache.read("0", 0, 100, load, future)];
    [...cache.read("32", 0, 100, load, future)];
    [...cache.read("0", 0, 100, load, future)];
    expect(load).toHaveBeenCalledTimes(33);
    [...cache.read("1", 0, 100, load, future)];
    expect(load).toHaveBeenCalledTimes(34);
  });
});
