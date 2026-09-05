import { env } from "cloudflare:workers";
import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { EntryStore } from "../src/entry-store";
import { createJwtSecret, issueJwt, verifyJwt } from "../src/jwt";
import type { PublicEntry } from "../src/model";
import { permissionGroupsAllow } from "../src/permissions";

const TEST_API_SECRET = "nscf-test-secret-20260717";

async function secretDigest(algorithm: "SHA-1" | "SHA-512" = "SHA-1"): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, new TextEncoder().encode(TEST_API_SECRET));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function entry(sgv: number, date: number, direction = "Flat"): Record<string, unknown> {
  return { sgv, date, direction, device: "simulator", type: "sgv" };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const encoded = token.split(".")[1];
  if (encoded === undefined) throw new Error("JWT payload is missing");
  const padded = encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    encoded.length + ((4 - (encoded.length % 4)) % 4),
    "=",
  );
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

async function post(tenantName: string, payload: unknown, path = "/api/v1/entries"): Promise<Response> {
  return SELF.fetch(`https://example.test${path}?tenant=${tenantName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-secret": await secretDigest() },
    body: JSON.stringify(payload),
  });
}

async function writeApi(
  tenantName: string,
  method: "POST" | "PUT" | "DELETE",
  path: string,
  payload?: unknown,
  contentType = "application/json",
): Promise<Response> {
  const separator = path.includes("?") ? "&" : "?";
  const headers: Record<string, string> = { "api-secret": await secretDigest() };
  if (payload !== undefined) headers["Content-Type"] = contentType;
  const init: RequestInit = { method, headers };
  if (payload !== undefined) {
    init.body = contentType === "application/json" ? JSON.stringify(payload) : String(payload);
  }
  return SELF.fetch(`https://example.test${path}${separator}tenant=${tenantName}`, init);
}

describe("official Nightscout UI assets", () => {
  it("serves the upstream homepage with a separate Nightscout for Cloudflare identity", async () => {
    const page = await SELF.fetch("https://example.test/");
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toMatch(/charset=utf-8/i);
    const html = await page.text();
    expect(html).toContain("<title>Nightscout</title>");
    expect(html).toContain('id="chartContainer"');
    expect(html).toContain('/bundle/js/bundle.app.js');
    expect(html).toContain('id="nscf-about"');
    expect(html).toContain('Upstream version <span class="version"></span>');
    expect(html).toContain("<strong>Nightscout for Cloudflare</strong>");
    expect(html).toContain("Version <strong>1.2</strong>");
    expect(html).toContain(
      'href="https://github.com/sid-luo/nightscout-for-cloudflare"',
    );
    expect(html).toContain(
      'href="https://github.com/sid-luo/nightscout-for-cloudflare/issues"',
    );
    const bundle = await SELF.fetch("https://example.test/bundle/js/bundle.app.js");
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("Content-Type")).toMatch(/charset=utf-8/i);

    const socketClient = await SELF.fetch("https://example.test/socket.io/socket.io.js");
    expect(socketClient.status).toBe(200);
    const socketClientSource = await socketClient.text();
    expect(socketClientSource).toContain("Socket.IO v4.5.4");
    expect(socketClientSource).not.toContain("/api/v2/ddata/at?");

    const socketClientDigest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(socketClientSource),
    );
    const socketClientHash = Array.from(
      new Uint8Array(socketClientDigest),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    expect(socketClientHash).toBe(
      "7a8ec840e096ddb18a8acc585baadcb3575b35cd6208b0193bdecfb43184fa42",
    );

    const tenantAdapter = await SELF.fetch(
      "https://example.test/platform/socket-tenant-adapter.js",
    );
    expect(tenantAdapter.status).toBe(200);
    const tenantAdapterSource = await tenantAdapter.text();
    expect(tenantAdapterSource).toContain("connectWithTenant");
    expect(tenantAdapterSource).toContain('query.set("tenant", selected)');
    const tenantAdapterDigest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(tenantAdapterSource),
    );
    const tenantAdapterHash = Array.from(
      new Uint8Array(tenantAdapterDigest),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const combinedDigest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(socketClientSource + tenantAdapterSource),
    );
    const transportCachebuster = Array.from(
      new Uint8Array(combinedDigest),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("").slice(0, 12);
    expect(html).toContain(`src="/socket.io/socket.io.js?${socketClientHash.slice(0, 12)}"`);
    expect(html).toContain(
      `src="/platform/socket-tenant-adapter.js?${tenantAdapterHash.slice(0, 12)}"`,
    );
    expect(html).toContain(
      `navigator.serviceWorker.register('/sw.js?v15.0.7-7e0e77f88fc1-${transportCachebuster}'`,
    );

    const serviceWorker = await SELF.fetch("https://example.test/sw.js");
    expect(serviceWorker.status).toBe(200);
    const serviceWorkerSource = await serviceWorker.text();
    expect(serviceWorkerSource).toContain(
      `var CACHE = 'v15.0.7-7e0e77f88fc1-${transportCachebuster}'`,
    );
    expect(serviceWorkerSource).not.toContain("'/socket.io/socket.io.js'");

    const downstreamArtifact = await SELF.fetch("https://example.test/nscf-upstream.json");
    expect(downstreamArtifact.status).toBe(404);
  });

  it("serves the official upstream secondary pages and clock views", async () => {
    const pages = [
      ["/admin/", "Admin tools: Nightscout"],
      ["/profile/", "Profile Editor: Nightscout"],
      ["/food/", "<title>Food Editor</title>"],
      ["/report/", "<title>Nightscout Reporting</title>"],
      ["/split/", "Nightscout multiframe view"],
      ["/split", "Nightscout multiframe view"],
      ["/clock/clock-color/", 'data-face="clock-color"'],
      ["/clock/cy10-sg35/", 'data-face="cy10-sg35"'],
      ["/api-docs/", 'id="swagger-ui"'],
      ["/api3-docs/", 'url: "/api3-swagger.json"'],
    ] as const;

    for (const [path, marker] of pages) {
      const response = await SELF.fetch(`https://example.test${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("Content-Type"), path).toBe("text/html; charset=utf-8");
      expect(await response.text(), path).toContain(marker);
    }
  });

  it("keeps every Admin tool while relabeling legacy Mongo panels", async () => {
    const page = await SELF.fetch("https://example.test/admin/");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain('id="nscf-storage-notice"');
    expect(html).toContain(
      'Nightscout.admin_plugins("cleanstatusdb").label = "Device status maintenance"',
    );
    expect(html).toContain(
      'Nightscout.admin_plugins("cleantreatmentsdb").label = "Treatment records maintenance"',
    );
    expect(html).toContain(
      'Nightscout.admin_plugins("cleanentriesdb").label = "Glucose entries maintenance"',
    );
    expect(html).toContain(
      'Nightscout.admin_plugins("futureitems").label = "Future-dated records maintenance"',
    );

    const bundleIndex = html.indexOf('<script src="/bundle/js/bundle.app.js"></script>');
    const labelsIndex = html.indexOf(
      'Nightscout.admin_plugins("cleanstatusdb").label',
    );
    const adminIndex = html.indexOf('<script src="/admin/js/admin.js"></script>');
    expect(bundleIndex).toBeGreaterThanOrEqual(0);
    expect(labelsIndex).toBeGreaterThan(bundleIndex);
    expect(adminIndex).toBeGreaterThan(labelsIndex);
  });

  it("forces HTML metadata for secondary-page assets and conditional cache hits", async () => {
    const forwardedValidators: Array<string | null> = [];
    const assetEnv = (status: 200 | 304): Env => ({
      API_SECRET: env.API_SECRET,
      ENTRY_STORE: env.ENTRY_STORE,
      DEXCOM_SHARE_CONNECTOR: env.DEXCOM_SHARE_CONNECTOR,
      ASSETS: {
        fetch: async (request: Request) => {
          const validator = request.headers.get("If-None-Match");
          forwardedValidators.push(validator);
          const effectiveStatus = validator === null ? status : 304;
          return new Response(
            effectiveStatus === 200
              ? "<html><title>Nightscout multiframe view</title></html>"
              : null,
            {
              status: effectiveStatus,
              headers: {
                "Content-Type": "text/plain",
                ETag: '"split-v1"',
              },
            },
          );
        },
      } as unknown as Fetcher,
    });

    const normal = await worker.fetch(
      new Request("https://example.test/split"),
      assetEnv(200),
    );
    expect(normal.status).toBe(200);
    expect(normal.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(normal.headers.get("Cache-Control")).toBe("no-store");
    expect(normal.headers.get("ETag")).toBeNull();
    expect(await normal.text()).toContain("Nightscout multiframe view");

    const cached = await worker.fetch(
      new Request("https://example.test/split", {
        headers: { "If-None-Match": '"split-v1"' },
      }),
      assetEnv(200),
    );
    expect(cached.status).toBe(200);
    expect(cached.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(cached.headers.get("Cache-Control")).toBe("no-store");
    expect(cached.headers.get("ETag")).toBeNull();
    expect(await cached.text()).toContain("Nightscout multiframe view");
    expect(forwardedValidators).toEqual([null, null]);

    const directNotModified = await worker.fetch(
      new Request("https://example.test/split"),
      assetEnv(304),
    );
    expect(directNotModified.status).toBe(304);
    expect(directNotModified.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await directNotModified.text()).toBe("");
  });
});

describe("Nightscout compatibility API", () => {
  it("returns the official client startup contract", async () => {
    const response = await SELF.fetch("https://example.test/api/v1/status.json");
    expect(response.status).toBe(200);
    const status = await response.json<Record<string, unknown>>();
    expect(status).toMatchObject({
      name: "Nightscout",
      version: "15.0.7",
      runtimeState: "loaded",
      apiEnabled: true,
      careportalEnabled: true,
    });
    expect(status).not.toHaveProperty("nscf");
    expect(status.version).toBe("15.0.7");

    const auth = await SELF.fetch("https://example.test/api/v1/verifyauth");
    expect(await auth.json()).toEqual({
      status: 200,
      message: {
        canRead: true,
        canWrite: false,
        isAdmin: false,
        permissions: "DEFAULT",
        rolefound: "NOTFOUND",
        message: "UNAUTHORIZED",
      },
    });

    const writableAuth = await SELF.fetch("https://example.test/api/v1/verifyauth", {
      headers: { "api-secret": await secretDigest("SHA-512") },
    });
    expect(await writableAuth.json()).toEqual({
      status: 200,
      message: {
        canRead: true,
        canWrite: true,
        isAdmin: true,
        permissions: "ROLE",
        rolefound: "NOTFOUND",
        message: "OK",
      },
    });

    const rejectedAuth = await SELF.fetch("https://example.test/api/v1/verifyauth", {
      headers: { "api-secret": "not-a-valid-credential" },
    });
    expect(await rejectedAuth.json()).toEqual({
      status: 200,
      message: {
        canRead: false,
        canWrite: false,
        isAdmin: false,
        permissions: "ROLE",
        rolefound: "NOTFOUND",
        message: "UNAUTHORIZED",
      },
    });

    const notifies = await SELF.fetch("https://example.test/api/v1/adminnotifies");
    expect(await notifies.json()).toEqual({ message: { notifies: [], notifyCount: 2 } });
  });

  it("provides the official clock startup scripts and properties shape", async () => {
    const name = tenant("clock");
    const base = Date.now() - 10 * 60_000;
    await post(name, [entry(110, base), entry(123, base + 300_000, "SingleUp")]);
    // These are newer than both SGVs. Mongo-backed Nightscout derives
    // properties from its SGV bucket, so MBGs must be filtered before LIMIT 4.
    await post(name, Array.from({ length: 4 }, (_, index) => ({
      type: "mbg",
      mbg: 100 + index,
      date: base + (index + 6) * 60_000,
      dateString: new Date(base + (index + 6) * 60_000).toISOString(),
      device: "properties-meter",
    })));

    const statusScript = await SELF.fetch("https://example.test/api/v1/status.js");
    expect(statusScript.status).toBe(200);
    expect(statusScript.headers.get("Content-Type")).toMatch(/application\/javascript/);
    expect(await statusScript.text()).toContain('"version":"15.0.7"');

    const properties = await (
      await SELF.fetch(`https://example.test/api/v2/properties?tenant=${name}`)
    ).json<Record<string, any>>();
    expect(properties).toMatchObject({
      bgnow: {
        sgvs: [{ mgdl: 123, scaled: 123, direction: "SingleUp" }],
      },
      delta: { mgdl: 13, scaled: 13, display: "+13" },
    });

    const staleName = tenant("clock-stale");
    const staleDate = Date.now() - 3 * 24 * 60 * 60_000;
    await post(staleName, [entry(199, staleDate)]);
    const staleProperties = await (
      await SELF.fetch(`https://example.test/api/v2/properties?tenant=${staleName}`)
    ).json<Record<string, any>>();
    expect(staleProperties).toMatchObject({
      bgnow: { sgvs: [] },
      delta: null,
      upbat: { display: "?%", devices: {} },
      dbsize: {
        display: "0%",
        status: "current",
        notificationLevel: 0,
        details: { maxSize: 953.67 },
      },
    });
    expect(staleProperties.dbsize.totalDataSize).toBeGreaterThan(0);
  });

  it("persists food editor records through create, update, filtering and delete", async () => {
    const name = tenant("food");
    const createdResponse = await writeApi(
      name,
      "POST",
      "/api/v1/food/",
      "type=food&name=Rice&category=Meal&portion=100&carbs=28",
      "application/x-www-form-urlencoded",
    );
    expect(createdResponse.status).toBe(200);
    const [created] = await createdResponse.json<Array<Record<string, unknown>>>();
    expect(created?._id).toMatch(/^[0-9a-f]{24}$/);

    const updated = { ...created, name: "Brown Rice", carbs: 24 };
    expect((await writeApi(name, "PUT", "/api/v1/food/", updated)).status).toBe(200);

    const regular = await (
      await SELF.fetch(`https://example.test/api/v1/food/regular.json?tenant=${name}`)
    ).json<Array<Record<string, unknown>>>();
    expect(regular).toMatchObject([{ name: "Brown Rice", carbs: 24 }]);

    expect((await writeApi(name, "DELETE", `/api/v1/food/${created?._id}`)).status).toBe(200);
    expect(
      await (
        await SELF.fetch(`https://example.test/api/v1/food.json?tenant=${name}`)
      ).json(),
    ).toEqual([]);
  });

  it("persists profile editor records and isolates them by tenant", async () => {
    const name = tenant("profile");
    const other = tenant("profile-other");
    const profile = {
      defaultProfile: "Default",
      startDate: new Date().toISOString(),
      units: "mg/dL",
      store: {
        Default: {
          dia: 3,
          timezone: "UTC",
          basal: [{ time: "00:00", value: 0.5 }],
          sens: [{ time: "00:00", value: 50 }],
          carbratio: [{ time: "00:00", value: 10 }],
          target_low: [{ time: "00:00", value: 80 }],
          target_high: [{ time: "00:00", value: 120 }],
        },
      },
    };
    const save = await writeApi(name, "PUT", "/api/v1/profile/", profile);
    expect(save.status).toBe(200);
    const saved = await save.json<Record<string, unknown>>();
    expect(saved._id).toMatch(/^[0-9a-f]{24}$/);

    const current = await (
      await SELF.fetch(`https://example.test/api/v1/profile/current?tenant=${name}`)
    ).json<Record<string, unknown>>();
    expect(current).toMatchObject({ _id: saved._id, defaultProfile: "Default" });
    expect(
      await (
        await SELF.fetch(`https://example.test/api/v1/profile.json?tenant=${other}`)
      ).json(),
    ).toEqual([]);

    await evictDurableObject(env.ENTRY_STORE.getByName(name));
    expect(
      await (
        await SELF.fetch(`https://example.test/api/v1/profile.json?tenant=${name}`)
      ).json(),
    ).toMatchObject([{ _id: saved._id }]);
  });

  it("persists treatments and device status for reports, cleanup tools and live data", async () => {
    const name = tenant("report-data");
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const treatmentResponse = await writeApi(name, "POST", "/api/v1/treatments/", {
      eventType: "Carb Correction",
      carbs: 15,
      created_at: createdAt,
    });
    const [treatment] = await treatmentResponse.json<Array<Record<string, unknown>>>();
    expect(treatment?._id).toMatch(/^[0-9a-f]{24}$/);

    const statusResponse = await writeApi(name, "POST", "/api/v1/devicestatus/", {
      device: "simulator",
      created_at: createdAt,
      uploader: { battery: 80 },
    });
    expect(statusResponse.status).toBe(200);

    const range = encodeURIComponent(new Date(Date.now() - 120_000).toISOString());
    const treatments = await (
      await SELF.fetch(
        `https://example.test/api/v1/treatments.json?tenant=${name}&find[created_at][$gte]=${range}`,
      )
    ).json<Array<Record<string, unknown>>>();
    expect(treatments).toMatchObject([{ eventType: "Carb Correction", carbs: 15 }]);

    const live = await (
      await SELF.fetch(`https://example.test/api/v2/ddata/at?tenant=${name}`)
    ).json<Record<string, any>>();
    expect(live.treatments).toMatchObject([{ _id: treatment?._id }]);
    expect(live.devicestatus).toMatchObject([{ device: "simulator" }]);

    const removed = await writeApi(name, "DELETE", `/api/v1/treatments/${treatment?._id}`);
    expect(await removed.json()).toEqual({ acknowledged: true, deletedCount: 1 });
  });

  it("keeps v1 and ddata treatment bodies legacy-shaped and permits legacy read-only writes", async () => {
    const name = tenant("legacy-treatment-shape");
    const createdDate = new Date(Date.now() - 60_000);
    createdDate.setMilliseconds(0);
    const createdAt = createdDate.toISOString();
    const createdResponse = await writeApi(name, "POST", "/api/v1/treatments/", {
      eventType: "Note",
      created_at: createdAt,
      notes: "legacy tombstone",
      isValid: false,
      isReadOnly: true,
    });
    expect(createdResponse.status).toBe(200);
    const [created] = await createdResponse.json<Array<Record<string, unknown>>>();
    expect(created).toMatchObject({
      eventType: "Note",
      created_at: createdAt,
      isValid: false,
      isReadOnly: true,
    });
    expect(created).not.toHaveProperty("srvCreated");
    expect(created).not.toHaveProperty("srvModified");

    const listedResponse = await SELF.fetch(
      `https://example.test/api/v1/treatments.json?tenant=${name}`,
    );
    expect(listedResponse.status).toBe(200);
    const listed = await listedResponse.json<Array<Record<string, unknown>>>();
    expect(listed).toMatchObject([{
      _id: created?._id,
      isValid: false,
      carbs: null,
      insulin: null,
    }]);
    expect(listed[0]).not.toHaveProperty("srvCreated");
    expect(listed[0]).not.toHaveProperty("srvModified");
    expect(listedResponse.headers.get("Last-Modified")).toBe(createdDate.toUTCString());

    const conditional = await SELF.fetch(
      `https://example.test/api/v1/treatments.json?tenant=${name}`,
      { headers: { "If-Modified-Since": createdDate.toUTCString() } },
    );
    expect(conditional.status).toBe(304);

    const ddata = await (
      await SELF.fetch(`https://example.test/api/v2/ddata/at?tenant=${name}`)
    ).json<Record<string, any>>();
    expect(ddata.treatments).toMatchObject([{ _id: created?._id, isValid: false }]);
    expect(ddata.treatments[0]).not.toHaveProperty("srvCreated");
    expect(ddata.treatments[0]).not.toHaveProperty("srvModified");
    expect(ddata.treatments[0]).not.toHaveProperty("carbs");
    expect(ddata.treatments[0]).not.toHaveProperty("insulin");

    const updatedResponse = await writeApi(name, "PUT", "/api/v1/treatments/", {
      ...created,
      notes: "legacy update allowed",
    });
    expect(updatedResponse.status).toBe(200);
    expect(await updatedResponse.json()).toMatchObject({
      _id: created?._id,
      notes: "legacy update allowed",
      isReadOnly: true,
    });

    const removed = await writeApi(name, "DELETE", `/api/v1/treatments/${created?._id}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ acknowledged: true, deletedCount: 1 });
  });

  it("accepts an empty v1 treatments batch with the locked 200 [] shape", async () => {
    const name = tenant("empty-treatment-batch");
    const response = await writeApi(name, "POST", "/api/v1/treatments/", []);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(await (
      await SELF.fetch(`https://example.test/api/v1/treatments.json?tenant=${name}`)
    ).json()).toEqual([]);
  });

  it("keeps late v1 uploads virtual while syncing their API3 fallback timestamps", async () => {
    const name = tenant("legacy-api3-time-boundary");
    const createdAt = "2001-02-03T04:05:06.000Z";
    const createdAtMillis = Date.parse(createdAt);
    const uploadStarted = Date.now();
    const response = await writeApi(name, "POST", "/api/v1/treatments/", {
      eventType: "Note",
      created_at: createdAt,
      notes: "uploaded decades later",
    });
    expect(response.status).toBe(200);
    const [legacy] = await response.json<Array<Record<string, unknown>>>();
    const legacyId = String(legacy?._id);
    expect(legacy).not.toHaveProperty("srvCreated");
    expect(legacy).not.toHaveProperty("srvModified");

    const stub = env.ENTRY_STORE.getByName(name);
    const readJson = await stub.findTreatmentById(legacyId);
    if (readJson === null) throw new Error("legacy treatment was not materialized");
    const read = JSON.parse(readJson) as Record<string, unknown>;
    expect(read).toMatchObject({
      identifier: legacyId,
      created_at: createdAt,
      srvCreated: createdAtMillis,
      srvModified: createdAtMillis,
    });
    expect(read).not.toHaveProperty("_id");

    const search = JSON.parse(await stub.queryTreatments(JSON.stringify({
      fields: ["_all"],
      limit: 10,
    }))) as Array<Record<string, unknown>>;
    expect(search).toHaveLength(1);
    expect(search[0]).toMatchObject({
      identifier: legacyId,
      srvCreated: createdAtMillis,
      srvModified: createdAtMillis,
    });
    expect(search[0]).not.toHaveProperty("_id");

    for (const field of ["srvCreated", "srvModified"]) {
      const recent = JSON.parse(await stub.queryTreatments(JSON.stringify({
        filters: [{ field, operator: "gte", value: uploadStarted }],
        limit: 10,
      }))) as unknown[];
      expect(recent, field).toEqual([]);
    }
    expect(JSON.parse(
      await stub.treatmentHistory(JSON.stringify({ since: 0 })),
    )).toMatchObject([{
      identifier: legacyId,
      srvCreated: createdAtMillis,
      srvModified: createdAtMillis,
    }]);
    expect(await stub.treatmentsLastModified()).toBe(createdAtMillis);

    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(state.storage.sql.exec<{ srv_created: number | null; srv_modified: number | null }>(
        `SELECT srv_created, srv_modified FROM documents
         WHERE collection = 'treatments' AND id = ?`,
        legacyId,
      ).one()).toEqual({ srv_created: null, srv_modified: null });
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM collection_clocks WHERE collection = 'treatments'",
      ).one().count).toBe(0);
    });

    const api3CreatedAt = new Date().toISOString();
    const first = JSON.parse(await stub.createTreatment(JSON.stringify({
      identifier: "api3-syncable",
      date: Date.parse(api3CreatedAt),
      utcOffset: 0,
      app: "round3-test",
      eventType: "Note",
      created_at: api3CreatedAt,
      notes: "native API3 timestamp",
      srvCreated: 1,
      srvModified: 2,
    }))) as { document: Record<string, unknown>; srvModified: number };
    expect(first.srvModified).toBeGreaterThanOrEqual(uploadStarted);
    expect(first.document).toMatchObject({
      srvCreated: first.srvModified,
      srvModified: first.srvModified,
    });
    expect(first.document).not.toHaveProperty("_id");

    await evictDurableObject(stub);
    const resumed = env.ENTRY_STORE.getByName(name);
    const patchedJson = await resumed.patchTreatment(
      "api3-syncable",
      JSON.stringify({ notes: "strictly newer after eviction" }),
    );
    if (patchedJson === null) throw new Error("API3 treatment disappeared after eviction");
    const patched = JSON.parse(patchedJson) as {
      document: Record<string, unknown>;
      srvModified: number;
    };
    expect(patched.srvModified).toBeGreaterThan(first.srvModified);
    expect(patched.document).not.toHaveProperty("_id");

    const history = JSON.parse(
      await resumed.treatmentHistory(JSON.stringify({ since: 0 })),
    ) as Array<Record<string, unknown>>;
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      identifier: legacyId,
      srvModified: createdAtMillis,
    });
    expect(history[1]).toMatchObject({
      identifier: "api3-syncable",
      srvModified: patched.srvModified,
    });
    expect(history[1]).not.toHaveProperty("_id");

    const legacyOverwrite = await writeApi(name, "POST", "/api/v1/treatments/", {
      identifier: "api3-syncable",
      eventType: "Note",
      created_at: api3CreatedAt,
      notes: "v1 replacement removes persisted srv fields",
    });
    expect(legacyOverwrite.status).toBe(200);
    const [overwritten] = await legacyOverwrite.json<Array<Record<string, unknown>>>();
    expect(overwritten).not.toHaveProperty("srvCreated");
    expect(overwritten).not.toHaveProperty("srvModified");
    expect(JSON.parse(
      await resumed.treatmentHistory(JSON.stringify({ since: 0 })),
    )).toMatchObject([
      {
        identifier: legacyId,
        srvModified: createdAtMillis,
      },
      {
        identifier: "api3-syncable",
        srvModified: Date.parse(api3CreatedAt),
      },
    ]);
  });

  it("supports v1 UUID retransmission plus identifier and fallback PUT identities", async () => {
    const name = tenant("legacy-treatment-uuid");
    const createdAt = new Date(Date.now() - 90_000).toISOString();
    const uuid = crypto.randomUUID();

    const firstResponse = await writeApi(name, "POST", "/api/v1/treatments/", {
      _id: uuid,
      eventType: "Note",
      created_at: createdAt,
      notes: "uuid create",
    });
    expect(firstResponse.status).toBe(200);
    const [first] = await firstResponse.json<Array<Record<string, unknown>>>();
    expect(first).toMatchObject({ identifier: uuid, notes: "uuid create" });
    expect(first?._id).toMatch(/^[0-9a-f]{24}$/);

    const retransmitResponse = await writeApi(name, "POST", "/api/v1/treatments/", {
      _id: uuid,
      eventType: "Note",
      created_at: createdAt,
      notes: "uuid retransmit",
    });
    const [retransmitted] = await retransmitResponse.json<Array<Record<string, unknown>>>();
    expect(retransmitted).toMatchObject({ _id: first?._id, identifier: uuid });

    const identifierPut = await writeApi(name, "PUT", "/api/v1/treatments/", {
      identifier: uuid,
      eventType: "Note",
      created_at: createdAt,
      notes: "identifier-only PUT",
    });
    expect(identifierPut.status).toBe(200);
    expect(await identifierPut.json()).toMatchObject({
      _id: first?._id,
      identifier: uuid,
      notes: "identifier-only PUT",
    });

    const identifierLookup = await SELF.fetch(
      `https://example.test/api/v1/treatments.json?tenant=${name}&find[_id]=${uuid}`,
    );
    expect(identifierLookup.status).toBe(200);
    expect(await identifierLookup.json()).toMatchObject([{
      _id: first?._id,
      identifier: uuid,
      notes: "identifier-only PUT",
    }]);

    const rawUuid = crypto.randomUUID();
    const rawCreatedAt = "2000-01-02T03:04:05.000Z";
    const stub = env.ENTRY_STORE.getByName(name);
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec(
        `INSERT INTO documents
          (collection, id, body, sort_time, created_at, updated_at, identifier,
           identifier_present, srv_created, srv_modified, is_valid, fallback_key, revision,
           srv_metadata_version)
         VALUES ('treatments', ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, 1, NULL, 1, 1)`,
        rawUuid,
        JSON.stringify({
          _id: rawUuid,
          eventType: "Note",
          created_at: rawCreatedAt,
          notes: "raw UUID id",
        }),
        Date.parse(rawCreatedAt),
        Date.now(),
        Date.now(),
      );
    });
    const rawIdLookup = await SELF.fetch(
      `https://example.test/api/v1/treatments.json?tenant=${name}&find[_id]=${rawUuid}`,
    );
    expect(rawIdLookup.status).toBe(200);
    expect(await rawIdLookup.json()).toMatchObject([{
      _id: rawUuid,
      notes: "raw UUID id",
    }]);

    const objectIdLookup = await SELF.fetch(
      `https://example.test/api/v1/treatments.json?tenant=${name}&find[_id]=${String(first?._id)}`,
    );
    expect(objectIdLookup.status).toBe(200);
    expect(await objectIdLookup.json()).toMatchObject([{ _id: first?._id, identifier: uuid }]);

    const missingLookup = await SELF.fetch(
      `https://example.test/api/v1/treatments.json?tenant=${name}&find[_id]=${crypto.randomUUID()}`,
    );
    expect(missingLookup.status).toBe(200);
    expect(await missingLookup.json()).toEqual([]);

    const fallbackCreatedAt = new Date(Date.now() - 30_000).toISOString();
    const fallbackCreate = await writeApi(name, "POST", "/api/v1/treatments/", {
      eventType: "Meal Bolus",
      created_at: fallbackCreatedAt,
      carbs: 10,
    });
    const [fallbackFirst] = await fallbackCreate.json<Array<Record<string, unknown>>>();
    const fallbackPut = await writeApi(name, "PUT", "/api/v1/treatments/", {
      eventType: "Meal Bolus",
      created_at: fallbackCreatedAt,
      carbs: 11,
    });
    expect(await fallbackPut.json()).toMatchObject({
      _id: fallbackFirst?._id,
      carbs: 11,
    });

    const removed = await writeApi(name, "DELETE", `/api/v1/treatments/${uuid}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ acknowledged: true, deletedCount: 1 });
  });

  it("normalizes v1 numeric predicates and orders treatments by created_at", async () => {
    const name = tenant("legacy-treatment-query-shape");
    const numericCreatedAt = new Date(Date.now() - 3 * 60_000).toISOString();
    await writeApi(name, "POST", "/api/v1/treatments/", {
      eventType: "Meal Bolus",
      created_at: numericCreatedAt,
      carbs: "99",
    });
    const numericResponse = await SELF.fetch(
      `https://example.test/api/v1/treatments.json?tenant=${name}&find[carbs]=99`,
    );
    expect(numericResponse.status).toBe(200);
    expect(await numericResponse.json()).toMatchObject([{
      created_at: numericCreatedAt,
      carbs: 99,
    }]);

    const olderCreatedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    const newerCreatedAt = new Date(Date.now() - 60_000).toISOString();
    const olderResponse = await writeApi(name, "POST", "/api/v1/treatments/", {
      eventType: "Ordering Fixture",
      created_at: olderCreatedAt,
      date: Date.now() + 24 * 60 * 60 * 1000,
      notes: "older created_at",
    });
    const newerResponse = await writeApi(name, "POST", "/api/v1/treatments/", {
      eventType: "Ordering Fixture",
      created_at: newerCreatedAt,
      date: 1,
      notes: "newer created_at",
    });
    const [older] = await olderResponse.json<Array<Record<string, unknown>>>();
    const [newer] = await newerResponse.json<Array<Record<string, unknown>>>();

    const ordered = await (
      await SELF.fetch(
        `https://example.test/api/v1/treatments.json?tenant=${name}`
          + "&find[eventType]=Ordering%20Fixture&count=2",
      )
    ).json<Array<Record<string, unknown>>>();
    expect(ordered.map((document) => document._id)).toEqual([newer?._id, older?._id]);
  });

  it("pushes v1 treatment filters before limit and controls unsupported queries", async () => {
    const name = tenant("treatment-tail-query");
    const stub = env.ENTRY_STORE.getByName(name);
    const recentBaseDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
    recentBaseDate.setMilliseconds(0);
    const recentBase = recentBaseDate.toISOString();
    await stub.treatmentsLastModified();
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec(`
        WITH digits(n) AS (
          VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
        ), raw_numbers(n) AS (
          SELECT a.n + b.n * 10 + c.n * 100 + d.n * 1000
          FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d
        ), numbers(n) AS (
          SELECT n FROM raw_numbers WHERE n <= 5000
        )
        INSERT INTO documents
          (collection, id, body, sort_time, created_at, updated_at, identifier,
           identifier_present, srv_created, srv_modified, is_valid, fallback_key, revision)
        SELECT
          'treatments',
          printf('%024x', n + 1),
          json_object(
            '_id', printf('%024x', n + 1),
            'identifier', printf('seed-%d', n),
            'eventType', 'Note',
            'created_at', strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || n || ' seconds'),
            'notes', CASE WHEN n = 0 THEN 'needle' ELSE 'haystack' END
          ),
          n,
          n,
          n,
          printf('seed-%d', n),
          1,
          1000000 + n,
          1000000 + n,
          1,
          NULL,
          1
        FROM numbers
      `, recentBase);
    });

    const response = await SELF.fetch(
      `https://example.test/api/v1/treatments.json?tenant=${name}&find[notes]=needle&count=1`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{
      _id: "000000000000000000000001",
      identifier: "seed-0",
      eventType: "Note",
      created_at: recentBase,
      notes: "needle",
      carbs: null,
      insulin: null,
    }]);

    const literalRegex = await SELF.fetch(
      `https://example.test/api/v1/treatments.json?tenant=${name}`
        + `&find[notes]=${encodeURIComponent("/^needle$/i")}`,
    );
    expect(literalRegex.status).toBe(400);
    expect(await literalRegex.json()).toMatchObject({
      error: {
        code: "invalid_query",
        message: "regex treatments query for find[notes] is not supported by the SQLite adapter",
      },
    });

    const unsupported = await SELF.fetch(
      `https://example.test/api/v1/treatments.json?tenant=${name}&find[notes][$regex]=needle`,
    );
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toEqual({
      error: {
        code: "invalid_query",
        message: "unsupported treatments query operator in find[notes][$regex]",
      },
    });

    const tooMany = Array.from({ length: 98 }, (_, index) => `id-${index}`).join(",");
    const bounded = await SELF.fetch(
      `https://example.test/api/v1/treatments.json?tenant=${name}`
        + `&find[identifier][$in]=${encodeURIComponent(tooMany)}&count=1`,
    );
    expect(bounded.status).toBe(400);
    expect(await bounded.json()).toMatchObject({
      error: { code: "invalid_query", message: expect.stringContaining("100 bound-parameter limit") },
    });

    const oldCreatedAt = "2020-01-01T00:00:00.000Z";
    await writeApi(name, "POST", "/api/v1/treatments/", {
      eventType: "Note",
      created_at: oldCreatedAt,
      notes: "outside-default-window",
    });
    const defaultWindow = await SELF.fetch(
      `https://example.test/api/v1/treatments.json?tenant=${name}`
        + "&find[notes]=outside-default-window",
    );
    expect(await defaultWindow.json()).toEqual([]);
    const explicitWindow = await SELF.fetch(
      `https://example.test/api/v1/treatments.json?tenant=${name}`
        + `&find[created_at][$gte]=${encodeURIComponent(oldCreatedAt)}`
        + "&find[notes]=outside-default-window",
    );
    expect(await explicitWindow.json()).toMatchObject([{
      created_at: oldCreatedAt,
      notes: "outside-default-window",
    }]);
  });

  it("matches the upstream activity create, query, conditional GET, update and delete contract", async () => {
    const name = tenant("activity");
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const createdResponse = await writeApi(name, "POST", "/api/v1/activity/", {
      created_at: createdAt,
      heartrate: 85,
      steps: 1500,
      activitylevel: "moderate",
    });
    expect(createdResponse.status).toBe(200);
    const created = await createdResponse.json<Array<Record<string, unknown>>>();
    expect(created).toMatchObject([
      {
        created_at: createdAt,
        heartrate: 85,
        steps: 1500,
        activitylevel: "moderate",
      },
    ]);
    expect(created[0]?._id).toMatch(/^[0-9a-f]{24}$/);

    const listed = await SELF.fetch(
      `https://example.test/api/v1/activity?tenant=${name}&find[created_at][$gte]=${encodeURIComponent(
        new Date(Date.now() - 120_000).toISOString(),
      )}`,
    );
    expect(listed.status).toBe(200);
    expect(listed.headers.get("Last-Modified")).not.toBeNull();
    expect(await listed.json()).toMatchObject([{ _id: created[0]?._id }]);

    const conditional = await SELF.fetch(
      `https://example.test/api/v1/activity?tenant=${name}`,
      { headers: { "If-Modified-Since": new Date().toUTCString() } },
    );
    expect(conditional.status).toBe(304);

    const updated = { ...created[0], heartrate: 92 };
    const updateResponse = await writeApi(name, "PUT", "/api/v1/activity/", updated);
    expect(await updateResponse.json()).toMatchObject({ _id: created[0]?._id, heartrate: 92 });

    const putCreatedResponse = await writeApi(name, "PUT", "/api/v1/activity/", {
      created_at: new Date(Date.now() - 30_000).toISOString(),
      heartrate: 78,
      steps: 750,
    });
    expect(putCreatedResponse.status).toBe(200);
    const putCreated = await putCreatedResponse.json<Record<string, unknown>>();
    expect(putCreated).toMatchObject({ heartrate: 78, steps: 750 });
    expect(putCreated._id).toMatch(/^[0-9a-f]{24}$/);

    const removed = await writeApi(name, "DELETE", `/api/v1/activity/${created[0]?._id}`);
    expect(await removed.json()).toEqual({});
    const removedPut = await writeApi(name, "DELETE", `/api/v1/activity/${putCreated._id}`);
    expect(await removedPut.json()).toEqual({});
    expect(
      await (
        await SELF.fetch(`https://example.test/api/v1/activity?tenant=${name}`)
      ).json(),
    ).toEqual([]);

    const empty = await writeApi(name, "POST", "/api/v1/activity/", []);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);
  });

  it("serves the public upstream API v3 version envelope with SQLite storage metadata", async () => {
    const response = await SELF.fetch("https://example.test/api/v3/version");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 200,
      result: {
        version: "15.0.7",
        apiVersion: "3.0.3-alpha",
        srvDate: expect.any(Number),
        storage: {
          storage: "sqlite-durable-object",
          version: expect.any(String),
        },
      },
    });
  });

  it("persists admin roles and subjects and authorizes their access tokens", async () => {
    const name = tenant("admin");
    const roleResponse = await writeApi(name, "POST", "/api/v2/authorization/roles", {
      name: "uploader",
      permissions: ["api:entries:create"],
    });
    expect(roleResponse.status).toBe(200);

    const subjectResponse = await writeApi(name, "POST", "/api/v2/authorization/subjects", {
      name: "Phone",
      roles: ["uploader"],
    });
    const createdSubject = await subjectResponse.json<Record<string, unknown>>();
    expect(createdSubject).not.toHaveProperty("accessToken");
    expect(createdSubject).not.toHaveProperty("digest");
    expect(createdSubject).not.toHaveProperty("accessTokenDigest");
    const listedSubjects = await SELF.fetch(
      `https://example.test/api/v2/authorization/subjects?tenant=${name}`,
      { headers: { "api-secret": await secretDigest() } },
    );
    const [subject] = await listedSubjects.json<Array<Record<string, unknown>>>();
    if (subject === undefined) throw new Error("created subject was not listed");
    expect(subject.accessToken).toEqual(expect.any(String));

    const authorized = await SELF.fetch(
      `https://example.test/api/v2/authorization/request/${subject.accessToken}?tenant=${name}`,
    );
    const authorization = await authorized.json<Record<string, unknown>>();
    expect(authorization).toMatchObject({
      token: expect.stringMatching(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
      sub: "Phone",
      permissionGroups: [["api:entries:create"], ["*:*:read"]],
      iat: expect.any(Number),
      exp: expect.any(Number),
    });
    const jwt = String(authorization.token);
    expect(decodeJwtPayload(jwt)).toMatchObject({
      accessToken: subject.accessToken,
      iat: authorization.iat,
      exp: authorization.exp,
    });
    expect(Number(authorization.exp) - Number(authorization.iat)).toBe(8 * 60 * 60);

    const refreshed = await SELF.fetch(
      `https://example.test/api/v2/authorization/request/${encodeURIComponent(jwt)}?tenant=${name}`,
    );
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({
      token: expect.stringMatching(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
      sub: "Phone",
      permissionGroups: [["api:entries:create"], ["*:*:read"]],
    });

    const rejectedIssuance = await SELF.fetch(
      `https://example.test/api/v2/authorization/request/not-a-subject?tenant=${name}`,
    );
    expect(rejectedIssuance.status).toBe(401);
    expect(await rejectedIssuance.json()).toEqual({
      status: 401,
      message: "Unauthorized",
      description: "Invalid/Missing",
    });

    const tokenAuth = await SELF.fetch(
      `https://example.test/api/v1/verifyauth?tenant=${name}&token=${subject.accessToken}`,
    );
    expect(await tokenAuth.json()).toEqual({
      status: 200,
      message: {
        canRead: true,
        canWrite: false,
        isAdmin: false,
        permissions: "ROLE",
        rolefound: "FOUND",
        message: "OK",
      },
    });

    const bearerAuth = await SELF.fetch(
      `https://example.test/api/v1/verifyauth?tenant=${name}`,
      { headers: { Authorization: `Bearer ${jwt}` } },
    );
    expect(await bearerAuth.json()).toEqual({
      status: 200,
      message: {
        canRead: true,
        canWrite: false,
        isAdmin: false,
        permissions: "ROLE",
        rolefound: "FOUND",
        message: "OK",
      },
    });

    const rawBearer = await SELF.fetch(
      `https://example.test/api/v3/status?tenant=${name}`,
      { headers: { Authorization: `Bearer ${subject.accessToken}` } },
    );
    expect(rawBearer.status).toBe(401);

    const missingV3Token = await SELF.fetch(
      `https://example.test/api/v3/status?tenant=${name}`,
    );
    expect(missingV3Token.status).toBe(401);
    expect(await missingV3Token.json()).toEqual({
      status: 401,
      message: "Missing or bad access token or JWT",
    });

    const invalidV3Token = await SELF.fetch(
      `https://example.test/api/v3/status?tenant=${name}`,
      { headers: { Authorization: "Bearer invalid-token" } },
    );
    expect(invalidV3Token.status).toBe(401);
    expect(await invalidV3Token.json()).toEqual({
      status: 401,
      message: "Bad access token or JWT",
    });

    const malformedV3Header = await SELF.fetch(
      `https://example.test/api/v3/status?tenant=${name}`,
      { headers: { Authorization: "Bearer  invalid-token" } },
    );
    expect(await malformedV3Header.json()).toEqual({
      status: 401,
      message: "Missing or bad access token or JWT",
    });

    const status = await SELF.fetch(
      `https://example.test/api/v3/status?tenant=${name}`,
      { headers: { Authorization: `bearer ${jwt}` } },
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      status: 200,
      result: {
        version: "15.0.7",
        apiVersion: "3.0.3-alpha",
        srvDate: expect.any(Number),
        apiPermissions: {
          devicestatus: "r",
          entries: "r",
          food: "r",
          profile: "r",
          settings: "r",
          treatments: "r",
        },
      },
    });

    await evictDurableObject(env.ENTRY_STORE.getByName(name));
    expect(
      (
        await SELF.fetch(`https://example.test/api/v3/status?tenant=${name}`, {
          headers: { Authorization: `Bearer ${jwt}` },
        })
      ).status,
    ).toBe(200);

    const otherTenant = tenant("admin-other");
    expect(
      (
        await SELF.fetch(`https://example.test/api/v3/status?tenant=${otherTenant}`, {
          headers: { Authorization: `Bearer ${jwt}` },
        })
      ).status,
    ).toBe(401);

    const jwtWrite = await SELF.fetch(
      `https://example.test/api/v1/entries?tenant=${name}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(entry(144, Date.now() - 120_000)),
      },
    );
    expect(jwtWrite.status).toBe(200);

    const opaqueTokenWrite = await SELF.fetch(
      `https://example.test/api/v1/entries?tenant=${name}`,
      {
        method: "POST",
        headers: {
          "api-secret": String(subject.accessToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(entry(145, Date.now() - 60_000)),
      },
    );
    expect(opaqueTokenWrite.status).toBe(200);

    const deleted = await writeApi(
      name,
      "DELETE",
      `/api/v2/authorization/subjects/${String(subject._id)}`,
    );
    expect(deleted.status).toBe(200);
    expect(
      (
        await SELF.fetch(`https://example.test/api/v3/status?tenant=${name}`, {
          headers: { Authorization: `Bearer ${jwt}` },
        })
      ).status,
    ).toBe(401);
  });

  it("writes an object or array and preserves upstream empty-rejection success", async () => {
    const name = tenant("write");
    const base = Date.now() - 10 * 60_000;
    const first = await post(name, entry(111, base));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject([{
      _id: expect.stringMatching(/^[0-9a-f]{24}$/),
      sgv: 111,
      date: base,
      sysTime: new Date(base).toISOString(),
      utcOffset: 0,
    }]);

    const batch = await post(name, [entry(122, base + 300_000), entry(133, base + 600_000)], "/api/v1/entries.json");
    expect(batch.status).toBe(200);
    expect((await batch.json<PublicEntry[]>()).map((row) => row.sgv)).toEqual([122, 133]);

    const history = await SELF.fetch(`https://example.test/api/v1/entries.json?tenant=${name}&count=10`);
    const rows = await history.json<PublicEntry[]>();
    expect(rows.map((row) => row.sgv)).toEqual([133, 122, 111]);
    expect(rows[0]).toMatchObject({ direction: "Flat", device: "simulator", type: "sgv" });
  });

  it("is idempotent by normalized timestamp and type", async () => {
    const name = tenant("dedupe");
    const date = Date.now() - 60_000;
    const first = await post(name, entry(140, date));
    const retry = await post(name, entry(140, date));
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);

    const rows = await (
      await SELF.fetch(`https://example.test/api/v1/entries.json?tenant=${name}&count=10`)
    ).json<PublicEntry[]>();
    expect(rows).toHaveLength(1);
  });

  it("supports current plus count and Nightscout date-range operators", async () => {
    const name = tenant("range");
    const base = Date.now() - 30 * 60_000;
    await post(name, [entry(100, base), entry(110, base + 300_000), entry(120, base + 600_000)]);

    const current = await (
      await SELF.fetch(`https://example.test/api/v1/entries/current.json?tenant=${name}`)
    ).json<PublicEntry[]>();
    expect(current.map((row) => row.sgv)).toEqual([120]);

    const query = new URLSearchParams({
      tenant: name,
      count: "1",
      "find[date][$gte]": String(base + 300_000),
      "find[date][$lte]": String(base + 600_000),
    });
    const filtered = await (
      await SELF.fetch(`https://example.test/api/v1/entries.json?${query.toString()}`)
    ).json<PublicEntry[]>();
    expect(filtered.map((row) => row.sgv)).toEqual([120]);
  });

  it("isolates tenants into separate Durable Object SQLite databases", async () => {
    const alpha = tenant("alpha");
    const beta = tenant("beta");
    const date = Date.now() - 60_000;
    await post(alpha, entry(101, date));
    await post(beta, entry(202, date));

    const alphaRows = await (
      await SELF.fetch(`https://example.test/api/v1/entries.json?tenant=${alpha}`)
    ).json<PublicEntry[]>();
    const betaRows = await (
      await SELF.fetch(`https://example.test/api/v1/entries.json?tenant=${beta}`)
    ).json<PublicEntry[]>();
    expect(alphaRows.map((row) => row.sgv)).toEqual([101]);
    expect(betaRows.map((row) => row.sgv)).toEqual([202]);
  });

  it("persists SQLite rows across Durable Object eviction", async () => {
    const name = tenant("persist");
    await post(name, entry(155, Date.now() - 60_000));
    const stub = env.ENTRY_STORE.getByName(name);

    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      const count = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM entries").one().count;
      expect(count).toBe(1);
      expect(state.storage.sql.databaseSize).toBeGreaterThan(0);
    });

    await evictDurableObject(stub);
    const rows = await (
      await SELF.fetch(`https://example.test/api/v1/entries.json?tenant=${name}`)
    ).json<PublicEntry[]>();
    expect(rows.map((row) => row.sgv)).toEqual([155]);
  });

  it("accepts upstream SGV values while rejecting malformed JSON, query and tenant input", async () => {
    const name = tenant("invalid");
    expect((await post(name, entry(10, Date.now()))).status).toBe(200);
    const ignoredSingleWithoutDate = await post(name, { sgv: 100 });
    expect(ignoredSingleWithoutDate.status).toBe(200);
    expect(await ignoredSingleWithoutDate.json()).toEqual([]);

    const malformed = await SELF.fetch(`https://example.test/api/v1/entries?tenant=${name}`, {
      method: "POST",
      headers: { "api-secret": await secretDigest() },
      body: "{",
    });
    expect(malformed.status).toBe(400);

    const badCount = await SELF.fetch(`https://example.test/api/v1/entries.json?tenant=${name}&count=10001`);
    expect(badCount.status).toBe(400);

    const badTenant = await SELF.fetch("https://example.test/api/v1/entries.json?tenant=Not%20Safe");
    expect(badTenant.status).toBe(400);
  });

  it("requires a hashed Nightscout API_SECRET and fails closed when it is absent", async () => {
    const name = tenant("auth");
    const target = `https://example.test/api/v1/entries?tenant=${name}`;
    const body = JSON.stringify(entry(123, Date.now() - 60_000));

    expect((await SELF.fetch(target, { method: "POST", body })).status).toBe(401);
    expect(
      (await SELF.fetch(target, { method: "POST", headers: { "api-secret": TEST_API_SECRET }, body })).status,
    ).toBe(401);
    expect(
      (await SELF.fetch(target, { method: "POST", headers: { "api-secret": "0".repeat(40) }, body })).status,
    ).toBe(401);
    expect(
      (await SELF.fetch(`${target}&secret=${await secretDigest("SHA-512")}`, { method: "POST", body })).status,
    ).toBe(200);

    const missingBinding = await worker.fetch(
      new Request(target, { method: "POST", body }),
      {} as Env,
    );
    expect(missingBinding.status).toBe(503);
    expect(await missingBinding.json()).toMatchObject({ error: { code: "api_secret_not_configured" } });
  });

  it("accepts a configured API_SECRET", async () => {
    const configuredEnv = {
      ASSETS: env.ASSETS,
      ENTRY_STORE: env.ENTRY_STORE,
      DEXCOM_SHARE_CONNECTOR: env.DEXCOM_SHARE_CONNECTOR,
      API_SECRET: TEST_API_SECRET,
    };
    expect((await worker.fetch(
      new Request("https://example.test/healthz"),
      configuredEnv,
    )).status).toBe(200);
  });

  it("rejects a too-short deployment password before Nightscout starts", async () => {
    const shortSecret = "too-short";
    const response = await worker.fetch(
      new Request("https://example.test/healthz"),
      {
        ASSETS: env.ASSETS,
        ENTRY_STORE: env.ENTRY_STORE,
        DEXCOM_SHARE_CONNECTOR: env.DEXCOM_SHARE_CONNECTOR,
        API_SECRET: shortSecret,
      },
    );
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("at least 12 characters");
    expect(body).not.toContain(shortSecret);
  });
});

