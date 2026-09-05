import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import {
  CLOUDFLARE_FREE_SQLITE_DO_MAX_MIB,
  nightscoutStatus,
  nightscoutWebsocketStatus,
  normalizeConfiguredDisplayUnits,
  normalizePlatformAuthFailDelay,
  normalizeProfileUnits,
  tenantStatusSettings,
} from "../src/status";

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

async function saveProfile(tenantName: string, profile: Record<string, unknown>): Promise<void> {
  const response = await SELF.fetch(
    `https://example.test/api/v1/profile?tenant=${tenantName}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "api-secret": await secretDigest(),
      },
      body: JSON.stringify(profile),
    },
  );
  expect(response.status).toBe(200);
}

interface StatusSubject {
  name: string;
  accessToken: string;
}

async function createStatusSubject(
  tenantName: string,
  name: string,
): Promise<StatusSubject> {
  const store = env.ENTRY_STORE.getByName(tenantName);
  await store.createDocuments("subjects", JSON.stringify([{ name, roles: ["readable"] }]));
  const subjects = JSON.parse(await store.listDocuments("subjects")) as StatusSubject[];
  const subject = subjects.find((candidate) => candidate.name === name);
  if (subject === undefined) throw new Error("status subject was not created");
  return subject;
}

async function issueStatusJwt(tenantName: string, accessToken: string): Promise<string> {
  const issued = JSON.parse(
    await env.ENTRY_STORE.getByName(tenantName).issueAccessJwt(accessToken),
  ) as { token: string };
  return issued.token;
}

function finalhandlerBody(method: string, pathname: string): string {
  return "<!DOCTYPE html>\n"
    + '<html lang="en">\n'
    + "<head>\n"
    + '<meta charset="utf-8">\n'
    + "<title>Error</title>\n"
    + "</head>\n"
    + "<body>\n"
    + `<pre>Cannot ${method} ${pathname}</pre>\n`
    + "</body>\n"
    + "</html>\n";
}

async function expectNotAcceptable(
  href: string,
  method: "GET" | "HEAD",
  accept?: string,
): Promise<void> {
  const response = await SELF.fetch(href, {
    method,
    ...(accept === undefined ? {} : { headers: { Accept: accept } }),
  });
  expect(response.status).toBe(406);
  expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("Vary")).toBe("Accept");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  if (method === "HEAD") {
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(await response.text()).toBe("");
  } else {
    const body = await response.text();
    expect(body).toMatch(/^Error: Not Acceptable\n/);
    expect(body.split("\n").length).toBeGreaterThan(1);
    expect(response.headers.get("Content-Length")).toBe(
      String(new TextEncoder().encode(body).byteLength),
    );
  }
}

function settingsOf(status: Record<string, unknown>): Record<string, unknown> {
  return status.settings as Record<string, unknown>;
}

describe("locked Nightscout status settings", () => {
  it("matches the v15.0.7 filtered default settings instead of a downstream approximation", () => {
    const status = nightscoutStatus(new Date(0));
    const settings = settingsOf(status);
    expect(settings).toEqual({
      units: "mg/dl",
      timeFormat: 12,
      dayStart: 7,
      dayEnd: 21,
      nightMode: false,
      editMode: true,
      showRawbg: "never",
      customTitle: "Nightscout",
      theme: "default",
      alarmUrgentHigh: true,
      alarmUrgentHighMins: [30, 60, 90, 120],
      alarmHigh: true,
      alarmHighMins: [30, 60, 90, 120],
      alarmLow: true,
      alarmLowMins: [15, 30, 45, 60],
      alarmUrgentLow: true,
      alarmUrgentLowMins: [15, 30, 45],
      alarmUrgentMins: [30, 60, 90, 120],
      alarmWarnMins: [30, 60, 90, 120],
      alarmTimeagoWarn: true,
      alarmTimeagoWarnMins: 15,
      alarmTimeagoUrgent: true,
      alarmTimeagoUrgentMins: 30,
      alarmPumpBatteryLow: false,
      language: "en",
      scaleY: "log",
      showPlugins: "dbsize delta direction upbat",
      showForecast: "ar2",
      focusHours: 3,
      heartbeat: 60,
      baseURL: "",
      authDefaultRoles: "readable",
      thresholds: {
        bgHigh: 260,
        bgTargetTop: 180,
        bgTargetBottom: 80,
        bgLow: 55,
      },
      insecureUseHttp: false,
      secureHstsHeader: true,
      secureHstsHeaderIncludeSubdomains: false,
      secureHstsHeaderPreload: false,
      secureCsp: false,
      deNormalizeDates: false,
      showClockDelta: false,
      showClockLastTime: false,
      frameUrl1: "",
      frameUrl2: "",
      frameUrl3: "",
      frameUrl4: "",
      frameUrl5: "",
      frameUrl6: "",
      frameUrl7: "",
      frameUrl8: "",
      frameName1: "",
      frameName2: "",
      frameName3: "",
      frameName4: "",
      frameName5: "",
      frameName6: "",
      frameName7: "",
      frameName8: "",
      authFailDelay: 5000,
      adminNotifiesEnabled: true,
      authenticationPromptOnLoad: false,
      DEFAULT_FEATURES: [
        "bgnow",
        "delta",
        "direction",
        "timeago",
        "devicestatus",
        "upbat",
        "errorcodes",
        "profile",
        "bolus",
        "dbsize",
        "runtimestate",
        "basal",
        "careportal",
      ],
      alarmTypes: ["predict"],
      enable: [
        "bgnow",
        "delta",
        "direction",
        "timeago",
        "devicestatus",
        "upbat",
        "errorcodes",
        "profile",
        "bolus",
        "dbsize",
        "runtimestate",
        "basal",
        "careportal",
        "ar2",
      ],
    });
    expect(status.authorized).toBeNull();
    expect(Object.keys(status)).toEqual([
      "status",
      "name",
      "version",
      "serverTime",
      "serverTimeEpoch",
      "apiEnabled",
      "careportalEnabled",
      "boluscalcEnabled",
      "settings",
      "extendedSettings",
      "authorized",
      "runtimeState",
    ]);
  });

  it("normalizes configured and persisted unit spellings without guessing unknown profile data", () => {
    expect(normalizeConfiguredDisplayUnits("mmol/L")).toBe("mmol");
    expect(normalizeConfiguredDisplayUnits("MG/DL")).toBe("mg/dl");
    expect(normalizeConfiguredDisplayUnits("unexpected")).toBe("mg/dl");
    expect(normalizeProfileUnits("mmol / L")).toBe("mmol");
    expect(normalizeProfileUnits("mgdl")).toBe("mg/dl");
    expect(normalizeProfileUnits("notmmol")).toBeNull();
    expect(normalizeProfileUnits("unexpected")).toBeNull();
  });

  it("reports the bounded platform auth delay actually enforced", () => {
    expect(normalizePlatformAuthFailDelay(undefined)).toBe(5000);
    expect(normalizePlatformAuthFailDelay("  ")).toBe(5000);
    expect(normalizePlatformAuthFailDelay("-1")).toBe(0);
    expect(normalizePlatformAuthFailDelay("60001")).toBe(60_000);
    expect(normalizePlatformAuthFailDelay("not-a-number")).toBe(5000);
  });
});

describe("tenant status configuration sources", () => {
  it("passes the official LANGUAGE setting to browser and socket status", () => {
    const overrides = tenantStatusSettings({ LANGUAGE: "zh_tw" });
    expect(settingsOf(nightscoutStatus(new Date(0), "readable", overrides)).language)
      .toBe("zh_tw");
    expect(settingsOf(nightscoutWebsocketStatus(
      new Date(0),
      undefined,
      "readable",
      overrides,
    )).language).toBe("zh_tw");
  });

  it("passes the official browser defaults to HTTP and socket status", () => {
    const overrides = tenantStatusSettings({
      TIME_FORMAT: "24",
      NIGHT_MODE: "on",
      SHOW_RAWBG: "noise",
      CUSTOM_TITLE: "My Nightscout",
      THEME: "colorblindfriendly",
      SCALE_Y: "linear",
      EDIT_MODE: "off",
    });
    const expected = {
      timeFormat: 24,
      nightMode: true,
      showRawbg: "noise",
      customTitle: "My Nightscout",
      theme: "colorblindfriendly",
      scaleY: "linear",
      editMode: false,
    };
    expect(settingsOf(nightscoutStatus(new Date(0), "readable", overrides)))
      .toMatchObject(expected);
    expect(settingsOf(nightscoutWebsocketStatus(
      new Date(0),
      undefined,
      "readable",
      overrides,
    ))).toMatchObject(expected);
  });

  it("maps the official alarm controls and snooze choices without changing defaults", () => {
    const overrides = tenantStatusSettings({
      ALARM_URGENT_HIGH: "off",
      ALARM_URGENT_HIGH_MINS: "10 20",
      ALARM_HIGH: "on",
      ALARM_HIGH_MINS: "25 50",
      ALARM_LOW: "false",
      ALARM_LOW_MINS: "5 15",
      ALARM_URGENT_LOW: "true",
      ALARM_URGENT_LOW_MINS: "7 14",
      ALARM_URGENT_MINS: "12 24",
      ALARM_WARN_MINS: "18 36",
    });
    const expected = {
      alarmUrgentHigh: false,
      alarmUrgentHighMins: [10, 20],
      alarmHigh: true,
      alarmHighMins: [25, 50],
      alarmLow: false,
      alarmLowMins: [5, 15],
      alarmUrgentLow: true,
      alarmUrgentLowMins: [7, 14],
      alarmUrgentMins: [12, 24],
      alarmWarnMins: [18, 36],
    };
    expect(settingsOf(nightscoutStatus(new Date(0), "readable", overrides)))
      .toMatchObject(expected);
    expect(settingsOf(nightscoutWebsocketStatus(
      new Date(0),
      undefined,
      "readable",
      overrides,
    ))).toMatchObject(expected);
  });

  it("maps focus, Clock and all eight Split View defaults to HTTP and socket status", () => {
    const overrides = tenantStatusSettings({
      FOCUS_HOURS: "6",
      SHOW_CLOCK_DELTA: "true",
      SHOW_CLOCK_LAST_TIME: "off",
      FRAME_URL_1: "https://one.example",
      FRAME_URL_2: "https://two.example",
      FRAME_URL_3: "https://three.example",
      FRAME_URL_4: "https://four.example",
      FRAME_URL_5: "https://five.example",
      FRAME_URL_6: "https://six.example",
      FRAME_URL_7: "https://seven.example",
      FRAME_URL_8: "https://eight.example",
      FRAME_NAME_1: "One",
      FRAME_NAME_2: "Two",
      FRAME_NAME_3: "Three",
      FRAME_NAME_4: "Four",
      FRAME_NAME_5: "Five",
      FRAME_NAME_6: "Six",
      FRAME_NAME_7: "Seven",
      FRAME_NAME_8: "Eight",
    });
    const expected = {
      // Locked v15.0.7 does not number-map FOCUS_HOURS.
      focusHours: "6",
      showClockDelta: true,
      showClockLastTime: false,
      frameUrl1: "https://one.example",
      frameUrl2: "https://two.example",
      frameUrl3: "https://three.example",
      frameUrl4: "https://four.example",
      frameUrl5: "https://five.example",
      frameUrl6: "https://six.example",
      frameUrl7: "https://seven.example",
      frameUrl8: "https://eight.example",
      frameName1: "One",
      frameName2: "Two",
      frameName3: "Three",
      frameName4: "Four",
      frameName5: "Five",
      frameName6: "Six",
      frameName7: "Seven",
      frameName8: "Eight",
    };
    expect(settingsOf(nightscoutStatus(new Date(0), "readable", overrides)))
      .toMatchObject(expected);
    expect(settingsOf(nightscoutWebsocketStatus(
      new Date(0),
      undefined,
      "readable",
      overrides,
    ))).toMatchObject(expected);
  });

  it("maps display-only Basal, Bolus and Profile plugin preferences", () => {
    const configured = tenantStatusSettings({
      BASAL_RENDER: "icicle",
      BOLUS_RENDER_OVER: "0.5",
      BOLUS_RENDER_FORMAT: "concise",
      BOLUS_RENDER_FORMAT_SMALL: "minimal",
      PROFILE_HISTORY: "on",
      PROFILE_MULTIPLE: "false",
    });
    expect(configured.extendedSettings).toMatchObject({
      basal: { render: "icicle" },
      bolus: {
        renderOver: 0.5,
        renderFormat: "concise",
        renderFormatSmall: "minimal",
      },
      profile: {
        history: true,
        multiple: false,
      },
    });
    expect(nightscoutWebsocketStatus(
      new Date(0),
      undefined,
      "readable",
      configured,
    ).extendedSettings).toEqual(configured.extendedSettings);

    const disabled = tenantStatusSettings({
      DISABLE: "basal bolus profile",
      BASAL_RENDER: "icicle",
      BOLUS_RENDER_OVER: "0.5",
      PROFILE_HISTORY: "on",
    });
    expect(disabled.extendedSettings).not.toHaveProperty("basal");
    expect(disabled.extendedSettings).not.toHaveProperty("bolus");
    expect(disabled.extendedSettings).not.toHaveProperty("profile");
  });

  it("defaults and maps DEVICESTATUS_ADVANCED without changing its data window", () => {
    const defaults = tenantStatusSettings({});
    expect(defaults.extendedSettings).toMatchObject({
      devicestatus: { advanced: true, days: 1 },
    });

    const configured = tenantStatusSettings({ DEVICESTATUS_ADVANCED: "off" });
    expect(configured.extendedSettings).toMatchObject({
      devicestatus: { advanced: false, days: 1 },
    });
    expect(nightscoutWebsocketStatus(
      new Date(0),
      undefined,
      "readable",
      configured,
    ).extendedSettings).toEqual(configured.extendedSettings);
  });

  it("passes the official plugin display defaults to browser and socket status", () => {
    const overrides = tenantStatusSettings({
      SHOW_PLUGINS: "openaps pump iob cob",
      SHOW_FORECAST: "openaps",
    });
    const expected = {
      showPlugins: "openaps pump iob cob delta direction upbat",
      showForecast: "openaps",
    };
    expect(settingsOf(nightscoutStatus(new Date(0), "readable", overrides)))
      .toMatchObject(expected);
    expect(settingsOf(nightscoutWebsocketStatus(
      new Date(0),
      undefined,
      "readable",
      overrides,
    ))).toMatchObject(expected);
  });

  it("uses the current profile units when DISPLAY_UNITS is absent across v1 and v2", async () => {
    const name = tenant("status-profile-units");
    await saveProfile(name, {
      defaultProfile: "Default",
      startDate: new Date().toISOString(),
      units: "mmol/L",
      store: { Default: { units: "mg/dl", timezone: "UTC", dia: 3 } },
    });

    for (const version of ["v1", "v2"] as const) {
      const response = await SELF.fetch(
        `https://example.test/api/${version}/status.json?tenant=${name}`,
      );
      expect(response.status).toBe(200);
      const status = await response.json<Record<string, unknown>>();
      expect(settingsOf(status)).toMatchObject({
        units: "mmol",
        authDefaultRoles: "readable",
        authFailDelay: 1,
      });
    }

    const script = await SELF.fetch(
      `https://example.test/api/v2/status.js?tenant=${name}`,
    );
    expect(await script.text()).toContain('"units":"mmol"');
  });

  it("falls back to the selected store profile units and keeps tenants isolated", async () => {
    const mmolTenant = tenant("status-nested-profile");
    const emptyTenant = tenant("status-empty-profile");
    await saveProfile(mmolTenant, {
      defaultProfile: "Child",
      startDate: new Date().toISOString(),
      store: {
        Default: { units: "mg/dl" },
        Child: { units: "MMOL/L", timezone: "Europe/London" },
      },
    });

    const mmol = await (
      await SELF.fetch(`https://example.test/api/v1/status.json?tenant=${mmolTenant}`)
    ).json<Record<string, unknown>>();
    const empty = await (
      await SELF.fetch(`https://example.test/api/v1/status.json?tenant=${emptyTenant}`)
    ).json<Record<string, unknown>>();
    expect(settingsOf(mmol).units).toBe("mmol");
    expect(settingsOf(empty).units).toBe("mg/dl");
  });

  it("gives DISPLAY_UNITS precedence and applies locked configured-threshold semantics", () => {
    const profile = {
      defaultProfile: "Default",
      startDate: new Date().toISOString(),
      units: "mg/dl",
      store: { Default: { units: "mg/dl" } },
    };
    const overrides = tenantStatusSettings({
      DISPLAY_UNITS: "mmol/L",
      AUTH_FAIL_DELAY: "7",
      BG_HIGH: "14",
      BG_TARGET_TOP: "10",
      BG_TARGET_BOTTOM: "4,4",
      BG_LOW: "3",
    }, profile);
    const status = JSON.parse(JSON.stringify(
      nightscoutStatus(new Date(0), "readable", overrides),
    )) as Record<string, unknown>;
    expect(settingsOf(status)).toMatchObject({
      units: "mmol",
      authFailDelay: 7,
      thresholds: {
        bgHigh: 252,
        bgTargetTop: 180,
        bgTargetBottom: 79,
        bgLow: 54,
      },
      alarmTypes: ["simple"],
    });
    expect(settingsOf(status).enable).toContain("simplealarms");
    expect(settingsOf(status).enable).not.toContain("ar2");
    expect(settingsOf(nightscoutWebsocketStatus(
      new Date(0),
      undefined,
      "readable",
      overrides,
    ))).toEqual(settingsOf(status));

    const invalid = JSON.parse(JSON.stringify(nightscoutStatus(
      new Date(0),
      "readable",
      tenantStatusSettings({ BG_HIGH: "not-a-number" }, profile),
    ))) as Record<string, unknown>;
    expect(settingsOf(invalid)).toMatchObject({
      thresholds: { bgHigh: null },
      alarmTypes: ["simple"],
    });

    const empty = nightscoutStatus(
      new Date(0),
      "readable",
      tenantStatusSettings({ BG_HIGH: "  " }, profile),
    );
    expect(settingsOf(empty).thresholds).toEqual({
      bgHigh: 260,
      bgTargetTop: 180,
      bgTargetBottom: 80,
      bgLow: 55,
    });
    expect(settingsOf(empty).alarmTypes).toEqual(["predict"]);
  });

  it("maps the Workers Free SQLite quota and upstream DBSIZE settings", () => {
    const defaults = tenantStatusSettings({});
    expect(defaults.extendedSettings).toEqual({
      dbsize: { max: CLOUDFLARE_FREE_SQLITE_DO_MAX_MIB },
      devicestatus: { advanced: true, days: 1 },
    });

    const configured = tenantStatusSettings({
      DBSIZE_MAX: "800",
      DBSIZE_WARN_PERCENTAGE: "55",
      DBSIZE_URGENT_PERCENTAGE: "70",
      DBSIZE_ENABLE_ALERTS: "true",
      DBSIZE_IN_MIB: "off",
    });
    expect(configured.extendedSettings).toEqual({
      dbsize: {
        max: 800,
        warnPercentage: 55,
        urgentPercentage: 70,
        enableAlerts: true,
        inMib: false,
      },
      devicestatus: { advanced: true, days: 1 },
    });
    expect(nightscoutWebsocketStatus(
      new Date(0),
      undefined,
      "readable",
      configured,
    ).extendedSettings).toEqual(configured.extendedSettings);
  });

  it("maps the three official Uploader Battery alert settings", () => {
    const configured = tenantStatusSettings({
      UPBAT_WARN: "42",
      UPBAT_URGENT: "17",
      UPBAT_ENABLE_ALERTS: "true",
    });
    expect(configured.extendedSettings).toMatchObject({
      upbat: {
        warn: 42,
        urgent: 17,
        enableAlerts: true,
      },
    });
    expect(nightscoutWebsocketStatus(
      new Date(0),
      undefined,
      "readable",
      configured,
    ).extendedSettings).toEqual(configured.extendedSettings);
  });
});

