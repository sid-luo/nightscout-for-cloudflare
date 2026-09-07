import missingRateFixture from "../vendor/nightscout/tests/data/missingRateOnLastEnacted.json";
import workingForecastFixture from "../vendor/nightscout/tests/data/statusWithWorkingForecast.json";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { createNightscoutProfileFunctions } from "../src/profile-functions";
import type { RealtimeDocument } from "../src/realtime/ddata-snapshot";
import { NONE, URGENT, WARN } from "../src/runtime/levels";
import {
  OPENAPS_INTENTS,
  calculateOpenApsProperty,
  openApsForecastAssistantResponse,
  openApsLastLoopAssistantResponse,
  openApsNotification,
  openApsVisualization,
} from "../src/plugins/openaps";
import {
  PUMP_INTENTS,
  calculatePumpProperty,
  pumpBatteryAssistantResponse,
  pumpNotification,
  pumpReservoirAssistantResponse,
  pumpVisualization,
} from "../src/plugins/pump";
import { loadPluginPropertyContext } from "../src/plugins/properties";
import { nightscoutStatus, tenantStatusSettings } from "../src/status";

const openApsNow = Date.parse("2015-12-05T19:05:00.000Z");

function openApsStatuses(): RealtimeDocument[] {
  return [
    {
      created_at: "2015-12-05T19:05:00.000Z",
      mills: openApsNow,
      device: "openaps://abusypi",
      mmtune: {
        scanDetails: [
          ["916.640", 4, -64],
          ["916.660", 5, -55],
          ["916.680", 5, -59],
        ],
        setFreq: 916.66,
        timestamp: " 2015-12-05T18:59:37.000Z",
        usedDefault: false,
      },
      openaps: {
        suggested: {
          bg: 147,
          timestamp: "2015-12-05T19:02:42.000Z",
          rate: 0.75,
          reason: "Eventual BG 125>120, no temp, setting 0.75U/hr",
          eventualBG: 125,
          duration: 30,
        },
        iob: {
          timestamp: "2015-12-05T19:02:42.000Z",
          bolusiob: 0,
          iob: 0.6068340736133333,
          activity: 0.016131569664902996,
        },
        enacted: {
          bg: 147,
          recieved: true,
          reason: "Eventual BG 125>120, no temp, setting 0.75U/hr",
          rate: 0.75,
          eventualBG: 125,
          timestamp: "2015-12-05T19:03:00.000Z",
          duration: 30,
          predBGs: {
            IOB: [100, 100, 100, 100],
            aCOB: [100, 100, 100, 100],
            COB: [100, 100, 100, 100],
          },
        },
      },
    },
    {
      created_at: "2015-12-05T18:05:00.000Z",
      mills: Date.parse("2015-12-05T18:05:00.000Z"),
      device: "openaps://awaitingpi",
      openaps: {
        suggested: {
          bg: 147,
          timestamp: "2015-12-05T16:02:42.000Z",
          rate: 0.75,
          reason: "Eventual BG 125>120, no temp, setting 0.75U/hr",
          eventualBG: 125,
          duration: 30,
        },
        iob: {
          timestamp: "2015-12-05T16:02:42.000Z",
          bolusiob: 0,
          iob: 0.6068340736133333,
          activity: 0.016131569664902996,
        },
        enacted: {
          bg: 147,
          recieved: true,
          reason: "Eventual BG 125>120, no temp, setting 0.75U/hr",
          rate: 0.75,
          eventualBG: 125,
          timestamp: "2015-12-05T16:03:00.000Z",
          duration: 30,
        },
      },
    },
  ];
}

