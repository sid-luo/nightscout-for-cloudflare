import { AsyncLocalStorage } from "node:async_hooks";

// Explicitly enabled for a short investigation; no counters are persisted.
const OPERATIONS = new Set([
  "resolveHttpAuthorizationJson", "verifyAccessJwt", "listAuthorizationSubjects",
  "getEntries", "getEntriesJson", "getLegacyEntriesResponseJson", "countLegacyDocumentsJson",
  "getSgvEntries", "getDdataSnapshotJson", "getPluginPropertyContextJson",
  "getPluginPropertyResponseJson", "getEntryById", "getCurrent",
  "getLegacyDeviceStatusQueryJson", "getLegacyDeviceStatusJson", "listDocuments",
  "getLegacyProfileCurrentJson",
  "findDocumentByField", "findTreatmentById", "findTreatmentByIdentifier",
  "findTreatmentForApi3Read", "findTreatmentByFallback", "queryTreatments",
  "findApi3Document", "api3QueryCollection", "api3CollectionLastModified",
  "api3CollectionHistory", "api3QueryTreatments", "queryLegacyTreatments",
  "queryLegacyDocumentsJson", "queryLegacyTreatmentsWithUuidHandling",
  "treatmentsLastModified", "treatmentHistory", "nightscoutHttpStatus",
]);
// These RPCs already exist on EntryStore. Dispatch remains explicit: neither
// arguments nor arbitrary property names become diagnostic labels or targets.
const MUTATION_OPERATIONS = new Set([
  "createAuthorizationSubjects", "saveAuthorizationSubjects", "authorizationFailed", "authorizationSucceeded",
  "issueAccessJwt", "putEntries", "putEntriesJson", "deleteEntries",
  "createDocuments", "saveDocuments", "deleteDocuments", "maintenanceDelete",
  "createLegacyTreatments", "createLegacyTreatmentsWithUuidHandling", "saveLegacyTreatmentsWithUuidHandling",
  "api3CreateDocument", "api3ReplaceDocument", "api3PatchDocument", "api3DeleteDocument",
  "upsertTreatment", "createTreatment", "api3CreateTreatment", "replaceTreatment", "api3ReplaceTreatment",
  "patchTreatment", "api3PatchTreatment", "deleteTreatment", "api3DeleteTreatment",
  "deleteLegacyTreatment", "deleteLegacyTreatmentWithUuidHandling",
  "publishAlarmNotification", "processAlarmNotificationRequests", "acknowledgeAlarmNotification", "acknowledgePushoverReceipt",
]);
const REALTIME_OPERATIONS = new Set([
  "realtimeHandshake", "realtimeValidateSession", "realtimeBeginPost", "realtimeBeginPostEnvelope",
  "realtimeAbortPost", "realtimeRejectPost", "realtimeSubmitPost", "realtimePoll", "realtimePollEnvelope",
]);
const OTHER_OPERATIONS = new Set(["resolveAuthorizationSubject", "authorizationDelay", "listAdminNotifications"]);
const MAX_CURSORS = 128;
const MAX_SHAPES = 8;
const MAX_STORAGE_DEPTH = 8;
interface CapturedCursor {
  cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
  shape: string;
}
interface Frame {
  sql: SqlStorage;
  cursors: CapturedCursor[];
  calls: number;
  errors: number;
  dropped: number;
  insideExec: boolean;
  installed: boolean;
  closed: boolean;
  started: number;
}
export interface ReadMeasurement {
  scope: "rpc-body-excludes-activation";
  rowsRead: number;
  rowsWritten: number;
  sqlCalls: number;
  sqlErrors: number;
  complete: boolean;
  wallMs: number;
  shapes: { id: string; reads: number; writes: number; calls: number }[];
}
export interface DiagnosticReadResult<T = unknown> {
  value: T;
  measurement: ReadMeasurement;
}
export type DiagnosticStorageResult<T = unknown> =
  | ({ ok: true } & DiagnosticReadResult<T>)
  | { ok: false; error: unknown };