describe("v1/v2 status representations", () => {
  it("contains a status RPC failure behind the generic Worker error envelope", async () => {
    const marker = "private-status-rpc-detail";
    const fakeStub = {
      authorizationDelay: async () => 0,
      listDocuments: async () => "[]",
      nightscoutHttpStatus: async () => {
        throw new Error(marker);
      },
    };
    const fakeNamespace = {
      getByName: () => fakeStub,
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await worker.fetch(
        new Request("https://example.test/api/v1/status.json?tenant=status-rpc-failure"),
        {
          ASSETS: env.ASSETS,
          ENTRY_STORE: fakeNamespace,
          API_SECRET: TEST_API_SECRET,
          AUTH_DEFAULT_ROLES: "readable",
          AUTH_FAIL_DELAY: "0",
        } as unknown as Parameters<typeof worker.fetch>[1],
      );
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toBe(
        JSON.stringify({ error: { code: "internal_error", message: "Internal server error" } }),
      );
      expect(body).not.toContain(marker);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("reports an exhausted SQLite DO write quota as a retryable 503", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-25T23:59:30.000Z");
    const fakeStub = {
      authorizationDelay: async () => 0,
      listDocuments: async () => "[]",
      nightscoutHttpStatus: async () => {
        throw new Error(
          "Exceeded allowed rows written in Durable Objects free tier.",
        );
      },
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await worker.fetch(
        new Request("https://example.test/api/v1/status.json?tenant=status-quota"),
        {
          ASSETS: env.ASSETS,
          ENTRY_STORE: { getByName: () => fakeStub },
          API_SECRET: TEST_API_SECRET,
          AUTH_DEFAULT_ROLES: "readable",
          AUTH_FAIL_DELAY: "0",
        } as unknown as Parameters<typeof worker.fetch>[1],
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("30");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = await response.text();
      expect(body).toBe(JSON.stringify({
        error: {
          code: "storage_write_quota_exceeded",
          message: "Storage writes are temporarily unavailable until the next daily reset",
        },
      }));
      expect(body).not.toContain("Durable Objects free tier");
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      vi.useRealTimers();
    }
  });

  it("reports an exhausted SQLite DO read quota as a retryable 503", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-25T23:59:30.000Z");
    const fakeStub = {
      authorizationDelay: async () => 0,
      listDocuments: async () => "[]",
      nightscoutHttpStatus: async () => {
        throw new Error(
          "Exceeded allowed rows read in Durable Objects free tier.",
        );
      },
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await worker.fetch(
        new Request("https://example.test/api/v1/status.json?tenant=status-quota"),
        {
          ASSETS: env.ASSETS,
          ENTRY_STORE: { getByName: () => fakeStub },
          API_SECRET: TEST_API_SECRET,
          AUTH_DEFAULT_ROLES: "readable",
          AUTH_FAIL_DELAY: "0",
        } as unknown as Parameters<typeof worker.fetch>[1],
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("30");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = await response.text();
      expect(body).toBe(JSON.stringify({
        error: {
          code: "storage_read_quota_exceeded",
          message: "Storage reads are temporarily unavailable until the next daily reset",
        },
      }));
      expect(body).not.toContain("Durable Objects free tier");
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not turn an exhausted Entries upload into a legacy Mongo 500", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-25T23:59:30.000Z");
    const fakeStub = {
      authorizationDelay: async () => 0,
      authorizationSucceeded: async () => undefined,
      putEntriesJson: async () => {
        throw new Error(
          "Exceeded allowed rows written in Durable Objects free tier.",
        );
      },
    };
    try {
      const response = await worker.fetch(
        new Request("https://example.test/api/v1/entries.json?tenant=entries-quota", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "api-secret": await secretDigest(),
          },
          body: JSON.stringify({
            type: "sgv",
            sgv: 123,
            date: Date.now(),
            dateString: new Date().toISOString(),
            direction: "Flat",
            device: "quota-contract",
          }),
        }),
        {
          ASSETS: env.ASSETS,
          ENTRY_STORE: { getByName: () => fakeStub },
          API_SECRET: TEST_API_SECRET,
          AUTH_DEFAULT_ROLES: "readable",
          AUTH_FAIL_DELAY: "0",
        } as unknown as Parameters<typeof worker.fetch>[1],
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("30");
      expect(await response.json()).toEqual({
        error: {
          code: "storage_write_quota_exceeded",
          message: "Storage writes are temporarily unavailable until the next daily reset",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("derives authorized only from query token, then query secret", async () => {
    const tenantName = tenant("status-query-auth");
    const bearerSubject = await createStatusSubject(tenantName, "Bearer Viewer");
    const querySubject = await createStatusSubject(tenantName, "Query Viewer");
    const bearerJwt = await issueStatusJwt(tenantName, bearerSubject.accessToken);
    const queryJwt = await issueStatusJwt(tenantName, querySubject.accessToken);

    async function authorized(
      configure: (url: URL) => void = () => undefined,
      headers: HeadersInit = {},
    ): Promise<unknown> {
      const url = new URL("https://example.test/api/v1/status.json");
      url.searchParams.set("tenant", tenantName);
      configure(url);
      const response = await SELF.fetch(url, { headers });
      expect(response.status).toBe(200);
      return (await response.json<Record<string, unknown>>()).authorized;
    }

    expect(await authorized(
      undefined,
      { Authorization: `Bearer ${bearerJwt}` },
    )).toBeNull();
    expect(await authorized(
      undefined,
      { "api-secret": await secretDigest() },
    )).toBeNull();
    expect(await authorized((url) => {
      url.searchParams.set("secret", querySubject.accessToken);
    })).toMatchObject({ sub: "Query Viewer" });
    expect(await authorized((url) => {
      url.searchParams.set("token", queryJwt);
    })).toMatchObject({ sub: "Query Viewer" });
    expect(await authorized((url) => {
      url.searchParams.append("token", "invalid-presented-first");
      url.searchParams.append("token", querySubject.accessToken);
    })).toMatchObject({ sub: "Query Viewer" });
    expect(await authorized((url) => {
      url.searchParams.append("token[]", querySubject.accessToken);
    })).toMatchObject({ sub: "Query Viewer" });
    const bracketUrl = new URL("https://example.test/api/v1/status.json");
    bracketUrl.searchParams.set("tenant", tenantName);
    bracketUrl.searchParams.append("token[]", "invalid-presented-first");
    bracketUrl.searchParams.append("token[]", querySubject.accessToken);
    const bracketResponse = await worker.fetch(
      new Request(bracketUrl),
      {
        ASSETS: env.ASSETS,
        ENTRY_STORE: env.ENTRY_STORE,
        API_SECRET: TEST_API_SECRET,
        AUTH_DEFAULT_ROLES: "denied",
        AUTH_FAIL_DELAY: "0",
      } as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(bracketResponse.status).toBe(200);
    expect((await bracketResponse.json<Record<string, unknown>>()).authorized)
      .toMatchObject({ sub: "Query Viewer" });
    const apiSecret = await secretDigest();
    expect(await authorized((url) => {
      url.searchParams.set("token", querySubject.accessToken);
      url.searchParams.set("secret", bearerSubject.accessToken);
    }, { Authorization: `Bearer ${bearerJwt}` })).toMatchObject({ sub: "Query Viewer" });
    expect(await authorized((url) => {
      url.searchParams.set("secret", apiSecret);
    })).toBeNull();
    expect(await authorized((url) => {
      url.searchParams.append("token[]", "invalid-presented-first");
      url.searchParams.set("secret", querySubject.accessToken);
    })).toBeNull();
  });

  it("serves the locked explicit representations through both inherited mounts", async () => {
    for (const version of ["v1", "v2"] as const) {
      const html = await SELF.fetch(`https://example.test/api/${version}/status.html`);
      expect(html.status).toBe(200);
      expect(html.headers.get("Content-Type")).toMatch(/^text\/html/);
      expect(html.headers.get("Vary")).toBe("Accept");
      expect(Number(html.headers.get("Content-Length"))).toBe(
        new TextEncoder().encode("<h1>STATUS OK</h1>").byteLength,
      );
      expect(await html.text()).toBe("<h1>STATUS OK</h1>");

      const text = await SELF.fetch(`https://example.test/api/${version}/status.txt`);
      expect(text.status).toBe(200);
      expect(text.headers.get("Content-Type")).toMatch(/^text\/plain/);
      expect(await text.text()).toBe("STATUS OK");

      for (const extension of ["png", "svg"] as const) {
        const redirect = await SELF.fetch(
          `https://example.test/api/${version}/status.${extension}`,
          { redirect: "manual" },
        );
        expect(redirect.status).toBe(302);
        expect(redirect.headers.get("Content-Type")).toBe(
          extension === "png" ? "image/png" : "image/svg+xml",
        );
        expect(redirect.headers.get("Content-Length")).toBe("0");
        expect(redirect.headers.get("Vary")).toBe("Accept");
        expect(redirect.headers.get("Location")).toBe(
          `http://img.shields.io/badge/Nightscout-OK-green.${extension}`,
        );
      }

      const script = await SELF.fetch(`https://example.test/api/${version}/status.js`);
      expect(script.status).toBe(200);
      expect(script.headers.get("Content-Type")).toMatch(/^application\/javascript/);
      expect(script.headers.get("Vary")).toBe("Accept");
      const scriptBody = await script.text();
      expect(scriptBody).toMatch(/^this\.serverSettings = \{"status":"ok"/);
      expect(scriptBody).toMatch(/ \;$/);
      const scriptHead = await SELF.fetch(
        `https://example.test/api/${version}/status.js`,
        { method: "HEAD" },
      );
      expect(scriptHead.status).toBe(200);
      expect(scriptHead.headers.get("Content-Length")).toBe(
        script.headers.get("Content-Length"),
      );
      expect(await scriptHead.text()).toBe("");

      const json = await SELF.fetch(`https://example.test/api/${version}/status.json`);
      expect(json.status).toBe(200);
      expect(json.headers.get("Vary")).toBe("Accept");
      expect(await json.json()).toMatchObject({
        status: "ok",
        version: "15.0.7",
        authorized: null,
      });
    }
  });

  it("negotiates the extensionless route and rejects declared but unrendered formats", async () => {
    const json = await SELF.fetch("https://example.test/api/v1/status", {
      headers: { Accept: "application/json" },
    });
    expect(json.status).toBe(200);
    expect(json.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(json.headers.get("Vary")).toBe("Accept");

    const axiosStyle = await SELF.fetch("https://example.test/api/v1/status", {
      headers: { Accept: "application/json, text/plain, */*" },
    });
    expect(axiosStyle.status).toBe(200);
    expect(axiosStyle.headers.get("Content-Type")).toMatch(/^application\/json/);

    const html = await SELF.fetch("https://example.test/api/v1/status", {
      headers: { Accept: "text/html" },
    });
    expect(html.status).toBe(200);
    expect(await html.text()).toBe("<h1>STATUS OK</h1>");

    const negotiatorPriority = await SELF.fetch("https://example.test/api/v1/status", {
      headers: { Accept: "text/*;q=.1,*/*;q=1" },
      redirect: "manual",
    });
    expect(negotiatorPriority.status).toBe(302);
    expect(negotiatorPriority.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    const redirectBody =
      "Found. Redirecting to http://img.shields.io/badge/Nightscout-OK-green.png";
    expect(negotiatorPriority.headers.get("Content-Length")).toBe(
      String(new TextEncoder().encode(redirectBody).byteLength),
    );
    expect(await negotiatorPriority.text()).toBe(redirectBody);

    const negotiatorPriorityHead = await SELF.fetch(
      "https://example.test/api/v1/status",
      {
        method: "HEAD",
        headers: { Accept: "text/*;q=.1,*/*;q=1" },
        redirect: "manual",
      },
    );
    expect(negotiatorPriorityHead.status).toBe(302);
    expect(negotiatorPriorityHead.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(negotiatorPriorityHead.headers.get("Content-Length")).toBe(
      negotiatorPriority.headers.get("Content-Length"),
    );
    expect(await negotiatorPriorityHead.text()).toBe("");

    const wildcard = await SELF.fetch("https://example.test/api/v1/status", {
      headers: { Accept: "*/*" },
    });
    expect(wildcard.status).toBe(200);
    expect(wildcard.headers.get("Content-Type")).toMatch(/^text\/html/);

    // negotiator 0.6.3 intentionally does not trim between the q key and `=`.
    await expectNotAcceptable(
      "https://example.test/api/v1/status",
      "GET",
      "text/html;q =.5",
    );

    for (const version of ["v1", "v2"] as const) {
      for (const extension of ["csv", "tsv"] as const) {
        for (const method of ["GET", "HEAD"] as const) {
          await expectNotAcceptable(
            `https://example.test/api/${version}/status.${extension}`,
            method,
          );
        }
      }
      for (const method of ["GET", "HEAD"] as const) {
        await expectNotAcceptable(
          `https://example.test/api/${version}/status`,
          method,
          "application/xml",
        );
      }
    }
  });

  it("preserves extension case bugs and unversioned finalhandler 404 responses", async () => {
    const paths = [
      "/api/v1/status.JSON",
      "/api/v2/status.TsV",
      "/api/v1/status.xml",
      "/api/v1/status.json/",
      "/api/status",
      "/api/status.json",
    ];
    for (const pathname of paths) {
      for (const method of ["GET", "HEAD"] as const) {
        const response = await SELF.fetch(`https://example.test${pathname}`, { method });
        expect(response.status).toBe(404);
        expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
        const expectedBody = finalhandlerBody(method, pathname);
        expect(response.headers.get("Content-Length")).toBe(
          String(new TextEncoder().encode(expectedBody).byteLength),
        );
        expect(await response.text()).toBe(method === "HEAD" ? "" : expectedBody);
      }
    }

    for (const pathname of ["/api/v1/status", "/api/v2/status.json", "/api/status"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
        const response = await SELF.fetch(`https://example.test${pathname}`, { method });
        expect(response.status).toBe(404);
        expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'");
        expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
        const expectedBody = finalhandlerBody(method, pathname);
        expect(response.headers.get("Content-Length")).toBe(
          String(new TextEncoder().encode(expectedBody).byteLength),
        );
        expect(await response.text()).toBe(expectedBody);
      }
    }

    const rejectedBeforeFinalhandler = await SELF.fetch(
      "https://example.test/api/v1/status",
      {
        method: "POST",
        headers: { Authorization: "Bearer invalid-status-jwt" },
      },
    );
    expect(rejectedBeforeFinalhandler.status).toBe(401);
    expect(await rejectedBeforeFinalhandler.json()).toEqual({
      status: 401,
      message: "Unauthorized",
      description: "Invalid/Missing",
    });

    const unversionedDoesNotAuthenticate = await SELF.fetch(
      "https://example.test/api/status",
      {
        method: "POST",
        headers: { Authorization: "Bearer invalid-status-jwt" },
      },
    );
    expect(unversionedDoesNotAuthenticate.status).toBe(404);
    expect(await unversionedDoesNotAuthenticate.text()).toBe(
      finalhandlerBody("POST", "/api/status"),
    );
  });

  it("inherits GET as HEAD without returning a body", async () => {
    const get = await SELF.fetch("https://example.test/api/v2/status.json");
    const response = await SELF.fetch("https://example.test/api/v2/status.json", {
      method: "HEAD",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(response.headers.get("Content-Length")).toBe(get.headers.get("Content-Length"));
    expect(Number(response.headers.get("Content-Length"))).toBeGreaterThan(0);
    expect(response.headers.get("Vary")).toBe("Accept");
    expect(await response.text()).toBe("");
  });
});
