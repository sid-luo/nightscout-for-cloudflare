import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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

function endpoint(path: string, tenantName: string): string {
  return `https://example.test${path}${path.includes("?") ? "&" : "?"}tenant=${tenantName}`;
}

async function write(
  tenantName: string,
  path: string,
  payload: unknown,
  method: "POST" | "PUT" = "POST",
): Promise<Response> {
  return SELF.fetch(endpoint(path, tenantName), {
    method,
    headers: {
      "api-secret": await secretDigest(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function listed(tenantName: string): Promise<JsonObject[]> {
  const response = await SELF.fetch(endpoint("/api/v1/treatments.json?count=100", tenantName));
  expect(response.status).toBe(200);
  return response.json<JsonObject[]>();
}

describe("locked v1/v2 Treatments preBolus contract", () => {
  it("atomically splits preBolus carbs into the shifted treatment and deduplicates both", async () => {
    const name = tenant("treatments-prebolus");
    const createdAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const input = {
      eventType: "Meal Bolus",
      created_at: createdAt,
      carbs: "30",
      insulin: "2.00",
      preBolus: "15",
      glucose: 100,
      glucoseType: "Finger",
      units: "mg/dl",
      notes: "meal split",
    };

    const createdResponse = await write(name, "/api/v1/treatments/", input);
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json<JsonObject[]>();
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      eventType: "Meal Bolus",
      created_at: createdAt,
      insulin: 2,
      preBolus: 15,
      glucose: 100,
      notes: "meal split",
    });
    expect(created[0]).not.toHaveProperty("carbs");

    const shiftedAt = new Date(Date.parse(createdAt) + 15 * 60_000).toISOString();
    expect(created[1]).toMatchObject({
      eventType: "Meal Bolus",
      created_at: shiftedAt,
      carbs: 30,
      notes: "meal split",
    });
    for (const field of ["insulin", "preBolus", "glucose", "glucoseType", "units", "utcOffset"]) {
      expect(created[1]).not.toHaveProperty(field);
    }
    expect(created[0]?._id).toMatch(/^[0-9a-f]{24}$/);
    expect(created[1]?._id).toMatch(/^[0-9a-f]{24}$/);

    const replayResponse = await write(name, "/api/v2/treatments/", input);
    expect(replayResponse.status).toBe(200);
    const replay = await replayResponse.json<JsonObject[]>();
    expect(replay.map((document) => document._id)).toEqual(
      created.map((document) => document._id),
    );
    expect(await listed(name)).toHaveLength(2);

    const ddata = await (
      await SELF.fetch(endpoint("/api/v2/ddata/at", name))
    ).json<{ treatments: JsonObject[] }>();
    expect(ddata.treatments).toEqual(expect.arrayContaining([
      expect.objectContaining({ _id: created[0]?._id, preBolus: 15 }),
      expect.objectContaining({ _id: created[1]?._id, carbs: 30 }),
    ]));
  });

  it("keeps ordered batch dedupe while returning every upstream create result", async () => {
    const name = tenant("treatments-prebolus-batch");
    const createdAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const repeated = {
      eventType: "BG Check",
      created_at: createdAt,
      glucose: 110,
      glucoseType: "Finger",
      units: "mg/dl",
    };
    const response = await write(name, "/api/v1/treatments/", [
      repeated,
      repeated,
      repeated,
      {
        eventType: "Meal Bolus",
        created_at: createdAt,
        carbs: "25",
        insulin: "1.5",
        preBolus: "10",
      },
    ]);
    expect(response.status).toBe(200);
    expect(await response.json<JsonObject[]>()).toHaveLength(5);
    expect(await listed(name)).toHaveLength(3);
  });

  it("creates the locked empty-carb child when preBolus is present without carbs", async () => {
    const name = tenant("treatments-prebolus-empty-carbs");
    const createdAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const input = {
      eventType: "Meal Bolus",
      created_at: createdAt,
      insulin: 1,
      preBolus: "5",
    };

    const createdResponse = await write(name, "/api/v1/treatments/", input);
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json<JsonObject[]>();
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      eventType: "Meal Bolus",
      created_at: createdAt,
      insulin: 1,
      preBolus: 5,
    });
    expect(created[0]).not.toHaveProperty("carbs");
    expect(created[1]).toMatchObject({
      eventType: "Meal Bolus",
      created_at: new Date(Date.parse(createdAt) + 5 * 60_000).toISOString(),
      carbs: "",
    });

    const replayResponse = await write(name, "/api/v2/treatments/", input);
    expect(replayResponse.status).toBe(200);
    const replay = await replayResponse.json<JsonObject[]>();
    expect(replay.map((document) => document._id)).toEqual(
      created.map((document) => document._id),
    );
    expect(await listed(name)).toHaveLength(2);
  });

  it("rolls back the primary record when the shifted timestamp cannot be represented", async () => {
    const name = tenant("treatments-prebolus-atomic");
    const response = await write(name, "/api/v1/treatments/", {
      eventType: "Meal Bolus",
      created_at: new Date().toISOString(),
      carbs: 20,
      insulin: 1,
      preBolus: "1e308",
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "mongo_error", message: "Mongo Error" },
    });
    expect(await listed(name)).toEqual([]);
  });
});

