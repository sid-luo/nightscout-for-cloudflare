import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type Api3CollectionName, type DocumentQuery } from "../src/document-repository";
import type { EntryStore, JsonDocument } from "../src/entry-store";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const id = (value: number) => value.toString(16).padStart(24, "0");
const OPTIONS = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null,
  validate: true, emitRealtime: false };
interface Response { ok: boolean; result?: JsonDocument[]; message?: string }
interface Internal {
  legacyTreatmentQueries: { entries: Map<string, string>; bytes: number };
  recordDataMutationInTransaction(collection: string): void;
  realtime: { recordApi3StorageMutationInTransaction(event: unknown): void };
}

function seedDense(sql: SqlStorage): void {
  sql.exec(`WITH RECURSIVE sequence(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM sequence WHERE n < 4999)
    INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,identifier_present,
      srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
    SELECT 'treatments',printf('%024x',n),json_object('_id',printf('%024x',n),'identifier','dense-'||n,
      'created_at','2026-10-18T12:00:00.000Z','date',?,'utcOffset',0,'app','synthetic-exact-cache',
      'eventType',json('["Note","Other","Note",7,["Missing"]]'),
      'rank',json(CASE n % 7 WHEN 0 THEN 'null' WHEN 1 THEN '1' WHEN 2 THEN '"1"' WHEN 3 THEN 'true'
        WHEN 4 THEN '"abc"' WHEN 5 THEN '[1]' ELSE '{"x":1}' END),
      'notes','dense-'||n,'srvCreated',?,'srvModified',?+n,'isValid',json(CASE WHEN n % 13=0 THEN 'false' ELSE 'true' END)),
      ?,?,?, 'dense-'||n,1,?,?+n,?+n,CASE WHEN n % 13=0 THEN 0 ELSE 1 END,1,1 FROM sequence`,
  AT, AT, AT, AT, AT, AT, AT, AT, AT);
}

function expected(storage: DurableObjectStorage, query: DocumentQuery, collection: Api3CollectionName = "treatments"): string {
  // This instance bypasses the EntryStore result cache and executes the full
  // current SQL query/materialization each time.
  return JSON.stringify({ ok: true, result: new SqliteDocumentRepository(storage).queryDocumentsForApi3(collection, query) });
}

async function observed(
  instance: EntryStore, storage: DurableObjectStorage, query: DocumentQuery,
  collection: Api3CollectionName = "treatments", legacy = false, raw = JSON.stringify(query),
) {
  const execute = storage.sql.exec.bind(storage.sql);
  const queries: { statement: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(storage.sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = execute(statement, ...bindings); queries.push({ statement, cursor }); return cursor;
  });
  try {
    const serialized = legacy ? await instance.queryLegacyTreatments(raw) : await instance.api3QueryCollection(collection, raw);
    const data = queries.filter(item => /^SELECT\b/.test(item.statement) && /\b(?:FROM|JOIN) documents\b/.test(item.statement));
    return { serialized, response: JSON.parse(serialized) as Response,
      dataCalls: data.length, dataReads: data.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: queries.reduce((sum, item) => sum + item.cursor.rowsWritten, 0) };
  } finally { spy.mockRestore(); }
}

function payload(identifier: string, notes: string): JsonDocument {
  return { identifier, created_at: new Date(AT).toISOString(), date: AT, utcOffset: 0,
    app: "synthetic-exact-cache", eventType: "Note", notes };
}

