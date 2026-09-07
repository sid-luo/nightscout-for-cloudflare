import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const TEST_API_SECRET = "nscf-test-secret-20260717";

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

async function v2Write(
  tenantName: string,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  payload?: unknown,
): Promise<Response> {
  const headers = new Headers({ "api-secret": await secretDigest() });
  const init: RequestInit = { method, headers };
  if (payload !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(payload);
  }
  return SELF.fetch(withTenant(path, tenantName), init);
}

describe("API v2 inherits the implemented v1 router", () => {
  it("exposes status, verifyauth and admin notifications through both mounts", async () => {
    for (const version of ["v1", "v2"] as const) {
      const status = await SELF.fetch(`https://example.test/api/${version}/status.json`);
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({
        name: "Nightscout",
        version: "15.0.8",
        runtimeState: "loaded",
      });

      const statusScript = await SELF.fetch(`https://example.test/api/${version}/status.js`);
      expect(statusScript.status).toBe(200);
      expect(statusScript.headers.get("Content-Type")).toMatch(/application\/javascript/);
      expect(await statusScript.text()).toContain('"version":"15.0.8"');

      const verify = await SELF.fetch(`https://example.test/api/${version}/verifyauth`);
      expect(verify.status).toBe(200);
      expect(await verify.json()).toMatchObject({
        status: 200,
        message: { canRead: true, canWrite: false, permissions: "DEFAULT" },
      });

      const notifies = await SELF.fetch(`https://example.test/api/${version}/adminnotifies`);
      expect(notifies.status).toBe(200);
      expect(await notifies.json()).toEqual({ message: { notifies: [], notifyCount: 1 } });
    }
  });

  it("stores entries through v2 and exposes the same records through v1", async () => {
    const name = tenant("v2-entries");
    const now = Date.now();
    const created = await v2Write(name, "POST", "/api/v2/entries", [
      {
        type: "sgv",
        sgv: 121,
        date: now,
        dateString: new Date(now).toISOString(),
        device: "v2-contract",
        direction: "Flat",
      },
    ]);
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject([{
      _id: expect.stringMatching(/^[0-9a-f]{24}$/),
      type: "sgv",
      sgv: 121,
      device: "v2-contract",
      sysTime: new Date(now).toISOString(),
      utcOffset: 0,
    }]);

    const fromV2 = await (
      await SELF.fetch(withTenant("/api/v2/entries.json?count=10", name))
    ).json<Array<Record<string, unknown>>>();
    const fromV1 = await (
      await SELF.fetch(withTenant("/api/v1/entries.json?count=10", name))
    ).json<Array<Record<string, unknown>>>();
    expect(fromV2).toEqual(fromV1);
    expect(fromV2).toMatchObject([{ sgv: 121, device: "v2-contract" }]);

    const current = await SELF.fetch(withTenant("/api/v2/entries/current.json", name));
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject([{ sgv: 121, device: "v2-contract" }]);

    const id = String(fromV2[0]?._id);
    const deleted = await v2Write(name, "DELETE", `/api/v2/entries/${id}`);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ acknowledged: true, deletedCount: 1 });
  });

  it("inherits the implemented document collection CRUD without duplicating storage", async () => {
    const name = tenant("v2-documents");

    const foodCreate = await v2Write(name, "POST", "/api/v2/food", {
      type: "food",
      name: "Rice",
      category: "Meal",
      portion: 100,
      carbs: 28,
    });
    expect(foodCreate.status).toBe(200);
    const food = (await foodCreate.json<Array<Record<string, unknown>>>())[0];
    expect(food?._id).toMatch(/^[0-9a-f]{24}$/);
    expect(
      await (await SELF.fetch(withTenant("/api/v1/food/regular.json", name))).json(),
    ).toMatchObject([{ name: "Rice", carbs: 28 }]);

    const profile = {
      defaultProfile: "Default",
      startDate: new Date().toISOString(),
      units: "mg/dL",
      store: { Default: { timezone: "UTC", dia: 3 } },
    };
    const profileSave = await v2Write(name, "PUT", "/api/v2/profile", profile);
    expect(profileSave.status).toBe(200);
    expect(await profileSave.json()).toMatchObject(profile);
    expect(
      await (await SELF.fetch(withTenant("/api/v2/profile/current", name))).json(),
    ).toMatchObject(profile);

    const treatmentCreate = await v2Write(name, "POST", "/api/v2/treatments", {
      eventType: "Note",
      created_at: new Date().toISOString(),
      notes: "simulated v2 record",
    });
    expect(treatmentCreate.status).toBe(200);
    expect(
      await (await SELF.fetch(withTenant("/api/v2/treatments?count=10", name))).json(),
    ).toMatchObject([{ eventType: "Note", notes: "simulated v2 record" }]);

    const deviceCreate = await v2Write(name, "POST", "/api/v2/devicestatus", {
      created_at: new Date().toISOString(),
      device: "v2-simulator",
      uploaderBattery: 85,
    });
    expect(deviceCreate.status).toBe(200);
    expect(
      await (await SELF.fetch(withTenant("/api/v2/devicestatus?count=10", name))).json(),
    ).toMatchObject([{ device: "v2-simulator", uploaderBattery: 85 }]);

    expect((await v2Write(name, "DELETE", `/api/v2/food/${String(food?._id)}`)).status).toBe(200);
    expect(await (await SELF.fetch(withTenant("/api/v2/food", name))).json()).toEqual([]);
  });
});
