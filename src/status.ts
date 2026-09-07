import {
  createNightscoutSettings,
  NIGHTSCOUT_DEFAULT_FEATURES as DEFAULT_FEATURES,
  NIGHTSCOUT_DEFAULT_THRESHOLDS as DEFAULT_THRESHOLDS,
} from "./settings";

const MMOL_TO_MGDL = 18.01559;
const MAX_AUTH_FAIL_DELAY_MS = 60_000;
export const CLOUDFLARE_FREE_SQLITE_DO_MAX_MIB = 1_000_000_000 / (1024 * 1024);

export type NightscoutDisplayUnits = "mg/dl" | "mmol";

export interface NightscoutStatusEnvironment {
  DISPLAY_UNITS?: string;
  TIME_FORMAT?: string;
  NIGHT_MODE?: string;
  SHOW_RAWBG?: string;
  CUSTOM_TITLE?: string;
  THEME?: string;
  SCALE_Y?: string;
  EDIT_MODE?: string;
  LANGUAGE?: string;
  ENABLE?: string;
  DISABLE?: string;
  SHOW_PLUGINS?: string;
  SHOW_FORECAST?: string;
  FOCUS_HOURS?: string;
  SHOW_CLOCK_DELTA?: string;
  SHOW_CLOCK_LAST_TIME?: string;
  FRAME_URL_1?: string;
  FRAME_URL_2?: string;
  FRAME_URL_3?: string;
  FRAME_URL_4?: string;
  FRAME_URL_5?: string;
  FRAME_URL_6?: string;
  FRAME_URL_7?: string;
  FRAME_URL_8?: string;
  FRAME_NAME_1?: string;
  FRAME_NAME_2?: string;
  FRAME_NAME_3?: string;
  FRAME_NAME_4?: string;
  FRAME_NAME_5?: string;
  FRAME_NAME_6?: string;
  FRAME_NAME_7?: string;
  FRAME_NAME_8?: string;
  AUTH_FAIL_DELAY?: string;
  ADMIN_NOTIFIES_ENABLED?: string;
  BG_HIGH?: string;
  BG_TARGET_TOP?: string;
  BG_TARGET_BOTTOM?: string;
  BG_LOW?: string;
  ALARM_TYPES?: string;
  ALARM_URGENT_HIGH?: string;
  ALARM_URGENT_HIGH_MINS?: string;
  ALARM_HIGH?: string;
  ALARM_HIGH_MINS?: string;
  ALARM_LOW?: string;
  ALARM_LOW_MINS?: string;
  ALARM_URGENT_LOW?: string;
  ALARM_URGENT_LOW_MINS?: string;
  ALARM_URGENT_MINS?: string;
  ALARM_WARN_MINS?: string;
  AR2_CONE_FACTOR?: string;
  BASAL_RENDER?: string;
  BOLUS_RENDER_OVER?: string;
  BOLUS_RENDER_FORMAT?: string;
  BOLUS_RENDER_FORMAT_SMALL?: string;
  PROFILE_HISTORY?: string;
  PROFILE_MULTIPLE?: string;
  BWP_SNOOZE?: string;
  BWP_WARN?: string;
  BWP_URGENT?: string;
  BWP_SNOOZE_MINS?: string;
  UPBAT_WARN?: string;
  UPBAT_URGENT?: string;
  UPBAT_ENABLE_ALERTS?: string;
  ERRORCODES_INFO?: string;
  ERRORCODES_WARN?: string;
  ERRORCODES_URGENT?: string;
  XDRIPJS_ENABLE_ALERTS?: string;
  XDRIPJS_WARN_BAT_V?: string;
  XDRIPJS_STATE_NOTIFY_INTRVL?: string;
  DBSIZE_MAX?: string;
  DBSIZE_WARN_PERCENTAGE?: string;
  DBSIZE_URGENT_PERCENTAGE?: string;
  DBSIZE_ENABLE_ALERTS?: string;
  DBSIZE_IN_MIB?: string;
  TIMEAGO_ENABLE_ALERTS?: string;
  ALARM_TIMEAGO_WARN?: string;
  ALARM_TIMEAGO_WARN_MINS?: string;
  ALARM_TIMEAGO_URGENT?: string;
  ALARM_TIMEAGO_URGENT_MINS?: string;
  CAGE_INFO?: string;
  CAGE_WARN?: string;
  CAGE_URGENT?: string;
  CAGE_DISPLAY?: string;
  CAGE_ENABLE_ALERTS?: string;
  SAGE_INFO?: string;
  SAGE_WARN?: string;
  SAGE_URGENT?: string;
  SAGE_ENABLE_ALERTS?: string;
  IAGE_INFO?: string;
  IAGE_WARN?: string;
  IAGE_URGENT?: string;
  IAGE_ENABLE_ALERTS?: string;
  BAGE_INFO?: string;
  BAGE_WARN?: string;
  BAGE_URGENT?: string;
  BAGE_DISPLAY?: string;
  BAGE_ENABLE_ALERTS?: string;
  DAY_START?: string;
  DAY_END?: string;
  OPENAPS_ENABLE_ALERTS?: string;
  OPENAPS_WARN?: string;
  OPENAPS_URGENT?: string;
  OPENAPS_FIELDS?: string;
  OPENAPS_RETRO_FIELDS?: string;
  OPENAPS_PRED_IOB_COLOR?: string;
  OPENAPS_PRED_COB_COLOR?: string;
  OPENAPS_PRED_ACOB_COLOR?: string;
  OPENAPS_PRED_ZT_COLOR?: string;
  OPENAPS_PRED_UAM_COLOR?: string;
  OPENAPS_COLOR_PREDICTION_LINES?: string;
  PUMP_ENABLE_ALERTS?: string;
  PUMP_WARN_ON_SUSPEND?: string;
  PUMP_FIELDS?: string;
  PUMP_RETRO_FIELDS?: string;
  PUMP_WARN_CLOCK?: string;
  PUMP_URGENT_CLOCK?: string;
  PUMP_WARN_RES?: string;
  PUMP_URGENT_RES?: string;
  PUMP_WARN_BATT_P?: string;
  PUMP_URGENT_BATT_P?: string;
  PUMP_WARN_BATT_V?: string;
  PUMP_URGENT_BATT_V?: string;
  PUMP_WARN_BATT_QUIET_NIGHT?: string;
  LOOP_ENABLE_ALERTS?: string;
  LOOP_WARN?: string;
  LOOP_URGENT?: string;
  TREATMENTNOTIFY_SNOOZE_MINS?: string;
  TREATMENTNOTIFY_INCLUDE_BOLUSES_OVER?: string;
  DEVICESTATUS_ADVANCED?: string;
  HEARTBEAT?: string;
}

