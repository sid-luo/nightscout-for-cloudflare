import { env } from "cloudflare:workers";
import {
  SELF,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  matchApi3FoodRoute,
  matchApi3SettingsRoute,
} from "../src/api3/treatments";
import { ENTRY_STORE_ACTIVATION_SEAL, type EntryStore } from "../src/entry-store";

/**
 * Differential contract sources, locked to Nightscout v15.0.7 commit
 * 7e0e77f88fc113a76fe363504125f5b36b8a3fe3:
 * - lib/api3/generic/{create,read,search,update,patch,delete,history}
 * - lib/api3/generic/setup.js (Food created_at-only fallback; Settings none)
 * - lib/api3/generic/{search,history}/operation.js (Settings admin permission)
 * - lib/api3/specific/lastModified.js
 * - lib/server/food.js and lib/api/food/index.js
 */

const TEST_API_SECRET = "nscf-test-secret-20260717";

type JsonObject = Record<string, unknown>;

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function secretDigest(): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(TEST_API_SECRET),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function withTenant(path: string, tenantName: string): string {
  return `https://example.test${path}${path.includes("?") ? "&" : "?"}tenant=${tenantName}`;
}

async function adminWrite(
  tenantName: string,
  path: string,
  payload: unknown,
): Promise<Response> {
  return SELF.fetch(withTenant(path, tenantName), {
    method: "POST",
    headers: {
      "api-secret": await secretDigest(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function issueSubject(
  tenantName: string,
  subjectName: string,
  permissions: string[],
): Promise<string> {
  const roleName = `role-${crypto.randomUUID().slice(0, 8)}`;
  expect((await adminWrite(tenantName, "/api/v2/authorization/roles", {
    name: roleName,
    permissions,
  })).status).toBe(200);
  const createdResponse = await adminWrite(
    tenantName,
    "/api/v2/authorization/subjects",
    { name: subjectName, roles: [roleName] },
  );
  expect(createdResponse.status).toBe(200);
  const created = await createdResponse.json<JsonObject>();
  const subjectsResponse = await SELF.fetch(withTenant(
    "/api/v2/authorization/subjects",
    tenantName,
  ), {
    headers: { "api-secret": await secretDigest() },
  });
  expect(subjectsResponse.status).toBe(200);
  const subject = (await subjectsResponse.json<JsonObject[]>()).find(
    (candidate) => candidate._id === created._id,
  );
  expect(subject?.accessToken).toEqual(expect.any(String));
  const authorization = await SELF.fetch(withTenant(
    `/api/v2/authorization/request/${encodeURIComponent(String(subject?.accessToken))}`,
    tenantName,
  ));
  expect(authorization.status).toBe(200);
  return String((await authorization.json<JsonObject>()).token);
}

function api3Fetch(
  tenantName: string,
  jwt: string | null,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (jwt !== null) headers.set("Authorization", `Bearer ${jwt}`);
  return SELF.fetch(withTenant(path, tenantName), { ...init, headers });
}

function jsonMutation(
  method: "POST" | "PUT" | "PATCH",
  body: unknown,
): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function result<T = unknown>(response: Response): Promise<T> {
  const body = await response.json<{ status: number; result: T }>();
  expect(body.status).toBe(200);
  return body.result;
}

function food(identifier: string, date: number, extra: JsonObject = {}): JsonObject {
  return {
    identifier,
    date,
    created_at: new Date(date).toISOString(),
    utcOffset: 0,
    app: "api3-food-test",
    device: "family-food-editor",
    type: "food",
    name: "Rice",
    category: "Meal",
    portion: 100,
    carbs: 28,
    ...extra,
  };
}

function settings(identifier: string, date: number, extra: JsonObject = {}): JsonObject {
  return {
    identifier,
    date,
    created_at: new Date(date).toISOString(),
    utcOffset: 0,
    app: "AAPS",
    device: "family-phone",
    units: "mg/dl",
    language: "zh_CN",
    ...extra,
  };
}

describe("API v3 Food and Settings verticals", () => {
  it("matches the eight locked generic routes for both collections", () => {
    for (const [matcher, collection] of [
      [matchApi3FoodRoute, "food"],
      [matchApi3SettingsRoute, "settings"],
    ] as const) {
      const routes = [
        ["GET", `/api/v3/${collection}`, "collection"],
        ["POST", `/api/v3/${collection}`, "collection"],
        ["GET", `/api/v3/${collection}/client-id`, "resource"],
        ["PUT", `/api/v3/${collection}/client-id`, "resource"],
        ["PATCH", `/api/v3/${collection}/client-id`, "resource"],
        ["DELETE", `/api/v3/${collection}/client-id`, "resource"],
        ["GET", `/api/v3/${collection}/history`, "history"],
        ["GET", `/api/v3/${collection}/history/1700000000000`, "history"],
      ] as const;
      for (const [method, path, kind] of routes) {
        expect(matcher(method, path)).toMatchObject({ kind });
      }
      expect(matcher("PATCH", `/api/v3/${collection}`)).toBeNull();
      expect(matcher("POST", `/api/v3/${collection}/client-id`)).toBeNull();
      expect(matcher("GET", `/api/v3/${collection}/too/many/segments`)).toBeNull();
    }
  });

  it("runs the complete Food CRUD, history, lastModified and v1 visibility workflow", async () => {
    const name = tenant("api3-food-workflow");
    const jwt = await issueSubject(name, "Food client", [
      "api:food:create",
      "api:food:read",
      "api:food:update",
      "api:food:delete",
    ]);
    const date = Date.parse("2026-07-10T08:00:00.000Z");
    const document = food("family-rice", date);

    const created = await api3Fetch(
      name,
      jwt,
      "/api/v3/food",
      jsonMutation("POST", document),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("Location")).toBe("/api/v3/food/family-rice");

    await evictDurableObject(env.ENTRY_STORE.getByName(name));
    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/food/family-rice",
    ))).toMatchObject({ name: "Rice", carbs: 28, identifier: "family-rice" });
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/food?type$eq=food",
    ))).toHaveLength(1);
    const csv = await api3Fetch(name, jwt, "/api/v3/food.csv?type$eq=food");
    expect(csv.status).toBe(200);
    expect(csv.headers.get("Content-Type")).toContain("text/csv");
    expect(await csv.text()).toContain("Rice");

    const legacy = await SELF.fetch(withTenant("/api/v1/food/regular.json", name));
    expect(legacy.status).toBe(200);
    expect(await legacy.json<JsonObject[]>()).toMatchObject([
      { name: "Rice", carbs: 28, identifier: "family-rice" },
    ]);

    const replaced = await api3Fetch(
      name,
      jwt,
      "/api/v3/food/family-rice",
      jsonMutation("PUT", food("ignored-by-path", date, { name: "Brown Rice", carbs: 24 })),
    );
    expect(replaced.status).toBe(200);
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/food/family-rice",
      jsonMutation("PATCH", { portion: 80, carbs: 20 }),
    )).status).toBe(200);
    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/food/family-rice",
    ))).toMatchObject({ name: "Brown Rice", portion: 80, carbs: 20 });

    const history = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/food/history/1700000000000",
    ));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ identifier: "family-rice", carbs: 20 });

    const modified = await result<{ collections: Record<string, number> }>(await api3Fetch(
      name,
      jwt,
      "/api/v3/lastModified",
    ));
    expect(modified.collections.food).toEqual(expect.any(Number));

    expect((await api3Fetch(name, jwt, "/api/v3/food/family-rice", {
      method: "DELETE",
    })).status).toBe(200);
    expect((await api3Fetch(name, jwt, "/api/v3/food/family-rice")).status).toBe(410);
    const deletedHistory = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/food/history/1700000000000",
    ));
    expect(deletedHistory).toMatchObject([{ identifier: "family-rice", isValid: false }]);
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/food/family-rice?permanent=true",
      { method: "DELETE" },
    )).status).toBe(200);
    expect((await api3Fetch(name, jwt, "/api/v3/food/family-rice")).status).toBe(404);
  });

  it("deduplicates a v1 Food row through the locked created_at-only API3 fallback", async () => {
    const name = tenant("api3-food-v1-fallback");
    const legacyCreate = await SELF.fetch(withTenant("/api/v1/food/", name), {
      method: "POST",
      headers: {
        "api-secret": await secretDigest(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "food",
        name: "Legacy Rice",
        category: "Meal",
        portion: 100,
        carbs: 30,
      }),
    });
    expect(legacyCreate.status).toBe(200);
    const legacy = (await legacyCreate.json<JsonObject[]>())[0]!;
    expect(legacy._id).toMatch(/^[0-9a-f]{24}$/);
    expect(legacy.created_at).toEqual(expect.any(String));
    const date = Date.parse(String(legacy.created_at));
    const legacyUpdate = await SELF.fetch(withTenant("/api/v1/food/", name), {
      method: "PUT",
      headers: {
        "api-secret": await secretDigest(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...legacy,
        date,
        utcOffset: 0,
        app: "api3-food-test",
        device: "family-food-editor",
      }),
    });
    expect(legacyUpdate.status).toBe(200);

    const jwt = await issueSubject(name, "Food sync", [
      "api:food:create",
      "api:food:read",
      "api:food:update",
    ]);
    await evictDurableObject(env.ENTRY_STORE.getByName(name));
    const deduplicated = await api3Fetch(
      name,
      jwt,
      "/api/v3/food",
      jsonMutation("POST", food("synced-food", date, {
        created_at: legacy.created_at,
        name: "Synced Rice",
      })),
    );
    expect(deduplicated.status).toBe(200);
    expect(await deduplicated.json()).toMatchObject({
      status: 200,
      identifier: "synced-food",
      isDeduplication: true,
      deduplicatedIdentifier: legacy._id,
    });
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/food",
    ))).toMatchObject([{ identifier: "synced-food", name: "Synced Rice" }]);
    const legacyRows = await (
      await SELF.fetch(withTenant("/api/v1/food/regular.json", name))
    ).json<JsonObject[]>();
    expect(legacyRows).toHaveLength(1);
    expect(legacyRows[0]).toMatchObject({
      _id: legacy._id,
      identifier: "synced-food",
      name: "Synced Rice",
    });
  });

  it("keeps Settings resource reads separate from admin-only search and history", async () => {
    const name = tenant("api3-settings-auth");
    const writer = await issueSubject(name, "Settings writer", [
      "api:settings:create",
      "api:settings:read",
      "api:settings:update",
      "api:settings:delete",
    ]);
    const reader = await issueSubject(name, "Settings reader", ["api:settings:read"]);
    const administrator = await issueSubject(name, "Settings administrator", [
      "api:settings:admin",
    ]);
    const date = Date.parse("2026-07-11T00:00:00.000Z");

    expect((await api3Fetch(
      name,
      writer,
      "/api/v3/settings",
      jsonMutation("POST", settings("aaps-family", date)),
    )).status).toBe(201);
    expect((await api3Fetch(name, reader, "/api/v3/settings/aaps-family")).status).toBe(200);

    const deniedSearch = await api3Fetch(name, reader, "/api/v3/settings");
    expect(deniedSearch.status).toBe(403);
    expect(await deniedSearch.json()).toEqual({
      status: 403,
      message: "Missing permission api:settings:admin",
    });
    const deniedHistory = await api3Fetch(
      name,
      reader,
      "/api/v3/settings/history/1700000000000",
    );
    expect(deniedHistory.status).toBe(403);
    expect(await deniedHistory.json()).toEqual({
      status: 403,
      message: "Missing permission api:settings:admin",
    });

    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      administrator,
      "/api/v3/settings",
    ))).toMatchObject([{ identifier: "aaps-family", language: "zh_CN" }]);
    const xml = await api3Fetch(name, administrator, "/api/v3/settings.xml");
    expect(xml.status).toBe(200);
    expect(xml.headers.get("Content-Type")).toContain("application/xml");
    expect(await xml.text()).toContain("aaps-family");
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      administrator,
      "/api/v3/settings/history/1700000000000",
    ))).toHaveLength(1);

    expect((await api3Fetch(
      name,
      writer,
      "/api/v3/settings/aaps-family",
      jsonMutation("PUT", settings("ignored-by-path", date, { language: "zh_TW" })),
    )).status).toBe(200);
    expect((await api3Fetch(
      name,
      writer,
      "/api/v3/settings/aaps-family",
      jsonMutation("PATCH", { units: "mmol" }),
    )).status).toBe(200);
    expect(await result<JsonObject>(await api3Fetch(
      name,
      reader,
      "/api/v3/settings/aaps-family",
    ))).toMatchObject({ language: "zh_TW", units: "mmol" });

    const modified = await result<{ collections: Record<string, number> }>(await api3Fetch(
      name,
      reader,
      "/api/v3/lastModified",
    ));
    expect(modified.collections.settings).toEqual(expect.any(Number));

    expect((await api3Fetch(name, writer, "/api/v3/settings/aaps-family", {
      method: "DELETE",
    })).status).toBe(200);
    expect((await api3Fetch(name, reader, "/api/v3/settings/aaps-family")).status).toBe(410);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      administrator,
      "/api/v3/settings/history/1700000000000",
    ))).toMatchObject([{ identifier: "aaps-family", isValid: false }]);
  });

  it("idempotently repairs pre-slice Food metadata and its created_at fallback", async () => {
    const name = tenant("api3-food-migration");
    const jwt = await issueSubject(name, "Food migration reader", ["api:food:read"]);
    const id = "eeeeeeeeeeeeeeeeeeeeeeee";
    const createdAt = "2026-07-12T00:00:00.000Z";
    const date = Date.parse(createdAt);
    const body = JSON.stringify({
      _id: id,
      type: "food",
      name: "Migrated Food",
      created_at: createdAt,
    });
    const stub = env.ENTRY_STORE.getByName(name);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec(
        `INSERT INTO documents
          (collection, id, body, sort_time, created_at, updated_at, identifier,
           identifier_present, srv_created, srv_modified, is_valid, fallback_key,
           revision, srv_metadata_version)
         VALUES ('food', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
        id,
        body,
        date,
        date,
        date,
      );
      state.storage.sql.exec(
        "DELETE FROM _sql_schema_migrations WHERE id = ?",
        ENTRY_STORE_ACTIVATION_SEAL,
      );
    });

    await evictDurableObject(stub);
    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      `/api/v3/food/${id}`,
    ))).toMatchObject({
      identifier: id,
      name: "Migrated Food",
      srvCreated: date,
      srvModified: date,
    });
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{
        identifier: string | null;
        identifier_present: number;
        is_valid: number;
        fallback_key: string;
        revision: number;
        srv_metadata_version: number;
      }>(
        `SELECT identifier, identifier_present, is_valid, fallback_key, revision,
                srv_metadata_version
         FROM documents WHERE collection = 'food' AND id = ?`,
        id,
      ).one()).toEqual({
        identifier: null,
        identifier_present: 0,
        is_valid: 1,
        fallback_key: JSON.stringify([createdAt]),
        revision: 1,
        srv_metadata_version: 1,
      });
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM document_changes
         WHERE collection = 'food' AND id = ? AND revision = 1 AND operation = 'migrate'`,
        id,
      ).one().count).toBe(1);
    });

    await evictDurableObject(stub);
    expect((await api3Fetch(name, jwt, `/api/v3/food/${id}`)).status).toBe(200);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM document_changes
         WHERE collection = 'food' AND id = ? AND revision = 1 AND operation = 'migrate'`,
        id,
      ).one().count).toBe(1);
    });
  });
});
