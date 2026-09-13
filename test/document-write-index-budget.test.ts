import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import { migrateDocumentWriteIndexesV29, SqliteDocumentRepository } from "../src/document-repository";

const options = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false };
const oldIndex = "CREATE INDEX document_changes_collection_history ON document_changes(collection, srv_modified ASC, change_id ASC)";

function snapshot(sql: SqlStorage): string {
  return JSON.stringify({
    documents: sql.exec("SELECT * FROM documents ORDER BY collection, id").toArray(),
    changes: sql.exec("SELECT * FROM document_changes ORDER BY change_id").toArray(),
    clocks: sql.exec("SELECT * FROM collection_clocks ORDER BY collection").toArray(),
    sequence: sql.exec("SELECT * FROM sqlite_sequence WHERE name = 'document_changes'").toArray(),
  });
}

function indexNames(sql: SqlStorage): string[] {
  return sql.exec<{ name: string }>("PRAGMA index_list(document_changes)").toArray().map(row => row.name);
}

function create(repository: SqliteDocumentRepository, identifier: string): void {
  expect(repository.createDocumentForApi3("devicestatus", {
    identifier, app: "AAPS", device: "synthetic-index-budget",
    date: Date.UTC(2026, 8, 13, 10), utcOffset: 0, uploaderBattery: 80,
  }, options).ok).toBe(true);
}

describe("revision ledger index write cost", () => {
  it("saves one actual SQL row write per upload while preserving every existing row and cursor", async () => {
    const stub = env.ENTRY_STORE.getByName(`ledger-index-budget-${crypto.randomUUID()}`);
    const measured = await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const sql = state.storage.sql;
      const repository = new SqliteDocumentRepository(state.storage);
      expect(indexNames(sql)).not.toContain("document_changes_collection_history");
      expect(indexNames(sql)).toContain("document_changes_document");
      // Reconstruct only the old redundant index to compare the same runtime
      // and storage shape before and after the migration.
      sql.exec(oldIndex);
      create(repository, "synthetic-prime-clock");
      const exec = sql.exec.bind(sql);
      const captured: { statement: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
      const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
        const cursor = exec(statement, ...bindings);
        captured.push({ statement, cursor });
        return cursor;
      });
      const writes = () => ({
        all: captured.reduce((total, item) => total + item.cursor.rowsWritten, 0),
        ledger: captured.filter(item => /INSERT INTO document_changes/.test(item.statement))
          .reduce((total, item) => total + item.cursor.rowsWritten, 0),
      });
      try {
        create(repository, "synthetic-before-index-removal");
        const before = writes();
        const fingerprint = snapshot(sql);
        const history = repository.documentHistory("devicestatus", { since: 0 });
        const lastModified = repository.collectionLastModified("devicestatus");
        captured.length = 0;
        state.storage.transactionSync(() => migrateDocumentWriteIndexesV29(sql));
        const migrationWrites = writes().all;
        expect(snapshot(sql)).toBe(fingerprint);
        expect(repository.documentHistory("devicestatus", { since: 0 })).toEqual(history);
        expect(repository.collectionLastModified("devicestatus")).toBe(lastModified);
        expect(indexNames(sql)).not.toContain("document_changes_collection_history");
        expect(indexNames(sql)).toContain("document_changes_document");
        captured.length = 0;
        migrateDocumentWriteIndexesV29(sql);
        const repeatedMigrationWrites = writes().all;
        expect(snapshot(sql)).toBe(fingerprint);
        captured.length = 0;
        create(repository, "synthetic-after-index-removal");
        const after = writes();
        expect(before.ledger).toBe(4);
        expect(after.ledger).toBe(3);
        expect(after.all).toBe(before.all - 1);
        expect(repeatedMigrationWrites).toBe(0);
        return { before, after, migrationWrites, repeatedMigrationWrites };
      } finally {
        spy.mockRestore();
      }
    });
    console.log("DOCUMENT_INDEX_SQL", JSON.stringify(measured));
  });

  it("keeps ledger lookups and public incremental history indexed after removal", async () => {
    const stub = env.ENTRY_STORE.getByName(`ledger-index-query-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const sql = state.storage.sql;
      const repository = new SqliteDocumentRepository(state.storage);
      create(repository, "synthetic-history-lookup");
      sql.exec(oldIndex);
      migrateDocumentWriteIndexesV29(sql);
      const plan = (query: string, ...bindings: SqlStorageValue[]) => sql.exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${query}`, ...bindings,
      ).toArray().map(row => row.detail).join("\n");
      expect(plan("SELECT change_id FROM document_changes WHERE collection = ? AND id = ? AND revision = ?", "devicestatus", "synthetic-id", 1))
        .toContain("document_changes_document");
      expect(plan("SELECT change_id FROM document_changes WHERE collection = ? AND id = ? LIMIT 129", "devicestatus", "synthetic-id"))
        .toContain("document_changes_document");
      expect(plan("SELECT * FROM documents WHERE collection = ? AND effective_modified > ? ORDER BY effective_modified ASC, id ASC LIMIT 1000", "devicestatus", 0))
        .toContain("documents_collection_effective_modified");
      expect(repository.deleteDocumentForApi3("devicestatus", "synthetic-history-lookup", true).deleted).toBe(true);
      expect(repository.documentHistory("devicestatus", { since: 0 })).toEqual([]);
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM document_changes WHERE collection = 'devicestatus'").one().count).toBe(0);
    });
  });

  it("rolls an interrupted DROP back without losing revision or sequence state", async () => {
    const stub = env.ENTRY_STORE.getByName(`ledger-index-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const sql = state.storage.sql;
      create(new SqliteDocumentRepository(state.storage), "synthetic-before-rollback");
      sql.exec(oldIndex);
      const fingerprint = snapshot(sql);
      expect(() => state.storage.transactionSync(() => {
        migrateDocumentWriteIndexesV29(sql);
        throw new Error("synthetic migration interruption");
      })).toThrow("synthetic migration interruption");
      expect(indexNames(sql)).toContain("document_changes_collection_history");
      expect(snapshot(sql)).toBe(fingerprint);
      state.storage.transactionSync(() => migrateDocumentWriteIndexesV29(sql));
      expect(snapshot(sql)).toBe(fingerprint);
    });
  });

  it("still rolls back the document, clock and revision when the ledger insert fails", async () => {
    const stub = env.ENTRY_STORE.getByName(`ledger-insert-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const sql = state.storage.sql;
      const repository = new SqliteDocumentRepository(state.storage);
      create(repository, "synthetic-before-insert-failure");
      migrateDocumentWriteIndexesV29(sql);
      const fingerprint = snapshot(sql);
      sql.exec(`CREATE TRIGGER synthetic_ledger_failure BEFORE INSERT ON document_changes
        WHEN NEW.collection = 'devicestatus' BEGIN
          SELECT RAISE(ABORT, 'synthetic revision insert failure');
        END`);
      expect(() => create(repository, "synthetic-failed-upload")).toThrow("synthetic revision insert failure");
      expect(snapshot(sql)).toBe(fingerprint);
      sql.exec("DROP TRIGGER synthetic_ledger_failure");
      create(repository, "synthetic-recovered-upload");
      expect(repository.documentHistory("devicestatus", { since: 0 })).toHaveLength(2);
    });
  });
});
