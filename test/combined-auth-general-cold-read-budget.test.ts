import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_AUTHORIZATION_ROLES } from "../src/authorization";
import { filterDocuments, normalizeTreatmentNumbers } from "../src/documents";
import { SqliteDocumentRepository } from "../src/document-repository";
import { EntryStore, ENTRY_STORE_ACTIVATION_SEAL, entryStoreSchemaIsActivationReady, type JsonDocument } from "../src/entry-store";
import { parseEntryPayload } from "../src/model";
import { readState } from "../src/treatment-read-side-index";
import { TREATMENT_MEMBERSHIP_VIEW_KEY as MEMBER_KEY } from "../src/treatment-membership-read-view";
import worker from "../src/index";

const MINUTE = 60_000, DAY = 86_400_000;
const START = Date.parse("2026-10-18T12:00:00.000Z");
const HISTORICAL = 20_001, LONG_ROWS = 35, MINUTES = 4;
const SECRET = "synthetic-combined-secret";
const ORIGIN = "https://synthetic.invalid";
const id = (n: number) => n.toString(16).padStart(24, "0");
type Stub = ReturnType<typeof env.ENTRY_STORE.getByName>;
interface Row extends Record<string, SqlStorageValue> { id: string; body: string; sort_time: number }
interface Internal {
  completeStorageInitialization(): void;
  legacyTreatmentQueries: { get(key: string): string | undefined };
}
interface Trace { owner: SqlStorage; phase: string; sql: string; treatmentData: boolean; scope: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }
interface Cost { phase: string; reads: number; writes: number; calls: number; memberSourceReads: number;
  memberSourceCalls: number; treatmentDataReads: number; activationChecks: number; rpcBodyReads: number;
  rpcBodyWrites: number; outsideRpcReads: number; alarmReads: number;
  outsideRpcSql: { scope: string; sql: string; reads: number; writes: number }[] }
interface RequestResult<T> { body: T; cost: Cost }

