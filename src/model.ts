import { sanitizeStoredDocument } from "./storage-purifier";
import {
  LEGACY_QUERY_DEFAULT_WINDOW_MS,
  LegacyObjectId,
  legacyDateMinimum,
  normalizeLegacyIdValue,
} from "./server-query";

const MAX_ENTRY_BATCH_SIZE = 1_000;
export const LEGACY_ENTRY_DEFAULT_WINDOW_MS = LEGACY_QUERY_DEFAULT_WINDOW_MS;
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type EntryJsonValue =
  | string
  | number
  | boolean
  | null
  | EntryJsonValue[]
  | { [key: string]: EntryJsonValue };

export interface EntryJsonDocument {
  [key: string]: EntryJsonValue;
}

export interface ValidatedEntry {
  documentJson: string;
  requestedId: string | null;
  identifier: string | null;
  identifierPresent: boolean;
  dedupeKey: string;
  sysTime: string;
  date: number;
  direction: string;
  device: string;
  type: string;
}

export interface PublicEntry {
  _id: string;
  identifier?: string | null;
  sgv?: number;
  mbg?: number;
  date: number;
  dateString?: string;
  direction?: string;
  device?: string;
  type?: string;
}

export interface HistoryQuery {
  count: number;
  filters: HistoryFilter[];
  sort: HistorySort[];
  type?: string | null;
}

export type HistoryFilterOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

export interface HistoryFilter {
  field: string;
  operator: HistoryFilterOperator;
  value: string | number;
}

export interface HistorySort {
  field: string;
  direction: "asc" | "desc";
}

export function parseEntryTypeFilter(url: URL): string | null {
  const directValues = url.searchParams.getAll("find[type]");
  const equalityValues = url.searchParams.getAll("find[type][$eq]");
  if (directValues.length > 1 || equalityValues.length > 1) {
    throw new ApiError(400, "invalid_query", "find[type] filters must not be repeated");
  }
  const direct = directValues[0] ?? null;
  const equality = equalityValues[0] ?? null;
  if (direct !== null && equality !== null && direct !== equality) {
    throw new ApiError(400, "invalid_query", "find[type] filters conflict");
  }
  const type = equality ?? direct;
  if (type !== null && (type.length === 0 || type.length > 256)) {
    throw new ApiError(400, "invalid_query", "find[type] has an invalid format");
  }
  return type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  field: string,
  defaultValue: string,
  maxLength: number,
): string {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_entry", `${field} must be a string`);
  }
  if (value.length === 0 || value.length > maxLength) {
    throw new ApiError(400, "invalid_entry", `${field} has an invalid length`);
  }
  return value;
}

function parseDate(entry: Record<string, unknown>): number {
  let date: number;
  if (typeof entry.date === "number" && Number.isFinite(entry.date)) {
    date = Math.trunc(entry.date);
  } else if (
    typeof entry.date === "string"
    && entry.date.trim().length > 0
    && Number.isFinite(Number(entry.date))
  ) {
    date = Math.trunc(Number(entry.date));
  } else if (typeof entry.dateString === "string") {
    date = Date.parse(entry.dateString);
  } else {
    // Locked entries.create() uses moment() when an array item has no usable
    // date. Canonical SQLite requires an indexed date, so persist that same
    // request-time instant explicitly instead of leaving an unqueryable row.
    date = Date.now();
  }

  if (!Number.isSafeInteger(date)) {
    throw new ApiError(400, "invalid_entry", "date must be a safe epoch-millisecond integer");
  }
  return date;
}