function configuredFeatureNames(value: string | undefined): string[] {
  const raw = value?.trim();
  if (raw === undefined || raw.length === 0) return [];
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw).toLowerCase();
  } catch {
    return [];
  }
  return decoded.split(" ").filter((feature) => feature.length > 0);
}

function configuredEnable(
  environment: NightscoutStatusEnvironment,
  alarmTypes: readonly string[],
): string[] | undefined {
  if (environment.ENABLE === undefined && environment.DISABLE === undefined) return undefined;
  const enabled = configuredFeatureNames(environment.ENABLE);
  if (
    ["careportal", "pushover", "maker"].some((feature) => enabled.includes(feature)) &&
    !enabled.includes("treatmentnotify")
  ) enabled.push("treatmentnotify");
  for (const feature of DEFAULT_FEATURES) {
    if (!enabled.includes(feature)) enabled.push(feature);
  }
  for (const alarmType of alarmTypes) {
    const alarmPlugin = alarmType === "simple" ? "simplealarms" : "ar2";
    if (!enabled.includes(alarmPlugin)) enabled.push(alarmPlugin);
  }
  const disabled = new Set(configuredFeatureNames(environment.DISABLE));
  return enabled.filter((feature) => !disabled.has(feature));
}

export interface NightscoutStatusSettingsOverrides {
  units?: NightscoutDisplayUnits;
  authFailDelay?: number;
  /** Test/platform-context override matching a resolved upstream settings.enable array. */
  enable?: string[];
  alarmTypes?: string[];
  thresholds?: {
    bgHigh: number;
    bgTargetTop: number;
    bgTargetBottom: number;
    bgLow: number;
  };
  simpleAlarms?: boolean;
  /** Request-local client/server plugin settings after platform adaptation. */
  extendedSettings?: Record<string, unknown>;
  /** Raw named settings env values consumed by the locked settings mappers. */
  settingEnvironment?: Record<string, unknown>;
}

