import { describe, expect, it, vi } from "vitest";
import { LegacyReadCache } from "../src/legacy-read-cache";

describe("legacy serialized read cache", () => {
  it("keeps only named metadata in the original budget and invalidates older loads", () => {
    const cache = new LegacyReadCache(3, 64, 32);
    cache.set("view", "safe");
    cache.set("result", "old");
    const generation = cache.generation;
    expect(cache.read("loading", () => {
      cache.clearKeeping(["view", "missing"]);
      return "old-generation";
    })).toBe("old-generation");
    expect(cache.generation).toBe(generation + 1);
    expect(cache.get("result")).toBeUndefined();
    expect(cache.get("loading")).toBeUndefined();
    expect(cache.get("view")).toBe("safe");
    const ledger = cache as unknown as { bytes: number; entries: Map<string, string> };
    expect(ledger.entries.size).toBe(1);
    expect(ledger.bytes).toBe(16);
  });
  it("retains empty results, isolates keys and clears results after mutation", () => {
    const cache = new LegacyReadCache();
    const empty = vi.fn(() => "[]");
    expect(cache.read("empty", empty)).toBe("[]");
    expect(cache.read("empty", empty)).toBe("[]");
    expect(empty).toHaveBeenCalledTimes(1);
    expect(cache.read("other", () => '[{"value":1}]')).toBe('[{"value":1}]');
    cache.clear();
    expect(cache.read("empty", () => '[{"value":2}]')).toBe('[{"value":2}]');
  });

  it("evicts least recently read results at the key limit", () => {
    const cache = new LegacyReadCache(2);
    cache.read("a", () => "a1");
    cache.read("b", () => "b1");
    expect(cache.read("a", () => "a2")).toBe("a1");
    cache.read("c", () => "c1");
    expect(cache.read("b", () => "b2")).toBe("b2");
  });

  it("bounds total string memory including keys, without caching oversized responses", () => {
    const cache = new LegacyReadCache(128, 16, 12);
    const small = vi.fn(() => "12");
    cache.read("ab", small); // 8 bytes
    cache.read("cd", () => "34"); // 8 bytes
    cache.read("ef", () => "56"); // evicts ab
    cache.read("ab", small);
    expect(small).toHaveBeenCalledTimes(2);
    const large = vi.fn(() => "123456789");
    expect(cache.read("large", large)).toBe("123456789");
    expect(cache.read("large", large)).toBe("123456789");
    expect(large).toHaveBeenCalledTimes(2);
    const longKey = vi.fn(() => "[]");
    cache.read("a-long-query-key", longKey);
    cache.read("a-long-query-key", longKey);
    expect(longKey).toHaveBeenCalledTimes(2);
    cache.clear();
    cache.read("ab", small);
    cache.read("cd", () => "34");
    cache.read("ab", small);
    expect(small).toHaveBeenCalledTimes(3);
  });

  it("retries errors instead of caching them", () => {
    const cache = new LegacyReadCache();
    expect(() => cache.read("a", () => { throw new Error("storage unavailable"); })).toThrow("storage unavailable");
    expect(cache.read("a", () => "[]")).toBe("[]");
  });

  it("touches get hits in the same LRU while distinguishing empty strings from misses", () => {
    const cache = new LegacyReadCache(2);
    expect(cache.get("missing")).toBeUndefined();
    expect(cache.set("a", "")).toBe(true);
    expect(cache.set("b", "[]")).toBe(true);
    expect(cache.get("a")).toBe("");
    expect(cache.set("c", "opaque-candidate")).toBe(true);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.read("a", () => { throw new Error("empty string was incorrectly treated as a miss"); })).toBe("");
    expect(cache.get("c")).toBe("opaque-candidate");
  });

  it("replaces the same key once in the byte ledger and reclaims its old allocation", () => {
    const cache = new LegacyReadCache(3, 24, 24);
    const ledger = cache as unknown as { bytes: number; entries: Map<string, string> };
    expect(cache.set("a", "12345")).toBe(true); // 12 bytes
    expect(cache.set("b", "123")).toBe(true); // 8 bytes
    expect(ledger.bytes).toBe(20);
    expect(cache.set("a", "x")).toBe(true); // Replaces 12 with 4, not +4.
    expect(ledger.bytes).toBe(12);
    expect(cache.set("c", "12345")).toBe(true); // All three fit exactly.
    expect(ledger.bytes).toBe(24);
    expect([...ledger.entries]).toEqual([["b", "123"], ["a", "x"], ["c", "12345"]]);
    expect(cache.set("a", "1234567")).toBe(true); // 16 bytes; b then c must go.
    expect([...ledger.entries]).toEqual([["a", "1234567"]]);
    expect(ledger.bytes).toBe(16);
    expect(cache.set("a", "1234567")).toBe(true);
    expect(ledger.bytes).toBe(16);
    expect(ledger.entries.size).toBe(1);
  });

  it("makes result and opaque candidate namespaces compete for one unchanged capacity", () => {
    const cache = new LegacyReadCache(3, 128, 128);
    expect(cache.set("api3:a", "{\"ok\":true}")).toBe(true);
    expect(cache.set("legacy:a", "[]")).toBe(true);
    expect(cache.set("candidate:a", "admit")).toBe(true);
    expect(cache.get("api3:a")).toBe('{"ok":true}');
    expect(cache.set("candidate:b", '["canonical-id"]')).toBe(true);
    expect(cache.get("legacy:a")).toBeUndefined();
    expect(cache.get("candidate:a")).toBe("admit");
    expect(cache.get("api3:a")).toBe('{"ok":true}');
    expect(cache.get("candidate:b")).toBe('["canonical-id"]');
    const ledger = cache as unknown as { bytes: number; entries: Map<string, string> };
    expect(ledger.entries.size).toBe(3);
    expect(ledger.bytes).toBe([...ledger.entries].reduce((sum, [key, value]) => sum + 2 * (key.length + value.length), 0));
    expect(ledger.bytes).toBeLessThanOrEqual(128);
  });

  it("does not publish a load from before clear or overwrite a newer value set during that load", () => {
    const cache = new LegacyReadCache();
    const initial = cache.generation;
    expect(cache.read("key", () => { cache.clear(); return "uncommitted"; })).toBe("uncommitted");
    expect(cache.generation).toBe(initial + 1);
    expect(cache.get("key")).toBeUndefined();
    const current = cache.generation;
    expect(cache.read("key", () => {
      cache.clear();
      expect(cache.set("key", "new-generation")).toBe(true);
      return "old-generation";
    })).toBe("old-generation");
    expect(cache.generation).toBe(current + 1);
    expect(cache.get("key")).toBe("new-generation");
    expect(cache.read("key", () => { throw new Error("new generation was lost"); })).toBe("new-generation");
    expect(cache.generation).toBe(current + 1); // Ordinary get/set/read never clear.
    cache.clear();
    expect(cache.generation).toBe(current + 2);
  });

  it("rejects oversized set without deleting, touching or charging over an existing legal value", () => {
    const cache = new LegacyReadCache(2, 24, 12);
    const ledger = cache as unknown as { bytes: number; entries: Map<string, string> };
    expect(cache.set("a", "x")).toBe(true);
    expect(cache.set("b", "y")).toBe(true);
    const before = [...ledger.entries];
    const bytes = ledger.bytes;
    expect(cache.set("a", "123456789")).toBe(false);
    expect([...ledger.entries]).toEqual(before);
    expect(ledger.bytes).toBe(bytes);
    expect(cache.set("c", "z")).toBe(true);
    expect(cache.get("a")).toBeUndefined(); // Rejected a replacement was no LRU hit.
    expect(cache.get("b")).toBe("y");
    expect(cache.get("c")).toBe("z");
    const totalLimited = new LegacyReadCache(2, 8, 100);
    expect(totalLimited.set("a", "x")).toBe(true);
    expect(totalLimited.set("a", "12345")).toBe(false);
    expect(totalLimited.get("a")).toBe("x");
  });
});