describe("locked Nightscout openaps.test.js", () => {
  it("set the property and update the pill and add forecast points", () => {
    const property = calculateOpenApsProperty(openApsStatuses(), openApsNow);
    expect(property.status).toMatchObject({ symbol: "⌁", code: "enacted" });
    const visual = openApsVisualization(property, openApsNow);
    expect(visual.pill).toMatchObject({ label: "OpenAPS ⌁", value: "2m ago" });
    expect(visual.pill.info[0]).toEqual({
      label: "1m ago",
      value: "abusypi ⌁ Enacted @ -55dB",
    });
    expect(visual.pill.info.at(-1)).toEqual({
      label: "1h ago",
      value: "awaitingpi ◉ Waiting",
    });
    expect(visual.forecastPoints).toHaveLength(12);
  });

  it("retains forecasts without invalid basal details when enacted rate is missing", () => {
    const statuses = openApsStatuses();
    delete ((statuses[0]!.openaps as RealtimeDocument).enacted as RealtimeDocument).rate;
    const visual = openApsVisualization(calculateOpenApsProperty(statuses, openApsNow), openApsNow);
    expect(visual.forecastPoints).toHaveLength(12);
    expect(JSON.stringify(visual.pill)).not.toMatch(/NaN|undefined/);
  });

  it("format OpenAPS pill BG in mmol when display units are mmol", () => {
    const property = calculateOpenApsProperty(openApsStatuses(), openApsNow);
    const visual = openApsVisualization(property, openApsNow, "mmol");
    const bg = visual.pill.info.find((entry) => String(entry.value).startsWith("BG: "));
    expect(bg?.value).toMatch(/^BG: 8\.2/);
    expect(bg?.value).not.toMatch(/^BG: 147/);
  });

  it("check the recieved flag to see if it was received", () => {
    const statuses = openApsStatuses();
    const openaps = statuses[0]?.openaps as RealtimeDocument;
    const enacted = openaps.enacted as RealtimeDocument;
    enacted.recieved = false;
    expect(calculateOpenApsProperty(statuses, openApsNow).status)
      .toMatchObject({ symbol: "x", code: "notenacted" });
  });

  it("generate an alert for a stuck loop", () => {
    const checkTime = openApsNow + 60 * 60_000;
    const property = calculateOpenApsProperty(openApsStatuses(), checkTime);
    expect(openApsNotification(property, [], checkTime, { enableAlerts: "TRUE" }))
      .toMatchObject({
        level: URGENT,
        title: "OpenAPS isn't looping",
        group: "OpenAPS",
      });
  });

  it("not generate an alert for a stuck loop, when there is an offline marker", () => {
    const checkTime = openApsNow + 60 * 60_000;
    const property = calculateOpenApsProperty(openApsStatuses(), checkTime);
    expect(openApsNotification(property, [{
      eventType: "OpenAPS Offline",
      mills: openApsNow,
      duration: 60,
    }], checkTime, { enableAlerts: "TRUE" })).toBeNull();
  });

  it("should handle virtAsst requests", () => {
    const property = calculateOpenApsProperty(openApsStatuses(), openApsNow);
    expect(OPENAPS_INTENTS).toHaveLength(2);
    expect(openApsForecastAssistantResponse(property)).toEqual({
      title: "OpenAPS Forecast",
      response: "The OpenAPS Eventual BG is 125",
    });
    expect(openApsLastLoopAssistantResponse(property, openApsNow)).toEqual({
      title: "Last Loop",
      response: "The last successful loop was 2 minutes ago",
    });
  });
});

const pumpNow = Date.parse("2015-12-05T19:05:00.000Z");

function pumpStatuses(override = false): RealtimeDocument[] {
  const make = (createdAt: string, device: string, clock: string): RealtimeDocument => ({
    created_at: createdAt,
    mills: Date.parse(createdAt),
    device,
    pump: {
      battery: { status: "normal", voltage: 1.52 },
      status: { status: "normal", bolusing: false, suspended: false },
      reservoir: 86.4,
      ...(override ? { reservoir_display_override: "50+U" } : {}),
      clock,
    },
  });
  return [
    make("2015-12-05T17:35:00.000Z", "openaps://farawaypi", "2015-12-05T17:32:00.000Z"),
    make("2015-12-05T19:05:00.000Z", "openaps://abusypi", "2015-12-05T19:02:00.000Z"),
  ];
}

function setLatestPumpValue(
  statuses: RealtimeDocument[],
  update: (pump: RealtimeDocument) => void,
): RealtimeDocument[] {
  const pump = statuses[1]?.pump as RealtimeDocument;
  update(pump);
  return statuses;
}

