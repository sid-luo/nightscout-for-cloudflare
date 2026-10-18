// These fixed internal loaders construct their public SGV/MBG/CAL objects
// from this union of fields. SQL selection still runs against the full body.
const ENTRY_FIELDS = [
  "_id", "date", "sgv", "mbg", "device", "direction", "filtered",
  "unfiltered", "noise", "rssi", "scale", "intercept", "slope",
] as const;

const MAX_PROJECTION_NODES = 8_192;
const MAX_PROJECTION_DEPTH = 64;
const MAX_PROJECTION_STRING_CHARACTERS = 256 * 1024;

/** JSON.stringify must preserve every selected value, including nested ones. */
function canSerializeSelectedValues(value: Record<string, unknown>): boolean {
  const work: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  let stringCharacters = 0;
  while (work.length > 0) {
    const current = work.pop()!;
    if (++nodes > MAX_PROJECTION_NODES || current.depth > MAX_PROJECTION_DEPTH) return false;
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value) || Object.is(current.value, -0)) return false;
    } else if (typeof current.value === "string") {
      stringCharacters += current.value.length;
    } else if (Array.isArray(current.value)) {
      if (nodes + work.length + current.value.length > MAX_PROJECTION_NODES) return false;
      for (const child of current.value) work.push({ value: child, depth: current.depth + 1 });
    } else if (typeof current.value === "object" && current.value !== null) {
      for (const key in current.value) {
        if (!Object.prototype.hasOwnProperty.call(current.value, key)) continue;
        stringCharacters += key.length;
        if (stringCharacters > MAX_PROJECTION_STRING_CHARACTERS ||
          nodes + work.length + 1 > MAX_PROJECTION_NODES) return false;
        work.push({
          value: (current.value as Record<string, unknown>)[key],
          depth: current.depth + 1,
        });
      }
    }
    if (stringCharacters > MAX_PROJECTION_STRING_CHARACTERS) return false;
  }
  return true;
}

/**
 * Retain only fields consumed by the fixed realtime entry loaders. Preserve
 * storage metadata and leave all validation to the original consumers. Any
 * unsafe or expensive projection falls back to the exact original raw row.
 */
export function projectRealtimeEntryRow<Row extends { body: string }>(row: Row): Row {
  try {
    const parsed: unknown = JSON.parse(row.body);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return row;
    const selected: Record<string, unknown> = {};
    for (const field of ENTRY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(parsed, field)) {
        selected[field] = (parsed as Record<string, unknown>)[field];
      }
    }
    if (!canSerializeSelectedValues(selected)) return row;
    return { ...row, body: JSON.stringify(selected) };
  } catch {
    // Invalid JSON, serialization limits and unusual row accessors retain
    // the original consumer's result/error and its observable timing.
    return row;
  }
}