function normalizeExtendedSetting(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  if (!Number.isNaN(Number(value))) return Number(value);
  const normalized = value.toLowerCase();
  if (normalized === "on" || normalized === "true") return true;
  if (normalized === "off" || normalized === "false") return false;
  return value;
}

function platformExtendedSettings(
  environment: NightscoutStatusEnvironment,
  enabled: ReadonlySet<string>,
): Record<string, unknown> {
  const dbsize: Record<string, unknown> = {
    // Cloudflare documents a 1 GB per-object ceiling on Workers Free, while
    // the locked plugin expresses its configured maximum in binary MiB.
    max: normalizeExtendedSetting(environment.DBSIZE_MAX)
      ?? CLOUDFLARE_FREE_SQLITE_DO_MAX_MIB,
  };
  const configured = [
    ["warnPercentage", environment.DBSIZE_WARN_PERCENTAGE],
    ["urgentPercentage", environment.DBSIZE_URGENT_PERCENTAGE],
    ["enableAlerts", environment.DBSIZE_ENABLE_ALERTS],
    ["inMib", environment.DBSIZE_IN_MIB],
  ] as const;
  for (const [key, raw] of configured) {
    const value = normalizeExtendedSetting(raw);
    if (value !== undefined) dbsize[key] = value;
  }
  const extended: Record<string, unknown> = {
    dbsize,
    // Locked Nightscout exposes this default even when no environment variable
    // is configured. It only controls how the browser merges received device
    // status records; the Worker upload and retention paths are unchanged.
    devicestatus: {
      advanced: normalizeExtendedSetting(environment.DEVICESTATUS_ADVANCED) ?? true,
      days: 1,
    },
  };
  function addPlugin(
    name: string,
    configured: readonly (readonly [string, string | undefined])[],
  ): void {
    if (!enabled.has(name)) return;
    const settings: Record<string, unknown> = {};
    for (const [key, raw] of configured) {
      const value = normalizeExtendedSetting(raw);
      if (value !== undefined) settings[key] = value;
    }
    if (Object.keys(settings).length > 0) extended[name] = settings;
  }
  addPlugin("ar2", [["coneFactor", environment.AR2_CONE_FACTOR]]);
  addPlugin("basal", [["render", environment.BASAL_RENDER]]);
  addPlugin("bolus", [
    ["renderOver", environment.BOLUS_RENDER_OVER],
    ["renderFormat", environment.BOLUS_RENDER_FORMAT],
    ["renderFormatSmall", environment.BOLUS_RENDER_FORMAT_SMALL],
  ]);
  addPlugin("profile", [
    ["history", environment.PROFILE_HISTORY],
    ["multiple", environment.PROFILE_MULTIPLE],
  ]);
  addPlugin("bwp", [
    ["snooze", environment.BWP_SNOOZE],
    ["warn", environment.BWP_WARN],
    ["urgent", environment.BWP_URGENT],
    ["snoozeMins", environment.BWP_SNOOZE_MINS],
  ]);
  addPlugin("upbat", [
    ["warn", environment.UPBAT_WARN],
    ["urgent", environment.UPBAT_URGENT],
    ["enableAlerts", environment.UPBAT_ENABLE_ALERTS],
  ]);
  if (enabled.has("errorcodes")) {
    const errorcodes: Record<string, unknown> = {};
    for (const [key, raw] of [
      ["info", environment.ERRORCODES_INFO],
      ["warn", environment.ERRORCODES_WARN],
      ["urgent", environment.ERRORCODES_URGENT],
    ] as const) {
      // Unlike most extended settings, the locked plugin parses literal
      // space-delimited strings and gives the string "off" special meaning.
      // Preserve those bytes instead of normalizing "off" to boolean false.
      if (raw !== undefined) errorcodes[key] = raw;
    }
    if (Object.keys(errorcodes).length > 0) extended.errorcodes = errorcodes;
  }
  addPlugin("xdripjs", [
    ["enableAlerts", environment.XDRIPJS_ENABLE_ALERTS],
    ["warnBatV", environment.XDRIPJS_WARN_BAT_V],
    ["stateNotifyIntrvl", environment.XDRIPJS_STATE_NOTIFY_INTRVL],
  ]);
  addPlugin("timeago", [["enableAlerts", environment.TIMEAGO_ENABLE_ALERTS]]);
  addPlugin("cage", [
    ["info", environment.CAGE_INFO],
    ["warn", environment.CAGE_WARN],
    ["urgent", environment.CAGE_URGENT],
    ["display", environment.CAGE_DISPLAY],
    ["enableAlerts", environment.CAGE_ENABLE_ALERTS],
  ]);
  addPlugin("sage", [
    ["info", environment.SAGE_INFO],
    ["warn", environment.SAGE_WARN],
    ["urgent", environment.SAGE_URGENT],
    ["enableAlerts", environment.SAGE_ENABLE_ALERTS],
  ]);
  addPlugin("iage", [
    ["info", environment.IAGE_INFO],
    ["warn", environment.IAGE_WARN],
    ["urgent", environment.IAGE_URGENT],
    ["enableAlerts", environment.IAGE_ENABLE_ALERTS],
  ]);
  addPlugin("bage", [
    ["info", environment.BAGE_INFO],
    ["warn", environment.BAGE_WARN],
    ["urgent", environment.BAGE_URGENT],
    ["display", environment.BAGE_DISPLAY],
    ["enableAlerts", environment.BAGE_ENABLE_ALERTS],
  ]);
  addPlugin("openaps", [
    ["enableAlerts", environment.OPENAPS_ENABLE_ALERTS],
    ["warn", environment.OPENAPS_WARN],
    ["urgent", environment.OPENAPS_URGENT],
    ["fields", environment.OPENAPS_FIELDS],
    ["retroFields", environment.OPENAPS_RETRO_FIELDS],
    ["predIobColor", environment.OPENAPS_PRED_IOB_COLOR],
    ["predCobColor", environment.OPENAPS_PRED_COB_COLOR],
    ["predAcobColor", environment.OPENAPS_PRED_ACOB_COLOR],
    ["predZtColor", environment.OPENAPS_PRED_ZT_COLOR],
    ["predUamColor", environment.OPENAPS_PRED_UAM_COLOR],
    ["colorPredictionLines", environment.OPENAPS_COLOR_PREDICTION_LINES],
  ]);
  addPlugin("pump", [
    ["enableAlerts", environment.PUMP_ENABLE_ALERTS],
    ["warnOnSuspend", environment.PUMP_WARN_ON_SUSPEND],
    ["fields", environment.PUMP_FIELDS],
    ["retroFields", environment.PUMP_RETRO_FIELDS],
    ["warnClock", environment.PUMP_WARN_CLOCK],
    ["urgentClock", environment.PUMP_URGENT_CLOCK],
    ["warnRes", environment.PUMP_WARN_RES],
    ["urgentRes", environment.PUMP_URGENT_RES],
    ["warnBattP", environment.PUMP_WARN_BATT_P],
    ["urgentBattP", environment.PUMP_URGENT_BATT_P],
    ["warnBattV", environment.PUMP_WARN_BATT_V],
    ["urgentBattV", environment.PUMP_URGENT_BATT_V],
    ["warnBattQuietNight", environment.PUMP_WARN_BATT_QUIET_NIGHT],
  ]);
  addPlugin("loop", [
    ["enableAlerts", environment.LOOP_ENABLE_ALERTS],
    ["warn", environment.LOOP_WARN],
    ["urgent", environment.LOOP_URGENT],
  ]);
  addPlugin("treatmentnotify", [
    ["snoozeMins", environment.TREATMENTNOTIFY_SNOOZE_MINS],
    ["includeBolusesOver", environment.TREATMENTNOTIFY_INCLUDE_BOLUSES_OVER],
  ]);
  return extended;
}

