import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ENTRY_STORE_ACTIVATION_SEAL, type EntryStore, type JsonDocument } from "../src/entry-store";
import type {
  Api3MutationDecision,
  Api3MutationOptions,
  DocumentDeleteResult,
  DocumentHistoryQuery,
  DocumentMutationResult,
  DocumentQuery,
} from "../src/document-repository";

interface TreatmentRpc {
  api3CreateTreatment(documentJson: string, optionsJson: string): Promise<string>;
  api3ReplaceTreatment(identity: string, documentJson: string, optionsJson: string): Promise<string>;
  api3PatchTreatment(identity: string, patchJson: string, optionsJson: string): Promise<string>;
  api3DeleteTreatment(
    identity: string,
    permanent: boolean,
    actor: string | null,
  ): Promise<DocumentDeleteResult>;
  createTreatment(documentJson: string): Promise<string>;
  upsertTreatment(documentJson: string): Promise<string>;
  replaceTreatment(identity: string, documentJson: string): Promise<string>;
  patchTreatment(identity: string, patchJson: string): Promise<string | null>;
  findTreatmentById(id: string, includeDeleted?: boolean): Promise<string | null>;
  findTreatmentByIdentifier(identifier: string, includeDeleted?: boolean): Promise<string | null>;
  findTreatmentByFallback(
    createdAt: string | number,
    eventType: string | number,
    includeDeleted?: boolean,
  ): Promise<string | null>;
  queryTreatments(queryJson?: string): Promise<string>;
  treatmentHistory(queryJson: string): Promise<string>;
  deleteTreatment(identity: string, permanent?: boolean): Promise<DocumentDeleteResult>;
}

type Api3MutationResult = DocumentMutationResult & { srvModified: number };

function store(prefix: string) {
  return env.ENTRY_STORE.getByName(`${prefix}-${crypto.randomUUID()}`);
}

function treatment(identifier: string, createdAt: string, extra = {}) {
  return {
    identifier,
    date: Date.parse(createdAt),
    utcOffset: 0,
    app: "repository-test",
    device: "test-device",
    eventType: "Correction Bolus",
    created_at: createdAt,
    insulin: 1,
    ...extra,
  };
}

function decode<T>(json: string): T {
  return JSON.parse(json) as T;
}

async function createTreatment(stub: TreatmentRpc, document: JsonDocument): Promise<Api3MutationResult> {
  return decode<Api3MutationResult>(await stub.createTreatment(JSON.stringify(document)));
}

async function upsertTreatment(stub: TreatmentRpc, document: JsonDocument): Promise<DocumentMutationResult> {
  return decode<DocumentMutationResult>(await stub.upsertTreatment(JSON.stringify(document)));
}

async function patchTreatment(
  stub: TreatmentRpc,
  identity: string,
  patch: JsonDocument,
): Promise<Api3MutationResult | null> {
  const result = await stub.patchTreatment(identity, JSON.stringify(patch));
  return result === null ? null : decode<Api3MutationResult>(result);
}

async function findById(
  stub: TreatmentRpc,
  id: string,
  includeDeleted = false,
): Promise<JsonDocument | null> {
  const result = await stub.findTreatmentById(id, includeDeleted);
  return result === null ? null : decode<JsonDocument>(result);
}

async function findByIdentifier(
  stub: TreatmentRpc,
  identifier: string,
  includeDeleted = false,
): Promise<JsonDocument | null> {
  const result = await stub.findTreatmentByIdentifier(identifier, includeDeleted);
  return result === null ? null : decode<JsonDocument>(result);
}

async function queryTreatments(stub: TreatmentRpc, query: DocumentQuery): Promise<JsonDocument[]> {
  return decode<JsonDocument[]>(await stub.queryTreatments(JSON.stringify(query)));
}

async function treatmentHistory(
  stub: TreatmentRpc,
  query: DocumentHistoryQuery,
): Promise<JsonDocument[]> {
  return decode<JsonDocument[]>(await stub.treatmentHistory(JSON.stringify(query)));
}

async function api3Create(
  stub: TreatmentRpc,
  document: JsonDocument,
  options: Api3MutationOptions,
): Promise<Api3MutationDecision> {
  return decode<Api3MutationDecision>(await stub.api3CreateTreatment(
    JSON.stringify(document),
    JSON.stringify(options),
  ));
}

async function api3Replace(
  stub: TreatmentRpc,
  identity: string,
  document: JsonDocument,
  options: Api3MutationOptions,
): Promise<Api3MutationDecision> {
  return decode<Api3MutationDecision>(await stub.api3ReplaceTreatment(
    identity,
    JSON.stringify(document),
    JSON.stringify(options),
  ));
}

async function storedId(stub: ReturnType<typeof store>, identifier: string): Promise<string> {
  return runInDurableObject(stub, async (_instance: EntryStore, state) => {
    const row = state.storage.sql.exec<{ id: string }>(
      `SELECT id FROM documents
       WHERE collection = 'treatments' AND identifier = ?
       ORDER BY updated_at DESC, id ASC LIMIT 1`,
      identifier,
    ).toArray()[0];
    if (row === undefined) throw new Error(`missing stored treatment ${identifier}`);
    return row.id;
  });
}

