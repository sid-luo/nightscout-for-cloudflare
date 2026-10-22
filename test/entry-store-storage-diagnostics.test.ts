import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { PLUGIN_NOTIFICATIONS_TASK, SqliteBackgroundTaskRepository } from "../src/background-tasks";
import type { EntryStore } from "../src/entry-store";
import worker from "../src/index";
import { diagnosticNamespace, startReadRequestTrace, type DiagnosticStorageResult } from "../src/read-diagnostics";
import { DurableObjectWriteQuotaError, isDurableObjectWriteQuotaError } from "../src/platform-errors";

interface ScopeRecord {
  event: string; id: string; parent: string | null; trace: string | null; phase: string; operation: string;
  rowsRead: number; rowsWritten: number; sqlCalls: number; complete: boolean;
}
type MutableStore = { env: Record<string, unknown>; automaticPluginNotificationEvaluation(now: number): unknown };
type Cursor = SqlStorageCursor<Record<string, SqlStorageValue>>;

describe("EntryStore storage diagnostics integration", () => {
  it("attributes real activation and nested alarm/background/notification SQL exactly once", async () => {
    const settings = env as unknown as Record<string, unknown>;
    const changes = { READ_DIAGNOSTICS: "1", ENABLE: "upbat", ALARM_TYPES: "predict", UPBAT_ENABLE_ALERTS: "true",
      UPBAT_WARN: "30", UPBAT_URGENT: "20", HEARTBEAT: "60",
      DISABLE: "ar2 simplealarms errorcodes treatmentnotify timeago pump openaps xdripjs loop bwp cage sage iage bage dbsize" };
    const before = Object.fromEntries(Object.keys(changes).map(key => [key, settings[key]]));
    const records: ScopeRecord[] = [];
    const output = vi.spyOn(console, "info").mockImplementation(value => {
      const record = JSON.parse(String(value)); if (record.event === "nscf_storage_scope") records.push(record);
    });
    try {
      Object.assign(settings, changes);
      const stub = env.ENTRY_STORE.getByName(`storage-events-${crypto.randomUUID()}`);
      await runInDurableObject(stub, async (instance: EntryStore, state) => {
        const internal = instance as unknown as MutableStore, sql = state.storage.sql;
        expect(records.some(record => record.phase === "activation")).toBe(true);
        internal.env.READ_DIAGNOSTICS = undefined;
        const now = Date.now(), privateDevice = "private-device-never-log", privateNote = "private-clinical-note-never-log";
        await instance.createDocuments("devicestatus", JSON.stringify([{
          device: privateDevice, created_at: new Date(now).toISOString(), date: now,
          uploader: { battery: 19, batteryVoltage: 4100 }, notes: privateNote,
        }]));
        records.length = 0;
        internal.automaticPluginNotificationEvaluation(now);
        await instance.alarm();
        expect(records).toHaveLength(0);
        new SqliteBackgroundTaskRepository(state.storage).schedule(PLUGIN_NOTIFICATIONS_TASK, now, now);
        internal.env.READ_DIAGNOSTICS = "1";
        const cursors: Cursor[] = [], execute = sql.exec.bind(sql);
        const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
          const cursor = execute(statement, ...bindings); cursors.push(cursor); return cursor;
        });
        try {
          await instance.alarm();
          const independent = { reads: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
            writes: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0), calls: cursors.length };
          const alarm = records.find(record => record.phase === "alarm")!;
          const background = records.find(record => record.phase === "background")!;
          const notification = records.find(record => record.phase === "notification")!;
          expect(alarm).toBeDefined(); expect(background).toMatchObject({ parent: alarm.id });
          expect(notification).toMatchObject({ parent: background.id });
          expect(records.every(record => record.complete)).toBe(true);
          expect(records.reduce((sum, record) => sum + record.rowsRead, 0)).toBe(independent.reads);
          expect(records.reduce((sum, record) => sum + record.rowsWritten, 0)).toBe(independent.writes);
          expect(records.reduce((sum, record) => sum + record.sqlCalls, 0)).toBe(independent.calls);
          expect(independent.calls).toBeGreaterThan(0);
          const text = JSON.stringify(records);
          expect(text).not.toContain(privateDevice); expect(text).not.toContain(privateNote);
          expect(text).not.toContain("SELECT"); expect(text).not.toContain("INSERT");
        } finally { spy.mockRestore(); }
      });
    } finally { Object.assign(settings, before); output.mockRestore(); }
  });

  it("measures a real HTTP mutation without duplicating writes or exposing its payload", async () => {
    const tenant = `storage-http-${crypto.randomUUID().slice(0, 8)}`;
    const stub = env.ENTRY_STORE.getByName(tenant), privateNote = "private-http-body-never-log";
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode("nscf-test-secret-20260717")))]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
    const records: Record<string, unknown>[] = [];
    const output = vi.spyOn(console, "info").mockImplementation(value => { records.push(JSON.parse(String(value))); });
    const cursors: Cursor[] = [];
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await runInDurableObject(stub, (_instance, state) => {
        const execute = state.storage.sql.exec.bind(state.storage.sql);
        spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((statement, ...bindings) => {
          const cursor = execute(statement, ...bindings); cursors.push(cursor); return cursor;
        });
      });
      const response = await worker.fetch(new Request(`https://nscf.invalid/api/v1/activity?tenant=${tenant}`, {
        method: "POST", headers: { "api-secret": digest, "Content-Type": "application/json" },
        body: JSON.stringify([{ _id: "000000000000000000000001", created_at: new Date().toISOString(), notes: privateNote }]),
      }), { ...env, READ_DIAGNOSTICS: "1" });
      expect(response.status).toBe(200);
      const body = await response.json() as { _id: string }[];
      expect(body).toHaveLength(1); expect(body[0]?._id).toBe("000000000000000000000001");
      const independent = await runInDurableObject(stub, () => {
        const result = { reads: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
          writes: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0), calls: cursors.length };
        spy?.mockRestore(); spy = undefined; return result;
      });
      const scopes = records.filter(record => record.event === "nscf_storage_scope") as unknown as ScopeRecord[];
      expect(scopes.some(record => record.phase === "rpc" && record.operation === "write" && record.rowsWritten > 0)).toBe(true);
      expect(scopes.reduce((sum, record) => sum + record.rowsRead, 0)).toBe(independent.reads);
      expect(scopes.reduce((sum, record) => sum + record.rowsWritten, 0)).toBe(independent.writes);
      expect(scopes.reduce((sum, record) => sum + record.sqlCalls, 0)).toBe(independent.calls);
      const httpTrace = records.find(record => record.event === "nscf_read_request")!;
      expect(httpTrace).toMatchObject({
        scope: "awaited-rpc-bodies-excludes-activation-and-detached-work",
        complete: true, rowsRead: independent.reads, rowsWritten: independent.writes, unmeasuredRpcCalls: 0,
      });
      expect(scopes.every(record => record.trace === httpTrace.trace)).toBe(true);
      await runInDurableObject(stub, (_instance, state) => {
        expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM documents WHERE collection='activity'").one().count).toBe(1);
      });
      const text = JSON.stringify(records);
      for (const value of [privateNote, tenant, digest, "nscf-test-secret-20260717"]) expect(text).not.toContain(value);
    } finally {
      await runInDurableObject(stub, () => { spy?.mockRestore(); });
      output.mockRestore();
    }
  });

  it("returns RPC action errors by value so missing-method text cannot replay committed writes", async () => {
    const stub = env.ENTRY_STORE.getByName(`storage-no-replay-${crypto.randomUUID()}`);
    let calls = 0, useQuota = false, actionSpy: ReturnType<typeof vi.spyOn> | undefined;
    const missing = 'RPC receiver does not implement the method "diagnosticStorageOperation".';
    const logs: string[] = [], privateNote = "private-error-test-note";
    const output = vi.spyOn(console, "info").mockImplementation(value => { logs.push(String(value)); });
    try {
      await runInDurableObject(stub, (instance: EntryStore) => {
        const original = instance.createDocuments.bind(instance);
        actionSpy = vi.spyOn(instance, "createDocuments").mockImplementation(async () => {
          calls++;
          await original("activity", JSON.stringify([{ _id: calls.toString(16).padStart(24, "0"), notes: privateNote }]));
          throw useQuota ? new DurableObjectWriteQuotaError() : new Error(missing);
        });
      });
      const receiver = stub as unknown as {
        diagnosticStorageOperation(operation: string, args: unknown[], trace: string): Promise<DiagnosticStorageResult>;
      };
      const response = await receiver.diagnosticStorageOperation("createDocuments", ["activity", "[]"], crypto.randomUUID());
      expect(response.ok).toBe(false);
      if (response.ok) throw new Error("Expected action failure envelope");
      expect(response.error).toBeInstanceOf(Error); expect((response.error as Error).message).toBe(missing);
      expect(calls).toBe(1);
      const trace = startReadRequestTrace(new Request("https://nscf.invalid/api/v1/activity"));
      await expect(diagnosticNamespace({ getByName: () => stub }, trace).getByName().createDocuments("activity", "[]"))
        .rejects.toThrow(missing);
      trace.finish(500); expect(calls).toBe(2);
      useQuota = true;
      const quota = startReadRequestTrace(new Request("https://nscf.invalid/api/v1/activity"));
      let propagated: unknown;
      try { await diagnosticNamespace({ getByName: () => stub }, quota).getByName().createDocuments("activity", "[]"); }
      catch (error) { propagated = error; }
      expect(isDurableObjectWriteQuotaError(propagated)).toBe(true);
      quota.finish(503); expect(calls).toBe(3);
      await runInDurableObject(stub, (_instance, state) => {
        actionSpy?.mockRestore(); actionSpy = undefined;
        expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM documents WHERE collection='activity'").one().count).toBe(3);
      });
      expect(logs.join("\n")).not.toContain(privateNote); expect(logs.join("\n")).not.toContain(missing);
    } finally {
      await runInDurableObject(stub, () => { actionSpy?.mockRestore(); }); output.mockRestore();
    }
  });
});