const context = new AsyncLocalStorage<Frame>();
export type StorageDiagnosticPhase = "activation" | "rpc" | "alarm" | "websocket" | "notification" | "background";
export type StorageDiagnosticOperation = "read" | "write" | "realtime" | "other";
interface StorageFrame extends Frame {
  id: string;
  parent: string | null;
  trace: string | null;
  phase: StorageDiagnosticPhase;
  operation: StorageDiagnosticOperation;
  depth: number;
  omittedScopes: number;
}
const storageContext = new AsyncLocalStorage<StorageFrame>();
const installed = new WeakMap<SqlStorage, SqlStorage["exec"]>();

export function isDiagnosticReadOperation(operation: unknown): operation is string {
  return typeof operation === "string" && OPERATIONS.has(operation);
}

export function isDiagnosticStorageOperation(operation: unknown): operation is string {
  return typeof operation === "string" && (OPERATIONS.has(operation) || MUTATION_OPERATIONS.has(operation)
    || REALTIME_OPERATIONS.has(operation) || OTHER_OPERATIONS.has(operation));
}

export function diagnosticStorageOperationKind(operation: unknown): StorageDiagnosticOperation {
  if (typeof operation !== "string") return "other";
  return OPERATIONS.has(operation) ? "read" : MUTATION_OPERATIONS.has(operation) ? "write"
    : REALTIME_OPERATIONS.has(operation) ? "realtime" : "other";
}

function fingerprint(text: string): string {
  let value = 0x811c9dc5;
  for (let n = 0; n < text.length; n++) value = Math.imul(value ^ text.charCodeAt(n), 0x01000193);
  return (value >>> 0).toString(16).padStart(8, "0");
}