function parseIdentity(entry: Record<string, unknown>): {
  requestedId: string | null;
  identifier: string | null;
  identifierPresent: boolean;
} {
  let requestedId: string | null = null;
  let identifier: string | null = null;
  // JSON.stringify omits an own property whose value is undefined. Treat the
  // same in direct RPC/unit-test callers so identity semantics do not depend
  // on whether the payload crossed an HTTP JSON boundary first.
  let identifierPresent = Object.prototype.hasOwnProperty.call(entry, "identifier")
    && entry.identifier !== undefined;

  if (identifierPresent && entry.identifier !== null) {
    if (typeof entry.identifier !== "string" || entry.identifier.length > 4096) {
      throw new ApiError(400, "invalid_entry", "identifier has an invalid format");
    }
    identifier = entry.identifier;
  }

  if (entry._id !== undefined && entry._id !== null && entry._id !== "") {
    if (typeof entry._id !== "string") {
      throw new ApiError(400, "invalid_entry", "_id must be a string");
    }
    if (OBJECT_ID.test(entry._id)) {
      requestedId = entry._id.toLowerCase();
    } else if (!identifier) {
      // Locked v15.0.7 calls this UUID handling, but its actual predicate is
      // every non-ObjectId string. Preserve uploader-owned sync IDs exactly,
      // including the upstream replacement of a null/empty identifier.
      if (entry._id.length > 4096) {
        throw new ApiError(400, "invalid_entry", "_id has an invalid format");
      }
      identifier = entry._id;
      identifierPresent = true;
    }
    // Locked normalizeEntryId() removes every non-ObjectId string `_id` so
    // Mongo can allocate the server-owned primary identity.
  }

  return { requestedId, identifier, identifierPresent };
}

function parsedZoneOffset(value: string): number {
  if (/[zZ]$/.test(value)) return 0;
  const match = /([+-])(\d{2}):?(\d{2})$/.exec(value);
  if (match === null) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function validateEntry(value: unknown): ValidatedEntry {
  if (!isRecord(value)) {
    throw new ApiError(400, "invalid_entry", "each entry must be a JSON object");
  }

  const date = parseDate(value);
  const type = boundedString(value.type, "type", "sgv", 256);
  const direction = boundedString(value.direction, "direction", "NONE", 4096);
  const device = boundedString(value.device, "device", "unknown", 4096);
  const identity = parseIdentity(value);
  const sourceDateString = typeof value.dateString === "string" && value.dateString.length > 0
    ? value.dateString
    : null;
  const sysTimeMillis = sourceDateString === null ? date : Date.parse(sourceDateString);
  if (!Number.isFinite(sysTimeMillis)) {
    throw new ApiError(400, "invalid_entry", "dateString is not a valid timestamp");
  }
  const sysTime = new Date(sysTimeMillis).toISOString();
  const document = { ...value } as EntryJsonDocument;
  delete document._id;
  if (identity.requestedId !== null) document._id = identity.requestedId;
  if (identity.identifierPresent) document.identifier = identity.identifier;
  else delete document.identifier;
  document.date = date;
  // Locked v15.0.7 lib/server/entries.js uses moment.parseZone: sysTime is
  // always normalized to UTC, utcOffset preserves the supplied zone, and a
  // date-only payload does not acquire a dateString field.
  if (sourceDateString === null) delete document.dateString;
  else document.dateString = sysTime;
  document.sysTime = sysTime;
  document.utcOffset = sourceDateString === null ? 0 : parsedZoneOffset(sourceDateString);
  document.type = type;
  document.direction = direction;
  document.device = device;

  return {
    ...identity,
    documentJson: JSON.stringify(document),
    // Locked v15.0.7 lib/server/entries.js always upserts v1 entries by
    // normalized sysTime + type, independently of identifier or device.
    dedupeKey: JSON.stringify([sysTime, type]),
    sysTime,
    date,
    direction,
    device,
    type,
  };
}

export function parseEntryPayload(value: unknown): ValidatedEntry[] {
  const values = Array.isArray(value) ? value : [value];
  if (values.length > MAX_ENTRY_BATCH_SIZE) {
    throw new ApiError(
      413,
      "batch_too_large",
      `batch must contain at most ${MAX_ENTRY_BATCH_SIZE} entries`,
    );
  }
  return values.map(validateEntry);
}

export function legacyEntryPreview(value: unknown): unknown[] {
  const sanitized = Array.isArray(value)
    ? value.map((item) => isRecord(item) ? sanitizeStoredDocument(item) : item)
    : isRecord(value) ? sanitizeStoredDocument(value) : value;
  if (Array.isArray(sanitized)) return sanitized;
  if (isRecord(sanitized) && Object.prototype.hasOwnProperty.call(sanitized, "date")) {
    return [sanitized];
  }
  return [];
}

export function parseLegacyEntryPayload(value: unknown): ValidatedEntry[] {
  // Locked insert_entries accepts a single object only when it owns `date`;
  // an array is passed through by length. Preserve that uploader quirk before
  // the adapter's explicit storage validation. The HTTP adapter already
  // bounds the complete request body to 512 KiB. The 1,000-item ceiling is
  // deliberately above xDrip's 300-item upload queue while preventing an
  // extreme array of tiny documents from monopolizing one Free-plan request.
  return parseEntryPayload(legacyEntryPreview(value));
}

const LEGACY_NUMERIC_ENTRY_FIELDS = new Set([
  "date",
  "sgv",
  "filtered",
  "unfiltered",
  "rssi",
  "noise",
  "mbg",
]);

const LEGACY_STRING_ENTRY_FIELDS = new Set([
  "_id",
  "dateString",
  "device",
  "direction",
  "identifier",
  "sysTime",
]);

const LEGACY_ENTRY_SORT_FIELDS = new Set([
  ...LEGACY_NUMERIC_ENTRY_FIELDS,
  ...LEGACY_STRING_ENTRY_FIELDS,
  "type",
]);

function parseLegacyInteger(value: string, name: string): number {
  // Locked lib/server/query.js recursively applies parseInt without a radix to
  // each numeric Entries query leaf. Preserve that coercion (including 0x)
  // while rejecting NaN before it reaches a Durable Object RPC/SQL binding.
  const parsed = Number.parseInt(value);
  if (!Number.isFinite(parsed)) {
    throw new ApiError(400, "invalid_query", `${name} must begin with an integer`);
  }
  return parsed;
}

function parseAliasTime(value: string | null, name: string): number | null {
  if (value === null || value === "") return null;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ApiError(400, "invalid_query", `${name} must be epoch milliseconds or ISO time`);
  }
  return Math.trunc(parsed);
}

