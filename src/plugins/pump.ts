import { profileTimezoneFormatter } from "../runtime/timezone";
import type { NightscoutProfileFunctions } from "../profile-functions";
import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import { NONE, URGENT, WARN, levelToStatusClass } from "../runtime/levels";
import { nightscoutTimes } from "../runtime/times";
import { findOpenApsOfflineMarker } from "./openaps";
import { calculateTimeAgoDisplay } from "./timeago";

export interface PumpPreferences extends Record<string, unknown> {
  fields?: unknown;
  retroFields?: unknown;
  warnClock?: unknown;
  urgentClock?: unknown;
  warnRes?: unknown;
  urgentRes?: unknown;
  warnBattV?: unknown;
  urgentBattV?: unknown;
  warnBattP?: unknown;
  urgentBattP?: unknown;
  warnOnSuspend?: unknown;
  enableAlerts?: unknown;
  warnBattQuietNight?: unknown;
}

export interface PumpCoreSettings extends Record<string, unknown> {
  dayStart?: unknown;
  dayEnd?: unknown;
}

export interface PumpProperty extends RealtimeDocument {
  data: RealtimeDocument;
}

export interface PumpVisualization {
  value: string;
  info: RealtimeDocument[];
  label: "Pump";
  pillClass: "current" | "warn" | "urgent";
}

export const PUMP_INTENTS = [
  { intent: "InsulinRemaining" },
  { intent: "PumpBattery" },
  { intent: "MetricNow", metrics: ["pump reservoir"] },
  { intent: "MetricNow", metrics: ["pump battery"] },
] as const;

const PUMP_PLUGIN = {
  name: "pump",
  label: "Pump",
  pluginType: "pill-status",
} as const;

const ALL_STATUS_FIELDS = ["reservoir", "battery", "clock", "status", "device"] as const;

function document(value: unknown): RealtimeDocument | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RealtimeDocument
    : undefined;
}

function cloneDocument(value: RealtimeDocument): RealtimeDocument {
  return JSON.parse(JSON.stringify(value)) as RealtimeDocument;
}

function dateMills(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  return Date.parse(value);
}

function isoMoment(value: unknown): string | null {
  const mills = dateMills(value);
  return Number.isFinite(mills) ? new Date(mills).toISOString() : null;
}

function cleanList(value: unknown): string[] {
  return decodeURIComponent(String(value || "")).toLowerCase().split(" ");
}

function emptyList(value: string[]): boolean {
  return value.length === 0 || value[0] === "";
}

function normalizedPreferences(
  preferences: PumpPreferences,
  profile?: NightscoutProfileFunctions,
): {
  fields: string[];
  retroFields: string[];
  warnClock: number;
  urgentClock: number;
  warnRes: number;
  urgentRes: number;
  warnBattV: number;
  urgentBattV: number;
  warnBattP: number;
  urgentBattP: number;
  warnOnSuspend: unknown;
  enableAlerts: unknown;
  warnBattQuietNight: unknown;
} {
  const fields = cleanList(preferences.fields);
  const retroFields = cleanList(preferences.retroFields);
  let warnBattQuietNight = preferences.warnBattQuietNight;
  if (warnBattQuietNight && (!profile || !profile.hasData() || !profile.getTimezone())) {
    warnBattQuietNight = false;
  }
  return {
    fields: emptyList(fields) ? ["reservoir"] : fields,
    retroFields: emptyList(retroFields) ? ["reservoir", "battery"] : retroFields,
    warnClock: Number(preferences.warnClock || 30),
    urgentClock: Number(preferences.urgentClock || 60),
    warnRes: Number(preferences.warnRes || 10),
    urgentRes: Number(preferences.urgentRes || 5),
    warnBattV: Number(preferences.warnBattV || 1.35),
    urgentBattV: Number(preferences.urgentBattV || 1.3),
    warnBattP: Number(preferences.warnBattP || 30),
    urgentBattP: Number(preferences.urgentBattP || 20),
    warnOnSuspend: preferences.warnOnSuspend || false,
    enableAlerts: preferences.enableAlerts || false,
    warnBattQuietNight: warnBattQuietNight || false,
  };
}

function formatAgo(value: unknown, now: number): string {
  const display = calculateTimeAgoDisplay({ mills: dateMills(value) }, now);
  return `${display.value ? display.value : ""}${display.shortLabel}${
    display.shortLabel.length === 1 ? " ago" : ""
  }`;
}

function timezoneHour(now: number, timezone: string | undefined): number {
  if (!timezone) {
    const date = new Date(now);
    return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  }
  try {
    const parts = profileTimezoneFormatter("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }, timezone).formatToParts(new Date(now));
    const read = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((part) => part.type === type)?.value ?? 0);
    return read("hour") + read("minute") / 60 + read("second") / 3600;
  } catch {
    const date = new Date(now);
    return date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  }
}

