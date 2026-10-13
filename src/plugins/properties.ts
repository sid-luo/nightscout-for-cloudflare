import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import {
  calculateBgnowProperties,
  type NightscoutGlucoseUnits,
} from "./bgnow";
import { calculateDirectionProperty } from "./direction";
import { calculateDatabaseSizeProperty } from "./dbsize";
import {
  calculateCannulaAgeProperty,
  calculateBatteryAgeProperty,
  calculateInsulinAgeProperty,
  calculateSensorAgeProperty,
  type AgePreferences,
} from "./age";
import { calculateLoopProperty } from "./loop";
import { calculateOpenApsProperty, type OpenApsPreferences } from "./openaps";
import {
  calculatePumpProperty,
  type PumpCoreSettings,
  type PumpPreferences,
} from "./pump";
import { calculateIobTotal } from "./iob";
import { calculateCobTotal } from "./cob";
import { calculateRawBgProperty } from "./rawbg";
import {
  createNightscoutProfileFunctions,
  type NightscoutProfileFunctions,
} from "../profile-functions";
import {
  createDefaultPluginCatalogs,
  createNightscoutPluginRegistry,
  type NightscoutPlugin,
  type PluginExecutionSandbox,
} from "./registry";
import {
  calculateUploaderBatteryProperty,
  type UploaderBatteryPreferences,
} from "./upbat";
import { calculateBasalProperty } from "./basal";
import { calculateAr2Property, type Ar2Settings } from "./ar2";
import { calculateBolusWizardPreview } from "./bwp";
import {
  calculateXdripJsProperty,
  type XdripJsPreferences,
} from "./xdripjs";
import { calculateRuntimeStateProperty } from "./runtimestate";

export interface PluginPropertyContext {
  sgvs: RealtimeDocument[];
  mbgs?: RealtimeDocument[];
  cals: RealtimeDocument[];
  devicestatus: RealtimeDocument[];
  treatments?: RealtimeDocument[];
  profiles?: RealtimeDocument[];
  dbstats?: Record<string, unknown>;
}

export interface PluginPropertySource {
  getPluginPropertyContextJson(at: number): Promise<string>;
  getDdataSnapshotJson(at: number, frame: boolean): Promise<string>;
}

const AGE_TREATMENT_WINDOW_MS = 62 * 24 * 60 * 60 * 1_000;
const RUNTIME_TREATMENT_WINDOW_MS = Math.round(2.5 * 24 * 60 * 60 * 1_000);
const PROFILE_SWITCH_WINDOW_MS = 31 * 12 * 24 * 60 * 60 * 1_000;
const AGE_TREATMENT_EVENT_TYPES = new Set([
  "Sensor Start",
  "Sensor Change",
  "Sensor Stop",
  "Site Change",
  "Insulin Change",
  "Pump Battery Change",
]);

interface TreatmentCandidate {
  document: RealtimeDocument;
  index: number;
}

function treatmentCandidateKey(candidate: TreatmentCandidate): string {
  const document = candidate.document;
  if (typeof document._id === "string") return `_id:${document._id}`;
  if (typeof document.identifier === "string") return `identifier:${document.identifier}`;
  return `input:${candidate.index}`;
}

