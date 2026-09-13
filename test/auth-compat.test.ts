import { env } from "cloudflare:workers";
import {
  SELF,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizationDerivationMarker,
} from "../src/authorization";
import type { EntryStore } from "../src/entry-store";
import worker from "../src/index";
import { issueJwt } from "../src/jwt";

const TEST_API_SECRET = "nscf-test-secret-20260717";
const ROTATED_API_SECRET = "nscf-rotated-secret-20260718";
const UNAUTHORIZED = {
  status: 401,
  message: "Unauthorized",
  description: "Invalid/Missing",
};

interface ListedSubject {
  _id: string;
  name: string;
  accessToken: string;
  roles: string[];
}

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function hexDigest(
  algorithm: "SHA-1" | "SHA-512",
  value: string,
): Promise<string> {
  const result = await crypto.subtle.digest(
    algorithm,
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(result),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function adminDigest(
  algorithm: "SHA-1" | "SHA-512" = "SHA-1",
): Promise<string> {
  return hexDigest(algorithm, TEST_API_SECRET);
}

function endpoint(path: string, tenantName: string): string {
  const url = new URL(`https://example.test${path}`);
  url.searchParams.set("tenant", tenantName);
  return url.href;
}

function configuredWorkerEnv(
  authDefaultRoles = "readable",
  authFailDelay = "0",
): Omit<Env, "API_SECRET"> & {
  API_SECRET: string;
  AUTH_DEFAULT_ROLES: string;
  AUTH_FAIL_DELAY: string;
} {
  return {
    ASSETS: env.ASSETS,
    ENTRY_STORE: env.ENTRY_STORE,
    DEXCOM_SHARE_CONNECTOR: env.DEXCOM_SHARE_CONNECTOR,
      SOURCE_CONNECTOR: env.SOURCE_CONNECTOR,
      WEBHOOK_DELIVERY: env.WEBHOOK_DELIVERY,
    API_SECRET: TEST_API_SECRET,
    AUTH_DEFAULT_ROLES: authDefaultRoles,
    AUTH_FAIL_DELAY: authFailDelay,
  };
}

function configuredFetch(
  tenantName: string,
  path: string,
  authDefaultRoles: string,
  init?: RequestInit,
  authFailDelay = "0",
): Promise<Response> {
  return worker.fetch(
    new Request(endpoint(path, tenantName), init),
    configuredWorkerEnv(authDefaultRoles, authFailDelay),
  );
}

async function adminRequest(
  tenantName: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  payload?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "api-secret": await adminDigest() };
  const init: RequestInit = { method, headers };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(payload);
  }
  return SELF.fetch(endpoint(path, tenantName), init);
}

async function createRole(
  tenantName: string,
  name: string,
  permissions: string | string[],
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await adminRequest(
    tenantName,
    "POST",
    "/api/v2/authorization/roles",
    { ...extra, name, permissions },
  );
  expect(response.status).toBe(200);
  return response.json<Record<string, unknown>>();
}

async function listSubjects(tenantName: string): Promise<ListedSubject[]> {
  const response = await adminRequest(
    tenantName,
    "GET",
    "/api/v2/authorization/subjects",
  );
  expect(response.status).toBe(200);
  return response.json<ListedSubject[]>();
}

async function createSubject(
  tenantName: string,
  name: string,
  roles: string[],
  id?: string,
  extra: Record<string, unknown> = {},
): Promise<{ created: Record<string, unknown>; listed: ListedSubject }> {
  const input: Record<string, unknown> = { ...extra, name, roles };
  if (id !== undefined) input._id = id;
  const response = await adminRequest(
    tenantName,
    "POST",
    "/api/v2/authorization/subjects",
    input,
  );
  expect(response.status).toBe(200);
  const created = await response.json<Record<string, unknown>>();
  expect(created).not.toHaveProperty("accessToken");
  expect(created).not.toHaveProperty("digest");
  expect(created).not.toHaveProperty("accessTokenDigest");
  const listed = (await listSubjects(tenantName)).find(
    (subject) => subject._id === created._id,
  );
  if (listed === undefined) throw new Error("created authorization subject was not listed");
  return { created, listed };
}

async function issueFor(
  tenantName: string,
  presented: string,
): Promise<Record<string, unknown>> {
  const response = await SELF.fetch(endpoint(
    `/api/v2/authorization/request/${encodeURIComponent(presented)}`,
    tenantName,
  ));
  expect(response.status).toBe(200);
  return response.json<Record<string, unknown>>();
}

function activity(marker: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "exercise",
    created_at: new Date().toISOString(),
    marker,
    ...extra,
  };
}

async function storedActivity(
  tenantName: string,
  marker: string,
): Promise<Record<string, unknown>> {
  const url = new URL(endpoint("/api/v1/activity", tenantName));
  url.searchParams.set("find[marker]", marker);
  const response = await SELF.fetch(url);
  expect(response.status).toBe(200);
  const [document] = await response.json<Array<Record<string, unknown>>>();
  if (document === undefined) throw new Error(`activity ${marker} was not stored`);
  return document;
}

