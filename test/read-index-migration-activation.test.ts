import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  ENTRY_STORE_ACTIVATION_SEAL,
  entryStoreSchemaIsActivationReady,
  entryStoreSchemaSupportsReadOnly,
  type EntryStore,
} from "../src/entry-store";
import { SqliteDocumentRepository, TREATMENT_READ_INDEX_MIGRATION_LIMIT } from "../src/document-repository";
import { parseEntryPayload } from "../src/model";
import { SqliteRealtimeSessionRepository } from "../src/realtime/session-repository";

const OPTIONS = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false };
const INDEX_NAMES = ["documents_treatments_created_at", "documents_treatments_event_type_created_at"];

function indexes(sql: SqlStorage): string[] {
  return sql.exec<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?) ORDER BY name",
    ...INDEX_NAMES,
  ).toArray().map(row => row.name);
}

function markers(sql: SqlStorage): number[] {
  return sql.exec<{ id: number }>("SELECT id FROM _sql_schema_migrations WHERE id >= 30 ORDER BY id")
    .toArray().map(row => row.id);
}

function preservedState(sql: SqlStorage): string {
  return JSON.stringify({
    documents: sql.exec("SELECT * FROM documents ORDER BY collection, id").toArray(),
    entries: sql.exec("SELECT * FROM entries ORDER BY id").toArray(),
    revisions: sql.exec("SELECT * FROM document_changes ORDER BY change_id").toArray(),
    clocks: sql.exec("SELECT * FROM collection_clocks ORDER BY collection").toArray(),
    sequence: sql.exec("SELECT * FROM sqlite_sequence WHERE name = 'document_changes'").toArray(),
    sessions: sql.exec("SELECT * FROM realtime_sessions ORDER BY sid").toArray(),
    frames: sql.exec("SELECT * FROM realtime_outbound_packets ORDER BY sid, sequence").toArray(),
    root: sql.exec("SELECT * FROM realtime_root_state ORDER BY singleton").toArray(),
  });
}

/** Model an actual fresh 1.3.2 tenant: seal 30 does not require old seal 28. */
function restoreSealedV30(sql: SqlStorage): void {
  for (const name of [...INDEX_NAMES, "documents_devicestatus_recent", "documents_treatments_api3_order"]) sql.exec(`DROP INDEX IF EXISTS ${name}`);
  sql.exec("DELETE FROM _sql_schema_migrations WHERE id >= 31 OR id = 28");
  sql.exec("INSERT OR IGNORE INTO _sql_schema_migrations(id) VALUES (30)");
  expect(markers(sql)).toEqual([30]);
  expect(entryStoreSchemaIsActivationReady(sql)).toBe(false);
}

function seedHistory(storage: DurableObjectStorage, treatmentCount = 24): string {
  const repository = new SqliteDocumentRepository(storage);
  const now = Date.now();
  repository.upsertLegacyEntries(parseEntryPayload([
    { type: "sgv", sgv: 110, date: now - 300_000, device: "synthetic-migration" },
  ]));
  expect(repository.createDocumentForApi3("devicestatus", {
    identifier: "migration-status", app: "synthetic", device: "synthetic-migration", utcOffset: 0,
    date: now, created_at: new Date(now).toISOString(), openaps: { suggested: { predBGs: { IOB: [110, 111] } } },
  }, OPTIONS).ok).toBe(true);
  storage.transactionSync(() => {
    for (let index = 0; index < treatmentCount; index++) {
      expect(repository.createDocumentForApi3("treatments", {
        identifier: `migration-treatment-${index}`, app: "synthetic", utcOffset: 0,
        date: now - index * 60_000, created_at: new Date(now - index * 60_000).toISOString(),
        eventType: index % 2 === 0 ? "Meal Bolus" : "Note", insulin: 1, carbs: 10,
      }, OPTIONS).ok).toBe(true);
    }
    // A second version proves revision history and its allocator stay intact.
    expect(repository.createDocumentForApi3("treatments", {
      identifier: "migration-treatment-0", app: "synthetic", utcOffset: 0,
      date: now, created_at: new Date(now).toISOString(), eventType: "Meal Bolus", insulin: 1, carbs: 11,
    }, OPTIONS).ok).toBe(true);
  });
  const sessions = new SqliteRealtimeSessionRepository(storage);
  const session = sessions.createSession(now);
  sessions.enqueueFrames(session.sid, ["4preserved-read-index-upgrade"], now);
  sessions.replaceRootDataState(JSON.stringify({ syntheticPreservedBaseline: "v30-to-v32" }), now - 1000);
  return session.sid;
}

