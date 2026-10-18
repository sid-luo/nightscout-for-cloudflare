import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import type { EntryStore, JsonDocument } from "../src/entry-store";

const id = (n: number) => n.toString(16).padStart(24, "0");
const indexPredicate = " AND collection IN ('treatments', 'devicestatus') AND json_valid(body)";

function observeTreatmentReads(instance: EntryStore, storage: DurableObjectStorage) {
  const exec = storage.sql.exec.bind(storage.sql);
  let cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  let documentSqlCalls = 0;
  const spy = vi.spyOn(storage.sql, "exec").mockImplementation((sql, ...bindings) => {
    const cursor = exec(sql, ...bindings);
    cursors.push(cursor);
    if (sql.startsWith("SELECT") && sql.includes("FROM documents")) documentSqlCalls++;
    return cursor;
  });
  return {
    restore: () => spy.mockRestore(),
    read: async (query: DocumentQuery, uuidHandling = true) => {
      cursors = [];
      documentSqlCalls = 0;
      const result = await instance.queryLegacyTreatmentsWithUuidHandling(JSON.stringify(query), uuidHandling);
      return { result, documents: JSON.parse(result) as JsonDocument[], sqlCalls: cursors.length, documentSqlCalls,
        rowsRead: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
        rowsWritten: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0) };
    },
  };
}

