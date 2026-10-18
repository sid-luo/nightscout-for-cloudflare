import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import { LegacyReadCache } from "../src/legacy-read-cache";
import { TreatmentMembershipReadView, TREATMENT_MEMBERSHIP_VIEW_KEY as MEMBER_KEY } from "../src/treatment-membership-read-view";
import { TreatmentOrderReadView } from "../src/treatment-order-read-view";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const id = (n: number) => n.toString(16).padStart(24, "0");
const ORIGINAL = `((json_type(body,'$.eventType')='text' AND json_extract(body,'$.eventType')=?) OR
  (json_type(body,'$.eventType')='array' AND EXISTS(SELECT 1 FROM json_each(body,'$.eventType') AS item WHERE item.type='text' AND item.value=?)))`;
const TOKEN_GUARD = `CASE WHEN json_valid(body) THEN CASE WHEN json_type(body,'$.eventType')='array' THEN
  CASE WHEN instr(json_extract(body,'$.eventType'),char(92))=0 THEN instr(json_extract(body,'$.eventType'),json_quote(?))>0 ELSE 1 END
  ELSE 1 END ELSE 1 END`;
const SLOTS = Array.from({ length: 8 }, (_, n) => `(json_type(body,'$.eventType[${n}]')='text' AND json_extract(body,'$.eventType[${n}]')=?)`).join(" OR ");
const SHORT_ARRAY = `((json_type(body,'$.eventType')='text' AND json_extract(body,'$.eventType')=?) OR
  (json_type(body,'$.eventType')='array' AND CASE WHEN json_array_length(body,'$.eventType')<=8 THEN COALESCE((${SLOTS}),0)
    ELSE EXISTS(SELECT 1 FROM json_each(body,'$.eventType') AS item WHERE item.type='text' AND item.value=?) END))`;
const ORDER = "ORDER BY sort_time DESC,srv_modified DESC,id ASC LIMIT ? OFFSET ?";
const statement = (predicate: string) => `SELECT * FROM documents INDEXED BY documents_treatments_api3_order
  WHERE collection=? AND collection='treatments' AND is_valid != 0 AND ${predicate} ${ORDER}`;
const query = (category: string, limit: number, skip = 0): DocumentQuery => ({ limit, skip,
  filters: [{ field: "eventType", operator: "eq", value: category }] });