function uniqueParameter(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new ApiError(400, "invalid_query", `${name} must not be repeated`);
  }
  return values[0] ?? null;
}

export function parseHistoryQuery(url: URL): HistoryQuery {
  const rawCount = uniqueParameter(url, "count") || "10";
  const count = Number(rawCount);
  if (!Number.isInteger(count) || count < 1 || count > 10000) {
    throw new ApiError(400, "invalid_query", "count must be an integer from 1 to 10000");
  }

  const type = parseEntryTypeFilter(url);
  const filters: HistoryFilter[] = [];
  const seen = new Set<string>();
  const findPattern = /^find\[([A-Za-z0-9_.-]+)\](?:\[\$(eq|ne|gt|gte|lt|lte)\])?$/;
  for (const [name, value] of url.searchParams) {
    if (!name.startsWith("find[")) continue;
    if (name === "find[type]" || name === "find[type][$eq]") continue;
    if (seen.has(name)) {
      throw new ApiError(400, "invalid_query", `${name} must not be repeated`);
    }
    seen.add(name);
    const match = findPattern.exec(name);
    if (match === null) {
      throw new ApiError(400, "unsupported_query_filter", `unsupported Entries filter ${name}`);
    }
    const field = match[1]!;
    const operator = (match[2] ?? "eq") as HistoryFilterOperator;
    if (!LEGACY_NUMERIC_ENTRY_FIELDS.has(field) && !LEGACY_STRING_ENTRY_FIELDS.has(field)) {
      throw new ApiError(400, "unsupported_query_filter", `unsupported Entries filter ${name}`);
    }
    if (field === "_id" && operator !== "eq") {
      throw new ApiError(400, "unsupported_query_filter", `unsupported Entries filter ${name}`);
    }
    const normalizedId = field === "_id" ? normalizeLegacyIdValue(value).value : value;
    const parsedValue = LEGACY_NUMERIC_ENTRY_FIELDS.has(field)
      ? parseLegacyInteger(value, name)
      : normalizedId instanceof LegacyObjectId
        ? normalizedId.toString()
        : String(normalizedId);
    filters.push({
      field,
      operator,
      value: parsedValue,
    });
  }

  const from = parseAliasTime(uniqueParameter(url, "from"), "from");
  const to = parseAliasTime(uniqueParameter(url, "to"), "to");
  if (from !== null) filters.push({ field: "date", operator: "gte", value: from });
  if (to !== null) filters.push({ field: "date", operator: "lte", value: to });

  const sort: HistorySort[] = [];
  const sortPattern = /^sort\[([A-Za-z0-9_.-]+)\]$/;
  const seenSorts = new Set<string>();
  for (const [name, value] of url.searchParams) {
    if (!name.startsWith("sort[")) continue;
    if (seenSorts.has(name)) {
      throw new ApiError(400, "invalid_query", `${name} must not be repeated`);
    }
    seenSorts.add(name);
    const match = sortPattern.exec(name);
    const field = match?.[1];
    if (field === undefined || !LEGACY_ENTRY_SORT_FIELDS.has(field)) {
      throw new ApiError(400, "unsupported_query_sort", `unsupported Entries sort ${name}`);
    }
    const normalized = value.toLowerCase();
    const direction = normalized === "1" || normalized === "asc" || normalized === "ascending"
      ? "asc"
      : normalized === "-1" || normalized === "desc" || normalized === "descending"
        ? "desc"
        : null;
    if (direction === null) {
      throw new ApiError(400, "invalid_query", `${name} must be 1, -1, asc, or desc`);
    }
    sort.push({ field, direction });
  }
  if (sort.length === 0) sort.push({ field: "date", direction: "desc" });

  // Locked query.js skips its four-day default only for `_id`, date, or
  // dateString predicates. Other filters remain bounded by the date index.
  if (!filters.some((filter) =>
    filter.field === "_id" || filter.field === "date" || filter.field === "dateString"
  )) {
    filters.push({
      field: "date",
      operator: "gte",
      value: legacyDateMinimum(),
    });
  }
  return { count, filters, sort, type };
}

