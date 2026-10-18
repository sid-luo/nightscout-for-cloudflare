import { describe, expect, it, vi } from "vitest";
import { LegacyReadCache } from "../src/legacy-read-cache";

interface Ledger { bytes: number; entries: Map<string, string> }
function ledger(cache: LegacyReadCache): Ledger { return cache as unknown as Ledger; }
function accounted(cache: LegacyReadCache, maxEntries: number, maxBytes: number): void {
  const actual = ledger(cache);
  expect(actual.bytes).toBe([...actual.entries].reduce((sum, [key, value]) => sum + 2 * (key.length + value.length), 0));
  expect(actual.entries.size).toBeLessThanOrEqual(maxEntries);
  expect(actual.bytes).toBeLessThanOrEqual(maxBytes);
}

describe("protected metadata shares the unchanged legacy serialized budget", () => {
  it("evicts only the least recent optional result while old protected entries remain in the same map", () => {
    const cache = new LegacyReadCache(4, 128, 64, ["member", "source"]);
    for (const [key, value] of [["member", "members"], ["source", "12"], ["api3:a", "[]"], ["legacy:b", "[]"]]) {
      expect(cache.set(key!, value!)).toBe(true);
    }
    expect(cache.set("order:c", "[]")).toBe(true);
    expect([...ledger(cache).entries]).toEqual([
      ["member", "members"], ["source", "12"], ["legacy:b", "[]"], ["order:c", "[]"],
    ]);
    expect(cache.get("legacy:b")).toBe("[]");
    expect(cache.set("api3:d", "[]")).toBe(true);
    expect(cache.get("order:c")).toBeUndefined();
    expect(cache.get("member")).toBe("members");
    expect(cache.get("source")).toBe("12");
    accounted(cache, 4, 128);
  });

  it("replaces a protected value exactly once and evicts optional bytes to accommodate its growth", () => {
    const cache = new LegacyReadCache(4, 80, 70, ["m", "s"]);
    for (const [key, value] of [["m", "x".repeat(10)], ["s", "1"], ["a", "x".repeat(10)], ["b", "x".repeat(10)]]) {
      expect(cache.set(key!, value!)).toBe(true);
    }
    expect(ledger(cache).bytes).toBe(70);
    expect(cache.set("m", "x".repeat(20))).toBe(true);
    expect([...ledger(cache).entries.keys()]).toEqual(["s", "b", "m"]);
    expect(ledger(cache).bytes).toBe(68);
    expect(cache.set("m", "x".repeat(20))).toBe(true);
    expect(ledger(cache).bytes).toBe(68);
    expect(cache.set("m", "")).toBe(true);
    expect(ledger(cache).bytes).toBe(28);
    expect(cache.get("s")).toBe("1");
    accounted(cache, 4, 80);
  });

  it("atomically refuses a new result or replacement that cannot fit beside protected data without touching prior LRU or values", () => {
    const cache = new LegacyReadCache(3, 60, 60, ["member", "source"]);
    expect(cache.set("member", "m".repeat(10))).toBe(true); // 32 bytes
    expect(cache.set("source", "1")).toBe(true); // 14 bytes
    expect(cache.set("a", "a")).toBe(true); // 4 bytes
    const before = [...ledger(cache).entries];
    const generation = cache.generation;
    // Each value fits the per-entry limit, but protected entries leave too
    // little room. Refusal must occur before evicting/replacing anything.
    expect(cache.set("wide", "1234")).toBe(false);
    expect(cache.set("a", "12345678")).toBe(false);
    expect(cache.set("member", "m".repeat(18))).toBe(false);
    expect([...ledger(cache).entries]).toEqual(before);
    expect(ledger(cache).bytes).toBe(50);
    expect(cache.generation).toBe(generation);
    expect(cache.set("b", "b")).toBe(true);
    expect([...ledger(cache).entries.keys()]).toEqual(["member", "source", "b"]);
    accounted(cache, 3, 60);
  });

  it("counts only retained protected slots and rejects optional loads when protected slots occupy the key cap", () => {
    const cache = new LegacyReadCache(2, 128, 128, ["member", "source"]);
    expect(cache.set("optional", "[]")).toBe(true); // Configured but absent keys reserve no bytes/slots.
    expect(cache.set("member", "members")).toBe(true);
    expect(cache.set("source", "1")).toBe(true); // Evicts optional, preserving member.
    const load = vi.fn(() => "[]");
    expect(cache.read("api3:uncached", load)).toBe("[]");
    expect(cache.read("api3:uncached", load)).toBe("[]");
    expect(load).toHaveBeenCalledTimes(2); // Return a valid result without falsely claiming it was retained.
    expect(cache.get("api3:uncached")).toBeUndefined();
    expect(cache.get("member")).toBe("members");
    expect(cache.get("source")).toBe("1");
    accounted(cache, 2, 128);
    const single = new LegacyReadCache(1, 128, 128, ["member", "source"]);
    expect(single.set("member", "members")).toBe(true);
    expect(single.set("source", "1")).toBe(false);
    expect(single.get("member")).toBe("members");
  });

  it("makes explicit clear and clearKeeping remove protected values and invalidate reentrant loads without reviving discarded data", () => {
    const cache = new LegacyReadCache(4, 256, 128, ["member", "source"]);
    cache.set("member", "old-members"); cache.set("source", "1");
    const generation = cache.generation;
    expect(cache.read("late", () => {
      cache.clearKeeping(["member", "source"]);
      expect(cache.set("member", "old-and-new-members")).toBe(true);
      cache.set("callback-only", "uncommitted");
      cache.clearKeeping(["member", "source"]);
      return "uncommitted late result";
    })).toBe("uncommitted late result");
    expect(cache.generation).toBe(generation + 2);
    expect(cache.get("late")).toBeUndefined();
    expect(cache.get("callback-only")).toBeUndefined();
    expect(cache.get("member")).toBe("old-and-new-members");
    cache.clearKeeping(["source"]); // Capacity protection must not override explicit invalidation.
    expect(cache.get("member")).toBeUndefined();
    expect(cache.get("source")).toBe("1");
    cache.clear();
    expect(cache.generation).toBe(generation + 4);
    expect([...ledger(cache).entries]).toEqual([]);
    expect(ledger(cache).bytes).toBe(0);
    expect(cache.set("member", "fresh")).toBe(true);
    accounted(cache, 4, 256);
  });

  it("cannot evict metadata admitted reentrantly during an ordinary load and still propagates original load errors", () => {
    const cache = new LegacyReadCache(2, 40, 40, ["m"]);
    expect(cache.read("result", () => {
      expect(cache.set("m", "x".repeat(16))).toBe(true); // 34 bytes remain charged while result admission is refused.
      return "result-value";
    })).toBe("result-value");
    expect(cache.get("result")).toBeUndefined();
    expect(cache.get("m")).toBe("x".repeat(16));
    let threw = false;
    try { cache.read("error", () => { throw undefined; }); }
    catch (error) { threw = true; expect(error).toBeUndefined(); }
    expect(threw).toBe(true);
    expect(cache.get("error")).toBeUndefined();
    accounted(cache, 2, 40);
  });

  it("charges protected and optional strings as UTF-16 under both the byte and per-entry limits", () => {
    const cache = new LegacyReadCache(3, 20, 12, ["m"]);
    expect(cache.set("m", "🧪🧪")).toBe(true); // 2*(1+4)=10 bytes.
    expect(cache.set("n", "🧪🧪")).toBe(true); // Exactly 20 total.
    expect(cache.set("e", "")).toBe(true); // Evicts only n.
    expect([...ledger(cache).entries]).toEqual([["m", "🧪🧪"], ["e", ""]]);
    expect(cache.set("m", "🧪🧪🧪")).toBe(false); // 14 bytes exceeds the unchanged 12-byte entry cap.
    expect(cache.get("m")).toBe("🧪🧪");
    accounted(cache, 3, 20);
  });
});
