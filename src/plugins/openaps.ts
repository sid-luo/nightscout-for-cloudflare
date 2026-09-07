import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import { NONE, URGENT, WARN, levelToStatusClass } from "../runtime/levels";
import { nightscoutTimes } from "../runtime/times";
import { mgdlToMMOL } from "../runtime/units";
import { calculateTimeAgoDisplay } from "./timeago";

export interface OpenApsPreferences extends Record<string, unknown> {
  fields?: unknown;
  retroFields?: unknown;
  warn?: unknown;
  urgent?: unknown;
  enableAlerts?: unknown;
  predIobColor?: unknown;
  predCobColor?: unknown;
  predAcobColor?: unknown;
  predZtColor?: unknown;
  predUamColor?: unknown;
  colorPredictionLines?: unknown;
}

export interface OpenApsDisplay extends RealtimeDocument {
  symbol: "⚠" | "x" | "⌁" | "↻" | "◉";
  code: "warning" | "notenacted" | "enacted" | "looping" | "waiting";
  label: "Warning" | "Not Enacted" | "Enacted" | "Looping" | "Waiting";
}

export interface OpenApsProperty extends RealtimeDocument {
  seenDevices: Record<string, RealtimeDocument>;
  lastEnacted: RealtimeDocument | null;
  lastNotEnacted: RealtimeDocument | null;
  lastSuggested: RealtimeDocument | null;
  lastIOB: RealtimeDocument | null;
  lastMMTune: RealtimeDocument | null;
  lastPredBGs: RealtimeDocument | null;
  lastLoopMoment?: string;
  lastEventualBG?: unknown;
  status: OpenApsDisplay;
}

export interface OpenApsVisualization {
  pill: {
    value: string;
    label: string;
    info: RealtimeDocument[];
    pillClass: "current" | "warn" | "urgent";
  };
  forecastPoints: RealtimeDocument[];
  forecastInfo: { type: "openaps"; label: "OpenAPS Forecasts" } | null;
}

export const OPENAPS_INTENTS = [
  { intent: "MetricNow", metrics: ["openaps forecast", "forecast"] },
  { intent: "LastLoop" },
] as const;

const OPENAPS_PLUGIN = {
  name: "openaps",
  label: "OpenAPS",
  pluginType: "pill-status",
} as const;

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

function normalizedPreferences(preferences: OpenApsPreferences): {
  fields: string[];
  retroFields: string[];
  warn: number;
  urgent: number;
  enableAlerts: unknown;
  predIOBColor: string;
  predCOBColor: string;
  predACOBColor: string;
  predZTColor: string;
  predUAMColor: string;
  colorPredictionLines: unknown;
} {
  const fields = cleanList(preferences.fields);
  const retroFields = cleanList(preferences.retroFields);
  return {
    fields: emptyList(fields)
      ? ["status-symbol", "status-label", "iob", "meal-assist", "rssi"]
      : fields,
    retroFields: emptyList(retroFields)
      ? ["status-symbol", "status-label", "iob", "meal-assist", "rssi"]
      : retroFields,
    warn: Number(preferences.warn ? preferences.warn : 30),
    urgent: Number(preferences.urgent ? preferences.urgent : 60),
    enableAlerts: preferences.enableAlerts,
    predIOBColor: String(preferences.predIobColor || "#1e88e5"),
    predCOBColor: String(preferences.predCobColor || "#FB8C00"),
    predACOBColor: String(preferences.predAcobColor || "#FB8C00"),
    predZTColor: String(preferences.predZtColor || "#00d2d2"),
    predUAMColor: String(preferences.predUamColor || "#c9bd60"),
    colorPredictionLines: preferences.colorPredictionLines === undefined
      ? true
      : preferences.colorPredictionLines,
  };
}

function deviceName(uri: string): string {
  const afterScheme = uri.split("://").at(-1) ?? "unknown";
  return afterScheme.split("/")[0] ?? "unknown";
}

