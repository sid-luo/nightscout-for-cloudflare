import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  diagnosticNamespace, isDiagnosticStorageOperation, measureDiagnosticRead,
  measureDiagnosticStorageOperation, startReadRequestTrace, withStorageDiagnostics,
  type StorageDiagnosticPhase,
} from "../src/read-diagnostics";

interface ScopeRecord {
  event: string; id: string; parent: string | null; trace: string | null; phase: string; operation: string;
  rowsRead: number; rowsWritten: number; sqlCalls: number; sqlErrors: number;
  complete: boolean; success: boolean; droppedSqlCalls: number; omittedScopes: number;
}

describe("opt-in storage scope attribution", () => {
  it("leaves SQL untouched when disabled and preserves synchronous values", async () => {
    await runInDurableObject(env.ENTRY_STORE.getByName(`storage-off-${crypto.randomUUID()}`), (_instance, state) => {
      const sql = state.storage.sql, original = sql.exec;
      const output = vi.spyOn(console, "info").mockImplementation(() => { throw new Error("must not log"); });
      try {
        const value = { then: () => { throw new Error("must not inspect synchronous value"); } };
        for (const enabled of [undefined, "0", true, 1, "true", " 1"]) {
          expect(withStorageDiagnostics(sql, enabled, "activation", () => value)).toBe(value);
          expect(sql.exec).toBe(original);
        }
        expect(output).not.toHaveBeenCalled();
      } finally { output.mockRestore(); }
    });
  });

  it("assigns nested scopes exclusively while keeping HTTP RPC measurement inclusive", async () => {
    await runInDurableObject(env.ENTRY_STORE.getByName(`storage-nested-${crypto.randomUUID()}`), async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("CREATE TABLE scope_fixture(id INTEGER PRIMARY KEY,value TEXT)");
      sql.exec("INSERT INTO scope_fixture VALUES(1,'first'),(2,'second'),(3,'third')");
      const records: ScopeRecord[] = [];
      const output = vi.spyOn(console, "info").mockImplementation(value => { records.push(JSON.parse(String(value))); });
      try {
        const originalValue = { marker: true };
        const activated = withStorageDiagnostics(sql, "1", "activation", () => {
          sql.exec("SELECT value FROM scope_fixture WHERE id=1").toArray();
          return originalValue;
        });
        expect(activated).toBe(originalValue);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ phase: "activation", parent: null, rowsRead: 1, complete: true });
        let parentReads = 0, childReads = 0, childWrites = 0;
        const traceId = crypto.randomUUID();
        const result = await measureDiagnosticRead(sql, "listDocuments", () => withStorageDiagnostics(sql, "1", "rpc", async () => {
          const first = sql.exec("SELECT value FROM scope_fixture WHERE id=1"); first.toArray(); parentReads += first.rowsRead;
          await withStorageDiagnostics(sql, "1", "notification", async () => {
            const all = sql.exec("SELECT value FROM scope_fixture"); all.toArray(); childReads += all.rowsRead;
            await Promise.resolve();
            const insert = sql.exec("INSERT INTO scope_fixture VALUES(4,'fourth')");
            childReads += insert.rowsRead; childWrites += insert.rowsWritten;
          }, "read");
          const last = sql.exec("SELECT value FROM scope_fixture WHERE id=4"); last.toArray(); parentReads += last.rowsRead;
          return "same-result";
        }, "read", traceId), traceId);
        expect(result.value).toBe("same-result");
        const child = records.find(record => record.phase === "notification")!;
        const parent = records.find(record => record.phase === "rpc")!;
        expect(child).toMatchObject({ parent: parent.id, trace: traceId, rowsRead: childReads, rowsWritten: childWrites, sqlCalls: 2, complete: true });
        expect(parent).toMatchObject({ parent: null, trace: traceId, rowsRead: parentReads, rowsWritten: 0, sqlCalls: 2, complete: true });
        expect(result.measurement).toMatchObject({ rowsRead: parentReads + childReads, rowsWritten: childWrites, sqlCalls: 4, complete: true });
        expect(JSON.stringify(records)).toContain("do-not-add-inclusive-http-rpc-measurements");
        const overlapping = await Promise.all([1, 2].map(limit => withStorageDiagnostics(sql, "1", "websocket", async () => {
          await Promise.resolve();
          const cursor = sql.exec("SELECT value FROM scope_fixture WHERE id<=?", limit); cursor.toArray();
          return cursor.rowsRead;
        }, "realtime")));
        expect(records.filter(record => record.phase === "websocket").map(record => record.rowsRead)).toEqual(overlapping);
      } finally { output.mockRestore(); }
    });
  });

  it("bounds capture, omits late work, and never logs private SQL or original errors", async () => {
    await runInDurableObject(env.ENTRY_STORE.getByName(`storage-errors-${crypto.randomUUID()}`), async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("CREATE TABLE scope_fixture(id INTEGER PRIMARY KEY,value TEXT)");
      sql.exec("INSERT INTO scope_fixture VALUES(1,'private-clinical-note')");
      const records: ScopeRecord[] = [], secret = "private-url-token-clinical-value";
      const output = vi.spyOn(console, "info").mockImplementation(value => { records.push(JSON.parse(String(value))); });
      try {
        const originalError = new Error(secret);
        expect(() => withStorageDiagnostics(sql, "1", secret as StorageDiagnosticPhase, () => {
          sql.exec(`SELECT '${secret}' AS value FROM scope_fixture`).toArray();
          throw originalError;
        }, "other", secret)).toThrow(originalError);
        expect(records.at(-1)).toMatchObject({ phase: "rpc", trace: null, success: false, sqlCalls: 1, complete: true });
        let originalSqlError: unknown;
        await expect(withStorageDiagnostics(sql, "1", "alarm", async () => {
          try { sql.exec("SELECT FROM scope_fixture").toArray(); }
          catch (error) { originalSqlError = error; throw error; }
        })).rejects.toBe(originalSqlError);
        expect(records.at(-1)).toMatchObject({ success: false, complete: false, sqlErrors: 1 });
        withStorageDiagnostics(sql, "1", "rpc", () => {
          for (let n = 0; n < 130; n++) sql.exec("SELECT value FROM scope_fixture").toArray();
        });
        expect(records.at(-1)).toMatchObject({ sqlCalls: 130, complete: false, droppedSqlCalls: 2, rowsRead: 128 });
        let release!: () => void, late!: Promise<void>;
        withStorageDiagnostics(sql, "1", "rpc", () => {
          late = new Promise<void>(resolve => { release = resolve; }).then(() => { sql.exec("SELECT value FROM scope_fixture").toArray(); });
        });
        const finished = records.at(-1), recordCount = records.length;
        release(); await late;
        expect(records).toHaveLength(recordCount); expect(records.at(-1)).toBe(finished);
        expect(finished).toMatchObject({ rowsRead: 0, sqlCalls: 0, complete: true });
        const recurse = (depth: number): void => withStorageDiagnostics(sql, "1", "rpc", () => {
          if (depth > 0) recurse(depth - 1);
          else sql.exec("SELECT value FROM scope_fixture").toArray();
        });
        recurse(12);
        expect(records.slice(recordCount)).toHaveLength(8);
        expect(records.slice(recordCount).some(record => record.omittedScopes > 0 && !record.complete)).toBe(true);
        const text = JSON.stringify(records);
        for (const privateText of [secret, "private-clinical-note", "SELECT", "scope_fixture", '"bindings"', '"body"']) expect(text).not.toContain(privateText);
      } finally { output.mockRestore(); }
      const brokenLog = vi.spyOn(console, "info").mockImplementation(() => { throw new Error("logging unavailable"); });
      try {
        expect(withStorageDiagnostics(sql, "1", "rpc", () => 42)).toBe(42);
        const error = new Error("original business error");
        await expect(withStorageDiagnostics(sql, "1", "rpc", async () => { throw error; })).rejects.toBe(error);
      } finally { brokenLog.mockRestore(); }
    });
  });

  it("measures writes with one operation and retries only an exact missing RPC method", async () => {
    const logs: Record<string, unknown>[] = [];
    const output = vi.spyOn(console, "info").mockImplementation(value => { logs.push(JSON.parse(String(value))); });
    try {
      let writes = 0, mode: "measure" | "missing" | "failure" | "action-missing" = "measure";
      const failure = new Error("storage failed after original write attempt");
      const stub = {
        async createDocuments() { writes++; return "original-write-result"; },
        async diagnosticStorageOperation(operation: string) {
          expect(operation).toBe("createDocuments");
          if (mode === "missing") throw new Error('RPC receiver does not implement the method "diagnosticStorageOperation".');
          const value = await this.createDocuments();
          if (mode === "failure") throw failure;
          if (mode === "action-missing") return { ok: false,
            error: new Error('RPC receiver does not implement the method "diagnosticStorageOperation".') };
          return { ok: true, value, measurement: { rowsRead: 2, rowsWritten: 3, sqlCalls: 1, complete: true } };
        },
      };
      const namespace = { getByName: () => stub };
      const request = () => startReadRequestTrace(new Request("https://nscf.invalid/api/v1/devicestatus?token=private"));
      const measured = request();
      expect(await diagnosticNamespace(namespace, measured).getByName().createDocuments()).toBe("original-write-result");
      measured.finish(200);
      expect(writes).toBe(1); expect(logs.at(-1)).toMatchObject({ rowsRead: 2, rowsWritten: 3, rpcAttempts: 1, complete: true });
      mode = "missing";
      const missing = request();
      await diagnosticNamespace(namespace, missing).getByName().createDocuments(); missing.finish(200);
      expect(writes).toBe(2); expect(logs.at(-1)).toMatchObject({ rpcAttempts: 2, unmeasuredRpcCalls: 1, complete: false });
      mode = "failure";
      const failed = request();
      await expect(diagnosticNamespace(namespace, failed).getByName().createDocuments()).rejects.toBe(failure);
      failed.finish(500); expect(writes).toBe(3);
      expect(logs.at(-1)).toMatchObject({ rpcAttempts: 1, failedRpcCalls: 1, complete: false });
      mode = "action-missing";
      const ambiguous = request();
      await expect(diagnosticNamespace(namespace, ambiguous).getByName().createDocuments())
        .rejects.toThrow('RPC receiver does not implement the method "diagnosticStorageOperation".');
      ambiguous.finish(500); expect(writes).toBe(4);
      expect(logs.at(-1)).toMatchObject({ rpcAttempts: 1, failedRpcCalls: 1, complete: false });
      expect(isDiagnosticStorageOperation("constructor")).toBe(false);
      expect(isDiagnosticStorageOperation("diagnosticStorageOperation")).toBe(false);
      expect(JSON.stringify(logs)).not.toContain("private");
      await expect(measureDiagnosticStorageOperation({} as SqlStorage, "constructor", () => "never", crypto.randomUUID()))
        .rejects.toThrow("Unsupported diagnostic storage operation");
    } finally { output.mockRestore(); }
  });
});
