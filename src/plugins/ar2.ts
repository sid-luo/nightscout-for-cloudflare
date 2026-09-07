import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import { INFO, URGENT, WARN, levelToDisplay } from "../runtime/levels";
import { nightscoutTimes } from "../runtime/times";
import { mgdlToMMOL, mmolToMgdl } from "../runtime/units";
import { calculateBgnowProperties, type NightscoutGlucoseUnits } from "./bgnow";

const BG_REFERENCE = 140;
const BG_MINIMUM = 36;
const BG_MAXIMUM = 400;
const WARNING_THRESHOLD = 0.05;
const URGENT_THRESHOLD = 0.10;
const AR = [-0.723, 1.716] as const;
const AR2_COLOR = "cyan";
const CONE_STEPS = [
  0.020, 0.041, 0.061, 0.081, 0.099, 0.116, 0.132,
  0.146, 0.159, 0.171, 0.182, 0.192, 0.201,
] as const;

const AR2_PLUGIN = {
  name: "ar2",
  label: "AR2",
  pluginType: "forecast",
} as const;

export interface Ar2Settings extends Record<string, unknown> {
  units?: unknown;
  thresholds?: Record<string, unknown>;
  alarmHigh?: unknown;
  alarmLow?: unknown;
}

export interface Ar2Forecast {
  predicted: RealtimeDocument[];
  avgLoss: number;
}

export interface Ar2Property extends RealtimeDocument {
  forecast: Ar2Forecast;
  level?: number;
  eventName?: string;
  displayLine?: string;
}

export interface Ar2RequestOptions {
  direction?: RealtimeDocument;
  propertyLines?: Partial<Record<"rawbg" | "bwp" | "iob" | "cob", string>>;
}

interface Ar2Accumulator {
  forecastTime: number;
  points: RealtimeDocument[];
  prev: number;
  curr: number;
}

function glucoseUnits(settings: Ar2Settings): NightscoutGlucoseUnits {
  return settings.units === "mmol" ? "mmol" : "mg/dl";
}

function unitsLabel(settings: Ar2Settings): string {
  return glucoseUnits(settings) === "mmol" ? "mmol/L" : "mg/dl";
}

function scaleMgdl(value: unknown, settings: Ar2Settings): number {
  return glucoseUnits(settings) === "mmol" && value
    ? Number(mgdlToMMOL(value as number | string))
    : Number(value);
}

