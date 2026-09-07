import type { NightscoutProfileFunctions } from "../profile-functions";
import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import { URGENT, WARN, levelToDisplay } from "../runtime/levels";
import { nightscoutTimes } from "../runtime/times";
import { mgdlToMMOL, mmolToMgdl } from "../runtime/units";
import type { NightscoutGlucoseUnits } from "./bgnow";

const BWP_PLUGIN = {
  name: "bwp",
  label: "Bolus Wizard Preview",
  pluginType: "pill-minor",
} as const;

export interface BwpSettings extends Record<string, unknown> {
  units?: unknown;
  thresholds?: Record<string, unknown>;
}

export interface BwpPreferences extends Record<string, unknown> {
  snooze?: unknown;
  warn?: unknown;
  urgent?: unknown;
  snoozeMins?: unknown;
}

export interface BwpProperty extends RealtimeDocument {
  effect: number;
  outcome: number;
  bolusEstimate: number;
  scaledSGV?: number;
}

export interface BwpNotificationEvaluation {
  notifications: RealtimeDocument[];
  snoozes: RealtimeDocument[];
}

function record(value: unknown): RealtimeDocument | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RealtimeDocument
    : undefined;
}

function latestSgv(
  sgvs: RealtimeDocument[],
  now: number,
): RealtimeDocument | undefined {
  for (let index = sgvs.length - 1; index >= 0; index -= 1) {
    const entry = sgvs[index];
    if (entry !== undefined && Number(entry.mills) <= now) return entry;
  }
  return undefined;
}

function units(settings: BwpSettings): NightscoutGlucoseUnits {
  return settings.units === "mmol" ? "mmol" : "mg/dl";
}

function scaleMgdl(value: unknown, settings: BwpSettings): number {
  return units(settings) === "mmol" && value
    ? Number(mgdlToMMOL(value as number | string))
    : Number(value);
}

function scaleEntry(entry: RealtimeDocument, settings: BwpSettings): number {
  if (entry.scaled !== undefined) return Number(entry.scaled);
  return units(settings) === "mmol"
    ? Number(entry.mmol || mgdlToMMOL(entry.mgdl as number | string))
    : Number(entry.mgdl || mmolToMgdl(entry.mmol as number | string));
}

function roundInsulin(value: number, roundingStyle: unknown): string {
  if (value === 0) return "0";
  if (roundingStyle === "medtronic") {
    const denominator = value <= 0.5 ? 0.05 : 0.1;
    const digits = value <= 0.5 ? 2 : 1;
    const multiplier = 1 / denominator;
    return (Math.floor(value * multiplier + 1e-9) / multiplier).toFixed(digits);
  }
  return (Math.floor(value * 100 + 1e-9) / 100).toFixed(2);
}

function roundBg(value: number, settings: BwpSettings): number {
  return units(settings) === "mmol" ? Math.round(value * 10) / 10 : Math.round(value);
}

function currentSgvIsUsable(
  entry: RealtimeDocument | undefined,
  now: number,
): boolean {
  return entry !== undefined
    && Number(entry.mgdl) >= 39
    && now - Number(entry.mills) <= nightscoutTimes.mins(15).msecs;
}

/**
 * Direct request-local port of locked v15.0.7 boluswizardpreview.calc().
 * This is an opt-in compatibility calculation; it does not change the
 * upstream formula, infer a dose, or execute any treatment action.
 */
export function calculateBolusWizardPreview(
  sgvs: RealtimeDocument[],
  treatments: RealtimeDocument[],
  profile: NightscoutProfileFunctions | undefined,
  iobProperty: RealtimeDocument | undefined,
  now: number,
  settings: BwpSettings = {},
  roundingStyle?: unknown,
): BwpProperty {
  const result: BwpProperty = {
    effect: 0,
    outcome: 0,
    bolusEstimate: 0,
    bolusEstimateDisplay: "0",
    outcomeDisplay: "0",
    displayIOB: "0",
    effectDisplay: "0",
    displayLine: "BWP: 0U",
  };
  const current = latestSgv(sgvs, now);
  if (current !== undefined) result.scaledSGV = scaleEntry(current, settings);

  const errors: string[] = [];
  if (profile === undefined || !profile.hasData()) {
    errors.push("Missing need a treatment profile");
  } else if (
    !profile.getSensitivity(now)
    || !profile.getHighBGTarget(now)
    || !profile.getLowBGTarget(now)
  ) {
    errors.push("Missing sens, target_high, or target_low treatment profile fields");
  }
  if (iobProperty === undefined) errors.push("Missing IOB property");
  if (!currentSgvIsUsable(current, now)) errors.push("Data isn't current");
  if (errors.length > 0) {
    result.errors = errors;
    return result;
  }

  const availableProfile = profile!;
  const scaled = result.scaledSGV!;
  const iob = Number(iobProperty!.iob || 0);
  result.iob = iob;
  const sensitivity = Number(availableProfile.getSensitivity(now));
  result.effect = iob * sensitivity;
  result.outcome = scaled - result.effect;

  let recentCarbs: RealtimeDocument | undefined;
  for (let index = treatments.length - 1; index >= 0; index -= 1) {
    const treatment = treatments[index];
    if (
      treatment !== undefined
      && Number(treatment.mills) <= now
      && now - Number(treatment.mills) < nightscoutTimes.mins(60).msecs
      && Number(treatment.carbs) > 0
    ) {
      recentCarbs = treatment;
      break;
    }
  }
  result.recentCarbs = recentCarbs;

  const highTarget = Number(availableProfile.getHighBGTarget(now));
  if (result.outcome > highTarget) {
    result.bolusEstimate = (result.outcome - highTarget) / sensitivity;
    result.aimTarget = highTarget;
    result.aimTargetString = "above high";
  }

  const lowTarget = Number(availableProfile.getLowBGTarget(now));
  result.belowLowTarget = scaled < lowTarget;
  if (result.outcome < lowTarget) {
    result.bolusEstimate = Math.abs(result.outcome - lowTarget) / sensitivity * -1;
    result.aimTarget = lowTarget;
    result.aimTargetString = "below low";
  }

  const basal = availableProfile.getBasal(now);
  if (result.bolusEstimate !== 0 && basal) {
    result.tempBasalAdjustment = {
      thirtymin: Math.round((basal / 2 + result.bolusEstimate) / (basal / 2) * 100),
      onehour: Math.round((basal + result.bolusEstimate) / basal * 100),
    };
  }

  result.bolusEstimateDisplay = roundInsulin(result.bolusEstimate, roundingStyle);
  result.outcomeDisplay = roundBg(result.outcome, settings);
  result.displayIOB = roundInsulin(iob, roundingStyle);
  result.effectDisplay = roundBg(result.effect, settings);
  result.displayLine = `BWP: ${String(result.bolusEstimateDisplay)}U`;
  return result;
}

