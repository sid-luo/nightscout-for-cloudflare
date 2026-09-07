import { sanitizeStoredDocument } from "./storage-purifier";
import type { JsonDocument, JsonValue } from "./entry-store";
import { LEGACY_ENTRY_DEFAULT_WINDOW_MS } from "./model";
import type { HistoryQuery, ValidatedEntry } from "./model";
import { compileMongoRegexToSqlGlob } from "./safe-regex";

export type Api3CollectionName =
  | "devicestatus"
  | "entries"
  | "food"
  | "profile"
  | "settings"
  | "treatments";

export type WebsocketRootCollectionName =
  | "activity"
  | "devicestatus"
  | "entries"
  | "food"
  | "profile"
  | "treatments";

type StoredDocumentCollectionName = Api3CollectionName | "activity";

export interface WebsocketRootAddResult {
  documents: JsonDocument[];
  changed: boolean;
}

const TREATMENTS: Api3CollectionName = "treatments";
const DEVICESTATUS: Api3CollectionName = "devicestatus";
const ENTRIES: Api3CollectionName = "entries";
const FOOD: Api3CollectionName = "food";
const PROFILE: Api3CollectionName = "profile";
const SETTINGS: Api3CollectionName = "settings";
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELD_NAME = /^[A-Za-z0-9_,.-]+$/;
const MAX_FIELD_NAME_LENGTH = 512;
const MAX_LIMIT = 10_000;
const MAX_SQL_BINDINGS = 100;
const MAX_SQL_STATEMENT_BYTES = 100_000;
const MAX_UNINDEXED_ENTRY_CANDIDATES = 10_000;
const MAX_SYNCHRONOUS_ENTRY_DELETES = 128;
const API3_MIN_TIMESTAMP = Date.UTC(2000, 0, 1);
const API3_MIN_UTC_OFFSET = -1_440;
const API3_MAX_UTC_OFFSET = 1_440;

function realtimeJsonTruthySql(path: "$.mbg" | "$.sgv"): string {
  const type = `json_type(body, '${path}')`;
  const value = `json_extract(body, '${path}')`;
  return `COALESCE(((${type} IN ('integer', 'real') AND ${value} != 0)
    OR (${type} = 'text' AND length(${value}) > 0)
    OR ${type} IN ('true', 'array', 'object')), 0)`;
}

function realtimeNumericMeasurementSql(path: "$.mbg" | "$.sgv"): string {
  const type = `json_type(body, '${path}')`;
  const value = `json_extract(body, '${path}')`;
  const trimmed = `trim(CAST(${value} AS TEXT))`;
  const safeJson = `(CASE WHEN json_valid(${trimmed}) THEN ${trimmed} ELSE 'null' END)`;
  return `((${type} IN ('integer', 'real') AND ${value} != 0)
    OR (${type} = 'text'
      AND length(${value}) > 0
      AND json_type(${safeJson}) IN ('integer', 'real')
      AND abs(CAST(${value} AS REAL)) <= 1.7976931348623157e308)
    OR ${type} = 'true')`;
}

type FilterOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "nin"
  | "re"
  | "exists";

type MaterializationPolicy = "api3" | "legacy";
type MutationPolicy = "api3" | "legacy";

const API3_IMMUTABLE_FIELDS = [
  "identifier",
  "date",
  "utcOffset",
  "eventType",
  "device",
  "app",
  "srvCreated",
  "subject",
  "srvModified",
  "modifiedBy",
  "isValid",
] as const;

export class DocumentQueryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DocumentQueryError";
  }
}

export interface DocumentFilter {
  field: string;
  operator: FilterOperator;
  value: JsonValue;
}

export interface DocumentSort {
  field: string;
  direction: "asc" | "desc";
}

export interface DocumentQuery {
  filters?: DocumentFilter[];
  /** Arrays are the internal ordered representation; a scalar keeps v1 callers compatible. */
  sort?: DocumentSort | DocumentSort[];
  limit?: number;
  skip?: number;
  fields?: string[];
  includeDeleted?: boolean;
  /** Legacy v1/v2 only; API3 identity behavior is unaffected. */
  legacyUuidHandling?: boolean;
}

export interface DocumentHistoryQuery {
  since: number;
  inclusive?: boolean;
  limit?: number;
  fields?: string[];
}

export interface DocumentMutationResult {
  document: JsonDocument;
  created: boolean;
  deduplicated: boolean;
  revision: number;
  srvModified: number | null;
  deduplicatedIdentifier?: string;
}

export type Api3RealtimeMutationEvent =
  | {
      type: "create" | "update";
      collection: Api3CollectionName;
      document: JsonDocument;
      /**
       * Legacy v1/v2 writes already publish one coalesced root update after
       * their ordered batch. Their API3 `/storage` event must not enqueue a
       * second root update for every item in that batch.
       */
      recordRootUpdate?: boolean;
    }
  | {
      type: "delete";
      collection: Api3CollectionName;
      identifier: string;
      recordRootUpdate?: boolean;
    };

export interface DocumentDeleteResult {
  deleted: boolean;
  permanent: boolean;
  error?: string;
  tooLarge?: boolean;
  revision?: number;
  srvModified?: number;
}

export type Api3MutationFailure =
  | "missing-create-permission"
  | "missing-update-permission"
  | "not-found"
  | "gone"
  | "precondition-failed";

export type Api3MutationDecision =
  | { ok: true; mutation: DocumentMutationResult }
  | { ok: false; reason: Api3MutationFailure }
  | { ok: false; reason: "operation-error"; message: string };

export interface Api3MutationOptions {
  canCreate: boolean;
  canUpdate: boolean;
  actor: string | null;
  ifUnmodifiedSince: number | null;
  /** HTTP API3 enables branch-sensitive validation; compatibility wrappers opt out. */
  validate?: boolean;
  /** The HTTP API3 boundary opts into its upstream `/storage` change event. */
  emitRealtime?: boolean;
}

interface DbDocumentV4 {
  [key: string]: SqlStorageValue;
  id: string;
  body: string;
  sort_time: number;
  created_at: number;
  updated_at: number;
  identifier: string | null;
  identifier_present: number | null;
  srv_created: number | null;
  srv_modified: number | null;
  effective_modified: number | null;
  is_valid: number | null;
  fallback_key: string | null;
  revision: number | null;
  srv_metadata_version: number | null;
}

interface ClockRow {
  [key: string]: SqlStorageValue;
  last_srv_modified: number;
}

interface CountRow {
  [key: string]: SqlStorageValue;
  count: number;
}

interface DbLegacyEntryShadow {
  [key: string]: SqlStorageValue;
  id: string;
  identifier: string | null;
  dedupe_key: string;
  sgv: number | null;
  mbg: number | null;
  date: number;
  date_string: string;
  direction: string;
  device: string;
  type: string;
  created_at: number;
}

interface SqlIndexRow {
  [key: string]: SqlStorageValue;
  name: string;
  unique: number;
  partial: number;
}

interface SqlColumnRow {
  [key: string]: SqlStorageValue;
  name: string;
  notnull: number;
  pk: number;
}

function randomObjectId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseBody(body: string): JsonDocument {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("stored document body is not an object");
  }
  return parsed as JsonDocument;
}

