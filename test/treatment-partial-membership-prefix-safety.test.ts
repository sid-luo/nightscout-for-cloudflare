import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import { LegacyReadCache } from "../src/legacy-read-cache";
import { TreatmentMembershipReadView, TREATMENT_MEMBERSHIP_VIEW_KEY as KEY } from "../src/treatment-membership-read-view";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const id = (n: number) => n.toString(16).padStart(24, "0");
interface Row extends Record<string, SqlStorageValue> { id: string; body: string }
const CATEGORY = `((json_type(body,'$.eventType')='text' AND json_extract(body,'$.eventType')=?)
 OR (json_type(body,'$.eventType')='array' AND EXISTS(SELECT 1 FROM json_each(body,'$.eventType') item
 WHERE item.type='text' AND item.value=?)))`;
function pool() {
  const cache = new LegacyReadCache();
  cache.set(KEY, JSON.stringify([2, "partial", id(3), [["Note", [id(0)]], ["Rare", [id(1)]], ["", [id(3)]]]]));
  return cache;
}
function seed(sql: SqlStorage) {
  sql.exec(`WITH RECURSIVE s(n) AS(VALUES(0) UNION ALL SELECT n+1 FROM s WHERE n<6000)
    INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,srv_modified,is_valid)
    SELECT 'treatments',printf('%024x',n),json_object('_id',printf('%024x',n),
      'created_at','2026-10-18T12:00:00.000Z','eventType',json('["Note"]'),'rank',n%3),?,?,?,?,1 FROM s`, AT, AT, AT, AT);
  const spellings = ['"Note"', '["Rare",null]', '[["Rare"],{"kind":"Rare"}]', '""',
    '"Rare"', '["Rare","Other"]', '["Note"]', '["\\u0052are"],"eventType":["Wrong"]'];
  spellings.forEach((fragment, n) => sql.exec(`UPDATE documents SET body=?,is_valid=? WHERE collection='treatments' AND id=?`,
    `{"_id":"${id(n)}","created_at":"2026-10-18T12:00:00.000Z","rank":${n % 3},"eventType":${fragment}}`, n === 4 ? 0 : n === 5 ? 2 : 1, id(n)));
  sql.exec("UPDATE documents SET body=json_set(body,'$.eventType','Rare') WHERE collection='treatments' AND id=?", id(6000));
}
function observed<T>(sql: SqlStorage, operation: () => T) {
  const original = sql.exec.bind(sql);
  const statements: { sql: string; bindings: number; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = original(statement, ...bindings); statements.push({ sql: statement, bindings: bindings.length, cursor }); return cursor;
  });
  try { return { value: operation(), statements, reads: statements.reduce((sum, row) => sum + row.cursor.rowsRead, 0),
    writes: statements.reduce((sum, row) => sum + row.cursor.rowsWritten, 0) }; }
  finally { spy.mockRestore(); }
}
function original(sql: SqlStorage, storage: DurableObjectStorage, query: DocumentQuery, api3: boolean) {
  const direction = query.sort === undefined ? undefined : (Array.isArray(query.sort) ? query.sort[0] : query.sort)!.direction;
  const order = direction === undefined ? api3 ? "sort_time DESC,srv_modified DESC,id ASC"
    : "json_extract(body,'$.created_at') DESC,id ASC"
    : `json_extract(body,'$.rank') ${direction === 'asc' ? 'ASC' : 'DESC'},id ${direction === 'asc' ? 'ASC' : 'DESC'}`;
  const rows = sql.exec<Row>(`SELECT * FROM documents WHERE collection='treatments'
    ${api3 ? 'AND is_valid!=0' : 'AND json_valid(body)'} AND ${CATEGORY}
    ORDER BY ${order} LIMIT ? OFFSET ?`, "Rare", "Rare", query.limit ?? 100, query.skip ?? 0).toArray();
  const renderer = new SqliteDocumentRepository(storage);
  (renderer as unknown as { queryTreatmentRows(): Row[] }).queryTreatmentRows = () => rows;
  return api3 ? renderer.queryTreatments(query) : renderer.queryLegacyTreatments(query);
}
const rare = { field: "eventType", operator: "eq", value: "Rare" } as const;

