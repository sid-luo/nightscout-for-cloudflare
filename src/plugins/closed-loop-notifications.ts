import { profileTimezoneFormatter, type TimezoneFormatter } from "../runtime/timezone";
import type { NightscoutProfileFunctions } from "../profile-functions";
import type { RealtimeDocument } from "../realtime/ddata-snapshot";
import { WARN } from "../runtime/levels";
import { nightscoutTimes } from "../runtime/times";
import {
  calculateLoopProperty,
  loopNotification,
  type LoopPreferences,
} from "./loop";
import {
  calculateOpenApsProperty,
  openApsNotification,
  type OpenApsPreferences,
} from "./openaps";
import {
  calculatePumpProperty,
  preparePumpData,
  pumpNotification,
  type PumpCoreSettings,
  type PumpPreferences,
} from "./pump";

export interface ClosedLoopNotificationOptions {
  pump?: {
    preferences: PumpPreferences;
    settings: PumpCoreSettings;
  };
  openaps?: {
    preferences: OpenApsPreferences;
  };
  loop?: {
    preferences: LoopPreferences;
  };
}

export interface ClosedLoopNotificationEvaluation {
  notifications: RealtimeDocument[];
  nextDueAt: number | null;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function document(value: unknown): RealtimeDocument | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RealtimeDocument
    : undefined;
}

function dateMills(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  return Date.parse(value);
}

function strictMinuteDeadline(value: unknown, minutes: unknown): number | null {
  const base = dateMills(value);
  const count = Number(minutes);
  if (!Number.isFinite(base) || !Number.isFinite(count)) return null;
  // Upstream uses moment(...).add(...).isBefore(now), so equality is still
  // healthy and the first changed millisecond is the logical transition.
  return base + nightscoutTimes.mins(count).msecs + 1;
}

function preferenceMinutes(value: unknown, fallback: number): number {
  return Number(value ? value : fallback);
}

function hasField(value: RealtimeDocument, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function offlineMarkerDeadlines(
  treatments: RealtimeDocument[],
  now: number,
  schedule: (deadline: number | null) => void,
): boolean {
  let active = false;
  for (const treatment of treatments) {
    if (treatment.eventType !== "OpenAPS Offline") continue;
    const startsAt = Number(treatment.mills);
    if (!Number.isFinite(startsAt)) continue;
    const endsAt = treatment.duration
      ? startsAt + nightscoutTimes.mins(Number(treatment.duration)).msecs
      : startsAt;
    if (startsAt > now) schedule(startsAt);
    if (startsAt <= now && Number.isFinite(endsAt) && endsAt >= now) {
      active = true;
      // The locked marker predicate includes its end instant.
      schedule(endsAt + 1);
    }
  }
  return active;
}

function formatterForTimezone(timezone: string | undefined): TimezoneFormatter {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  };
  return profileTimezoneFormatter("en-CA", options, timezone);
}