describe("complete locked v1 Treatments upload and identity contract", () => {
  it("sanitizes the locked XSS fixture and normalizes zoned time and numbers", async () => {
    const name = tenant("treatments-sanitize-zone");
    const response = await write(name, "/api/v1/treatments/", {
      eventType: "Meal Bolus",
      created_at: "2026-07-20T12:30:00.000+02:30",
      carbs: "30",
      insulin: "2.00",
      glucose: 100,
      glucoseType: "Finger",
      units: "mg/dl",
      notes: '<IMG SRC="javascript:alert(\'XSS\');">',
    });
    expect(response.status).toBe(200);
    const created = await response.json<JsonObject[]>();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      eventType: "Meal Bolus",
      created_at: "2026-07-20T10:00:00.000Z",
      utcOffset: 150,
      carbs: 30,
      insulin: 2,
      glucose: 100,
      notes: "<img />",
    });
    expect(created[0]).not.toHaveProperty("eventTime");
  });

  it("posts, queries and bulk-deletes the locked treatment selection", async () => {
    const name = tenant("treatments-query-delete");
    const createdAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const response = await write(name, "/api/v1/treatments/", {
      eventType: "Carb Correction",
      created_at: createdAt,
      carbs: "99",
      insulin: "2.00",
      glucose: 100,
      glucoseType: "Finger",
      units: "mg/dl",
    });
    expect(response.status).toBe(200);

    const selected = await SELF.fetch(endpoint(
      "/api/v1/treatments/?find[carbs]=99",
      name,
    ));
    expect(selected.status).toBe(200);
    expect(await selected.json<JsonObject[]>()).toHaveLength(1);

    const deleted = await SELF.fetch(endpoint(
      "/api/v1/treatments/?find[carbs]=99",
      name,
    ), {
      method: "DELETE",
      headers: { "api-secret": await secretDigest() },
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ acknowledged: true, deletedCount: 1 });
    expect(await (await SELF.fetch(endpoint(
      "/api/v1/treatments/?find[carbs]=99",
      name,
    ))).json()).toEqual([]);
  });

  it("moves UUID _id to identifier across POST, PUT and server-ID DELETE", async () => {
    const name = tenant("treatments-uuid");
    const uuid = "69F15FD2-8075-4DEB-AEA3-4352F455840D";
    const firstAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const first = await write(name, "/api/v1/treatments/", {
      _id: uuid,
      eventType: "Temporary Override",
      created_at: firstAt,
      durationType: "indefinite",
      correctionRange: [90, 110],
      insulinNeedsScaleFactor: 1.2,
      reason: "test override",
    });
    expect(first.status).toBe(200);
    const created = (await first.json<JsonObject[]>())[0]!;
    expect(created).toMatchObject({ identifier: uuid, durationType: "indefinite" });
    expect(created._id).toMatch(/^[0-9a-f]{24}$/);
    const serverId = String(created._id);

    const repostAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const repost = await write(name, "/api/v1/treatments/", {
      _id: uuid,
      eventType: "Temporary Override",
      created_at: repostAt,
      duration: 60,
      correctionRange: [90, 110],
      insulinNeedsScaleFactor: 1.2,
      reason: "reposted override",
    });
    expect((await repost.json<JsonObject[]>())[0]).toMatchObject({
      _id: serverId,
      identifier: uuid,
      created_at: repostAt,
      duration: 60,
    });

    const updateAt = new Date(Date.now() - 15 * 60_000).toISOString();
    const updated = await write(name, "/api/v1/treatments/", {
      _id: uuid,
      eventType: "Temporary Override",
      created_at: updateAt,
      duration: 30,
      correctionRange: [90, 110],
      insulinNeedsScaleFactor: 1.2,
      reason: "updated override",
    }, "PUT");
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      _id: serverId,
      identifier: uuid,
      created_at: updateAt,
      duration: 30,
      reason: "updated override",
    });
    expect(await listed(name)).toHaveLength(1);

    const deleted = await SELF.fetch(endpoint(`/api/v1/treatments/${serverId}`, name), {
      method: "DELETE",
      headers: { "api-secret": await secretDigest() },
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ acknowledged: true, deletedCount: 1 });
    expect(await listed(name)).toEqual([]);
  });

  it("deduplicates explicit AAPS identifiers and preserves ordered identifier batches", async () => {
    const name = tenant("treatments-identifiers");
    const createdAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const identifier = `AAPS-${crypto.randomUUID()}`;
    const first = await write(name, "/api/v1/treatments/", {
      identifier,
      eventType: "Carb Correction",
      carbs: 30,
      created_at: createdAt,
    });
    const firstDocument = (await first.json<JsonObject[]>())[0]!;
    expect(firstDocument).toMatchObject({ identifier, carbs: 30 });
    expect(firstDocument._id).toMatch(/^[0-9a-f]{24}$/);

    const replay = await write(name, "/api/v1/treatments/", {
      identifier,
      eventType: "Carb Correction",
      carbs: 45,
      created_at: createdAt,
    });
    expect((await replay.json<JsonObject[]>())[0]).toMatchObject({
      _id: firstDocument._id,
      identifier,
      carbs: 45,
    });
    expect((await listed(name)).filter((document) => document.identifier === identifier)).toHaveLength(1);

    const identifiers = [0, 1, 2].map((index) => `BATCH-${index}-${crypto.randomUUID()}`);
    const batch = await write(name, "/api/v1/treatments/", identifiers.map((value, index) => ({
      identifier: value,
      eventType: "Bolus",
      insulin: 1 + index * 0.5,
      created_at: new Date(Date.now() - (3 - index) * 60 * 60_000).toISOString(),
    })));
    expect(batch.status).toBe(200);
    const batchDocuments = await batch.json<JsonObject[]>();
    expect(batchDocuments.map((document) => document.identifier)).toEqual(identifiers);
    expect(batchDocuments.every((document) => /^[0-9a-f]{24}$/.test(String(document._id))))
      .toBe(true);
  });
});