describe("partial membership SQL-prefix safety", () => {
  it("keeps complete original residuals, SQLite sorts/ties, validity, duplicate keys and unknown suffix", async () => {
    const reports = await runInDurableObject(env.ENTRY_STORE.getByName(`partial-safety-native-${crypto.randomUUID()}`), (_instance, state) => {
      const sql = state.storage.sql; seed(sql);
      const reports = [];
      for (const api3 of [false, true]) for (const direction of [undefined, "asc", "desc"] as const) {
        const cache = pool(), repo = new SqliteDocumentRepository(state.storage, undefined, undefined, cache);
        const query: DocumentQuery = { filters: [rare], limit: 3, skip: 1,
          ...(direction === undefined ? {} : { sort: { field: "rank", direction } }) };
        const expected = original(sql, state.storage, query, api3);
        const actual = observed(sql, () => api3 ? repo.queryTreatments(query) : repo.queryLegacyTreatments(query));
        expect(actual.value).toEqual(expected); expect(actual.writes).toBe(0);
        expect(new TreatmentMembershipReadView(sql, cache).partialPrefix("Rare")?.after).toBe(id(5003));
        expect(actual.statements.some(row => row.sql.includes("id > ? OR id IN"))).toBe(!api3);
        expect(actual.statements.every(row => row.bindings <= 100 && new TextEncoder().encode(row.sql).byteLength <= 100_000)).toBe(true);
        reports.push({ api3, direction: direction ?? "default", reads: actual.reads, writes: actual.writes,
          selected: (actual.value as { _id: string }[]).map(row => row._id) });
      }
      return reports;
    });
    console.info(`PARTIAL_PREFIX_NATIVE_SEMANTICS=${JSON.stringify(reports)}`);
  });

  it("keeps canonical old/new unions and rollback ghosts, then disables lost mutation history", async () => {
    await runInDurableObject(env.ENTRY_STORE.getByName(`partial-safety-mutation-${crypto.randomUUID()}`), (_instance, state) => {
      const sql = state.storage.sql; seed(sql);
      const cache = pool(), view = new TreatmentMembershipReadView(sql, cache);
      const clear = () => cache.clearKeeping([KEY]);
      const repo = new SqliteDocumentRepository(state.storage, undefined, clear, cache,
        (collection, key, oldBody, newBody) => { if (collection === "treatments") { view.rememberMutation(key, oldBody, newBody); clear(); return clear; } });
      const save = (category: string) => repo.upsertTreatment({ _id: id(0), created_at: "2026-10-18T12:00:00.000Z", eventType: category });
      const uploaded = observed(sql, () => save("Rare"));
      expect(view.partialPrefix("Rare")?.ids).toContain(id(0)); expect(view.partialPrefix("Note")?.ids).toContain(id(0));
      const query: DocumentQuery = { filters: [rare], limit: 100 };
      expect(repo.queryLegacyTreatments(query)).toEqual(original(sql, state.storage, query, false));
      expect(uploaded.statements.filter(row => row.sql.includes(" AS valid_json")).every(row => row.cursor.rowsRead + row.cursor.rowsWritten === 0)).toBe(true);
      expect(() => state.storage.transactionSync(() => { save("RolledBack"); throw new Error("outer canonical rollback"); })).toThrow("outer canonical rollback");
      expect(view.candidates("RolledBack") ?? view.partialPrefix("RolledBack")?.ids).toContain(id(0));
      expect(repo.queryLegacyTreatments({ filters: [{ ...rare, value: "RolledBack" }] })).toEqual([]);
      expect(repo.queryLegacyTreatments(query)).toEqual(original(sql, state.storage, query, false));
      expect(repo.deleteTreatmentById(id(1))).toBe(true);
      expect(repo.queryLegacyTreatments(query)).toEqual(original(sql, state.storage, query, false));
      cache.clear(); expect(TreatmentMembershipReadView.isUnsafe(cache)).toBe(true); expect(view.partialPrefix("Rare")).toBeUndefined();
      const fallback = observed(sql, () => repo.queryLegacyTreatments(query));
      expect(fallback.value).toEqual(original(sql, state.storage, query, false));
      expect(fallback.statements.some(row => row.sql.includes(" AS valid_json") && row.sql.includes("FROM documents"))).toBe(false);
    });
  });

  it("refuses dense/foreign/overlay/invalid coverage and preserves original binding/SQL validation", async () => {
    await runInDurableObject(env.ENTRY_STORE.getByName(`partial-safety-limits-${crypto.randomUUID()}`), (_instance, state) => {
      const sql = state.storage.sql; seed(sql);
      for (const format of [[2,"partial",id(3),[["Rare",null]]], [3,"partial",id(3),"Other",[]],
        [3,"partial",id(3),"Rare",[["Rare",[id(1)]]]],
        [2,"overlay",null,[["Rare",[id(1)]]]], [2,"partial","bad\0id",[]]]) {
        const cache = new LegacyReadCache(); cache.set(KEY, JSON.stringify(format));
        expect(new TreatmentMembershipReadView(sql, cache).partialPrefix("Rare")).toBeUndefined();
      }
      const bare = new SqliteDocumentRepository(state.storage);
      const exact100: DocumentQuery = { limit: 1, filters: [rare, { field: "_id", operator: "in",
        value: Array.from({ length: 95 }, (_, n) => id(n)) }] };
      const cache = pool(), repo = new SqliteDocumentRepository(state.storage, undefined, undefined, cache);
      const actual = observed(sql, () => repo.queryLegacyTreatments(exact100));
      expect(actual.value).toEqual(bare.queryLegacyTreatments(exact100));
      expect(actual.statements.some(row => row.bindings === 100)).toBe(true);
      expect(actual.statements.every(row => row.bindings <= 100)).toBe(true);
      const values = ["Rare", ...Array<null>(94).fill(null)];
      const large: DocumentQuery = { limit: 1, filters: [rare,
        ...Array.from({ length: 4 }, () => ({ field: "eventType", operator: "in" as const, value: values }))] };
      const largeCache = pool(), largeRepo = new SqliteDocumentRepository(state.storage, undefined, undefined, largeCache);
      const largeActual = observed(sql, () => largeRepo.queryTreatments(large));
      expect(largeActual.value).toEqual(bare.queryTreatments(large));
      expect(Math.max(...largeActual.statements.map(row => new TextEncoder().encode(row.sql).byteLength))).toBeGreaterThan(90_000);
      expect(largeActual.statements.every(row => new TextEncoder().encode(row.sql).byteLength <= 100_000)).toBe(true);
      const rejected = observed(sql, () => {
        for (const invalid of [{ ...exact100, filters: [...exact100.filters!, { field: "_id", operator: "ne", value: id(99) }] },
          { filters: [rare], sort: [] }, { filters: [rare], skip: -1 }] as DocumentQuery[]) expect(() => repo.queryTreatments(invalid)).toThrow();
      });
      expect(rejected.statements).toHaveLength(0);
    });
  });

  it("keeps native lazy JSON error timing for an unvisited malformed suffix", async () => {
    for (const deferred of [false, true]) await runInDurableObject(env.ENTRY_STORE.getByName(`partial-safety-lazy-${deferred}-${crypto.randomUUID()}`), (_instance, state) => {
      const sql = state.storage.sql; seed(sql);
      if (deferred) for (const index of ["documents_treatments_created_at", "documents_treatments_event_type_created_at",
        "documents_treatments_api3_order"]) sql.exec(`DROP INDEX IF EXISTS ${index}`);
      sql.exec("UPDATE documents SET body='{malformed',sort_time=? WHERE collection='treatments' AND id=?", AT + 1, id(5999));
      sql.exec("UPDATE documents SET sort_time=? WHERE collection='treatments' AND id=?", AT + 2, id(6000));
      const cache = pool(), repo = new SqliteDocumentRepository(state.storage, undefined, undefined, cache);
      const bare = new SqliteDocumentRepository(state.storage);
      const query: DocumentQuery = { filters: [rare], limit: 1 };
      const caught = (action: () => unknown) => { try { return { value: action() }; } catch (error) { return { error: String(error) }; } };
      const earlyOriginal = caught(() => bare.queryTreatments(query));
      if (deferred) expect(earlyOriginal.error).toContain("malformed");
      else expect(earlyOriginal.value).toHaveLength(1);
      expect(caught(() => repo.queryTreatments(query))).toEqual(earlyOriginal);
      expect(new TreatmentMembershipReadView(sql, cache).partialPrefix("Rare")).toBeDefined();
      const missing: DocumentQuery = { filters: [{ ...rare, value: "Missing" }], limit: 1 };
      const expected = caught(() => bare.queryTreatments(missing));
      expect(expected.error).toContain("malformed"); expect(caught(() => repo.queryTreatments(missing))).toEqual(expected);
      expect(cache.get(KEY)).toBe("rejected");
      console.info(`PARTIAL_PREFIX_LAZY=${JSON.stringify({ deferred, earlyMatchSucceeded: !deferred,
        earlyOriginalErrorMatches: deferred,
        missingErrorMatchesOriginal: true, rejectedMalformedCoverage: true })}`);
    });
  });
});