function statusField(result: RealtimeDocument, name: string): RealtimeDocument | undefined {
  return document(result[name]);
}

/** Direct pure port of the locked pump prepareData() helper. */
export function preparePumpData(
  property: RealtimeDocument,
  treatments: RealtimeDocument[],
  profile: NightscoutProfileFunctions | undefined,
  now: number,
  preferences: PumpPreferences = {},
  settings: PumpCoreSettings = {},
): RealtimeDocument {
  const prefs = normalizedPreferences(preferences, profile);
  const rawPump = document(property.pump) ?? {};
  const timezone = profile?.getTimezone();
  const localHour = timezoneHour(now, timezone);
  const dayStart = Number(settings.dayStart ?? 7);
  const dayEnd = Number(settings.dayEnd ?? 21);
  const batteryWarn = !(prefs.warnBattQuietNight && (localHour < dayStart || localHour > dayEnd));
  const reservoirPresent = rawPump.reservoir || rawPump.reservoir === 0;
  const result: RealtimeDocument = {
    level: NONE,
    clock: rawPump.clock ? { value: isoMoment(rawPump.clock) } : null,
    reservoir: reservoirPresent ? { value: rawPump.reservoir } : null,
    reservoir_display_override: rawPump.reservoir_display_override || null,
    reservoir_level_override: rawPump.reservoir_level_override || null,
    manufacturer: rawPump.manufacturer,
    model: rawPump.model,
    extended: rawPump.extended || null,
  };

  const clock = statusField(result, "clock");
  if (clock !== undefined) {
    clock.label = "Last Clock";
    clock.display = formatAgo(clock.value, now);
    const mills = dateMills(clock.value);
    if (now - nightscoutTimes.mins(prefs.urgentClock).msecs > mills) {
      clock.level = URGENT;
      clock.message = "URGENT: Pump data stale";
    } else if (now - nightscoutTimes.mins(prefs.warnClock).msecs > mills) {
      clock.level = WARN;
      clock.message = "Warning, Pump data stale";
    } else clock.level = NONE;
  }

  let reservoir = statusField(result, "reservoir");
  if (reservoir !== undefined) {
    reservoir.label = "Reservoir";
    reservoir.display = `${Number(reservoir.value).toPrecision(3)}U`;
    if (Number(reservoir.value) < prefs.urgentRes) {
      reservoir.level = URGENT;
      reservoir.message = "URGENT: Pump Reservoir Low";
    } else if (Number(reservoir.value) < prefs.warnRes) {
      reservoir.level = WARN;
      reservoir.message = "Warning, Pump Reservoir Low";
    } else reservoir.level = NONE;
  } else if (result.manufacturer === "Insulet") {
    result.reservoir = { label: "Reservoir", display: "50+ U" };
    reservoir = statusField(result, "reservoir");
  }
  if (result.reservoir_display_override && reservoir !== undefined) {
    reservoir.display = result.reservoir_display_override;
  }
  if (result.reservoir_level_override && reservoir !== undefined) {
    reservoir.level = result.reservoir_level_override;
  }

  const rawStatus = document(rawPump.status);
  if (rawStatus !== undefined) {
    let status = rawStatus.status || "normal";
    if (rawStatus.bolusing) status = "bolusing";
    else if (rawStatus.suspended) status = "suspended";
    // Keep the locked shadowing quirk: warnOnSuspend is read from the uploaded
    // pump object, not from prefs, so ordinary uploads do not gain new logic.
    const preparedStatus: RealtimeDocument = { value: status, display: status, label: "Status" };
    if (rawStatus.suspended && rawPump.warnOnSuspend) {
      preparedStatus.level = WARN;
      preparedStatus.message = "Pump Suspended";
    }
    result.status = preparedStatus;
  }

  const rawBattery = document(rawPump.battery);
  let battery: RealtimeDocument | undefined;
  let batteryType: "%" | "v" | undefined;
  if (rawBattery?.percent) {
    battery = { value: rawBattery.percent, unit: "percent" };
    batteryType = "%";
  } else if (rawBattery?.voltage) {
    battery = { value: rawBattery.voltage, unit: "volts" };
    batteryType = "v";
  }
  if (battery !== undefined && batteryType !== undefined) {
    battery.label = "Battery";
    battery.display = `${String(battery.value)}${batteryType}`;
    const urgent = batteryType === "v" ? prefs.urgentBattV : prefs.urgentBattP;
    const warn = batteryType === "v" ? prefs.warnBattV : prefs.warnBattP;
    if (Number(battery.value) < urgent && batteryWarn) {
      battery.level = URGENT;
      battery.message = "URGENT: Pump Battery Low";
    } else if (Number(battery.value) < warn && batteryWarn) {
      battery.level = WARN;
      battery.message = "Warning, Pump Battery Low";
    } else battery.level = NONE;
    result.battery = battery;
  }

  result.device = { label: "Device", display: property.device };
  result.title = "Pump Status";
  result.level = NONE;
  if (findOpenApsOfflineMarker(treatments, now) === null) {
    for (const fieldName of ALL_STATUS_FIELDS) {
      const field = statusField(result, fieldName);
      if (field !== undefined && Number(field.level) > Number(result.level)) {
        result.level = field.level;
        result.title = field.message;
      }
    }
  }
  if (Number(result.level) > NONE) {
    const message: string[] = [];
    const preparedBattery = statusField(result, "battery");
    const preparedReservoir = statusField(result, "reservoir");
    if (preparedBattery !== undefined) {
      message.push(`Pump Battery: ${String(preparedBattery.display)}`);
    }
    if (preparedReservoir !== undefined) {
      message.push(`Pump Reservoir: ${String(preparedReservoir.display)}`);
    }
    result.message = message.join("\n");
  }
  return result;
}