describe("locked Nightscout pump.test.js", () => {
  it("set the property and update the pill", () => {
    const property = calculatePumpProperty(pumpStatuses(), [], undefined, pumpNow);
    expect(property.data).toMatchObject({
      level: NONE,
      battery: { value: 1.52 },
      reservoir: { value: 86.4 },
    });
    expect(pumpVisualization(property, [], undefined, pumpNow)).toMatchObject({
      label: "Pump",
      value: "86.4U",
    });
  });

  it("use reservoir_display_override when available", () => {
    const property = calculatePumpProperty(pumpStatuses(true), [], undefined, pumpNow);
    expect(pumpVisualization(property, [], undefined, pumpNow).value).toBe("50+U");
  });

  it("not generate an alert when pump is ok", () => {
    const property = calculatePumpProperty(pumpStatuses(), [], undefined, pumpNow);
    expect(pumpNotification(property, [], undefined, pumpNow, { enableAlerts: true }))
      .toBeNull();
  });

  it("generate an alert when reservoir is low", () => {
    const statuses = setLatestPumpValue(pumpStatuses(), (pump) => {
      pump.reservoir = 0.5;
    });
    const property = calculatePumpProperty(statuses, [], undefined, pumpNow);
    expect(pumpNotification(property, [], undefined, pumpNow, { enableAlerts: true }))
      .toMatchObject({ level: URGENT, title: "URGENT: Pump Reservoir Low" });
  });

  it("generate an alert when reservoir is 0", () => {
    const statuses = setLatestPumpValue(pumpStatuses(), (pump) => {
      pump.reservoir = 0;
    });
    const property = calculatePumpProperty(statuses, [], undefined, pumpNow);
    expect(pumpNotification(property, [], undefined, pumpNow, { enableAlerts: true }))
      .toMatchObject({ level: URGENT, title: "URGENT: Pump Reservoir Low" });
  });

  it("generate an alert when battery is low", () => {
    const statuses = setLatestPumpValue(pumpStatuses(), (pump) => {
      (pump.battery as RealtimeDocument).voltage = 1.33;
    });
    const property = calculatePumpProperty(statuses, [], undefined, pumpNow);
    expect(pumpNotification(property, [], undefined, pumpNow, { enableAlerts: true }))
      .toMatchObject({ level: WARN, title: "Warning, Pump Battery Low" });
  });

  it("generate an urgent alarm when battery is really low", () => {
    const statuses = setLatestPumpValue(pumpStatuses(), (pump) => {
      (pump.battery as RealtimeDocument).voltage = 1;
    });
    const property = calculatePumpProperty(statuses, [], undefined, pumpNow);
    expect(pumpNotification(property, [], undefined, pumpNow, { enableAlerts: true }))
      .toMatchObject({ level: URGENT, title: "URGENT: Pump Battery Low" });
  });

  it("not generate a battery alarm during night when PUMP_WARN_BATT_QUIET_NIGHT is true", () => {
    const statuses = setLatestPumpValue(pumpStatuses(), (pump) => {
      (pump.battery as RealtimeDocument).voltage = 1;
    });
    const profile = createNightscoutProfileFunctions([{ timezone: "UTC" }]);
    const preferences = { enableAlerts: true, warnBattQuietNight: true };
    const settings = { dayStart: 24, dayEnd: 21 };
    const property = calculatePumpProperty(statuses, [], profile, pumpNow, preferences, settings);
    expect(pumpNotification(property, [], profile, pumpNow, preferences, settings)).toBeNull();
  });

  it("not generate an alert for a stale pump data, when there is an offline marker", () => {
    const checkTime = pumpNow + 60 * 60_000;
    const treatments = [{ eventType: "OpenAPS Offline", mills: pumpNow, duration: 60 }];
    const property = calculatePumpProperty(pumpStatuses(), treatments, undefined, checkTime);
    expect(pumpNotification(
      property,
      treatments,
      undefined,
      checkTime,
      { enableAlerts: true },
    )).toBeNull();
  });

  it("should handle virtAsst requests", () => {
    const property = calculatePumpProperty(pumpStatuses(), [], undefined, pumpNow);
    expect(PUMP_INTENTS).toHaveLength(4);
    expect(pumpReservoirAssistantResponse(property)).toEqual({
      title: "Insulin Remaining",
      response: "You have 86.4 units remaining",
    });
    expect(pumpBatteryAssistantResponse(property)).toEqual({
      title: "Pump Battery",
      response: "Your pump battery is at 1.52 volts",
    });
  });
});

