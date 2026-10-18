import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import { parseEntryPayload } from "../src/model";

const FIVE_MINUTES = 300_000;
const HISTORY_ROWS = 576;
interface Row extends Record<string, SqlStorageValue> { id: string; body: string; sort_time: number }
interface EntryCache {
  clear(): void;
  readonly ready: boolean;
  readonly entries: Map<string, { lower: number; rows: Row[]; limit: number; bytes: number }>;
}
interface Internal {
  realtimeEntryQueries: EntryCache;
  realtimeSnapshot(now: number, frame: boolean, mode: string): { sgvs: unknown[] };
  pluginPropertyContext(now: number): { sgvs: unknown[] };
  realtimeDeviceStatusQueries: { clear(): void };
  realtimeAuxiliaryQueries: Record<string, { clear(): void }>;
  recentTreatmentQueries: { clear(): void };
  boundedTreatmentQueries: { clear(): void };
}

function cacheState(cache: EntryCache) {
  return {
    ready: cache.ready,
    queries: [...cache.entries].map(([sql, value]) => ({
      key: sql.replace(/\s+/g, " ").trim(),
      lower: value.lower,
      limit: value.limit,
      bytes: value.bytes,
      rows: value.rows.length,
    })),
  };
}

function clearFixtureCaches(internal: Internal): void {
  // Direct fixture INSERTs bypass real write hooks; activation or the sample
  // upload may already have warmed complete caches of the pre-fixture state.
  internal.realtimeEntryQueries.clear();
  internal.realtimeDeviceStatusQueries.clear();
  internal.recentTreatmentQueries.clear();
  internal.boundedTreatmentQueries.clear();
  for (const cache of Object.values(internal.realtimeAuxiliaryQueries)) cache.clear();
}

describe("canonical entry body cache size and repeated read budget", () => {
  it("compares actual v1 canonical bodies with compact historical fixture bodies", async () => {
    const reports = [];
    for (const shape of ["compact-fixture", "actual-putEntries-canonical"] as const) {
      const stub = env.ENTRY_STORE.getByName(`entry-canonical-size-${shape}-${crypto.randomUUID()}`);
      const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        const internal = instance as unknown as Internal;
        try {
          // Obtain the template from the real mutation boundary, rather than
          // guessing which normalization or canonical fields uploads acquire.
          expect((await instance.putEntries(parseEntryPayload([{
            date: now, dateString: new Date(now).toISOString(),
            sgv: 120, type: "sgv", device: "synthetic-cgm",
          }]))).inserted).toBe(1);
          const original = state.storage.sql.exec<Row>(
            "SELECT id, body, sort_time FROM documents WHERE collection = 'entries' LIMIT 1",
          ).one();
          const canonical = JSON.parse(original.body) as Record<string, unknown>;
          let cachedRowBytes = 0;
          let storedBodyBytes = 0;
          state.storage.transactionSync(() => {
            state.storage.sql.exec("DELETE FROM documents WHERE collection = 'entries'");
            for (let n = 0; n < HISTORY_ROWS; n++) {
              const at = now - (HISTORY_ROWS - n) * FIVE_MINUTES;
              const id = n.toString(16).padStart(24, "0");
              const dateString = new Date(at).toISOString();
              const document = shape === "actual-putEntries-canonical"
                ? { ...canonical, _id: id, date: at, dateString, sysTime: dateString }
                : { _id: id, device: "synthetic-cgm", type: "sgv", sgv: 120, date: at, dateString };
              const row = { id, body: JSON.stringify(document), sort_time: at };
              cachedRowBytes += JSON.stringify(row).length * 2;
              storedBodyBytes += row.body.length * 2;
              state.storage.sql.exec(`INSERT INTO documents
                (collection,id,body,sort_time,created_at,updated_at)
                VALUES('entries',?,?,?,?,?)`, id, row.body, at, at, at);
            }
          });
          clearFixtureCaches(internal);
          const execute = state.storage.sql.exec.bind(state.storage.sql);
          const phases = [];
          for (const mode of ["root", "properties"] as const) {
            // Isolate the 64-row properties cache from root's 1,000-row peek.
            internal.realtimeEntryQueries.clear();
            const repeats = [];
            let previous: unknown;
            for (let repeat = 0; repeat < 3; repeat++) {
              const cursors: { sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
              const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...bindings) => {
                const cursor = execute(sql, ...bindings);
                cursors.push({ sql, cursor });
                return cursor;
              });
              let result: { sgvs: unknown[] };
              try {
                result = mode === "root"
                  ? internal.realtimeSnapshot(now, false, "root")
                  : internal.pluginPropertyContext(now);
              } finally { spy.mockRestore(); }
              expect(result.sgvs).toHaveLength(mode === "root" ? HISTORY_ROWS : 64);
              if (repeat > 0) expect(result).toEqual(previous);
              previous = result;
              const entryWindows = cursors.filter(({ sql }) => sql.includes("collection = 'entries'")
                && sql.includes("sort_time >= ?") && !sql.includes("AND id = ?"));
              repeats.push({ repeat,
                reads: cursors.reduce((sum, { cursor }) => sum + cursor.rowsRead, 0),
                entryRangeReads: entryWindows.reduce((sum, { cursor }) => sum + cursor.rowsRead, 0),
                entryRangeCalls: entryWindows.length,
                cache: cacheState(internal.realtimeEntryQueries),
              });
            }
            phases.push({ mode, repeats });
          }
          return { shape, sourceCanonicalBodyKeys: Object.keys(canonical).sort(),
            sourceCanonicalBodyBytes: original.body.length * 2,
            sourceCanonicalCacheRowBytes: JSON.stringify(original).length * 2,
            seededRows: HISTORY_ROWS, storedBodyBytes, expectedUnprojectedCacheBytes: cachedRowBytes,
            capBytes: 512 * 1024, phases };
        } finally { clock.mockRestore(); }
      });
      reports.push(report);
    }
    console.info(`ENTRY_CANONICAL_SIZE_READ_BUDGET=${JSON.stringify(reports)}`);
    // These checks stay about actual observable reuse. The diagnostic includes
    // exact body/cache bytes and absent query keys if a capacity cliff occurs.
    for (const report of reports) for (const phase of report.phases) {
      expect(phase.repeats[0]!.entryRangeCalls).toBeGreaterThan(0);
      expect(phase.repeats[1]!.entryRangeReads, `${report.shape}/${phase.mode}`).toBeLessThan(40);
      expect(phase.repeats[2]!.entryRangeReads, `${report.shape}/${phase.mode}`).toBeLessThan(40);
    }
  }, 30_000);
});
