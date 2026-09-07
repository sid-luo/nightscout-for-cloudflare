import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { nightscoutStatus } from "../src/status";

const TEST_API_SECRET = "nscf-test-secret-20260717";

type JsonObject = Record<string, unknown>;

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function withTenant(path: string, tenantName: string): string {
  return `https://example.test${path}${path.includes("?") ? "&" : "?"}tenant=${tenantName}`;
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

async function post(
  tenantName: string,
  collection: "entries" | "treatments",
  payload: unknown,
): Promise<Response> {
  return SELF.fetch(withTenant(`/api/v1/${collection}/`, tenantName), {
    method: "POST",
    headers: {
      "api-secret": await secretDigest(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
}

function expectObjectIds(documents: JsonObject[]): void {
  expect(documents.every((document) => /^[0-9a-f]{24}$/.test(String(document._id)))).toBe(true);
}

describe("locked root and v1/v2 Status upstream contracts", () => {
  it("adapts the complete public GET /api/versions contract", async () => {
    const response = await SELF.fetch("https://example.test/api/versions");
    expect(response.status).toBe(200);
    const versions = await response.json<JsonObject[]>();
    expect(versions.length).toBeGreaterThanOrEqual(3);
    expect(versions).toEqual([
      { version: "1.0.0", url: "/api/v1" },
      { version: "2.0.0", url: "/api/v2" },
      { version: "3.0.5", url: "/api/v3" },
    ]);
    for (const version of versions) {
      expect(Object.keys(version).sort()).toEqual(["url", "version"]);
      expect(String(version.version)).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
      expect(String(version.url)).toMatch(/^\/api/);
    }
  });

  it("adapts the locked custom-enable status body and all six representations", async () => {
    const modeled = nightscoutStatus(
      new Date("2026-07-20T00:00:00.000Z"),
      "readable",
      { enable: ["careportal", "rawbg"] },
    );
    expect(modeled).toMatchObject({
      apiEnabled: true,
      careportalEnabled: true,
      settings: { enable: ["careportal", "rawbg"] },
    });

    for (const version of ["v1", "v2"] as const) {
      const json = await SELF.fetch(`https://example.test/api/${version}/status.json`);
      expect(json.status).toBe(200);
      expect(await json.json()).toMatchObject({ apiEnabled: true, careportalEnabled: true });

      const html = await SELF.fetch(`https://example.test/api/${version}/status.html`);
      expect(html.status).toBe(200);
      expect(html.headers.get("Content-Type")).toMatch(/^text\/html/);

      const text = await SELF.fetch(`https://example.test/api/${version}/status.txt`);
      expect(text.status).toBe(200);
      expect(text.headers.get("Content-Type")).toMatch(/^text\/plain/);
      expect(await text.text()).toBe("STATUS OK");

      const script = await SELF.fetch(`https://example.test/api/${version}/status.js`);
      expect(script.status).toBe(200);
      expect(script.headers.get("Content-Type")).toMatch(/^application\/javascript/);
      expect(await script.text()).toMatch(/^this\.serverSettings =/);

      for (const extension of ["svg", "png"] as const) {
        const redirect = await SELF.fetch(
          `https://example.test/api/${version}/status.${extension}`,
          { redirect: "manual" },
        );
        expect(redirect.status).toBe(302);
        expect(redirect.headers.get("Location")).toBe(
          `http://img.shields.io/badge/Nightscout-OK-green.${extension}`,
        );
      }
    }
  });
});

describe("locked v1 Alexa REST contract", () => {
  it("returns the official launch, unknown-intent and session-ended responses", async () => {
    const name = tenant("v1-alexa");
    const alexa = (request: JsonObject) => SELF.fetch(withTenant("/api/v1/alexa", name), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request }),
    });

    const launch = await alexa({ type: "LaunchRequest", locale: "en-US" });
    expect(launch.status).toBe(200);
    expect(await launch.json()).toEqual({
      version: "1.0",
      response: {
        outputSpeech: {
          type: "PlainText",
          text: "What would you like to check on Nightscout?",
        },
        card: {
          type: "Simple",
          title: "Welcome to Nightscout",
          content: "What would you like to check on Nightscout?",
        },
        reprompt: {
          outputSpeech: {
            type: "PlainText",
            text: "What would you like to check on Nightscout?",
          },
        },
        shouldEndSession: false,
      },
    });

    const unknown = await alexa({
      type: "LaunchRequest",
      locale: "en-US",
      intent: { name: "UNKNOWN" },
    });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({
      response: {
        outputSpeech: {
          text: "I'm sorry, I don't know what you're asking for.",
        },
        shouldEndSession: true,
      },
    });

    const ended = await alexa({ type: "SessionEndedRequest", locale: "en-US" });
    expect(ended.status).toBe(200);
    expect(await ended.json()).toBe("");
  });
});

describe("locked v1 Loop and Trio batch-operation contract", () => {
  it("stores Loop carb and dose arrays as ordered treatment documents", async () => {
    const now = Date.now();
    const carbs = [
      {
        eventType: "Carb Correction",
        carbs: 15,
        created_at: new Date(now).toISOString(),
        enteredBy: "loop://iPhone",
        absorptionTime: 180,
      },
      {
        eventType: "Carb Correction",
        carbs: 30,
        created_at: new Date(now + 3_600_000).toISOString(),
        enteredBy: "loop://iPhone",
        absorptionTime: 240,
      },
    ];
    const carbTenant = tenant("v1-loop-carbs");
    const carbResponse = await post(carbTenant, "treatments", carbs);
    expect(carbResponse.status).toBe(200);
    const carbRows = await carbResponse.json<JsonObject[]>();
    expect(carbRows).toHaveLength(carbs.length);
    expectObjectIds(carbRows);
    expect((await (await SELF.fetch(withTenant(
      "/api/v1/treatments.json?count=100",
      carbTenant,
    ))).json<JsonObject[]>())).toHaveLength(carbs.length);

    const doses = [
      { eventType: "Temp Basal", duration: 30, rate: 1.5, absolute: 1.5 },
      { eventType: "Bolus", insulin: 2 },
      { eventType: "Temp Basal", duration: 30, rate: 0.5, absolute: 0.5 },
    ].map((document, index) => ({
      ...document,
      created_at: new Date(now + index * 60_000).toISOString(),
      enteredBy: "loop://iPhone",
    }));
    const doseResponse = await post(tenant("v1-loop-doses"), "treatments", doses);
    expect(doseResponse.status).toBe(200);
    const doseRows = await doseResponse.json<JsonObject[]>();
    expect(doseRows).toHaveLength(doses.length);
    expectObjectIds(doseRows);

    const empty = await post(tenant("v1-empty-treatment-batch"), "treatments", []);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);
  });

  it("stores Loop glucose arrays, single-item arrays and 100 items in submission order", async () => {
    const now = Math.floor((Date.now() - 60 * 60_000) / 1000) * 1000;
    const glucose = Array.from({ length: 3 }, (_, index) => ({
      type: "sgv",
      sgv: 120 + index * 5,
      date: now + index * 300_000,
      dateString: new Date(now + index * 300_000).toISOString(),
      direction: index === 0 ? "Flat" : "FortyFiveUp",
      device: "loop://iPhone",
    }));
    const response = await post(tenant("v1-loop-glucose"), "entries", glucose);
    expect(response.status).toBe(200);
    const rows = await response.json<JsonObject[]>();
    expect(rows).toHaveLength(glucose.length);
    expectObjectIds(rows);

    const single = await post(tenant("v1-loop-single"), "entries", [glucose[0]]);
    expect(single.status).toBe(200);
    const singleRows = await single.json<JsonObject[]>();
    expect(singleRows).toHaveLength(1);
    expectObjectIds(singleRows);

    const large = Array.from({ length: 100 }, (_, index) => ({
      type: "sgv",
      sgv: 100 + index % 50,
      date: now + index * 60_000,
      dateString: new Date(now + index * 60_000).toISOString(),
      direction: "Flat",
      device: "loop://iPhone",
    }));
    const largeResponse = await post(tenant("v1-loop-large"), "entries", large);
    expect(largeResponse.status).toBe(200);
    const largeRows = await largeResponse.json<JsonObject[]>();
    expect(largeRows).toHaveLength(100);
    expectObjectIds(largeRows);
    expect(largeRows.map((row) => row.date)).toEqual(large.map((row) => row.date));
  });

  it("preserves Trio treatment and glucose pipeline fields and response order", async () => {
    const now = Date.now();
    const treatments = [
      {
        eventType: "Meal Bolus",
        insulin: 5,
        carbs: 45,
        created_at: new Date(now).toISOString(),
        enteredBy: "Trio",
        id: "trio-uuid-meal-1",
      },
      {
        eventType: "Correction Bolus",
        insulin: 1.5,
        created_at: new Date(now + 60_000).toISOString(),
        enteredBy: "Trio",
        id: "trio-uuid-corr-1",
      },
    ];
    const treatmentResponse = await post(tenant("v1-trio-treatments"), "treatments", treatments);
    expect(treatmentResponse.status).toBe(200);
    const treatmentRows = await treatmentResponse.json<JsonObject[]>();
    expect(treatmentRows).toHaveLength(2);
    expectObjectIds(treatmentRows);
    expect(treatmentRows.map((row) => [row.id, row.enteredBy])).toEqual(
      treatments.map((row) => [row.id, row.enteredBy]),
    );

    const glucose = Array.from({ length: 3 }, (_, index) => ({
      sgv: 110 + index * 5,
      date: now + index * 300_000,
      dateString: new Date(now + index * 300_000).toISOString(),
      direction: index === 1 ? "FortyFiveUp" : "Flat",
      type: "sgv",
      device: "Trio",
    }));
    const entryResponse = await post(tenant("v1-trio-glucose"), "entries", glucose);
    expect(entryResponse.status).toBe(200);
    const entryRows = await entryResponse.json<JsonObject[]>();
    expect(entryRows).toHaveLength(3);
    expect(entryRows.map((row) => row.device)).toEqual(["Trio", "Trio", "Trio"]);
  });

  it("treats isValid as stored entry data rather than rejecting a mixed batch", async () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    const mixed = [
      { type: "sgv", sgv: 120, date: now, direction: "Flat", isValid: true },
      { type: "sgv", sgv: 115, date: now - 300_000, direction: "Flat", isValid: false },
      { type: "sgv", sgv: 125, date: now + 300_000, direction: "FortyFiveUp", isValid: true },
    ];
    const response = await post(tenant("v1-mixed-validity"), "entries", mixed);
    expect(response.status).toBe(200);
    const rows = await response.json<JsonObject[]>();
    expect(rows).toHaveLength(mixed.length);
    expect(rows.map((row) => row.isValid)).toEqual([true, false, true]);
  });
});

