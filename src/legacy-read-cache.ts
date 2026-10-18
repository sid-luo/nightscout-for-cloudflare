/** Bounded opaque serialized results/candidates; no filtering or mutable values. */
export class LegacyReadCache {
  private readonly entries = new Map<string, string>();
  private bytes = 0;
  private generationToken = 0;
  private readonly protectedKeys: ReadonlySet<string>;

  constructor(
    private readonly maxEntries = 128,
    private readonly maxBytes = 4 * 1024 * 1024,
    private readonly maxEntryBytes = 1024 * 1024,
    protectedKeys: readonly string[] = [],
  ) {
    // Protection affects capacity admission only. Values remain in the same
    // charged Map and explicit clear/clearKeeping still invalidate them.
    this.protectedKeys = new Set(protectedKeys);
  }

  get generation(): number { return this.generationToken; }

  clear(): void {
    this.generationToken++;
    this.entries.clear();
    this.bytes = 0;
  }

  clearKeeping(keys: readonly string[]): void {
    const retained = keys.flatMap(key => {
      const value = this.entries.get(key);
      return value === undefined ? [] : [[key, value] as const];
    });
    // Invalidate in-flight loads even when a proven-safe metadata lane survives.
    this.clear();
    for (const [key, value] of retained) this.set(key, value);
  }

  get(key: string): string | undefined {
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, cached);
    }
    return cached;
  }

  set(key: string, value: string): boolean {
    const bytes = this.size(key, value);
    // Reject before touching an existing value or evicting another namespace.
    if (this.maxEntries < 1 || bytes > this.maxEntryBytes || bytes > this.maxBytes) return false;
    let protectedBytes = 0;
    let protectedCount = 0;
    if (this.protectedKeys.size > 0) {
      for (const [otherKey, otherValue] of this.entries) {
        if (otherKey !== key && this.protectedKeys.has(otherKey)) {
          protectedCount++;
          protectedBytes += this.size(otherKey, otherValue);
        }
      }
    }
    // Optional results may not evict monotone mutation history. Plan refusal
    // before changing LRU or the ledger, including replacement of this key.
    if (protectedCount >= this.maxEntries || protectedBytes + bytes > this.maxBytes) return false;
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.entries.delete(key);
      this.bytes -= this.size(key, previous);
    }
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const oldest = this.oldestEvictable();
      // The preflight above proves a non-protected victim exists whenever
      // eviction is needed, so admission never partially evicts then fails.
      if (oldest === undefined) break;
      this.entries.delete(oldest[0]);
      this.bytes -= this.size(oldest[0], oldest[1]);
    }
    this.entries.set(key, value);
    this.bytes += bytes;
    return true;
  }

  read(key: string, load: () => string): string {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const generation = this.generationToken;
    // Errors are never cached; empty strings/results are valid entries. A
    // synchronous mutation/rollback inside load must not republish old data.
    const value = load();
    if (generation === this.generationToken) this.set(key, value);
    return value;
  }

  private size(key: string, value: string): number {
    // Account for both strings as UTF-16, independently of engine compaction.
    return 2 * (key.length + value.length);
  }

  private oldestEvictable(): [string, string] | undefined {
    for (const entry of this.entries) if (!this.protectedKeys.has(entry[0])) return entry;
    return undefined;
  }
}
