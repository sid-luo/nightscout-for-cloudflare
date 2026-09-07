import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryStore } from "../src/entry-store";

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

async function adminWrite(
  tenantName: string,
  path: string,
  payload: unknown,
): Promise<Response> {
  return SELF.fetch(`https://example.test${path}?tenant=${tenantName}`, {
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
  const subjectResponse = await adminWrite(
    tenantName,
    "/api/v2/authorization/subjects",
    { name: subjectName, roles: [roleName] },
  );
  expect(subjectResponse.status).toBe(200);
  const created = await subjectResponse.json<JsonObject>();
  const subjectsResponse = await SELF.fetch(
    `https://example.test/api/v2/authorization/subjects?tenant=${tenantName}`,
    { headers: { "api-secret": await secretDigest() } },
  );
  expect(subjectsResponse.status).toBe(200);
  const subject = (await subjectsResponse.json<JsonObject[]>()).find(
    (candidate) => candidate._id === created._id,
  );
  if (subject === undefined) throw new Error("created API3 subject was not listed");
  const authorization = await SELF.fetch(
    `https://example.test/api/v2/authorization/request/${encodeURIComponent(String(subject.accessToken))}?tenant=${tenantName}`,
  );
  expect(authorization.status).toBe(200);
  const body = await authorization.json<JsonObject>();
  return String(body.token);
}

function withTenant(path: string, tenantName: string): string {
  return `https://example.test${path}${path.includes("?") ? "&" : "?"}tenant=${tenantName}`;
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

function treatment(
  identifier: string,
  createdAt: string,
  extra: JsonObject = {},
): JsonObject {
  return {
    identifier,
    date: Date.parse(createdAt),
    utcOffset: 0,
    app: "api3-http-test",
    device: "test-device",
    eventType: "Note",
    created_at: createdAt,
    notes: identifier,
    ...extra,
  };
}

async function result<T = unknown>(response: Response): Promise<T> {
  const body = await response.json<{ status: number; result: T }>();
  expect(body.status).toBe(200);
  return body.result;
}

describe("API v3 treatments vertical slice", () => {
  it("uses JWT Bearer only and enforces mutation-sensitive permissions", async () => {
    const name = tenant("api3-auth");
    const createdAt = "2026-06-01T00:00:00.000Z";
    const document = treatment("auth-treatment", createdAt);
    const readable = await issueSubject(name, "Reader", []);
    const createOnly = await issueSubject(name, "Creator", ["api:treatments:create"]);
    const updateOnly = await issueSubject(name, "Updater", ["api:treatments:update"]);

    const missing = await api3Fetch(name, null, "/api/v3/treatments");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      status: 401,
      message: "Missing or bad access token or JWT",
    });
    const queryToken = await api3Fetch(
      name,
      null,
      `/api/v3/treatments?token=${encodeURIComponent(readable)}`,
    );
    expect(queryToken.status).toBe(401);
    const apiSecret = await SELF.fetch(withTenant("/api/v3/treatments", name), {
      headers: { "api-secret": await secretDigest() },
    });
    expect(apiSecret.status).toBe(401);

    const denied = await api3Fetch(
      name,
      readable,
      "/api/v3/treatments",
      jsonMutation("POST", document),
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      status: 403,
      message: "Missing permission api:treatments:create",
    });

    const created = await api3Fetch(
      name,
      createOnly,
      "/api/v3/treatments/auth-treatment",
      jsonMutation("PUT", document),
    );
    expect(created.status).toBe(201);
    const createOnlyUpdate = await api3Fetch(
      name,
      createOnly,
      "/api/v3/treatments/auth-treatment",
      jsonMutation("PUT", { ...document, notes: "must not update" }),
    );
    expect(createOnlyUpdate.status).toBe(403);
    expect(await createOnlyUpdate.json()).toEqual({
      status: 403,
      message: "Missing permission api:treatments:update",
    });

    const missingUpdate = await api3Fetch(
      name,
      updateOnly,
      "/api/v3/treatments/missing-treatment",
      jsonMutation("PUT", { ...document, identifier: "missing-treatment" }),
    );
    expect(missingUpdate.status).toBe(403);
    expect(await missingUpdate.json()).toEqual({
      status: 403,
      message: "Missing permission api:treatments:create",
    });
    expect((await api3Fetch(
      name,
      updateOnly,
      "/api/v3/treatments/missing-treatment",
    )).status).toBe(404);
  });

  it("matches only the eight official routes and preserves extension middleware precedence", async () => {
    const name = tenant("api3-route-extension");
    const jwt = await issueSubject(name, "Extension writer", [
      "api:treatments:create",
      "api:treatments:read",
      "api:treatments:update",
      "api:treatments:delete",
    ]);
    const document = treatment("known-mime-write", "2026-06-01T01:00:00.000Z");

    const malformedUnknown = await api3Fetch(
      name,
      null,
      "/api/v3/treatments.definitely-not-a-mime",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      },
    );
    expect(malformedUnknown.status).toBe(500);
    expect(await malformedUnknown.json()).toEqual({
      status: 500,
      message: "Internal Server Error",
    });

    const unknown = await api3Fetch(
      name,
      null,
      "/api/v3/treatments.definitely-not-a-mime",
      jsonMutation("POST", treatment("unknown-mime-must-not-write", "2026-06-01T02:00:00.000Z")),
    );
    expect(unknown.status).toBe(406);
    expect(unknown.headers.get("Vary")).toBe("Accept");
    expect(await unknown.json()).toEqual({
      status: 406,
      message: "Unsupported output format requested",
    });
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/unknown-mime-must-not-write",
    )).status).toBe(404);

    const knownMimeWrite = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments.ttf",
      jsonMutation("POST", document),
    );
    expect(knownMimeWrite.status).toBe(201);
    expect(knownMimeWrite.headers.get("Content-Type")).toMatch(/application\/json/);
    expect(await knownMimeWrite.json()).toMatchObject({
      status: 201,
      identifier: "known-mime-write",
    });
    const jsonAliasWrite = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments.map",
      jsonMutation(
        "POST",
        treatment("json-alias-write", "2026-06-01T01:30:00.000Z"),
      ),
    );
    expect(jsonAliasWrite.status).toBe(201);
    expect(jsonAliasWrite.headers.get("Content-Type")).toMatch(/application\/json/);
    for (const alias of ["map", "JSON"]) {
      const jsonAliasRead = await api3Fetch(
        name,
        jwt,
        `/api/v3/treatments/json-alias-write.${alias}`,
      );
      expect(jsonAliasRead.status, alias).toBe(200);
      expect(await result<JsonObject>(jsonAliasRead)).toMatchObject({
        identifier: "json-alias-write",
      });
    }
    expect((await api3Fetch(
      name,
      null,
      "/api/v3/treatments/known-mime-write.ttf",
    )).status).toBe(401);
    const knownUnsupported = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/known-mime-write.ttf",
    );
    expect(knownUnsupported.status).toBe(406);
    expect(knownUnsupported.headers.get("Vary")).toBe("Accept");
    const csvSupported = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/known-mime-write.csv",
    );
    expect(csvSupported.status).toBe(200);
    expect(csvSupported.headers.get("Content-Type")).toMatch(/text\/csv/);
    expect(csvSupported.headers.get("Vary")).toBe("Accept");
    expect(await csvSupported.text()).toContain("known-mime-write");
    const acceptXml = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/known-mime-write",
      { headers: { Accept: "application/xml" } },
    );
    expect(acceptXml.status).toBe(200);
    expect(acceptXml.headers.get("Content-Type")).toMatch(/application\/xml/);
    expect(acceptXml.headers.get("Vary")).toBe("Accept");
    expect(await acceptXml.text()).toContain("<identifier>known-mime-write</identifier>");
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/known-mime-write",
      { headers: { Accept: "Application/JSON" } },
    )).status).toBe(200);
    const zeroQuality = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/known-mime-write",
      { headers: { Accept: "application/json;q=0" } },
    );
    expect(zeroQuality.status).toBe(406);
    expect(zeroQuality.headers.get("Vary")).toBe("Accept");

    for (const [path, method] of [
      ["/api/v3/treatments", "PATCH"],
      ["/api/v3/treatments/not-a-post-route", "POST"],
    ] as const) {
      const unmatched = await api3Fetch(
        name,
        null,
        path,
        jsonMutation(method, { notes: "route must not authenticate" }),
      );
      expect(unmatched.status).toBe(404);
      expect(await unmatched.json()).toEqual({
        status: 404,
        message: "Bad operation or collection",
      });
    }
    const genericMissing = await api3Fetch(name, null, "/api/v3/not-implemented");
    expect(await genericMissing.json()).toEqual({
      status: 404,
      message: "Bad operation or collection",
    });
    const primitive = await api3Fetch(name, jwt, "/api/v3/treatments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "42",
    });
    expect(await primitive.json()).toEqual({
      status: 400,
      message: "Bad or missing request body",
    });
  });

  it("adapts Express implicit HEAD and complete cross-origin API preflight", async () => {
    const name = tenant("api3-head-cors");
    const preflight = await SELF.fetch(withTenant(
      "/api/v3/treatments/head-cors-treatment",
      name,
    ), {
      method: "OPTIONS",
      headers: {
        Origin: "https://client.example",
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "authorization,if-unmodified-since",
      },
    });
    expect(preflight.status).toBe(200);
    expect(await preflight.text()).toBe("OK");
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const methods = preflight.headers.get("Access-Control-Allow-Methods") ?? "";
    for (const method of ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"]) {
      expect(methods.split(",")).toContain(method);
    }
    const allowedHeaders = (preflight.headers.get("Access-Control-Allow-Headers") ?? "")
      .toLowerCase();
    for (const header of ["authorization", "api-secret", "if-modified-since", "if-unmodified-since"]) {
      expect(allowedHeaders).toContain(header);
    }

    for (const path of ["/api/versions", "/api/v3/version"]) {
      const response = await SELF.fetch(`https://example.test${path}`, { method: "HEAD" });
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe("");
      expect(response.headers.get("Content-Type"), path).toContain("application/json");
    }

    const jwt = await issueSubject(name, "HEAD reader", [
      "api:treatments:create",
      "api:treatments:read",
    ]);
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments",
      jsonMutation("POST", treatment(
        "head-cors-treatment",
        "2026-06-01T02:30:00.000Z",
      )),
    )).status).toBe(201);

    for (const path of [
      "/api/v3/status",
      "/api/v3/lastModified",
      "/api/v3/treatments",
      "/api/v3/treatments/head-cors-treatment",
      "/api/v3/treatments/history/946684800001",
    ]) {
      const response = await api3Fetch(name, jwt, path, { method: "HEAD" });
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe("");
    }

    const missingAuth = await api3Fetch(
      name,
      null,
      "/api/v3/treatments",
      { method: "HEAD" },
    );
    expect(missingAuth.status).toBe(401);
    expect(await missingAuth.text()).toBe("");
    const unknown = await api3Fetch(
      name,
      jwt,
      "/api/v3/NOT_EXIST",
      { method: "HEAD" },
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe("");
  });

  it("orders dynamic permission, existence, precondition, and validation like the locked handlers", async () => {
    const name = tenant("api3-validation-order");
    const reader = await issueSubject(name, "Validation reader", []);
    const creator = await issueSubject(name, "Validation creator", ["api:treatments:create"]);
    const updater = await issueSubject(name, "Validation updater", ["api:treatments:update"]);
    const full = await issueSubject(name, "Validation owner", [
      "api:treatments:create",
      "api:treatments:read",
      "api:treatments:update",
      "api:treatments:delete",
    ]);
    const createdAt = "2026-06-01T03:00:00.000Z";
    const base = treatment("validation-order", createdAt);
    expect((await api3Fetch(
      name,
      full,
      "/api/v3/treatments",
      jsonMutation("POST", base),
    )).status).toBe(201);

    const invalidNew = { identifier: "invalid-new", date: null, utcOffset: 0, app: "test" };
    const deniedBeforeValidation = await api3Fetch(
      name,
      reader,
      "/api/v3/treatments",
      jsonMutation("POST", invalidNew),
    );
    expect(await deniedBeforeValidation.json()).toEqual({
      status: 403,
      message: "Missing permission api:treatments:create",
    });
    const duplicateDeniedBeforeValidation = await api3Fetch(
      name,
      creator,
      "/api/v3/treatments",
      jsonMutation("POST", { identifier: "validation-order", date: null, utcOffset: 0, app: "test" }),
    );
    expect(await duplicateDeniedBeforeValidation.json()).toEqual({
      status: 403,
      message: "Missing permission api:treatments:update",
    });
    const duplicateValidated = await api3Fetch(
      name,
      updater,
      "/api/v3/treatments",
      jsonMutation("POST", { identifier: "validation-order", date: null, utcOffset: 0, app: "test" }),
    );
    expect(duplicateValidated.status).toBe(400);

    const missingPut = await api3Fetch(
      name,
      updater,
      "/api/v3/treatments/missing-validation-put",
      jsonMutation("PUT", invalidNew),
    );
    expect(await missingPut.json()).toEqual({
      status: 403,
      message: "Missing permission api:treatments:create",
    });
    const missingPatch = await api3Fetch(
      name,
      updater,
      "/api/v3/treatments/missing-validation-patch",
      jsonMutation("PATCH", { date: null }),
    );
    expect(await missingPatch.json()).toEqual({ status: 404 });
    const deniedPatch = await api3Fetch(
      name,
      reader,
      "/api/v3/treatments/missing-validation-patch",
      jsonMutation("PATCH", { date: null }),
    );
    expect(await deniedPatch.json()).toEqual({
      status: 403,
      message: "Missing permission api:treatments:update",
    });

    const stalePatch = await api3Fetch(
      name,
      updater,
      "/api/v3/treatments/validation-order",
      jsonMutation("PATCH", { utcOffset: "invalid" }, {
        "If-Unmodified-Since": "Sat, 01 Jan 2000 00:00:00 GMT",
      }),
    );
    expect(await stalePatch.json()).toEqual({ status: 412 });

    expect((await api3Fetch(
      name,
      full,
      "/api/v3/treatments",
      jsonMutation("POST", treatment("readonly-treatment", "2026-06-01T04:00:00.000Z", {
        isReadOnly: true,
      })),
    )).status).toBe(201);
    const readonlyPatch = await api3Fetch(
      name,
      updater,
      "/api/v3/treatments/readonly-treatment",
      jsonMutation("PATCH", { notes: "forbidden by read-only flag" }),
    );
    expect(await readonlyPatch.json()).toEqual({
      status: 422,
      message: "Trying to modify read-only document",
    });

    expect((await api3Fetch(
      name,
      full,
      "/api/v3/treatments/validation-order",
      { method: "DELETE" },
    )).status).toBe(200);
    const gonePatch = await api3Fetch(
      name,
      updater,
      "/api/v3/treatments/validation-order",
      jsonMutation("PATCH", { date: null }),
    );
    expect(await gonePatch.json()).toEqual({ status: 410 });
  });

  it("represents every locked api3.patch contract on the Workers runtime", async () => {
    const name = tenant("api3-patch-file");
    const creator = await issueSubject(name, "Patch creator", [
      "api:treatments:create",
      "api:treatments:read",
    ]);
    const updater = await issueSubject(name, "Patch updater", [
      "api:treatments:update",
      "api:treatments:read",
    ]);
    const date = Date.now() - 60_000;
    const valid = treatment(
      "patch-file-treatment",
      new Date(date).toISOString(),
      {
        utcOffset: -180,
        eventType: "Correction Bolus",
        insulin: 0.3,
      },
    );
    const resource = "/api/v3/treatments/patch-file-treatment";

    const missingAuth = await api3Fetch(
      name,
      null,
      "/api/v3/treatments/FAKE_IDENTIFIER",
      { method: "PATCH" },
    );
    expect(missingAuth.status).toBe(401);
    expect(await missingAuth.json()).toEqual({
      status: 401,
      message: "Missing or bad access token or JWT",
    });

    const missingCollection = await api3Fetch(
      name,
      updater,
      "/api/v3/NOT_EXIST",
      jsonMutation("PATCH", valid),
    );
    expect(missingCollection.status).toBe(404);
    expect(await missingCollection.json()).toEqual({
      status: 404,
      message: "Bad operation or collection",
    });

    const missingDocument = await api3Fetch(
      name,
      updater,
      resource,
      jsonMutation("PATCH", valid),
    );
    expect(missingDocument.status).toBe(404);
    expect(await missingDocument.json()).toEqual({ status: 404 });

    expect((await api3Fetch(
      name,
      creator,
      "/api/v3/treatments",
      jsonMutation("POST", valid),
    )).status).toBe(201);

    const immutableAlterations: Array<[string, unknown]> = [
      ["identifier", "MODIFIED"],
      ["date", date + 10_000],
      ["utcOffset", -300],
      ["eventType", "MODIFIED"],
      ["device", "MODIFIED"],
      ["app", "MODIFIED"],
      ["srvCreated", date - 10_000],
      ["subject", "MODIFIED"],
      ["srvModified", date - 100_000],
      ["modifiedBy", "MODIFIED"],
      ["isValid", false],
    ];
    for (const [field, value] of immutableAlterations) {
      const rejected = await api3Fetch(
        name,
        updater,
        resource,
        jsonMutation("PATCH", { [field]: value }),
      );
      expect(rejected.status, field).toBe(400);
      expect(await rejected.json(), field).toEqual({
        status: 400,
        message: `Field ${field} cannot be modified by the client`,
      });
    }

    const patched = await api3Fetch(
      name,
      updater,
      resource,
      jsonMutation("PATCH", { ...valid, carbs: 10 }),
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ status: 200 });
    expect(await result<JsonObject>(await api3Fetch(name, updater, resource)))
      .toMatchObject({
        identifier: "patch-file-treatment",
        carbs: 10,
        insulin: 0.3,
        subject: "Patch creator",
        modifiedBy: "Patch updater",
      });

    const basalDate = date + 1;
    const basal = treatment(
      "patch-file-temp-basal",
      new Date(basalDate).toISOString(),
      {
        utcOffset: -180,
        eventType: "Temp Basal",
        absolute: 1.2,
        duration: 30,
      },
    );
    expect((await api3Fetch(
      name,
      creator,
      "/api/v3/treatments",
      jsonMutation("POST", basal),
    )).status).toBe(201);
    const basalPatch = await api3Fetch(
      name,
      updater,
      "/api/v3/treatments/patch-file-temp-basal",
      jsonMutation("PATCH", {
        absolute: 0.7,
        duration: 0,
        durationInMilliseconds: 26_584,
      }),
    );
    expect(basalPatch.status).toBe(200);
    const basalActual = await result<JsonObject>(await api3Fetch(
      name,
      updater,
      "/api/v3/treatments/patch-file-temp-basal",
    ));
    expect(basalActual).toMatchObject({
      identifier: "patch-file-temp-basal",
      absolute: 0.7,
      duration: 0,
      durationInMilliseconds: 26_584,
      endmills: basalDate + 26_584,
      subject: "Patch creator",
      modifiedBy: "Patch updater",
    });
  });

  it("represents every locked api3.delete contract on the Workers runtime", async () => {
    const name = tenant("api3-delete-file");
    const deleter = await issueSubject(name, "Delete file", [
      "api:treatments:delete",
    ]);

    const missingAuth = await api3Fetch(
      name,
      null,
      "/api/v3/treatments/FAKE_IDENTIFIER",
      { method: "DELETE" },
    );
    expect(missingAuth.status).toBe(401);
    expect(await missingAuth.json()).toEqual({
      status: 401,
      message: "Missing or bad access token or JWT",
    });

    const missingCollection = await api3Fetch(
      name,
      deleter,
      "/api/v3/NOT_EXIST",
      { method: "DELETE" },
    );
    expect(missingCollection.status).toBe(404);
    expect(await missingCollection.json()).toEqual({
      status: 404,
      message: "Bad operation or collection",
    });
  });

  it("represents every locked api3.update contract on the Workers runtime", async () => {
    const name = tenant("api3-update-file");
    const updateOnly = await issueSubject(name, "PUT updater", [
      "api:treatments:update",
      "api:treatments:read",
    ]);
    const owner = await issueSubject(name, "PUT owner", [
      "api:treatments:create",
      "api:treatments:update",
      "api:treatments:read",
      "api:treatments:delete",
    ]);
    const date = Date.now() - 120_000;
    const identifier = "update-file-treatment";
    const resource = `/api/v3/treatments/${identifier}`;
    const original = treatment(identifier, new Date(date).toISOString(), {
      utcOffset: -180,
      eventType: "Correction Bolus",
      insulin: 0.3,
    });

    const missingAuth = await api3Fetch(
      name,
      null,
      "/api/v3/treatments/FAKE_IDENTIFIER",
      { method: "PUT" },
    );
    expect(missingAuth.status).toBe(401);
    expect(await missingAuth.json()).toEqual({
      status: 401,
      message: "Missing or bad access token or JWT",
    });

    const missingCollection = await api3Fetch(
      name,
      updateOnly,
      "/api/v3/NOT_EXIST",
      jsonMutation("PUT", original),
    );
    expect(missingCollection.status).toBe(404);
    expect(await missingCollection.json()).toEqual({
      status: 404,
      message: "Bad operation or collection",
    });

    const deniedUpsert = await api3Fetch(
      name,
      updateOnly,
      resource,
      jsonMutation("PUT", original),
    );
    expect(deniedUpsert.status).toBe(403);
    expect(await deniedUpsert.json()).toEqual({
      status: 403,
      message: "Missing permission api:treatments:create",
    });

    const created = await api3Fetch(
      name,
      owner,
      resource,
      jsonMutation("PUT", original),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      status: 201,
      identifier,
      lastModified: expect.any(Number),
    });
    expect(created.headers.get("Last-Modified")).not.toBeNull();
    expect(await result<JsonObject>(await api3Fetch(name, owner, resource)))
      .toMatchObject({
        ...original,
        subject: "PUT owner",
        srvCreated: expect.any(Number),
        srvModified: expect.any(Number),
      });

    const replacement: JsonObject = { ...original, carbs: 10 };
    delete replacement.insulin;
    const updated = await api3Fetch(
      name,
      updateOnly,
      resource,
      jsonMutation("PUT", replacement),
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ status: 200, lastModified: expect.any(Number) });
    const replaced = await result<JsonObject>(await api3Fetch(name, updateOnly, resource));
    expect(replaced).toMatchObject({
      ...replacement,
      subject: "PUT updater",
      srvCreated: expect.any(Number),
      srvModified: expect.any(Number),
    });
    expect(replaced).not.toHaveProperty("insulin");
    expect(replaced).not.toHaveProperty("modifiedBy");

    const future = new Date(Date.now() + 60_000).toUTCString();
    const acceptedConditional = await api3Fetch(
      name,
      updateOnly,
      resource,
      jsonMutation("PUT", { ...replacement, carbs: 11 }, {
        "If-Unmodified-Since": future,
      }),
    );
    expect(acceptedConditional.status).toBe(200);
    const beforeStale = await result<JsonObject>(await api3Fetch(name, updateOnly, resource));
    const stale = await api3Fetch(
      name,
      updateOnly,
      resource,
      jsonMutation("PUT", { ...replacement, carbs: 12 }, {
        "If-Unmodified-Since": "Sat, 01 Jan 2000 00:00:00 GMT",
      }),
    );
    expect(stale.status).toBe(412);
    expect(await stale.json()).toEqual({ status: 412 });
    expect(await result<JsonObject>(await api3Fetch(name, updateOnly, resource))).toEqual(beforeStale);

    const immutableAlterations: Array<[string, unknown]> = [
      ["date", date + 10_000],
      ["utcOffset", -300],
      ["eventType", "MODIFIED"],
      ["device", "MODIFIED"],
      ["app", "MODIFIED"],
      ["srvCreated", date - 10_000],
      ["subject", "MODIFIED"],
      ["srvModified", date - 100_000],
      ["modifiedBy", "MODIFIED"],
      ["isValid", false],
    ];
    for (const [field, value] of immutableAlterations) {
      const rejected = await api3Fetch(
        name,
        updateOnly,
        resource,
        jsonMutation("PUT", { ...replacement, carbs: 11, [field]: value }),
      );
      expect(rejected.status, field).toBe(400);
      expect(await rejected.json(), field).toEqual({
        status: 400,
        message: `Field ${field} cannot be modified by the client`,
      });
    }

    const ignoredIdentifier = await api3Fetch(
      name,
      updateOnly,
      resource,
      jsonMutation("PUT", { ...replacement, identifier: "MODIFIED", carbs: 13 }),
    );
    expect(ignoredIdentifier.status).toBe(200);
    expect(await result<JsonObject>(await api3Fetch(name, updateOnly, resource)))
      .toMatchObject({ identifier, carbs: 13 });

    const basalDate = date + 1;
    const basalIdentifier = "update-file-temp-basal";
    const basalResource = `/api/v3/treatments/${basalIdentifier}`;
    const basal = treatment(basalIdentifier, new Date(basalDate).toISOString(), {
      utcOffset: -180,
      eventType: "Temp Basal",
      absolute: 1.2,
      duration: 30,
    });
    expect((await api3Fetch(
      name,
      owner,
      basalResource,
      jsonMutation("PUT", basal),
    )).status).toBe(201);
    const replacedBasal = await api3Fetch(
      name,
      updateOnly,
      basalResource,
      jsonMutation("PUT", {
        ...basal,
        absolute: 0.7,
        duration: 0,
        durationInMilliseconds: 26_584,
      }),
    );
    expect(replacedBasal.status).toBe(200);
    expect(await result<JsonObject>(await api3Fetch(name, updateOnly, basalResource)))
      .toMatchObject({
        identifier: basalIdentifier,
        absolute: 0.7,
        duration: 0,
        durationInMilliseconds: 26_584,
        endmills: basalDate + 26_584,
        subject: "PUT updater",
      });

    expect((await api3Fetch(name, owner, resource, { method: "DELETE" })).status).toBe(200);
    const gone = await api3Fetch(
      name,
      updateOnly,
      resource,
      jsonMutation("PUT", replacement),
    );
    expect(gone.status).toBe(410);
    expect(await gone.json()).toEqual({ status: 410 });
  });

  it("represents every locked api3.create contract on the Workers runtime", async () => {
    const name = tenant("api3-create-file");
    const reader = await issueSubject(name, "CREATE reader", []);
    const createOnly = await issueSubject(name, "CREATE creator", [
      "api:treatments:create",
      "api:treatments:read",
    ]);
    const updateOnly = await issueSubject(name, "CREATE updater", [
      "api:treatments:update",
      "api:treatments:read",
    ]);
    const owner = await issueSubject(name, "CREATE owner", [
      "api:treatments:create",
      "api:treatments:update",
      "api:treatments:read",
      "api:treatments:delete",
    ]);
    const baseDate = Date.now() - 10 * 60_000;
    const valid: JsonObject = {
      identifier: "create-valid-document",
      date: baseDate,
      utcOffset: 0,
      app: "api3-create-test",
      device: "API3 CREATE",
      eventType: "Correction Bolus",
      insulin: 0.3,
    };

    const missingAuth = await api3Fetch(
      name,
      null,
      "/api/v3/treatments",
      jsonMutation("POST", valid),
    );
    expect(missingAuth.status).toBe(401);
    expect(await missingAuth.json()).toEqual({
      status: 401,
      message: "Missing or bad access token or JWT",
    });

    const missingCollection = await api3Fetch(
      name,
      createOnly,
      "/api/v3/NOT_EXIST",
      jsonMutation("POST", valid),
    );
    expect(missingCollection.status).toBe(404);
    expect(await missingCollection.json()).toEqual({
      status: 404,
      message: "Bad operation or collection",
    });

    const denied = await api3Fetch(
      name,
      reader,
      "/api/v3/treatments",
      jsonMutation("POST", valid),
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      status: 403,
      message: "Missing permission api:treatments:create",
    });

    const empty = await api3Fetch(
      name,
      createOnly,
      "/api/v3/treatments",
      jsonMutation("POST", {}),
    );
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({
      status: 400,
      message: "Bad or missing request body",
    });

    const created = await api3Fetch(
      name,
      createOnly,
      "/api/v3/treatments",
      jsonMutation("POST", valid),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json<JsonObject>();
    expect(createdBody).toMatchObject({
      status: 201,
      identifier: "create-valid-document",
      lastModified: expect.any(Number),
    });
    expect(created.headers.get("Location")).toBe(
      "/api/v3/treatments/create-valid-document",
    );
    const createdHeader = Date.parse(String(created.headers.get("Last-Modified")));
    const createdActual = await result<JsonObject>(await api3Fetch(
      name,
      createOnly,
      "/api/v3/treatments/create-valid-document",
    ));
    expect(createdActual).toMatchObject({
      ...valid,
      subject: "CREATE creator",
      srvCreated: expect.any(Number),
      srvModified: createdBody.lastModified,
    });
    expect(Math.floor(Number(createdActual.srvModified) / 1_000) * 1_000).toBe(createdHeader);
    expect(Math.floor(Number(createdActual.srvCreated) / 1_000) * 1_000).toBe(createdHeader);

    const validationBase: JsonObject = {
      identifier: "create-validation",
      date: baseDate + 1,
      utcOffset: 0,
      app: "api3-create-test",
      device: "API3 CREATE validation",
      eventType: "Correction Bolus",
    };
    const invalidDates: unknown[] = [undefined, null, "ABC", -1, 1, "2019-20-60T50:90:90"];
    for (const invalidDate of invalidDates) {
      const document = { ...validationBase };
      if (invalidDate === undefined) delete document.date;
      else document.date = invalidDate;
      const response = await api3Fetch(
        name,
        createOnly,
        "/api/v3/treatments",
        jsonMutation("POST", document),
      );
      expect(response.status, String(invalidDate)).toBe(400);
      expect(await response.json(), String(invalidDate)).toEqual({
        status: 400,
        message: "Bad or missing date field",
      });
    }
    for (const invalidOffset of [-5_000, "ABC", null]) {
      const response = await api3Fetch(
        name,
        createOnly,
        "/api/v3/treatments",
        jsonMutation("POST", { ...validationBase, utcOffset: invalidOffset }),
      );
      expect(response.status, String(invalidOffset)).toBe(400);
      expect(await response.json(), String(invalidOffset)).toEqual({
        status: 400,
        message: "Bad or missing utcOffset field",
      });
    }
    for (const invalidApp of [undefined, null, ""]) {
      const document = { ...validationBase };
      if (invalidApp === undefined) delete document.app;
      else document.app = invalidApp;
      const response = await api3Fetch(
        name,
        createOnly,
        "/api/v3/treatments",
        jsonMutation("POST", document),
      );
      expect(response.status, String(invalidApp)).toBe(400);
      expect(await response.json(), String(invalidApp)).toEqual({
        status: 400,
        message: "Bad or missing app field",
      });
    }

    const validOffset = await api3Fetch(
      name,
      createOnly,
      "/api/v3/treatments",
      jsonMutation("POST", {
        ...validationBase,
        identifier: "create-valid-offset",
        utcOffset: 120,
      }),
    );
    expect(validOffset.status).toBe(201);
    expect(await result<JsonObject>(await api3Fetch(
      name,
      createOnly,
      "/api/v3/treatments/create-valid-offset",
    ))).toMatchObject({ utcOffset: 120 });

    const normalized = await api3Fetch(
      name,
      createOnly,
      "/api/v3/treatments",
      jsonMutation("POST", {
        ...validationBase,
        identifier: "create-normalized-date",
        date: "2019-06-10T08:07:08,576+02:00",
        utcOffset: undefined,
      }),
    );
    expect(normalized.status).toBe(201);
    expect(await result<JsonObject>(await api3Fetch(
      name,
      createOnly,
      "/api/v3/treatments/create-normalized-date",
    ))).toMatchObject({
      date: 1_560_146_828_576,
      utcOffset: 120,
      created_at: "2019-06-10T06:07:08.576Z",
    });

    const permissionDocument = {
      ...valid,
      identifier: "create-dedup-permission",
      date: baseDate + 10_000,
    };
    expect((await api3Fetch(
      name,
      createOnly,
      "/api/v3/treatments",
      jsonMutation("POST", permissionDocument),
    )).status).toBe(201);
    const deniedDedup = await api3Fetch(
      name,
      createOnly,
      "/api/v3/treatments",
      jsonMutation("POST", permissionDocument),
    );
    expect(deniedDedup.status).toBe(403);
    expect(await deniedDedup.json()).toEqual({
      status: 403,
      message: "Missing permission api:treatments:update",
    });

    const upsertDocument = {
      ...valid,
      identifier: "create-upsert-identifier",
      date: baseDate + 20_000,
    };
    expect((await api3Fetch(
      name,
      owner,
      "/api/v3/treatments",
      jsonMutation("POST", upsertDocument),
    )).status).toBe(201);
    const upserted = await api3Fetch(
      name,
      owner,
      "/api/v3/treatments",
      jsonMutation("POST", { ...upsertDocument, insulin: 0.5 }),
    );
    expect(upserted.status).toBe(200);
    expect(await upserted.json()).toMatchObject({
      status: 200,
      identifier: "create-upsert-identifier",
      isDeduplication: true,
    });
    expect(await result<JsonObject>(await api3Fetch(
      name,
      owner,
      "/api/v3/treatments/create-upsert-identifier",
    ))).toMatchObject({ insulin: 0.5 });

    const fallbackCreatedAt = new Date(baseDate + 30_000).toISOString();
    const legacyFallback = await adminWrite(name, "/api/v1/treatments", {
      date: Date.parse(fallbackCreatedAt),
      utcOffset: 0,
      app: "api3-create-test",
      device: "API3 CREATE fallback",
      eventType: "Correction Bolus",
      created_at: fallbackCreatedAt,
      insulin: 0.3,
    });
    expect(legacyFallback.status).toBe(200);
    const [legacyFallbackDocument] = await legacyFallback.json<JsonObject[]>();
    const legacyFallbackId = String(legacyFallbackDocument?._id);
    const fallbackIdentifier = "create-modern-fallback";
    const fallbackDedup = await api3Fetch(
      name,
      owner,
      "/api/v3/treatments",
      jsonMutation("POST", {
        date: Date.parse(fallbackCreatedAt),
        utcOffset: 0,
        app: "api3-create-test",
        device: "API3 CREATE fallback",
        eventType: "Correction Bolus",
        created_at: fallbackCreatedAt,
        insulin: 0.4,
        identifier: fallbackIdentifier,
      }),
    );
    expect(fallbackDedup.status).toBe(200);
    expect(await fallbackDedup.json()).toMatchObject({
      status: 200,
      identifier: fallbackIdentifier,
      deduplicatedIdentifier: legacyFallbackId,
      isDeduplication: true,
    });
    expect(await result<JsonObject>(await api3Fetch(
      name,
      owner,
      `/api/v3/treatments/${fallbackIdentifier}`,
    ))).toMatchObject({ identifier: fallbackIdentifier, insulin: 0.4 });

    const onlyCreatedAt = new Date(baseDate + 40_000).toISOString();
    const legacyOnlyDate = await adminWrite(name, "/api/v1/treatments", {
      date: Date.parse(onlyCreatedAt),
      utcOffset: 0,
      app: "api3-create-test",
      device: "API3 CREATE no fallback",
      eventType: "Note",
      created_at: onlyCreatedAt,
      notes: "legacy note",
    });
    expect(legacyOnlyDate.status).toBe(200);
    const [legacyOnlyDateDocument] = await legacyOnlyDate.json<JsonObject[]>();
    const legacyOnlyDateId = String(legacyOnlyDateDocument?._id);
    const distinct = await api3Fetch(
      name,
      owner,
      "/api/v3/treatments",
      jsonMutation("POST", {
        date: Date.parse(onlyCreatedAt),
        utcOffset: 0,
        app: "api3-create-test",
        device: "API3 CREATE no fallback",
        eventType: "Meal Bolus",
        created_at: onlyCreatedAt,
        insulin: 0.4,
        identifier: "create-distinct-event-type",
      }),
    );
    expect(distinct.status).toBe(201);
    expect(await result<JsonObject>(await api3Fetch(
      name,
      owner,
      `/api/v3/treatments/${legacyOnlyDateId}`,
    ))).toMatchObject({ eventType: "Note" });
    expect(await result<JsonObject>(await api3Fetch(
      name,
      owner,
      "/api/v3/treatments/create-distinct-event-type",
    ))).toMatchObject({ eventType: "Meal Bolus" });

    const deletedIdentifier = "create-overwrite-deleted";
    const deletedFirst = {
      ...valid,
      identifier: deletedIdentifier,
      date: baseDate + 50_000,
    };
    expect((await api3Fetch(
      name,
      owner,
      "/api/v3/treatments",
      jsonMutation("POST", deletedFirst),
    )).status).toBe(201);
    expect((await api3Fetch(
      name,
      owner,
      `/api/v3/treatments/${deletedIdentifier}`,
      { method: "DELETE" },
    )).status).toBe(200);
    const deletedReplacement = { ...deletedFirst, date: baseDate + 60_000 };
    const deniedDeletedReplacement = await api3Fetch(
      name,
      createOnly,
      "/api/v3/treatments",
      jsonMutation("POST", deletedReplacement),
    );
    expect(deniedDeletedReplacement.status).toBe(403);
    expect(await deniedDeletedReplacement.json()).toEqual({
      status: 403,
      message: "Missing permission api:treatments:update",
    });
    const replacedDeleted = await api3Fetch(
      name,
      owner,
      "/api/v3/treatments",
      jsonMutation("POST", deletedReplacement),
    );
    expect(replacedDeleted.status).toBe(200);
    expect(await result<JsonObject>(await api3Fetch(
      name,
      owner,
      `/api/v3/treatments/${deletedIdentifier}`,
    ))).toMatchObject({
      identifier: deletedIdentifier,
      date: baseDate + 60_000,
    });

    const calculatedDocument: JsonObject = {
      date: 1_780_790_400_000,
      utcOffset: 0,
      app: "api3-create-test",
      device: "API3 CREATE identifier",
      eventType: "Correction Bolus",
      insulin: 0.3,
    };
    const expectedCalculatedIdentifier = "77639ea8-cbde-529d-ab42-c0bab2b49f9e";
    const calculated = await api3Fetch(
      name,
      createOnly,
      "/api/v3/treatments",
      jsonMutation("POST", calculatedDocument),
    );
    expect(calculated.status).toBe(201);
    expect(await calculated.json()).toMatchObject({
      status: 201,
      identifier: expectedCalculatedIdentifier,
    });
    expect(calculated.headers.get("Location")).toBe(
      `/api/v3/treatments/${expectedCalculatedIdentifier}`,
    );
    const calculatedDedup = await api3Fetch(
      name,
      updateOnly,
      "/api/v3/treatments",
      jsonMutation("POST", calculatedDocument),
    );
    expect(calculatedDedup.status).toBe(200);
    expect(await calculatedDedup.json()).toMatchObject({
      status: 200,
      identifier: expectedCalculatedIdentifier,
      isDeduplication: true,
    });
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      updateOnly,
      `/api/v3/treatments?date%24eq=${calculatedDocument.date}`,
    ))).toHaveLength(1);

    const generated = await api3Fetch(
      name,
      owner,
      "/api/v3/treatments",
      jsonMutation("POST", {
        date: baseDate + 70_000,
        utcOffset: 0,
        app: "api3-create-test",
        device: "API3 CREATE generated",
        eventType: "Note",
        notes: "missing identifier",
      }),
    );
    expect(generated.status).toBe(201);
    const generatedIdentifier = String((await generated.json<JsonObject>()).identifier);
    expect(generatedIdentifier.length).toBeGreaterThan(0);
    expect(await result<JsonObject>(await api3Fetch(
      name,
      owner,
      `/api/v3/treatments/${generatedIdentifier}`,
    ))).toMatchObject({ identifier: generatedIdentifier, notes: "missing identifier" });

    const objectIdIdentifier = "507f1f77bcf86cd799439011";
    expect((await api3Fetch(
      name,
      owner,
      "/api/v3/treatments",
      jsonMutation("POST", {
        ...valid,
        identifier: objectIdIdentifier,
        date: baseDate + 80_000,
        notes: "ObjectId identifier",
      }),
    )).status).toBe(201);
    expect(await result<JsonObject>(await api3Fetch(
      name,
      owner,
      `/api/v3/treatments/${objectIdIdentifier}`,
    ))).toMatchObject({ identifier: objectIdIdentifier, notes: "ObjectId identifier" });

    const uuidIdentifier = "E1F2A3B4-C5D6-7890-ABCD-EF1234567890";
    const uuidDocument = {
      ...valid,
      identifier: uuidIdentifier,
      date: baseDate + 90_000,
      eventType: "Temporary Override",
      reason: "UUID identifier",
    };
    expect((await api3Fetch(
      name,
      owner,
      "/api/v3/treatments",
      jsonMutation("POST", uuidDocument),
    )).status).toBe(201);
    const uuidDedup = await api3Fetch(
      name,
      owner,
      "/api/v3/treatments",
      jsonMutation("POST", { ...uuidDocument, reason: "Updated reason" }),
    );
    expect(uuidDedup.status).toBe(200);
    expect(await uuidDedup.json()).toMatchObject({
      status: 200,
      identifier: uuidIdentifier,
      isDeduplication: true,
    });
    expect(await result<JsonObject>(await api3Fetch(
      name,
      owner,
      `/api/v3/treatments/${uuidIdentifier}`,
    ))).toMatchObject({ identifier: uuidIdentifier, reason: "Updated reason" });
  });

  it("runs the create, dedupe, read, replace, patch, history, and delete workflow", async () => {
    const name = tenant("api3-workflow");
    const permissions = [
      "api:treatments:create",
      "api:treatments:read",
      "api:treatments:update",
      "api:treatments:delete",
    ];
    const alice = await issueSubject(name, "Alice", permissions);
    const bob = await issueSubject(name, "Bob", permissions);
    const createdAt = "2026-06-02T00:00:00.000Z";
    const document = treatment("workflow-treatment", createdAt, { notes: "created" });

    const created = await api3Fetch(
      name,
      alice,
      "/api/v3/treatments",
      jsonMutation("POST", document),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json<JsonObject>();
    expect(createdBody).toMatchObject({
      status: 201,
      identifier: "workflow-treatment",
      lastModified: expect.any(Number),
    });
    expect(created.headers.get("Location")).toBe("/api/v3/treatments/workflow-treatment");
    expect(created.headers.get("Last-Modified")).not.toBeNull();
    expect(created.headers.get("Content-Type")).toMatch(/application\/json/);

    const deduplicated = await api3Fetch(
      name,
      alice,
      "/api/v3/treatments",
      jsonMutation("POST", { ...document, notes: "deduplicated" }),
    );
    expect(deduplicated.status).toBe(200);
    expect(await deduplicated.json()).toMatchObject({
      status: 200,
      identifier: "workflow-treatment",
      isDeduplication: true,
    });

    const readCreated = await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/workflow-treatment",
    );
    expect(await result<JsonObject>(readCreated)).toMatchObject({
      identifier: "workflow-treatment",
      notes: "deduplicated",
      subject: "Alice",
      srvCreated: expect.any(Number),
      srvModified: expect.any(Number),
    });
    const readLastModified = readCreated.headers.get("Last-Modified");
    expect(readLastModified).not.toBeNull();
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/workflow-treatment",
      { headers: { "If-Modified-Since": String(readLastModified) } },
    )).status).toBe(304);

    const replaced = await api3Fetch(
      name,
      bob,
      "/api/v3/treatments/workflow-treatment",
      jsonMutation("PUT", { ...document, notes: "replaced" }),
    );
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toEqual({
      status: 200,
      lastModified: expect.any(Number),
    });

    const stale = await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/workflow-treatment",
      jsonMutation("PUT", { ...document, notes: "stale overwrite" }, {
        "If-Unmodified-Since": "Sat, 01 Jan 2000 00:00:00 GMT",
      }),
    );
    expect(stale.status).toBe(412);
    expect(await stale.json()).toEqual({ status: 412 });

    const patched = await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/workflow-treatment",
      jsonMutation("PATCH", { notes: "patched" }),
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ status: 200 });
    expect(await result<JsonObject>(await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/workflow-treatment",
    ))).toMatchObject({
      subject: "Bob",
      modifiedBy: "Alice",
      notes: "patched",
    });

    const lastModified = await result<JsonObject>(await api3Fetch(
      name,
      alice,
      "/api/v3/lastModified",
    ));
    expect(lastModified).toMatchObject({
      srvDate: expect.any(Number),
      collections: { treatments: expect.any(Number) },
    });

    const history = await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/history/946684800001",
    );
    expect((await result<JsonObject[]>(history))).toEqual([
      expect.objectContaining({ identifier: "workflow-treatment", notes: "patched" }),
    ]);
    expect(history.headers.get("ETag")).toMatch(/^W\/"\d+"$/);
    const headerHistory = await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/history",
      { headers: { "Last-Modified": "Sat, 01 Jan 2000 00:00:01 GMT" } },
    );
    expect((await result<JsonObject[]>(headerHistory))).toEqual([
      expect.objectContaining({ identifier: "workflow-treatment", notes: "patched" }),
    ]);

    const softDeleted = await api3Fetch(
      name,
      bob,
      "/api/v3/treatments/workflow-treatment",
      { method: "DELETE" },
    );
    expect(await softDeleted.json()).toEqual({ status: 200 });
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/workflow-treatment",
    )).status).toBe(410);
    const search = await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/treatments",
    ));
    expect(search).toEqual([]);
    const tombstoneHistory = await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/history/946684800001",
    ));
    expect(tombstoneHistory).toEqual([
      expect.objectContaining({
        identifier: "workflow-treatment",
        isValid: false,
        modifiedBy: "Bob",
      }),
    ]);

    // Express' repeated scalar becomes an array, so strict === "true" is false.
    const repeatedPermanent = await api3Fetch(
      name,
      bob,
      "/api/v3/treatments/workflow-treatment?permanent=true&permanent=false",
      { method: "DELETE" },
    );
    expect(repeatedPermanent.status).toBe(200);
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/workflow-treatment",
    )).status).toBe(410);

    expect((await api3Fetch(
      name,
      bob,
      "/api/v3/treatments/workflow-treatment?permanent=true",
      { method: "DELETE" },
    )).status).toBe(200);
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/workflow-treatment",
    )).status).toBe(404);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/treatments/history/946684800001",
    ))).toEqual([]);
  });

  it("represents every locked api3.generic.workflow contract on the Workers runtime", async () => {
    const name = tenant("api3-generic-workflow-file");
    const permissions = [
      "api:treatments:create",
      "api:treatments:read",
      "api:treatments:update",
      "api:treatments:delete",
    ];
    const alice = await issueSubject(name, "Generic Alice", permissions);
    const bob = await issueSubject(name, "Generic Bob", permissions);
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const original = treatment("generic-workflow-file", createdAt, {
      eventType: "Correction Bolus",
      insulin: 1,
    });
    const resource = "/api/v3/treatments/generic-workflow-file";

    const initialModified = await result<JsonObject>(await api3Fetch(
      name,
      alice,
      "/api/v3/lastModified",
    ));
    expect(Number(initialModified.srvDate)).toBeGreaterThanOrEqual(1_546_300_800_000);
    const initialCollections = initialModified.collections as JsonObject;
    let historyTimestamp = Number(
      initialCollections.treatments
      ?? Number(initialModified.srvDate) - 10 * 60 * 1_000,
    );

    const status = await result<JsonObject>(await api3Fetch(
      name,
      alice,
      "/api/v3/status",
    ));
    expect(Number(status.srvDate)).toBeGreaterThanOrEqual(1_546_300_800_000);
    historyTimestamp = Number(status.srvDate);

    expect((await api3Fetch(name, alice, resource)).status).toBe(404);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/treatments?identifier_eq=generic-workflow-file",
    ))).toEqual([]);
    expect((await api3Fetch(
      name,
      alice,
      resource,
      { method: "DELETE" },
    )).status).toBe(404);

    const created = await api3Fetch(
      name,
      alice,
      "/api/v3/treatments",
      jsonMutation("POST", original),
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      status: 201,
      identifier: "generic-workflow-file",
      lastModified: expect.any(Number),
    });

    let actual = await result<JsonObject>(await api3Fetch(name, alice, resource));
    expect(actual).toMatchObject({
      ...original,
      subject: "Generic Alice",
      srvCreated: expect.any(Number),
      srvModified: expect.any(Number),
    });
    if (historyTimestamp >= Number(actual.srvModified)) {
      historyTimestamp = Number(actual.srvModified) - 1;
    }

    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/treatments?identifier%24eq=generic-workflow-file",
    ))).toEqual([
      expect.objectContaining({ identifier: "generic-workflow-file" }),
    ]);

    let history = await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      `/api/v3/treatments/history/${historyTimestamp}`,
    ));
    expect(history).toEqual([
      expect.objectContaining({ identifier: "generic-workflow-file" }),
    ]);
    historyTimestamp = Number(history[0]?.srvModified);

    actual.insulin = 0.5;
    const updated = await api3Fetch(
      name,
      bob,
      resource,
      jsonMutation("PUT", actual),
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      status: 200,
      lastModified: expect.any(Number),
    });

    history = await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      `/api/v3/treatments/history/${historyTimestamp}`,
    ));
    expect(history).toEqual([
      expect.objectContaining({
        identifier: "generic-workflow-file",
        insulin: 0.5,
        subject: "Generic Bob",
      }),
    ]);
    historyTimestamp = Number(history[0]?.srvModified);
    actual = await result<JsonObject>(await api3Fetch(name, alice, resource));
    expect(actual).toMatchObject({
      identifier: "generic-workflow-file",
      insulin: 0.5,
      subject: "Generic Bob",
    });

    const patched = await api3Fetch(
      name,
      alice,
      resource,
      jsonMutation("PATCH", { carbs: 5, insulin: 0.4 }),
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ status: 200 });
    history = await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      `/api/v3/treatments/history/${historyTimestamp}`,
    ));
    expect(history).toEqual([
      expect.objectContaining({
        identifier: "generic-workflow-file",
        carbs: 5,
        insulin: 0.4,
        modifiedBy: "Generic Alice",
      }),
    ]);
    historyTimestamp = Number(history[0]?.srvModified);
    actual = await result<JsonObject>(await api3Fetch(name, alice, resource));
    expect(actual).toMatchObject({
      identifier: "generic-workflow-file",
      carbs: 5,
      insulin: 0.4,
      subject: "Generic Bob",
      modifiedBy: "Generic Alice",
    });

    const softDeleted = await api3Fetch(
      name,
      bob,
      resource,
      { method: "DELETE" },
    );
    expect(softDeleted.status).toBe(200);
    expect(await softDeleted.json()).toEqual({ status: 200 });
    expect((await api3Fetch(name, alice, resource)).status).toBe(410);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/treatments?identifier_eq=generic-workflow-file",
    ))).toEqual([]);
    history = await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      `/api/v3/treatments/history/${historyTimestamp}`,
    ));
    expect(history).toEqual([
      expect.objectContaining({
        identifier: "generic-workflow-file",
        isValid: false,
        modifiedBy: "Generic Bob",
      }),
    ]);
    historyTimestamp = Number(history[0]?.srvModified);

    const permanentlyDeleted = await api3Fetch(
      name,
      bob,
      `${resource}?permanent=true`,
      { method: "DELETE" },
    );
    expect(permanentlyDeleted.status).toBe(200);
    expect(await permanentlyDeleted.json()).toEqual({ status: 200 });
    expect((await api3Fetch(name, alice, resource)).status).toBe(404);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      `/api/v3/treatments/history/${historyTimestamp}`,
    ))).toEqual([]);

    const readOnlyDocument = { ...original, isReadOnly: true };
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/treatments",
      jsonMutation("POST", readOnlyDocument),
    )).status).toBe(201);
    const readOnlyActual = await result<JsonObject>(await api3Fetch(
      name,
      alice,
      resource,
    ));
    expect(readOnlyActual).toMatchObject(readOnlyDocument);

    const readOnlyMessage = {
      status: 422,
      message: "Trying to modify read-only document",
    };
    const readOnlyPost = await api3Fetch(
      name,
      bob,
      "/api/v3/treatments",
      jsonMutation("POST", { ...readOnlyActual, insulin: 0.41 }),
    );
    expect(readOnlyPost.status).toBe(422);
    expect(await readOnlyPost.json()).toEqual(readOnlyMessage);
    const readOnlyPut = await api3Fetch(
      name,
      bob,
      resource,
      jsonMutation("PUT", { ...readOnlyActual, insulin: 0.42 }),
    );
    expect(readOnlyPut.status).toBe(422);
    expect(await readOnlyPut.json()).toEqual(readOnlyMessage);
    const readOnlyPatch = await api3Fetch(
      name,
      bob,
      resource,
      jsonMutation("PATCH", { insulin: 0.43 }),
    );
    expect(readOnlyPatch.status).toBe(422);
    expect(await readOnlyPatch.json()).toEqual(readOnlyMessage);
    const readOnlyDelete = await api3Fetch(
      name,
      bob,
      `${resource}?permanent=true`,
      { method: "DELETE" },
    );
    expect(readOnlyDelete.status).toBe(422);
    expect(await readOnlyDelete.json()).toEqual(readOnlyMessage);
    expect(await result<JsonObject>(await api3Fetch(name, alice, resource)))
      .toMatchObject(readOnlyDocument);
  });

  it("renders READ, SEARCH, and HISTORY through the locked CSV/XML libraries", async () => {
    const name = tenant("api3-renderers");
    const jwt = await issueSubject(name, "Renderer user", [
      "api:treatments:create",
      "api:treatments:read",
      "api:treatments:delete",
    ]);
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments",
      jsonMutation("POST", treatment(
        "format-treatment",
        "2026-06-02T01:00:00.000Z",
        { notes: "a,b" },
      )),
    )).status).toBe(201);

    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments",
      jsonMutation("POST", treatment(
        "invalid-xml-attribute",
        "2026-06-02T01:01:00.000Z",
        { _bad: { x: 1 } },
      )),
    )).status).toBe(201);

    const readCsv = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/format-treatment.csv?fields=identifier%2Cnotes",
    );
    expect(readCsv.status).toBe(200);
    expect(readCsv.headers.get("Content-Type")).toMatch(/text\/csv/);
    expect(await readCsv.text()).toBe('identifier,notes\nformat-treatment,"a,b"\n');

    const readXml = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/format-treatment?fields=identifier%2Cnotes",
      { headers: { Accept: "application/xml" } },
    );
    expect(readXml.status).toBe(200);
    expect(await readXml.text()).toContain(
      "<item>\n  <identifier>format-treatment</identifier>\n  <notes>a,b</notes>\n</item>",
    );

    const invalidXml = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/invalid-xml-attribute.xml",
    );
    // 15.0.8 treats underscore-prefixed fields as XML elements, not attributes.
    expect(invalidXml.status).toBe(200);
    expect(invalidXml.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(invalidXml.headers.get("Vary")).toBe("Accept");
    expect(await invalidXml.text()).toContain("<_bad>\n    <x>1</x>\n  </_bad>");

    const searchXml = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments.xml?identifier=format-treatment&fields=identifier%2Cnotes",
    );
    expect(searchXml.status).toBe(200);
    expect(await searchXml.text()).toContain(
      "<items>\n  <item>\n    <identifier>format-treatment</identifier>",
    );

    const historyCsv = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/history/946684800001.csv?fields=identifier%2Cnotes",
    );
    expect(historyCsv.status).toBe(200);
    expect(await historyCsv.text()).toBe(
      'identifier,notes\n'
      + 'format-treatment,"a,b"\n'
      + 'invalid-xml-attribute,invalid-xml-attribute\n',
    );

    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/format-treatment?permanent=true",
      { method: "DELETE" },
    )).status).toBe(200);
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/invalid-xml-attribute?permanent=true",
      { method: "DELETE" },
    )).status).toBe(200);
  });

  it("represents every locked api3.renderer contract on the Workers runtime", async () => {
    const name = tenant("api3-renderer-file");
    const jwt = await issueSubject(name, "Renderer file", [
      "api:treatments:create",
      "api:treatments:read",
      "api:treatments:delete",
    ]);
    const now = Date.now();
    const firstDate = now - 5 * 60 * 1_000;
    const secondDate = now - 60 * 1_000;
    const historyFrom = now - 10 * 60 * 1_000;
    const first = treatment(
      "renderer-file-one",
      new Date(firstDate).toISOString(),
      { notes: "first,renderer" },
    );
    const second = treatment(
      "renderer-file-two",
      new Date(secondDate).toISOString(),
      { notes: "second renderer" },
    );
    for (const document of [first, second]) {
      const created = await api3Fetch(
        name,
        jwt,
        "/api/v3/treatments",
        jsonMutation("POST", document),
      );
      expect(created.status).toBe(201);
      expect(await result<JsonObject>(await api3Fetch(
        name,
        jwt,
        `/api/v3/treatments/${String(document.identifier)}`,
      ))).toMatchObject(document);
    }

    for (const [path, headers] of [
      ["/api/v3/treatments/renderer-file-one.ttf?fields=_all", undefined],
      ["/api/v3/treatments/renderer-file-one?fields=_all", { Accept: "font/ttf" }],
      ["/api/v3/treatments.ttf?fields=_all", undefined],
      ["/api/v3/treatments?fields=_all", { Accept: "font/ttf" }],
      [`/api/v3/treatments/history/${historyFrom}.ttf`, undefined],
      [`/api/v3/treatments/history/${historyFrom}`, { Accept: "font/ttf" }],
    ] as const) {
      const unsupported = await api3Fetch(
        name,
        jwt,
        path,
        headers === undefined ? {} : { headers },
      );
      expect(unsupported.status, path).toBe(406);
      expect(await unsupported.json(), path).toEqual({
        status: 406,
        message: "Unsupported output format requested",
      });
    }

    const readXmlByExtension = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/renderer-file-one.xml?fields=_all",
    );
    const readXmlByAccept = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/renderer-file-one?fields=_all",
      { headers: { Accept: "application/xml" } },
    );
    expect(readXmlByExtension.status).toBe(200);
    expect(readXmlByExtension.headers.get("Content-Type"))
      .toBe("application/xml; charset=utf-8");
    const readXml = await readXmlByExtension.text();
    expect(readXml).toBe(await readXmlByAccept.text());
    expect(readXml).toContain("<?xml version='1.0' encoding='utf-8'?>");
    expect(readXml).toContain("<identifier>renderer-file-one</identifier>");

    const readCsvByExtension = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/renderer-file-one.csv?fields=_all",
    );
    const readCsvByAccept = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/renderer-file-one?fields=_all",
      { headers: { Accept: "text/csv" } },
    );
    expect(readCsvByExtension.status).toBe(200);
    expect(readCsvByExtension.headers.get("Content-Type"))
      .toBe("text/csv; charset=utf-8");
    const readCsv = await readCsvByExtension.text();
    expect(readCsv).toBe(await readCsvByAccept.text());
    expect(readCsv).toContain("renderer-file-one");
    expect(readCsv).toContain('"first,renderer"');

    for (const [format, accept, contentType] of [
      ["xml", "application/xml", "application/xml; charset=utf-8"],
      ["csv", "text/csv", "text/csv; charset=utf-8"],
    ] as const) {
      const searchPath = `/api/v3/treatments.${format}?date%24gte=${firstDate}`;
      const searchByExtension = await api3Fetch(name, jwt, searchPath);
      const searchByAccept = await api3Fetch(
        name,
        jwt,
        `/api/v3/treatments?date%24gte=${firstDate}`,
        { headers: { Accept: accept } },
      );
      expect(searchByExtension.status, format).toBe(200);
      expect(searchByExtension.headers.get("Content-Type"), format).toBe(contentType);
      const extensionBody = await searchByExtension.text();
      expect(extensionBody, format).toBe(await searchByAccept.text());
      expect(extensionBody, format).toContain("renderer-file-one");
      expect(extensionBody, format).toContain("renderer-file-two");

      const historyByExtension = await api3Fetch(
        name,
        jwt,
        `/api/v3/treatments/history/${historyFrom}.${format}`,
      );
      const historyByAccept = await api3Fetch(
        name,
        jwt,
        `/api/v3/treatments/history/${historyFrom}`,
        { headers: { Accept: accept } },
      );
      expect(historyByExtension.status, format).toBe(200);
      expect(historyByExtension.headers.get("Content-Type"), format).toBe(contentType);
      const historyBody = await historyByExtension.text();
      expect(historyBody, format).toBe(await historyByAccept.text());
      expect(historyBody, format).toContain("renderer-file-one");
      expect(historyBody, format).toContain("renderer-file-two");
    }

    for (const identifier of ["renderer-file-one", "renderer-file-two"]) {
      const deleted = await api3Fetch(
        name,
        jwt,
        `/api/v3/treatments/${identifier}?permanent=true`,
        { method: "DELETE" },
      );
      expect(deleted.status, identifier).toBe(200);
      expect(await deleted.json(), identifier).toEqual({ status: 200 });
    }
  });

  it("uses the locked single public sort and complete ordered tie-break chain", async () => {
    const name = tenant("api3-sort");
    const jwt = await issueSubject(name, "Sorter", [
      "api:treatments:create",
      "api:treatments:read",
      "api:treatments:update",
    ]);
    const fixtures = [
      ["a-sort", 1, 2, 2],
      ["b-sort", 1, 1, 1],
      ["c-sort", 1, 3, 3],
      ["d-sort", 0, 0, 0],
    ] as const;
    for (const [identifier, rank, commaRank, nestedRank] of fixtures) {
      const response = await api3Fetch(
        name,
        jwt,
        "/api/v3/treatments",
        jsonMutation("POST", treatment(identifier, "2026-06-03T00:00:00.000Z", {
          rank,
          secondary: 9 - rank,
          "rank,secondary": commaRank,
          metrics: { rank: nestedRank },
        })),
      );
      expect(response.status).toBe(201);
    }

    const identifiers = (documents: JsonObject[]): unknown[] =>
      documents.map((document) => document.identifier);
    expect(identifiers(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?sort=rank",
    )))).toEqual(["d-sort", "a-sort", "b-sort", "c-sort"]);
    expect(identifiers(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?sort%24desc=rank",
    )))).toEqual(["c-sort", "b-sort", "a-sort", "d-sort"]);
    expect(identifiers(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?sort=rank&limit=2&skip=1",
    )))).toEqual(["a-sort", "b-sort"]);
    expect(identifiers(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?sort=rank&sort=secondary",
    )))).toEqual(["d-sort", "b-sort", "a-sort", "c-sort"]);
    expect(identifiers(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?sort=rank%2Csecondary",
    )))).toEqual(["d-sort", "b-sort", "a-sort", "c-sort"]);
    expect(identifiers(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?sort=metrics.rank",
    )))).toEqual(["d-sort", "b-sort", "a-sort", "c-sort"]);
    expect(identifiers(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?sort=unknownField",
    )))).toEqual(["a-sort", "b-sort", "c-sort", "d-sort"]);

    const combined = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?sort=rank&sort%24desc=rank",
    );
    expect(combined.status).toBe(400);
    expect(await combined.json()).toEqual({
      status: 400,
      message: "Parameters sort and sort_desc cannot be combined",
    });
  });

  it("preserves legacy materialization, raw srv filters, fallback dedupe, and v1 shape", async () => {
    const name = tenant("api3-legacy");
    const jwt = await issueSubject(name, "Legacy bridge", [
      "api:treatments:create",
      "api:treatments:read",
      "api:treatments:update",
    ]);
    const createdAt = "2026-06-04T00:00:00.000Z";
    const createdAtMillis = Date.parse(createdAt);
    const legacyResponse = await adminWrite(name, "/api/v1/treatments", {
      date: createdAtMillis,
      utcOffset: 0,
      app: "legacy-app",
      device: "legacy-device",
      eventType: "Note",
      created_at: createdAt,
      notes: "legacy row",
    });
    expect(legacyResponse.status).toBe(200);
    const [legacy] = await legacyResponse.json<JsonObject[]>();
    const legacyId = String(legacy?._id);

    const api3Legacy = await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      `/api/v3/treatments/${legacyId}`,
    ));
    expect(api3Legacy).toMatchObject({
      identifier: legacyId,
      srvCreated: createdAtMillis,
      srvModified: createdAtMillis,
    });
    expect(api3Legacy).not.toHaveProperty("_id");
    const params = new URLSearchParams({
      "srvModified$gte": String(createdAtMillis - 1),
    });
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `/api/v3/treatments?${params.toString()}`,
    ))).toEqual([]);
    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/lastModified",
    ))).toMatchObject({ collections: { treatments: createdAtMillis } });

    const deduplicated = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments",
      jsonMutation("POST", {
        identifier: "modern-legacy-bridge",
        date: createdAtMillis,
        utcOffset: 0,
        app: "legacy-app",
        device: "legacy-device",
        eventType: "Note",
        created_at: createdAt,
        notes: "deduplicated through fallback",
      }),
    );
    expect(deduplicated.status).toBe(200);
    expect(await deduplicated.json()).toMatchObject({
      status: 200,
      identifier: "modern-legacy-bridge",
      deduplicatedIdentifier: legacyId,
      isDeduplication: true,
    });

    const legacyList = await SELF.fetch(
      withTenant(`/api/v1/treatments.json?find[_id]=${legacyId}`, name),
    );
    expect(legacyList.status).toBe(200);
    const [legacyShape] = await legacyList.json<JsonObject[]>();
    expect(legacyShape).toMatchObject({
      _id: legacyId,
      identifier: "modern-legacy-bridge",
      notes: "deduplicated through fallback",
    });

    const clientIdCollision = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments",
      jsonMutation("POST", {
        ...treatment("unrelated-client-id", "2026-06-04T01:00:00.000Z"),
        _id: legacyId,
      }),
    );
    expect(clientIdCollision.status).toBe(500);
    expect(await clientIdCollision.json()).toEqual({
      status: 500,
      message: "Database error",
    });
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/unrelated-client-id",
    )).status).toBe(404);
    const unchangedLegacy = await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      `/api/v3/treatments/${legacyId}`,
    ));
    expect(unchangedLegacy).toMatchObject({
      identifier: "modern-legacy-bridge",
      notes: "deduplicated through fallback",
    });
  });

  it("copies the locked history projection header fallback", async () => {
    const name = tenant("api3-history-fields");
    const jwt = await issueSubject(name, "Historian", [
      "api:treatments:create",
      "api:treatments:read",
    ]);
    const createdAt = "2026-06-05T01:02:03.000Z";
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments",
      jsonMutation("POST", treatment("history-fields", createdAt)),
    )).status).toBe(201);

    const fullRead = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/history-fields",
    );
    expect(fullRead.status).toBe(200);
    const fullLastModified = fullRead.headers.get("Last-Modified");
    expect(fullLastModified).not.toBe(new Date(createdAt).toUTCString());
    const projectedRead = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/history-fields?fields=identifier",
    );
    expect(await result<JsonObject>(projectedRead)).toEqual({ identifier: "history-fields" });
    expect(projectedRead.headers.get("Last-Modified")).toBe(new Date(createdAt).toUTCString());
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/history-fields?fields=identifier",
      { headers: { "If-Modified-Since": new Date(createdAt).toUTCString() } },
    )).status).toBe(304);
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/history-fields",
      { headers: { "If-Modified-Since": new Date(createdAt).toUTCString() } },
    )).status).toBe(200);

    const projected = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/history/946684800001?fields=identifier",
    );
    expect(await result<JsonObject[]>(projected)).toEqual([{ identifier: "history-fields" }]);
    expect(projected.headers.get("Last-Modified")).toBe(new Date(createdAt).toUTCString());
    expect(projected.headers.get("ETag")).toBe(`W/"${Date.parse(createdAt)}"`);
  });

  it("enforces controlled SQLite query limits without broadening the public API", async () => {
    const name = tenant("api3-query-differences");
    const jwt = await issueSubject(name, "Query user", [
      "api:treatments:create",
      "api:treatments:read",
    ]);
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments",
      jsonMutation("POST", treatment("regex-source", "2026-06-06T00:00:00.000Z", {
        notes: "Meal Bolus",
        rank: 0,
      })),
    )).status).toBe(201);

    const regexParams = new URLSearchParams({ "notes$re": "^Meal" });
    const regex = await api3Fetch(
      name,
      jwt,
      `/api/v3/treatments?${regexParams.toString()}`,
    );
    expect(regex.status).toBe(200);
    expect(await result<JsonObject[]>(regex)).toEqual([
      expect.objectContaining({ identifier: "regex-source", notes: "Meal Bolus" }),
    ]);

    const unsafeRegexParams = new URLSearchParams({ "notes$re": "(a+)+$" });
    const unsafeRegex = await api3Fetch(
      name,
      jwt,
      `/api/v3/treatments?${unsafeRegexParams.toString()}`,
    );
    expect(unsafeRegex.status).toBe(400);
    expect(await unsafeRegex.json()).toEqual({
      status: 400,
      message: "regex construct ( is not supported safely",
    });

    for (const paging of ["limit=.5", "limit=0x10", "skip=.5"]) {
      const response = await api3Fetch(
        name,
        jwt,
        `/api/v3/treatments?${paging}`,
      );
      expect(response.status, paging).toBe(200);
      expect(await result<JsonObject[]>(response)).toEqual([
        expect.objectContaining({ identifier: "regex-source" }),
      ]);
    }
    for (const skip of [1_000_001, Number.MAX_SAFE_INTEGER]) {
      const response = await api3Fetch(
        name,
        jwt,
        `/api/v3/treatments?skip=${skip}`,
      );
      expect(response.status, String(skip)).toBe(200);
      expect(await result<JsonObject[]>(response)).toEqual([]);
    }
    const unsafeSkip = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?skip=9007199254740992",
    );
    expect(unsafeSkip.status).toBe(400);
    expect(await unsafeSkip.json()).toEqual({
      status: 400,
      message: "Parameter skip out of tolerance",
    });
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?rank%24gt=1&rank%24lt=1",
    ))).toEqual([
      expect.objectContaining({ identifier: "regex-source", rank: 0 }),
    ]);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments?isValid=false",
    ))).toEqual([
      expect.objectContaining({ identifier: "regex-source" }),
    ]);

    const unsafe = await api3Fetch(
      name,
      jwt,
      `/api/v3/treatments?sort=${encodeURIComponent('bad"field')}`,
    );
    expect(unsafe.status).toBe(400);
    expect(await unsafe.json()).toEqual({
      status: 400,
      message: 'Invalid sort field bad"field',
    });

    const excessive = new URLSearchParams();
    for (let index = 0; index < 50; index += 1) excessive.set(`field${index}`, String(index));
    const bounded = await api3Fetch(
      name,
      jwt,
      `/api/v3/treatments?${excessive.toString()}`,
    );
    expect(bounded.status).toBe(400);
    expect(await bounded.json()).toMatchObject({
      status: 400,
      message: expect.stringContaining("bound-parameter limit"),
    });

    const format = await api3Fetch(name, jwt, "/api/v3/treatments.ttf");
    expect(format.status).toBe(406);
    expect(await format.json()).toEqual({
      status: 406,
      message: "Unsupported output format requested",
    });
  });

  it("rolls back document, history, and monotonic clock when an HTTP mutation fails", async () => {
    const name = tenant("api3-http-rollback");
    const jwt = await issueSubject(name, "Atomic writer", [
      "api:treatments:create",
      "api:treatments:read",
      "api:treatments:update",
    ]);
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments",
      jsonMutation("POST", treatment("atomic-http", "2026-06-07T00:00:00.000Z", {
        notes: "before failure",
      })),
    )).status).toBe(201);
    const before = await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/atomic-http",
    ));
    const beforeLastModified = await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/lastModified",
    ));
    const stub = env.ENTRY_STORE.getByName(name);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER fail_api3_http_change
        BEFORE INSERT ON document_changes
        WHEN NEW.collection = 'treatments'
        BEGIN
          SELECT RAISE(ABORT, 'forced API3 HTTP change failure');
        END;
      `);
    });

    const failed = await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/atomic-http",
      jsonMutation("PATCH", { notes: "must roll back" }),
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ status: 500, message: "Database error" });
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec("DROP TRIGGER fail_api3_http_change");
    });

    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/treatments/atomic-http",
    ))).toEqual(before);
    expect((await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/lastModified",
    ))).collections).toEqual(beforeLastModified.collections);
  });
});
