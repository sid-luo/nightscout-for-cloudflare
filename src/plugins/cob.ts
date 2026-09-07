import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import { nightscoutTimes } from "../runtime/times";
import {
  calculateIobTotal,
  type IobProfile,
} from "./iob";

export interface CobProfile extends IobProfile {
  hasData(): boolean;
  getCarbRatio(time?: unknown, specProfile?: string): number | undefined;
  getCarbAbsorptionRate(time?: unknown, specProfile?: string): number | undefined;
}

export const COB_RECENCY_THRESHOLD_MS = nightscoutTimes.mins(30).msecs;

export const COB_INTENTS = [{
  intent: "MetricNow",
  metrics: ["cob", "carbs on board", "carbohydrates on board"],
}] as const;

function record(value: unknown): RealtimeDocument | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RealtimeDocument
    : undefined;
}

function get(document: RealtimeDocument, ...path: string[]): unknown {
  let value: unknown = document;
  for (const part of path) {
    const current = record(value);
    if (current === undefined) return undefined;
    value = current[part];
  }
  return value;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value) || typeof value === "string") return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return true;
}

function inputMills(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return Number(value);
}

function clone<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)]),
    ) as T;
  }
  return value;
}

/** Direct request-local port of locked plugins/cob.fromDeviceStatus(). */
export function cobFromDeviceStatus(
  deviceStatus: RealtimeDocument,
): RealtimeDocument {
  if (get(deviceStatus, "openaps") !== undefined) {
    const openaps = record(deviceStatus.openaps);
    if (openaps === undefined) return {};
    const suggested = record(openaps.suggested);
    const enacted = record(openaps.enacted);
    let lastCob: unknown = null;
    let lastMills: number | null = null;
    if (suggested !== undefined && enacted !== undefined) {
      const suggestedMills = inputMills(suggested.timestamp);
      const enactedMills = inputMills(enacted.timestamp);
      if (enactedMills > suggestedMills) {
        lastCob = enacted.COB;
        lastMills = enactedMills;
      } else {
        lastCob = suggested.COB;
        lastMills = suggestedMills;
      }
    } else if (enacted !== undefined) {
      lastCob = enacted.COB;
      lastMills = inputMills(enacted.timestamp);
    } else if (suggested !== undefined) {
      lastCob = suggested.COB;
      lastMills = inputMills(suggested.timestamp);
    }
    if (lastCob === null || lastMills === null) return {};
    return {
      cob: lastCob,
      source: "OpenAPS",
      device: deviceStatus.device,
      mills: lastMills,
    };
  }

  const loopCob = record(get(deviceStatus, "loop", "cob"));
  if (loopCob !== undefined) {
    return {
      cob: loopCob.cob,
      source: "Loop",
      device: deviceStatus.device,
      mills: inputMills(loopCob.timestamp),
    };
  }
  return {};
}

export function isCobDeviceStatusAvailable(
  deviceStatuses: RealtimeDocument[] = [],
): boolean {
  return deviceStatuses.map(cobFromDeviceStatus).some((status) => !isEmpty(status));
}

/** Direct request-local port of locked plugins/cob.lastCOBDeviceStatus(). */
export function lastCobDeviceStatus(
  deviceStatuses: RealtimeDocument[] = [],
  suppliedTime: number | Date,
): RealtimeDocument {
  const time = inputMills(suppliedTime);
  const futureMills = time + nightscoutTimes.mins(5).msecs;
  const recentMills = time - COB_RECENCY_THRESHOLD_MS;
  return deviceStatuses
    .filter((status) =>
      Number(status.mills) <= futureMills && Number(status.mills) >= recentMills
    )
    .map(cobFromDeviceStatus)
    .filter((status) => !isEmpty(status))
    .sort((left, right) => Number(left.mills) - Number(right.mills))
    .at(-1) ?? {};
}

