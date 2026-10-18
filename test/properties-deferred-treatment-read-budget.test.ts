import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { EntryStore, entryStoreSchemaIsActivationReady, type JsonDocument } from "../src/entry-store";
import { parseEntryPayload } from "../src/model";
import { readState } from "../src/treatment-read-side-index";
import { TREATMENT_MEMBERSHIP_VIEW_KEY } from "../src/treatment-membership-read-view";
import worker from "../src/index";

const START = Date.parse("2026-10-18T12:00:00.000Z");
const MINUTE = 60_000, DAY = 86_400_000;
const ORIGIN = "https://synthetic.invalid";
const id = (n: number) => n.toString(16).padStart(24, "0");
type Stub = ReturnType<typeof env.ENTRY_STORE.getByName>;
interface Row extends Record<string, SqlStorageValue> { id: string; body: string; sort_time: number }
interface Internal {
  completeStorageInitialization(): void;
  cachedAuxiliaryRows(statement: string, bindings: SqlStorageValue[]): Iterable<Row>;
  pluginPropertyContext(at: number): { treatments: JsonDocument[] };
  legacyTreatmentQueries: { get(key: string): string | undefined };
  boundedTreatmentQueries: { clear(): void };
  realtimeAuxiliaryQueries: { treatments: { clear(): void } };
  recordDataMutationInTransaction(collection: string): void;
}
interface Trace { owner: SqlStorage; sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }
interface SqlCost { sql: string; reads: number; writes: number; calls: number }
function configuration(stub: Stub): Parameters<typeof worker.fetch>[1] {
  return { ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => stub }, API_SECRET: "synthetic-property-secret",
    AUTH_DEFAULT_ROLES: "readable", AUTH_FAIL_DELAY: "0" } as unknown as Parameters<typeof worker.fetch>[1];
}

function originalContext(instance: EntryStore, sql: SqlStorage, at: number): { treatments: JsonDocument[] } {
  const internal = instance as unknown as Internal, saved = internal.cachedAuxiliaryRows;
  internal.cachedAuxiliaryRows = (statement, bindings) => sql.exec<Row>(statement, ...bindings);
  try { return internal.pluginPropertyContext(at); }
  finally { internal.cachedAuxiliaryRows = saved; }
}

async function measured<T>(sql: SqlStorage, action: () => T | Promise<T>) {
  const exec = sql.exec.bind(sql), queries: { statement: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = exec(statement, ...bindings); queries.push({ statement, cursor }); return cursor;
  });
  try {
    const value = await action();
    const cost = (selected: (statement: string) => boolean) => queries.filter(row => selected(row.statement))
      .reduce((sum, row) => sum+row.cursor.rowsRead, 0);
    return { value, reads: cost(() => true),
      writes: queries.reduce((sum, row) => sum+row.cursor.rowsWritten, 0),
      categorySourceReads: cost(statement => statement.includes("json_type(body, '$.eventType') = 'text'")),
      memberSourceReads: cost(statement => statement.includes(" AS valid_json") && statement.includes("FROM documents")),
      ordinarySourceReads: cost(statement => statement.includes("LIMIT 1000") && statement.includes("collection = 'treatments'")) };
  } finally { spy.mockRestore(); }
}

