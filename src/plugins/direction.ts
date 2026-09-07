import type { RealtimeDocument } from "../realtime/ddata-snapshot";

const DIRECTION_CHARACTERS: Record<string, string> = {
  NONE: "⇼",
  TripleUp: "⤊",
  DoubleUp: "⇈",
  SingleUp: "↑",
  FortyFiveUp: "↗",
  Flat: "→",
  FortyFiveDown: "↘",
  SingleDown: "↓",
  DoubleDown: "⇊",
  TripleDown: "⤋",
  "NOT COMPUTABLE": "-",
  "RATE OUT OF RANGE": "⇕",
};

const DIRECTION_ALIASES: Record<string, string> = {
  ...Object.fromEntries(Object.keys(DIRECTION_CHARACTERS).map((value) =>
    [value.replace(/[\s_-]+/g, "").toLowerCase(), value])),
  up: "SingleUp", down: "SingleDown", slideup: "FortyFiveUp",
  slidedown: "FortyFiveDown", slightup: "FortyFiveUp", slightdown: "FortyFiveDown",
};

export function normalizeDirection(value: unknown): unknown {
  if (!value) return value;
  return DIRECTION_ALIASES[String(value).trim().replace(/[\s_-]+/g, "").toLowerCase()] ?? value;
}

/** Direct stateless port of locked plugins/direction.info(). */
export function nightscoutDirectionInfo(
  sgv: RealtimeDocument | undefined,
): RealtimeDocument {
  const result: RealtimeDocument = { display: null };
  if (sgv === undefined) return result;
  result.value = normalizeDirection(sgv.direction);
  result.label = DIRECTION_CHARACTERS[String(result.value)] ?? "-";
  const label = String(result.label);
  result.entity = label.length > 0 ? `&#${label.charCodeAt(0)};` : "";
  return result;
}

/** Mirrors direction.setProperties() current-data guard. */
export function calculateDirectionProperty(
  sgv: RealtimeDocument | undefined,
  now: number,
): RealtimeDocument | undefined {
  if (sgv === undefined || now - Number(sgv.mills) > 15 * 60_000) return undefined;
  return nightscoutDirectionInfo(sgv);
}

/** Locked updateVisualisation payload, including its low-CGM error override. */
export function directionVisualization(
  property: RealtimeDocument | undefined,
  latestMgdl: unknown,
): RealtimeDocument {
  if (property === undefined || !property.value) return { hide: true };
  const adjusted = { ...property };
  if (Number(latestMgdl) < 39) {
    adjusted.value = "CGM ERROR";
    adjusted.label = "✖";
  }
  return { label: `${String(adjusted.label)}&#xfe0e;`, directHTML: true };
}
