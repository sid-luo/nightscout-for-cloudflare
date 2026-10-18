import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import type { EntryStore, JsonDocument, JsonValue } from "../src/entry-store";
import { LegacyReadCache } from "../src/legacy-read-cache";

const AT = Date.UTC(2026, 9, 18, 12);
const RECORDS = 5000;
const MAX_IDS = 5000;
const id = (n: number) => n.toString(16).padStart(24, "0");
const CATEGORY = `((json_type(body, '$.eventType') = 'text' AND json_extract(body, '$.eventType') = ?)
  OR (json_type(body, '$.eventType') = 'array' AND EXISTS (
    SELECT 1 FROM json_each(body, '$.eventType') item WHERE item.type = 'text' AND item.value = ?)))`;
const RANK_ORDER = "json_extract(body, '$.rank') DESC, id DESC";
const COMPOUND_ORDER = "json_extract(body, '$.rank') ASC, json_extract(body, '$.nested.tie') DESC, id DESC";
interface RawRow extends Record<string, SqlStorageValue> { id: string; body: string }
interface Audit {
  name: string; query: DocumentQuery; policy?: "api3" | "legacy";
  where?: string; bindings?: SqlStorageValue[]; order: string;
}

function seed(sql: SqlStorage): void {
  const ranks: Array<JsonValue | undefined> = [undefined, null, 0, -2, 1.5, true, false,
    "01", "1", "A", "a", "\u0080", "\ue000", "🚀", [1, null], { z: 1, a: 2 }, { a: 2, z: 1 }];
  for (let n = 0; n < RECORDS; n++) {
    const at = AT + n * 1000;
    const rank = ranks[n % ranks.length];
    const body: JsonDocument = { _id: id(n), identifier: `sort-id-${n}`, date: at,
      created_at: new Date(at).toISOString(), srvCreated: at, srvModified: at + n % 3,
      isValid: n % 17 !== 0, eventType: ["Note", "Other", "Note", 7, "07", ["Absent"], { type: "Absent" },
        ...(n % 800 === 0 ? ["Rare"] : [])], nested: { tie: n % 11 }, flag: 1,
      ...(rank === undefined ? {} : { rank }) };
    sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,
      identifier_present,srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
      VALUES('treatments',?,?,?,?,?,?,1,?,?,?,?,1,1)`, id(n), JSON.stringify(body), at, at, at,
    body.identifier as string, at, at + n % 3, at + n % 3, n % 17 === 0 ? 0 : 1);
  }
}
function predicate(audit: Audit): { sql: string; bindings: SqlStorageValue[] } {
  return { sql: `collection = ? ${audit.policy === "legacy"
    ? "AND collection IN ('treatments','devicestatus') AND json_valid(body)"
    : audit.query.includeDeleted === true ? "" : "AND is_valid != 0"}
    ${audit.where === undefined ? "" : `AND ${audit.where}`}`,
  bindings: ["treatments", ...(audit.bindings ?? [])] };
}
function original(sql: SqlStorage, audit: Audit): RawRow[] {
  const where = predicate(audit);
  return sql.exec<RawRow>(`SELECT id,body FROM documents WHERE ${where.sql}
    ORDER BY ${audit.order} LIMIT ? OFFSET ?`, ...where.bindings, audit.query.limit ?? 1000, audit.query.skip ?? 0).toArray();
}
function materialize(rows: RawRow[], audit: Audit): JsonDocument[] {
  return rows.map(row => {
    const document = JSON.parse(row.body) as JsonDocument;
    if (audit.policy === "legacy") document._id = row.id;
    else {
      delete document._id;
      if (!document.identifier) document.identifier = row.id;
      if (!document.srvModified && typeof document.created_at === "string") document.srvModified = Date.parse(document.created_at);
      if (document.srvModified && !document.srvCreated) document.srvCreated = document.srvModified;
    }
    return audit.query.fields === undefined ? document : Object.fromEntries(audit.query.fields
      .filter(field => Object.hasOwn(document, field)).map(field => [field, document[field]!])) as JsonDocument;
  });
}
function fits(statement: string, bindings: readonly SqlStorageValue[]): boolean {
  return bindings.length <= 100 && new TextEncoder().encode(statement).byteLength <= 100_000;
}
function measured<T>(sql: SqlStorage, action: () => T) {
  const execute = sql.exec.bind(sql);
  const statements: { sql: string; bindings: SqlStorageValue[]; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = execute(statement, ...bindings);
    statements.push({ sql: statement, bindings, cursor });
    return cursor;
  });
  try {
    const result = action();
    return { result, reads: statements.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: statements.reduce((sum, item) => sum + item.cursor.rowsWritten, 0), calls: statements.length,
      plans: statements.filter(item => /^SELECT\b/.test(item.sql)).flatMap(item => execute<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${item.sql}`, ...item.bindings).toArray().map(row => row.detail)),
      statements: statements.map(item => ({ sql: item.sql.replace(/\s+/g, " ").trim(),
        bindings: item.bindings.length, reads: item.cursor.rowsRead })) };
  } finally { spy.mockRestore(); }
}
async function measuredAsync<T>(sql: SqlStorage, action: () => Promise<T>) {
  const execute = sql.exec.bind(sql);
  const statements: { sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = execute(statement, ...bindings);
    statements.push({ sql: statement, cursor });
    return cursor;
  });
  try {
    const result = await action();
    return { result, reads: statements.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: statements.reduce((sum, item) => sum + item.cursor.rowsWritten, 0),
      documentReads: statements.filter(item => /(?:FROM|JOIN)\s+documents\b/.test(item.sql))
        .reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      statements: statements.map(item => ({ sql: item.sql.replace(/\s+/g, " ").trim(), reads: item.cursor.rowsRead })) };
  } finally { spy.mockRestore(); }
}

