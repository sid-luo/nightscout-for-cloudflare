import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import { AlertDeviceStatusQueryCache } from "../src/realtime/alert-device-status-query-cache";
import type { CachedDeviceStatusRow } from "../src/realtime/device-status-query-cache";

const MINUTE = 60_000;
const id = (n: number) => n.toString(16).padStart(24, "0");
const DISABLED = "ar2 simplealarms errorcodes treatmentnotify timeago pump openaps xdripjs loop bwp cage sage iage bage dbsize";
type Runtime = { settings: Record<string, unknown>; upbat: boolean };
type Data = { devicestatus: Record<string, unknown>[] };
interface Internal {
  env: Record<string, unknown>;
  alertDeviceStatusQueries: AlertDeviceStatusQueryCache<CachedDeviceStatusRow>;
  alertDeviceStatusCheckpoint: unknown;
  resolvedAutomaticNotificationRuntime(at: number): Runtime;
  automaticNotificationData(at: number, runtime: Runtime): Data;
  automaticPluginNotificationEvaluation(at: number, runtime: Runtime): { notifications: unknown[]; nextDueAt: number | null };
  realtime: { recordApi3StorageMutationInTransaction(event: unknown): void };
}

/** The original two SQL selections and unchanged normalization/budget path. */
class OriginalAlertReads extends AlertDeviceStatusQueryCache<CachedDeviceStatusRow> {
  override *read(_key: string, _fields: readonly string[], _lower: number, _upper: number,
    load: () => Iterable<CachedDeviceStatusRow>): IterableIterator<CachedDeviceStatusRow> { yield* load(); }
  override rememberFuture(_row: CachedDeviceStatusRow | undefined): void {}
  override future(_key: string, _upper: number, load: () => CachedDeviceStatusRow | undefined): CachedDeviceStatusRow | undefined {
    return load();
  }
  override fork(): OriginalAlertReads { return new OriginalAlertReads(); }
}

function configure(instance: EntryStore, heartbeat: number): Internal {
  const internal = instance as unknown as Internal;
  Object.assign(internal.env, { ENABLE: "upbat", DISABLE: DISABLED, ALARM_TYPES: "predict",
    UPBAT_ENABLE_ALERTS: "true", UPBAT_WARN: "30", UPBAT_URGENT: "20", HEARTBEAT: String(heartbeat) });
  return internal;
}

function status(n: number, at: number, predictions = false): Record<string, unknown> {
  const prediction = Array.from({ length: 48 }, (_, point) => 100 + point % 40);
  const explanation = "Synthetic AAPS prediction fixture: mealCOB=0; currenttemp=0.8; IOB=0.4; minPredBG=110; eventualBG=120. ".repeat(18);
  return { _id: id(n), device: "openaps://synthetic-phone", created_at: new Date(at).toISOString(),
    uploader: { battery: 19 }, ...(predictions ? { pump: { battery: { percent: 80 }, reservoir: 60 },
      openaps: { suggested: { reason: explanation, predBGs: { IOB: prediction, COB: prediction, UAM: prediction, ZT: prediction } } } } : {}) };
}

function seed(sql: SqlStorage, at: number, predictions = false): void {
  const body = status(0, at, predictions);
  sql.exec(`WITH RECURSIVE seq(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM seq WHERE n<1439)
    INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
    SELECT 'devicestatus',printf('%024x',n),json_set(?, '$._id',printf('%024x',n), '$.created_at',
      strftime('%Y-%m-%dT%H:%M:%fZ',(?-(1439-n)*60000-30000)/1000.0,'unixepoch')),
      ?-(1439-n)*60000-30000,?-(1439-n)*60000-30000,?-(1439-n)*60000-30000,1 FROM seq`,
    JSON.stringify(body), at, at, at, at);
}