function finiteInteger(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function timestamp(value: JsonValue | undefined): number | null {
  const numeric = finiteInteger(value);
  if (numeric !== null) return numeric;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/**
 * API3 resolves a modification cursor for documents written through older
 * APIs: entries use `date`, the other generic collections use `created_at`,
 * and settings has no fallback. Persisting that cursor avoids re-parsing every
 * JSON document on each NSClientV3 incremental poll.
 */
function effectiveApi3Modified(
  document: JsonDocument,
  srvModified: number | null,
  collection: StoredDocumentCollectionName,
): number | null {
  if (srvModified !== null) return srvModified;
  if (collection === SETTINGS || collection === "activity") return null;
  return timestamp(document[collection === ENTRIES ? "date" : "created_at"]);
}

function sortTime(document: JsonDocument, fallback: number): number {
  for (const field of ["date", "mills", "created_at", "timestamp", "startDate"]) {
    const parsed = timestamp(document[field]);
    if (parsed !== null) return parsed;
  }
  return fallback;
}

function canonicalCreatedAt(value: JsonValue | undefined): JsonValue | undefined {
  if (typeof value !== "string") return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

function fallbackKey(
  document: JsonDocument,
  collection: StoredDocumentCollectionName = TREATMENTS,
): string | null {
  // Locked v15.0.7 lib/api3/generic/setup.js configures the API3 legacy
  // fallback as date+type for entries, created_at+device for devicestatus,
  // created_at alone for food/profile, and created_at+eventType for
  // treatments. Settings deliberately has no fallback identity.
  // This is deliberately separate from v1's sysTime+type upsert selector in
  // lib/server/entries.js. Settings must not inherit the created_at fallback.
  if (collection === SETTINGS || collection === "activity") return null;
  const dateValue = collection === ENTRIES
    ? document.date
    : canonicalCreatedAt(document.created_at);
  if (collection === FOOD || collection === PROFILE) {
    return typeof dateValue === "string" || typeof dateValue === "number"
      ? JSON.stringify([dateValue])
      : null;
  }
  const distinguishingValue = collection === ENTRIES
    ? document.type
    : collection === DEVICESTATUS
      ? document.device
      : document.eventType;
  if (
    (typeof dateValue !== "string" && typeof dateValue !== "number") ||
    (typeof distinguishingValue !== "string" && typeof distinguishingValue !== "number")
  ) {
    return null;
  }
  return JSON.stringify([dateValue, distinguishingValue]);
}

function hasOwn(document: JsonDocument, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(document, field);
}

function identifierMetadata(document: JsonDocument): {
  identifier: string | null;
  present: 0 | 1;
} {
  if (!hasOwn(document, "identifier")) return { identifier: null, present: 0 };
  return {
    identifier: typeof document.identifier === "string" ? document.identifier : null,
    present: 1,
  };
}

function requestedIdentifier(document: JsonDocument): string | null {
  return typeof document.identifier === "string" && document.identifier.length > 0
    ? document.identifier
    : null;
}

function requestedId(document: JsonDocument): string | null {
  return typeof document._id === "string" && OBJECT_ID.test(document._id)
    ? document._id.toLowerCase()
    : null;
}

function assertApi3Common(document: JsonDocument, patching = false): void {
  if (
    (!patching || document.date !== undefined)
    && (typeof document.date !== "number" || document.date <= API3_MIN_TIMESTAMP)
  ) {
    throw new Error("Bad or missing date field");
  }
  if (
    (!patching || document.utcOffset !== undefined)
    && (
      typeof document.utcOffset !== "number"
      || document.utcOffset < API3_MIN_UTC_OFFSET
      || document.utcOffset > API3_MAX_UTC_OFFSET
    )
  ) {
    throw new Error("Bad or missing utcOffset field");
  }
  if (
    (!patching || document.app !== undefined)
    && (typeof document.app !== "string" || document.app.trim().length === 0)
  ) {
    throw new Error("Bad or missing app field");
  }
}

function assertApi3Identifier(document: JsonDocument): void {
  if (typeof document.identifier !== "string" || document.identifier.trim().length === 0) {
    throw new Error("Bad or missing identifier field");
  }
}

function normalizeTreatmentIdentity(
  document: JsonDocument,
  uuidHandling = true,
): JsonDocument {
  const normalized = sanitizeStoredDocument(document);
  if (typeof normalized._id === "string" && !OBJECT_ID.test(normalized._id)) {
    if (uuidHandling && requestedIdentifier(normalized) === null) {
      normalized.identifier = normalized._id;
    }
    delete normalized._id;
  } else if (typeof normalized._id === "string") {
    normalized._id = normalized._id.toLowerCase();
  }
  return normalized;
}

function websocketStorageId(value: JsonValue | undefined): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
  return OBJECT_ID.test(value) ? value.toLowerCase() : value;
}

function websocketSqlScalar(value: JsonValue | undefined): SqlStorageValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return undefined;
}

function websocketFieldPath(field: string): string[] | null {
  if (field.length === 0 || field.length > MAX_FIELD_NAME_LENGTH || field.includes("\0")) {
    return null;
  }
  const path = field.split(".");
  return path.some((segment) => segment.length === 0) ? null : path;
}

function websocketOwnValue(document: JsonDocument, field: string): JsonValue | undefined {
  return Object.prototype.hasOwnProperty.call(document, field)
    ? document[field]
    : undefined;
}

function websocketDefineOwn(
  document: JsonDocument,
  field: string,
  value: JsonValue,
): void {
  // Assignment to the magic `__proto__` setter would mutate an isolate-wide
  // prototype instead of representing Mongo's ordinary BSON field. Defining
  // an enumerable own property preserves the document shape safely.
  Object.defineProperty(document, field, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function websocketSetFields(document: JsonDocument, fields: JsonDocument): JsonDocument {
  const updated = structuredClone(document);
  for (const [field, value] of Object.entries(fields)) {
    const path = websocketFieldPath(field);
    if (path === null || path[0] === "_id") throw new Error("invalid websocket update field");
    let target: JsonDocument = updated;
    for (const segment of path.slice(0, -1)) {
      const current = websocketOwnValue(target, segment);
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        websocketDefineOwn(target, segment, {});
      }
      target = websocketOwnValue(target, segment) as JsonDocument;
    }
    websocketDefineOwn(target, path.at(-1)!, structuredClone(value));
  }
  return updated;
}

function websocketUnsetFields(document: JsonDocument, fields: JsonDocument): JsonDocument {
  const updated = structuredClone(document);
  for (const field of Object.keys(fields)) {
    const path = websocketFieldPath(field);
    if (path === null || path[0] === "_id") throw new Error("invalid websocket unset field");
    let target: JsonDocument | null = updated;
    for (const segment of path.slice(0, -1)) {
      const current = websocketOwnValue(target, segment);
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        target = null;
        break;
      }
      target = current as JsonDocument;
    }
    if (target !== null) delete target[path.at(-1)!];
  }
  return updated;
}

function utcOffsetMinutes(value: JsonValue | undefined): number {
  if (typeof value !== "string") return 0;
  if (/[zZ]$/.test(value)) return 0;
  const match = /([+-])(\d{2}):?(\d{2})$/.exec(value);
  if (match === null) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

interface PreparedLegacyTreatment {
  document: JsonDocument;
  preBolusCarbs: number | "" | null;
}

/**
 * Locked v15.0.7 treatments.prepareData(). It intentionally runs before the
 * v1 upsert selector: created_at is UTC, eventTime overrides it, numeric fields
 * are normalized, and utcOffset still comes from the original created_at
 * value. A truthy preBolus plus carbs moves those carbs into the returned
 * fan-out value; the caller decides whether it is the POST/create path (which
 * creates the shifted record) or the PUT/save path (which does not).
 */
function prepareLegacyTreatment(document: JsonDocument): PreparedLegacyTreatment {
  const normalized = { ...document };
  const originalCreatedAt = normalized.created_at;
  const parsed = typeof originalCreatedAt === "number"
    ? originalCreatedAt
    : typeof originalCreatedAt === "string"
      ? Date.parse(originalCreatedAt)
      : Number.NaN;
  const createdAt = Number.isFinite(parsed) ? new Date(parsed) : new Date();
  normalized.created_at = createdAt.toISOString();
  normalized.utcOffset = utcOffsetMinutes(originalCreatedAt);

  if (normalized.eventTime) {
    const eventTime = new Date(normalized.eventTime as string | number);
    normalized.created_at = eventTime.toISOString();
  }

  // Keep the query-relevant body representation aligned with the locked
  // treatments.prepareData implementation. It eagerly coerces all numeric
  // fields before applying its historical empty/NaN cleanup rules.
  const numericFields = [
    "glucose",
    "targetTop",
    "targetBottom",
    "carbs",
    "insulin",
    "duration",
    "percent",
    "absolute",
    "relative",
    "preBolus",
  ] as const;
  for (const field of numericFields) normalized[field] = Number(normalized[field]);

  // Locked finishUpsert() creates the shifted record for every truthy
  // normalized preBolus, even when carbs are missing/zero. prepareData()
  // initializes that child value to an empty string and only replaces it when
  // the normalized carbs value is truthy.
  const hasPreBolus = Boolean(normalized.preBolus && normalized.preBolus !== 0);
  let preBolusCarbs: number | "" | null = hasPreBolus ? "" : null;
  if (preBolusCarbs !== null && normalized.carbs) {
    preBolusCarbs = Number(normalized.carbs);
    delete normalized.carbs;
  }

  if (normalized.eventType === "Announcement") normalized.isAnnouncement = true;
  delete normalized.eventTime;

  for (const field of [
    "targetTop",
    "targetBottom",
    "carbs",
    "insulin",
    "percent",
    "relative",
    "notes",
    "preBolus",
  ] as const) {
    if (!normalized[field] || normalized[field] === 0) delete normalized[field];
  }
  for (const field of ["absolute", "duration"] as const) {
    if (Number.isNaN(normalized[field])) delete normalized[field];
  }
  if (normalized.glucose === 0 || Number.isNaN(normalized.glucose)) {
    delete normalized.glucose;
    delete normalized.glucoseType;
    delete normalized.units;
  }
  return { document: normalized, preBolusCarbs };
}

function durationMills(value: JsonValue | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (value.trim() !== "" && Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeTreatmentDuration(
  document: JsonDocument,
  fallbackDocument?: JsonDocument,
): void {
  const base = durationMills(document.mills)
    ?? durationMills(fallbackDocument?.mills)
    ?? durationMills(document.created_at)
    ?? durationMills(document.date)
    ?? durationMills(fallbackDocument?.created_at)
    ?? durationMills(fallbackDocument?.date);
  if (
    (document.endmills === undefined || document.endmills === null)
    && base !== null
  ) {
    if (Object.prototype.hasOwnProperty.call(document, "durationInMilliseconds")) {
      const duration = Number(document.durationInMilliseconds) || 0;
      if (duration > 0) document.endmills = base + duration;
    } else if (Object.prototype.hasOwnProperty.call(document, "duration")) {
      document.endmills = base + (Number(document.duration) || 0) * 60_000;
    } else if (
      fallbackDocument !== undefined
      && Object.prototype.hasOwnProperty.call(fallbackDocument, "durationInMilliseconds")
    ) {
      const duration = Number(fallbackDocument.durationInMilliseconds) || 0;
      if (duration > 0) document.endmills = base + duration;
    } else if (
      fallbackDocument !== undefined
      && Object.prototype.hasOwnProperty.call(fallbackDocument, "duration")
    ) {
      document.endmills = base + (Number(fallbackDocument.duration) || 0) * 60_000;
    }
  }

  const end = Number(document.endmills);
  if (base !== null && Number.isFinite(end) && end >= base) {
    document.durationInMilliseconds = end - base;
    document.duration = Math.round((end - base) / 60_000);
  }
}

function materializeApi3WithStorageProjection(
  row: Pick<DbDocumentV4, "id" | "body">,
  fields: string[] | undefined,
  collection: Api3CollectionName = TREATMENTS,
): JsonDocument {
  let document = parseBody(row.body);
  if (!document.identifier) document.identifier = row.id;
  delete document._id;

  if (fields !== undefined) {
    document = project(document, Array.from(new Set([
      ...fields,
      "identifier",
      "srvCreated",
      "created_at",
      "date",
    ])));
  }

  // Locked API3 resolves fallback dates only after the storage query. Entries
  // use date; device status, food, profile and treatments use created_at;
  // settings has no fallback date. This remains virtual for ordinary raw
  // srv* filters; lastModified and history deliberately use the same effective
  // cursor so mixed v1/v2/v3 clients can resume without a synchronization gap.
  if (!document.srvModified) {
    const fallback = collection === SETTINGS
      ? null
      : timestamp(collection === ENTRIES ? document.date : document.created_at);
    if (fallback !== null) document.srvModified = fallback;
  }
  if (document.srvModified && !document.srvCreated) {
    const modified = timestamp(document.srvModified);
    if (modified !== null) document.srvCreated = modified;
  }
  return document;
}

function materializeApi3(
  row: Pick<DbDocumentV4, "id" | "body">,
  collection: Api3CollectionName = TREATMENTS,
): JsonDocument {
  return materializeApi3WithStorageProjection(row, undefined, collection);
}

function materializeLegacy(row: Pick<DbDocumentV4, "id" | "body">): JsonDocument {
  const document = parseBody(row.body);
  document._id = row.id;
  return document;
}

function project(document: JsonDocument, fields: string[] | undefined): JsonDocument {
  if (fields === undefined || fields.includes("_all")) return document;
  const projected: JsonDocument = {};
  for (const field of fields) {
    if (!FIELD_NAME.test(field)) throw new Error(`invalid projection field ${field}`);
    const value = document[field];
    if (value !== undefined) projected[field] = value;
  }
  return projected;
}

function validateFieldName(field: string): void {
  if (
    field.length === 0
    || field.length > MAX_FIELD_NAME_LENGTH
    || !FIELD_NAME.test(field)
    || field.startsWith(".")
    || field.endsWith(".")
    || field.includes("..")
  ) {
    throw new DocumentQueryError("QUERY_FIELD_INVALID", `invalid query field ${field}`);
  }
}

function jsonPath(field: string): string {
  return `$.${field.split(".").map((segment) => `"${segment}"`).join(".")}`;
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return 1_000;
  // Locked Mongo treats cursor.limit(0) as unlimited. Keep the request bounded
  // to API3's configured maximum on the Free-plan adapter instead of 500ing.
  if (limit === 0) return 1_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  return limit;
}

function boundedSkip(skip: number | undefined): number {
  if (skip === undefined) return 0;
  if (!Number.isSafeInteger(skip) || skip < 0) {
    throw new DocumentQueryError(
      "QUERY_SKIP_INVALID",
      "document query skip must be a non-negative safe integer",
    );
  }
  return skip;
}

function sqlValue(value: JsonValue): SqlStorageValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}

interface FieldExpression {
  sql: string;
  bindings: SqlStorageValue[];
  existsSql: string;
  existsBindings: SqlStorageValue[];
  textSql: string;
  textBindings: SqlStorageValue[];
  typeSql: string;
  typeBindings: SqlStorageValue[];
  arrayEachSql?: string;
  arrayBindings?: SqlStorageValue[];
}

function fieldExpression(
  field: string,
  policy: MaterializationPolicy,
  collection?: Api3CollectionName,
): FieldExpression {
  validateFieldName(field);
  if (collection === ENTRIES && field === "date") {
    // Both API3 and legacy entry validators make canonical sort_time the
    // integer `date`. Keeping the query expression on this physical column is
    // what lets SQLite use the collection/date index rather than JSON-scan a
    // tenant's complete glucose history.
    return {
      sql: "sort_time",
      bindings: [],
      existsSql: "1",
      existsBindings: [],
      textSql: "0",
      textBindings: [],
      typeSql: "'integer'",
      typeBindings: [],
    };
  }
  if (collection === ENTRIES && field === "type") {
    // Literal JSON paths are required for SQLite to match the partial
    // documents_entries_type_sort expression index. A bound path is
    // semantically equivalent but cannot participate in that index.
    return {
      sql: "json_extract(body, '$.type')",
      bindings: [],
      existsSql: "json_type(body, '$.type') IS NOT NULL",
      existsBindings: [],
      textSql: "json_type(body, '$.type') = 'text'",
      textBindings: [],
      typeSql: "json_type(body, '$.type')",
      typeBindings: [],
      arrayEachSql: "json_each(body, '$.type')",
      arrayBindings: [],
    };
  }
  if (collection === ENTRIES && field === "dateString") {
    return {
      sql: "json_extract(body, '$.dateString')",
      bindings: [],
      existsSql: "json_type(body, '$.dateString') IS NOT NULL",
      existsBindings: [],
      textSql: "json_type(body, '$.dateString') = 'text'",
      textBindings: [],
      typeSql: "json_type(body, '$.dateString')",
      typeBindings: [],
      // V1 normalization stores dateString only as text. Keeping the generic
      // API3 array branch on this legacy path would wrap the scalar predicate
      // in an OR/json_each expression and make SQLite abandon the partial
      // documents_entries_date_string_sort index. API3 retains its wider
      // mixed-type behavior; the bounded legacy adapter stays index-safe.
      ...(policy === "api3"
        ? {
            arrayEachSql: "json_each(body, '$.dateString')",
            arrayBindings: [],
          }
        : {}),
    };
  }
  switch (field) {
    case "_id":
      return {
        sql: "id",
        bindings: [],
        existsSql: "1",
        existsBindings: [],
        // Mongo stores API3 `_id` as ObjectId, so `$regex` does not apply even
        // though the adapter's physical primary key is encoded as SQLite TEXT.
        textSql: "0",
        textBindings: [],
        typeSql: policy === "api3" ? "'objectId'" : "'text'",
        typeBindings: [],
      };
    case "identifier":
      return {
        sql: "identifier",
        bindings: [],
        existsSql: "identifier_present != 0",
        existsBindings: [],
        textSql: "typeof(identifier) = 'text'",
        textBindings: [],
        typeSql: "CASE WHEN identifier_present = 0 THEN NULL WHEN identifier IS NULL THEN 'null' ELSE 'text' END",
        typeBindings: [],
      };
    case "srvCreated":
    case "srvModified":
      // API3 filters the raw Mongo document before resolveDates() adds any
      // created_at fallback. Query the preserved body to keep that ordering.
      break;
    case "isValid":
      if (policy === "api3") {
        return {
          sql: "is_valid",
          bindings: [],
          existsSql: "1",
          existsBindings: [],
          textSql: "0",
          textBindings: [],
          typeSql: "'true'",
          typeBindings: [],
        };
      }
      break;
  }
  return {
    sql: "json_extract(body, ?)",
    bindings: [jsonPath(field)],
    existsSql: "json_type(body, ?) IS NOT NULL",
    existsBindings: [jsonPath(field)],
    textSql: "json_type(body, ?) = 'text'",
    textBindings: [jsonPath(field)],
    typeSql: "json_type(body, ?)",
    typeBindings: [jsonPath(field)],
    arrayEachSql: "json_each(body, ?)",
    arrayBindings: [jsonPath(field)],
  };
}

interface SqlPredicate {
  sql: string;
  bindings: SqlStorageValue[];
}

function mongoTypeGuard(typeSql: string, value: JsonValue): string {
  if (typeof value === "number") return `${typeSql} IN ('integer', 'real')`;
  if (typeof value === "string") return `${typeSql} = 'text'`;
  if (typeof value === "boolean") return `${typeSql} IN ('true', 'false')`;
  if (value === null) return `${typeSql} = 'null'`;
  return `${typeSql} = '${Array.isArray(value) ? "array" : "object"}'`;
}

function combinePredicates(operator: "AND" | "OR", predicates: SqlPredicate[]): SqlPredicate {
  if (predicates.length === 0) return { sql: operator === "OR" ? "0" : "1", bindings: [] };
  if (predicates.length === 1) return predicates[0]!;
  const midpoint = Math.floor(predicates.length / 2);
  const left = combinePredicates(operator, predicates.slice(0, midpoint));
  const right = combinePredicates(operator, predicates.slice(midpoint));
  return {
    sql: `(${left.sql} ${operator} ${right.sql})`,
    bindings: [...left.bindings, ...right.bindings],
  };
}

function scalarEqualityPredicate(
  expression: FieldExpression,
  value: JsonValue,
  includeMissingForNull: boolean,
): SqlPredicate {
  if (value === null) {
    return includeMissingForNull
      ? {
          sql: `(NOT (${expression.existsSql}) OR ${expression.typeSql} = 'null')`,
          bindings: [...expression.existsBindings, ...expression.typeBindings],
        }
      : {
          sql: `(${expression.existsSql} AND ${expression.typeSql} = 'null')`,
          bindings: [...expression.existsBindings, ...expression.typeBindings],
        };
  }
  return {
    sql: `(${mongoTypeGuard(expression.typeSql, value)} AND ${expression.sql} = ?)`,
    bindings: [
      ...expression.typeBindings,
      ...expression.bindings,
      sqlValue(value),
    ],
  };
}

function arrayValuePredicate(
  expression: FieldExpression,
  operator: "=" | ">" | ">=" | "<" | "<=" | "GLOB",
  value: JsonValue,
): SqlPredicate | null {
  if (expression.arrayEachSql === undefined || expression.arrayBindings === undefined) return null;
  const valueClause = value === null
    ? "item.type = 'null'"
    : `${mongoTypeGuard("item.type", value)} AND item.value ${operator} ?`;
  return {
    sql: `(${expression.typeSql} = 'array' AND EXISTS (
      SELECT 1 FROM ${expression.arrayEachSql} AS item
      WHERE ${valueClause}
    ))`,
    bindings: [
      ...expression.typeBindings,
      ...expression.arrayBindings,
      ...(value === null ? [] : [sqlValue(value)]),
    ],
  };
}

function equalityPredicate(
  expression: FieldExpression,
  value: JsonValue,
  includeMissingForNull: boolean,
): SqlPredicate {
  const predicates = [scalarEqualityPredicate(expression, value, includeMissingForNull)];
  const array = arrayValuePredicate(expression, "=", value);
  if (array !== null) predicates.push(array);
  return combinePredicates("OR", predicates);
}

function comparisonPredicate(
  expression: FieldExpression,
  operator: ">" | ">=" | "<" | "<=",
  value: JsonValue,
): SqlPredicate {
  const predicates: SqlPredicate[] = [{
    sql: `(${mongoTypeGuard(expression.typeSql, value)} AND ${expression.sql} ${operator} ?)`,
    bindings: [
      ...expression.typeBindings,
      ...expression.bindings,
      sqlValue(value),
    ],
  }];
  const array = arrayValuePredicate(expression, operator, value);
  if (array !== null) predicates.push(array);
  return combinePredicates("OR", predicates);
}

function regexPredicate(expression: FieldExpression, pattern: string): SqlPredicate {
  const predicates: SqlPredicate[] = [{
    sql: `(${expression.textSql} AND ${expression.sql} GLOB ?)`,
    bindings: [...expression.textBindings, ...expression.bindings, pattern],
  }];
  if (expression.arrayEachSql !== undefined && expression.arrayBindings !== undefined) {
    predicates.push({
      sql: `(${expression.typeSql} = 'array' AND EXISTS (
        SELECT 1 FROM ${expression.arrayEachSql} AS item
        WHERE item.type = 'text' AND item.value GLOB ?
      ))`,
      bindings: [
        ...expression.typeBindings,
        ...expression.arrayBindings,
        pattern,
      ],
    });
  }
  return combinePredicates("OR", predicates);
}

function orderedSorts(sort: DocumentQuery["sort"]): DocumentSort[] {
  if (sort === undefined) return [];
  const values: unknown[] = Array.isArray(sort) ? sort : [sort];
  if (values.length === 0) {
    throw new DocumentQueryError("QUERY_SORT_EMPTY", "document sort must contain at least one field");
  }
  return values.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new DocumentQueryError("QUERY_SORT_INVALID", "invalid document sort");
    }
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.field !== "string") {
      throw new DocumentQueryError("QUERY_SORT_INVALID", "invalid document sort field");
    }
    validateFieldName(candidate.field);
    if (candidate.direction !== "asc" && candidate.direction !== "desc") {
      throw new DocumentQueryError(
        "QUERY_SORT_DIRECTION_INVALID",
        `invalid document sort direction ${String(candidate.direction)}`,
      );
    }
    return { field: candidate.field, direction: candidate.direction };
  });
}