function measure<T>(sql: SqlStorage, action: () => T) {
  const exec = sql.exec.bind(sql);
  const queries: { statement: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = exec(statement, ...bindings);
    queries.push({ statement: statement.replace(/\s+/g, " ").trim(), cursor });
    return cursor;
  });
  try {
    const result = action();
    return { result, queries: queries.map(({ statement, cursor }) => ({ statement, reads: cursor.rowsRead, writes: cursor.rowsWritten })) };
  } finally { spy.mockRestore(); }
}

function initialize(instance: EntryStore): void {
  (instance as unknown as { completeStorageInitialization(): void }).completeStorageInitialization();
}

function expectNoCoreBackfill(statements: string[]): void {
  for (const statement of statements) {
    expect(statement).not.toMatch(/\b(?:INSERT(?: OR \w+)? INTO|UPDATE|DELETE FROM)\s+(?:documents|entries|document_changes|collection_clocks|realtime_root_state)\b/i);
  }
}

describe("optional v31 read indexes through EntryStore activation", () => {
  it("upgrades sealed v30 without old marker 28, preserving all history and baseline across eviction", async () => {
    const stub = env.ENTRY_STORE.getByName(`read-index-v31-activation-${crypto.randomUUID()}`);
    const expected = await runInDurableObject(stub, (instance: EntryStore, state) => {
      const sql = state.storage.sql;
      const sid = seedHistory(state.storage);
      restoreSealedV30(sql);
      const before = preservedState(sql);
      const work = measure(sql, () => initialize(instance));
      expectNoCoreBackfill(work.queries.map(query => query.statement));
      expect(indexes(sql)).toEqual(INDEX_NAMES);
      expect(markers(sql)).toEqual([30, 31, 33, ENTRY_STORE_ACTIVATION_SEAL]);
      expect(ENTRY_STORE_ACTIVATION_SEAL).toBe(34);
      expect(entryStoreSchemaIsActivationReady(sql)).toBe(true);
      expect(entryStoreSchemaSupportsReadOnly(sql)).toBe(true);
      expect(preservedState(sql)).toBe(before);
      const repository = new SqliteDocumentRepository(state.storage);
      const cold = measure(sql, () => repository.queryLegacyTreatments({ limit: 1, filters: [
        { field: "eventType", operator: "eq", value: "Meal Bolus" },
      ] }));
      expect(cold.result).toHaveLength(1);
      expect(cold.result[0]!.carbs).toBe(11);
      expect(cold.queries.reduce((sum, query) => sum + query.reads, 0)).toBeLessThan(50);
      // A sealed reactivation must neither reevaluate/build indexes nor insert
      // any migration marker. Core state fingerprints detect any backfill.
      sql.exec(`CREATE TRIGGER reject_repeated_read_index_activation BEFORE INSERT ON _sql_schema_migrations
        BEGIN SELECT RAISE(ABORT, 'sealed read-index activation attempted a migration'); END`);
      return { before, sid };
    });
    await evictDurableObject(stub);
    expect(JSON.parse(await stub.nightscoutHttpStatus(Date.now())).status).toBe("ok");
    await runInDurableObject(stub, (_instance: EntryStore, state) => {
      expect(indexes(state.storage.sql)).toEqual(INDEX_NAMES);
      expect(preservedState(state.storage.sql)).toBe(expected.before);
      expect(new SqliteRealtimeSessionRepository(state.storage).peekFrames(expected.sid)?.frames)
        .toEqual(["4preserved-read-index-upgrade"]);
    });
  });

  it("upgrades the prior local seal 32 and rolls optional v33 indexes back with their marker", async () => {
    const stub = env.ENTRY_STORE.getByName(`cold-index-v33-marker-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (instance: EntryStore, state) => {
      const sql = state.storage.sql;
      seedHistory(state.storage);
      sql.exec("DROP INDEX documents_devicestatus_recent");
      sql.exec("DROP INDEX documents_treatments_api3_order");
      sql.exec("DELETE FROM _sql_schema_migrations WHERE id IN (33, ?)", ENTRY_STORE_ACTIVATION_SEAL);
      sql.exec("INSERT INTO _sql_schema_migrations(id) VALUES(32)");
      const before = preservedState(sql);
      sql.exec(`CREATE TRIGGER fail_cold_index_marker BEFORE INSERT ON _sql_schema_migrations
        WHEN NEW.id = 33 BEGIN SELECT RAISE(ABORT, 'synthetic cold-index marker failure'); END`);
      expect(() => initialize(instance)).toThrow("synthetic cold-index marker failure");
      expect(sql.exec("PRAGMA index_info(documents_devicestatus_recent)").toArray()).toEqual([]);
      expect(sql.exec("PRAGMA index_info(documents_treatments_api3_order)").toArray()).toEqual([]);
      expect(entryStoreSchemaIsActivationReady(sql)).toBe(false);
      expect(preservedState(sql)).toBe(before);
      sql.exec("DROP TRIGGER fail_cold_index_marker");
      const recovery = measure(sql, () => initialize(instance));
      expectNoCoreBackfill(recovery.queries.map(query => query.statement));
      expect(markers(sql)).toEqual([31, 32, 33, ENTRY_STORE_ACTIVATION_SEAL]);
      expect(entryStoreSchemaIsActivationReady(sql)).toBe(true);
      expect(preservedState(sql)).toBe(before);
    });
  });

  it("rolls index creation back if marker 31 fails, then recovers on the same instance", async () => {
    const stub = env.ENTRY_STORE.getByName(`read-index-v31-marker-retry-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const sql = state.storage.sql;
      seedHistory(state.storage);
      restoreSealedV30(sql);
      const before = preservedState(sql);
      sql.exec(`CREATE TRIGGER fail_read_index_marker BEFORE INSERT ON _sql_schema_migrations
        WHEN NEW.id = 31 BEGIN SELECT RAISE(ABORT, 'synthetic read-index marker failure'); END`);
      expect(() => initialize(instance)).toThrow("synthetic read-index marker failure");
      expect(indexes(sql)).toEqual([]);
      expect(markers(sql)).toEqual([30]);
      expect(entryStoreSchemaIsActivationReady(sql)).toBe(false);
      expect(preservedState(sql)).toBe(before);
      // A quota failure can leave the old schema serving reads before the
      // next reset. Do not force an index that was rolled back with marker 31.
      expect(JSON.parse(await instance.getPluginPropertyContextJson(Date.now()))).toHaveProperty("treatments");
      expect(JSON.parse(instance.nightscoutHttpStatus(Date.now())).status).toBe("ok");
      sql.exec("DROP TRIGGER fail_read_index_marker");
      initialize(instance);
      expect(indexes(sql)).toEqual(INDEX_NAMES);
      expect(markers(sql)).toEqual([30, 31, 33, ENTRY_STORE_ACTIVATION_SEAL]);
      expect(entryStoreSchemaIsActivationReady(sql)).toBe(true);
      expect(preservedState(sql)).toBe(before);
    });
  });

  it("keeps committed indexes when the activation seal fails and retries without DDL or backfill", async () => {
    const stub = env.ENTRY_STORE.getByName(`read-index-v31-seal-retry-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (instance: EntryStore, state) => {
      const sql = state.storage.sql;
      seedHistory(state.storage);
      restoreSealedV30(sql);
      const before = preservedState(sql);
      sql.exec(`CREATE TRIGGER fail_read_index_seal BEFORE INSERT ON _sql_schema_migrations
        WHEN NEW.id = ${ENTRY_STORE_ACTIVATION_SEAL} BEGIN SELECT RAISE(ABORT, 'synthetic read-index seal failure'); END`);
      expect(() => initialize(instance)).toThrow("synthetic read-index seal failure");
      expect(indexes(sql)).toEqual(INDEX_NAMES);
      expect(markers(sql)).toEqual([30, 31, 33]);
      expect(entryStoreSchemaIsActivationReady(sql)).toBe(false);
      expect(preservedState(sql)).toBe(before);
      sql.exec("DROP TRIGGER fail_read_index_seal");
      const retry = measure(sql, () => initialize(instance));
      expectNoCoreBackfill(retry.queries.map(query => query.statement));
      expect(retry.queries.some(query => /\b(?:CREATE|DROP) INDEX\b/i.test(query.statement))).toBe(false);
      expect(markers(sql)).toEqual([30, 31, 33, ENTRY_STORE_ACTIVATION_SEAL]);
      expect(entryStoreSchemaIsActivationReady(sql)).toBe(true);
      expect(preservedState(sql)).toBe(before);
    });
  });

  it("seals histories above 20000 treatments without optional indexes and keeps old reads and writes usable", async () => {
    const stub = env.ENTRY_STORE.getByName(`read-index-v31-large-history-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const sql = state.storage.sql;
      seedHistory(state.storage, 1);
      restoreSealedV30(sql);
      const extra = TREATMENT_READ_INDEX_MIGRATION_LIMIT;
      sql.exec(`WITH RECURSIVE sequence(n) AS (
        VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
      ) INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
        SELECT 'treatments', printf('%024x', n),
          '{"created_at":"2026-10-18T00:00:00.000Z","eventType":"Synthetic Legacy Note"}', n, n, n
        FROM sequence`, extra);
      expect(sql.exec<{ count: number }>("SELECT count(*) AS count FROM documents WHERE collection='treatments'").one().count)
        .toBe(TREATMENT_READ_INDEX_MIGRATION_LIMIT + 1);
      const before = preservedState(sql);
      const work = measure(sql, () => initialize(instance));
      expectNoCoreBackfill(work.queries.map(query => query.statement));
      expect(work.queries.filter(query => /\bCREATE INDEX\b/i.test(query.statement))
        .every(query => query.statement.includes("treatment_read_side_") || query.statement.includes("documents_devicestatus_recent"))).toBe(true);
      expect(sql.exec("SELECT * FROM treatment_read_side_keys").toArray()).toEqual([]);
      expect(sql.exec<{ read_complete: number }>("SELECT read_complete FROM treatment_read_side_state").one().read_complete).toBe(0);
      expect(indexes(sql)).toEqual([]);
      expect(markers(sql)).toEqual([30, 31, 33, ENTRY_STORE_ACTIVATION_SEAL]);
      expect(entryStoreSchemaIsActivationReady(sql)).toBe(true);
      expect(entryStoreSchemaSupportsReadOnly(sql)).toBe(true);
      expect(preservedState(sql)).toBe(before);
      const repository = new SqliteDocumentRepository(state.storage);
      expect(repository.queryLegacyTreatments({ limit: 1, filters: [
        { field: "eventType", operator: "eq", value: "Synthetic Legacy Note" },
      ] })).toHaveLength(1);
      const created = JSON.parse(await instance.api3CreateDocument("treatments", JSON.stringify({
        identifier: "after-deferred-index", app: "synthetic", utcOffset: 0,
        date: Date.now() + 60_000, created_at: new Date(Date.now() + 60_000).toISOString(), eventType: "Sensor Change",
      }), JSON.stringify(OPTIONS)));
      expect(created).toMatchObject({ ok: true });
      expect(repository.queryLegacyTreatments({ limit: 1, filters: [
        { field: "eventType", operator: "eq", value: "Sensor Change" },
      ] }).map(document => document.identifier)).toEqual(["after-deferred-index"]);
      expect(indexes(sql)).toEqual([]);
      expect(markers(sql)).toEqual([30, 31, 33, ENTRY_STORE_ACTIVATION_SEAL]);
    });
  }, 30_000);
});