function loopDisplay(
  moments: {
    when?: number;
    enacted?: number;
    notEnacted?: number;
    suggested?: number;
  },
  recent: number,
  noWarning: boolean,
): OpenApsDisplay {
  if (
    Number.isFinite(moments.notEnacted) &&
    (
      (Number.isFinite(moments.enacted) && Number(moments.notEnacted) > Number(moments.enacted)) ||
      (!Number.isFinite(moments.enacted) && Number(moments.notEnacted) > recent)
    )
  ) return { symbol: "x", code: "notenacted", label: "Not Enacted" };
  if (Number.isFinite(moments.enacted) && Number(moments.enacted) > recent) {
    return { symbol: "⌁", code: "enacted", label: "Enacted" };
  }
  if (Number.isFinite(moments.suggested) && Number(moments.suggested) > recent) {
    return { symbol: "↻", code: "looping", label: "Looping" };
  }
  if (Number.isFinite(moments.when) && (noWarning || Number(moments.when) > recent)) {
    return { symbol: "◉", code: "waiting", label: "Waiting" };
  }
  return { symbol: "⚠", code: "warning", label: "Warning" };
}

/** Direct request-local port of locked plugins/openaps.analyzeData(). */
export function calculateOpenApsProperty(
  deviceStatuses: RealtimeDocument[],
  now: number,
  preferences: OpenApsPreferences = {},
): OpenApsProperty {
  const prefs = normalizedPreferences(preferences);
  const recentLimit = now - nightscoutTimes.hours(6).msecs;
  const recent = now - nightscoutTimes.mins(prefs.warn / 2).msecs;
  const statuses = deviceStatuses
    .filter((status) =>
      Object.prototype.hasOwnProperty.call(status, "openaps") &&
      Number(status.mills) <= now && Number(status.mills) >= recentLimit
    )
    .map(cloneDocument);

  const result: OpenApsProperty = {
    seenDevices: {},
    lastEnacted: null,
    lastNotEnacted: null,
    lastSuggested: null,
    lastIOB: null,
    lastMMTune: null,
    lastPredBGs: null,
    status: { symbol: "⚠", code: "warning", label: "Warning" },
  };

  for (const status of statuses) {
    const openaps = document(status.openaps) ?? {};
    if (Array.isArray(openaps.iob) && openaps.iob.length > 0) {
      openaps.iob = openaps.iob[0];
      const firstIob = document(openaps.iob);
      if (firstIob?.time) firstIob.timestamp = firstIob.time;
    }

    const uri = typeof status.device === "string" ? status.device : "device";
    const device = result.seenDevices[uri] ?? { name: deviceName(uri), uri };
    result.seenDevices[uri] = device;
    const rawEnacted = document(openaps.enacted);
    const enactedReceived = Boolean(rawEnacted?.recieved || rawEnacted?.received);
    const enacted = rawEnacted?.timestamp && enactedReceived
      ? dateMills(rawEnacted.mills || rawEnacted.timestamp)
      : Number.NaN;
    const notEnacted = rawEnacted?.timestamp && !enactedReceived
      ? dateMills(rawEnacted.mills || rawEnacted.timestamp)
      : Number.NaN;
    const rawSuggested = document(openaps.suggested);
    const suggested = rawSuggested?.mills
      ? dateMills(rawSuggested.mills)
      : dateMills(rawSuggested?.timestamp);
    const rawIob = document(openaps.iob);
    const iob = rawIob?.mills ? dateMills(rawIob.mills) : dateMills(rawIob?.timestamp);
    const when = Number(status.mills);
    const statusDisplay = loopDisplay({ when, enacted, notEnacted, suggested }, recent, true);
    const currentDeviceStatus = document(device.status);
    if (currentDeviceStatus === undefined || when > dateMills(currentDeviceStatus.when)) {
      device.status = { ...statusDisplay, when: isoMoment(when) };
    }

    if (
      rawEnacted !== undefined && Number.isFinite(enacted) &&
      (result.lastEnacted === null || enacted > dateMills(result.lastEnacted.moment))
    ) {
      rawEnacted.moment = isoMoment(rawEnacted.mills || rawEnacted.timestamp);
      result.lastEnacted = rawEnacted;
      if (
        rawEnacted.predBGs &&
        (result.lastPredBGs === null || enacted > dateMills(result.lastPredBGs.moment))
      ) {
        result.lastPredBGs = Array.isArray(rawEnacted.predBGs)
          ? { values: rawEnacted.predBGs }
          : document(rawEnacted.predBGs) ?? null;
        if (result.lastPredBGs !== null) result.lastPredBGs.moment = rawEnacted.moment;
      }
    }

    if (
      rawEnacted !== undefined && Number.isFinite(notEnacted) &&
      (result.lastNotEnacted === null || notEnacted > dateMills(result.lastNotEnacted.moment))
    ) {
      rawEnacted.moment = isoMoment(rawEnacted.mills || rawEnacted.timestamp);
      result.lastNotEnacted = rawEnacted;
    }

    if (
      rawSuggested !== undefined && Number.isFinite(suggested) &&
      (result.lastSuggested === null || suggested > dateMills(result.lastSuggested.moment))
    ) {
      rawSuggested.moment = isoMoment(rawSuggested.mills || rawSuggested.timestamp);
      result.lastSuggested = rawSuggested;
      if (
        rawSuggested.predBGs &&
        (result.lastPredBGs === null || suggested > dateMills(result.lastPredBGs.moment))
      ) {
        result.lastPredBGs = Array.isArray(rawSuggested.predBGs)
          ? { values: rawSuggested.predBGs }
          : document(rawSuggested.predBGs) ?? null;
        if (result.lastPredBGs !== null) result.lastPredBGs.moment = rawSuggested.moment;
      }
    }

    if (
      rawIob !== undefined && Number.isFinite(iob) &&
      (
        result.lastIOB === null ||
        dateMills(rawIob.timestamp) > dateMills(result.lastIOB.moment)
      )
    ) {
      rawIob.moment = isoMoment(iob);
      result.lastIOB = rawIob;
    }

    const mmtune = document(status.mmtune);
    if (mmtune?.timestamp) {
      mmtune.moment = isoMoment(mmtune.timestamp);
      const currentTune = document(device.mmtune);
      if (currentTune === undefined || when > dateMills(currentTune.moment)) device.mmtune = mmtune;
    }
  }

  const enactedMills = dateMills(result.lastEnacted?.moment);
  const suggestedMills = dateMills(result.lastSuggested?.moment);
  if (Number.isFinite(enactedMills) && Number.isFinite(suggestedMills)) {
    if (enactedMills > suggestedMills) {
      result.lastLoopMoment = result.lastEnacted?.moment as string;
      result.lastEventualBG = result.lastEnacted?.eventualBG;
    } else {
      result.lastLoopMoment = result.lastSuggested?.moment as string;
      result.lastEventualBG = result.lastSuggested?.eventualBG;
    }
  } else if (Number.isFinite(enactedMills)) {
    result.lastLoopMoment = result.lastEnacted?.moment as string;
    result.lastEventualBG = result.lastEnacted?.eventualBG;
  } else if (Number.isFinite(suggestedMills)) {
    result.lastLoopMoment = result.lastSuggested?.moment as string;
    result.lastEventualBG = result.lastSuggested?.eventualBG;
  }

  result.status = loopDisplay({
    enacted: enactedMills,
    notEnacted: dateMills(result.lastNotEnacted?.moment),
    suggested: suggestedMills,
  }, recent, false);
  return result;
}