function propertyLine(properties: Record<string, unknown>, name: string): string | undefined {
  const line = record(properties[name])?.displayLine;
  return typeof line === "string" && line.length > 0 ? line : undefined;
}

function defaultMessage(
  sgvs: RealtimeDocument[],
  now: number,
  settings: BwpSettings,
  properties: Record<string, unknown>,
): string {
  const current = latestSgv(sgvs, now);
  let first = "BG Now: undefined";
  if (current !== undefined) {
    const displayed = Number(current.mgdl) === 39
      ? "LOW"
      : Number(current.mgdl) === 401
        ? "HIGH"
        : String(scaleEntry(current, settings));
    first = `BG Now: ${displayed}`;
  }
  const delta = record(properties.delta)?.display;
  if (delta) first += ` ${String(delta)}`;
  const direction = record(properties.direction)?.label;
  if (direction) first += ` ${String(direction)}`;
  first += units(settings) === "mmol" ? " mmol/L" : " mg/dl";
  const lines = [first];
  for (const name of ["rawbg", "ar2", "bwp", "iob", "cob"]) {
    const line = propertyLine(properties, name);
    if (line !== undefined) lines.push(line);
  }
  return lines.join("\n");
}

/** Direct request-local port of locked boluswizardpreview.checkNotifications(). */
export function calculateBwpNotificationEvaluation(
  property: BwpProperty | undefined,
  profile: NightscoutProfileFunctions | undefined,
  sgvs: RealtimeDocument[],
  now: number,
  settings: BwpSettings = {},
  preferences: BwpPreferences = {},
  properties: Record<string, unknown> = {},
): BwpNotificationEvaluation {
  const result: BwpNotificationEvaluation = { notifications: [], snoozes: [] };
  if (property === undefined
    || (Array.isArray(property.errors) && property.errors.length > 0)) return result;
  const snoozeBwp = Number(preferences.snooze) || 0.10;
  const warnBwp = Number(preferences.warn) || 0.50;
  const urgentBwp = Number(preferences.urgent) || 1;
  const snoozeLength = preferences.snoozeMins
    ? Number(preferences.snoozeMins) * 60_000
    : nightscoutTimes.mins(10).msecs;
  const thresholds = record(settings.thresholds) ?? {};
  const high = record(properties.ar2)?.eventType === "high"
    || Number(property.scaledSGV) >= scaleMgdl(thresholds.bgTargetTop, settings);

  if (high && Number(property.iob) > 0 && Number(property.bolusEstimate) < snoozeBwp) {
    result.snoozes.push({
      level: URGENT,
      title: "Snoozing high alarm since there is enough IOB",
      message: [propertyLine(properties, "bwp"), propertyLine(properties, "iob")]
        .join("\n"),
      lengthMills: snoozeLength,
      debug: property,
      group: "default",
    });
    return result;
  }

  const highTarget = profile?.getHighBGTarget(now);
  if (
    highTarget !== undefined
    && Number(property.scaledSGV) > highTarget
    && Number(property.bolusEstimate) > warnBwp
  ) {
    const level = Number(property.bolusEstimate) > urgentBwp ? URGENT : WARN;
    result.notifications.push({
      level,
      title: `${levelToDisplay(level)}, Check BG, time to bolus?`,
      message: defaultMessage(sgvs, now, settings, properties),
      eventName: "bwp",
      pushoverSound: level === URGENT ? "updown" : "bike",
      plugin: BWP_PLUGIN,
      debug: property,
      group: "default",
    });
  }
  return result;
}