function zonedParts(formatter: TimezoneFormatter, at: number): ZonedParts {
  const parts = formatter.formatToParts(new Date(at));
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

function calendarEpoch(parts: ZonedParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

function sameZonedParts(left: ZonedParts, right: ZonedParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute
    && left.second === right.second;
}

function localTarget(
  current: ZonedParts,
  secondsAfterMidnight: number,
  dayOffset: number,
): ZonedParts {
  const asCalendar = new Date(Date.UTC(
    current.year,
    current.month - 1,
    current.day + dayOffset,
    0,
    0,
    secondsAfterMidnight,
  ));
  return {
    year: asCalendar.getUTCFullYear(),
    month: asCalendar.getUTCMonth() + 1,
    day: asCalendar.getUTCDate(),
    hour: asCalendar.getUTCHours(),
    minute: asCalendar.getUTCMinutes(),
    second: asCalendar.getUTCSeconds(),
  };
}

function zonedTargetToEpoch(
  formatter: TimezoneFormatter,
  target: ZonedParts,
  after: number,
): number | null {
  const targetCalendar = calendarEpoch(target);
  let guess = targetCalendar;
  for (let index = 0; index < 4; index += 1) {
    const represented = calendarEpoch(zonedParts(formatter, guess));
    const adjustment = targetCalendar - represented;
    if (adjustment === 0) break;
    guess += adjustment;
  }

  // The half-hour probes cover ordinary and half-hour DST folds without
  // retaining a timezone database or a cross-tenant formatter cache.
  let selected: number | null = null;
  for (let offset = -4; offset <= 4; offset += 1) {
    const candidate = guess + offset * 30 * 60_000;
    if (candidate <= after || !sameZonedParts(zonedParts(formatter, candidate), target)) continue;
    selected = selected === null ? candidate : Math.min(selected, candidate);
  }
  return selected;
}

/**
 * Find the next exact whole-second boundary used by the locked pump battery
 * quiet-night predicate. This avoids waking a Free-plan Durable Object once
 * per heartbeat throughout the night.
 */
function nextPumpBatteryQuietBoundary(
  now: number,
  profile: NightscoutProfileFunctions | undefined,
  settings: PumpCoreSettings,
): number | null {
  if (!profile?.hasData() || !profile.getTimezone()) return null;
  const start = Number(settings.dayStart ?? 7);
  const end = Number(settings.dayEnd ?? 21);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const firstWarnSecond = Math.max(0, Math.ceil(start * 3_600));
  const lastWarnSecond = Math.min(86_399, Math.floor(end * 3_600));
  if (firstWarnSecond > lastWarnSecond) return null;
  if (firstWarnSecond === 0 && lastWarnSecond === 86_399) return null;

  const formatter = formatterForTimezone(profile.getTimezone());
  const current = zonedParts(formatter, now);
  const currentSecond = current.hour * 3_600 + current.minute * 60 + current.second;
  const warningEnabled = currentSecond >= firstWarnSecond && currentSecond <= lastWarnSecond;
  let targetSecond: number;
  let firstDayOffset: number;
  if (warningEnabled) {
    targetSecond = lastWarnSecond + 1;
    firstDayOffset = targetSecond >= 86_400 ? 1 : 0;
    targetSecond %= 86_400;
  } else {
    targetSecond = firstWarnSecond;
    firstDayOffset = currentSecond < firstWarnSecond ? 0 : 1;
  }

  // A DST spring-forward can make one wall-clock target nonexistent. The
  // following local day is a deterministic, bounded fallback.
  for (let offset = firstDayOffset; offset <= firstDayOffset + 2; offset += 1) {
    const candidate = zonedTargetToEpoch(
      formatter,
      localTarget(current, targetSecond, offset),
      now,
    );
    if (candidate !== null) return candidate;
  }
  return null;
}

/**
 * Cloudflare scheduling adapter for the locked Pump/OpenAPS/Loop notification
 * producers. It executes the existing direct plugin ports and only derives
 * the next persisted logical deadline needed to replace Node's setInterval.
 */
export function calculateClosedLoopNotificationEvaluation(
  deviceStatuses: RealtimeDocument[],
  treatments: RealtimeDocument[],
  profile: NightscoutProfileFunctions | undefined,
  now: number,
  heartbeatMs: number,
  options: ClosedLoopNotificationOptions,
): ClosedLoopNotificationEvaluation {
  const notifications: RealtimeDocument[] = [];
  let nextDueAt: number | null = null;
  const schedule = (deadline: number | null): void => {
    if (deadline === null || !Number.isFinite(deadline) || deadline <= now) return;
    const normalized = Math.trunc(deadline);
    nextDueAt = nextDueAt === null ? normalized : Math.min(nextDueAt, normalized);
  };
  const active = (notification: RealtimeDocument | null): void => {
    if (notification === null) return;
    notifications.push(notification);
    schedule(now + heartbeatMs);
  };

  const usesOfflineMarkers = options.pump !== undefined || options.openaps !== undefined;
  const offlineActive = usesOfflineMarkers
    ? offlineMarkerDeadlines(treatments, now, schedule)
    : false;

  for (const status of deviceStatuses) {
    const outerMills = Number(status.mills);
    if (!Number.isFinite(outerMills)) continue;
    if (outerMills > now) {
      if (
        (!offlineActive && options.pump !== undefined && hasField(status, "pump"))
        || (!offlineActive && options.openaps !== undefined && hasField(status, "openaps"))
        || (options.loop !== undefined && hasField(status, "loop"))
      ) schedule(outerMills);
      continue;
    }
    if (!offlineActive && options.pump !== undefined && hasField(status, "pump")) {
      const urgent = preferenceMinutes(options.pump.preferences.urgentClock, 60);
      schedule(outerMills + nightscoutTimes.mins(urgent * 2).msecs + 1);
    }
    if (!offlineActive && options.openaps !== undefined && hasField(status, "openaps")) {
      schedule(outerMills + nightscoutTimes.hours(6).msecs + 1);
    }
    if (options.loop !== undefined && hasField(status, "loop")) {
      schedule(outerMills + nightscoutTimes.hours(6).msecs + 1);
    }
  }

  // Preserve the locked server registry order within this adapter: Pump,
  // OpenAPS, then Loop. Notification arbitration is order-sensitive.
  if (options.pump !== undefined) {
    const { preferences, settings } = options.pump;
    const property = calculatePumpProperty(
      deviceStatuses,
      treatments,
      profile,
      now,
      preferences,
      settings,
    );
    const rawPump = document(property.pump);
    const clock = rawPump?.clock;
    if (!offlineActive) {
      schedule(strictMinuteDeadline(
        clock,
        preferenceMinutes(preferences.warnClock, 30),
      ));
      schedule(strictMinuteDeadline(
        clock,
        preferenceMinutes(preferences.urgentClock, 60),
      ));
    }

    const notification = pumpNotification(
      property,
      treatments,
      profile,
      now,
      preferences,
      settings,
    );
    active(notification);

    if (!offlineActive && preferences.warnBattQuietNight) {
      const unrestricted = preparePumpData(
        property,
        treatments,
        profile,
        now,
        { ...preferences, warnBattQuietNight: false },
        settings,
      );
      if (Number(document(unrestricted.battery)?.level) >= WARN) {
        schedule(nextPumpBatteryQuietBoundary(now, profile, settings));
      }
    }
  }

  if (options.openaps !== undefined) {
    const preferences = options.openaps.preferences;
    const property = calculateOpenApsProperty(deviceStatuses, now, preferences);
    if (!offlineActive) {
      schedule(strictMinuteDeadline(
        property.lastLoopMoment,
        preferenceMinutes(preferences.warn, 30),
      ));
      schedule(strictMinuteDeadline(
        property.lastLoopMoment,
        preferenceMinutes(preferences.urgent, 60),
      ));
    }
    active(openApsNotification(property, treatments, now, preferences));
  }

  if (options.loop !== undefined) {
    const preferences = options.loop.preferences;
    const property = calculateLoopProperty(deviceStatuses, now, preferences);
    schedule(strictMinuteDeadline(
      property.lastOkMoment,
      preferenceMinutes(preferences.warn, 30),
    ));
    schedule(strictMinuteDeadline(
      property.lastOkMoment,
      preferenceMinutes(preferences.urgent, 60),
    ));
    active(loopNotification(property, now, preferences));
  }

  return { notifications, nextDueAt };
}
