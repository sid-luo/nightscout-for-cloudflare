import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import * as codec from "../src/realtime/raw-row-codec";
import { normalizeRealtimeDocument } from "../src/realtime/ddata-snapshot";
import type { EntryStore } from "../src/entry-store";

interface Row extends Record<string, SqlStorageValue> { id: string; body: string; sort_time: number }
interface CachedWindow { bytes: number; rows: codec.PackedSqlRow<Row>[] }
interface Internal {
  pluginPropertyContext(now: number): { treatments: Record<string, unknown>[] };
  boundedTreatmentQueries: {
    clear(): void;
    read(key: string, lower: number, upper: number, load: () => Iterable<Row>, nextFuture: () => number): IterableIterator<Row>;
    entries: Map<string, CachedWindow>;
    bytes: number;
  };
  realtimeEntryQueries: { clear(): void };
  realtimeDeviceStatusQueries: { clear(): void };
  recentTreatmentQueries: { clear(): void };
  realtimeAuxiliaryQueries: Record<string, { clear(): void }>;
}
const REPEATS = 100;
const ROWS = 1000;
const CANONICAL = 144;
const CAP = 512 * 1024;
const id = (n: number) => n.toString(16).padStart(24, "0");
const originalPack = codec.packSqlRow;
const originalUnpack = codec.unpackSqlRow;

function clear(internal: Internal): void {
  internal.boundedTreatmentQueries.clear();
  internal.realtimeEntryQueries.clear();
  internal.realtimeDeviceStatusQueries.clear();
  internal.recentTreatmentQueries.clear();
  for (const cache of Object.values(internal.realtimeAuxiliaryQueries)) cache.clear();
}