describe("Workers OpenAPS/Pump platform adapter", () => {
  it("normalizes official environment settings only when the plugins are enabled", () => {
    const configured = tenantStatusSettings({
      ENABLE: "openaps pump",
      DAY_START: "8",
      DAY_END: "22",
      OPENAPS_ENABLE_ALERTS: "true",
      OPENAPS_WARN: "20",
      OPENAPS_URGENT: "40",
      OPENAPS_FIELDS: "status-symbol iob rssi",
      OPENAPS_PRED_IOB_COLOR: "#123456",
      OPENAPS_COLOR_PREDICTION_LINES: "off",
      PUMP_ENABLE_ALERTS: "on",
      PUMP_FIELDS: "reservoir battery",
      PUMP_WARN_CLOCK: "25",
      PUMP_URGENT_CLOCK: "50",
      PUMP_WARN_BATT_QUIET_NIGHT: "true",
    });
    expect(configured.extendedSettings).toMatchObject({
      openaps: {
        enableAlerts: true,
        warn: 20,
        urgent: 40,
        fields: "status-symbol iob rssi",
        predIobColor: "#123456",
        colorPredictionLines: false,
      },
      pump: {
        enableAlerts: true,
        fields: "reservoir battery",
        warnClock: 25,
        urgentClock: 50,
        warnBattQuietNight: true,
      },
    });
    const settings = nightscoutStatus(new Date(0), "readable", configured).settings as
      Record<string, unknown>;
    expect(settings).toMatchObject({ dayStart: "8", dayEnd: "22" });
    expect(tenantStatusSettings({ OPENAPS_WARN: "20", PUMP_WARN_RES: "5" }).extendedSettings)
      .not.toHaveProperty("openaps");
  });

  it("projects device status and serves only enabled OpenAPS/Pump v2 properties", async () => {
    const tenant = `openaps-pump-${crypto.randomUUID()}`;
    const stub = env.ENTRY_STORE.getByName(tenant);
    const liveNow = Date.now();
    await stub.createDocuments("devicestatus", JSON.stringify([{
      created_at: new Date(liveNow - 60_000).toISOString(),
      device: "openaps://family-rig",
      openaps: {
        suggested: {
          bg: 120,
          eventualBG: 125,
          timestamp: new Date(liveNow - 90_000).toISOString(),
        },
        enacted: {
          bg: 120,
          eventualBG: 125,
          received: true,
          rate: 0.8,
          duration: 30,
          timestamp: new Date(liveNow - 80_000).toISOString(),
        },
      },
      pump: {
        clock: new Date(liveNow - 60_000).toISOString(),
        reservoir: 75.5,
        battery: { percent: 80 },
        status: { status: "normal", suspended: false, bolusing: false },
      },
    }]));

    const context = await loadPluginPropertyContext(stub, liveNow);
    expect(context.devicestatus).toHaveLength(1);
    const enabledStatus = nightscoutStatus(
      new Date(liveNow),
      "readable",
      tenantStatusSettings({ ENABLE: "openaps pump" }),
    );
    const fakeStub = {
      authorizationDelay: (...args: Parameters<typeof stub.authorizationDelay>) =>
        stub.authorizationDelay(...args),
      listDocuments: (...args: Parameters<typeof stub.listDocuments>) => stub.listDocuments(...args),
      getPluginPropertyContextJson: (...args: Parameters<typeof stub.getPluginPropertyContextJson>) =>
        stub.getPluginPropertyContextJson(...args),
      getDdataSnapshotJson: (...args: Parameters<typeof stub.getDdataSnapshotJson>) =>
        stub.getDdataSnapshotJson(...args),
      nightscoutHttpStatus: async () => JSON.stringify(enabledStatus),
    };
    const response = await worker.fetch(
      new Request(`https://example.test/api/v2/properties/openaps,pump?tenant=${tenant}`),
      {
        ASSETS: env.ASSETS,
        ENTRY_STORE: { getByName: () => fakeStub },
        AUTH_DEFAULT_ROLES: "readable",
        AUTH_FAIL_DELAY: "0",
      } as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      openaps: {
        lastEventualBG: 125,
        status: { code: "enacted" },
      },
      pump: {
        device: "openaps://family-rig",
        data: {
          level: NONE,
          reservoir: { value: 75.5 },
          battery: { value: 80, unit: "percent" },
        },
      },
    });

    fakeStub.nightscoutHttpStatus = async () => JSON.stringify(nightscoutStatus(
      new Date(liveNow),
      "readable",
      tenantStatusSettings({ ENABLE: "" }),
    ));
    const disabled = await worker.fetch(
      new Request(`https://example.test/api/v2/properties/openaps,pump?tenant=${tenant}`),
      {
        ASSETS: env.ASSETS,
        ENTRY_STORE: { getByName: () => fakeStub },
        AUTH_DEFAULT_ROLES: "readable",
        AUTH_FAIL_DELAY: "0",
      } as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(await disabled.json()).toEqual({});
  });
});


it("preserves captured OpenAPS UAM forecasts across absent, null and blank basal details", () => {
  for (const [fixture, details] of [
    [workingForecastFixture, null], [missingRateFixture, null],
    [workingForecastFixture, { rate: null }], [workingForecastFixture, { rate: "" }],
    [workingForecastFixture, { duration: null }], [workingForecastFixture, { duration: "" }],
  ] as const) {
    const statuses = structuredClone(fixture) as unknown as RealtimeDocument[];
    for (const status of statuses) status.mills = Date.parse(String(status.created_at));
    if (details) Object.assign((statuses[0]!.openaps as RealtimeDocument).enacted!, details);
    const time = Number(statuses[0]!.mills);
    const property = calculateOpenApsProperty(statuses, time);
    expect((property.lastPredBGs as RealtimeDocument).UAM).toBeInstanceOf(Array);
    const visual = openApsVisualization(property, time);
    expect(visual.forecastPoints.length).toBeGreaterThan(100);
    if (details || fixture === missingRateFixture) {
      expect(JSON.stringify(visual.pill.info)).not.toMatch(/undefined|Temp Basal Started/);
    }
  }
});
