/** Exact serialized results only: no filtering, truncation, or shared mutable objects. */
export class LegacyReadCache {
  private readonly entries = new Map<string, string>();
  private bytes = 0;

  constructor(
    private readonly maxEntries = 128,
    private readonly maxBytes = 4 * 1024 * 1024,
    private readonly maxEntryBytes = 1024 * 1024,
  ) {}

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  read(key: string, load: () => string): string {
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    // Loading synchronously prevents a mutation from racing cache insertion.
    // Errors are never cached; empty JSON results are valid cache entries.
    const value = load();
    const bytes = this.size(key, value);
    if (this.maxEntries < 1 || bytes > this.maxEntryBytes || bytes > this.maxBytes) return value;
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const oldest = this.entries.entries().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest[0]);
      this.bytes -= this.size(oldest[0], oldest[1]);
    }
    this.entries.set(key, value);
    this.bytes += bytes;
    return value;
  }

  private size(key: string, value: string): number {
    // Account for both strings as UTF-16, independently of engine compaction.
    return 2 * (key.length + value.length);
  }
}