function sqlShape(sql: string): string {
  // Hash only a shape. Never retain bindings, SQL literals or complete SQL.
  return fingerprint(sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ").slice(0, 65_536));
}

function install(sql: SqlStorage): boolean {
  if (installed.get(sql) === sql.exec) return true;
  const original = sql.exec.bind(sql);
  const wrapped = ((statement: string, ...bindings: SqlStorageValue[]) => {
    // HTTP read measurements are inclusive. Storage scope measurements assign
    // each SQL call only to the innermost active scope. They are separate views
    // of the same cursor, and must never be summed with each other.
    const frames = [context.getStore(), storageContext.getStore()]
      .filter((frame): frame is Frame => frame !== undefined && !frame.closed && frame.sql === sql && !frame.insideExec);
    if (frames.length === 0) return original(statement, ...bindings);
    for (const frame of frames) { frame.calls++; frame.insideExec = true; }
    try {
      const cursor = original(statement, ...bindings);
      const shape = frames.some(frame => frame.cursors.length < MAX_CURSORS) ? sqlShape(statement) : "";
      for (const frame of frames) {
        if (frame.cursors.length < MAX_CURSORS) frame.cursors.push({ cursor, shape });
        else frame.dropped++;
      }
      return cursor;
    } catch (error) { for (const frame of frames) frame.errors++; throw error; }
    finally { for (const frame of frames) frame.insideExec = false; }
  }) as SqlStorage["exec"];
  try {
    sql.exec = wrapped;
    if (sql.exec !== wrapped) return false;
    installed.set(sql, wrapped);
    return true;
  } catch { return false; }
}

function counts(frame: Frame) {
  let rowsRead = 0, rowsWritten = 0;
  let complete = frame.installed && frame.dropped === 0 && frame.errors === 0;
  const shapes = new Map<string, { id: string; reads: number; writes: number; calls: number }>();
  for (const { cursor, shape } of frame.cursors) {
    try {
      const reads = cursor.rowsRead, writes = cursor.rowsWritten;
      if (!Number.isFinite(reads) || !Number.isFinite(writes)) { complete = false; continue; }
      rowsRead += reads; rowsWritten += writes;
      const item = shapes.get(shape) ?? { id: shape, reads: 0, writes: 0, calls: 0 };
      item.reads += reads; item.writes += writes; item.calls++;
      shapes.set(shape, item);
    } catch { complete = false; }
  }
  return { rowsRead, rowsWritten,
    sqlCalls: frame.calls, sqlErrors: frame.errors, complete,
    wallMs: Math.max(0, Math.round((performance.now() - frame.started) * 1000) / 1000),
    shapes: [...shapes.values()].sort((a, b) => b.reads - a.reads).slice(0, MAX_SHAPES),
    shapesTruncated: shapes.size > MAX_SHAPES };
}

function measurement(frame: Frame): ReadMeasurement {
  const { shapesTruncated: _shapesTruncated, ...metrics } = counts(frame);
  return { scope: "rpc-body-excludes-activation", ...metrics };
}

function emit(record: unknown): void {
  // Diagnostic output must not turn a successful request into a failure.
  try { console.info(JSON.stringify(record)); } catch { /* logging is optional */ }
}

function closeStorageFrame(frame: StorageFrame, success: boolean): void {
  try {
    const metrics = counts(frame);
    emit({ event: "nscf_storage_scope", id: frame.id, parent: frame.parent, trace: frame.trace,
      phase: frame.phase, operation: frame.operation, success,
      scope: "exclusive-sql-in-callback-excludes-child-scopes-and-post-callback",
      aggregation: "do-not-add-inclusive-http-rpc-measurements",
      sampling: "application-emits-all-platform-may-sample",
      exclusions: "kv-alarm-apis-and-platform-internals", ...metrics,
      complete: frame.omittedScopes === 0 && metrics.complete,
      omittedScopes: frame.omittedScopes, droppedSqlCalls: frame.dropped });
  } catch {
    // Instrumentation must not replace an original result or error.
  } finally {
    frame.closed = true;
    frame.cursors.length = 0;
  }
}

/** Temporary opt-in, SQL-only event attribution. Preserves sync return values
 * and original errors; Promise callbacks close their scope after settlement.
 * Parent scopes exclude nested scopes. They do not absorb unfinished tasks.
 */
export function withStorageDiagnostics<T>(sql: SqlStorage, enabled: unknown, phase: StorageDiagnosticPhase,
  call: () => T, operation: StorageDiagnosticOperation = "other", traceId?: string): T {
  if (enabled !== "1") return call();
  const parent = storageContext.getStore();
  if (parent !== undefined && !parent.closed && parent.depth >= MAX_STORAGE_DEPTH) {
    parent.omittedScopes++;
    return call();
  }
  const frame: StorageFrame = { sql, cursors: [], calls: 0, errors: 0, dropped: 0,
    insideExec: false, installed: install(sql), closed: false, started: performance.now(),
    id: crypto.randomUUID(), parent: parent?.closed === false ? parent.id : null,
    trace: typeof traceId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(traceId)
      ? traceId.toLowerCase() : parent?.closed === false ? parent.trace : null,
    phase: ["activation", "rpc", "alarm", "websocket", "notification", "background"].includes(phase) ? phase : "rpc",
    operation: ["read", "write", "realtime", "other"].includes(operation) ? operation : "other",
    depth: parent?.closed === false ? parent.depth + 1 : 1, omittedScopes: 0 };
  return storageContext.run(frame, () => {
    let result: T;
    try { result = call(); }
    catch (error) { closeStorageFrame(frame, false); throw error; }
    if (result instanceof Promise) {
      return Promise.resolve(result).then(value => { closeStorageFrame(frame, true); return value; },
        error => { closeStorageFrame(frame, false); throw error; }) as T;
    }
    closeStorageFrame(frame, true);
    return result;
  });
}

export async function measureDiagnosticRead<T>(sql: SqlStorage, operation: string,
  call: () => T | Promise<T>, traceId: string): Promise<DiagnosticReadResult<T>> {
  if (!isDiagnosticReadOperation(operation)) throw new Error("Unsupported diagnostic read operation");
  return measureRpc(sql, operation, call, traceId);
}

export async function measureDiagnosticStorageOperation<T>(sql: SqlStorage, operation: string,
  call: () => T | Promise<T>, traceId: string): Promise<DiagnosticStorageResult<T>> {
  if (!isDiagnosticStorageOperation(operation)) throw new Error("Unsupported diagnostic storage operation");
  // A business action can throw the same text as a transport missing-method
  // error after it has already committed a write. Return action failures by
  // value so the caller never mistakes them for permission to replay it.
  try { return { ok: true, ...await measureRpc(sql, operation, call, traceId) }; }
  catch (error) { return { ok: false, error }; }
}

async function measureRpc<T>(sql: SqlStorage, operation: string,
  call: () => T | Promise<T>, traceId: string): Promise<DiagnosticReadResult<T>> {
  const frame: Frame = { sql, cursors: [], calls: 0, errors: 0, dropped: 0,
    insideExec: false, installed: install(sql), closed: false, started: performance.now() };
  return context.run(frame, async () => {
    try { return { value: await call(), measurement: measurement(frame) }; }
    catch (error) {
      emit({ event: "nscf_read_rpc_failure", trace: /^[a-f0-9-]{36}$/.test(traceId) ? traceId : "untracked",
        operation, measurement: measurement(frame) });
      throw error;
    }
    finally {
      // Descendant tasks may retain ALS context after the awaited read ends.
      // Stop capture and release native cursor references at that boundary.
      frame.closed = true;
      frame.cursors.length = 0;
    }
  });
}

function route(path: string): string {
  if (/^\/api\/v2\/authorization\/request\//.test(path)) return "/api/v2/authorization/request/:credential";
  const matched = /^\/api\/(v[123])\/(entries|devicestatus|treatments|profile|profiles|activity|food|properties|status|authorization|ddata|admin)(?:\.json)?(\/.*)?$/.exec(path);
  if (matched === null) return path === "/pebble" ? "/pebble" : "/other";
  const suffix = matched[3];
  return `/api/${matched[1]}/${matched[2]}${suffix === undefined || suffix === "/" ? "" : suffix === "/current" || suffix === "/current.json" ? "/current" : "/:resource"}`;
}

function queryShape(url: URL): string {
  // Values, tokens, tenant names and arbitrary URL paths never enter a log.
  const keys = [...url.searchParams.keys()].filter(key => !/token|secret|auth|tenant/i.test(key)).sort().slice(0, 64);
  return fingerprint(keys.map(key => key.slice(0, 128)).join("|"));
}

type RpcFunction = (...args: unknown[]) => unknown;
export interface ReadRequestTrace {
  id: string;
  completed: boolean;
  calls: number;
  attempts: number;
  pending: number;
  unmeasured: number;
  failures: number;
  hasNonReadRpc: boolean;
  measurements: { operation: string; measurement: ReadMeasurement }[];
  finish(status: number): void;
}

export function startReadRequestTrace(request: Request): ReadRequestTrace {
  const url = new URL(request.url), started = performance.now();
  const label = route(url.pathname), shape = queryShape(url);
  const method = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(request.method) ? request.method : "OTHER";
  const trace: ReadRequestTrace = { id: crypto.randomUUID(), completed: false,
    calls: 0, attempts: 0, pending: 0, unmeasured: 0, failures: 0, hasNonReadRpc: false, measurements: [],
    finish(status) {
      trace.completed = true;
      emit({ event: "nscf_read_request", trace: trace.id, route: label, method, shape, status,
        // Keep the historical read-only label. A mutation/realtime body can
        // itself await background notification work, which is included here.
        scope: trace.hasNonReadRpc ? "awaited-rpc-bodies-excludes-activation-and-detached-work"
          : "awaited-rpc-bodies-excludes-activation-and-background", rpcCalls: trace.calls,
        sampling: "application-emits-all-platform-may-sample",
        aggregation: "inclusive-rpc-bodies-do-not-add-storage-scope-measurements",
        rpcAttempts: trace.attempts, pendingRpcCalls: trace.pending,
        unmeasuredRpcCalls: trace.unmeasured, failedRpcCalls: trace.failures,
        rowsRead: trace.measurements.reduce((sum, item) => sum + item.measurement.rowsRead, 0),
        rowsWritten: trace.measurements.reduce((sum, item) => sum + item.measurement.rowsWritten, 0),
        complete: trace.pending === 0 && trace.unmeasured === 0 && trace.failures === 0 && trace.measurements.every(item => item.measurement.complete),
        wallMs: Math.max(0, Math.round((performance.now() - started) * 1000) / 1000),
        operations: trace.measurements.slice(0, 32) });
    } };
  return trace;
}

function missingDiagnosticMethod(error: unknown, method: "diagnosticRead" | "diagnosticStorageOperation"): boolean {
  return error instanceof Error && (error.message === `RPC receiver does not implement the method "${method}"`
    || error.message === `RPC receiver does not implement the method "${method}".`);
}

export function diagnosticNamespace<T extends object>(namespace: T, trace: ReadRequestTrace): T {
  const wrapStub = (stub: object): object => new Proxy(stub, {
    get(target, property) {
      const original = Reflect.get(target, property, target) as unknown;
      if (typeof property !== "string" || typeof original !== "function") return original;
      return async (...args: unknown[]) => {
        if (trace.completed) return Reflect.apply(original, target, args);
        trace.calls++;
        trace.pending++;
        try {
          if (!isDiagnosticStorageOperation(property)) {
            trace.unmeasured++; trace.attempts++;
            return await Reflect.apply(original, target, args);
          }
          if (!isDiagnosticReadOperation(property)) trace.hasNonReadRpc = true;
          const method = isDiagnosticReadOperation(property) ? "diagnosticRead" : "diagnosticStorageOperation";
          const diagnostic = Reflect.get(target, method, target) as RpcFunction | undefined;
          if (typeof diagnostic !== "function") {
            trace.unmeasured++; trace.attempts++;
            return await Reflect.apply(original, target, args);
          }
          let result: DiagnosticReadResult | DiagnosticStorageResult;
          try {
            trace.attempts++;
            result = await Reflect.apply(diagnostic, target, [property, args, trace.id]) as DiagnosticReadResult | DiagnosticStorageResult;
          } catch (error) {
            if (!missingDiagnosticMethod(error, method)) throw error;
            trace.unmeasured++; trace.attempts++;
            return await Reflect.apply(original, target, args);
          }
          // Deliberately outside the missing-transport-method catch above.
          if (method === "diagnosticStorageOperation") {
            const response = result as DiagnosticStorageResult;
            if (response.ok === false) throw response.error;
            if (response.ok !== true) throw new Error("Invalid diagnostic storage response");
            result = response;
          }
          const measured = result as DiagnosticReadResult;
          if (!trace.completed && trace.measurements.length < 128) trace.measurements.push({ operation: property, measurement: measured.measurement });
          else trace.unmeasured++;
          return measured.value;
        } catch (error) {
          trace.failures++;
          throw error;
        } finally { trace.pending--; }
      };
    },
  });
  return new Proxy(namespace, { get(target, property) {
    const value = Reflect.get(target, property, target) as unknown;
    if (typeof value !== "function") return value;
    if (property === "get" || property === "getByName") return (...args: unknown[]) => wrapStub(Reflect.apply(value, target, args) as object);
    return (...args: unknown[]) => Reflect.apply(value, target, args);
  } });
}
