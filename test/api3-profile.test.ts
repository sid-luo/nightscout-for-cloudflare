import { env } from "cloudflare:workers";
import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { matchApi3ProfileRoute } from "../src/api3/treatments";
import { ENTRY_STORE_ACTIVATION_SEAL, type EntryStore } from "../src/entry-store";

/**
 * Differential contract sources, locked to Nightscout v15.0.7 commit
 * 7e0e77f88fc113a76fe363504125f5b36b8a3fe3:
 * - lib/api3/generic/{create,read,search,update,patch,delete,history}
 * - lib/api3/generic/setup.js (Profile created_at-only legacy fallback)
 * - lib/api3/specific/lastModified.js
 * - lib/server/profile.js (v1 create/save/remove and last sorting)
 * - tests/api3.aaps-patterns.test.js (AAPS createProfileStore behavior)
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

async function v1Write(
  tenantName: string,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  payload?: unknown,
): Promise<Response> {
  const headers = new Headers({ "api-secret": await secretDigest() });
  if (payload !== undefined) headers.set("Content-Type", "application/json");
  return SELF.fetch(withTenant(path, tenantName), {
    method,
    headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
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
  const subjectResponse = await adminWrite(
    tenantName,
    "/api/v2/authorization/subjects",
    { name: subjectName, roles: [roleName] },
  );
  expect(subjectResponse.status).toBe(200);
  const created = await subjectResponse.json<JsonObject>();
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
  headers: HeadersInit = {},
): RequestInit {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Content-Type", "application/json");
  return { method, headers: requestHeaders, body: JSON.stringify(body) };
}

function aapsProfile(date: number, extra: JsonObject = {}): JsonObject {
  const iso = new Date(date).toISOString();
  return {
    app: "AAPS",
    date,
    created_at: iso,
    startDate: iso,
    defaultProfile: "aaps-v3-test",
    units: "mg/dl",
    store: {
      "aaps-v3-test": {
        dia: 5,
        carbratio: [{ time: "00:00", value: 10 }],
        sens: [{ time: "00:00", value: 50 }],
        basal: [{ time: "00:00", value: 0.5 }],
        target_low: [{ time: "00:00", value: 100 }],
        target_high: [{ time: "00:00", value: 120 }],
        timezone: "UTC",
      },
    },
    ...extra,
  };
}

function profile(
  identifier: string,
  date: number,
  extra: JsonObject = {},
): JsonObject {
  return {
    ...aapsProfile(date),
    identifier,
    defaultProfile: "Default",
    store: {
      Default: {
        dia: 4,
        carbratio: [{ time: "00:00", value: 11 }],
        sens: [{ time: "00:00", value: 45 }],
        basal: [{ time: "00:00", value: 0.6 }],
        target_low: [{ time: "00:00", value: 90 }],
        target_high: [{ time: "00:00", value: 120 }],
        timezone: "UTC",
      },
    },
    ...extra,
  };
}

async function result<T = unknown>(response: Response): Promise<T> {
  const body = await response.json<{ status: number; result: T }>();
  expect(body.status).toBe(200);
  return body.result;
}

describe("API v3 Profile vertical slice", () => {
  it("matches exactly the eight generic Profile routes and applies dynamic permissions", async () => {
    const routeCases = [
      ["GET", "/api/v3/profile", "collection"],
      ["POST", "/api/v3/profile", "collection"],
      ["GET", "/api/v3/profile/profile-id", "resource"],
      ["PUT", "/api/v3/profile/profile-id", "resource"],
      ["PATCH", "/api/v3/profile/profile-id", "resource"],
      ["DELETE", "/api/v3/profile/profile-id", "resource"],
      ["GET", "/api/v3/profile/history", "history"],
      ["GET", "/api/v3/profile/history/1700000000000", "history"],
    ] as const;
    for (const [method, path, kind] of routeCases) {
      expect(matchApi3ProfileRoute(method, path)).toMatchObject({ kind });
    }
    for (const [method, path] of [
      ["PATCH", "/api/v3/profile"],
      ["POST", "/api/v3/profile/profile-id"],
      ["POST", "/api/v3/profile/history"],
      ["GET", "/api/v3/profile/not/a/route"],
    ] as const) {
      expect(matchApi3ProfileRoute(method, path)).toBeNull();
    }

    const name = tenant("api3-profile-auth");
    const date = Date.parse("2026-07-01T00:00:00.000Z");
    const document = profile("profile-auth", date);
    const reader = await issueSubject(name, "Reader", ["api:profile:read"]);
    const creator = await issueSubject(name, "Creator", ["api:profile:create"]);
    const updater = await issueSubject(name, "Updater", ["api:profile:update"]);

    const missing = await api3Fetch(name, null, "/api/v3/profile");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      status: 401,
      message: "Missing or bad access token or JWT",
    });
    expect((await SELF.fetch(withTenant("/api/v3/profile", name), {
      headers: { "api-secret": await secretDigest() },
    })).status).toBe(401);

    const deniedCreate = await api3Fetch(
      name,
      reader,
      "/api/v3/profile",
      jsonMutation("POST", document),
    );
    expect(await deniedCreate.json()).toEqual({
      status: 403,
      message: "Missing permission api:profile:create",
    });

    expect((await api3Fetch(
      name,
      creator,
      "/api/v3/profile",
      jsonMutation("POST", document),
    )).status).toBe(201);
    const duplicateRequiresUpdate = await api3Fetch(
      name,
      creator,
      "/api/v3/profile",
      jsonMutation("POST", document),
    );
    expect(await duplicateRequiresUpdate.json()).toEqual({
      status: 403,
      message: "Missing permission api:profile:update",
    });

    const missingPutRequiresCreate = await api3Fetch(
      name,
      updater,
      "/api/v3/profile/missing-profile",
      jsonMutation("PUT", profile("ignored", date + 60_000)),
    );
    expect(await missingPutRequiresCreate.json()).toEqual({
      status: 403,
      message: "Missing permission api:profile:create",
    });
    expect((await api3Fetch(name, reader, "/api/v3/profile/profile-auth")).status).toBe(200);
  });

  it("matches the locked AAPS retry contract and exposes the newest profile through v1 current", async () => {
    const name = tenant("api3-profile-aaps");
    const creator = await issueSubject(name, "AAPS creator", ["api:profile:create"]);
    const updater = await issueSubject(name, "AAPS updater", ["api:profile:update"]);
    const reader = await issueSubject(name, "AAPS reader", ["api:profile:read"]);
    const firstDate = Date.parse("2026-07-02T00:00:00.000Z");
    const secondDate = firstDate + 60_000;
    const first = aapsProfile(firstDate, {
      store: {
        "aaps-v3-test": {
          ...(aapsProfile(firstDate).store as JsonObject)["aaps-v3-test"] as JsonObject,
          carbratio: [{ time: "00:00", value: 8 }],
        },
      },
    });
    const second = aapsProfile(secondDate, {
      store: {
        "aaps-v3-test": {
          ...(aapsProfile(secondDate).store as JsonObject)["aaps-v3-test"] as JsonObject,
          carbratio: [{ time: "00:00", value: 14 }],
        },
      },
    });

    const created = await api3Fetch(
      name,
      creator,
      "/api/v3/profile",
      jsonMutation("POST", first),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json<JsonObject>();
    expect(createdBody.identifier).toEqual(expect.any(String));

    const retry = await api3Fetch(
      name,
      updater,
      "/api/v3/profile",
      jsonMutation("POST", first),
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      status: 200,
      identifier: createdBody.identifier,
      isDeduplication: true,
    });
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      reader,
      "/api/v3/profile",
    ))).toHaveLength(1);

    const edited = await api3Fetch(
      name,
      creator,
      "/api/v3/profile",
      jsonMutation("POST", second),
    );
    expect(edited.status).toBe(201);
    const editedBody = await edited.json<JsonObject>();
    expect(editedBody.identifier).not.toBe(createdBody.identifier);

    const api3Profiles = await result<JsonObject[]>(await api3Fetch(
      name,
      reader,
      "/api/v3/profile",
    ));
    expect(api3Profiles).toHaveLength(2);
    expect(api3Profiles.every((item) => item._id === undefined)).toBe(true);

    const currentResponse = await SELF.fetch(withTenant("/api/v1/profile/current", name));
    expect(currentResponse.status).toBe(200);
    const current = await currentResponse.json<JsonObject>();
    expect(current.startDate).toBe(new Date(secondDate).toISOString());
    expect(
      (((current.store as JsonObject)["aaps-v3-test"] as JsonObject).carbratio as JsonObject[])[0]
        ?.value,
    ).toBe(14);
    const legacyProfiles = await (
      await SELF.fetch(withTenant("/api/v1/profile.json?count=10", name))
    ).json<JsonObject[]>();
    expect(legacyProfiles).toHaveLength(2);

    expect(await result<JsonObject>(await api3Fetch(
      name,
      reader,
      "/api/v3/lastModified",
    ))).toMatchObject({
      srvDate: expect.any(Number),
      collections: { profile: expect.any(Number) },
    });
  });

  it("runs create, search, read, replace, patch, history, formats, and both delete modes", async () => {
    const name = tenant("api3-profile-workflow");
    const permissions = [
      "api:profile:create",
      "api:profile:read",
      "api:profile:update",
      "api:profile:delete",
    ];
    const alice = await issueSubject(name, "Alice", permissions);
    const bob = await issueSubject(name, "Bob", permissions);
    const date = Date.parse("2026-07-03T00:00:00.000Z");
    const document = profile("workflow-profile", date, { note: "initial" });

    const created = await api3Fetch(
      name,
      alice,
      "/api/v3/profile",
      jsonMutation("POST", document),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      status: 201,
      identifier: "workflow-profile",
      lastModified: expect.any(Number),
    });
    expect(created.headers.get("Location")).toBe("/api/v3/profile/workflow-profile");

    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/profile?defaultProfile%24eq=Default",
    ))).toEqual([
      expect.objectContaining({ identifier: "workflow-profile", note: "initial" }),
    ]);

    const readCreated = await api3Fetch(
      name,
      alice,
      "/api/v3/profile/workflow-profile",
    );
    expect(await result<JsonObject>(readCreated)).toMatchObject({
      identifier: "workflow-profile",
      date,
      utcOffset: 0,
      created_at: new Date(date).toISOString(),
      subject: "Alice",
      store: { Default: { timezone: "UTC" } },
      srvCreated: expect.any(Number),
      srvModified: expect.any(Number),
    });
    const readLastModified = readCreated.headers.get("Last-Modified");
    expect(readLastModified).not.toBeNull();
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/profile/workflow-profile",
      { headers: { "If-Modified-Since": String(readLastModified) } },
    )).status).toBe(304);

    const replacement = profile("workflow-profile", date, {
      note: "replaced",
      duration: 30,
    });
    const replaced = await api3Fetch(
      name,
      bob,
      "/api/v3/profile/workflow-profile",
      jsonMutation("PUT", replacement),
    );
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toEqual({ status: 200, lastModified: expect.any(Number) });

    const patched = await api3Fetch(
      name,
      alice,
      "/api/v3/profile/workflow-profile",
      jsonMutation("PATCH", { note: "patched" }),
    );
    expect(patched.status).toBe(200);
    const readPatched = await result<JsonObject>(await api3Fetch(
      name,
      alice,
      "/api/v3/profile/workflow-profile",
    ));
    expect(readPatched).toMatchObject({
      note: "patched",
      subject: "Bob",
      modifiedBy: "Alice",
      duration: 30,
      durationInMilliseconds: 1_800_000,
      endmills: date + 1_800_000,
    });

    const history = await api3Fetch(
      name,
      alice,
      "/api/v3/profile/history/946684800001",
    );
    expect(await result<JsonObject[]>(history)).toEqual([
      expect.objectContaining({ identifier: "workflow-profile", note: "patched" }),
    ]);
    expect(history.headers.get("ETag")).toMatch(/^W\/"\d+"$/);
    expect((await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/profile/history",
      { headers: { "Last-Modified": "Sat, 01 Jan 2000 00:00:01 GMT" } },
    ))).length).toBe(1);

    const searchCsv = await api3Fetch(
      name,
      alice,
      "/api/v3/profile.csv?fields=identifier%2CdefaultProfile",
    );
    expect(searchCsv.status).toBe(200);
    expect(searchCsv.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(await searchCsv.text()).toBe(
      "identifier,defaultProfile\nworkflow-profile,Default\n",
    );

    const readXml = await api3Fetch(
      name,
      alice,
      "/api/v3/profile/workflow-profile?fields=identifier%2Cstore",
      { headers: { Accept: "application/xml" } },
    );
    expect(readXml.status).toBe(200);
    expect(readXml.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    const xml = await readXml.text();
    expect(xml).toContain("<identifier>workflow-profile</identifier>");
    expect(xml).toContain("<timezone>UTC</timezone>");

    expect((await api3Fetch(
      name,
      bob,
      "/api/v3/profile/workflow-profile",
      { method: "DELETE" },
    )).status).toBe(200);
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/profile/workflow-profile",
    )).status).toBe(410);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/profile",
    ))).toEqual([]);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/profile/history/946684800001",
    ))).toEqual([
      expect.objectContaining({
        identifier: "workflow-profile",
        isValid: false,
        modifiedBy: "Bob",
      }),
    ]);

    expect((await api3Fetch(
      name,
      bob,
      "/api/v3/profile/workflow-profile?permanent=true",
      { method: "DELETE" },
    )).status).toBe(200);
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/profile/workflow-profile",
    )).status).toBe(404);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/profile/history/946684800001",
    ))).toEqual([]);
  });

  it("shares v1 storage immediately, fallback-deduplicates by created_at, and removes history on v1 delete", async () => {
    const name = tenant("api3-profile-legacy");
    const jwt = await issueSubject(name, "Legacy bridge", [
      "api:profile:create",
      "api:profile:read",
      "api:profile:update",
      "api:profile:delete",
    ]);
    const createdAt = "2026-07-04T01:02:03.000Z";
    const date = Date.parse(createdAt);
    const legacyResponse = await v1Write(name, "POST", "/api/v1/profile", {
      app: "legacy-profile-editor",
      date,
      utcOffset: 0,
      created_at: createdAt,
      startDate: createdAt,
      defaultProfile: "Legacy",
      store: { Legacy: { timezone: "UTC", dia: 4 } },
    });
    expect(legacyResponse.status).toBe(200);
    const [legacy] = await legacyResponse.json<JsonObject[]>();
    const legacyId = String(legacy?._id);
    expect(legacyId).toMatch(/^[0-9a-f]{24}$/);

    const readLegacy = await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      `/api/v3/profile/${legacyId}`,
    ));
    expect(readLegacy).toMatchObject({
      identifier: legacyId,
      srvCreated: date,
      srvModified: date,
      defaultProfile: "Legacy",
    });
    expect(readLegacy).not.toHaveProperty("_id");
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/profile/history/946684800001",
    ))).toMatchObject([{
      identifier: legacyId,
      srvCreated: date,
      srvModified: date,
      defaultProfile: "Legacy",
    }]);
    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/lastModified",
    ))).toMatchObject({ collections: { profile: date } });

    const deduplicated = await api3Fetch(
      name,
      jwt,
      "/api/v3/profile",
      jsonMutation("POST", {
        ...profile("modern-profile", date),
        app: "legacy-profile-editor",
        created_at: createdAt,
        startDate: createdAt,
        defaultProfile: "Modern",
      }),
    );
    expect(deduplicated.status).toBe(200);
    expect(await deduplicated.json()).toMatchObject({
      status: 200,
      identifier: "modern-profile",
      deduplicatedIdentifier: legacyId,
      isDeduplication: true,
    });
    const legacyList = await (
      await SELF.fetch(withTenant("/api/v1/profile.json?count=10", name))
    ).json<JsonObject[]>();
    expect(legacyList).toEqual([
      expect.objectContaining({
        _id: legacyId,
        identifier: "modern-profile",
        defaultProfile: "Modern",
      }),
    ]);

    const deleted = await v1Write(name, "DELETE", `/api/v1/profile/${legacyId}`);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({});
    expect((await api3Fetch(name, jwt, "/api/v3/profile/modern-profile")).status).toBe(404);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/profile/history/946684800001",
    ))).toEqual([]);
  });

  it("uses startDate descending and ObjectId descending for v1 list/current, independent of created_at", async () => {
    const name = tenant("api3-profile-v1-sort");
    const lowId = "111111111111111111111111";
    const tieLowId = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const tieHighId = "bbbbbbbbbbbbbbbbbbbbbbbb";
    const olderStart = "2026-07-05T00:00:00.000Z";
    const newestStart = "2026-07-06T00:00:00.000Z";
    for (const document of [
      {
        _id: lowId,
        defaultProfile: "CreatedLaterButStartsEarlier",
        startDate: olderStart,
        created_at: "2026-07-10T00:00:00.000Z",
        store: { CreatedLaterButStartsEarlier: { timezone: "UTC" } },
      },
      {
        _id: tieLowId,
        defaultProfile: "TieLow",
        startDate: newestStart,
        created_at: "2026-07-02T00:00:00.000Z",
        store: { TieLow: { timezone: "UTC" } },
      },
      {
        _id: tieHighId,
        defaultProfile: "TieHigh",
        startDate: newestStart,
        created_at: "2026-07-01T00:00:00.000Z",
        store: { TieHigh: { timezone: "UTC" } },
      },
    ]) {
      const response = await v1Write(name, "POST", "/api/v1/profile", document);
      expect(response.status).toBe(200);
    }

    const listed = await (
      await SELF.fetch(withTenant("/api/v1/profile.json?count=10", name))
    ).json<JsonObject[]>();
    expect(listed.map((item) => item._id)).toEqual([tieHighId, tieLowId, lowId]);
    const current = await (
      await SELF.fetch(withTenant("/api/v1/profile/current", name))
    ).json<JsonObject>();
    expect(current).toMatchObject({ _id: tieHighId, defaultProfile: "TieHigh" });

    const saved = await v1Write(name, "PUT", "/api/v1/profile", {
      ...current,
      defaultProfile: "TieHighSaved",
      store: { TieHighSaved: { timezone: "Europe/Prague" } },
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      _id: tieHighId,
      defaultProfile: "TieHighSaved",
    });
    const jwt = await issueSubject(name, "v1 save reader", ["api:profile:read"]);
    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      `/api/v3/profile/${tieHighId}`,
    ))).toMatchObject({
      identifier: tieHighId,
      defaultProfile: "TieHighSaved",
      store: { TieHighSaved: { timezone: "Europe/Prague" } },
    });
  });

  it("keeps the official Profile Editor create-save-current flow after Durable Object restart", async () => {
    const name = tenant("api3-profile-editor");
    const initial = {
      defaultProfile: "Default",
      startDate: "2026-07-06T12:00:00.000Z",
      units: "mg/dL",
      store: { Default: { timezone: "UTC", dia: 3 } },
    };
    const firstSave = await v1Write(name, "PUT", "/api/v1/profile", initial);
    expect(firstSave.status).toBe(200);
    const created = await firstSave.json<JsonObject>();
    expect(created).toMatchObject(initial);
    expect(created._id).toMatch(/^[0-9a-f]{24}$/);
    expect(created.created_at).toEqual(expect.any(String));

    const secondSave = await v1Write(name, "PUT", "/api/v1/profile", {
      ...created,
      defaultProfile: "Child",
      store: { Child: { timezone: "Asia/Shanghai", dia: 4 } },
    });
    expect(secondSave.status).toBe(200);
    expect(await secondSave.json()).toMatchObject({
      _id: created._id,
      defaultProfile: "Child",
    });

    await evictDurableObject(env.ENTRY_STORE.getByName(name));
    const current = await (
      await SELF.fetch(withTenant("/api/v1/profile/current", name))
    ).json<JsonObject>();
    expect(current).toMatchObject({
      _id: created._id,
      defaultProfile: "Child",
      store: { Child: { timezone: "Asia/Shanghai", dia: 4 } },
    });
  });

  it("selects the same startDate-current Profile for v1, status, and realtime ddata", async () => {
    const name = tenant("api3-profile-current-consistency");
    const earlierStart = "2026-07-08T00:00:00.000Z";
    const laterStart = "2026-07-09T00:00:00.000Z";
    for (const document of [
      {
        _id: "eeeeeeeeeeeeeeeeeeeeeeee",
        defaultProfile: "CreatedLater",
        startDate: earlierStart,
        created_at: "2026-07-12T00:00:00.000Z",
        units: "mg/dL",
        store: { CreatedLater: { timezone: "UTC", units: "mg/dL" } },
      },
      {
        _id: "222222222222222222222222",
        defaultProfile: "StartsLater",
        startDate: laterStart,
        created_at: "2026-07-01T00:00:00.000Z",
        units: "mmol/L",
        store: { StartsLater: { timezone: "UTC", units: "mmol/L" } },
      },
    ]) {
      expect((await v1Write(name, "POST", "/api/v1/profile", document)).status).toBe(200);
    }

    const current = await (
      await SELF.fetch(withTenant("/api/v1/profile/current", name))
    ).json<JsonObject>();
    expect(current).toMatchObject({
      _id: "222222222222222222222222",
      defaultProfile: "StartsLater",
    });

    const status = await (
      await SELF.fetch(withTenant("/api/v1/status.json", name))
    ).json<JsonObject>();
    expect((status.settings as JsonObject).units).toBe("mmol");

    const ddata = await (
      await SELF.fetch(withTenant("/api/v2/ddata/at", name))
    ).json<JsonObject>();
    expect(ddata.profiles).toEqual([
      expect.objectContaining({
        _id: "222222222222222222222222",
        defaultProfile: "StartsLater",
      }),
    ]);
  });

  it("idempotently backfills existing Profile metadata, history, and the created_at-only fallback", async () => {
    const name = tenant("api3-profile-migration");
    const jwt = await issueSubject(name, "Migration reader", ["api:profile:read"]);
    const id = "dddddddddddddddddddddddd";
    const createdAt = "2026-07-07T00:00:00.000Z";
    const date = Date.parse(createdAt);
    const body = JSON.stringify({
      _id: id,
      app: "pre-slice-profile",
      date,
      utcOffset: 0,
      created_at: createdAt,
      startDate: createdAt,
      defaultProfile: "Migrated",
      store: { Migrated: { timezone: "UTC" } },
    });
    const stub = env.ENTRY_STORE.getByName(name);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec(
        `INSERT INTO documents
          (collection, id, body, sort_time, created_at, updated_at, identifier,
           identifier_present, srv_created, srv_modified, is_valid, fallback_key,
           revision, srv_metadata_version)
         VALUES ('profile', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
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
      `/api/v3/profile/${id}`,
    ))).toMatchObject({
      identifier: id,
      defaultProfile: "Migrated",
      srvCreated: date,
      srvModified: date,
    });
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{
        identifier: string | null;
        identifier_present: number;
        srv_created: number | null;
        srv_modified: number | null;
        is_valid: number;
        fallback_key: string;
        revision: number;
        srv_metadata_version: number;
      }>(
        `SELECT identifier, identifier_present, srv_created, srv_modified, is_valid,
                fallback_key, revision, srv_metadata_version
         FROM documents WHERE collection = 'profile' AND id = ?`,
        id,
      ).one()).toEqual({
        identifier: null,
        identifier_present: 0,
        srv_created: null,
        srv_modified: null,
        is_valid: 1,
        fallback_key: JSON.stringify([createdAt]),
        revision: 1,
        srv_metadata_version: 1,
      });
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM document_changes
         WHERE collection = 'profile' AND id = ? AND revision = 1 AND operation = 'migrate'`,
        id,
      ).one().count).toBe(1);
    });

    await evictDurableObject(stub);
    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      `/api/v3/profile/${id}`,
    ))).toMatchObject({
      identifier: id,
      defaultProfile: "Migrated",
      srvCreated: date,
      srvModified: date,
    });
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM document_changes
         WHERE collection = 'profile' AND id = ? AND revision = 1 AND operation = 'migrate'`,
        id,
      ).one().count).toBe(1);
    });
  });
});
