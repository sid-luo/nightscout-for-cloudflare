import { sanitizeStoredDocument } from "../storage-purifier";
import type { DocumentFilter, DocumentSort } from "../document-repository";
import type { JsonDocument, JsonValue } from "../entry-store";
import { compileMongoRegexToSqlGlob, SafeRegexError } from "../safe-regex";

export const API3_MAX_LIMIT = 1_000;
const MIN_TIMESTAMP = Date.UTC(2000, 0, 1);
const MIN_UTC_OFFSET = -1_440;
const MAX_UTC_OFFSET = 1_440;
const MAX_FIELD_LENGTH = 512;
const SAFE_FIELD = /^[A-Za-z0-9_,.-]+$/;
const FILTER_PARAMETER = /^(.*)\$([a-zA-Z]+)$/;
const FILTER_OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "re"]);
const RESERVED_PARAMETERS = new Set([
  "tenant",
  "token",
  "sort",
  "sort$desc",
  "limit",
  "skip",
  "fields",
  "now",
]);
const RESERVED_DOCUMENT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_DOCUMENT_DEPTH = 16;
const MAX_STRING_LENGTH = 64 * 1_024;
const UUID_NAMESPACE = new TextEncoder().encode("NightscoutRocks!");

export const API3_MESSAGES = {
  badBody: "Bad or missing request body",
  badDate: "Bad or missing date field",
  badUtcOffset: "Bad or missing utcOffset field",
  badApp: "Bad or missing app field",
  badIdentifier: "Bad or missing identifier field",
  badLimit: "Parameter limit out of tolerance",
  badSkip: "Parameter skip out of tolerance",
  combinedSort: "Parameters sort and sort_desc cannot be combined",
  badLastModified: "Bad or missing Last-Modified header/parameter",
  unsupportedFormat: "Unsupported output format requested",
} as const;

export class Api3InputError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly controlledDifference = false,
  ) {
    super(message);
    this.name = "Api3InputError";
  }
}

export interface Api3SearchInput {
  filters: DocumentFilter[];
  sort: DocumentSort[];
  limit: number;
  skip: number;
  fields?: string[];
}

export interface Api3HistoryInput {
  since: number;
  inclusive: boolean;
  limit: number;
  fields?: string[];
}

function queryValues(url: URL, name: string): string[] {
  return url.searchParams.getAll(name);
}

/** Express' extended query parser returns an array for a repeated scalar. */
function expressScalar(values: string[]): string | string[] | undefined {
  if (values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values;
}

function jsPropertyKey(value: string | string[]): string {
  return Array.isArray(value) ? value.toString() : value;
}

function queryTruthy(value: string | string[] | undefined): boolean {
  return Array.isArray(value) || (value !== undefined && value.length > 0);
}

function assertSafeField(field: string, kind: "filter" | "sort" | "projection"): void {
  if (
    field.length === 0
    || field.length > MAX_FIELD_LENGTH
    || !SAFE_FIELD.test(field)
    || field.startsWith(".")
    || field.endsWith(".")
    || field.includes("..")
  ) {
    throw new Api3InputError(
      400,
      `Invalid ${kind} field ${field || "(empty)"}`,
      true,
    );
  }
}

function strictNumberInString(value: string): boolean {
  if (value.trim().length === 0) return false;
  return !Number.isNaN(Number.parseFloat(value)) && Number.isFinite(Number(value));
}

function utcOffsetFromString(value: string): number {
  if (/[zZ]$/.test(value)) return 0;
  const match = /([+-])(\d{2}):?(\d{2})$/.exec(value);
  if (match === null) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function timestampValue(value: unknown): { timestamp: number; utcOffset: number } | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = timestampValue(item);
      if (parsed !== null) return parsed;
    }
    return null;
  }

  let numeric: number | null = null;
  if (typeof value === "number" && Number.isFinite(value)) {
    numeric = value;
  } else if (typeof value === "string" && strictNumberInString(value)) {
    numeric = Number.parseFloat(value);
  }
  if (numeric !== null) {
    const milliseconds = numeric < MIN_TIMESTAMP ? numeric * 1_000 : numeric;
    return Number.isFinite(milliseconds) && milliseconds >= MIN_TIMESTAMP
      ? { timestamp: Math.trunc(milliseconds), utcOffset: 0 }
      : null;
  }

  if (typeof value !== "string" || value.length === 0) return null;
  const normalizedFraction = value.replace(/(\d{2}:\d{2}:\d{2}),(\d+)/, "$1.$2");
  const parsed = Date.parse(normalizedFraction);
  return Number.isFinite(parsed) && parsed >= MIN_TIMESTAMP
    ? { timestamp: Math.trunc(parsed), utcOffset: utcOffsetFromString(value) }
    : null;
}