function parsePluginTreatments(value: unknown, now: number): RealtimeDocument[] {
  if (!Array.isArray(value)) return [];
  const recent: TreatmentCandidate[] = [];
  const latestAges = new Map<string, TreatmentCandidate>();
  let latestProfileSwitch: TreatmentCandidate | undefined;
  value.forEach((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return;
    const document = candidate as RealtimeDocument;
    const eventType = document.eventType;
    const mills = Number(document.mills);
    if (!Number.isFinite(mills) || mills > now) return;
    const wrapped = { document, index };
    if (mills >= now - RUNTIME_TREATMENT_WINDOW_MS) recent.push(wrapped);
    if (
      typeof eventType === "string" && AGE_TREATMENT_EVENT_TYPES.has(eventType) &&
      mills >= now - AGE_TREATMENT_WINDOW_MS
    ) {
      const current = latestAges.get(eventType);
      if (current === undefined || mills > Number(current.document.mills)) {
        latestAges.set(eventType, wrapped);
      }
    }
    if (
      eventType === "Profile Switch" && Number(document.duration) === 0 &&
      mills >= now - PROFILE_SWITCH_WINDOW_MS &&
      (latestProfileSwitch === undefined || mills > Number(latestProfileSwitch.document.mills))
    ) latestProfileSwitch = wrapped;
  });
  const selected = new Map<string, TreatmentCandidate>();
  for (const candidate of recent) selected.set(treatmentCandidateKey(candidate), candidate);
  if (latestProfileSwitch !== undefined) {
    selected.set(treatmentCandidateKey(latestProfileSwitch), latestProfileSwitch);
  }
  for (const candidate of latestAges.values()) {
    selected.set(treatmentCandidateKey(candidate), candidate);
  }
  return [...selected.values()]
    .sort((left, right) =>
      Number(left.document.mills) - Number(right.document.mills) || left.index - right.index
    )
    .map((candidate) => candidate.document);
}

export function parsePluginPropertyContext(json: string, now: number): PluginPropertyContext {
  const value = JSON.parse(json) as Partial<PluginPropertyContext>;
  return {
    sgvs: Array.isArray(value.sgvs) ? value.sgvs : [],
    mbgs: Array.isArray(value.mbgs) ? value.mbgs : [],
    cals: Array.isArray(value.cals) ? value.cals : [],
    devicestatus: Array.isArray(value.devicestatus) ? value.devicestatus : [],
    treatments: parsePluginTreatments(value.treatments, now),
    profiles: Array.isArray(value.profiles)
      ? value.profiles.filter((profile): profile is RealtimeDocument =>
        typeof profile === "object" && profile !== null && !Array.isArray(profile)
      )
      : [],
    dbstats: typeof value.dbstats === "object"
        && value.dbstats !== null
        && !Array.isArray(value.dbstats)
      ? value.dbstats
      : {},
  };
}

function missingPropertyContextRpc(error: unknown): boolean {
  return error instanceof Error &&
    error.message.includes("RPC receiver does not implement the method") &&
    error.message.includes("getPluginPropertyContextJson");
}

/**
 * New Worker versions can reach an older, still-live Durable Object isolate
 * during Cloudflare's rolling deployment. Fall back only for that precise
 * missing-method condition; all actual storage/parser failures still surface.
 */
export async function loadPluginPropertyContext(
  source: PluginPropertySource,
  now: number,
): Promise<PluginPropertyContext> {
  try {
    return parsePluginPropertyContext(await source.getPluginPropertyContextJson(now), now);
  } catch (error) {
    if (!missingPropertyContextRpc(error)) throw error;
    return parsePluginPropertyContext(await source.getDdataSnapshotJson(now, false), now);
  }
}

function processProfileTreatmentDurations(
  documents: RealtimeDocument[],
  keepZeroDuration: boolean,
): RealtimeDocument[] {
  const seenMills = new Set<unknown>();
  const treatments = documents
    .filter((document) => {
      if (seenMills.has(document.mills)) return false;
      seenMills.add(document.mills);
      return true;
    })
    .map((document) => JSON.parse(JSON.stringify(document)) as RealtimeDocument);
  const endEvents = treatments.filter((treatment) => !treatment.duration);
  const cutIfInInterval = (
    base: RealtimeDocument,
    end: RealtimeDocument,
  ): void => {
    const baseMills = Number(base.mills);
    const endMills = Number(end.mills);
    if (
      baseMills < endMills
      && baseMills + Number(base.duration) * 60_000 > endMills
    ) {
      base.duration = (endMills - baseMills) / 60_000;
      if (end.profile) {
        base.cuttedby = end.profile;
        end.cutting = base.profile;
      }
    }
  };
  for (const treatment of treatments) {
    if (!treatment.duration) continue;
    for (const end of endEvents) cutIfInInterval(treatment, end);
  }
  for (const treatment of treatments) {
    if (!treatment.duration) continue;
    for (const end of treatments) cutIfInInterval(treatment, end);
  }
  return keepZeroDuration
    ? treatments
    : treatments.filter((treatment) => Boolean(treatment.duration));
}

