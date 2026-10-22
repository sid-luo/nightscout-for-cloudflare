import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { EntryStore } from "../src/entry-store";
import { AlertDeviceStatusQueryCache } from "../src/realtime/alert-device-status-query-cache";
import type { CachedDeviceStatusRow } from "../src/realtime/device-status-query-cache";

class OriginalAlertReads extends AlertDeviceStatusQueryCache<CachedDeviceStatusRow> {
  override *read(_key: string, _fields: readonly string[], _lower: number, _upper: number,
    load: () => Iterable<CachedDeviceStatusRow>): IterableIterator<CachedDeviceStatusRow> { yield* load(); }
  override rememberFuture(_row: CachedDeviceStatusRow | undefined): void {}
  override future(_key: string, _upper: number, load: () => CachedDeviceStatusRow | undefined): CachedDeviceStatusRow | undefined { return load(); }
}

interface Trace {
  owner: SqlStorage;
  phase: string;
  sql: string;
  cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
}

describe("15-second alert alarms under repeated actual object eviction", () => {
  for (const predictions of [false, true]) it(`bounds ${predictions ? "AAPS-sized" : "simple"} warm and every-tick cold costs with one-minute uploads and original alert output`, async () => {
    let now = Date.now();
    const start = now;
    const bindings = env as unknown as Record<string, unknown>;
    const changes = { ENABLE: "upbat", UPBAT_ENABLE_ALERTS: "true", UPBAT_WARN: "30", UPBAT_URGENT: "20",
      HEARTBEAT: "15", ALARM_TYPES: "predict", READ_DIAGNOSTICS: undefined,
      DISABLE: "ar2 simplealarms errorcodes treatmentnotify timeago pump openaps xdripjs loop bwp cage sage iage bage dbsize" };
    const previousBindings = Object.fromEntries(Object.keys(changes).map(key => [key, bindings[key]]));
    let nativeOwner: Pick<SqlStorage, "exec"> | undefined, nativeExec: SqlStorage["exec"] | undefined;
    await runInDurableObject(env.ENTRY_STORE.getByName(`cold-alert-probe-${crypto.randomUUID()}`), (_instance, state) => {
      let owner: object | null = state.storage.sql;
      while (owner !== null && !Object.hasOwn(owner, "exec")) owner = Object.getPrototypeOf(owner) as object | null;
      expect(owner !== null && owner !== state.storage.sql).toBe(true);
      nativeOwner = owner as Pick<SqlStorage, "exec">;
      nativeExec = Object.getOwnPropertyDescriptor(owner!, "exec")!.value as SqlStorage["exec"];
    });
    let phase = "fixture", evaluations = 0;
    const records: Trace[] = [];
    const execSpy = vi.spyOn(nativeOwner!, "exec").mockImplementation(function (this: SqlStorage, sql, ...parameters) {
      const cursor = Reflect.apply(nativeExec!, this, [sql, ...parameters]) as SqlStorageCursor<Record<string, SqlStorageValue>>;
      if (!["fixture", "inspect", "oracle"].includes(phase)) records.push({ owner: this, phase, sql, cursor });
      return cursor;
    });
    const notificationOwner = EntryStore.prototype as unknown as { automaticPluginNotificationEvaluation(...args: unknown[]): unknown };
    const notification = notificationOwner.automaticPluginNotificationEvaluation;
    const notificationSpy = vi.spyOn(notificationOwner, "automaticPluginNotificationEvaluation").mockImplementation(function (this: unknown, ...args) {
      if (phase === "fixture" || phase === "inspect") return Reflect.apply(notification, this, args);
      evaluations++;
      const result = Reflect.apply(notification, this, args);
      const internal = this as { alertDeviceStatusQueries: AlertDeviceStatusQueryCache<CachedDeviceStatusRow>;
        alertDeviceStatusCheckpoint: unknown };
      const cache = internal.alertDeviceStatusQueries, checkpoint = internal.alertDeviceStatusCheckpoint, previousPhase = phase;
      internal.alertDeviceStatusQueries = new OriginalAlertReads();
      internal.alertDeviceStatusCheckpoint = { hydrate() {}, persist() {} };
      phase = "oracle";
      try { expect(result).toEqual(Reflect.apply(notification, this, args)); }
      finally { internal.alertDeviceStatusQueries = cache; internal.alertDeviceStatusCheckpoint = checkpoint; phase = previousPhase; }
      return result;
    });
    const alarm = EntryStore.prototype.alarm;
    const alarmSpy = vi.spyOn(EntryStore.prototype, "alarm").mockImplementation(function (this: EntryStore, info) {
      if (phase !== "fixture" && phase !== "inspect") phase = "alarm";
      return Reflect.apply(alarm, this, [info]);
    });
    const upload = EntryStore.prototype.createDocuments;
    const uploadSpy = vi.spyOn(EntryStore.prototype, "createDocuments").mockImplementation(function (this: EntryStore, ...args) {
      if (phase !== "fixture" && phase !== "inspect") phase = "upload";
      return Reflect.apply(upload, this, args);
    });
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const reports = [];
    try {
      Object.assign(bindings, changes);
      const prediction = Array.from({ length: 48 }, (_, point) => 100 + point % 40);
      const extra = predictions ? { openaps: { suggested: {
        reason: "Synthetic AAPS prediction fixture: mealCOB=0; currenttemp=0.8; IOB=0.4; minPredBG=110; eventualBG=120. ".repeat(18),
        predBGs: { IOB: prediction, COB: prediction, UAM: prediction, ZT: prediction },
      } } } : {};
      for (const coldEveryTick of [false, true]) {
        now = start;
        const stub = env.ENTRY_STORE.getByName(`cold-alert-${coldEveryTick}-${crypto.randomUUID()}`);
        phase = "fixture";
        await runInDurableObject(stub, async (_instance, state) => {
          state.storage.sql.exec(`WITH RECURSIVE seq(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM seq WHERE n<1439)
            INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
            SELECT 'devicestatus',printf('%024x',n),json_patch(json_object('_id',printf('%024x',n),'device','openaps://synthetic-phone',
              'created_at',strftime('%Y-%m-%dT%H:%M:%fZ',(?-(1439-n)*60000-30000)/1000.0,'unixepoch'),
              'uploader',json_object('battery',19)),json(?)),?-(1439-n)*60000-30000,?-(1439-n)*60000-30000,
              ?-(1439-n)*60000-30000,1 FROM seq`, start, JSON.stringify(extra), start, start, start);
          state.storage.sql.exec(`INSERT INTO background_tasks(kind,due_at,attempt_count,updated_at)
            VALUES('plugin-notifications',?,0,?)`, start + 15_000, start);
          await state.storage.setAlarm(start + 15_000);
        });
        records.length = 0; evaluations = 0;
        const ticks = [];
        for (let tick = 1; tick <= 16; tick++) {
          now = start + tick * 15_000;
          phase = "inspect";
          if (coldEveryTick) await evictDurableObject(stub);
          phase = "activation";
          if (tick % 4 === 0) {
            expect(JSON.parse(await stub.createDocuments("devicestatus", JSON.stringify([{
              _id: (10_000 + tick).toString(16).padStart(24, "0"), device: "openaps://synthetic-phone",
              created_at: new Date(now).toISOString(), uploader: { battery: 19 }, ...extra,
            }])))).toHaveLength(1);
          }
          expect(await runDurableObjectAlarm(stub)).toBe(true);
          phase = "inspect";
          ticks.push(await runInDurableObject(stub, (_instance, state) => {
            const selected = records.filter(record => record.owner === state.storage.sql);
            const phases = ["activation", "alarm", "upload"].map(name => ({ phase: name,
              reads: selected.filter(record => record.phase === name).reduce((sum, record) => sum + record.cursor.rowsRead, 0),
              writes: selected.filter(record => record.phase === name).reduce((sum, record) => sum + record.cursor.rowsWritten, 0) }));
            const result = { tick, phases, reads: selected.reduce((sum, record) => sum + record.cursor.rowsRead, 0),
              writes: selected.reduce((sum, record) => sum + record.cursor.rowsWritten, 0),
              deviceReads: selected.filter(record => record.sql.includes("collection = 'devicestatus'"))
                .reduce((sum, record) => sum + record.cursor.rowsRead, 0),
              checkpointSaves: selected.filter(record => record.sql.includes("SET alert_payload ="))
                .reduce((sum, record) => sum + record.cursor.rowsWritten, 0),
              checkpointDdl: selected.filter(record => /^\s*(CREATE|DROP)\s/i.test(record.sql)
                && /nscf_ds_checkpoint|nscf_device_status_read_checkpoint/.test(record.sql)).length,
              activationSeals: selected.filter(record => record.sql.includes("_sql_schema_migrations")).length };
            records.length = 0;
            return result;
          }));
        }
        expect(evaluations).toBe(16);
        expect(ticks.filter(tick => tick.activationSeals > 0)).toHaveLength(coldEveryTick ? 16 : 0);
        // One original cold prefix, then bounded singleton restores and PK
        // maintenance. The old every-tick result was 32,577 reads/122 writes.
        expect(ticks.reduce((sum, tick) => sum + tick.reads, 0)).toBeLessThanOrEqual(4500);
        expect(ticks.reduce((sum, tick) => sum + tick.deviceReads, 0)).toBeLessThanOrEqual(2200);
        expect(ticks.reduce((sum, tick) => sum + tick.writes, 0)).toBeLessThanOrEqual(150);
        expect(ticks.reduce((sum, tick) => sum + tick.checkpointSaves, 0)).toBeLessThanOrEqual(5);
        for (const tick of ticks.filter(tick => tick.tick !== 1 && tick.tick % 4 !== 0)) {
          expect(tick.checkpointSaves).toBe(0);
          expect(tick.checkpointDdl).toBe(0);
        }
        reports.push({ predictions, coldEveryTick, simulatedSeconds: 240, alarmTicks: 16, uploads: 4, evaluations,
          reads: ticks.reduce((sum, tick) => sum + tick.reads, 0), writes: ticks.reduce((sum, tick) => sum + tick.writes, 0),
          deviceReads: ticks.reduce((sum, tick) => sum + tick.deviceReads, 0), ticks });
      }
      console.info(`ALERT_EVERY_COLD_BUDGET=${JSON.stringify({ scope: "Native SQL prototype installed before actual eviction; real alarm lifecycle handler; constructor SQL included; excludes fixture, inspection SQL and platform internal KV/alarm storage", reports })}`);
    } finally {
      phase = "inspect";
      for (const [key, value] of Object.entries(previousBindings)) {
        if (value === undefined) delete bindings[key]; else bindings[key] = value;
      }
      clock.mockRestore(); uploadSpy.mockRestore(); alarmSpy.mockRestore(); notificationSpy.mockRestore(); execSpy.mockRestore();
    }
  });
});
