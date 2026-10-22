import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { EntryStore } from "../src/entry-store";
import { SqliteDocumentRepository } from "../src/document-repository";
import { parseApi3Search } from "../src/api3/input";
import worker from "../src/index";
import { decodeEngineIoV4PollingPayload, encodeEngineIoV4PollingPayload } from "../src/protocol";

const MINUTE = 60_000, MINUTES = 8, HISTORICAL = 12000;
const SECRET = "nscf-test-secret-20260717";
const id = (n: number) => n.toString(16).padStart(24, "0");
interface Trace { owner: SqlStorage; statement: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }
interface Cost { minute: number; reads: number; writes: number; calls: number; activationChecks: number }

describe("post-1.4 combined authenticated polling and notification budget", () => {
  it("keeps uploads and API3 reads fresh through frequent alarms, live polling and two true cold recoveries", async () => {
    // Keep native Miniflare alarm delivery beyond real wall time; this
    // controlled timeline explicitly invokes the actual alarm handler.
    let now = Date.now() + 86_400_000;
    const start = now, clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const changes = { ENABLE: "upbat", UPBAT_ENABLE_ALERTS: "true", UPBAT_WARN: "30", UPBAT_URGENT: "20",
      HEARTBEAT: "15", ALARM_TYPES: "predict", READ_DIAGNOSTICS: undefined,
      DISABLE: "ar2 simplealarms errorcodes treatmentnotify timeago pump openaps xdripjs loop bwp cage sage iage bage dbsize" };
    const bindings = env as unknown as Record<string, unknown>;
    const before = Object.fromEntries(Object.keys(changes).map(key => [key, bindings[key]]));
    let nativeOwner: Pick<SqlStorage, "exec"> | undefined, nativeExec: SqlStorage["exec"] | undefined;
    let phase = "fixture", notificationEvaluations = 0;
    const traces: Trace[] = [], costs: Cost[] = [];
    const probe = env.ENTRY_STORE.getByName(`post14-probe-${crypto.randomUUID()}`);
    await runInDurableObject(probe, (_instance, state) => {
      let owner: object | null = state.storage.sql;
      while (owner !== null && !Object.hasOwn(owner, "exec")) owner = Object.getPrototypeOf(owner) as object | null;
      expect(owner).not.toBeNull();
      nativeOwner = owner as Pick<SqlStorage, "exec">;
      nativeExec = Object.getOwnPropertyDescriptor(owner!, "exec")!.value as SqlStorage["exec"];
    });
    const executeSpy = vi.spyOn(nativeOwner!, "exec").mockImplementation(function (this: SqlStorage, statement, ...parameters) {
      const cursor = Reflect.apply(nativeExec!, this, [statement, ...parameters]) as SqlStorageCursor<Record<string, SqlStorageValue>>;
      if (phase !== "fixture" && phase !== "inspect") traces.push({ owner: this, statement, cursor });
      return cursor;
    });
    const notificationOwner = EntryStore.prototype as unknown as { automaticPluginNotificationEvaluation(...args: unknown[]): unknown };
    const originalNotification = notificationOwner.automaticPluginNotificationEvaluation;
    const notificationSpy = vi.spyOn(notificationOwner, "automaticPluginNotificationEvaluation").mockImplementation(function (this: unknown, ...args) {
      if (phase !== "fixture" && phase !== "inspect") notificationEvaluations++;
      return Reflect.apply(originalNotification, this, args);
    });
    const stub = env.ENTRY_STORE.getByName(`post14-combined-${crypto.randomUUID()}`);
    const configuration = { ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => stub }, API_SECRET: SECRET,
      AUTH_DEFAULT_ROLES: "", AUTH_FAIL_DELAY: "0" } as unknown as Parameters<typeof worker.fetch>[1];
    let httpRequests = 0, alarms = 0, heartbeatCycles = 0, reconnects = 0;
    let sessions: { sid: string; lastPong: number }[] = [];
    try {
      const token = await runInDurableObject(stub, async (instance: EntryStore, state) => {
        await instance.createDocuments("roles", JSON.stringify([{ name: "post14-reader", permissions: ["api:devicestatus:read"] }]));
        await instance.createDocuments("subjects", JSON.stringify([{ name: "post14-reader", roles: ["post14-reader"] }]));
        const subjects = JSON.parse(await instance.listDocuments("subjects")) as { name: string; accessToken: string }[];
        const accessToken = subjects.find(subject => subject.name === "post14-reader")!.accessToken;
        const jwt = (JSON.parse(await instance.issueAccessJwt(accessToken)) as { token: string }).token;
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
      Object.assign(bindings, changes);
      const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(SECRET)))]
        .map(byte => byte.toString(16).padStart(2, "0")).join("");
      const request = async (path: string, payload?: unknown) => {
        const response = await worker.fetch(new Request(`https://synthetic.invalid${path}`, payload === undefined
          ? { headers: { Authorization: `Bearer ${token}` } }
          : { method: "POST", headers: { "api-secret": digest, "Content-Type": "application/json" }, body: JSON.stringify(payload) }), configuration);
        httpRequests++;
        expect(response.status, path).toBe(200);
        return response.json() as Promise<{ status: number; result: Record<string, unknown>[] }>;
      };
      const api3 = async (query: string) => {
        const result = await request(`/api/v3/devicestatus?limit=1${query}`);
        expect(result.status).toBe(200); return result.result;
      };
      const inspectLeases = async () => {
        phase = "inspect";
        await runInDurableObject(stub, (_instance, state) => {
          for (const session of sessions) expect(state.storage.sql.exec<{ post_token: string | null }>(
            "SELECT post_token FROM realtime_sessions WHERE sid=?", session.sid).one().post_token).toBeNull();
        });
      };
      const harvest = async (minute: number) => {
        phase = "inspect";
        const cost = await runInDurableObject(stub, (_instance, state) => {
          const captured = traces.filter(trace => trace.owner === state.storage.sql);
          return { minute, reads: captured.reduce((sum, trace) => sum + trace.cursor.rowsRead, 0),
            writes: captured.reduce((sum, trace) => sum + trace.cursor.rowsWritten, 0), calls: captured.length,
            activationChecks: captured.filter(trace => trace.statement.includes("_sql_schema_migrations")).length };
        });
        costs.push(cost); traces.length = 0;
      };
      for (let minute = 0; minute < MINUTES; minute++) {
        now = start + minute * MINUTE;
        const cold = minute === 2 || minute === 5;
        if (cold) {
          // Previous minute's counters have already been harvested in their
          // owning activation. The next real HTTP mutation pays activation.
          phase = "inspect"; await evictDurableObject(stub);
          Object.assign(bindings, changes); reconnects++; sessions = [];
        }
        phase = `upload-${minute}`;
        await request("/api/v1/devicestatus", [{ _id: id(13000 + minute), date: now,
          created_at: new Date(now).toISOString(), device: minute === 4 ? "arrives-later" : "present", uploader: { battery: 19 } }]);
        if (minute === 0 || cold) {
          phase = `connect-${minute}`;
          for (let client = 0; client < 2; client++) {
            const handshake = await stub.realtimeHandshake(4);
            expect(handshake.ok).toBe(true); if (!handshake.ok) throw new Error("handshake failed");
            sessions.push({ sid: handshake.value.sid, lastPong: now });
          }
          const matching = await api3("&device%24eq=arrives-later");
          if (minute < 4) expect(matching).toEqual([]);
          else expect(matching).toMatchObject([{ date: start + 4 * MINUTE, device: "arrives-later" }]);
        }
        for (let tick = 0; tick < 4; tick++) {
          now = start + minute * MINUTE + tick * 15_000;
          phase = `minute-${minute}-tick-${tick}`;
          await runInDurableObject(stub, async (instance: EntryStore) => { await instance.alarm(); }); alarms++;
          expect(await api3("&device%24eq=never-arrives")).toEqual([]);
          // HTTP defaults deliberately sort identifier/created_at/date ASC;
          // a request for the newest status must ask for date DESC explicitly.
          if (minute === 1 && tick === 0) {
            const ordinary = await api3("");
            phase = "inspect";
            const expected = await runInDurableObject(stub, (_instance, state) =>
              new SqliteDocumentRepository(state.storage).queryDocumentsForApi3("devicestatus", {
                ...parseApi3Search(new URL("https://synthetic.invalid/api/v3/devicestatus?limit=1")), includeDeleted: false,
              }));
            expect(ordinary).toEqual(expected);
            phase = `minute-${minute}-tick-${tick}`;
          }
          const latest = await api3("&sort%24desc=date");
          if (latest[0]?.date !== start + minute * MINUTE) {
            phase = "inspect";
            const native = await runInDurableObject(stub, (_instance, state) => ({
              rows: state.storage.sql.exec(`SELECT id,sort_time,json_extract(body,'$.date') AS date,
                json_extract(body,'$.created_at') AS iso FROM documents WHERE collection='devicestatus'
                ORDER BY sort_time DESC LIMIT 3`).toArray(),
              original: new SqliteDocumentRepository(state.storage).queryDocumentsForApi3("devicestatus", {
                ...parseApi3Search(new URL("https://synthetic.invalid/api/v3/devicestatus?limit=1&sort%24desc=date")), includeDeleted: false,
              }),
            }));
            console.info(`POST14_FRESHNESS_FAILURE=${JSON.stringify({ minute, tick, latest, native })}`);
          }
          expect(latest).toMatchObject([{ date: start + minute * MINUTE,
            device: minute === 4 ? "arrives-later" : "present" }]);
          if (minute === 4 && tick === 0 || minute === 7 && tick === 3) {
            expect(await api3("&device%24eq=arrives-later")).toMatchObject([{ date: start + 4 * MINUTE, device: "arrives-later" }]);
          }
          for (const session of sessions) {
            if (now - session.lastPong < 25_000) continue;
            const poll = await stub.realtimePollEnvelope(session.sid, 4);
            expect(poll.ok).toBe(true); if (!poll.ok) throw new Error("live poll failed");
            expect(decodeEngineIoV4PollingPayload(poll.value.payload)).toEqual([{ type: "ping" }]);
            const lease = await stub.realtimeBeginPostEnvelope(session.sid, 4);
            expect(lease.ok).toBe(true); if (!lease.ok) throw new Error("POST lease failed");
            expect(await stub.realtimeSubmitPost(session.sid, lease.value.token,
              encodeEngineIoV4PollingPayload([{ type: "pong" }]), 4)).toEqual({ ok: true, value: null });
            session.lastPong = now; heartbeatCycles++;
          }
        }
        await inspectLeases(); await harvest(minute);
      }
      phase = "inspect";
      const finalCount = await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM documents WHERE collection='devicestatus'").one().count);
      expect(finalCount).toBe(HISTORICAL + MINUTES);
      expect(notificationEvaluations).toBeGreaterThanOrEqual(32);
      expect(alarms).toBe(32); expect(reconnects).toBe(2); expect(heartbeatCycles).toBe(26);
      expect(costs.filter(cost => cost.minute === 2 || cost.minute === 5).every(cost => cost.activationChecks > 0)).toBe(true);
      const coldMinutes = [0, 2, 5];
      // The pre-checkpoint version paid two empty predicates (~2H) and an
      // explicit native JSON sort (~2H) again in these three cold phases.
      // The first 100k aggregate hypothesis failed at 153009 rows after the
      // HTTP latest sort was corrected; retain that evidence, not a false
      // zero-cost claim for cache reconstruction. Keep that budget unchanged
      // while durable checkpoints now include their own restoration/writes.
      // Warm phases cannot rescan H.
      const coldBudget = 4 * HISTORICAL + 4000, warmBudget = 1000;
      const aggregateBudget = coldMinutes.length * coldBudget + (MINUTES - coldMinutes.length) * warmBudget;
      const report = { scope: "Eight simulated minutes; native SqlStorage.exec includes sealed activation, JWT authentication, HTTP uploads/reads, actual alarm bodies, durable checkpoint work and EIO4 lease/pong RPCs. Excludes fixture, JWT issuance, inspection and harvest. KV/alarm API internals and platform billing unmeasured; no full-day guarantee.",
        minutes: MINUTES, seedStatuses: HISTORICAL, recentStatusMinutes: 1440, uploads: MINUTES,
        httpRequests, alarms, notificationEvaluations, pollingClients: 2, heartbeatCycles, reconnects,
        budget: { coldMinutes, coldBudget, warmBudget, aggregateBudget },
        reads: costs.reduce((sum, cost) => sum + cost.reads, 0), writes: costs.reduce((sum, cost) => sum + cost.writes, 0), costs };
      console.info(`POST14_COMBINED_BUDGET=${JSON.stringify(report)}`);
      // The unrepaired never-arriving API3 query alone scans >=384,000 rows
      // for these 32 polls. Require every new activation's expected source
      // reads and every warm phase independently, without a daily claim.
      for (const cost of costs) expect(cost.reads, `minute ${cost.minute}`)
        .toBeLessThanOrEqual(coldMinutes.includes(cost.minute) ? coldBudget : warmBudget);
      expect(report.reads).toBeLessThanOrEqual(aggregateBudget);
      expect(report.writes).toBeGreaterThan(0); expect(report.writes).toBeLessThan(10_000);
    } finally {
      phase = "inspect"; executeSpy.mockRestore(); notificationSpy.mockRestore();
      Object.assign(bindings, before); clock.mockRestore();
    }
  }, 30_000);
});