export function findOpenApsOfflineMarker(
  treatments: RealtimeDocument[],
  now: number,
): RealtimeDocument | null {
  for (let index = treatments.length - 1; index >= 0; index -= 1) {
    const treatment = treatments[index];
    if (treatment === undefined) continue;
    const eventTime = Number(treatment.mills);
    const eventEnd = treatment.duration
      ? eventTime + nightscoutTimes.mins(Number(treatment.duration)).msecs
      : eventTime;
    if (
      eventTime <= now && treatment.eventType === "OpenAPS Offline" && eventEnd >= now
    ) return treatment;
  }
  return null;
}

export function openApsStatusLevel(
  property: OpenApsProperty,
  treatments: RealtimeDocument[],
  now: number,
  preferences: OpenApsPreferences = {},
): number {
  if (findOpenApsOfflineMarker(treatments, now) !== null) return NONE;
  const lastLoop = dateMills(property.lastLoopMoment);
  if (!Number.isFinite(lastLoop)) return NONE;
  const prefs = normalizedPreferences(preferences);
  if (lastLoop + nightscoutTimes.mins(prefs.urgent).msecs < now) return URGENT;
  if (lastLoop + nightscoutTimes.mins(prefs.warn).msecs < now) return WARN;
  return NONE;
}

function formatAgo(value: unknown, now: number): string {
  const display = calculateTimeAgoDisplay({ mills: dateMills(value) }, now);
  return `${display.value ? display.value : ""}${display.shortLabel}${
    display.shortLabel.length === 1 ? " ago" : ""
  }`;
}

