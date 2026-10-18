import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { EntryStore, ENTRY_STORE_ACTIVATION_SEAL, type JsonDocument } from "../src/entry-store";
import { parseEntryPayload } from "../src/model";
import worker from "../src/index";

const ORIGIN = "https://synthetic.invalid";
const MINUTE = 60_000;
const WINDOW = 2 * 24 * 60 * MINUTE;
const id = (n: number) => n.toString(16).padStart(24, "0");
const compact = (sql: string) => sql.replace(/\s+/g, " ").trim();
interface Row extends Record<string, SqlStorageValue> { id: string; body: string; sort_time: number }
interface Glucose { _id: string; mgdl: number; mills: number; device: string; direction?: string; type: string }
interface Calibration { _id: string; mills: number; scale: number; intercept: number; slope: number; type: string }
interface Snapshot { sgvs: Glucose[]; mbgs: Glucose[]; cals: Calibration[] }
interface Internal {
  realtimeEntryQueries: { entries: Map<string, { lower: number; limit: number; rows: Row[]; bytes: number }> };
}
type Stub = ReturnType<typeof env.ENTRY_STORE.getByName>;
type Phase = "fixture" | "activation" | "first-public-body" | "properties" | "warm-ddata" |
  "warm-properties" | "backward-properties" | "historical-frame" | "inspect";
interface Trace {
  owner: SqlStorage; phase: Phase; sql: string; bindings: SqlStorageValue[];
  cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
}
interface PrimitiveTrace {
  phase: Phase; sql: string; bindings: SqlStorageValue[]; reads: number; writes: number;
}

function configuration(stub: Stub): Parameters<typeof worker.fetch>[1] {
  // Forward the actual stub. An instance proxy would activate the DO before
  // the measured request and hide its constructor/blockConcurrencyWhile work.
  return { ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => stub },
    API_SECRET: "synthetic-real-cold-secret", AUTH_DEFAULT_ROLES: "readable", AUTH_FAIL_DELAY: "0",
  } as unknown as Parameters<typeof worker.fetch>[1];
}

async function get<T>(stub: Stub, path: string): Promise<T> {
  const response = await worker.fetch(new Request(`${ORIGIN}${path}`), configuration(stub));
  expect(response.status, path).toBe(200);
  return response.json<T>();
}

