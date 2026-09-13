import { normalizeProfileTimezone, profileTimezoneFormatter } from "./runtime/timezone";
import { nightscoutTimes } from "./runtime/times";

export type NightscoutProfileDocument = Record<string, unknown>;

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

/** Request/isolate-local replacement for the upstream memory-cache instance. */
class ProfileCache {
  readonly #entries = new Map<string, CacheEntry>();

  clear(): void {
    this.#entries.clear();
  }

  get<T>(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  put(key: string, value: unknown, ttl: number): void {
    this.#entries.set(key, { expiresAt: Date.now() + ttl, value });
  }
}

const CACHE_TTL = 5_000;

function isDocument(value: unknown): value is NightscoutProfileDocument {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scheduleSecondsAt(time: number, timezone: string | undefined): number {
  if (timezone === undefined || timezone.length === 0) {
    const date = new Date(time);
    return date.getHours() * 3_600 + date.getMinutes() * 60 + date.getSeconds();
  }

  const parts = profileTimezoneFormatter("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }, timezone).formatToParts(new Date(time));
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return read("hour") * 3_600 + read("minute") * 60 + read("second");
}

/**
 * Workers-safe port of Nightscout Profile functions, with 15.0.8 timezone handling.
 *
 * The profile selection, profile-switch, Circadian Percentage Profile and
 * temp-basal rules intentionally retain upstream coercion and ordering. Only
 * Node-only lodash/memory-cache/moment-timezone mechanics are replaced by
 * built-ins available in Workers (Map, arrays, Date and Intl).
 */
export class NightscoutProfileFunctions {
  data: NightscoutProfileDocument[] | null = null;
  profiletreatments: NightscoutProfileDocument[] = [];
  tempbasaltreatments: NightscoutProfileDocument[] = [];
  combobolustreatments: NightscoutProfileDocument[] = [];

  readonly #cache = new ProfileCache();
  #prevBasalTreatment: NightscoutProfileDocument | null = null;

  constructor(profileData?: NightscoutProfileDocument[] | null) {
    this.clear();
    if (profileData) this.loadData(profileData);
    this.updateTreatments([], []);
  }

  clear(): void {
    this.#cache.clear();
    this.data = null;
    this.#prevBasalTreatment = null;
  }

  loadData(profileData: NightscoutProfileDocument[]): void {
    if (profileData.length === 0) return;
    this.data = this.convertToProfileStore(profileData);
    for (const record of this.data) {
      if (isDocument(record.store)) {
        for (const storedProfile of Object.values(record.store)) {
          if (isDocument(storedProfile) || Array.isArray(storedProfile)) {
            this.preprocessProfileOnLoad(storedProfile);
          }
        }
      }
      record.mills = new Date(String(record.startDate)).getTime();
    }
  }

  convertToProfileStore(
    dataArray: NightscoutProfileDocument[],
  ): NightscoutProfileDocument[] {
    const convertedProfiles: NightscoutProfileDocument[] = [];
    for (const profile of dataArray) {
      if (!profile.defaultProfile) {
        const startDate = profile.startDate ? profile.startDate : "1980-01-01";
        const id = profile._id;
        delete profile.startDate;
        delete profile._id;
        delete profile.created_at;
        convertedProfiles.push({
          defaultProfile: "Default",
          store: { Default: profile },
          startDate,
          _id: id,
          convertedOnTheFly: true,
        });
      } else {
        delete profile.convertedOnTheFly;
        convertedProfiles.push(profile);
      }
    }
    return convertedProfiles;
  }

  timeStringToSeconds(time: string): number {
    const split = time.split(":");
    return Number.parseInt(split[0] ?? "", 10) * 3_600 +
      Number.parseInt(split[1] ?? "", 10) * 60;
  }

  preprocessProfileOnLoad(
    container: NightscoutProfileDocument | unknown[],
  ): void {
    for (const value of Object.values(container)) {
      if (value === null) continue;
      if (Array.isArray(value)) this.preprocessProfileOnLoad(value);
      if (isDocument(value) && value.time) {
        const seconds = this.timeStringToSeconds(String(value.time));
        if (!Number.isNaN(seconds)) value.timeAsSeconds = seconds;
      }
    }
  }

  getValueByTime(
    suppliedTime: number,
    valueType: string,
    specProfile?: string,
  ): number | undefined {
    let time = suppliedTime;
    if (!time) time = Date.now();

    const minuteTime = Math.round(time / 60_000) * 60_000;
    const cacheKey = `${minuteTime}${valueType}${String(specProfile)}`;
    const cached = this.#cache.get<number>(cacheKey);
    if (cached) return cached;

    let timeshift = 0;
    let percentage = 100;
    const activeTreatment = this.activeProfileTreatmentToTime(time);
    const isCcpProfile = specProfile === undefined &&
      activeTreatment !== null && Boolean(activeTreatment.CircadianPercentageProfile);
    if (isCcpProfile) {
      percentage = Number(activeTreatment.percentage);
      timeshift = Number(activeTreatment.timeshift);
    }
    const offset = timeshift % 24;
    // Preserve the locked implementation's exact arithmetic, including the
    // extra offset multiplier in `offset * times.hours(offset).msecs`.
    time += offset * nightscoutTimes.hours(offset).msecs;

    const current = this.getCurrentProfile(time, specProfile);
    const valueContainer = current[valueType];
    const timezone = this.getTimezone(specProfile);
    const secondsFromMidnight = scheduleSecondsAt(minuteTime, timezone);

    let returnValue = valueContainer;
    if (Array.isArray(valueContainer)) {
      for (const rawValue of valueContainer) {
        if (!isDocument(rawValue)) continue;
        if (secondsFromMidnight >= Number(rawValue.timeAsSeconds)) {
          returnValue = rawValue.value;
        }
      }
    }

    if (returnValue) {
      let numeric = Number.parseFloat(String(returnValue));
      if (isCcpProfile) {
        if (valueType === "sens" || valueType === "carbratio") {
          numeric = numeric * 100 / percentage;
        } else if (valueType === "basal") {
          numeric = numeric * percentage / 100;
        }
      }
      returnValue = numeric;
    }

    const result = typeof returnValue === "number" ? returnValue : undefined;
    this.#cache.put(cacheKey, result, CACHE_TTL);
    return result;
  }

  getCurrentProfile(
    suppliedTime?: number | null,
    specProfile?: string,
  ): NightscoutProfileDocument {
    const time = suppliedTime || Date.now();
    const minuteTime = Math.round(time / 60_000) * 60_000;
    const cacheKey = `profile${minuteTime}${String(specProfile)}`;
    const cached = this.#cache.get<NightscoutProfileDocument>(cacheKey);
    if (cached) return cached;

    const activeRecord = this.profileFromTime(time);
    const profileName = this.activeProfileToTime(time);
    let result: NightscoutProfileDocument = {};
    if (activeRecord !== null && isDocument(activeRecord.store) && profileName !== null) {
      const selected = activeRecord.store[profileName];
      if (isDocument(selected)) result = selected;
    }

    this.#cache.put(cacheKey, result, CACHE_TTL);
    return result;
  }

  getUnits(specProfile?: string): "mmol" | "mg/dl" {
    const profileUnits = `${String(this.getCurrentProfile(null, specProfile).units)} `;
    return profileUnits.toLowerCase().includes("mmol") ? "mmol" : "mg/dl";
  }

  getTimezone(specProfile?: string): string | undefined {
    return normalizeProfileTimezone(this.getCurrentProfile(null, specProfile).timezone);
  }

  hasData(): boolean {
    return this.data !== null;
  }

  getDIA(time?: unknown, specProfile?: string): number | undefined {
    return this.getValueByTime(Number(time), "dia", specProfile);
  }

  getSensitivity(time?: unknown, specProfile?: string): number | undefined {
    return this.getValueByTime(Number(time), "sens", specProfile);
  }

  getCarbRatio(time?: unknown, specProfile?: string): number | undefined {
    return this.getValueByTime(Number(time), "carbratio", specProfile);
  }

  getCarbAbsorptionRate(time?: unknown, specProfile?: string): number | undefined {
    return this.getValueByTime(Number(time), "carbs_hr", specProfile);
  }

  getLowBGTarget(time?: unknown, specProfile?: string): number | undefined {
    return this.getValueByTime(Number(time), "target_low", specProfile);
  }

  getHighBGTarget(time?: unknown, specProfile?: string): number | undefined {
    return this.getValueByTime(Number(time), "target_high", specProfile);
  }

  getBasal(time?: unknown, specProfile?: string): number | undefined {
    return this.getValueByTime(Number(time), "basal", specProfile);
  }

  updateTreatments(
    profileTreatments: NightscoutProfileDocument[] = [],
    tempBasalTreatments: NightscoutProfileDocument[] = [],
    comboBolusTreatments: NightscoutProfileDocument[] = [],
  ): void {
    this.profiletreatments = profileTreatments;
    const seenMills = new Set<unknown>();
    this.tempbasaltreatments = tempBasalTreatments.filter((treatment) => {
      if (seenMills.has(treatment.mills)) return false;
      seenMills.add(treatment.mills);
      return true;
    });
    for (const treatment of this.tempbasaltreatments) {
      treatment.endmills = Number(treatment.mills) +
        nightscoutTimes.mins(Number(treatment.duration || 0)).msecs;
    }
    this.tempbasaltreatments.sort(
      (left, right) => Number(left.mills) - Number(right.mills),
    );
    this.combobolustreatments = comboBolusTreatments;
    this.#cache.clear();
  }

  activeProfileToTime(suppliedTime?: unknown): string | null {
    if (!this.hasData()) return null;
    const time = Number(suppliedTime) || Date.now();
    const activeRecord = this.profileFromTime(time);
    if (activeRecord === null) return null;
    let profileName = String(activeRecord.defaultProfile);
    const treatment = this.activeProfileTreatmentToTime(time);
    if (
      treatment !== null &&
      typeof treatment.profile === "string" &&
      isDocument(activeRecord.store) &&
      isDocument(activeRecord.store[treatment.profile])
    ) {
      profileName = treatment.profile;
    }
    return profileName;
  }

  activeProfileTreatmentToTime(suppliedTime: number): NightscoutProfileDocument | null {
    const minuteTime = Math.round(suppliedTime / 60_000) * 60_000;
    const cacheKey = `profileCache${minuteTime}`;
    const cached = this.#cache.get<NightscoutProfileDocument | null>(cacheKey);
    if (cached) return cached;

    let treatment: NightscoutProfileDocument | null = null;
    if (this.hasData()) {
      const activeRecord = this.profileFromTime(suppliedTime);
      if (activeRecord !== null) {
        for (const candidate of this.profiletreatments) {
          if (
            suppliedTime >= Number(candidate.mills) &&
            Number(candidate.mills) >= Number(activeRecord.mills)
          ) {
            const duration = nightscoutTimes.mins(Number(candidate.duration || 0)).msecs;
            if (
              (duration !== 0 && suppliedTime < Number(candidate.mills) + duration) ||
              duration === 0
            ) {
              treatment = candidate;
              this.injectProfileSwitch(activeRecord, candidate);
            }
          }
        }
      }
    }

    this.#cache.put(cacheKey, treatment, CACHE_TTL);
    return treatment;
  }

  profileSwitchName(name: string): string {
    const index = name.indexOf("@@@@@");
    return index < 0 ? name : name.substring(0, index);
  }

  profileFromTime(time: unknown): NightscoutProfileDocument | null {
    let profileData: NightscoutProfileDocument | null = null;
    if (this.data !== null) {
      profileData = this.data[0] ?? null;
      for (const candidate of this.data) {
        if (Number(time) >= Number(candidate.mills)) {
          profileData = candidate;
          break;
        }
      }
    }
    return profileData;
  }

  tempBasalTreatment(time: number): NightscoutProfileDocument | null {
    if (
      this.#prevBasalTreatment !== null &&
      time >= Number(this.#prevBasalTreatment.mills) &&
      time <= Number(this.#prevBasalTreatment.endmills)
    ) {
      return this.#prevBasalTreatment;
    }

    let first = 0;
    let last = this.tempbasaltreatments.length - 1;
    while (first <= last) {
      const index = first + Math.floor((last - first) / 2);
      const treatment = this.tempbasaltreatments[index]!;
      if (time >= Number(treatment.mills) && time <= Number(treatment.endmills)) {
        this.#prevBasalTreatment = treatment;
        return treatment;
      }
      if (time < Number(treatment.mills)) last = index - 1;
      else first = index + 1;
    }
    return null;
  }

  comboBolusTreatment(time: number): NightscoutProfileDocument | null {
    let treatment: NightscoutProfileDocument | null = null;
    for (const candidate of this.combobolustreatments) {
      const duration = nightscoutTimes.mins(Number(candidate.duration || 0)).msecs;
      if (time < Number(candidate.mills) + duration && time > Number(candidate.mills)) {
        treatment = candidate;
      }
    }
    return treatment;
  }

  getTempBasal(time: number, specProfile?: string): NightscoutProfileDocument {
    const minuteTime = Math.round(time / 60_000) * 60_000;
    const cacheKey = `basalCache${minuteTime}${String(specProfile)}`;
    const cached = this.#cache.get<NightscoutProfileDocument>(cacheKey);
    if (cached) return cached;

    const basal = this.getBasal(time, specProfile);
    let tempbasal = basal;
    let combobolusbasal: unknown = 0;
    const treatment = this.tempBasalTreatment(time);
    const comboBolusTreatment = this.comboBolusTreatment(time);
    if (
      treatment !== null &&
      !Number.isNaN(Number(treatment.absolute)) &&
      Number(treatment.duration) > 0
    ) {
      tempbasal = Number(treatment.absolute);
    } else if (treatment !== null && treatment.percent) {
      tempbasal = Number(basal) * (100 + Number(treatment.percent)) / 100;
    }
    if (comboBolusTreatment !== null && comboBolusTreatment.relative) {
      combobolusbasal = comboBolusTreatment.relative;
    }

    const result: NightscoutProfileDocument = {
      basal,
      treatment,
      combobolustreatment: comboBolusTreatment,
      tempbasal,
      combobolusbasal,
      totalbasal: Number(tempbasal) + Number(combobolusbasal),
    };
    this.#cache.put(cacheKey, result, CACHE_TTL);
    return result;
  }

  listBasalProfiles(): string[] {
    const profiles: string[] = [];
    if (this.data !== null) {
      const current = this.activeProfileToTime();
      if (current !== null) profiles.push(current);
      const store = this.data[0]?.store;
      if (isDocument(store)) {
        for (const key of Object.keys(store)) {
          if (key !== current && !key.includes("@@@@@")) profiles.push(key);
        }
      }
    }
    return profiles;
  }

  private injectProfileSwitch(
    activeRecord: NightscoutProfileDocument,
    treatment: NightscoutProfileDocument,
  ): void {
    if (
      typeof treatment.profileJson !== "string" ||
      typeof treatment.profile !== "string" ||
      !isDocument(activeRecord.store) ||
      activeRecord.store[treatment.profile] !== undefined
    ) {
      return;
    }
    if (!treatment.profile.includes("@@@@@")) {
      treatment.profile += `@@@@@${String(treatment.mills)}`;
    }
    activeRecord.store[treatment.profile] = JSON.parse(treatment.profileJson) as unknown;
  }
}

export function createNightscoutProfileFunctions(
  profileData?: NightscoutProfileDocument[] | null,
): NightscoutProfileFunctions {
  return new NightscoutProfileFunctions(profileData);
}