function expectNoInternalAuthState(text: string): void {
  expect(text).not.toContain(TEST_API_SECRET);
  expect(text).not.toContain(ROTATED_API_SECRET);
  expect(text).not.toContain("accessTokenDigest");
  expect(text).not.toMatch(/(?:^|[\"'])digest(?:[\"']|\s*:)/);
  expect(text).not.toContain("authorization-subject-marker");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("locked Nightscout v15.0.7 authorization compatibility", () => {
  it("derives the upstream subject credential and sanitizes every public/RPC response", async () => {
    const tenantName = tenant("auth-derive");
    const id = "0123456789abcdef01234567";
    const createdRole = await createRole(
      tenantName,
      "created-at-role",
      ["api:activity:create"],
      { customRoleField: "preserved" },
    );
    expect(createdRole).toMatchObject({
      name: "created-at-role",
      permissions: ["api:activity:create"],
      customRoleField: "preserved",
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    const savedRoleResponse = await adminRequest(
      tenantName,
      "PUT",
      "/api/v2/authorization/roles",
      {
        _id: createdRole._id,
        name: "created-at-role",
        permissions: [],
        customRoleField: "still-preserved",
        created_at: "",
      },
    );
    const savedRole = await savedRoleResponse.json<Record<string, unknown>>();
    expect(savedRole).toMatchObject({
      _id: createdRole._id,
      customRoleField: "still-preserved",
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(savedRole.created_at).not.toBe("");

    const { created, listed } = await createSubject(
      tenantName,
      "Phone #1!",
      ["readable"],
      id,
      {
        customSubjectField: "preserved",
        authorizationMarkerLabel: "user-field-preserved",
        _nscfAuthorizationSubjectMarker: "private-field-must-not-leak",
      },
    );

    const secretSha1 = await adminDigest();
    const expectedDigest = await hexDigest("SHA-1", `${secretSha1}${id}`);
    const expectedAccessToken = `phone1-${expectedDigest.slice(0, 16)}`;
    expect(created).toMatchObject({
      _id: id,
      name: "Phone #1!",
      roles: ["readable"],
      customSubjectField: "preserved",
      authorizationMarkerLabel: "user-field-preserved",
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(created).not.toHaveProperty("_nscfAuthorizationSubjectMarker");
    expect(listed).toEqual({
      _id: id,
      name: "Phone #1!",
      roles: ["readable"],
      accessToken: expectedAccessToken,
    });

    const updatedResponse = await adminRequest(
      tenantName,
      "PUT",
      "/api/v2/authorization/subjects",
      {
        _id: id,
        name: "Phone #1!",
        roles: [],
        customSubjectField: "updated-and-preserved",
        authorizationMarkerLabel: "still-user-field-preserved",
        created_at: "",
        _nscfAuthorizationSubjectMarker: "private-field-must-still-not-leak",
      },
    );
    expect(updatedResponse.status).toBe(200);
    const updatedText = await updatedResponse.text();
    expect(JSON.parse(updatedText)).toMatchObject({
      _id: id,
      name: "Phone #1!",
      roles: [],
      customSubjectField: "updated-and-preserved",
      authorizationMarkerLabel: "still-user-field-preserved",
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(JSON.parse(updatedText)).not.toHaveProperty("_nscfAuthorizationSubjectMarker");
    expectNoInternalAuthState(updatedText);

    const stub = env.ENTRY_STORE.getByName(tenantName);
    const genericList = await stub.listDocuments("subjects");
    const resolved = await stub.resolveAuthorizationSubject(
      JSON.stringify([expectedAccessToken]),
    );
    if (resolved === null) throw new Error("derived credential did not resolve");
    expect(JSON.parse(genericList)).toEqual([{
      _id: id,
      name: "Phone #1!",
      roles: [],
      accessToken: expectedAccessToken,
    }]);
    expect(JSON.parse(resolved)).toEqual({
      _id: id,
      name: "Phone #1!",
      roles: [],
      accessToken: expectedAccessToken,
    });
    expectNoInternalAuthState(JSON.stringify(created));
    expectNoInternalAuthState(JSON.stringify(listed));
    expectNoInternalAuthState(genericList);
    expectNoInternalAuthState(resolved);

    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const body = state.storage.sql.exec<{ body: string }>(
        "SELECT body FROM documents WHERE collection = 'subjects' AND id = ?",
        id,
      ).one().body;
      expect(JSON.parse(body)).toMatchObject({
        accessToken: expectedAccessToken,
        digest: expectedDigest,
        accessTokenDigest: await hexDigest("SHA-1", expectedAccessToken),
      });
      const marker = state.storage.sql.exec<{ value: string }>(
        "SELECT value FROM tenant_secrets WHERE name = 'authorization-subject-marker'",
      ).one().value;
      expect(marker).toMatch(/^[0-9a-f]{64}$/);
      expect(marker).not.toBe(TEST_API_SECRET);
      expect(marker).not.toBe(secretSha1);
      expect(marker).not.toBe(await adminDigest("SHA-512"));
    });
  });

  it("preserves suffix-prefix lookup, cosmetic aliases, and canonical JWT issuance", async () => {
    const tenantName = tenant("auth-prefix");
    await createRole(tenantName, "activity-writer", "api:activity:create");
    const { listed } = await createSubject(
      tenantName,
      "Alias Phone",
      ["activity-writer"],
      "111111111111111111111111",
    );
    const suffix = listed.accessToken.split("-").at(-1)!;
    const cosmeticAlias = `anything-at-all-${suffix}`;

    const issued = await issueFor(tenantName, cosmeticAlias);
    const jwt = String(issued.token);
    expect(issued).toMatchObject({
      sub: "Alias Phone",
      permissionGroups: [["api:activity:create"], ["*:*:read"]],
    });
    const encodedPayload = jwt.split(".")[1]!;
    const payload = JSON.parse(atob(
      encodedPayload.replaceAll("-", "+").replaceAll("_", "/").padEnd(
        encodedPayload.length + ((4 - encodedPayload.length % 4) % 4),
        "=",
      ),
    )) as Record<string, unknown>;
    expect(payload.accessToken).toBe(listed.accessToken);

    const accessTokenDigestPrefix = (await hexDigest("SHA-1", listed.accessToken)).slice(0, 16);
    expect((await issueFor(tenantName, accessTokenDigestPrefix)).sub).toBe("Alias Phone");

    const tooShort = await SELF.fetch(endpoint(
      `/api/v2/authorization/request/${suffix.slice(0, 15)}`,
      tenantName,
    ));
    expect(tooShort.status).toBe(401);
    expect(await tooShort.json()).toEqual(UNAUTHORIZED);

    const unicodePrefix = await SELF.fetch(endpoint(
      `/api/v2/authorization/request/${encodeURIComponent("é".repeat(16))}`,
      tenantName,
    ));
    expect(unicodePrefix.status).toBe(401);
    expect(await unicodePrefix.json()).toEqual(UNAUTHORIZED);

    const ordered = new URL(endpoint("/api/v1/verifyauth", tenantName));
    ordered.searchParams.append("token", "invalid-first");
    ordered.searchParams.append("token", cosmeticAlias);
    expect(await (await SELF.fetch(ordered)).json()).toMatchObject({
      message: { permissions: "ROLE", rolefound: "FOUND", canRead: true },
    });

    const apiSecretSlot = await SELF.fetch(endpoint("/api/v1/activity", tenantName), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-secret": cosmeticAlias,
      },
      body: JSON.stringify(activity("access-token-in-secret-slot")),
    });
    expect(apiSecretSlot.status).toBe(200);

    const jwtInApiSecretSlot = await SELF.fetch(endpoint("/api/v1/activity", tenantName), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-secret": jwt,
      },
      body: JSON.stringify(activity("jwt-in-secret-slot")),
    });
    expect(jwtInApiSecretSlot.status).toBe(401);
    expect(await jwtInApiSecretSlot.json()).toEqual(UNAUTHORIZED);
  });

  it("matches independent secret/token extraction priority and deletes selected body credentials", async () => {
    const tenantName = tenant("auth-priority");
    await createRole(tenantName, "activity-writer", [
      "api:activity:read",
      "api:activity:create",
    ]);
    const { listed } = await createSubject(
      tenantName,
      "Priority Phone",
      ["activity-writer"],
    );
    const sha1 = await adminDigest();

    const querySecretWins = new URL(endpoint("/api/v1/activity", tenantName));
    querySecretWins.searchParams.set("secret", sha1);
    const querySecretResponse = await SELF.fetch(querySecretWins, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-secret": "invalid-header-secret",
      },
      body: JSON.stringify(activity("query-secret-wins")),
    });
    expect(querySecretResponse.status).toBe(200);

    const invalidQueryWins = new URL(endpoint("/api/v1/activity", tenantName));
    invalidQueryWins.searchParams.set("secret", "invalid-query-secret");
    const invalidQueryResponse = await SELF.fetch(invalidQueryWins, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-secret": sha1,
      },
      body: JSON.stringify(activity("invalid-query-shadows-header")),
    });
    expect(invalidQueryResponse.status).toBe(401);
    expect(await invalidQueryResponse.json()).toEqual(UNAUTHORIZED);

    const orderedSecretArray = new URL(endpoint("/api/v1/activity", tenantName));
    orderedSecretArray.searchParams.append("secret[]", "invalid-array-first");
    orderedSecretArray.searchParams.append("secret[]", listed.accessToken);
    const orderedSecretArrayResponse = await configuredFetch(
      tenantName,
      `${orderedSecretArray.pathname}${orderedSecretArray.search}`,
      "denied",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(activity("ordered-secret-array")),
      },
    );
    expect(orderedSecretArrayResponse.status).toBe(200);

    const orderedRepeatedSecret = new URL(endpoint("/api/v1/activity", tenantName));
    orderedRepeatedSecret.searchParams.append("secret", "invalid-repeated-first");
    orderedRepeatedSecret.searchParams.append("secret", listed.accessToken);
    const orderedRepeatedSecretResponse = await configuredFetch(
      tenantName,
      `${orderedRepeatedSecret.pathname}${orderedRepeatedSecret.search}`,
      "denied",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(activity("ordered-repeated-secret")),
      },
    );
    expect(orderedRepeatedSecretResponse.status).toBe(200);

    const invalidSecretArray = new URL(endpoint("/api/v1/entries.json", tenantName));
    invalidSecretArray.searchParams.append("secret[]", "invalid-only");
    const invalidSecretArrayResponse = await configuredFetch(
      tenantName,
      `${invalidSecretArray.pathname}${invalidSecretArray.search}`,
      "readable",
    );
    expect(invalidSecretArrayResponse.status).toBe(401);
    expect(await invalidSecretArrayResponse.json()).toEqual(UNAUTHORIZED);

    const adminSecretArray = new URL(endpoint("/api/v1/activity", tenantName));
    adminSecretArray.searchParams.append("secret[]", sha1);
    const adminSecretArrayResponse = await configuredFetch(
      tenantName,
      `${adminSecretArray.pathname}${adminSecretArray.search}`,
      "denied",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(activity("array-is-not-admin")),
      },
    );
    expect(adminSecretArrayResponse.status).toBe(401);
    expect(await adminSecretArrayResponse.json()).toEqual(UNAUTHORIZED);

    const oversizedSecretArray = new URL(endpoint("/api/v1/entries.json", tenantName));
    for (let index = 0; index < 33; index += 1) {
      oversizedSecretArray.searchParams.append("secret[]", `candidate-${index}`);
    }
    const oversizedSecretArrayResponse = await configuredFetch(
      tenantName,
      `${oversizedSecretArray.pathname}${oversizedSecretArray.search}`,
      "readable",
    );
    expect(oversizedSecretArrayResponse.status).toBe(401);
    expect(await oversizedSecretArrayResponse.json()).toEqual(UNAUTHORIZED);

    const bearerWins = new URL(endpoint("/api/v1/activity", tenantName));
    bearerWins.searchParams.set("token", listed.accessToken);
    const bearerResponse = await SELF.fetch(bearerWins, {
      method: "POST",
      headers: {
        Authorization: "Bearer invalid-bearer",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(activity("bearer-shadows-query")),
    });
    expect(bearerResponse.status).toBe(401);
    expect(await bearerResponse.json()).toEqual(UNAUTHORIZED);

    const queryTokenWins = new URL(endpoint("/api/v1/activity", tenantName));
    queryTokenWins.searchParams.set("token", listed.accessToken);
    const queryTokenResponse = await SELF.fetch(queryTokenWins, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(activity("query-token-wins", { token: "unselected-body-token" })),
    });
    expect(queryTokenResponse.status).toBe(200);
    expect(await storedActivity(tenantName, "query-token-wins")).toHaveProperty(
      "token",
      "unselected-body-token",
    );

    const bodyTokenResponse = await SELF.fetch(endpoint("/api/v1/activity", tenantName), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(activity("body-token", { token: listed.accessToken })),
    });
    expect(bodyTokenResponse.status).toBe(200);
    expect(await storedActivity(tenantName, "body-token")).not.toHaveProperty("token");

    const bodyAdminResponse = await SELF.fetch(endpoint("/api/v1/activity", tenantName), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(activity("body-admin", {
        secret: sha1,
        token: "selected-invalid-token",
      })),
    });
    expect(bodyAdminResponse.status).toBe(200);
    expect(await storedActivity(tenantName, "body-admin")).not.toHaveProperty("secret");
    expect(await storedActivity(tenantName, "body-admin")).not.toHaveProperty("token");

    const arrayResponse = await SELF.fetch(endpoint("/api/v1/activity", tenantName), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        activity("array-first", { token: listed.accessToken }),
        activity("array-second", { token: "unselected-second-token" }),
      ]),
    });
    expect(arrayResponse.status).toBe(200);
    expect(await storedActivity(tenantName, "array-first")).not.toHaveProperty("token");
    expect(await storedActivity(tenantName, "array-second")).toHaveProperty(
      "token",
      "unselected-second-token",
    );
  });

  it("preserves SHA-1/SHA-512 case semantics and v1/v2 verifyauth envelopes", async () => {
    const tenantName = tenant("auth-hashes");
    const sha1 = await adminDigest();
    const sha512 = await adminDigest("SHA-512");

    const defaultV1 = await (await SELF.fetch(endpoint("/api/v1/verifyauth", tenantName))).json();
    const defaultV2 = await (await SELF.fetch(endpoint("/api/v2/verifyauth", tenantName))).json();
    expect(defaultV2).toEqual(defaultV1);
    expect(defaultV1).toMatchObject({
      status: 200,
      message: { permissions: "DEFAULT", rolefound: "NOTFOUND", canRead: true },
    });

    const upperSha1 = await SELF.fetch(endpoint("/api/v1/verifyauth", tenantName), {
      headers: { "api-secret": sha1.toUpperCase() },
    });
    expect(await upperSha1.json()).toMatchObject({
      message: { isAdmin: true, canWrite: true, permissions: "ROLE" },
    });

    const exactSha512 = await SELF.fetch(endpoint("/api/v2/verifyauth", tenantName), {
      headers: { "api-secret": sha512 },
    });
    expect(await exactSha512.json()).toMatchObject({ message: { isAdmin: true } });
    expect(sha512.toUpperCase()).not.toBe(sha512);
    const upperSha512 = await SELF.fetch(endpoint("/api/v1/verifyauth", tenantName), {
      headers: { "api-secret": sha512.toUpperCase() },
    });
    expect(await upperSha512.json()).toMatchObject({
      message: { isAdmin: false, canRead: false, permissions: "ROLE" },
    });

    const invalidQueryToken = new URL(endpoint("/api/v1/verifyauth", tenantName));
    invalidQueryToken.searchParams.set("token", "invalid-opaque-token");
    expect(await (await SELF.fetch(invalidQueryToken)).json()).toMatchObject({
      message: { permissions: "DEFAULT", canRead: true },
    });
    const invalidBearer = await SELF.fetch(endpoint("/api/v1/verifyauth", tenantName), {
      headers: { Authorization: "Bearer invalid-opaque-token" },
    });
    expect(await invalidBearer.json()).toMatchObject({
      message: { permissions: "ROLE", canRead: false, rolefound: "NOTFOUND" },
    });
    const nullSecret = await SELF.fetch(endpoint("/api/v1/verifyauth", tenantName), {
      headers: { "api-secret": "null" },
    });
    expect(await nullSecret.json()).toMatchObject({
      message: { permissions: "DEFAULT", canRead: true },
    });
    const plaintextSecret = await SELF.fetch(endpoint("/api/v1/verifyauth", tenantName), {
      headers: { "api-secret": TEST_API_SECRET },
    });
    expect(await plaintextSecret.json()).toMatchObject({
      message: { permissions: "ROLE", canRead: false },
    });

    const rejectedWrite = await SELF.fetch(endpoint("/api/v1/activity", tenantName), {
      method: "POST",
      headers: {
        "api-secret": TEST_API_SECRET,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(activity("plaintext-rejected")),
    });
    expect(rejectedWrite.status).toBe(401);
    expect(await rejectedWrite.json()).toEqual(UNAUTHORIZED);
  });

  it("applies locked default roles and rejects explicit bad credentials on protected v1/v2 reads", async () => {
    const tenantName = tenant("auth-default-roles");

    expect((await configuredFetch(tenantName, "/api/v1/entries.json", "denied")).status)
      .toBe(401);
    expect((await configuredFetch(tenantName, "/api/v2/status", "denied")).status)
      .toBe(401);
    expect((await configuredFetch(tenantName, "/api/v2/status", "status-only")).status)
      .toBe(200);
    expect((await configuredFetch(tenantName, "/api/v1/entries.json", "status-only")).status)
      .toBe(401);

    await createRole(tenantName, "entries-only-default", ["api:entries:read"]);
    await createRole(tenantName, "clock-default", [
      "api:entries:read",
      "api:treatments:read",
    ]);
    expect((await configuredFetch(
      tenantName,
      "/api/v2/entries.json",
      "denied,entries-only-default",
    )).status).toBe(200);
    expect((await configuredFetch(
      tenantName,
      "/api/v2/properties",
      "entries-only-default",
    )).status).toBe(401);
    expect((await configuredFetch(
      tenantName,
      "/api/v2/properties",
      "denied clock-default",
    )).status).toBe(200);

    for (const [headers, expected] of [
      [{ Authorization: "Bearer definitely-wrong" }, 401],
      [{ "api-secret": "definitely-wrong" }, 401],
      [{ "api-secret": "null" }, 200],
      [{ Authorization: "bearer definitely-wrong" }, 200],
    ] as const) {
      const response = await SELF.fetch(endpoint("/api/v1/entries.json", tenantName), {
        headers,
      });
      expect(response.status).toBe(expected);
      if (expected === 401) expect(await response.json()).toEqual(UNAUTHORIZED);
    }
    const invalidQueryToken = new URL(endpoint("/api/v2/entries.json", tenantName));
    invalidQueryToken.searchParams.set("token", "invalid-opaque-query-token");
    expect((await SELF.fetch(invalidQueryToken)).status).toBe(200);

    const { listed } = await createSubject(tenantName, "No implicit reader", []);
    const issued = await issueFor(tenantName, listed.accessToken);
    expect((await configuredFetch(
      tenantName,
      "/api/v1/entries.json",
      "denied",
      { headers: { Authorization: `Bearer ${String(issued.token)}` } },
    )).status).toBe(401);

    await createRole(tenantName, "create-without-read", ["api:activity:create"]);
    const writer = await createSubject(
      tenantName,
      "Outer read guard",
      ["create-without-read"],
    );
    const writerJwt = await issueFor(tenantName, writer.listed.accessToken);
    const outerGuard = await configuredFetch(
      tenantName,
      "/api/v1/activity",
      "denied",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${String(writerJwt.token)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(activity("outer-read-required")),
      },
    );
    expect(outerGuard.status).toBe(401);
  });

  it("returns the locked seen-permission registry and Shiro trie JSON shape", async () => {
    const tenantName = tenant("auth-permission-trie");
    await createRole(tenantName, "not-a-route", ["custom:stored:permission"]);

    const permissionsResponse = await adminRequest(
      tenantName,
      "GET",
      "/api/v2/authorization/permissions",
    );
    const permissions = await permissionsResponse.json<string[]>();
    expect(permissions).toEqual([...permissions].sort());
    expect(permissions).toContain("admin:api:permissions:read");
    expect(permissions).toContain("api:entries:read");
    expect(permissions).toContain("notifications:loop:push");
    expect(permissions).not.toContain("custom:stored:permission");

    const trieResponse = await adminRequest(
      tenantName,
      "GET",
      "/api/v2/authorization/permissions/trie",
    );
    expect(await trieResponse.json()).toMatchObject({
      data: {
        admin: { api: { permissions: { read: { "*": {} } } } },
        api: { entries: { read: { "*": {} } } },
        notifications: { loop: { push: { "*": {} } } },
      },
    });
  });

  it("persists the locked per-IP failure delay and clears it on successful auth", async () => {
    const tenantName = tenant("auth-delay");
    const stub = env.ENTRY_STORE.getByName(tenantName);
    const directIp = "198.51.100.10";
    expect(await stub.authorizationDelay(directIp, 1_000)).toBe(0);
    await stub.authorizationFailed(directIp, 1_000, 50);
    expect(await stub.authorizationDelay(directIp, 1_025)).toBe(25);
    await stub.authorizationFailed(directIp, 1_025, 50);
    expect(await stub.authorizationDelay(directIp, 1_025)).toBe(75);
    expect(await stub.authorizationDelay(directIp, 1_100)).toBe(0);
    await stub.authorizationFailed(directIp, 1_200, 50);
    expect(await stub.authorizationDelay(directIp, 1_225)).toBe(25);
    await stub.authorizationSucceeded(directIp);
    expect(await stub.authorizationDelay(directIp, 1_225)).toBe(0);
    await stub.authorizationFailed(directIp, 2_000, -50);
    expect(await stub.authorizationDelay(directIp, 2_000)).toBe(0);
    await stub.authorizationFailed(directIp, 3_000, 999_999);
    expect(await stub.authorizationDelay(directIp, 3_000)).toBe(60_000);
    await stub.authorizationSucceeded(directIp);

    const alarmIp = "198.51.100.11";
    const alarmNow = Date.now();
    await stub.authorizationFailed(alarmIp, alarmNow, 50);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(await state.storage.getAlarm()).toBe(alarmNow + 50 + 60_000 + 1);
      state.storage.sql.exec(
        "UPDATE authorization_failures SET retry_at = ? WHERE ip = ?",
        Date.now() - 60_002,
        alarmIp,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM authorization_failures WHERE ip = ?",
        alarmIp,
      ).one().count).toBe(0);
    });

    const requestIp = "203.0.113.77";
    const rejected = await configuredFetch(
      tenantName,
      "/api/v1/entries.json",
      "readable",
      {
        headers: {
          Authorization: "Bearer wrong-delay-token",
          "CF-Connecting-IP": requestIp,
        },
      },
      "100",
    );
    expect(rejected.status).toBe(401);
    expect(await stub.authorizationDelay(requestIp, Date.now())).toBeGreaterThan(0);

    const accepted = await configuredFetch(
      tenantName,
      "/api/v1/entries.json",
      "readable",
      {
        headers: {
          "api-secret": await adminDigest(),
          "CF-Connecting-IP": requestIp,
        },
      },
      "100",
    );
    expect(accepted.status).toBe(200);
    expect(await stub.authorizationDelay(requestIp, Date.now())).toBe(0);
  });

  it("adapts the locked API_SECRET experiments permission probe through v1 and v2", async () => {
    const tenantName = tenant("auth-experiments");

    const status = await configuredFetch(
      tenantName,
      "/api/v1/status.json",
      "readable",
    );
    expect(status.status).toBe(200);

    for (const version of ["v1", "v2"]) {
      const anonymous = await configuredFetch(
        tenantName,
        `/api/${version}/experiments/test`,
        "readable",
      );
      expect(anonymous.status).toBe(401);

      const admin = await configuredFetch(
        tenantName,
        `/api/${version}/experiments/test`,
        "readable",
        { headers: { "api-secret": await adminDigest() } },
      );
      expect(admin.status).toBe(200);
      expect(await admin.json()).toEqual({ status: "ok" });
    }

    await createRole(tenantName, "debug-probe", ["authorization:debug:test"]);
    const { listed } = await createSubject(tenantName, "Debug probe", ["debug-probe"]);
    const issued = await issueFor(tenantName, listed.accessToken);
    const delegated = await configuredFetch(
      tenantName,
      "/api/v1/experiments/test",
      "denied",
      { headers: { Authorization: `Bearer ${String(issued.token)}` } },
    );
    expect(delegated.status).toBe(200);
    expect(await delegated.json()).toEqual({ status: "ok" });

    const shortSecretEnv = {
      ...configuredWorkerEnv("denied"),
      API_SECRET: "tooshort",
    };
    const shortSecret = await worker.fetch(
      new Request(endpoint("/api/v1/experiments/test", tenantName), {
        headers: { "api-secret": await hexDigest("SHA-1", "tooshort") },
      }),
      shortSecretEnv,
    );
    expect(shortSecret.status).toBe(503);
    expect(await shortSecret.json()).toMatchObject({
      error: { code: "api_secret_too_short" },
    });
  });

  it("derives realtime read/write/treatment flags from live role permissions", async () => {
    const tenantName = tenant("auth-realtime-permissions");
    await createRole(tenantName, "realtime-writer", [
      "api:*:read",
      "api:*:create,update,delete",
      "api:treatments:create,update,delete",
    ]);
    const { listed } = await createSubject(
      tenantName,
      "Realtime Writer",
      ["realtime-writer"],
    );
    const issued = await issueFor(tenantName, listed.accessToken);
    const stub = env.ENTRY_STORE.getByName(tenantName);
    await runInDurableObject(stub, async (instance: EntryStore) => {
      const authorize = Reflect.get(instance, "realtimeAuthorize").bind(instance) as (
        message: Record<string, unknown>,
      ) => Promise<Record<string, boolean> | null>;
      expect(await authorize({ token: issued.token })).toEqual({
        read: true,
        write: true,
        write_treatment: true,
      });
    });

    const roleResponse = await adminRequest(
      tenantName,
      "GET",
      "/api/v2/authorization/roles",
    );
    const role = (await roleResponse.json<Array<Record<string, unknown>>>()).find(
      (candidate) => candidate.name === "realtime-writer",
    );
    if (role === undefined) throw new Error("realtime writer role was not listed");
    expect((await adminRequest(
      tenantName,
      "PUT",
      "/api/v2/authorization/roles",
      { ...role, permissions: ["api:*:read"] },
    )).status).toBe(200);
    await runInDurableObject(stub, async (instance: EntryStore) => {
      const authorize = Reflect.get(instance, "realtimeAuthorize").bind(instance) as (
        message: Record<string, unknown>,
      ) => Promise<Record<string, boolean> | null>;
      expect(await authorize({ token: issued.token })).toEqual({
        read: true,
        write: false,
        write_treatment: false,
      });
    });
  });

  it("matches all six locked admin-save cases and rejects mutation arrays", async () => {
    const tenantName = tenant("auth-admin-save");
    const { created: createdSubject } = await createSubject(
      tenantName,
      "api-security-subject-update",
      ["readable"],
      undefined,
      { notes: "original" },
    );
    const createdRole = await createRole(
      tenantName,
      "api-security-role-update",
      ["api:entries:read"],
      { notes: "original" },
    );

    const subjectSave = await adminRequest(
      tenantName,
      "PUT",
      "/api/v2/authorization/subjects",
      {
        _id: createdSubject._id,
        name: "api-security-subject-update",
        roles: ["admin"],
        notes: "updated",
        created_at: "2024-10-26T21:32:49.173Z",
      },
    );
    expect(subjectSave.status).toBe(200);
    expect(await subjectSave.json()).toMatchObject({
      _id: createdSubject._id,
      roles: ["admin"],
      notes: "updated",
      created_at: "2024-10-26T21:32:49.173Z",
    });

    const roleSave = await adminRequest(
      tenantName,
      "PUT",
      "/api/v2/authorization/roles",
      {
        _id: createdRole._id,
        name: "api-security-role-update",
        permissions: ["api:entries:update"],
        notes: "updated",
        created_at: "2024-10-26T21:32:49.173Z",
      },
    );
    expect(roleSave.status).toBe(200);
    expect(await roleSave.json()).toMatchObject({
      _id: createdRole._id,
      permissions: ["api:entries:update"],
      notes: "updated",
      created_at: "2024-10-26T21:32:49.173Z",
    });

    for (const [collection, payload, description] of [
      [
        "subjects",
        { name: "api-security-subject-missing-id", roles: ["readable"], notes: "should fail" },
        "Missing _id for update",
      ],
      [
        "subjects",
        {
          _id: "not-a-valid-objectid",
          name: "api-security-subject-invalid-id",
          roles: ["readable"],
          notes: "should fail",
        },
        "Invalid _id format: not-a-valid-objectid",
      ],
      [
        "roles",
        {
          name: "api-security-role-missing-id",
          permissions: ["api:entries:read"],
          notes: "should fail",
        },
        "Missing _id for update",
      ],
      [
        "roles",
        {
          _id: "not-a-valid-objectid",
          name: "api-security-role-invalid-id",
          permissions: ["api:entries:read"],
          notes: "should fail",
        },
        "Invalid _id format: not-a-valid-objectid",
      ],
    ] as const) {
      const response = await adminRequest(
        tenantName,
        "PUT",
        `/api/v2/authorization/${collection}`,
        payload,
      );
      expect(response.status, `${collection}: ${description}`).toBe(500);
      expect(await response.json()).toEqual({
        status: 500,
        message: "Mongo Error",
        description,
      });
    }

    for (const [method, collection] of [
      ["POST", "subjects"],
      ["POST", "roles"],
      ["PUT", "subjects"],
      ["PUT", "roles"],
    ] as const) {
      const response = await adminRequest(
        tenantName,
        method,
        `/api/v2/authorization/${collection}`,
        [{ name: `array-${method}-${collection}` }],
      );
      expect(response.status, `${method} ${collection}`).toBe(500);
    }

    const subjectNames = (await listSubjects(tenantName)).map((subject) => subject.name);
    for (const name of [
      "api-security-subject-missing-id",
      "api-security-subject-invalid-id",
      "array-POST-subjects",
      "array-PUT-subjects",
    ]) {
      expect(subjectNames).not.toContain(name);
    }
    const roleList = await adminRequest(
      tenantName,
      "GET",
      "/api/v2/authorization/roles",
    );
    const roleNames = (await roleList.json<Array<Record<string, unknown>>>())
      .map((role) => role.name);
    for (const name of [
      "api-security-role-missing-id",
      "api-security-role-invalid-id",
      "array-POST-roles",
      "array-PUT-roles",
    ]) {
      expect(roleNames).not.toContain(name);
    }
  });

  it("re-resolves subject and role state for every JWT and fails closed after revocation", async () => {
    const tenantName = tenant("auth-live");
    const role = await createRole(
      tenantName,
      "live-writer",
      ["api:activity:create"],
    );
    const { listed } = await createSubject(
      tenantName,
      "Live Phone",
      ["live-writer"],
    );
    const issued = await issueFor(tenantName, listed.accessToken);
    const jwt = String(issued.token);

    const bearerWrite = (marker: string) => SELF.fetch(endpoint("/api/v1/activity", tenantName), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(activity(marker)),
    });
    expect((await bearerWrite("live-before-role-change")).status).toBe(200);

    const denyRole = await adminRequest(
      tenantName,
      "PUT",
      "/api/v2/authorization/roles",
      { _id: role._id, name: "live-writer", permissions: [] },
    );
    expect(denyRole.status).toBe(200);
    const denied = await bearerWrite("live-after-role-deny");
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual(UNAUTHORIZED);

    const restoreRole = await adminRequest(
      tenantName,
      "PUT",
      "/api/v2/authorization/roles",
      { _id: role._id, name: "live-writer", permissions: "api:activity:create" },
    );
    expect(restoreRole.status).toBe(200);
    expect((await bearerWrite("live-after-role-restore")).status).toBe(200);

    const removeSubjectRole = await adminRequest(
      tenantName,
      "PUT",
      "/api/v2/authorization/subjects",
      { _id: listed._id, name: listed.name, roles: [] },
    );
    expect(removeSubjectRole.status).toBe(200);
    expect(await removeSubjectRole.json()).not.toHaveProperty("accessToken");
    expect((await bearerWrite("live-after-subject-role-change")).status).toBe(401);

    const deleted = await adminRequest(
      tenantName,
      "DELETE",
      `/api/v2/authorization/subjects/${listed._id}`,
    );
    expect(deleted.status).toBe(200);
    const revoked = await SELF.fetch(endpoint("/api/v1/verifyauth", tenantName), {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    // Locked upstream throws after a deleted subject in this path. The Worker
    // adaptation deliberately closes it as an authorization failure.
    expect(await revoked.json()).toMatchObject({
      message: { permissions: "ROLE", rolefound: "NOTFOUND", canRead: false },
    });
  });

  it("keeps JWTs tenant-local, persistent across eviction, and bounded by expiry", async () => {
    const tenantName = tenant("auth-persist");
    const otherTenant = tenant("auth-persist-other");
    const { listed } = await createSubject(tenantName, "Persistent Phone", []);
    const issued = await issueFor(tenantName, listed.accessToken);
    const jwt = String(issued.token);
    const stub = env.ENTRY_STORE.getByName(tenantName);

    await evictDurableObject(stub);
    const afterEviction = await SELF.fetch(endpoint("/api/v3/status", tenantName), {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(afterEviction.status).toBe(200);
    const crossTenant = await SELF.fetch(endpoint("/api/v3/status", otherTenant), {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(crossTenant.status).toBe(401);

    const resumed = env.ENTRY_STORE.getByName(tenantName);
    const jwtSecret = await runInDurableObject(
      resumed,
      async (_instance: EntryStore, state) => state.storage.sql.exec<{ value: string }>(
        "SELECT value FROM tenant_secrets WHERE name = 'authorization-jwt'",
      ).one().value,
    );
    const expired = await issueJwt(
      jwtSecret,
      listed.accessToken,
      Math.floor(Date.now() / 1000) - 9 * 60 * 60,
    );
    const expiredResponse = await SELF.fetch(endpoint("/api/v1/verifyauth", tenantName), {
      headers: { Authorization: `Bearer ${expired.token}` },
    });
    expect(await expiredResponse.json()).toMatchObject({
      message: { permissions: "ROLE", rolefound: "NOTFOUND", canRead: false },
    });
  });

  it("re-derives bounded subjects on API_SECRET rotation without accepting the marker", async () => {
    const tenantName = tenant("auth-rotate");
    const id = "222222222222222222222222";
    const { listed } = await createSubject(tenantName, "Rotating Phone", [], id);
    const oldAccessToken = listed.accessToken;
    const stub = env.ENTRY_STORE.getByName(tenantName);

    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const instanceEnv = Reflect.get(instance, "env") as { API_SECRET?: string };
      expect(instanceEnv.API_SECRET).toBe(TEST_API_SECRET);
      instanceEnv.API_SECRET = ROTATED_API_SECRET;
      try {
        expect(await instance.resolveAuthorizationSubject(
          JSON.stringify([oldAccessToken]),
        )).toBeNull();
        const rotatedSecretDigest = await hexDigest("SHA-1", ROTATED_API_SECRET);
        const rotatedDigest = await hexDigest("SHA-1", `${rotatedSecretDigest}${id}`);
        const rotatedAccessToken = `rotatingph-${rotatedDigest.slice(0, 16)}`;
        const resolved = await instance.resolveAuthorizationSubject(
          JSON.stringify([rotatedAccessToken]),
        );
        if (resolved === null) throw new Error("rotated credential did not resolve");
        expect(JSON.parse(resolved)).toEqual({
          _id: id,
          name: "Rotating Phone",
          roles: [],
          accessToken: rotatedAccessToken,
        });
        expectNoInternalAuthState(resolved);

        const stored = JSON.parse(state.storage.sql.exec<{ body: string }>(
          "SELECT body FROM documents WHERE collection = 'subjects' AND id = ?",
          id,
        ).one().body) as Record<string, unknown>;
        expect(stored).toMatchObject({
          accessToken: rotatedAccessToken,
          digest: rotatedDigest,
          accessTokenDigest: await hexDigest("SHA-1", rotatedAccessToken),
        });
        const marker = state.storage.sql.exec<{ value: string }>(
          "SELECT value FROM tenant_secrets WHERE name = 'authorization-subject-marker'",
        ).one().value;
        expect(marker).toMatch(/^[0-9a-f]{64}$/);
        expect(marker).not.toBe(ROTATED_API_SECRET);
        expect(await instance.resolveAuthorizationSubject(JSON.stringify([marker]))).toBeNull();
      } finally {
        instanceEnv.API_SECRET = TEST_API_SECRET;
      }
    });

    expect(await stub.resolveAuthorizationSubject(
      JSON.stringify([oldAccessToken]),
    )).not.toBeNull();
  });

  it("patches rotated credentials without overwriting a concurrent subject edit", async () => {
    const tenantName = tenant("auth-rotate-concurrent");
    const id = "333333333333333333333333";
    await createSubject(
      tenantName,
      "Concurrent Rotation",
      [],
      id,
      { notes: "before" },
    );
    const rotatedSecretDigest = await hexDigest("SHA-1", ROTATED_API_SECRET);
    const rotatedDigest = await hexDigest("SHA-1", `${rotatedSecretDigest}${id}`);
    const rotatedAccessToken = `concurrent-${rotatedDigest.slice(0, 16)}`;
    const stub = env.ENTRY_STORE.getByName(tenantName);

    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const instanceEnv = Reflect.get(instance, "env") as { API_SECRET?: string };
      const originalDerive = Reflect.get(
        instance,
        "deriveAuthorizationSubject",
      ).bind(instance) as (document: Record<string, unknown>) => Promise<unknown>;
      let releaseDerivation!: () => void;
      let markEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseDerivation = resolve;
      });
      let pauseFirst = true;
      Reflect.set(instance, "deriveAuthorizationSubject", async (
        document: Record<string, unknown>,
      ) => {
        if (pauseFirst) {
          pauseFirst = false;
          markEntered();
          await release;
        }
        return originalDerive(document);
      });
      instanceEnv.API_SECRET = ROTATED_API_SECRET;
      try {
        const resolving = instance.resolveAuthorizationSubject(
          JSON.stringify([rotatedAccessToken]),
        );
        await entered;
        state.storage.sql.exec(
          `UPDATE documents
           SET body = json_set(body, '$.notes', 'concurrent-edit'),
               updated_at = updated_at + 1
           WHERE collection = 'subjects' AND id = ?`,
          id,
        );
        releaseDerivation();
        const resolved = await resolving;
        expect(resolved).not.toBeNull();
        const stored = JSON.parse(state.storage.sql.exec<{ body: string }>(
          "SELECT body FROM documents WHERE collection = 'subjects' AND id = ?",
          id,
        ).one().body) as Record<string, unknown>;
        expect(stored).toMatchObject({
          notes: "concurrent-edit",
          accessToken: rotatedAccessToken,
          digest: rotatedDigest,
        });
      } finally {
        releaseDerivation();
        Reflect.set(instance, "deriveAuthorizationSubject", originalDerive);
        instanceEnv.API_SECRET = TEST_API_SECRET;
      }
    });
  });

  it("self-heals malformed auth secrets and lets an API-secret admin repair corrupt subject JSON", async () => {
    const tenantName = tenant("auth-corrupt-repair");
    const id = "444444444444444444444444";
    const stub = env.ENTRY_STORE.getByName(tenantName);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO tenant_secrets (name, value, created_at)
         VALUES ('authorization-jwt', 'malformed', ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
        now,
      );
      state.storage.sql.exec(
        `INSERT INTO tenant_secrets (name, value, created_at)
         VALUES ('authorization-subject-marker', 'also-malformed', ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
        now,
      );
      state.storage.sql.exec(
        `INSERT INTO documents (collection, id, body, sort_time, created_at, updated_at)
         VALUES ('subjects', ?, '{not-json', ?, ?, ?)`,
        id,
        now,
        now,
        now,
      );
    });

    const listedCorrupt = await adminRequest(
      tenantName,
      "GET",
      "/api/v2/authorization/subjects",
    );
    expect(listedCorrupt.status).toBe(200);
    expect(await listedCorrupt.json()).toEqual([{
      _id: id,
      name: `[invalid subject ${id}]`,
      roles: [],
    }]);

    const repaired = await adminRequest(
      tenantName,
      "PUT",
      "/api/v2/authorization/subjects",
      { _id: id, name: "Repaired Subject", roles: ["readable"] },
    );
    expect(repaired.status).toBe(200);
    const [listed] = await listSubjects(tenantName);
    expect(listed).toMatchObject({
      _id: id,
      name: "Repaired Subject",
      roles: ["readable"],
      accessToken: expect.stringMatching(/^repairedsu-[0-9a-f]{16}$/),
    });

    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ value: string }>(
        "SELECT value FROM tenant_secrets WHERE name = 'authorization-jwt'",
      ).one().value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(state.storage.sql.exec<{ value: string }>(
        "SELECT value FROM tenant_secrets WHERE name = 'authorization-subject-marker'",
      ).one().value).toMatch(/^[0-9a-f]{64}$/);
      expect(() => JSON.parse(state.storage.sql.exec<{ body: string }>(
        "SELECT body FROM documents WHERE collection = 'subjects' AND id = ?",
        id,
      ).one().body)).not.toThrow();
    });
  });

  it("enforces the 256-subject cap atomically for concurrent POST and PUT upsert", async () => {
    const tenantName = tenant("auth-cap-concurrent");
    const stub = env.ENTRY_STORE.getByName(tenantName);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const now = Date.now();
      for (let index = 0; index < 255; index += 1) {
        const id = index.toString(16).padStart(24, "0");
        state.storage.sql.exec(
          `INSERT INTO documents (collection, id, body, sort_time, created_at, updated_at)
           VALUES ('subjects', ?, ?, ?, ?, ?)`,
          id,
          JSON.stringify({ _id: id, name: `seed-${index}`, roles: [] }),
          index,
          now,
          now,
        );
      }
    });

    const [first, second] = await Promise.all([
      adminRequest(tenantName, "POST", "/api/v2/authorization/subjects", {
        _id: "aaaaaaaaaaaaaaaaaaaaaaaa",
        name: "Concurrent A",
        roles: [],
      }),
      adminRequest(tenantName, "POST", "/api/v2/authorization/subjects", {
        _id: "bbbbbbbbbbbbbbbbbbbbbbbb",
        name: "Concurrent B",
        roles: [],
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 500]);
    expect((await listSubjects(tenantName))).toHaveLength(256);

    const updateExisting = await adminRequest(
      tenantName,
      "PUT",
      "/api/v2/authorization/subjects",
      {
        _id: "000000000000000000000000",
        name: "Updated existing at cap",
        roles: [],
      },
    );
    expect(updateExisting.status).toBe(200);
    const upsertNew = await adminRequest(
      tenantName,
      "PUT",
      "/api/v2/authorization/subjects",
      {
        _id: "cccccccccccccccccccccccc",
        name: "Forbidden upsert at cap",
        roles: [],
      },
    );
    expect(upsertNew.status).toBe(500);
    expect((await listSubjects(tenantName))).toHaveLength(256);
  });

  it("caps rotation work before hashing subjects and keeps failure responses/logs secret-free", async () => {
    const tenantName = tenant("auth-cap");
    const stub = env.ENTRY_STORE.getByName(tenantName);
    await stub.issueAccessJwt("cap-marker-seed");
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const now = Date.now();
      for (let index = 0; index < 257; index += 1) {
        const id = index.toString(16).padStart(24, "0");
        state.storage.sql.exec(
          `INSERT INTO documents (collection, id, body, sort_time, created_at, updated_at)
           VALUES ('subjects', ?, ?, ?, ?, ?)`,
          id,
          JSON.stringify({ _id: id, name: `seed-${index}`, roles: [] }),
          index,
          now,
          now,
        );
      }
      const jwtSecret = state.storage.sql.exec<{ value: string }>(
        "SELECT value FROM tenant_secrets WHERE name = 'authorization-jwt'",
      ).one().value;
      const currentMarker = await authorizationDerivationMarker(
        jwtSecret,
        TEST_API_SECRET,
      );
      state.storage.sql.exec(
        `INSERT INTO tenant_secrets (name, value, created_at)
         VALUES ('authorization-subject-marker', ?, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
        currentMarker,
        now,
      );
    });

    expect(await stub.resolveAuthorizationSubject(JSON.stringify(["0".repeat(16)])))
      .toBeNull();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await adminRequest(
      tenantName,
      "GET",
      "/api/v2/authorization/subjects",
    );
    expect(response.status).toBe(500);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toEqual({
      error: { code: "internal_error", message: "Internal server error" },
    });
    const logs = JSON.stringify(errorSpy.mock.calls);
    expectNoInternalAuthState(responseText);
    expectNoInternalAuthState(logs);
  });

  it("bounds credential candidate count, length, and request-body work", async () => {
    const tenantName = tenant("auth-bounds");
    const candidates = new URL(endpoint("/api/v1/verifyauth", tenantName));
    for (let index = 0; index < 33; index += 1) {
      candidates.searchParams.append("token", `candidate-${index}`);
    }
    expect(await (await SELF.fetch(candidates)).json()).toMatchObject({
      message: { permissions: "DEFAULT", canRead: true },
    });

    const oversizedBearer = await SELF.fetch(endpoint("/api/v1/verifyauth", tenantName), {
      headers: { Authorization: `Bearer ${"x".repeat(4097)}` },
    });
    expect(await oversizedBearer.json()).toMatchObject({
      message: { permissions: "ROLE", canRead: false },
    });

    const oversizedBody = await SELF.fetch(endpoint("/api/v1/activity", tenantName), {
      method: "POST",
      headers: {
        "api-secret": await adminDigest(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value: "x".repeat(512 * 1024) }),
    });
    expect(oversizedBody.status).toBe(413);
    expect(await oversizedBody.json()).toEqual({
      error: {
        code: "body_too_large",
        message: "request body exceeds 512 KiB",
      },
    });
  });
});