describe("SQLite collection contract v4", () => {
  it("migrates v3 documents safely and remains idempotent across activation", async () => {
    const stub = store("migration");
    const id = "0123456789abcdef01234567";
    const legacyDocument: JsonDocument = {
      _id: id,
      identifier: "legacy-treatment",
      eventType: "Meal Bolus",
      created_at: "2026-01-01T00:00:00.000Z",
      carbs: 20,
    };
    const legacyBody = JSON.stringify(legacyDocument);

    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec(`
          CREATE TABLE documents_v3 (
            collection TEXT NOT NULL,
            id TEXT NOT NULL,
            body TEXT NOT NULL,
            sort_time INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (collection, id)
          )
        `);
        state.storage.sql.exec(
          `INSERT INTO documents_v3
            (collection, id, body, sort_time, created_at, updated_at)
           VALUES ('treatments', ?, ?, ?, ?, ?)`,
          id,
          legacyBody,
          Date.parse("2026-01-01T00:00:00.000Z"),
          Date.parse("2026-01-01T00:00:00.000Z"),
          Date.parse("2026-01-01T00:00:00.000Z"),
        );
        state.storage.sql.exec("DROP TABLE document_changes");
        state.storage.sql.exec("DROP TABLE collection_clocks");
        state.storage.sql.exec("DROP TABLE documents");
        state.storage.sql.exec("ALTER TABLE documents_v3 RENAME TO documents");
        state.storage.sql.exec(
          "CREATE INDEX documents_collection_sort ON documents(collection, sort_time DESC)",
        );
        state.storage.sql.exec("DELETE FROM _sql_schema_migrations WHERE id >= 4");
      });

      expect(state.storage.sql.exec<{ name: string }>(
        "PRAGMA table_info(documents)",
      ).toArray().map((column) => column.name)).toEqual([
        "collection",
        "id",
        "body",
        "sort_time",
        "created_at",
        "updated_at",
      ]);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE name IN ('document_changes', 'collection_clocks')`,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ name: string }>(
        `SELECT name FROM sqlite_schema
         WHERE type = 'index' AND name LIKE 'documents_collection_%'
         ORDER BY name`,
      ).toArray().map((index) => index.name)).toEqual(["documents_collection_sort"]);
    });

    await evictDurableObject(stub);
    const migrated = await findById(stub, id);
    expect(migrated).toMatchObject({
      identifier: "legacy-treatment",
      eventType: "Meal Bolus",
      carbs: 20,
    });
    expect(migrated).not.toHaveProperty("_id");
    expect(migrated?.srvCreated).toEqual(expect.any(Number));
    expect(migrated?.srvModified).toEqual(expect.any(Number));

    await evictDurableObject(stub);
    expect(await findById(stub, id)).toMatchObject({ identifier: "legacy-treatment", carbs: 20 });
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const storedBody = state.storage.sql.exec<{ body: string }>(
        "SELECT body FROM documents WHERE collection = 'treatments' AND id = ?",
        id,
      ).one().body;
      expect(storedBody).toBe(legacyBody);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id = 4",
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM document_changes WHERE collection = 'treatments' AND id = ?",
        id,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM collection_clocks WHERE collection = 'treatments'",
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ identifier_present: number }>(
        "SELECT identifier_present FROM documents WHERE collection = 'treatments' AND id = ?",
        id,
      ).one().identifier_present).toBe(1);
      expect(state.storage.sql.exec<{
        srv_created: number | null;
        srv_modified: number | null;
        srv_metadata_version: number;
      }>(
        `SELECT srv_created, srv_modified, srv_metadata_version FROM documents
         WHERE collection = 'treatments' AND id = ?`,
        id,
      ).one()).toEqual({ srv_created: null, srv_modified: null, srv_metadata_version: 1 });
      expect(state.storage.sql.exec<{
        srv_created: number | null;
        srv_modified: number | null;
        srv_metadata_version: number;
      }>(
        `SELECT srv_created, srv_modified, srv_metadata_version FROM document_changes
         WHERE collection = 'treatments' AND id = ?`,
        id,
      ).one()).toEqual({ srv_created: null, srv_modified: null, srv_metadata_version: 1 });
      const srvColumns = state.storage.sql.exec<{ name: string; notnull: number }>(
        "PRAGMA table_info(document_changes)",
      ).toArray()
        .filter((column) => column.name === "srv_created" || column.name === "srv_modified")
        .map(({ name, notnull }) => ({ name, notnull }));
      expect(srvColumns).toEqual([
        { name: "srv_created", notnull: 0 },
        { name: "srv_modified", notnull: 0 },
      ]);
    });
  });

  it("repairs identifier presence when an older v4 marker already exists", async () => {
    const stub = store("v4-presence-upgrade");
    const legacyClockHighWater = 4_102_444_800_999;
    const legacy = await upsertTreatment(stub, {
      identifier: null,
      eventType: "Note",
      created_at: "2026-01-02T00:00:00.000Z",
      notes: "explicit null",
    });
    const id = String(legacy.document._id);
    const offsetLegacy = await upsertTreatment(stub, {
      eventType: "Meal Bolus",
      created_at: "2026-01-03T12:00:00.000Z",
      carbs: 10,
    });
    const offsetId = String(offsetLegacy.document._id);
    const oldOffsetDocument: JsonDocument = {
      ...offsetLegacy.document,
      created_at: "2026-01-03T07:00:00.000-05:00",
      utcOffset: -300,
    };
    const oldOffsetBody = JSON.stringify(oldOffsetDocument);
    const oldOffsetFallback = JSON.stringify([
      "2026-01-03T07:00:00.000-05:00",
      "Meal Bolus",
    ]);

    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec(
          `INSERT INTO collection_clocks (collection, last_srv_modified)
           VALUES ('treatments', ?)`,
          legacyClockHighWater,
        );
        state.storage.sql.exec(
          `UPDATE documents SET body = ?, fallback_key = ?
           WHERE collection = 'treatments' AND id = ?`,
          oldOffsetBody,
          oldOffsetFallback,
          offsetId,
        );
        state.storage.sql.exec(
          `UPDATE document_changes SET body = ?
           WHERE collection = 'treatments' AND id = ?`,
          oldOffsetBody,
          offsetId,
        );
        state.storage.sql.exec(`
          CREATE TABLE documents_old_v4 (
            collection TEXT NOT NULL,
            id TEXT NOT NULL,
            body TEXT NOT NULL,
            sort_time INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            identifier TEXT,
            srv_created INTEGER,
            srv_modified INTEGER,
            is_valid INTEGER,
            fallback_key TEXT,
            revision INTEGER,
            PRIMARY KEY (collection, id)
          );
          INSERT INTO documents_old_v4
            (collection, id, body, sort_time, created_at, updated_at, identifier,
             srv_created, srv_modified, is_valid, fallback_key, revision)
          SELECT collection, id, body, sort_time, created_at, updated_at, identifier,
                 COALESCE(srv_created, 4102444800000),
                 COALESCE(srv_modified, 4102444800001),
                 is_valid, fallback_key, revision
          FROM documents;

          CREATE TABLE document_changes_old_v4 (
            change_id INTEGER PRIMARY KEY AUTOINCREMENT,
            collection TEXT NOT NULL,
            id TEXT NOT NULL,
            identifier TEXT,
            body TEXT NOT NULL,
            srv_created INTEGER NOT NULL,
            srv_modified INTEGER NOT NULL,
            is_valid INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            operation TEXT NOT NULL
          );
          INSERT INTO document_changes_old_v4
            (change_id, collection, id, identifier, body, srv_created, srv_modified,
             is_valid, revision, operation)
          SELECT change_id, collection, id, identifier, body,
                 COALESCE(srv_created, 4102444800000),
                 COALESCE(srv_modified, 4102444800001),
                 is_valid, revision, operation
          FROM document_changes;

          DROP TABLE document_changes;
          ALTER TABLE document_changes_old_v4 RENAME TO document_changes;
          DROP TABLE documents;
          ALTER TABLE documents_old_v4 RENAME TO documents;
          DELETE FROM _sql_schema_migrations WHERE id = ${ENTRY_STORE_ACTIVATION_SEAL};
        `);
      });
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id = 4",
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ name: string }>(
        "PRAGMA table_info(documents)",
      ).toArray().some((column) => column.name === "identifier_present")).toBe(false);
    });

    await evictDurableObject(stub);
    expect(await findById(stub, id, true)).toMatchObject({
      identifier: id,
      notes: "explicit null",
    });
    expect(await findById(stub, offsetId, true)).toMatchObject({
      identifier: offsetId,
      created_at: "2026-01-03T07:00:00.000-05:00",
      utcOffset: -300,
    });
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ identifier_present: number }>(
        "SELECT identifier_present FROM documents WHERE collection = 'treatments' AND id = ?",
        id,
      ).one().identifier_present).toBe(1);
      expect(state.storage.sql.exec<{ identifier_present: number }>(
        `SELECT identifier_present FROM document_changes
         WHERE collection = 'treatments' AND id = ?`,
        id,
      ).one().identifier_present).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM document_changes
         WHERE collection = 'treatments' AND id = ?`,
        id,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ srv_created: number | null; srv_modified: number | null }>(
        `SELECT srv_created, srv_modified FROM documents
         WHERE collection = 'treatments' AND id = ?`,
        id,
      ).one()).toEqual({ srv_created: null, srv_modified: null });
      expect(state.storage.sql.exec<{ last_srv_modified: number }>(
        `SELECT last_srv_modified FROM collection_clocks
         WHERE collection = 'treatments'`,
      ).one().last_srv_modified).toBe(legacyClockHighWater);
      expect(state.storage.sql.exec<{ srv_created: number | null; srv_modified: number | null }>(
        `SELECT srv_created, srv_modified FROM document_changes
         WHERE collection = 'treatments' AND id = ?`,
        id,
      ).one()).toEqual({ srv_created: null, srv_modified: null });
      expect(state.storage.sql.exec<{ fallback_key: string }>(
        `SELECT fallback_key FROM documents
         WHERE collection = 'treatments' AND id = ?`,
        offsetId,
      ).one().fallback_key).toBe(JSON.stringify([
        "2026-01-03T12:00:00.000Z",
        "Meal Bolus",
      ]));
      const indexes = state.storage.sql.exec<{ name: string }>(
        "PRAGMA index_list(documents)",
      ).toArray().map((index) => index.name);
      expect(indexes).toContain("documents_collection_sort");
    });

    const canonicalRetransmission = await upsertTreatment(stub, {
      eventType: "Meal Bolus",
      created_at: "2026-01-03T12:00:00.000Z",
      carbs: 11,
    });
    expect(canonicalRetransmission.document._id).toBe(offsetId);
    const api3AfterRepair = await createTreatment(stub, {
      identifier: "post-repair-api3-clock",
      date: Date.parse("2026-01-04T00:00:00.000Z"),
      utcOffset: 0,
      app: "migration-test",
      eventType: "Note",
      created_at: "2026-01-04T00:00:00.000Z",
    });
    expect(api3AfterRepair.srvModified).toBeGreaterThan(legacyClockHighWater);

    await evictDurableObject(stub);
    expect(await findById(stub, id, true)).toMatchObject({ identifier: id, notes: "explicit null" });
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM document_changes
         WHERE collection = 'treatments' AND id = ?`,
        offsetId,
      ).one().count).toBe(2);
    });
  });

  it("keeps identifier and fallback indexes non-unique", async () => {
    const stub = store("indexes");
    await stub.treatmentsLastModified();
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const indexes = state.storage.sql.exec<{ name: string; unique: number }>(
        "PRAGMA index_list(documents)",
      ).toArray();
      expect(indexes.find((index) => index.name === "documents_collection_identifier")?.unique).toBe(0);
      expect(
        indexes.find((index) => index.name === "documents_collection_identifier_presence")?.unique,
      ).toBe(0);
      expect(indexes.find((index) => index.name === "documents_collection_fallback")?.unique).toBe(0);
      expect(
        indexes.find((index) => index.name === "documents_collection_effective_modified")?.unique,
      ).toBe(0);
      const plan = state.storage.sql.exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT effective_modified
         FROM documents
         WHERE collection = 'treatments'
           AND effective_modified IS NOT NULL
         ORDER BY effective_modified DESC, id ASC
         LIMIT 1`,
      ).toArray();
      expect(plan.some((row) =>
        row.detail.includes("documents_collection_effective_modified")
      )).toBe(true);
    });
  });

  it("keeps allocation monotonic but derives lastModified from current documents", async () => {
    const stub = store("clock");
    const createdAt = "2026-02-01T00:00:00.000Z";
    const first = await createTreatment(stub, treatment("clock-a", createdAt));
    const second = await createTreatment(
      stub,
      treatment("clock-b", "2026-02-01T00:01:00.000Z", { insulin: 1.1 }),
    );
    expect(second.srvModified).toBeGreaterThan(first.srvModified);

    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER reject_non_increasing_clock_update
        BEFORE UPDATE ON collection_clocks
        WHEN NEW.last_srv_modified <= OLD.last_srv_modified
        BEGIN
          SELECT RAISE(ABORT, 'clock must only move forward');
        END
      `);
    });

    await evictDurableObject(stub);
    const third = await patchTreatment(stub, "clock-a", { insulin: 1.2 });
    expect(third?.srvModified).toBeGreaterThan(second.srvModified);
    expect(await stub.treatmentsLastModified()).toBe(third?.srvModified);

    expect((await stub.deleteTreatment("clock-a", true)).deleted).toBe(true);
    expect(await stub.treatmentsLastModified()).toBe(second.srvModified);
    expect((await stub.deleteTreatment("clock-b", true)).deleted).toBe(true);
    expect(await stub.treatmentsLastModified()).toBeNull();

    await evictDurableObject(stub);
    const fourth = await createTreatment(
      stub,
      treatment("clock-c", "2026-02-01T00:02:00.000Z"),
    );
    expect(fourth.srvModified).toBeGreaterThan(third?.srvModified ?? 0);
  });

  it("includes the locked created_at fallback in current-document lastModified", async () => {
    const stub = store("last-modified-fallback");
    const pastCreatedAt = "2001-01-01T00:00:00.000Z";
    const past = await upsertTreatment(stub, {
      eventType: "Note",
      created_at: pastCreatedAt,
      notes: "past fallback fixture",
    });
    expect(await stub.treatmentsLastModified()).toBe(Date.parse(pastCreatedAt));
    expect((await stub.deleteTreatment(String(past.document._id), true)).deleted).toBe(true);

    const futureCreatedAt = "2099-01-01T00:00:00.000Z";
    const legacy = await upsertTreatment(stub, {
      eventType: "Note",
      created_at: futureCreatedAt,
      notes: "future fallback fixture",
    });
    expect(await stub.treatmentsLastModified()).toBe(Date.parse(futureCreatedAt));
    expect((await stub.deleteTreatment(String(legacy.document._id), true)).deleted).toBe(true);
    expect(await stub.treatmentsLastModified()).toBeNull();
  });

  it("uses official identifier, id, then legacy fallback priority and preserves the server id", async () => {
    const stub = store("identity");
    const createdAt = "2026-03-01T00:00:00.000Z";
    const primary = await createTreatment(stub, treatment("priority-id", createdAt));
    const primaryId = await storedId(stub, "priority-id");
    const conflictingId = "aaaaaaaaaaaaaaaaaaaaaaaa";
    await createTreatment(stub, {
      _id: conflictingId,
      eventType: "Note",
      created_at: "2026-03-01T00:01:00.000Z",
      notes: "other document",
    });

    await runInDurableObject(stub, async (instance: EntryStore) => {
      await expect(instance.createTreatment(JSON.stringify({
        _id: conflictingId,
        identifier: "priority-id",
        eventType: "Correction Bolus",
        created_at: createdAt,
        insulin: 2,
      }))).rejects.toThrow("immutable field _id");
    });
    const retransmitted = await createTreatment(stub, treatment(
      "priority-id",
      createdAt,
      { insulin: 2 },
    ));
    expect(await storedId(stub, "priority-id")).toBe(primaryId);
    expect(primaryId).not.toBe(conflictingId);
    expect(retransmitted.document).not.toHaveProperty("_id");
    expect((await findById(stub, conflictingId))?.notes).toBe("other document");

    const replaced = decode<DocumentMutationResult>(await stub.replaceTreatment(
      "priority-id",
      JSON.stringify({
        eventType: "Correction Bolus",
        created_at: createdAt,
        insulin: 2.5,
        notes: "replacement",
      }),
    ));
    expect(replaced.document).toMatchObject({
      identifier: "priority-id",
      insulin: 2.5,
      notes: "replacement",
    });
    expect(replaced.document).not.toHaveProperty("_id");
    expect(replaced.document.srvCreated).toBe(primary.document.srvCreated);

    const legacy = await upsertTreatment(stub, {
      eventType: "Meal Bolus",
      created_at: "2026-03-02T00:00:00.000Z",
      carbs: 15,
    });
    const legacyFallback = await stub.findTreatmentByFallback(
      "2026-03-02T00:00:00.000Z",
      "Meal Bolus",
    );
    expect(legacyFallback === null ? null : decode<JsonDocument>(legacyFallback).identifier)
      .toBe(legacy.document._id);
    const deduplicated = await createTreatment(stub, {
      identifier: "modern-identifier",
      eventType: "Meal Bolus",
      created_at: "2026-03-02T00:00:00.000Z",
      carbs: 20,
    });
    expect(await storedId(stub, "modern-identifier")).toBe(legacy.document._id);
    expect(deduplicated.deduplicatedIdentifier).toBe(legacy.document._id);
    expect(await findByIdentifier(stub, "modern-identifier")).toMatchObject({
      identifier: "modern-identifier",
    });
    expect(await findByIdentifier(stub, "modern-identifier")).not.toHaveProperty("_id");
    const fallback = await stub.findTreatmentByFallback(
      "2026-03-02T00:00:00.000Z",
      "Meal Bolus",
    );
    expect(fallback).toBeNull();

    const v1Modern = await createTreatment(stub, {
      identifier: "v1-existing-identifier",
      eventType: "Carb Correction",
      created_at: "2026-03-03T00:00:00.000Z",
      carbs: 10,
    });
    expect(v1Modern.document).not.toHaveProperty("_id");
    const v1ModernId = await storedId(stub, "v1-existing-identifier");
    const fallbackUpsert = await upsertTreatment(stub, {
      eventType: "Carb Correction",
      created_at: "2026-03-03T00:00:00.000Z",
      carbs: 11,
    });
    expect(fallbackUpsert.document._id).toBe(v1ModernId);
    const identifierFirst = await upsertTreatment(stub, {
      identifier: "v1-new-identifier",
      eventType: "Carb Correction",
      created_at: "2026-03-03T00:00:00.000Z",
      carbs: 12,
    });
    expect(identifierFirst.document._id).not.toBe(v1ModernId);
  });

  it("normalizes v1 created_at and eventTime before fallback identity lookup", async () => {
    const stub = store("legacy-time-identity");
    const first = await upsertTreatment(stub, {
      eventType: "Correction Bolus",
      created_at: "2026-03-10T12:00:00.000Z",
      insulin: 1,
    });
    const retransmitted = await upsertTreatment(stub, {
      eventType: "Correction Bolus",
      created_at: "2026-03-10T07:00:00.000-05:00",
      insulin: 1.5,
    });
    expect(retransmitted.document._id).toBe(first.document._id);
    expect(retransmitted.document).toMatchObject({
      created_at: "2026-03-10T12:00:00.000Z",
      utcOffset: -300,
    });

    const eventTarget = await upsertTreatment(stub, {
      eventType: "Note",
      created_at: "2026-03-11T12:00:00.000Z",
      notes: "canonical",
    });
    const eventRetransmit = await upsertTreatment(stub, {
      eventType: "Note",
      created_at: "2026-03-09T07:00:00.000-05:00",
      eventTime: "2026-03-11T07:00:00.000-05:00",
      notes: "eventTime override",
    });
    expect(eventRetransmit.document._id).toBe(eventTarget.document._id);
    expect(eventRetransmit.document).toMatchObject({
      created_at: "2026-03-11T12:00:00.000Z",
      utcOffset: -300,
      notes: "eventTime override",
    });
    expect(eventRetransmit.document).not.toHaveProperty("eventTime");

    const preBolus = await upsertTreatment(stub, {
      eventType: "Meal Bolus",
      created_at: "2026-03-12T12:00:00.000Z",
      carbs: "20",
      preBolus: "15",
    });
    expect(preBolus.document).toMatchObject({ preBolus: 15 });
    expect(preBolus.document).not.toHaveProperty("carbs");
  });

  it("resolves legacy dates before API3 replace and patch validation only", async () => {
    const stub = store("legacy-api3-update-dates");
    const replaceCreatedAt = "2002-01-02T03:04:05.000Z";
    const replaceMillis = Date.parse(replaceCreatedAt);
    const replaceLegacy = await upsertTreatment(stub, {
      date: replaceMillis,
      eventType: "Note",
      device: "legacy-device",
      app: "legacy-app",
      created_at: replaceCreatedAt,
      notes: "replace source",
    });
    const replaceId = String(replaceLegacy.document._id);
    const replaced = decode<Api3MutationResult>(await stub.replaceTreatment(
      replaceId,
      JSON.stringify({
        date: replaceMillis,
        utcOffset: 0,
        eventType: "Note",
        device: "legacy-device",
        app: "legacy-app",
        created_at: replaceCreatedAt,
        srvCreated: replaceMillis,
        srvModified: replaceMillis,
        notes: "replace accepted virtual fields",
      }),
    ));
    expect(replaced.document).toMatchObject({
      identifier: replaceId,
      srvCreated: replaceMillis,
      srvModified: replaced.srvModified,
    });
    expect(replaced.srvModified).toBeGreaterThan(replaceMillis);
    expect(replaced.document).not.toHaveProperty("_id");

    const patchCreatedAt = "2003-02-03T04:05:06.000Z";
    const patchMillis = Date.parse(patchCreatedAt);
    const patchLegacy = await upsertTreatment(stub, {
      date: patchMillis,
      eventType: "Note",
      device: "legacy-device",
      app: "legacy-app",
      created_at: patchCreatedAt,
      notes: "patch source",
    });
    const patched = await patchTreatment(stub, String(patchLegacy.document._id), {
      srvCreated: patchMillis,
      srvModified: patchMillis,
      notes: "patch accepted virtual fields",
    });
    expect(patched?.document).toMatchObject({
      identifier: patchLegacy.document._id,
      srvCreated: patchMillis,
      srvModified: patched?.srvModified,
    });
    expect(patched?.srvModified).toBeGreaterThan(patchMillis);
    expect(patched?.document).not.toHaveProperty("_id");

    const dedupCreatedAt = "2004-03-04T05:06:07.000Z";
    const dedupMillis = Date.parse(dedupCreatedAt);
    await upsertTreatment(stub, {
      date: dedupMillis,
      eventType: "Meal Bolus",
      device: "legacy-device",
      app: "legacy-app",
      created_at: dedupCreatedAt,
    });
    await runInDurableObject(stub, async (instance: EntryStore) => {
      await expect(instance.createTreatment(JSON.stringify({
        identifier: "raw-dedup-validation",
        date: dedupMillis,
        utcOffset: 0,
        eventType: "Meal Bolus",
        device: "legacy-device",
        app: "legacy-app",
        created_at: dedupCreatedAt,
        srvCreated: dedupMillis,
      }))).rejects.toThrow("Field srvCreated cannot be modified by the client");
    });
  });

  it("uses the legacy-only ObjectId fallback for API3 PUT and PATCH", async () => {
    const stub = store("api3-mutation-objectid-fallback");
    const createdAt = "2026-03-19T00:00:00.000Z";
    await createTreatment(stub, treatment("visible-identifier", createdAt));
    const internalId = await storedId(stub, "visible-identifier");
    expect(internalId).toMatch(/^[0-9a-f]{24}$/);

    const options: Api3MutationOptions = {
      canCreate: true,
      canUpdate: true,
      actor: "contract-test",
      ifUnmodifiedSince: null,
      validate: true,
    };
    const patch = decode<Api3MutationDecision>(await stub.api3PatchTreatment(
      internalId,
      JSON.stringify({ notes: "must not patch by modern storage id" }),
      JSON.stringify(options),
    ));
    expect(patch).toEqual({ ok: false, reason: "not-found" });

    const replacement = await api3Replace(
      stub,
      internalId,
      treatment(internalId, "2026-03-19T00:01:00.000Z"),
      options,
    );
    expect(replacement).toMatchObject({
      ok: true,
      mutation: {
        created: true,
        document: { identifier: internalId },
      },
    });
    const original = await findByIdentifier(stub, "visible-identifier");
    expect(original).toMatchObject({ identifier: "visible-identifier" });
    expect(original).not.toHaveProperty("notes");
  });

  it("distinguishes a missing identifier from explicit null and empty values", async () => {
    const stub = store("identifier-presence");
    const missing = await upsertTreatment(stub, {
      eventType: "Meal Bolus",
      created_at: "2026-03-20T00:00:00.000Z",
      carbs: 10,
    });
    const adopted = await createTreatment(stub, {
      identifier: "adopt-missing",
      eventType: "Meal Bolus",
      created_at: "2026-03-20T00:00:00.000Z",
      carbs: 11,
    });
    expect(await storedId(stub, "adopt-missing")).toBe(missing.document._id);
    expect(adopted.document).not.toHaveProperty("_id");

    const explicitNull = await upsertTreatment(stub, {
      identifier: null,
      eventType: "Meal Bolus",
      created_at: "2026-03-21T00:00:00.000Z",
      carbs: 12,
    });
    const afterNull = await createTreatment(stub, {
      identifier: "must-not-match-null",
      eventType: "Meal Bolus",
      created_at: "2026-03-21T00:00:00.000Z",
      carbs: 13,
    });
    expect(afterNull.document).not.toHaveProperty("_id");
    expect(await storedId(stub, "must-not-match-null")).not.toBe(explicitNull.document._id);
    expect(await stub.findTreatmentByFallback(
      "2026-03-21T00:00:00.000Z",
      "Meal Bolus",
    )).toBeNull();

    const explicitEmpty = await upsertTreatment(stub, {
      identifier: "",
      eventType: "Meal Bolus",
      created_at: "2026-03-22T00:00:00.000Z",
      carbs: 14,
    });
    const afterEmpty = await createTreatment(stub, {
      identifier: "must-not-match-empty",
      eventType: "Meal Bolus",
      created_at: "2026-03-22T00:00:00.000Z",
      carbs: 15,
    });
    expect(afterEmpty.document).not.toHaveProperty("_id");
    expect(await storedId(stub, "must-not-match-empty")).not.toBe(explicitEmpty.document._id);
    expect(await stub.findTreatmentByFallback(
      "2026-03-22T00:00:00.000Z",
      "Meal Bolus",
    )).toBeNull();

    const missingIdentifierId = "aaaaaaaaaaaaaaaaaaaaaaaa";
    await upsertTreatment(stub, {
      _id: missingIdentifierId,
      eventType: "Note",
      created_at: "2026-03-23T00:00:00.000Z",
    });
    const adoptedHexIdentifier = await createTreatment(stub, {
      identifier: missingIdentifierId,
      eventType: "Note",
      created_at: "2026-03-23T00:00:00.000Z",
    });
    expect(adoptedHexIdentifier.document).not.toHaveProperty("_id");
    expect(await storedId(stub, missingIdentifierId)).toBe(missingIdentifierId);

    const explicitNullId = "bbbbbbbbbbbbbbbbbbbbbbbb";
    await upsertTreatment(stub, {
      _id: explicitNullId,
      identifier: null,
      eventType: "Note",
      created_at: "2026-03-24T00:00:00.000Z",
    });
    expect(await findByIdentifier(stub, explicitNullId)).toMatchObject({ identifier: explicitNullId });
    // API3 READ uses filterForOne() and may expose the ObjectId virtually, but
    // PUT/PATCH identifyingFilter() only falls back to `_id` when identifier
    // is genuinely absent. An explicit null therefore must not be mutated.
    expect(await patchTreatment(stub, explicitNullId, { notes: "must not patch" })).toBeNull();
    const hexIdentifier = await createTreatment(stub, {
      identifier: explicitNullId,
      eventType: "Note",
      created_at: "2026-03-25T00:00:00.000Z",
    });
    expect(hexIdentifier.document).not.toHaveProperty("_id");
    expect(await storedId(stub, explicitNullId)).not.toBe(explicitNullId);

    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const presence = state.storage.sql.exec<{ identifier_present: number; identifier: string | null }>(
        `SELECT identifier_present, identifier FROM documents
         WHERE collection = 'treatments' AND id IN (?, ?)
         ORDER BY id`,
        String(explicitNull.document._id),
        String(explicitEmpty.document._id),
      ).toArray();
      expect(presence).toHaveLength(2);
      expect(presence.every((row) => row.identifier_present === 1)).toBe(true);
      expect(presence.map((row) => row.identifier)).toEqual(expect.arrayContaining([null, ""]));
    });
  });

  it("keeps API3 POST candidate lookup and create-only permission selection atomic", async () => {
    const stub = store("api3-create-only-race");
    const document = treatment(
      "create-only-race",
      "2026-04-10T00:00:00.000Z",
      { notes: "must remain revision one" },
    );
    const createOnly: Api3MutationOptions = {
      canCreate: true,
      canUpdate: false,
      actor: "creator-a",
      ifUnmodifiedSince: null,
    };

    const decisions = await Promise.all([
      api3Create(stub, document, createOnly),
      api3Create(stub, document, createOnly),
    ]);
    const successes = decisions.filter(
      (decision): decision is Extract<Api3MutationDecision, { ok: true }> => decision.ok,
    );
    const failures = decisions.filter(
      (decision): decision is Extract<Api3MutationDecision, { ok: false }> => !decision.ok,
    );

    expect(successes).toHaveLength(1);
    expect(successes[0]?.mutation).toMatchObject({ created: true, revision: 1 });
    expect(failures).toEqual([{ ok: false, reason: "missing-update-permission" }]);
    expect(await findByIdentifier(stub, "create-only-race")).toMatchObject({
      notes: "must remain revision one",
      subject: "creator-a",
    });
  });

  it("keeps API3 PUT existence lookup and update-only permission selection atomic", async () => {
    const stub = store("api3-update-only-branch");
    const existing = treatment("put-existing", "2026-04-11T00:00:00.000Z", {
      notes: "before",
    });
    await api3Create(stub, existing, {
      canCreate: true,
      canUpdate: true,
      actor: "creator-b",
      ifUnmodifiedSince: null,
    });
    const updateOnly: Api3MutationOptions = {
      canCreate: false,
      canUpdate: true,
      actor: "updater-b",
      ifUnmodifiedSince: null,
    };

    const updated = await api3Replace(stub, "put-existing", {
      ...existing,
      notes: "after",
    }, updateOnly);
    expect(updated).toMatchObject({ ok: true, mutation: { created: false, revision: 2 } });

    const missing = await Promise.all([
      api3Replace(stub, "put-missing-a", {
        ...existing,
        identifier: "put-missing-a",
      }, updateOnly),
      api3Replace(stub, "put-missing-b", {
        ...existing,
        identifier: "put-missing-b",
      }, updateOnly),
    ]);
    expect(missing).toEqual([
      { ok: false, reason: "missing-create-permission" },
      { ok: false, reason: "missing-create-permission" },
    ]);
    expect(await findByIdentifier(stub, "put-missing-a")).toBeNull();
    expect(await findByIdentifier(stub, "put-missing-b")).toBeNull();
  });

  it("does not treat an arbitrary API3 body _id as an extra deduplication selector", async () => {
    const stub = store("api3-body-id-not-dedup");
    const legacyId = "1234567890abcdef12345678";
    await upsertTreatment(stub, {
      _id: legacyId,
      eventType: "Note",
      created_at: "2026-04-12T00:00:00.000Z",
      notes: "legacy must survive",
    });

    await runInDurableObject(stub, async (instance: EntryStore) => {
      const decision = decode<Api3MutationDecision>(await instance.api3CreateTreatment(JSON.stringify({
        ...treatment("unrelated-api3-identifier", "2026-04-13T00:00:00.000Z"),
        _id: legacyId,
        eventType: "Note",
        notes: "must not overwrite by body id",
      }), JSON.stringify({
        canCreate: true,
        canUpdate: true,
        actor: "creator-c",
        ifUnmodifiedSince: null,
        validate: true,
      } satisfies Api3MutationOptions)));
      expect(decision).toMatchObject({
        ok: false,
        reason: "operation-error",
        message: expect.stringContaining("E11000 duplicate key error"),
      });
    });

    expect(await findById(stub, legacyId, true)).toMatchObject({
      identifier: legacyId,
      notes: "legacy must survive",
    });
    expect(await findByIdentifier(stub, "unrelated-api3-identifier", true)).toBeNull();
  });

  it("records distinct API3 create, patch, and soft-delete actors", async () => {
    const stub = store("api3-mutation-actors");
    const document = treatment("actor-chain", "2026-04-14T00:00:00.000Z");
    await api3Create(stub, document, {
      canCreate: true,
      canUpdate: true,
      actor: "creator-d",
      ifUnmodifiedSince: null,
    });
    const patched = decode<Api3MutationDecision>(await stub.api3PatchTreatment(
      "actor-chain",
      JSON.stringify({ notes: "changed by a second subject" }),
      JSON.stringify({
        canCreate: false,
        canUpdate: true,
        actor: "updater-d",
        ifUnmodifiedSince: null,
      } satisfies Api3MutationOptions),
    ));
    expect(patched).toMatchObject({
      ok: true,
      mutation: { document: { subject: "creator-d", modifiedBy: "updater-d" } },
    });

    expect(await stub.api3DeleteTreatment("actor-chain", false, "deleter-d")).toMatchObject({
      deleted: true,
      permanent: false,
    });
    expect(await findByIdentifier(stub, "actor-chain", true)).toMatchObject({
      subject: "creator-d",
      modifiedBy: "deleter-d",
      isValid: false,
    });
  });

  it("does not pass the stored treatment as duration fallback during replacement", async () => {
    const stub = store("api3-duration-order");
    const fallbackMills = Date.parse("2026-04-15T00:00:00.000Z");
    await createTreatment(stub, treatment(
      "duration-order",
      "2026-04-14T00:00:00.000Z",
      { mills: fallbackMills },
    ));
    const replacementCreatedAt = "2026-04-16T00:00:00.000Z";
    const replaced = decode<DocumentMutationResult>(await stub.replaceTreatment(
      "duration-order",
      JSON.stringify({ created_at: replacementCreatedAt, duration: 10 }),
    ));
    const replacementBase = Date.parse(replacementCreatedAt);
    expect(replaced.document).toMatchObject({
      endmills: replacementBase + 10 * 60_000,
      durationInMilliseconds: 10 * 60_000,
      duration: 10,
    });
    expect(replaced.document.endmills).not.toBe(fallbackMills + 10 * 60_000);
  });

  it("enforces API3 immutable fields while preserving deduplication exceptions", async () => {
    const stub = store("immutable");
    const base: JsonDocument = {
      identifier: "immutable",
      date: Date.parse("2026-03-25T00:00:00.000Z"),
      utcOffset: 0,
      eventType: "Correction Bolus",
      device: "pump-a",
      app: "test-app",
      created_at: "2026-03-25T00:00:00.000Z",
      subject: "subject-a",
      modifiedBy: "modifier-a",
      insulin: 1,
    };
    const created = await createTreatment(stub, base);
    const changes: Record<string, JsonDocument["identifier"]> = {
      identifier: "other-identifier",
      date: Number(base.date) + 1,
      utcOffset: 60,
      eventType: "Meal Bolus",
      device: "pump-b",
      app: "other-app",
      srvCreated: Number(created.document.srvCreated) + 1,
      subject: "subject-b",
      srvModified: Number(created.document.srvModified) + 1,
      modifiedBy: "modifier-b",
      isValid: false,
    };
    await runInDurableObject(stub, async (instance: EntryStore) => {
      for (const [field, value] of Object.entries(changes)) {
        await expect(instance.patchTreatment("immutable", JSON.stringify({ [field]: value })))
          .rejects.toThrow(`Field ${field} cannot be modified by the client`);
        if (field !== "identifier") {
          await expect(instance.replaceTreatment(
            "immutable",
            JSON.stringify({ ...base, [field]: value }),
          )).rejects.toThrow(`Field ${field} cannot be modified by the client`);
        }
      }
    });

    const pathWins = decode<DocumentMutationResult>(await stub.replaceTreatment(
      "immutable",
      JSON.stringify({ ...base, identifier: "ignored-body-identifier", insulin: 2 }),
    ));
    expect(pathWins.document).toMatchObject({ identifier: "immutable", insulin: 2 });

    const legacy = await upsertTreatment(stub, {
      date: Date.parse("2026-03-26T00:00:00.000Z"),
      utcOffset: 0,
      eventType: "Meal Bolus",
      device: "legacy-device",
      app: "legacy-app",
      created_at: "2026-03-26T00:00:00.000Z",
    });
    const deduplicated = await createTreatment(stub, {
      identifier: "adopted-identifier",
      date: Date.parse("2026-03-26T00:00:00.000Z"),
      utcOffset: 0,
      eventType: "Meal Bolus",
      device: "legacy-device",
      app: "legacy-app",
      created_at: "2026-03-26T00:00:00.000Z",
    });
    expect(deduplicated.document).not.toHaveProperty("_id");
    expect(await storedId(stub, "adopted-identifier")).toBe(legacy.document._id);

    const immutableLegacy = await upsertTreatment(stub, {
      date: Date.parse("2026-03-27T00:00:00.000Z"),
      utcOffset: 0,
      eventType: "Meal Bolus",
      device: "legacy-device",
      app: "legacy-app",
      created_at: "2026-03-27T00:00:00.000Z",
    });
    await runInDurableObject(stub, async (instance: EntryStore) => {
      await expect(instance.createTreatment(JSON.stringify({
        identifier: "identifier-only-exception",
        date: Date.parse("2026-03-27T00:00:00.000Z"),
        utcOffset: 0,
        eventType: "Meal Bolus",
        device: "changed-device",
        app: "legacy-app",
        created_at: "2026-03-27T00:00:00.000Z",
      }))).rejects.toThrow("Field device cannot be modified by the client");
    });
    expect(await findById(stub, String(immutableLegacy.document._id))).not.toBeNull();
  });

  it("allows only API3 create dedup to resurrect tombstones", async () => {
    const stub = store("tombstone-exception");
    const original = await createTreatment(stub, {
      identifier: "resurrect",
      date: Date.parse("2026-03-28T00:00:00.000Z"),
      utcOffset: 0,
      eventType: "Correction Bolus",
      device: "pump-a",
      app: "app-a",
      created_at: "2026-03-28T00:00:00.000Z",
    });
    expect(original.document).not.toHaveProperty("_id");
    const originalId = await storedId(stub, "resurrect");
    await stub.deleteTreatment("resurrect");
    await runInDurableObject(stub, async (instance: EntryStore) => {
      await expect(instance.replaceTreatment("resurrect", JSON.stringify({
        identifier: "resurrect",
        date: Date.parse("2026-03-29T00:00:00.000Z"),
        utcOffset: 60,
        eventType: "Meal Bolus",
        device: "pump-b",
        app: "app-b",
        created_at: "2026-03-29T00:00:00.000Z",
      }))).rejects.toThrow("document is deleted");
      await expect(instance.patchTreatment("resurrect", JSON.stringify({ device: "pump-b" })))
        .rejects.toThrow("document is deleted");
    });

    const resurrected = await createTreatment(stub, {
      identifier: "resurrect",
      date: Date.parse("2026-03-29T00:00:00.000Z"),
      utcOffset: 60,
      eventType: "Meal Bolus",
      device: "pump-b",
      app: "app-b",
      created_at: "2026-03-29T00:00:00.000Z",
      srvCreated: 1,
      srvModified: 2,
    });
    expect(resurrected.document).toMatchObject({
      identifier: "resurrect",
      eventType: "Meal Bolus",
      device: "pump-b",
      srvCreated: original.srvModified,
    });
    expect(resurrected.document).not.toHaveProperty("_id");
    expect(await storedId(stub, "resurrect")).toBe(originalId);
    expect(resurrected.document.isValid).not.toBe(false);

    await upsertTreatment(stub, {
      ...resurrected.document,
      isValid: false,
      isReadOnly: true,
    });
    await runInDurableObject(stub, async (instance: EntryStore) => {
      await expect(instance.createTreatment(JSON.stringify({
        identifier: "resurrect",
        date: Date.parse("2026-03-30T00:00:00.000Z"),
        utcOffset: 0,
        eventType: "Note",
        device: "pump-c",
        app: "app-c",
        created_at: "2026-03-30T00:00:00.000Z",
      }))).rejects.toThrow("Trying to modify read-only document");
    });
  });

  it("rejects queries beyond Durable Objects SQLite binding and LIKE limits", async () => {
    const stub = store("query-limits");
    const values = Array.from({ length: 98 }, (_, index) => `identifier-${index}`);
    await runInDurableObject(stub, async (instance: EntryStore) => {
      for (const operator of ["in", "nin"] as const) {
        expect(decode(await instance.queryTreatments(JSON.stringify({
          filters: [{ field: "identifier", operator, value: values.slice(0, 97) }],
          limit: 1,
        })))).toEqual([]);
        await expect(instance.queryTreatments(JSON.stringify({
          filters: [{ field: "identifier", operator, value: values }],
          limit: 1,
        }))).rejects.toThrow("100 bound-parameter limit");
      }
      await expect(instance.queryTreatments(JSON.stringify({
        filters: [{ field: "notes", operator: "re", value: "x".repeat(49) }],
        limit: 1,
      }))).rejects.toThrow("50-byte limit");
      expect(decode(await instance.queryTreatments(JSON.stringify({
        filters: [{ field: "notes", operator: "re", value: "x".repeat(48) }],
        limit: 1,
      })))).toEqual([]);
      await expect(instance.queryTreatments(JSON.stringify({
        sort: [{ field: "date", direction: "sideways" }],
        limit: 1,
      }))).rejects.toThrow("invalid document sort direction sideways");
      expect(decode(await instance.queryTreatments(JSON.stringify({
        skip: Number.MAX_SAFE_INTEGER,
        limit: 1,
      })))).toEqual([]);
      await expect(instance.queryTreatments(JSON.stringify({
        skip: Number.MAX_SAFE_INTEGER + 1,
        limit: 1,
      }))).rejects.toThrow("non-negative safe integer");
    });
  });

  it("keeps Mongo-style missing and null semantics for NIN", async () => {
    const stub = store("query-nin");
    await createTreatment(stub, treatment("nin-missing", "2026-03-31T00:00:00.000Z"));
    await createTreatment(stub, treatment("nin-null", "2026-03-31T00:01:00.000Z", { notes: null }));
    await createTreatment(stub, treatment("nin-blocked", "2026-03-31T00:02:00.000Z", { notes: "blocked" }));
    await createTreatment(stub, treatment("nin-allowed", "2026-03-31T00:03:00.000Z", { notes: "allowed" }));

    const withoutBlocked = await queryTreatments(stub, {
      filters: [{ field: "notes", operator: "nin", value: ["blocked"] }],
      limit: 10,
    });
    expect(withoutBlocked.map((document) => document.identifier).sort()).toEqual([
      "nin-allowed",
      "nin-missing",
      "nin-null",
    ]);

    const withoutNull = await queryTreatments(stub, {
      filters: [{ field: "notes", operator: "nin", value: [null] }],
      limit: 10,
    });
    expect(withoutNull.map((document) => document.identifier).sort()).toEqual([
      "nin-allowed",
      "nin-blocked",
      "nin-missing",
    ]);
  });

  it("filters in SQLite before applying limit", async () => {
    const stub = store("filter-before-limit");
    await createTreatment(stub, treatment("matching", "2026-04-01T00:00:00.000Z", { notes: "needle" }));
    await createTreatment(stub, treatment("newer-non-match", "2026-04-02T00:00:00.000Z", { notes: "haystack" }));

    const matches = await queryTreatments(stub, {
      filters: [{ field: "notes", operator: "eq", value: "needle" }],
      sort: { field: "created_at", direction: "desc" },
      limit: 1,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ identifier: "matching", notes: "needle" });
  });

  it("returns ascending projected history with visible tombstones and erases permanent deletes", async () => {
    const stub = store("history");
    const first = await createTreatment(stub, treatment("history-a", "2026-05-01T00:00:00.000Z"));
    expect(first.document).not.toHaveProperty("_id");
    const firstId = await storedId(stub, "history-a");
    const second = await createTreatment(stub, treatment("history-b", "2026-05-01T00:01:00.000Z"));
    await patchTreatment(stub, "history-a", { insulin: 1.5 });
    const deleted = await stub.deleteTreatment("history-a");

    const history = await treatmentHistory(stub, {
      since: 0,
      fields: ["identifier", "srvModified", "isValid"],
    });
    expect(history.map((document) => document.identifier)).toEqual(["history-b", "history-a"]);
    expect(history[0]?.srvModified).toBe(second.srvModified);
    expect(history[1]).toEqual({
      identifier: "history-a",
      srvModified: deleted.srvModified,
      isValid: false,
    });
    expect(await findByIdentifier(stub, "history-a")).toBeNull();
    expect(await findByIdentifier(stub, "history-a", true)).toMatchObject({ isValid: false });

    expect((await stub.deleteTreatment("history-a", true)).deleted).toBe(true);
    expect(await findById(stub, firstId, true)).toBeNull();
    expect((await treatmentHistory(stub, { since: 0 })).some(
      (document) => document.identifier === "history-a",
    )).toBe(false);
  });

  it("rolls back document, clock, and change rows when the change insert fails", async () => {
    const stub = store("atomic-failure");
    await stub.treatmentsLastModified();
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER fail_treatment_change
        BEFORE INSERT ON document_changes
        WHEN NEW.collection = 'treatments'
        BEGIN
          SELECT RAISE(ABORT, 'forced document_changes failure');
        END;
      `);
      await expect(instance.createTreatment(JSON.stringify(treatment(
        "atomic-id",
        "2026-06-01T00:00:00.000Z",
      )))).rejects.toThrow("forced document_changes failure");
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM documents WHERE collection = 'treatments'",
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM document_changes WHERE collection = 'treatments'",
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM collection_clocks WHERE collection = 'treatments'",
      ).one().count).toBe(0);
    });
  });
});