function parseFilterValue(field: string, value: string | string[]): JsonValue {
  let parsed: JsonValue;
  if (Array.isArray(value)) {
    parsed = value;
  } else if (strictNumberInString(value)) {
    parsed = Number.parseFloat(value);
  } else if (value === "true") {
    parsed = true;
  } else if (value === "false") {
    parsed = false;
  } else if (value.startsWith("'") && value.endsWith("'")) {
    parsed = value.slice(1, -1);
  } else {
    parsed = value;
  }

  if (["date", "srvModified", "srvCreated"].includes(field)) {
    const timestamp = timestampValue(parsed);
    if (timestamp !== null) return timestamp.timestamp;
  }
  if (field === "created_at") {
    const timestamp = timestampValue(parsed);
    if (timestamp !== null) return new Date(timestamp.timestamp).toISOString();
  }
  return parsed;
}

export function normalizeApi3MaxLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return API3_MAX_LIMIT;
  // Upstream allows deployments to raise this without a ceiling. The Workers
  // Free adapter deliberately keeps the existing 1,000-document resource cap,
  // while preserving the useful upstream ability to configure a lower limit.
  return Math.min(parsed, API3_MAX_LIMIT);
}

function parseLimit(url: URL, configuredMaxLimit: unknown = API3_MAX_LIMIT): number {
  const maxLimit = normalizeApi3MaxLimit(configuredMaxLimit);
  const value = expressScalar(queryValues(url, "limit"));
  if (!queryTruthy(value)) return maxLimit;
  if (value === undefined || Array.isArray(value)) {
    throw new Api3InputError(400, API3_MESSAGES.badLimit);
  }
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && numeric > 0 && numeric <= maxLimit) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : maxLimit;
  }
  throw new Api3InputError(400, API3_MESSAGES.badLimit);
}

function parseSkip(url: URL): number {
  const value = expressScalar(queryValues(url, "skip"));
  if (!queryTruthy(value)) return 0;
  if (value === undefined || Array.isArray(value)) {
    throw new Api3InputError(400, API3_MESSAGES.badSkip);
  }
  const numeric = Number(value);
  if (!Number.isNaN(numeric) && numeric >= 0) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 0;
    if (!Number.isSafeInteger(parsed)) {
      throw new Api3InputError(400, API3_MESSAGES.badSkip, true);
    }
    return parsed;
  }
  throw new Api3InputError(400, API3_MESSAGES.badSkip);
}

export function parseApi3Fields(url: URL): string[] | undefined {
  const value = expressScalar(queryValues(url, "fields"));
  if (!queryTruthy(value) || value === "_all") return undefined;
  if (value === undefined || Array.isArray(value)) {
    throw new Api3InputError(400, "Invalid fields parameter", true);
  }
  const fields = value.split(",");
  for (const field of fields) assertSafeField(field, "projection");
  return fields;
}

function appendSortField(sort: DocumentSort[], field: string, direction: "asc" | "desc"): void {
  if (sort.some((item) => item.field === field)) return;
  sort.push({ field, direction });
}