async function seed(instance: EntryStore, state: DurableObjectState): Promise<void> {
  expect((await instance.putEntries(parseEntryPayload([{ date: START, sgv: 140,
    type: "sgv", device: "synthetic-property-cgm" }]))).inserted).toBe(1);
  const sql = state.storage.sql;
  sql.exec(`WITH RECURSIVE sequence(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM sequence WHERE n<20000)
    INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
    SELECT 'treatments',printf('%024x',n),json_object('_id',printf('%024x',n),
      'created_at',strftime('%Y-%m-%dT%H:%M:%fZ',(?-30*86400000+n*60000)/1000.0,'unixepoch'),
      'eventType','Note'),?-30*86400000+n*60000,?,?,1 FROM sequence`, START, START, START-DAY, START-DAY);
  for (let n = 0; n < 35; n++) {
    const at = START-(35-n)*MINUTE, key = id(20001+n);
    sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
      VALUES('treatments',?,?,?,?,?,1)`, key, JSON.stringify({ _id: key, created_at: new Date(at).toISOString(),
      eventType: n > 32 ? [...Array<null>(1024).fill(null), "Rare"] : Array<string>(1025).fill("Note"),
      notes: "synthetic-long-full-body-"+"x".repeat(4096) }), at, START-DAY, START-DAY);
  }
  for (const name of ["documents_treatments_created_at", "documents_treatments_event_type_created_at",
    "documents_treatments_api3_order"]) sql.exec(`DROP INDEX IF EXISTS ${name}`);
  sql.exec("DELETE FROM _sql_schema_migrations WHERE id>=31 OR id=28");
  sql.exec("INSERT OR IGNORE INTO _sql_schema_migrations(id) VALUES(30)");
  (instance as unknown as Internal).completeStorageInitialization();
  expect(entryStoreSchemaIsActivationReady(sql)).toBe(true);
  // A real deferred schema whose existing daily optional budget is exhausted.
  // Public reads must remain usable without adding optional backfill writes.
  sql.exec(`UPDATE treatment_read_side_state SET read_budget_day=?,read_day_rows=5000,
    read_last_run_at=?,read_complete=0`, Math.floor(START/DAY), START);
  expect(readState(sql)).toMatchObject({ complete: false, budgetRows: 5000 });
}

describe("deferred treatment category work shared by property inputs", () => {
  it("measures four real property HTTP reads across genuine uploads and a sealed recovery", async () => {
    const probe = env.ENTRY_STORE.getByName(`property-native-probe-${crypto.randomUUID()}`);
    let owner: Pick<SqlStorage, "exec"> | undefined, originalExec: SqlStorage["exec"] | undefined;
    await runInDurableObject(probe, (_instance, state) => {
      let current: object | null = state.storage.sql;
      while (current !== null && !Object.hasOwn(current, "exec")) current = Object.getPrototypeOf(current) as object | null;
      expect(current !== null && current !== state.storage.sql).toBe(true);
      const descriptor = Object.getOwnPropertyDescriptor(current!, "exec")!;
      expect(typeof descriptor.value).toBe("function");
      owner = current as Pick<SqlStorage, "exec">; originalExec = descriptor.value as SqlStorage["exec"];
    });
    const stub = env.ENTRY_STORE.getByName(`property-deferred-${crypto.randomUUID()}`);
    let now = START, recording = false;
    let actualContext: unknown;
    const traces: Trace[] = [];
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const getContext = EntryStore.prototype.getPluginPropertyContextJson;
    const contextSpy = vi.spyOn(EntryStore.prototype, "getPluginPropertyContextJson").mockImplementation(async function (this: EntryStore, at) {
      const result = await Reflect.apply(getContext, this, [at]);
      if (recording) actualContext = JSON.parse(result) as unknown;
      return result;
    });
    const spy = vi.spyOn(owner!, "exec").mockImplementation(function (this: SqlStorage, statement, ...bindings) {
      const cursor = Reflect.apply(originalExec!, this, [statement, ...bindings]) as SqlStorageCursor<Record<string, SqlStorageValue>>;
      if (recording) traces.push({ owner: this, sql: statement.replace(/\s+/g, " ").trim(), cursor });
      return cursor;
    });
    try {
      await runInDurableObject(stub, seed);
      await evictDurableObject(stub);
      const samples = [];
      for (let n = 0; n < 4; n++) {
        now = START+n*MINUTE;
        await runInDurableObject(stub, async (instance: EntryStore) => {
          await instance.createDocuments("treatments", JSON.stringify([{ _id: id(60000+n),
            created_at: new Date(now).toISOString(), eventType: "Note", notes: "genuine property upload" }]));
        });
        now += 1000;
        // The independent oracle keeps the original unfiltered SQL at every
        // loader boundary; it reuses only unchanged normalization/output budget.
        const oracle = await runInDurableObject(stub, (instance: EntryStore, state) => originalContext(instance, state.storage.sql, now));
        actualContext = undefined; recording = true;
        const response = await worker.fetch(new Request(ORIGIN+"/api/v2/properties"), configuration(stub));
        const body = await response.json<{ bgnow: { last: number; mills: number } }>();
        expect(response.status).toBe(200);
        expect(body.bgnow).toMatchObject({ last: 140, mills: START });
        const sample = await runInDurableObject(stub, (instance: EntryStore, state) => {
          recording = false;
          const rows = traces.filter(row => row.owner === state.storage.sql);
          const grouped = new Map<string, SqlCost>();
          for (const row of rows) {
            const previous = grouped.get(row.sql) ?? { sql: row.sql, reads: 0, writes: 0, calls: 0 };
            previous.reads += row.cursor.rowsRead; previous.writes += row.cursor.rowsWritten; previous.calls++;
            grouped.set(row.sql, previous);
          }
          const serialized = (instance as unknown as Internal).legacyTreatmentQueries.get(TREATMENT_MEMBERSHIP_VIEW_KEY);
          const membership = serialized === undefined ? "none" : serialized === "pending" || serialized === "rejected"
            ? serialized : String((JSON.parse(serialized) as unknown[])[1]);
          traces.length = 0;
          return { reads: rows.reduce((sum, row) => sum+row.cursor.rowsRead, 0),
            writes: rows.reduce((sum, row) => sum+row.cursor.rowsWritten, 0), membership, sql: [...grouped.values()] };
        });
        expect(sample.writes).toBe(0);
        expect(actualContext).toEqual(oracle);
        samples.push({ minute: n, ...sample });
      }
      expect(samples[0]!.reads).toBeLessThan(150_000);
      for (const sample of samples.slice(1)) {
        expect(sample.membership).toBe("complete");
        expect(sample.reads).toBeLessThan(1000);
      }
      expect(samples.reduce((sum, sample) => sum+sample.reads, 0)).toBeLessThan(145_000);
      console.info(`PROPERTIES_DEFERRED_TREATMENT=${JSON.stringify({ samples, reads: samples.reduce((sum, sample) => sum+sample.reads, 0) })}`);
    } finally { recording = false; spy.mockRestore(); contextSpy.mockRestore(); clock.mockRestore(); }
  });

  it("keeps native text residuals, full bodies, future boundaries and upload/rollback changes live", async () => {
    const stub = env.ENTRY_STORE.getByName(`property-deferred-live-${crypto.randomUUID()}`);
    let now = START;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await runInDurableObject(stub, async (instance: EntryStore, state) => {
        await seed(instance, state);
        const insert = (n: number, eventType: JsonDocument["eventType"], at: number, extra: JsonDocument = {}) => {
          state.storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
            VALUES('treatments',?,?,?,?,?,1)`, id(n), JSON.stringify({ _id: id(n), eventType,
            created_at: new Date(at).toISOString(), ...extra }), at, at, at);
        };
        insert(50000, "Site Change", START-20*DAY, { notes: "original full body "+"x".repeat(8192) });
        insert(50001, ["Site Change"], START-10*DAY);
        insert(50002, [["Site Change"]], START-9*DAY);
        insert(50003, "Site Change", START+2000, { notes: "future exact boundary" });
        insert(50004, "Profile Switch", START-365*DAY, { duration: 0, profile: "old retained switch" });
        insert(50005, "Profile Switch", START-DAY, { duration: "0", profile: "wrong duration type" });
      });
      await evictDurableObject(stub);
      const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
        const sql = state.storage.sql, internal = instance as unknown as Internal;
        const check = async () => {
          const expected = originalContext(instance, sql, now);
          const sample = await measured(sql, () => instance.getPluginPropertyContextJson(now));
          const actual = JSON.parse(sample.value) as { treatments: JsonDocument[] };
          expect(actual).toEqual(expected); expect(sample.writes).toBe(0);
          return { actual, reads: sample.reads, writes: sample.writes,
            categorySourceReads: sample.categorySourceReads, memberSourceReads: sample.memberSourceReads,
            ordinarySourceReads: sample.ordinarySourceReads };
        };
        const cold = await check();
        expect(cold.actual.treatments.find(row => row._id === id(50000))?.notes).toBe("original full body "+"x".repeat(8192));
        expect(cold.actual.treatments.some(row => row._id === id(50001) || row._id === id(50002) || row._id === id(50003))).toBe(false);
        expect(cold.actual.treatments.some(row => row._id === id(50004))).toBe(true);
        const warm = await check();
        expect(warm.reads).toBeLessThan(50);
        now += 2000;
        const boundary = await check();
        expect(boundary.actual.treatments.find(row => row._id === id(50003))?.notes).toBe("future exact boundary");
        expect(boundary.reads).toBeLessThan(200);
        expect(boundary.categorySourceReads).toBeLessThan(100);
        expect(boundary.memberSourceReads).toBe(0);
        await instance.createDocuments("treatments", JSON.stringify([{ _id: id(50006), eventType: "Site Change",
          created_at: new Date(START-DAY).toISOString(), notes: "fresh after genuine upload" }]));
        const uploaded = await check();
        expect(uploaded.reads).toBeLessThan(1000);
        expect(uploaded.actual.treatments.some(row => row._id === id(50006))).toBe(true);
        // Make this marker strictly newer than the future fixture at +2000.
        // An exact tie must keep the original id-ASC winner, while the ordinary
        // ASC window may legally stop before its tail at the output budget.
        now += 1;
        const saved = internal.recordDataMutationInTransaction;
        const beforeRollbackCount = sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM documents WHERE collection='treatments'").one().count;
        let lateHookReached = false, lateReadSawUncommitted = false, lateNativeVisible = false, lateOriginalSelected = false;
        let lateExpected: unknown, lateActual: unknown;
        internal.recordDataMutationInTransaction = (collection) => {
          if (collection === "treatments") {
            lateHookReached = true;
            const canonical = sql.exec<Row>("SELECT id,body,sort_time FROM documents WHERE collection='treatments' AND id=?", id(50007)).one();
            lateNativeVisible = canonical.id === id(50007) && JSON.parse(canonical.body).notes === "rolled back body";
            const expected = originalContext(instance, sql, now), actual = internal.pluginPropertyContext(now);
            lateExpected = expected; lateActual = actual;
            lateOriginalSelected = expected.treatments.some(row => row._id === id(50007) && row.notes === "rolled back body");
            lateReadSawUncommitted = actual.treatments
              .some(row => row._id === id(50007) && row.notes === "rolled back body");
            throw new Error("synthetic property rollback after late read");
          }
          return Reflect.apply(saved, instance, [collection]);
        };
        try {
          await expect(instance.createDocuments("treatments", JSON.stringify([{ _id: id(50007), eventType: "Site Change",
            created_at: new Date(now).toISOString(), notes: "rolled back body" }]))).rejects.toThrow("Treatment storage failure");
        } finally { internal.recordDataMutationInTransaction = saved; }
        expect(lateHookReached).toBe(true);
        expect(lateNativeVisible).toBe(true);
        expect(lateOriginalSelected).toBe(true);
        expect(lateReadSawUncommitted).toBe(true);
        expect(lateActual).toEqual(lateExpected);
        const rollback = await check();
        expect(rollback.actual.treatments.some(row => row._id === id(50007))).toBe(false);
        expect(sql.exec("SELECT id FROM documents WHERE collection='treatments' AND id=?", id(50007)).toArray()).toEqual([]);
        expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM documents WHERE collection='treatments'").one().count).toBe(beforeRollbackCount);
        expect(sql.exec("SELECT change_id FROM document_changes WHERE collection='treatments' AND id=?", id(50007)).toArray()).toEqual([]);
        expect(sql.exec("SELECT read_document_id FROM treatment_read_side_keys WHERE read_document_id=?", id(50007)).toArray()).toEqual([]);
        expect(rollback.reads).toBeLessThan(1000);
        return { cold: cold.reads, warm: warm.reads, boundary: boundary.reads,
          uploaded: uploaded.reads, rollback: rollback.reads,
          boundaryBreakdown: { categorySourceReads: boundary.categorySourceReads, memberSourceReads: boundary.memberSourceReads,
            ordinarySourceReads: boundary.ordinarySourceReads },
          lateHookReached, lateNativeVisible, lateOriginalSelected, lateReadSawUncommitted, canonicalRollbackVerified: true,
          addedReadWrites: [cold, warm, boundary, uploaded, rollback].map(row => row.writes) };
      });
      console.info(`PROPERTIES_DEFERRED_LIVE=${JSON.stringify(report)}`);
    } finally { clock.mockRestore(); }
  });

  it("falls back after an unsupported malformed source or lost mutation history instead of claiming empty", async () => {
    const stub = env.ENTRY_STORE.getByName(`property-deferred-rejected-${crypto.randomUUID()}`);
    const clock = vi.spyOn(Date, "now").mockReturnValue(START);
    try {
      await runInDurableObject(stub, async (instance: EntryStore, state) => {
        await seed(instance, state);
        state.storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
          VALUES('treatments',?,'{bad JSON',?,?,?,1)`, id(50000), START-3*DAY, START-DAY, START-DAY);
      });
      await evictDurableObject(stub);
      const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
        const sql = state.storage.sql, internal = instance as unknown as Internal;
        const expected = originalContext(instance, sql, START);
        const first = await measured(sql, () => instance.getPluginPropertyContextJson(START));
        expect(JSON.parse(first.value)).toEqual(expected); expect(first.writes).toBe(0);
        expect(internal.legacyTreatmentQueries.get(TREATMENT_MEMBERSHIP_VIEW_KEY)).toBe("rejected");
        await instance.createDocuments("treatments", JSON.stringify([{ _id: id(50001), eventType: "Site Change",
          created_at: new Date(START-DAY).toISOString(), notes: "selected despite rejected proof" }]));
        const afterExpected = originalContext(instance, sql, START);
        const after = await measured(sql, () => instance.getPluginPropertyContextJson(START));
        expect(JSON.parse(after.value)).toEqual(afterExpected); expect(after.writes).toBe(0);
        expect(afterExpected.treatments.some(row => row._id === id(50001))).toBe(true);
        // True pool loss after a mutation cannot reconstruct an authority from
        // potentially uncommitted SQL; the existing sticky guard keeps fallback.
        (internal.legacyTreatmentQueries as unknown as { clear(): void }).clear();
        internal.boundedTreatmentQueries.clear(); internal.realtimeAuxiliaryQueries.treatments.clear();
        const lost = await measured(sql, () => instance.getPluginPropertyContextJson(START));
        expect(JSON.parse(lost.value)).toEqual(afterExpected); expect(lost.writes).toBe(0);
        expect(lost.reads).toBeGreaterThan(100_000);
        return { malformed: first.reads, afterUpload: after.reads, lost: lost.reads,
          writes: [first.writes, after.writes, lost.writes] };
      });
      console.info(`PROPERTIES_DEFERRED_REJECTED=${JSON.stringify(report)}`);
    } finally { clock.mockRestore(); }
  });
});
