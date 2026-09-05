import { DeviceStatusQueryCache } from "./realtime/device-status-query-cache";
import { RealtimeEntryQueryCache } from "./realtime/entry-query-cache";
import { DurableObject } from "cloudflare:workers";
import { SqliteAdminNotifyRepository } from "./admin-notifies";
import {
  migrateBackgroundTasksV14,
  PLUGIN_NOTIFICATIONS_TASK,
  SqliteBackgroundTaskRepository,
  type BackgroundTaskRow,
} from "./background-tasks";
import {
  apiSecretDigestMatches,
  authorizationPermissionGroups,
  authorizationRoleNames,
  authorizationDerivationMarker,
  boundedTokenCandidates,
  deriveSubjectCredential,
  subjectCredentialMatches,
  type PresentedToken,
  type SubjectCredential,
} from "./authorization";
import {
  migrateDataUpdateDebounceV16,
  SqliteDataUpdateDebounceRepository,
} from "./data-update-debounce";
import {
  createJwtSecret,
  isJwtSecret,
  issueJwt as signJwt,
  verifyJwt as validateJwt,
} from "./jwt";
import { permissionGroupsAllow } from "./permissions";
import {
  documentReadSchemaIsCurrent,
  entriesShadowSchemaIsCurrent,
  migrateEntriesV6,
  migrateDocumentsV4,
  migrateEffectiveModifiedV26,
  DocumentQueryError,
  SqliteDocumentRepository,
  type Api3CollectionName,
  type Api3MutationOptions,
  type DocumentDeleteResult,
  type DocumentHistoryQuery,
  type DocumentQuery,
} from "./document-repository";
import {
  DurableObjectWriteQuotaError,
  durableObjectWriteQuotaResetAt,
  durableObjectWriteQuotaRetryAfterSeconds,
  isDurableObjectWriteQuotaError,
  isDurableObjectReadQuotaError,
} from "./platform-errors";
import {
  type HistoryQuery,
  type PublicEntry,
  type ValidatedEntry,
} from "./model";
import { sqliteNightscoutDatabaseStats } from "./data-loader";
import { fitTreatmentsToBgCurve } from "./data/treatment-to-curve";
import {
  normalizeLegacyDeviceStatusDocument,
  parseLegacyPredictionsMaxSize,
} from "./documents";
import {
  migrateRealtimeAlarmNamespaceV10,
  migrateRealtimeClosuresV8,
  migrateRealtimeSessions,
  migrateRealtimeRootUpdatesV11,
  migrateRealtimeStorageNamespaceV9,
  migrateRealtimeTransportsV7,
  migrateRealtimeNotificationStateV13,
  migrateRealtimeProtocolsV19,
  migrateRealtimeJsonpV21,
  migrateRealtimeWriteAuthorityV12,
} from "./realtime/session-repository";
import {
  RealtimeSessionError,
  RealtimeSessionService,
  type RealtimeAlarmAuthorization,
  type RealtimeAuthorization,
  type RealtimeRootWriteRequest,
  type RealtimeRootWriteResult,
  type RealtimeSnapshot,
} from "./realtime/session-service";
import {
  buildRealtimeTreatmentBuckets,
  buildRealtimeRetroDeviceStatus,
  filterRealtimePublicProfiles,
  normalizeRealtimeDdataDocument,
  normalizeRealtimeDeviceStatus,
  normalizeRealtimeDocument,
  selectRealtimeRecentDeviceStatus,
  type RealtimeDocument,
  type RealtimeTreatmentBuckets,
} from "./realtime/ddata-snapshot";
import {
  REALTIME_DEVICE_STATUS_WINDOW_MS,
  REALTIME_MAX_PAYLOAD_BYTES,
  REALTIME_MAX_SESSIONS_PER_TENANT,
  REALTIME_PING_INTERVAL_MS,
  REALTIME_PING_TIMEOUT_MS,
  REALTIME_SNAPSHOT_MAX_BYTES,
  REALTIME_SNAPSHOT_MAX_DOCUMENT_DEPTH,
  REALTIME_SNAPSHOT_MAX_DOCUMENTS,
  REALTIME_SNAPSHOT_MAX_NODES,
  REALTIME_SNAPSHOT_MAX_STRING_CHARACTERS,
  REALTIME_WEBSOCKET_FLUSH_MAX_BYTES,
  REALTIME_WEBSOCKET_FLUSH_MAX_FRAMES,
  REALTIME_WEBSOCKET_FLUSH_MAX_SOCKETS,
  type RealtimeEngineProtocol,
} from "./realtime/constants";
import {
  nightscoutStatus,
  nightscoutWebsocketStatus,
  tenantStatusSettings as deriveTenantStatusSettings,
  type NightscoutStatusEnvironment,
  type NightscoutStatusSettingsOverrides,
} from "./status";
import { calculateSimpleAlarmRequest } from "./plugins/simplealarms";
import { calculateAr2NotificationRequest } from "./plugins/ar2";
import {
  calculateUploaderBatteryProperty,
  uploaderBatteryNotification,
} from "./plugins/upbat";
import { calculateErrorCodeNotification } from "./plugins/errorcodes";
import {
  calculateXdripJsEvaluation,
  type XdripJsStateNotification,
} from "./plugins/xdripjs";
import { calculateAgeNotificationEvaluation } from "./plugins/age";
import {
  calculateDatabaseSizeProperty,
  databaseSizeNotification,
} from "./plugins/dbsize";
import { nightscoutDirectionInfo } from "./plugins/direction";
import { calculateClosedLoopNotificationEvaluation } from "./plugins/closed-loop-notifications";
import {
  calculateBwpNotificationEvaluation,
  type BwpProperty,
} from "./plugins/bwp";
import {
  calculatePluginProperties,
  createPluginProfileFunctions,
} from "./plugins/properties";
import { calculateTreatmentNotificationEvaluation } from "./plugins/treatmentnotify";
import { calculateTimeAgoNotificationEvaluation } from "./plugins/timeago";
import { createNightscoutProfileFunctions } from "./profile-functions";
import { nightscoutTimes } from "./runtime/times";
import {
  NightscoutPushNotify,
} from "./pushnotify";
import { SqlitePushNotificationStateStore } from "./push-notification-store";
import {
  nightscoutAlarmEventEnabled,
  nightscoutFirstSnoozeMins,
} from "./settings";

export type DocumentCollection =
  | "activity"
  | "food"
  | "profile"
  | "treatments"
  | "devicestatus"
  | "subjects"
  | "roles";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonDocument {
  [key: string]: JsonValue;
}

interface DbDocument {
  [key: string]: SqlStorageValue;
  id: string;
  body: string;
  sort_time: number;
  updated_at: number;
}

interface DbSecret {
  [key: string]: SqlStorageValue;
  value: string;
}

interface DbPluginRuntimeState {
  [key: string]: SqlStorageValue;
  body: string;
  updated_at: number;
}

export interface WriteResult {
  inserted: number;
  duplicates: number;
  entriesJson: string;
}

export type RealtimeRpcResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code: RealtimeSessionError["code"];
        message: string;
      };
    };

export type AuthorizationMutationResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export type LegacyTreatmentCreateResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

type EntryStoreEnv = Env
  & NightscoutStatusEnvironment
  & {
  API_SECRET?: string;
  AUTH_DEFAULT_ROLES?: string;
  PREDICTIONS_MAX_SIZE?: string;
  UUID_HANDLING?: string;
};

export const ENTRY_STORE_ACTIVATION_SEAL = 28;

const ENTRY_STORE_REQUIRED_MIGRATIONS = [
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  18,
  19,
  20,
  21,
  22,
  24,
  26,
  27,
  ENTRY_STORE_ACTIVATION_SEAL,
] as const;

const ENTRY_STORE_CORE_READ_MIGRATIONS = [2, 3, 4] as const;

function sqliteTableHasColumns(
  sql: SqlStorage,
  table: string,
  required: readonly string[],
): boolean {
  if (!/^[a-z_]+$/.test(table)) return false;
  const columns = new Set(
    sql.exec<{ name: string }>(`PRAGMA table_info(${table})`)
      .toArray()
      .map((column) => column.name),
  );
  return required.every((column) => columns.has(column));
}

function sqliteMigrationMarkersPresent(
  sql: SqlStorage,
  required: readonly number[],
): boolean {
  const markers = new Set(
    sql.exec<{ id: number }>(
      `SELECT id FROM _sql_schema_migrations
       WHERE id IN (${required.join(",")})`,
    ).toArray().map((row) => row.id),
  );
  return required.every((id) => markers.has(id));
}

/**
 * One-row activation preflight written only after the complete schema and
 * realtime root snapshot have been prepared. A current tenant must not rerun
 * idempotent DDL/DML on every Durable Object wake.
 */
export function entryStoreSchemaIsActivationReady(sql: SqlStorage): boolean {
  try {
    return sqliteMigrationMarkersPresent(sql, [ENTRY_STORE_ACTIVATION_SEAL]);
  } catch {
    return false;
  }
}

/**
 * Minimum schema required to keep existing HTTP reads and authorization
 * checks available after Cloudflare has temporarily rejected SQLite writes.
 * Realtime and mutations remain disabled until the next daily quota reset.
 */
export function entryStoreSchemaSupportsCoreReadOnly(sql: SqlStorage): boolean {
  try {
    return sqliteMigrationMarkersPresent(sql, ENTRY_STORE_CORE_READ_MIGRATIONS)
      && sqliteTableHasColumns(
        sql,
        "documents",
        [
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
        ],
      )
      && sqliteTableHasColumns(sql, "tenant_secrets", ["name", "value", "created_at"])
      && sqliteTableHasColumns(
        sql,
        "authorization_failures",
        ["ip", "retry_at", "updated_at"],
      )
      && sqliteTableHasColumns(
        sql,
        "admin_notifies",
        ["message", "body", "count", "last_recorded", "persistent"],
      );
  } catch {
    return false;
  }
}

/**
 * Full schema audit used by tests and migration diagnostics. The constructor
 * uses the single-row activation marker above so ordinary wakes stay cheap.
 */
export function entryStoreSchemaSupportsReadOnly(sql: SqlStorage): boolean {
  try {
    if (!sqliteMigrationMarkersPresent(sql, ENTRY_STORE_REQUIRED_MIGRATIONS)) {
      return false;
    }
    if (!documentReadSchemaIsCurrent(sql) || !entriesShadowSchemaIsCurrent(sql)) {
      return false;
    }
    if (
      !sqliteTableHasColumns(sql, "tenant_secrets", ["name", "value", "created_at"])
      || !sqliteTableHasColumns(
        sql,
        "authorization_failures",
        ["ip", "retry_at", "updated_at"],
      )
      || !sqliteTableHasColumns(
        sql,
        "admin_notifies",
        ["message", "body", "count", "last_recorded", "persistent"],
      )
      || !sqliteTableHasColumns(
        sql,
        "realtime_root_state",
        ["singleton", "snapshot", "updated_at"],
      )
    ) {
      return false;
    }
    return sql.exec<{ present: number }>(
      "SELECT EXISTS(SELECT 1 FROM realtime_root_state WHERE singleton = 1) AS present",
    ).one().present !== 0;
  } catch {
    return false;
  }
}

// Keep the original tag strings so already-hibernated EIO4 sockets survive a
// deployment; they now identify both accepted Engine.IO protocol versions.
const REALTIME_WEBSOCKET_TAG = "eio4-websocket";
const REALTIME_WEBSOCKET_SID_TAG_PREFIX = "eio4-sid:";
const REALTIME_WEBSOCKET_ATTACHMENT_VERSION = 2;
const REALTIME_WEBSOCKET_EVENT_TIMEOUT_MS = 15_000;
const REALTIME_SID = /^[A-Za-z0-9_-]{20}$/;
const REALTIME_ENTRY_WINDOW_MS = 2 * 24 * 60 * 60 * 1_000;
const AGE_TREATMENT_WINDOW_MS = 62 * 24 * 60 * 60 * 1_000;
const RUNTIME_TREATMENT_WINDOW_MS = Math.round(2.5 * 24 * 60 * 60 * 1_000);
const RUNTIME_RECENT_MUTATION_WINDOW_MS = 15 * 60 * 1_000;
const PROFILE_SWITCH_WINDOW_MS = 31 * 12 * 24 * 60 * 60 * 1_000;
const NOTIFICATION_REQUEST_BATCH_LIMIT = 128;
const BACKGROUND_TASK_BATCH_LIMIT = 4;
const MIN_NOTIFICATION_HEARTBEAT_SECONDS = 15;
const MAX_NOTIFICATION_HEARTBEAT_SECONDS = 24 * 60 * 60;
const AGE_TREATMENT_EVENT_TYPES = [
  "Sensor Start",
  "Sensor Change",
  "Sensor Stop",
  "Site Change",
  "Insulin Change",
  "Pump Battery Change",
] as const;
const REALTIME_TREATMENT_BUCKET_KEYS: readonly (keyof RealtimeTreatmentBuckets)[] = [
  "sitechangeTreatments",
  "insulinchangeTreatments",
  "batteryTreatments",
  "sensorTreatments",
  "profileTreatments",
  "combobolusTreatments",
  "tempbasalTreatments",
  "tempTargetTreatments",
];
const API3_STORAGE_COLLECTIONS: readonly Api3CollectionName[] = [
  "devicestatus",
  "entries",
  "food",
  "profile",
  "settings",
  "treatments",
];
// Locked Profile.last() is the source for /profile/current, status settings,
// and dataloader realtime profiles. json_valid keeps the adapter resilient to
// a corrupt SQLite row that MongoDB itself could never have stored.
const PROFILE_CURRENT_ORDER_BY =
  "CASE WHEN json_valid(body) THEN json_extract(body, '$.startDate') ELSE NULL END DESC, id DESC";

interface RealtimeWebSocketAttachment {
  version: typeof REALTIME_WEBSOCKET_ATTACHMENT_VERSION;
  objectId: string;
  sid: string;
  mode: "session" | "upgrade";
  engineProtocol: RealtimeEngineProtocol;
  lastSeenAt?: number;
  nextPingAt?: number | null;
  pongDeadline?: number | null;
  phase?: "opening" | "probed";
  deadline?: number;
}

interface PluginPropertyContext {
  sgvs: RealtimeDocument[];
  mbgs: RealtimeDocument[];
  cals: RealtimeDocument[];
  devicestatus: RealtimeDocument[];
  treatments: RealtimeDocument[];
  profiles: RealtimeDocument[];
  dbstats: Record<string, unknown>;
}

type RealtimeSnapshotMode = "root" | "ddata";

interface FullRealtimeDdataSnapshot extends RealtimeSnapshot, RealtimeTreatmentBuckets {
  activity: RealtimeDocument[];
  lastUpdated: number;
  lastProfileFromSwitch: string | null;
  page?: { frame: true; after: number };
}

interface AutomaticNotificationRuntime {
  settings: Record<string, unknown>;
  extendedSettings: Record<string, unknown>;
  enabled: ReadonlySet<string>;
  upbat: boolean;
  ar2: boolean;
  simpleAlarms: boolean;
  errorCodes: boolean;
  xdripJs: boolean;
  pump: boolean;
  openAps: boolean;
  loop: boolean;
  bwp: boolean;
  cage: boolean;
  sage: boolean;
  iage: boolean;
  bage: boolean;
  treatmentNotify: boolean;
  timeAgo: boolean;
  dbSize: boolean;
}

interface AutomaticNotificationData {
  sgvs: RealtimeDocument[];
  mbgs: RealtimeDocument[];
  devicestatus: RealtimeDocument[];
  profiles: RealtimeDocument[];
  treatments: RealtimeDocument[];
  ageTreatments: RealtimeDocument[];
  dbstats: Record<string, unknown>;
}

interface AutomaticNotificationEvaluation {
  notifications: RealtimeDocument[];
  snoozes: RealtimeDocument[];
  nextDueAt: number | null;
  xdripStateNotification: XdripJsStateNotification | null;
  xdripStateNotificationChanged: boolean;
}

type RealtimeWebSocketCloseResult = "inactive" | "closed" | "failed";

function randomObjectId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function legacyStorageSaveObjectId(value: unknown): string {
  return typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value)
    ? value.toLowerCase()
    : randomObjectId();
}

function toPublicEntry(document: JsonDocument): PublicEntry {
  const id = document._id;
  const date = document.date;
  if (
    typeof id !== "string"
    || typeof date !== "number"
  ) {
    throw new Error("stored entry is missing its legacy public fields");
  }
  return { ...document, _id: id, date };
}