const MISS = Symbol("absent investigation marker");
class IncompleteOrder extends Error { constructor(readonly reason: string) { super(reason); } }

/** Investigation only: complete native order, original SQL residual, zero DB writes. */
class NativeOrderPrototype {
  readonly views: LegacyReadCache;
  constructor(maxEntryBytes = 1024 * 1024) { this.views = new LegacyReadCache(128, 4 * 1024 * 1024, maxEntryBytes); }
  clear(): void { this.views.clear(); }
  read(sql: SqlStorage, audit: Audit, batch: number, strategy: "in" | "json1", maxProbes = Infinity) {
    const where = predicate(audit), limit = audit.query.limit ?? 1000, skip = audit.query.skip ?? 0;
    const originalStatement = `SELECT id,body FROM documents WHERE ${where.sql} ORDER BY ${audit.order} LIMIT ? OFFSET ?`;
    if (!fits(originalStatement, [...where.bindings, limit, skip])) throw new Error("original SQL exceeds limits");
    const fallback = (reason: string, inspected = 0) => ({ rows: original(sql, audit), reason, inspected });
    const key = `sort-native:${JSON.stringify([audit.policy ?? "api3", audit.query.includeDeleted === true, audit.order])}`;
    try { this.views.read(`sort-disabled:${key}`, () => { throw MISS; }); return fallback("blocked-view"); }
    catch (error) { if (error !== MISS) throw error; }
    let ids: string[];
    try {
      ids = JSON.parse(this.views.read(key, () => {
        const base = audit.policy === "legacy" ? "AND json_valid(body)" : audit.query.includeDeleted === true ? "" : "AND is_valid != 0";
        const rows = sql.exec<{ id: string }>(`SELECT id FROM documents WHERE collection = ? ${base}
          ORDER BY ${audit.order} LIMIT ?`, "treatments", MAX_IDS + 1).toArray();
        if (rows.length > MAX_IDS) throw new IncompleteOrder("more-than-5000");
        if (rows.some(row => typeof row.id !== "string")) throw new IncompleteOrder("non-string-id");
        const value = JSON.stringify(rows.map(row => row.id));
        // Default existing LegacyReadCache's exact per-entry budget.
        if (2 * (key.length + value.length) > 1024 * 1024) throw new IncompleteOrder("serialized-overflow");
        return value;
      })) as string[];
    } catch (error) {
      if (error instanceof IncompleteOrder || error instanceof Error && /malformed JSON/i.test(error.message)) {
        this.views.read(`sort-disabled:${key}`, () => "disabled");
        return fallback(error instanceof IncompleteOrder ? error.reason : "optional-malformed-body");
      }
      throw error;
    }
    const selected: string[] = [];
    let matched = 0, inspected = 0;
    const available = 100 - where.bindings.length;
    const width = Math.min(batch, strategy === "json1" ? 64 : available);
    if (width < 1) return fallback("binding-limit");
    for (let offset = 0; offset < ids.length; offset += width) {
      const chunk = ids.slice(offset, offset + width);
      if (inspected + chunk.length > maxProbes) return fallback("probe-budget", inspected);
      const statement = strategy === "json1"
        ? `SELECT documents.id FROM (SELECT value AS __candidate_id FROM json_each(?)) AS candidate
          CROSS JOIN documents WHERE documents.id = candidate.__candidate_id AND ${where.sql}`
        : `SELECT id FROM documents WHERE ${where.sql} AND id IN (${chunk.map(() => "?").join(",")})`;
      const values = strategy === "json1" ? [JSON.stringify(chunk), ...where.bindings] : [...where.bindings, ...chunk];
      if (!fits(statement, values)) return fallback("expanded-sql-limit", inspected);
      const hits = new Set(sql.exec<{ id: string }>(statement, ...values).toArray().map(row => row.id));
      inspected += chunk.length;
      for (const candidate of chunk) if (hits.has(candidate)) {
        if (matched++ >= skip) selected.push(candidate);
        if (selected.length >= limit) break;
      }
      if (selected.length >= limit) break;
    }
    const bodies = new Map<string, RawRow>();
    for (let offset = 0; offset < selected.length; offset += 90) {
      const chunk = selected.slice(offset, offset + 90);
      for (const row of sql.exec<RawRow>(`SELECT id,body FROM documents WHERE collection = ?
        AND id IN (${chunk.map(() => "?").join(",")})`, "treatments", ...chunk)) bodies.set(row.id, row);
    }
    return { rows: selected.map(id => bodies.get(id)!), reason: "complete-native-order", inspected };
  }
}

