import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { fitTreatmentsToBgCurve } from "../src/data/treatment-to-curve";
import { parseEntryPayload } from "../src/model";
import { createNightscoutProfileFunctions } from "../src/profile-functions";
import type { RealtimeDocument } from "../src/realtime/ddata-snapshot";
import {
  IOB_INTENTS,
  IOB_RECENCY_THRESHOLD_MS,
  IOB_ROLLUPS,
  calculateIobFromTreatments,
  calculateIobTotal,
  iobAssistantResponses,
} from "../src/plugins/iob";
import {
  COB_INTENTS,
  COB_RECENCY_THRESHOLD_MS,
  calculateCobFromTreatments,
  calculateCobTotal,
  cobAssistantResponse,
  cobVisualization,
} from "../src/plugins/cob";
import { loadPluginPropertyContext } from "../src/plugins/properties";
import { nightscoutStatus, tenantStatusSettings } from "../src/status";

const now = Date.parse("2026-07-20T12:00:00.000Z");

function iobProfile(dia = 3) {
  return createNightscoutProfileFunctions([{ dia, sens: 0 }]);
}

function cobProfile() {
  return createNightscoutProfileFunctions([{
    startDate: "2015-06-21",
    sens: 95,
    carbratio: 18,
    carbs_hr: 30,
  }]);
}

function openapsIobStatus(
  mills: number,
  iob: unknown = {
    iob: 0.047,
    basaliob: -0.298,
    activity: 0.0147,
    timestamp: mills,
  },
): RealtimeDocument {
  return {
    device: "openaps://pi1",
    mills,
    openaps: { iob },
  };
}