function entryQueryNeedsScanGuard(query: DocumentQuery): boolean {
  const indexedFields = new Set([
    "_id",
    "identifier",
    "date",
    "type",
    "isValid",
    "srvModified",
  ]);
  const indexableOperators = new Set(["eq", "gt", "gte", "lt", "lte", "in"]);
  if ((query.filters ?? []).some(
    (filter) => !indexedFields.has(filter.field) || !indexableOperators.has(filter.operator),
  )) return true;
  return orderedSorts(query.sort).some((sort) => !indexedFields.has(sort.field));
}

function entryScanProbe(query: DocumentQuery): SqlPredicate {
  const clauses = ["collection = 'entries'"];
  const bindings: SqlStorageValue[] = [];
  for (const filter of query.filters ?? []) {
    if (filter.field === "date" && typeof filter.value === "number") {
      const operators: Partial<Record<FilterOperator, string>> = {
        eq: "=",
        gt: ">",
        gte: ">=",
        lt: "<",
        lte: "<=",
      };
      const operator = operators[filter.operator];
      if (operator !== undefined) {
        clauses.push(`sort_time ${operator} ?`);
        bindings.push(filter.value);
      }
    } else if (
      (filter.field === "_id" || filter.field === "identifier")
      && filter.operator === "eq"
      && typeof filter.value === "string"
    ) {
      clauses.push(`${filter.field === "_id" ? "id" : "identifier"} = ?`);
      bindings.push(filter.value);
    } else if (filter.field === "dateString" && typeof filter.value === "string") {
      const operators: Partial<Record<FilterOperator, string>> = {
        eq: "=",
        gt: ">",
        gte: ">=",
        lt: "<",
        lte: "<=",
      };
      const operator = operators[filter.operator];
      if (operator !== undefined) {
        clauses.push("json_type(body, '$.dateString') = 'text'");
        clauses.push(`json_extract(body, '$.dateString') ${operator} ?`);
        bindings.push(filter.value);
      }
    } else if (
      filter.field === "type"
      && filter.operator === "eq"
      && typeof filter.value === "string"
    ) {
      clauses.push("json_extract(body, '$.type') = ?");
      bindings.push(filter.value);
    }
  }
  return { sql: clauses.join(" AND "), bindings };
}

function appendFilter(
  clauses: string[],
  bindings: SqlStorageValue[],
  filter: DocumentFilter,
  policy: MaterializationPolicy,
  collection: Api3CollectionName,
  legacyUuidHandling = true,
): void {
  if (
    policy === "legacy"
    && filter.field === "_id"
    && filter.operator === "eq"
    && typeof filter.value === "string"
    && UUID.test(filter.value)
    && legacyUuidHandling
  ) {
    clauses.push("(identifier = ? OR id = ?)");
    bindings.push(filter.value, filter.value);
    return;
  }
  const expression = fieldExpression(filter.field, policy, collection);
  switch (filter.operator) {
    case "eq": {
      const predicate = equalityPredicate(expression, filter.value, true);
      clauses.push(predicate.sql);
      bindings.push(...predicate.bindings);
      return;
    }
    case "ne": {
      const equal = equalityPredicate(expression, filter.value, false);
      if (filter.value === null) {
        clauses.push(`(${expression.existsSql} AND NOT (${equal.sql}))`);
        bindings.push(...expression.existsBindings, ...equal.bindings);
      } else {
        clauses.push(`NOT COALESCE((${equal.sql}), 0)`);
        bindings.push(...equal.bindings);
      }
      return;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const operators = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
      const predicate = comparisonPredicate(
        expression,
        operators[filter.operator],
        filter.value,
      );
      clauses.push(predicate.sql);
      bindings.push(...predicate.bindings);
      return;
    }
    case "in":
    case "nin": {
      const values = Array.isArray(filter.value) ? filter.value : String(filter.value).split("|");
      if (values.length === 0) {
        clauses.push(filter.operator === "in" ? "0" : "1");
        return;
      }
      if (values.length > MAX_SQL_BINDINGS) {
        throw new DocumentQueryError(
          "QUERY_BINDING_LIMIT",
          `document query exceeds SQLite's ${MAX_SQL_BINDINGS} bound-parameter limit`,
        );
      }
      const membership = combinePredicates(
        "OR",
        values.map((value) => equalityPredicate(
          expression,
          value,
          filter.operator === "in" && value === null,
        )),
      );
      clauses.push(
        filter.operator === "in"
          ? membership.sql
          : `NOT COALESCE((${membership.sql}), 0)`,
      );
      bindings.push(...membership.bindings);
      return;
    }
    case "re": {
      const pattern = compileMongoRegexToSqlGlob(String(filter.value));
      // Mongo's $regex only matches string values. GLOB is case-sensitive and
      // has no backtracking engine; the compiler accepts only a bounded linear
      // subset before this statement is built.
      const predicate = regexPredicate(expression, pattern);
      clauses.push(predicate.sql);
      bindings.push(...predicate.bindings);
      return;
    }
    case "exists": {
      const exists = filter.value !== false
        && filter.value !== 0
        && filter.value !== "false"
        && filter.value !== "0";
      clauses.push(exists ? expression.existsSql : `NOT (${expression.existsSql})`);
      bindings.push(...expression.existsBindings);
      return;
    }
    default:
      throw new DocumentQueryError(
        "QUERY_OPERATOR_UNSUPPORTED",
        `unsupported document query operator ${String(filter.operator)}`,
      );
  }
}

function assertSqlQueryWithinLimits(statement: string, bindings: SqlStorageValue[]): void {
  if (bindings.length > MAX_SQL_BINDINGS) {
    throw new DocumentQueryError(
      "QUERY_BINDING_LIMIT",
      `document query exceeds SQLite's ${MAX_SQL_BINDINGS} bound-parameter limit`,
    );
  }
  if (new TextEncoder().encode(statement).byteLength > MAX_SQL_STATEMENT_BYTES) {
    throw new DocumentQueryError(
      "QUERY_STATEMENT_LIMIT",
      `document query exceeds SQLite's ${MAX_SQL_STATEMENT_BYTES}-byte statement limit`,
    );
  }
}

function tableColumnNames(
  sql: SqlStorage,
  table: "documents" | "document_changes" | "entries",
): Set<string> {
  return new Set(
    sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((column) => column.name),
  );
}

function changeTableNeedsNullableSrvColumns(sql: SqlStorage): boolean {
  const columns = sql.exec<{ name: string; notnull: number }>(
    "PRAGMA table_info(document_changes)",
  ).toArray();
  return columns.some(
    (column) => (column.name === "srv_created" || column.name === "srv_modified")
      && column.notnull !== 0,
  );
}

function rebuildChangeTableWithNullableSrvColumns(sql: SqlStorage): void {
  if (!changeTableNeedsNullableSrvColumns(sql)) return;
  sql.exec(`
    ALTER TABLE document_changes RENAME TO document_changes_v4_not_null;
    CREATE TABLE document_changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      identifier TEXT,
      identifier_present INTEGER,
      body TEXT NOT NULL,
      srv_created INTEGER,
      srv_modified INTEGER,
      is_valid INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      operation TEXT NOT NULL,
      srv_metadata_version INTEGER
    );
    INSERT INTO document_changes
      (change_id, collection, id, identifier, identifier_present, body,
       srv_created, srv_modified, is_valid, revision, operation, srv_metadata_version)
    SELECT change_id, collection, id, identifier, identifier_present, body,
           srv_created, srv_modified, is_valid, revision, operation, srv_metadata_version
    FROM document_changes_v4_not_null;
    DROP TABLE document_changes_v4_not_null;
  `);
}

function addColumn(sql: SqlStorage, columns: Set<string>, name: string, definition: string): void {
  if (columns.has(name)) return;
  sql.exec(`ALTER TABLE documents ADD COLUMN ${name} ${definition}`);
  columns.add(name);
}

export function migrateDocumentsV4(sql: SqlStorage): void {
  const columns = tableColumnNames(sql, "documents");
  addColumn(sql, columns, "identifier", "TEXT");
  addColumn(sql, columns, "identifier_present", "INTEGER");
  addColumn(sql, columns, "srv_created", "INTEGER");
  addColumn(sql, columns, "srv_modified", "INTEGER");
  addColumn(sql, columns, "effective_modified", "INTEGER");
  addColumn(sql, columns, "is_valid", "INTEGER");
  addColumn(sql, columns, "fallback_key", "TEXT");
  addColumn(sql, columns, "revision", "INTEGER");
  addColumn(sql, columns, "srv_metadata_version", "INTEGER");

  sql.exec(`
    CREATE TABLE IF NOT EXISTS collection_clocks (
      collection TEXT PRIMARY KEY,
      last_srv_modified INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS document_changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      identifier TEXT,
      identifier_present INTEGER,
      body TEXT NOT NULL,
      srv_created INTEGER,
      srv_modified INTEGER,
      is_valid INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      operation TEXT NOT NULL,
      srv_metadata_version INTEGER
    );
  `);

  const changeColumns = tableColumnNames(sql, "document_changes");
  const changePresenceWasMissing = !changeColumns.has("identifier_present");
  if (changePresenceWasMissing) {
    sql.exec("ALTER TABLE document_changes ADD COLUMN identifier_present INTEGER");
    changeColumns.add("identifier_present");
  }
  if (!changeColumns.has("srv_metadata_version")) {
    sql.exec("ALTER TABLE document_changes ADD COLUMN srv_metadata_version INTEGER");
    changeColumns.add("srv_metadata_version");
  }
  rebuildChangeTableWithNullableSrvColumns(sql);

  sql.exec(`
    CREATE INDEX IF NOT EXISTS documents_collection_sort
      ON documents(collection, sort_time DESC);
    CREATE INDEX IF NOT EXISTS documents_collection_identifier
      ON documents(collection, identifier);
    CREATE INDEX IF NOT EXISTS documents_collection_identifier_presence
      ON documents(collection, identifier_present, identifier);
    CREATE INDEX IF NOT EXISTS documents_collection_fallback
      ON documents(collection, fallback_key);
    CREATE INDEX IF NOT EXISTS documents_collection_valid_sort
      ON documents(collection, is_valid, sort_time DESC, srv_modified DESC);
    CREATE INDEX IF NOT EXISTS documents_collection_modified
      ON documents(collection, srv_modified DESC);
    CREATE INDEX IF NOT EXISTS documents_collection_effective_modified
      ON documents(collection, effective_modified DESC, id ASC);
    CREATE INDEX IF NOT EXISTS document_changes_collection_history
      ON document_changes(collection, srv_modified ASC, change_id ASC);
    CREATE INDEX IF NOT EXISTS document_changes_document
      ON document_changes(collection, id, revision);
  `);

  const rows = sql.exec<DbDocumentV4>(`
    SELECT collection, id, body, sort_time, created_at, updated_at,
           identifier, identifier_present, srv_created, srv_modified, effective_modified,
           is_valid, fallback_key, revision, srv_metadata_version
    FROM documents
    WHERE identifier_present IS NULL OR srv_metadata_version IS NULL
       OR is_valid IS NULL OR revision IS NULL
       OR (collection = 'devicestatus' AND fallback_key IS NULL
           AND json_type(body, '$.created_at') IS NOT NULL
           AND json_type(body, '$.device') IS NOT NULL)
       OR (collection = 'entries' AND fallback_key IS NULL
           AND json_type(body, '$.date') IS NOT NULL
           AND json_type(body, '$.type') IS NOT NULL)
       OR (collection = 'profile' AND fallback_key IS NULL
           AND json_type(body, '$.created_at') IS NOT NULL)
       OR (collection = 'food' AND fallback_key IS NULL
           AND json_type(body, '$.created_at') IS NOT NULL)
       OR NOT EXISTS (
         SELECT 1 FROM document_changes
         WHERE document_changes.collection = documents.collection
           AND document_changes.id = documents.id
           AND document_changes.revision = documents.revision
       )
    ORDER BY collection ASC, updated_at ASC, id ASC
  `).toArray();

  for (const row of rows) {
    const collection = String(row.collection);
    const document = parseBody(row.body);
    // v4 rows written before this repair may contain an allocator/upload time
    // even though their preserved body never had srv*. Rebuild the nullable
    // metadata from the body, which is the locked Mongo-observable source.
    const srvModified = finiteInteger(document.srvModified);
    const srvCreated = finiteInteger(document.srvCreated);
    const isValid = row.is_valid ?? (document.isValid === false ? 0 : 1);
    const identity = identifierMetadata(document);
    const identifierPresent = identity.present;
    const identifier = identity.identifier;
    // Recompute the locked collection-specific API3 fallback key from the
    // preserved body. This also backfills devicestatus rows written before
    // that collection joined the generic SQLite API3 adapter.
    const documentFallback = collection === TREATMENTS
      || collection === DEVICESTATUS
      || collection === ENTRIES
      || collection === FOOD
      || collection === PROFILE
      ? fallbackKey(document, collection as Api3CollectionName)
      : row.fallback_key;
    const revision = row.revision ?? 1;
    const effectiveModified = effectiveApi3Modified(
      document,
      srvModified,
      collection as StoredDocumentCollectionName,
    );

    sql.exec(
      `UPDATE documents
       SET identifier = ?, srv_created = ?, srv_modified = ?, is_valid = ?,
           identifier_present = ?, fallback_key = ?, revision = ?, srv_metadata_version = 1,
           effective_modified = ?
       WHERE collection = ? AND id = ?`,
      identifier,
      srvCreated,
      srvModified,
      isValid,
      identifierPresent,
      documentFallback,
      revision,
      effectiveModified,
      collection,
      row.id,
    );

    const changeCount = sql.exec<CountRow>(
      `SELECT COUNT(*) AS count FROM document_changes
       WHERE collection = ? AND id = ? AND revision = ?`,
      collection,
      row.id,
      revision,
    ).one().count;
    if (changeCount === 0) {
      sql.exec(
        `INSERT INTO document_changes
          (collection, id, identifier, identifier_present, body, srv_created, srv_modified,
           is_valid, revision, operation, srv_metadata_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'migrate', 1)`,
        collection,
        row.id,
        identifier,
        identifierPresent,
        row.body,
        srvCreated,
        srvModified,
        isValid,
        revision,
      );
    }
  }

  const changes = sql.exec<{ change_id: number; body: string }>(
    `SELECT change_id, body FROM document_changes
     WHERE identifier_present IS NULL OR srv_metadata_version IS NULL`,
  ).toArray();
  for (const change of changes) {
    const document = parseBody(change.body);
    const identity = identifierMetadata(document);
    sql.exec(
      `UPDATE document_changes
       SET identifier_present = ?, srv_created = ?, srv_modified = ?, srv_metadata_version = 1
       WHERE change_id = ?`,
      identity.present,
      finiteInteger(document.srvCreated),
      finiteInteger(document.srvModified),
      change.change_id,
    );
  }

  sql.exec(`
    INSERT INTO collection_clocks (collection, last_srv_modified)
    SELECT collection, MAX(srv_modified)
    FROM documents
    WHERE srv_modified IS NOT NULL
    GROUP BY collection
    ON CONFLICT(collection) DO UPDATE SET
      last_srv_modified = excluded.last_srv_modified
    WHERE excluded.last_srv_modified > collection_clocks.last_srv_modified
  `);
}