describe("zero-persistent-write unindexed treatment sort investigation", () => {
  it("measures moving filters, dense arrays, SQLite mixed values and compound/deep pages against complete original SQL", async () => {
    const stub = env.ENTRY_STORE.getByName(`unindexed-native-order-${crypto.randomUUID()}`);
    const reports = await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => seed(state.storage.sql));
      const repository = new SqliteDocumentRepository(state.storage);
      const audits: Audit[] = [
        ...[0, 1000, 3000].map(lower => ({ name: `moving-time-${lower}`, query: { limit: 5,
          sort: { field: "rank", direction: "desc" as const }, filters: [{ field: "date", operator: "gte" as const, value: AT + lower * 1000 }] },
          where: "json_extract(body, '$.date') >= ?", bindings: [AT + lower * 1000], order: RANK_ORDER })),
        { name: "compound-mixed", query: { limit: 5, skip: 17,
          sort: [{ field: "rank", direction: "asc" }, { field: "nested.tie", direction: "desc" }] }, order: COMPOUND_ORDER },
        { name: "dense-common-array", query: { limit: 5, sort: { field: "rank", direction: "desc" },
          filters: [{ field: "eventType", operator: "eq", value: "Note" }] }, where: CATEGORY, bindings: ["Note", "Note"], order: RANK_ORDER },
        { name: "dense-absent-member", query: { limit: 5, sort: { field: "rank", direction: "desc" },
          filters: [{ field: "eventType", operator: "eq", value: "Absent" }] }, where: CATEGORY, bindings: ["Absent", "Absent"], order: RANK_ORDER },
        { name: "dense-rare-member", query: { limit: 3, sort: { field: "rank", direction: "desc" },
          filters: [{ field: "eventType", operator: "eq", value: "Rare" }] }, where: CATEGORY, bindings: ["Rare", "Rare"], order: RANK_ORDER },
        { name: "deep-offset", query: { limit: 3, skip: 4000, sort: { field: "rank", direction: "desc" } }, order: RANK_ORDER },
        { name: "legacy-mixed", policy: "legacy", query: { limit: 5, skip: 11,
          sort: [{ field: "rank", direction: "asc" }, { field: "nested.tie", direction: "desc" }] }, order: COMPOUND_ORDER },
      ];
      const prototypes = [
        { name: "in32", cache: new NativeOrderPrototype(), strategy: "in" as const, batch: 32, max: Infinity },
        { name: "json64", cache: new NativeOrderPrototype(), strategy: "json1" as const, batch: 64, max: Infinity },
        { name: "json64-bounded", cache: new NativeOrderPrototype(), strategy: "json1" as const, batch: 64, max: 64 },
      ];
      return audits.map(audit => {
        const expected = original(state.storage.sql, audit);
        const expectedDocuments = materialize(expected, audit);
        const baseline = measured(state.storage.sql, () => audit.policy === "legacy"
          ? repository.queryLegacyDocuments("treatments", audit.query) : repository.queryDocumentsForApi3("treatments", audit.query));
        expect(baseline.result, audit.name).toEqual(expectedDocuments);
        expect(baseline.writes).toBe(0);
        const variants = prototypes.map(prototype => {
          const measuredResult = measured(state.storage.sql, () => prototype.cache.read(
            state.storage.sql, audit, prototype.batch, prototype.strategy, prototype.max));
          expect(materialize(measuredResult.result.rows, audit), `${audit.name}/${prototype.name}`).toEqual(expectedDocuments);
          expect(measuredResult.writes).toBe(0);
          return { variant: prototype.name, reads: measuredResult.reads, writes: measuredResult.writes,
            calls: measuredResult.calls, inspected: measuredResult.result.inspected, reason: measuredResult.result.reason,
            plans: [...new Set(measuredResult.plans)] };
        });
        return { name: audit.name, returned: expected.length, baseline: { reads: baseline.reads, writes: baseline.writes,
          calls: baseline.calls, plans: [...new Set(baseline.plans)] }, variants };
      });
    });
    console.info(`UNINDEXED_SORT_LOW_WRITE_BEFORE=${JSON.stringify(reports)}`);
    expect(reports).toHaveLength(9);
  }, 60_000);

  it("exposes optional out-of-filter malformed bodies and bounded overflow/retry behavior without changing successful reads", async () => {
    const stub = env.ENTRY_STORE.getByName(`unindexed-native-boundaries-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => seed(state.storage.sql));
      const sql = state.storage.sql;
      const audit: Audit = { name: "targeted-original", query: { limit: 1, sort: { field: "rank", direction: "desc" },
        filters: [{ field: "identifier", operator: "eq", value: "sort-id-42" }] },
      where: "identifier = ?", bindings: ["sort-id-42"], order: RANK_ORDER };
      const expected = original(sql, audit);
      sql.exec("UPDATE documents SET body='not JSON',is_valid=2 WHERE collection='treatments' AND id=?", id(4999));
      const repository = new SqliteDocumentRepository(state.storage);
      expect(repository.queryDocumentsForApi3("treatments", audit.query)).toEqual(materialize(expected, audit));
      const cache = new NativeOrderPrototype();
      const malformed = measured(sql, () => cache.read(sql, audit, 64, "json1", 64));
      expect(malformed.result.rows).toEqual(expected);
      expect(malformed.result.reason).toBe("optional-malformed-body");
      const retry = measured(sql, () => cache.read(sql, audit, 64, "json1", 64));
      expect(retry.result.reason).toBe("blocked-view");
      expect(retry.result.rows).toEqual(expected);
      expect(malformed.writes + retry.writes).toBe(0);
      sql.exec("UPDATE documents SET body=? WHERE collection='treatments' AND id=?",
        JSON.stringify({ _id: id(4999), identifier: "sort-id-4999", rank: "z" }), id(4999));
      sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
        VALUES('treatments',?,?,?,?,?,1)`, id(6000), JSON.stringify({ _id: id(6000), rank: "after" }), AT, AT, AT);
      const overflowAudit = { ...audit, query: { ...audit.query, includeDeleted: true } };
      cache.clear();
      const overflow = measured(sql, () => cache.read(sql, overflowAudit, 64, "json1", 64));
      const blocked = measured(sql, () => cache.read(sql, overflowAudit, 64, "json1", 64));
      expect(overflow.result.reason).toBe("more-than-5000");
      expect(blocked.result.reason).toBe("blocked-view");
      expect(overflow.result.rows).toEqual(original(sql, overflowAudit));
      expect(blocked.result.rows).toEqual(original(sql, overflowAudit));
      expect(overflow.writes + blocked.writes).toBe(0);
      return { malformed: { reason: malformed.result.reason, reads: malformed.reads },
        retry: { reason: retry.result.reason, reads: retry.reads },
        overflow: { reason: overflow.result.reason, reads: overflow.reads },
        blocked: { reason: blocked.result.reason, reads: blocked.reads } };
    });
    console.info(`UNINDEXED_SORT_LOW_WRITE_BOUNDARIES=${JSON.stringify(report)}`);
  }, 60_000);

  it("rebuilds after mutation and actual eviction, keeping large sort values out of retained ID views", async () => {
    const stub = env.ENTRY_STORE.getByName(`unindexed-native-cold-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => state.storage.transactionSync(() => seed(state.storage.sql)));
    const reports = [];
    for (let activation = 0; activation < 2; activation++) {
      if (activation > 0) await evictDurableObject(stub);
      reports.push(await runInDurableObject(stub, (_instance, state) => {
        const sql = state.storage.sql, cache = new NativeOrderPrototype();
        const audit: Audit = { name: "large-value", query: { limit: 3,
          sort: { field: "rank", direction: "desc" } }, order: RANK_ORDER };
        const phases = [];
        for (const phase of ["cold", "warm", "mutation"] as const) {
          if (phase === "mutation") {
            const body = JSON.stringify({ _id: id(42), identifier: "sort-id-42", rank: "zz".repeat(32_000) });
            sql.exec("UPDATE documents SET body=? WHERE collection='treatments' AND id=?", body, id(42));
            cache.clear(); // Required canonical mutation/rollback invalidation.
          }
          const actual = measured(sql, () => cache.read(sql, audit, 64, "json1", 64));
          expect(actual.result.rows).toEqual(original(sql, audit));
          expect(actual.writes).toBe(0);
          phases.push({ phase, reads: actual.reads, calls: actual.calls, inspected: actual.result.inspected });
        }
        return { activation, phases };
      }));
    }
    console.info(`UNINDEXED_SORT_LOW_WRITE_COLD=${JSON.stringify(reports)}`);
  }, 60_000);

  it("reuses production fixed-filter native views across page/projection variations and invalidates on genuine mutation", async () => {
    const stub = env.ENTRY_STORE.getByName(`unindexed-native-production-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      state.storage.transactionSync(() => seed(state.storage.sql));
      const repository = new SqliteDocumentRepository(state.storage);
      const samples = [];
      for (const lower of [1000, 1001]) {
        for (const [phase, page] of [
          ["original-expensive", { limit: 3 }],
          ["complete-view-build", { limit: 5, skip: 5, fields: ["identifier", "rank"] }],
          ["warm-deep-page", { limit: 7, skip: 400, fields: ["identifier", "created_at"] }],
          ["warm-empty-page", { limit: 1, skip: 4999, fields: ["identifier"] }],
        ] as const) {
          const query: DocumentQuery = { limit: page.limit, ...("skip" in page ? { skip: page.skip } : {}),
            ...("fields" in page ? { fields: [...page.fields] } : {}),
            sort: { field: "rank", direction: "desc" }, filters: [{ field: "date", operator: "gte", value: AT + lower * 1000 }] };
          // A separate repository has no EntryStore shared cache injected.
          const expected = repository.queryDocumentsForApi3("treatments", query);
          const actual = await measuredAsync(state.storage.sql, () => instance.api3QueryCollection("treatments", JSON.stringify(query)));
          expect(JSON.parse(actual.result), `${lower}/${phase}`).toEqual({ ok: true, result: expected });
          expect(actual.writes).toBe(0);
          if (phase.startsWith("warm-")) expect(actual.documentReads, `${lower}/${phase}`).toBeLessThan(100);
          else expect(actual.documentReads, `${lower}/${phase}`).toBeGreaterThan(512);
          samples.push({ lower, phase, reads: actual.reads, documentReads: actual.documentReads,
            writes: actual.writes, returned: expected.length, statements: actual.statements });
        }
      }
      const mutation = JSON.parse(await instance.api3PatchDocument("treatments", "sort-id-4999", JSON.stringify({ rank: "🚀zz" }),
        JSON.stringify({ canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false })));
      expect(mutation).toMatchObject({ ok: true });
      const query: DocumentQuery = { limit: 2, sort: { field: "rank", direction: "desc" },
        filters: [{ field: "date", operator: "gte", value: AT + 1000 * 1000 }] };
      const expected = repository.queryDocumentsForApi3("treatments", query);
      const after = await measuredAsync(state.storage.sql, () => instance.api3QueryCollection("treatments", JSON.stringify(query)));
      expect(JSON.parse(after.result)).toEqual({ ok: true, result: expected });
      expect(expected[0]!.identifier).toBe("sort-id-4999");
      expect(after.documentReads).toBeGreaterThan(512);
      expect(after.writes).toBe(0);
      return { samples, afterMutation: { reads: after.reads, documentReads: after.documentReads,
        writes: after.writes, identifiers: expected.map(document => document.identifier) } };
    });
    console.info(`UNINDEXED_SORT_FIXED_VIEW_PRODUCTION=${JSON.stringify(report)}`);
  }, 60_000);

  it("counts complete rebuilds and genuine patch writes over repeated fixed-filter page cycles", async () => {
    const reports = [];
    for (const mode of ["original", "production"] as const) {
      const stub = env.ENTRY_STORE.getByName(`unindexed-native-cycles-${mode}-${crypto.randomUUID()}`);
      reports.push(await runInDurableObject(stub, async (instance: EntryStore, state) => {
        state.storage.transactionSync(() => seed(state.storage.sql));
        const repository = new SqliteDocumentRepository(state.storage);
        const cycles = [];
        for (let cycle = 0; cycle < 12; cycle++) {
          const patch = await measuredAsync(state.storage.sql, () => instance.api3PatchDocument(
            "treatments", "sort-id-4999", JSON.stringify({ rank: cycle % 2 === 0 ? `🚀cycle-${cycle}` : cycle }),
            JSON.stringify({ canCreate: true, canUpdate: true, actor: null,
              ifUnmodifiedSince: null, emitRealtime: false })));
          expect(JSON.parse(patch.result)).toMatchObject({ ok: true });
          const pages = [];
          for (const [pageIndex, page] of [
            { limit: 3 },
            { limit: 5, skip: 5, fields: ["identifier", "rank"] },
            { limit: 7, skip: 400, fields: ["identifier", "created_at"] },
            { limit: 11, skip: 1200, fields: ["identifier", "nested"] },
            { limit: 2, skip: 2800, fields: ["identifier"] },
            { limit: 1, skip: 4999, fields: ["identifier"] },
          ].entries()) {
            const query: DocumentQuery = { ...page, sort: { field: "rank", direction: "desc" },
              filters: [{ field: "date", operator: "gte", value: AT + 1000 * 1000 }] };
            // Every independent full SQL oracle is outside the measured workload.
            const expected = repository.queryDocumentsForApi3("treatments", query);
            const actual = await measuredAsync(state.storage.sql, () => mode === "production"
              ? instance.api3QueryCollection("treatments", JSON.stringify(query))
              : Promise.resolve(JSON.stringify({ ok: true, result: repository.queryDocumentsForApi3("treatments", query) })));
            expect(JSON.parse(actual.result), `${mode}/${cycle}/${pageIndex}`).toEqual({ ok: true, result: expected });
            expect(actual.writes).toBe(0);
            pages.push({ pageIndex, reads: actual.reads, documentReads: actual.documentReads,
              writes: actual.writes, returned: expected.length,
              sourceProbes: actual.statements.filter(item => item.sql.startsWith("SELECT COUNT(*) AS count FROM (")).length,
              orderBuilds: actual.statements.filter(item => item.sql.startsWith("SELECT id FROM documents")).length });
          }
          cycles.push({ cycle, patch: { reads: patch.reads, writes: patch.writes }, pages,
            readTotal: patch.reads + pages.reduce((sum, item) => sum + item.reads, 0),
            writeTotal: patch.writes + pages.reduce((sum, item) => sum + item.writes, 0) });
        }
        return { mode, cycles, reads: cycles.reduce((sum, item) => sum + item.readTotal, 0),
          writes: cycles.reduce((sum, item) => sum + item.writeTotal, 0) };
      }));
    }
    const [before, after] = reports;
    expect(after!.reads).toBeLessThan(before!.reads);
    expect(after!.writes).toBe(before!.writes);
    for (let cycle = 0; cycle < 12; cycle++) {
      expect(after!.cycles[cycle]!.patch.writes, `cycle ${cycle}`).toBe(before!.cycles[cycle]!.patch.writes);
      const pages = after!.cycles[cycle]!.pages;
      expect(pages.reduce((sum, page) => sum + page.sourceProbes, 0), `source probe ${cycle}`).toBe(cycle === 0 ? 1 : 0);
      expect(pages.reduce((sum, page) => sum + page.orderBuilds, 0), `complete build ${cycle}`).toBe(1);
      for (const page of pages.slice(2)) expect(page.documentReads).toBeLessThan(100);
    }
    console.info(`UNINDEXED_SORT_FIXED_VIEW_CYCLES=${JSON.stringify(reports)}`);
  }, 60_000);
});