/** Shared locked profile preprocessing for properties and persisted plugin tasks. */
export function createPluginProfileFunctions(
  context: Pick<PluginPropertyContext, "profiles" | "treatments">,
): NightscoutProfileFunctions {
  const profiles = JSON.parse(JSON.stringify(context.profiles ?? [])) as RealtimeDocument[];
  const profile = createNightscoutProfileFunctions(profiles);
  const treatments = context.treatments ?? [];
  profile.updateTreatments(
    processProfileTreatmentDurations(
      treatments.filter((treatment) => treatment.eventType === "Profile Switch"),
      true,
    ),
    processProfileTreatmentDurations(
      treatments.filter((treatment) =>
        typeof treatment.eventType === "string"
        && treatment.eventType.includes("Temp Basal")
      ),
      false,
    ),
    treatments
      .filter((treatment) => treatment.eventType === "Combo Bolus")
      .map((treatment) => JSON.parse(JSON.stringify(treatment)) as RealtimeDocument),
  );
  return profile;
}

/**
 * Workers-safe equivalent of plugins.setProperties(): execute property
 * setters in locked server-plugin order and only for enabled plugins.
 */
export function calculatePluginProperties(
  context: PluginPropertyContext,
  units: NightscoutGlucoseUnits,
  now: number,
  enabled: ReadonlySet<string>,
  extendedSettings: Record<string, unknown> = {},
  settings: Record<string, unknown> = {},
  runtimeState: unknown = "loaded",
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  let profile: NightscoutProfileFunctions | undefined;
  const pluginProfile = (): NightscoutProfileFunctions => {
    if (profile !== undefined) return profile;
    profile = createPluginProfileFunctions(context);
    return profile;
  };
  const agePreferences = (pluginSandbox: PluginExecutionSandbox): AgePreferences =>
    typeof pluginSandbox.extendedSettings === "object"
        && pluginSandbox.extendedSettings !== null
        && !Array.isArray(pluginSandbox.extendedSettings)
      ? pluginSandbox.extendedSettings as AgePreferences
      : {};
  const pluginPreferences = <T extends Record<string, unknown>>(
    pluginSandbox: PluginExecutionSandbox,
  ): T =>
    typeof pluginSandbox.extendedSettings === "object"
        && pluginSandbox.extendedSettings !== null
        && !Array.isArray(pluginSandbox.extendedSettings)
      ? pluginSandbox.extendedSettings as T
      : {} as T;
  const server: Record<string, Partial<NightscoutPlugin>> = {
    bgnow: {
      setProperties: () => {
        Object.assign(properties, calculateBgnowProperties(context.sgvs, now, units));
      },
    },
    rawbg: {
      setProperties: () => {
        properties.rawbg = calculateRawBgProperty(context.sgvs, context.cals, now, units);
      },
    },
    direction: {
      setProperties: () => {
        const latest = [...context.sgvs].reverse()
          .find((entry) => Number(entry.mills) <= now);
        const direction = calculateDirectionProperty(latest, now);
        if (direction !== undefined) properties.direction = direction;
      },
    },
    upbat: {
      setProperties: (pluginSandbox) => {
        properties.upbat = calculateUploaderBatteryProperty(
          context.devicestatus,
          now,
          pluginPreferences<UploaderBatteryPreferences>(pluginSandbox),
        );
      },
    },
    ar2: {
      setProperties: () => {
        properties.ar2 = calculateAr2Property(
          context.sgvs,
          now,
          settings as Ar2Settings,
        );
      },
    },
    loop: {
      setProperties: () => {
        properties.loop = calculateLoopProperty(context.devicestatus, now);
      },
    },
    openaps: {
      setProperties: (pluginSandbox) => {
        properties.openaps = calculateOpenApsProperty(
          context.devicestatus,
          now,
          pluginPreferences<OpenApsPreferences>(pluginSandbox),
        );
      },
    },
    xdripjs: {
      setProperties: (pluginSandbox) => {
        properties.sensorState = calculateXdripJsProperty(
          context.devicestatus,
          now,
          pluginPreferences<XdripJsPreferences>(pluginSandbox),
        );
      },
    },
    pump: {
      setProperties: (pluginSandbox) => {
        properties.pump = calculatePumpProperty(
          context.devicestatus,
          context.treatments ?? [],
          pluginProfile(),
          now,
          pluginPreferences<PumpPreferences>(pluginSandbox),
          settings as PumpCoreSettings,
        );
      },
    },
    iob: {
      setProperties: () => {
        properties.iob = calculateIobTotal(
          context.treatments ?? [],
          context.devicestatus,
          pluginProfile(),
          now,
        );
      },
    },
    cob: {
      setProperties: () => {
        properties.cob = calculateCobTotal(
          context.treatments ?? [],
          context.devicestatus,
          pluginProfile(),
          now,
        );
      },
    },
    bwp: {
      setProperties: () => {
        properties.bwp = calculateBolusWizardPreview(
          context.sgvs,
          context.treatments ?? [],
          pluginProfile(),
          typeof properties.iob === "object" && properties.iob !== null
            ? properties.iob as RealtimeDocument
            : undefined,
          now,
          { ...settings, units },
          typeof properties.roundingStyle === "string"
            ? properties.roundingStyle
            : undefined,
        );
      },
    },
    cage: {
      setProperties: (pluginSandbox) => {
        properties.cage = calculateCannulaAgeProperty(
          context.treatments ?? [],
          now,
          agePreferences(pluginSandbox),
        );
      },
    },
    sage: {
      setProperties: (pluginSandbox) => {
        properties.sage = calculateSensorAgeProperty(
          context.treatments ?? [],
          now,
          agePreferences(pluginSandbox),
        );
      },
    },
    iage: {
      setProperties: (pluginSandbox) => {
        properties.iage = calculateInsulinAgeProperty(
          context.treatments ?? [],
          now,
          agePreferences(pluginSandbox),
        );
      },
    },
    bage: {
      setProperties: (pluginSandbox) => {
        properties.bage = calculateBatteryAgeProperty(
          context.treatments ?? [],
          now,
          agePreferences(pluginSandbox),
        );
      },
    },
    basal: {
      setProperties: () => {
        const basal = calculateBasalProperty(pluginProfile(), now);
        if (basal !== undefined) properties.basal = basal;
      },
    },
    dbsize: {
      setProperties: (pluginSandbox) => {
        const preferences: Record<string, unknown> =
          typeof pluginSandbox.extendedSettings === "object"
            && pluginSandbox.extendedSettings !== null
            && !Array.isArray(pluginSandbox.extendedSettings)
          ? pluginSandbox.extendedSettings as Record<string, unknown>
          : {};
        properties.dbsize = calculateDatabaseSizeProperty(context.dbstats, preferences);
      },
    },
    runtimestate: {
      setProperties: () => {
        properties.runtimestate = calculateRuntimeStateProperty(runtimeState);
      },
    },
  };
  const registry = createNightscoutPluginRegistry(
    { settings: { enable: [...enabled] } },
    createDefaultPluginCatalogs({ server }),
  ).registerServerDefaults();
  const sandbox = {
    withExtendedSettings(plugin: NightscoutPlugin): PluginExecutionSandbox {
      const selected = extendedSettings[plugin.name];
      return {
        ...sandbox,
        extendedSettings: typeof selected === "object"
            && selected !== null
            && !Array.isArray(selected)
          ? selected
          : {},
      };
    },
  } satisfies PluginExecutionSandbox;
  registry.setProperties(sandbox);
  return properties;
}