export function cobDeviceStatusesInTimeRange(
  deviceStatuses: RealtimeDocument[] = [],
  from: number,
  to: number,
): RealtimeDocument[] {
  return deviceStatuses
    .filter((status) => Number(status.mills) > from && Number(status.mills) < to)
    .map(cobFromDeviceStatus)
    .filter((status) => !isEmpty(status))
    .sort((left, right) => Number(left.mills) - Number(right.mills));
}

export interface CobCalculation extends RealtimeDocument {
  initialCarbs: number;
  decayedBy: Date;
  isDecaying: number;
  carbTime: Date;
}

/** Direct port of locked plugins/cob.cobCalc(). */
export function calculateCobTreatment(
  treatment: RealtimeDocument,
  profile: CobProfile,
  lastDecayedBy: number | Date,
  suppliedTime: number | Date,
  specProfile?: string,
): CobCalculation | "" {
  if (!treatment.carbs) return "";
  const time = inputMills(suppliedTime);
  const delay = 20;
  const carbTime = new Date(Number(treatment.mills));
  const carbsPerHour = Number(profile.getCarbAbsorptionRate(treatment.mills, specProfile));
  const carbsPerMinute = carbsPerHour / 60;
  const decayedBy = new Date(carbTime);
  const minutesLeft = (inputMills(lastDecayedBy) - carbTime.getTime()) / 1_000 / 60;
  decayedBy.setMinutes(
    decayedBy.getMinutes() + Math.max(delay, minutesLeft) +
      Number(treatment.carbs) / carbsPerMinute,
  );
  const initialCarbs = delay > minutesLeft
    ? Number.parseInt(String(treatment.carbs))
    : Number.parseInt(String(treatment.carbs)) + minutesLeft * carbsPerMinute;
  const startDecay = new Date(carbTime);
  startDecay.setMinutes(carbTime.getMinutes() + delay);
  const isDecaying = time < inputMills(lastDecayedBy) || time > startDecay.getTime() ? 1 : 0;
  return { initialCarbs, decayedBy, isDecaying, carbTime };
}

/** Direct request-local port of locked plugins/cob.fromTreatments(). */
export function calculateCobFromTreatments(
  treatments: RealtimeDocument[] = [],
  deviceStatuses: RealtimeDocument[] = [],
  profile: CobProfile,
  suppliedTime: number | Date,
  specProfile?: string,
): RealtimeDocument {
  const time = inputMills(suppliedTime);
  const liverSensRatio = 8;
  let totalCob = 0;
  let lastCarbs: RealtimeDocument | null = null;
  let isDecaying = 0;
  let lastDecayedBy: number | Date = 0;

  for (const treatment of treatments) {
    if (treatment.carbs && Number(treatment.mills) < time) {
      lastCarbs = treatment;
      const calculation = calculateCobTreatment(
        treatment,
        profile,
        lastDecayedBy,
        time,
        specProfile,
      );
      if (calculation === "") continue;
      let decaysInHours = (calculation.decayedBy.getTime() - time) / 1_000 / 60 / 60;
      if (decaysInHours > -10) {
        const startActivity = Number(calculateIobTotal(
          treatments,
          deviceStatuses,
          profile,
          lastDecayedBy,
          specProfile,
        ).activity);
        const endActivity = Number(calculateIobTotal(
          treatments,
          deviceStatuses,
          profile,
          calculation.decayedBy,
          specProfile,
        ).activity);
        const averageActivity = (startActivity + endActivity) / 2;
        const delayedCarbs = averageActivity * liverSensRatio /
          Number(profile.getSensitivity(treatment.mills, specProfile)) *
          Number(profile.getCarbRatio(treatment.mills, specProfile));
        const delayMinutes = Math.round(
          delayedCarbs /
            Number(profile.getCarbAbsorptionRate(treatment.mills, specProfile)) * 60,
        );
        if (delayMinutes > 0) {
          calculation.decayedBy.setMinutes(
            calculation.decayedBy.getMinutes() + delayMinutes,
          );
          decaysInHours = (calculation.decayedBy.getTime() - time) / 1_000 / 60 / 60;
        }
      }
      lastDecayedBy = calculation.decayedBy;
      if (decaysInHours > 0) {
        totalCob += Math.min(
          Number(treatment.carbs),
          decaysInHours * Number(profile.getCarbAbsorptionRate(treatment.mills, specProfile)),
        );
        isDecaying = calculation.isDecaying;
      } else {
        totalCob = 0;
      }
    }
  }

  const rawCarbImpact = isDecaying *
    Number(profile.getSensitivity(time, specProfile)) /
    Number(profile.getCarbRatio(time, specProfile)) *
    Number(profile.getCarbAbsorptionRate(time, specProfile)) / 60;
  return {
    decayedBy: lastDecayedBy,
    isDecaying,
    carbs_hr: profile.getCarbAbsorptionRate(time, specProfile),
    rawCarbImpact,
    cob: totalCob,
    lastCarbs,
  };
}

