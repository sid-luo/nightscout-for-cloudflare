import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ENTRY_STORE_ACTIVATION_SEAL, entryStoreSchemaIsActivationReady, entryStoreSchemaSupportsReadOnly, type EntryStore, type JsonDocument } from "../src/entry-store";
import { SqliteDocumentRepository } from "../src/document-repository";
import { SqliteRealtimeSessionRepository } from "../src/realtime/session-repository";

function preservedState(sql: SqlStorage): string {
  return JSON.stringify({
    documents: sql.exec("SELECT * FROM documents ORDER BY collection, id").toArray(),
    entries: sql.exec("SELECT * FROM entries ORDER BY id").toArray(),
    changes: sql.exec("SELECT * FROM document_changes ORDER BY change_id").toArray(),
    clocks: sql.exec("SELECT * FROM collection_clocks ORDER BY collection").toArray(),
    sequence: sql.exec("SELECT * FROM sqlite_sequence WHERE name = 'document_changes'").toArray(),
    sessions: sql.exec("SELECT * FROM realtime_sessions ORDER BY sid").toArray(),
    frames: sql.exec("SELECT * FROM realtime_outbound_packets ORDER BY sid, sequence").toArray(),
    root: sql.exec("SELECT * FROM realtime_root_state ORDER BY singleton").toArray(),
  });
}

function retiredIndexes(sql: SqlStorage): string[] {
  return sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('realtime_outbound_by_session', 'document_changes_collection_history') ORDER BY name")
    .toArray().map((row) => row.name);
}

type InitializationWork = {
  reads: number;
  writes: number;
  queries: { sql: string; reads: number; writes: number }[];
};

/** Measure the real synchronous activation path, excluding fixture/verification SQL. */
function measuredInitialization(instance: EntryStore, sql: SqlStorage, error?: string): InitializationWork {
  const exec = sql.exec.bind(sql);
  const cursors: { sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = exec(statement, ...bindings);
    cursors.push({ sql: statement.replace(/\s+/g, " ").trim(), cursor });
    return cursor;
  });
  try {
    const initialization = instance as unknown as { completeStorageInitialization: () => void };
    if (error) expect(() => initialization.completeStorageInitialization()).toThrow(error);
    else initialization.completeStorageInitialization();
  } finally {
    spy.mockRestore();
  }
  const queries = cursors.map(({ sql, cursor }) => ({ sql, reads: cursor.rowsRead, writes: cursor.rowsWritten }));
  return {
    reads: queries.reduce((sum, query) => sum + query.reads, 0),
    writes: queries.reduce((sum, query) => sum + query.writes, 0),
    queries,
  };
}

function expectNoHistoricalWork(work: InitializationWork): void {
  for (const query of work.queries) {
    // Activation may inspect the latest profile for admin-notification settings.
    // It must not revisit data/ledger history or recompute the realtime baseline.
    expect(query.sql).not.toMatch(/\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:entries|document_changes|collection_clocks|realtime_root_state)\b/i);
    if (/\b(?:FROM|JOIN)\s+documents\b/i.test(query.sql)) {
      expect(query.sql).toContain("WHERE collection = 'profile'");
      expect(query.sql).toMatch(/LIMIT 10$/);
    }
  }
}

function restoreOldSeal(sql: SqlStorage): void {
  sql.exec("CREATE INDEX realtime_outbound_by_session ON realtime_outbound_packets(sid, sequence)");
  sql.exec("CREATE INDEX document_changes_collection_history ON document_changes(collection, srv_modified ASC, change_id ASC)");
  sql.exec("DELETE FROM _sql_schema_migrations WHERE id >= 29");
  sql.exec("INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (28)");
}

function seedHistory(storage: DurableObjectStorage, count: number): void {
  const repository = new SqliteDocumentRepository(storage);
  const now = Date.now();
  const options = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false };
  storage.transactionSync(() => {
    for (let index = 0; index < count; index++) {
      const collection = (["entries", "devicestatus", "treatments"] as const)[index % 3]!;
      const date = now - index * 300_000;
      const payload: JsonDocument = collection === "entries" ? { type: "sgv", sgv: 110 }
        : collection === "devicestatus" ? { openaps: { suggested: { timestamp: new Date(date).toISOString() } } }
          : { eventType: "Meal Bolus", insulin: 1, carbs: 10 };
      expect(repository.createDocumentForApi3(collection, {
        identifier: `synthetic-history-${index}`, date, created_at: new Date(date).toISOString(),
        app: "AAPS", device: "synthetic-v29", utcOffset: 0, ...payload,
      }, options).ok).toBe(true);
    }
  });
  const sessions = new SqliteRealtimeSessionRepository(storage);
  const session = sessions.createSession(now);
  sessions.enqueueFrames(session.sid, ["4pending-history-upgrade"], now);
}