export function parseApi3Sort(url: URL): DocumentSort[] {
  const ascending = expressScalar(queryValues(url, "sort"));
  const descending = expressScalar(queryValues(url, "sort$desc"));
  if (queryTruthy(ascending) && queryTruthy(descending)) {
    throw new Api3InputError(400, API3_MESSAGES.combinedSort);
  }

  const direction = queryTruthy(descending) ? "desc" : "asc";
  const explicit = queryTruthy(descending)
    ? jsPropertyKey(descending!)
    : queryTruthy(ascending)
      ? jsPropertyKey(ascending!)
      : null;
  const sort: DocumentSort[] = [];
  if (explicit !== null) {
    assertSafeField(explicit, "sort");
    appendSortField(sort, explicit, direction);
  }
  for (const field of ["identifier", "created_at", "date"]) {
    appendSortField(sort, field, direction);
  }
  return sort;
}

export function parseApi3Search(
  url: URL,
  configuredMaxLimit: unknown = API3_MAX_LIMIT,
): Api3SearchInput {
  // Locked mongoCollection.utils.parseFilter() assigns each condition to an
  // object property. A later condition for the same field therefore replaces
  // the earlier one, and its final onlyValid clause replaces a caller-supplied
  // isValid condition. Preserve those observable semantics before SQL sees the
  // query instead of incorrectly ANDing every parameter.
  const filtersByField = new Map<string, DocumentFilter>();
  const parameterNames = new Set(url.searchParams.keys());
  for (const name of parameterNames) {
    if (RESERVED_PARAMETERS.has(name)) continue;
    let field = name;
    let operator = "eq";
    const match = FILTER_PARAMETER.exec(name);
    if (match !== null) {
      field = match[1]!;
      operator = match[2]!;
      if (!FILTER_OPERATORS.has(operator)) {
        throw new Api3InputError(400, `Unsupported filter operator ${operator}`);
      }
    }
    assertSafeField(field, "filter");
    const raw = expressScalar(queryValues(url, name));
    if (raw === undefined) continue;
    const value = operator === "in" || operator === "nin"
      ? jsPropertyKey(raw)
      : parseFilterValue(field, raw);
    if (operator === "re") {
      try {
        // Locked parseValue() removes paired single quotes before the Mongo
        // driver receives a regex. Validate the same normalized value that
        // the repository will compile, not the raw query token.
        compileMongoRegexToSqlGlob(String(value));
      } catch (error) {
        if (error instanceof SafeRegexError) {
          throw new Api3InputError(400, error.message, true);
        }
        throw error;
      }
    }
    if (field !== "isValid") {
      filtersByField.set(field, {
        field,
        operator: operator as DocumentFilter["operator"],
        value,
      });
    }
  }

  const fields = parseApi3Fields(url);
  const result: Api3SearchInput = {
    filters: [...filtersByField.values()],
    sort: parseApi3Sort(url),
    limit: parseLimit(url, configuredMaxLimit),
    skip: parseSkip(url),
  };
  if (fields !== undefined) result.fields = fields;
  return result;
}

export function parseApi3History(
  url: URL,
  lastModifiedPath: string | undefined,
  lastModifiedHeader: string | null,
  configuredMaxLimit: unknown = API3_MAX_LIMIT,
): Api3HistoryInput {
  let since: number;
  let inclusive: boolean;
  if (lastModifiedPath !== undefined) {
    const parsed = timestampValue(lastModifiedPath);
    if (parsed === null) throw new Api3InputError(400, API3_MESSAGES.badLastModified);
    since = parsed.timestamp;
    inclusive = false;
  } else {
    if (lastModifiedHeader === null || lastModifiedHeader.length === 0) {
      throw new Api3InputError(400, API3_MESSAGES.badLastModified);
    }
    const parsed = timestampValue(lastModifiedHeader);
    if (parsed === null) throw new Api3InputError(400, API3_MESSAGES.badLastModified);
    since = Math.floor(parsed.timestamp / 1_000) * 1_000;
    inclusive = true;
  }
  const fields = parseApi3Fields(url);
  const result: Api3HistoryInput = {
    since,
    inclusive,
    limit: parseLimit(url, configuredMaxLimit),
  };
  if (fields !== undefined) result.fields = fields;
  return result;
}

