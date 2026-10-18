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
function measured<T>(sql: SqlStorage, action: () => T) {
  const execute = sql.exec.bind(sql);
  const rows: { statement: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...values) => {
    const cursor = execute(statement, ...values); rows.push({ statement, cursor }); return cursor;
  });
  try {
    const result = action();
    const sources = rows.filter(row => row.statement.includes(" AS valid_json") && row.statement.includes("FROM documents"));
    return { result, reads: rows.reduce((sum, row) => sum + row.cursor.rowsRead, 0),
      writes: rows.reduce((sum, row) => sum + row.cursor.rowsWritten, 0), sourceCalls: sources.length,
      sourceReads: sources.reduce((sum, row) => sum + row.cursor.rowsRead, 0) };
  } finally { spy.mockRestore(); }
}
function phase(cache: LegacyReadCache): unknown {
  const value = cache.get(KEY);
  return value === undefined || value === "pending" || value === "rejected" ? value : JSON.parse(value)[1];
}
function seed(sql: SqlStorage, oldRows: number, longRows: number) {
  sql.exec(`WITH RECURSIVE seq(n) AS(VALUES(0) UNION ALL SELECT n+1 FROM seq WHERE n<?)
    INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
    SELECT 'treatments',printf('%024x',n),json_object('_id',printf('%024x',n),'eventType','Note',
      'created_at','2026-09-01T00:00:00.000Z','rank',n%3),?,?,?,1 FROM seq`, Math.max(0, oldRows - 1), AT, AT, AT);
  if (oldRows === 0) sql.exec("DELETE FROM documents WHERE collection='treatments'");
  for (let n = 0; n < longRows; n++) {
    const key = id(oldRows + n), at = AT + n * 1000;
    const members = n === 5 || n === longRows - 1 ? [...Array<null>(1024).fill(null), "Rare"]
      : Array<string>(1025).fill("Note");
    const body = JSON.stringify({ _id: key, eventType: members, created_at: new Date(at).toISOString(), rank: n % 3 });
    sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
      VALUES('treatments',?,?,?,?,?,1)`, key, body, at, at, at);
  }
  if (oldRows > 20_000) for (const name of ["documents_treatments_created_at",
    "documents_treatments_event_type_created_at", "documents_treatments_api3_order"]) sql.exec(`DROP INDEX IF EXISTS ${name}`);
}
function request(category: string): DocumentQuery {
  return { limit: 100, filters: [{ field: "eventType", operator: "eq", value: category },
    { field: "created_at", operator: "gte", value: "2026-10-17T00:00:00.000Z" }] };
}
function statement(category: string, cache?: LegacyReadCache, custom = false) {
  const serialized = cache?.get(KEY), value: unknown = serialized === undefined || serialized === "pending"
    || serialized === "rejected" ? undefined : JSON.parse(serialized);
  let barrier = "", values: SqlStorageValue[] = [];
  if (Array.isArray(value) && value[0] === 2 && value[1] === "partial" && typeof value[2] === "string") {
    const pair = (value[3] as [string, string[] | null][]).find(([name]) => name === category);
    const known = pair?.[1] ?? [];
    if (pair?.[1] !== null) {
      barrier = known.length === 0 ? " AND id > ?" : " AND (id > ? OR id IN (SELECT value FROM json_each(?)))";
      values = known.length === 0 ? [value[2]] : [value[2], JSON.stringify(known)];
    }
  }
  const order = custom ? "json_extract(body,'$.rank') ASC,id DESC" : "json_extract(body,'$.created_at') DESC,id ASC";
  return { sql: `SELECT * FROM documents WHERE collection='treatments' AND collection IN ('treatments','devicestatus')
    AND json_valid(body)${barrier} AND json_extract(body,'$.created_at')>=? AND ${CATEGORY}
    ORDER BY ${order} LIMIT 100 OFFSET 0`, values: [...values, "2026-10-17T00:00:00.000Z", category, category] };
}
function raw(sql: SqlStorage, category: string, cache?: LegacyReadCache, custom = false) {
  const query = statement(category, cache, custom);
  return sql.exec<Row>(query.sql, ...query.values).toArray();
}

describe("partial membership prefix native residual experiment", () => {
  for (const fixture of [{ name: "long-prefix", oldRows: 0, longRows: 77, attempts: 3, oldMeasuredTotal: 237088 },
    { name: "old-scalar-prefix", oldRows: 20_001, longRows: 35, attempts: 7, oldMeasuredTotal: 235513 }]) {
    it(`counts every cold/build/fallback for ${fixture.name} against the preserved pre-change control`, async () => {
      const report = await runInDurableObject(env.ENTRY_STORE.getByName(`partial-prefix-${fixture.name}-${crypto.randomUUID()}`), (_instance, state) => {
        const sql = state.storage.sql; seed(sql, fixture.oldRows, fixture.longRows);
        const runtimeCache = new LegacyReadCache(), prototypeCache = new LegacyReadCache();
        const runtime = new SqliteDocumentRepository(state.storage, undefined, undefined, runtimeCache);
        const prototype = new SqliteDocumentRepository(state.storage, undefined, undefined, prototypeCache);
        const firstCurrent = measured(sql, () => runtime.queryLegacyTreatments(request("MissingA")));
        const firstPrototype = measured(sql, () => prototype.queryLegacyTreatments(request("MissingA")));
        expect(firstCurrent.result).toEqual([]); expect(firstPrototype.result).toEqual(firstCurrent.result);
        expect(firstCurrent.reads).toBeGreaterThan(512); expect(phase(runtimeCache)).toBe("pending");
        const samples = [];
        for (let attempt = 0; attempt < fixture.attempts && phase(prototypeCache) !== "complete"; attempt++) {
          const category = `MissingB-${attempt}`;
          const current = measured(sql, () => runtime.queryLegacyTreatments(request(category)));
          const learned = measured(sql, () => new TreatmentMembershipReadView(sql, prototypeCache).candidates(category));
          const narrowed = measured(sql, () => learned.result === undefined ? raw(sql, category, prototypeCache) : []);
          const narrowedQuery = statement(category, prototypeCache);
          const narrowedPlan = sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${narrowedQuery.sql}`, ...narrowedQuery.values)
            .toArray().map(row => row.detail);
          expect(narrowed.result).toEqual(raw(sql, category)); expect(current.result).toEqual([]);
          expect(phase(prototypeCache)).toBe(phase(runtimeCache));
          // Different native orders and a prefix match both retain the full
          // original residual, rather than sorting or filtering in JavaScript.
          for (const custom of [false, true]) expect(raw(sql, "Rare", prototypeCache, custom)).toEqual(raw(sql, "Rare", undefined, custom));
          expect(current.writes + learned.writes + narrowed.writes).toBe(0);
          samples.push({ phase: phase(prototypeCache), currentReads: current.reads, currentWrites: current.writes,
            sourceReads: learned.sourceReads, narrowedReads: narrowed.reads,
            prototypeTotalReads: learned.reads + narrowed.reads, narrowedPlan });
        }
        expect(phase(prototypeCache)).toBe("complete");
        const probe = statement("Rare", runtimeCache);
        const plan = sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${probe.sql}`, ...probe.values).toArray().map(row => row.detail);
        const currentTotalReads = firstCurrent.reads + samples.reduce((sum, row) => sum + row.currentReads, 0);
        const currentWrites = firstCurrent.writes + samples.reduce((sum, row) => sum + row.currentWrites, 0);
        expect(currentTotalReads).toBeLessThan(fixture.oldMeasuredTotal); expect(currentWrites).toBe(0);
        return { fixture, firstCurrentReads: firstCurrent.reads, firstPrototypeReads: firstPrototype.reads,
          samples, currentTotalReads, oldMeasuredTotal: fixture.oldMeasuredTotal, currentWrites,
          prototypeTotalReads: firstPrototype.reads + samples.reduce((sum, row) => sum + row.prototypeTotalReads, 0),
          optionalWrites: 0, originalPlan: plan };
      });
      console.info(`PARTIAL_MEMBERSHIP_PREFIX_RUNTIME=${JSON.stringify(report)}`);
    }, 60_000);
  }
});