/**
 * Normalize only the unit spellings used by locked profile records. Profile
 * data is persisted user input, so substring guesses such as `notmmol` must
 * not alter the server-wide unit contract.
 */
export function normalizeProfileUnits(value: unknown): NightscoutDisplayUnits | null {
  if (typeof value !== "string") return null;
  const compact = value.trim().toLowerCase().replaceAll(" ", "");
  if (compact === "mmol" || compact === "mmol/l") return "mmol";
  if (compact === "mg/dl" || compact === "mgdl") return "mg/dl";
  return null;
}

/** Locked v15.0.7 lib/server/env.js DISPLAY_UNITS normalization. */
export function normalizeConfiguredDisplayUnits(value: string): NightscoutDisplayUnits {
  return value.toLowerCase().includes("mmol") ? "mmol" : "mg/dl";
}

function profileDisplayUnits(profile: unknown): NightscoutDisplayUnits | null {
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return null;
  const record = profile as Record<string, unknown>;
  const recordUnits = normalizeProfileUnits(record.units);
  if (recordUnits !== null) return recordUnits;

  const defaultProfile = record.defaultProfile;
  const store = record.store;
  if (
    typeof defaultProfile !== "string"
    || typeof store !== "object"
    || store === null
    || Array.isArray(store)
  ) {
    return null;
  }
  const selected = (store as Record<string, unknown>)[defaultProfile];
  if (typeof selected !== "object" || selected === null || Array.isArray(selected)) return null;
  return normalizeProfileUnits((selected as Record<string, unknown>).units);
}

