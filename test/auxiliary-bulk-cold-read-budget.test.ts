import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import { TREATMENT_EVENT_TYPE_INDEX_VALUE_SQL } from "../src/document-repository";
import { LegacyReadCache } from "../src/legacy-read-cache";
import { TreatmentMembershipReadView, TREATMENT_MEMBERSHIP_VIEW_KEY } from "../src/treatment-membership-read-view";

const START = Date.parse("2026-10-18T12:00:00.000Z"), DAY = 86_400_000;
const id = (n: number) => n.toString(16).padStart(24, "0");
const CATEGORIES = ["Profile Switch", "Sensor Start", "Sensor Change", "Sensor Stop", "Site Change", "Insulin Change", "Pump Battery Change"];
const OPTIONS = JSON.stringify({ canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false });
interface Row extends Record<string, SqlStorageValue> { id: string; body: string; sort_time: number }
interface Internal {
  treatmentCategoryIndexAvailable: boolean | undefined;
  auxiliaryTreatmentCold: boolean;
  auxiliaryTreatmentBulk: { allowLearning: boolean; learningStarted: boolean } | undefined;
  boundedTreatmentQueries: { clear(): void };
  invalidateAuxiliaryQueries(collection: string, preserveTreatmentViews: boolean): void;
  legacyTreatmentQueries: LegacyReadCache;
  cachedAuxiliaryRows(statement: string, bindings: SqlStorageValue[]): Iterable<Row>;
  sharedTreatmentEventRows(statement: string, bindings: SqlStorageValue[], category: string): IterableIterator<Row>;
  pluginPropertyContext(at: number): unknown;
  realtimeSnapshot(at: number, frame: boolean, mode: "ddata"): unknown;
  withAuxiliaryTreatmentBulk<T>(read: () => T): T;
}
function query(category: string): string {
  return `SELECT id, body, sort_time FROM documents WHERE collection = 'treatments'
    AND json_valid(body) AND json_type(body, '$.eventType') = 'text'
    AND ${TREATMENT_EVENT_TYPE_INDEX_VALUE_SQL} = ?
    ${category === "Profile Switch" ? "AND json_type(body, '$.duration') IN ('integer','real') AND CAST(json_extract(body,'$.duration') AS REAL)=0" : ""}
    AND sort_time >= ? AND sort_time <= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1`;
}
async function measured<T>(sql: SqlStorage, action: () => T | Promise<T>) {
  const exec = sql.exec.bind(sql), traces: { sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...values) => {
    const cursor = exec(statement, ...values); traces.push({ sql: statement, cursor }); return cursor;
  });
  try {
    const value = await action();
    const member = traces.filter(row => row.sql.includes(" AS valid_json") && row.sql.includes("FROM documents"));
    return { value, reads: traces.reduce((sum, row) => sum+row.cursor.rowsRead, 0),
      writes: traces.reduce((sum, row) => sum+row.cursor.rowsWritten, 0),
      memberReads: member.reduce((sum, row) => sum+row.cursor.rowsRead, 0), memberCalls: member.length,
      categoryReads: traces.filter(row => row.sql.includes("json_type(body, '$.eventType') = 'text'"))
        .map(row => row.cursor.rowsRead) };
  } finally { spy.mockRestore(); }
}
/** Previous production helper only, keeping the same SQL/caches and genuine mutations. */
function previousPolicy(internal: Internal, sql: SqlStorage): void {
  internal.sharedTreatmentEventRows = function* (statement, bindings, category) {
    const member = new TreatmentMembershipReadView(sql, internal.legacyTreatmentQueries), ids = member.candidates(category);
    if (ids !== undefined) {
      if (ids.length === 0) return;
      const selected = statement.replace(/FROM documents(?: INDEXED BY documents_collection_sort)?\s+WHERE/,
        `FROM (SELECT * FROM documents WHERE collection='treatments'
          AND id IN (SELECT value FROM json_each(?)) LIMIT -1) WHERE`);
      yield* sql.exec<Row>(selected, JSON.stringify(ids), ...bindings); return;
    }
    const cursor = sql.exec<Row>(statement, ...bindings);
    yield* cursor; member.noteExpensiveRead(cursor.rowsRead);
  };
}
function fixture(sql: SqlStorage, internal: Internal, oldDays: number, fast = false, long = true): void {
  for (const name of ["documents_treatments_created_at", "documents_treatments_event_type_created_at", "documents_treatments_api3_order"])
    sql.exec(`DROP INDEX IF EXISTS ${name}`);
  sql.exec(`WITH RECURSIVE n(v) AS(VALUES(0) UNION ALL SELECT v+1 FROM n WHERE v<20000)
    INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
    SELECT 'treatments',printf('%024x',v),json_object('_id',printf('%024x',v),'created_at',?,'eventType','Note'),?,?,?,1 FROM n`,
  new Date(START-oldDays*DAY).toISOString(), START-oldDays*DAY, START-DAY, START-DAY);
  if (long) for (let n = 0; n < 35; n++) sql.exec(`INSERT INTO documents
    (collection,id,body,sort_time,created_at,updated_at,is_valid) VALUES('treatments',?,?,?,?,?,1)`,
  id(20001+n), JSON.stringify({ _id: id(20001+n), created_at: new Date(START-n*60_000).toISOString(),
    eventType: Array<string>(1025).fill("Note"), notes: "x".repeat(4096) }), START-n*60_000, START-DAY, START-DAY);
  if (fast) for (let n = 0; n < CATEGORIES.length; n++) sql.exec(`INSERT INTO documents
    (collection,id,body,sort_time,created_at,updated_at,is_valid) VALUES('treatments',?,?,?,?,?,1)`,
  id(50000+n), JSON.stringify({ _id: id(50000+n), eventType: CATEGORIES[n], duration: 0,
    created_at: new Date(START+1000-n).toISOString(), notes: "full selected body" }), START+1000-n, START-DAY, START-DAY);
  if (fast) for (let n = 0; n < CATEGORIES.length; n++) sql.exec(`INSERT INTO documents
    (collection,id,body,sort_time,created_at,updated_at,is_valid) VALUES('treatments',?,?,?,?,?,1)`,
  id(50100+n), JSON.stringify({ _id: id(50100+n), eventType: CATEGORIES[n], duration: 0,
    created_at: new Date(START+500-n).toISOString(), notes: "earlier same-category sort group" }), START+500-n, START-DAY, START-DAY);
  internal.treatmentCategoryIndexAvailable = undefined; internal.boundedTreatmentQueries.clear(); internal.legacyTreatmentQueries.clear();
}
function phase(internal: Internal): string | undefined {
  const value = internal.legacyTreatmentQueries.get(TREATMENT_MEMBERSHIP_VIEW_KEY);
  return value === undefined || value === "pending" || value === "rejected" ? value : String((JSON.parse(value) as unknown[])[1]);
}
function read(internal: Internal, operation: string, at: number): unknown {
  if (operation === "properties") return internal.pluginPropertyContext(at);
  if (operation === "ddata") return internal.realtimeSnapshot(at, true, "ddata");
  return [...internal.cachedAuxiliaryRows(query("Pump Battery Change"), ["Pump Battery Change", at-62*DAY, at])];
}
function original(internal: Internal, sql: SqlStorage, operation: string, at: number): unknown {
  const saved = internal.cachedAuxiliaryRows;
  internal.cachedAuxiliaryRows = (statement, bindings) => sql.exec<Row>(statement, ...bindings);
  try { return read(internal, operation, at); } finally { internal.cachedAuxiliaryRows = saved; }
}