/**
 * One-time bounded API3 cursor backfill. New writes always maintain the
 * indexed value. Upgrades only repair the most recent documents so an old
 * long-running instance cannot consume the entire Workers Free write budget
 * during one Durable Object activation.
 */
export function migrateEffectiveModifiedV26(sql: SqlStorage): void {
  sql.exec(`
    UPDATE documents
    SET effective_modified = CASE
      WHEN srv_modified IS NOT NULL THEN srv_modified
      WHEN collection = 'entries'
        AND json_type(body, '$.date') IN ('integer', 'real')
        THEN CAST(json_extract(body, '$.date') AS INTEGER)
      WHEN collection = 'entries'
        AND json_type(body, '$.date') = 'text'
        AND julianday(json_extract(body, '$.date')) IS NOT NULL
        THEN CAST(ROUND(
          (julianday(json_extract(body, '$.date')) - 2440587.5) * 86400000
        ) AS INTEGER)
      WHEN collection NOT IN ('settings', 'activity')
        AND json_type(body, '$.created_at') IN ('integer', 'real')
        THEN CAST(json_extract(body, '$.created_at') AS INTEGER)
      WHEN collection NOT IN ('settings', 'activity')
        AND json_type(body, '$.created_at') = 'text'
        AND julianday(json_extract(body, '$.created_at')) IS NOT NULL
        THEN CAST(ROUND(
          (julianday(json_extract(body, '$.created_at')) - 2440587.5) * 86400000
        ) AS INTEGER)
      ELSE NULL
    END
    WHERE rowid IN (
      SELECT rowid
      FROM documents
      WHERE effective_modified IS NULL
        AND (
          srv_modified IS NOT NULL
          OR collection NOT IN ('settings', 'activity')
        )
      ORDER BY sort_time DESC, id ASC
      LIMIT 10000
    )
  `);
}

function createEntriesShadowTable(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      identifier TEXT,
      dedupe_key TEXT NOT NULL UNIQUE,
      sgv INTEGER CHECK (sgv IS NULL OR (sgv >= 20 AND sgv <= 600)),
      mbg INTEGER CHECK (mbg IS NULL OR (mbg >= 20 AND mbg <= 600)),
      date INTEGER NOT NULL,
      date_string TEXT NOT NULL,
      direction TEXT NOT NULL,
      device TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}

function sqliteObjectExists(
  sql: SqlStorage,
  type: "index" | "table" | "trigger",
  name: string,
): boolean {
  return sql.exec<{ present: number }>(
    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?) AS present",
    type,
    name,
  ).one().present !== 0;
}

function entriesUniqueIndexesAreCompatible(sql: SqlStorage): boolean {
  const indexes = sql.exec<SqlIndexRow>("PRAGMA index_list(entries)").toArray();
  const allowedNames = new Set([
    "entries_date_desc",
    "sqlite_autoindex_entries_1",
    "sqlite_autoindex_entries_2",
  ]);
  if (indexes.some((index) => !allowedNames.has(index.name))) return false;
  let idIsUnique = false;
  let dedupeKeyIsUnique = false;
  for (const index of indexes) {
    if (index.unique === 0) {
      // The fresh shadow contract has exactly one caller-created non-unique
      // index. Unknown expression indexes can throw during otherwise-valid
      // writes (for example json_extract over a plain device string), so they
      // are incompatible rather than harmless schema decoration.
      if (index.name !== "entries_date_desc") return false;
      continue;
    }
    if (index.partial !== 0) return false;
    if (!/^[A-Za-z0-9_]+$/.test(index.name)) return false;
    const columns = sql.exec<{ name: string }>(
      `PRAGMA index_info("${index.name}")`,
    ).toArray().map((column) => column.name);
    if (
      index.name === "sqlite_autoindex_entries_1"
      && columns.length === 1
      && columns[0] === "id"
    ) {
      idIsUnique = true;
    } else if (
      index.name === "sqlite_autoindex_entries_2"
      && columns.length === 1
      && columns[0] === "dedupe_key"
    ) {
      dedupeKeyIsUnique = true;
    } else {
      // Any additional UNIQUE contract can reject writes Mongo would accept.
      return false;
    }
  }
  return idIsUnique && dedupeKeyIsUnique;
}

function entriesHasDateIndex(sql: SqlStorage): boolean {
  const row = sql.exec<{ sql: string | null }>(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'entries_date_desc'",
  ).toArray()[0];
  return typeof row?.sql === "string"
    && normalizeSchemaDefinition(row.sql)
      === normalizeSchemaDefinition("CREATE INDEX entries_date_desc ON entries(date DESC)");
}

function entriesHasTriggers(sql: SqlStorage): boolean {
  return sql.exec<{ present: number }>(
    `SELECT EXISTS(
       SELECT 1 FROM sqlite_master
       WHERE type = 'trigger' AND tbl_name = 'entries'
     ) AS present`,
  ).one().present !== 0;
}

function hasObsoleteEntriesArtifacts(sql: SqlStorage): boolean {
  return sql.exec<{ present: number }>(`
    SELECT EXISTS(
      SELECT 1
      FROM sqlite_master
      WHERE name IN (
        'entries_migration_capture_insert',
        'entries_migration_capture_update',
        'entries_migration_capture_delete',
        'entry_shadow_migration_queue',
        'entry_shadow_migration_state',
        'entries_v6_legacy'
      )
    ) AS present
  `).one().present !== 0;
}

