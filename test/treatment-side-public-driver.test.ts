import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository } from "../src/document-repository";
import { ENTRY_STORE_ACTIVATION_SEAL, entryStoreSchemaIsActivationReady, type EntryStore } from "../src/entry-store";
import { DurableObjectWriteQuotaError } from "../src/platform-errors";
import { initialize, readState, TREATMENT_READ_SIDE_TABLE as KEYS } from "../src/treatment-read-side-index";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const MINUTE = 60_000;
const RESET = Date.parse("2026-10-19T00:00:00.000Z");
const OPTIONS = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false };
interface Internal {
  completeStorageInitialization(): void;
  documentRepository(): SqliteDocumentRepository;
  realtimeSnapshot(at: number, frame?: boolean, mode?: "root" | "ddata"): unknown;
  pluginPropertyContext(at: number): unknown;
  treatmentReadIndexCooldownUntil: number;
  storageWriteQuotaBlockedUntil: number;
  treatmentCategoryIndexAvailable: boolean | undefined;
}

function seed(sql: SqlStorage, count: number): void {
  sql.exec(`WITH RECURSIVE sequence(n) AS (
    VALUES(1) UNION ALL SELECT n + 1 FROM sequence WHERE n < ?
  ) INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
    SELECT 'treatments', printf('%024x', n), json_object(
      '_id', printf('%024x', n), 'created_at', '2026-10-18T12:00:00.000Z',
      'eventType', 'Note', 'notes', 'public-driver-fixture'
    ), ?, ?, ?, 1 FROM sequence`, count, NOW, NOW, NOW);
}

function prepareSide(instance: EntryStore, storage: DurableObjectStorage, count = 400): void {
  storage.sql.exec("DROP INDEX documents_treatments_created_at");
  storage.sql.exec("DROP INDEX documents_treatments_event_type_created_at");
  storage.sql.exec("DROP INDEX documents_treatments_api3_order");
  storage.sql.exec("DROP INDEX documents_devicestatus_recent");
  seed(storage.sql, count);
  storage.transactionSync(() => initialize(storage.sql));
  // Activation may already have cached the native capability. Only this raw
  // fixture removes an index from a live object; real native schemas keep it.
  (instance as unknown as Internal).treatmentCategoryIndexAvailable = undefined;
  expect(readState(storage.sql)).toMatchObject({ cursor: null, complete: false, budgetRows: 0 });
}