async function measure<T>(sql: SqlStorage, operation: () => T | Promise<T>) {
  const exec = sql.exec.bind(sql);
  const captured: { sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = exec(statement, ...bindings);
    captured.push({ sql: statement.replace(/\s+/g, " ").trim(), cursor });
    return cursor;
  });
  try {
    const result = await operation();
    return { result, reads: captured.reduce((sum, x) => sum + x.cursor.rowsRead, 0),
      writes: captured.reduce((sum, x) => sum + x.cursor.rowsWritten, 0),
      deviceReads: captured.filter(x => x.sql.includes("collection = 'devicestatus'"))
        .reduce((sum, x) => sum + x.cursor.rowsRead, 0) };
  } finally { spy.mockRestore(); }
}

function originalData(internal: Internal, at: number, runtime: Runtime): Data {
  const saved = internal.alertDeviceStatusQueries;
  const checkpoint = internal.alertDeviceStatusCheckpoint;
  internal.alertDeviceStatusQueries = new OriginalAlertReads();
  internal.alertDeviceStatusCheckpoint = { hydrate() {}, persist() {} };
  try { return clinicalData(internal.automaticNotificationData(at, runtime)); }
  finally { internal.alertDeviceStatusQueries = saved; internal.alertDeviceStatusCheckpoint = checkpoint; }
}

// Physical SQLite size includes the new optional derived table. It is a real
// storage metric; compare the clinical inputs and actual notification decisions.
function clinicalData(data: Data): Data {
  const { dbstats: _physicalSize, ...clinical } = data as Data & { dbstats?: unknown };
  return clinical;
}
const noCheckpoint = {
  hydrate() {}, beforeMutation() {}, afterMutation() {}, persist() {}, reset() {},
  fork(): unknown { return this; },
};

function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let n = 0; n < text.length; n++) hash = Math.imul(hash ^ text.charCodeAt(n), 0x01000193);
  return (hash >>> 0).toString(16);
}