/**
 * Cloudflare cannot hold an incoming request open for Nightscout's unbounded
 * AUTH_FAIL_DELAY. Report the same 0..60s value the Worker actually enforces.
 */
export function normalizePlatformAuthFailDelay(value: string | undefined): number {
  const normalized = value?.trim();
  const parsed = Number(normalized === undefined || normalized === "" ? 5000 : normalized);
  return Number.isFinite(parsed)
    ? Math.max(0, Math.min(MAX_AUTH_FAIL_DELAY_MS, Math.trunc(parsed)))
    : 5000;
}

function lockedThresholdNumber(value: string | undefined, fallback: number): number {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") return fallback;
  // Locked settings.js accepts a decimal comma, then coerces every configured
  // threshold with Number(). Invalid values become NaN and JSON renders null.
  return Number(normalized.replace(",", "."));
}

function configuredThresholdValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? undefined : normalized;
}

function configuredThresholds(
  environment: NightscoutStatusEnvironment,
  units: NightscoutDisplayUnits,
): NightscoutStatusSettingsOverrides["thresholds"] | undefined {
  const values = [
    configuredThresholdValue(environment.BG_HIGH),
    configuredThresholdValue(environment.BG_TARGET_TOP),
    configuredThresholdValue(environment.BG_TARGET_BOTTOM),
    configuredThresholdValue(environment.BG_LOW),
  ];
  if (values.every((value) => value === undefined)) return undefined;

  const thresholds = {
    bgHigh: lockedThresholdNumber(values[0], DEFAULT_THRESHOLDS.bgHigh),
    bgTargetTop: lockedThresholdNumber(
      values[1],
      DEFAULT_THRESHOLDS.bgTargetTop,
    ),
    bgTargetBottom: lockedThresholdNumber(
      values[2],
      DEFAULT_THRESHOLDS.bgTargetBottom,
    ),
    bgLow: lockedThresholdNumber(values[3], DEFAULT_THRESHOLDS.bgLow),
  };

  // Locked settings.js accepts mmol thresholds, but keeps legacy mg/dl values
  // when bgHigh is already above the mmol range.
  if (units === "mmol" && thresholds.bgHigh < 50) {
    thresholds.bgHigh = Math.round(thresholds.bgHigh * MMOL_TO_MGDL);
    thresholds.bgTargetTop = Math.round(thresholds.bgTargetTop * MMOL_TO_MGDL);
    thresholds.bgTargetBottom = Math.round(thresholds.bgTargetBottom * MMOL_TO_MGDL);
    thresholds.bgLow = Math.round(thresholds.bgLow * MMOL_TO_MGDL);
  }
  if (thresholds.bgTargetBottom >= thresholds.bgTargetTop) {
    thresholds.bgTargetBottom = thresholds.bgTargetTop - 1;
  }
  if (thresholds.bgTargetTop <= thresholds.bgTargetBottom) {
    thresholds.bgTargetTop = thresholds.bgTargetBottom + 1;
  }
  if (thresholds.bgLow >= thresholds.bgTargetBottom) {
    thresholds.bgLow = thresholds.bgTargetBottom - 1;
  }
  if (thresholds.bgHigh <= thresholds.bgTargetTop) {
    thresholds.bgHigh = thresholds.bgTargetTop + 1;
  }
  return thresholds;
}