async function seed(instance: EntryStore, state: DurableObjectState, at: number) {
  expect((await instance.putEntries(parseEntryPayload([{
    date: at, dateString: new Date(at).toISOString(), sgv: 120, type: "sgv", device: "synthetic-cold-cgm",
  }]))).inserted).toBe(1);
  const template = JSON.parse(state.storage.sql.exec<Row>(
    "SELECT id,body,sort_time FROM documents WHERE collection='entries' LIMIT 1",
  ).one().body) as JsonDocument;
  state.storage.transactionSync(() => {
    state.storage.sql.exec("DELETE FROM documents WHERE collection='entries'");
    const insert = (collection: string, key: string, document: JsonDocument, timestamp: number) => {
      state.storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
        VALUES(?,?,?,?,?,?,1)`, collection, key, JSON.stringify(document), timestamp, timestamp, timestamp);
    };
    for (let n = 0; n < 1000; n++) {
      const timestamp = at - (1000 - n) * MINUTE;
      const iso = new Date(timestamp).toISOString();
      insert("entries", id(n), { ...template, _id: id(n), date: timestamp, dateString: iso,
        sysTime: iso, sgv: 120 + n % 60 }, timestamp);
      insert("devicestatus", id(n), { _id: id(n), created_at: iso, device: "synthetic-cold-aaps",
        uploaderBattery: 90, pump: { battery: { percent: 80 }, reservoir: 50, clock: iso },
        openaps: { suggested: { timestamp: iso, IOB: 0.2, COB: 4,
          predBGs: { IOB: [120, 121, 122], COB: [121, 122, 123] } } } }, timestamp);
    }
    // More than ten genuine MBGs/CALs makes a larger-prefix reuse prove the
    // original smaller LIMIT, rather than accidentally reusing an empty cache.
    // A truthy MBG on a type=sgv document must still be MBG and excluded from SGV.
    for (let n = 0; n < 14; n++) {
      const timestamp = at - (1100 - n) * MINUTE + 500;
      insert("entries", id(2000 + n), { _id: id(2000 + n), date: timestamp,
        type: n % 2 ? "mbg" : "sgv", mbg: n === 12 ? "133" : n === 13 ? true : 130 + n,
        sgv: 199, device: "synthetic-cold-meter" }, timestamp);
    }
    for (let n = 0; n < 12; n++) {
      const timestamp = at - (12 - n) * MINUTE + 250;
      insert("entries", id(3000 + n), { _id: id(3000 + n), date: timestamp, type: "cal",
        ...(n % 2 ? { sgv: 0, mbg: false } : {}), scale: 1, intercept: 10 + n, slope: 0.8 }, timestamp);
    }
  });
  return { sgvs: 1000, mbgs: 14, cals: 12, statuses: 1000, canonicalTemplateKeys: Object.keys(template).sort() };
}

function plain<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function originalOracle(sql: SqlStorage, at: number, property: boolean, frame = false): Snapshot {
  // Independent original-body SQL + native normalizer for this finite fixture.
  // No production query factory, cache key, projected row or cache data is used.
  const rows = sql.exec<Row>(`SELECT id,body,sort_time FROM documents
    WHERE collection='entries' AND sort_time>=? ${frame ? "AND sort_time<=?" : ""}
    ORDER BY sort_time DESC,id ASC`, ...(frame ? [at - WINDOW, at] : [at - WINDOW])).toArray();
  const documents = rows.map(row => JSON.parse(row.body) as JsonDocument);
  const measurement = (value: unknown): number | null => {
    if (value === null || value === undefined || value === false || value === "") return null;
    const result = Number(value);
    return Number.isFinite(result) && result !== 0 ? result : null;
  };
  const sgvs = documents.filter(document => !document.mbg && measurement(document.sgv) !== null)
    .slice(0, property ? 64 : 726).map(document => ({ _id: document._id as string,
      mgdl: measurement(document.sgv)!, mills: document.date as number, device: document.device as string,
      direction: document.direction as string, type: "sgv" })).reverse();
  const mbgs = documents.filter(document => measurement(document.mbg) !== null).slice(0, 10)
    .map(document => ({ _id: document._id as string, mgdl: measurement(document.mbg)!,
      mills: document.date as number, device: document.device as string, type: "mbg" })).reverse();
  const cals = documents.filter(document => document.type === "cal" && !document.sgv && !document.mbg)
    .slice(0, 1).map(document => ({ _id: document._id as string, mills: document.date as number,
      scale: document.scale as number, intercept: document.intercept as number,
      slope: document.slope as number, type: "cal" }));
  return plain({ sgvs, mbgs, cals });
}

function summary(records: PrimitiveTrace[], phase: Phase) {
  const selected = records.filter(record => record.phase === phase);
  const entries = selected.filter(record => record.sql.includes("collection = 'entries'"));
  const mbg = entries.filter(record => record.sql.includes("'$.mbg'") && !record.sql.includes("'$.sgv'")
    && !record.sql.includes("'$.type'"));
  const cal = entries.filter(record => record.sql.includes("'$.type'"));
  const sgv = entries.filter(record => record.sql.includes("'$.sgv'") && !record.sql.includes("'$.type'"));
  const cost = (rows: PrimitiveTrace[]) => rows.reduce((sum, row) => sum + row.reads, 0);
  return { phase, calls: selected.length, reads: cost(selected),
    writes: selected.reduce((sum, row) => sum + row.writes, 0),
    mbgCalls: mbg.length, mbgReads: cost(mbg), calCalls: cal.length, calReads: cost(cal),
    sgvCalls: sgv.length, sgvReads: cost(sgv),
    statements: selected.map(row => ({ sql: row.sql, bindings: row.bindings,
      reads: row.reads, writes: row.writes })) };
}

describe("actual sealed activation and entry/status window rebuild", () => {
  it("reports the native interception surface without invoking prototype getters", async () => {
    const stub = env.ENTRY_STORE.getByName(`real-cold-descriptor-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, (_instance, state) => {
      const descriptors = (value: object, property: string) => {
        const result = [];
        let owner: object | null = value;
        for (let depth = 0; owner !== null; depth++, owner = Object.getPrototypeOf(owner) as object | null) {
          const descriptor = Object.getOwnPropertyDescriptor(owner, property);
          result.push({ depth, isInstance: owner === value, ownNames: Object.getOwnPropertyNames(owner),
            descriptor: descriptor === undefined ? null : {
              valueType: typeof descriptor.value, getType: typeof descriptor.get, setType: typeof descriptor.set,
              configurable: descriptor.configurable, enumerable: descriptor.enumerable, writable: descriptor.writable,
            } });
        }
        return result;
      };
      return { exec: descriptors(state.storage.sql, "exec"), sql: descriptors(state.storage, "sql") };
    });
    console.info(`REAL_COLD_NATIVE_DESCRIPTOR=${JSON.stringify(report)}`);
  });

  for (const first of ["ddata", "properties"] as const) {
    it(`captures constructor SQL before the first public ${first} request, then checks mixed MBG/CAL windows`, async () => {
      const probe = env.ENTRY_STORE.getByName(`real-cold-prototype-${crypto.randomUUID()}`);
      let nativeOwner: Pick<SqlStorage, "exec"> | undefined;
      let nativeExec: SqlStorage["exec"] | undefined;
      await runInDurableObject(probe, (_instance, state) => {
        const sql = state.storage.sql;
        let owner: object | null = sql;
        while (owner !== null && !Object.hasOwn(owner, "exec")) owner = Object.getPrototypeOf(owner) as object | null;
        // Native prototype objects cannot be passed to expect's formatter:
        // inspecting their receiver-bound getters causes Illegal invocation.
        expect(owner !== null, "A shared SqlStorage.exec prototype is required").toBe(true);
        expect(owner === sql, "An instance-only spy cannot measure the next activation").toBe(false);
        const descriptor = Object.getOwnPropertyDescriptor(owner!, "exec")!;
        expect(typeof descriptor.value).toBe("function");
        expect(descriptor.get === undefined).toBe(true);
        expect(descriptor.configurable).toBe(true);
        expect(descriptor.writable).toBe(true);
        // cloudflare:test invokes this callback in the same isolate. Keep the
        // native references in the closure, never in a serialized test result.
        nativeOwner = owner as Pick<SqlStorage, "exec">;
        nativeExec = descriptor.value as SqlStorage["exec"];
      });
      expect(nativeOwner !== undefined && nativeExec !== undefined).toBe(true);
      const stub = env.ENTRY_STORE.getByName(`real-cold-${first}-${crypto.randomUUID()}`);
      let now = Date.now();
      let phase: Phase = "fixture";
      let authBoundaries = 0;
      let harvesting = false;
      let harvestExecCalls = 0;
      const records: Trace[] = [];
      const captured: PrimitiveTrace[] = [];
      const execSpy = vi.spyOn(nativeOwner!, "exec").mockImplementation(function (this: SqlStorage, statement, ...bindings) {
        const cursor = Reflect.apply(nativeExec!, this, [statement, ...bindings]) as SqlStorageCursor<Record<string, SqlStorageValue>>;
        if (harvesting) harvestExecCalls++;
        if (phase !== "fixture" && phase !== "inspect") records.push({ owner: this, phase,
          sql: compact(statement), bindings, cursor });
        return cursor;
      });
      const harvest = async () => {
        phase = "inspect";
        const rows = await runInDurableObject(stub, (_instance, state) => {
          harvesting = true;
          try {
            // Read native counters in their owning DO before the next HTTP,
            // oracle or eviction; only plain metadata leaves this callback.
            return records.filter(record => record.owner === state.storage.sql).map(record => ({
              phase: record.phase, sql: record.sql, bindings: record.bindings,
              reads: record.cursor.rowsRead, writes: record.cursor.rowsWritten,
            }));
          } finally {
            records.length = 0;
            harvesting = false;
          }
        });
        expect(harvestExecCalls, "Counter harvesting must not execute SQL").toBe(0);
        captured.push(...rows);
      };
      const authorize = EntryStore.prototype.resolveHttpAuthorizationJson;
      const authorizationSpy = vi.spyOn(EntryStore.prototype, "resolveHttpAuthorizationJson")
        .mockImplementation(function (this: EntryStore, input) {
          if (phase === "activation") { phase = "first-public-body"; authBoundaries++; }
          return Reflect.apply(authorize, this, [input]) as Promise<string>;
        });
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        const fixture = await runInDurableObject(stub, (instance: EntryStore, state) => seed(instance, state, now));
        await evictDurableObject(stub);
        phase = "activation";
        const firstResult = await get<Snapshot | Record<string, unknown>>(stub,
          first === "ddata" ? "/api/v2/ddata/at" : "/api/v2/properties");
        await harvest();
        expect(authBoundaries).toBe(1);
        const activation = summary(captured, "activation");
        const body = summary(captured, "first-public-body");
        expect(body.sgvCalls).toBe(1);
        expect(body.mbgCalls).toBe(1);
        expect(body.calCalls).toBe(1);
        expect(activation.statements.some(row => row.sql.includes("_sql_schema_migrations")
          && row.sql.includes(String(ENTRY_STORE_ACTIVATION_SEAL))),
        "The measured receiver must include the constructor's sealed-schema preflight before auth RPC").toBe(true);
        expect(activation.writes).toBe(0);
        expect(activation.statements.some(row => /^(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP)\b/.test(row.sql))).toBe(false);
        if (first === "ddata") {
          const expected = await runInDurableObject(stub, (_instance, state) => originalOracle(state.storage.sql, now, false));
          expect((firstResult as Snapshot).sgvs).toEqual(expected.sgvs);
        } else expect(firstResult).toBeTypeOf("object");

        const phases: Phase[] = [];
        for (const next of first === "ddata"
          ? ["properties", "warm-ddata", "warm-properties"] as const
          : ["warm-ddata", "properties", "warm-properties"] as const) {
          now += 1000; phase = next; phases.push(next);
          if (next === "warm-ddata") {
            const snapshot = await get<Snapshot>(stub, "/api/v2/ddata/at");
            await harvest();
            const expected = await runInDurableObject(stub, (_instance, state) => originalOracle(state.storage.sql, now, false));
            expect(snapshot.sgvs).toEqual(expected.sgvs);
          } else {
            expect(await get(stub, "/api/v2/properties")).toBeTypeOf("object");
            await harvest();
            await runInDurableObject(stub, async (instance: EntryStore, state) => {
              const actual = JSON.parse(await instance.getPluginPropertyContextJson(now)) as Snapshot;
              const expected = originalOracle(state.storage.sql, now, true);
              expect(actual.sgvs).toEqual(expected.sgvs);
              expect(actual.mbgs).toEqual(expected.mbgs);
              expect(actual.cals).toEqual(expected.cals);
              expect(actual.mbgs).toHaveLength(10);
              expect(actual.cals).toHaveLength(1);
            });
          }
        }
        const forwardCache = await runInDurableObject(stub, (instance: EntryStore) =>
          [...(instance as unknown as Internal).realtimeEntryQueries.entries].map(([key, value]) => ({
            key: compact(key), rows: value.rows.length, limit: value.limit, bytes: value.bytes,
          })));
        const reused = summary(captured, "properties");
        expect(reused.sgvCalls + reused.mbgCalls + reused.calCalls).toBe(0);
        expect(reused.reads).toBeLessThanOrEqual(40);
        expect(forwardCache.every(entry => entry.bytes <= 512 * 1024)).toBe(true);
        if (first === "ddata") {
          // The complete larger windows are sufficient; a forward property
          // read must not build separate small SQL caches at all.
          expect(forwardCache.filter(entry => /LIMIT 10$/.test(entry.key))).toEqual([]);
          expect(forwardCache.filter(entry => entry.key.includes("'$.type'") && entry.limit === 1000)
            .map(entry => entry.rows)).toEqual([12]);
          expect(forwardCache.filter(entry => entry.key.includes("'$.mbg'") && !entry.key.includes("'$.sgv'")
            && !entry.key.includes("'$.type'") && entry.limit === 1000).map(entry => entry.rows)).toEqual([14]);
        }
        // A backward lower bound must miss all later-moving cached windows.
        // Frames remain uncached and keep their explicit original upper bound.
        now -= 5 * MINUTE;
        phase = "backward-properties";
        await get(stub, "/api/v2/properties");
        await harvest();
        await runInDurableObject(stub, async (instance: EntryStore, state) => {
          const actual = JSON.parse(await instance.getPluginPropertyContextJson(now)) as Snapshot;
          const expected = originalOracle(state.storage.sql, now, true);
          expect(actual.sgvs).toEqual(expected.sgvs);
          expect(actual.mbgs).toEqual(expected.mbgs);
          expect(actual.cals).toEqual(expected.cals);
        });
        phase = "historical-frame";
        const frameAt = now - 5 * MINUTE;
        const historical = await get<Snapshot>(stub, `/api/v2/ddata/at/${frameAt}`);
        await harvest();
        const expectedHistorical = await runInDurableObject(stub, (_instance, state) => originalOracle(state.storage.sql, frameAt, false, true));
        expect(historical.sgvs).toEqual(expectedHistorical.sgvs);
        const cache = await runInDurableObject(stub, (instance: EntryStore) =>
          [...(instance as unknown as Internal).realtimeEntryQueries.entries].map(([key, value]) => ({
            key: compact(key), rows: value.rows.length, lower: value.lower, limit: value.limit, bytes: value.bytes,
          })));
        const measured = [activation, body, ...phases.map(next => summary(captured, next)),
          summary(captured, "backward-properties"), summary(captured, "historical-frame")];
        expect(measured.every(sample => sample.writes === 0)).toBe(true);
        expect(summary(captured, "historical-frame").sgvCalls).toBe(1);
        expect(summary(captured, "historical-frame").mbgCalls).toBe(1);
        expect(summary(captured, "historical-frame").calCalls).toBe(1);
        expect(summary(captured, "backward-properties").sgvCalls).toBe(1);
        expect(summary(captured, "backward-properties").mbgCalls).toBe(1);
        expect(summary(captured, "backward-properties").calCalls).toBe(1);
        if (first === "properties") {
          const larger = summary(captured, "warm-ddata");
          expect(larger.sgvCalls).toBe(1);
          expect(larger.mbgCalls).toBe(1);
          expect(larger.calCalls).toBe(1);
        }
        console.info(`REAL_COLD_DEVICE_ENTRY_REBUILD=${JSON.stringify({ first, fixture,
          scope: "Actual shared SqlStorage.exec prototype installed before real eviction; target receiver isolated after first HTTP; auth prototype marks constructor/public-body boundary. Fixture/oracle excluded.",
          activationAndFirstHttpReads: activation.reads + body.reads, harvestExecCalls, measured, forwardCache, cache })}`);
      } finally {
        clock.mockRestore(); authorizationSpy.mockRestore(); execSpy.mockRestore();
      }
    }, 60_000);
  }
});
