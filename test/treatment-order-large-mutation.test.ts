import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import type { EntryStore, JsonDocument, JsonValue } from "../src/entry-store";
import { LegacyReadCache } from "../src/legacy-read-cache";
import { TREATMENT_ORDER_SOURCE_KEY, TreatmentOrderReadView, type TreatmentOrderReadSource } from "../src/treatment-order-read-view";

const AT = Date.UTC(2026, 9, 18, 12);
const id = (n: number) => n.toString(16).padStart(24, "0");
const SOURCE_INDEX = "documents_collection_created_at";
const ORDER = "json_extract(body, ?) DESC,id DESC";
interface Row extends Record<string, SqlStorageValue> { id: string; body: string }
function seed(sql: SqlStorage, count: number, unusualDates = false): void {
  const ranks: JsonValue[] = [null, 0, -1, 1.5, true, "01", "a", "\ue000", "🚀", [1, null], { z: 1, a: 2 }];
  for (let n = 0; n < count; n++) {
    const at = AT + n * 60_000;
    const created: JsonValue = unusualDates && n < count - 1200 && n % 900 === 0
      ? ["2000-01-01T00:00:00.000Z", new Date(AT + count * 60_000).toISOString()]
      : unusualDates && n === 53 ? { date: "2099-01-01T00:00:00.000Z" } : new Date(at).toISOString();
    const body = { _id: id(n), identifier: `large-sort-${n}`, created_at: created, date: at,
      eventType: ["Note", "Other"], rank: ranks[n % ranks.length], nested: { tie: n % 9 },
      srvCreated: at, srvModified: at, isValid: true };
    sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,
      identifier_present,srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
      VALUES('treatments',?,?,?,?,?,?,1,?,?,?,1,1,1)`, id(n), JSON.stringify(body), at, at, at, body.identifier, at, at, at);
  }
}
async function measure<T>(sql: SqlStorage, action: () => T | Promise<T>) {
  const execute = sql.exec.bind(sql);
  const cursors: { sql: string; bindings: SqlStorageValue[]; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = execute(statement, ...bindings);
    cursors.push({ sql: statement, bindings, cursor });
    return cursor;
  });
  try {
    const result = await action();
    return { result, reads: cursors.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: cursors.reduce((sum, item) => sum + item.cursor.rowsWritten, 0),
      documentReads: cursors.filter(item => /(?:FROM|JOIN)\s+documents\b/.test(item.sql))
        .reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      statements: cursors.map(item => ({ sql: item.sql.replace(/\s+/g, " ").trim(), reads: item.cursor.rowsRead,
        bindings: item.bindings.length, bytes: new TextEncoder().encode(item.sql).byteLength,
        plans: /^SELECT\b/.test(item.sql) ? execute<{ detail: string }>(`EXPLAIN QUERY PLAN ${item.sql}`, ...item.bindings)
          .toArray().map(row => row.detail) : [] })) };
  } finally { spy.mockRestore(); }
}
function documents(rows: Row[], fields?: string[]): JsonDocument[] {
  return rows.map(row => {
    const document = JSON.parse(row.body) as JsonDocument;
    document._id = row.id;
    return fields === undefined ? document : Object.fromEntries(fields.filter(field => Object.hasOwn(document, field))
      .map(field => [field, document[field]!])) as JsonDocument;
  });
}
const legacyWhere = `collection=? AND collection IN ('treatments','devicestatus') AND json_valid(body)`;
const timeWhere = `((json_type(body,'$.created_at')='text' AND json_extract(body,'$.created_at')>=?) OR
  (json_type(body,'$.created_at')='array' AND EXISTS(SELECT 1 FROM json_each(body,'$.created_at') AS item
    WHERE item.type='text' AND item.value>=?)))`;
function boundedPlan(lower: string, limit: number, skip: number): {
  statement: string; bindings: SqlStorageValue[]; source: TreatmentOrderReadSource;
} {
  const statement = `SELECT * FROM documents WHERE ${legacyWhere} AND ${timeWhere}
    AND json_extract(body,'$.created_at')>=? ORDER BY ${ORDER} LIMIT ? OFFSET ?`;
  const bindings: SqlStorageValue[] = ["treatments", lower, lower, lower, "$.rank", limit, skip];
  return { statement, bindings, source: {
    probeStatement: `SELECT COUNT(*) AS count FROM (SELECT 1 FROM documents INDEXED BY ${SOURCE_INDEX}
      WHERE collection='treatments' AND collection IN ('treatments','devicestatus') AND json_valid(body)
      AND json_extract(body,'$.created_at')>=? LIMIT 5001)`,
    probeBindings: [lower],
    buildStatement: `SELECT * FROM documents INDEXED BY ${SOURCE_INDEX} WHERE ${legacyWhere} AND ${timeWhere}
      AND json_extract(body,'$.created_at')>=? ORDER BY ${ORDER} LIMIT ? OFFSET ?`,
    buildBindings: ["treatments", lower, lower, lower, "$.rank", limit, skip],
  } };
}

/** Investigation only: dirty IDs remain after reads, so later outer rollback is rechecked. */
class NativeDirtyOrderPrototype {
  private ids: string[] | undefined;
  private readonly dirty = new Set<string>();
  private blocked = false;
  constructor(private readonly sql: SqlStorage, private readonly where = "collection='treatments' AND is_valid!=0",
    private readonly whereBindings: SqlStorageValue[] = []) {}
  changed(key?: string): void {
    if (key === undefined) { this.blocked = true; this.ids = undefined; return; }
    this.dirty.add(key);
    if (this.dirty.size > 16) { this.blocked = true; this.ids = undefined; }
  }
  private original(limit: number, skip: number): Row[] {
    return this.sql.exec<Row>(`SELECT * FROM documents WHERE ${this.where}
      ORDER BY ${ORDER} LIMIT ? OFFSET ?`, ...this.whereBindings, "$.rank", limit, skip).toArray();
  }
  read(limit: number, skip: number): Row[] {
    if (this.blocked) return this.original(limit, skip);
    if (this.ids === undefined) {
      const sourceCount = this.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM documents WHERE collection='treatments' LIMIT 5001)`).one().count;
      if (sourceCount > 5000) { this.blocked = true; return this.original(limit, skip); }
      const rows = this.sql.exec<{ id: string }>(`SELECT id FROM documents WHERE ${this.where}
        ORDER BY ${ORDER} LIMIT 5001`, ...this.whereBindings, "$.rank").toArray();
      if (rows.length > 5000) { this.blocked = true; return this.original(limit, skip); }
      this.ids = rows.map(row => row.id);
    }
    // Only ordinal arithmetic happens in JS. Every membership and comparison is native SQL.
    const next = this.ids.filter(key => !this.dirty.has(key));
    for (const changed of this.dirty) {
      const matches = this.sql.exec<{ id: string }>(`SELECT id FROM documents
        INDEXED BY sqlite_autoindex_documents_1 WHERE id=? AND ${this.where} LIMIT 1`, changed, ...this.whereBindings).toArray();
      if (matches.length === 0) continue;
      let low = 0, high = next.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        const first = this.sql.exec<{ id: string }>(`SELECT id FROM documents
          WHERE collection='treatments' AND id IN (?,?) ORDER BY ${ORDER} LIMIT 1`,
        changed, next[middle]!, "$.rank").one().id;
        if (first === changed) high = middle; else low = middle + 1;
      }
      next.splice(low, 0, changed);
    }
    if (next.length > 5000) { this.blocked = true; this.ids = undefined; return this.original(limit, skip); }
    this.ids = next;
    const page = next.slice(skip, skip + limit);
    if (page.length === 0) return [];
    return this.sql.exec<Row>(`SELECT documents.* FROM json_each(?) page CROSS JOIN documents
      ON documents.collection='treatments' AND documents.id=page.value ORDER BY CAST(page.key AS INTEGER)`,
    JSON.stringify(page)).toArray();
  }
}