interface Row extends Record<string, SqlStorageValue> { id: string; body: string }
interface Internal { legacyTreatmentQueries: LegacyReadCache; documentRepository(): SqliteDocumentRepository }
async function measure<T>(sql: SqlStorage, action: () => T | Promise<T>) {
  const execute = sql.exec.bind(sql);
  const queries: { statement: string; bindings: SqlStorageValue[]; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((sqlText, ...bindings) => {
    const cursor = execute(sqlText, ...bindings); queries.push({ statement: sqlText, bindings, cursor }); return cursor;
  });
  try {
    const result = await action();
    const source = queries.filter(item => item.statement.includes(" AS valid_json") && item.statement.includes("FROM documents"));
    return { result, reads: queries.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: queries.reduce((sum, item) => sum + item.cursor.rowsWritten, 0),
      membershipSourceReads: source.reduce((sum, item) => sum + item.cursor.rowsRead, 0), sourceCalls: source.length,
      calls: queries.map(item => ({ statement: item.statement, bindings: item.bindings, reads: item.cursor.rowsRead })) };
  } finally { spy.mockRestore(); }
}
function seed(sql: SqlStorage, count: number, fragment = '["Note","Other",7,["Absent"],null]'): void {
  sql.exec(`WITH RECURSIVE s(n) AS(VALUES(0) UNION ALL SELECT n+1 FROM s WHERE n<?)
    INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,identifier_present,
      srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
    SELECT 'treatments',printf('%024x',n),json_object('_id',printf('%024x',n),'identifier','evict-'||n,
      'created_at','2026-10-18T12:00:00.000Z','date',?+n,'rank',n%7,'eventType',json(?),
      'srvCreated',?,'srvModified',?+n,'isValid',1),?+n,?,?, 'evict-'||n,1,?,?+n,?+n,1,1,1 FROM s`,
  count - 1, AT, fragment, AT, AT, AT, AT, AT, AT, AT, AT);
}
function finishMembership(sql: SqlStorage, cache: LegacyReadCache): void {
  const view = new TreatmentMembershipReadView(sql, cache);
  for (let attempt = 0; attempt < 8; attempt++) {
    const ids = view.candidates("Absent");
    if (ids !== undefined) { expect(ids).toEqual([]); return; }
    view.noteExpensiveRead(513);
  }
  throw new Error("fixture membership did not finish");
}
function caught(action: () => unknown) {
  try { return { value: action() }; }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
}
const fits = (sqlText: string, values: SqlStorageValue[]) => values.length <= 100 && new TextEncoder().encode(sqlText).byteLength <= 100_000;
function materializeOriginalRows(storage: DurableObjectStorage, rows: Row[], requested: DocumentQuery, legacy = false) {
  const oracle = new SqliteDocumentRepository(storage);
  // Only the independent fixed original SQL supplies rows. Reuse the public
  // materializer/projection so the oracle also preserves server metadata.
  (oracle as unknown as { queryTreatmentRows(): Row[] }).queryTreatmentRows = () => rows;
  return legacy ? oracle.queryLegacyTreatments(requested) : oracle.queryTreatments(requested);
}

describe("actual cold treatment membership rebuild investigation", () => {
  it("records whole public recovery after real eviction and demonstrates ready-only reuse of a successful complete empty page", async () => {
    const stub = env.ENTRY_STORE.getByName(`membership-real-cold-baseline-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (instance, state) => {
      seed(state.storage.sql, 6001);
      finishMembership(state.storage.sql, (instance as unknown as Internal).legacyTreatmentQueries);
    });
    await evictDurableObject(stub);
    const report = await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql, cache = (instance as unknown as Internal).legacyTreatmentQueries;
      expect(cache.get(MEMBER_KEY)).toBeUndefined(); expect(TreatmentMembershipReadView.isUnsafe(cache)).toBe(false);
      const oracle = new SqliteDocumentRepository(state.storage);
      const samples = [];
      for (let n = 0; n < 4; n++) {
        const requested: DocumentQuery = { ...query("Absent", n + 1), ...(n % 2 ? { fields: ["eventType"] } : {}) };
        const sample = await measure(sql, () => instance.api3QueryCollection("treatments", JSON.stringify(requested)));
        expect(JSON.parse(sample.result)).toEqual({ ok: true, result: oracle.queryTreatments(requested) });
        expect(sample.writes).toBe(0);
        samples.push({ reads: sample.reads, membershipSourceReads: sample.membershipSourceReads, sourceCalls: sample.sourceCalls });
      }
      // Investigation-only replay: the first successful skip=0 empty page
      // proves complete output for this exact full WHERE/native order. Existing
      // ready-only view machinery can reuse it without another SQL scan.
      const proofCache = new LegacyReadCache(), ready = new TreatmentOrderReadView(sql, proofCache);
      const sqlText = statement(ORIGINAL), values: SqlStorageValue[] = ["treatments", "Absent", "Absent", 1, 0];
      const key = ready.key(sqlText, values);
      expect(ready.observeCompleteRead(key, [], 1, 0, proofCache.generation)).toBe(true);
      const reuse = await measure(sql, () => ready.read<Row>(key, sqlText,
        [...values.slice(0, -2), 7, 0], 7, 0, undefined, false));
      expect(reuse.result).toEqual([]); expect(reuse.reads).toBe(0); expect(reuse.writes).toBe(0);
      return { samples, publicFourRequestsReads: samples.reduce((sum, sample) => sum + sample.reads, 0),
        publicMembershipRebuildReads: samples.reduce((sum, sample) => sum + sample.membershipSourceReads, 0),
        reuseSuccessfulColdEmptyAdditionalReads: reuse.reads, optionalWrites: 0 };
    });
    console.info(`MEMBERSHIP_REAL_COLD_PUBLIC=${JSON.stringify(report)}`);
    expect(report.optionalWrites).toBe(0);
  }, 60_000);

  it("measures token guarding versus short-array JSON1 slots using the same full native residual and order", async () => {
    const reports = [];
    const variants = [
      { name: "nested-missing-token-present", fragment: '["Note","Other",7,["Absent"],null]', category: "Absent", count: 6001 },
      { name: "flat-missing-token-absent", fragment: '["Note","Other",7,["Different"],null]', category: "Absent", count: 6001 },
      { name: "escaped-short-missing", fragment: '["\\u004eote","Other",7,["Absent"],null]', category: "Absent", count: 6001 },
      { name: "eight-last-member", fragment: '[0,1,2,3,4,5,6,"Target"]', category: "Target", count: 128 },
      { name: "nine-last-member-fallback", fragment: '[0,1,2,3,4,5,6,7,"Target"]', category: "Target", count: 128 },
      { name: "long-nested-missing-fallback", fragment: JSON.stringify([...Array<string>(63).fill("Other"), ["Absent"]]), category: "Absent", count: 128 },
    ];
    for (const variant of variants) {
      const stub = env.ENTRY_STORE.getByName(`membership-native-cold-${variant.name}-${crypto.randomUUID()}`);
      reports.push(await runInDurableObject(stub, async (_instance, state) => {
        const sql = state.storage.sql; seed(sql, variant.count, variant.fragment);
        const baseValues: SqlStorageValue[] = ["treatments", variant.category, variant.category, 3, 0];
        const old = await measure(sql, () => sql.exec<Row>(statement(ORIGINAL), ...baseValues).toArray());
        const guardedValues: SqlStorageValue[] = ["treatments", variant.category, variant.category, variant.category, 3, 0];
        const guarded = await measure(sql, () => sql.exec<Row>(statement(`(${TOKEN_GUARD}) AND ${ORIGINAL}`), ...guardedValues).toArray());
        const shortValues: SqlStorageValue[] = ["treatments", ...Array<string>(10).fill(variant.category), 3, 0];
        const short = await measure(sql, () => sql.exec<Row>(statement(SHORT_ARRAY), ...shortValues).toArray());
        expect(guarded.result).toEqual(old.result); expect(short.result).toEqual(old.result);
        expect(old.writes + guarded.writes + short.writes).toBe(0);
        const plans = [ORIGINAL, `(${TOKEN_GUARD}) AND ${ORIGINAL}`, SHORT_ARRAY].map((predicate, n) =>
          sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${statement(predicate)}`, ...[baseValues, guardedValues, shortValues][n]!)
            .toArray().map(row => row.detail));
        expect(plans.every(plan => plan.some(detail => detail.includes("documents_treatments_api3_order")))).toBe(true);
        return { name: variant.name, sourceRows: variant.count, returned: old.result.length,
          originalCoreReads: old.reads, tokenGuardCoreReads: guarded.reads, shortArrayCoreReads: short.reads,
          optionalOriginalBindings: baseValues.length, optionalShortBindings: shortValues.length, writes: 0, plans };
      }));
    }
    console.info(`MEMBERSHIP_REAL_COLD_SQL_VARIANTS=${JSON.stringify(reports)}`);
    expect(reports).toMatchInlineSnapshot(`
      [
        {
          "name": "nested-missing-token-present",
          "optionalOriginalBindings": 5,
          "optionalShortBindings": 13,
          "originalCoreReads": 36006,
          "plans": [
            [
              "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
            [
              "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
            [
              "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
          ],
          "returned": 0,
          "shortArrayCoreReads": 6001,
          "sourceRows": 6001,
          "tokenGuardCoreReads": 36006,
          "writes": 0,
        },
        {
          "name": "flat-missing-token-absent",
          "optionalOriginalBindings": 5,
          "optionalShortBindings": 13,
          "originalCoreReads": 36006,
          "plans": [
            [
              "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
            [
              "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
            [
              "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
          ],
          "returned": 0,
          "shortArrayCoreReads": 6001,
          "sourceRows": 6001,
          "tokenGuardCoreReads": 6001,
          "writes": 0,
        },
        {
          "name": "escaped-short-missing",
          "optionalOriginalBindings": 5,
          "optionalShortBindings": 13,
          "originalCoreReads": 36006,
          "plans": [
            [
              "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
            [
              "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
            [
              "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
          ],
          "returned": 0,
          "shortArrayCoreReads": 6001,
          "sourceRows": 6001,
          "tokenGuardCoreReads": 36006,
          "writes": 0,
        },
        {
          "name": "eight-last-member",
          "optionalOriginalBindings": 5,
          "optionalShortBindings": 13,
          "originalCoreReads": 24,
          "plans": [
            [
              "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
            [
              "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
            [
              "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
          ],
          "returned": 3,
          "shortArrayCoreReads": 3,
          "sourceRows": 128,
          "tokenGuardCoreReads": 24,
          "writes": 0,
        },
        {
          "name": "nine-last-member-fallback",
          "optionalOriginalBindings": 5,
          "optionalShortBindings": 13,
          "originalCoreReads": 27,
          "plans": [
            [
              "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
            [
              "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
            [
              "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
          ],
          "returned": 3,
          "shortArrayCoreReads": 27,
          "sourceRows": 128,
          "tokenGuardCoreReads": 27,
          "writes": 0,
        },
        {
          "name": "long-nested-missing-fallback",
          "optionalOriginalBindings": 5,
          "optionalShortBindings": 13,
          "originalCoreReads": 8320,
          "plans": [
            [
              "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
            [
              "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
            [
              "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
              "CORRELATED SCALAR SUBQUERY 1",
              "SCAN item VIRTUAL TABLE INDEX 3:",
            ],
          ],
          "returned": 0,
          "shortArrayCoreReads": 8320,
          "sourceRows": 128,
          "tokenGuardCoreReads": 8320,
          "writes": 0,
        },
      ]
    `);
  }, 60_000);

  it("matches exotic native values and retains actual lazy success/error timing", async () => {
    const stub = env.ENTRY_STORE.getByName(`membership-cold-exotic-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const fragments = [
        '{"eventType":["\\u0041","Note"]}', '{"eventType":["A\\u0000suffix","A"]}',
        '{"eventType":["\\ud800","Note"]}', '{"eventType":["Nöté","🧪","A"]}',
        '{"eventType":["A"],"eventType":["Other"]}', '{"eventType":["Other"],"eventType":["A"]}',
        '{"eventType":[7,"7",null,true,false,[],{},"A"]}',
        '{"eventType":[["Absent"],{"kind":"Absent"},"Quote\\\"x","Back\\\\x",""]}',
        '{"eventType":[0,1,2,3,4,5,6,7,"A"]}', '{"eventType":[1e309,-0,"A"]}', '{}',
      ];
      for (const [n, body] of fragments.entries()) sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
        VALUES('treatments',?,?,?,?,?,1)`, id(n), body, AT + n, AT, AT);
      for (const category of ["A", "Note", "Other", "Absent", "7", "", 'Quote"x', "Back\\x", "A\0suffix", "Nöté"]) {
        const base = sql.exec<Row>(statement(ORIGINAL), "treatments", category, category, 100, 0).toArray();
        const short = sql.exec<Row>(statement(SHORT_ARRAY), "treatments", ...Array<string>(10).fill(category), 100, 0).toArray();
        expect(short, category).toEqual(base);
        if (/^[\x20-\x7e]{0,512}$/.test(category)) {
          const guarded = sql.exec<Row>(statement(`(${TOKEN_GUARD}) AND ${ORIGINAL}`), "treatments", category, category, category, 100, 0).toArray();
          expect(guarded, category).toEqual(base);
        }
      }
      // Newest valid A wins before the malformed old row. A missing category
      // must encounter it. Compare outcomes rather than assume eager failure.
      sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
        VALUES('treatments',?,?,?,?,?,1)`, id(1000), "{invalid", AT - 1, AT, AT);
      for (const category of ["A", "Guaranteed Missing"]) {
        const old = caught(() => sql.exec<Row>(statement(ORIGINAL), "treatments", category, category, 1, 0).toArray());
        const short = caught(() => sql.exec<Row>(statement(SHORT_ARRAY), "treatments", ...Array<string>(10).fill(category), 1, 0).toArray());
        const guarded = caught(() => sql.exec<Row>(statement(`(${TOKEN_GUARD}) AND ${ORIGINAL}`), "treatments", category, category, category, 1, 0).toArray());
        expect(short).toEqual(old); expect(guarded).toEqual(old);
        expect(old).toHaveProperty(category === "A" ? "value" : "error");
      }
    });
  });

  it("keeps default-order complete proofs scoped to validity, full filters and successful first pages", async () => {
    const stub = env.ENTRY_STORE.getByName(`membership-cold-scope-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql; seed(sql, 6001, '["Note","Other"]');
      const repo = (instance as unknown as Internal).documentRepository();
      repo.upsertTreatment({ _id: id(1000), identifier: "deleted-absent", created_at: new Date(AT).toISOString(),
        eventType: "Absent", isValid: false });
      const oracle = new SqliteDocumentRepository(state.storage);
      const missing = await measure(sql, () => instance.api3QueryCollection("treatments", JSON.stringify(query("Absent", 1))));
      expect(JSON.parse(missing.result)).toEqual({ ok: true, result: [] }); expect(missing.reads).toBeGreaterThan(512);
      const included = { ...query("Absent", 10), includeDeleted: true };
      const visible = JSON.parse(await instance.api3QueryCollection("treatments", JSON.stringify(included)));
      expect(visible).toEqual({ ok: true, result: oracle.queryTreatments(included) }); expect(visible.result).toHaveLength(1);
      expect(JSON.parse(await instance.queryLegacyTreatmentsWithUuidHandling(JSON.stringify(query("Absent", 10)), true)))
        .toEqual(oracle.queryLegacyTreatments(query("Absent", 10)));
      const skipped = query("Note", 1, 10_000);
      expect(JSON.parse(await instance.api3QueryCollection("treatments", JSON.stringify(skipped))))
        .toEqual({ ok: true, result: oracle.queryTreatments(skipped) });
      const first = query("Note", 1, 0);
      const actual = JSON.parse(await instance.api3QueryCollection("treatments", JSON.stringify(first)));
      expect(actual).toEqual({ ok: true, result: oracle.queryTreatments(first) }); expect(actual.result).toHaveLength(1);
    });
  });

  it("retains original legal binding and SQL-byte contracts when the optional short-array expression does not fit", async () => {
    const stub = env.ENTRY_STORE.getByName(`membership-cold-limits-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql; seed(sql, 3, '["Note"]');
      // A flat 95-term AND would make the original expression itself exceed
      // workerd's depth=100 before we can test the separate binding contract.
      const extra = `id NOT IN (${Array<string>(95).fill("?").join(",")})`;
      const originalText = statement(`${ORIGINAL} AND ${extra}`);
      const shortText = statement(`${SHORT_ARRAY} AND ${extra}`);
      const originalValues: SqlStorageValue[] = ["treatments", "Note", "Note", ...Array<string>(95).fill("absent"), 1, 0];
      const shortValues: SqlStorageValue[] = ["treatments", ...Array<string>(10).fill("Note"), ...Array<string>(95).fill("absent"), 1, 0];
      expect(originalValues).toHaveLength(100); expect(fits(originalText, originalValues)).toBe(true);
      expect(fits(shortText, shortValues)).toBe(false);
      const expected = sql.exec<Row>(originalText, ...originalValues).toArray();
      const selected = fits(shortText, shortValues) ? { statement: shortText, values: shortValues }
        : { statement: originalText, values: originalValues };
      expect(sql.exec<Row>(selected.statement, ...selected.values).toArray()).toEqual(expected);
      // SQLite platform boundary prototype only: comments do not change the
      // predicate, and do not claim a public parser can emit this exact text.
      const base = statement(ORIGINAL), replacement = statement(SHORT_ARRAY);
      const padding = ` /*${"x".repeat(99_900 - new TextEncoder().encode(base).byteLength - 5)}*/`;
      const values: SqlStorageValue[] = ["treatments", "Note", "Note", 1, 0];
      expect(new TextEncoder().encode(base + padding).byteLength).toBe(99_900);
      expect(fits(base + padding, values)).toBe(true);
      expect(fits(replacement + padding, ["treatments", ...Array<string>(10).fill("Note"), 1, 0])).toBe(false);
      expect(sql.exec<Row>(base + padding, ...values).toArray()).toHaveLength(1);
    });
  });

  it("retains an originally legal many-filter query without expanding the category AST", async () => {
    const stub = env.ENTRY_STORE.getByName(`membership-cold-filter-depth-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql; seed(sql, 3, '["Note"]');
      const requested: DocumentQuery = { limit: 1,
        filters: Array.from({ length: 17 }, () => ({ field: "eventType", operator: "eq" as const, value: "Note" })) };
      const original = new SqliteDocumentRepository(state.storage).queryTreatments(requested);
      expect(original).toHaveLength(1);
      const execute = sql.exec.bind(sql), statements: string[] = [];
      const spy = vi.spyOn(sql, "exec").mockImplementation((sqlText, ...values) => {
        statements.push(sqlText); return execute(sqlText, ...values);
      });
      try {
        expect(JSON.parse(await instance.api3QueryCollection("treatments", JSON.stringify(requested))))
          .toEqual({ ok: true, result: original });
      } finally { spy.mockRestore(); }
      // The optional eight-slot equality is limited to <=16 filters. Its
      // additional expression depth must not reject this valid old query.
      expect(statements.some(sqlText => /\$\.eventType\[8\]/.test(sqlText))).toBe(false);
    });
  });

  it("executes real public queries at the original and expanded binding limits with full original SQL oracles", async () => {
    const stub = env.ENTRY_STORE.getByName(`membership-cold-public-bindings-${crypto.randomUUID()}`);
    const reports = await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql; seed(sql, 32, '["Note"]');
      const samples = [];
      for (const count of [95, 87]) {
        const identifiers = Array.from({ length: count }, (_, n) => n < 32 ? `evict-${n}` : `absent-${n}`);
        const requested: DocumentQuery = { limit: 3, skip: 1, filters: [
          { field: "eventType", operator: "eq", value: "Note" },
          { field: "identifier", operator: "in", value: identifiers },
        ] };
        const originalText = statement(`${ORIGINAL} AND identifier IN (${identifiers.map(() => "?").join(",")})`);
        const originalValues: SqlStorageValue[] = ["treatments", "Note", "Note", ...identifiers, 3, 1];
        const original = sql.exec<Row>(originalText, ...originalValues).toArray();
        expect(original).toHaveLength(3);
        expect(originalValues).toHaveLength(count + 5);
        const expected = materializeOriginalRows(state.storage, original, requested);
        const actual = await measure(sql, () => instance.api3QueryCollection("treatments", JSON.stringify(requested)));
        expect(JSON.parse(actual.result)).toEqual({ ok: true, result: expected });
        expect(actual.writes).toBe(0);
        const selected = actual.calls.filter(call => /^\s*SELECT\s+\*/.test(call.statement)
          && call.statement.includes("OFFSET ?"));
        expect(selected).toHaveLength(1);
        expect(selected[0]!.bindings).toHaveLength(100);
        const expanded = /\$\.eventType\[8\]/.test(selected[0]!.statement);
        expect(expanded).toBe(count === 87);
        const plan = sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${selected[0]!.statement}`,
          ...selected[0]!.bindings).toArray().map(row => row.detail);
        expect(plan.some(detail => detail.includes("documents_treatments_api3_order"))).toBe(true);
        samples.push({ originalBindings: originalValues.length, executedBindings: selected[0]!.bindings.length,
          expanded, returned: expected.length, reads: actual.reads, writes: actual.writes, plan });
      }
      // The 512-code-unit boundary only controls optional admission. A longer
      // legitimate string must still execute its unmodified original query.
      const category = "x".repeat(513), requested = query(category, 1);
      const original = sql.exec<Row>(statement(ORIGINAL), "treatments", category, category, 1, 0).toArray();
      const actual = await measure(sql, () => instance.api3QueryCollection("treatments", JSON.stringify(requested)));
      expect(JSON.parse(actual.result)).toEqual({ ok: true, result: materializeOriginalRows(state.storage, original, requested) });
      expect(actual.calls.some(call => /\$\.eventType\[8\]/.test(call.statement))).toBe(false);
      expect(actual.writes).toBe(0);
      return samples;
    });
    console.info(`MEMBERSHIP_REAL_COLD_PUBLIC_BINDINGS=${JSON.stringify(reports)}`);
  });

  it("preserves giant unrelated fields and native/custom sorting while measuring both full original and public read costs", async () => {
    const stub = env.ENTRY_STORE.getByName(`membership-cold-giant-body-${crypto.randomUUID()}`);
    const reports = await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql; seed(sql, 48);
      const giant = "u".repeat(256 * 1024);
      sql.exec("UPDATE documents SET body=json_set(body,'$.unrelatedHuge',?) WHERE collection='treatments'", giant);
      const variants: { name: string; category: string; requested: DocumentQuery; order: string; legacy?: boolean }[] = [
        { name: "missing-native", category: "Absent", requested: query("Absent", 1), order: "sort_time DESC,srv_modified DESC,id ASC" },
        { name: "full-native", category: "Note", requested: query("Note", 1), order: "sort_time DESC,srv_modified DESC,id ASC" },
        { name: "custom-rank", category: "Note", requested: { ...query("Note", 3), sort: { field: "rank", direction: "desc" },
          fields: ["rank", "eventType"] }, order: "json_extract(body,'$.rank') DESC,id DESC" },
        { name: "full-legacy", category: "Note", requested: query("Note", 1),
          order: "json_extract(body,'$.created_at') DESC,id ASC", legacy: true },
      ];
      const samples = [];
      for (const variant of variants) {
        const originalText = `SELECT * FROM documents WHERE collection='treatments'
          ${variant.legacy ? "AND json_valid(body)" : "AND is_valid != 0"} AND ${ORIGINAL}
          ORDER BY ${variant.order} LIMIT ? OFFSET ?`;
        const original = await measure(sql, () => sql.exec<Row>(originalText, variant.category, variant.category,
          variant.requested.limit!, 0).toArray());
        const expected = materializeOriginalRows(state.storage, original.result, variant.requested, variant.legacy);
        const actual = await measure(sql, () => variant.legacy
          ? instance.queryLegacyTreatmentsWithUuidHandling(JSON.stringify(variant.requested), true)
          : instance.api3QueryCollection("treatments", JSON.stringify(variant.requested)));
        expect(JSON.parse(actual.result)).toEqual(variant.legacy ? expected : { ok: true, result: expected });
        if (variant.name.startsWith("full-")) expect(expected[0]!.unrelatedHuge).toBe(giant);
        expect(actual.writes + original.writes).toBe(0);
        const data = actual.calls.filter(call => /^\s*SELECT\s+(?:\*|documents\.\*)/.test(call.statement)
          && call.statement.includes("OFFSET ?"));
        expect(data).toHaveLength(1);
        const plan = sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${data[0]!.statement}`,
          ...data[0]!.bindings).toArray().map(row => row.detail);
        samples.push({ name: variant.name, canonicalRows: 48, unrelatedBodyCharacters: giant.length,
          returned: expected.length, originalDataReads: original.reads, publicReads: actual.reads,
          membershipSourceReads: actual.membershipSourceReads, writes: actual.writes, plan });
      }
      return samples;
    });
    console.info(`MEMBERSHIP_REAL_COLD_GIANT_BODY=${JSON.stringify(reports)}`);
  }, 60_000);
});
