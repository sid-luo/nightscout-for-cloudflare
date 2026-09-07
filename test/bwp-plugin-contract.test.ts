import { describe, expect, it } from "vitest";
import { buildNightscoutSummary } from "../src/api2/summary";
import { createNightscoutProfileFunctions } from "../src/profile-functions";
import {
  calculateBolusWizardPreview,
  calculateBwpNotificationEvaluation,
  type BwpProperty,
} from "../src/plugins/bwp";
import {
  calculatePluginProperties,
  createPluginProfileFunctions,
  type PluginPropertyContext,
} from "../src/plugins/properties";
import { URGENT, WARN } from "../src/runtime/levels";
import { nightscoutStatus, tenantStatusSettings } from "../src/status";

const now = Date.parse("2026-07-22T08:00:00.000Z");
const before = now - 5 * 60_000;
const settings = {
  units: "mg/dl",
  thresholds: {
    bgHigh: 260,
    bgTargetTop: 180,
    bgTargetBottom: 80,
    bgLow: 55,
  },
};

function profile(document: Record<string, unknown>) {
  return createNightscoutProfileFunctions([structuredClone(document)]);
}

function context(
  sgvs: PluginPropertyContext["sgvs"],
  profileDocument: Record<string, unknown>,
  treatments: PluginPropertyContext["treatments"] = [],
): PluginPropertyContext {
  return {
    sgvs,
    cals: [],
    devicestatus: [],
    profiles: [profileDocument],
    treatments,
  };
}

describe("locked Nightscout v15.0.7 boluswizardpreview.test.js", () => {
  it("calculates zero and positive IOB outcomes in mg/dl", () => {
    const zero = calculateBolusWizardPreview(
      [{ mgdl: 100, mills: before }, { mgdl: 100, mills: now }],
      [],
      profile({ dia: 3, sens: 90, target_high: 120, target_low: 100 }),
      { iob: 0 },
      now,
      settings,
    );
    expect(zero).toMatchObject({
      effect: 0,
      effectDisplay: 0,
      outcome: 100,
      outcomeDisplay: 100,
      bolusEstimate: 0,
      displayLine: "BWP: 0U",
    });

    const one = calculateBolusWizardPreview(
      [{ mgdl: 100, mills: before }, { mgdl: 100, mills: now }],
      [],
      profile({ dia: 3, sens: 50, target_high: 100, target_low: 50 }),
      { iob: 1 },
      now,
      settings,
    );
    expect(one).toMatchObject({
      effect: 50,
      effectDisplay: 50,
      outcome: 50,
      outcomeDisplay: 50,
      bolusEstimate: 0,
      displayLine: "BWP: 0U",
    });
  });

  it("preserves negative estimates and temp-basal preview percentages", () => {
    const result = calculateBolusWizardPreview(
      [{ mgdl: 100, mills: before }, { mgdl: 100, mills: now }],
      [{ insulin: "1.0", mills: now }],
      profile({ dia: 3, sens: 50, target_high: 200, target_low: 100, basal: 1 }),
      { iob: 1 },
      now,
      settings,
    );
    expect(result).toMatchObject({
      effect: 50,
      outcome: 50,
      bolusEstimate: -1,
      displayLine: "BWP: -1.00U",
      tempBasalAdjustment: { thirtymin: -100, onehour: 0 },
    });
  });

  it("preserves mmol scaling and floor-based insulin display", () => {
    const result = calculateBolusWizardPreview(
      [{ mgdl: 175, mills: before }, { mgdl: 153, mills: now }],
      [{ insulin: "0.45", mills: now }],
      profile({
        dia: 3,
        units: "mmol",
        sens: 9,
        target_high: 6,
        target_low: 5,
        basal: 0.125,
      }),
      { iob: 0.45 },
      now,
      { ...settings, units: "mmol" },
    );
    expect(result.effect).toBe(4.05);
    expect(result.outcome).toBe(4.45);
    expect(Math.round(result.bolusEstimate * 100)).toBe(-6);
    expect(result).toMatchObject({
      displayLine: "BWP: -0.07U",
      tempBasalAdjustment: { thirtymin: 2, onehour: 51 },
    });
  });

  it("returns the locked missing-profile, IOB, and stale-data errors", () => {
    expect(calculateBolusWizardPreview(
      [{ mgdl: 180, mills: now - 15 * 60_000 - 1 }],
      [],
      undefined,
      undefined,
      now,
      settings,
    ).errors).toEqual([
      "Missing need a treatment profile",
      "Missing IOB property",
      "Data isn't current",
    ]);
  });

  it("matches in-range, warning, urgent, and IOB-snooze notification branches", () => {
    const warningContext = context(
      [
        { mgdl: 175, direction: "FortyFiveUp", mills: before },
        { mgdl: 180, direction: "FortyFiveUp", mills: now },
      ],
      { dia: 3, sens: 90, target_high: 120, target_low: 100 },
    );
    const warningProperties = calculatePluginProperties(
      warningContext,
      "mg/dl",
      now,
      new Set(["bgnow", "direction", "ar2", "iob", "bwp"]),
      {},
      settings,
    );
    const warning = calculateBwpNotificationEvaluation(
      warningProperties.bwp as BwpProperty,
      createPluginProfileFunctions(warningContext),
      warningContext.sgvs,
      now,
      settings,
      {},
      warningProperties,
    );
    expect(warning.snoozes).toEqual([]);
    expect(warning.notifications).toEqual([expect.objectContaining({
      level: WARN,
      title: "Warning, Check BG, time to bolus?",
      message: "BG Now: 180 +5 ↗ mg/dl\nBG 15m: 187 mg/dl\nBWP: 0.66U",
      eventName: "bwp",
      pushoverSound: "bike",
      plugin: { name: "bwp", label: "Bolus Wizard Preview", pluginType: "pill-minor" },
      group: "default",
    })]);

    const urgentContext = context(
      [{ mgdl: 295, mills: before }, { mgdl: 300, mills: now }],
      { dia: 3, sens: 90, target_high: 120, target_low: 100 },
    );
    const urgentProperties = calculatePluginProperties(
      urgentContext,
      "mg/dl",
      now,
      new Set(["bgnow", "direction", "ar2", "iob", "bwp"]),
      {},
      settings,
    );
    expect(calculateBwpNotificationEvaluation(
      urgentProperties.bwp as BwpProperty,
      createPluginProfileFunctions(urgentContext),
      urgentContext.sgvs,
      now,
      settings,
      {},
      urgentProperties,
    ).notifications[0]).toMatchObject({ level: URGENT, pushoverSound: "updown" });

    const snoozeContext = context(
      [{ mgdl: 295, mills: before }, { mgdl: 300, mills: now }],
      { dia: 3, sens: 90, target_high: 120, target_low: 100 },
      [{ insulin: 5, mills: before }],
    );
    const snoozeProperties = calculatePluginProperties(
      snoozeContext,
      "mg/dl",
      now,
      new Set(["bgnow", "direction", "ar2", "iob", "bwp"]),
      {},
      settings,
    );
    expect(calculateBwpNotificationEvaluation(
      snoozeProperties.bwp as BwpProperty,
      createPluginProfileFunctions(snoozeContext),
      snoozeContext.sgvs,
      now,
      settings,
      {},
      snoozeProperties,
    )).toMatchObject({
      notifications: [],
      snoozes: [expect.objectContaining({
        level: URGENT,
        title: "Snoozing high alarm since there is enough IOB",
        lengthMills: 600_000,
      })],
    });
  });
});

