import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { EntryStore } from "../src/entry-store";
import { SqliteDocumentRepository } from "../src/document-repository";
import { parseApi3Search } from "../src/api3/input";
import { calculateUploaderBatteryProperty, uploaderBatteryNotification } from "../src/plugins/upbat";
import { normalizeRealtimeDeviceStatus, type RealtimeDocument } from "../src/realtime/ddata-snapshot";
import { decodeEngineIoV4PollingPayload, encodeEngineIoV4PollingPayload } from "../src/protocol";
import worker from "../src/index";

const MINUTE = 60_000, MINUTES = 8, STEPS = MINUTES * 4, HISTORICAL = 12000;
const SECRET = "nscf-test-secret-20260717";
const id = (n: number) => n.toString(16).padStart(24, "0");
interface Trace { owner: SqlStorage; statement: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }
interface Cost { step: number; reads: number; writes: number; calls: number; activationChecks: number;
  sourceReads: number; checkpointReads: number }
interface Evaluation { notifications: RealtimeDocument[]; nextDueAt: number | null }
interface RawStatus extends Record<string, SqlStorageValue> { id: string; body: string }

describe("every-tick cold API3, notifications and live polling", () => {
  it("preserves native data and timely alarms across a true eviction before every fifteen-second tick", async () => {
    // The application clock is simulated; Miniflare's alarm scheduler uses
    // real wall time. Keep native delivery in the future so only the explicit
    // real alarm-handler invocations below advance this controlled timeline.
    let now = Date.now() + 86_400_000, step = -1, measuring = false;
    const start = now, clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const bindings = env as unknown as Record<string, unknown>;
    const settings = { ENABLE: "upbat", UPBAT_ENABLE_ALERTS: "true", UPBAT_WARN: "30", UPBAT_URGENT: "20",
      HEARTBEAT: "15", ALARM_TYPES: "predict", READ_DIAGNOSTICS: undefined,
      DISABLE: "ar2 simplealarms errorcodes treatmentnotify timeago pump openaps xdripjs loop bwp cage sage iage bage dbsize" };
    const previousSettings = Object.fromEntries(Object.keys(settings).map(key => [key, bindings[key]]));
    const traces: Trace[] = [], costs: Cost[] = [], evaluations = new Map<number, Evaluation>();
    let nativeOwner: Pick<SqlStorage, "exec"> | undefined, nativeExec: SqlStorage["exec"] | undefined;
    await runInDurableObject(env.ENTRY_STORE.getByName(`every-cold-probe-${crypto.randomUUID()}`), (_instance, state) => {
      let owner: object | null = state.storage.sql;
      while (owner !== null && !Object.hasOwn(owner, "exec")) owner = Object.getPrototypeOf(owner) as object | null;
      expect(owner).not.toBeNull(); nativeOwner = owner as Pick<SqlStorage, "exec">;
      nativeExec = Object.getOwnPropertyDescriptor(owner!, "exec")!.value as SqlStorage["exec"];
    });
    const executeSpy = vi.spyOn(nativeOwner!, "exec").mockImplementation(function (this: SqlStorage, statement, ...parameters) {
      const cursor = Reflect.apply(nativeExec!, this, [statement, ...parameters]) as SqlStorageCursor<Record<string, SqlStorageValue>>;
      if (measuring) traces.push({ owner: this, statement, cursor });
      return cursor;
    });
    const evaluationOwner = EntryStore.prototype as unknown as { automaticPluginNotificationEvaluation(...args: unknown[]): Evaluation };
    const originalEvaluation = evaluationOwner.automaticPluginNotificationEvaluation;
    const evaluationSpy = vi.spyOn(evaluationOwner, "automaticPluginNotificationEvaluation").mockImplementation(function (this: unknown, ...args) {
      const result = Reflect.apply(originalEvaluation, this, args) as Evaluation;
      if (measuring) evaluations.set(step, structuredClone(result));
      return result;
    });
    const stub = env.ENTRY_STORE.getByName(`every-cold-combined-${crypto.randomUUID()}`);
    const configuration = { ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => stub }, API_SECRET: SECRET,
      AUTH_DEFAULT_ROLES: "", AUTH_FAIL_DELAY: "0" } as unknown as Parameters<typeof worker.fetch>[1];
    let requests = 0, controlPosts = 0, noopPolls = 0, closedSessions = 0, reconnects = 0;
    let sessions: { sid: string; lastPoll: number }[] = [];
    const closedSids: string[] = [];
    const closeSessions = async () => {
      for (const session of sessions) {
        const lease = await stub.realtimeBeginPostEnvelope(session.sid, 4);
        expect(lease.ok).toBe(true); if (!lease.ok) throw new Error("close lease failed");
        expect(await stub.realtimeSubmitPost(session.sid, lease.value.token,
          encodeEngineIoV4PollingPayload([{ type: "close" }]), 4)).toEqual({ ok: true, value: null });
        closedSids.push(session.sid); closedSessions++;
      }
      sessions = [];
    };
    try {
      const token = await runInDurableObject(stub, async (instance: EntryStore, state) => {
        await instance.createDocuments("roles", JSON.stringify([{ name: "cold-reader", permissions: ["api:devicestatus:read"] }]));
        await instance.createDocuments("subjects", JSON.stringify([{ name: "cold-reader", roles: ["cold-reader"] }]));
        const subjects = JSON.parse(await instance.listDocuments("subjects")) as { name: string; accessToken: string }[];
        const jwt = (JSON.parse(await instance.issueAccessJwt(subjects.find(subject => subject.name === "cold-reader")!.accessToken)) as { token: string }).token;
        state.storage.transactionSync(() => state.storage.sql.exec(`WITH RECURSIVE seq(n) AS
          (VALUES(0) UNION ALL SELECT n+1 FROM seq WHERE n<?)
          INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,identifier_present,
            srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
          SELECT 'devicestatus',printf('%024x',n),json_object('_id',printf('%024x',n),'identifier','seed-'||n,
            'date',?-(?-n)*60000,'created_at',strftime('%Y-%m-%dT%H:%M:%fZ',(?-(?-n)*60000)/1000.0,'unixepoch'),
            'device','present','uploader',json_object('battery',19)),?-(?-n)*60000,?-(?-n)*60000,?-(?-n)*60000,
            'seed-'||n,1,?-(?-n)*60000,?-(?-n)*60000,?-(?-n)*60000,1,1,1 FROM seq`,
        HISTORICAL - 1, start, HISTORICAL, start, HISTORICAL, start, HISTORICAL, start, HISTORICAL,
        start, HISTORICAL, start, HISTORICAL, start, HISTORICAL, start, HISTORICAL));
        return jwt;
      });
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(SECRET)))]
        .map(byte => byte.toString(16).padStart(2, "0")).join("");
      const request = async (path: string, payload?: unknown) => {
        const response = await worker.fetch(new Request(`https://synthetic.invalid${path}`, payload === undefined
          ? { headers: { Authorization: `Bearer ${token}` } }
          : { method: "POST", headers: { "api-secret": digest, "Content-Type": "application/json" }, body: JSON.stringify(payload) }), configuration);
        requests++; expect(response.status, path).toBe(200); return response.json();
      };
      const read = async (suffix: string): Promise<RealtimeDocument[]> => {
        const result = await request(`/api/v3/devicestatus?limit=1${suffix}`) as { status: number; result: RealtimeDocument[] };
        expect(result.status).toBe(200); return result.result;
      };
      for (step = 0; step < STEPS; step++) {
        now = start + step * 15_000;
        const minute = Math.floor(step / 4);
        // Harvest each old activation before this call. No constructor or
        // native source scan is hidden inside fixture/inspection accounting.
        measuring = false; await evictDurableObject(stub); Object.assign(bindings, settings);
        measuring = true;
        await runInDurableObject(stub, (instance: EntryStore) => {
          // Each cold activation intentionally restarts polling liveness. A
          // 15s-cold fixture cannot have a due 25s server ping. Bound the real
          // empty poll here; warm ping/pong delivery is covered separately.
          (instance as unknown as { realtime: { pollWaitMs: number } }).realtime.pollWaitMs = 0;
        });
        if (step % 4 === 0) await request("/api/v1/devicestatus", [{ _id: id(13000 + minute), date: now,
          created_at: new Date(now).toISOString(), device: minute === 4 ? "arrives-later" : "present", uploader: { battery: 19 } }]);
        if (step === 0 || step === 8 || step === 20) {
          if (step !== 0) { await closeSessions(); reconnects++; }
          for (let client = 0; client < 2; client++) {
            const handshake = await stub.realtimeHandshake(4);
            expect(handshake.ok).toBe(true); if (!handshake.ok) throw new Error("handshake failed");
            sessions.push({ sid: handshake.value.sid, lastPoll: now });
          }
        }
        await runInDurableObject(stub, async (instance: EntryStore) => { await instance.alarm(); });
        const missing = await read("&device%24eq=never-arrives"), latest = await read("&sort%24desc=date");
        expect(missing).toEqual([]);
        expect(latest).toMatchObject([{ date: start + minute * MINUTE, device: minute === 4 ? "arrives-later" : "present" }]);
        if (step === 8) expect(await read("&device%24eq=arrives-later")).toEqual([]);
        if (step === 16) expect(await read("&device%24eq=arrives-later"))
          .toMatchObject([{ date: start + 4 * MINUTE, device: "arrives-later" }]);
        for (const session of sessions) {
          if (now - session.lastPoll < 25_000) continue;
          const poll = await stub.realtimePollEnvelope(session.sid, 4);
          expect(poll.ok).toBe(true); if (!poll.ok) throw new Error("poll failed after cold recovery");
          expect(decodeEngineIoV4PollingPayload(poll.value.payload)).toEqual([{ type: "noop" }]); noopPolls++;
          const lease = await stub.realtimeBeginPostEnvelope(session.sid, 4);
          expect(lease.ok).toBe(true); if (!lease.ok) throw new Error("lease failed after cold recovery");
          expect(await stub.realtimeSubmitPost(session.sid, lease.value.token,
            encodeEngineIoV4PollingPayload([{ type: "pong" }]), 4)).toEqual({ ok: true, value: null });
          // An accepted unsolicited EIO4 pong exercises control-POST lease
          // completion. This is not a claim of due server-heartbeat delivery.
          session.lastPoll = now; controlPosts++;
        }
        if (step === STEPS - 1) await closeSessions();
        measuring = false;
        const cost = await runInDurableObject(stub, (_instance, state) => {
          const captured = traces.filter(trace => trace.owner === state.storage.sql);
          const repository = new SqliteDocumentRepository(state.storage);
          for (const [suffix, actual] of [["&device%24eq=never-arrives", missing], ["&sort%24desc=date", latest]] as const) {
            expect(actual).toEqual(repository.queryDocumentsForApi3("devicestatus", {
              ...parseApi3Search(new URL(`https://synthetic.invalid/api/v3/devicestatus?limit=1${suffix}`)), includeDeleted: false,
            }));
          }
          // Stateless alert oracle. It neither swaps the live cache nor saves
          // a checkpoint; every source row comes from the original SQL shape.
          const statuses = state.storage.sql.exec<RawStatus>(`SELECT id,body FROM documents
            WHERE collection='devicestatus' AND sort_time>=? AND sort_time<=?
              AND CASE WHEN json_valid(body) THEN (json_type(body,'$.uploader') IS NOT NULL
                OR json_type(body,'$.uploaderBattery') IS NOT NULL) ELSE 0 END
            ORDER BY sort_time DESC,updated_at DESC,id ASC LIMIT 1000`, now - 86_400_000, now).toArray()
            .map(row => normalizeRealtimeDeviceStatus({ ...JSON.parse(row.body) as RealtimeDocument, _id: row.id }));
          const preferences = { enableAlerts: true, warn: 30, urgent: 20 };
          const expected = uploaderBatteryNotification(calculateUploaderBatteryProperty(statuses, now, preferences), preferences);
          expect(expected).not.toBeNull();
          // Preserve the original earlier 30-minute expiration boundary as
          // well as HEARTBEAT: a row exactly 30 minutes old wakes in 1ms.
          const expires = statuses.filter(status => Object.hasOwn(status, "uploader")
            && Number(status.mills) <= now && Number(status.mills) >= now - 30 * MINUTE)
            .map(status => Number(status.mills) + 30 * MINUTE + 1);
          const expectedNextDue = Math.min(now + 15_000, ...expires);
          expect(evaluations.get(step), `actual scheduled notification evaluation at cold tick ${step}`)
            .toMatchObject({ notifications: [expected], nextDueAt: expectedNextDue });
          for (const session of sessions) expect(state.storage.sql.exec<{ post_token: string | null }>(
            "SELECT post_token FROM realtime_sessions WHERE sid=?", session.sid).one().post_token).toBeNull();
          for (const sid of closedSids) expect(state.storage.sql.exec(
            "SELECT sid FROM realtime_sessions WHERE sid=?", sid).toArray()).toEqual([]);
          return { step, reads: captured.reduce((sum, trace) => sum + trace.cursor.rowsRead, 0),
            writes: captured.reduce((sum, trace) => sum + trace.cursor.rowsWritten, 0), calls: captured.length,
            activationChecks: captured.filter(trace => trace.statement.includes("_sql_schema_migrations")).length,
            sourceReads: captured.filter(trace => /FROM documents/.test(trace.statement)).reduce((sum, trace) => sum + trace.cursor.rowsRead, 0),
            checkpointReads: captured.filter(trace => /nscf_device_status_read_checkpoint|schema_rowid/.test(trace.statement))
              .reduce((sum, trace) => sum + trace.cursor.rowsRead, 0) };
        });
        costs.push(cost); traces.length = 0;
      }
      const count = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM documents WHERE collection='devicestatus'").one().count);
      expect(count).toBe(HISTORICAL + MINUTES); expect(evaluations.size).toBe(STEPS);
      expect(costs.every(cost => cost.activationChecks > 0)).toBe(true);
      expect(noopPolls).toBe(26); expect(controlPosts).toBe(26); expect(closedSessions).toBe(6); expect(reconnects).toBe(2);
      // The original source work is paid once: initial alert/empty/latest
      // prefixes and one newly learned empty predicate at step 8. Every other
      // true cold activation must restore bounded proofs and use PK maintenance.
      const budget = { initial: 4 * HISTORICAL + 4000, enrollment: HISTORICAL + 1000,
        restoredTick: 500, aggregate: 80_000, writes: 700 };
      const report = { scope: "Eight simulated minutes; real eviction before every 15s tick. Native SQL includes activation, authenticated HTTP uploads/API3 reads, actual alarms/checkpoint work and EIO4 bounded noop polls/control-POST leases/close. Test-only pollWaitMs=0; unsolicited pong controls prove lease completion, not due server-heartbeat delivery (covered by warm combined case). Fixture, JWT issuance, native result/alert oracles and harvest are excluded; KV/alarm APIs and platform internals unmeasured. No daily guarantee.",
        minutes: MINUTES, evictions: STEPS, seedStatuses: HISTORICAL, uploads: MINUTES, httpRequests: requests,
        alertOracleChecks: evaluations.size, noopPolls, controlPosts, closedSessions, reconnects,
        budget, reads: costs.reduce((sum, cost) => sum + cost.reads, 0), writes: costs.reduce((sum, cost) => sum + cost.writes, 0), costs };
      console.info(`POST14_EVERY_COLD_COMBINED=${JSON.stringify(report)}`);
      for (const cost of costs) expect(cost.reads, `cold tick ${cost.step}`)
        .toBeLessThanOrEqual(cost.step === 0 ? budget.initial : cost.step === 8 ? budget.enrollment : budget.restoredTick);
      expect(report.reads).toBeGreaterThan(0); expect(report.reads).toBeLessThanOrEqual(budget.aggregate);
      expect(report.writes).toBeGreaterThan(0); expect(report.writes).toBeLessThanOrEqual(budget.writes);
    } finally {
      measuring = false; executeSpy.mockRestore(); evaluationSpy.mockRestore();
      Object.assign(bindings, previousSettings); clock.mockRestore();
    }
  }, 30_000);
});
