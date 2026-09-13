/** Nightscout 15.0.8 Profile timezone normalization, without a Node timezone DB. */
export function normalizeProfileTimezone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let zone = value.replace("ETC", "Etc");
  const match = /^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/i.exec(zone);
  if (match) {
    const minutes = Number(match[3] ?? 0);
    if (minutes === 0) zone = `Etc/GMT${match[1] === "+" ? "-" : "+"}${match[2]}`;
    else if (minutes < 60) zone = `${match[1]}${match[2]!.padStart(2, "0")}:${match[3]}`;
  }
  return zone;
}

export type TimezoneFormatter = Pick<Intl.DateTimeFormat, "formatToParts">;

/** Fixed offsets are shifted explicitly; this also works on ICU versions that
 * do not accept +HH:MM in Intl. Invalid names retain upstream's UTC fallback. */
export function profileTimezoneFormatter(
  locale: string,
  options: Intl.DateTimeFormatOptions,
  timezone: string | undefined,
): TimezoneFormatter {
  const zone = normalizeProfileTimezone(timezone);
  const fixed = /^([+-])(\d{2}):(\d{2})$/.exec(zone ?? "");
  if (fixed && Number(fixed[2]) < 24 && Number(fixed[3]) < 60) {
    const offset = (Number(fixed[2]) * 60 + Number(fixed[3])) * (fixed[1] === "+" ? 1 : -1);
    const formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
    return { formatToParts: (date) => formatter.formatToParts(new Date(Number(date ?? Date.now()) + offset * 60_000)) };
  }
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: zone });
  } catch {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
  }
}