describe("locked v1 AndroidAPS client document contract", () => {
  it("preserves AAPS SGV metadata and recalculates utcOffset from dateString", async () => {
    const name = tenant("v1-aaps-entry");
    const date = Date.now();
    const response = await post(name, "entries", [{
      type: "sgv",
      sgv: 120,
      date,
      dateString: "2026-01-18T10:30:00+02:00",
      device: "AndroidAPS-DexcomG6",
      direction: "Flat",
      app: "AAPS",
      utcOffset: 999,
    }]);
    expect(response.status).toBe(200);
    const rows = await response.json<JsonObject[]>();
    expect(rows).toHaveLength(1);
    expectObjectIds(rows);
    expect(rows[0]).toMatchObject({
      type: "sgv",
      sgv: 120,
      date,
      dateString: "2026-01-18T08:30:00.000Z",
      sysTime: "2026-01-18T08:30:00.000Z",
      utcOffset: 120,
      device: "AndroidAPS-DexcomG6",
      direction: "Flat",
      app: "AAPS",
    });
  });

  it("preserves SMB, meal-bolus and temp-basal pump metadata in single and batch responses", async () => {
    const name = tenant("v1-aaps-treatments");
    const now = Date.now();
    const smb = {
      eventType: "Correction Bolus",
      insulin: 0.25,
      created_at: new Date(now).toISOString(),
      date: now,
      type: "SMB",
      isValid: true,
      isSMB: true,
      pumpId: 4148,
      pumpType: "ACCU_CHEK_INSIGHT_BLUETOOTH",
      pumpSerial: "33013206",
      app: "AAPS",
    };
    const meal = {
      eventType: "Meal Bolus",
      insulin: 8.1,
      carbs: 45,
      created_at: new Date(now + 60_000).toISOString(),
      date: now + 60_000,
      type: "NORMAL",
      isValid: true,
      isSMB: false,
      pumpId: 4102,
      pumpType: "ACCU_CHEK_INSIGHT_BLUETOOTH",
      pumpSerial: "33013206",
      app: "AAPS",
    };
    const tempBasal = {
      eventType: "Temp Basal",
      created_at: new Date(now + 120_000).toISOString(),
      enteredBy: "openaps://AndroidAPS",
      isValid: true,
      duration: 60,
      rate: 0,
      type: "NORMAL",
      absolute: 0,
      pumpId: 284835,
      pumpType: "ACCU_CHEK_INSIGHT_BLUETOOTH",
      pumpSerial: "33013206",
      app: "AAPS",
    };

    const single = await post(tenant("v1-aaps-single"), "treatments", [meal]);
    expect(single.status).toBe(200);
    const singleRows = await single.json<JsonObject[]>();
    expect(singleRows).toHaveLength(1);
    expectObjectIds(singleRows);

    const batch = await post(name, "treatments", [smb, meal, tempBasal]);
    expect(batch.status).toBe(200);
    const rows = await batch.json<JsonObject[]>();
    expect(rows).toHaveLength(3);
    expectObjectIds(rows);
    expect(rows[0]).toMatchObject({
      eventType: "Correction Bolus",
      insulin: 0.25,
      type: "SMB",
      isValid: true,
      isSMB: true,
      pumpId: 4148,
      pumpType: "ACCU_CHEK_INSIGHT_BLUETOOTH",
      pumpSerial: "33013206",
      app: "AAPS",
    });
    expect(rows[1]).toMatchObject({
      eventType: "Meal Bolus",
      insulin: 8.1,
      carbs: 45,
      type: "NORMAL",
      isValid: true,
      isSMB: false,
      pumpId: 4102,
    });
    expect(rows[2]).toMatchObject({
      eventType: "Temp Basal",
      duration: 60,
      rate: 0,
      absolute: 0,
      isValid: true,
      pumpId: 284835,
    });
  });
});

