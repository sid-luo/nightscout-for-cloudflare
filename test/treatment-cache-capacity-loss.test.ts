import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import { LegacyReadCache } from "../src/legacy-read-cache";
import { TreatmentMembershipReadView, TREATMENT_MEMBERSHIP_VIEW_KEY as KEY } from "../src/treatment-membership-read-view";
import { TREATMENT_ORDER_SOURCE_KEY } from "../src/treatment-order-read-view";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const id = (n: number) => n.toString(16).padStart(24, "0");
const OPTIONS = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false };
interface Internal { legacyTreatmentQueries: LegacyReadCache; documentRepository(): SqliteDocumentRepository }
function seed(sql: SqlStorage, count = 6001): void {
  sql.exec(`WITH RECURSIVE s(n) AS(VALUES(0) UNION ALL SELECT n+1 FROM s WHERE n<?)
    INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
    SELECT 'treatments',printf('%024x',n),json_object('_id',printf('%024x',n),
      'created_at','2026-10-18T12:00:00.000Z','date',?+n,'rank',n%7,
      'eventType',json('["Note","Other",7,["Absent"],null]')),?+n,?,?,1 FROM s`,
  count - 1, AT, AT, AT, AT);
}
async function measure<T>(sql: SqlStorage, action: () => T | Promise<T>) {
  const execute = sql.exec.bind(sql);
  const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = execute(statement, ...bindings); cursors.push(cursor); return cursor;
  });
  try {
    const result = await action();
    return { result, reads: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      writes: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0) };
  } finally { spy.mockRestore(); }
}
function finish(sql: SqlStorage, cache: LegacyReadCache): void {
  const view = new TreatmentMembershipReadView(sql, cache);
  for (let attempt = 0; attempt < 8; attempt++) {
    const ids = view.candidates("Absent");
    if (ids !== undefined) { expect(ids).toEqual([]); return; }
    view.noteExpensiveRead(513);
  }
  throw new Error("bounded membership did not finish");
}
function churn(cache: LegacyReadCache, cycle: number): void {
  for (let n = 0; n < 140; n++) expect(cache.set(`api3:key-churn:${cycle}:${n}`, "[]")).toBe(true);
  const large = JSON.stringify({ completeResponse: "x".repeat(450_000) });
  for (let n = 0; n < 6; n++) expect(cache.set(`legacy:byte-churn:${cycle}:${n}`, large)).toBe(true);
  const ledger = cache as unknown as { entries: Map<string, string>; bytes: number };
  expect(ledger.entries.size).toBeLessThanOrEqual(128);
  expect(ledger.bytes).toBe([...ledger.entries].reduce((sum, [key, value]) => sum + 2 * (key.length + value.length), 0));
  expect(ledger.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect([...ledger.entries].every(([key, value]) => 2 * (key.length + value.length) <= 1024 * 1024)).toBe(true);
}
const query = (category: string, limit: number): DocumentQuery => ({ limit,
  filters: [{ field: "eventType", operator: "eq", value: category }] });

describe("treatment shared capacity and actual cache loss", () => {
  it("keeps public membership usable under key/byte churn with identical canonical writes", async () => {
    const reports = [];
    for (const protectedHistory of [false, true]) {
      const stub = env.ENTRY_STORE.getByName(`member-capacity-${protectedHistory}-${crypto.randomUUID()}`);
      reports.push(await runInDurableObject(stub, async (instance, state) => {
        const internal = instance as unknown as Internal, sql = state.storage.sql;
        // Replay the preceding admission policy against the same current
        // repository/public APIs; the true branch uses production's cache.
        if (!protectedHistory) internal.legacyTreatmentQueries = new LegacyReadCache();
        const cache = internal.legacyTreatmentQueries;
        seed(sql); const prewarm = await measure(sql, () => finish(sql, cache));
        expect(prewarm.writes).toBe(0);
        const created = await measure(sql, () => instance.api3CreateDocument("treatments", JSON.stringify({
          _id: id(90_000), identifier: "capacity-live", eventType: ["Live", "Note"],
          date: AT + 9000, utcOffset: 0, app: "capacity-audit", created_at: new Date(AT).toISOString(),
          notes: "before", extra: { preserved: [true, null] },
        }), JSON.stringify(OPTIONS)));
        expect(JSON.parse(created.result).ok).toBe(true);
        cache.set(TREATMENT_ORDER_SOURCE_KEY, "6002");
        const oracle = new SqliteDocumentRepository(state.storage);
        const samples = [];
        for (let cycle = 0; cycle < 3; cycle++) {
          const generation = cache.generation; churn(cache, cycle);
          expect(cache.generation).toBe(generation);
          expect(TreatmentMembershipReadView.isUnsafe(cache)).toBe(!protectedHistory);
          expect(cache.get(KEY) !== undefined).toBe(protectedHistory);
          expect(cache.get(TREATMENT_ORDER_SOURCE_KEY) !== undefined).toBe(protectedHistory);
          const absent = query("Absent", cycle + 1), live = query("Live", cycle + 1);
          const missing = await measure(sql, () => instance.api3QueryCollection("treatments", JSON.stringify(absent)));
          expect(JSON.parse(missing.result)).toEqual({ ok: true, result: oracle.queryTreatments(absent) });
          const patch = await measure(sql, () => instance.api3PatchDocument("treatments", "capacity-live",
            JSON.stringify({ notes: `after-${cycle}` }), JSON.stringify(OPTIONS)));
          expect(JSON.parse(patch.result).ok).toBe(true);
          const selected = await measure(sql, () => instance.api3QueryCollection("treatments", JSON.stringify(live)));
          expect(JSON.parse(selected.result)).toEqual({ ok: true, result: oracle.queryTreatments(live) });
          expect(oracle.queryTreatments(live)[0]!.notes).toBe(`after-${cycle}`);
          expect(missing.writes + selected.writes).toBe(0);
          if (protectedHistory) expect(missing.reads).toBe(0);
          samples.push({ missingReads: missing.reads, selectedReads: selected.reads,
            patchReads: patch.reads, businessWrites: patch.writes });
        }
        return { protectedHistory, prewarmReads: prewarm.reads, createReads: created.reads,
          createWrites: created.writes, samples,
          queryReads: samples.reduce((sum, sample) => sum + sample.missingReads + sample.selectedReads, 0),
          businessWrites: created.writes + samples.reduce((sum, sample) => sum + sample.businessWrites, 0) };
      }));
    }
    expect(reports[1]!.businessWrites).toBe(reports[0]!.businessWrites);
    expect(reports[1]!.prewarmReads).toBe(reports[0]!.prewarmReads);
    expect(reports[1]!.queryReads).toBeLessThan(reports[0]!.queryReads / 100);
    console.info(`TREATMENT_CAPACITY_PUBLIC=${JSON.stringify(reports)}`);
  }, 60_000);

  it("keeps monotone old/new history under churn inside an outer rollback, but explicit loss remains unsafe", async () => {
    const stub = env.ENTRY_STORE.getByName(`member-capacity-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (instance, state) => {
      const internal = instance as unknown as Internal, sql = state.storage.sql;
      seed(sql, 2); const cache = internal.legacyTreatmentQueries; finish(sql, cache);
      const repository = internal.documentRepository();
      expect(() => state.storage.transactionSync(() => {
        repository.upsertTreatment({ _id: id(0), created_at: new Date(AT).toISOString(), eventType: "Added" });
        churn(cache, 0);
        expect(TreatmentMembershipReadView.isUnsafe(cache)).toBe(false);
        expect(new TreatmentMembershipReadView(sql, cache).candidates("Added")).toEqual([id(0)]);
        throw new Error("outer rollback after protected capacity churn");
      })).toThrow("outer rollback after protected capacity churn");
      for (const category of ["Note", "Added", "Absent"]) {
        expect(repository.queryTreatments(query(category, 10)))
          .toEqual(new SqliteDocumentRepository(state.storage).queryTreatments(query(category, 10)));
      }
      expect(TreatmentMembershipReadView.isUnsafe(cache)).toBe(false);
      cache.clear();
      expect(TreatmentMembershipReadView.isUnsafe(cache)).toBe(true);
      finish(sql, new LegacyReadCache()); // A genuinely fresh safety lifetime can rebuild.
    });
  });

  it("relearns safely after actual DO eviction without claiming memory survives or adding durable writes", async () => {
    const stub = env.ENTRY_STORE.getByName(`member-real-loss-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (instance, state) => {
      seed(state.storage.sql);
      finish(state.storage.sql, (instance as unknown as Internal).legacyTreatmentQueries);
    });
    await evictDurableObject(stub);
    const report = await runInDurableObject(stub, async (instance, state) => {
      const cache = (instance as unknown as Internal).legacyTreatmentQueries, sql = state.storage.sql;
      expect(cache.get(KEY)).toBeUndefined();
      expect(TreatmentMembershipReadView.isUnsafe(cache)).toBe(false);
      const first = await measure(sql, () => instance.api3QueryCollection("treatments", JSON.stringify(query("Absent", 1))));
      expect(JSON.parse(first.result)).toEqual({ ok: true, result: [] });
      expect(first.reads).toBeGreaterThan(512); expect(first.writes).toBe(0);
      const relearn = await measure(sql, () => finish(sql, cache));
      const warm = await measure(sql, () => instance.api3QueryCollection("treatments", JSON.stringify(query("Absent", 2))));
      expect(JSON.parse(warm.result)).toEqual({ ok: true, result: [] });
      expect(warm.reads).toBe(0); expect(warm.writes + relearn.writes).toBe(0);
      return { afterRealEvictionFirstReads: first.reads, relearnReads: relearn.reads,
        warmReads: warm.reads, optionalWrites: first.writes + relearn.writes + warm.writes };
    });
    console.info(`TREATMENT_REAL_CACHE_LOSS=${JSON.stringify(report)}`);
  }, 60_000);
});