export function openApsNotification(
  property: OpenApsProperty,
  treatments: RealtimeDocument[],
  now: number,
  preferences: OpenApsPreferences = {},
): RealtimeDocument | null {
  const prefs = normalizedPreferences(preferences);
  if (!prefs.enableAlerts || property.lastLoopMoment === undefined) return null;
  const level = openApsStatusLevel(property, treatments, now, prefs);
  if (level < WARN) return null;
  return {
    level,
    title: "OpenAPS isn't looping",
    message: `Last Loop: ${formatAgo(property.lastLoopMoment, now)}`,
    pushoverSound: "echo",
    group: "OpenAPS",
    plugin: OPENAPS_PLUGIN,
    debug: property,
  };
}

function roundInsulin(value: unknown): string {
  const insulin = Number(value);
  if (insulin === 0) return "0";
  return (Math.floor(insulin * 100 + 1e-9) / 100).toFixed(2);
}

function displayTime(value: unknown, now: number, inRetroMode: boolean): string {
  if (!inRetroMode) return formatAgo(value, now);
  const mills = dateMills(value);
  if (!Number.isFinite(mills)) return "unknown";
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" })
    .format(new Date(mills));
}

/** Pure form of locked plugins/openaps.updateVisualisation(). */
export function openApsVisualization(
  property: OpenApsProperty,
  now: number,
  units: "mg/dl" | "mmol" = "mg/dl",
  preferences: OpenApsPreferences = {},
  inRetroMode = false,
): OpenApsVisualization {
  const prefs = normalizedPreferences(preferences);
  const selected = inRetroMode ? prefs.retroFields : prefs.fields;
  const events: { time: number; value: string }[] = [];
  const valueString = (prefix: string, value: unknown): string => value ? `${prefix}${String(value)}` : "";
  const displayBg = (value: unknown): number => {
    const scaled = units === "mmol" ? Number(mgdlToMMOL(Number(value))) : Number(value);
    return units === "mmol" ? Math.round(scaled * 10) / 10 : Math.round(scaled);
  };
  const concatIOB = (parts: string[]): string[] => {
    if (property.lastIOB === null) return parts;
    parts.push(", IOB: ", `${roundInsulin(property.lastIOB.iob)}U`);
    if (property.lastIOB.basaliob) {
      parts.push(`, Basal IOB ${roundInsulin(property.lastIOB.basaliob)}U`);
    }
    if (property.lastIOB.bolusiob) {
      parts.push(`, Bolus IOB ${roundInsulin(property.lastIOB.bolusiob)}U`);
    }
    return parts;
  };
  const addSuggestion = (): void => {
    if (property.lastSuggested === null) return;
    let parts = [
      valueString("BG: ", displayBg(property.lastSuggested.bg)),
      valueString(", ", property.lastSuggested.reason),
      property.lastSuggested.sensitivityRatio
        ? `, <b>Sensitivity Ratio:</b> ${String(property.lastSuggested.sensitivityRatio)}`
        : "",
    ];
    if (selected.includes("iob")) parts = concatIOB(parts);
    events.push({
      time: dateMills(property.lastSuggested.moment),
      value: parts.join(""),
    });
  };

  if (property.status.code === "enacted" && property.lastEnacted !== null) {
    const enacted = property.lastEnacted;
    const rate = Number(enacted.rate);
    const duration = Number(enacted.duration);
    const hasDetails = enacted.rate !== undefined && enacted.rate !== null && enacted.rate !== ""
      && Number.isFinite(rate) && enacted.duration !== undefined && enacted.duration !== null
      && enacted.duration !== "" && Number.isFinite(duration);
    const canceled = hasDetails && rate === 0 && duration === 0;
    let parts = [valueString("BG: ", displayBg(enacted.bg))];
    if (hasDetails) {
      parts.push(`, <b>Temp Basal${canceled ? " Canceled" : " Started"}</b>`);
      if (!canceled) parts.push(` ${rate.toFixed(2)} for ${duration}m`);
    }
    parts.push(
      valueString(", ", enacted.reason),
      enacted.mealAssist && selected.includes("meal-assist")
        ? ` <b>Meal Assist:</b> ${String(enacted.mealAssist)}` : "",
    );
    if (
      property.lastSuggested !== null &&
      dateMills(property.lastSuggested.moment) > dateMills(enacted.moment)
    ) addSuggestion();
    else parts = concatIOB(parts);
    events.push({ time: dateMills(enacted.moment), value: parts.join("") });
  } else addSuggestion();

  for (const device of Object.values(property.seenDevices)) {
    const status = document(device.status);
    if (status === undefined) continue;
    const info = [String(device.name)];
    if (selected.includes("status-symbol")) info.push(String(status.symbol));
    if (selected.includes("status-label")) info.push(String(status.label));
    const tune = document(device.mmtune);
    if (tune !== undefined) {
      const scanDetails = Array.isArray(tune.scanDetails) ? tune.scanDetails : [];
      const best = scanDetails
        .filter((detail): detail is unknown[] => Array.isArray(detail))
        .reduce<unknown[] | undefined>((current, detail) =>
          current === undefined || Number(detail[2]) > Number(current[2]) ? detail : current,
        undefined);
      if (selected.includes("freq")) info.push(`${String(tune.setFreq)}MHz`);
      if (best !== undefined && best.length > 2 && selected.includes("rssi")) {
        info.push(`@ ${String(best[2])}dB`);
      }
    }
    events.push({ time: dateMills(status.when), value: info.join(" ") });
  }

  const info = events
    .sort((left, right) => right.time - left.time)
    .map((event) => ({
      label: `${inRetroMode ? "@ " : ""}${displayTime(event.time, now, inRetroMode)}`,
      value: event.value,
    }));
  const forecastPoints: RealtimeDocument[] = [];
  const predictions = property.lastPredBGs;
  if (predictions !== null) {
    const start = dateMills(predictions.moment);
    const series = [
      ["values", 0, "Values", "#ff00ff"],
      ["IOB", 3333, "IOB", prefs.predIOBColor],
      ["ZT", 4444, "Zero-Temp", prefs.predZTColor],
      ["aCOB", 5555, "Accel-COB", prefs.predACOBColor],
      ["COB", 7777, "COB", prefs.predCOBColor],
      ["UAM", 9999, "UAM", prefs.predUAMColor],
    ] as const;
    for (const [key, offset, forecastType, color] of series) {
      const values = predictions[key];
      if (!Array.isArray(values)) continue;
      values.forEach((value, index) => forecastPoints.push({
        mgdl: value,
        color: prefs.colorPredictionLines ? color : "#ff00ff",
        mills: start + nightscoutTimes.mins(5 * index).msecs + offset,
        noFade: true,
        forecastType,
      }));
    }
  }
  return {
    pill: {
      value: displayTime(property.lastLoopMoment, now, inRetroMode),
      label: `OpenAPS${selected.includes("status-symbol") ? ` ${property.status.symbol}` : ""}`,
      info,
      pillClass: levelToStatusClass(openApsStatusLevel(property, [], now, prefs)),
    },
    forecastPoints,
    forecastInfo: forecastPoints.length > 0
      ? { type: "openaps", label: "OpenAPS Forecasts" }
      : null,
  };
}