function realtimeMeasurement(value: unknown): number | null {
  // Locked dataloader classification uses JS truthiness followed by Number().
  // Preserve numeric strings and the mbg-before-sgv priority, but omit values
  // that would become NaN/Infinity instead of serializing misleading nulls.
  if (!value) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

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

function documentSortTime(document: JsonDocument): number {
  for (const field of ["date", "mills", "created_at", "timestamp", "startDate"]) {
    const value = document[field];
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return Date.now();
}

function toDocument(row: DbDocument): JsonDocument {
  return JSON.parse(row.body) as JsonDocument;
}

function tryDocument(row: DbDocument): JsonDocument | null {
  try {
    const parsed: unknown = JSON.parse(row.body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as JsonDocument
      : null;
  } catch {
    return null;
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function publicAuthorizationSubject(subject: JsonDocument): JsonDocument {
  const result: JsonDocument = {};
  for (const field of ["_id", "name", "accessToken", "roles"] as const) {
    const value = subject[field];
    if (value !== undefined) result[field] = value;
  }
  if (result.roles === undefined) result.roles = [];
  return result;
}

function publicAuthorizationSubjectMutation(subject: JsonDocument): JsonDocument {
  const result = { ...subject };
  // Locked Nightscout derives accessToken while loading subjects. Its create
  // and update responses are the database document, so a newly derived token
  // is obtained from the subjects GET rather than leaked by the mutation.
  for (const field of Object.keys(result)) {
    if (
      field === "accessToken" ||
      field === "digest" ||
      field === "accessTokenDigest" ||
      field.startsWith("_nscf")
    ) {
      delete result[field];
    }
  }
  return result;
}

const realtimeJsonEncoder = new TextEncoder();
const AUTHORIZATION_SUBJECT_LIMIT = 256;
const AUTHORIZATION_FAILURE_AGE_MS = 60_000;
const AUTHORIZATION_FAILURE_LIMIT = 4096;
const AUTHORIZATION_FAILURE_MAX_DELAY_MS = 60_000;
const REALTIME_ROOT_WRITE_BATCH_MAX_DOCUMENTS = 100;

function realtimeJsonBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("realtime JSON value is not serializable");
  return realtimeJsonEncoder.encode(serialized).byteLength;
}

function realtimeStoredBodyAllowed(body: string): boolean {
  // UTF-16 length is a cheap lower bound for UTF-8 size and avoids allocating
  // another near-megabyte buffer for a body that is already too large.
  if (body.length > REALTIME_SNAPSHOT_MAX_BYTES) return false;
  const bytes = realtimeJsonEncoder.encode(body).byteLength;
  return bytes <= REALTIME_SNAPSHOT_MAX_BYTES;
}

interface RealtimeJsonMetrics {
  nodes: number;
  maxDepth: number;
  maxStringCharacters: number;
}

function realtimeJsonMetrics(
  value: unknown,
  enforceDocumentShape = false,
): RealtimeJsonMetrics {
  const work: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  let maxDepth = 0;
  let maxStringCharacters = 0;
  while (work.length > 0) {
    const item = work.pop();
    if (item === undefined) break;
    nodes += 1;
    maxDepth = Math.max(maxDepth, item.depth);
    if (nodes > REALTIME_SNAPSHOT_MAX_NODES) {
      return { nodes, maxDepth, maxStringCharacters };
    }
    if (enforceDocumentShape && maxDepth > REALTIME_SNAPSHOT_MAX_DOCUMENT_DEPTH) {
      return { nodes, maxDepth, maxStringCharacters };
    }
    if (typeof item.value === "string") {
      maxStringCharacters = Math.max(maxStringCharacters, item.value.length);
      if (
        enforceDocumentShape &&
        maxStringCharacters > REALTIME_SNAPSHOT_MAX_STRING_CHARACTERS
      ) {
        return { nodes, maxDepth, maxStringCharacters };
      }
    } else if (Array.isArray(item.value)) {
      if (nodes + work.length + item.value.length > REALTIME_SNAPSHOT_MAX_NODES) {
        return {
          nodes: REALTIME_SNAPSHOT_MAX_NODES + 1,
          maxDepth,
          maxStringCharacters,
        };
      }
      for (const child of item.value) work.push({ value: child, depth: item.depth + 1 });
    } else if (typeof item.value === "object" && item.value !== null) {
      for (const key in item.value) {
        if (!Object.prototype.hasOwnProperty.call(item.value, key)) continue;
        maxStringCharacters = Math.max(maxStringCharacters, key.length);
        if (
          enforceDocumentShape &&
          maxStringCharacters > REALTIME_SNAPSHOT_MAX_STRING_CHARACTERS
        ) {
          return { nodes, maxDepth, maxStringCharacters };
        }
        if (nodes + work.length + 1 > REALTIME_SNAPSHOT_MAX_NODES) {
          return {
            nodes: REALTIME_SNAPSHOT_MAX_NODES + 1,
            maxDepth,
            maxStringCharacters,
          };
        }
        const child = (item.value as Record<string, unknown>)[key];
        work.push({ value: child, depth: item.depth + 1 });
      }
    }
  }
  return { nodes, maxDepth, maxStringCharacters };
}

function realtimeDocumentShapeAllowed(metrics: RealtimeJsonMetrics): boolean {
  return metrics.nodes <= REALTIME_SNAPSHOT_MAX_NODES
    && metrics.maxDepth <= REALTIME_SNAPSHOT_MAX_DOCUMENT_DEPTH
    && metrics.maxStringCharacters <= REALTIME_SNAPSHOT_MAX_STRING_CHARACTERS;
}

function realtimeRootWriteDocument(value: unknown): JsonDocument | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const metrics = realtimeJsonMetrics(value, true);
  if (!realtimeDocumentShapeAllowed(metrics)) return null;
  try {
    if (realtimeJsonBytes(value) > REALTIME_SNAPSHOT_MAX_BYTES) return null;
    return structuredClone(value) as JsonDocument;
  } catch {
    return null;
  }
}

function isEntryStoreWriteQuotaError(error: unknown): boolean {
  return isDurableObjectWriteQuotaError(error)
    || (
      error instanceof RealtimeSessionError
      && error.code === "storage_quota"
    );
}

class RealtimeJsonBudget {
  private usedBytes: number;
  private usedNodes: number;
  private usedDocuments: number;

  constructor(base: unknown, documents = 0) {
    this.usedBytes = realtimeJsonBytes(base);
    this.usedNodes = realtimeJsonMetrics(base).nodes;
    this.usedDocuments = documents;
    if (this.usedBytes > REALTIME_SNAPSHOT_MAX_BYTES) {
      throw new Error("realtime snapshot base exceeds its byte budget");
    }
    if (this.usedNodes > REALTIME_SNAPSHOT_MAX_NODES) {
      throw new Error("realtime snapshot base exceeds its node budget");
    }
  }

  reserveArrayItem(value: unknown, priorItems: number): boolean {
    const metrics = realtimeJsonMetrics(value, true);
    if (
      !realtimeDocumentShapeAllowed(metrics) ||
      this.usedNodes + metrics.nodes > REALTIME_SNAPSHOT_MAX_NODES ||
      this.usedDocuments + 1 > REALTIME_SNAPSHOT_MAX_DOCUMENTS
    ) {
      return false;
    }
    // Stringify only after the iterative shape walk has established safe
    // depth, node, and scalar bounds.
    const addedBytes = realtimeJsonBytes(value) + (priorItems === 0 ? 0 : 1);
    if (this.usedBytes + addedBytes > REALTIME_SNAPSHOT_MAX_BYTES) return false;
    this.usedBytes += addedBytes;
    this.usedNodes += metrics.nodes;
    this.usedDocuments += 1;
    return true;
  }
}

export class EntryStore extends DurableObject<EntryStoreEnv> {
  private readonly realtime: RealtimeSessionService;
  private readonly realtimeEntryQueries = new RealtimeEntryQueryCache<DbDocument>();
  private realtimeDeviceStatusQueries = new DeviceStatusQueryCache<DbDocument>();
  private deviceStatusCacheMutation = false;
  private readonly activeWebSocketSessions = new Set<string>();
  private storageWriteQuotaBlockedUntil = 0;
  private storageSchemaInitializationPending = false;
  private realtimeAlarmRecoveryPending = false;
  private realtimeAlarmRecoveryScheduled = false;

  constructor(ctx: DurableObjectState, env: EntryStoreEnv) {
    super(ctx, env);
    ctx.setHibernatableWebSocketEventTimeout(REALTIME_WEBSOCKET_EVENT_TIMEOUT_MS);
    this.realtime = new RealtimeSessionService(ctx.storage, {
      snapshot: (now) => this.realtimeSnapshot(now),
      retroDeviceStatus: (now) => this.realtimeRetroDeviceStatus(now),
      status: (now) => nightscoutWebsocketStatus(
        new Date(now),
        this.activeProfileFromSwitch(now),
        this.env.AUTH_DEFAULT_ROLES ?? "readable",
        this.tenantStatusSettings(),
      ),
      activeProfile: (now) => this.activeProfileFromSwitch(now),
      authorize: (message) => this.realtimeAuthorize(message),
      authorizeStorage: (message) => this.realtimeStorageAuthorize(message),
      authorizeAlarm: (message) => this.realtimeAlarmAuthorize(message),
      writeRoot: (request) => this.realtimeRootWrite(request),
    });
    ctx.blockConcurrencyWhile(async () => {
      if (!entryStoreSchemaIsActivationReady(this.ctx.storage.sql)) {
        this.storageSchemaInitializationPending = true;
        try {
          this.completeStorageInitialization();
        } catch (error) {
          if (
            !isEntryStoreWriteQuotaError(error)
            || !entryStoreSchemaSupportsCoreReadOnly(this.ctx.storage.sql)
          ) {
            throw error;
          }
          this.realtimeAlarmRecoveryPending = true;
          this.enterStorageWriteQuotaMode(error);
          return;
        }
      }
      if (this.storageWritesBlocked()) return;
      try {
        this.reconcileRealtimeWebSocketSessions();
        await this.synchronizeRealtimeAlarm();
      } catch (error) {
        if (!isEntryStoreWriteQuotaError(error)) throw error;
        this.realtimeAlarmRecoveryPending = true;
        this.enterStorageWriteQuotaMode(error);
      }
    });
  }

  private completeStorageInitialization(): void {
    this.realtimeEntryQueries.clear();
    this.realtimeDeviceStatusQueries.clear();
    // This method is intentionally synchronous. A request cannot observe a
    // half-repaired schema between quota reset and the activation seal.
    this.storageSchemaInitializationPending = false;
    try {
      this.migrate();
      this.reconcileAdminNotifies(Date.now());
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (?)",
        ENTRY_STORE_ACTIVATION_SEAL,
      );
    } catch (error) {
      this.storageSchemaInitializationPending = true;
      throw error;
    }
  }

  private migrate(): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
          id INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      const version = this.ctx.storage.sql
        .exec<{ version: number }>(
          "SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations",
        )
        .one().version;

      if (version < 1) {
        this.ctx.storage.sql.exec(`
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
          );
          CREATE INDEX IF NOT EXISTS entries_date_desc ON entries(date DESC);
          INSERT INTO _sql_schema_migrations (id) VALUES (1);
        `);
      }

      if (version < 2) {
        this.ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS documents (
            collection TEXT NOT NULL,
            id TEXT NOT NULL,
            body TEXT NOT NULL,
            sort_time INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (collection, id)
          );
          CREATE INDEX IF NOT EXISTS documents_collection_sort
            ON documents(collection, sort_time DESC);
          INSERT INTO _sql_schema_migrations (id) VALUES (2);
        `);
      }

      if (version < 3) {
        this.ctx.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS tenant_secrets (
            name TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          INSERT INTO _sql_schema_migrations (id) VALUES (3);
        `);
      }

      // Schema v4 is also checked after its marker exists so partial installs
      // and the identifier-presence metadata added to the same contract are
      // repaired idempotently on activation.
      migrateDocumentsV4(this.ctx.storage.sql);
      if (version < 4) {
        this.ctx.storage.sql.exec("INSERT INTO _sql_schema_migrations (id) VALUES (4)");
      }

      // Realtime schema creation remains idempotent after its marker so a
      // partially initialized Durable Object is repaired on activation.
      migrateRealtimeSessions(this.ctx.storage);
      if (version < 5) {
        this.ctx.storage.sql.exec("INSERT INTO _sql_schema_migrations (id) VALUES (5)");
      }
      // Inspect the Entries shadow on every activation. The marker records
      // provenance only: another branch may already have advanced MAX(id), and
      // an incompatible pre-1.0 table must still be reset independently.
      const entriesMarkerPresent = this.ctx.storage.sql.exec<{ present: number }>(
        "SELECT EXISTS(SELECT 1 FROM _sql_schema_migrations WHERE id = 6) AS present",
      ).one().present !== 0;
      migrateEntriesV6(this.ctx.storage.sql);
      if (!entriesMarkerPresent) {
        this.ctx.storage.sql.exec("INSERT INTO _sql_schema_migrations (id) VALUES (6)");
      }

      migrateRealtimeTransportsV7(this.ctx.storage);
      // MAX(id) is not proof that this specific repair marker exists: a later
      // independent migration may already have a higher id.
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (7)",
      );

      migrateRealtimeClosuresV8(this.ctx.storage);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (8)",
      );

      migrateRealtimeStorageNamespaceV9(this.ctx.storage);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (9)",
      );

      migrateRealtimeAlarmNamespaceV10(this.ctx.storage);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (10)",
      );

      migrateRealtimeRootUpdatesV11(this.ctx.storage);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (11)",
      );

      migrateRealtimeWriteAuthorityV12(this.ctx.storage);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (12)",
      );

      migrateRealtimeNotificationStateV13(this.ctx.storage);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (13)",
      );

      migrateBackgroundTasksV14(this.ctx.storage);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (14)",
      );

      // Admin notifications were a Node-process-local array upstream. Persist
      // them per tenant so DO eviction does not erase the warning drawer.
      this.adminNotifies().migrate();
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (15)",
      );

      // Upstream bootevent uses process-local lodash debounce and mutable
      // running/pending flags. Persist the equivalent burst window so rapid
      // uploads remain coalesced across Durable Object eviction.
      migrateDataUpdateDebounceV16(this.ctx.storage);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (16)",
      );

      // Upstream pushnotify keeps dedupe leases, Pushover receipts and Maker
      // All Clear state in process memory. Persist them per tenant so Worker
      // eviction cannot duplicate an alarm or lose a receipt callback.
      this.pushNotificationState().migrate();
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (18)",
      );

      // Locked Socket.IO keeps allowEIO3 enabled. Admit protocol 3 sessions in
      // the same bounded durable table while preserving all existing EIO4 rows.
      migrateRealtimeProtocolsV19(this.ctx.storage);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (19)",
      );

      // Some locked plugins retain small notification throttling markers in
      // module globals. Keep generic per-plugin JSON state in tenant SQLite so
      // isolate eviction cannot reset their ordinary-user alert cadence.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS plugin_runtime_state (
          plugin TEXT PRIMARY KEY,
          body TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (20)",
      );

      // Engine.IO fixes the XHR-versus-JSONP polling implementation at the
      // initial handshake. Persist the sanitized callback index so a JSONP
      // SID retains its response envelope across Durable Object eviction.
      migrateRealtimeJsonpV21(this.ctx.storage);
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (21)",
      );

      const retiredTestFeedRemoved = this.ctx.storage.sql.exec<{ present: number }>(
        "SELECT EXISTS(SELECT 1 FROM _sql_schema_migrations WHERE id = 22) AS present",
      ).one().present !== 0;
      if (!retiredTestFeedRemoved) {
        // Remove the former deployment-only test feed and every row it created.
        // Ordinary user data cannot carry this reserved internal device value.
        this.ctx.storage.sql.exec(`
          DELETE FROM document_changes
          WHERE collection = 'entries'
            AND json_extract(body, '$.device') = 'simulator://nscf-test';
          DELETE FROM entries WHERE device = 'simulator://nscf-test';
          DELETE FROM documents
          WHERE collection = 'entries'
            AND json_extract(body, '$.device') = 'simulator://nscf-test';
          DROP TABLE IF EXISTS simulated_cgm_state;
          INSERT INTO _sql_schema_migrations (id) VALUES (22);
        `);
      }

      const embeddedDexcomTaskRemoved = this.ctx.storage.sql.exec<{ present: number }>(
        "SELECT EXISTS(SELECT 1 FROM _sql_schema_migrations WHERE id = 24) AS present",
      ).one().present !== 0;
      if (!embeddedDexcomTaskRemoved) {
        // Dexcom Share now runs in its own Durable Object so a slow vendor
        // request can never delay this object's Engine.IO heartbeat alarm.
        this.ctx.storage.sql.exec(`
          DELETE FROM background_tasks WHERE kind = 'connect-dexcomshare';
          DELETE FROM plugin_runtime_state WHERE plugin = 'connect-dexcomshare';
          INSERT INTO _sql_schema_migrations (id) VALUES (24);
        `);
      }

      const effectiveModifiedBackfilled = this.ctx.storage.sql.exec<{ present: number }>(
        "SELECT EXISTS(SELECT 1 FROM _sql_schema_migrations WHERE id = 26) AS present",
      ).one().present !== 0;
      if (!effectiveModifiedBackfilled) {
        migrateEffectiveModifiedV26(this.ctx.storage.sql);
        this.ctx.storage.sql.exec(
          "INSERT INTO _sql_schema_migrations (id) VALUES (26)",
        );
      }

      const legacyNotificationScheduleRemoved = this.ctx.storage.sql.exec<{ present: number }>(
        "SELECT EXISTS(SELECT 1 FROM _sql_schema_migrations WHERE id = 27) AS present",
      ).one().present !== 0;
      if (!legacyNotificationScheduleRemoved) {
        // Earlier builds seeded a per-minute plugin evaluation on activation.
        // Clear that legacy task once; ordinary data mutations will schedule
        // the next bounded evaluation when there is actually new input.
        this.ctx.storage.sql.exec(
          "DELETE FROM background_tasks WHERE kind = ?",
          PLUGIN_NOTIFICATIONS_TASK,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM data_update_debounce WHERE kind = ?",
          PLUGIN_NOTIFICATIONS_TASK,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO _sql_schema_migrations (id) VALUES (27)",
        );
      }

      // This named, idempotent auth state is intentionally independent of the
      // numeric migration sequence. Delay-list state can safely repair itself
      // even when a later branch has already advanced MAX(id).
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS authorization_failures (
          ip TEXT PRIMARY KEY,
          retry_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS authorization_failures_updated
          ON authorization_failures(updated_at, ip);
      `);
    });
    this.realtime.synchronizeRootDataSnapshot();
  }

  private enterStorageWriteQuotaMode(error: unknown): boolean {
    if (!isEntryStoreWriteQuotaError(error)) return false;
    this.storageWriteQuotaBlockedUntil = durableObjectWriteQuotaResetAt();
    return true;
  }

  private storageWritesBlocked(now = Date.now()): boolean {
    if (this.storageWriteQuotaBlockedUntil > now) return true;
    this.storageWriteQuotaBlockedUntil = 0;
    if (this.storageSchemaInitializationPending) {
      try {
        this.completeStorageInitialization();
      } catch (error) {
        if (!this.enterStorageWriteQuotaMode(error)) throw error;
        return true;
      }
    }
    this.scheduleRealtimeAlarmRecovery();
    return false;
  }

  private scheduleRealtimeAlarmRecovery(): void {
    if (
      !this.realtimeAlarmRecoveryPending
      || this.realtimeAlarmRecoveryScheduled
    ) {
      return;
    }
    this.realtimeAlarmRecoveryScheduled = true;
    this.ctx.waitUntil((async () => {
      try {
        if (this.storageWritesBlocked()) return;
        this.reconcileRealtimeWebSocketSessions();
        await this.synchronizeRealtimeAlarm();
        this.realtimeAlarmRecoveryPending = false;
      } catch (error) {
        if (!this.enterStorageWriteQuotaMode(error)) throw error;
      } finally {
        this.realtimeAlarmRecoveryScheduled = false;
      }
    })());
  }

  private requireStorageWrites(): void {
    if (this.storageWritesBlocked()) throw new DurableObjectWriteQuotaError();
  }

  private async withStorageWrites<T>(
    operation: () => T | Promise<T>,
  ): Promise<T> {
    this.requireStorageWrites();
    try {
      return await operation();
    } catch (error) {
      this.enterStorageWriteQuotaMode(error);
      throw error;
    }
  }

  private storageWriteQuotaResponse(): Response {
    return Response.json(
      { code: 3, message: "Bad request" },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(durableObjectWriteQuotaRetryAfterSeconds()),
        },
      },
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const rawEngineProtocol = url.searchParams.get("EIO");
    if (
      request.method !== "GET" ||
      request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
      (rawEngineProtocol !== "3" && rawEngineProtocol !== "4") ||
      url.searchParams.get("transport") !== "websocket" ||
      url.searchParams.has("j")
    ) {
      return Response.json(
        { code: 3, message: "Bad request" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (this.storageWritesBlocked()) return this.storageWriteQuotaResponse();
    const engineProtocol: RealtimeEngineProtocol = rawEngineProtocol === "3" ? 3 : 4;
    const rawSid = url.searchParams.get("sid");
    const upgradeSid = rawSid === null || rawSid === "" ? null : rawSid;
    if (upgradeSid !== null && !REALTIME_SID.test(upgradeSid)) {
      return Response.json(
        { code: 1, message: "Session ID unknown" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    // Reconcile the bounded SQL session set with Cloudflare's hibernatable
    // socket attachments before enforcing either capacity limit.
    this.reconcileRealtimeWebSocketSessions();
    this.flushRealtimeWebSockets();
    if (
      this.ctx.getWebSockets(REALTIME_WEBSOCKET_TAG).length >=
      REALTIME_MAX_SESSIONS_PER_TENANT
    ) {
      return Response.json(
        { code: 3, message: "Bad request" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (
      upgradeSid !== null &&
      this.ctx.getWebSockets(`${REALTIME_WEBSOCKET_SID_TAG_PREFIX}${upgradeSid}`)
        .some((ws) => ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
    ) {
      return Response.json(
        { code: 3, message: "Bad request" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    let opened: { sid: string; frame: string } | null = null;
    let upgradeStarted = false;
    try {
      let attachment: RealtimeWebSocketAttachment;
      let initialFrame: string | null = null;
      if (upgradeSid === null) {
        opened = this.realtime.createWebSocketHandshake(engineProtocol);
        const now = Date.now();
        attachment = {
          version: REALTIME_WEBSOCKET_ATTACHMENT_VERSION,
          objectId: this.ctx.id.toString(),
          sid: opened.sid,
          mode: "session",
          engineProtocol,
          lastSeenAt: now,
          nextPingAt: engineProtocol === 4 ? now + REALTIME_PING_INTERVAL_MS : null,
          pongDeadline: null,
        };
        initialFrame = opened.frame;
      } else {
        const deadline = this.realtime.beginWebSocketUpgrade(upgradeSid, engineProtocol);
        upgradeStarted = true;
        attachment = {
          version: REALTIME_WEBSOCKET_ATTACHMENT_VERSION,
          objectId: this.ctx.id.toString(),
          sid: upgradeSid,
          mode: "upgrade",
          engineProtocol,
          phase: "opening",
          deadline,
        };
      }
      this.ctx.acceptWebSocket(server, [
        REALTIME_WEBSOCKET_TAG,
        `${REALTIME_WEBSOCKET_SID_TAG_PREFIX}${attachment.sid}`,
      ]);
      server.serializeAttachment(attachment);
      if (initialFrame !== null) server.send(initialFrame);
      this.flushRealtimeWebSockets();
      await this.synchronizeRealtimeAlarm();
      return new Response(null, { status: 101, webSocket: client });
    } catch (error) {
      if (this.enterStorageWriteQuotaMode(error)) {
        this.safeCloseWebSocket(server, 1013, "storage temporarily unavailable");
        return this.storageWriteQuotaResponse();
      }
      if (opened !== null) this.realtime.closeWebSocketSession(opened.sid);
      if (upgradeStarted && upgradeSid !== null) {
        this.realtime.abortWebSocketUpgrade(upgradeSid);
      }
      this.safeCloseWebSocket(server, 1011, "handshake failed");
      try {
        this.flushRealtimeWebSockets();
        await this.synchronizeRealtimeAlarm();
      } catch (cleanupError) {
        if (this.enterStorageWriteQuotaMode(cleanupError)) {
          return this.storageWriteQuotaResponse();
        }
        throw cleanupError;
      }
      if (error instanceof RealtimeSessionError && error.code === "unknown_sid") {
        return Response.json(
          { code: 1, message: "Session ID unknown" },
          { status: 400, headers: { "Cache-Control": "no-store" } },
        );
      }
      if (error instanceof RealtimeSessionError && error.code === "capacity") {
        return Response.json(
          { code: 3, message: "Bad request" },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }
      throw error;
    }
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    let attachment = this.realtimeWebSocketAttachment(ws);
    if (
      attachment !== null &&
      typeof message === "string" &&
      this.handleRealtimeWebSocketHeartbeat(ws, attachment, message)
    ) {
      // Heartbeats are attachment-only and must remain available while an
      // application frame is awaiting authorization, or while SQLite writes
      // are temporarily quota-blocked. Only the derived Alarm deadline needs
      // persistence when storage is available again.
      if (this.storageWritesBlocked()) {
        this.realtimeAlarmRecoveryPending = true;
        return;
      }
      try {
        await this.synchronizeRealtimeAlarm();
      } catch (error) {
        if (!this.enterStorageWriteQuotaMode(error)) throw error;
        this.realtimeAlarmRecoveryPending = true;
      }
      return;
    }
    if (this.storageWritesBlocked()) {
      this.safeCloseWebSocket(ws, 1013, "storage temporarily unavailable");
      return;
    }
    if (attachment === null) {
      try {
        this.closeInvalidRealtimeWebSocket(ws);
        this.flushRealtimeWebSockets();
        await this.synchronizeRealtimeAlarm();
      } catch (error) {
        if (!this.enterStorageWriteQuotaMode(error)) throw error;
        this.safeCloseWebSocket(ws, 1013, "storage temporarily unavailable");
      }
      return;
    }
    if (this.activeWebSocketSessions.has(attachment.sid)) {
      try {
        if (attachment.mode === "upgrade") {
          this.realtime.abortWebSocketUpgrade(attachment.sid);
        } else {
          this.realtime.closeWebSocketSession(attachment.sid);
        }
        this.safeCloseWebSocket(ws, 1008, "concurrent frame");
        this.flushRealtimeWebSockets();
        await this.synchronizeRealtimeAlarm();
      } catch (error) {
        if (!this.enterStorageWriteQuotaMode(error)) throw error;
        this.safeCloseWebSocket(ws, 1013, "storage temporarily unavailable");
      }
      return;
    }

    this.activeWebSocketSessions.add(attachment.sid);
    try {
      if (typeof message !== "string") {
        if (attachment.mode === "upgrade") {
          this.realtime.abortWebSocketUpgrade(attachment.sid);
        } else {
          this.realtime.closeWebSocketSession(attachment.sid);
        }
        this.safeCloseWebSocket(ws, 1003, "binary packets unsupported");
        return;
      }
      if (attachment.mode === "upgrade") {
        if ((attachment.deadline ?? 0) <= Date.now()) {
          throw new RealtimeSessionError("bad_packet", "websocket upgrade timed out");
        }
        if (attachment.phase === "opening") {
          if (message !== "2probe") {
            throw new RealtimeSessionError("bad_packet", "expected websocket probe ping");
          }
          this.realtime.probeWebSocketUpgrade(attachment.sid);
          attachment = { ...attachment, phase: "probed" };
          ws.serializeAttachment(attachment);
          ws.send("3probe");
          return;
        }
        if (attachment.phase !== "probed" || message !== "5") {
          throw new RealtimeSessionError("bad_packet", "expected websocket upgrade packet");
        }
        this.realtime.completeWebSocketUpgrade(attachment.sid);
        const now = Date.now();
        attachment = {
          version: REALTIME_WEBSOCKET_ATTACHMENT_VERSION,
          objectId: this.ctx.id.toString(),
          sid: attachment.sid,
          mode: "session",
          engineProtocol: attachment.engineProtocol,
          lastSeenAt: now,
          nextPingAt: attachment.engineProtocol === 4
            ? now + REALTIME_PING_INTERVAL_MS
            : null,
          pongDeadline: null,
        };
        ws.serializeAttachment(attachment);
        return;
      }
      const now = Date.now();
      const frameBytes = realtimeJsonEncoder.encode(message).byteLength;
      if (frameBytes > REALTIME_MAX_PAYLOAD_BYTES) {
        throw new RealtimeSessionError("bad_packet", "websocket packet too_large");
      }
      attachment = {
        ...attachment,
        lastSeenAt: now,
      };
      ws.serializeAttachment(attachment);
      const result = await this.realtime.submitWebSocketFrame(attachment.sid, message);
      if (result.closed) this.safeCloseWebSocket(ws, 1000, "transport close");
    } catch (error) {
      if (this.enterStorageWriteQuotaMode(error)) {
        this.safeCloseWebSocket(ws, 1013, "storage temporarily unavailable");
        return;
      }
      try {
        if (attachment.mode === "upgrade") {
          this.realtime.abortWebSocketUpgrade(attachment.sid);
        } else {
          this.realtime.closeWebSocketSession(attachment.sid);
        }
      } catch (cleanupError) {
        if (!this.enterStorageWriteQuotaMode(cleanupError)) throw cleanupError;
        this.safeCloseWebSocket(ws, 1013, "storage temporarily unavailable");
        return;
      }
      const oversized =
        error instanceof RealtimeSessionError &&
        error.code === "bad_packet" &&
        error.message.includes("too_large");
      const unavailable =
        error instanceof RealtimeSessionError && error.code === "unknown_sid";
      this.safeCloseWebSocket(
        ws,
        oversized ? 1009 : unavailable ? 1008 : 1002,
        oversized ? "packet too large" : unavailable ? "session unavailable" : "bad packet",
      );
    } finally {
      this.activeWebSocketSessions.delete(attachment.sid);
      if (!this.storageWritesBlocked()) {
        try {
          this.flushRealtimeWebSockets();
          await this.synchronizeRealtimeAlarm();
        } catch (error) {
          if (!this.enterStorageWriteQuotaMode(error)) throw error;
          this.safeCloseWebSocket(ws, 1013, "storage temporarily unavailable");
        }
      }
    }
  }

  private handleRealtimeWebSocketHeartbeat(
    ws: WebSocket,
    attachment: RealtimeWebSocketAttachment,
    message: string,
  ): boolean {
    if (
      attachment.mode !== "session" ||
      realtimeJsonEncoder.encode(message).byteLength > REALTIME_MAX_PAYLOAD_BYTES
    ) {
      return false;
    }
    const eio4Pong = attachment.engineProtocol === 4 && message.startsWith("3");
    const eio3Ping = attachment.engineProtocol === 3 && message.startsWith("2");
    if (!eio4Pong && !eio3Ping) return false;
    const now = Date.now();
    ws.serializeAttachment({
      ...attachment,
      lastSeenAt: now,
      nextPingAt: eio4Pong
        ? this.nextRealtimeWebSocketPingAfterPong(attachment, now)
        : null,
      pongDeadline: null,
    } satisfies RealtimeWebSocketAttachment);
    if (eio3Ping) ws.send("3");
    return true;
  }

  /**
   * Preserve the server-ping phase rather than scheduling from the arrival
   * time of each pong. All sockets pinged in one alarm share one exact
   * pongDeadline, so this also gives them one exact nextPingAt.
   */
  private nextRealtimeWebSocketPingAfterPong(
    attachment: RealtimeWebSocketAttachment,
    now: number,
  ): number {
    if (
      attachment.pongDeadline !== null &&
      attachment.pongDeadline !== undefined
    ) {
      const phase = attachment.pongDeadline +
        REALTIME_PING_INTERVAL_MS -
        REALTIME_PING_TIMEOUT_MS;
      if (phase > now) return phase;
      return phase +
        (Math.floor((now - phase) / REALTIME_PING_INTERVAL_MS) + 1) *
          REALTIME_PING_INTERVAL_MS;
    }
    return now + REALTIME_PING_INTERVAL_MS;
  }

  override async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    if (this.storageWritesBlocked()) {
      this.safeCloseWebSocket(ws, 1013, "storage temporarily unavailable");
      return;
    }
    const attachment = this.realtimeWebSocketAttachment(ws);
    try {
      if (attachment?.mode === "upgrade") {
        this.realtime.abortWebSocketUpgrade(attachment.sid);
      } else if (attachment !== null) {
        this.realtime.closeWebSocketSession(attachment.sid);
      } else {
        this.closeInvalidRealtimeWebSocket(ws);
      }
      this.flushRealtimeWebSockets();
      await this.synchronizeRealtimeAlarm();
    } catch (error) {
      if (!this.enterStorageWriteQuotaMode(error)) throw error;
      this.safeCloseWebSocket(ws, 1013, "storage temporarily unavailable");
    }
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    if (this.storageWritesBlocked()) {
      this.safeCloseWebSocket(ws, 1013, "storage temporarily unavailable");
      return;
    }
    const attachment = this.realtimeWebSocketAttachment(ws);
    try {
      if (attachment?.mode === "upgrade") {
        this.realtime.abortWebSocketUpgrade(attachment.sid);
      } else if (attachment !== null) {
        this.realtime.closeWebSocketSession(attachment.sid);
      } else {
        this.closeInvalidRealtimeWebSocket(ws);
      }
      console.error(JSON.stringify({ message: "realtime websocket transport error" }));
      this.safeCloseWebSocket(ws, 1011, "transport error");
      this.flushRealtimeWebSockets();
      await this.synchronizeRealtimeAlarm();
    } catch (error) {
      if (!this.enterStorageWriteQuotaMode(error)) throw error;
      this.safeCloseWebSocket(ws, 1013, "storage temporarily unavailable");
    }
  }

  private trustedRealtimeWebSocketSid(ws: WebSocket): string | null {
    let tags: string[];
    try {
      tags = this.ctx.getTags(ws);
    } catch {
      return null;
    }
    const sidTags = tags.filter((tag) => tag.startsWith(REALTIME_WEBSOCKET_SID_TAG_PREFIX));
    if (sidTags.length !== 1) return null;
    const sid = sidTags[0]!.slice(REALTIME_WEBSOCKET_SID_TAG_PREFIX.length);
    return REALTIME_SID.test(sid) ? sid : null;
  }

  private realtimeWebSocketAttachment(
    ws: WebSocket,
  ): RealtimeWebSocketAttachment | null {
    let attachment: unknown;
    try {
      attachment = ws.deserializeAttachment();
    } catch {
      return null;
    }
    if (typeof attachment !== "object" || attachment === null || Array.isArray(attachment)) {
      return null;
    }
    const value = attachment as Record<string, unknown>;
    const trustedSid = this.trustedRealtimeWebSocketSid(ws);
    if (
      (value.version !== 1 && value.version !== REALTIME_WEBSOCKET_ATTACHMENT_VERSION) ||
      value.objectId !== this.ctx.id.toString() ||
      typeof value.sid !== "string" ||
      value.sid !== trustedSid ||
      !REALTIME_SID.test(value.sid)
    ) {
      return null;
    }
    const engineProtocol = value.version === REALTIME_WEBSOCKET_ATTACHMENT_VERSION
      ? value.engineProtocol === 3 || value.engineProtocol === 4
        ? value.engineProtocol
        : null
      : this.realtime.sessionEngineProtocol(value.sid);
    if (engineProtocol === null) return null;
    const mode = value.mode === undefined || value.mode === "session"
      ? "session"
      : value.mode === "upgrade"
        ? "upgrade"
        : null;
    if (mode === null) return null;
    if (
      mode === "upgrade" &&
      (
        (value.phase !== "opening" && value.phase !== "probed") ||
        typeof value.deadline !== "number" ||
        !Number.isSafeInteger(value.deadline) ||
        value.deadline <= 0
      )
    ) {
      return null;
    }
    const now = Date.now();
    const sessionTimesValid =
      typeof value.lastSeenAt === "number" &&
      Number.isSafeInteger(value.lastSeenAt) &&
      value.lastSeenAt > 0 &&
      (value.nextPingAt === null ||
        (
          typeof value.nextPingAt === "number" &&
          Number.isSafeInteger(value.nextPingAt) &&
          value.nextPingAt > 0
        )) &&
      (value.pongDeadline === null ||
        (
          typeof value.pongDeadline === "number" &&
          Number.isSafeInteger(value.pongDeadline) &&
          value.pongDeadline > 0
        ));
    if (
      mode === "session" &&
      value.version === REALTIME_WEBSOCKET_ATTACHMENT_VERSION &&
      !sessionTimesValid
    ) {
      return null;
    }
    const normalized: RealtimeWebSocketAttachment = {
      version: REALTIME_WEBSOCKET_ATTACHMENT_VERSION,
      objectId: value.objectId,
      sid: value.sid,
      mode,
      engineProtocol,
      ...(mode === "upgrade"
        ? {
            phase: value.phase as "opening" | "probed",
            deadline: value.deadline as number,
          }
        : {
            lastSeenAt: sessionTimesValid ? value.lastSeenAt as number : now,
            nextPingAt: sessionTimesValid
              ? value.nextPingAt as number | null
              : engineProtocol === 4
                ? now + REALTIME_PING_INTERVAL_MS
                : null,
            pongDeadline: sessionTimesValid
              ? value.pongDeadline as number | null
              : null,
          }),
    };
    if (value.version !== REALTIME_WEBSOCKET_ATTACHMENT_VERSION) {
      ws.serializeAttachment(normalized);
    }
    return normalized;
  }

  private closeInvalidRealtimeWebSocket(ws: WebSocket): void {
    const sid = this.trustedRealtimeWebSocketSid(ws);
    if (sid !== null) {
      this.realtime.closeWebSocketSession(sid);
      // A live WebSocket session deletion, or an already-persisted teardown
      // from a previous deployment, owns physical close retry/backoff.
      if (this.realtime.webSocketClosureDeadline(sid) !== null) return;
    }
    const result = this.safeCloseWebSocket(ws, 1008, "invalid session attachment");
    if (result === "failed" && sid !== null) {
      this.realtime.deferWebSocketClosure(
        sid,
        1008,
        "invalid session attachment",
      );
    }
  }

  private reconcileRealtimeWebSocketSessions(): void {
    const socketsBySid = new Map<string, WebSocket[]>();
    for (const ws of this.ctx.getWebSockets(REALTIME_WEBSOCKET_TAG)) {
      if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
        continue;
      }
      const sid = this.trustedRealtimeWebSocketSid(ws);
      if (sid === null) {
        this.safeCloseWebSocket(ws, 1008, "invalid session attachment");
        continue;
      }
      const sockets = socketsBySid.get(sid) ?? [];
      sockets.push(ws);
      socketsBySid.set(sid, sockets);
    }

    const liveSids = new Set<string>();
    for (const [sid, sockets] of socketsBySid) {
      if (sockets.length !== 1) {
        for (const ws of sockets) this.closeInvalidRealtimeWebSocket(ws);
        continue;
      }
      const ws = sockets[0]!;
      const attachment = this.realtimeWebSocketAttachment(ws);
      if (attachment === null) {
        this.closeInvalidRealtimeWebSocket(ws);
        continue;
      }
      if (attachment.mode === "upgrade") continue;
      if (
        this.realtime.webSocketSessionEngineProtocol(sid) !==
          attachment.engineProtocol
      ) {
        this.closeInvalidRealtimeWebSocket(ws);
        continue;
      }
      liveSids.add(sid);
    }
    this.realtime.reconcileWebSocketSessions(liveSids);
  }

  private safeCloseWebSocket(
    ws: WebSocket,
    code: number,
    reason: string,
  ): RealtimeWebSocketCloseResult {
    if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
      return "inactive";
    }
    try {
      ws.close(code, reason);
      return "closed";
    } catch {
      // Transport teardown is best-effort after durable session cleanup.
      return "failed";
    }
  }

  private flushRealtimeWebSockets(): void {
    if (this.storageWritesBlocked()) return;
    const now = Date.now();
    let remainingSockets = REALTIME_WEBSOCKET_FLUSH_MAX_SOCKETS;
    let remainingFrames = REALTIME_WEBSOCKET_FLUSH_MAX_FRAMES;
    let remainingBytes = REALTIME_WEBSOCKET_FLUSH_MAX_BYTES;
    let remainingClosureRows = REALTIME_WEBSOCKET_FLUSH_MAX_SOCKETS;

    // Take one tombstone at a time. A corrupt duplicate SID tag may map one
    // durable closure to many physical sockets, so bulk-taking rows before an
    // early budget return could otherwise lose unprocessed tombstones.
    while (remainingSockets > 0 && remainingClosureRows > 0) {
      const closure = this.realtime.takeWebSocketClosures(1, now)[0];
      if (closure === undefined) break;
      remainingClosureRows -= 1;
      const sockets = this.ctx.getWebSockets(
        `${REALTIME_WEBSOCKET_SID_TAG_PREFIX}${closure.sid}`,
      );
      const activeSockets = sockets.filter((ws) =>
        ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING
      );
      const socketOffset = activeSockets.length === 0
        ? 0
        : closure.socketOffset % activeSockets.length;
      const rotatedSockets = socketOffset === 0
        ? activeSockets
        : activeSockets.slice(socketOffset).concat(activeSockets.slice(0, socketOffset));
      const selectedSockets = rotatedSockets.slice(0, remainingSockets);
      const nextSocketOffset = activeSockets.length === 0
        ? 0
        : (socketOffset + selectedSockets.length) % activeSockets.length;
      let closeFailed = false;
      for (const ws of selectedSockets) {
        const result = this.safeCloseWebSocket(ws, closure.code, closure.reason);
        if (result === "inactive") continue;
        remainingSockets -= 1;
        if (result === "failed") closeFailed = true;
      }
      const budgetDeferred = activeSockets.length > selectedSockets.length;
      if (budgetDeferred || closeFailed) {
        this.realtime.requeueWebSocketClosure(
          closure,
          { budgetDeferred, closeFailed, nextSocketOffset },
          now,
        );
      }
    }
    if (remainingSockets === 0) return;

    const queuedSids = this.realtime.queuedWebSocketSessionIds(
      remainingSockets,
    );

    for (const sid of queuedSids) {
      const sockets = this.ctx.getWebSockets(
        `${REALTIME_WEBSOCKET_SID_TAG_PREFIX}${sid}`,
      );
      if (sockets.length !== 1) {
        this.realtime.closeWebSocketSession(sid);
        for (const socket of sockets) {
          if (remainingSockets === 0) break;
          const result = this.safeCloseWebSocket(
            socket,
            1008,
            "ambiguous session attachment",
          );
          if (result === "inactive") continue;
          remainingSockets -= 1;
        }
        if (remainingSockets === 0) return;
        continue;
      }

      const ws = sockets[0]!;
      remainingSockets -= 1;
      const attachment = this.realtimeWebSocketAttachment(ws);
      if (attachment === null || attachment.sid !== sid || attachment.mode !== "session") {
        this.closeInvalidRealtimeWebSocket(ws);
        continue;
      }
      try {
        const batch = this.realtime.peekWebSocketFrames(
          sid,
          remainingFrames,
          remainingBytes,
        );
        if (batch === null) break;
        for (const frame of batch.frames) {
          const frameBytes = realtimeJsonEncoder.encode(frame).byteLength;
          if (frameBytes > remainingBytes || remainingFrames === 0) {
            throw new Error("websocket flush budget invariant failed");
          }
          ws.send(frame);
          remainingBytes -= frameBytes;
          remainingFrames -= 1;
        }
        // WebSocket.send() cannot participate in a SQLite transaction. Keep
        // the FIFO prefix durable until every synchronous send succeeds, then
        // acknowledge it in one transaction. A crash after send but before
        // this acknowledgement may replay a frame, but cannot silently lose
        // the only durable copy before delivery.
        this.realtime.acknowledgeWebSocketFrames(sid, batch);
      } catch {
        this.realtime.closeWebSocketSession(sid);
        this.safeCloseWebSocket(ws, 1011, "outbound queue failure");
      }
      if (remainingSockets === 0 || remainingFrames === 0 || remainingBytes === 0) break;
    }
  }

  private documentRepository(): SqliteDocumentRepository {
    return new SqliteDocumentRepository(
      this.ctx.storage,
      (event) => {
        if (event.collection === "entries") this.realtimeEntryQueries.clear();
        if (event.collection === "devicestatus" && !this.deviceStatusCacheMutation) {
          this.realtimeDeviceStatusQueries.clear();
        }
        try {
          this.realtime.recordApi3StorageMutationInTransaction(event);
        } finally {
          // A snapshot may have read uncommitted entries. Do not let those
          // values survive a later rollback of the caller's transaction.
          if (event.collection === "entries") this.realtimeEntryQueries.clear();
          if (event.collection === "devicestatus" && !this.deviceStatusCacheMutation) {
            this.realtimeDeviceStatusQueries.clear();
          }
        }
      },
      (collection, document) => {
        if (collection === "devicestatus") {
          this.updateDeviceStatusQueryCache(document);
        }
        this.recordDataMutationInTransaction(collection);
      },
    );
  }

  private updateDeviceStatusQueryCache(document?: JsonDocument): void {
    if (!this.deviceStatusCacheMutation || document === undefined) {
      this.realtimeDeviceStatusQueries.clear();
      return;
    }
    if (!this.realtimeDeviceStatusQueries.ready) return;
    // Read canonical storage metadata, including updated_at, instead of
    // guessing ordering from the public API3 document's timestamps.
    const identity = document.identifier;
    if (typeof identity !== "string") {
      this.realtimeDeviceStatusQueries.clear();
      return;
    }
    const rows = this.ctx.storage.sql.exec<DbDocument>(
      `SELECT id, body, sort_time, updated_at FROM documents
       WHERE collection = 'devicestatus' AND identifier = ? LIMIT 2`, identity,
    ).toArray();
    if (rows.length !== 1) this.realtimeDeviceStatusQueries.clear();
    else this.realtimeDeviceStatusQueries.upsert(rows[0]!);
  }

  private withDeviceStatusCacheMutation<T>(collection: string, operation: () => T): T {
    if (collection !== "devicestatus") return operation();
    // Repository operations are synchronous and own their SQLite transaction.
    // Only publish the fork after that transaction returns successfully.
    const committed = this.realtimeDeviceStatusQueries;
    this.realtimeDeviceStatusQueries = committed.fork();
    this.deviceStatusCacheMutation = true;
    try {
      return operation();
    } catch (error) {
      this.realtimeDeviceStatusQueries = committed;
      throw error;
    } finally {
      this.deviceStatusCacheMutation = false;
    }
  }

  private backgroundTasks(): SqliteBackgroundTaskRepository {
    return new SqliteBackgroundTaskRepository(this.ctx.storage);
  }

  private dataUpdateDebounce(): SqliteDataUpdateDebounceRepository {
    return new SqliteDataUpdateDebounceRepository(this.ctx.storage);
  }

  private adminNotifies(): SqliteAdminNotifyRepository {
    return new SqliteAdminNotifyRepository(this.ctx.storage);
  }

  private pushNotificationState(): SqlitePushNotificationStateStore {
    return new SqlitePushNotificationStateStore(this.ctx.storage);
  }

  private adminNotifiesEnabled(now: number): boolean {
    const status = nightscoutStatus(
      new Date(now),
      this.env.AUTH_DEFAULT_ROLES ?? "readable",
      this.tenantStatusSettings(),
    );
    return recordValue(status.settings).adminNotifiesEnabled !== false;
  }

  private reconcileAdminNotifies(now: number): void {
    if (this.storageWritesBlocked()) return;
    this.adminNotifies().reconcileReadableSite(
      (this.env.AUTH_DEFAULT_ROLES ?? "readable") === "readable",
      this.adminNotifiesEnabled(now),
      now,
    );
  }

  listAdminNotifications(now = Date.now()): string {
    const timestamp = Number.isFinite(now) ? Math.trunc(now) : Date.now();
    this.reconcileAdminNotifies(timestamp);
    return JSON.stringify(
      this.adminNotifies().listForApi(timestamp, !this.storageWritesBlocked()),
    );
  }

  private xdripStateNotification(): XdripJsStateNotification | null {
    const row = this.ctx.storage.sql.exec<DbPluginRuntimeState>(
      "SELECT body, updated_at FROM plugin_runtime_state WHERE plugin = 'xdripjs' LIMIT 1",
    ).toArray()[0];
    if (row === undefined) return null;
    try {
      const parsed: unknown = JSON.parse(row.body);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
      const record = parsed as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, "state")) return null;
      const timestamp = Number(record.timestamp);
      if (!Number.isSafeInteger(timestamp)) return null;
      return { state: record.state, timestamp };
    } catch {
      return null;
    }
  }

  private persistXdripStateNotification(state: XdripJsStateNotification): void {
    const timestamp = Number(state.timestamp);
    if (!Number.isSafeInteger(timestamp)) return;
    let normalizedState = state.state === undefined ? null : state.state;
    let body: string;
    try {
      body = JSON.stringify({ state: normalizedState, timestamp });
    } catch {
      normalizedState = String(state.state).slice(0, 256);
      body = JSON.stringify({ state: normalizedState, timestamp });
    }
    if (body.length > 1_024) {
      normalizedState = String(state.state).slice(0, 256);
      body = JSON.stringify({ state: normalizedState, timestamp });
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO plugin_runtime_state (plugin, body, updated_at)
       VALUES ('xdripjs', ?, ?)
       ON CONFLICT(plugin) DO UPDATE SET
         body = excluded.body,
         updated_at = excluded.updated_at`,
      body,
      timestamp,
    );
  }

  private resolvedAutomaticNotificationRuntime(now: number): AutomaticNotificationRuntime {
    const status = nightscoutStatus(
      new Date(now),
      this.env.AUTH_DEFAULT_ROLES ?? "readable",
      this.tenantStatusSettings(),
    );
    const settings = recordValue(status.settings);
    const extendedSettings = recordValue(status.extendedSettings);
    const enabled = new Set(
      Array.isArray(settings.enable)
        ? settings.enable.filter((feature): feature is string => typeof feature === "string")
        : [],
    );
    const timeAgoPreferences = recordValue(extendedSettings.timeago);
    const upbatPreferences = recordValue(extendedSettings.upbat);
    const pumpPreferences = recordValue(extendedSettings.pump);
    const openApsPreferences = recordValue(extendedSettings.openaps);
    const loopPreferences = recordValue(extendedSettings.loop);
    const xdripPreferences = recordValue(extendedSettings.xdripjs);
    const cagePreferences = recordValue(extendedSettings.cage);
    const sagePreferences = recordValue(extendedSettings.sage);
    const iagePreferences = recordValue(extendedSettings.iage);
    const bagePreferences = recordValue(extendedSettings.bage);
    const dbSizePreferences = recordValue(extendedSettings.dbsize);
    return {
      settings,
      extendedSettings,
      enabled,
      upbat: enabled.has("upbat") && Boolean(upbatPreferences.enableAlerts),
      ar2: enabled.has("ar2"),
      simpleAlarms: enabled.has("simplealarms"),
      errorCodes: enabled.has("errorcodes"),
      xdripJs: enabled.has("xdripjs") && Boolean(xdripPreferences.enableAlerts),
      pump: enabled.has("pump") && Boolean(pumpPreferences.enableAlerts),
      openAps: enabled.has("openaps") && Boolean(openApsPreferences.enableAlerts),
      loop: enabled.has("loop") && Boolean(loopPreferences.enableAlerts),
      bwp: enabled.has("bwp"),
      cage: enabled.has("cage") && Boolean(cagePreferences.enableAlerts),
      sage: enabled.has("sage") && Boolean(sagePreferences.enableAlerts),
      iage: enabled.has("iage") && Boolean(iagePreferences.enableAlerts),
      bage: enabled.has("bage") && Boolean(bagePreferences.enableAlerts),
      treatmentNotify: enabled.has("treatmentnotify"),
      timeAgo: enabled.has("timeago") && Boolean(timeAgoPreferences.enableAlerts),
      dbSize: enabled.has("dbsize") && Boolean(dbSizePreferences.enableAlerts),
    };
  }

  private notificationHeartbeatMs(settings: Record<string, unknown>): number {
    const configured = Number(settings.heartbeat);
    const seconds = Number.isFinite(configured) && configured > 0 ? configured : 60;
    // A zero/negative or extremely small Node interval can monopolize a Free
    // Worker. Preserve ordinary upstream values while making that platform
    // boundary explicit and bounded.
    return Math.trunc(Math.max(
      MIN_NOTIFICATION_HEARTBEAT_SECONDS,
      Math.min(MAX_NOTIFICATION_HEARTBEAT_SECONDS, seconds),
    ) * 1_000);
  }

  private recordDataMutationInTransaction(collection: string): void {
    if (collection === "entries") this.realtimeEntryQueries.clear();
    const tasks = this.backgroundTasks();
    const now = Date.now();
    const runtime = this.resolvedAutomaticNotificationRuntime(now);
    const anyEnabled = runtime.upbat || runtime.ar2 || runtime.simpleAlarms || runtime.errorCodes
      || runtime.pump || runtime.openAps || runtime.xdripJs
      || runtime.loop || runtime.bwp || runtime.cage || runtime.sage || runtime.iage
      || runtime.bage
      || runtime.treatmentNotify || runtime.timeAgo || runtime.dbSize;
    const inputChanged = runtime.dbSize || (collection === "profile"
      ? anyEnabled
      : collection === "entries"
        ? runtime.ar2 || runtime.simpleAlarms || runtime.errorCodes || runtime.bwp
          || runtime.treatmentNotify || runtime.timeAgo
        : collection === "treatments"
          ? runtime.bwp || runtime.treatmentNotify || runtime.pump || runtime.openAps
            || runtime.cage || runtime.sage || runtime.iage || runtime.bage
          : collection === "devicestatus"
            && (runtime.upbat || runtime.bwp || runtime.pump || runtime.openAps
              || runtime.xdripJs || runtime.loop));
    if (!inputChanged) return;
    if (this.dataUpdateDebounce().record(PLUGIN_NOTIFICATIONS_TASK, now)) {
      tasks.schedule(PLUGIN_NOTIFICATIONS_TASK, now, now);
    }
  }

  private latestSgvAtOrBefore(
    sgvs: RealtimeDocument[],
    now: number,
  ): RealtimeDocument | null {
    for (let index = sgvs.length - 1; index >= 0; index -= 1) {
      const entry = sgvs[index];
      if (entry !== undefined && Number(entry.mills) <= now) return entry;
    }
    return null;
  }

  private earliestFutureEntryAt(
    entries: RealtimeDocument[],
    now: number,
  ): number | null {
    let earliest: number | null = null;
    for (const entry of entries) {
      const mills = Number(entry.mills);
      if (!Number.isFinite(mills) || mills <= now) continue;
      earliest = earliest === null ? mills : Math.min(earliest, mills);
    }
    return earliest;
  }

  private automaticNotificationData(
    now: number,
    runtime: AutomaticNotificationRuntime,
  ): AutomaticNotificationData {
    const result: AutomaticNotificationData = {
      sgvs: [],
      mbgs: [],
      devicestatus: [],
      profiles: [],
      treatments: [],
      ageTreatments: [],
      dbstats: sqliteNightscoutDatabaseStats(this.ctx.storage.sql.databaseSize),
    };
    const budget = new RealtimeJsonBudget(result);
    if (runtime.ar2 || runtime.simpleAlarms || runtime.errorCodes || runtime.timeAgo) {
      for (const row of this.ctx.storage.sql.exec<DbDocument>(
        `SELECT id, body, sort_time
         FROM documents
         WHERE collection = 'entries'
           AND sort_time >= ?
           AND ${realtimeNumericMeasurementSql("$.sgv")}
           AND NOT ${realtimeJsonTruthySql("$.mbg")}
         ORDER BY sort_time DESC, id ASC
         LIMIT 64`,
        now - REALTIME_ENTRY_WINDOW_MS,
      )) {
        const entry = toPublicEntry(toDocument(row));
        const raw = entry as PublicEntry & Record<string, unknown>;
        if (raw.mbg) continue;
        const mgdl = realtimeMeasurement(raw.sgv);
        if (mgdl === null) continue;
        const sgv = {
          _id: entry._id,
          mgdl,
          mills: entry.date,
          device: entry.device,
          direction: entry.direction,
          filtered: raw.filtered,
          unfiltered: raw.unfiltered,
          noise: raw.noise,
          rssi: raw.rssi,
          type: "sgv",
        };
        if (!budget.reserveArrayItem(sgv, result.sgvs.length)) break;
        result.sgvs.push(sgv);
      }
      result.sgvs.reverse();
    }

    if (runtime.treatmentNotify) {
      for (const row of this.ctx.storage.sql.exec<DbDocument>(
        `SELECT id, body, sort_time
         FROM documents
         WHERE collection = 'entries'
           AND sort_time >= ?
           AND ${realtimeNumericMeasurementSql("$.mbg")}
         ORDER BY sort_time DESC, id ASC
         LIMIT 10`,
        now - REALTIME_ENTRY_WINDOW_MS,
      )) {
        const entry = toPublicEntry(toDocument(row));
        const raw = entry as PublicEntry & Record<string, unknown>;
        const mgdl = realtimeMeasurement(raw.mbg);
        if (mgdl === null) continue;
        const mbg = {
          _id: entry._id,
          mgdl,
          mills: entry.date,
          device: entry.device,
          type: "mbg",
        };
        if (!budget.reserveArrayItem(mbg, result.mbgs.length)) break;
        result.mbgs.push(mbg);
      }
      result.mbgs.reverse();
    }

    if (runtime.upbat || runtime.pump || runtime.openAps || runtime.xdripJs || runtime.loop) {
      const enabledFields = [
        runtime.upbat
          ? "(json_type(body, '$.uploader') IS NOT NULL OR json_type(body, '$.uploaderBattery') IS NOT NULL)"
          : null,
        runtime.pump ? "json_type(body, '$.pump') IS NOT NULL" : null,
        runtime.openAps ? "json_type(body, '$.openaps') IS NOT NULL" : null,
        runtime.xdripJs ? "json_type(body, '$.xdripjs') IS NOT NULL" : null,
        runtime.loop ? "json_type(body, '$.loop') IS NOT NULL" : null,
      ].filter((predicate): predicate is string => predicate !== null).join(" OR ");
      const safeFields = `CASE WHEN json_valid(body) THEN (${enabledFields}) ELSE 0 END`;
      result.devicestatus = this.realtimeDocuments(
        `SELECT id, body, sort_time
         FROM documents
         WHERE collection = 'devicestatus'
           AND sort_time >= ?
           AND sort_time <= ?
           AND ${safeFields}
         ORDER BY sort_time DESC, updated_at DESC, id ASC
         LIMIT 1000`,
        [now - REALTIME_DEVICE_STATUS_WINDOW_MS, now],
        budget,
        normalizeRealtimeDeviceStatus,
      );
      const future = this.realtimeDocuments(
        `SELECT id, body, sort_time
         FROM documents
         WHERE collection = 'devicestatus'
           AND sort_time > ?
           AND ${safeFields}
         ORDER BY sort_time ASC, updated_at DESC, id ASC
         LIMIT 1`,
        [now],
        budget,
        normalizeRealtimeDeviceStatus,
      );
      result.devicestatus.push(...future);
    }

    if (runtime.pump) {
      result.profiles = this.realtimeDocuments(
        `SELECT id, body, sort_time
         FROM documents
         WHERE collection = 'profile'
         ORDER BY ${PROFILE_CURRENT_ORDER_BY}
         LIMIT 1`,
        [],
        budget,
        normalizeRealtimeDocument,
      );
    }

    if (runtime.treatmentNotify || runtime.pump || runtime.openAps) {
      result.treatments = this.realtimeDocuments(
        `SELECT id, body, sort_time
         FROM (
           SELECT id, body, sort_time, updated_at
           FROM documents
           WHERE collection = 'treatments'
             AND sort_time >= ?
           ORDER BY sort_time DESC, updated_at DESC, id ASC
           LIMIT 1000
         )
         ORDER BY sort_time ASC, id ASC`,
        [now - RUNTIME_TREATMENT_WINDOW_MS],
        budget,
        normalizeRealtimeDocument,
      );
    }

    if (runtime.cage || runtime.sage || runtime.iage || runtime.bage) {
      const eventTypes = [
        ...(runtime.cage ? ["Site Change"] : []),
        ...(runtime.sage ? ["Sensor Start", "Sensor Change"] : []),
        ...(runtime.iage ? ["Insulin Change"] : []),
        ...(runtime.bage ? ["Pump Battery Change"] : []),
      ];
      for (const eventType of eventTypes) {
        result.ageTreatments.push(...this.realtimeDocuments(
          `SELECT id, body, sort_time
           FROM documents
           WHERE collection = 'treatments'
             AND json_extract(body, '$.eventType') = ?
             AND sort_time >= ?
             AND sort_time <= ?
           ORDER BY sort_time DESC, updated_at DESC, id ASC
           LIMIT 1`,
          [eventType, now - AGE_TREATMENT_WINDOW_MS, now],
          budget,
          normalizeRealtimeDocument,
        ));
        result.ageTreatments.push(...this.realtimeDocuments(
          `SELECT id, body, sort_time
           FROM documents
           WHERE collection = 'treatments'
             AND json_extract(body, '$.eventType') = ?
             AND sort_time > ?
           ORDER BY sort_time ASC, updated_at DESC, id ASC
           LIMIT 1`,
          [eventType, now],
          budget,
          normalizeRealtimeDocument,
        ));
      }
      result.ageTreatments.sort((left, right) => Number(left.mills) - Number(right.mills));
    }
    return result;
  }

  private automaticPluginNotificationEvaluation(
    now: number,
    runtime = this.resolvedAutomaticNotificationRuntime(now),
  ): AutomaticNotificationEvaluation {
    const notifications: RealtimeDocument[] = [];
    const snoozes: RealtimeDocument[] = [];
    let xdripStateNotification = this.xdripStateNotification();
    let xdripStateNotificationChanged = false;
    let nextDueAt: number | null = null;
    const schedule = (deadline: number | null): void => {
      if (deadline === null || !Number.isFinite(deadline)) return;
      const normalized = Math.max(now, Math.trunc(deadline));
      nextDueAt = nextDueAt === null ? normalized : Math.min(nextDueAt, normalized);
    };
    const heartbeatMs = this.notificationHeartbeatMs(runtime.settings);
    const data = this.automaticNotificationData(now, runtime);
    const bwpContext = runtime.bwp ? this.pluginPropertyContext(now) : null;
    const bwpProperties = bwpContext === null
      ? {}
      : calculatePluginProperties(
        bwpContext,
        runtime.settings.units === "mmol" ? "mmol" : "mg/dl",
        now,
        runtime.enabled,
        runtime.extendedSettings,
        runtime.settings,
      );
    const bwpProfile = bwpContext === null
      ? undefined
      : createPluginProfileFunctions(bwpContext);
    const propertyLines = Object.fromEntries(
      ["rawbg", "bwp", "iob", "cob"].flatMap((name) => {
        const line = recordValue(bwpProperties[name]).displayLine;
        return typeof line === "string" && line.length > 0 ? [[name, line]] : [];
      }),
    );

    // Preserve the locked server plugin order for every implemented producer:
    // upbat, ar2, simplealarms, errorcodes, pump, openaps, xdripjs, loop, bwp,
    // cage, sage, iage, bage, treatmentnotify, timeago, then dbsize. The shared engine can therefore
    // arbitrate identical requests and treatment snoozes in Node-server order.
    if (runtime.upbat) {
      schedule(this.earliestFutureEntryAt(
        data.devicestatus.filter((status) =>
          Object.prototype.hasOwnProperty.call(status, "uploader")
        ),
        now,
      ));
      const preferences = recordValue(runtime.extendedSettings.upbat);
      const property = calculateUploaderBatteryProperty(
        data.devicestatus,
        now,
        preferences,
      );
      const notification = uploaderBatteryNotification(property, preferences);
      if (notification !== null) {
        notifications.push(notification);
        schedule(now + heartbeatMs);
        for (const status of data.devicestatus) {
          if (!Object.prototype.hasOwnProperty.call(status, "uploader")) continue;
          const mills = Number(status.mills);
          if (
            Number.isFinite(mills)
            && mills <= now
            && mills >= now - nightscoutTimes.mins(30).msecs
          ) {
            schedule(mills + nightscoutTimes.mins(30).msecs + 1);
          }
        }
      }
    }

    if (runtime.ar2) {
      schedule(this.earliestFutureEntryAt(data.sgvs, now));
      const latest = this.latestSgvAtOrBefore(data.sgvs, now);
      const request = calculateAr2NotificationRequest(
        data.sgvs,
        now,
        runtime.settings,
        latest === null
          ? { propertyLines }
          : { direction: nightscoutDirectionInfo(latest), propertyLines },
      );
      if (request !== null) {
        notifications.push(request);
        if (latest !== null) {
          const expiresAt = Number(latest.mills) + nightscoutTimes.mins(10).msecs + 1;
          schedule(Math.min(now + heartbeatMs, expiresAt));
        }
      }
    }

    if (runtime.simpleAlarms) {
      schedule(this.earliestFutureEntryAt(data.sgvs, now));
      const request = calculateSimpleAlarmRequest(data.sgvs, now, runtime.settings);
      if (request !== null) {
        notifications.push(request);
        const latest = this.latestSgvAtOrBefore(data.sgvs, now);
        if (latest !== null) {
          const expiresAt = Number(latest.mills) + nightscoutTimes.mins(10).msecs;
          schedule(Math.min(now + heartbeatMs, expiresAt));
        }
      }
    }

    if (runtime.errorCodes) {
      schedule(this.earliestFutureEntryAt(data.sgvs, now));
      const request = calculateErrorCodeNotification(
        data.sgvs,
        now,
        recordValue(runtime.extendedSettings.errorcodes),
      );
      if (request !== null) {
        notifications.push(request);
        const latest = this.latestSgvAtOrBefore(data.sgvs, now);
        if (latest !== null) {
          const expiresAt = Number(latest.mills) + nightscoutTimes.mins(10).msecs;
          schedule(Math.min(now + heartbeatMs, expiresAt));
        }
      }
    }

    const loopNotifications: RealtimeDocument[] = [];
    if (runtime.pump || runtime.openAps || runtime.loop) {
      const profile = runtime.pump
        ? createNightscoutProfileFunctions(
          data.profiles.map((document) => structuredClone(document)),
        )
        : undefined;
      const closedLoop = calculateClosedLoopNotificationEvaluation(
        data.devicestatus,
        data.treatments,
        profile,
        now,
        heartbeatMs,
        {
          ...(runtime.pump
            ? {
              pump: {
                preferences: recordValue(runtime.extendedSettings.pump),
                settings: runtime.settings,
              },
            }
            : {}),
          ...(runtime.openAps
            ? { openaps: { preferences: recordValue(runtime.extendedSettings.openaps) } }
            : {}),
          ...(runtime.loop
            ? { loop: { preferences: recordValue(runtime.extendedSettings.loop) } }
            : {}),
        },
      );
      for (const notification of closedLoop.notifications) {
        if (recordValue(notification.plugin).name === "loop") {
          loopNotifications.push(notification);
        } else {
          notifications.push(notification);
        }
      }
      schedule(closedLoop.nextDueAt);
    }

    if (runtime.xdripJs) {
      for (const status of data.devicestatus) {
        if (!Object.prototype.hasOwnProperty.call(status, "xdripjs")) continue;
        const mills = Number(status.mills);
        if (!Number.isFinite(mills)) continue;
        if (mills > now) {
          schedule(mills);
        } else if (mills >= now - nightscoutTimes.hours(24).msecs) {
          // The locked 24-hour predicate is inclusive at the boundary.
          schedule(mills + nightscoutTimes.hours(24).msecs + 1);
        }
      }
      const xdrip = calculateXdripJsEvaluation(
        data.devicestatus,
        now,
        recordValue(runtime.extendedSettings.xdripjs),
        xdripStateNotification,
      );
      if (xdrip.notification !== null) notifications.push(xdrip.notification);
      if (xdrip.repeatsAtHeartbeat) schedule(now + heartbeatMs);
      schedule(xdrip.nextStateDueAt);
      xdripStateNotification = xdrip.stateNotification;
      xdripStateNotificationChanged = xdrip.stateNotificationChanged;
    }

    // The closed-loop helper computes one shared deadline, but xdripjs sits
    // between OpenAPS and Loop in the locked server registry.
    notifications.push(...loopNotifications);

    if (runtime.bwp && bwpContext !== null) {
      const property = recordValue(bwpProperties.bwp) as BwpProperty;
      const bwp = calculateBwpNotificationEvaluation(
        property,
        bwpProfile,
        bwpContext.sgvs,
        now,
        runtime.settings,
        recordValue(runtime.extendedSettings.bwp),
        bwpProperties,
      );
      notifications.push(...bwp.notifications);
      snoozes.push(...bwp.snoozes);
      // Workers Free does not keep the Node process heartbeat alive solely to
      // age BWP state. Every new SGV, treatment, profile or device-status
      // mutation still evaluates it immediately, which matches the data
      // cadence without a permanent one-alarm-per-minute SQLite scan.
    }

    if (runtime.cage || runtime.sage || runtime.iage || runtime.bage) {
      schedule(this.earliestFutureEntryAt(data.ageTreatments, now));
      const age = calculateAgeNotificationEvaluation(
        data.ageTreatments,
        now,
        heartbeatMs,
        {
          ...(runtime.cage
            ? { cage: recordValue(runtime.extendedSettings.cage) }
            : {}),
          ...(runtime.sage
            ? { sage: recordValue(runtime.extendedSettings.sage) }
            : {}),
          ...(runtime.iage
            ? { iage: recordValue(runtime.extendedSettings.iage) }
            : {}),
          ...(runtime.bage
            ? { bage: recordValue(runtime.extendedSettings.bage) }
            : {}),
        },
      );
      notifications.push(...age.notifications);
      schedule(age.nextDueAt);
    }

    if (runtime.treatmentNotify) {
      const treatment = calculateTreatmentNotificationEvaluation(
        data.treatments,
        data.mbgs,
        now,
        recordValue(runtime.extendedSettings.treatmentnotify),
        runtime.settings,
      );
      notifications.push(...treatment.notifications);
      snoozes.push(...treatment.snoozes);
      schedule(treatment.activatesAt);
      if (
        treatment.expiresAt !== null
        && (treatment.notifications.length > 0 || treatment.snoozes.length > 0)
      ) {
        schedule(Math.min(now + heartbeatMs, treatment.expiresAt));
      }
    }

    if (runtime.timeAgo) {
      const timeAgo = calculateTimeAgoNotificationEvaluation(
        data.sgvs,
        now,
        runtime.settings,
        recordValue(runtime.extendedSettings.timeago),
        heartbeatMs,
      );
      if (timeAgo.notification !== null) notifications.push(timeAgo.notification);
      schedule(timeAgo.nextDueAt);
    }
    if (runtime.dbSize) {
      const preferences = recordValue(runtime.extendedSettings.dbsize);
      const property = calculateDatabaseSizeProperty(data.dbstats, preferences);
      const notification = databaseSizeNotification(property, preferences);
      if (notification !== null) {
        notifications.push(notification);
        schedule(now + heartbeatMs);
      }
    }
    return {
      notifications,
      snoozes,
      nextDueAt,
      xdripStateNotification,
      xdripStateNotificationChanged,
    };
  }

  private processPluginNotificationTask(task: BackgroundTaskRow, now: number): void {
    const evaluation = this.automaticPluginNotificationEvaluation(now);
    this.realtime.processAlarmNotificationRequests(
      evaluation.notifications,
      evaluation.snoozes,
      now,
      () => {
        if (
          evaluation.xdripStateNotificationChanged
          && evaluation.xdripStateNotification !== null
        ) {
          this.persistXdripStateNotification(evaluation.xdripStateNotification);
        }
        this.backgroundTasks().complete(
          task.kind,
          evaluation.nextDueAt,
          now,
        );
      },
    );
  }

  private async processDueBackgroundTasks(now: number): Promise<void> {
    const tasks = this.backgroundTasks();
    for (const kind of this.dataUpdateDebounce().consumeDue(
      now,
      BACKGROUND_TASK_BATCH_LIMIT,
    )) {
      // Only known kinds are recorded, but fail closed if a future migration
      // leaves an unknown row instead of fabricating a new task behavior.
      if (kind === PLUGIN_NOTIFICATIONS_TASK) tasks.schedule(kind, now, now);
    }
    const dueTasks = tasks.due(now, BACKGROUND_TASK_BATCH_LIMIT);
    for (const task of dueTasks) {
      try {
        if (task.kind === PLUGIN_NOTIFICATIONS_TASK) {
          this.processPluginNotificationTask(task, now);
        } else {
          this.ctx.storage.transactionSync(() => tasks.complete(task.kind, null, now));
        }
      } catch (error) {
        if (isEntryStoreWriteQuotaError(error)) throw error;
        this.ctx.storage.transactionSync(() => tasks.fail(task.kind, now));
      }
    }
  }

  private configuredApiSecret(): string | null {
    const secret = this.env.API_SECRET;
    return secret !== undefined && secret.length >= 12 ? secret : null;
  }

  private async deriveAuthorizationSubject(
    document: JsonDocument,
  ): Promise<(JsonDocument & SubjectCredential) | null> {
    const configured = this.configuredApiSecret();
    const subjectId = document._id;
    const subjectName = document.name;
    if (
      configured === null ||
      typeof subjectId !== "string" ||
      typeof subjectName !== "string"
    ) {
      return null;
    }
    return {
      ...document,
      ...await deriveSubjectCredential(configured, subjectId, subjectName),
    };
  }

  private authorizationSubjectRows(): DbDocument[] {
    return this.ctx.storage.sql.exec<DbDocument>(
      `SELECT id, body, sort_time, updated_at
       FROM documents
       WHERE collection = 'subjects'
       ORDER BY
         CASE WHEN json_valid(body) THEN json_extract(body, '$.name') ELSE '' END ASC,
         id ASC
       LIMIT ?`,
      AUTHORIZATION_SUBJECT_LIMIT + 1,
    ).toArray();
  }

  private authorizationSubjectCredentialShapeIsCurrent(document: JsonDocument): boolean {
    const name = document.name;
    const digest = document.digest;
    const accessToken = document.accessToken;
    const accessTokenDigest = document.accessTokenDigest;
    if (
      typeof name !== "string" ||
      typeof digest !== "string" ||
      typeof accessToken !== "string" ||
      typeof accessTokenDigest !== "string" ||
      !/^[0-9a-f]{40}$/.test(digest) ||
      !/^[0-9a-f]{40}$/.test(accessTokenDigest)
    ) {
      return false;
    }
    const abbreviation = name.toLowerCase().replace(/\W/g, "").slice(0, 10);
    return accessToken === `${abbreviation}-${digest.slice(0, 16)}`;
  }

  private async ensureAuthorizationSubjectsCurrent(): Promise<boolean> {
    const configured = this.configuredApiSecret();
    if (configured === null) throw new Error("API_SECRET is not configured");
    const marker = await authorizationDerivationMarker(
      this.getOrCreateJwtSecret(),
      configured,
    );

    // Crypto yields the input gate. Re-read and conditionally patch each row
    // in one sync transaction so an admin edit made during derivation is never
    // replaced with an old whole-document snapshot.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rows = this.authorizationSubjectRows();
      if (rows.length > AUTHORIZATION_SUBJECT_LIMIT) return false;
      const storedMarker = this.ctx.storage.sql.exec<DbSecret>(
        "SELECT value FROM tenant_secrets WHERE name = 'authorization-subject-marker' LIMIT 1",
      ).toArray()[0]?.value;
      if (
        storedMarker === marker &&
        rows.every((row) => {
          const document = tryDocument(row);
          return document !== null &&
            this.authorizationSubjectCredentialShapeIsCurrent(document);
        })
      ) {
        return true;
      }

      const derived = await Promise.all(rows.map(async (row) => {
        const document = tryDocument(row);
        return {
          id: row.id,
          updatedAt: row.updated_at,
          name: document?.name,
          subject: document === null
            ? null
            : await this.deriveAuthorizationSubject(document),
        };
      }));
      if (
        derived.some((item) =>
          item.subject === null ||
          typeof item.name !== "string" ||
          !Number.isInteger(item.updatedAt)
        )
      ) {
        return false;
      }

      const stable = this.ctx.storage.transactionSync(() => {
        const currentRows = this.authorizationSubjectRows();
        if (currentRows.length !== rows.length) return false;
        for (let index = 0; index < rows.length; index += 1) {
          const before = rows[index]!;
          const current = currentRows[index]!;
          if (
            current.id !== before.id ||
            current.updated_at !== before.updated_at ||
            tryDocument(current)?.name !== tryDocument(before)?.name
          ) {
            return false;
          }
        }

        for (const item of derived) {
          const subject = item.subject!;
          const written = this.ctx.storage.sql.exec(
            `UPDATE documents
             SET body = json_set(
               body,
               '$.accessToken', ?,
               '$.accessTokenDigest', ?,
               '$.digest', ?
             )
             WHERE collection = 'subjects'
               AND id = ?
               AND updated_at = ?
               AND json_extract(body, '$.name') = ?`,
            subject.accessToken,
            subject.accessTokenDigest,
            subject.digest,
            item.id,
            item.updatedAt,
            item.name as string,
          ).rowsWritten;
          if (written !== 1) return false;
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO tenant_secrets (name, value, created_at)
           VALUES ('authorization-subject-marker', ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             value = excluded.value,
             created_at = excluded.created_at`,
          marker,
          Date.now(),
        );
        return true;
      });
      if (stable) return true;
    }
    return false;
  }

  async resolveAuthorizationSubject(candidatesJson: string): Promise<string | null> {
    if (candidatesJson.length > 16 * 1024) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidatesJson);
    } catch {
      return null;
    }
    if (
      !Array.isArray(parsed) ||
      !parsed.every((candidate) => typeof candidate === "string")
    ) {
      return null;
    }
    const candidates = boundedTokenCandidates(parsed as PresentedToken);
    if (candidates === null) return null;
    if (!await this.ensureAuthorizationSubjectsCurrent()) return null;
    const subjects = this.authorizationSubjectRows().map((row) =>
      toDocument(row) as JsonDocument & SubjectCredential
    );
    for (const candidate of candidates) {
      const suffix = candidate.split("-").at(-1) ?? "";
      if (suffix.length < 16) continue;
      const matches = await Promise.all(subjects.map(async (subject) =>
        typeof subject.accessToken === "string" &&
          typeof subject.accessTokenDigest === "string" &&
          typeof subject.digest === "string"
          ? subjectCredentialMatches(subject, candidate)
          : false
      ));
      const matchedIndex = matches.findIndex(Boolean);
      if (matchedIndex !== -1) {
        return JSON.stringify(publicAuthorizationSubject(subjects[matchedIndex]!));
      }
    }
    return null;
  }

  async listAuthorizationSubjects(): Promise<string | null> {
    const current = await this.ensureAuthorizationSubjectsCurrent();
    const rows = this.authorizationSubjectRows();
    if (rows.length > AUTHORIZATION_SUBJECT_LIMIT) return null;
    const subjects: JsonDocument[] = [];
    for (const row of rows) {
      const subject = tryDocument(row);
      if (subject === null) {
        // Never expose corrupt bytes. The stable id lets an API-secret admin
        // delete the row or replace it with a valid subject document.
        subjects.push({
          _id: row.id,
          name: `[invalid subject ${row.id}]`,
          roles: [],
        });
        continue;
      }
      if (current && typeof subject.accessToken !== "string") continue;
      subjects.push(publicAuthorizationSubject(subject));
    }
    return JSON.stringify(subjects);
  }

  async createAuthorizationSubjects(
    documentsJson: string,
  ): Promise<AuthorizationMutationResult> {
    try {
      return { ok: true, value: await this.createDocuments("subjects", documentsJson) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return {
        ok: false,
        error: message.startsWith("authorization subject limit ")
          ? message
          : "Authorization storage failure",
      };
    }
  }

  async saveAuthorizationSubjects(
    documentsJson: string,
  ): Promise<AuthorizationMutationResult> {
    try {
      return { ok: true, value: await this.saveDocuments("subjects", documentsJson) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      return {
        ok: false,
        error: message.startsWith("authorization subject limit ")
          ? message
          : "Authorization storage failure",
      };
    }
  }

  private latestStatusProfile(): JsonDocument | undefined {
    const rows = this.ctx.storage.sql.exec<DbDocument>(
      `SELECT id, body, sort_time, updated_at
       FROM documents
       WHERE collection = 'profile'
       ORDER BY ${PROFILE_CURRENT_ORDER_BY}
       LIMIT 10`,
    ).toArray();
    for (const row of rows) {
      const profile = tryDocument(row);
      if (profile !== null) return profile;
    }
    return undefined;
  }

  private tenantStatusSettings(): NightscoutStatusSettingsOverrides {
    return deriveTenantStatusSettings(this.env, this.latestStatusProfile());
  }

  /** Locked dataloader's latest one-year zero-duration Profile Switch marker. */
  private activeProfileFromSwitch(now: number): string | null {
    for (const row of this.ctx.storage.sql.exec<{ profile: SqlStorageValue }>(
      `SELECT json_extract(body, '$.profile') AS profile
       FROM documents
       WHERE collection = 'treatments'
         AND json_extract(body, '$.eventType') = 'Profile Switch'
         AND json_type(body, '$.duration') IN ('integer', 'real')
         AND CAST(json_extract(body, '$.duration') AS REAL) = 0
         AND sort_time >= ?
         AND sort_time <= ?
       ORDER BY sort_time DESC, updated_at DESC, id ASC
       LIMIT 1`,
      now - PROFILE_SWITCH_WINDOW_MS,
      now,
    )) {
      return typeof row.profile === "string" && row.profile.length > 0
        ? row.profile
        : null;
    }
    return null;
  }

  /** Locked ddata loader's distinct latest Profile Switch marker semantics. */
  private ddataLastProfileFromSwitch(at: number, frame: boolean): string | null {
    const upperClause = frame ? "AND sort_time <= ?" : "";
    for (const row of this.ctx.storage.sql.exec<{
      profile: SqlStorageValue;
      sort_time: SqlStorageValue;
    }>(
      `SELECT json_extract(body, '$.profile') AS profile, sort_time
       FROM documents
       WHERE collection = 'treatments'
         AND json_extract(body, '$.eventType') = 'Profile Switch'
         AND json_type(body, '$.duration') IN ('integer', 'real')
         AND CAST(json_extract(body, '$.duration') AS REAL) = 0
         AND sort_time >= ?
         ${upperClause}
       ORDER BY sort_time DESC, updated_at DESC, id ASC
       LIMIT 1`,
      ...(frame
        ? [at - PROFILE_SWITCH_WINDOW_MS, at]
        : [at - PROFILE_SWITCH_WINDOW_MS]),
    )) {
      return Number(row.sort_time) < Date.now() && typeof row.profile === "string"
        ? row.profile
        : null;
    }
    return null;
  }

  nightscoutHttpStatus(now: number): string {
    const timestamp = Number.isFinite(now) ? now : Date.now();
    return JSON.stringify(nightscoutStatus(
      new Date(timestamp),
      this.env.AUTH_DEFAULT_ROLES ?? "readable",
      this.tenantStatusSettings(),
    ));
  }

  private cachedRealtimeEntries(now: number, frame: boolean, sql: string): Iterable<DbDocument> {
    const lower = now - REALTIME_ENTRY_WINDOW_MS;
    return this.realtimeEntryQueries.read(sql, lower, frame, () =>
      this.ctx.storage.sql.exec<DbDocument>(sql, ...(frame ? [lower, now] : [lower])),
    );
  }

  private realtimeSnapshot(
    now: number,
    frame = false,
    mode: RealtimeSnapshotMode = "root",
  ): RealtimeSnapshot {
    const snapshot: RealtimeSnapshot = {
      devicestatus: [],
      sgvs: [],
      cals: [],
      profiles: [],
      mbgs: [],
      food: [],
      treatments: [],
      dbstats: sqliteNightscoutDatabaseStats(this.ctx.storage.sql.databaseSize),
    };

    // Deterministic truncation priority starts with SGVs so oversized profile
    // or device-status documents cannot erase the glucose stream required by
    // monitoring and closed-loop clients. Each SQL cursor stops as soon as the
    // shared serialized output budget is exhausted; no large result is
    // materialized with toArray() before accounting.
    let budget = new RealtimeJsonBudget(snapshot);
    const entryUpperClause = frame ? "AND sort_time <= ?" : "";
    for (const row of this.cachedRealtimeEntries(now, frame,
      `SELECT id, body, sort_time
       FROM documents
       WHERE collection = 'entries'
         AND sort_time >= ?
         ${entryUpperClause}
         AND ${realtimeNumericMeasurementSql("$.sgv")}
         AND NOT ${realtimeJsonTruthySql("$.mbg")}
       ORDER BY sort_time DESC, id ASC
       LIMIT 1000`,
    )) {
      const entry = toPublicEntry(toDocument(row));
      const raw = entry as PublicEntry & Record<string, unknown>;
      if (raw.mbg) continue;
      const mgdl = realtimeMeasurement(raw.sgv);
      if (mgdl === null) continue;
      const sgv = {
        _id: entry._id,
        mgdl,
        mills: entry.date,
        device: entry.device,
        direction: entry.direction,
        filtered: raw.filtered,
        unfiltered: raw.unfiltered,
        noise: raw.noise,
        rssi: raw.rssi,
        type: "sgv",
      };
      if (!budget.reserveArrayItem(sgv, snapshot.sgvs.length)) break;
      snapshot.sgvs.push(sgv);
    }
    snapshot.sgvs.reverse();

    const profiles = this.realtimeDocuments(
      `SELECT id, body, sort_time
       FROM documents
       WHERE collection = 'profile'
       ORDER BY ${PROFILE_CURRENT_ORDER_BY}
       LIMIT 1`,
      [],
      budget,
      (document) => normalizeRealtimeDdataDocument(document, false),
    );
    snapshot.profiles = mode === "root"
      ? filterRealtimePublicProfiles(profiles)
      : profiles;
    budget = new RealtimeJsonBudget(
      snapshot,
      snapshot.sgvs.length + snapshot.profiles.length,
    );

    const rawDeviceStatus = this.realtimeRawDeviceStatus(
      now,
      budget,
      mode === "ddata" && frame,
    );
    snapshot.devicestatus = mode === "root"
      ? selectRealtimeRecentDeviceStatus(rawDeviceStatus, now)
      : buildRealtimeRetroDeviceStatus(rawDeviceStatus);
    // Root recentDeviceStatus removes old-per-group and future records, so
    // refund those conservative raw reservations before lower-priority
    // collections. Ddata keeps the complete bounded raw loader array.
    budget = new RealtimeJsonBudget(
      snapshot,
      snapshot.sgvs.length + snapshot.profiles.length + snapshot.devicestatus.length,
    );

    for (const row of this.cachedRealtimeEntries(now, frame,
      `SELECT id, body, sort_time
       FROM documents
       WHERE collection = 'entries'
         AND sort_time >= ?
         ${entryUpperClause}
         AND json_extract(body, '$.type') = 'cal'
         AND NOT ${realtimeJsonTruthySql("$.mbg")}
         AND NOT ${realtimeJsonTruthySql("$.sgv")}
       ORDER BY sort_time DESC, id ASC
       LIMIT 1000`,
    )) {
      const entry = toPublicEntry(toDocument(row)) as PublicEntry & Record<string, unknown>;
      if (entry.mbg || entry.sgv) continue;
      const calibration = {
        _id: entry._id,
        mills: entry.date,
        scale: entry.scale,
        intercept: entry.intercept,
        slope: entry.slope,
        type: "cal",
      };
      if (!budget.reserveArrayItem(calibration, snapshot.cals.length)) break;
      snapshot.cals.push(calibration);
    }
    snapshot.cals.reverse();

    for (const row of this.cachedRealtimeEntries(now, frame,
      `SELECT id, body, sort_time
       FROM documents
       WHERE collection = 'entries'
         AND sort_time >= ?
         ${entryUpperClause}
         AND ${realtimeNumericMeasurementSql("$.mbg")}
       ORDER BY sort_time DESC, id ASC
       LIMIT 1000`,
    )) {
      const entry = toPublicEntry(toDocument(row));
      const mgdl = realtimeMeasurement(entry.mbg);
      if (mgdl === null) continue;
      const mbg = {
        _id: entry._id,
        mgdl,
        mills: entry.date,
        device: entry.device,
        type: "mbg",
      };
      if (!budget.reserveArrayItem(mbg, snapshot.mbgs.length)) break;
      snapshot.mbgs.push(mbg);
    }
    snapshot.mbgs.reverse();

    snapshot.treatments = this.realtimeLoadedTreatments(now, frame, budget, snapshot);
    snapshot.food = this.realtimeDocuments(
      `SELECT id, body, sort_time
       FROM documents
       WHERE collection = 'food'
       ORDER BY sort_time DESC, updated_at DESC
       LIMIT 5000`,
      [],
      budget,
      (document) => normalizeRealtimeDdataDocument(document, false),
    );
    return snapshot;
  }

  /**
   * Locked dataloader retains the ordinary 2.5-day Treatment window plus one
   * latest zero-duration Profile Switch and one latest age event per type.
   * Current loads intentionally have no upper bound; explicit frames do.
   */
  private realtimeLoadedTreatments(
    now: number,
    frame: boolean,
    budget: RealtimeJsonBudget,
    snapshot: RealtimeSnapshot,
  ): RealtimeDocument[] {
    const realtimeSettings = this.resolvedAutomaticNotificationRuntime(now);
    const normalize = (document: RealtimeDocument): RealtimeDocument => {
      const treatment = normalizeRealtimeDdataDocument(document, true);
      // The locked dataloader runs treatmenttocurve before processTreatments.
      fitTreatmentsToBgCurve({
        sgvs: snapshot.sgvs as RealtimeDocument[],
        cals: snapshot.cals as RealtimeDocument[],
        treatments: [treatment],
      }, {
        units: realtimeSettings.settings.units,
        rawBgEnabled: realtimeSettings.enabled.has("rawbg"),
      });
      return treatment;
    };
    const treatments: RealtimeDocument[] = [];
    const seen = new Set<string>();
    const append = (documents: RealtimeDocument[]): void => {
      for (const document of documents) {
        const id = typeof document._id === "string" ? document._id : "";
        if (id.length > 0 && seen.has(id)) continue;
        if (id.length > 0) seen.add(id);
        treatments.push(document);
      }
    };
    const upperClause = frame ? "AND sort_time <= ?" : "";

    append(this.realtimeDocuments(
      `SELECT id, body, sort_time
       FROM (
         SELECT id, body, sort_time, updated_at
         FROM documents
         WHERE collection = 'treatments'
           AND sort_time >= ?
           ${upperClause}
         ORDER BY sort_time DESC, updated_at DESC, id ASC
         LIMIT 1000
       )
       ORDER BY sort_time ASC, id ASC`,
      frame
        ? [now - RUNTIME_TREATMENT_WINDOW_MS, now]
        : [now - RUNTIME_TREATMENT_WINDOW_MS],
      budget,
      normalize,
    ));

    if (!frame) {
      // The Node server keeps freshly received Treatments in its in-memory
      // cache even when a client backdates created_at outside the cold-load
      // window. SQLite updated_at is the durable equivalent across DO
      // eviction; one HTTP batch is capped at 100, so this stays bounded.
      append(this.realtimeDocuments(
        `SELECT id, body, sort_time
         FROM documents
         WHERE collection = 'treatments'
           AND updated_at >= ?
         ORDER BY updated_at ASC, id ASC
         LIMIT 100`,
        [now - RUNTIME_RECENT_MUTATION_WINDOW_MS],
        budget,
        normalize,
      ));
    }

    append(this.realtimeDocuments(
      `SELECT id, body, sort_time
       FROM documents
       WHERE collection = 'treatments'
         AND json_extract(body, '$.eventType') = 'Profile Switch'
         AND json_type(body, '$.duration') IN ('integer', 'real')
         AND CAST(json_extract(body, '$.duration') AS REAL) = 0
         AND sort_time >= ?
         ${upperClause}
       ORDER BY sort_time DESC, updated_at DESC, id ASC
       LIMIT 1`,
      frame ? [now - PROFILE_SWITCH_WINDOW_MS, now] : [now - PROFILE_SWITCH_WINDOW_MS],
      budget,
      normalize,
    ));

    for (const eventType of AGE_TREATMENT_EVENT_TYPES) {
      append(this.realtimeDocuments(
        `SELECT id, body, sort_time
         FROM documents
         WHERE collection = 'treatments'
           AND json_extract(body, '$.eventType') = ?
           AND sort_time >= ?
           ${upperClause}
         ORDER BY sort_time DESC, updated_at DESC, id ASC
         LIMIT 1`,
        frame
          ? [eventType, now - AGE_TREATMENT_WINDOW_MS, now]
          : [eventType, now - AGE_TREATMENT_WINDOW_MS],
        budget,
        normalize,
      ));
    }
    treatments.sort((left, right) => Number(left.mills) - Number(right.mills));
    return treatments;
  }

  /**
   * Small bounded data view used by /api/v2/properties. The official server
   * derives properties from its in-memory ddata cache; querying the complete
   * snapshot here would also deserialize treatments, profiles, and food on
   * every property poll. This adapter loads only the bounded plugin inputs.
   */
  private pluginPropertyContext(now: number): PluginPropertyContext {
    const context: PluginPropertyContext = {
      sgvs: [],
      mbgs: [],
      cals: [],
      devicestatus: [],
      treatments: [],
      profiles: [],
      dbstats: sqliteNightscoutDatabaseStats(this.ctx.storage.sql.databaseSize),
    };
    let budget = new RealtimeJsonBudget(context);

    for (const row of this.ctx.storage.sql.exec<DbDocument>(
      `SELECT id, body, sort_time
       FROM documents
       WHERE collection = 'entries'
         AND sort_time >= ?
         AND ${realtimeNumericMeasurementSql("$.sgv")}
         AND NOT ${realtimeJsonTruthySql("$.mbg")}
       ORDER BY sort_time DESC, id ASC
       LIMIT 64`,
      now - REALTIME_ENTRY_WINDOW_MS,
    )) {
      const entry = toPublicEntry(toDocument(row));
      const raw = entry as PublicEntry & Record<string, unknown>;
      if (raw.mbg) continue;
      const mgdl = realtimeMeasurement(raw.sgv);
      if (mgdl === null) continue;
      const sgv = {
        _id: entry._id,
        mgdl,
        mills: entry.date,
        device: entry.device,
        direction: entry.direction,
        filtered: raw.filtered,
        unfiltered: raw.unfiltered,
        noise: raw.noise,
        rssi: raw.rssi,
        type: "sgv",
      };
      if (!budget.reserveArrayItem(sgv, context.sgvs.length)) break;
      context.sgvs.push(sgv);
    }
    context.sgvs.reverse();
    budget = new RealtimeJsonBudget(context, context.sgvs.length);

    for (const row of this.ctx.storage.sql.exec<DbDocument>(
      `SELECT id, body, sort_time
       FROM documents
       WHERE collection = 'entries'
         AND sort_time >= ?
         AND ${realtimeNumericMeasurementSql("$.mbg")}
       ORDER BY sort_time DESC, id ASC
       LIMIT 10`,
      now - REALTIME_ENTRY_WINDOW_MS,
    )) {
      const entry = toPublicEntry(toDocument(row));
      const raw = entry as PublicEntry & Record<string, unknown>;
      const mgdl = realtimeMeasurement(raw.mbg);
      if (mgdl === null) continue;
      const mbg = {
        _id: entry._id,
        mgdl,
        mills: entry.date,
        device: entry.device,
        type: "mbg",
      };
      if (!budget.reserveArrayItem(mbg, context.mbgs.length)) break;
      context.mbgs.push(mbg);
    }
    context.mbgs.reverse();
    budget = new RealtimeJsonBudget(
      context,
      context.sgvs.length + context.mbgs.length,
    );

    for (const row of this.ctx.storage.sql.exec<DbDocument>(
      `SELECT id, body, sort_time
       FROM documents
       WHERE collection = 'entries'
         AND sort_time >= ?
         AND json_extract(body, '$.type') = 'cal'
         AND NOT ${realtimeJsonTruthySql("$.mbg")}
         AND NOT ${realtimeJsonTruthySql("$.sgv")}
       ORDER BY sort_time DESC, id ASC
       LIMIT 10`,
      now - REALTIME_ENTRY_WINDOW_MS,
    )) {
      const entry = toPublicEntry(toDocument(row)) as PublicEntry & Record<string, unknown>;
      if (entry.mbg || entry.sgv) continue;
      const calibration = {
        _id: entry._id,
        mills: entry.date,
        scale: entry.scale,
        intercept: entry.intercept,
        slope: entry.slope,
        type: "cal",
      };
      if (budget.reserveArrayItem(calibration, context.cals.length)) {
        context.cals.push(calibration);
      }
      break;
    }
    budget = new RealtimeJsonBudget(
      context,
      context.sgvs.length + context.mbgs.length + context.cals.length,
    );
    const rawDeviceStatus = this.realtimeRawDeviceStatus(now, budget);
    context.devicestatus = selectRealtimeRecentDeviceStatus(rawDeviceStatus, now);
    budget = new RealtimeJsonBudget(
      context,
      context.sgvs.length + context.mbgs.length + context.cals.length +
        context.devicestatus.length,
    );

    // Locked dataloader supplies the latest Profile to request-local plugin
    // calculations. Keep the same one-row selection used by /profile/current.
    context.profiles = this.realtimeDocuments(
      `SELECT id, body, sort_time
       FROM documents
       WHERE collection = 'profile'
       ORDER BY ${PROFILE_CURRENT_ORDER_BY}
       LIMIT 1`,
      [],
      budget,
      normalizeRealtimeDocument,
    );
    budget = new RealtimeJsonBudget(
      context,
      context.sgvs.length + context.mbgs.length + context.cals.length +
        context.devicestatus.length + context.profiles.length,
    );

    const seenTreatments = new Set<string>();
    const appendTreatments = (documents: RealtimeDocument[]): void => {
      for (const document of documents) {
        const key = typeof document._id === "string"
          ? `_id:${document._id}`
          : `event:${String(document.eventType)}:${String(document.mills)}`;
        if (seenTreatments.has(key)) continue;
        seenTreatments.add(key);
        context.treatments.push(document);
      }
    };

    // Locked dataloader separately retains the latest zero-duration Profile
    // Switch for one year so Profile-based IOB/COB calculations do not lose
    // the active profile when the ordinary treatment window rolls forward.
    appendTreatments(this.realtimeDocuments(
      `SELECT id, body, sort_time
       FROM documents
       WHERE collection = 'treatments'
         AND json_extract(body, '$.eventType') = 'Profile Switch'
         AND json_type(body, '$.duration') IN ('integer', 'real')
         AND CAST(json_extract(body, '$.duration') AS REAL) = 0
         AND sort_time >= ?
         AND sort_time <= ?
       ORDER BY sort_time DESC, updated_at DESC, id ASC
       LIMIT 1`,
      [now - PROFILE_SWITCH_WINDOW_MS, now],
      budget,
      normalizeRealtimeDocument,
    ));

    // Locked dataloader also loads one latest row for each age-related event
    // within 62 days.
    for (const eventType of AGE_TREATMENT_EVENT_TYPES) {
      appendTreatments(this.realtimeDocuments(
        `SELECT id, body, sort_time
         FROM documents
         WHERE collection = 'treatments'
           AND json_extract(body, '$.eventType') = ?
           AND sort_time >= ?
           AND sort_time <= ?
         ORDER BY sort_time DESC, updated_at DESC, id ASC
         LIMIT 1`,
        [eventType, now - AGE_TREATMENT_WINDOW_MS, now],
        budget,
        normalizeRealtimeDocument,
      ));
    }

    // The official cold/frame dataloader reads 2.5 days of Treatments. Select
    // the newest 1,000 rows under the existing transport budget, then restore
    // the upstream ascending runtime order before executing IOB/COB formulas.
    appendTreatments(this.realtimeDocuments(
      `SELECT id, body, sort_time
       FROM (
         SELECT id, body, sort_time, updated_at
         FROM documents
         WHERE collection = 'treatments'
           AND sort_time >= ?
           AND sort_time <= ?
         ORDER BY sort_time DESC, updated_at DESC, id ASC
         LIMIT 1000
       )
       ORDER BY sort_time ASC, id ASC`,
      [now - RUNTIME_TREATMENT_WINDOW_MS, now],
      budget,
      normalizeRealtimeDocument,
    ));
    context.treatments.sort((left, right) => Number(left.mills) - Number(right.mills));
    return context;
  }

  private realtimeDocuments(
    statement: string,
    bindings: SqlStorageValue[],
    budget: RealtimeJsonBudget,
    normalize: (document: RealtimeDocument) => RealtimeDocument,
    rows?: Iterable<DbDocument>,
  ): RealtimeDocument[] {
    const documents: RealtimeDocument[] = [];
    for (const row of rows ?? this.ctx.storage.sql.exec<DbDocument>(statement, ...bindings)) {
      if (!realtimeStoredBodyAllowed(row.body)) break;
      let parsed: RealtimeDocument;
      try {
        const value: unknown = toDocument(row);
        if (typeof value !== "object" || value === null || Array.isArray(value)) break;
        parsed = value as RealtimeDocument;
      } catch {
        break;
      }
      parsed._id = row.id;
      // Stored JSON is checked iteratively before clone-based runtime
      // normalization, so an over-deep body cannot reach JSON.stringify().
      if (!realtimeDocumentShapeAllowed(realtimeJsonMetrics(parsed, true))) break;
      const normalized = normalize(parsed);
      if (!budget.reserveArrayItem(normalized, documents.length)) break;
      documents.push(normalized);
    }
    return documents;
  }

  private realtimeRawDeviceStatus(
    now: number,
    budget: RealtimeJsonBudget,
    frame = false,
  ): RealtimeDocument[] {
    const lower = now - REALTIME_DEVICE_STATUS_WINDOW_MS;
    const statement = `SELECT id, body, sort_time, updated_at
       FROM documents
       WHERE collection = 'devicestatus'
         AND sort_time >= ?
         ${frame ? "AND sort_time <= ?" : ""}
       ORDER BY sort_time DESC, updated_at DESC`;
    const bindings = frame ? [lower, now] : [lower];
    return this.realtimeDocuments(statement, bindings, budget,
      normalizeRealtimeDeviceStatus,
      this.realtimeDeviceStatusQueries.read(lower, frame, () =>
        this.ctx.storage.sql.exec<DbDocument>(statement, ...bindings)),
    );
  }

  private realtimeRetroDeviceStatus(now: number): RealtimeDocument[] {
    const result: { devicestatus: RealtimeDocument[] } = { devicestatus: [] };
    const budget = new RealtimeJsonBudget(result);
    result.devicestatus = buildRealtimeRetroDeviceStatus(
      this.realtimeRawDeviceStatus(now, budget),
    );
    return result.devicestatus;
  }

  private authorizationFailureIp(ip: string): string | null {
    return ip.length > 0 && ip.length <= 256 ? ip : null;
  }

  private cleanupAuthorizationFailures(now: number): void {
    if (this.storageWritesBlocked()) return;
    const expired = this.ctx.storage.sql.exec<{ present: number }>(
      `SELECT EXISTS(
         SELECT 1 FROM authorization_failures
         WHERE retry_at + ? < ?
       ) AS present`,
      AUTHORIZATION_FAILURE_AGE_MS,
      now,
    ).one().present !== 0;
    if (!expired) return;
    try {
      this.ctx.storage.sql.exec(
        "DELETE FROM authorization_failures WHERE retry_at + ? < ?",
        AUTHORIZATION_FAILURE_AGE_MS,
        now,
      );
    } catch (error) {
      if (!this.enterStorageWriteQuotaMode(error)) throw error;
    }
  }

  private authorizationFailureCleanupDeadline(): number | null {
    const retryAt = this.ctx.storage.sql.exec<{ retry_at: number | null }>(
      `SELECT MIN(retry_at) AS retry_at
       FROM authorization_failures`,
    ).one().retry_at;
    return retryAt === null
      ? null
      : retryAt + AUTHORIZATION_FAILURE_AGE_MS + 1;
  }

  async authorizationDelay(ip: string, now = Date.now()): Promise<number> {
    const normalizedIp = this.authorizationFailureIp(ip);
    if (normalizedIp === null || !Number.isFinite(now)) return 0;
    const timestamp = Math.trunc(now);
    this.cleanupAuthorizationFailures(timestamp);
    const row = this.ctx.storage.sql.exec<{ retry_at: number }>(
      "SELECT retry_at FROM authorization_failures WHERE ip = ? LIMIT 1",
      normalizedIp,
    ).toArray()[0];
    const delay = row !== undefined && timestamp < row.retry_at
      ? row.retry_at - timestamp
      : 0;
    await this.synchronizeRealtimeAlarm();
    return Math.min(delay, AUTHORIZATION_FAILURE_MAX_DELAY_MS);
  }

  async authorizationFailed(ip: string, now: number, delayMs: number): Promise<void> {
    const normalizedIp = this.authorizationFailureIp(ip);
    if (
      normalizedIp === null ||
      !Number.isFinite(now) ||
      !Number.isFinite(delayMs)
    ) {
      return;
    }
    if (this.storageWritesBlocked()) return;
    const timestamp = Math.trunc(now);
    const delay = Math.max(
      0,
      Math.min(AUTHORIZATION_FAILURE_MAX_DELAY_MS, Math.trunc(delayMs)),
    );
    try {
      this.ctx.storage.transactionSync(() => {
        this.cleanupAuthorizationFailures(timestamp);
        const existing = this.ctx.storage.sql.exec<{ retry_at: number }>(
          "SELECT retry_at FROM authorization_failures WHERE ip = ? LIMIT 1",
          normalizedIp,
        ).toArray()[0]?.retry_at;
        const retryAt = Math.min((existing === undefined || timestamp >= existing
          ? timestamp
          : existing) + delay, timestamp + AUTHORIZATION_FAILURE_MAX_DELAY_MS);
        this.ctx.storage.sql.exec(
          `INSERT INTO authorization_failures (ip, retry_at, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(ip) DO UPDATE SET
             retry_at = excluded.retry_at,
             updated_at = excluded.updated_at`,
          normalizedIp,
          retryAt,
          timestamp,
        );
        const count = this.ctx.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM authorization_failures",
        ).one().count;
        const excess = count - AUTHORIZATION_FAILURE_LIMIT;
        if (excess > 0) {
          this.ctx.storage.sql.exec(
            `DELETE FROM authorization_failures
             WHERE ip IN (
               SELECT ip FROM authorization_failures
               ORDER BY updated_at ASC, ip ASC
               LIMIT ?
             )`,
            excess,
          );
        }
        this.adminNotifies().add({
          title: "Failed authentication",
          message: `A device at IP address ${normalizedIp} attempted authenticating with Nightscout with wrong credentials. Check if you have an uploader setup with wrong API_SECRET or token?`,
        }, this.adminNotifiesEnabled(timestamp), timestamp);
      });
    } catch (error) {
      if (!this.enterStorageWriteQuotaMode(error)) throw error;
      return;
    }
    await this.synchronizeRealtimeAlarm();
  }

  async authorizationSucceeded(ip: string): Promise<void> {
    const normalizedIp = this.authorizationFailureIp(ip);
    if (normalizedIp === null || this.storageWritesBlocked()) return;
    const present = this.ctx.storage.sql.exec<{ present: number }>(
      `SELECT EXISTS(
         SELECT 1 FROM authorization_failures WHERE ip = ?
       ) AS present`,
      normalizedIp,
    ).one().present !== 0;
    if (!present) return;
    try {
      this.ctx.storage.sql.exec(
        "DELETE FROM authorization_failures WHERE ip = ?",
        normalizedIp,
      );
    } catch (error) {
      if (!this.enterStorageWriteQuotaMode(error)) throw error;
      return;
    }
    await this.synchronizeRealtimeAlarm();
  }

  private async realtimePermissionGroups(subjectRoles: unknown): Promise<string[][]> {
    const roles = JSON.parse(await this.listDocuments("roles")) as JsonDocument[];
    return authorizationPermissionGroups(
      authorizationRoleNames(subjectRoles, this.env.AUTH_DEFAULT_ROLES),
      roles,
    );
  }

  private realtimeAuthorizationFromGroups(
    permissionGroups: string[][],
  ): RealtimeAuthorization {
    return {
      read: permissionGroupsAllow(permissionGroups, "api:*:read"),
      write: permissionGroupsAllow(
        permissionGroups,
        "api:*:create,update,delete",
      ),
      write_treatment: permissionGroupsAllow(
        permissionGroups,
        "api:treatments:create,update,delete",
      ),
    };
  }

  private async realtimeCredentialPermissionGroups(
    presentedSecret: unknown,
    presentedToken: unknown,
  ): Promise<string[][] | null> {
    const rawSecret = presentedSecret === "null" ? null : presentedSecret;
    const rawToken = presentedToken;
    if (
      (rawSecret === undefined || rawSecret === null || rawSecret === "") &&
      (rawToken === undefined || rawToken === null || rawToken === "")
    ) {
      return this.realtimePermissionGroups([]);
    }

    const configured = this.configuredApiSecret();
    if (typeof rawSecret === "string" && rawSecret.length <= 4096) {
      if (await apiSecretDigestMatches(rawSecret, configured)) {
        return [["*"]];
      }
      if (configured !== null) {
        const subjectJson = await this.resolveAuthorizationSubject(
          JSON.stringify([rawSecret]),
        );
        if (subjectJson !== null) {
          const subject = JSON.parse(subjectJson) as JsonDocument;
          return this.realtimePermissionGroups(subject.roles);
        }
      }
    }

    if (typeof rawToken === "string" && rawToken.length <= 4096) {
      const claims = await validateJwt(this.getOrCreateJwtSecret(), rawToken);
      if (claims !== null && configured !== null) {
        const subjectJson = await this.resolveAuthorizationSubject(
          JSON.stringify([claims.accessToken]),
        );
        if (subjectJson !== null) {
          const subject = JSON.parse(subjectJson) as JsonDocument;
          return this.realtimePermissionGroups(subject.roles);
        }
      }
    }
    return null;
  }

  private async realtimeAuthorize(
    message: Record<string, unknown>,
  ): Promise<RealtimeAuthorization | null> {
    const groups = await this.realtimeCredentialPermissionGroups(
      message.secret,
      message.token,
    );
    return groups === null ? null : this.realtimeAuthorizationFromGroups(groups);
  }

  private realtimeRootWrite(request: RealtimeRootWriteRequest): RealtimeRootWriteResult {
    const repository = this.documentRepository();
    if (request.event === "dbAdd") {
      const values = Array.isArray(request.data) ? request.data : [request.data];
      if (values.length > REALTIME_ROOT_WRITE_BATCH_MAX_DOCUMENTS) {
        return { acknowledgement: [], changed: false };
      }

      const documents: JsonDocument[] = [];
      let changed = false;
      for (const value of values) {
        const document = realtimeRootWriteDocument(value);
        if (document === null) {
          // processSingleDbAdd rejects malformed values. The locked array
          // wrapper reports [] even if an earlier sequential item committed.
          return { acknowledgement: [], changed };
        }
        try {
          const result = repository.addWebsocketRootDocument(
            request.collection,
            document,
            request.receivedAt,
          );
          documents.push(...result.documents);
          changed ||= result.changed;
        } catch {
          // Mongo insertion/dedupe failures are item-local in the locked
          // processSingleDbAdd branches; array processing continues.
        }
      }
      return { acknowledgement: documents, changed };
    }

    if (request.event === "dbRemove") {
      let changed = false;
      try {
        changed = repository.deleteWebsocketRootDocument(
          request.collection,
          request.id,
        );
      } catch {
        // dbRemove acknowledges optimistically before its async Mongo result.
      }
      return { acknowledgement: { result: "success" }, changed };
    }

    const fields = realtimeRootWriteDocument(request.data);
    if (fields === null) {
      return { acknowledgement: { result: "success" }, changed: false };
    }
    let changed = false;
    try {
      changed = request.event === "dbUpdate"
        ? repository.updateWebsocketRootDocument(request.collection, request.id, fields)
        : repository.unsetWebsocketRootDocument(request.collection, request.id, fields);
    } catch {
      // dbUpdate and dbUpdateUnset expose the same optimistic success ACK when
      // Mongo rejects the asynchronous update operation.
    }
    return { acknowledgement: { result: "success" }, changed };
  }

  private async realtimeAlarmAuthorize(
    message: Record<string, unknown>,
  ): Promise<RealtimeAlarmAuthorization | null> {
    // Locked AlarmSocket gives the accessToken branch priority over all web
    // credentials and requires only that the subject exists. A successful
    // native subscription may ACK alarms regardless of the subject's roles.
    if (message.accessToken) {
      if (
        typeof message.accessToken !== "string"
        || message.accessToken.length > 4096
      ) {
        return null;
      }
      const subjectJson = await this.resolveAuthorizationSubject(
        JSON.stringify([message.accessToken]),
      );
      return subjectJson === null ? null : { mode: "accessToken" };
    }

    // The currently ported settings surface locks
    // authenticationPromptOnLoad=false, so missing web credentials resolve the
    // tenant's default roles exactly like the upstream web-client branch.
    const groups = await this.realtimeCredentialPermissionGroups(
      message.secret,
      message.jwtToken,
    );
    if (groups === null) return null;
    return {
      mode: "web",
      read: permissionGroupsAllow(groups, "api:*:read"),
      ack: permissionGroupsAllow(groups, "notifications:*:ack"),
    };
  }

  private async realtimeStorageAuthorize(
    message: Record<string, unknown>,
  ): Promise<readonly Api3CollectionName[] | null> {
    const accessToken = message.accessToken;
    if (
      typeof accessToken !== "string"
      || accessToken.length === 0
      || accessToken.length > 4096
    ) {
      return null;
    }
    const subjectJson = await this.resolveAuthorizationSubject(
      JSON.stringify([accessToken]),
    );
    if (subjectJson === null) return null;
    const subject = JSON.parse(subjectJson) as JsonDocument;
    const groups = await this.realtimePermissionGroups(subject.roles);
    const requested = Array.isArray(message.collections)
      ? message.collections
      : API3_STORAGE_COLLECTIONS;
    const granted: Api3CollectionName[] = [];
    for (const candidate of requested) {
      if (
        typeof candidate !== "string"
        || !API3_STORAGE_COLLECTIONS.includes(candidate as Api3CollectionName)
      ) {
        continue;
      }
      const collection = candidate as Api3CollectionName;
      const permission = collection === "settings"
        ? "api:settings:admin"
        : `api:${collection}:read`;
      if (permissionGroupsAllow(groups, permission)) granted.push(collection);
    }
    return granted;
  }

  async publishAlarmNotification(notificationJson: string): Promise<number> {
    if (notificationJson.length > REALTIME_MAX_PAYLOAD_BYTES) return 0;
    let parsed: unknown;
    try {
      parsed = JSON.parse(notificationJson) as unknown;
    } catch {
      return 0;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return 0;
    const delivered = this.realtime.publishAlarmNotification(
      parsed as Record<string, unknown>,
    );
    this.flushRealtimeWebSockets();
    await this.synchronizeRealtimeAlarm();
    return delivered;
  }

  async processAlarmNotificationRequests(
    requestsJson: string,
    lastUpdated: number,
  ): Promise<string> {
    if (
      requestsJson.length > REALTIME_MAX_PAYLOAD_BYTES
      || !Number.isSafeInteger(lastUpdated)
    ) return JSON.stringify({ ok: false, error: "invalid_notification_requests" });
    let parsed: unknown;
    try {
      parsed = JSON.parse(requestsJson) as unknown;
    } catch {
      return JSON.stringify({ ok: false, error: "invalid_notification_requests" });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return JSON.stringify({ ok: false, error: "invalid_notification_requests" });
    }
    const record = parsed as Record<string, unknown>;
    const notifications = record.notifications;
    const snoozes = record.snoozes;
    const validArray = (value: unknown): value is Record<string, unknown>[] =>
      Array.isArray(value)
      && value.length <= NOTIFICATION_REQUEST_BATCH_LIMIT
      && value.every((item) =>
        typeof item === "object" && item !== null && !Array.isArray(item)
      );
    if (!validArray(notifications) || !validArray(snoozes)) {
      return JSON.stringify({ ok: false, error: "invalid_notification_requests" });
    }
    const result = this.realtime.processAlarmNotificationRequests(
      notifications,
      snoozes,
      lastUpdated,
    );
    this.flushRealtimeWebSockets();
    await this.synchronizeRealtimeAlarm();
    return JSON.stringify({ ok: true, ...result });
  }

  async acknowledgeAlarmNotification(
    level: number,
    group: string,
    silenceTime: number,
  ): Promise<boolean> {
    const accepted = this.realtime.acknowledgeAlarm(level, group, silenceTime);
    this.flushRealtimeWebSockets();
    await this.synchronizeRealtimeAlarm();
    return accepted;
  }

  async acknowledgePushoverReceipt(responseJson: string, now: number): Promise<boolean> {
    if (
      responseJson.length > REALTIME_MAX_PAYLOAD_BYTES
      || !Number.isSafeInteger(now)
      || now < 0
    ) return false;
    let response: unknown;
    try {
      response = JSON.parse(responseJson) as unknown;
    } catch {
      return false;
    }
    if (typeof response !== "object" || response === null || Array.isArray(response)) return false;

    const runtime = this.resolvedAutomaticNotificationRuntime(now);
    const pushnotify = new NightscoutPushNotify({
      state: this.pushNotificationState(),
      now: () => now,
      settings: {
        isAlarmEventEnabled: (notification) =>
          nightscoutAlarmEventEnabled(runtime.settings, {
            eventName: notification.eventName ?? "",
            level: Number(notification.level),
          }),
        snoozeFirstMinsForAlarmEvent: (notification) =>
          nightscoutFirstSnoozeMins(runtime.settings, {
            eventName: notification.eventName ?? "",
            level: Number(notification.level),
          }),
      },
      notifications: {
        ack: (level, group, silenceTime) => {
          this.realtime.acknowledgeAlarm(level, group ?? "default", silenceTime);
        },
      },
    });
    const accepted = pushnotify.pushoverAck(response as Record<string, unknown>);
    if (accepted) {
      this.flushRealtimeWebSockets();
      await this.synchronizeRealtimeAlarm();
    }
    return accepted;
  }

  private async flushRealtimeMutation(): Promise<void> {
    this.requireStorageWrites();
    try {
      // Upstream's data-received listener evaluates plugins on the leading edge.
      // Do the same in the originating request so ordinary in-range uploads do
      // not consume a second Worker invocation merely to remove a due task.
      await this.processDueBackgroundTasks(Date.now());
      if (this.realtime.flushApplicationWakes() > 0) this.flushRealtimeWebSockets();
      await this.synchronizeRealtimeAlarm();
    } catch (error) {
      this.enterStorageWriteQuotaMode(error);
      throw error;
    }
  }

  private async publishRootDataUpdate(): Promise<void> {
    this.requireStorageWrites();
    try {
      this.ctx.storage.transactionSync(() => {
        this.realtime.recordRootDataUpdateInTransaction();
      });
      await this.flushRealtimeMutation();
    } catch (error) {
      this.enterStorageWriteQuotaMode(error);
      throw error;
    }
  }

  private nextRealtimeWebSocketHeartbeatDeadline(): number | null {
    let nextDeadline: number | null = null;
    const consider = (deadline: number): void => {
      if (nextDeadline === null || deadline < nextDeadline) nextDeadline = deadline;
    };
    for (const ws of this.ctx.getWebSockets(REALTIME_WEBSOCKET_TAG)) {
      if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
        continue;
      }
      const attachment = this.realtimeWebSocketAttachment(ws);
      if (attachment === null) {
        const sid = this.trustedRealtimeWebSocketSid(ws);
        if (
          sid !== null &&
          this.realtime.webSocketClosureDeadline(sid) !== null
        ) {
          continue;
        }
        consider(Date.now());
        continue;
      }
      if (attachment.mode === "upgrade") {
        consider(attachment.deadline!);
        continue;
      }
      if (attachment.engineProtocol === 3) {
        consider(
          attachment.lastSeenAt! +
            REALTIME_PING_INTERVAL_MS +
            REALTIME_PING_TIMEOUT_MS,
        );
        continue;
      }
      const deadline = attachment.pongDeadline ?? attachment.nextPingAt;
      if (deadline !== null && deadline !== undefined) consider(deadline);
    }
    return nextDeadline;
  }

  private processRealtimeWebSocketHeartbeats(now: number): void {
    const readyEio4Sockets: Array<{
      ws: WebSocket;
      attachment: RealtimeWebSocketAttachment;
    }> = [];
    let eio4PingDue = false;
    for (const ws of this.ctx.getWebSockets(REALTIME_WEBSOCKET_TAG)) {
      if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
        continue;
      }
      const attachment = this.realtimeWebSocketAttachment(ws);
      if (attachment === null) {
        const sid = this.trustedRealtimeWebSocketSid(ws);
        if (
          sid !== null &&
          this.realtime.webSocketClosureDeadline(sid) !== null
        ) {
          continue;
        }
        this.closeInvalidRealtimeWebSocket(ws);
        continue;
      }
      if (attachment.mode === "upgrade") {
        if (attachment.deadline! <= now) {
          this.realtime.abortWebSocketUpgrade(attachment.sid);
          this.safeCloseWebSocket(ws, 1008, "websocket upgrade timed out");
        }
        continue;
      }
      const eio3ExpiresAt =
        attachment.lastSeenAt! +
        REALTIME_PING_INTERVAL_MS +
        REALTIME_PING_TIMEOUT_MS;
      const heartbeatExpired = attachment.engineProtocol === 3
        ? eio3ExpiresAt <= now
        : attachment.pongDeadline !== null &&
          attachment.pongDeadline !== undefined &&
          attachment.pongDeadline <= now;
      if (heartbeatExpired) {
        this.realtime.closeWebSocketSession(attachment.sid);
        this.safeCloseWebSocket(ws, 1008, "ping timeout");
        continue;
      }
      if (
        attachment.engineProtocol !== 4 ||
        attachment.pongDeadline !== null
      ) {
        continue;
      }
      readyEio4Sockets.push({ ws, attachment });
      if (
        attachment.nextPingAt !== null &&
        attachment.nextPingAt !== undefined &&
        attachment.nextPingAt <= now
      ) {
        eio4PingDue = true;
      }
    }
    if (!eio4PingDue) return;

    // One tenant owns one Cloudflare alarm. When any EIO4 socket reaches its
    // ping phase, ping every ready EIO4 socket in this same wake so independently
    // opened browser/AAPS connections converge to one 25-second phase.
    const pongDeadline = now + REALTIME_PING_TIMEOUT_MS;
    for (const { ws, attachment } of readyEio4Sockets) {
      try {
        ws.send("2");
        ws.serializeAttachment({
          ...attachment,
          nextPingAt: null,
          pongDeadline,
        } satisfies RealtimeWebSocketAttachment);
      } catch {
        this.realtime.closeWebSocketSession(attachment.sid);
        this.safeCloseWebSocket(ws, 1011, "heartbeat send failed");
      }
    }
  }

  private async synchronizeRealtimeAlarm(): Promise<void> {
    if (this.storageWritesBlocked()) {
      this.realtimeAlarmRecoveryPending = true;
      return;
    }
    // Cloudflare persists one alarm per Durable Object. Application work stays
    // in SQLite while Engine.IO heartbeat deadlines live in hibernatable
    // WebSocket attachments, avoiding a session/FIFO rewrite every 25 seconds.
    try {
      const realtimeDeadline = this.realtime.nextDeadline();
      const websocketHeartbeatDeadline =
        this.nextRealtimeWebSocketHeartbeatDeadline();
      const authorizationDeadline = this.authorizationFailureCleanupDeadline();
      const backgroundDeadline = this.backgroundTasks().nextDeadline();
      const dataUpdateDeadline = this.dataUpdateDebounce().nextDeadline();
      const deadlines = [
        realtimeDeadline,
        websocketHeartbeatDeadline,
        authorizationDeadline,
        backgroundDeadline,
        dataUpdateDeadline,
      ]
        .filter((deadline): deadline is number => deadline !== null);
      const nextDeadline = deadlines.length === 0 ? null : Math.min(...deadlines);
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (nextDeadline === null) {
        if (currentAlarm !== null) await this.ctx.storage.deleteAlarm();
        this.realtimeAlarmRecoveryPending = false;
        return;
      }
    // A durable outbound frame records its FIFO creation time, which is often
    // already in the past by the time this turn yields. Cloudflare treats a
    // newly written past alarm as immediately due; scheduling one short turn
    // ahead keeps it observable/persistent while still prompting the next
    // bounded flush turn without a polling timer.
      const scheduleNow = Date.now();
      const promptDeadline = scheduleNow + 100;
      const isDue = nextDeadline <= promptDeadline;
      const scheduledDeadline = isDue ? promptDeadline : nextDeadline;
    // Do not postpone a still-future prompt alarm on every busy WebSocket
    // turn; otherwise a steady input stream could starve durable pending
    // output. A past alarm is different: getAlarm() can briefly retain its
    // timestamp while delivery is being queued, then clear it after this RPC.
    // Replace that stale schedule so due SQL work cannot lose its only wakeup.
      const shouldReplace = isDue
        ? currentAlarm === null
          || currentAlarm <= scheduleNow
          || currentAlarm > scheduledDeadline
        : currentAlarm !== scheduledDeadline;
      if (shouldReplace) {
        await this.ctx.storage.setAlarm(scheduledDeadline);
      }
      this.realtimeAlarmRecoveryPending = false;
    } catch (error) {
      if (isEntryStoreWriteQuotaError(error)) {
        this.realtimeAlarmRecoveryPending = true;
      }
      throw error;
    }
  }

  private async realtimeScheduledResult<T>(
    operation: () => T | Promise<T>,
  ): Promise<RealtimeRpcResult<T>> {
    if (this.storageWritesBlocked()) {
      return {
        ok: false,
        error: {
          code: "storage_quota",
          message: "Temporary storage quota exceeded",
        },
      };
    }
    try {
      return { ok: true, value: await operation() };
    } catch (error) {
      if (this.enterStorageWriteQuotaMode(error)) {
        return {
          ok: false,
          error: {
            code: "storage_quota",
            message: "Temporary storage quota exceeded",
          },
        };
      }
      if (error instanceof RealtimeSessionError) {
        return {
          ok: false,
          error: { code: error.code, message: error.message },
        };
      }
      throw error;
    } finally {
      if (!this.storageWritesBlocked()) {
        try {
          this.flushRealtimeWebSockets();
          await this.synchronizeRealtimeAlarm();
        } catch (error) {
          if (!this.enterStorageWriteQuotaMode(error)) throw error;
        }
      }
    }
  }

  override async alarm(_alarmInfo?: AlarmInvocationInfo): Promise<void> {
    if (this.storageWritesBlocked()) {
      this.realtimeAlarmRecoveryPending = true;
      return;
    }
    try {
      // Alarm delivery is at-least-once. processAlarm commits every durable
      // transition transactionally before this derived schedule is replaced.
      const now = Date.now();
      this.cleanupAuthorizationFailures(now);
      this.processRealtimeWebSocketHeartbeats(now);
      this.realtime.processAlarm();
      await this.processDueBackgroundTasks(now);
      if (this.storageWritesBlocked()) throw new DurableObjectWriteQuotaError();
      this.flushRealtimeWebSockets();
      await this.synchronizeRealtimeAlarm();
    } catch (error) {
      if (this.enterStorageWriteQuotaMode(error)) {
        this.realtimeAlarmRecoveryPending = true;
        return;
      }
      throw error;
    }
  }

  realtimeHandshake(
    engineProtocol: RealtimeEngineProtocol = 4,
    jsonpIndex: string | null = null,
  ): Promise<RealtimeRpcResult<{ sid: string; payload: string }>> {
    return this.realtimeScheduledResult(() =>
      this.realtime.createHandshake(engineProtocol, jsonpIndex)
    );
  }

  realtimeValidateSession(
    sid: string,
    engineProtocol: RealtimeEngineProtocol = 4,
  ): Promise<RealtimeRpcResult<null>> {
    return this.realtimeScheduledResult(() => {
      this.realtime.validateSession(sid, engineProtocol);
      return null;
    });
  }

  realtimeBeginPost(
    sid: string,
    engineProtocol: RealtimeEngineProtocol = 4,
  ): Promise<RealtimeRpcResult<string>> {
    return this.realtimeScheduledResult(() =>
      this.realtime.beginPost(sid, engineProtocol)
    );
  }

  realtimeBeginPostEnvelope(
    sid: string,
    engineProtocol: RealtimeEngineProtocol = 4,
  ): Promise<RealtimeRpcResult<{ token: string; jsonpIndex: string | null }>> {
    return this.realtimeScheduledResult(() =>
      this.realtime.beginPostEnvelope(sid, engineProtocol)
    );
  }

  realtimeAbortPost(sid: string, token: string): Promise<RealtimeRpcResult<null>> {
    return this.realtimeScheduledResult(() => {
      this.realtime.abortPost(sid, token);
      return null;
    });
  }

  realtimeRejectPost(sid: string, token: string): Promise<RealtimeRpcResult<null>> {
    return this.realtimeScheduledResult(() => {
      this.realtime.rejectPost(sid, token);
      return null;
    });
  }

  realtimeSubmitPost(
    sid: string,
    token: string,
    payload: string,
    engineProtocol: RealtimeEngineProtocol = 4,
  ): Promise<RealtimeRpcResult<null>> {
    return this.realtimeScheduledResult(async () => {
      await this.realtime.submitPost(sid, token, payload, engineProtocol);
      return null;
    });
  }

  realtimePoll(
    sid: string,
    engineProtocol: RealtimeEngineProtocol = 4,
  ): Promise<RealtimeRpcResult<string>> {
    return this.realtimeScheduledResult(() =>
      this.realtime.poll(sid, engineProtocol)
    );
  }

  realtimePollEnvelope(
    sid: string,
    engineProtocol: RealtimeEngineProtocol = 4,
  ): Promise<RealtimeRpcResult<{ payload: string; jsonpIndex: string | null }>> {
    return this.realtimeScheduledResult(() =>
      this.realtime.pollEnvelope(sid, engineProtocol)
    );
  }

  private getOrCreateJwtSecret(): string {
    const existing = this.ctx.storage.sql
      .exec<DbSecret>(
        "SELECT value FROM tenant_secrets WHERE name = 'authorization-jwt' LIMIT 1",
      )
      .toArray()[0];
    if (existing !== undefined && isJwtSecret(existing.value)) return existing.value;

    const value = createJwtSecret();
    this.ctx.storage.sql.exec(
      `INSERT INTO tenant_secrets (name, value, created_at)
       VALUES ('authorization-jwt', ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         value = excluded.value,
         created_at = excluded.created_at`,
      value,
      Date.now(),
    );
    return value;
  }

  async issueAccessJwt(accessToken: string): Promise<string> {
    if (accessToken.length === 0 || accessToken.length > 512) {
      throw new Error("invalid access token length");
    }
    return JSON.stringify(await signJwt(this.getOrCreateJwtSecret(), accessToken));
  }

  async verifyAccessJwt(token: string): Promise<string | null> {
    if (token.length === 0 || token.length > 4096) return null;
    const claims = await validateJwt(this.getOrCreateJwtSecret(), token);
    return claims === null ? null : JSON.stringify(claims);
  }

  async putEntries(entries: ValidatedEntry[]): Promise<WriteResult> {
    let mutations: ReturnType<SqliteDocumentRepository["upsertLegacyEntries"]>;
    try {
      mutations = this.documentRepository().upsertLegacyEntries(entries);
    } finally {
      // Ordered Mongo-compatible batches can commit a successful prefix before
      // a later item fails. Publish that resulting state in both outcomes.
      await this.publishRootDataUpdate();
    }
    return {
      inserted: mutations.filter((mutation) => mutation.created).length,
      duplicates: mutations.filter((mutation) => !mutation.created).length,
      // Locked bulkWrite returns the normalized submitted documents, not the
      // merged database snapshots. Mongo only adds _id to indexes that were
      // inserted by this batch; an ordinary replay/update has no generated id.
      entriesJson: JSON.stringify(mutations.map((mutation, index) => {
        const submitted = JSON.parse(entries[index]!.documentJson) as JsonDocument;
        if (mutation.created) submitted._id = mutation.document._id!;
        return submitted;
      })),
    };
  }

  async putEntriesJson(entries: ValidatedEntry[]): Promise<string> {
    this.requireStorageWrites();
    try {
      return JSON.stringify({ ok: true, result: await this.putEntries(entries) });
    } catch (error) {
      if (this.enterStorageWriteQuotaMode(error) || isDurableObjectReadQuotaError(error)) throw error;
      // Keep an expected Mongo-compatible ordered-batch failure inside the DO
      // RPC boundary. The HTTP adapter emits the locked public envelope while
      // the successful SQLite prefix remains committed.
      return JSON.stringify({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getEntries(query: HistoryQuery): Promise<PublicEntry[]> {
    return this.documentRepository().queryLegacyEntries(query).map(toPublicEntry);
  }

  async getEntriesJson(query: HistoryQuery): Promise<string> {
    try {
      return JSON.stringify({ ok: true, result: await this.getEntries(query) });
    } catch (error) {
      const queryStatus = error instanceof DocumentQueryError
        ? error.code === "QUERY_SCAN_LIMIT" ? 413 : 400
        : undefined;
      return JSON.stringify({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        ...(queryStatus === undefined ? {} : { status: queryStatus }),
      });
    }
  }

  async countLegacyDocumentsJson(
    collection: Api3CollectionName,
    query: HistoryQuery,
  ): Promise<string> {
    try {
      const count = this.documentRepository().countLegacyDocuments(query, collection);
      return JSON.stringify({ ok: true, result: count });
    } catch (error) {
      const queryStatus = error instanceof DocumentQueryError
        ? error.code === "QUERY_SCAN_LIMIT" ? 413 : 400
        : undefined;
      return JSON.stringify({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        ...(queryStatus === undefined ? {} : { status: queryStatus }),
      });
    }
  }

  async getSgvEntries(count: number): Promise<PublicEntry[]> {
    return this.documentRepository().queryLegacySgvBucket(count).map(toPublicEntry);
  }

  async getDdataSnapshotJson(at: number, frame: boolean): Promise<string> {
    if (!Number.isFinite(at)) throw new Error("invalid ddata frame time");
    const timestamp = Math.trunc(at);
    const snapshot = this.realtimeSnapshot(timestamp, frame, "ddata");
    const result: FullRealtimeDdataSnapshot = {
      sgvs: snapshot.sgvs,
      treatments: snapshot.treatments,
      mbgs: snapshot.mbgs,
      cals: snapshot.cals,
      profiles: snapshot.profiles,
      devicestatus: snapshot.devicestatus,
      food: snapshot.food,
      activity: [],
      dbstats: snapshot.dbstats,
      lastUpdated: at,
      lastProfileFromSwitch: this.ddataLastProfileFromSwitch(timestamp, frame),
      ...(frame ? { page: { frame: true, after: at } } : {}),
      ...buildRealtimeTreatmentBuckets([]),
    };

    // Locked dataloader.loadActivity() projects only these four fields, sorts
    // oldest-first, keeps two days, caps explicit historical frames at `at`,
    // and de-duplicates equal instants. Activity is part of ddata.clone(), but
    // deliberately not part of dataWithRecentStatuses() used by the root
    // Socket.IO authorization snapshot.
    let budget: RealtimeJsonBudget;
    try {
      budget = new RealtimeJsonBudget(
        result,
        snapshot.devicestatus.length + snapshot.sgvs.length + snapshot.cals.length +
          snapshot.profiles.length + snapshot.mbgs.length + snapshot.food.length +
          snapshot.treatments.length,
      );
    } catch {
      // The ordinary snapshot already consumed the platform payload budget.
      // Preserve the glucose-first truncation policy and return an empty
      // lower-priority Activity bucket instead of failing the whole request.
      return JSON.stringify(result);
    }

    const upperClause = frame ? "AND sort_time <= ?" : "";
    const bindings: SqlStorageValue[] = frame
      ? [timestamp - REALTIME_ENTRY_WINDOW_MS, timestamp]
      : [timestamp - REALTIME_ENTRY_WINDOW_MS];
    const seenMills = new Set<number>();
    for (const row of this.ctx.storage.sql.exec<DbDocument>(
      `SELECT id, body, sort_time
       FROM documents
       WHERE collection = 'activity'
         AND sort_time >= ?
         ${upperClause}
       ORDER BY sort_time ASC, id ASC`,
      ...bindings,
    )) {
      if (!realtimeStoredBodyAllowed(row.body)) break;
      let document: RealtimeDocument;
      try {
        document = toDocument(row);
      } catch {
        break;
      }
      if (typeof document.created_at !== "string") continue;
      const mills = Date.parse(document.created_at);
      if (!Number.isFinite(mills) || seenMills.has(mills)) continue;
      const activity: RealtimeDocument = {
        mills: new Date(mills).toISOString(),
        heartrate: document.heartrate,
        steps: document.steps,
        activitylevel: document.activitylevel,
      };
      if (!budget.reserveArrayItem(activity, result.activity.length)) break;
      seenMills.add(mills);
      result.activity.push(activity);
    }

    const buckets = buildRealtimeTreatmentBuckets(
      snapshot.treatments as RealtimeDocument[],
    );
    for (const key of REALTIME_TREATMENT_BUCKET_KEYS) {
      for (const treatment of buckets[key]) {
        if (!budget.reserveArrayItem(treatment, result[key].length)) break;
        result[key].push(treatment);
      }
    }
    return JSON.stringify(result);
  }

  async getPluginPropertyContextJson(at: number): Promise<string> {
    if (!Number.isFinite(at)) throw new Error("invalid property context time");
    return JSON.stringify(this.pluginPropertyContext(Math.trunc(at)));
  }

  async getEntryById(id: string): Promise<PublicEntry[]> {
    const entry = this.documentRepository().findLegacyEntryById(id);
    return entry === null ? [] : [toPublicEntry(entry)];
  }

  async getCurrent(): Promise<PublicEntry[]> {
    return this.documentRepository().currentLegacyEntries().map((document) => {
      const entry = toPublicEntry(document);
      return entry.type === undefined ? { ...entry, type: "sgv" } : entry;
    });
  }

  async deleteEntries(
    ids: string[],
    lte: number | null = null,
    gte: number | null = null,
    type: string | null = null,
    dateString: string | null = null,
    date: number | null = null,
    dateStringLte: string | null = null,
    dateStringGte: string | null = null,
  ): Promise<number> {
    this.requireStorageWrites();
    const deleted = this.documentRepository().deleteLegacyEntries(
      ids,
      lte,
      gte,
      type,
      dateString,
      date,
      dateStringLte,
      dateStringGte,
    );
    await this.publishRootDataUpdate();
    return deleted;
  }

  async listDocuments(collection: DocumentCollection, limit = 5000): Promise<string> {
    if (collection === "subjects") return await this.listAuthorizationSubjects() ?? "[]";
    const boundedLimit = Math.max(1, Math.min(10000, Math.trunc(limit)));
    if (collection === "treatments") {
      return JSON.stringify(this.documentRepository().queryLegacyTreatments({ limit: boundedLimit }));
    }
    const orderBy = collection === "profile"
      ? PROFILE_CURRENT_ORDER_BY
      : "sort_time DESC, updated_at DESC";
    const documents = this.ctx.storage.sql
      .exec<DbDocument>(
        `SELECT id, body, sort_time
         FROM documents
         WHERE collection = ?
         ORDER BY ${orderBy}
         LIMIT ?`,
        collection,
        boundedLimit,
      )
      .toArray()
      .map(toDocument);
    return JSON.stringify(documents);
  }

  async createDocuments(
    collection: DocumentCollection,
    documentsJson: string,
  ): Promise<string> {
    return this.withStorageWrites(() =>
      this.createDocumentsWritable(collection, documentsJson)
    );
  }

  private async createDocumentsWritable(
    collection: DocumentCollection,
    documentsJson: string,
  ): Promise<string> {
    let documents = JSON.parse(documentsJson) as JsonDocument[];
    if (collection === "treatments") {
      const result = await this.createLegacyTreatments(documentsJson);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    }
    if (collection === "profile" || collection === "food") {
      const result = JSON.stringify(
        documents.map((document) =>
          this.documentRepository().createLegacyDocument(
            collection,
            collection === "food"
              ? { ...document, created_at: new Date().toISOString() }
              : document.created_at
                ? document
                : { ...document, created_at: new Date().toISOString() },
          ).document),
      );
      await this.publishRootDataUpdate();
      return result;
    }
    if (collection === "devicestatus") {
      const predictionsMaxSize = parseLegacyPredictionsMaxSize(
        this.env.PREDICTIONS_MAX_SIZE,
      );
      const result = JSON.stringify(
        documents.map((document) =>
          this.documentRepository().createLegacyDocument(
            collection,
            normalizeLegacyDeviceStatusDocument(document, Date.now(), predictionsMaxSize),
          ).document),
      );
      await this.publishRootDataUpdate();
      return result;
    }
    if (collection === "subjects" || collection === "roles") {
      documents = documents.map((document) =>
        Object.prototype.hasOwnProperty.call(document, "created_at")
          ? document
          : { ...document, created_at: new Date().toISOString() }
      );
    }
    if (collection === "activity") {
      documents = documents.map((document) =>
        Object.prototype.hasOwnProperty.call(document, "created_at")
          ? document
          : { ...document, created_at: new Date().toISOString() }
      );
    }
    if (collection === "subjects") {
      await this.ensureAuthorizationSubjectsCurrent();
      const derived: JsonDocument[] = [];
      for (const document of documents) {
        const id = typeof document._id === "string" ? document._id : randomObjectId();
        const subject = await this.deriveAuthorizationSubject({ ...document, _id: id });
        if (subject === null) throw new Error("cannot derive subject access token");
        derived.push(subject);
      }
      documents = derived;
      const now = Date.now();
      const stored = documents.map((document) => {
        const id = document._id as string;
        return { ...document, _id: id };
      });
      this.ctx.storage.transactionSync(() => {
        const currentCount = this.ctx.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM documents WHERE collection = 'subjects'",
        ).one().count;
        if (currentCount + stored.length > AUTHORIZATION_SUBJECT_LIMIT) {
          throw new Error(
            `authorization subject limit ${AUTHORIZATION_SUBJECT_LIMIT} exceeded`,
          );
        }
        for (const document of stored) {
          const id = document._id as string;
          this.ctx.storage.sql.exec(
            `INSERT INTO documents (collection, id, body, sort_time, created_at, updated_at)
             VALUES ('subjects', ?, ?, ?, ?, ?)`,
            id,
            JSON.stringify(document),
            documentSortTime(document),
            now,
            now,
          );
        }
        this.ctx.storage.sql.exec(
          "DELETE FROM tenant_secrets WHERE name = 'authorization-subject-marker'",
        );
      });
      return JSON.stringify(stored.map(publicAuthorizationSubjectMutation));
    }
    const now = Date.now();
    const stored: JsonDocument[] = [];
    for (const document of documents) {
      const id = typeof document._id === "string" ? document._id : randomObjectId();
      const normalized = { ...document, _id: id };
      this.ctx.storage.sql.exec(
        `INSERT INTO documents (collection, id, body, sort_time, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        collection,
        id,
        JSON.stringify(normalized),
        documentSortTime(normalized),
        now,
        now,
      );
      stored.push(normalized);
    }
    if (collection === "activity") await this.publishRootDataUpdate();
    return JSON.stringify(stored);
  }

  async createLegacyTreatments(
    documentsJson: string,
  ): Promise<LegacyTreatmentCreateResult> {
    return this.createLegacyTreatmentsWithUuidHandling(documentsJson, true);
  }

  async createLegacyTreatmentsWithUuidHandling(
    documentsJson: string,
    uuidHandling: boolean,
  ): Promise<LegacyTreatmentCreateResult> {
    this.requireStorageWrites();
    let result: LegacyTreatmentCreateResult;
    try {
      const documents = JSON.parse(documentsJson) as JsonDocument[];
      result = {
        ok: true,
        value: JSON.stringify(
          documents.flatMap((document) =>
            this.documentRepository()
              .createLegacyTreatmentBundle(document, uuidHandling)
              .map((mutation) => mutation.document)),
        ),
      };
    } catch (error) {
      if (this.enterStorageWriteQuotaMode(error) || isDurableObjectReadQuotaError(error)) throw error;
      // Keep expected storage/normalization failures inside the RPC boundary;
      // the HTTP adapter emits the public legacy error without an unhandled DO
      // rejection or leaking internal SQLite details.
      result = { ok: false, error: "Treatment storage failure" };
    }
    await this.publishRootDataUpdate();
    return result;
  }

  async saveDocuments(
    collection: DocumentCollection,
    documentsJson: string,
  ): Promise<string> {
    return this.withStorageWrites(() =>
      this.saveDocumentsWritable(collection, documentsJson)
    );
  }

  private async saveDocumentsWritable(
    collection: DocumentCollection,
    documentsJson: string,
  ): Promise<string> {
    let documents = JSON.parse(documentsJson) as JsonDocument[];
    if (collection === "treatments") {
      return this.saveLegacyTreatmentsWithUuidHandling(documentsJson, true);
    }
    if (collection === "profile" || collection === "food") {
      const result = JSON.stringify(
        documents.map((document) =>
          this.documentRepository().saveLegacyDocument(
            collection,
            Object.prototype.hasOwnProperty.call(document, "created_at")
              ? document
              : { ...document, created_at: new Date().toISOString() },
          ).document),
      );
      await this.publishRootDataUpdate();
      return result;
    }
    if (collection === "devicestatus") {
      const result = JSON.stringify(
        documents.map((document) =>
          this.documentRepository().saveLegacyDocument(collection, document).document),
      );
      await this.publishRootDataUpdate();
      return result;
    }
    if (collection === "subjects" || collection === "roles") {
      documents = documents.map((document) =>
        document.created_at
          ? document
          : { ...document, created_at: new Date().toISOString() }
      );
    }
    if (collection === "activity") {
      documents = documents.map((document) => ({
        ...document,
        _id: legacyStorageSaveObjectId(document._id),
        ...(Object.prototype.hasOwnProperty.call(document, "created_at")
          ? {}
          : { created_at: new Date().toISOString() }),
      }));
    }
    if (collection === "subjects") {
      await this.ensureAuthorizationSubjectsCurrent();
      const derived: JsonDocument[] = [];
      for (const document of documents) {
        const subject = await this.deriveAuthorizationSubject(document);
        if (subject === null) throw new Error("cannot derive subject access token");
        derived.push(subject);
      }
      documents = derived;
      const now = Date.now();
      this.ctx.storage.transactionSync(() => {
        const currentCount = this.ctx.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM documents WHERE collection = 'subjects'",
        ).one().count;
        const ids = Array.from(new Set(documents.map((document) => document._id as string)));
        let insertedByUpsert = 0;
        for (const id of ids) {
          const exists = this.ctx.storage.sql.exec<{ found: number }>(
            `SELECT 1 AS found FROM documents
             WHERE collection = 'subjects' AND id = ? LIMIT 1`,
            id,
          ).toArray()[0];
          if (exists === undefined) insertedByUpsert += 1;
        }
        if (currentCount + insertedByUpsert > AUTHORIZATION_SUBJECT_LIMIT) {
          throw new Error(
            `authorization subject limit ${AUTHORIZATION_SUBJECT_LIMIT} exceeded`,
          );
        }
        for (const document of documents) {
          const id = document._id as string;
          this.ctx.storage.sql.exec(
            `INSERT INTO documents (collection, id, body, sort_time, created_at, updated_at)
             VALUES ('subjects', ?, ?, ?, ?, ?)
             ON CONFLICT(collection, id) DO UPDATE SET
               body = excluded.body,
               sort_time = excluded.sort_time,
               updated_at = excluded.updated_at`,
            id,
            JSON.stringify(document),
            documentSortTime(document),
            now,
            now,
          );
        }
        this.ctx.storage.sql.exec(
          "DELETE FROM tenant_secrets WHERE name = 'authorization-subject-marker'",
        );
      });
      return JSON.stringify(documents.map(publicAuthorizationSubjectMutation));
    }
    const now = Date.now();
    for (const document of documents) {
      const id = document._id as string;
      this.ctx.storage.sql.exec(
        `INSERT INTO documents (collection, id, body, sort_time, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(collection, id) DO UPDATE SET
           body = excluded.body,
           sort_time = excluded.sort_time,
           updated_at = excluded.updated_at`,
        collection,
        id,
        JSON.stringify(document),
        documentSortTime(document),
        now,
        now,
      );
    }
    if (collection === "activity") await this.publishRootDataUpdate();
    return JSON.stringify(documents);
  }

  async saveLegacyTreatmentsWithUuidHandling(
    documentsJson: string,
    uuidHandling: boolean,
  ): Promise<string> {
    return this.withStorageWrites(async () => {
      const documents = JSON.parse(documentsJson) as JsonDocument[];
      const result = JSON.stringify(
        documents.map((document) =>
          this.documentRepository().upsertTreatment(document, uuidHandling).document),
      );
      await this.publishRootDataUpdate();
      return result;
    });
  }

  async deleteDocuments(collection: DocumentCollection, ids: string[]): Promise<number> {
    return this.withStorageWrites(() =>
      this.deleteDocumentsWritable(collection, ids)
    );
  }

  private async deleteDocumentsWritable(
    collection: DocumentCollection,
    ids: string[],
  ): Promise<number> {
    if (
      collection === "treatments"
      || collection === "devicestatus"
      || collection === "food"
      || collection === "profile"
    ) {
      let deleted = 0;
      for (const id of ids) {
        if (this.documentRepository().deleteDocumentById(collection, id)) deleted += 1;
      }
      await this.publishRootDataUpdate();
      return deleted;
    }
    let deleted = 0;
    for (const id of ids) {
      deleted += this.ctx.storage.sql
        .exec("DELETE FROM documents WHERE collection = ? AND id = ?", collection, id).rowsWritten;
    }
    if (collection === "activity") await this.publishRootDataUpdate();
    return deleted;
  }

  async findDocumentByField(
    collection: DocumentCollection,
    field: string,
    expected: string,
  ): Promise<string | null> {
    if (collection === "treatments") {
      const found = field === "_id"
        ? this.documentRepository().findTreatmentById(expected)
        : field === "identifier"
          ? this.documentRepository().findTreatmentByIdentifier(expected)
          : this.documentRepository().queryTreatments({
            filters: [{ field, operator: "eq", value: expected }],
            limit: 1,
          })[0] ?? null;
      return found === null ? null : JSON.stringify(found);
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(field)) throw new Error("invalid document field");
    const row = field === "_id"
      ? this.ctx.storage.sql.exec<DbDocument>(
        `SELECT id, body, sort_time FROM documents
         WHERE collection = ? AND id = ? LIMIT 1`,
        collection,
        expected,
      ).toArray()[0]
      : this.ctx.storage.sql.exec<DbDocument>(
        `SELECT id, body, sort_time FROM documents
         WHERE collection = ? AND json_extract(body, ?) = ? LIMIT 1`,
        collection,
        `$.${field}`,
        expected,
      ).toArray()[0];
    const found = row === undefined ? undefined : toDocument(row);
    return found === undefined ? null : JSON.stringify(found);
  }

  async findTreatmentById(id: string, includeDeleted = false): Promise<string | null> {
    const document = this.documentRepository().findTreatmentById(id, includeDeleted);
    return document === null ? null : JSON.stringify(document);
  }

  async findTreatmentByIdentifier(
    identifier: string,
    includeDeleted = false,
  ): Promise<string | null> {
    const document = this.documentRepository().findTreatmentByIdentifier(identifier, includeDeleted);
    return document === null ? null : JSON.stringify(document);
  }

  async findTreatmentForApi3Read(
    identifier: string,
    fieldsJson: string,
  ): Promise<string | null> {
    return this.findApi3Document("treatments", identifier, fieldsJson);
  }

  async findTreatmentByFallback(
    createdAt: string | number,
    eventType: string | number,
    includeDeleted = false,
  ): Promise<string | null> {
    const document = this.documentRepository().findTreatmentByFallback(
      createdAt,
      eventType,
      includeDeleted,
    );
    return document === null ? null : JSON.stringify(document);
  }

  async queryTreatments(queryJson = "{}"): Promise<string> {
    const query = JSON.parse(queryJson) as DocumentQuery;
    return JSON.stringify(this.documentRepository().queryTreatments(query));
  }

  async findApi3Document(
    collection: Api3CollectionName,
    identifier: string,
    fieldsJson: string,
  ): Promise<string | null> {
    const parsed = JSON.parse(fieldsJson) as string[] | null;
    const document = this.documentRepository().findDocumentForApi3Read(
      collection,
      identifier,
      parsed ?? undefined,
    );
    return document === null ? null : JSON.stringify(document);
  }

  async api3QueryCollection(
    collection: Api3CollectionName,
    queryJson = "{}",
  ): Promise<string> {
    try {
      const query = JSON.parse(queryJson) as DocumentQuery;
      return JSON.stringify({
        ok: true,
        result: this.documentRepository().queryDocumentsForApi3(collection, query),
      });
    } catch (error) {
      if (isDurableObjectReadQuotaError(error)) throw error;
      return JSON.stringify({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof DocumentQueryError
          ? { status: error.code === "QUERY_SCAN_LIMIT" ? 413 : 400 }
          : {}),
      });
    }
  }

  async api3CreateDocument(
    collection: Api3CollectionName,
    documentJson: string,
    optionsJson: string,
  ): Promise<string> {
    this.requireStorageWrites();
    const document = JSON.parse(documentJson) as JsonDocument;
    const options = JSON.parse(optionsJson) as Api3MutationOptions;
    let result: string;
    try {
      result = JSON.stringify(
        this.withDeviceStatusCacheMutation(collection, () =>
          this.documentRepository().createDocumentForApi3(collection, document, options)),
      );
    } catch (error) {
      if (this.enterStorageWriteQuotaMode(error) || isDurableObjectReadQuotaError(error)) throw error;
      result = JSON.stringify({
        ok: false,
        reason: "operation-error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await this.flushRealtimeMutation();
    return result;
  }

  async api3ReplaceDocument(
    collection: Api3CollectionName,
    identity: string,
    documentJson: string,
    optionsJson: string,
  ): Promise<string> {
    this.requireStorageWrites();
    const document = JSON.parse(documentJson) as JsonDocument;
    const options = JSON.parse(optionsJson) as Api3MutationOptions;
    let result: string;
    try {
      result = JSON.stringify(
        this.documentRepository().replaceDocumentForApi3(
          collection,
          identity,
          document,
          options,
        ),
      );
    } catch (error) {
      if (this.enterStorageWriteQuotaMode(error) || isDurableObjectReadQuotaError(error)) throw error;
      result = JSON.stringify({
        ok: false,
        reason: "operation-error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await this.flushRealtimeMutation();
    return result;
  }

  async api3PatchDocument(
    collection: Api3CollectionName,
    identity: string,
    patchJson: string,
    optionsJson: string,
  ): Promise<string> {
    this.requireStorageWrites();
    const patch = JSON.parse(patchJson) as JsonDocument;
    const options = JSON.parse(optionsJson) as Api3MutationOptions;
    let result: string;
    try {
      result = JSON.stringify(
        this.documentRepository().patchDocumentForApi3(
          collection,
          identity,
          patch,
          options,
        ),
      );
    } catch (error) {
      if (this.enterStorageWriteQuotaMode(error) || isDurableObjectReadQuotaError(error)) throw error;
      result = JSON.stringify({
        ok: false,
        reason: "operation-error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    await this.flushRealtimeMutation();
    return result;
  }

  async api3DeleteDocument(
    collection: Api3CollectionName,
    identity: string,
    permanent: boolean,
    actor: string | null,
  ): Promise<DocumentDeleteResult> {
    this.requireStorageWrites();
    let result: DocumentDeleteResult;
    try {
      result = this.documentRepository().deleteDocumentForApi3(
        collection,
        identity,
        permanent,
        actor,
      );
    } catch (error) {
      if (this.enterStorageWriteQuotaMode(error) || isDurableObjectReadQuotaError(error)) throw error;
      // Keep application-level validation failures inside the typed DO RPC
      // contract. Letting a known read-only rejection escape the Durable
      // Object produces an uncaught RPC exception even when the outer Worker
      // can translate it to an HTTP response.
      result = {
        deleted: false,
        permanent,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await this.flushRealtimeMutation();
    return result;
  }

  async api3CollectionLastModified(
    collection: Api3CollectionName,
  ): Promise<number | null> {
    return this.documentRepository().collectionLastModified(collection);
  }

  async api3CollectionHistory(
    collection: Api3CollectionName,
    queryJson: string,
  ): Promise<string> {
    const query = JSON.parse(queryJson) as DocumentHistoryQuery;
    return JSON.stringify(this.documentRepository().documentHistory(collection, query));
  }

  async api3QueryTreatments(queryJson = "{}"): Promise<string> {
    return this.api3QueryCollection("treatments", queryJson);
  }

  async queryLegacyTreatments(queryJson = "{}"): Promise<string> {
    return this.queryLegacyTreatmentsWithUuidHandling(queryJson, true);
  }

  async queryLegacyDocumentsJson(
    collection: Api3CollectionName,
    queryJson = "{}",
  ): Promise<string> {
    try {
      const query = JSON.parse(queryJson) as DocumentQuery;
      return JSON.stringify({
        ok: true,
        result: this.documentRepository().queryLegacyDocuments(collection, query),
      });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof DocumentQueryError
          ? { status: error.code === "QUERY_SCAN_LIMIT" ? 413 : 400 }
          : {}),
      });
    }
  }

  async queryLegacyTreatmentsWithUuidHandling(
    queryJson: string,
    uuidHandling: boolean,
  ): Promise<string> {
    const query = JSON.parse(queryJson) as DocumentQuery;
    query.legacyUuidHandling = uuidHandling;
    return JSON.stringify(this.documentRepository().queryLegacyTreatments(query));
  }

  async upsertTreatment(documentJson: string): Promise<string> {
    const document = JSON.parse(documentJson) as JsonDocument;
    const result = JSON.stringify(this.documentRepository().upsertTreatment(document));
    await this.publishRootDataUpdate();
    return result;
  }

  async createTreatment(documentJson: string): Promise<string> {
    const document = JSON.parse(documentJson) as JsonDocument;
    const result = JSON.stringify(this.documentRepository().createTreatment(document));
    await this.publishRootDataUpdate();
    return result;
  }

  async api3CreateTreatment(
    documentJson: string,
    optionsJson: string,
  ): Promise<string> {
    return this.api3CreateDocument("treatments", documentJson, optionsJson);
  }

  async replaceTreatment(
    identity: string,
    documentJson: string,
  ): Promise<string> {
    const document = JSON.parse(documentJson) as JsonDocument;
    const result = JSON.stringify(this.documentRepository().replaceTreatment(identity, document));
    await this.publishRootDataUpdate();
    return result;
  }

  async api3ReplaceTreatment(
    identity: string,
    documentJson: string,
    optionsJson: string,
  ): Promise<string> {
    return this.api3ReplaceDocument("treatments", identity, documentJson, optionsJson);
  }

  async patchTreatment(
    identity: string,
    patchJson: string,
  ): Promise<string | null> {
    const patch = JSON.parse(patchJson) as JsonDocument;
    const result = this.documentRepository().patchTreatment(identity, patch);
    await this.publishRootDataUpdate();
    return result === null ? null : JSON.stringify(result);
  }

  async api3PatchTreatment(
    identity: string,
    patchJson: string,
    optionsJson: string,
  ): Promise<string> {
    return this.api3PatchDocument("treatments", identity, patchJson, optionsJson);
  }

  async deleteTreatment(identity: string, permanent = false): Promise<DocumentDeleteResult> {
    const result = this.documentRepository().deleteTreatment(identity, permanent);
    await this.publishRootDataUpdate();
    return result;
  }

  async api3DeleteTreatment(
    identity: string,
    permanent: boolean,
    actor: string | null,
  ): Promise<DocumentDeleteResult> {
    return this.api3DeleteDocument("treatments", identity, permanent, actor);
  }

  async deleteLegacyTreatment(identity: string): Promise<boolean> {
    return this.deleteLegacyTreatmentWithUuidHandling(identity, true);
  }

  async deleteLegacyTreatmentWithUuidHandling(
    identity: string,
    uuidHandling: boolean,
  ): Promise<boolean> {
    const deleted = this.documentRepository().deleteLegacyTreatment(identity, uuidHandling);
    await this.publishRootDataUpdate();
    return deleted;
  }

  async treatmentsLastModified(): Promise<number | null> {
    return this.api3CollectionLastModified("treatments");
  }

  async treatmentHistory(queryJson: string): Promise<string> {
    return this.api3CollectionHistory("treatments", queryJson);
  }
}