describe("actual workerd treatment-window codec CPU diagnostic", () => {
  it("compares current versus forced-raw packing over the identical genuine canonical Note fixture", async () => {
    const stub = env.ENTRY_STORE.getByName(`cache-compression-cpu-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const internal = instance as unknown as Internal;
      const cache = internal.boundedTreatmentQueries;
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        expect(await instance.createLegacyTreatments(JSON.stringify([{
          _id: "f".repeat(24), eventType: "Note", created_at: new Date(now).toISOString(),
        }]))).toMatchObject({ ok: true });
        const source = state.storage.sql.exec<Row>(
          "SELECT id,body,sort_time FROM documents WHERE collection='treatments' LIMIT 1",
        ).one();
        const canonical = JSON.parse(source.body) as Record<string, unknown>;
        state.storage.transactionSync(() => {
          state.storage.sql.exec("DELETE FROM documents WHERE collection='treatments'");
          for (let n = 0; n < ROWS; n++) {
            const at = now - (ROWS - n) * 60_000;
            const document = n >= ROWS - CANONICAL
              ? { ...canonical, _id: id(n), created_at: new Date(at).toISOString() }
              : { _id: id(n), created_at: new Date(at).toISOString(), eventType: "Note" };
            state.storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
              VALUES('treatments',?,?,?,?,?)`, id(n), JSON.stringify(document), at, at, at);
          }
        });
        clear(internal);
        // Independently select every row with the unmodified loader's full
        // SQL ordering/window, and normalize its original canonical body.
        const rawRows = state.storage.sql.exec<Row>(`SELECT id,body,sort_time FROM (
          SELECT id,body,sort_time,updated_at FROM documents
          WHERE collection='treatments' AND sort_time>=? AND sort_time<=?
          ORDER BY sort_time DESC,updated_at DESC,id ASC LIMIT 1000
        ) ORDER BY sort_time ASC,id ASC`, now - 2.5 * 86_400_000, now).toArray();
        expect(rawRows).toHaveLength(ROWS);
        const treatmentOracle = rawRows.map(row => normalizeRealtimeDocument({ ...JSON.parse(row.body), _id: row.id }));
        // Build a complete response oracle with the real private method, but
        // bypass its treatment-window cache so every loader uses original SQL.
        const bypass = vi.spyOn(cache, "read").mockImplementation((_key, _lower, _upper, load) => load()[Symbol.iterator]() as IterableIterator<Row>);
        let oracle: ReturnType<Internal["pluginPropertyContext"]>;
        try { oracle = internal.pluginPropertyContext(now); }
        finally { bypass.mockRestore(); }
        expect(oracle.treatments).toEqual(treatmentOracle);
        const serializedOracle = JSON.stringify(oracle);
        const execute = state.storage.sql.exec.bind(state.storage.sql);
        const variants = [];
        for (const mode of ["current", "forced-raw"] as const) {
          clear(internal);
          let packCalls = 0, compressionAttempts = 0, compressedRows = 0, unpackCalls = 0, inflateCalls = 0;
          let phase: "cold" | "warm" = "cold";
          const executed: { phase: string; sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
          let packSpy: ReturnType<typeof vi.spyOn> | undefined;
          let unpackSpy: ReturnType<typeof vi.spyOn> | undefined;
          try {
            packSpy = vi.spyOn(codec, "packSqlRow").mockImplementation(function <Row extends object>(row: Row, compress = true) {
              packCalls++;
              const enabled = mode === "forced-raw" ? false : compress;
              const body = (row as Record<string, unknown>).body;
              if (enabled && typeof body === "string" && body.length >= 128 && body.length <= 65_536) compressionAttempts++;
              const packed = originalPack(row, enabled);
              if (packed?.compressedBody !== undefined) compressedRows++;
              return packed;
            });
            unpackSpy = vi.spyOn(codec, "unpackSqlRow").mockImplementation(function <Row extends object>(packed: codec.PackedSqlRow<Row>) {
              unpackCalls++;
              if (packed.compressedBody !== undefined) inflateCalls++;
              return originalUnpack(packed);
            });
          } catch (error) {
            packSpy?.mockRestore(); unpackSpy?.mockRestore();
            throw new Error(`CODEC_SPY_UNAVAILABLE: actual-workerd CPU comparison stopped: ${String(error)}`);
          }
          const sqlSpy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...bindings) => {
            const cursor = execute(sql, ...bindings); executed.push({ phase, sql, cursor }); return cursor;
          });
          try {
            const coldStart = performance.now();
            const cold = internal.pluginPropertyContext(now);
            const coldMs = performance.now() - coldStart;
            expect(JSON.stringify(cold)).toBe(serializedOracle);
            // A namespace spy that does not reach the statically imported
            // production binding cannot support this comparison: stop, do not
            // silently report two runs of the same packing configuration.
            expect(packCalls, "CODEC_SPY_NOT_INTERCEPTED: stop this comparison").toBeGreaterThanOrEqual(ROWS);
            expect(compressionAttempts, "normal mixed Notes never reach the 128-unit compression gate").toBe(0);
            expect(compressedRows).toBe(0);
            const coldCodec = { packCalls, compressionAttempts, compressedRows, unpackCalls, inflateCalls };
            packCalls = compressionAttempts = compressedRows = unpackCalls = inflateCalls = 0;
            phase = "warm";
            let warmMs = 0;
            for (let repeat = 0; repeat < REPEATS; repeat++) {
              const started = performance.now();
              const response = internal.pluginPropertyContext(now);
              warmMs += performance.now() - started;
              // Full comparisons/serialization stay outside the measured
              // interval; retain no collection of 100 response object trees.
              expect(JSON.stringify(response), `${mode} repeat ${repeat}`).toBe(serializedOracle);
            }
            expect(packCalls).toBe(0);
            expect(unpackCalls).toBeGreaterThanOrEqual(REPEATS * ROWS);
            expect(inflateCalls).toBe(0);
            const window = [...cache.entries].find(([key]) => key.includes("LIMIT 1000"));
            expect(window).toBeDefined();
            const [key, entry] = window!;
            const metadataBytes = 256 + 2 * key.length;
            const rawRowBytes = rawRows.reduce((sum, row) => sum + originalPack(row, false)!.bytes, 0);
            const packedRows = rawRows.map(row => originalPack(row));
            const packedRowBytes = packedRows.reduce((sum, row) => sum + row!.bytes, 0);
            const dictionaryBytes = packedRows.some(row => row!.compressedBody !== undefined) ? codec.PACKED_SQL_ROW_SHARED_BYTES : 0;
            const rawWindowBytes = metadataBytes + rawRowBytes;
            const packedWindowBytes = metadataBytes + packedRowBytes + dictionaryBytes;
            expect(rawWindowBytes).toBeLessThanOrEqual(CAP);
            expect(dictionaryBytes).toBe(0);
            expect(packedWindowBytes).toBe(rawWindowBytes);
            expect(entry.bytes).toBe(mode === "current" ? packedWindowBytes : rawWindowBytes);
            const warmSql = executed.filter(item => item.phase === "warm");
            const warmWindowSql = warmSql.filter(item => item.sql.includes("collection = 'treatments'") && item.sql.includes("LIMIT 1000"));
            expect(warmWindowSql).toHaveLength(0);
            expect(executed.reduce((sum, item) => sum + item.cursor.rowsWritten, 0)).toBe(0);
            variants.push({ mode, repeats: REPEATS, coldMs, warmMs, warmMsPerCall: warmMs / REPEATS,
              coldCodec, warmCodec: { packCalls, compressionAttempts, compressedRows, unpackCalls, inflateCalls },
              coldReads: executed.filter(item => item.phase === "cold").reduce((sum, item) => sum + item.cursor.rowsRead, 0),
              warmReads: warmSql.reduce((sum, item) => sum + item.cursor.rowsRead, 0), warmWindowCalls: warmWindowSql.length,
              storedBodyBytes: rawRows.reduce((sum, row) => sum + 2 * row.body.length, 0),
              metadataBytes, rawRowBytes, rawWindowBytes, packedRowBytes, dictionaryBytes, packedWindowBytes,
              cacheBytes: cache.bytes, fullWindowCacheBytes: entry.bytes, fullWindowRows: entry.rows.length,
              fullWindowCompressedRows: entry.rows.filter(row => row.compressedBody !== undefined).length });
          } finally { sqlSpy.mockRestore(); packSpy.mockRestore(); unpackSpy.mockRestore(); }
        }
        return { sourceCanonicalBody: source.body, sourceCanonicalBodyCodeUnits: source.body.length,
          canonicalCount: CANONICAL, compactCount: ROWS - CANONICAL, capBytes: CAP,
          responseTreatmentRows: oracle.treatments.length, responseCodeUnits: serializedOracle.length,
          variants, currentToRawWarmRatio: variants[0]!.warmMs / variants[1]!.warmMs };
      } finally { clock.mockRestore(); }
    });
    console.info(`CACHE_COMPRESSION_CPU_AUDIT=${JSON.stringify(report)}`);
  }, 60_000);
});