function momentRelative(target: unknown, base: number): string {
  const targetMills = dateMills(target);
  if (!Number.isFinite(targetMills)) return "Invalid date";
  const future = targetMills > base;
  const seconds = Math.round(Math.abs(targetMills - base) / 1_000);
  let text: string;
  if (seconds <= 44) text = "a few seconds";
  else if (seconds <= 89) text = "a minute";
  else {
    const minutes = Math.round(seconds / 60);
    if (minutes <= 44) text = `${minutes} minutes`;
    else if (minutes <= 89) text = "an hour";
    else {
      const hours = Math.round(minutes / 60);
      if (hours <= 21) text = `${hours} hours`;
      else if (hours <= 35) text = "a day";
      else text = `${Math.round(hours / 24)} days`;
    }
  }
  return future ? `in ${text}` : `${text} ago`;
}

export function openApsForecastAssistantResponse(
  property: OpenApsProperty | undefined,
): { title: string; response: string } {
  return property?.lastEventualBG
    ? {
      title: "OpenAPS Forecast",
      response: `The OpenAPS Eventual BG is ${String(property.lastEventualBG)}`,
    }
    : {
      title: "OpenAPS Forecast",
      response: "That value is unknown at the moment. Please see your Nightscout site for more details.",
    };
}

export function openApsLastLoopAssistantResponse(
  property: OpenApsProperty | undefined,
  now: number,
): { title: string; response: string } {
  return property?.lastLoopMoment
    ? {
      title: "Last Loop",
      response: `The last successful loop was ${momentRelative(property.lastLoopMoment, now)}`,
    }
    : {
      title: "Last Loop",
      response: "That value is unknown at the moment. Please see your Nightscout site for more details.",
    };
}