describe("large-source and frequent-mutation native order investigation", () => {
  it("keeps complete mixed-type order over an indexed necessary date superset beyond 5000 total treatments", async () => {
    const stub = env.ENTRY_STORE.getByName(`large-order-source-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const total = 21001;
      state.storage.transactionSync(() => seed(state.storage.sql, total, true));
      const repository = new SqliteDocumentRepository(state.storage);
      const cache = new LegacyReadCache(), view = new TreatmentOrderReadView(state.storage.sql, cache);
      const lower = new Date(AT + (total - 1000) * 60_000).toISOString();
      const samples = [];
      for (const [pageIndex, page] of [{ limit: 3 }, { limit: 5, skip: 17, fields: ["identifier", "rank"] },
        { limit: 7, skip: 400, fields: ["identifier", "created_at"] }, { limit: 1, skip: 2000, fields: ["identifier"] }].entries()) {
        const query: DocumentQuery = { ...page, filters: [{ field: "created_at", operator: "gte", value: lower }],
          sort: { field: "rank", direction: "desc" } };
        const expected = repository.queryLegacyTreatments(query);
        const production = await measure(state.storage.sql, () => instance.queryLegacyTreatments(JSON.stringify(query)));
        expect(JSON.parse(production.result), `production/${pageIndex}`).toEqual(expected);
        const plan = boundedPlan(lower, page.limit, page.skip ?? 0);
        const key = view.key(plan.statement, plan.bindings);
        const proposed = await measure(state.storage.sql, () => {
          let rows = view.read<Row>(key, plan.statement, plan.bindings, page.limit, page.skip ?? 0, plan.source);
          if (rows === undefined) {
            const cursor = state.storage.sql.exec<Row>(plan.statement, ...plan.bindings);
            rows = cursor.toArray(); view.noteExpensiveRead(key, cursor.rowsRead);
          }
          return documents(rows, page.fields);
        });
        expect(proposed.result, `bounded/${pageIndex}`).toEqual(expected);
        expect(production.writes + proposed.writes).toBe(0);
        if (pageIndex >= 2) expect(proposed.documentReads).toBeLessThan(100);
        samples.push({ pageIndex, returned: expected.length,
          production: { reads: production.reads, statements: production.statements },
          bounded: { reads: proposed.reads, statements: proposed.statements } });
      }
      const sourceCount = state.storage.sql.exec<{ count: number }>(boundedPlan(lower, 1, 0).source.probeStatement, lower).one().count;
      expect(sourceCount).toBeGreaterThan(1000); // Arrays and objects are retained as complete extras.
      expect(sourceCount).toBeLessThan(1200);
      return { total, sourceCount, samples };
    });
    console.info(`TREATMENT_LARGE_INDEXED_ORDER=${JSON.stringify(report)}`);
  }, 60_000);

  it("requires two distinct expensive pages before a third request can build an optional view", async () => {
    const stub = env.ENTRY_STORE.getByName(`order-two-page-gate-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (_instance, state) => {
      state.storage.transactionSync(() => seed(state.storage.sql, 5000));
      const cache = new LegacyReadCache(), view = new TreatmentOrderReadView(state.storage.sql, cache, 2);
      const statement = `SELECT * FROM documents WHERE collection=? AND is_valid!=0 ORDER BY ${ORDER} LIMIT ? OFFSET ?`;
      const pages = [{ limit: 3, skip: 0 }, { limit: 3, skip: 0 }, { limit: 5, skip: 17 }, { limit: 7, skip: 400 }];
      const samples = [];
      for (const [index, page] of pages.entries()) {
        const bindings: SqlStorageValue[] = ["treatments", "$.rank", page.limit, page.skip];
        const key = view.key(statement, bindings);
        const expected = state.storage.sql.exec<Row>(statement, ...bindings).toArray();
        const actual = await measure(state.storage.sql, () => {
          let rows = view.read<Row>(key, statement, bindings, page.limit, page.skip);
          if (rows === undefined) {
            const cursor = state.storage.sql.exec<Row>(statement, ...bindings);
            rows = cursor.toArray(); view.noteExpensiveRead(key, cursor.rowsRead, JSON.stringify(page));
          }
          return rows;
        });
        expect(actual.result).toEqual(expected);
        expect(actual.writes).toBe(0);
        const built = actual.statements.some(item => item.sql.startsWith("SELECT id FROM documents"));
        expect(built, `request ${index}`).toBe(index === 3);
        samples.push({ index, reads: actual.reads, built });
      }
      return samples;
    });
    console.info(`TREATMENT_ORDER_TWO_PAGE_GATE=${JSON.stringify(report)}`);
  }, 60_000);

  it("rejects an over-cap count upper bound after a rolled-back create without scanning an optional source", async () => {
    const stub = env.ENTRY_STORE.getByName(`order-upper-bound-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.transactionSync(() => seed(state.storage.sql, 5000));
      const sql = state.storage.sql, cache = new LegacyReadCache();
      cache.set(TREATMENT_ORDER_SOURCE_KEY, "5000");
      expect(() => state.storage.transactionSync(() => {
        // Same conservative metadata update as a create hook: rollback may
        // leave the upper bound high, never lower than the canonical count.
        cache.set(TREATMENT_ORDER_SOURCE_KEY, "5001");
        sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
          VALUES('treatments',?,?,?,?,?,1)`, id(6000), JSON.stringify({ rank: "failed" }), AT, AT, AT);
        throw new Error("failed create rollback");
      })).toThrow("failed create rollback");
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM documents WHERE collection='treatments'").one().count).toBe(5000);
      const statement = `SELECT * FROM documents WHERE collection=? ORDER BY ${ORDER} LIMIT ? OFFSET ?`;
      for (const cached of ["5001", "rejected", "NaN", "-1", "1.5"]) {
        cache.clear();
        cache.set(TREATMENT_ORDER_SOURCE_KEY, cached);
        const view = new TreatmentOrderReadView(sql, cache);
        const bindings: SqlStorageValue[] = ["treatments", "$.rank", 1, 0];
        const key = view.key(statement, bindings);
        view.noteExpensiveRead(key, 513);
        const actual = await measure(sql, () => view.read(key, statement, bindings, 1, 0));
        expect(actual.result, cached).toBeUndefined();
        expect(actual.statements, cached).toEqual([]);
      }
    });
  }, 60_000);

  it("counts genuine patch plus only one or two distinct pages, including every source probe and rebuild", async () => {
    const stub = env.ENTRY_STORE.getByName(`order-frequent-two-pages-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      state.storage.transactionSync(() => seed(state.storage.sql, 5000));
      const repository = new SqliteDocumentRepository(state.storage);
      const phases = [];
      for (const { pageCount, policy, repetitions } of [
        { pageCount: 1, policy: "current", repetitions: 4 },
        { pageCount: 2, policy: "current", repetitions: 12 },
        { pageCount: 2, policy: "before-full-clear", repetitions: 12 },
      ] as const) {
        const cycles = [];
        for (let cycle = 0; cycle < repetitions; cycle++) {
          if (policy === "before-full-clear") {
            // Replay the preceding callback policy: all retained order/source
            // metadata disappears for every write. This operation performs no SQL.
            (instance as unknown as { legacyTreatmentQueries: LegacyReadCache }).legacyTreatmentQueries.clear();
          }
          const patch = await measure(state.storage.sql, () => instance.api3PatchDocument("treatments", "large-sort-4999",
            JSON.stringify({ rank: cycle % 2 === 0 ? `🚀${pageCount}-${cycle}` : cycle }), JSON.stringify({
              canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false })));
          expect(JSON.parse(patch.result)).toMatchObject({ ok: true });
          const pages = [];
          for (let page = 0; page < pageCount; page++) {
            const query: DocumentQuery = { limit: 3 + page * 2, skip: page * 17,
              fields: page === 0 ? ["identifier", "rank"] : ["identifier", "created_at"],
              sort: { field: "rank", direction: "desc" } };
            const reference = await measure(state.storage.sql, () => repository.queryDocumentsForApi3("treatments", query));
            const production = await measure(state.storage.sql, () => instance.api3QueryCollection("treatments", JSON.stringify(query)));
            expect(JSON.parse(production.result)).toEqual({ ok: true, result: reference.result });
            expect(reference.writes + production.writes).toBe(0);
            pages.push({ page, referenceReads: reference.reads, productionReads: production.reads,
              sourceProbes: production.statements.filter(item => item.sql.startsWith("SELECT COUNT(*) AS count FROM (")).length,
              orderBuilds: production.statements.filter(item => item.sql.startsWith("SELECT id FROM documents")).length });
          }
          cycles.push({ cycle, patch: { reads: patch.reads, writes: patch.writes }, pages,
            originalReads: patch.reads + pages.reduce((sum, page) => sum + page.referenceReads, 0),
            productionReads: patch.reads + pages.reduce((sum, page) => sum + page.productionReads, 0) });
        }
        expect(cycles.reduce((sum, cycle) => sum + cycle.pages.reduce((n, page) => n + page.sourceProbes, 0), 0))
          .toBe(pageCount === 1 ? 0 : policy === "before-full-clear" ? 12 : 1);
        if (pageCount === 2 && policy === "current") for (const cycle of cycles.slice(1))
          expect(cycle.pages.reduce((sum, page) => sum + page.sourceProbes, 0)).toBe(0);
        phases.push({ pageCount, policy, cycles,
          originalReads: cycles.reduce((sum, cycle) => sum + cycle.originalReads, 0),
          productionReads: cycles.reduce((sum, cycle) => sum + cycle.productionReads, 0),
          writesEach: cycles.reduce((sum, cycle) => sum + cycle.patch.writes, 0) });
      }
      const current = phases[1]!, preceding = phases[2]!;
      expect(preceding.originalReads).toBe(current.originalReads);
      expect(preceding.productionReads).toBeGreaterThan(current.productionReads);
      expect(preceding.writesEach).toBe(current.writesEach);
      for (let cycle = 0; cycle < 12; cycle++)
        expect(preceding.cycles[cycle]!.patch.writes).toBe(current.cycles[cycle]!.patch.writes);
      // Same canonical state and genuine patch cost; reference queries use no injected cache.
      return phases;
    });
    console.info(`TREATMENT_ORDER_FREQUENT_PATCH=${JSON.stringify(report)}`);
  }, 60_000);

  it("investigates native two-row insertion without JS value comparison and retains rollback dirty IDs", async () => {
    const stub = env.ENTRY_STORE.getByName(`order-native-dirty-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      state.storage.transactionSync(() => seed(state.storage.sql, 5000));
      const sql = state.storage.sql;
      const where = "collection='treatments' AND is_valid!=0 AND json_extract(body,'$.date')>=?";
      const whereBindings = [AT + 1000 * 60_000];
      const prototype = new NativeDirtyOrderPrototype(sql, where, whereBindings);
      const initial = await measure(sql, () => prototype.read(3, 0));
      const samples = [];
      for (let cycle = 0; cycle < 12; cycle++) {
        const patch = await measure(sql, () => instance.api3PatchDocument("treatments", "large-sort-4999",
          JSON.stringify({ rank: cycle % 3 === 0 ? `🚀${cycle}` : cycle % 3 === 1 ? -cycle : { a: cycle, z: 1 } }),
          JSON.stringify({ canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false })));
        expect(JSON.parse(patch.result)).toMatchObject({ ok: true });
        prototype.changed(id(4999));
        for (const skip of [0, 4000]) {
          const expected = sql.exec<Row>(`SELECT * FROM documents WHERE ${where}
            ORDER BY ${ORDER} LIMIT ? OFFSET ?`, ...whereBindings, "$.rank", 5, skip).toArray();
          const actual = await measure(sql, () => prototype.read(5, skip));
          expect(actual.result).toEqual(expected);
          expect(actual.writes).toBe(0);
          samples.push({ cycle, skip, reads: actual.reads, patch: { reads: patch.reads, writes: patch.writes } });
        }
      }
      const beforeRollback = sql.exec<Row>(`SELECT * FROM documents WHERE ${where}
        ORDER BY ${ORDER} LIMIT 5000 OFFSET 0`, ...whereBindings, "$.rank").toArray();
      expect(() => state.storage.transactionSync(() => {
        sql.exec("UPDATE documents SET body=json_set(body,'$.rank','zzz-rollback','$.date',0) WHERE collection='treatments' AND id=?", id(4999));
        prototype.changed(id(4999));
        expect(prototype.read(5000, 0)).toEqual(sql.exec<Row>(`SELECT * FROM documents
          WHERE ${where} ORDER BY ${ORDER} LIMIT 5000 OFFSET 0`, ...whereBindings, "$.rank").toArray());
        throw new Error("outer rollback");
      })).toThrow("outer rollback");
      expect(prototype.read(5000, 0)).toEqual(beforeRollback);
      // Unknown changes conservatively disable this test prototype, rather than assume an unaffected suffix.
      prototype.changed();
      expect(prototype.read(5000, 0)).toEqual(beforeRollback);
      return { initialReads: initial.reads, samples, rollbackMatchesOriginal: true, unknownFallsBack: true,
        scope: "Prototype only; dirty IDs never cleared after reads; bounded16 unique IDs, original fallback thereafter." };
    });
    console.info(`TREATMENT_ORDER_NATIVE_DIRTY_PROTOTYPE=${JSON.stringify(report)}`);
  }, 60_000);
});