describe("locked Nightscout iob.test.js", () => {
  it("should handle virtAsst requests", () => {
    expect(IOB_INTENTS).toHaveLength(1);
    expect(IOB_ROLLUPS).toHaveLength(1);
    expect(iobAssistantResponses({ iob: 1.5 })).toEqual({
      intent: {
        title: "Current IOB",
        response: "You have 1.50 units of insulin on board",
      },
      rollup: {
        results: "and you have 1.50 units of insulin on board.",
        priority: 2,
      },
    });
  });

  it("should calculate IOB", () => {
    const treatments = [{ mills: now - 1, insulin: "1.00" }];
    const profile = iobProfile();
    expect(calculateIobTotal(treatments, [], profile, now).display).toBe("1.00");
    const afterHour = Number(calculateIobTotal(
      treatments,
      [],
      profile,
      now + 60 * 60_000,
    ).iob);
    expect(afterHour).toBeGreaterThan(0);
    expect(afterHour).toBeLessThan(1);
    expect(calculateIobTotal(treatments, [], profile, now + 3 * 60 * 60_000).iob)
      .toBe(0);
  });

  it("should calculate IOB using defaults", () => {
    expect(calculateIobTotal([{ mills: now - 1, insulin: "1.00" }], [], undefined, now)
      .display).toBe("1.00");
  });

  it("should not show a negative IOB when approaching 0", () => {
    const bolusTime = now - 1;
    expect(calculateIobTotal(
      [{ mills: bolusTime, insulin: "5.00" }],
      [],
      undefined,
      bolusTime + 3 * 60 * 60_000 - 90_000,
    ).display).toBe("0.00");
  });

  it("should calculate IOB using a 4 hour duration", () => {
    const treatments = [{ mills: now - 1, insulin: "1.00" }];
    const profile = iobProfile(4);
    expect(calculateIobTotal(treatments, [], profile, now).display).toBe("1.00");
    expect(Number(calculateIobTotal(treatments, [], profile, now + 60 * 60_000).iob))
      .toBeGreaterThan(0);
    expect(Number(calculateIobTotal(treatments, [], profile, now + 3 * 60 * 60_000).iob))
      .toBeGreaterThan(0);
    expect(calculateIobTotal(treatments, [], profile, now + 4 * 60 * 60_000).iob)
      .toBe(0);
  });

  const treatmentContext = () => {
    const treatments = [{ mills: now - 1, insulin: "3.00" }];
    const profile = iobProfile();
    return {
      treatments,
      profile,
      treatmentIob: calculateIobFromTreatments(treatments, profile, now).iob,
    };
  };

  it("should fall back to treatment data if no devicestatus data", () => {
    const fixture = treatmentContext();
    expect(calculateIobTotal(fixture.treatments, [], fixture.profile, now)).toMatchObject({
      source: "Care Portal",
      iob: fixture.treatmentIob,
    });
  });

  it("should fall back to treatments if openaps devicestatus is present but empty", () => {
    const fixture = treatmentContext();
    expect(calculateIobTotal(
      fixture.treatments,
      [{ device: "openaps://pi1", mills: now - 1, openaps: {} }],
      fixture.profile,
      now,
    ).iob).toBe(fixture.treatmentIob);
  });

  it("should fall back to treatments if openaps devicestatus is present but too stale", () => {
    const fixture = treatmentContext();
    const stale = now - IOB_RECENCY_THRESHOLD_MS - 1;
    expect(calculateIobTotal(
      fixture.treatments,
      [openapsIobStatus(stale)],
      fixture.profile,
      now,
    )).toMatchObject({ source: "Care Portal", iob: fixture.treatmentIob });
  });

  it("should return IOB data from openaps", () => {
    const fixture = treatmentContext();
    expect(calculateIobTotal(
      fixture.treatments,
      [openapsIobStatus(now - 1)],
      fixture.profile,
      now,
    )).toMatchObject({
      iob: 0.047,
      basaliob: -0.298,
      activity: 0.0147,
      source: "OpenAPS",
      device: "openaps://pi1",
    });
  });

  it("should not blow up with null IOB data from openaps", () => {
    const fixture = treatmentContext();
    expect(calculateIobTotal(
      fixture.treatments,
      [openapsIobStatus(now - 1, null)],
      fixture.profile,
      now,
    )).toMatchObject({ source: "Care Portal", display: "3.00" });
  });

  it("should return IOB data from openaps post AMA (an array)", () => {
    const fixture = treatmentContext();
    expect(calculateIobTotal(
      fixture.treatments,
      [openapsIobStatus(now - 1, [{
        iob: 0.047,
        basaliob: -0.298,
        activity: 0.0147,
        time: now - 1,
      }])],
      fixture.profile,
      now,
    )).toMatchObject({
      iob: 0.047,
      basaliob: -0.298,
      activity: 0.0147,
      source: "OpenAPS",
      device: "openaps://pi1",
    });
  });

  it("should return IOB data from Loop", () => {
    const fixture = treatmentContext();
    expect(calculateIobTotal(fixture.treatments, [{
      device: "loop://iPhone",
      mills: now - 1,
      loop: { iob: { iob: 0.75, timestamp: now - 1 } },
    }], fixture.profile, now)).toMatchObject({
      iob: 0.75,
      source: "Loop",
      device: "loop://iPhone",
    });
  });

  it("should return IOB data from openaps from multiple devices", () => {
    const fixture = treatmentContext();
    expect(calculateIobTotal(fixture.treatments, [
      openapsIobStatus(now - 1_000),
      openapsIobStatus(now - 1),
      openapsIobStatus(now - 20_000),
    ], fixture.profile, now)).toMatchObject({
      iob: 0.047,
      basaliob: -0.298,
      activity: 0.0147,
      source: "OpenAPS",
      device: "openaps://pi1",
    });
  });

  it("should return IOB data from MiniMed Connect", () => {
    const fixture = treatmentContext();
    expect(calculateIobTotal(fixture.treatments, [{
      device: "connect://paradigm",
      mills: now - 1,
      pump: { iob: { bolusiob: 0.87 } },
      connect: { sensorState: "copacetic" },
    }], fixture.profile, now)).toMatchObject({
      iob: 0.87,
      source: "MM Connect",
      device: "connect://paradigm",
    });
  });
});