function configuration(stub: Stub, diagnostics = false): Parameters<typeof worker.fetch>[1] {
  return { ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => stub }, API_SECRET: SECRET,
    // No independent public grant: this fixture can actually revoke its custom reader.
    AUTH_DEFAULT_ROLES: "", AUTH_FAIL_DELAY: "0", READ_DIAGNOSTICS: diagnostics ? "1" : "0" } as unknown as Parameters<typeof worker.fetch>[1];
}
function profile(key: string, at: number): JsonDocument {
  return { _id: key, startDate: new Date(at).toISOString(), created_at: new Date(at).toISOString(),
    defaultProfile: "Combined", units: "mg/dl", store: { Combined: { dia: 4, timezone: "UTC",
      basal: [{ time: "00:00", value: 0.6 }], carbratio: [{ time: "00:00", value: 10 }],
      sens: [{ time: "00:00", value: 50 }], target_low: [{ time: "00:00", value: 90 }],
      target_high: [{ time: "00:00", value: 120 }] } } };
}
function status(key: string, at: number, rank: number): JsonDocument {
  return { _id: key, date: at, created_at: new Date(at).toISOString(), device: "synthetic-combined-loop",
    notes: "u".repeat(8192), pump: { clock: new Date(at).toISOString(), battery: { percent: 80 }, reservoir: 50 },
    openaps: { suggested: { timestamp: new Date(at).toISOString(), IOB: rank, COB: 0,
      predBGs: Object.fromEntries(["IOB", "COB", "UAM", "ZT"].map(name => [name,
        Array.from({ length: 48 }, (_, point) => 100 + point % 30)])) } } };
}
function membershipPhase(instance: EntryStore): string {
  const serialized = (instance as unknown as Internal).legacyTreatmentQueries.get(MEMBER_KEY);
  return serialized === undefined ? "none" : serialized === "pending" || serialized === "rejected"
    ? serialized : String((JSON.parse(serialized) as unknown[])[1]);
}
async function fixture(instance: EntryStore, state: DurableObjectState): Promise<string> {
  const sql = state.storage.sql;
  expect((await instance.putEntries(parseEntryPayload([{ date: START, sgv: 120,
    type: "sgv", device: "synthetic-combined-cgm" }]))).inserted).toBe(1);
  const template = JSON.parse(sql.exec<Row>("SELECT id,body,sort_time FROM documents WHERE collection='entries' LIMIT 1").one().body) as JsonDocument;
  state.storage.transactionSync(() => {
    sql.exec("DELETE FROM documents WHERE collection='entries'");
    sql.exec("DELETE FROM entries"); // Remove the template's v1 shadow before minute zero.
    const insert = (collection: string, key: string, body: JsonDocument, at: number) => sql.exec(`INSERT INTO documents
      (collection,id,body,sort_time,created_at,updated_at,is_valid) VALUES(?,?,?,?,?,?,1)`,
    collection, key, JSON.stringify(body), at, at, at);
    for (let n = 0; n < 1000; n++) {
      const at = START - (1000 - n) * MINUTE, iso = new Date(at).toISOString();
      insert("entries", id(n), { ...template, _id: id(n), date: at, dateString: iso, sysTime: iso, sgv: 110 + n % 30 }, at);
    }
    sql.exec(`WITH RECURSIVE sequence(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM sequence WHERE n<${HISTORICAL - 1})
      INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
      SELECT 'treatments',printf('%024x',n),json_object('_id',printf('%024x',n),
        'created_at',strftime('%Y-%m-%dT%H:%M:%fZ',(?-30*86400000+n*60000)/1000.0,'unixepoch'),
        'eventType','Note','rank',n%5),?-30*86400000+n*60000,?,?,1 FROM sequence`, START, START, START, START);
    for (let n = 0; n < LONG_ROWS; n++) {
      const key = id(HISTORICAL + n), at = START - (LONG_ROWS - n) * MINUTE;
      insert("treatments", key, { _id: key, created_at: new Date(at).toISOString(), rank: n % 3,
        eventType: n >= LONG_ROWS - 2 ? [...Array<null>(1024).fill(null), "Rare"] : Array<string>(1025).fill("Note"),
        notes: `long-full-body-${n}-${"x".repeat(4096)}` }, at);
    }
    for (let n = 0; n < 128; n++) {
      const at = START - (128 - n) * MINUTE;
      insert("devicestatus", id(n), status(id(n), at, n % 5), at);
      insert("profile", id(n), profile(id(n), at), at);
    }
    for (let n = 0; n < 512; n++) {
      const at = START - (512 - n) * MINUTE;
      insert("activity", id(n), { _id: id(n), created_at: new Date(at).toISOString(),
        heartrate: 80, steps: n, activitylevel: "walking" }, at);
    }
    for (let n = 0; n < 32; n++) insert("roles", id(n), {
      _id: id(n), name: `combined-role-${n}`, permissions: [],
    }, START);
    for (const name of ["documents_treatments_created_at", "documents_treatments_event_type_created_at",
      "documents_treatments_api3_order"]) sql.exec(`DROP INDEX IF EXISTS ${name}`);
    // Execute the real optional migration against >20k treatments during setup.
    // The measured requests recover its sealed deferred schema, not day-one DDL.
    sql.exec("DELETE FROM _sql_schema_migrations WHERE id>=31 OR id=28");
    sql.exec("INSERT OR IGNORE INTO _sql_schema_migrations(id) VALUES(30)");
  });
  (instance as unknown as Internal).completeStorageInitialization();
  expect(entryStoreSchemaIsActivationReady(sql)).toBe(true);
  expect(sql.exec<{ id: number }>("SELECT id FROM _sql_schema_migrations WHERE id=?", ENTRY_STORE_ACTIVATION_SEAL).toArray()).toHaveLength(1);
  expect(sql.exec("PRAGMA index_info(documents_treatments_event_type_created_at)").toArray()).toEqual([]);
  expect(readState(sql)).toMatchObject({ complete: false, budgetRows: 0, cursor: null });
  await instance.createDocuments("roles", JSON.stringify([{ _id: id(700_000), name: "combined-reader", permissions: ["*:*:read"] }]));
  await instance.createDocuments("subjects", JSON.stringify([{ name: "combined-reader", roles: ["combined-reader"] }]));
  const subjects = JSON.parse(await instance.listDocuments("subjects")) as { name: string; accessToken: string }[];
  const subject = subjects.find(value => value.name === "combined-reader")!;
  expect(subject.accessToken).toEqual(expect.any(String));
  return (JSON.parse(await instance.issueAccessJwt(subject.accessToken)) as { token: string }).token;
}