/**
 * Parse the filter portion shared by the locked `/count/:storage/where`
 * aggregate route without inheriting the Entries result-size contract.
 *
 * Upstream ignores `count` and ordinary `sort[...]` options when it builds
 * the `$match` stage, then applies a server-side `$group`. Preserve that
 * behavior so counting a long indexed date range never materializes the
 * matching documents merely to satisfy the ordinary 10,000-row response cap.
 * User-supplied aggregation pipelines remain an explicit Workers safety gap:
 * accepting arbitrary Mongo stages would be code-like query execution rather
 * than a SQLite syntax translation.
 */
export function parseHistoryCountQuery(url: URL): HistoryQuery {
  for (const name of url.searchParams.keys()) {
    if (name === "pipeline" || name.startsWith("pipeline[")) {
      throw new ApiError(
        400,
        "unsupported_query_pipeline",
        "custom count aggregation pipelines are not supported",
      );
    }
  }

  const normalized = new URL(url);
  normalized.searchParams.delete("count");
  const sortNames = new Set(
    [...normalized.searchParams.keys()].filter((name) => name.startsWith("sort[")),
  );
  for (const name of sortNames) normalized.searchParams.delete(name);

  const query = parseHistoryQuery(normalized);
  return { ...query, count: 1, sort: [] };
}
