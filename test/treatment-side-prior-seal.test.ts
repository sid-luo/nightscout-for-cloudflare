import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ENTRY_STORE_ACTIVATION_SEAL, entryStoreSchemaIsActivationReady, type EntryStore } from "../src/entry-store";
import { DurableObjectWriteQuotaError } from "../src/platform-errors";
import { readState, TREATMENT_READ_SIDE_TABLE as KEYS } from "../src/treatment-read-side-index";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const RESET = Date.parse("2026-10-19T00:00:00.000Z");

function seed(sql: SqlStorage, count = 130): void {
  sql.exec(`WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n < ?)
    INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
    SELECT 'treatments',printf('%024x',n),json_object('created_at','2026-10-18T12:00:00.000Z',
      'eventType','Note','notes','prior-seal fixture'),?+n,?,?,1 FROM sequence`, count, AT, AT, AT);
}

function nativeAbsent(sql: SqlStorage): void {
  sql.exec("DROP INDEX documents_treatments_created_at");
  sql.exec("DROP INDEX documents_treatments_event_type_created_at");
  expect(readState(sql)).toBeNull();
  expect(sql.exec<{ id: number }>("SELECT id FROM _sql_schema_migrations WHERE id IN (31,?) ORDER BY id",
    ENTRY_STORE_ACTIVATION_SEAL).toArray().map(row => row.id)).toEqual([31, ENTRY_STORE_ACTIVATION_SEAL]);
  // This existing activation seal bypasses migrations. A public driver must
  // discover the optional missing side schema independently of migration31.
  expect(entryStoreSchemaIsActivationReady(sql)).toBe(true);
}

function canonical(sql: SqlStorage): string {
  return JSON.stringify({
    documents: sql.exec("SELECT * FROM documents ORDER BY collection,id").toArray(),
    changes: sql.exec("SELECT * FROM document_changes ORDER BY change_id").toArray(),
    clocks: sql.exec("SELECT * FROM collection_clocks ORDER BY collection").toArray(),
    markers: sql.exec("SELECT * FROM _sql_schema_migrations ORDER BY id").toArray(),
  });
}

function sideCount(sql: SqlStorage): number {
  return sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${KEYS}`).one().count;
}

describe("side schema recovery from an already sealed migration31 store", () => {
  it("initializes only empty structures then advances 64 source keys on its first public read", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-prior-seal-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const sql = state.storage.sql;
      nativeAbsent(sql);
      seed(sql);
      const before = canonical(sql);
      const clock = vi.spyOn(Date, "now").mockReturnValue(AT);
      try {
        const result = JSON.parse(await instance.api3QueryTreatments('{"limit":1}'));
        expect(result).toMatchObject({ ok: true });
        expect(result.result).toHaveLength(1);
        expect(readState(sql)).toMatchObject({ complete: false, cursor: (64).toString(16).padStart(24, "0"),
          budgetRows: 64, lastRunAt: AT });
        expect(sideCount(sql)).toBe(64);
        expect(canonical(sql)).toBe(before);
        await instance.api3QueryTreatments('{"limit":1}');
        expect(sideCount(sql)).toBe(64);
      } finally { clock.mockRestore(); }
    });
  });

  it("performs only zero-read/zero-write schema probes on an ordinary native sealed store", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-native-unneeded-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const sql = state.storage.sql;
      expect(readState(sql)).toBeNull();
      seed(sql, 3);
      const before = canonical(sql);
      const execute = sql.exec.bind(sql);
      const cursors: { statement: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
      let nativeChecks = 0;
      const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
        if (/^PRAGMA index_info\(documents_treatments_(created_at|event_type_created_at)\)$/.test(statement)) nativeChecks++;
        const cursor = execute(statement, ...bindings); cursors.push({ statement, cursor }); return cursor;
      });
      try {
        expect(JSON.parse(await instance.api3QueryTreatments('{"limit":1}'))).toMatchObject({ ok: true });
        expect(nativeChecks).toBe(2);
        for (let repeated = 0; repeated < 3; repeated++) {
          expect(JSON.parse(await instance.api3QueryTreatments('{"limit":1}'))).toMatchObject({ ok: true });
        }
        expect(nativeChecks).toBe(8);
        expect(cursors.reduce((sum, item) => sum + item.cursor.rowsWritten, 0)).toBe(0);
        const probes = cursors.filter(item => item.statement.startsWith("PRAGMA"));
        expect(probes.reduce((sum, item) => sum + item.cursor.rowsRead, 0)).toBe(0);
      } finally { spy.mockRestore(); }
      expect(readState(sql)).toBeNull();
      expect(canonical(sql)).toBe(before);
    });
  });

  it("rolls an empty-schema quota failure back and discovers the committed schema again after reset", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-schema-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const sql = state.storage.sql;
      nativeAbsent(sql);
      seed(sql);
      const before = canonical(sql);
      let at = AT, attempts = 0, fail = true;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => at);
      const execute = sql.exec.bind(sql);
      const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
        const cursor = execute(statement, ...bindings);
        if (statement.includes("CREATE TRIGGER IF NOT EXISTS treatment_read_side_update")) {
          attempts++;
          if (fail) throw new DurableObjectWriteQuotaError();
        }
        return cursor;
      });
      try {
        expect(JSON.parse(await instance.api3QueryTreatments('{"limit":1}'))).toMatchObject({ ok: true });
        expect(attempts).toBe(1);
        expect(readState(sql)).toBeNull();
        expect(sql.exec<{ name: string }>(`SELECT name FROM sqlite_master
          WHERE name LIKE 'treatment_read_side_%'`).toArray()).toEqual([]);
        expect(canonical(sql)).toBe(before);
        fail = false;
        at = RESET - 1;
        await instance.api3QueryTreatments('{"limit":1}');
        expect(attempts).toBe(1);
        expect(readState(sql)).toBeNull();
        at = RESET;
        expect(JSON.parse(await instance.api3QueryTreatments('{"limit":1}'))).toMatchObject({ ok: true });
        expect(attempts).toBe(2);
        expect(readState(sql)).toMatchObject({ complete: false, budgetRows: 64, lastRunAt: RESET });
        expect(sideCount(sql)).toBe(64);
        expect(canonical(sql)).toBe(before);
      } finally { spy.mockRestore(); clock.mockRestore(); }
    });
  });
});
