import { env } from "cloudflare:workers";
import {
  SELF,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SqliteDocumentRepository } from "../src/document-repository";
import { ENTRY_STORE_ACTIVATION_SEAL, type EntryStore } from "../src/entry-store";
import { parseEntryPayload, parseHistoryQuery } from "../src/model";

/**
 * Differential contract sources, locked to Nightscout v15.0.7 commit
 * 7e0e77f88fc113a76fe363504125f5b36b8a3fe3:
 * - lib/api3/generic/{create,read,search,update,patch,delete,history}
 * - lib/api3/generic/setup.js (entries date+type legacy fallback)
 * - lib/api3/storage/mongoCollection/{index,find,modify,utils}.js
 * - lib/api3/specific/lastModified.js and lib/api3/security.js
 * - lib/server/entries.js (v1 sysTime+type upsert and UUID handling)
 * - tests/api3.*.test.js, tests/api.entries*.test.js, and storage tests.
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
  const subjectResponse = await adminWrite(
    tenantName,
    "/api/v2/authorization/subjects",
    { name: subjectName, roles: [roleName] },
  );
  expect(subjectResponse.status).toBe(200);
  const created = await subjectResponse.json<JsonObject>();
  // Locked Nightscout returns the stored subject on mutation and derives the
  // access token while reloading/listing authorization state. The integrated
  // adapter therefore never leaks derived credential fields from POST.
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
  const authorization = await SELF.fetch(
    withTenant(
      `/api/v2/authorization/request/${encodeURIComponent(String(subject?.accessToken))}`,
      tenantName,
    ),
  );
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

async function v1Post(tenantName: string, body: unknown): Promise<Response> {
  return SELF.fetch(withTenant("/api/v1/entries", tenantName), {
    method: "POST",
    headers: {
      "api-secret": await secretDigest(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function v1Entries(tenantName: string, count = 100): Promise<JsonObject[]> {
  const response = await SELF.fetch(
    withTenant(`/api/v1/entries.json?count=${count}`, tenantName),
  );
  expect(response.status).toBe(200);
  return response.json<JsonObject[]>();
}

function entry(
  identifier: string,
  date: number,
  extra: JsonObject = {},
): JsonObject {
  return {
    identifier,
    date,
    dateString: new Date(date).toISOString(),
    app: "api3-entries-test",
    device: "simulator://cgm",
    type: "sgv",
    sgv: 120,
    direction: "Flat",
    ...extra,
  };
}

async function result<T = unknown>(response: Response): Promise<T> {
  const body = await response.json<{ status: number; result: T }>();
  expect(body.status).toBe(200);
  return body.result;
}

describe("API v3 Entries vertical slice", () => {
  it("requires JWT Bearer auth and collection-specific permissions", async () => {
    const name = tenant("api3-entry-auth");
    const date = Date.now() - 60_000;
    const document = entry("entry-auth", date);
    const reader = await issueSubject(name, "Reader", ["api:entries:read"]);
    const creator = await issueSubject(name, "Creator", ["api:entries:create"]);
    const updater = await issueSubject(name, "Updater", ["api:entries:update"]);

    const missing = await api3Fetch(name, null, "/api/v3/entries");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      status: 401,
      message: "Missing or bad access token or JWT",
    });
    expect((await SELF.fetch(withTenant("/api/v3/entries", name), {
      headers: { "api-secret": await secretDigest() },
    })).status).toBe(401);

    const deniedCreate = await api3Fetch(
      name,
      reader,
      "/api/v3/entries",
      jsonMutation("POST", document),
    );
    expect(deniedCreate.status).toBe(403);
    expect(await deniedCreate.json()).toEqual({
      status: 403,
      message: "Missing permission api:entries:create",
    });

    expect((await api3Fetch(
      name,
      creator,
      "/api/v3/entries",
      jsonMutation("POST", document),
    )).status).toBe(201);
    const deniedPatch = await api3Fetch(
      name,
      creator,
      "/api/v3/entries/entry-auth",
      jsonMutation("PATCH", { sgv: 121 }),
    );
    expect(deniedPatch.status).toBe(403);
    expect(await deniedPatch.json()).toEqual({
      status: 403,
      message: "Missing permission api:entries:update",
    });

    const deniedUpsert = await api3Fetch(
      name,
      updater,
      "/api/v3/entries/missing-entry",
      jsonMutation("PUT", entry("ignored", date + 300_000)),
    );
    expect(deniedUpsert.status).toBe(403);
    expect(await deniedUpsert.json()).toEqual({
      status: 403,
      message: "Missing permission api:entries:create",
    });
    expect((await api3Fetch(name, reader, "/api/v3/entries/entry-auth")).status).toBe(200);
  });

  it("keeps valid API3 entries without type readable through legacy v1 routes", async () => {
    const name = tenant("api3-entry-optional-type");
    const jwt = await issueSubject(name, "Optional type", [
      "api:entries:create",
      "api:entries:read",
    ]);
    const date = Date.now() - 60_000;
    const created = await api3Fetch(
      name,
      jwt,
      "/api/v3/entries",
      jsonMutation("POST", {
        identifier: "optional-type-sgv",
        date,
        utcOffset: 0,
        app: "api3-entries-test",
        device: "optional-type-cgm",
        direction: "Flat",
        sgv: 123,
      }),
    );
    expect(created.status).toBe(201);

    const legacy = await SELF.fetch(withTenant("/api/v1/entries.json?count=10", name));
    expect(legacy.status).toBe(200);
    const rows = await legacy.json<JsonObject[]>();
    expect(rows).toMatchObject([{
      identifier: "optional-type-sgv",
      date,
      sgv: 123,
    }]);
    expect(rows[0]).not.toHaveProperty("type");
    const current = await SELF.fetch(withTenant("/api/v1/entries/current.json", name));
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject([{
      identifier: "optional-type-sgv",
      sgv: 123,
      type: "sgv",
    }]);
    const properties = await SELF.fetch(withTenant("/api/v2/properties", name));
    expect(properties.status).toBe(200);
    expect(await properties.json()).toMatchObject({
      bgnow: { sgvs: [{ mgdl: 123, device: "optional-type-cgm" }] },
    });
  });

  it("preserves locked v1 numeric-string measurements without BSON cross-type range matches", async () => {
    const name = tenant("api3-entry-numeric-string");
    const date = Date.now() - 60_000;
    const posted = await v1Post(name, entry(
      "numeric-string-sgv",
      date,
      { sgv: "199" },
    ));
    expect(posted.status).toBe(200);
    expect(await posted.json()).toMatchObject([{
      _id: expect.stringMatching(/^[0-9a-f]{24}$/),
      identifier: "numeric-string-sgv",
      sgv: "199",
    }]);
    expect(await v1Entries(name)).toMatchObject([{
      identifier: "numeric-string-sgv",
      sgv: "199",
    }]);

    const jwt = await issueSubject(name, "Numeric string reader", ["api:entries:read"]);
    for (const range of ["sgv%24gt=100", "sgv%24lt=300"]) {
      expect(await result<JsonObject[]>(await api3Fetch(
        name,
        jwt,
        `/api/v3/entries?${range}`,
      ))).toEqual([]);
    }
    const ddata = await SELF.fetch(withTenant("/api/v2/ddata/at", name));
    expect(ddata.status).toBe(200);
    expect(await ddata.json()).toMatchObject({
      sgvs: [{ mgdl: 199, device: "simulator://cgm", type: "sgv" }],
    });
  });

  it("keeps AAPS NSClientV3 incremental history moving after legacy CGM uploads", async () => {
    const name = tenant("api3-entry-aaps-history");
    const jwt = await issueSubject(name, "AAPS history reader", ["api:entries:read"]);
    const firstDate = Date.UTC(2026, 6, 25, 0, 4, 21, 123);
    const secondDate = firstDate + 300_000;

    expect((await v1Post(name, entry("legacy-cgm-first", firstDate, {
      device: "xDrip-NSFollower",
      sgv: 151,
    }))).status).toBe(200);

    const initial = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries?sort=date&date%24gt=${firstDate - 1}&limit=500`,
    ));
    expect(initial).toMatchObject([{
      identifier: "legacy-cgm-first",
      date: firstDate,
      sgv: 151,
      srvCreated: firstDate,
      srvModified: firstDate,
    }]);

    const firstHistoryResponse = await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/history/${firstDate - 1}?limit=500`,
    );
    expect(firstHistoryResponse.headers.get("ETag")).toBe(`W/"${firstDate}"`);
    expect(await result<JsonObject[]>(firstHistoryResponse)).toMatchObject([{
      date: firstDate,
      sgv: 151,
      srvCreated: firstDate,
      srvModified: firstDate,
    }]);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/history/${firstDate}?limit=500`,
    ))).toEqual([]);

    expect((await v1Post(name, entry("legacy-cgm-second", secondDate, {
      device: "xDrip-NSFollower",
      sgv: 156,
    }))).status).toBe(200);

    const lastModified = await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/lastModified",
    ));
    expect(lastModified).toMatchObject({ collections: { entries: secondDate } });

    const catchUpResponse = await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/history/${firstDate}?limit=500`,
    );
    expect(catchUpResponse.headers.get("ETag")).toBe(`W/"${secondDate}"`);
    expect(await result<JsonObject[]>(catchUpResponse)).toMatchObject([{
      date: secondDate,
      sgv: 156,
      srvCreated: secondDate,
      srvModified: secondDate,
    }]);
  });

  it("runs search, create, read, PUT, PATCH, history, lastModified, formats, and deletes", async () => {
    const name = tenant("api3-entry-workflow");
    const permissions = [
      "api:entries:create",
      "api:entries:read",
      "api:entries:update",
      "api:entries:delete",
    ];
    const alice = await issueSubject(name, "Alice", permissions);
    const bob = await issueSubject(name, "Bob", permissions);
    const date = Date.now() - 10 * 60_000;
    const document = entry("workflow-entry", date, {
      noise: 1,
      filtered: 120_000,
      unfiltered: 121_000,
    });

    const created = await api3Fetch(
      name,
      alice,
      "/api/v3/entries",
      jsonMutation("POST", document),
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json<JsonObject>();
    expect(createdBody).toMatchObject({
      status: 201,
      identifier: "workflow-entry",
      lastModified: expect.any(Number),
    });
    const createdModified = Number(createdBody.lastModified);
    expect(created.headers.get("Location")).toBe("/api/v3/entries/workflow-entry");
    expect(created.headers.get("Last-Modified")).not.toBeNull();

    const searched = await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/entries?type%24eq=sgv&fields=identifier%2Csgv%2Cdate",
    ));
    expect(searched).toEqual([{
      identifier: "workflow-entry",
      sgv: 120,
      date,
    }]);

    const readCreated = await api3Fetch(
      name,
      alice,
      "/api/v3/entries/workflow-entry",
    );
    expect(await result<JsonObject>(readCreated)).toMatchObject({
      identifier: "workflow-entry",
      date,
      utcOffset: 0,
      created_at: new Date(date).toISOString(),
      subject: "Alice",
      srvCreated: expect.any(Number),
      srvModified: createdModified,
    });
    const readLastModified = readCreated.headers.get("Last-Modified");
    expect(readLastModified).not.toBeNull();
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/entries/workflow-entry",
      { headers: { "If-Modified-Since": String(readLastModified) } },
    )).status).toBe(304);

    const replaced = await api3Fetch(
      name,
      bob,
      "/api/v3/entries/workflow-entry",
      jsonMutation("PUT", { ...document, sgv: 125 }),
    );
    expect(replaced.status).toBe(200);
    const replacedBody = await replaced.json<JsonObject>();
    expect(replacedBody).toMatchObject({ status: 200, lastModified: expect.any(Number) });
    expect(Number(replacedBody.lastModified)).toBeGreaterThan(createdModified);
    expect((await api3Fetch(
      name,
      alice,
      "/api/v3/entries/workflow-entry",
      jsonMutation("PUT", document, {
        "If-Unmodified-Since": "Sat, 01 Jan 2000 00:00:00 GMT",
      }),
    )).status).toBe(412);

    const patched = await api3Fetch(
      name,
      alice,
      "/api/v3/entries/workflow-entry",
      jsonMutation("PATCH", { sgv: 130, direction: "FortyFiveUp" }),
    );
    expect(patched.status).toBe(200);
    const finalDocument = await result<JsonObject>(await api3Fetch(
      name,
      alice,
      "/api/v3/entries/workflow-entry",
    ));
    expect(finalDocument).toMatchObject({
      sgv: 130,
      direction: "FortyFiveUp",
      subject: "Bob",
      modifiedBy: "Alice",
    });
    const finalModified = Number(finalDocument.srvModified);
    expect(finalModified).toBeGreaterThan(Number(replacedBody.lastModified));

    expect(await result<JsonObject>(await api3Fetch(
      name,
      alice,
      "/api/v3/lastModified",
    ))).toMatchObject({
      srvDate: expect.any(Number),
      collections: { entries: finalModified },
    });
    const history = await api3Fetch(
      name,
      alice,
      `/api/v3/entries/history/${createdModified}`,
    );
    expect(await result<JsonObject[]>(history)).toEqual([
      expect.objectContaining({ identifier: "workflow-entry", sgv: 130 }),
    ]);
    expect(history.headers.get("ETag")).toBe(`W/"${finalModified}"`);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/entries/history?limit=1",
      { headers: { "Last-Modified": "Sat, 01 Jan 2000 00:00:01 GMT" } },
    ))).toHaveLength(1);

    const searchCsv = await api3Fetch(
      name,
      alice,
      "/api/v3/entries.csv?fields=identifier%2Csgv",
    );
    expect(searchCsv.status).toBe(200);
    expect(searchCsv.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(searchCsv.headers.get("Vary")).toBe("Accept");
    expect(await searchCsv.text()).toBe("identifier,sgv\nworkflow-entry,130\n");

    const readXml = await api3Fetch(
      name,
      alice,
      "/api/v3/entries/workflow-entry?fields=identifier%2Csgv",
      { headers: { Accept: "application/xml" } },
    );
    expect(readXml.status).toBe(200);
    expect(readXml.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(await readXml.text()).toContain(
      "<item>\n  <identifier>workflow-entry</identifier>\n  <sgv>130</sgv>\n</item>",
    );

    expect((await api3Fetch(
      name,
      bob,
      "/api/v3/entries/workflow-entry",
      { method: "DELETE" },
    )).status).toBe(200);
    expect((await api3Fetch(name, alice, "/api/v3/entries/workflow-entry")).status).toBe(410);
    expect(await result<JsonObject[]>(await api3Fetch(name, alice, "/api/v3/entries"))).toEqual([]);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      `/api/v3/entries/history/${finalModified - 1}`,
    ))).toEqual([
      expect.objectContaining({
        identifier: "workflow-entry",
        isValid: false,
        modifiedBy: "Bob",
      }),
    ]);

    expect((await api3Fetch(
      name,
      bob,
      "/api/v3/entries/workflow-entry?permanent=true",
      { method: "DELETE" },
    )).status).toBe(200);
    expect((await api3Fetch(name, alice, "/api/v3/entries/workflow-entry")).status).toBe(404);
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      alice,
      "/api/v3/entries/history/946684800001",
    ))).toEqual([]);
  });

  it("keeps identifier non-unique and applies deterministic search order, limit, and skip", async () => {
    const name = tenant("api3-entry-index");
    const jwt = await issueSubject(name, "Index reader", [
      "api:entries:create",
      "api:entries:read",
    ]);
    const firstDate = Date.now() - 20 * 60_000;
    const secondDate = firstDate + 300_000;
    const sharedIdentifier = "shared-v1-entry";
    expect((await v1Post(name, [
      entry(sharedIdentifier, firstDate, { sgv: 101 }),
      entry(sharedIdentifier, secondDate, { sgv: 102 }),
    ])).status).toBe(200);

    const ascending = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries?identifier%24eq=${sharedIdentifier}&sort=date`,
    ));
    expect(ascending.map((document) => document.date)).toEqual([firstDate, secondDate]);
    const descending = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries?identifier%24eq=${sharedIdentifier}&sort%24desc=date&limit=1&skip=1`,
    ));
    expect(descending.map((document) => document.date)).toEqual([firstDate]);

    const sameDate = secondDate + 300_000;
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/entries",
      jsonMutation("POST", entry("same-time-a", sameDate, { sgv: 103 })),
    )).status).toBe(201);
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/entries",
      jsonMutation("POST", entry("same-time-b", sameDate, { sgv: 104 })),
    )).status).toBe(201);
    const sameTimeDocuments = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries?date%24eq=${sameDate}&fields=identifier`,
    ));
    expect(sameTimeDocuments.map((document) => document.identifier).sort())
      .toEqual(["same-time-a", "same-time-b"]);

    const stub = env.ENTRY_STORE.getByName(name);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM entries WHERE identifier = ?",
        sharedIdentifier,
      ).one().count).toBe(2);
      const uniqueIdentifierIndexes = state.storage.sql.exec<{
        name: string;
        unique: number;
      }>("PRAGMA index_list(entries)").toArray().filter((index) => {
        if (index.unique === 0) return false;
        const columns = state.storage.sql.exec<{ name: string }>(
          `PRAGMA index_info("${index.name}")`,
        ).toArray();
        return columns.length === 1 && columns[0]?.name === "identifier";
      });
      expect(uniqueIdentifierIndexes).toEqual([]);
    });
  });

  it("represents every locked api3.search contract on the Workers runtime", async () => {
    const name = tenant("api3-search-contract");
    const started = Date.now() - 1;
    const jwt = await issueSubject(name, "Search contract", [
      "api:entries:create",
      "api:entries:read",
    ]);

    const missing = await api3Fetch(name, null, "/api/v3/entries");
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      status: 401,
      message: "Missing or bad access token or JWT",
    });
    const unknown = await api3Fetch(name, jwt, "/api/v3/NOT_EXIST");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      status: 404,
      message: "Bad operation or collection",
    });

    const base = Date.now() - 60 * 60_000;
    for (let index = 0; index < 12; index += 1) {
      const created = await api3Fetch(
        name,
        jwt,
        "/api/v3/entries",
        jsonMutation("POST", entry(
          `search-contract-${String(index).padStart(2, "0")}`,
          base + index * 300_000,
          { sgv: 100 + index },
        )),
      );
      expect(created.status, String(index)).toBe(201);
    }

    const all = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/entries",
    ));
    expect(all).toHaveLength(12);
    const fromStartPath = `/api/v3/entries?srvModified%24gte=${started}`;
    const fromStart = await result<JsonObject[]>(await api3Fetch(name, jwt, fromStartPath));
    expect(fromStart).toHaveLength(12);

    for (const [parameter, message] of [
      ["limit=INVALID", "Parameter limit out of tolerance"],
      ["limit=-1", "Parameter limit out of tolerance"],
      ["limit=0", "Parameter limit out of tolerance"],
      ["limit=1001", "Parameter limit out of tolerance"],
      ["skip=INVALID", "Parameter skip out of tolerance"],
      ["skip=-5", "Parameter skip out of tolerance"],
    ] as const) {
      const response = await api3Fetch(name, jwt, `/api/v3/entries?${parameter}`);
      expect(response.status, parameter).toBe(400);
      expect(await response.json(), parameter).toEqual({ status: 400, message });
    }
    const combinedSort = await api3Fetch(
      name,
      jwt,
      "/api/v3/entries?sort=date&sort%24desc=created_at",
    );
    expect(combinedSort.status).toBe(400);
    expect(await combinedSort.json()).toEqual({
      status: 400,
      message: "Parameters sort and sort_desc cannot be combined",
    });

    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/entries?limit=3",
    ))).toHaveLength(3);

    const ascending = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `${fromStartPath}&sort=date`,
    ));
    const descending = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `${fromStartPath}&sort%24desc=date`,
    ));
    expect(descending).toEqual([...ascending].reverse());
    for (let index = 1; index < ascending.length; index += 1) {
      expect(Number(ascending[index - 1]?.date)).toBeLessThanOrEqual(
        Number(ascending[index]?.date),
      );
    }

    const firstEight = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/entries?sort=date&limit=8",
    ));
    const skipped = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/entries?sort=date&skip=3&limit=5",
    ));
    expect(skipped).toEqual(firstEight.slice(3));

    const projected = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/entries?fields=date%2Capp%2Csubject",
    ));
    for (const document of projected) {
      expect(Object.keys(document).sort()).toEqual(["app", "date", "subject"]);
    }
    const complete = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      "/api/v3/entries?fields=_all",
    ));
    for (const document of complete) {
      expect(Object.keys(document).length).toBeGreaterThanOrEqual(10);
      expect(document).not.toHaveProperty("_id");
      expect(document).toMatchObject({
        identifier: expect.any(String),
        srvCreated: expect.any(Number),
        srvModified: expect.any(Number),
      });
    }
  });

  it("pushes a bounded case-sensitive Nightscout regex subset into SQLite without ReDoS", async () => {
    const name = tenant("api3-entry-safe-regex");
    const jwt = await issueSubject(name, "Regex reader", ["api:entries:read"]);
    const base = Date.now() - 10 * 60_000;
    expect((await v1Post(name, [
      entry("regex-one", base, {
        device: "simulator://cgm-1",
        labels: ["simulator://cgm-1"],
        scores: [50, 250],
        metadata: { device: "simulator://cgm-1" },
      }),
      entry("regex-two", base + 60_000, { device: "simulator://cgm-2" }),
      entry("regex-case", base + 120_000, { device: "Simulator://CGM-3" }),
    ])).status).toBe(200);

    const common = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries?device%24re=${encodeURIComponent("simulator://cgm-.*")}`,
    ));
    expect(common.map((document) => document.identifier).sort()).toEqual([
      "regex-one",
      "regex-two",
    ]);

    const anchoredDigit = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries?device%24re=${encodeURIComponent("^simulator://cgm-\\d$")}`,
    ));
    expect(anchoredDigit).toHaveLength(2);
    const quotedAnchoredDigit = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries?device%24re=${encodeURIComponent("'^simulator://cgm-\\d$'")}`,
    ));
    expect(quotedAnchoredDigit).toEqual(anchoredDigit);

    const numericDoesNotCast = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries?sgv%24re=${encodeURIComponent("12.*")}`,
    ));
    expect(numericDoesNotCast).toEqual([]);
    const objectIdDoesNotCast = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries?_id%24re=${encodeURIComponent(".*")}`,
    ));
    expect(objectIdDoesNotCast).toEqual([]);

    const arrayRegex = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries?labels%24re=${encodeURIComponent("simulator.*")}`,
    ));
    expect(arrayRegex).toMatchObject([{ identifier: "regex-one" }]);
    for (const filter of [
      `labels=${encodeURIComponent("simulator://cgm-1")}`,
      `labels%24in=${encodeURIComponent("other|simulator://cgm-1")}`,
      "scores%24gt=200",
    ]) {
      expect(await result<JsonObject[]>(await api3Fetch(
        name,
        jwt,
        `/api/v3/entries?${filter}`,
      ))).toMatchObject([{ identifier: "regex-one" }]);
    }
    const objectRegex = await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries?metadata%24re=${encodeURIComponent("simulator.*")}`,
    ));
    expect(objectRegex).toEqual([]);

    for (const unsafe of [
      "(a+)+$",
      "a".repeat(129),
      "\\bword",
      "(a)\\1",
      "\\p{L}",
      "\\w".repeat(8),
    ]) {
      const response = await api3Fetch(
        name,
        jwt,
        `/api/v3/entries?device%24re=${encodeURIComponent(unsafe)}`,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        status: 400,
        message: expect.stringMatching(/not supported safely|exceeds 128 bytes|50-byte limit/),
      });
    }
  });

  it("matches v1 sysTime+type upserts independently of UUID, device, and measurement type", async () => {
    const name = tenant("api3-entry-v1-dedup");
    const date = Date.now() - 15 * 60_000;
    const firstUuid = "550e8400-e29b-41d4-a716-446655440011";
    const secondUuid = "550e8400-e29b-41d4-a716-446655440012";
    const firstPost = await v1Post(name, {
      _id: firstUuid,
      ...entry("discarded-first", date, {
        identifier: undefined,
        sgv: 111,
        device: "Trio",
        filtered: 22_222,
      }),
    });
    expect(firstPost.status).toBe(200);
    expect(await firstPost.json()).toMatchObject([{
      _id: expect.stringMatching(/^[0-9a-f]{24}$/),
      identifier: firstUuid,
      filtered: 22_222,
    }]);
    const replayPost = await v1Post(name, {
      _id: secondUuid,
      ...entry("discarded-second", date, {
        identifier: undefined,
        sgv: 123,
        direction: "FortyFiveUp",
        device: "xDrip",
      }),
    });
    expect(replayPost.status).toBe(200);
    const replaySaved = await replayPost.json<JsonObject[]>();
    expect(replaySaved).toMatchObject([{
      identifier: secondUuid,
      sgv: 123,
      device: "xDrip",
    }]);
    expect(replaySaved[0]).not.toHaveProperty("_id");
    expect(replaySaved[0]).not.toHaveProperty("filtered");
    expect((await v1Post(name, {
      type: "mbg",
      mbg: 118,
      date,
      dateString: new Date(date).toISOString(),
      device: "Meter",
    })).status).toBe(200);
    expect((await v1Post(name, entry(
      "third-time",
      date + 300_000,
      { sgv: 130 },
    ))).status).toBe(200);

    const rows = await v1Entries(name);
    expect(rows).toHaveLength(3);
    expect(rows.filter((document) => document.type === "sgv" && document.date === date)).toEqual([
      expect.objectContaining({
        identifier: secondUuid,
        sgv: 123,
        direction: "FortyFiveUp",
        device: "xDrip",
      }),
    ]);
    expect(rows.filter((document) => document.date === date).map((document) => document.type).sort())
      .toEqual(["mbg", "sgv"]);
    const stub = env.ENTRY_STORE.getByName(name);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const plan = state.storage.sql.exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT * FROM documents
         WHERE collection = 'entries'
           AND json_extract(body, '$.sysTime') = ?
           AND json_extract(body, '$.type') = ?
         ORDER BY updated_at ASC, id ASC
         LIMIT 1`,
        new Date(date).toISOString(),
        "sgv",
      ).toArray().map((row) => row.detail).join("\n");
      expect(plan).toContain("documents_entries_sys_time_type");
      const datePlan = state.storage.sql.exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT id FROM documents
         WHERE collection = 'entries'
           AND sort_time >= ?
           AND sort_time <= ?
         ORDER BY sort_time DESC, id ASC
         LIMIT 10`,
        date - 60_000,
        date + 600_000,
      ).toArray().map((row) => row.detail).join("\n");
      expect(datePlan).toContain("documents_collection_sort");
      expect(datePlan).toMatch(/sort_time>[?]/);
      const typePlan = state.storage.sql.exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT id FROM documents
         WHERE collection = 'entries'
           AND json_extract(body, '$.type') = ?
         ORDER BY sort_time DESC, id ASC
         LIMIT 10`,
        "mbg",
      ).toArray().map((row) => row.detail).join("\n");
      expect(typePlan).toContain("documents_entries_type_sort");
      const api3DatePlan = state.storage.sql.exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT id FROM documents
         WHERE collection = 'entries'
           AND is_valid != 0
           AND sort_time >= ?
         ORDER BY sort_time DESC, srv_modified DESC, id ASC
         LIMIT 10`,
        date - 60_000,
      ).toArray().map((row) => row.detail).join("\n");
      expect(api3DatePlan).toMatch(/documents_collection_(?:valid_)?sort/);
      expect(api3DatePlan).toMatch(/sort_time>[?]/);
      let productionQuery: { statement: string; bindings: SqlStorageValue[] } | null = null;
      const rawSql = state.storage.sql;
      const interceptedSql = new Proxy(rawSql, {
        get(target, property) {
          if (property === "exec") {
            return (statement: string, ...bindings: SqlStorageValue[]) => {
              if (statement.startsWith("SELECT * FROM documents")) {
                productionQuery = { statement, bindings };
              }
              return target.exec(statement, ...bindings);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const interceptedStorage = new Proxy(state.storage, {
        get(target, property) {
          if (property === "sql") return interceptedSql;
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const repository = new SqliteDocumentRepository(interceptedStorage);
      repository.queryLegacyEntries(parseHistoryQuery(new URL(
        `https://example.test/api/v1/entries.json?count=10&find[dateString][$gte]=${encodeURIComponent(new Date(date - 60_000).toISOString())}`,
      )));
      const capturedQuery = productionQuery as {
        statement: string;
        bindings: SqlStorageValue[];
      } | null;
      if (capturedQuery === null) throw new Error("production Entries SELECT was not captured");
      const dateStringPlan = rawSql.exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${capturedQuery.statement}`,
        ...capturedQuery.bindings,
      ).toArray().map((row) => row.detail).join("\n");
      expect(dateStringPlan).toContain("documents_entries_date_string_sort");
      expect(dateStringPlan).not.toContain("SCAN documents");
    });
  });

  it("matches locked v1 parseZone offsets and leaves date-only dateString absent", async () => {
    const name = tenant("api3-entry-v1-zones");
    const plusEight = "2025-07-18T08:00:00.000+08:00";
    const minusFive = "2025-07-18T20:00:00.000-05:00";
    const plusDate = Date.parse(plusEight);
    const minusDate = Date.parse(minusFive);
    const dateOnly = Date.parse("2025-07-19T02:00:00.000Z");
    expect((await v1Post(name, [
      entry("zone-plus-eight", plusDate, { dateString: plusEight, sgv: 111 }),
      entry("zone-minus-five", minusDate, { dateString: minusFive, sgv: 112 }),
      {
        identifier: "date-only",
        date: dateOnly,
        app: "api3-entries-test",
        device: "simulator://date-only",
        type: "sgv",
        sgv: 113,
        direction: "Flat",
      },
    ])).status).toBe(200);

    const byIdentifier = new Map(
      (await (await SELF.fetch(withTenant(
        `/api/v1/entries.json?count=100&find[date][$gte]=${plusDate - 60_000}`
          + `&find[date][$lte]=${dateOnly + 60_000}`,
        name,
      ))).json<JsonObject[]>()).map((document) => [document.identifier, document]),
    );
    expect(byIdentifier.get("zone-plus-eight")).toMatchObject({
      dateString: "2025-07-18T00:00:00.000Z",
      sysTime: "2025-07-18T00:00:00.000Z",
      utcOffset: 480,
    });
    expect(byIdentifier.get("zone-minus-five")).toMatchObject({
      dateString: "2025-07-19T01:00:00.000Z",
      sysTime: "2025-07-19T01:00:00.000Z",
      utcOffset: -300,
    });
    const withoutDateString = byIdentifier.get("date-only");
    expect(withoutDateString).toMatchObject({
      sysTime: "2025-07-19T02:00:00.000Z",
      utcOffset: 0,
    });
    expect(Object.prototype.hasOwnProperty.call(withoutDateString, "dateString")).toBe(false);
  });

  it("applies the locked four-day default window without conflating dateString with date", async () => {
    const name = tenant("api3-entry-v1-default-window");
    const now = Date.now();
    const staleDate = now - 5 * 24 * 60 * 60_000;
    const staleResponse = await v1Post(name, entry("stale-default-window", staleDate));
    expect(staleResponse.status).toBe(200);
    const [savedStale] = await staleResponse.json<JsonObject[]>();
    const staleId = String(savedStale?._id);

    expect(await v1Entries(name)).toEqual([]);
    for (const route of ["/api/v1/entries/current.json", "/api/v2/entries/current.json"]) {
      const response = await SELF.fetch(withTenant(route, name));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    }
    const byId = await SELF.fetch(withTenant(`/api/v1/entries/${staleId}.json`, name));
    expect(byId.status).toBe(200);
    expect(await byId.json()).toMatchObject([{ identifier: "stale-default-window" }]);

    const storedDate = now - 2 * 24 * 60 * 60_000;
    const storedDateString = new Date(now - 24 * 60 * 60_000).toISOString();
    expect((await v1Post(name, entry("independent-date-string", storedDate, {
      dateString: storedDateString,
    }))).status).toBe(200);
    const boundary = encodeURIComponent(new Date(now - 36 * 60 * 60_000).toISOString());
    const byDateString = await SELF.fetch(withTenant(
      `/api/v1/entries.json?count=10&find[dateString][$gte]=${boundary}`,
      name,
    ));
    expect(byDateString.status).toBe(200);
    expect(await byDateString.json()).toMatchObject([{
      identifier: "independent-date-string",
      date: storedDate,
      dateString: storedDateString,
    }]);
  });

  it("returns saved v1/v2 records, honors model/type filters, and bypasses the ten-row ID window", async () => {
    const name = tenant("api3-entry-v1-routing");
    const empty = await v1Post(name, []);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);
    const base = Date.now() - 20 * 60_000;
    const payload = Array.from({ length: 12 }, (_, index) => entry(
      `routing-sgv-${index}`,
      base + index * 60_000,
      { sgv: 100 + index, filtered: 20_000 + index, unfiltered: 21_000 + index },
    ));
    payload.push({
      identifier: "routing-mbg",
      date: base + 13 * 60_000,
      dateString: new Date(base + 13 * 60_000).toISOString(),
      app: "api3-entries-test",
      device: "routing-meter",
      type: "mbg",
      mbg: 117,
    });
    const posted = await v1Post(name, payload);
    expect(posted.status).toBe(200);
    const saved = await posted.json<JsonObject[]>();
    expect(saved).toHaveLength(13);
    expect(saved[0]).toMatchObject({
      _id: expect.stringMatching(/^[0-9a-f]{24}$/),
      identifier: "routing-sgv-0",
      type: "sgv",
      filtered: 20_000,
      unfiltered: 21_000,
      sysTime: new Date(base).toISOString(),
      utcOffset: 0,
    });

    const v1Sgvs = await (
      await SELF.fetch(withTenant("/api/v1/entries/sgv.json?count=20", name))
    ).json<JsonObject[]>();
    expect(v1Sgvs).toHaveLength(12);
    expect(new Set(v1Sgvs.map((document) => document.type))).toEqual(new Set(["sgv"]));
    const v2Sgvs = await (
      await SELF.fetch(withTenant("/api/v2/entries/sgv.json?count=20", name))
    ).json<JsonObject[]>();
    expect(v2Sgvs).toEqual(v1Sgvs);
    const legacyExtensionPath = await (
      await SELF.fetch(withTenant("/api/v1/entries/sgv/.json?count=20", name))
    ).json<JsonObject[]>();
    expect(legacyExtensionPath).toEqual(v1Sgvs);

    const mbgs = await (
      await SELF.fetch(withTenant("/api/v1/entries.json?find[type]=mbg&count=20", name))
    ).json<JsonObject[]>();
    expect(mbgs).toMatchObject([{ identifier: "routing-mbg", type: "mbg", mbg: 117 }]);

    const oldestId = String(saved[0]?._id);
    const ordinaryWindow = await v1Entries(name, 10);
    expect(ordinaryWindow.some((document) => document._id === oldestId)).toBe(false);
    for (const version of ["v1", "v2"] as const) {
      const byId = await SELF.fetch(withTenant(`/api/${version}/entries/${oldestId}.json`, name));
      expect(byId.status).toBe(200);
      expect(await byId.json()).toMatchObject([{
        _id: oldestId,
        identifier: "routing-sgv-0",
        sgv: 100,
      }]);
      const missingId = "ffffffffffffffffffffffff";
      const missing = await SELF.fetch(withTenant(
        `/api/${version}/entries/${missingId}`,
        name,
      ));
      expect(missing.status).toBe(500);
      expect(await missing.json()).toEqual({
        status: 500,
        message: "Mongo Error",
        description: `No such id: '${missingId}'`,
      });
    }

    const mbgDate = base + 13 * 60_000;
    const modelDelete = await SELF.fetch(withTenant(
      `/api/v2/entries/mbg.json?find[date][$gte]=${mbgDate}&find[date][$lte]=${mbgDate}`,
      name,
    ), {
      method: "DELETE",
      headers: { "api-secret": await secretDigest() },
    });
    expect(modelDelete.status).toBe(200);
    expect(await modelDelete.json()).toEqual({ acknowledged: true, deletedCount: 1 });
    expect(await (
      await SELF.fetch(withTenant("/api/v1/entries/mbg.json?count=20", name))
    ).json()).toEqual([]);

    const filteredDeleteDate = base + 14 * 60_000;
    expect((await v1Post(name, [
      entry("routing-filtered-sgv", filteredDeleteDate, { sgv: 145 }),
      {
        identifier: "routing-filtered-mbg",
        date: filteredDeleteDate,
        dateString: new Date(filteredDeleteDate).toISOString(),
        app: "api3-entries-test",
        device: "routing-meter",
        type: "mbg",
        mbg: 119,
      },
    ])).status).toBe(200);
    const queryTypeDelete = await SELF.fetch(withTenant(
      `/api/v1/entries.json?find[type][$eq]=mbg&find[date][$gte]=${filteredDeleteDate}&find[date][$lte]=${filteredDeleteDate}`,
      name,
    ), {
      method: "DELETE",
      headers: { "api-secret": await secretDigest() },
    });
    expect(queryTypeDelete.status).toBe(200);
    expect(await queryTypeDelete.json()).toEqual({ acknowledged: true, deletedCount: 1 });
    const afterQueryTypeDelete = await (
      await SELF.fetch(withTenant("/api/v1/entries.json?count=20", name))
    ).json<JsonObject[]>();
    expect(afterQueryTypeDelete).toEqual(expect.arrayContaining([
      expect.objectContaining({ identifier: "routing-filtered-sgv", type: "sgv", sgv: 145 }),
    ]));
    expect(afterQueryTypeDelete.some(
      (document) => document.identifier === "routing-filtered-mbg",
    )).toBe(false);

    const unsupportedDelete = await SELF.fetch(withTenant(
      `/api/v1/entries.json?find[device]=simulator&find[date][$gte]=${base}&find[date][$lte]=${filteredDeleteDate}`,
      name,
    ), {
      method: "DELETE",
      headers: { "api-secret": await secretDigest() },
    });
    expect(unsupportedDelete.status).toBe(400);
    expect(await unsupportedDelete.json()).toMatchObject({
      error: { code: "unsupported_delete_filter" },
    });
    expect(await v1Entries(name, 20)).toHaveLength(13);

    // Locked entries DELETE treats path model `*` specially: prepReqModel
    // first overwrites query type with `*`, then removes that type predicate.
    for (const [index, typeFilter] of [
      "find[type]=mbg",
      "find[type][$eq]=mbg",
    ].entries()) {
      const wildcardDate = filteredDeleteDate + (index + 1) * 60_000;
      expect((await v1Post(name, [
        entry(`wildcard-sgv-${index}`, wildcardDate, { sgv: 150 + index }),
        {
          identifier: `wildcard-mbg-${index}`,
          date: wildcardDate,
          dateString: new Date(wildcardDate).toISOString(),
          device: "routing-meter",
          type: "mbg",
          mbg: 120 + index,
        },
      ])).status).toBe(200);
      const wildcardDelete = await SELF.fetch(withTenant(
        `/api/v1/entries/*.json?${typeFilter}&find[date][$gte]=${wildcardDate}&find[date][$lte]=${wildcardDate}`,
        name,
      ), {
        method: "DELETE",
        headers: { "api-secret": await secretDigest() },
      });
      expect(wildcardDelete.status).toBe(200);
      expect(await wildcardDelete.json()).toEqual({
        acknowledged: true,
        deletedCount: 2,
      });
    }
    expect(await v1Entries(name, 20)).toHaveLength(13);
  });

  it("fails closed when an unindexed API3 Entries query exceeds its scan budget", async () => {
    const name = tenant("api3-entry-scan-budget");
    const needleDate = Date.now() - 60_000;
    expect((await v1Post(name, entry("scan-budget-needle", needleDate, {
      device: "needle-cgm",
    }))).status).toBe(200);
    const jwt = await issueSubject(name, "Scan budget reader", ["api:entries:read"]);
    const stub = env.ENTRY_STORE.getByName(name);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const base = needleDate - 24 * 60 * 60_000;
      state.storage.sql.exec(
        `WITH RECURSIVE candidates(value) AS (
           VALUES (1)
           UNION ALL SELECT value + 1 FROM candidates WHERE value <= 10000
         )
         INSERT INTO documents
           (collection, id, body, sort_time, created_at, updated_at)
         SELECT 'entries', printf('%024x', value + 900000),
                json_object(
                  'date', ? - value,
                  'dateString', ?,
                  'type', 'sgv',
                  'sgv', 120,
                  'device', 'nonmatching-cgm'
                ),
                ? - value, ?, ?
         FROM candidates`,
        base,
        new Date(base).toISOString(),
        base,
        base,
        base,
      );
    });

    const broad = await api3Fetch(name, jwt, "/api/v3/entries?device=needle-cgm&limit=1");
    expect(broad.status).toBe(413);
    expect(await broad.json()).toMatchObject({
      status: 413,
      message: expect.stringContaining("add a narrower date filter"),
    });

    const broadDateString = await SELF.fetch(withTenant(
      "/api/v1/entries.json?count=1&find[dateString][$gte]=0000",
      name,
    ));
    expect(broadDateString.status).toBe(413);
    expect(await broadDateString.json()).toMatchObject({
      error: {
        code: "entry_query_limit",
        message: expect.stringContaining("add a narrower date filter"),
      },
    });

    const sparseDateString = await SELF.fetch(withTenant(
      `/api/v1/entries.json?count=1&find[dateString]=${encodeURIComponent(new Date(needleDate).toISOString())}`,
      name,
    ));
    expect(sparseDateString.status).toBe(200);
    expect(await sparseDateString.json()).toMatchObject([{
      identifier: "scan-budget-needle",
      device: "needle-cgm",
    }]);

    const narrow = await api3Fetch(
      name,
      jwt,
      `/api/v3/entries?device=needle-cgm&date%24gte=${needleDate - 1_000}&limit=1`,
    );
    expect(narrow.status).toBe(200);
    expect(await result<JsonObject[]>(narrow)).toMatchObject([{
      identifier: "scan-budget-needle",
      device: "needle-cgm",
    }]);
  });

  it("rejects an oversized synchronous v1 range delete atomically", async () => {
    const name = tenant("api3-entry-delete-limit");
    const base = Date.now() - 180 * 60_000;
    const entries = Array.from({ length: 129 }, (_, index) => entry(
      `delete-limit-${index}`,
      base + index * 60_000,
      { sgv: 90 + (index % 100) },
    ));
    expect((await v1Post(name, entries.slice(0, 100))).status).toBe(200);
    expect((await v1Post(name, entries.slice(100))).status).toBe(200);

    const response = await SELF.fetch(withTenant(
      `/api/v1/entries/sgv.json?find[date][$gte]=${base}&find[date][$lte]=${base + 128 * 60_000}`,
      name,
    ), {
      method: "DELETE",
      headers: { "api-secret": await secretDigest() },
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: "entry_delete_limit",
        message: "entry deletion exceeds 128 records or stored revisions; narrow the request",
      },
    });
    const intact = await v1Entries(name, 200);
    expect(intact).toHaveLength(129);
    const oneId = String(intact[0]?._id);
    const removeOne = await SELF.fetch(withTenant(`/api/v1/entries/${oneId}`, name), {
      method: "DELETE",
      headers: { "api-secret": await secretDigest() },
    });
    expect(removeOne.status).toBe(200);
    expect(await removeOne.json()).toEqual({ acknowledged: true, deletedCount: 1 });
    const accepted = await SELF.fetch(withTenant(
      `/api/v1/entries/sgv.json?find[date][$gte]=${base}&find[date][$lte]=${base + 128 * 60_000}`,
      name,
    ), {
      method: "DELETE",
      headers: { "api-secret": await secretDigest() },
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ acknowledged: true, deletedCount: 128 });
    expect(await v1Entries(name, 200)).toEqual([]);
  });

  it("rejects permanent deletion with unbounded revision history atomically", async () => {
    const name = tenant("api3-entry-delete-history-limit");
    const stub = env.ENTRY_STORE.getByName(name);
    const jwt = await issueSubject(name, "History delete limiter", [
      "api:entries:read",
      "api:entries:delete",
    ]);
    const id = "abababababababababababab";
    expect((await v1Post(name, {
      _id: id,
      ...entry("delete-history-limit", Date.now() - 60_000),
    })).status).toBe(200);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE copies(value) AS (
           VALUES (1) UNION ALL SELECT value + 1 FROM copies WHERE value < 128
         )
         INSERT INTO document_changes
           (collection, id, identifier, identifier_present, body, srv_created,
            srv_modified, is_valid, revision, operation, srv_metadata_version)
         SELECT document.collection, document.id, document.identifier,
                document.identifier_present, document.body, document.srv_created,
                document.srv_modified, document.is_valid, document.revision,
                'history-limit', document.srv_metadata_version
         FROM documents AS document CROSS JOIN copies
         WHERE document.collection = 'entries' AND document.id = ?`,
        id,
      );
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM document_changes WHERE collection = 'entries' AND id = ?",
        id,
      ).one().count).toBe(129);
    });

    const api3Delete = await api3Fetch(
      name,
      jwt,
      "/api/v3/entries/delete-history-limit?permanent=true",
      { method: "DELETE" },
    );
    expect(api3Delete.status).toBe(413);
    expect(await api3Delete.json()).toMatchObject({ status: 413 });
    const v1Delete = await SELF.fetch(withTenant(`/api/v1/entries/${id}`, name), {
      method: "DELETE",
      headers: { "api-secret": await secretDigest() },
    });
    expect(v1Delete.status).toBe(413);
    expect(await v1Delete.json()).toMatchObject({
      error: { code: "entry_delete_limit" },
    });
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM documents WHERE collection = 'entries' AND id = ?",
        id,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM document_changes WHERE collection = 'entries' AND id = ?",
        id,
      ).one().count).toBe(129);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM entries WHERE id = ?",
        id,
      ).one().count).toBe(1);
    });
  });

  it("invalidates a v1 shadow after API3 type changes and soft deletion", async () => {
    const name = tenant("api3-entry-shadow-invalidation");
    const jwt = await issueSubject(name, "Shadow updater", [
      "api:entries:read",
      "api:entries:update",
      "api:entries:delete",
    ]);
    const originalId = "999999999999999999999991";
    const replacementId = "999999999999999999999992";
    const date = Date.now() - 25 * 60_000;
    expect((await v1Post(name, {
      _id: originalId,
      ...entry("removed", date, { identifier: undefined, sgv: 119 }),
    })).status).toBe(200);
    expect((await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${originalId}`,
      jsonMutation("PATCH", { type: "mbg", mbg: 118 }),
    )).status).toBe(200);

    const stub = env.ENTRY_STORE.getByName(name);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM entries WHERE id = ?",
        originalId,
      ).one().count).toBe(0);
    });
    expect((await v1Post(name, {
      _id: replacementId,
      ...entry("removed", date, { identifier: undefined, sgv: 121 }),
    })).status).toBe(200);
    const rows = await v1Entries(name);
    expect(rows).toHaveLength(2);
    expect(rows.map((document) => [document._id, document.type]).sort()).toEqual([
      [originalId, "mbg"],
      [replacementId, "sgv"],
    ]);

    expect((await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${replacementId}`,
      { method: "DELETE" },
    )).status).toBe(200);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM entries WHERE id = ?",
        replacementId,
      ).one().count).toBe(0);
    });
  });

  it("normalizes uppercase ObjectId fallbacks like Mongo for API3 read, patch, put, and delete", async () => {
    const name = tenant("api3-entry-objectid-case");
    const jwt = await issueSubject(name, "ObjectId case", [
      "api:entries:create",
      "api:entries:read",
      "api:entries:update",
      "api:entries:delete",
    ]);
    const base = Date.now() - 30 * 60_000;
    const ids = [
      "abcdefabcdefabcdefabcde1",
      "abcdefabcdefabcdefabcde2",
      "abcdefabcdefabcdefabcde3",
      "abcdefabcdefabcdefabcde4",
    ];
    expect((await v1Post(name, ids.map((id, index) => ({
      _id: id,
      ...entry(`case-${index}`, base + index * 60_000, { identifier: undefined }),
    })))).status).toBe(200);

    for (const filter of [
      `_id%24eq=${ids[0]}`,
      `_id%24in=${ids[0]}`,
    ]) {
      expect(await result<JsonObject[]>(await api3Fetch(
        name,
        jwt,
        `/api/v3/entries?${filter}`,
      ))).toEqual([]);
    }
    expect(await result<JsonObject[]>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries?_id%24ne=${ids[0]}`,
    ))).toHaveLength(4);

    const read = await api3Fetch(name, jwt, `/api/v3/entries/${ids[0]!.toUpperCase()}`);
    expect(read.status).toBe(200);
    expect(await result<JsonObject>(read)).toMatchObject({ identifier: ids[0], sgv: 120 });

    const patched = await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${ids[1]!.toUpperCase()}`,
      jsonMutation("PATCH", { sgv: 133 }),
    );
    expect(patched.status).toBe(200);
    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${ids[1]!.toUpperCase()}`,
    ))).toMatchObject({ sgv: 133 });

    const upperPutId = ids[2]!.toUpperCase();
    const uppercasePut = await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${upperPutId}`,
      jsonMutation("PUT", entry("ignored-by-path", base + 2 * 60_000, { sgv: 144 })),
    );
    // ObjectId parsing itself is case-insensitive, but locked update.validate
    // compares the normalized legacy identifier to the path string exactly.
    expect(uppercasePut.status).toBe(400);
    expect(await uppercasePut.json()).toMatchObject({
      status: 400,
      message: "Field identifier cannot be modified by the client",
    });
    const lowercasePut = await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${ids[2]}`,
      jsonMutation("PUT", entry("ignored-by-path", base + 2 * 60_000, { sgv: 144 })),
    );
    expect(lowercasePut.status).toBe(200);
    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${upperPutId}`,
    ))).toMatchObject({ identifier: ids[2], sgv: 144 });

    const removed = await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${ids[3]!.toUpperCase()}?permanent=true`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect((await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${ids[3]!.toUpperCase()}`,
    )).status).toBe(404);
  });

  it("bridges v1 entries into API3 and API3 mutations back into v1 reads", async () => {
    const name = tenant("api3-entry-interop");
    const permissions = [
      "api:entries:create",
      "api:entries:read",
      "api:entries:update",
      "api:entries:delete",
    ];
    const jwt = await issueSubject(name, "Interop", permissions);
    const legacyId = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const legacyDate = Date.now() - 30 * 60_000;
    expect((await v1Post(name, {
      _id: legacyId,
      date: legacyDate,
      dateString: new Date(legacyDate).toISOString(),
      app: "api3-entries-test",
      device: "simulator://legacy",
      type: "sgv",
      sgv: 115,
      direction: "Flat",
    })).status).toBe(200);

    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${legacyId}`,
    ))).toMatchObject({
      identifier: legacyId,
      sgv: 115,
      srvCreated: legacyDate,
      srvModified: legacyDate,
    });
    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/lastModified",
    ))).toMatchObject({ collections: { entries: legacyDate } });

    expect((await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${legacyId}`,
      jsonMutation("PATCH", { sgv: 116 }),
    )).status).toBe(200);
    expect(await v1Entries(name)).toEqual([
      expect.objectContaining({ _id: legacyId, sgv: 116 }),
    ]);

    const modernDate = legacyDate + 300_000;
    const modern = entry("modern-entry", modernDate, {
      sysTime: new Date(modernDate).toISOString(),
      sgv: 125,
    });
    expect((await api3Fetch(
      name,
      jwt,
      "/api/v3/entries",
      jsonMutation("POST", modern),
    )).status).toBe(201);
    expect((await v1Entries(name)).map((document) => document.identifier)).toContain("modern-entry");

    expect((await v1Post(name, {
      date: modernDate,
      dateString: new Date(modernDate).toISOString(),
      device: "simulator://retry",
      type: "sgv",
      sgv: 126,
      direction: "SingleUp",
    })).status).toBe(200);
    expect(await result<JsonObject>(await api3Fetch(
      name,
      jwt,
      "/api/v3/entries/modern-entry",
    ))).toMatchObject({ sgv: 126, direction: "SingleUp" });

    const fallback = await api3Fetch(
      name,
      jwt,
      "/api/v3/entries",
      jsonMutation("POST", {
        ...entry("legacy-now-modern", legacyDate, {
          device: "simulator://legacy",
          sgv: 117,
        }),
      }),
    );
    expect(fallback.status).toBe(200);
    expect(await fallback.json()).toMatchObject({
      identifier: "legacy-now-modern",
      deduplicatedIdentifier: legacyId,
      isDeduplication: true,
    });
  });

  it("distinguishes missing and null identifiers for ObjectId mutation fallback", async () => {
    const name = tenant("api3-entry-null-id");
    const jwt = await issueSubject(name, "Identity", [
      "api:entries:create",
      "api:entries:read",
      "api:entries:update",
      "api:entries:delete",
    ]);
    const base = Date.now() - 45 * 60_000;
    const missingId = "bbbbbbbbbbbbbbbbbbbbbbbb";
    const nullId = "cccccccccccccccccccccccc";
    const putNullId = "dddddddddddddddddddddddd";
    expect((await v1Post(name, {
      _id: missingId,
      ...entry("removed", base, { identifier: undefined }),
    })).status).toBe(200);
    expect((await v1Post(name, {
      _id: nullId,
      ...entry("removed", base + 300_000, { identifier: null }),
    })).status).toBe(200);
    expect((await v1Post(name, {
      _id: putNullId,
      ...entry("removed", base + 600_000, { identifier: null }),
    })).status).toBe(200);

    expect((await api3Fetch(name, jwt, `/api/v3/entries/${missingId}`)).status).toBe(200);
    expect((await api3Fetch(name, jwt, `/api/v3/entries/${nullId}`)).status).toBe(200);
    expect((await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${missingId}`,
      jsonMutation("PATCH", { sgv: 121 }),
    )).status).toBe(200);
    expect((await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${nullId}`,
      jsonMutation("PATCH", { sgv: 122 }),
    )).status).toBe(404);

    expect((await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${nullId}?permanent=true`,
      { method: "DELETE" },
    )).status).toBe(200);
    expect((await api3Fetch(name, jwt, `/api/v3/entries/${nullId}`)).status).toBe(404);

    const putByObjectId = await api3Fetch(
      name,
      jwt,
      `/api/v3/entries/${putNullId}`,
      jsonMutation("PUT", entry("ignored", base + 900_000)),
    );
    expect(putByObjectId.status).toBe(201);
    expect(await putByObjectId.json()).toMatchObject({
      status: 201,
      identifier: putNullId,
    });
    const stub = env.ENTRY_STORE.getByName(name);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM documents
         WHERE collection = 'entries' AND (id = ? OR identifier = ?)`,
        putNullId,
        putNullId,
      ).one().count).toBe(2);
    });
  });

  it("keeps the ordered v1 batch prefix when a later entry conflicts", async () => {
    const name = tenant("api3-entry-rollback");
    const id = "eeeeeeeeeeeeeeeeeeeeeeee";
    const base = Date.now() - 60 * 60_000;
    const validated = parseEntryPayload([
      { _id: id, ...entry("removed", base, { identifier: undefined }) },
      { _id: id, ...entry("removed", base + 300_000, { identifier: undefined }) },
    ]);
    const stub = env.ENTRY_STORE.getByName(name);
    let failure = "";
    await runInDurableObject(stub, async (instance: EntryStore) => {
      try {
        await instance.putEntries(validated);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    });
    expect(failure).toContain("E11000 duplicate key error");
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM documents WHERE collection = 'entries'",
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM document_changes WHERE collection = 'entries'",
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM entries",
      ).one().count).toBe(1);
    });
  });

  it("keeps v1 sysTime plus type authoritative when identifiers differ", async () => {
    const name = tenant("api3-entry-v1-identifier-independent");
    const date = Date.now() - 60_000;
    const sysTime = new Date(date).toISOString();
    expect((await v1Post(name, {
      ...entry("v1-first-identifier", date),
      sysTime,
      sgv: 141,
    })).status).toBe(200);
    expect((await v1Post(name, {
      ...entry("v1-second-identifier", date),
      sysTime,
      sgv: 199,
    })).status).toBe(200);
    const rows = await v1Entries(name);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      identifier: "v1-second-identifier",
      sysTime,
      type: "sgv",
      sgv: 199,
    });
  });

  it("resets only an incompatible pre-1.0 Entries shadow and preserves profile data", async () => {
    const name = tenant("api3-entry-fresh-schema-reset");
    const stub = env.ENTRY_STORE.getByName(name);
    const profileId = "abababababababababababab";
    await stub.createDocuments("profile", JSON.stringify([{
      _id: profileId,
      defaultProfile: "Default",
      store: { Default: { timezone: "UTC" } },
    }]));
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec("DROP TABLE entries");
      state.storage.sql.exec(`
        CREATE TABLE entries (
          id TEXT PRIMARY KEY,
          identifier TEXT UNIQUE,
          dedupe_key TEXT NOT NULL UNIQUE,
          sgv INTEGER NOT NULL,
          date INTEGER NOT NULL,
          date_string TEXT NOT NULL,
          direction TEXT NOT NULL,
          device TEXT NOT NULL,
          type TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      state.storage.sql.exec(
        `INSERT INTO entries
          (id, identifier, dedupe_key, sgv, date, date_string,
           direction, device, type, created_at)
         VALUES ('cdcdcdcdcdcdcdcdcdcdcdcd', 'simulated-old-row',
                 'old-key', 140, 1700000000000, '2023-11-14T22:13:20.000Z',
                 'Flat', 'simulator', 'sgv', 1700000000000)`,
      );
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (99)",
      );
      state.storage.sql.exec(
        "DELETE FROM _sql_schema_migrations WHERE id = ?",
        ENTRY_STORE_ACTIVATION_SEAL,
      );
    });

    await evictDurableObject(stub);
    expect(await stub.getEntries({
      count: 10,
      filters: [],
      sort: [{ field: "date", direction: "desc" }],
      type: null,
    })).toEqual([]);
    expect(JSON.parse(await stub.listDocuments("profile", 10))).toMatchObject([{
      _id: profileId,
      defaultProfile: "Default",
    }]);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const columns = state.storage.sql.exec<{ name: string }>(
        "PRAGMA table_info(entries)",
      ).toArray().map((column) => column.name);
      expect(columns).toContain("mbg");
      const uniqueIdentifierIndexes = state.storage.sql.exec<{
        name: string;
        unique: number;
      }>("PRAGMA index_list(entries)").toArray().filter((index) => {
        if (index.unique === 0) return false;
        const indexed = state.storage.sql.exec<{ name: string }>(
          `PRAGMA index_info("${index.name}")`,
        ).toArray();
        return indexed.length === 1 && indexed[0]?.name === "identifier";
      });
      expect(uniqueIdentifierIndexes).toEqual([]);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE name IN (
           'entries_v6_legacy',
           'entry_shadow_migration_queue',
           'entry_shadow_migration_state',
           'entries_migration_capture_insert',
           'entries_migration_capture_update',
           'entries_migration_capture_delete'
         )`,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM documents WHERE collection = 'profile' AND id = ?",
        profileId,
      ).one().count).toBe(1);
    });
  });

  it("repairs deceptive shadow constraints and same-name indexes once, then restarts read-only", async () => {
    const name = tenant("api3-entry-schema-contract");
    const stub = env.ENTRY_STORE.getByName(name);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec("DROP TABLE entries");
      state.storage.sql.exec(`
        CREATE TABLE entries (
          id TEXT PRIMARY KEY,
          identifier TEXT,
          dedupe_key TEXT NOT NULL COLLATE NOCASE,
          sgv INTEGER CHECK (sgv IS NULL OR sgv < 100),
          mbg INTEGER,
          date INTEGER NOT NULL,
          date_string TEXT NOT NULL,
          direction TEXT NOT NULL,
          device TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type = 'sgv'),
          created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX deceptive_dedupe_key
          ON entries(dedupe_key) WHERE 0;
        CREATE INDEX entries_date_desc ON entries(date DESC);
        DROP INDEX documents_entries_sys_time_type;
        CREATE UNIQUE INDEX documents_entries_sys_time_type
          ON documents(
            json_extract(body, '$.sysTime'),
            json_extract(body, '$.type'),
            updated_at ASC,
            id ASC
          )
          WHERE collection = 'entries';
        DROP INDEX documents_entries_type_sort;
        CREATE UNIQUE INDEX documents_entries_type_sort
          ON documents(json_extract(body, '$.type'), sort_time ASC)
          WHERE collection = 'entries';
        DROP INDEX documents_entries_date_string_sort;
        CREATE UNIQUE INDEX documents_entries_date_string_sort
          ON documents(json_extract(body, '$.dateString'))
          WHERE collection = 'entries';
        DELETE FROM _sql_schema_migrations WHERE id = ${ENTRY_STORE_ACTIVATION_SEAL};
      `);
    });

    await evictDurableObject(stub);
    expect((await v1Post(name, {
      identifier: "schema-repaired-mbg",
      type: "mbg",
      mbg: 121,
      date: Date.now() - 60_000,
      device: "schema-meter",
    })).status).toBe(200);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const tableSql = state.storage.sql.exec<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entries'",
      ).one().sql;
      expect(tableSql).not.toContain("COLLATE NOCASE");
      expect(tableSql).not.toContain("type = 'sgv'");
      const canonicalSql = state.storage.sql.exec<{ sql: string }>(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index' AND name = 'documents_entries_sys_time_type'`,
      ).one().sql;
      expect(canonicalSql).toMatch(/^CREATE INDEX /i);
      expect(canonicalSql).not.toMatch(/^CREATE UNIQUE INDEX /i);
      const typeSortSql = state.storage.sql.exec<{ sql: string }>(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index' AND name = 'documents_entries_type_sort'`,
      ).one().sql;
      expect(typeSortSql).toMatch(/^CREATE INDEX /i);
      expect(typeSortSql).not.toMatch(/^CREATE UNIQUE INDEX /i);
      expect(typeSortSql).toContain("sort_time DESC");
      const dateStringSql = state.storage.sql.exec<{ sql: string }>(
        `SELECT sql FROM sqlite_master
         WHERE type = 'index' AND name = 'documents_entries_date_string_sort'`,
      ).one().sql;
      expect(dateStringSql).toMatch(/^CREATE INDEX /i);
      expect(dateStringSql).not.toMatch(/^CREATE UNIQUE INDEX /i);
      expect(dateStringSql).toContain("json_type(body, '$.dateString') = 'text'");
      const dedupeIndexes = state.storage.sql.exec<{
        name: string;
        unique: number;
        partial: number;
      }>("PRAGMA index_list(entries)").toArray().filter((index) => {
        if (index.unique === 0) return false;
        return state.storage.sql.exec<{ name: string }>(
          `PRAGMA index_info("${index.name}")`,
        ).toArray().some((column) => column.name === "dedupe_key");
      });
      expect(dedupeIndexes).toHaveLength(1);
      expect(dedupeIndexes[0]?.partial).toBe(0);

      state.storage.sql.exec("DROP INDEX entries_date_desc");
      state.storage.sql.exec("CREATE INDEX entries_date_desc ON entries(type)");
      state.storage.sql.exec(
        "DELETE FROM _sql_schema_migrations WHERE id = ?",
        ENTRY_STORE_ACTIVATION_SEAL,
      );
    });

    await evictDurableObject(stub);
    expect((await stub.getCurrent()).length).toBe(1);
    const schemaSnapshot = await runInDurableObject(
      stub,
      async (_instance: EntryStore, state) => JSON.stringify(state.storage.sql.exec<{
        type: string;
        name: string;
        sql: string | null;
      }>(
        `SELECT type, name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      ).toArray()),
    );
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const columns = state.storage.sql.exec<{ name: string }>(
        "PRAGMA index_info(entries_date_desc)",
      ).toArray().map((column) => column.name);
      expect(columns).toEqual(["date"]);
    });

    await evictDurableObject(stub);
    expect((await stub.getCurrent()).length).toBe(1);
    const restartedSchemaSnapshot = await runInDurableObject(
      stub,
      async (_instance: EntryStore, state) => JSON.stringify(state.storage.sql.exec<{
        type: string;
        name: string;
        sql: string | null;
      }>(
        `SELECT type, name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      ).toArray()),
    );
    expect(restartedSchemaSnapshot).toBe(schemaSnapshot);
  });

  it("removes every unknown Entries trigger and index before accepting writes", async () => {
    const name = tenant("api3-entry-schema-unknown-objects");
    const stub = env.ENTRY_STORE.getByName(name);
    expect(await stub.getCurrent()).toEqual([]);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER arbitrary_blocking_trigger
        BEFORE INSERT ON entries
        BEGIN
          SELECT RAISE(ABORT, 'unexpected trigger fired');
        END;
        CREATE INDEX unexpected_expr
          ON entries(json_extract(device, '$.x'));
        CREATE UNIQUE INDEX unexpected_nocase_dedupe
          ON entries(dedupe_key COLLATE NOCASE);
        DELETE FROM _sql_schema_migrations WHERE id = ${ENTRY_STORE_ACTIVATION_SEAL};
      `);
    });

    await evictDurableObject(stub);
    const saved = await v1Post(name, {
      identifier: "schema-clean-write",
      type: "sgv",
      sgv: 118,
      date: Date.now() - 60_000,
      device: "unknown",
    });
    expect(saved.status).toBe(200);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE (type = 'trigger' AND tbl_name = 'entries')
            OR name IN ('unexpected_expr', 'unexpected_nocase_dedupe')`,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entries'",
      ).toArray().map((row) => row.name).sort()).toEqual([
        "entries_date_desc",
        "sqlite_autoindex_entries_1",
        "sqlite_autoindex_entries_2",
      ]);
    });
  });

});
