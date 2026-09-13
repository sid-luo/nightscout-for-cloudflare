import { describe, expect, it } from "vitest";
import {
  createNightscoutProfileFunctions,
  type NightscoutProfileDocument,
} from "../src/profile-functions";

const NOW = Date.UTC(2015, 5, 22, 12, 0, 0);
const NOON = Date.UTC(2015, 5, 22, 12, 0, 0);
const THREE_PM = Date.UTC(2015, 5, 26, 15, 0, 0);

function oldProfileData(lowTarget = 95): NightscoutProfileDocument[] {
  return [{
    dia: 3,
    carbs_hr: 30,
    carbratio: 7,
    sens: 35,
    target_low: lowTarget,
    target_high: 120,
  }];
}

function complexProfileData(): NightscoutProfileDocument[] {
  return [{
    timezone: "UTC",
    sens: [
      { time: "00:00", value: 10 },
      { time: "02:00", value: 10 },
      { time: "07:00", value: 9 },
    ],
    dia: 3,
    carbratio: [
      { time: "00:00", value: 16 },
      { time: "06:00", value: 15 },
      { time: "14:00", value: 16 },
    ],
    carbs_hr: 30,
    startDate: "2015-06-21",
    basal: [
      { time: "00:00", value: 0.175 },
      { time: "02:30", value: 0.125 },
      { time: "05:00", value: 0.075 },
      { time: "08:00", value: 0.1 },
      { time: "14:00", value: 0.125 },
      { time: "20:00", value: 0.3 },
      { time: "22:00", value: 0.225 },
    ],
    target_low: 4.5,
    target_high: 8,
    units: "mmol",
  }];
}

function multiProfileData(): NightscoutProfileDocument[] {
  return [
    {
      startDate: "2015-06-25T00:00:00.000Z",
      defaultProfile: "20150625-1",
      store: {
        "20150625-1": {
          dia: "4",
          timezone: "UTC",
          startDate: "1970-01-01T00:00:00.000Z",
          sens: [
            { time: "00:00", value: 12 },
            { time: "02:00", value: 13 },
            { time: "07:00", value: 14 },
          ],
          carbratio: [
            { time: "00:00", value: 16 },
            { time: "06:00", value: 15 },
            { time: "14:00", value: 17 },
          ],
          carbs_hr: 30,
          target_low: 4.5,
          target_high: 8,
          units: "mmol",
          basal: [
            { time: "00:00", value: "0.5", timeAsSeconds: "0" },
            { time: "09:00", value: "0.25", timeAsSeconds: "32400" },
            { time: "12:30", value: "0.9", timeAsSeconds: "45000" },
            { time: "17:00", value: "0.3", timeAsSeconds: "61200" },
            { time: "20:00", value: "1", timeAsSeconds: "72000" },
          ],
        },
      },
      units: "mmol",
      mills: "1435190400000",
    },
    {
      startDate: "2015-06-21T00:00:00.000Z",
      defaultProfile: "20190621-1",
      store: {
        "20190621-1": {
          dia: "4",
          timezone: "UTC",
          startDate: "1970-01-01T00:00:00.000Z",
          sens: [
            { time: "00:00", value: 11 },
            { time: "02:00", value: 10 },
            { time: "07:00", value: 9 },
          ],
          carbratio: [
            { time: "00:00", value: 12 },
            { time: "06:00", value: 13 },
            { time: "14:00", value: 14 },
          ],
          carbs_hr: 35,
          target_low: 4.2,
          target_high: 9,
          units: "mmol",
          basal: [
            { time: "00:00", value: "0.3", timeAsSeconds: "0" },
            { time: "09:00", value: "0.4", timeAsSeconds: "32400" },
            { time: "12:30", value: "0.5", timeAsSeconds: "45000" },
            { time: "17:00", value: "0.6", timeAsSeconds: "61200" },
            { time: "23:00", value: "0.7", timeAsSeconds: "82800" },
          ],
        },
      },
      units: "mmol",
      mills: "1434844800000",
    },
  ];
}