/** Request-local port of locked plugins/pump.setProperties(). */
export function calculatePumpProperty(
  deviceStatuses: RealtimeDocument[],
  treatments: RealtimeDocument[],
  profile: NightscoutProfileFunctions | undefined,
  now: number,
  preferences: PumpPreferences = {},
  settings: PumpCoreSettings = {},
): PumpProperty {
  const prefs = normalizedPreferences(preferences, profile);
  const recent = now - nightscoutTimes.mins(prefs.urgentClock * 2).msecs;
  let selected: RealtimeDocument | undefined;
  for (const rawStatus of deviceStatuses) {
    if (
      !Object.prototype.hasOwnProperty.call(rawStatus, "pump") ||
      Number(rawStatus.mills) > now || Number(rawStatus.mills) < recent
    ) continue;
    const status = cloneDocument(rawStatus);
    const pump = document(status.pump);
    status.clockMills = pump?.clock ? dateMills(pump.clock) : status.mills;
    if (selected === undefined || Number(status.clockMills) > Number(selected.clockMills)) {
      selected = status;
    }
  }
  const property = selected ?? {};
  property.data = preparePumpData(property, treatments, profile, now, preferences, settings);
  return property as PumpProperty;
}

export function pumpNotification(
  property: PumpProperty,
  treatments: RealtimeDocument[],
  profile: NightscoutProfileFunctions | undefined,
  now: number,
  preferences: PumpPreferences = {},
  settings: PumpCoreSettings = {},
): RealtimeDocument | null {
  const prefs = normalizedPreferences(preferences, profile);
  if (!prefs.enableAlerts) return null;
  const data = preparePumpData(property, treatments, profile, now, preferences, settings);
  if (Number(data.level) < WARN) return null;
  return {
    level: data.level,
    title: data.title,
    message: data.message,
    pushoverSound: "echo",
    group: "Pump",
    plugin: PUMP_PLUGIN,
  };
}

export function pumpVisualization(
  property: PumpProperty,
  treatments: RealtimeDocument[],
  profile: NightscoutProfileFunctions | undefined,
  now: number,
  preferences: PumpPreferences = {},
  settings: PumpCoreSettings = {},
  inRetroMode = false,
): PumpVisualization {
  const prefs = normalizedPreferences(preferences, profile);
  const data = preparePumpData(property, treatments, profile, now, preferences, settings);
  const selected = inRetroMode ? prefs.retroFields : prefs.fields;
  const values: string[] = [];
  const info: RealtimeDocument[] = [];
  for (const fieldName of ALL_STATUS_FIELDS) {
    const field = statusField(data, fieldName);
    if (field === undefined) continue;
    if (selected.includes(fieldName)) values.push(String(field.display));
    else info.push({ label: field.label, value: field.display });
  }
  const extended = document(data.extended);
  if (extended !== undefined) {
    info.push({ label: "------------", value: "" });
    for (const [key, value] of Object.entries(extended)) info.push({ label: key, value });
  }
  return {
    value: values.join(" "),
    info,
    label: "Pump",
    pillClass: levelToStatusClass(data.level),
  };
}

const UNKNOWN =
  "That value is unknown at the moment. Please see your Nightscout site for more details.";

export function pumpReservoirAssistantResponse(
  property: PumpProperty | undefined,
): { title: string; response: string } {
  const reservoir = document(property?.pump)?.reservoir;
  return reservoir || reservoir === 0
    ? {
      title: "Insulin Remaining",
      response: `You have ${String(reservoir)} units remaining`,
    }
    : { title: "Insulin Remaining", response: UNKNOWN };
}

export function pumpBatteryAssistantResponse(
  property: PumpProperty | undefined,
): { title: string; response: string } {
  const battery = document(property?.data)?.battery;
  const prepared = document(battery);
  return prepared
    ? {
      title: "Pump Battery",
      response: `Your pump battery is at ${String(prepared.value)} ${String(prepared.unit)}`,
    }
    : { title: "Pump Battery", response: UNKNOWN };
}
