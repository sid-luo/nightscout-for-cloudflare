import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { packSqlRow, PACKED_SQL_ROW_SHARED_BYTES } from "../src/realtime/raw-row-codec";
import type { EntryStore } from "../src/entry-store";

interface Row extends Record<string, SqlStorageValue> { id: string; body: string; sort_time: number }
interface Internal {
  pluginPropertyContext(now: number): { treatments: unknown[] };
  boundedTreatmentQueries: {
    clear(): void;
    entries: Map<string, { bytes: number; rows: Row[]; lower: number; upper: number }>;
    bytes: number;
  };
  realtimeEntryQueries: { clear(): void };
  realtimeDeviceStatusQueries: { clear(): void };
  recentTreatmentQueries: { clear(): void };
  realtimeAuxiliaryQueries: Record<string, { clear(): void }>;
}

describe("canonical treatment body cache size and repeated read budget", () => {
  it("compares 1000 compact Notes against 144 actual canonical uploads plus 856 compact Notes", async () => {
    const reports = [];
    for (const canonicalCount of [0, 144]) {
      const stub = env.ENTRY_STORE.getByName(`treatment-canonical-size-${canonicalCount}-${crypto.randomUUID()}`);
      const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        const internal = instance as unknown as Internal;
        const cache = internal.boundedTreatmentQueries;
        try {
          expect(await instance.createLegacyTreatments(JSON.stringify([{
            _id: "f".repeat(24), eventType: "Note", created_at: new Date(now).toISOString(),
          }]))).toMatchObject({ ok: true });
          const source = state.storage.sql.exec<Row>(
            "SELECT id, body, sort_time FROM documents WHERE collection = 'treatments' LIMIT 1",
          ).one();
          const canonical = JSON.parse(source.body) as Record<string, unknown>;
          let storedBodyBytes = 0;
          let expectedRowBudget = 0;
          let usesDictionary = false;
          state.storage.transactionSync(() => {
            state.storage.sql.exec("DELETE FROM documents WHERE collection = 'treatments'");
            for (let n = 0; n < 1000; n++) {
              const at = now - (1000 - n) * 60_000;
              const id = n.toString(16).padStart(24, "0");
              const document = n >= 1000 - canonicalCount
                ? { ...canonical, _id: id, created_at: new Date(at).toISOString() }
                : { _id: id, created_at: new Date(at).toISOString(), eventType: "Note" };
              const row = { id, body: JSON.stringify(document), sort_time: at };
              const packed = packSqlRow(row)!;
              expectedRowBudget += packed.bytes;
              usesDictionary ||= packed.compressedBody !== undefined;
              storedBodyBytes += row.body.length * 2;
              state.storage.sql.exec(`INSERT INTO documents
                (collection,id,body,sort_time,created_at,updated_at)
                VALUES('treatments',?,?,?,?,?)`, id, row.body, at, at, at);
            }
          });
          // SQL fixture changes intentionally bypass production write hooks.
          cache.clear();
          internal.realtimeEntryQueries.clear();
          internal.realtimeDeviceStatusQueries.clear();
          internal.recentTreatmentQueries.clear();
          for (const auxiliary of Object.values(internal.realtimeAuxiliaryQueries)) auxiliary.clear();
          const execute = state.storage.sql.exec.bind(state.storage.sql);
          const repeats = [];
          let previous: unknown;
          let expectedKeyBudget = 0;
          for (let repeat = 0; repeat < 3; repeat++) {
            const captured: { sql: string; bindings: SqlStorageValue[];
              cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
            const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...bindings) => {
              const cursor = execute(sql, ...bindings);
              captured.push({ sql, bindings, cursor });
              return cursor;
            });
            let result: { treatments: unknown[] };
            try { result = internal.pluginPropertyContext(now); }
            finally { spy.mockRestore(); }
            expect(result.treatments).toHaveLength(1000);
            if (repeat > 0) expect(result).toEqual(previous);
            previous = result;
            const treatmentSql = captured.filter(({ sql }) => sql.includes("collection = 'treatments'"));
            const fullWindow = treatmentSql.filter(({ sql }) => sql.includes("LIMIT 1000"));
            const firstWindow = fullWindow[0];
            if (firstWindow !== undefined) {
              expectedKeyBudget = 256 + 2 * JSON.stringify([
                firstWindow.sql, firstWindow.bindings.slice(0, -2),
              ]).length;
            }
            repeats.push({ repeat,
              reads: captured.reduce((sum, { cursor }) => sum + cursor.rowsRead, 0),
              treatmentReads: treatmentSql.reduce((sum, { cursor }) => sum + cursor.rowsRead, 0),
              fullWindowReads: fullWindow.reduce((sum, { cursor }) => sum + cursor.rowsRead, 0),
              dataSql: treatmentSql.map(({ sql, cursor }) => ({
                sql: sql.replace(/\s+/g, " ").trim(), reads: cursor.rowsRead,
              })),
              cache: { bytes: cache.bytes, ready: cache.entries.size > 0,
                entries: [...cache.entries].map(([key, entry]) => ({ key, bytes: entry.bytes,
                  rows: entry.rows.length, lower: entry.lower, upper: entry.upper })),
              },
            });
          }
          return { canonicalCount, compactCount: 1000 - canonicalCount,
            canonicalKeys: Object.keys(canonical).sort(), canonicalBody: source.body,
            sourceCanonicalBodyBytes: source.body.length * 2, storedBodyBytes,
            expectedRowBudget, expectedKeyBudget,
            expectedFullWindowCacheBytes: expectedRowBudget + expectedKeyBudget + (usesDictionary ? PACKED_SQL_ROW_SHARED_BYTES : 0),
            capBytes: 512 * 1024, repeats };
        } finally { clock.mockRestore(); }
      });
      reports.push(report);
    }
    console.info(`TREATMENT_CANONICAL_SIZE_READ_BUDGET=${JSON.stringify(reports)}`);
    for (const report of reports) {
      expect(report.repeats[0]!.fullWindowReads).toBeGreaterThan(0);
      expect(report.repeats[1]!.fullWindowReads, `canonical=${report.canonicalCount}`).toBe(0);
      expect(report.repeats[2]!.fullWindowReads, `canonical=${report.canonicalCount}`).toBe(0);
    }
  }, 30_000);
});
