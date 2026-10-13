import { describe, expect, it, vi } from "vitest";
import { LegacyReadCache } from "../src/legacy-read-cache";

describe("legacy serialized read cache", () => {
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
});