export function tenantStatusSettings(
  environment: NightscoutStatusEnvironment,
  latestProfile?: unknown,
): NightscoutStatusSettingsOverrides {
  const units = environment.DISPLAY_UNITS === undefined
    ? profileDisplayUnits(latestProfile) ?? "mg/dl"
    : normalizeConfiguredDisplayUnits(environment.DISPLAY_UNITS);
  const thresholds = configuredThresholds(environment, units);
  const configuredAlarmTypes = configuredFeatureNames(environment.ALARM_TYPES)
    .filter((type) => type === "predict" || type === "simple");
  const alarmTypes = configuredAlarmTypes.length > 0
    ? configuredAlarmTypes
    : [thresholds !== undefined ? "simple" : "predict"];
  const base = {
    units,
    authFailDelay: normalizePlatformAuthFailDelay(environment.AUTH_FAIL_DELAY),
    simpleAlarms: alarmTypes.includes("simple"),
    alarmTypes,
  };
  const enable = configuredEnable(environment, alarmTypes);
  const effectiveEnabled = new Set(enable ?? [
    ...DEFAULT_FEATURES,
    ...alarmTypes.map((type) => type === "simple" ? "simplealarms" : "ar2"),
  ]);
  const settingEnvironment: Record<string, unknown> = {};
  for (const [name, value] of [
    ["ALARM_TIMEAGO_WARN", environment.ALARM_TIMEAGO_WARN],
    ["ALARM_TIMEAGO_WARN_MINS", environment.ALARM_TIMEAGO_WARN_MINS],
    ["ALARM_TIMEAGO_URGENT", environment.ALARM_TIMEAGO_URGENT],
    ["ALARM_TIMEAGO_URGENT_MINS", environment.ALARM_TIMEAGO_URGENT_MINS],
    ["TIME_FORMAT", environment.TIME_FORMAT],
    ["DAY_START", environment.DAY_START],
    ["DAY_END", environment.DAY_END],
    ["NIGHT_MODE", environment.NIGHT_MODE],
    ["SHOW_RAWBG", environment.SHOW_RAWBG],
    ["CUSTOM_TITLE", environment.CUSTOM_TITLE],
    ["THEME", environment.THEME],
    ["SCALE_Y", environment.SCALE_Y],
    ["EDIT_MODE", environment.EDIT_MODE],
    ["HEARTBEAT", environment.HEARTBEAT],
    ["LANGUAGE", environment.LANGUAGE],
    ["SHOW_PLUGINS", environment.SHOW_PLUGINS],
    ["SHOW_FORECAST", environment.SHOW_FORECAST],
    ["FOCUS_HOURS", environment.FOCUS_HOURS],
    ["SHOW_CLOCK_DELTA", environment.SHOW_CLOCK_DELTA],
    ["SHOW_CLOCK_LAST_TIME", environment.SHOW_CLOCK_LAST_TIME],
    ["FRAME_URL_1", environment.FRAME_URL_1],
    ["FRAME_URL_2", environment.FRAME_URL_2],
    ["FRAME_URL_3", environment.FRAME_URL_3],
    ["FRAME_URL_4", environment.FRAME_URL_4],
    ["FRAME_URL_5", environment.FRAME_URL_5],
    ["FRAME_URL_6", environment.FRAME_URL_6],
    ["FRAME_URL_7", environment.FRAME_URL_7],
    ["FRAME_URL_8", environment.FRAME_URL_8],
    ["FRAME_NAME_1", environment.FRAME_NAME_1],
    ["FRAME_NAME_2", environment.FRAME_NAME_2],
    ["FRAME_NAME_3", environment.FRAME_NAME_3],
    ["FRAME_NAME_4", environment.FRAME_NAME_4],
    ["FRAME_NAME_5", environment.FRAME_NAME_5],
    ["FRAME_NAME_6", environment.FRAME_NAME_6],
    ["FRAME_NAME_7", environment.FRAME_NAME_7],
    ["FRAME_NAME_8", environment.FRAME_NAME_8],
    ["ALARM_URGENT_HIGH", environment.ALARM_URGENT_HIGH],
    ["ALARM_URGENT_HIGH_MINS", environment.ALARM_URGENT_HIGH_MINS],
    ["ALARM_HIGH", environment.ALARM_HIGH],
    ["ALARM_HIGH_MINS", environment.ALARM_HIGH_MINS],
    ["ALARM_LOW", environment.ALARM_LOW],
    ["ALARM_LOW_MINS", environment.ALARM_LOW_MINS],
    ["ALARM_URGENT_LOW", environment.ALARM_URGENT_LOW],
    ["ALARM_URGENT_LOW_MINS", environment.ALARM_URGENT_LOW_MINS],
    ["ALARM_URGENT_MINS", environment.ALARM_URGENT_MINS],
    ["ALARM_WARN_MINS", environment.ALARM_WARN_MINS],
    ["ADMIN_NOTIFIES_ENABLED", environment.ADMIN_NOTIFIES_ENABLED],
  ] as const) {
    if (value !== undefined) settingEnvironment[name] = value;
  }
  return {
    ...base,
    extendedSettings: platformExtendedSettings(environment, effectiveEnabled),
    ...(Object.keys(settingEnvironment).length === 0 ? {} : { settingEnvironment }),
    ...(thresholds === undefined ? {} : { thresholds }),
    ...(enable === undefined ? {} : { enable }),
  };
}