describe("locked Nightscout cob.test.js", () => {
  it("should calculate IOB, multiple treatments", () => {
    const treatments = [
      { carbs: "100", mills: Date.parse("2015-05-29T02:03:48.827Z") },
      { carbs: "10", mills: Date.parse("2015-05-29T03:45:10.670Z") },
    ];
    const profile = cobProfile();
    const after100 = calculateCobTotal(
      treatments,
      [],
      profile,
      Date.parse("2015-05-29T02:03:49.827Z"),
    );
    const before10 = calculateCobTotal(
      treatments,
      [],
      profile,
      Date.parse("2015-05-29T03:45:10.670Z"),
    );
    const after10 = calculateCobTotal(
      treatments,
      [],
      profile,
      Date.parse("2015-05-29T03:45:11.670Z"),
    );
    expect(after100.cob).toBe(100);
    expect(Math.round(Number(before10.cob))).toBe(59);
    expect(Math.round(Number(after10.cob))).toBe(69);
  });

  it("should calculate IOB, single treatment", () => {
    const treatments = [{ carbs: "8", mills: Date.parse("2015-05-29T04:40:40.174Z") }];
    const profile = cobProfile();
    const times = [
      "2015-05-29T04:41:40.174Z",
      "2015-05-29T05:04:40.174Z",
      "2015-05-29T05:20:00.174Z",
      "2015-05-29T05:50:00.174Z",
      "2015-05-29T06:50:00.174Z",
    ].map(Date.parse);
    expect(times.map((time) => calculateCobTotal(treatments, [], profile, time).cob))
      .toEqual([8, 6, 0, 0, 0]);
  });

  it("set a pill to the current COB", () => {
    const property = calculateCobTotal(
      [{ carbs: "8", mills: now - 60_000 }],
      [],
      cobProfile(),
      now,
    );
    expect(cobVisualization(property).value).toBe("8g");
  });

  it("should handle virtAsst requests", () => {
    expect(COB_INTENTS).toHaveLength(1);
    const property = calculateCobTotal(
      [{ carbs: "8", mills: now - 60_000 }],
      [],
      cobProfile(),
      now,
    );
    expect(cobAssistantResponse(property)).toEqual({
      title: "Current COB",
      response: "You have 8 carbohydrates on board",
    });
  });

  const treatmentContext = () => {
    const treatments = [{ mills: now - 1, carbs: "20" }];
    const profile = cobProfile();
    return {
      treatments,
      profile,
      treatmentCob: calculateCobFromTreatments(treatments, [], profile, now).cob,
    };
  };

  it("should fall back to treatment data if no devicestatus data", () => {
    const fixture = treatmentContext();
    expect(calculateCobTotal(
      fixture.treatments,
      [],
      fixture.profile,
      now,
      undefined,
      now,
    )).toMatchObject({ source: "Care Portal", cob: fixture.treatmentCob });
  });

  it("should fall back to treatments if openaps devicestatus is present but empty", () => {
    const fixture = treatmentContext();
    expect(calculateCobTotal(fixture.treatments, [{
      device: "openaps://pi1",
      mills: now - 1,
      openaps: {},
    }], fixture.profile, now, undefined, now).cob).toBe(fixture.treatmentCob);
  });

  it("should fall back to treatments if openaps devicestatus is present but too stale", () => {
    const fixture = treatmentContext();
    const stale = now - COB_RECENCY_THRESHOLD_MS - 1;
    expect(calculateCobTotal(fixture.treatments, [{
      device: "openaps://pi1",
      mills: stale,
      openaps: { enacted: { COB: 5, timestamp: stale } },
    }], fixture.profile, now, undefined, now)).toMatchObject({
      source: "Care Portal",
      cob: fixture.treatmentCob,
    });
  });

  it("uses the requested historical time to select fresh OpenAPS COB", () => {
    const fixture = treatmentContext();
    expect(calculateCobTotal(fixture.treatments, [{
      device: "openaps://history", mills: now - 1,
      openaps: { enacted: { COB: 7, timestamp: now - 1 } },
    }], fixture.profile, now, undefined, now + 90 * 86400000)).toMatchObject({ cob: 7, source: "OpenAPS" });
  });

  it("should return COB data from OpenAPS", () => {
    const fixture = treatmentContext();
    expect(calculateCobTotal(fixture.treatments, [{
      device: "openaps://pi1",
      mills: now - 1,
      openaps: { enacted: { COB: 5, timestamp: now - 1 } },
    }], fixture.profile, now, undefined, now)).toMatchObject({
      cob: 5,
      source: "OpenAPS",
      device: "openaps://pi1",
    });
  });

  it("should return COB data from Loop", () => {
    const fixture = treatmentContext();
    expect(calculateCobTotal(fixture.treatments, [{
      device: "loop://iPhone",
      mills: now - 1,
      loop: { cob: { cob: 5, timestamp: now - 1 } },
    }], fixture.profile, now, undefined, now)).toMatchObject({
      cob: 5,
      source: "Loop",
      device: "loop://iPhone",
    });
  });
});