describe("upstream Shiro permission adapter", () => {
  it("preserves implicit suffixes, wildcard segments, and comma branches", () => {
    expect(permissionGroupsAllow([["api:entries"]], "api:entries:create")).toBe(true);
    expect(
      permissionGroupsAllow(
        [["api:food,treatments:create"]],
        "api:treatments:create",
      ),
    ).toBe(true);
    expect(
      permissionGroupsAllow(
        [["api:*:create,update,delete"]],
        "api:entries:update",
      ),
    ).toBe(true);
    expect(
      permissionGroupsAllow(
        [["api:*:create,update,delete"]],
        "api:entries:read",
      ),
    ).toBe(false);
    expect(
      permissionGroupsAllow(
        [["newsletter:view,create,edit,delete"]],
        "newsletter:view,create,any,edit,delete",
      ),
    ).toBe(false);
  });
});

describe("tenant JWT adapter", () => {
  it("signs HS256 claims and rejects tampering and expiration", async () => {
    const secret = createJwtSecret();
    const issued = await issueJwt(secret, "subject-access-token", 1_000_000);
    expect(await verifyJwt(secret, issued.token, 1_000_001)).toEqual({
      accessToken: "subject-access-token",
      iat: 1_000_000,
      exp: 1_000_000 + 8 * 60 * 60,
    });

    const [header, payload, signature] = issued.token.split(".");
    expect(header).toBeDefined();
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();
    const tamperedSignature = `${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
    expect(
      await verifyJwt(secret, `${header}.${payload}.${tamperedSignature}`, 1_000_001),
    ).toBeNull();
    expect(await verifyJwt(secret, issued.token, issued.exp)).toBeNull();
    expect(await verifyJwt(createJwtSecret(), issued.token, 1_000_001)).toBeNull();
  });
});