function sideCount(sql: SqlStorage): number {
  return sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${KEYS}`).one().count;
}

function createPayload(identifier: string, at = NOW) {
  return { identifier, app: "synthetic-public-side-driver", utcOffset: 0, date: at,
    created_at: new Date(at).toISOString(), eventType: "Note", notes: "canonical write must not backfill" };
}

function coreSnapshot(sql: SqlStorage): string {
  return JSON.stringify({
    documents: sql.exec("SELECT * FROM documents ORDER BY collection,id").toArray(),
    entries: sql.exec("SELECT * FROM entries ORDER BY id").toArray(),
    changes: sql.exec("SELECT * FROM document_changes ORDER BY change_id").toArray(),
    clocks: sql.exec("SELECT * FROM collection_clocks ORDER BY collection").toArray(),
    root: sql.exec("SELECT * FROM realtime_root_state ORDER BY singleton").toArray(),
  });
}

describe("optional treatment side progress is driven only by bounded public reads", () => {
  it("uses wall-clock minutes across all public read paths, including historical frames", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-public-minutes-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      prepareSide(instance, state.storage);
      let now = NOW;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const paths = [
        () => instance.getDdataSnapshotJson(NOW - 365 * 86_400_000, true),
        () => instance.getPluginPropertyContextJson(NOW),
        () => instance.api3QueryTreatments('{"limit":1}'),
        () => instance.queryLegacyTreatments('{"limit":1}'),
        () => instance.queryLegacyDocumentsJson("treatments", '{"limit":1}'),
        () => instance.listDocuments("treatments", 1),
      ];
      try {
        for (const [index, path] of paths.entries()) {
          now = NOW + index * MINUTE;
          await path();
          const progress = readState(state.storage.sql);
          expect(progress).toMatchObject({ lastRunAt: now, budgetRows: (index + 1) * 64, complete: false });
          expect(sideCount(state.storage.sql)).toBe((index + 1) * 64);
          // Different public endpoints and frame timestamps share one durable
          // checkpoint; none can buy a second batch inside this minute.
          for (const repeated of paths) await repeated();
          expect(readState(state.storage.sql)).toEqual(progress);
        }
        now = NOW + 5 * MINUTE + MINUTE - 1;
        await instance.getPluginPropertyContextJson(NOW + 10 * 86_400_000);
        expect(readState(state.storage.sql)?.budgetRows).toBe(384);
        now = NOW + 6 * MINUTE;
        await instance.api3QueryCollection("treatments", '{"limit":1}');
        expect(readState(state.storage.sql)).toMatchObject({ complete: true, budgetRows: 400, lastRunAt: now });
        expect(sideCount(state.storage.sql)).toBe(400);
      } finally { clock.mockRestore(); }
    });
  }, 60_000);

  it("does not advance from repository reads, private snapshots or canonical mutation callbacks", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-public-only-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      prepareSide(instance, state.storage, 130);
      const internal = instance as unknown as Internal;
      const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
      try {
        const initial = readState(state.storage.sql);
        const repository = internal.documentRepository();
        expect(repository.queryLegacyTreatments({ limit: 1 })).toHaveLength(1);
        expect(repository.queryDocumentsForApi3("treatments", { limit: 1 })).toHaveLength(1);
        internal.realtimeSnapshot(NOW, false, "root");
        internal.realtimeSnapshot(NOW, true, "ddata");
        internal.pluginPropertyContext(NOW);
        await instance.queryTreatments('{"limit":1}');
        expect(readState(state.storage.sql)).toEqual(initial);
        expect(sideCount(state.storage.sql)).toBe(0);
        const created = JSON.parse(await instance.api3CreateDocument("treatments",
          JSON.stringify(createPayload("private-callback-write")), JSON.stringify(OPTIONS)));
        expect(created).toMatchObject({ ok: true });
        expect(await instance.findApi3Document("treatments", "private-callback-write", "null")).not.toBeNull();
        expect(readState(state.storage.sql)).toEqual(initial);
        expect(sideCount(state.storage.sql)).toBe(1); // Only the write's own trigger key.
        await instance.api3QueryCollection("food", '{"limit":1}');
        await instance.listDocuments("profile", 1);
        expect(readState(state.storage.sql)).toEqual(initial);
      } finally { clock.mockRestore(); }
    });
  });

  it("rolls an optional quota batch back, continues original reads and retries only after UTC reset", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-public-quota-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      prepareSide(instance, state.storage, 130);
      const internal = instance as unknown as Internal;
      let now = NOW;
      let attempts = 0;
      let fail = true;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const execute = state.storage.sql.exec.bind(state.storage.sql);
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((statement, ...bindings) => {
        if (new RegExp(`^\\s*INSERT INTO ${KEYS}\\b`).test(statement)) {
          attempts += 1;
          const cursor = execute(statement, ...bindings);
          if (fail) throw new DurableObjectWriteQuotaError();
          return cursor;
        }
        return execute(statement, ...bindings);
      });
      try {
        const initial = readState(state.storage.sql);
        const canonical = coreSnapshot(state.storage.sql);
        const first = JSON.parse(await instance.api3QueryTreatments('{"limit":1}'));
        expect(first).toMatchObject({ ok: true });
        expect(first.result).toHaveLength(1);
        expect(attempts).toBe(1);
        expect(readState(state.storage.sql)).toEqual(initial);
        expect(sideCount(state.storage.sql)).toBe(0);
        expect(coreSnapshot(state.storage.sql)).toBe(canonical);
        expect(internal.treatmentReadIndexCooldownUntil).toBe(RESET);
        expect(internal.storageWriteQuotaBlockedUntil).toBe(0);
        fail = false;
        now += MINUTE;
        expect(JSON.parse(await instance.queryLegacyTreatments('{"limit":1}'))).toHaveLength(1);
        await instance.getPluginPropertyContextJson(NOW);
        expect(attempts).toBe(1);
        now = RESET - 1;
        await instance.listDocuments("treatments", 1);
        expect(attempts).toBe(1);
        now = RESET;
        expect(JSON.parse(await instance.api3QueryCollection("treatments", '{"limit":1}'))).toMatchObject({ ok: true });
        expect(attempts).toBe(2);
        expect(readState(state.storage.sql)).toMatchObject({ budgetRows: 64, lastRunAt: RESET, complete: false });
        expect(sideCount(state.storage.sql)).toBe(64);
        expect(coreSnapshot(state.storage.sql)).toBe(canonical);
      } finally { spy.mockRestore(); clock.mockRestore(); }
    });
  });

  it("reports trigger failures and exact platform quota while rolling canonical data and side keys back", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-public-canonical-quota-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      prepareSide(instance, state.storage, 2);
      const internal = instance as unknown as Internal;
      const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
      try {
        // Optional-progress cooldown must not silence an unrelated canonical
        // mutation's trigger failure or return a successful upload response.
        internal.treatmentReadIndexCooldownUntil = RESET;
        state.storage.sql.exec(`CREATE TRIGGER audit_public_side_quota BEFORE INSERT ON ${KEYS}
          BEGIN SELECT RAISE(ABORT, 'Exceeded allowed rows written in Durable Objects free tier.'); END`);
        const canonical = coreSnapshot(state.storage.sql);
        const progress = readState(state.storage.sql);
        const rejected = JSON.parse(await instance.api3CreateDocument("treatments",
          JSON.stringify(createPayload("rejected-by-side-trigger")), JSON.stringify(OPTIONS)));
        expect(rejected).toMatchObject({ ok: false, reason: "operation-error" });
        expect(rejected.message).toContain("Exceeded allowed rows written in Durable Objects free tier.");
        expect(rejected.message).toContain("SQLITE_CONSTRAINT_TRIGGER");
        expect(internal.storageWriteQuotaBlockedUntil).toBe(0);
        expect(coreSnapshot(state.storage.sql)).toBe(canonical);
        expect(readState(state.storage.sql)).toEqual(progress);
        expect(sideCount(state.storage.sql)).toBe(0);
        expect(await instance.findApi3Document("treatments", "rejected-by-side-trigger", "null")).toBeNull();
        state.storage.sql.exec("DROP TRIGGER audit_public_side_quota");
        const execute = state.storage.sql.exec.bind(state.storage.sql);
        let canonicalAttempts = 0;
        let observedCanonicalWrites = 0;
        const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((statement, ...bindings) => {
          const cursor = execute(statement, ...bindings);
          if (/^\s*INSERT INTO documents\b/.test(statement)) {
            canonicalAttempts += 1;
            observedCanonicalWrites += cursor.rowsWritten;
            // A platform exception has no SQLite trigger suffix. Throw after
            // the real statement/side trigger to prove the surrounding
            // canonical transaction rolls both changes back.
            throw new DurableObjectWriteQuotaError();
          }
          return cursor;
        });
        try {
          await expect(instance.api3CreateDocument("treatments", JSON.stringify(createPayload("exact-platform-quota")),
            JSON.stringify(OPTIONS))).rejects.toThrow("Exceeded allowed rows written in Durable Objects free tier.");
          expect(canonicalAttempts).toBe(1);
          expect(observedCanonicalWrites).toBeGreaterThan(0);
          expect(internal.storageWriteQuotaBlockedUntil).toBe(RESET);
          expect(coreSnapshot(state.storage.sql)).toBe(canonical);
          expect(readState(state.storage.sql)).toEqual(progress);
          expect(sideCount(state.storage.sql)).toBe(0);
          expect(await instance.findApi3Document("treatments", "exact-platform-quota", "null")).toBeNull();
          await expect(instance.api3CreateDocument("treatments", JSON.stringify(createPayload("gated-after-quota")),
            JSON.stringify(OPTIONS))).rejects.toThrow("Exceeded allowed rows written in Durable Objects free tier.");
          expect(canonicalAttempts).toBe(1);
        } finally { spy.mockRestore(); }
      } finally { clock.mockRestore(); }
    });
  });

  it("initializes an empty deferred side schema from old seal30 without changing canonical data or running a batch", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-public-seal30-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (instance: EntryStore, state) => {
      const sql = state.storage.sql;
      const repository = new SqliteDocumentRepository(state.storage);
      expect(repository.createDocumentForApi3("treatments", createPayload("preserved-pre-side"), OPTIONS)).toMatchObject({ ok: true });
      expect(repository.createDocumentForApi3("treatments", { ...createPayload("preserved-pre-side"), notes: "second revision" },
        OPTIONS)).toMatchObject({ ok: true });
      sql.exec("DROP INDEX documents_treatments_created_at");
      sql.exec("DROP INDEX documents_treatments_event_type_created_at");
      sql.exec("DROP INDEX documents_treatments_api3_order");
      sql.exec("DROP INDEX documents_devicestatus_recent");
      seed(sql, 20_000);
      sql.exec("DELETE FROM _sql_schema_migrations WHERE id >= 31 OR id = 28");
      sql.exec("INSERT OR IGNORE INTO _sql_schema_migrations(id) VALUES(30)");
      expect(entryStoreSchemaIsActivationReady(sql)).toBe(false);
      const before = coreSnapshot(sql);
      (instance as unknown as Internal).completeStorageInitialization();
      expect(entryStoreSchemaIsActivationReady(sql)).toBe(true);
      expect(sql.exec<{ id: number }>("SELECT id FROM _sql_schema_migrations WHERE id >= 30 ORDER BY id")
        .toArray().map(row => row.id)).toEqual([30, 31, 33, ENTRY_STORE_ACTIVATION_SEAL]);
      expect(sql.exec("PRAGMA index_info(documents_treatments_created_at)").toArray()).toEqual([]);
      expect(sql.exec("PRAGMA index_info(documents_treatments_event_type_created_at)").toArray()).toEqual([]);
      expect(readState(sql)).toEqual({ cursor: null, complete: false, lastRunAt: null, budgetDay: null, budgetRows: 0 });
      expect(sideCount(sql)).toBe(0);
      expect(coreSnapshot(sql)).toBe(before);
    });
  }, 60_000);
});
