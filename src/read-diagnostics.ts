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
const MAX_CURSORS = 128;
const MAX_SHAPES = 8;
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
const context = new AsyncLocalStorage<Frame>();
const installed = new WeakMap<SqlStorage, SqlStorage["exec"]>();

export function isDiagnosticReadOperation(operation: unknown): operation is string {
  return typeof operation === "string" && OPERATIONS.has(operation);
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
    const frame = context.getStore();
    if (frame === undefined || frame.closed || frame.sql !== sql || frame.insideExec) return original(statement, ...bindings);
    frame.calls++;
    frame.insideExec = true;
    try {
      const cursor = original(statement, ...bindings);
      if (frame.cursors.length < MAX_CURSORS) frame.cursors.push({ cursor, shape: sqlShape(statement) });
      else frame.dropped++;
      return cursor;
    } catch (error) { frame.errors++; throw error; }
    finally { frame.insideExec = false; }
  }) as SqlStorage["exec"];
  try {
    sql.exec = wrapped;
    if (sql.exec !== wrapped) return false;
    installed.set(sql, wrapped);
    return true;
  } catch { return false; }
}

function measurement(frame: Frame): ReadMeasurement {
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
  return { scope: "rpc-body-excludes-activation", rowsRead, rowsWritten,
    sqlCalls: frame.calls, sqlErrors: frame.errors, complete,
    wallMs: Math.max(0, Math.round((performance.now() - frame.started) * 1000) / 1000),
    shapes: [...shapes.values()].sort((a, b) => b.reads - a.reads).slice(0, MAX_SHAPES) };
}

function emit(record: unknown): void {
  // Diagnostic output must not turn a successful request into a failure.
  try { console.info(JSON.stringify(record)); } catch { /* logging is optional */ }
}

export async function measureDiagnosticRead<T>(sql: SqlStorage, operation: string,
  call: () => T | Promise<T>, traceId: string): Promise<DiagnosticReadResult<T>> {
  if (!isDiagnosticReadOperation(operation)) throw new Error("Unsupported diagnostic read operation");
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
  measurements: { operation: string; measurement: ReadMeasurement }[];
  finish(status: number): void;
}

export function startReadRequestTrace(request: Request): ReadRequestTrace {
  const url = new URL(request.url), started = performance.now();
  const label = route(url.pathname), shape = queryShape(url);
  const method = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(request.method) ? request.method : "OTHER";
  const trace: ReadRequestTrace = { id: crypto.randomUUID(), completed: false,
    calls: 0, attempts: 0, pending: 0, unmeasured: 0, failures: 0, measurements: [],
    finish(status) {
      trace.completed = true;
      emit({ event: "nscf_read_request", trace: trace.id, route: label, method, shape, status,
        scope: "awaited-rpc-bodies-excludes-activation-and-background", rpcCalls: trace.calls,
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

function missingDiagnosticMethod(error: unknown): boolean {
  return error instanceof Error && /^RPC receiver does not implement the method "diagnosticRead"\.?$/.test(error.message);
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
          if (!isDiagnosticReadOperation(property)) {
            trace.unmeasured++; trace.attempts++;
            return await Reflect.apply(original, target, args);
          }
          const diagnostic = Reflect.get(target, "diagnosticRead", target) as RpcFunction | undefined;
          if (typeof diagnostic !== "function") {
            trace.unmeasured++; trace.attempts++;
            return await Reflect.apply(original, target, args);
          }
          let result: DiagnosticReadResult;
          try {
            trace.attempts++;
            result = await Reflect.apply(diagnostic, target, [property, args, trace.id]) as DiagnosticReadResult;
          } catch (error) {
            if (!missingDiagnosticMethod(error)) throw error;
            trace.unmeasured++; trace.attempts++;
            return await Reflect.apply(original, target, args);
          }
          if (!trace.completed && trace.measurements.length < 128) trace.measurements.push({ operation: property, measurement: result.measurement });
          else trace.unmeasured++;
          return result.value;
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