describe("bounded auxiliary learning inside synchronous bulk readers", () => {
  for (const shape of ["properties", "ddata", "old-outside-age", "all-fast", "isolated"] as const)
    it(`measures ${shape} first cold and continuing uploads against the previous policy`, async () => {
      const reports = [];
      for (const mode of ["previous", "current"] as const) {
        const stub = env.ENTRY_STORE.getByName(`aux-bulk-${shape}-${mode}-${crypto.randomUUID()}`);
        reports.push(await runInDurableObject(stub, async (instance: EntryStore, state) => {
          const internal = instance as unknown as Internal, sql = state.storage.sql;
          fixture(sql, internal, shape === "old-outside-age" || shape === "all-fast" ? 90 : 30, shape === "all-fast", shape !== "isolated");
          const saved = internal.sharedTreatmentEventRows;
          if (mode === "previous") previousPolicy(internal, sql);
          const samples = [], operation = shape === "ddata" || shape === "isolated" ? shape : "properties";
          try {
            for (let step = 0; step < (shape === "isolated" ? 7 : 4); step++) {
              const at = START+2000+step*60_000;
              const mutation = await measured(sql, () => instance.api3CreateDocument("treatments", JSON.stringify({
                _id: id(60000+step), identifier: `aux-bulk-${step}`, date: at, created_at: new Date(at).toISOString(),
                eventType: "Note", app: "synthetic", utcOffset: 0,
              }), OPTIONS));
              expect(JSON.parse(mutation.value)).toMatchObject({ ok: true });
              if (shape === "all-fast") for (let n = 0; n < CATEGORIES.length; n++) {
                const category = CATEGORIES[n]!;
                const cursor = sql.exec<Row>(query(category).replace("FROM documents", "FROM documents INDEXED BY documents_collection_sort"),
                  category, at-(category === "Profile Switch" ? 372 : 62)*DAY, at);
                expect(cursor.toArray()[0]?.id).toBe(id(50000+n));
                expect(cursor.rowsRead).toBeLessThanOrEqual(512);
              }
              const oracle = original(internal, sql, operation, at);
              const sample = await measured(sql, () => read(internal, operation, at));
              expect(sample.value).toEqual(oracle); expect(sample.writes).toBe(0);
              expect(internal.auxiliaryTreatmentBulk === undefined).toBe(true);
              expect(sample.memberCalls).toBeLessThanOrEqual(7);
              samples.push({ step, reads: sample.reads, writes: sample.writes, phase: phase(internal),
                memberReads: sample.memberReads, memberCalls: sample.memberCalls, categoryReads: sample.categoryReads,
                mutationReads: mutation.reads, mutationWrites: mutation.writes });
            }
          } finally { internal.sharedTreatmentEventRows = saved; }
          return { mode, samples, reads: samples.reduce((sum, row) => sum+row.reads, 0) };
        }));
      }
      console.info(`AUXILIARY_BULK_COLD=${JSON.stringify({ shape, reports })}`);
      const previous = reports[0]!, current = reports[1]!;
      if (shape === "all-fast") {
        for (const report of reports) for (const sample of report.samples) {
          expect(sample.memberCalls).toBe(0);
          for (const reads of sample.categoryReads) expect(reads).toBeLessThanOrEqual(512);
        }
        expect(current.reads).toBe(previous.reads);
      } else if (shape === "isolated") {
        // Isolated readers retain exactly the previous learning lifecycle,
        // including its short-term extra source batches and eventual warmup.
        expect(current.samples).toEqual(previous.samples);
        expect(current.reads).toBe(previous.reads);
        expect(current.samples[5]!.phase).toBe("complete");
        expect(current.samples[6]!.phase).toBe("complete");
        expect(current.samples[6]!.memberCalls).toBe(0);
        expect(current.samples[6]!.reads).toBeLessThan(10);
      } else {
        expect(current.samples[0]!.phase).toBe("complete");
        expect(current.samples[0]!.reads).toBeLessThan(previous.samples[0]!.reads);
        expect(current.reads).toBeLessThan(previous.reads);
        for (const sample of current.samples.slice(1)) { expect(sample.memberCalls).toBe(0); expect(sample.reads).toBeLessThan(1000); }
      }
    });

  it("finishes an existing near-EOF partial before considering any broad fallback", async () => {
    const reports = [];
    for (const mode of ["previous", "current"] as const) {
      const stub = env.ENTRY_STORE.getByName(`aux-bulk-near-eof-${mode}-${crypto.randomUUID()}`);
      reports.push(await runInDurableObject(stub, async (instance: EntryStore, state) => {
        const internal = instance as unknown as Internal, sql = state.storage.sql;
        for (const name of ["documents_treatments_created_at", "documents_treatments_event_type_created_at", "documents_treatments_api3_order"])
          sql.exec(`DROP INDEX IF EXISTS ${name}`);
        for (let n = 0; n < 77; n++) sql.exec(`INSERT INTO documents
          (collection,id,body,sort_time,created_at,updated_at,is_valid) VALUES('treatments',?,?,?,?,?,1)`,
          id(n), JSON.stringify({ _id: id(n), created_at: new Date(START-30*DAY).toISOString(),
            eventType: Array<string>(1025).fill("Note") }), START-30*DAY, START-DAY, START-DAY);
        internal.treatmentCategoryIndexAvailable = undefined;
        internal.legacyTreatmentQueries.clear(); internal.boundedTreatmentQueries.clear();
        const member = new TreatmentMembershipReadView(sql, internal.legacyTreatmentQueries);
        expect(member.candidates("MissingWarmup")).toBeUndefined(); member.noteExpensiveRead(1000);
        expect(member.candidates("MissingWarmup")).toBeUndefined();
        expect(member.candidates("MissingWarmup")).toBeUndefined();
        expect(phase(internal)).toBe("partial");
        const saved = internal.sharedTreatmentEventRows;
        if (mode === "previous") previousPolicy(internal, sql);
        try {
          const expected = original(internal, sql, "properties", START);
          const sample = await measured(sql, () => internal.pluginPropertyContext(START));
          expect(sample.value).toEqual(expected); expect(sample.writes).toBe(0);
          expect(sample.memberCalls).toBe(1); expect(sample.memberReads).toBeLessThan(30);
          expect(sample.reads).toBeLessThan(100);
          expect(phase(internal)).toBe("complete");
          return { mode, reads: sample.reads, writes: sample.writes, memberReads: sample.memberReads, memberCalls: sample.memberCalls };
        } finally { internal.sharedTreatmentEventRows = saved; }
      }));
    }
    expect(reports[1]!.reads).toBe(reports[0]!.reads);
    console.info(`AUXILIARY_BULK_NEAR_EOF=${JSON.stringify({ reports })}`);
  });

  it("declines forward learning after actual isolated reads filled later category windows", async () => {
    const reports = [];
    for (const mode of ["previous", "current"] as const) {
      const stub = env.ENTRY_STORE.getByName(`aux-bulk-partial-cached-${mode}-${crypto.randomUUID()}`);
      reports.push(await runInDurableObject(stub, async (instance: EntryStore, state) => {
        const internal = instance as unknown as Internal, sql = state.storage.sql;
        for (const name of ["documents_treatments_created_at", "documents_treatments_event_type_created_at", "documents_treatments_api3_order"])
          sql.exec(`DROP INDEX IF EXISTS ${name}`);
        for (let n = 0; n < 257; n++) sql.exec(`INSERT INTO documents
          (collection,id,body,sort_time,created_at,updated_at,is_valid) VALUES('treatments',?,?,?,?,?,1)`,
          id(n), JSON.stringify({ _id: id(n), created_at: new Date(START-30*DAY).toISOString(),
            eventType: Array<string>(1025).fill("Note") }), START-30*DAY, START-DAY, START-DAY);
        internal.treatmentCategoryIndexAvailable = undefined;
        internal.legacyTreatmentQueries.clear(); internal.boundedTreatmentQueries.clear();
        const savedRows = internal.cachedAuxiliaryRows, queries: { statement: string; bindings: SqlStorageValue[] }[] = [];
        internal.cachedAuxiliaryRows = (statement, bindings) => {
          if (statement.includes("json_type(body, '$.eventType') = 'text'") && typeof bindings[0] === "string")
            queries.push({ statement, bindings });
          return sql.exec<Row>(statement, ...bindings);
        };
        try { internal.pluginPropertyContext(START); } finally { internal.cachedAuxiliaryRows = savedRows; }
        expect(queries).toHaveLength(6);
        const member = new TreatmentMembershipReadView(sql, internal.legacyTreatmentQueries);
        expect(member.candidates("MissingWarmup")).toBeUndefined();
        const missing = sql.exec(`SELECT id FROM documents WHERE collection='treatments'
          AND EXISTS(SELECT 1 FROM json_each(body,'$.eventType') item WHERE item.type='text' AND item.value=?)`, "MissingWarmup");
        expect(missing.toArray()).toEqual([]); expect(missing.rowsRead).toBeGreaterThan(512);
        member.noteExpensiveRead(missing.rowsRead);
        const saved = internal.sharedTreatmentEventRows;
        if (mode === "previous") previousPolicy(internal, sql);
        try {
          for (const query of queries) expect([...internal.cachedAuxiliaryRows(query.statement, query.bindings)]).toEqual([]);
          expect(phase(internal)).toBe("partial");
          expect(internal.auxiliaryTreatmentCold).toBe(false);
          const expected = original(internal, sql, "properties", START);
          const sample = await measured(sql, () => internal.pluginPropertyContext(START));
          expect(sample.value).toEqual(expected); expect(sample.writes).toBe(0);
          expect(sample.memberCalls).toBe(1); expect(phase(internal)).toBe("partial");
          return { mode, reads: sample.reads, writes: sample.writes, memberReads: sample.memberReads, memberCalls: sample.memberCalls };
        } finally { internal.sharedTreatmentEventRows = saved; }
      }));
    }
    expect(reports[1]!.reads).toBe(reports[0]!.reads);
    expect(reports[1]!.memberReads).toBe(reports[0]!.memberReads);
    console.info(`AUXILIARY_BULK_CACHED_DECLINE=${JSON.stringify({ reports })}`);
  });

  it("keeps learning behind natural EOF and restores nested scopes after errors", async () => {
    const stub = env.ENTRY_STORE.getByName(`aux-bulk-eof-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (instance: EntryStore, state) => {
      const internal = instance as unknown as Internal;
      // Fresh construction already seeded its root snapshot and consumed the
      // cold opportunity. Use the real memory-cache invalidation precondition.
      internal.invalidateAuxiliaryQueries("treatments", true);
      expect(internal.auxiliaryTreatmentCold).toBe(true);
      const candidates = vi.spyOn(TreatmentMembershipReadView.prototype, "candidates").mockReturnValue(undefined);
      const nativeExec = state.storage.sql.exec.bind(state.storage.sql);
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((statement, ...values) => {
        if (statement === "synthetic category cursor") return Object.assign([{ id: id(1), body: "{}", sort_time: START }],
          { rowsRead: 600, rowsWritten: 0 }) as unknown as SqlStorageCursor<Record<string, SqlStorageValue>>;
        return nativeExec(statement, ...values);
      });
      try {
        internal.withAuxiliaryTreatmentBulk(() => {
          expect(internal.auxiliaryTreatmentBulk?.allowLearning).toBe(true);
          const iterator = internal.sharedTreatmentEventRows("synthetic category cursor", [], "Profile Switch");
          expect(iterator.next().done).toBe(false); iterator.return?.(undefined);
          expect(candidates).toHaveBeenCalledTimes(1);
          expect(internal.auxiliaryTreatmentBulk?.learningStarted).toBe(false);
          candidates.mockClear();
          [...internal.sharedTreatmentEventRows("synthetic category cursor", [], "Profile Switch")];
          expect(candidates).toHaveBeenCalledTimes(7);
          [...internal.sharedTreatmentEventRows("synthetic category cursor", [], "Sensor Start")];
          expect(candidates).toHaveBeenCalledTimes(7);
          const current = internal.auxiliaryTreatmentBulk;
          expect(() => internal.withAuxiliaryTreatmentBulk(() => { throw new Error("scope failure"); })).toThrow("scope failure");
          expect(internal.auxiliaryTreatmentBulk === current).toBe(true);
          expect(current?.allowLearning).toBe(false);
        });
        expect(internal.auxiliaryTreatmentBulk === undefined).toBe(true);
        const outer = { allowLearning: true, learningStarted: false };
        internal.auxiliaryTreatmentBulk = outer;
        internal.invalidateAuxiliaryQueries("treatments", true);
        expect(internal.auxiliaryTreatmentCold).toBe(true);
        expect(() => internal.withAuxiliaryTreatmentBulk(() => {
          expect(internal.auxiliaryTreatmentBulk?.allowLearning).toBe(false);
          expect(outer.allowLearning).toBe(false);
          throw new Error("nested cold scope failure");
        })).toThrow("nested cold scope failure");
        expect(internal.auxiliaryTreatmentBulk === outer).toBe(true);
      } finally { candidates.mockRestore(); spy.mockRestore(); internal.auxiliaryTreatmentBulk = undefined; }
    });
  });
});