function nightscoutSettings(
  authDefaultRoles: string,
  overrides: NightscoutStatusSettingsOverrides,
): Record<string, unknown> {
  const settings = createNightscoutSettings();
  const thresholds = overrides.thresholds;
  settings.eachSettingAsEnv((name) => {
    if (name === "UNITS") return overrides.units ?? "mg/dl";
    if (name === "AUTH_FAIL_DELAY") return overrides.authFailDelay ?? 5000;
    if (name === "ALARM_TYPES") {
      return overrides.alarmTypes?.join(" ")
        ?? (overrides.simpleAlarms === true ? "simple" : "predict");
    }
    const configuredSetting = overrides.settingEnvironment?.[name];
    if (configuredSetting !== undefined) return configuredSetting;
    if (thresholds === undefined) return undefined;
    if (name === "BG_HIGH") return thresholds.bgHigh;
    if (name === "BG_TARGET_TOP") return thresholds.bgTargetTop;
    if (name === "BG_TARGET_BOTTOM") return thresholds.bgTargetBottom;
    if (name === "BG_LOW") return thresholds.bgLow;
    return undefined;
  });
  settings.authDefaultRoles = authDefaultRoles;
  if (overrides.enable !== undefined) settings.enable = [...overrides.enable];

  // filteredSettings retains enumerable method functions exactly like the
  // upstream module; Express JSON serialization omits those functions. Build
  // the same request snapshot explicitly before returning it to Worker routes.
  const filtered = settings.filteredSettings(settings);
  if (typeof filtered !== "object" || filtered === null || Array.isArray(filtered)) return {};
  return Object.fromEntries(
    Object.entries(filtered).filter(([, value]) => typeof value !== "function"),
  );
}

export function nightscoutStatus(
  now = new Date(),
  authDefaultRoles = "readable",
  settingsOverrides: NightscoutStatusSettingsOverrides = {},
  authorized: unknown = null,
): Record<string, unknown> {
  const settings = nightscoutSettings(authDefaultRoles, settingsOverrides);
  const enable = settings.enable as string[];
  const extendedSettings = settingsOverrides.extendedSettings ?? {};
  return {
    status: "ok",
    name: "Nightscout",
    version: "15.0.8",
    serverTime: now.toISOString(),
    serverTimeEpoch: now.getTime(),
    apiEnabled: true,
    careportalEnabled: enable.includes("careportal"),
    boluscalcEnabled: enable.includes("boluscalc"),
    settings,
    extendedSettings,
    authorized,
    runtimeState: "loaded",
  };
}

/** Exact field set/order used by locked Nightscout's Socket.IO authorize path. */
export function nightscoutWebsocketStatus(
  now = new Date(),
  activeProfile?: unknown,
  authDefaultRoles = "readable",
  settingsOverrides: NightscoutStatusSettingsOverrides = {},
): Record<string, unknown> {
  const httpStatus = nightscoutStatus(now, authDefaultRoles, settingsOverrides);
  const websocketStatus: Record<string, unknown> = {
    status: "ok",
    name: "Nightscout",
    version: "15.0.8",
    versionNum: 150007,
    serverTime: now.toISOString(),
    apiEnabled: true,
    careportalEnabled: httpStatus.careportalEnabled,
    boluscalcEnabled: httpStatus.boluscalcEnabled,
    settings: httpStatus.settings,
    extendedSettings: httpStatus.extendedSettings,
  };
  if (activeProfile !== undefined && activeProfile !== null) {
    websocketStatus.activeProfile = activeProfile;
  }
  return websocketStatus;
}