describe("locked Nightscout data.treatmenttocurve.test.js", () => {
  it("update treatment display BGs", () => {
    const before = now - 5 * 60_000;
    const data: { sgvs: RealtimeDocument[]; treatments: RealtimeDocument[] } = {
      sgvs: [{ mgdl: 90, mills: before }, { mgdl: 100, mills: now }],
      treatments: [
        { _id: "someid_1", mills: before, glucose: 100, units: "mgdl" },
        { _id: "someid_2", mills: before, glucose: 5.5, units: "mmol" },
        { _id: "someid_3", mills: now - 120_000, insulin: "1.00" },
        { _id: "someid_4", mills: now + 60_000, insulin: "1.00" },
        { _id: "someid_5", mills: before - 120_000, insulin: "1.00" },
      ],
    };
    fitTreatmentsToBgCurve(data);
    expect(data.treatments[0]?.mgdl).toBe(100);
    expect(data.treatments[1]?.mmol).toBe(5.5);
    expect(data.treatments[2]?.mgdl).toBe(95);
    expect(data.treatments[3]?.mgdl).toBe(100);
    expect(data.treatments[4]?.mgdl).toBe(90);
  });
});

describe("Workers IOB/COB platform adapter", () => {
  it("loads the official bounded Treatment/Profile inputs and curves ddata markers", async () => {
    const tenant = `iob-cob-context-${crypto.randomUUID()}`;
    const stub = env.ENTRY_STORE.getByName(tenant);
    const liveNow = Date.now();
    await stub.putEntries(parseEntryPayload([
      {
        type: "sgv",
        sgv: 90,
        date: liveNow - 5 * 60_000,
        dateString: new Date(liveNow - 5 * 60_000).toISOString(),
        device: "simulator://cgm",
      },
      {
        type: "sgv",
        sgv: 100,
        date: liveNow,
        dateString: new Date(liveNow).toISOString(),
        device: "simulator://cgm",
      },
    ]));
    await stub.createDocuments("profile", JSON.stringify([{
      defaultProfile: "Child",
      startDate: new Date(liveNow - 24 * 60 * 60_000).toISOString(),
      store: { Child: { dia: 3, sens: 95, carbratio: 18, carbs_hr: 30, basal: [] } },
    }]));
    await stub.createDocuments("treatments", JSON.stringify([
      {
        eventType: "Meal Bolus",
        insulin: 1,
        carbs: 10,
        created_at: new Date(liveNow - 2 * 60_000).toISOString(),
      },
      {
        eventType: "Meal Bolus",
        insulin: 1,
        created_at: new Date(liveNow - 4 * 24 * 60 * 60_000).toISOString(),
      },
    ]));

    const context = await loadPluginPropertyContext(stub, liveNow);
    expect(context.profiles).toHaveLength(1);
    expect(context.treatments).toEqual(expect.arrayContaining([
      expect.objectContaining({ carbs: 10 }),
    ]));
    expect(context.treatments).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ created_at: new Date(liveNow - 4 * 24 * 60 * 60_000).toISOString() }),
    ]));

    const response = await SELF.fetch(
      `https://example.test/api/v2/ddata/at?tenant=${encodeURIComponent(tenant)}`,
    );
    expect(response.status).toBe(200);
    const ddata = await response.json() as { treatments: RealtimeDocument[] };
    expect(ddata.treatments.find((treatment) => treatment.carbs === 10)?.mgdl).toBe(95);
  });

  it("serves enabled IOB/COB properties and summary state from current device status", async () => {
    const tenant = `iob-cob-live-${crypto.randomUUID()}`;
    const stub = env.ENTRY_STORE.getByName(tenant);
    const liveNow = Date.now();
    await stub.createDocuments("profile", JSON.stringify([{
      defaultProfile: "Child",
      startDate: new Date(liveNow - 24 * 60 * 60_000).toISOString(),
      store: {
        Child: {
          timezone: "Asia/Shanghai",
          dia: 3,
          sens: 95,
          carbratio: 18,
          carbs_hr: 30,
          basal: [],
        },
      },
    }]));
    await stub.createDocuments("devicestatus", JSON.stringify([{
      device: "openaps://pi1",
      created_at: new Date(liveNow - 1_000).toISOString(),
      openaps: {
        iob: {
          iob: 0.047,
          basaliob: -0.298,
          activity: 0.0147,
          timestamp: liveNow - 1_000,
        },
        enacted: { COB: 5, timestamp: liveNow - 1_000 },
      },
    }]));

    const status = nightscoutStatus(
      new Date(liveNow),
      "readable",
      tenantStatusSettings({ ENABLE: "iob cob" }),
    );
    const fakeStub = {
      authorizationDelay: (...args: Parameters<typeof stub.authorizationDelay>) =>
        stub.authorizationDelay(...args),
      listDocuments: (...args: Parameters<typeof stub.listDocuments>) =>
        stub.listDocuments(...args),
      getPluginPropertyContextJson: (...args: Parameters<typeof stub.getPluginPropertyContextJson>) =>
        stub.getPluginPropertyContextJson(...args),
      getDdataSnapshotJson: (...args: Parameters<typeof stub.getDdataSnapshotJson>) =>
        stub.getDdataSnapshotJson(...args),
      nightscoutHttpStatus: async () => JSON.stringify(status),
    };
    const testEnv = {
      ASSETS: env.ASSETS,
      ENTRY_STORE: { getByName: () => fakeStub },
      AUTH_DEFAULT_ROLES: "readable",
      AUTH_FAIL_DELAY: "0",
    } as unknown as Parameters<typeof worker.fetch>[1];

    const propertiesResponse = await worker.fetch(
      new Request(`https://example.test/api/v2/properties/iob,cob?tenant=${tenant}`),
      testEnv,
    );
    expect(propertiesResponse.status).toBe(200);
    expect(await propertiesResponse.json()).toMatchObject({
      iob: { iob: 0.047, source: "OpenAPS", display: "0.05" },
      cob: { cob: 5, source: "OpenAPS", display: 5 },
    });

    const summaryResponse = await worker.fetch(
      new Request(`https://example.test/api/v2/summary/?tenant=${tenant}`),
      testEnv,
    );
    expect(summaryResponse.status).toBe(200);
    expect(await summaryResponse.json()).toMatchObject({
      state: { iob: 0.05, cob: 5, bwp: null },
    });
  });
});