function assertJson(value: unknown, depth = 0): void {
  if (depth > MAX_DOCUMENT_DEPTH) throw new Api3InputError(400, API3_MESSAGES.badBody);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Api3InputError(400, API3_MESSAGES.badBody);
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) throw new Api3InputError(400, API3_MESSAGES.badBody);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item, depth + 1);
    return;
  }
  if (typeof value !== "object") throw new Api3InputError(400, API3_MESSAGES.badBody);
  for (const [key, item] of Object.entries(value)) {
    if (RESERVED_DOCUMENT_KEYS.has(key) || key.startsWith("$")) {
      throw new Api3InputError(400, API3_MESSAGES.badBody, true);
    }
    assertJson(item, depth + 1);
  }
}

export function parseApi3Document(value: unknown): JsonDocument {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.keys(value).length === 0
  ) {
    throw new Api3InputError(400, API3_MESSAGES.badBody);
  }
  assertJson(value);
  try {
    return sanitizeStoredDocument(value as JsonDocument);
  } catch (error) {
    if (error instanceof RangeError) throw new Api3InputError(400, error.message);
    throw error;
  }
}

export function normalizeApi3Date(document: JsonDocument): void {
  const parsed = timestampValue([document.date, document.created_at]);
  if (parsed === null) return;
  document.date = parsed.timestamp;
  if (document.utcOffset === undefined) document.utcOffset = parsed.utcOffset;
  document.created_at = new Date(parsed.timestamp).toISOString();
}

export function validateApi3Common(document: JsonDocument, patching = false): void {
  if (
    (!patching || document.date !== undefined)
    && (typeof document.date !== "number" || document.date <= MIN_TIMESTAMP)
  ) {
    throw new Api3InputError(400, API3_MESSAGES.badDate);
  }
  if (
    (!patching || document.utcOffset !== undefined)
    && (
      typeof document.utcOffset !== "number"
      || document.utcOffset < MIN_UTC_OFFSET
      || document.utcOffset > MAX_UTC_OFFSET
    )
  ) {
    throw new Api3InputError(400, API3_MESSAGES.badUtcOffset);
  }
  if (
    (!patching || document.app !== undefined)
    && (typeof document.app !== "string" || document.app.trim().length === 0)
  ) {
    throw new Api3InputError(400, API3_MESSAGES.badApp);
  }
}

function uuidString(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export async function calculateApi3Identifier(document: JsonDocument): Promise<string> {
  let key = `${String(document.device)}_${String(document.date)}`;
  if (document.eventType) key += `_${String(document.eventType)}`;
  const keyBytes = new TextEncoder().encode(key);
  const source = new Uint8Array(UUID_NAMESPACE.byteLength + keyBytes.byteLength);
  source.set(UUID_NAMESPACE);
  source.set(keyBytes, UUID_NAMESPACE.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", source));
  const uuid = digest.slice(0, 16);
  uuid[6] = (uuid[6]! & 0x0f) | 0x50;
  uuid[8] = (uuid[8]! & 0x3f) | 0x80;
  return uuidString(uuid);
}

export async function resolveApi3Identifier(document: JsonDocument): Promise<void> {
  const calculated = await calculateApi3Identifier(document);
  if (!document.identifier) document.identifier = calculated;
}

export function validateApi3Identifier(document: JsonDocument): void {
  if (typeof document.identifier !== "string" || document.identifier.trim().length === 0) {
    throw new Api3InputError(400, API3_MESSAGES.badIdentifier);
  }
}

export function ifUnmodifiedSince(request: Request): number | null {
  const value = request.headers.get("If-Unmodified-Since");
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) * 1_000 : null;
}