describe("locked v1 authenticated Entries and slice contract", () => {
  it("rejects anonymous uploads and returns all 30 authorized preview rows", async () => {
    const name = tenant("v1-auth-preview");
    const date = Math.floor(Date.now() / 1000) * 1000;
    const unauthorized = await SELF.fetch(withTenant("/api/v1/entries.json", name), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{
        type: "sgv",
        sgv: 100,
        date,
        dateString: new Date(date).toISOString(),
      }]),
    });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({
      status: 401,
      message: "Unauthorized",
      description: "Invalid/Missing",
    });

    const previewRows = Array.from({ length: 30 }, (_, index) => ({
      type: "sgv",
      sgv: 100 + index,
      date: date + index * 60_000,
      dateString: new Date(date + index * 60_000).toISOString(),
      direction: "Flat",
      device: "preview-fixture",
    }));
    const preview = await SELF.fetch(withTenant("/api/v1/entries/preview.json", name), {
      method: "POST",
      headers: {
        "api-secret": await secretDigest(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(previewRows),
    });
    // The locked test ignores Supertest's stale 201 expectation; the actual
    // format_post_response calls res.json() and therefore returns 200.
    expect(preview.status).toBe(200);
    expect(await preview.json<JsonObject[]>()).toHaveLength(30);
  });

  it("reads a literal dateString slice and enforces auth for exact and ranged deletes", async () => {
    const name = tenant("v1-slice-delete");
    const date = Math.floor(Date.now() / 1000) * 1000;
    const dateString = new Date(date).toISOString();
    const created = await post(name, "entries", [{
      type: "sgv",
      sgv: 100,
      date,
      dateString,
      direction: "Flat",
      device: "slice-fixture",
    }]);
    expect(created.status).toBe(200);

    const prefix = dateString.split("T")[0]!;
    const slice = await SELF.fetch(withTenant(
      `/api/v1/slice/entries/dateString/sgv/${prefix}.json`,
      name,
    ));
    expect(slice.status).toBe(200);
    expect(await slice.json<JsonObject[]>()).toMatchObject([{
      type: "sgv",
      sgv: 100,
      dateString,
    }]);

    const exactPath = `/api/v1/entries/sgv?find[dateString]=${encodeURIComponent(dateString)}`;
    const denied = await SELF.fetch(withTenant(exactPath, name), { method: "DELETE" });
    expect(denied.status).toBe(401);
    expect((await SELF.fetch(withTenant("/api/v1/entries/sgv.json?count=10", name))).status)
      .toBe(200);

    const exactDelete = await SELF.fetch(withTenant(exactPath, name), {
      method: "DELETE",
      headers: { "api-secret": await secretDigest() },
      // Cloudflare's public edge may expose a bodyless DELETE as a zero-byte
      // stream instead of request.body === null.
      body: new Uint8Array(0),
    });
    expect(exactDelete.status).toBe(200);
    expect(await exactDelete.json()).toEqual({ acknowledged: true, deletedCount: 1 });
    expect(await (await SELF.fetch(withTenant(
      `/api/v1/slice/entries/dateString/sgv/${prefix}.json`,
      name,
    ))).json()).toEqual([]);

    const rangeName = tenant("v1-range-delete");
    const rangeRows = Array.from({ length: 10 }, (_, index) => ({
      type: "sgv",
      sgv: 110 + index,
      date: date + index * 60_000,
      dateString: new Date(date + index * 60_000).toISOString(),
      direction: "Flat",
      device: "range-fixture",
    }));
    expect((await post(rangeName, "entries", rangeRows)).status).toBe(200);
    const rangePath = `/api/v1/entries/sgv?find[date][$gte]=${date}`
      + `&find[date][$lte]=${date + 9 * 60_000}`;
    const rangeDenied = await SELF.fetch(withTenant(rangePath, rangeName), { method: "DELETE" });
    expect(rangeDenied.status).toBe(401);
    expect(await (await SELF.fetch(withTenant(
      `/api/v1/entries/sgv.json?find[date][$gte]=${date}&count=10`,
      rangeName,
    ))).json<JsonObject[]>()).toHaveLength(10);

    const rangeDelete = await SELF.fetch(withTenant(rangePath, rangeName), {
      method: "DELETE",
      headers: { "api-secret": await secretDigest() },
    });
    expect(rangeDelete.status).toBe(200);
    expect(await rangeDelete.json()).toEqual({ acknowledged: true, deletedCount: 10 });
  });
});