export function calculateCarbImpact(
  rawCarbImpact: number,
  insulinImpact: number,
): { netCarbImpact: number; totalImpact: number } {
  const liverCarbImpact = Math.min(0.7, insulinImpact);
  const netCarbImpact = Math.max(0, rawCarbImpact - liverCarbImpact);
  return { netCarbImpact, totalImpact: netCarbImpact - insulinImpact };
}

function withDisplay(result: RealtimeDocument): RealtimeDocument {
  if (isEmpty(result) || result.cob === undefined) return {};
  const display = Math.round(Number(result.cob) * 10) / 10;
  return { ...result, display, displayLine: `COB: ${display}g` };
}

/** Direct request-local port of locked plugins/cob.cobTotal(). */
export function calculateCobTotal(
  treatments: RealtimeDocument[] = [],
  deviceStatuses: RealtimeDocument[] = [],
  profile: CobProfile | undefined,
  suppliedTime: number | Date = Date.now(),
  specProfile?: string,
  _wallClock = Date.now(),
): RealtimeDocument {
  if (!profile || !profile.hasData()) return {};
  if (
    !profile.getSensitivity(suppliedTime, specProfile) ||
    !profile.getCarbRatio(suppliedTime, specProfile)
  ) return {};
  const time = inputMills(suppliedTime);
  let result = lastCobDeviceStatus(deviceStatuses, time);
  const tenMinutes = nightscoutTimes.mins(10).msecs;
  if (isEmpty(result) || result.cob === null || result.cob === undefined ||
      !Number.isFinite(result.mills) || time - Number(result.mills) > tenMinutes) {
    const treatmentCob = treatments.length > 0
      ? calculateCobFromTreatments(
        treatments,
        deviceStatuses,
        profile,
        time,
        specProfile,
      )
      : {};
    result = clone(treatmentCob);
    result.source = "Care Portal";
    result.treatmentCOB = clone(treatmentCob);
  }
  return withDisplay(result);
}

export function cobVisualization(property: RealtimeDocument): RealtimeDocument {
  if (property.cob === undefined) return {};
  const display = Math.round(Number(property.cob) * 10) / 10;
  const info: RealtimeDocument[] = [];
  const treatmentCob = record(property.treatmentCOB);
  if (treatmentCob?.cob) {
    info.push({ label: "Careportal COB", value: Math.round(Number(treatmentCob.cob) * 10) / 10 });
  }
  const lastCarbs = record(property.lastCarbs) ?? record(treatmentCob?.lastCarbs);
  if (lastCarbs !== undefined) {
    info.push({
      label: "Last Carbs",
      value: `${String(lastCarbs.carbs)}g @ ${new Date(Number(lastCarbs.mills)).toLocaleString()}`,
    });
  }
  return { value: `${display}g`, label: "COB", info };
}

export function cobAssistantResponse(
  property: RealtimeDocument,
  person?: string,
): { title: string; response: string } {
  const value = property.cob ? property.cob : 0;
  return {
    title: "Current COB",
    response: person
      ? `${person.replace("'s", "")} has ${String(value)} carbohydrates on board`
      : `You have ${String(value)} carbohydrates on board`,
  };
}
