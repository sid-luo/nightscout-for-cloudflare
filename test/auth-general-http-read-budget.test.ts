import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_AUTHORIZATION_ROLES } from "../src/authorization";
import { filterDocuments } from "../src/documents";
import type { EntryStore, JsonDocument } from "../src/entry-store";
import worker from "../src/index";

const ORIGIN = "https://synthetic.invalid";
const SECRET = "synthetic-ordinary-read-secret";
const AT = Date.parse("2026-10-18T12:00:00.000Z");
const id = (n: number) => n.toString(16).padStart(24, "0");
const PROFILE_ORDER = "CASE WHEN json_valid(body) THEN json_extract(body, '$.startDate') ELSE NULL END DESC, id DESC";
type Collection = "profile" | "activity" | "roles";
function seed(storage: DurableObjectStorage, collection: Collection, count: number, large = false): void {
  storage.transactionSync(() => {
    for (let n = 0; n < count; n++) {
      let document: JsonDocument;
      if (collection === "profile") {
        const start = [new Date(AT + n * 1000).toISOString(), AT + n, null, undefined, "", ["array", n], { rank: n }, true][n % 8];
        document = { _id: id(n), defaultProfile: "Default", created_at: new Date(AT + n * 1000).toISOString(),
          ...(start === undefined ? {} : { startDate: start }), store: { Default: { units: "mg/dl", basal: [{ time: "00:00", value: 1 }] } } };
      } else if (collection === "activity") {
        document = { _id: id(n), created_at: new Date(AT + n * 1000).toISOString(), heartrate: n % 2 ? 80 : "80",
          steps: n % 11, activitylevel: n % 3 ? "walk" : ["walk", "run"], checks: [{ value: n % 2 }, { value: 8 }],
          ...(n === 0 ? { onlyOldest: "yes" } : {}) };
      } else {
        document = { _id: id(n), name: n === count - 1 ? "synthetic-reader" : n < 2 ? "duplicate" : `role-${n}`,
          permissions: n === count - 1 ? ["*:*:read"] : n % 3 ? "api:profile:read" : ["api:activity:read", 7, null],
          created_at: new Date(AT + n * 1000).toISOString() };
      }
      if (large && n === count - 1) document.largeField = "x".repeat(96 * 1024);
      storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`, collection, id(n), JSON.stringify(document), AT + n * 1000, AT, AT + n * 1000);
    }
  });
}
function original(sql: SqlStorage, collection: Collection): JsonDocument[] {
  return sql.exec<{ body: string }>(`SELECT body FROM documents WHERE collection=?
    ORDER BY ${collection === "profile" ? PROFILE_ORDER : "sort_time DESC, updated_at DESC"} LIMIT 5000`, collection)
    .toArray().map(row => JSON.parse(row.body) as JsonDocument);
}
function mergedRoles(stored: JsonDocument[]): JsonDocument[] {
  const names = new Set(stored.map(role => role.name).filter((name): name is string => typeof name === "string"));
  return [...stored, ...BUILTIN_AUTHORIZATION_ROLES.filter(role => !names.has(role.name))
    .map(role => ({ name: role.name, permissions: [...role.permissions] }))]
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}
function configuration(instance: EntryStore, rpc: string[], defaults = "readable"): Parameters<typeof worker.fetch>[1] {
  const forward = new Proxy(instance, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      rpc.push(String(property) + (property === "listDocuments" ? `:${String(args[0])}` : ""));
      return value.apply(target, args);
    };
  } });
  return { ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => forward },
    API_SECRET: SECRET, AUTH_DEFAULT_ROLES: defaults, AUTH_FAIL_DELAY: "0" } as unknown as Parameters<typeof worker.fetch>[1];
}
async function digest(): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(SECRET)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
async function measured(storage: DurableObjectStorage, instance: EntryStore, path: string, admin = false, defaults = "readable",
  headers: Record<string, string> = {}) {
  const rpc: string[] = [], configured = configuration(instance, rpc, defaults);
  const request = new Request(`${ORIGIN}${path}`, { headers: { ...headers, ...(admin ? { "api-secret": await digest() } : {}) } });
  const execute = storage.sql.exec.bind(storage.sql);
  const queries: { sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(storage.sql, "exec").mockImplementation((sql, ...bindings) => {
    const cursor = execute(sql, ...bindings); queries.push({ sql, cursor }); return cursor;
  });
  try {
    const response = await worker.fetch(request, configured), body = await response.json();
    return { status: response.status, body, lastModified: response.headers.get("Last-Modified"), rpc,
      reads: queries.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: queries.reduce((sum, item) => sum + item.cursor.rowsWritten, 0),
      queries: queries.map(item => ({ sql: item.sql.replace(/\s+/g, " ").trim(), reads: item.cursor.rowsRead, writes: item.cursor.rowsWritten })) };
  } finally { spy.mockRestore(); }
}
function metrics(sample: Awaited<ReturnType<typeof measured>>) {
  return { status: sample.status, reads: sample.reads, writes: sample.writes, rpc: sample.rpc,
    returned: Array.isArray(sample.body) ? sample.body.length : sample.body === null ? 0 : 1,
    queries: sample.queries };
}
function clearFixtureCaches(instance: EntryStore, collection: Collection): void {
  (instance as unknown as { invalidateAuxiliaryQueries(collection: string): void }).invalidateAuxiliaryQueries(collection);
}

describe("ordinary profile/activity/roles full HTTP handler read costs", () => {
  it("measures Profile/current and singular/plural lists with original mixed-type startDate ordering", async () => {
    const reports = [];
    for (const count of [32, 6001]) reports.push(await runInDurableObject(
      env.ENTRY_STORE.getByName(`ordinary-profile-${count}-${crypto.randomUUID()}`), async (instance, state) => {
        seed(state.storage, "profile", count, true); clearFixtureCaches(instance, "profile");
        const all = original(state.storage.sql, "profile"), samples = [];
        for (const path of ["/api/v1/profile/current", "/api/v1/profile/current?count=0",
          "/api/v1/profile.json?count=3", "/api/v1/profiles.json?find[defaultProfile]=Default&sort[startDate]=-1&count=3"]) {
          const sample = await measured(state.storage, instance, path);
          const expected = path.includes("/current") ? all[0] ?? null : path.includes("/profiles")
            ? filterDocuments(all, new URL(`${ORIGIN}${path}`), 10) : all.slice(0, 3);
          expect(sample.status).toBe(200); expect(sample.body).toEqual(expected); expect(sample.writes).toBe(0);
          samples.push({ path, ...metrics(sample) });
        }
        return { sourceRows: count, originalWindowRows: all.length, samples };
      }));
    console.info(`ORDINARY_PROFILE_HTTP=${JSON.stringify(reports)}`);
  }, 60_000);

  it("measures simple Activity and preserves the full 5000-row JS filter/sort candidate window", async () => {
    const reports = [];
    for (const count of [32, 6001]) reports.push(await runInDurableObject(
      env.ENTRY_STORE.getByName(`ordinary-activity-${count}-${crypto.randomUUID()}`), async (instance, state) => {
        seed(state.storage, "activity", count, true); clearFixtureCaches(instance, "activity");
        const all = original(state.storage.sql, "activity"), samples = [];
        for (const path of ["/api/v1/activity.json?count=5", "/api/v1/activity.json?count=7",
          "/api/v1/activity.json?find[checks.value]=8&count=5",
          "/api/v1/activity.json?sort[heartrate]=1&count=5",
          "/api/v1/activity.json?find[onlyOldest]=yes&count=1"]) {
          const sample = await measured(state.storage, instance, path);
          expect(sample.status).toBe(200);
          expect(sample.body).toEqual(filterDocuments(all, new URL(`${ORIGIN}${path}`), 5000));
          expect(sample.writes).toBe(0); expect(sample.lastModified === null || Number.isFinite(Date.parse(sample.lastModified))).toBe(true);
          samples.push({ path, ...metrics(sample) });
        }
        return { sourceRows: count, originalWindowRows: all.length, samples };
      }));
    console.info(`ORDINARY_ACTIVITY_HTTP=${JSON.stringify(reports)}`);
  }, 60_000);

  it("measures repeated wide-role defaults and preserves the full public stored+builtin role list", async () => {
    const reports = [];
    for (const count of [32, 6001]) reports.push(await runInDurableObject(
      env.ENTRY_STORE.getByName(`ordinary-roles-${count}-${crypto.randomUUID()}`), async (instance, state) => {
        seed(state.storage, "roles", count, true); clearFixtureCaches(instance, "roles");
        const stored = original(state.storage.sql, "roles"), expected = mergedRoles(stored), samples = [];
        for (let repeat = 0; repeat < 3; repeat++) {
          const authorized = await measured(state.storage, instance, `/api/v1/activity.json?count=${repeat + 1}`, false, "synthetic-reader");
          expect(authorized.status).toBe(200); expect(authorized.body).toEqual([]); expect(authorized.writes).toBe(0);
          const listed = await measured(state.storage, instance, "/api/v2/authorization/roles", true);
          expect(listed.status).toBe(200); expect(listed.body).toEqual(expected); expect(listed.writes).toBe(0);
          samples.push({ repeat, defaults: metrics(authorized), fullRoleList: metrics(listed) });
        }
        return { sourceRows: count, originalWindowRows: stored.length,
          serializedWindowBytes: 2 * JSON.stringify(stored).length, publicListRows: expected.length, samples };
      }));
    console.info(`ORDINARY_ROLES_HTTP=${JSON.stringify(reports)}`);
  }, 60_000);

  it("records existing malformed-row and count error precedence before any new query-aware shortcut", async () => {
    const reports = [];
    for (const collection of ["profile", "activity", "roles"] as const) reports.push(await runInDurableObject(
      env.ENTRY_STORE.getByName(`ordinary-errors-${collection}-${crypto.randomUUID()}`), async (instance, state) => {
        seed(state.storage, collection, 8);
        state.storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
          VALUES(?,?,'{broken',?,?,?)`, collection, id(999), AT - 1000, AT, AT);
        clearFixtureCaches(instance, collection);
        const path = collection === "profile" ? "/api/v1/profile/current" : collection === "activity"
          ? "/api/v1/activity.json?count=1" : "/api/v2/authorization/roles";
        const sample = await measured(state.storage, instance, path, true);
        expect(sample.status).toBe(500); expect(sample.writes).toBe(0);
        return { collection, path, ...metrics(sample) };
      }));
    console.info(`ORDINARY_MALFORMED_HTTP=${JSON.stringify(reports)}`);
  });
});