describe("legacy treatment REST read budget", () => {
  it("uses the treatment category index for recent matches without changing results", async () => {
    const stub = env.ENTRY_STORE.getByName(`legacy-treatment-budget-${crypto.randomUUID()}`);
    const measurements = await runInDurableObject(stub, (_instance, state) => {
      const repository = new SqliteDocumentRepository(state.storage);
      const now = Date.parse("2026-10-13T00:00:00Z");
      state.storage.transactionSync(() => {
        for (let n = 0; n < 5_000; n++) {
          const at = now - (5_000 - n) * 300_000;
          // Direct seeding deliberately includes all preserved body variants,
          // avoiding write normalization when testing the read contract.
          state.storage.sql.exec(`INSERT INTO documents
            (collection,id,body,sort_time,created_at,updated_at)
            VALUES('treatments',?,?,?,?,?)`, id(n), JSON.stringify({
            created_at: new Date(at).toISOString(),
            eventType: n % 4 === 0 ? "Sensor Change" : "Note",
          }), at, at, at);
        }
      });
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      let captured: { sql: string; bindings: SqlStorageValue[]; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((statement, ...bindings) => {
        const cursor = exec(statement, ...bindings);
        captured.push({ sql: statement.replace(/\s+/g, " ").trim(), bindings, cursor });
        return cursor;
      });
      const reports = [];
      try {
        for (const eventType of ["Sensor Change", "Absent Synthetic Type"]) {
          const query: DocumentQuery = { limit: 1, filters: [
            { field: "created_at", operator: "gte", value: "2026-09-01" },
            { field: "eventType", operator: "eq", value: eventType },
          ] };
          captured = [];
          const actual = repository.queryLegacyTreatments(query);
          const statement = captured.find(item => item.sql.startsWith("SELECT") && item.sql.includes("FROM documents"))!;
          expect(statement).toBeDefined();
          const baseline = exec(statement.sql
            .replaceAll(" INDEXED BY documents_treatments_event_type_created_at", "")
            .replaceAll(indexPredicate, ""), ...statement.bindings);
          const expected = baseline.toArray().map(row => ({ ...JSON.parse(String(row.body)), _id: row.id }));
          expect(actual).toEqual(expected);
          const plan = exec(`EXPLAIN QUERY PLAN ${statement.sql}`, ...statement.bindings).toArray();
          reports.push({ eventType, actual: actual.length, beforeReads: baseline.rowsRead,
            afterReads: statement.cursor.rowsRead, afterWrites: statement.cursor.rowsWritten, plan });
          if (eventType === "Sensor Change") {
            expect(statement.cursor.rowsRead).toBeLessThan(30);
            expect(JSON.stringify(plan)).toContain("documents_treatments_event_type_created_at");
          }
        }
      } finally { spy.mockRestore(); }
      return reports;
    });
    console.log(`LEGACY_TREATMENT_READ_BUDGET=${JSON.stringify(measurements)}`);
  });

  it("preserves scalar/array predicates, date ties, missing fields, pagination and UUID matching", async () => {
    const stub = env.ENTRY_STORE.getByName(`legacy-treatment-semantics-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const repository = new SqliteDocumentRepository(state.storage);
      const sameDate = "2026-10-12T00:00:00.000Z";
      const uuid = "ee340c50-c8e6-4bba-8dab-8c82794dc0ab";
      const bodies: JsonDocument[] = [
        { created_at: sameDate, eventType: "Sensor Change", marker: "tie-first" },
        { created_at: sameDate, eventType: ["Note", "Sensor Change"], marker: "tie-second" },
        { created_at: sameDate, eventType: "Sensor Change", marker: "tie-third" },
        { created_at: "2026-10-13T00:00:00Z", eventType: "Note", marker: "newer-unmatched" },
        { created_at: "2026-10-10T00:00:00Z", marker: "missing-event" },
        { created_at: sameDate, eventType: null, marker: "null-event" },
        { created_at: sameDate, eventType: 7, marker: "numeric-event" },
        { created_at: sameDate, eventType: false, marker: "boolean-event" },
        { created_at: ["2026-10-14T00:00:00Z", "2026-10-01T00:00:00Z"], eventType: "Sensor Change", marker: "array-date" },
        { created_at: 7, eventType: "Sensor Change", marker: "numeric-date" },
        { created_at: null, eventType: "Sensor Change", marker: "null-date" },
        { eventType: "Sensor Change", marker: "missing-date" },
        { created_at: true, eventType: "Sensor Change", marker: "boolean-date" },
        { created_at: { nested: sameDate }, eventType: "Sensor Change", marker: "object-date" },
        { created_at: sameDate, eventType: [7, null, false], marker: "mixed-event-array" },
        { created_at: sameDate, identifier: uuid, eventType: "Note", marker: "uuid" },
      ];
      state.storage.transactionSync(() => {
        for (const [n, body] of bodies.entries()) {
          state.storage.sql.exec(`INSERT INTO documents
            (collection,id,body,sort_time,created_at,updated_at,identifier)
            VALUES('treatments',?,?,?,?,?,?)`, id(n + 1), JSON.stringify(body), n, n, n,
          typeof body.identifier === "string" ? body.identifier : null);
        }
      });
      const queries: DocumentQuery[] = [
        { limit: 100 },
        { filters: [{ field: "eventType", operator: "eq", value: "Sensor Change" }], limit: 1 },
        { filters: [{ field: "eventType", operator: "eq", value: "Sensor Change" }], limit: 3, skip: 1 },
        { filters: [{ field: "eventType", operator: "eq", value: null }], limit: 100 },
        { filters: [{ field: "eventType", operator: "eq", value: 7 }], limit: 100 },
        { filters: [{ field: "eventType", operator: "eq", value: false }], limit: 100 },
        { filters: [{ field: "eventType", operator: "in", value: ["Note", 7, null] }], limit: 100 },
        { filters: [{ field: "eventType", operator: "ne", value: "Note" }], limit: 100 },
        { filters: [{ field: "created_at", operator: "gte", value: sameDate }], limit: 100 },
        { filters: [{ field: "created_at", operator: "eq", value: sameDate }], limit: 100 },
        { filters: [{ field: "created_at", operator: "gte", value: 1 }], limit: 100 },
        { filters: [{ field: "created_at", operator: "eq", value: null }], limit: 100 },
        { filters: [{ field: "created_at", operator: "exists", value: false }], limit: 100 },
        { filters: [{ field: "created_at", operator: "re", value: "^2026-10" }], limit: 100 },
        { filters: [{ field: "eventType", operator: "eq", value: "Absent Type" }], limit: 1 },
        { filters: [{ field: "_id", operator: "eq", value: uuid }], legacyUuidHandling: true },
        { filters: [{ field: "_id", operator: "eq", value: uuid }], legacyUuidHandling: false },
        { filters: [{ field: "_id", operator: "eq", value: id(2) }], fields: ["_id", "marker"] },
        { sort: { field: "created_at", direction: "asc" }, limit: 4, skip: 3 },
        { sort: [{ field: "created_at", direction: "desc" }, { field: "_id", direction: "desc" }], limit: 4 },
      ];
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      let selected: { sql: string; bindings: SqlStorageValue[] } | undefined;
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...bindings) => {
        if (sql.startsWith("SELECT") && sql.includes("FROM documents")) selected = { sql: sql.replace(/\s+/g, " ").trim(), bindings };
        return exec(sql, ...bindings);
      });
      try {
        for (const query of queries) {
          selected = undefined;
          const actual = repository.queryLegacyTreatments(query);
          expect(selected).toBeDefined();
          const statement = selected!;
          const expected = exec<{ id: string; body: string }>(
            statement.sql.replaceAll(" INDEXED BY documents_treatments_event_type_created_at", "")
              .replaceAll(indexPredicate, ""), ...statement.bindings,
          ).toArray().map(row => {
            const document: JsonDocument = { ...JSON.parse(row.body), _id: row.id };
            return query.fields === undefined || query.fields.includes("_all") ? document
              : Object.fromEntries(query.fields.filter(field => document[field] !== undefined).map(field => [field, document[field]]));
          });
          expect(actual, JSON.stringify(query)).toEqual(expected);
        }
        const tied = repository.queryLegacyTreatments({ filters: [
          { field: "created_at", operator: "eq", value: sameDate },
          { field: "eventType", operator: "eq", value: "Sensor Change" },
        ], limit: 2, skip: 1 });
        expect(tied.map(row => row.marker)).toEqual(["tie-second", "tie-third"]);
      } finally { spy.mockRestore(); }
    });
  });

  it("reuses populated and empty REST results without mixing query options, UUID modes or collections", async () => {
    const stub = env.ENTRY_STORE.getByName(`legacy-treatment-cache-keys-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const uuid = "6d321378-1933-4e63-a623-198fe5c04180";
      await instance.createDocuments("treatments", JSON.stringify([
        { _id: id(1), created_at: "2026-10-13T00:00:00Z", eventType: "Sensor Change", notes: "newest", identifier: uuid },
        { _id: id(2), created_at: "2026-10-12T00:00:00Z", eventType: "Sensor Change", notes: "older" },
        { _id: id(3), created_at: "2026-10-11T00:00:00Z", eventType: "Note", notes: "other category" },
      ]));
      const observer = observeTreatmentReads(instance, state.storage);
      const matched: DocumentQuery = { limit: 1, filters: [{ field: "eventType", operator: "eq", value: "Sensor Change" }] };
      try {
        for (const query of [matched, { ...matched, filters: [{ field: "eventType", operator: "eq", value: "Absent Synthetic Type" }] } as DocumentQuery]) {
          const first = await observer.read(query);
          // An indexed cold miss can execute its data query without visiting
          // any stored row. Distinguish that from a cache hit by SQL calls.
          expect(first.documentSqlCalls).toBeGreaterThan(0);
          expect(first.rowsWritten).toBe(0);
          expect(first.documents).toHaveLength(query === matched ? 1 : 0);
          const repeat = await observer.read(query);
          expect(repeat.result).toBe(first.result);
          expect(repeat).toMatchObject({ documentSqlCalls: 0, rowsRead: 0, rowsWritten: 0 });
        }
        const variants: { query: DocumentQuery; notes: unknown[] }[] = [
          { query: { ...matched, limit: 2 }, notes: ["newest", "older"] },
          { query: { ...matched, skip: 1 }, notes: ["older"] },
          { query: { ...matched, sort: { field: "created_at", direction: "asc" } }, notes: ["older"] },
          { query: { ...matched, fields: ["notes"] }, notes: ["newest"] },
          { query: { ...matched, filters: [{ field: "eventType", operator: "eq", value: "Note" }] }, notes: ["other category"] },
        ];
        for (const { query, notes } of variants) {
          const first = await observer.read(query);
          expect(first.documentSqlCalls).toBeGreaterThan(0);
          expect(first.documents.map(document => document.notes)).toEqual(notes);
          if (query.fields) expect(first.documents).toEqual([{ notes: "newest" }]);
          expect(await observer.read(query)).toMatchObject({ result: first.result, documentSqlCalls: 0, rowsRead: 0 });
        }
        // The method argument overrides a conflicting serialized query flag.
        const uuidQuery: DocumentQuery = { filters: [{ field: "_id", operator: "eq", value: uuid }], legacyUuidHandling: false };
        for (const uuidHandling of [true, false]) {
          const first = await observer.read(uuidQuery, uuidHandling);
          expect(first.documentSqlCalls).toBeGreaterThan(0);
          expect(first.documents).toHaveLength(uuidHandling ? 1 : 0);
          expect(await observer.read(uuidQuery, uuidHandling)).toMatchObject({ result: first.result, documentSqlCalls: 0, rowsRead: 0 });
        }
        await instance.createDocuments("devicestatus", JSON.stringify([{ _id: id(4), created_at: "2026-10-13T00:00:00Z", device: "synthetic" }]));
        expect(await observer.read(matched)).toMatchObject({ documentSqlCalls: 0, rowsRead: 0 });
      } finally { observer.restore(); }
    });
  });

  it("invalidates treatment results on create, update, delete and rollback from either mutation callback", async () => {
    const stub = env.ENTRY_STORE.getByName(`legacy-treatment-cache-mutations-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const query: DocumentQuery = { limit: 1, filters: [{ field: "eventType", operator: "eq", value: "Sensor Change" }] };
      const document = { _id: id(1), created_at: "2026-10-13T00:00:00Z", eventType: "Sensor Change", notes: "created" };
      const observer = observeTreatmentReads(instance, state.storage);
      const internal = instance as unknown as {
        recordDataMutationInTransaction(collection: string): void;
        realtime: { recordApi3StorageMutationInTransaction(event: unknown): void };
      };
      try {
        expect((await observer.read(query)).documents).toEqual([]);
        expect(await observer.read(query)).toMatchObject({ documentSqlCalls: 0, rowsRead: 0 });
        await instance.createDocuments("treatments", JSON.stringify([document]));
        const created = await observer.read(query);
        expect(created.sqlCalls).toBeGreaterThan(0);
        expect(created.documents[0]?.notes).toBe("created");
        expect(await observer.read(query)).toMatchObject({ result: created.result, documentSqlCalls: 0, rowsRead: 0 });
        await instance.saveLegacyTreatmentsWithUuidHandling(JSON.stringify([{ ...document, notes: "updated" }]), true);
        const updated = await observer.read(query);
        expect(updated.sqlCalls).toBeGreaterThan(0);
        expect(updated.documents[0]?.notes).toBe("updated");
        expect(await observer.read(query)).toMatchObject({ result: updated.result, documentSqlCalls: 0, rowsRead: 0 });
        expect(await instance.deleteLegacyTreatmentWithUuidHandling(id(1), true)).toBe(true);
        const deleted = await observer.read(query);
        expect(deleted.sqlCalls).toBeGreaterThan(0);
        expect(deleted.documents).toEqual([]);
        expect(await observer.read(query)).toMatchObject({ result: deleted.result, documentSqlCalls: 0, rowsRead: 0 });

        for (const callback of ["realtime", "data"] as const) {
          const original = callback === "realtime"
            ? internal.realtime.recordApi3StorageMutationInTransaction : internal.recordDataMutationInTransaction;
          let uncommitted: Promise<string> | undefined;
          const fail = () => {
            // This read populates the synchronous result cache before the
            // transaction fails. Both the pre-callback and finally clears
            // are necessary to avoid returning old or rolled-back data.
            uncommitted = instance.queryLegacyTreatmentsWithUuidHandling(JSON.stringify(query), true);
            throw new Error("synthetic treatment rollback");
          };
          if (callback === "realtime") internal.realtime.recordApi3StorageMutationInTransaction = fail;
          else internal.recordDataMutationInTransaction = fail;
          try {
            // The legacy treatment boundary wraps storage callback failures.
            await expect(instance.createDocuments("treatments", JSON.stringify([{ ...document, notes: "rolled back" }]))).rejects.toThrow("Treatment storage failure");
          } finally {
            if (callback === "realtime") internal.realtime.recordApi3StorageMutationInTransaction = original;
            else internal.recordDataMutationInTransaction = original as (collection: string) => void;
          }
          expect(uncommitted).toBeDefined();
          expect(JSON.parse(await uncommitted!)[0]?.notes).toBe("rolled back");
          const committed = await observer.read(query);
          expect(committed.sqlCalls).toBeGreaterThan(0);
          expect(committed.documents).toEqual([]);
          expect(await observer.read(query)).toMatchObject({ result: committed.result, documentSqlCalls: 0, rowsRead: 0 });
        }
      } finally { observer.restore(); }
    });
  });

  it("evicts treatment query results after the 128-key bound", async () => {
    const stub = env.ENTRY_STORE.getByName(`legacy-treatment-cache-bound-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      await instance.createDocuments("treatments", JSON.stringify([
        { _id: id(1), created_at: "2026-10-13T00:00:00Z", eventType: "Note" },
      ]));
      const observer = observeTreatmentReads(instance, state.storage);
      const firstQuery: DocumentQuery = { limit: 1, skip: 0 };
      try {
        const first = await observer.read(firstQuery);
        expect(await observer.read(firstQuery)).toMatchObject({ result: first.result, documentSqlCalls: 0, rowsRead: 0 });
        for (let skip = 1; skip <= 128; skip++) await observer.read({ limit: 1, skip });
        const evicted = await observer.read(firstQuery);
        expect(evicted.result).toBe(first.result);
        expect(evicted.sqlCalls).toBeGreaterThan(0);
        expect(await observer.read(firstQuery)).toMatchObject({ result: first.result, documentSqlCalls: 0, rowsRead: 0 });
      } finally { observer.restore(); }
    });
  });
});
