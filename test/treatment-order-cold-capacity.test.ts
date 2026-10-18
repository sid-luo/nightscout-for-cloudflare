import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import type { EntryStore, JsonValue } from "../src/entry-store";
import { LegacyReadCache } from "../src/legacy-read-cache";
import { TreatmentOrderReadView } from "../src/treatment-order-read-view";

const AT = Date.UTC(2026, 9, 18, 12);
const id = (n: number) => n.toString(16).padStart(24, "0");
function seed(sql: SqlStorage, count: number): void {
  const ranks: JsonValue[] = [null, 0, -1, 1.5, true, "01", "a", "\ue000", "🚀", [1, null], { z: 1, a: 2 }];
  for (let n = 0; n < count; n++) {
    const at = AT + n * 1000;
    const body = { _id: id(n), identifier: `cold-sort-${n}`, created_at: new Date(at).toISOString(),
      eventType: n % 941 === 0 ? "Rare" : ["Note", "Other"], bucket: n % 941 === 0 ? "rare" : "common",
      rank: ranks[n % ranks.length], date: at, srvCreated: at, srvModified: at, isValid: true };
    sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,identifier_present,
      srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
      VALUES('treatments',?,?,?,?,?,?,1,?,?,?,1,1,1)`, id(n), JSON.stringify(body), at, at, at, body.identifier, at, at, at);
  }
}
async function measure<T>(sql: SqlStorage, action: () => T | Promise<T>) {
  const execute = sql.exec.bind(sql);
  const cursors: { sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = execute(statement, ...bindings);
    cursors.push({ sql: statement.replace(/\s+/g, " ").trim(), cursor });
    return cursor;
  });
  try {
    const result = await action();
    return { result, reads: cursors.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: cursors.reduce((sum, item) => sum + item.cursor.rowsWritten, 0),
      sourceProbes: cursors.filter(item => item.sql.startsWith("SELECT COUNT(*) AS count FROM (")).length,
      orderBuilds: cursors.filter(item => item.sql.startsWith("SELECT id FROM documents")).length,
      statements: cursors.map(item => ({ sql: item.sql, reads: item.cursor.rowsRead, writes: item.cursor.rowsWritten })) };
  } finally { spy.mockRestore(); }
}
const summary = <T>(value: Awaited<ReturnType<typeof measure<T>>>) => ({ reads: value.reads, writes: value.writes,
  sourceProbes: value.sourceProbes, orderBuilds: value.orderBuilds, statements: value.statements });

describe("native order first-success, capacity and lost-cache audit", () => {
  it("piggybacks complete original Rare/missing pages over more than 5000 source rows, including native warm-first routing", async () => {
    const reports = [];
    for (const category of [false, true]) for (const missing of [false, true]) for (const policy of ["before-no-observe", "observe"] as const) {
      const stub = env.ENTRY_STORE.getByName(`order-first-${category}-${missing}-${policy}-${crypto.randomUUID()}`);
      reports.push(await runInDurableObject(stub, async (instance: EntryStore, state) => {
        state.storage.transactionSync(() => seed(state.storage.sql, 6001));
        const oracle = new SqliteDocumentRepository(state.storage);
        const disabled = policy === "before-no-observe"
          ? vi.spyOn(TreatmentOrderReadView.prototype, "observeCompleteRead").mockReturnValue(false) : undefined;
        const samples = [];
        try {
          for (const [page, shape] of [{ limit: 10 }, { limit: 3, fields: ["identifier", "rank"] },
            { limit: 2, skip: 4, fields: ["identifier", "created_at"] }, { limit: 1, skip: 30, fields: ["identifier"] }].entries()) {
            const query: DocumentQuery = { ...shape, sort: { field: "rank", direction: "desc" },
              filters: [{ field: category ? "eventType" : "bucket", operator: "eq",
                value: category ? missing ? "Missing" : "Rare" : missing ? "missing" : "rare" }] };
            const expected = oracle.queryDocumentsForApi3("treatments", query);
            const actual = await measure(state.storage.sql, () => instance.api3QueryCollection("treatments", JSON.stringify(query)));
            expect(JSON.parse(actual.result)).toEqual({ ok: true, result: expected });
            expect(actual.writes).toBe(0);
            if (policy === "observe" && page > 0) {
              expect(actual.sourceProbes + actual.orderBuilds).toBe(0);
              expect(actual.reads).toBeLessThanOrEqual(expected.length * 3);
            }
            samples.push({ page, returned: expected.length, ...summary(actual) });
          }
        } finally { disabled?.mockRestore(); }
        return { category, missing, policy, samples, reads: samples.reduce((sum, sample) => sum + sample.reads, 0) };
      }));
    }
    for (const after of reports.filter(item => item.policy === "observe")) {
      const before = reports.find(item => item.policy === "before-no-observe"
        && item.category === after.category && item.missing === after.missing)!;
      expect(after.samples[0]!.reads).toBe(before.samples[0]!.reads);
      expect(after.reads).toBeLessThanOrEqual(before.reads);
    }
    console.info(`TREATMENT_ORDER_FIRST_COMPLETE=${JSON.stringify(reports)}`);
  }, 60_000);

  it("relearns complete native results after real eviction and after genuine mutation without publishing stale IDs", async () => {
    const stub = env.ENTRY_STORE.getByName(`order-observe-evict-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => state.storage.transactionSync(() => seed(state.storage.sql, 6001)));
    const samples = [];
    for (const phase of ["cold", "warm", "evicted", "after-mutation", "warm-after-mutation"] as const) {
      if (phase === "evicted") await evictDurableObject(stub);
      samples.push(await runInDurableObject(stub, async (instance: EntryStore, state) => {
        const oracle = new SqliteDocumentRepository(state.storage);
        let mutation;
        if (phase === "after-mutation") {
          const measured = await measure(state.storage.sql, () => instance.api3PatchDocument("treatments", "cold-sort-13",
            JSON.stringify({ bucket: "rare", rank: "🚀changed" }), JSON.stringify({ canCreate: true, canUpdate: true,
              actor: null, ifUnmodifiedSince: null, emitRealtime: false })));
          expect(JSON.parse(measured.result)).toMatchObject({ ok: true });
          mutation = summary(measured);
        }
        const query: DocumentQuery = { limit: phase.startsWith("warm") ? 3 : 10,
          ...(phase.startsWith("warm") ? { fields: ["identifier", "rank"] } : {}),
          filters: [{ field: "bucket", operator: "eq", value: "rare" }], sort: { field: "rank", direction: "desc" } };
        const expected = oracle.queryDocumentsForApi3("treatments", query);
        const actual = await measure(state.storage.sql, () => instance.api3QueryCollection("treatments", JSON.stringify(query)));
        expect(JSON.parse(actual.result)).toEqual({ ok: true, result: expected });
        expect(actual.writes + actual.sourceProbes + actual.orderBuilds).toBe(0);
        if (phase.startsWith("warm")) expect(actual.reads).toBeLessThanOrEqual(expected.length * 3);
        if (phase === "after-mutation") expect(expected.some(document => document.identifier === "cold-sort-13")).toBe(true);
        return { phase, returned: expected.length, ...summary(actual), mutation,
          scope: "Complete API3 RPC business SQL; DO activation occurs before the storage spy is installed." };
      }));
    }
    console.info(`TREATMENT_ORDER_OBSERVE_EVICTION=${JSON.stringify(samples)}`);
  }, 60_000);

  it("rejects partial/offset/unsafe/generation-changed observations, and cached-only reads do not build pending views", async () => {
    const stub = env.ENTRY_STORE.getByName(`order-observe-guards-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const cache = new LegacyReadCache(), view = new TreatmentOrderReadView(state.storage.sql, cache);
      const statement = "SELECT * FROM documents WHERE collection=? ORDER BY json_extract(body,?) DESC,id DESC LIMIT ? OFFSET ?";
      const bindings: SqlStorageValue[] = ["treatments", "$.rank", 5, 0], key = view.key(statement, bindings);
      for (const input of [
        { rows: [{ id: id(1) }], limit: 1, skip: 0 },
        { rows: [{ id: id(1) }], limit: 5, skip: 1 },
        { rows: [{ id: id(1) }], limit: 0, skip: 0 },
        { rows: [{ id: "bad/unicode/🧪" }], limit: 5, skip: 0 },
        { rows: [{ id: id(1) }, { id: id(1) }], limit: 5, skip: 0 },
      ]) {
        expect(view.observeCompleteRead(key, input.rows, input.limit, input.skip, cache.generation)).toBe(false);
        expect(cache.get(key)).toBeUndefined();
      }
      const before = cache.generation;
      cache.clear();
      expect(view.observeCompleteRead(key, [{ id: id(1) }], 5, 0, before)).toBe(false);
      const reentrant = { get id() { cache.clear(); return id(1); } };
      expect(view.observeCompleteRead(key, [reentrant], 5, 0, cache.generation)).toBe(false);
      expect(cache.get(key)).toBeUndefined();
      expect(view.observeCompleteRead(key, [], 5, 0, cache.generation)).toBe(true);
      cache.clear();
      expect(cache.get(key)).toBeUndefined();
      view.noteExpensiveRead(key, 513);
      const pending = await measure(state.storage.sql, () => view.read(key, statement, bindings, 5, 0, undefined, false));
      expect(pending.result).toBeUndefined();
      expect(pending.statements).toEqual([]);
      for (const refusal of ["rejected", "reject"]) {
        cache.set(key, refusal);
        const compatible = await measure(state.storage.sql, () => view.read(key, statement, bindings, 5, 0));
        expect(compatible.result).toBeUndefined();
        expect(compatible.statements).toEqual([]);
      }
      // Refusal metadata must fit even at the exact pending-marker budget.
      const bytes = 2 * (key.length + "pending".length);
      const tiny = new LegacyReadCache(8, bytes, bytes), refused = new TreatmentOrderReadView(state.storage.sql, tiny);
      refused.noteExpensiveRead(key, 513);
      expect(refused.observeCompleteRead(key, [{ id: id(1) }, { id: id(2) }], 5, 0, tiny.generation)).toBe(false);
      const noRetry = await measure(state.storage.sql, () => refused.read(key, statement, bindings, 5, 0));
      expect(noRetry.result).toBeUndefined();
      expect(noRetry.statements).toEqual([]);
    });
  });

  it("measures the complete request when an order vector exceeds the entry budget, then when that refusal is lost", async () => {
    const stub = env.ENTRY_STORE.getByName(`order-capacity-refusal-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (_instance, state) => {
      state.storage.transactionSync(() => seed(state.storage.sql, 5000));
      const cache = new LegacyReadCache(128, 4 * 1024 * 1024, 4096);
      const repository = new SqliteDocumentRepository(state.storage, undefined, undefined, cache);
      const oracle = new SqliteDocumentRepository(state.storage);
      const samples = [];
      for (const [page, shape] of [{ limit: 5 }, { limit: 7, skip: 17 }, { limit: 9, skip: 400 },
        { limit: 5, skip: 13 }, { limit: 7, skip: 21 }].entries()) {
        if (page === 3) cache.clear(); // Explicit loss of all metadata, not a simulated retained rejection.
        const query: DocumentQuery = { ...shape, sort: { field: "rank", direction: "desc" } };
        const expected = oracle.queryDocumentsForApi3("treatments", query);
        const actual = await measure(state.storage.sql, () => repository.queryDocumentsForApi3("treatments", query));
        expect(actual.result).toEqual(expected);
        expect(actual.writes).toBe(0);
        samples.push({ page, ...summary(actual) });
      }
      expect(samples[1]!.orderBuilds).toBe(1);
      expect(samples[1]!.reads).toBeLessThan(samples[0]!.reads * 2);
      expect(samples[2]!.orderBuilds + samples[2]!.sourceProbes).toBe(0);
      expect(samples[4]!.orderBuilds).toBe(1);
      expect(samples[4]!.reads).toBeLessThan(samples[3]!.reads * 2);
      return { entryBudgetBytes: 4096, samples, totalReads: samples.reduce((sum, sample) => sum + sample.reads, 0),
        scope: "Complete repository query SQL including source proof/build/point/fallback; fixture/oracle excluded." };
    });
    console.info(`TREATMENT_ORDER_CAPACITY_REFUSAL=${JSON.stringify(report)}`);
  }, 60_000);
});