async function original(stub: Stub, path: string): Promise<unknown> {
  return runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql, url = new URL(ORIGIN + path);
    if (path.includes("/treatments")) {
      const category = url.searchParams.get("find[eventType]")!, lower = url.searchParams.get("find[created_at][$gte]")!;
      const direction = Number(url.searchParams.get("sort[rank]")) === 1 ? "ASC" : "DESC";
      const order = url.searchParams.has("sort[rank]")
        ? `json_extract(body,'$.rank') ${direction},id ${direction}` : "json_extract(body,'$.created_at') DESC,id ASC";
      // The locked v1 parser consumes count/sort but ignores URL skip.
      // Keep OFFSET 0; repository/API3 pagination is a different contract.
      const rows = sql.exec<Row>(`SELECT * FROM documents WHERE collection='treatments' AND json_valid(body)
        AND json_extract(body,'$.created_at')>=? AND ((json_type(body,'$.eventType')='text' AND json_extract(body,'$.eventType')=?)
          OR (json_type(body,'$.eventType')='array' AND EXISTS(SELECT 1 FROM json_each(body,'$.eventType') AS item
            WHERE item.type='text' AND item.value=?))) ORDER BY ${order} LIMIT ? OFFSET ?`,
      lower, category, category, Number(url.searchParams.get("count") ?? 1), 0)
        .toArray();
      // Keep selection independent; reuse only the public legacy materializer
      // so added null/default fields and numeric normalization match the wire.
      const renderer = new SqliteDocumentRepository(state.storage);
      (renderer as unknown as { queryTreatmentRows(): Row[] }).queryTreatmentRows = () => rows;
      return JSON.parse(JSON.stringify(normalizeTreatmentNumbers(renderer.queryLegacyTreatments({
        limit: Number(url.searchParams.get("count") ?? 1), skip: 0,
      }))));
    }
    if (path.includes("/profile/current")) return sql.exec<Row>(`SELECT id,body,sort_time FROM documents WHERE collection='profile'
      ORDER BY CASE WHEN json_valid(body) THEN json_extract(body,'$.startDate') ELSE NULL END DESC,id DESC LIMIT 1`)
      .toArray().map(row => ({ ...JSON.parse(row.body) as JsonDocument, _id: row.id }))[0] ?? null;
    const collection = path.includes("/activity") ? "activity" : path.includes("/authorization/roles") ? "roles" : "devicestatus";
    const documents: JsonDocument[] = sql.exec<Row>(`SELECT id,body,sort_time FROM documents WHERE collection=?
      ORDER BY sort_time DESC,updated_at DESC LIMIT 5000`, collection).toArray()
      .map(row => ({ ...JSON.parse(row.body) as JsonDocument, _id: row.id }));
    if (collection !== "roles") return filterDocuments(documents, url, collection === "activity" ? 5000 : 10);
    const names = new Set(documents.map(row => row.name));
    return [...documents, ...BUILTIN_AUTHORIZATION_ROLES.filter(role => !names.has(role.name)).map(role => ({
      name: role.name, permissions: [...role.permissions],
    }))].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  });
}