describe("Workers BWP platform adaptation", () => {
  it("publishes BWP through the server property registry and API v2 summary", () => {
    const data = context(
      [{ mgdl: 175, mills: before }, { mgdl: 180, mills: now }],
      { dia: 3, sens: 90, target_high: 120, target_low: 100 },
    );
    const properties = calculatePluginProperties(
      data,
      "mg/dl",
      now,
      new Set(["bgnow", "ar2", "iob", "bwp"]),
      {},
      settings,
    );
    expect(properties.bwp).toMatchObject({
      bolusEstimateDisplay: "0.66",
      outcomeDisplay: 180,
    });
    expect(buildNightscoutSummary({
      sgvs: data.sgvs,
      treatments: [],
      profiles: data.profiles ?? [],
      devicestatus: [],
      cals: [],
      mbgs: [],
      food: [],
      dbstats: {},
    }, 6, now, properties).state).toMatchObject({ bwp: 0.67 });
  });

  it("maps the official BWP_* environment settings only when enabled", () => {
    const status = nightscoutStatus(new Date(now), "readable", tenantStatusSettings({
      ENABLE: "bwp iob",
      BWP_SNOOZE: "0.15",
      BWP_WARN: "0.60",
      BWP_URGENT: "1.20",
      BWP_SNOOZE_MINS: "12",
    }));
    expect(status.extendedSettings).toMatchObject({
      bwp: { snooze: 0.15, warn: 0.6, urgent: 1.2, snoozeMins: 12 },
    });
    expect(nightscoutStatus(new Date(now)).extendedSettings).not.toHaveProperty("bwp");
  });
});


describe("Nightscout 15.0.8 BWP alarm regression", () => {
  it.each([0, -1, undefined])("does not snooze a high alarm with IOB %s", (iob) => {
    const result = calculateBwpNotificationEvaluation(
      { effect: 0, outcome: 180, bolusEstimate: 0, scaledSGV: 180, iob },
      profile({ dia: 3, sens: 90, target_high: 200, target_low: 100 }),
      [{ mgdl: 180, mills: now }], now, settings,
    );
    expect(result.snoozes).toEqual([]);
  });

  it("does not emit or snooze alarms from an incomplete calculation", () => {
    for (const bolusEstimate of [0, 5]) {
      const result = calculateBwpNotificationEvaluation(
        { effect: 0, outcome: 300, bolusEstimate, scaledSGV: 300, iob: 1,
          errors: ["Data isn't current"] },
        profile({ dia: 3, sens: 90, target_high: 120, target_low: 100 }),
        [{ mgdl: 300, mills: now }], now, settings,
      );
      expect(result).toEqual({ notifications: [], snoozes: [] });
    }
  });
});