export function openApsEventTypes(units: "mg/dl" | "mmol"): RealtimeDocument[] {
  const reasons = units === "mmol"
    ? [
      { name: "Eating Soon", targetTop: 4.5, targetBottom: 4.5, duration: 60 },
      { name: "Activity", targetTop: 8, targetBottom: 6.5, duration: 120 },
      { name: "Manual" },
    ]
    : [
      { name: "Eating Soon", targetTop: 80, targetBottom: 80, duration: 60 },
      { name: "Activity", targetTop: 140, targetBottom: 120, duration: 120 },
      { name: "Manual" },
    ];
  return [
    {
      val: "Temporary Target", name: "Temporary Target", bg: false, insulin: false,
      carbs: false, prebolus: false, duration: true, percent: false, absolute: false,
      profile: false, split: false, targets: true, reasons,
    },
    {
      val: "Temporary Target Cancel", name: "Temporary Target Cancel", bg: false,
      insulin: false, carbs: false, prebolus: false, duration: false, percent: false,
      absolute: false, profile: false, split: false,
    },
    {
      val: "OpenAPS Offline", name: "OpenAPS Offline", bg: false, insulin: false,
      carbs: false, prebolus: false, duration: true, percent: false, absolute: false,
      profile: false, split: false,
    },
  ];
}