describe("combined authorization, ordinary readers and sealed recovery budget", () => {
  it("keeps the same four-minute uploads and reads fresh while properties share deferred membership across two cold activations", async () => {
    const probe = env.ENTRY_STORE.getByName(`combined-prototype-${crypto.randomUUID()}`);
    let nativeOwner: Pick<SqlStorage, "exec"> | undefined, nativeExec: SqlStorage["exec"] | undefined;
    await runInDurableObject(probe, (_instance, state) => {
      let owner: object | null = state.storage.sql;
      while (owner !== null && !Object.hasOwn(owner, "exec")) owner = Object.getPrototypeOf(owner) as object | null;
      expect(owner !== null && owner !== state.storage.sql).toBe(true);
      const descriptor = Object.getOwnPropertyDescriptor(owner!, "exec")!;
      expect(typeof descriptor.value).toBe("function");
      nativeOwner = owner as Pick<SqlStorage, "exec">; nativeExec = descriptor.value as SqlStorage["exec"];
    });
    const stub = env.ENTRY_STORE.getByName(`combined-business-${crypto.randomUUID()}`);
    let now = START, phase = "fixture", harvesting = false, harvestSqlCalls = 0;
    const traces: Trace[] = [], costs: Cost[] = [];
    // Independent test-owned scope: never import the diagnostic collector's ALS.
    const scopes = new AsyncLocalStorage<{ kind: "rpc" | "alarm"; open: boolean }>();
    const originalDiagnostic = EntryStore.prototype.diagnosticRead;
    const diagnosticSpy = vi.spyOn(EntryStore.prototype, "diagnosticRead").mockImplementation(function (this: EntryStore, operation, args, traceId) {
      const scope = { kind: "rpc" as const, open: true };
      return scopes.run(scope, async () => {
        try { return await Reflect.apply(originalDiagnostic, this, [operation, args, traceId]); }
        finally { scope.open = false; }
      });
    });
    const originalAlarm = EntryStore.prototype.alarm;
    const alarmSpy = vi.spyOn(EntryStore.prototype, "alarm").mockImplementation(function (this: EntryStore) {
      const parent = scopes.getStore();
      // An explicitly awaited alarm inside a measured RPC remains RPC work.
      if (parent?.kind === "rpc" && parent.open) return Reflect.apply(originalAlarm, this, []);
      const scope = { kind: "alarm" as const, open: true };
      return scopes.run(scope, async () => {
        try { return await Reflect.apply(originalAlarm, this, []); }
        finally { scope.open = false; }
      });
    });
    const executeSpy = vi.spyOn(nativeOwner!, "exec").mockImplementation(function (this: SqlStorage, statement, ...bindings) {
      const cursor = Reflect.apply(nativeExec!, this, [statement, ...bindings]) as SqlStorageCursor<Record<string, SqlStorageValue>>;
      if (harvesting) harvestSqlCalls++;
      const active = scopes.getStore();
      const scope = active?.kind === "rpc" ? active.open ? "rpc" : "post-rpc-async" : active?.kind === "alarm" ? "alarm" : "outside";
      if (phase !== "fixture" && (phase !== "inspect" || scope === "alarm" || scope === "post-rpc-async")) traces.push({ owner: this, phase, sql: statement, scope,
        treatmentData: statement.includes("FROM documents")
          && (/collection\s*=\s*'treatments'/.test(statement) || bindings[0] === "treatments"), cursor });
      return cursor;
    });
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const harvest = async (label: string): Promise<Cost> => {
      phase = "inspect";
      const cost = await runInDurableObject(stub, (_instance, state) => {
        harvesting = true;
        try {
          const rows = traces.filter(row => row.owner === state.storage.sql);
          const members = rows.filter(row => row.sql.includes(" AS valid_json") && row.sql.includes("FROM documents")
            && /collection\s*=\s*'treatments'/.test(row.sql));
          const treatment = rows.filter(row => row.treatmentData);
          return { phase: label, calls: rows.length, reads: rows.reduce((sum, row) => sum + row.cursor.rowsRead, 0),
            writes: rows.reduce((sum, row) => sum + row.cursor.rowsWritten, 0),
            memberSourceCalls: members.length, memberSourceReads: members.reduce((sum, row) => sum + row.cursor.rowsRead, 0),
            treatmentDataReads: treatment.reduce((sum, row) => sum + row.cursor.rowsRead, 0),
            activationChecks: rows.filter(row => row.sql.includes("_sql_schema_migrations")).length,
            rpcBodyReads: rows.filter(row => row.scope === "rpc").reduce((sum, row) => sum + row.cursor.rowsRead, 0),
            rpcBodyWrites: rows.filter(row => row.scope === "rpc").reduce((sum, row) => sum + row.cursor.rowsWritten, 0),
            outsideRpcReads: rows.filter(row => row.scope !== "rpc").reduce((sum, row) => sum + row.cursor.rowsRead, 0),
            alarmReads: rows.filter(row => row.scope === "alarm").reduce((sum, row) => sum + row.cursor.rowsRead, 0),
            outsideRpcSql: label.startsWith("diagnostic-on-") ? rows.filter(row => row.scope !== "rpc").map(row => ({
              scope: row.scope, sql: row.sql.replace(/\s+/g, " ").trim(), reads: row.cursor.rowsRead, writes: row.cursor.rowsWritten,
            })) : [] };
        } finally { traces.length = 0; harvesting = false; }
      });
      expect(harvestSqlCalls).toBe(0); costs.push(cost); return cost;
    };
    let requests = 0;
    const send = async <T>(label: string, path: string, headers: HeadersInit, payload?: unknown, expectedStatus = 200, diagnostics = false): Promise<RequestResult<T>> => {
      phase = label;
      const requestHeaders = new Headers(headers);
      if (payload !== undefined) requestHeaders.set("Content-Type", "application/json");
      const response = await worker.fetch(new Request(ORIGIN + path, { method: payload === undefined ? "GET" : "POST",
        headers: requestHeaders,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }), configuration(stub, diagnostics));
      const body = await response.json<T>(); requests++;
      const cost = await harvest(label);
      expect(response.status, label).toBe(expectedStatus); return { body, cost };
    };
    const inspect = async <T>(action: (instance: EntryStore, state: DurableObjectState) => T | Promise<T>) => {
      phase = "inspect"; return runInDurableObject(stub, action);
    };
    const oracle = async (path: string) => { phase = "inspect"; return original(stub, path); };
    const treatmentPath = (category: string, limit = 1, skip = 0, rank?: number) => {
      const params = new URLSearchParams({ "find[eventType]": category, "find[created_at][$gte]": new Date(now - 4 * DAY).toISOString(),
        count: String(limit), skip: String(skip) });
      if (rank !== undefined) params.set("sort[rank]", String(rank));
      return `/api/v1/treatments.json?${params}`;
    };
    try {
      const jwt = await runInDurableObject(stub, (instance: EntryStore, state) => fixture(instance, state));
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(SECRET))),
        byte => byte.toString(16).padStart(2, "0")).join("");
      const admin = { "api-secret": digest }, reader = { Authorization: `Bearer ${jwt}` };
      const transitions: { minute: number; afterProperties: string; phases: string[] }[] = [];
      let correction = 0;
      for (let minute = 0; minute < MINUTES; minute++) {
        now = START + minute * MINUTE;
        if (minute % 2 === 0) {
          phase = "inspect"; await evictDurableObject(stub);
          const verified = await send<{ message: { canRead: boolean; canWrite: boolean; isAdmin: boolean } }>(
            `cold-${minute / 2}-auth`, "/api/v1/verifyauth", reader);
          expect(verified.body.message).toMatchObject({ canRead: true, canWrite: false, isAdmin: false });
          expect(verified.cost.activationChecks).toBeGreaterThan(0);
          expect(await inspect((instance: EntryStore) => membershipPhase(instance))).toBe("none");
        }
        const at = now, glucose = 150 + minute;
        const entry = { _id: id(600_000 + minute), date: at, dateString: new Date(at).toISOString(),
          sgv: glucose, type: "sgv", device: "synthetic-combined-cgm" };
        await send(`upload-sgv-${minute}`, "/api/v1/entries", admin, [entry]);
        if (minute === 1) {
          await send(`correct-sgv-${minute}`, "/api/v1/entries", admin, [{ ...entry, sgv: glucose + 1 }]); correction++;
        }
        await send(`upload-status-${minute}`, "/api/v1/devicestatus", admin, [status(id(600_100 + minute), at, minute % 5)]);
        await send(`upload-treatment-${minute}`, "/api/v1/treatments", admin, [{ _id: id(600_200 + minute),
          eventType: "Note", created_at: new Date(at).toISOString(), rank: minute, notes: "live combined note" }]);
        await send(`upload-activity-${minute}`, "/api/v1/activity", admin, [{ _id: id(600_300 + minute),
          created_at: new Date(at).toISOString(), heartrate: 85, steps: 100 + minute, activitylevel: "walking" }]);
        if (minute === 1) await send("move-old-id-behind-partial", "/api/v1/treatments", admin, [{ _id: id(0),
          eventType: Array<string>(1025).fill("Rare"), created_at: new Date(at).toISOString(), rank: 9, notes: "updated historical body" }]);
        if (minute === 2) await send("new-current-profile", "/api/v1/profile", admin, [profile(id(600_400), at)]);
        now = at + 1000;
        const entries = await send<JsonDocument[]>(`read-latest-sgv-${minute}`, "/api/v1/entries.json?count=1", reader);
        expect(entries.body[0]).toMatchObject({ _id: id(600_000 + minute), sgv: glucose + (minute === 1 ? 1 : 0), date: at });
        const properties = await send<{ bgnow: { last: number; mills: number } }>(`read-properties-${minute}`, "/api/v2/properties", reader);
        expect(properties.body.bgnow).toMatchObject({ last: glucose + (minute === 1 ? 1 : 0), mills: at });
        const afterProperties = await inspect((instance: EntryStore) => membershipPhase(instance));
        expect(afterProperties).toBe("complete");
        if (minute % 2 === 1) expect(properties.cost.reads).toBeLessThan(2000);
        for (const path of ["/api/v1/profile/current.json", "/api/v1/activity.json?count=3", "/api/v2/authorization/roles",
          "/api/v1/devicestatus.json?find[openaps.suggested.IOB][$gte]=0&sort[openaps.suggested.IOB]=-1&count=3"]) {
          const expected = await oracle(path);
          const actual = await send<unknown>(`ordinary-${minute}-${path.split("?")[0]}`, path, path.includes("authorization/roles") ? admin : reader);
          expect(actual.body).toEqual(expected);
        }
        const latestStatus = await send<JsonDocument[]>(`latest-status-${minute}`, "/api/v1/devicestatus.json?count=1", reader);
        expect(latestStatus.body[0]).toMatchObject({ _id: id(600_100 + minute), date: at, notes: "u".repeat(8192) });

        const phases: string[] = [];
        // Preserve the three requests actually issued per minute in the frozen
        // before run, even though properties now finish the shared proof first.
        const maxLearningRequests = 3;
        for (let step = 0; step < maxLearningRequests; step++) {
          const path = treatmentPath(`Missing-${minute}-${step}`);
          const expected = await oracle(path);
          const actual = await send<unknown[]>(`learn-${minute}-${step}`, path, reader);
          expect(actual.body).toEqual(expected); expect(actual.body).toEqual([]);
          expect(actual.cost.memberSourceCalls).toBe(0); expect(actual.cost.treatmentDataReads).toBe(0);
          phases.push(await inspect((instance: EntryStore) => membershipPhase(instance)));
        }
        const memberPhase = await inspect((instance: EntryStore) => membershipPhase(instance));
        expect(memberPhase).toBe("complete");
        transitions.push({ minute, afterProperties, phases });
        if (minute % 2 === 1) {
          const path = treatmentPath(`Warm-different-missing-${minute}`, 3, 2);
          const warm = await send<unknown[]>(`warm-empty-${minute}`, path, reader);
          expect(warm.body).toEqual([]); expect(warm.cost.memberSourceCalls).toBe(0);
          expect(warm.cost.treatmentDataReads).toBe(0); // Auth/side-state reads remain counted globally.
        }
        const path = treatmentPath("Rare", 2, minute % 2, minute % 2 ? 1 : -1);
        const expected = await oracle(path);
        const sorted = await send<unknown[]>(`custom-sort-${minute}`, path, reader);
        expect(sorted.body).toEqual(expected);
        if (minute === 0) {
          const wrong = await send<{ message: { message: string; isAdmin: boolean } }>("independent-wrong-candidate",
            "/api/v1/verifyauth", { "api-secret": "0".repeat(40) });
          expect(wrong.body.message).toMatchObject({ message: "UNAUTHORIZED", isAdmin: false });
          await send("reader-cannot-create-status", "/api/v1/devicestatus", reader, [{ date: at }], 401);
          const valid = await send<{ message: { message: string; isAdmin: boolean } }>("independent-admin-candidate", "/api/v1/verifyauth", admin);
          expect(valid.body.message).toMatchObject({ message: "OK", isAdmin: true });
        }
        if (minute === 2) {
          for (const revoke of [true, false]) {
            phase = revoke ? "role-revoke" : "role-restore";
            await runInDurableObject(stub, (instance: EntryStore) => instance.saveDocuments("roles", JSON.stringify([{
              _id: id(700_000), name: "combined-reader", permissions: revoke ? [] : ["*:*:read"],
            }])));
            await harvest(revoke ? "role-revoke" : "role-restore");
            const storedRole = await inspect((_instance, state) => JSON.parse(state.storage.sql.exec<Row>(
              "SELECT id,body,sort_time FROM documents WHERE collection='roles' AND id=?", id(700_000)).one().body) as JsonDocument);
            expect(storedRole.permissions).toEqual(revoke ? [] : ["*:*:read"]);
            const checked = await send<{ message: { canRead: boolean; isAdmin: boolean } }>(revoke ? "revoked-jwt" : "restored-jwt", "/api/v1/verifyauth", reader);
            expect(checked.body.message).toMatchObject({ canRead: !revoke, isAdmin: false });
            if (revoke) await send("revoked-reader-denied", "/api/v1/entries.json?count=1", reader, undefined, 401);
          }
        }
      }
      // Compare only additional warm reads in this same seeded activation;
      // the four-minute workload is not repeated for diagnostic timing.
      interface DiagnosticRecord { event: string; route: string; scope: string; complete: boolean;
        rowsRead: number; rowsWritten: number; unmeasuredRpcCalls: number; pendingRpcCalls: number;
        failedRpcCalls: number; operations: { measurement: { complete: boolean } }[] }
      const diagnosticRecords: DiagnosticRecord[] = [];
      const diagnosticParity: { route: string; nativeOffReads: number; nativeOnReads: number;
        nativeWrites: number; reportedReads: number; reportedWrites: number; complete: boolean; scope: string;
        nativeRpcReads: number; outsideRpcReads: number; alarmReads: number }[] = [];
      const infoSpy = vi.spyOn(console, "info").mockImplementation(message => {
        if (typeof message !== "string") return;
        try {
          const record = JSON.parse(message) as DiagnosticRecord;
          if (record.event === "nscf_read_request") diagnosticRecords.push(record);
        } catch { /* Other console output is not a diagnostic record. */ }
      });
      try {
        const paths = ["/api/v1/profile/current.json", "/api/v1/activity.json?count=3", "/api/v2/authorization/roles",
          treatmentPath("Rare", 1, 0, -1)];
        for (const [index, path] of paths.entries()) {
          const headers = path.includes("authorization/roles") ? admin : reader;
          const expected = await oracle(path);
          const off = await send<unknown>(`diagnostic-off-${index}`, path, headers);
          const on = await send<unknown>(`diagnostic-on-${index}`, path, headers, undefined, 200, true);
          expect(off.body).toEqual(expected); expect(on.body).toEqual(off.body);
          expect(off.cost.writes).toBe(0); expect(on.cost.writes).toBe(off.cost.writes);
          expect(diagnosticRecords).toHaveLength(index + 1);
          const measured = diagnosticRecords[index]!;
          expect(measured.scope).toBe("awaited-rpc-bodies-excludes-activation-and-background");
          expect(measured.rowsWritten).toBe(0);
          expect(typeof measured.complete).toBe("boolean");
          // Full native cost still includes concurrent alarm/maintenance. Only
          // independently scoped awaited RPC-body work is comparable here.
          if (on.cost.outsideRpcReads > 0) console.warn(`COMBINED_PARITY_NATIVE_DETAIL=${JSON.stringify({
            route: measured.route, fullReads: on.cost.reads, rpcReads: on.cost.rpcBodyReads,
            reportedReads: measured.rowsRead, outsideRpcReads: on.cost.outsideRpcReads,
            alarmReads: on.cost.alarmReads, sql: on.cost.outsideRpcSql,
          })}`);
          if (measured.complete) {
            expect(measured.rowsRead).toBe(on.cost.rpcBodyReads);
            expect(measured.rowsWritten).toBe(on.cost.rpcBodyWrites);
          }
          else expect(measured.unmeasuredRpcCalls > 0 || measured.pendingRpcCalls > 0 || measured.failedRpcCalls > 0
            || measured.operations.some(operation => !operation.measurement.complete)).toBe(true);
          if (path.includes("treatments")) expect((on.body as JsonDocument[])[0]).toMatchObject({
            _id: id(0), rank: 9, notes: "updated historical body", created_at: new Date(START + MINUTE).toISOString(),
          });
          diagnosticParity.push({ route: measured.route, nativeOffReads: off.cost.reads, nativeOnReads: on.cost.reads,
            nativeWrites: on.cost.writes, reportedReads: measured.rowsRead, reportedWrites: measured.rowsWritten,
            complete: measured.complete, scope: measured.scope, nativeRpcReads: on.cost.rpcBodyReads,
            outsideRpcReads: on.cost.outsideRpcReads, alarmReads: on.cost.alarmReads });
        }
        const encodedDiagnostics = JSON.stringify(diagnosticRecords);
        for (const secret of [SECRET, digest, jwt, "updated historical body", '"body"', '"bindings"', '"sgv"']) {
          expect(encodedDiagnostics).not.toContain(secret);
        }
      } finally { infoSpy.mockRestore(); }
      const final = await inspect((_instance, state) => ({ counts: state.storage.sql.exec<{ collection: string; count: number }>(
        "SELECT collection,COUNT(*) AS count FROM documents WHERE collection IN ('entries','devicestatus','treatments','profile','activity','roles') GROUP BY collection").toArray(),
      progress: readState(state.storage.sql), oldId: state.storage.sql.exec<Row>("SELECT id,body,sort_time FROM documents WHERE collection='treatments' AND id=?", id(0)).one() }));
      expect(final.counts).toEqual([{ collection: "activity", count: 516 }, { collection: "devicestatus", count: 132 },
        { collection: "entries", count: 1004 }, { collection: "profile", count: 129 }, { collection: "roles", count: 33 },
        { collection: "treatments", count: HISTORICAL + LONG_ROWS + MINUTES }]);
      expect(JSON.parse(final.oldId.body)).toMatchObject({ notes: "updated historical body", rank: 9 });
      expect(final.progress).toMatchObject({ complete: false, budgetRows: 4 * 64 });
      await harvest("tail-background");
      const reads = costs.reduce((sum, cost) => sum + cost.reads, 0), writes = costs.reduce((sum, cost) => sum + cost.writes, 0);
      const report = { scope: "Four simulated minutes, two true sealed recoveries; all intercepted SQL includes constructors, HTTP authentication, uploads and optional side maintenance. Fixture/enrollment/JWT creation, native result oracles and zero-SQL counter harvest excluded; KV/internal platform work outside SqlStorage.exec unmeasured.",
        minutes: MINUTES, evictions: 2, requests, glucoseUploads: 4, glucoseCorrections: correction, statusUploads: 4,
        treatmentCreates: 4, treatmentHistoricalUpdates: 1, activityUploads: 4, profileCreates: 1, reads, writes,
        sideBudgetRows: final.progress?.budgetRows, transitions, diagnosticParity, costs };
      console.info(`COMBINED_AUTH_GENERAL_COLD=${JSON.stringify(report)}`);
      expect(costs.filter(cost => cost.phase.startsWith("cold-")).reduce((sum, cost) => sum + cost.activationChecks, 0)).toBeGreaterThanOrEqual(2);
      expect(costs.filter(cost => cost.phase.startsWith("read-properties-")).some(cost => cost.memberSourceReads >= 5000)).toBe(true);
      expect(requests).toBe(81); expect(reads).toBeLessThan(1_500_000); expect(writes).toBeLessThan(5000);
      expect(writes).toBeGreaterThan(0); // Real uploads and previously approved side maintenance are included.
      expect(correction).toBe(1); expect(harvestSqlCalls).toBe(0);
    } finally { clock.mockRestore(); alarmSpy.mockRestore(); diagnosticSpy.mockRestore(); executeSpy.mockRestore(); }
  }, 60_000);
});