function normalizeSchemaDefinition(definition: string): string {
  return definition
    .toLowerCase()
    .replace(/["`\[\]]/g, "")
    .replace(/\s+/g, "")
    .replace("createtableifnotexists", "createtable")
    .replace(/;$/, "");
}

function entriesTableDefinitionIsCompatible(sql: SqlStorage): boolean {
  const row = sql.exec<{ sql: string | null }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entries'",
  ).toArray()[0];
  if (typeof row?.sql !== "string") return false;
  const expected = `
    CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      identifier TEXT,
      dedupe_key TEXT NOT NULL UNIQUE,
      sgv INTEGER CHECK (sgv IS NULL OR (sgv >= 20 AND sgv <= 600)),
      mbg INTEGER CHECK (mbg IS NULL OR (mbg >= 20 AND mbg <= 600)),
      date INTEGER NOT NULL,
      date_string TEXT NOT NULL,
      direction TEXT NOT NULL,
      device TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;
  return normalizeSchemaDefinition(row.sql) === normalizeSchemaDefinition(expected);
}

function entriesShadowNeedsRebuild(sql: SqlStorage): boolean {
  const columns = sql.exec<SqlColumnRow>("PRAGMA table_info(entries)").toArray();
  const byName = new Map(columns.map((column) => [column.name, column]));
  const columnNames = new Set(columns.map((column) => column.name));
  const requiredColumns = [
    "id",
    "identifier",
    "dedupe_key",
    "sgv",
    "mbg",
    "date",
    "date_string",
    "direction",
    "device",
    "type",
    "created_at",
  ];
  const requiredNotNull = [
    "dedupe_key",
    "date",
    "date_string",
    "direction",
    "device",
    "type",
    "created_at",
  ];
  const requiredNullable = ["identifier", "sgv", "mbg"];
  return !entriesTableDefinitionIsCompatible(sql)
    || !entriesUniqueIndexesAreCompatible(sql)
    || entriesHasTriggers(sql)
    || columnNames.size !== requiredColumns.length
    || requiredColumns.some((column) => !columnNames.has(column))
    || byName.get("id")?.pk !== 1
    || requiredNotNull.some((column) => byName.get(column)?.notnull !== 1)
    || requiredNullable.some((column) => byName.get(column)?.notnull !== 0);
}

/**
 * Pure read-only compatibility check used when Cloudflare has temporarily
 * disabled SQLite writes after the Free-plan daily quota is exhausted.
 */
export function entriesShadowSchemaIsCurrent(sql: SqlStorage): boolean {
  try {
    return !hasObsoleteEntriesArtifacts(sql)
      && sqliteObjectExists(sql, "table", "entries")
      && !entriesShadowNeedsRebuild(sql)
      && entriesHasDateIndex(sql)
      && canonicalEntriesIndexIsCompatible(sql)
      && canonicalEntriesTypeSortIndexIsCompatible(sql)
      && canonicalEntriesDateStringIndexIsCompatible(sql);
  } catch {
    return false;
  }
}

/**
 * The columns required by every canonical document read path. This does not
 * replace migration: it only proves that an already-migrated tenant can keep
 * serving reads while writes are temporarily unavailable.
 */
export function documentReadSchemaIsCurrent(sql: SqlStorage): boolean {
  try {
    const documentColumns = tableColumnNames(sql, "documents");
    const changeColumns = tableColumnNames(sql, "document_changes");
    const clockColumns = new Set(
      sql.exec<{ name: string }>("PRAGMA table_info(collection_clocks)")
        .toArray()
        .map((column) => column.name),
    );
    return [
      "collection",
      "id",
      "body",
      "sort_time",
      "created_at",
      "updated_at",
      "identifier",
      "identifier_present",
      "srv_created",
      "srv_modified",
      "effective_modified",
      "is_valid",
      "fallback_key",
      "revision",
      "srv_metadata_version",
    ].every((column) => documentColumns.has(column))
      && [
        "change_id",
        "collection",
        "id",
        "identifier",
        "identifier_present",
        "body",
        "srv_created",
        "srv_modified",
        "is_valid",
        "revision",
        "operation",
        "srv_metadata_version",
      ].every((column) => changeColumns.has(column))
      && ["collection", "last_srv_modified"].every((column) =>
        clockColumns.has(column)
      );
  } catch {
    return false;
  }
}

function canonicalEntriesIndexIsCompatible(sql: SqlStorage): boolean {
  const row = sql.exec<{ sql: string | null }>(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'documents_entries_sys_time_type'",
  ).toArray()[0];
  if (typeof row?.sql !== "string") return false;
  const expected = `
    CREATE INDEX documents_entries_sys_time_type
      ON documents(
        json_extract(body, '$.sysTime'),
        json_extract(body, '$.type'),
        updated_at ASC,
        id ASC
      )
      WHERE collection = 'entries'
  `;
  return normalizeSchemaDefinition(row.sql) === normalizeSchemaDefinition(expected);
}

function canonicalEntriesTypeSortIndexIsCompatible(sql: SqlStorage): boolean {
  const row = sql.exec<{ sql: string | null }>(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'documents_entries_type_sort'",
  ).toArray()[0];
  if (typeof row?.sql !== "string") return false;
  const expected = `
    CREATE INDEX documents_entries_type_sort
      ON documents(
        json_extract(body, '$.type'),
        sort_time DESC,
        id ASC
      )
      WHERE collection = 'entries'
  `;
  return normalizeSchemaDefinition(row.sql) === normalizeSchemaDefinition(expected);
}

function canonicalEntriesDateStringIndexIsCompatible(sql: SqlStorage): boolean {
  const row = sql.exec<{ sql: string | null }>(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'documents_entries_date_string_sort'",
  ).toArray()[0];
  if (typeof row?.sql !== "string") return false;
  const expected = `
    CREATE INDEX documents_entries_date_string_sort
      ON documents(
        json_extract(body, '$.dateString'),
        sort_time DESC,
        id ASC
      )
      WHERE collection = 'entries'
        AND json_type(body, '$.dateString') = 'text'
  `;
  return normalizeSchemaDefinition(row.sql) === normalizeSchemaDefinition(expected);
}

/**
 * Install the fresh Entries shadow used by v1 writes and realtime reads.
 *
 * This project is still pre-1.0 and its only incompatible `entries` schemas
 * held test data. The public deployment was verified empty before this
 * contract was selected. Reset only that internal shadow when it is
 * incompatible; canonical documents and every other tenant collection stay
 * untouched. From this schema onward v1/API3 writes maintain canonical state
 * synchronously, so no source-copy queue or background alarm is required.
 */
export function migrateEntriesV6(sql: SqlStorage): void {
  const hasObsoleteArtifacts = hasObsoleteEntriesArtifacts(sql);
  const hasEntriesTable = sqliteObjectExists(sql, "table", "entries");
  const needsRebuild = hasEntriesTable && entriesShadowNeedsRebuild(sql);
  const hasDateIndex = hasEntriesTable && !needsRebuild && entriesHasDateIndex(sql);
  const hasNamedCanonicalIndex = sqliteObjectExists(
    sql,
    "index",
    "documents_entries_sys_time_type",
  );
  const hasCanonicalIndex = hasNamedCanonicalIndex && canonicalEntriesIndexIsCompatible(sql);
  const hasNamedTypeSortIndex = sqliteObjectExists(
    sql,
    "index",
    "documents_entries_type_sort",
  );
  const hasTypeSortIndex = hasNamedTypeSortIndex
    && canonicalEntriesTypeSortIndexIsCompatible(sql);
  const hasNamedDateStringIndex = sqliteObjectExists(
    sql,
    "index",
    "documents_entries_date_string_sort",
  );
  const hasDateStringIndex = hasNamedDateStringIndex
    && canonicalEntriesDateStringIndexIsCompatible(sql);
  // The common activation path is read-only. Avoid issuing even no-op DDL on
  // every Durable Object wake once the complete fresh-schema contract exists.
  if (
    !hasObsoleteArtifacts
    && hasEntriesTable
    && !needsRebuild
    && hasDateIndex
    && hasCanonicalIndex
    && hasTypeSortIndex
    && hasDateStringIndex
  ) {
    return;
  }

  if (hasObsoleteArtifacts) {
    sql.exec(`
      DROP TRIGGER IF EXISTS entries_migration_capture_insert;
      DROP TRIGGER IF EXISTS entries_migration_capture_update;
      DROP TRIGGER IF EXISTS entries_migration_capture_delete;
      DROP TABLE IF EXISTS entry_shadow_migration_queue;
      DROP TABLE IF EXISTS entry_shadow_migration_state;
      DROP TABLE IF EXISTS entries_v6_legacy;
    `);
  }
  if (!hasEntriesTable) {
    createEntriesShadowTable(sql);
  } else if (needsRebuild) {
    sql.exec("DROP TABLE entries");
    createEntriesShadowTable(sql);
  }
  if (!hasDateIndex || needsRebuild || !hasEntriesTable) {
    if (sqliteObjectExists(sql, "index", "entries_date_desc")) {
      sql.exec("DROP INDEX entries_date_desc");
    }
    sql.exec("CREATE INDEX entries_date_desc ON entries(date DESC)");
  }
  // v1's authoritative upsert selector lives inside the canonical JSON body.
  // Without this expression index, every new/replayed SGV would scan years of
  // Entries documents on the Free plan. SQLite JSON functions are
  // deterministic and therefore valid expression-index keys.
  if (hasNamedCanonicalIndex && !hasCanonicalIndex) {
    sql.exec("DROP INDEX documents_entries_sys_time_type");
  }
  if (!hasCanonicalIndex) {
    sql.exec(`
      CREATE INDEX documents_entries_sys_time_type
      ON documents(
        json_extract(body, '$.sysTime'),
        json_extract(body, '$.type'),
        updated_at ASC,
        id ASC
      )
      WHERE collection = 'entries'
    `);
  }
  if (hasNamedTypeSortIndex && !hasTypeSortIndex) {
    sql.exec("DROP INDEX documents_entries_type_sort");
  }
  if (!hasTypeSortIndex) {
    sql.exec(`
      CREATE INDEX documents_entries_type_sort
      ON documents(
        json_extract(body, '$.type'),
        sort_time DESC,
        id ASC
      )
      WHERE collection = 'entries'
    `);
  }
  if (hasNamedDateStringIndex && !hasDateStringIndex) {
    sql.exec("DROP INDEX documents_entries_date_string_sort");
  }
  if (!hasDateStringIndex) {
    sql.exec(`
      CREATE INDEX documents_entries_date_string_sort
      ON documents(
        json_extract(body, '$.dateString'),
        sort_time DESC,
        id ASC
      )
      WHERE collection = 'entries'
        AND json_type(body, '$.dateString') = 'text'
    `);
  }
}
export class SqliteDocumentRepository {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly onApi3RealtimeMutation?: (event: Api3RealtimeMutationEvent) => void,
    private readonly onDataMutation?: (
      collection: StoredDocumentCollectionName,
      document?: JsonDocument,
    ) => void,
  ) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  private emitApi3RealtimeMutation(
    collection: Api3CollectionName,
    mutation: DocumentMutationResult,
    enabled: boolean | undefined,
  ): DocumentMutationResult {
    if (enabled === true && this.onApi3RealtimeMutation !== undefined) {
      this.onApi3RealtimeMutation({
        type: mutation.created ? "create" : "update",
        collection,
        document: mutation.document,
      });
    }
    return mutation;
  }

  private findByIdRow(
    id: string,
    collection: StoredDocumentCollectionName = TREATMENTS,
  ): DbDocumentV4 | undefined {
    return this.sql.exec<DbDocumentV4>(
      `SELECT * FROM documents WHERE collection = ? AND id = ? LIMIT 1`,
      collection,
      id,
    ).toArray()[0];
  }

  private findByIdentifierRow(
    identifier: string,
    collection: Api3CollectionName = TREATMENTS,
  ): DbDocumentV4 | undefined {
    return this.sql.exec<DbDocumentV4>(
      `SELECT * FROM documents
       WHERE collection = ? AND identifier = ?
       ORDER BY srv_modified DESC, updated_at DESC, id ASC
       LIMIT 1`,
      collection,
      identifier,
    ).toArray()[0];
  }

  private findLegacyByIdRow(
    id: string,
    collection: Api3CollectionName = TREATMENTS,
  ): DbDocumentV4 | undefined {
    return this.sql.exec<DbDocumentV4>(
      `SELECT * FROM documents
       WHERE collection = ? AND id = ? AND identifier_present = 0
       LIMIT 1`,
      collection,
      id,
    ).toArray()[0];
  }

  private findByFallbackRow(
    key: string,
    legacyOnly: boolean,
    collection: Api3CollectionName = TREATMENTS,
  ): DbDocumentV4 | undefined {
    return this.sql.exec<DbDocumentV4>(
      `SELECT * FROM documents
       WHERE collection = ? AND fallback_key = ? ${legacyOnly ? "AND identifier_present = 0" : ""}
       ORDER BY srv_modified DESC, updated_at DESC, id ASC
       LIMIT 1`,
      collection,
      key,
    ).toArray()[0];
  }

  private findByIdentity(
    identity: string,
    collection: Api3CollectionName = TREATMENTS,
  ): DbDocumentV4 | undefined {
    return this.findByIdentifierRow(identity, collection)
      ?? (OBJECT_ID.test(identity)
        ? this.findByIdRow(identity.toLowerCase(), collection)
        : undefined);
  }

  private findApi3MutationCandidate(
    identity: string,
    collection: Api3CollectionName = TREATMENTS,
  ): DbDocumentV4 | undefined {
    const identified = this.findByIdentifierRow(identity, collection);
    if (identified !== undefined) return identified;
    // Locked identifyingFilter() uses an ObjectId fallback for PUT/PATCH only
    // when the stored legacy document genuinely has no identifier field. READ
    // and DELETE use the broader filterForOne() contract represented above.
    return OBJECT_ID.test(identity)
      ? this.findLegacyByIdRow(identity.toLowerCase(), collection)
      : undefined;
  }

  private findApi3CreateCandidate(
    document: JsonDocument,
    collection: Api3CollectionName = TREATMENTS,
  ): DbDocumentV4 | undefined {
    const identifier = requestedIdentifier(document);
    if (identifier !== null) {
      const identified = this.findByIdentifierRow(identifier, collection)
        ?? (OBJECT_ID.test(identifier)
          ? this.findLegacyByIdRow(identifier.toLowerCase(), collection)
          : undefined);
      if (identified !== undefined) return identified;
    }
    const key = fallbackKey(document, collection);
    return key === null ? undefined : this.findByFallbackRow(key, true, collection);
  }

  private requestedStorageIdIsOccupied(
    document: JsonDocument,
    collection: Api3CollectionName,
  ): boolean {
    const id = requestedId(document);
    if (id === null) return false;
    return this.findByIdRow(id, collection) !== undefined;
  }

  private duplicateStorageIdDecision(
    collection: Api3CollectionName,
  ): Api3MutationDecision {
    return {
      ok: false,
      reason: "operation-error",
      message: `E11000 duplicate key error collection: ${collection} index: _id_`,
    };
  }

  private findTreatmentUpsertCandidate(
    document: JsonDocument,
    uuidHandling = true,
  ): DbDocumentV4 | undefined {
    const identifier = requestedIdentifier(document);
    if (identifier !== null) {
      return this.findByIdentifierRow(identifier)
        ?? (uuidHandling ? this.findByIdRow(identifier) : undefined);
    }
    const id = requestedId(document);
    if (id !== null) return this.findByIdRow(id);
    const key = fallbackKey(document);
    return key === null ? undefined : this.findByFallbackRow(key, false);
  }

  private findLegacyEntryBySysTimeType(
    sysTime: string,
    type: string,
  ): DbDocumentV4 | undefined {
    // Locked v15.0.7 lib/server/entries.js does not use identifier for v1
    // upserts. The exact normalized sysTime + type pair is authoritative.
    return this.sql.exec<DbDocumentV4>(
      `SELECT * FROM documents
       WHERE collection = 'entries'
         AND json_extract(body, '$.sysTime') = ?
         AND json_extract(body, '$.type') = ?
       ORDER BY updated_at ASC, id ASC
       LIMIT 1`,
      sysTime,
      type,
    ).toArray()[0];
  }

  private findEntryShadowByDedupeKey(key: string): DbLegacyEntryShadow | undefined {
    return this.sql.exec<DbLegacyEntryShadow>(
      `SELECT id, identifier, dedupe_key, sgv, mbg, date, date_string,
              direction, device, type, created_at
       FROM entries WHERE dedupe_key = ? LIMIT 1`,
      key,
    ).toArray()[0];
  }

  private writeLegacyEntryShadow(
    id: string,
    dedupeKey: string,
    document: JsonDocument,
  ): void {
    const identifier = typeof document.identifier === "string" ? document.identifier : null;
    const sgv = typeof document.sgv === "number"
      && Number.isFinite(document.sgv)
      && document.sgv >= 20
      && document.sgv <= 600
      ? Math.trunc(document.sgv)
      : null;
    const mbg = typeof document.mbg === "number"
      && Number.isFinite(document.mbg)
      && document.mbg >= 20
      && document.mbg <= 600
      ? Math.trunc(document.mbg)
      : null;
    const date = timestamp(document.date);
    // The fixed shadow column is the v1 upsert time, not necessarily a public
    // dateString: locked upstream leaves dateString absent for date-only input.
    const dateString = typeof document.sysTime === "string"
      ? document.sysTime
      : date === null
        ? null
        : new Date(date).toISOString();
    if (date === null || dateString === null || typeof document.type !== "string") {
      throw new Error("legacy entry shadow requires date, dateString, and type");
    }
    const direction = typeof document.direction === "string" ? document.direction : "NONE";
    const device = typeof document.device === "string" ? document.device : "unknown";
    const existing = this.findEntryShadowByDedupeKey(dedupeKey);
    if (existing !== undefined && existing.id !== id) {
      throw new Error("legacy entry shadow identity mismatch");
    }
    this.sql.exec(
      `INSERT INTO entries
        (id, identifier, dedupe_key, sgv, mbg, date, date_string,
         direction, device, type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         identifier = excluded.identifier,
         sgv = excluded.sgv,
         mbg = excluded.mbg,
         date = excluded.date,
         date_string = excluded.date_string,
         direction = excluded.direction,
         device = excluded.device,
         type = excluded.type`,
      id,
      identifier,
      dedupeKey,
      sgv,
      mbg,
      date,
      dateString,
      direction,
      device,
      document.type,
      Date.now(),
    );
  }

  private nextSrvModified(
    now: number,
    collection: Api3CollectionName = TREATMENTS,
  ): number {
    const last = this.sql.exec<ClockRow>(
      "SELECT last_srv_modified FROM collection_clocks WHERE collection = ? LIMIT 1",
      collection,
    ).toArray()[0]?.last_srv_modified ?? 0;
    const next = Math.max(Math.trunc(now), last + 1);
    this.sql.exec(
      `INSERT INTO collection_clocks (collection, last_srv_modified)
       VALUES (?, ?)
       ON CONFLICT(collection) DO UPDATE SET last_srv_modified = excluded.last_srv_modified`,
      collection,
      next,
    );
    return next;
  }

  private preconditionFailed(
    row: DbDocumentV4,
    ifUnmodifiedSince: number | null,
    collection: Api3CollectionName = TREATMENTS,
  ): boolean {
    if (ifUnmodifiedSince === null) return false;
    const modified = timestamp(materializeApi3(row, collection).srvModified);
    return modified !== null
      && Math.floor(modified / 1_000) * 1_000 > ifUnmodifiedSince;
  }

  private assertWritable(row: DbDocumentV4): void {
    const document = materializeLegacy(row);
    if (document.isReadOnly === true || document.readOnly === true || document.readonly === true) {
      throw new Error("Trying to modify read-only document");
    }
  }

  private assertApi3ImmutableFields(
    row: DbDocumentV4,
    document: JsonDocument,
    isDeduplication = false,
    resolveStoredDates = false,
    collection: Api3CollectionName = TREATMENTS,
  ): void {
    this.assertWritable(row);
    if (row.is_valid === 0) return;
    const stored = resolveStoredDates
      ? materializeApi3(row, collection)
      : materializeLegacy(row);
    if (!resolveStoredDates) stored.identifier = row.identifier || row.id;
    for (const field of API3_IMMUTABLE_FIELDS) {
      if (field === "identifier" && isDeduplication) continue;
      if (document[field] !== undefined && document[field] !== stored[field]) {
        throw new Error(`Field ${field} cannot be modified by the client`);
      }
    }
  }

  private assertClientStorageIdCompatible(row: DbDocumentV4, document: JsonDocument): void {
    if (document._id !== undefined && document._id !== row.id) {
      throw new Error("MongoServerError: immutable field _id was altered");
    }
  }

  private writeSnapshot(
    id: string,
    document: JsonDocument,
    existing: DbDocumentV4 | undefined,
    operation: "create" | "replace" | "patch" | "delete",
    policy: MutationPolicy,
    serverSrvCreated?: number,
    collection: StoredDocumentCollectionName = TREATMENTS,
  ): DocumentMutationResult {
    if (policy === "api3" && collection === "activity") {
      throw new Error("activity is not an API3 collection");
    }
    // Final boundary also protects internal/importer writes and old values
    // retained by PATCH before publishing the canonical snapshot.
    document = sanitizeStoredDocument(document);
    const api3Collection = collection as Api3CollectionName;
    const revision = (existing?.revision ?? 0) + 1;
    const identity = identifierMetadata(document);
    const identifier = identity.identifier;
    const isValid = document.isValid === false ? 0 : 1;
    const stored = { ...document };
    stored._id = id;
    const generatedSrvModified = policy === "api3"
      ? this.nextSrvModified(Date.now(), api3Collection)
      : null;
    if (policy === "api3") {
      if (generatedSrvModified === null) throw new Error("API3 srvModified allocation failed");
      if (operation === "patch" || operation === "delete") {
        // Locked PATCH and soft DELETE only persist srvModified. If a legacy
        // document has no srvCreated, READ will resolve it virtually later.
        stored.srvModified = generatedSrvModified;
      } else {
        const rawExisting = existing === undefined ? undefined : parseBody(existing.body);
        stored.srvCreated = existing === undefined
          ? generatedSrvModified
          : serverSrvCreated
            ?? finiteInteger(rawExisting?.srvCreated)
            ?? generatedSrvModified;
        stored.srvModified = generatedSrvModified;
      }
    }
    if (isValid === 0) stored.isValid = false;
    const srvCreated = finiteInteger(stored.srvCreated);
    const srvModified = finiteInteger(stored.srvModified);
    const effectiveModified = effectiveApi3Modified(stored, srvModified, collection);
    const body = JSON.stringify(stored);
    const now = Date.now();

    this.sql.exec(
      `INSERT INTO documents
        (collection, id, body, sort_time, created_at, updated_at, identifier,
         identifier_present, srv_created, srv_modified, is_valid, fallback_key, revision,
         srv_metadata_version, effective_modified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ${existing === undefined
    ? ""
    : `ON CONFLICT(collection, id) DO UPDATE SET
         body = excluded.body,
         sort_time = excluded.sort_time,
         updated_at = excluded.updated_at,
         identifier = excluded.identifier,
         identifier_present = excluded.identifier_present,
         srv_created = excluded.srv_created,
         srv_modified = excluded.srv_modified,
         effective_modified = excluded.effective_modified,
         is_valid = excluded.is_valid,
         fallback_key = excluded.fallback_key,
         revision = excluded.revision,
         srv_metadata_version = excluded.srv_metadata_version`}`,
      collection,
      id,
      body,
      sortTime(stored, existing?.sort_time ?? now),
      existing?.created_at ?? now,
      now,
      identifier,
      identity.present,
      srvCreated,
      srvModified,
      isValid,
      fallbackKey(stored, collection),
      revision,
      effectiveModified,
    );
    this.sql.exec(
      `INSERT INTO document_changes
        (collection, id, identifier, identifier_present, body, srv_created, srv_modified,
         is_valid, revision, operation, srv_metadata_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      collection,
      id,
      identifier,
      identity.present,
      body,
      srvCreated,
      srvModified,
      isValid,
      revision,
      operation,
    );

    if (policy === "api3" && collection === ENTRIES) {
      // API3 can change fields the narrow v1/realtime shadow cannot represent
      // (including type and soft-delete metadata). Canonical JSON is always
      // written first in this transaction; invalidating the shadow keeps v1
      // reads exact until a later v1 write recreates it synchronously.
      this.sql.exec("DELETE FROM entries WHERE id = ?", id);
    }

    const result: DocumentMutationResult = {
      document: policy === "api3"
        ? materializeApi3({
          id,
          body,
        }, api3Collection)
        : stored,
      created: existing === undefined,
      deduplicated: existing !== undefined,
      revision,
      srvModified,
    };
    const oldIdentifier = existing === undefined ? null : existing.identifier || existing.id;
    if (existing !== undefined && oldIdentifier !== identifier && oldIdentifier !== null) {
      result.deduplicatedIdentifier = oldIdentifier;
    }
    if (
      policy === "legacy"
      && collection !== "activity"
      && this.onApi3RealtimeMutation !== undefined
    ) {
      this.onApi3RealtimeMutation({
        type: result.created ? "create" : "update",
        collection: api3Collection,
        document: materializeApi3({ id, body }, api3Collection),
        recordRootUpdate: false,
      });
    }
    this.onDataMutation?.(collection, result.document);
    return result;
  }

  findTreatmentById(id: string, includeDeleted = false): JsonDocument | null {
    const row = this.findByIdRow(id);
    if (row === undefined || (!includeDeleted && row.is_valid === 0)) return null;
    return materializeApi3(row, TREATMENTS);
  }

  findTreatmentByIdentifier(identifier: string, includeDeleted = false): JsonDocument | null {
    const row = this.findByIdentity(identifier);
    if (row === undefined || (!includeDeleted && row.is_valid === 0)) return null;
    return materializeApi3(row, TREATMENTS);
  }

  findTreatmentForApi3Read(
    identifier: string,
    fields: string[] | undefined,
    collection: Api3CollectionName = TREATMENTS,
  ): JsonDocument | null {
    const row = this.findByIdentity(identifier, collection);
    return row === undefined
      ? null
      : materializeApi3WithStorageProjection(row, fields, collection);
  }

  findDocumentForApi3Read(
    collection: Api3CollectionName,
    identifier: string,
    fields: string[] | undefined,
  ): JsonDocument | null {
    return this.findTreatmentForApi3Read(identifier, fields, collection);
  }

  findTreatmentByFallback(createdAt: JsonValue, eventType: JsonValue, includeDeleted = false): JsonDocument | null {
    const key = fallbackKey({ created_at: createdAt, eventType });
    const row = key === null ? undefined : this.findByFallbackRow(key, true);
    if (row === undefined || (!includeDeleted && row.is_valid === 0)) return null;
    return materializeApi3(row, TREATMENTS);
  }

  private assertEntryQueryWithinScanBudget(query: DocumentQuery): void {
    if (!entryQueryNeedsScanGuard(query)) return;
    const probe = entryScanProbe(query);
    const beyondBudget = this.sql.exec<{ present: number }>(
      `SELECT EXISTS(
         SELECT 1 FROM documents
         WHERE ${probe.sql}
         ORDER BY sort_time DESC, id ASC
         LIMIT 1 OFFSET ${MAX_UNINDEXED_ENTRY_CANDIDATES}
       ) AS present`,
      ...probe.bindings,
    ).one().present !== 0;
    if (beyondBudget) {
      throw new DocumentQueryError(
        "QUERY_SCAN_LIMIT",
        `Entries query exceeds the ${MAX_UNINDEXED_ENTRY_CANDIDATES}-row scan budget; add a narrower date filter`,
      );
    }
  }

  private queryTreatmentRows(
    query: DocumentQuery,
    policy: MaterializationPolicy,
    collection: Api3CollectionName = TREATMENTS,
  ): DbDocumentV4[] {
    const useLegacyDateStringIndex = collection === ENTRIES
      && policy === "legacy"
      && (query.filters ?? []).some((filter) =>
        filter.field === "dateString"
        && typeof filter.value === "string"
        && (filter.operator === "eq"
          || filter.operator === "gt"
          || filter.operator === "gte"
          || filter.operator === "lt"
          || filter.operator === "lte")
      );
    const source = useLegacyDateStringIndex
      ? "documents INDEXED BY documents_entries_date_string_sort"
      : "documents";
    // A literal Entries collection predicate lets SQLite prove partial-index
    // eligibility. Other collections retain the shared bound predicate.
    const clauses = collection === ENTRIES ? ["collection = 'entries'"] : ["collection = ?"];
    const bindings: SqlStorageValue[] = collection === ENTRIES ? [] : [collection];
    if (policy === "api3" && query.includeDeleted !== true) clauses.push("is_valid != 0");
    for (const filter of query.filters ?? []) {
      appendFilter(
        clauses,
        bindings,
        filter,
        policy,
        collection,
        query.legacyUuidHandling !== false,
      );
    }

    let order = policy === "legacy"
      ? collection === ENTRIES
        ? "sort_time DESC, id ASC"
        : "json_extract(body, '$.created_at') DESC, id ASC"
      : "sort_time DESC, srv_modified DESC, id ASC";
    if (query.sort !== undefined) {
      const sorts = orderedSorts(query.sort);
      const orderParts: string[] = [];
      for (const sort of sorts) {
        const expression = fieldExpression(sort.field, policy, collection);
        orderParts.push(`${expression.sql} ${sort.direction === "asc" ? "ASC" : "DESC"}`);
        bindings.push(...expression.bindings);
      }
      if (!sorts.some((sort) => sort.field === "_id")) {
        const tieDirection = sorts[sorts.length - 1]?.direction === "desc" ? "DESC" : "ASC";
        orderParts.push(`id ${tieDirection}`);
      }
      order = orderParts.join(", ");
    }
    bindings.push(boundedLimit(query.limit), boundedSkip(query.skip));
    // Arbitrary JSON fields, compound fallback sorts, and regex/negative
    // predicates have no general SQLite index. Probe the indexed date/id
    // candidate set and fail closed before executing when it exceeds the
    // explicit Free-plan budget. Never truncate then filter: that would return
    // a plausible but incorrect empty/page result.
    if (collection === ENTRIES) this.assertEntryQueryWithinScanBudget(query);
    const statement = `SELECT * FROM ${source}
       WHERE ${clauses.join(" AND ")}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`;
    assertSqlQueryWithinLimits(statement, bindings);
    return this.sql.exec<DbDocumentV4>(statement, ...bindings).toArray();
  }

  queryTreatments(query: DocumentQuery = {}): JsonDocument[] {
    return this.queryTreatmentRows(query, "api3")
      .map((row) => materializeApi3(row, TREATMENTS))
      .map((document) => project(document, query.fields));
  }

  queryDocumentsForApi3(
    collection: Api3CollectionName,
    query: DocumentQuery = {},
  ): JsonDocument[] {
    return this.queryTreatmentRows(query, "api3", collection)
      .map((row) => materializeApi3(row, collection))
      .map((document) => project(document, query.fields));
  }

  queryLegacyDocuments(
    collection: Api3CollectionName,
    query: DocumentQuery = {},
  ): JsonDocument[] {
    return this.queryTreatmentRows(query, "legacy", collection)
      .map(materializeLegacy)
      .map((document) => project(document, query.fields));
  }

  queryLegacyTreatments(query: DocumentQuery = {}): JsonDocument[] {
    return this.queryLegacyDocuments(TREATMENTS, query);
  }

  private upsertLegacyEntry(entry: ValidatedEntry): DocumentMutationResult {
    const incoming = parseBody(entry.documentJson);
    let shadow = this.findEntryShadowByDedupeKey(entry.dedupeKey);
    let existing: DbDocumentV4 | undefined;
    if (shadow !== undefined) {
      const candidate = this.findByIdRow(shadow.id, ENTRIES);
      if (candidate !== undefined) {
        const candidateDocument = parseBody(candidate.body);
        if (
          candidateDocument.sysTime === entry.sysTime
          && candidateDocument.type === entry.type
        ) {
          // The ordinary replay path is two indexed lookups: shadow's UNIQUE
          // dedupe key followed by documents' (collection,id) primary key.
          existing = candidate;
        } else {
          this.sql.exec("DELETE FROM entries WHERE id = ?", shadow.id);
          shadow = undefined;
        }
      }
    }
    existing ??= this.findLegacyEntryBySysTimeType(entry.sysTime, entry.type);
    if (shadow !== undefined && existing?.id !== shadow.id) {
      const shadowCanonical = this.findByIdRow(shadow.id, ENTRIES);
      if (existing !== undefined || shadowCanonical !== undefined) {
        // The canonical Mongo-equivalent sysTime+type lookup wins. This can
        // repair a shadow left stale by an older deployment after API3
        // changed type, without forcing a duplicate primary-key insert.
        this.sql.exec("DELETE FROM entries WHERE id = ?", shadow.id);
        shadow = undefined;
      }
    }
    if (
      existing !== undefined
      && entry.requestedId !== null
      && entry.requestedId !== existing.id
    ) {
      // Mongo rejects changing _id in the $set portion of an upsert. The
      // current item rolls back atomically; earlier ordered-batch items have
      // already committed and the remaining suffix is never attempted.
      throw new Error("MongoServerError: immutable field _id was altered");
    }
    if (
      existing === undefined
      && entry.requestedId !== null
      && this.findByIdRow(entry.requestedId, ENTRIES) !== undefined
    ) {
      throw new Error("E11000 duplicate key error collection: entries index: _id_");
    }
    delete incoming._id;
    const original = existing === undefined ? {} : parseBody(existing.body);
    delete original._id;
    const document = { ...original, ...incoming };
    const id = existing?.id ?? shadow?.id ?? entry.requestedId ?? randomObjectId();
    const mutation = this.writeSnapshot(
      id,
      document,
      existing,
      existing === undefined ? "create" : "replace",
      "legacy",
      undefined,
      ENTRIES,
    );
    this.writeLegacyEntryShadow(id, entry.dedupeKey, mutation.document);
    return mutation;
  }

  upsertLegacyEntries(entries: ValidatedEntry[]): DocumentMutationResult[] {
    const mutations: DocumentMutationResult[] = [];
    for (const entry of entries) {
      // Mongo bulkWrite({ ordered: true }) commits every successful operation
      // before the first failure and never executes the remaining suffix. A
      // transaction per item is the matching SQLite DO boundary; wrapping the
      // whole array in one transaction would incorrectly erase that prefix.
      mutations.push(this.storage.transactionSync(() => this.upsertLegacyEntry(entry)));
    }
    return mutations;
  }

  queryLegacyEntries(query: HistoryQuery): JsonDocument[] {
    const filters: DocumentFilter[] = query.filters.map((filter) => ({ ...filter }));
    if (query.type !== null && query.type !== undefined) {
      filters.push({ field: "type", operator: "eq", value: query.type });
    }
    return this.queryTreatmentRows({
      filters,
      sort: query.sort.map((sort) => ({ ...sort })),
      limit: query.count,
    }, "legacy", ENTRIES).map(materializeLegacy);
  }

  countLegacyDocuments(
    query: HistoryQuery,
    collection: Api3CollectionName = ENTRIES,
  ): number {
    const filters: DocumentFilter[] = query.filters.map((filter) => ({ ...filter }));
    if (query.type !== null && query.type !== undefined) {
      filters.push({ field: "type", operator: "eq", value: query.type });
    }
    const countQuery: DocumentQuery = { filters };
    if (collection === ENTRIES) this.assertEntryQueryWithinScanBudget(countQuery);

    const useLegacyDateStringIndex = collection === ENTRIES
      && filters.some((filter) =>
        filter.field === "dateString"
        && typeof filter.value === "string"
        && (filter.operator === "eq"
          || filter.operator === "gt"
          || filter.operator === "gte"
          || filter.operator === "lt"
          || filter.operator === "lte")
      );
    const source = useLegacyDateStringIndex
      ? "documents INDEXED BY documents_entries_date_string_sort"
      : "documents";
    const clauses = collection === ENTRIES ? ["collection = 'entries'"] : ["collection = ?"];
    const bindings: SqlStorageValue[] = collection === ENTRIES ? [] : [collection];
    for (const filter of filters) {
      appendFilter(clauses, bindings, filter, "legacy", collection);
    }
    const statement = `SELECT COUNT(*) AS count FROM ${source}
       WHERE ${clauses.join(" AND ")}`;
    assertSqlQueryWithinLimits(statement, bindings);
    return this.sql.exec<CountRow>(statement, ...bindings).one().count;
  }

  queryLegacySgvBucket(count: number): JsonDocument[] {
    const documents: JsonDocument[] = [];
    for (const row of this.sql.exec<DbDocumentV4>(
      `SELECT * FROM documents
       WHERE collection = 'entries'
         AND sort_time >= ?
         AND ${realtimeNumericMeasurementSql("$.sgv")}
         AND NOT ${realtimeJsonTruthySql("$.mbg")}
       ORDER BY sort_time DESC, id ASC
       LIMIT 1000`,
      Date.now() - 2 * 24 * 60 * 60 * 1_000,
    )) {
      const document = materializeLegacy(row);
      // Locked dataloader classifies mbg first, then applies Number() to a
      // truthy sgv. Keep the properties/clock bucket aligned with realtime.
      if (document.mbg || !document.sgv) continue;
      const sgv = Number(document.sgv);
      if (!Number.isFinite(sgv)) continue;
      documents.push({ ...document, sgv, type: "sgv" });
      if (documents.length >= count) break;
    }
    return documents;
  }

  findLegacyEntryById(id: string): JsonDocument | null {
    const canonical = this.findByIdRow(id, ENTRIES);
    return canonical === undefined ? null : materializeLegacy(canonical);
  }

  currentLegacyEntries(): JsonDocument[] {
    return this.queryLegacyEntries({
      count: 1,
      filters: [{
        field: "date",
        operator: "gte",
        value: Date.now() - LEGACY_ENTRY_DEFAULT_WINDOW_MS,
      }],
      sort: [{ field: "date", direction: "desc" }],
      type: null,
    });
  }

  deleteLegacyEntries(
    ids: string[],
    lte: number | null,
    gte: number | null,
    type: string | null = null,
    dateString: string | null = null,
    date: number | null = null,
    dateStringLte: string | null = null,
    dateStringGte: string | null = null,
  ): number {
    return this.storage.transactionSync(() => {
      if (
        ids.length === 0
        && lte === null
        && gte === null
        && dateString === null
        && date === null
        && dateStringLte === null
        && dateStringGte === null
      ) return 0;
      const clauses = ["collection = 'entries'"];
      const bindings: SqlStorageValue[] = [];
      if (ids.length > 0) {
        clauses.push(`id IN (${ids.map(() => "?").join(", ")})`);
        bindings.push(...ids);
      } else {
        if (lte !== null) {
          clauses.push("sort_time <= ?");
          bindings.push(lte);
        }
        if (gte !== null) {
          clauses.push("sort_time >= ?");
          bindings.push(gte);
        }
        if (dateString !== null) {
          clauses.push("json_extract(body, '$.dateString') = ?");
          bindings.push(dateString);
        }
        if (date !== null) {
          clauses.push("sort_time = ?");
          bindings.push(date);
        }
        if (dateStringLte !== null) {
          clauses.push("json_extract(body, '$.dateString') <= ?");
          bindings.push(dateStringLte);
        }
        if (dateStringGte !== null) {
          clauses.push("json_extract(body, '$.dateString') >= ?");
          bindings.push(dateStringGte);
        }
      }
      if (type !== null) {
        clauses.push("json_extract(body, '$.type') = ?");
        bindings.push(type);
      }
      const rows = this.sql.exec<{ id: string; identifier: string | null }>(
        `SELECT id, identifier FROM documents WHERE ${clauses.join(" AND ")} LIMIT ?`,
        ...bindings,
        MAX_SYNCHRONOUS_ENTRY_DELETES + 1,
      ).toArray();
      if (rows.length > MAX_SYNCHRONOUS_ENTRY_DELETES) return -1;
      let changeRows = 0;
      for (const row of rows) {
        const remaining = MAX_SYNCHRONOUS_ENTRY_DELETES - changeRows + 1;
        changeRows += this.sql.exec<{ change_id: number }>(
          `SELECT change_id FROM document_changes
           WHERE collection = 'entries' AND id = ? LIMIT ?`,
          row.id,
          remaining,
        ).toArray().length;
        if (changeRows > MAX_SYNCHRONOUS_ENTRY_DELETES) return -1;
      }
      for (const row of rows) {
        this.sql.exec(
          "DELETE FROM document_changes WHERE collection = 'entries' AND id = ?",
          row.id,
        );
        this.sql.exec(
          "DELETE FROM documents WHERE collection = 'entries' AND id = ?",
          row.id,
        );
        this.sql.exec("DELETE FROM entries WHERE id = ?", row.id);
        this.onApi3RealtimeMutation?.({
          type: "delete",
          collection: ENTRIES,
          identifier: row.identifier || row.id,
          recordRootUpdate: false,
        });
      }
      if (rows.length > 0) this.onDataMutation?.(ENTRIES);
      return rows.length;
    });
  }

  private websocketFirstByFields(
    collection: WebsocketRootCollectionName,
    fields: Array<[
      "NSCLIENT_ID" | "created_at" | "eventType" | "startDate",
      JsonValue | undefined,
    ]>,
  ): DbDocumentV4 | undefined {
    const bindings: SqlStorageValue[] = [collection];
    const clauses: string[] = [];
    for (const [field, value] of fields) {
      const scalar = websocketSqlScalar(value);
      if (scalar === undefined) return undefined;
      clauses.push(`json_extract(body, '$.${field}') IS ?`);
      bindings.push(scalar);
    }
    return this.sql.exec<DbDocumentV4>(
      `SELECT * FROM documents
       WHERE collection = ? AND ${clauses.join(" AND ")}
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
      ...bindings,
    ).toArray()[0];
  }

  private websocketSimilarTreatment(document: JsonDocument): DbDocumentV4 | undefined {
    const createdAt = new Date(document.created_at as string | number).getTime();
    if (!Number.isFinite(createdAt)) return undefined;
    const lower = new Date(createdAt - 2_000).toISOString();
    const upper = new Date(createdAt + 2_000).toISOString();
    const selected: Array<[
      | "insulin"
      | "carbs"
      | "percent"
      | "absolute"
      | "duration"
      | "NSCLIENT_ID"
      | "eventType",
      JsonValue | undefined,
    ]> = [];
    for (const field of ["insulin", "carbs", "percent", "absolute", "duration"] as const) {
      if (document[field]) selected.push([field, document[field]]);
    }
    if (document.NSCLIENT_ID) selected.push(["NSCLIENT_ID", document.NSCLIENT_ID]);
    if (selected.length === 0) selected.push(["eventType", document.eventType]);

    const bindings: SqlStorageValue[] = [TREATMENTS, lower, upper];
    const clauses = [
      "json_type(body, '$.created_at') = 'text'",
      "json_extract(body, '$.created_at') >= ?",
      "json_extract(body, '$.created_at') <= ?",
    ];
    for (const [field, value] of selected) {
      const scalar = websocketSqlScalar(value);
      if (scalar === undefined) return undefined;
      clauses.push(`json_extract(body, '$.${field}') IS ?`);
      bindings.push(scalar);
    }
    return this.sql.exec<DbDocumentV4>(
      `SELECT * FROM documents
       WHERE collection = ? AND ${clauses.join(" AND ")}
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
      ...bindings,
    ).toArray()[0];
  }

  /** Raw main-namespace dbAdd semantics from locked websocket.js. */
  addWebsocketRootDocument(
    collection: WebsocketRootCollectionName,
    input: JsonDocument,
    receivedAt: number,
  ): WebsocketRootAddResult {
    return this.storage.transactionSync(() => {
      const document = sanitizeStoredDocument(input);
      if (!hasOwn(document, "created_at")) {
        document.created_at = new Date(receivedAt).toISOString();
      }
      if (collection === TREATMENTS && !hasOwn(document, "eventType")) {
        document.eventType = "<none>";
      }

      if (collection === TREATMENTS) {
        const exact = document.NSCLIENT_ID
          ? this.websocketFirstByFields(TREATMENTS, [["NSCLIENT_ID", document.NSCLIENT_ID]])
          : this.websocketFirstByFields(TREATMENTS, [
            ["created_at", document.created_at],
            ["eventType", document.eventType],
          ]);
        if (exact !== undefined) {
          return { documents: [materializeLegacy(exact)], changed: false };
        }
        const similar = this.websocketSimilarTreatment(document);
        if (similar !== undefined) {
          const updated = materializeLegacy(similar);
          updated.created_at = document.created_at!;
          const mutation = this.writeSnapshot(
            similar.id,
            updated,
            similar,
            "patch",
            "legacy",
            undefined,
            TREATMENTS,
          );
          return { documents: [mutation.document], changed: true };
        }
      } else if (collection === DEVICESTATUS) {
        const exact = document.NSCLIENT_ID
          ? this.websocketFirstByFields(DEVICESTATUS, [["NSCLIENT_ID", document.NSCLIENT_ID]])
          : this.websocketFirstByFields(DEVICESTATUS, [["created_at", document.created_at]]);
        if (exact !== undefined) {
          return { documents: [materializeLegacy(exact)], changed: false };
        }
      } else if (collection === PROFILE) {
        const existing = document.NSCLIENT_ID
          ? this.websocketFirstByFields(PROFILE, [["NSCLIENT_ID", document.NSCLIENT_ID]])
          : document.startDate
            ? this.websocketFirstByFields(PROFILE, [["startDate", document.startDate]])
            : undefined;
        if (existing !== undefined) {
          document._id = existing.id;
          const mutation = this.writeSnapshot(
            existing.id,
            document,
            existing,
            "replace",
            "legacy",
            undefined,
            PROFILE,
          );
          return { documents: [mutation.document], changed: true };
        }
      }

      const id = websocketStorageId(document._id) ?? randomObjectId();
      document._id = id;
      const mutation = this.writeSnapshot(
        id,
        document,
        undefined,
        "create",
        "legacy",
        undefined,
        collection,
      );
      return { documents: [mutation.document], changed: true };
    });
  }

  updateWebsocketRootDocument(
    collection: WebsocketRootCollectionName,
    id: string,
    fields: JsonDocument,
  ): boolean {
    return this.storage.transactionSync(() => {
      const storageId = websocketStorageId(id);
      if (storageId === null) return false;
      const existing = this.findByIdRow(storageId, collection);
      if (existing === undefined) return false;
      const updated = websocketSetFields(materializeLegacy(existing), sanitizeStoredDocument(fields));
      this.writeSnapshot(
        existing.id,
        updated,
        existing,
        "patch",
        "legacy",
        undefined,
        collection,
      );
      if (collection === ENTRIES) this.sql.exec("DELETE FROM entries WHERE id = ?", existing.id);
      return true;
    });
  }

  unsetWebsocketRootDocument(
    collection: WebsocketRootCollectionName,
    id: string,
    fields: JsonDocument,
  ): boolean {
    return this.storage.transactionSync(() => {
      const storageId = websocketStorageId(id);
      if (storageId === null) return false;
      const existing = this.findByIdRow(storageId, collection);
      if (existing === undefined) return false;
      const updated = websocketUnsetFields(materializeLegacy(existing), fields);
      this.writeSnapshot(
        existing.id,
        updated,
        existing,
        "patch",
        "legacy",
        undefined,
        collection,
      );
      if (collection === ENTRIES) this.sql.exec("DELETE FROM entries WHERE id = ?", existing.id);
      return true;
    });
  }

  deleteWebsocketRootDocument(collection: WebsocketRootCollectionName, id: string): boolean {
    const storageId = websocketStorageId(id);
    return storageId === null ? false : this.deleteDocumentById(collection, storageId);
  }

  private upsertPreparedLegacyTreatment(
    document: JsonDocument,
    uuidHandling = true,
  ): DocumentMutationResult {
    const existing = this.findTreatmentUpsertCandidate(document, uuidHandling);
    if (requestedIdentifier(document) !== null) delete document._id;
    const id = existing?.id ?? requestedId(document) ?? randomObjectId();
    return this.writeSnapshot(
      id,
      document,
      existing,
      existing === undefined ? "create" : "replace",
      "legacy",
    );
  }

  /** Locked treatments.save(): normalize and upsert one document, without POST fan-out. */
  upsertTreatment(input: JsonDocument, uuidHandling = true): DocumentMutationResult {
    return this.storage.transactionSync(() => {
      const prepared = prepareLegacyTreatment(normalizeTreatmentIdentity(input, uuidHandling));
      return this.upsertPreparedLegacyTreatment(prepared.document, uuidHandling);
    });
  }

  /**
   * Locked treatments.create()/upsert() including the preBolus carb record.
   * Cloudflare tightens the two writes into one synchronous SQLite transaction
   * so a failed shifted timestamp cannot leave a half-created meal treatment.
   */
  createLegacyTreatmentBundle(
    input: JsonDocument,
    uuidHandling = true,
  ): DocumentMutationResult[] {
    return this.storage.transactionSync(() => {
      const prepared = prepareLegacyTreatment(normalizeTreatmentIdentity(input, uuidHandling));
      const primary = this.upsertPreparedLegacyTreatment(prepared.document, uuidHandling);
      if (prepared.preBolusCarbs === null) return [primary];

      const preBolus = Number(prepared.document.preBolus);
      const primaryCreatedAt = Date.parse(String(prepared.document.created_at));
      const shiftedCreatedAt = new Date(primaryCreatedAt + preBolus * 60_000).toISOString();
      const shifted: JsonDocument = {
        created_at: shiftedCreatedAt,
        carbs: prepared.preBolusCarbs,
      };
      if (prepared.document.eventType !== undefined) {
        shifted.eventType = prepared.document.eventType;
      }
      if (prepared.document.notes) shifted.notes = prepared.document.notes;
      const carbRecord = this.upsertPreparedLegacyTreatment(shifted, uuidHandling);
      return [primary, carbRecord];
    });
  }

  createLegacyDocument(
    collection: Api3CollectionName,
    input: JsonDocument,
  ): DocumentMutationResult {
    return this.storage.transactionSync(() => {
      const document = normalizeTreatmentIdentity(input);
      const id = requestedId(document) ?? randomObjectId();
      return this.writeSnapshot(
        id,
        document,
        undefined,
        "create",
        "legacy",
        undefined,
        collection,
      );
    });
  }

  saveLegacyDocument(
    collection: Api3CollectionName,
    input: JsonDocument,
  ): DocumentMutationResult {
    return this.storage.transactionSync(() => {
      // Locked Profile/Food storage constructs a fresh ObjectId when save() is
      // called without an _id or with a value the MongoDB ObjectId constructor
      // rejects. Keep that internal storage contract here. Public v1/v2 routes
      // still perform their locked ObjectId validation before reaching this
      // adapter, so accepting the direct-storage shape does not weaken HTTP
      // mutation validation.
      const document = { ...input };
      const id = requestedId(document) ?? randomObjectId();
      const existing = this.findByIdRow(id, collection);
      return this.writeSnapshot(
        id,
        document,
        existing,
        existing === undefined ? "create" : "replace",
        "legacy",
        undefined,
        collection,
      );
    });
  }

  createTreatmentForApi3(
    input: JsonDocument,
    options: Api3MutationOptions,
    collection: Api3CollectionName = TREATMENTS,
  ): Api3MutationDecision {
    return this.storage.transactionSync(() => {
      const document = normalizeTreatmentIdentity(input);
      const existing = this.findApi3CreateCandidate(document, collection);
      if (existing !== undefined) {
        if (!options.canUpdate) return { ok: false, reason: "missing-update-permission" };
        this.assertClientStorageIdCompatible(existing, document);
        this.assertApi3ImmutableFields(existing, document, true, false, collection);
        if (options.validate !== false) assertApi3Common(document);
        normalizeTreatmentDuration(document);
      } else {
        if (!options.canCreate) return { ok: false, reason: "missing-create-permission" };
        // Mongo insertOne cannot overwrite an existing `_id`; the canonical
        // collection therefore rejects an occupied storage key with E11000.
        if (this.requestedStorageIdIsOccupied(document, collection)) {
          return this.duplicateStorageIdDecision(collection);
        }
        if (options.validate !== false) {
          assertApi3Identifier(document);
          assertApi3Common(document);
        }
      }
      if (options.actor !== null) document.subject = options.actor;
      const id = existing?.id ?? requestedId(document) ?? randomObjectId();
      const mutation = this.writeSnapshot(
        id,
        document,
        existing,
        existing === undefined ? "create" : "replace",
        "api3",
        undefined,
        collection,
      );
      return {
        ok: true,
        mutation: this.emitApi3RealtimeMutation(
          collection,
          mutation,
          options.emitRealtime,
        ),
      };
    });
  }

  createDocumentForApi3(
    collection: Api3CollectionName,
    input: JsonDocument,
    options: Api3MutationOptions,
  ): Api3MutationDecision {
    return this.createTreatmentForApi3(input, options, collection);
  }

  createTreatment(input: JsonDocument): DocumentMutationResult {
    const decision = this.createTreatmentForApi3(input, {
      canCreate: true,
      canUpdate: true,
      actor: null,
      ifUnmodifiedSince: null,
      validate: false,
    });
    if (!decision.ok) throw new Error(decision.reason);
    return decision.mutation;
  }

  replaceTreatmentForApi3(
    identity: string,
    input: JsonDocument,
    options: Api3MutationOptions,
    collection: Api3CollectionName = TREATMENTS,
  ): Api3MutationDecision {
    return this.storage.transactionSync(() => {
      const existing = this.findApi3MutationCandidate(identity, collection);
      if (existing === undefined) {
        if (!options.canCreate) return { ok: false, reason: "missing-create-permission" };
        const document = normalizeTreatmentIdentity({ ...input, identifier: identity });
        if (this.requestedStorageIdIsOccupied(document, collection)) {
          return this.duplicateStorageIdDecision(collection);
        }
        if (options.validate !== false) {
          assertApi3Identifier(document);
          assertApi3Common(document);
        }
        if (options.actor !== null) document.subject = options.actor;
        const mutation = this.writeSnapshot(
          requestedId(document) ?? randomObjectId(),
          document,
          undefined,
          "create",
          "api3",
          undefined,
          collection,
        );
        return {
          ok: true,
          mutation: this.emitApi3RealtimeMutation(
            collection,
            mutation,
            options.emitRealtime,
          ),
        };
      }
      if (existing.is_valid === 0) return { ok: false, reason: "gone" };
      if (this.preconditionFailed(existing, options.ifUnmodifiedSince, collection)) {
        return { ok: false, reason: "precondition-failed" };
      }
      if (!options.canUpdate) return { ok: false, reason: "missing-update-permission" };
      const document = normalizeTreatmentIdentity({ ...input });
      this.assertClientStorageIdCompatible(existing, document);
      document._id = existing.id;
      document.identifier = identity;
      this.assertApi3ImmutableFields(existing, document, false, true, collection);
      if (options.validate !== false) assertApi3Common(document);
      normalizeTreatmentDuration(document);
      if (options.actor !== null) document.subject = options.actor;
      const resolvedExisting = materializeApi3(existing, collection);
      if (resolvedExisting.srvCreated !== undefined) {
        document.srvCreated = resolvedExisting.srvCreated;
      }
      const serverSrvCreated = finiteInteger(resolvedExisting.srvCreated);
      const mutation = this.writeSnapshot(
        existing.id,
        document,
        existing,
        "replace",
        "api3",
        serverSrvCreated ?? undefined,
        collection,
      );
      return {
        ok: true,
        mutation: this.emitApi3RealtimeMutation(
          collection,
          mutation,
          options.emitRealtime,
        ),
      };
    });
  }

  replaceDocumentForApi3(
    collection: Api3CollectionName,
    identity: string,
    input: JsonDocument,
    options: Api3MutationOptions,
  ): Api3MutationDecision {
    return this.replaceTreatmentForApi3(identity, input, options, collection);
  }

  replaceTreatment(identity: string, input: JsonDocument): DocumentMutationResult {
    const decision = this.replaceTreatmentForApi3(identity, input, {
      canCreate: true,
      canUpdate: true,
      actor: null,
      ifUnmodifiedSince: null,
      validate: false,
    });
    if (!decision.ok) {
      throw new Error(decision.reason === "gone" ? "document is deleted" : decision.reason);
    }
    return decision.mutation;
  }

  patchTreatmentForApi3(
    identity: string,
    patch: JsonDocument,
    options: Api3MutationOptions,
    collection: Api3CollectionName = TREATMENTS,
  ): Api3MutationDecision {
    return this.storage.transactionSync(() => {
      if (!options.canUpdate) return { ok: false, reason: "missing-update-permission" };
      const existing = this.findApi3MutationCandidate(identity, collection);
      if (existing === undefined) return { ok: false, reason: "not-found" };
      if (existing.is_valid === 0) return { ok: false, reason: "gone" };
      if (this.preconditionFailed(existing, options.ifUnmodifiedSince, collection)) {
        return { ok: false, reason: "precondition-failed" };
      }
      patch = sanitizeStoredDocument(patch);
      this.assertApi3ImmutableFields(existing, patch, false, true, collection);
      if (options.validate !== false) assertApi3Common(patch, true);
      const original = materializeLegacy(existing);
      const serverPatch = { ...patch };
      if (options.actor !== null) serverPatch.modifiedBy = options.actor;
      normalizeTreatmentDuration(serverPatch, original);
      const document = { ...original, ...serverPatch };
      const mutation = this.writeSnapshot(
        existing.id,
        document,
        existing,
        "patch",
        "api3",
        undefined,
        collection,
      );
      return {
        ok: true,
        mutation: this.emitApi3RealtimeMutation(
          collection,
          mutation,
          options.emitRealtime,
        ),
      };
    });
  }

  patchDocumentForApi3(
    collection: Api3CollectionName,
    identity: string,
    patch: JsonDocument,
    options: Api3MutationOptions,
  ): Api3MutationDecision {
    return this.patchTreatmentForApi3(identity, patch, options, collection);
  }

  patchTreatment(identity: string, patch: JsonDocument): DocumentMutationResult | null {
    const decision = this.patchTreatmentForApi3(identity, patch, {
      canCreate: true,
      canUpdate: true,
      actor: null,
      ifUnmodifiedSince: null,
      validate: false,
    });
    if (!decision.ok) {
      if (decision.reason === "not-found") return null;
      throw new Error(decision.reason === "gone" ? "document is deleted" : decision.reason);
    }
    return decision.mutation;
  }

  deleteTreatment(
    identity: string,
    permanent = false,
    actor: string | null = null,
    collection: Api3CollectionName = TREATMENTS,
    emitRealtime = false,
  ): DocumentDeleteResult {
    return this.storage.transactionSync(() => {
      const existing = this.findByIdentity(identity, collection);
      if (existing === undefined) return { deleted: false, permanent };
      this.assertWritable(existing);
      if (permanent) {
        const history = this.sql.exec<{ change_id: number }>(
          `SELECT change_id FROM document_changes
           WHERE collection = ? AND id = ?
           LIMIT ?`,
          collection,
          existing.id,
          MAX_SYNCHRONOUS_ENTRY_DELETES + 1,
        ).toArray();
        if (history.length > MAX_SYNCHRONOUS_ENTRY_DELETES) {
          return { deleted: false, permanent: true, tooLarge: true };
        }
        this.sql.exec(
          "DELETE FROM document_changes WHERE collection = ? AND id = ?",
          collection,
          existing.id,
        );
        this.sql.exec(
          "DELETE FROM documents WHERE collection = ? AND id = ?",
          collection,
          existing.id,
        );
        if (collection === ENTRIES) this.sql.exec("DELETE FROM entries WHERE id = ?", existing.id);
        if (emitRealtime && this.onApi3RealtimeMutation !== undefined) {
          this.onApi3RealtimeMutation({ type: "delete", collection, identifier: identity });
        }
        this.onDataMutation?.(collection);
        return { deleted: true, permanent: true };
      }
      const document = materializeLegacy(existing);
      document.isValid = false;
      if (actor !== null) document.modifiedBy = actor;
      const mutation = this.writeSnapshot(
        existing.id,
        document,
        existing,
        "delete",
        "api3",
        undefined,
        collection,
      );
      if (mutation.srvModified === null) throw new Error("soft delete has no srvModified");
      if (emitRealtime && this.onApi3RealtimeMutation !== undefined) {
        this.onApi3RealtimeMutation({ type: "delete", collection, identifier: identity });
      }
      return {
        deleted: true,
        permanent: false,
        revision: mutation.revision,
        srvModified: mutation.srvModified,
      };
    });
  }

  deleteDocumentForApi3(
    collection: Api3CollectionName,
    identity: string,
    permanent = false,
    actor: string | null = null,
  ): DocumentDeleteResult {
    return this.deleteTreatment(identity, permanent, actor, collection, true);
  }

  deleteDocumentById(collection: StoredDocumentCollectionName, id: string): boolean {
    return this.storage.transactionSync(() => {
      const existing = this.findByIdRow(id, collection);
      if (existing === undefined) return false;
      this.sql.exec("DELETE FROM document_changes WHERE collection = ? AND id = ?", collection, id);
      this.sql.exec("DELETE FROM documents WHERE collection = ? AND id = ?", collection, id);
      if (collection === ENTRIES) this.sql.exec("DELETE FROM entries WHERE id = ?", id);
      if (collection !== "activity") {
        this.onApi3RealtimeMutation?.({
          type: "delete",
          collection,
          identifier: existing.identifier || existing.id,
          recordRootUpdate: false,
        });
      }
      this.onDataMutation?.(collection);
      return true;
    });
  }

  deleteTreatmentById(id: string): boolean {
    return this.deleteDocumentById(TREATMENTS, id);
  }

  deleteLegacyTreatment(identity: string, uuidHandling = true): boolean {
    return this.storage.transactionSync(() => {
      const existing = OBJECT_ID.test(identity)
        ? this.findByIdRow(identity.toLowerCase())
        : UUID.test(identity)
          ? uuidHandling
            ? this.findByIdentifierRow(identity) ?? this.findByIdRow(identity)
            : this.findByIdRow(identity)
          : undefined;
      if (existing === undefined) return false;
      this.sql.exec(
        "DELETE FROM document_changes WHERE collection = ? AND id = ?",
        TREATMENTS,
        existing.id,
      );
      this.sql.exec(
        "DELETE FROM documents WHERE collection = ? AND id = ?",
        TREATMENTS,
        existing.id,
      );
      this.onApi3RealtimeMutation?.({
        type: "delete",
        collection: TREATMENTS,
        identifier: existing.identifier || existing.id,
        recordRootUpdate: false,
      });
      this.onDataMutation?.(TREATMENTS);
      return true;
    });
  }

  treatmentsLastModified(collection: Api3CollectionName = TREATMENTS): number | null {
    const row = this.sql.exec<{ effective_modified: number }>(
      `SELECT effective_modified
       FROM documents
       WHERE collection = ?
         AND effective_modified IS NOT NULL
       ORDER BY effective_modified DESC, id ASC
       LIMIT 1`,
      collection,
    ).toArray()[0];
    return row === undefined ? null : Math.trunc(row.effective_modified);
  }

  collectionLastModified(collection: Api3CollectionName): number | null {
    return this.treatmentsLastModified(collection);
  }

  treatmentHistory(
    query: DocumentHistoryQuery,
    collection: Api3CollectionName = TREATMENTS,
  ): JsonDocument[] {
    if (!Number.isFinite(query.since)) throw new Error("history timestamp must be finite");
    const comparison = query.inclusive === true ? ">=" : ">";
    const rows = this.sql.exec<DbDocumentV4>(
      `SELECT *
       FROM documents
       WHERE collection = ?
         AND effective_modified ${comparison} ?
       ORDER BY effective_modified ASC, id ASC
       LIMIT ?`,
      collection,
      Math.trunc(query.since),
      boundedLimit(query.limit),
    ).toArray();
    return rows
      .map((row) => materializeApi3(row, collection))
      .map((document) => project(document, query.fields));
  }

  documentHistory(
    collection: Api3CollectionName,
    query: DocumentHistoryQuery,
  ): JsonDocument[] {
    return this.treatmentHistory(query, collection);
  }
}