function scaleEntry(entry: RealtimeDocument, settings: Ar2Settings): number {
  if (entry.scaled !== undefined) return Number(entry.scaled);
  return glucoseUnits(settings) === "mmol"
    ? Number(entry.mmol || mgdlToMMOL(entry.mgdl as number | string))
    : Number(entry.mgdl || mmolToMgdl(entry.mmol as number | string));
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

function ar2Context(
  sgvs: RealtimeDocument[],
  now: number,
  settings: Ar2Settings,
): { bgnow: RealtimeDocument; delta: RealtimeDocument | null } {
  const properties = calculateBgnowProperties(sgvs, now, glucoseUnits(settings));
  return { bgnow: properties.bgnow, delta: properties.delta };
}

function canForecast(
  context: { bgnow: RealtimeDocument; delta: RealtimeDocument | null },
): context is { bgnow: RealtimeDocument; delta: RealtimeDocument } {
  return Number(context.bgnow.mean) >= BG_MINIMUM
    && typeof context.delta?.mean5MinsAgo === "number"
    && !Number.isNaN(context.delta.mean5MinsAgo);
}

function initializeAr2(
  context: { bgnow: RealtimeDocument; delta: RealtimeDocument },
  now: number,
): Ar2Accumulator {
  return {
    forecastTime: Number(context.bgnow.mills) || now,
    points: [],
    prev: Math.log(Number(context.delta.mean5MinsAgo) / BG_REFERENCE),
    curr: Math.log(Number(context.bgnow.mean) / BG_REFERENCE),
  };
}

function incrementAr2(result: Ar2Accumulator): Ar2Accumulator {
  return {
    forecastTime: result.forecastTime + nightscoutTimes.mins(5).msecs,
    points: result.points,
    prev: result.curr,
    curr: AR[0] * result.prev + AR[1] * result.curr,
  };
}

function ar2Point(
  next: Ar2Accumulator,
  options: { offset?: number; coneFactor?: number; step?: number } = {},
): RealtimeDocument {
  const step = options.step || 0;
  const coneFactor = options.coneFactor || 0;
  const offset = options.offset || 0;
  const mgdl = Math.round(BG_REFERENCE * Math.exp(next.curr + coneFactor * step));
  return {
    mills: next.forecastTime + offset,
    mgdl: Math.max(BG_MINIMUM, Math.min(BG_MAXIMUM, mgdl)),
    color: AR2_COLOR,
  };
}

/** Direct request-local port of locked ar2.forecast(). */
export function calculateAr2Forecast(
  sgvs: RealtimeDocument[],
  now: number,
  settings: Ar2Settings = {},
): Ar2Forecast {
  const result: Ar2Forecast = { predicted: [], avgLoss: 0 };
  const context = ar2Context(sgvs, now, settings);
  if (!canForecast(context)) return result;

  let accumulator = initializeAr2(context, now);
  for (let index = 0; index < 6; index += 1) {
    accumulator = incrementAr2(accumulator);
    accumulator.points.push(ar2Point(accumulator, { offset: 2_000 }));
  }
  result.predicted = accumulator.points;

  // Preserve the locked inclusive loop and its size divisor exactly. It uses
  // six samples divided by five; changing that would change alarm thresholds.
  const size = Math.min(result.predicted.length - 1, 6);
  for (let index = 0; index <= size; index += 1) {
    result.avgLoss += 1 / size
      * Math.pow(Math.log(Number(result.predicted[index]!.mgdl) / 120) / Math.LN10, 2);
  }
  return result;
}

/** Direct request-local port of locked ar2.forecastCone(). */
export function calculateAr2ForecastCone(
  sgvs: RealtimeDocument[],
  now: number,
  settings: Ar2Settings = {},
  extendedSettings: Record<string, unknown> = {},
): RealtimeDocument[] {
  const context = ar2Context(sgvs, now, settings);
  if (!canForecast(context)) return [];
  let coneFactor = Number(extendedSettings.coneFactor);
  if (Number.isNaN(coneFactor) || coneFactor < 0) coneFactor = 2;

  let accumulator = initializeAr2(context, now);
  for (const step of CONE_STEPS) {
    accumulator = incrementAr2(accumulator);
    if (coneFactor > 0) {
      accumulator.points.push(ar2Point(accumulator, {
        offset: 2_000,
        coneFactor: -coneFactor,
        step,
      }));
    }
    accumulator.points.push(ar2Point(accumulator, {
      offset: 4_000,
      coneFactor,
      step,
    }));
  }
  return accumulator.points;
}

function forecastAlarm(
  forecast: Ar2Forecast,
  settings: Ar2Settings,
): { level: number; eventName: string } | null {
  let level = INFO;
  if (forecast.avgLoss > URGENT_THRESHOLD) level = URGENT;
  else if (forecast.avgLoss > WARNING_THRESHOLD) level = WARN;
  if (level === INFO) return null;

  const predicted = forecast.predicted.map((point) => scaleEntry(point, settings));
  const inTwentyMinutes = predicted.length >= 4 ? predicted[3] : undefined;
  const thresholds = settings.thresholds ?? {};
  let eventName = "";
  if (
    inTwentyMinutes !== undefined
    && Boolean(settings.alarmHigh ?? true)
    && inTwentyMinutes > scaleMgdl(thresholds.bgTargetTop ?? 180, settings)
  ) {
    eventName = "high";
  } else if (
    inTwentyMinutes !== undefined
    && Boolean(settings.alarmLow ?? true)
    && inTwentyMinutes < scaleMgdl(thresholds.bgTargetBottom ?? 80, settings)
  ) {
    eventName = "low";
  }
  return { level, eventName };
}

/** Direct request-local port of locked ar2.setProperties(). */
export function calculateAr2Property(
  sgvs: RealtimeDocument[],
  now: number,
  settings: Ar2Settings = {},
): Ar2Property {
  const forecast = calculateAr2Forecast(sgvs, now, settings);
  const property: Ar2Property = { forecast };
  const alarm = forecastAlarm(forecast, settings);
  if (alarm !== null) {
    property.level = alarm.level;
    property.eventName = alarm.eventName;
  }
  const predicted = forecast.predicted.map((point) => scaleEntry(point, settings));
  if (predicted.length >= 3) {
    property.displayLine = `BG 15m: ${predicted[2]} ${unitsLabel(settings)}`;
  }
  return property;
}

function displayBg(entry: RealtimeDocument, settings: Ar2Settings): string {
  if (Number(entry.mgdl) === 39) return "LOW";
  if (Number(entry.mgdl) === 401) return "HIGH";
  return String(scaleEntry(entry, settings));
}

function buildMessage(
  sgvs: RealtimeDocument[],
  now: number,
  settings: Ar2Settings,
  property: Ar2Property,
  options: Ar2RequestOptions,
): string {
  const current = latestSgv(sgvs, now)!;
  const context = ar2Context(sgvs, now, settings);
  let firstLine = `BG Now: ${displayBg(current, settings)}`;
  if (context.delta?.display) firstLine += ` ${String(context.delta.display)}`;
  if (options.direction?.label) firstLine += ` ${String(options.direction.label)}`;
  firstLine += ` ${unitsLabel(settings)}`;
  const lines = [firstLine];
  if (options.propertyLines?.rawbg) lines.push(options.propertyLines.rawbg);
  if (property.displayLine) lines.push(property.displayLine);
  if (options.propertyLines?.bwp) lines.push(options.propertyLines.bwp);
  if (options.propertyLines?.iob) lines.push(options.propertyLines.iob);
  if (options.propertyLines?.cob) lines.push(options.propertyLines.cob);
  return lines.join("\n");
}

/** Direct request-local port of locked ar2.checkNotifications(). */
export function calculateAr2NotificationRequest(
  sgvs: RealtimeDocument[],
  now: number,
  settings: Ar2Settings = {},
  options: Ar2RequestOptions = {},
): RealtimeDocument | null {
  const current = latestSgv(sgvs, now);
  if (current === undefined || now - Number(current.mills) > nightscoutTimes.mins(10).msecs) {
    return null;
  }
  const property = calculateAr2Property(sgvs, now, settings);
  if (property.level === undefined) return null;
  const thresholds = settings.thresholds ?? {};
  const currentScaled = scaleEntry(current, settings);
  const inTarget = currentScaled > scaleMgdl(thresholds.bgTargetBottom ?? 80, settings)
    && currentScaled < scaleMgdl(thresholds.bgTargetTop ?? 180, settings);
  const rangeLabel = property.eventName ? property.eventName.toUpperCase() : "Check BG";
  const title = `${levelToDisplay(property.level)}, ${rangeLabel}${inTarget ? " predicted" : ""}`;
  const pushoverSound = property.level === URGENT
    ? "persistent"
    : property.eventName === "low"
      ? "falling"
      : property.eventName === "high"
        ? "climb"
        : undefined;
  const predicted = property.forecast.predicted.map((point) => scaleEntry(point, settings));
  return {
    level: property.level,
    title,
    message: buildMessage(sgvs, now, settings, property, options),
    eventName: property.eventName,
    pushoverSound,
    plugin: AR2_PLUGIN,
    debug: {
      forecast: {
        avgLoss: property.forecast.avgLoss,
        predicted: predicted.join(", "),
      },
    },
    group: "default",
  };
}

/** Locked English virtual-assistant contract without Node moment state. */
export function calculateAr2VirtualAssistant(
  sgvs: RealtimeDocument[],
  now: number,
  settings: Ar2Settings = {},
): { title: string; response: string } {
  const forecast = calculateAr2Forecast(sgvs, now, settings).predicted;
  if (forecast.length === 0) return { title: "AR2 Forecast", response: "Unknown" };
  const values = forecast.map((point) => Number(point.mgdl));
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const horizon = Math.max(...forecast.map((point) => Number(point.mills)));
  const minutes = Math.round((horizon - now) / nightscoutTimes.min().msecs);
  const relative = `in ${minutes} minutes`;
  return {
    title: "AR2 Forecast",
    response: minimum === maximum
      ? `According to the AR2 forecast you are expected to be around ${maximum} over the next ${relative}`
      : `According to the AR2 forecast you are expected to be between ${minimum} and ${maximum} over the next ${relative}`,
  };
}
