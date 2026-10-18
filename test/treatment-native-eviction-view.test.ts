import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import type { EntryStore, JsonDocument } from "../src/entry-store";
import { LegacyReadCache } from "../src/legacy-read-cache";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const OPTIONS = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false };
interface Internal {
  legacyTreatmentQueries: LegacyReadCache;
  recordDataMutationInTransaction(collection: string): void;
}
interface Response { ok: boolean; result?: JsonDocument[] }

function seed(sql: SqlStorage): void {
  sql.exec(`WITH RECURSIVE s(n) AS(VALUES(0) UNION ALL SELECT n+1 FROM s WHERE n<6000)
    INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,identifier_present,
      srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
    SELECT 'treatments',printf('%024x',n),json_object('_id',printf('%024x',n),
      'identifier','native-'||n,'created_at','2026-10-18T12:00:00.000Z','date',?+n,
      'utcOffset',0,'app','native-cold-audit','notes','before-'||n,
      'eventType',json(CASE WHEN n IN(137,5001,5900) THEN '["Note","Rare",7,["Absent"],null]'
        ELSE '["Note","Other",7,["Absent"],null]' END), 'srvCreated',?,'srvModified',?+n),
      ?+n,?,?, 'native-'||n,1,?,?+n,?+n,1,1,1 FROM s`, AT, AT, AT, AT, AT, AT, AT, AT, AT);
}

function query(category: string, limit: number, extra: Partial<DocumentQuery> = {}): DocumentQuery {
  return { filters: [{ field: "eventType", operator: "eq", value: category }], limit, ...extra };
}
function expected(storage: DurableObjectStorage, input: DocumentQuery): Response {
  return { ok: true, result: new SqliteDocumentRepository(storage).queryTreatments(input) };
}
function vectors(instance: EntryStore): string[] {
  const cache = (instance as unknown as Internal).legacyTreatmentQueries;
  return [...(cache as unknown as { entries: Map<string, string> }).entries]
    .filter(([key, value]) => key.startsWith("\0treatment-order:v1:") && value.startsWith("["))
    .map(([, value]) => value);
}
async function measure(instance: EntryStore, storage: DurableObjectStorage, input: DocumentQuery) {
  const execute = storage.sql.exec.bind(storage.sql);
  const cursors: { statement: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(storage.sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = execute(statement, ...bindings); cursors.push({ statement, cursor }); return cursor;
  });
  try {
    const response = JSON.parse(await instance.api3QueryCollection("treatments", JSON.stringify(input))) as Response;
    return { response, reads: cursors.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: cursors.reduce((sum, item) => sum + item.cursor.rowsWritten, 0),
      dataCalls: cursors.filter(item => /^SELECT\b/.test(item.statement) && /\b(?:FROM|JOIN) documents\b/.test(item.statement)).length,
      dataReads: cursors.filter(item => /^SELECT\b/.test(item.statement) && /\b(?:FROM|JOIN) documents\b/.test(item.statement))
        .reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      sourceCalls: cursors.filter(item => item.statement.includes(" AS valid_json") && item.statement.includes("FROM documents")).length,
      orderBuilds: cursors.filter(item => /^SELECT id FROM documents/.test(item.statement)).length };
  } finally { spy.mockRestore(); }
}
async function cold(name: string) {
  const stub = env.ENTRY_STORE.getByName(`${name}-${crypto.randomUUID()}`);
  await runInDurableObject(stub, (_instance, state) => state.storage.transactionSync(() => seed(state.storage.sql)));
  await evictDurableObject(stub);
  return stub;
}