describe("automatic DeviceStatus alert read budget", () => {
  for (const heartbeat of [15, 60]) {
    it(`keeps the original ${heartbeat}s alert decisions while eliminating unchanged recent reads`, async () => {
      const stub = env.ENTRY_STORE.getByName(`alert-repeat-${heartbeat}-${crypto.randomUUID()}`);
      const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
        const at = Date.now();
        const internal = configure(instance, heartbeat);
        state.storage.transactionSync(() => seed(state.storage.sql, at));
        const runtime = internal.resolvedAutomaticNotificationRuntime(at);
        const first = await measure(state.storage.sql, () => internal.automaticPluginNotificationEvaluation(at, runtime));
        const repeated = await measure(state.storage.sql, () => internal.automaticPluginNotificationEvaluation(at, runtime));
        const cachedData = clinicalData(internal.automaticNotificationData(at, runtime));
        expect(cachedData).toEqual(originalData(internal, at, runtime));
        expect(first.result).toEqual(repeated.result);
        expect(first.result.notifications).toHaveLength(1);
        expect(first.result.nextDueAt).toBeGreaterThan(at);
        expect(first.result.nextDueAt).toBeLessThanOrEqual(at + heartbeat * 1000);
        expect(first.deviceReads).toBe(2003);
        expect(repeated.deviceReads).toBe(0);
        expect(first.writes).toBeLessThanOrEqual(8);
        expect(repeated.writes).toBe(0);
        return { heartbeat, firstReads: first.reads, repeatedReads: repeated.reads,
          firstDeviceReads: first.deviceReads, repeatedDeviceReads: repeated.deviceReads, writes: first.writes + repeated.writes,
          nextDueDeltaMs: first.result.nextDueAt! - at };
      });
      console.info(`ALERT_REPEAT_BUDGET=${JSON.stringify(report)}`);
    });
  }

  it("preserves sparse predicates, future activation, mutations, rollback, budgets and actual cold restore", async () => {
    const stub = env.ENTRY_STORE.getByName(`alert-authority-${crypto.randomUUID()}`);
    const at = Date.now();
    const options = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: true };
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const internal = configure(instance, 15);
      // Many nonmatching future rows must not become an extra raw full scan.
      state.storage.sql.exec(`WITH RECURSIVE seq(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM seq WHERE n<5999)
        INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
        SELECT 'devicestatus',printf('%024x',n),json_object('device','unrelated','pump',json_object()),
          ?+60000+n,?, ?,1 FROM seq`, at, at, at);
      const sparseRuntime = internal.resolvedAutomaticNotificationRuntime(at);
      const sparseCold = await measure(state.storage.sql, () => internal.automaticNotificationData(at, sparseRuntime));
      const sparseWarm = await measure(state.storage.sql, () => internal.automaticNotificationData(at, sparseRuntime));
      expect(sparseCold.deviceReads).toBeGreaterThan(6000);
      expect(sparseWarm.deviceReads).toBe(0);
      expect(clinicalData(sparseWarm.result)).toEqual(clinicalData(sparseCold.result));
      console.info(`ALERT_SPARSE_FUTURE_BUDGET=${JSON.stringify({ first: sparseCold.deviceReads, repeated: sparseWarm.deviceReads })}`);
      const create = (identifier: string, date: number, extra: Record<string, unknown> = {}) => instance.api3CreateDocument(
        "devicestatus", JSON.stringify({ identifier, date, utcOffset: 0, app: "synthetic", device: "openaps://synthetic-phone",
          uploaderBattery: 19, ...extra }), JSON.stringify(options));
      const verify = (now = at) => {
        const runtime = internal.resolvedAutomaticNotificationRuntime(now);
        expect(clinicalData(internal.automaticNotificationData(now, runtime))).toEqual(originalData(internal, now, runtime));
      };
      expect(JSON.parse(await instance.api3CreateDocument("devicestatus", JSON.stringify({
        identifier: "convert-future", date: at + 2 * MINUTE, utcOffset: 0, app: "synthetic", pump: {},
      }), JSON.stringify(options)))).toMatchObject({ ok: true });
      verify();
      expect(JSON.parse(await instance.api3PatchDocument("devicestatus", "convert-future",
        JSON.stringify({ uploaderBattery: 19 }), JSON.stringify(options)))).toMatchObject({ ok: true });
      verify(); verify(at + 2 * MINUTE);
      expect(JSON.parse(await create("recent", at - MINUTE))).toMatchObject({ ok: true });
      expect(JSON.parse(await create("future", at + MINUTE))).toMatchObject({ ok: true });
      verify(); verify(); verify(at + MINUTE); verify(at - MINUTE);
      expect(JSON.parse(await instance.api3ReplaceDocument("devicestatus", "recent", JSON.stringify({
        identifier: "recent", date: at - MINUTE, utcOffset: 0, app: "synthetic", uploaderBattery: 18,
      }), JSON.stringify(options)))).toMatchObject({ ok: true });
      verify();
      const old = internal.realtime.recordApi3StorageMutationInTransaction;
      internal.realtime.recordApi3StorageMutationInTransaction = () => {
        verify();
        throw new Error("synthetic alert cache rollback");
      };
      try { expect(JSON.parse(await create("failed", at - 10))).toMatchObject({ ok: false }); }
      finally { internal.realtime.recordApi3StorageMutationInTransaction = old; }
      verify();
      expect((await instance.api3DeleteDocument("devicestatus", "recent", true, null)).deleted).toBe(true);
      verify();
      expect(JSON.parse(await instance.api3ReplaceDocument("devicestatus", "future", JSON.stringify({
        identifier: "future", date: at + MINUTE, utcOffset: 0, app: "synthetic", pump: {},
      }), JSON.stringify(options)))).toMatchObject({ ok: true });
      verify();
      expect(JSON.parse(await create("oversize", at - 20, { extra: "x".repeat(300_000) }))).toMatchObject({ ok: true });
      verify(); verify();
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, (instance: EntryStore) => {
      const internal = configure(instance, 15);
      const runtime = internal.resolvedAutomaticNotificationRuntime(at);
      expect(clinicalData(internal.automaticNotificationData(at, runtime))).toEqual(originalData(internal, at, runtime));
      expect(clinicalData(internal.automaticNotificationData(at, runtime))).toEqual(originalData(internal, at, runtime));
    });
  });

  for (const heartbeat of [15, 60]) {
    it(`compares one hour of ${heartbeat}s evaluations and one-minute prediction uploads against original SQL`, async () => {
      const start = Date.now();
      const reports = [];
      for (const baseline of [true, false]) {
        const stub = env.ENTRY_STORE.getByName(`alert-moving-${heartbeat}-${baseline}-${crypto.randomUUID()}`);
        reports.push(await runInDurableObject(stub, async (instance: EntryStore, state) => {
          let now = start;
          const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
          const internal = configure(instance, heartbeat);
          if (baseline) {
            internal.alertDeviceStatusQueries = new OriginalAlertReads();
            internal.alertDeviceStatusCheckpoint = noCheckpoint;
          }
          state.storage.transactionSync(() => seed(state.storage.sql, start, true));
          const runtime = internal.resolvedAutomaticNotificationRuntime(start);
          const schemaObjects = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM sqlite_master").one().count;
          let reads = 0, writes = 0, uploadReads = 0, uploadWrites = 0;
          let firstUploadReads: number | undefined, maxUploadReads = 0;
          const fingerprints = [];
          try {
            for (let second = 0; second < 3600; second += heartbeat) {
              now = start + second * 1000;
              if (second % 60 === 0) {
                const upload = await measure(state.storage.sql, () => instance.createDocuments("devicestatus",
                  JSON.stringify([status(10_000 + second / 60, now, true)])));
                expect(JSON.parse(upload.result)).toHaveLength(1);
                reads += upload.reads; writes += upload.writes;
                uploadReads += upload.reads; uploadWrites += upload.writes;
                firstUploadReads ??= upload.reads;
                maxUploadReads = Math.max(maxUploadReads, upload.reads);
              }
              const evaluation = await measure(state.storage.sql, () => internal.automaticNotificationData(now, runtime));
              reads += evaluation.reads; writes += evaluation.writes;
              fingerprints.push(fingerprint(clinicalData(evaluation.result)));
            }
          } finally { clock.mockRestore(); }
          return { baseline, heartbeat, reads, writes, uploadReads, uploadWrites, firstUploadReads,
            maxUploadReads, schemaObjects, bodyCodeUnits: JSON.stringify(status(0, start, true)).length, fingerprints };
        }));
      }
      const original = reports[0]!, cached = reports[1]!;
      console.info(`ALERT_MOVING_BUDGET=${JSON.stringify(reports.map(({ fingerprints, ...report }) =>
        ({ ...report, evaluations: fingerprints.length, uploads: 60, bodyScope: "synthetic AAPS prediction arrays" })))}`);
      expect(cached.fingerprints).toEqual(original.fingerprints);
      // Derived checkpoint setup, one invalidation per subsequent upload and
      // one refreshed raw proof per minute; canonical upload work is unchanged.
      expect(cached.writes - original.writes).toBeLessThanOrEqual(128);
      expect(cached.writes).toBeGreaterThanOrEqual(original.writes);
      expect(cached.uploadWrites - original.uploadWrites).toBeLessThanOrEqual(128);
      // The first participating read installs and verifies the optional table
      // and three triggers. Subsequent wakes use four indexed schema rowids.
      expect(cached.firstUploadReads).toBeLessThanOrEqual(original.firstUploadReads! + 8 * cached.schemaObjects + 128);
      expect(cached.reads).toBeLessThan(original.reads / 2);
    }, 60_000);
  }
});