describe("API3 treatment exact responses share the existing legacy result budget", () => {
  it("caches dense-array misses/custom pages and keeps every parsed query flag and other collections separate", async () => {
    const stub = env.ENTRY_STORE.getByName(`api3-exact-keys-${crypto.randomUUID()}`);
    const reports = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      seedDense(state.storage.sql);
      const base: DocumentQuery = { limit: 3, skip: 2800, sort: { field: "rank", direction: "asc" } };
      const queries: DocumentQuery[] = [
        { limit: 3, filters: [{ field: "eventType", operator: "eq", value: "Missing" }] },
        base, { ...base, limit: 7 }, { ...base, skip: 2801 }, { ...base, includeDeleted: true },
        { ...base, includeDeleted: false }, { ...base, fields: ["identifier", "rank"] },
        { ...base, fields: ["notes"] }, { ...base, fields: ["_all"] },
        { ...base, sort: { field: "rank", direction: "desc" } },
        { ...base, sort: [{ field: "rank", direction: "asc" }, { field: "created_at", direction: "desc" }] },
        { ...base, legacyUuidHandling: false },
        { ...base, filters: [{ field: "eventType", operator: "eq", value: "Other" }] },
      ];
      const reports = [];
      for (const [index, query] of queries.entries()) {
        const oracle = expected(state.storage, query);
        const cold = await observed(instance, state.storage, query);
        expect(cold.serialized, `query ${index}`).toBe(oracle);
        expect(cold.dataCalls).toBeGreaterThan(0);
        expect(cold.writes).toBe(0);
        const warm = await observed(instance, state.storage, query, "treatments", false, JSON.stringify(query, null, 2));
        expect(warm.serialized).toBe(oracle);
        expect(warm).toMatchObject({ dataCalls: 0, dataReads: 0, writes: 0 });
        reports.push({ index, coldReads: cold.dataReads, warmReads: warm.dataReads, returned: cold.response.result?.length });
      }
      state.storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
        VALUES('food',?,'{"identifier":"food-only","created_at":"2026-10-18T12:00:00.000Z","rank":999}',?,?,?,1)`, id(9000), AT, AT, AT);
      const sameQuery: DocumentQuery = { limit: 3 };
      const treatment = await observed(instance, state.storage, sameQuery);
      for (let repeat = 0; repeat < 2; repeat++) {
        const food = await observed(instance, state.storage, sameQuery, "food");
        expect(food.serialized).toBe(expected(state.storage, sameQuery, "food"));
        expect(food.response.result?.[0]?.identifier).toBe("food-only");
        expect(food.dataCalls).toBeGreaterThan(0);
      }
      expect(await observed(instance, state.storage, sameQuery)).toMatchObject({ serialized: treatment.serialized, dataCalls: 0 });
      // Same query in legacy mode must produce its array/_id contract, then
      // cache independently without poisoning the API3 ok/result envelope.
      const legacy = await observed(instance, state.storage, sameQuery, "treatments", true);
      expect(Array.isArray(JSON.parse(legacy.serialized))).toBe(true);
      expect(legacy.dataCalls).toBeGreaterThan(0);
      expect(await observed(instance, state.storage, sameQuery, "treatments", true)).toMatchObject({ serialized: legacy.serialized, dataCalls: 0 });
      expect(await observed(instance, state.storage, sameQuery)).toMatchObject({ serialized: treatment.serialized, dataCalls: 0 });
      return reports;
    });
    console.info(`API3_TREATMENT_EXACT_KEYS=${JSON.stringify(reports)}`);
  }, 60_000);

  it("invalidates on genuine API3 create/patch/soft+hard delete and legacy create/save/delete", async () => {
    const stub = env.ENTRY_STORE.getByName(`api3-exact-mutations-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const query: DocumentQuery = { limit: 100 };
      const fresh = async () => {
        const actual = await observed(instance, state.storage, query);
        expect(actual.serialized).toBe(expected(state.storage, query));
        expect(actual.dataCalls).toBeGreaterThan(0);
        expect(actual.writes).toBe(0);
        expect(await observed(instance, state.storage, query)).toMatchObject({ serialized: actual.serialized, dataCalls: 0, dataReads: 0 });
        return actual.response.result!;
      };
      expect(await fresh()).toEqual([]);
      expect(JSON.parse(await instance.api3CreateDocument("treatments", JSON.stringify(payload("api3-target", "created")), JSON.stringify(OPTIONS))))
        .toMatchObject({ ok: true });
      expect((await fresh())[0]?.notes).toBe("created");
      expect(JSON.parse(await instance.api3PatchDocument("treatments", "api3-target", '{"notes":"patched"}', JSON.stringify(OPTIONS))))
        .toMatchObject({ ok: true });
      expect((await fresh())[0]?.notes).toBe("patched");
      const deletedQuery: DocumentQuery = { limit: 100, includeDeleted: true };
      await observed(instance, state.storage, deletedQuery);
      expect(await observed(instance, state.storage, deletedQuery)).toMatchObject({ dataCalls: 0 });
      expect(await instance.api3DeleteDocument("treatments", "api3-target", false, null)).toMatchObject({ deleted: true });
      expect(await fresh()).toEqual([]);
      const tombstone = await observed(instance, state.storage, deletedQuery);
      expect(tombstone.serialized).toBe(expected(state.storage, deletedQuery));
      expect(tombstone.dataCalls).toBeGreaterThan(0);
      expect(tombstone.response.result?.[0]?.isValid).toBe(false);
      expect(await instance.api3DeleteDocument("treatments", "api3-target", true, null)).toMatchObject({ deleted: true });
      expect(await fresh()).toEqual([]);
      const legacy = { _id: id(123), created_at: new Date(AT).toISOString(), eventType: "Note", notes: "legacy-created" };
      await instance.createDocuments("treatments", JSON.stringify([legacy]));
      expect((await fresh())[0]?.notes).toBe("legacy-created");
      await instance.saveLegacyTreatmentsWithUuidHandling(JSON.stringify([{ ...legacy, notes: "legacy-updated" }]), true);
      expect((await fresh())[0]?.notes).toBe("legacy-updated");
      expect(await instance.deleteLegacyTreatmentWithUuidHandling(id(123), true)).toBe(true);
      expect(await fresh()).toEqual([]);
    });
  });

  it("clears a response read inside either mutation callback when the outer mutation transaction rolls back", async () => {
    const stub = env.ENTRY_STORE.getByName(`api3-exact-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const internal = instance as unknown as Internal;
      const query: DocumentQuery = { limit: 10 };
      await observed(instance, state.storage, query);
      for (const callback of ["realtime", "data"] as const) {
        const previous = callback === "realtime" ? internal.realtime.recordApi3StorageMutationInTransaction
          : internal.recordDataMutationInTransaction;
        let uncommitted: Promise<string> | undefined;
        const fail = () => {
          uncommitted = instance.api3QueryCollection("treatments", JSON.stringify(query));
          throw new Error("synthetic outer API3 cache rollback");
        };
        if (callback === "realtime") internal.realtime.recordApi3StorageMutationInTransaction = fail;
        else internal.recordDataMutationInTransaction = fail;
        try {
          expect(JSON.parse(await instance.api3CreateDocument("treatments", JSON.stringify(payload(`rolled-${callback}`, "uncommitted")),
            JSON.stringify({ ...OPTIONS, emitRealtime: true })))).toMatchObject({ ok: false });
        } finally {
          if (callback === "realtime") internal.realtime.recordApi3StorageMutationInTransaction = previous;
          else internal.recordDataMutationInTransaction = previous as (collection: string) => void;
        }
        expect(uncommitted).toBeDefined();
        expect((JSON.parse(await uncommitted!) as Response).result?.[0]?.notes).toBe("uncommitted");
        const committed = await observed(instance, state.storage, query);
        expect(committed.serialized).toBe(expected(state.storage, query));
        expect(committed.response.result).toEqual([]);
        expect(committed.dataCalls).toBeGreaterThan(0);
        expect(await observed(instance, state.storage, query)).toMatchObject({ serialized: committed.serialized, dataCalls: 0 });
      }
    });
  });

  it("does not cache operation/read-quota errors and can recover the same query after repair", async () => {
    const stub = env.ENTRY_STORE.getByName(`api3-exact-errors-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
        VALUES('treatments',?,'{malformed',?,?,?,1)`, id(1), AT, AT, AT);
      const query: DocumentQuery = { limit: 1 };
      for (let attempt = 0; attempt < 2; attempt++) {
        const failed = await observed(instance, state.storage, query);
        expect(failed.response.ok).toBe(false);
        expect(failed.dataCalls).toBeGreaterThan(0);
      }
      // Deliberately repair without a callback: a cached error would hide it.
      sql.exec("UPDATE documents SET body=? WHERE collection='treatments' AND id=?", JSON.stringify(payload("repaired", "healthy")), id(1));
      const repaired = await observed(instance, state.storage, query);
      expect(repaired.response).toMatchObject({ ok: true, result: [{ notes: "healthy" }] });
      expect(repaired.dataCalls).toBeGreaterThan(0);
      expect(await observed(instance, state.storage, query)).toMatchObject({ serialized: repaired.serialized, dataCalls: 0 });
      const freshQuery: DocumentQuery = { limit: 1, skip: 1 };
      const execute = sql.exec.bind(sql);
      let attempts = 0;
      const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
        if (/^SELECT\b/.test(statement) && /\b(?:FROM|JOIN) documents\b/.test(statement)) {
          attempts++; throw new Error("Exceeded allowed rows read in Durable Objects free tier.");
        }
        return execute(statement, ...bindings);
      });
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          await expect(instance.api3QueryCollection("treatments", JSON.stringify(freshQuery))).rejects.toThrow();
        }
        expect(attempts).toBe(2);
      } finally { spy.mockRestore(); }
      const recovered = await observed(instance, state.storage, freshQuery);
      expect(recovered.response).toEqual({ ok: true, result: [] });
      expect(recovered.dataCalls).toBeGreaterThan(0);
      expect(await observed(instance, state.storage, freshQuery)).toMatchObject({ serialized: recovered.serialized, dataCalls: 0 });
    });
  });

  it("shares the 128-key/4MiB LRU with legacy responses and never retains an oversized serialized result", async () => {
    const stub = env.ENTRY_STORE.getByName(`api3-exact-budget-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const sql = state.storage.sql;
      for (let index = 0; index < 12; index++) {
        const document = payload(`large-${index}`, "x".repeat(60_000));
        sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,
          identifier_present,srv_created,srv_modified,is_valid,revision,srv_metadata_version)
          VALUES('treatments',?,?,?,?,?,?,1,?,?,1,1,1)`, id(index + 1), JSON.stringify(document),
        AT + index, AT, AT, document.identifier as string, AT, AT + index);
      }
      const internal = instance as unknown as Internal;
      const legacyQuery: DocumentQuery = { limit: 1, fields: ["notes"] };
      const legacy = await observed(instance, state.storage, legacyQuery, "treatments", true);
      const firstQuery: DocumentQuery = { limit: 1, skip: 0, fields: ["identifier"] };
      const first = await observed(instance, state.storage, firstQuery);
      for (let skip = 1; skip <= 127; skip++) await observed(instance, state.storage, { ...firstQuery, skip });
      expect(internal.legacyTreatmentQueries.entries.size).toBeLessThanOrEqual(128);
      expect(await observed(instance, state.storage, firstQuery)).toMatchObject({ serialized: first.serialized, dataCalls: 0 });
      const legacyEvicted = await observed(instance, state.storage, legacyQuery, "treatments", true);
      expect(legacyEvicted.serialized).toBe(legacy.serialized);
      expect(legacyEvicted.dataCalls).toBeGreaterThan(0);
      const largeQuery: DocumentQuery = { limit: 7, skip: 0 };
      const large = await observed(instance, state.storage, largeQuery);
      for (let skip = 1; skip <= 5; skip++) await observed(instance, state.storage, { ...largeQuery, skip });
      expect(internal.legacyTreatmentQueries.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(internal.legacyTreatmentQueries.entries.size).toBeLessThanOrEqual(128);
      const largeEvicted = await observed(instance, state.storage, largeQuery);
      expect(largeEvicted.serialized).toBe(large.serialized);
      expect(largeEvicted.dataCalls).toBeGreaterThan(0);
      const overflow: DocumentQuery = { limit: 12 };
      const beforeBytes = internal.legacyTreatmentQueries.bytes;
      const beforeKeys = internal.legacyTreatmentQueries.entries.size;
      for (let attempt = 0; attempt < 2; attempt++) {
        const oversized = await observed(instance, state.storage, overflow);
        expect(oversized.serialized).toBe(expected(state.storage, overflow));
        expect(oversized.serialized.length * 2).toBeGreaterThan(1024 * 1024);
        expect(oversized.dataCalls).toBeGreaterThan(0);
      }
      expect(internal.legacyTreatmentQueries.bytes).toBe(beforeBytes);
      expect(internal.legacyTreatmentQueries.entries.size).toBe(beforeKeys);
      const selected: DocumentQuery = { limit: 1, fields: ["notes"], filters: [{ field: "identifier", operator: "eq", value: "large-0" }] };
      await observed(instance, state.storage, selected);
      expect(await observed(instance, state.storage, selected)).toMatchObject({ dataCalls: 0 });
      expect(JSON.parse(await instance.api3PatchDocument("treatments", "large-0", '{"notes":"after-overflow"}', JSON.stringify(OPTIONS))))
        .toMatchObject({ ok: true });
      const after = await observed(instance, state.storage, selected);
      expect(after.response.result).toEqual([{ notes: "after-overflow" }]);
      expect(after.dataCalls).toBeGreaterThan(0);
    });
  }, 60_000);

  it("loses only the memory result cache on actual Durable Object eviction and reloads current canonical data", async () => {
    const stub = env.ENTRY_STORE.getByName(`api3-exact-evict-${crypto.randomUUID()}`);
    const query: DocumentQuery = { limit: 3, filters: [{ field: "eventType", operator: "eq", value: "Missing" }] };
    const initial = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      seedDense(state.storage.sql);
      const first = await observed(instance, state.storage, query);
      expect(first.dataCalls).toBeGreaterThan(0);
      expect(await observed(instance, state.storage, query)).toMatchObject({ serialized: first.serialized, dataCalls: 0 });
      return first.serialized;
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const cold = await observed(instance, state.storage, query);
      expect(cold.serialized).toBe(initial);
      expect(cold.serialized).toBe(expected(state.storage, query));
      expect(cold.dataCalls).toBeGreaterThan(0);
      expect(await observed(instance, state.storage, query)).toMatchObject({ serialized: initial, dataCalls: 0, dataReads: 0 });
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM documents WHERE collection='treatments'").one().count).toBe(5000);
    });
  }, 60_000);
});