describe("native treatment views reuse successful scans after real eviction", () => {
  it("observes a first empty native page and reuses its fixed query across limit/skip/fields without a membership rebuild", async () => {
    const stub = await cold("native-empty-eviction");
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      expect(vectors(instance)).toEqual([]);
      const first = await measure(instance, state.storage, query("Absent", 1));
      expect(first.response).toEqual(expected(state.storage, query("Absent", 1)));
      expect(first.reads).toBeGreaterThan(512); expect(first.writes).toBe(0);
      expect(vectors(instance)).toEqual(["[]"]);
      const pages = [];
      for (const input of [query("Absent", 2), query("Absent", 3, { skip: 17 }),
        query("Absent", 7, { fields: ["identifier", "notes"] })]) {
        const actual = await measure(instance, state.storage, input);
        expect(actual.response).toEqual(expected(state.storage, input));
        expect(actual).toMatchObject({ reads: 0, dataCalls: 0, writes: 0, sourceCalls: 0, orderBuilds: 0 });
        pages.push(actual);
      }
      return { first, pages };
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      expect(vectors(instance)).toEqual([]);
      const again = await measure(instance, state.storage, query("Absent", 2));
      expect(again.response).toEqual(expected(state.storage, query("Absent", 2)));
      expect(again.reads).toBeGreaterThan(512); expect(again.writes).toBe(0);
    });
    console.info(`NATIVE_REAL_EVICTION_EMPTY=${JSON.stringify(report)}`);
  }, 60_000);

  it("retains the complete native order of a short first page while time/deleted filters remain separate", async () => {
    const stub = await cold("native-short-eviction");
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const first = await measure(instance, state.storage, query("Rare", 10));
      expect(first.response).toEqual(expected(state.storage, query("Rare", 10)));
      expect(first.response.result?.map(row => row.identifier)).toEqual(["native-5900", "native-5001", "native-137"]);
      expect(first.reads).toBeGreaterThan(512); expect(first.writes).toBe(0);
      expect(vectors(instance)).toHaveLength(1);
      const pages = [];
      for (const input of [query("Rare", 2), query("Rare", 1, { skip: 1 }),
        query("Rare", 3, { skip: 3, fields: ["identifier"] }), query("Rare", 2, { fields: ["identifier", "notes"] })]) {
        const actual = await measure(instance, state.storage, input);
        expect(actual.response).toEqual(expected(state.storage, input));
        expect(actual.sourceCalls + actual.orderBuilds).toBe(0);
        expect(actual.dataReads).toBeLessThanOrEqual(3 * (actual.response.result?.length ?? 0));
        expect(actual.writes).toBe(0); pages.push(actual);
      }
      const filtered = query("Rare", 10, { filters: [
        { field: "eventType", operator: "eq", value: "Rare" }, { field: "date", operator: "gte", value: AT + 5000 },
      ] });
      const narrow = await measure(instance, state.storage, filtered);
      expect(narrow.response).toEqual(expected(state.storage, filtered));
      expect(narrow.response.result).toHaveLength(2); expect(narrow.dataCalls).toBeGreaterThan(0);
      const deleted = query("Rare", 10, { includeDeleted: true });
      const differentFlag = await measure(instance, state.storage, deleted);
      expect(differentFlag.response).toEqual(expected(state.storage, deleted));
      expect(differentFlag.dataCalls).toBeGreaterThan(0);
      return { first, pages, narrow, differentFlag };
    });
    console.info(`NATIVE_REAL_EVICTION_SHORT=${JSON.stringify(report)}`);
  }, 60_000);

  it("clears a native vector on a real API3 patch and after a callback reads uncommitted data then rolls back", async () => {
    const stub = await cold("native-callback-rollback");
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const internal = instance as unknown as Internal;
      await measure(instance, state.storage, query("Rare", 10));
      expect(vectors(instance)).toHaveLength(1);
      expect(JSON.parse(await instance.api3PatchDocument("treatments", "native-5900", '{"notes":"committed"}', JSON.stringify(OPTIONS))))
        .toMatchObject({ ok: true });
      expect(vectors(instance)).toEqual([]);
      const changed = await measure(instance, state.storage, query("Rare", 11));
      expect(changed.response).toEqual(expected(state.storage, query("Rare", 11)));
      expect(changed.response.result?.[0]?.notes).toBe("committed");
      expect(changed.dataCalls).toBeGreaterThan(0);
      let uncommitted: Promise<string> | undefined;
      const spy = vi.spyOn(internal, "recordDataMutationInTransaction").mockImplementation(collection => {
        if (collection !== "treatments") return;
        uncommitted = instance.api3QueryCollection("treatments", JSON.stringify(query("Rare", 12)));
        throw new Error("rollback after native cold read");
      });
      try {
        expect(JSON.parse(await instance.api3PatchDocument("treatments", "native-5900", '{"notes":"uncommitted"}', JSON.stringify(OPTIONS))))
          .toMatchObject({ ok: false });
      } finally { spy.mockRestore(); }
      expect(uncommitted).toBeDefined();
      expect((JSON.parse(await uncommitted!) as Response).result?.[0]?.notes).toBe("uncommitted");
      expect(vectors(instance)).toEqual([]);
      const restored = await measure(instance, state.storage, query("Rare", 13));
      expect(restored.response).toEqual(expected(state.storage, query("Rare", 13)));
      expect(restored.response.result?.[0]?.notes).toBe("committed");
      expect(restored.dataCalls).toBeGreaterThan(0); expect(restored.writes).toBe(0);
    });
  }, 60_000);

  it("does not treat a page equal to LIMIT or a short offset page as a complete native result", async () => {
    for (const input of [query("Rare", 3), query("Rare", 10, { skip: 1 })]) {
      const stub = await cold("native-incomplete-page");
      await runInDurableObject(stub, async (instance: EntryStore, state) => {
        const first = await measure(instance, state.storage, input);
        expect(first.response).toEqual(expected(state.storage, input));
        expect(vectors(instance)).toEqual([]);
        const complete = await measure(instance, state.storage, query("Rare", 11));
        expect(complete.response).toEqual(expected(state.storage, query("Rare", 11)));
        expect(complete.response.result).toHaveLength(3);
        expect(complete.dataCalls).toBeGreaterThan(0); expect(complete.writes).toBe(0);
      });
    }
  }, 60_000);

  it("leaves cheap native LIMIT reads lazy and does not admit pending full-query builds", async () => {
    const stub = await cold("native-cheap-lazy");
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      for (const limit of [1, 2]) {
        const input: DocumentQuery = { limit };
        const actual = await measure(instance, state.storage, input);
        expect(actual.response).toEqual(expected(state.storage, input));
        expect(actual.dataReads).toBeLessThanOrEqual(limit * 3);
        expect(actual).toMatchObject({ writes: 0, sourceCalls: 0, orderBuilds: 0 });
        expect(vectors(instance)).toEqual([]);
      }
    });
  }, 60_000);
});