describe("locked Nightscout v15.0.7 profile.test.js contract", () => {
  it("should say it does not have data before it has data", () => {
    const profile = createNightscoutProfileFunctions();
    profile.clear();
    expect(profile.hasData()).toBe(false);
  });

  it("should return undefined if asking for keys before init", () => {
    expect(createNightscoutProfileFunctions().getDIA(NOW)).toBeUndefined();
  });

  it("should return undefined if asking for missing keys", () => {
    expect(createNightscoutProfileFunctions().getSensitivity(NOW)).toBeUndefined();
  });

  it("should know what the DIA is with old style profiles", () => {
    expect(createNightscoutProfileFunctions(oldProfileData()).getDIA(NOW)).toBe(3);
  });

  it("should know what the DIA is with old style profiles, with missing date argument", () => {
    expect(createNightscoutProfileFunctions(oldProfileData()).getDIA()).toBe(3);
  });

  it("should know what the carbs_hr is with old style profiles", () => {
    expect(createNightscoutProfileFunctions(oldProfileData()).getCarbAbsorptionRate(NOW)).toBe(30);
  });

  it("should know what the carbratio is with old style profiles", () => {
    expect(createNightscoutProfileFunctions(oldProfileData()).getCarbRatio(NOW)).toBe(7);
  });

  it("should know what the sensitivity is with old style profiles", () => {
    expect(createNightscoutProfileFunctions(oldProfileData()).getSensitivity(NOW)).toBe(35);
  });

  it("should know what the low target is with old style profiles", () => {
    expect(createNightscoutProfileFunctions(oldProfileData()).getLowBGTarget(NOW)).toBe(95);
  });

  it("should know what the high target is with old style profiles", () => {
    expect(createNightscoutProfileFunctions(oldProfileData()).getHighBGTarget(NOW)).toBe(120);
  });

  it("should know how to reload data and still know what the low target is with old style profiles", () => {
    const profile = createNightscoutProfileFunctions(oldProfileData());
    profile.loadData(oldProfileData(50));
    expect(profile.getLowBGTarget(NOW)).toBe(50);
  });

  it("should return profile units when configured", () => {
    expect(createNightscoutProfileFunctions(complexProfileData()).getUnits()).toBe("mmol");
  });

  it("should know what the basal rate is at 12:00 with complex style profiles", () => {
    expect(createNightscoutProfileFunctions(complexProfileData()).getBasal(NOON)).toBe(0.1);
  });

  it("should know what the basal rate is at 15:00 with complex style profiles", () => {
    const atThreePm = Date.UTC(2015, 5, 22, 15, 0, 0);
    expect(createNightscoutProfileFunctions(complexProfileData()).getBasal(atThreePm)).toBe(0.125);
  });

  it("should know what the carbratio is at 12:00 with complex style profiles", () => {
    expect(createNightscoutProfileFunctions(complexProfileData()).getCarbRatio(NOON)).toBe(15);
  });

  it("should know what the sensitivity is at 12:00 with complex style profiles", () => {
    expect(createNightscoutProfileFunctions(complexProfileData()).getSensitivity(NOON)).toBe(9);
  });

  it("should return profile units when configured for multiple profiles", () => {
    expect(createNightscoutProfileFunctions(multiProfileData()).getUnits()).toBe("mmol");
  });

  it("should know what the basal rate is at 12:00 with multiple profiles", () => {
    expect(createNightscoutProfileFunctions(multiProfileData()).getBasal(NOON)).toBe(0.4);
  });

  it("should know what the basal rate is at 15:00 with multiple profiles", () => {
    expect(createNightscoutProfileFunctions(multiProfileData()).getBasal(THREE_PM)).toBe(0.9);
  });

  it("should know what the carbratio is at 12:00 with multiple profiles", () => {
    expect(createNightscoutProfileFunctions(multiProfileData()).getCarbRatio(NOON)).toBe(13);
  });

  it("should know what the carbratio is at 15:00 with multiple profiles", () => {
    expect(createNightscoutProfileFunctions(multiProfileData()).getCarbRatio(THREE_PM)).toBe(17);
  });

  it("should know what the sensitivity is at 12:00 with multiple profiles", () => {
    expect(createNightscoutProfileFunctions(multiProfileData()).getSensitivity(NOON)).toBe(9);
  });

  it("should know what the sensitivity is at 15:00 with multiple profiles", () => {
    expect(createNightscoutProfileFunctions(multiProfileData()).getSensitivity(THREE_PM)).toBe(14);
  });

  it("should select the correct profile for 15:00 with multiple profiles", () => {
    expect(createNightscoutProfileFunctions(multiProfileData()).getCurrentProfile(THREE_PM).carbs_hr)
      .toBe(30);
  });
});

describe('15.0.8 profile offset timezones', () => {
  it.each([
    ['GMT+4', 'Etc/GMT-4'], ['UTC+2', 'Etc/GMT-2'], ['GMT-5', 'Etc/GMT+5'],
    ['ETC/GMT+5', 'Etc/GMT+5'], ['GMT+0', 'Etc/GMT-0'], ['GMT-0', 'Etc/GMT+0'],
    ['GMT+12', 'Etc/GMT-12'], ['GMT+5:30', '+05:30'], ['GMT-3:30', '-03:30'],
    ['GMT+5:45', '+05:45'], ['UTC+9:30', '+09:30'], ['GMT+5:00', 'Etc/GMT-5'],
    ['GMT+5:60', 'GMT+5:60'], ['Asia/Shanghai', 'Asia/Shanghai'], ['UTC', 'UTC'],
  ])('normalizes %s to %s', (timezone, normalized) => {
    expect(createNightscoutProfileFunctions([{timezone}]).getTimezone()).toBe(normalized);
  });
  it.each([
    ['GMT+5:30', '2026-09-07T18:29:00Z', '2026-09-07T18:30:00Z'],
    ['GMT+5:45', '2026-09-07T18:14:00Z', '2026-09-07T18:15:00Z'],
    ['GMT-3:30', '2026-09-08T03:29:00Z', '2026-09-08T03:30:00Z'],
    ['GMT+4', '2026-09-07T19:59:00Z', '2026-09-07T20:00:00Z'],
  ])('uses the correct schedule on both sides of local midnight for %s', (timezone,before,after) => {
    const p=createNightscoutProfileFunctions([{timezone,basal:[
      {time:'00:00',timeAsSeconds:0,value:0.5},
      {time:'23:00',timeAsSeconds:82800,value:1},
    ]}]);
    expect(p.getBasal(Date.parse(before))).toBe(1);
    expect(p.getBasal(Date.parse(after))).toBe(0.5);
  });
});
