import { describe, expect, it } from "vitest";
import {
  bgnowDeltaVisualization,
  calculateBgnowProperties,
} from "../src/plugins/bgnow";
import {
  calculateDirectionProperty,
  directionVisualization,
  nightscoutDirectionInfo,
} from "../src/plugins/direction";

const FIVE_MINUTES = 300_000;
const SIX_MINUTES = 360_000;

describe("locked Nightscout bgnow.test.js property plugin", () => {
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  const before = now - FIVE_MINUTES;

  it("calculates the exact mg/dl delta and visualization payload", () => {
    const properties = calculateBgnowProperties([
      { mills: before, mgdl: 100 },
      { mills: now, mgdl: 105 },
    ], now, "mg/dl");
    expect(properties.delta).toMatchObject({
      mgdl: 5,
      interpolated: false,
      scaled: 5,
      display: "+5",
    });
    expect(bgnowDeltaVisualization(properties.delta, "mg/dl")).toEqual({
      value: "+5",
      label: "mg/dl",
      info: null,
    });
  });

  it("interpolates an eleven-minute mg/dl gap into a five-minute delta", () => {
    const properties = calculateBgnowProperties([
      { mills: before - SIX_MINUTES, mgdl: 100 },
      { mills: now, mgdl: 105 },
    ], now, "mg/dl");
    expect(properties.delta).toMatchObject({
      mgdl: 2,
      interpolated: true,
      scaled: 2,
      display: "+2",
    });
    expect(bgnowDeltaVisualization(properties.delta, "mg/dl")).toEqual({
      value: "+2 *",
      label: "mg/dl",
      info: [
        { label: "Elapsed Time", value: "11 mins" },
        { label: "Absolute Delta", value: "5 mg/dl" },
        { label: "Interpolated", value: "103 mg/dl" },
      ],
    });
  });

  it("matches normal, zero, and interpolated mmol rounding and bucket positions", () => {
    const normal = calculateBgnowProperties([
      { mills: before, mgdl: 100 },
      { mills: now, mgdl: 105 },
    ], now, "mmol");
    expect(normal.bgnow).toMatchObject({ mean: 105, last: 105, mills: now });
    expect(normal.delta).toMatchObject({
      mgdl: 5,
      interpolated: false,
      scaled: 0.2,
      display: "+0.2",
    });
    expect(normal.buckets?.[0]).toMatchObject({ mean: 105 });
    expect(normal.buckets?.[1]).toMatchObject({ mean: 100 });

    const unchanged = calculateBgnowProperties([
      { mills: before, mgdl: 85 },
      { mills: now, mgdl: 85 },
    ], now, "mmol");
    expect(unchanged.delta).toMatchObject({
      mgdl: 0,
      interpolated: false,
      scaled: 0,
      display: "+0",
    });

    const interpolated = calculateBgnowProperties([
      { mills: before - SIX_MINUTES, mgdl: 100 },
      { mills: now, mgdl: 105 },
    ], now, "mmol");
    expect(interpolated.delta).toMatchObject({
      mgdl: 2,
      interpolated: true,
      scaled: 0.1,
      display: "+0.1",
    });
    expect(interpolated.buckets?.[0]).toMatchObject({ mean: 105 });
    expect(interpolated.buckets?.[1]).toMatchObject({ isEmpty: true });
    expect(interpolated.buckets?.[2]).toMatchObject({ mean: 100 });
  });
});

describe("locked Nightscout direction.test.js property plugin", () => {
  const now = Date.parse("2026-07-20T12:00:00.000Z");

  it("sets current Flat and DoubleUp properties and the locked pill label", () => {
    const flat = calculateDirectionProperty({ mills: now, direction: "Flat" }, now);
    expect(flat).toEqual({
      display: null,
      value: "Flat",
      label: "→",
      entity: "&#8594;",
    });
    expect(calculateDirectionProperty({ mills: now, direction: "DoubleUp" }, now))
      .toMatchObject({ value: "DoubleUp", label: "⇈", entity: "&#8648;" });
    expect(directionVisualization(flat, 100)).toEqual({
      label: "→&#xfe0e;",
      directHTML: true,
    });
  });

  it("maps every direction asserted by the locked upstream file", () => {
    const expected: Record<string, [string, string]> = {
      NONE: ["⇼", "&#8700;"],
      DoubleUp: ["⇈", "&#8648;"],
      SingleUp: ["↑", "&#8593;"],
      FortyFiveUp: ["↗", "&#8599;"],
      Flat: ["→", "&#8594;"],
      FortyFiveDown: ["↘", "&#8600;"],
      SingleDown: ["↓", "&#8595;"],
      DoubleDown: ["⇊", "&#8650;"],
      "NOT COMPUTABLE": ["-", "&#45;"],
      "RATE OUT OF RANGE": ["⇕", "&#8661;"],
    };
    for (const [direction, [label, entity]] of Object.entries(expected)) {
      expect(nightscoutDirectionInfo({ mills: now, direction })).toMatchObject({
        label,
        entity,
      });
    }
  });
});

it("normalizes legacy direction names and separators", () => {
  for (const [direction, value] of [["up", "SingleUp"], ["slide_down", "FortyFiveDown"], ["double-up", "DoubleUp"], ["NOT COMPUTABLE", "NOT COMPUTABLE"]]) {
    expect(nightscoutDirectionInfo({ mills: Date.now(), direction }).value).toBe(value);
  }
});