describe("v29 index migration through actual EntryStore activation", () => {
  it("keeps sealed-v28 upgrade work independent of history size and never rebuilds its realtime baseline", async () => {
    const reports: { records: number; work: InitializationWork }[] = [];
    for (const records of [1, 1_000]) {
      const stub = env.ENTRY_STORE.getByName(`index-v29-bounded-${records}-${crypto.randomUUID()}`);
      const work = await runInDurableObject(stub, async (instance: EntryStore, state) => {
        const sql = state.storage.sql;
        seedHistory(state.storage, records);
        restoreOldSeal(sql);
        const before = preservedState(sql);
        const work = measuredInitialization(instance, sql);
        expectNoHistoricalWork(work);
        expect(retiredIndexes(sql)).toEqual([]);
        expect(preservedState(sql)).toBe(before);
        expect(entryStoreSchemaIsActivationReady(sql)).toBe(true);
        return work;
      });
      reports.push({ records, work });
    }
    for (const report of reports) console.log(JSON.stringify({ label: "sealed-v28-upgrade", ...report }));
    expect(reports[1]!.work.reads).toBe(reports[0]!.work.reads);
    expect(reports[1]!.work.writes).toBe(reports[0]!.work.writes);
    expect(reports[1]!.work.queries.map((query) => query.sql)).toEqual(reports[0]!.work.queries.map((query) => query.sql));
  });

  it("retries a failed activation seal after committed v29 without scanning history or rewriting the baseline", async () => {
    const stub = env.ENTRY_STORE.getByName(`index-v29-seal-retry-${crypto.randomUUID()}`);
    const reports = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const sql = state.storage.sql;
      seedHistory(state.storage, 100);
      restoreOldSeal(sql);
      sql.exec(`CREATE TRIGGER fail_activation_seal BEFORE INSERT ON _sql_schema_migrations
        WHEN NEW.id = ${ENTRY_STORE_ACTIVATION_SEAL} BEGIN SELECT RAISE(ABORT, 'synthetic activation seal failure'); END`);
      const before = preservedState(sql);
      const failed = measuredInitialization(instance, sql, "synthetic activation seal failure");
      expectNoHistoricalWork(failed);
      expect(retiredIndexes(sql)).toEqual([]);
      expect(preservedState(sql)).toBe(before);
      expect(entryStoreSchemaIsActivationReady(sql)).toBe(false);
      expect(sql.exec<{ id: number }>("SELECT id FROM _sql_schema_migrations WHERE id >= 29 ORDER BY id").toArray()).toEqual([{ id: 29 }]);

      sql.exec("DROP TRIGGER fail_activation_seal");
      const retry = measuredInitialization(instance, sql);
      expectNoHistoricalWork(retry);
      expect(retry.queries.some((query) => /DROP INDEX/i.test(query.sql))).toBe(false);
      expect(preservedState(sql)).toBe(before);
      expect(entryStoreSchemaIsActivationReady(sql)).toBe(true);
      return { failed, retry };
    });
    console.log(JSON.stringify({ label: "sealed-v28-upgrade-seal-retry", ...reports }));
  });

  it("does full repair when an old seal exists but a required earlier migration marker is missing", async () => {
    const stub = env.ENTRY_STORE.getByName(`index-v29-missing-marker-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const sql = state.storage.sql;
      seedHistory(state.storage, 3);
      restoreOldSeal(sql);
      sql.exec("DELETE FROM _sql_schema_migrations WHERE id = 10");
      const before = preservedState(sql);
      const work = measuredInitialization(instance, sql);
      expect(work.queries.some((query) => /CREATE TABLE IF NOT EXISTS realtime_alarm_connections/i.test(query.sql))).toBe(true);
      expect(sql.exec<{ id: number }>("SELECT id FROM _sql_schema_migrations WHERE id = 10").one().id).toBe(10);
      expect(retiredIndexes(sql)).toEqual([]);
      expect(preservedState(sql)).toBe(before);
      expect(entryStoreSchemaIsActivationReady(sql)).toBe(true);
    });
  });

  it("upgrades an old v28 seal without changing documents, history, clocks or pending polling frames, then remains sealed", async () => {
    const stub = env.ENTRY_STORE.getByName(`index-v29-activation-${crypto.randomUUID()}`);
    const before = await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const sql = state.storage.sql;
      const repository = new SqliteDocumentRepository(state.storage);
      const now = Date.now();
      const options = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false };
      const fixtures: ["entries" | "devicestatus" | "treatments", JsonDocument][] = [
        ["entries", { type: "sgv", sgv: 110 }],
        ["devicestatus", { openaps: { suggested: { timestamp: new Date(now).toISOString(), predBGs: { IOB: [110, 111] } } } }],
        ["treatments", { eventType: "Meal Bolus", insulin: 1, carbs: 10 }],
      ];
      for (const [collection, payload] of fixtures) {
        expect(repository.createDocumentForApi3(collection, {
          identifier: `synthetic-${collection}`, app: "AAPS", device: "synthetic-v29",
          date: now, created_at: new Date(now).toISOString(), utcOffset: 0, ...payload,
        }, options).ok).toBe(true);
      }
      // A second accepted version proves the ledger/allocator survives intact.
      expect(repository.createDocumentForApi3("treatments", {
        identifier: "synthetic-treatments", app: "AAPS", device: "synthetic-v29",
        date: now, created_at: new Date(now).toISOString(), utcOffset: 0,
        eventType: "Meal Bolus", insulin: 1, carbs: 11,
      }, options).ok).toBe(true);
      const sessions = new SqliteRealtimeSessionRepository(state.storage);
      const session = sessions.createSession(now);
      sessions.enqueueFrames(session.sid, ["4pending-first", "4pending-second"], now);
      sql.exec("CREATE INDEX realtime_outbound_by_session ON realtime_outbound_packets(sid, sequence)");
      sql.exec("CREATE INDEX document_changes_collection_history ON document_changes(collection, srv_modified ASC, change_id ASC)");
      sql.exec("DELETE FROM _sql_schema_migrations WHERE id >= 29");
      sql.exec("INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (28)");
      expect(entryStoreSchemaIsActivationReady(sql)).toBe(false);
      expect(retiredIndexes(sql)).toHaveLength(2);
      return { fingerprint: preservedState(sql), sid: session.sid };
    });

    await evictDurableObject(stub);
    expect(JSON.parse(await stub.nightscoutHttpStatus(Date.now())).status).toBe("ok");
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const sql = state.storage.sql;
      expect(retiredIndexes(sql)).toEqual([]);
      expect(preservedState(sql)).toBe(before.fingerprint);
      expect(entryStoreSchemaIsActivationReady(sql)).toBe(true);
      expect(entryStoreSchemaSupportsReadOnly(sql)).toBe(true);
      const markers = sql.exec<{ id: number }>("SELECT id FROM _sql_schema_migrations WHERE id IN (28, 29, ?) ORDER BY id", ENTRY_STORE_ACTIVATION_SEAL).toArray().map((row) => row.id);
      expect(markers).toEqual([28, 29, ENTRY_STORE_ACTIVATION_SEAL]);
      expect(new SqliteRealtimeSessionRepository(state.storage).peekFrames(before.sid)?.frames)
        .toEqual(["4pending-first", "4pending-second"]);
      // Any second activation migration would insert its idempotent markers;
      // fail rather than allow an unnoticed repair/write cycle.
      sql.exec(`CREATE TRIGGER reject_repeated_v29_activation BEFORE INSERT ON _sql_schema_migrations
        BEGIN SELECT RAISE(ABORT, 'sealed v29 activation attempted a migration'); END`);
    });

    await evictDurableObject(stub);
    expect(JSON.parse(await stub.nightscoutHttpStatus(Date.now())).status).toBe("ok");
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(retiredIndexes(state.storage.sql)).toEqual([]);
      expect(preservedState(state.storage.sql)).toBe(before.fingerprint);
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      expect(repository.dequeueFrames(before.sid)).toEqual(["4pending-first", "4pending-second"]);
      expect(repository.requireSession(before.sid).outboundPackets).toBe(0);
    });
  });

  it("accepts a fresh v29 schema without requiring the obsolete v28 activation seal", async () => {
    const stub = env.ENTRY_STORE.getByName(`index-v29-fresh-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec("DELETE FROM _sql_schema_migrations WHERE id = 28");
      expect(retiredIndexes(state.storage.sql)).toEqual([]);
      expect(entryStoreSchemaIsActivationReady(state.storage.sql)).toBe(true);
      expect(entryStoreSchemaSupportsReadOnly(state.storage.sql)).toBe(true);
    });
  });

  it("rolls both index drops back together when the v29 marker cannot commit, then recovers", async () => {
    const stub = env.ENTRY_STORE.getByName(`index-v29-interrupted-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const sql = state.storage.sql;
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      const session = repository.createSession(Date.now());
      repository.enqueueFrames(session.sid, ["4pending-through-rollback"], Date.now());
      sql.exec("CREATE INDEX realtime_outbound_by_session ON realtime_outbound_packets(sid, sequence)");
      sql.exec("CREATE INDEX document_changes_collection_history ON document_changes(collection, srv_modified ASC, change_id ASC)");
      sql.exec("DELETE FROM _sql_schema_migrations WHERE id >= 29");
      sql.exec("INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (28)");
      sql.exec(`CREATE TRIGGER fail_v29_marker BEFORE INSERT ON _sql_schema_migrations
        WHEN NEW.id = 29 BEGIN SELECT RAISE(ABORT, 'synthetic v29 commit failure'); END`);
      const before = preservedState(sql);
      const initialization = instance as unknown as { completeStorageInitialization: () => void };
      expect(() => initialization.completeStorageInitialization()).toThrow("synthetic v29 commit failure");
      expect(retiredIndexes(sql)).toHaveLength(2);
      expect(preservedState(sql)).toBe(before);
      expect(entryStoreSchemaIsActivationReady(sql)).toBe(false);
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id = 29").one().count).toBe(0);

      sql.exec("DROP TRIGGER fail_v29_marker");
      initialization.completeStorageInitialization();
      expect(retiredIndexes(sql)).toEqual([]);
      expect(preservedState(sql)).toBe(before);
      expect(entryStoreSchemaIsActivationReady(sql)).toBe(true);
      expect(repository.dequeueFrames(session.sid)).toEqual(["4pending-through-rollback"]);
    });
  });
});
