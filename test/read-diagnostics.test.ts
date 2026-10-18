import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { diagnosticNamespace, measureDiagnosticRead, startReadRequestTrace } from "../src/read-diagnostics";

describe("opt-in read diagnostics", () => {
  it("isolates overlapping SQL scopes, preserves errors and marks bounded capture incomplete", async () => {
    const result = await runInDurableObject(env.ENTRY_STORE.getByName(`diagnostic-meter-${crypto.randomUUID()}`), async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("CREATE TABLE diagnostic_fixture(id INTEGER PRIMARY KEY,value TEXT)");
      sql.exec("INSERT INTO diagnostic_fixture VALUES(1,'a'),(2,'b'),(3,'c')");
      const calls: string[] = [];
      const output = vi.spyOn(console, "info").mockImplementation(value => { calls.push(String(value)); });
      try {
        const trace = crypto.randomUUID();
        const expected: number[][] = [[], []];
        const samples = await Promise.all([0, 1].map(n => measureDiagnosticRead(sql, "listDocuments", async () => {
          for (let part = 0; part < 2; part++) {
            const cursor = sql.exec("SELECT value FROM diagnostic_fixture WHERE id<=?", n === 0 ? 2 : 1);
            cursor.toArray(); expected[n]!.push(cursor.rowsRead);
            await Promise.resolve();
          }
          return n;
        }, trace)));
        for (const [n, sample] of samples.entries()) {
          expect(sample.value).toBe(n); expect(sample.measurement.sqlCalls).toBe(2);
          expect(sample.measurement.rowsRead).toBe(expected[n]!.reduce((a, b) => a + b, 0));
          expect(sample.measurement.rowsWritten).toBe(0); expect(sample.measurement.complete).toBe(true);
        }
        const privateText = "sensitive-note-and-credential-918271";
        const error = new Error(privateText);
        try {
          await measureDiagnosticRead(sql, "listDocuments", () => {
            sql.exec(`SELECT '${privateText}' AS value FROM diagnostic_fixture`).toArray();
            throw error;
          }, trace);
          throw new Error("Expected original operation failure");
        } catch (caught) { expect(caught).toBe(error); }
        expect(calls).toHaveLength(1); expect(calls[0]).not.toContain(privateText);
        expect(JSON.parse(calls[0]!)).toMatchObject({ event: "nscf_read_rpc_failure", operation: "listDocuments",
          measurement: { rowsRead: 3, rowsWritten: 0 } });
        let nativeError: unknown;
        try {
          await measureDiagnosticRead(sql, "listDocuments", () => {
            try { return sql.exec("SELECT FROM diagnostic_fixture").toArray(); }
            catch (caught) { nativeError = caught; throw caught; }
          }, trace);
          throw new Error("Expected original SQL failure");
        } catch (caught) { expect(caught).toBe(nativeError); }
        expect(JSON.parse(calls.at(-1)!)).toMatchObject({ measurement: { complete: false, sqlErrors: 1 } });
        const overflow = await measureDiagnosticRead(sql, "listDocuments", () => {
          for (let n = 0; n < 130; n++) sql.exec("SELECT value FROM diagnostic_fixture").toArray();
          return "complete-original-result";
        }, trace);
        expect(overflow.value).toBe("complete-original-result");
        expect(overflow.measurement.sqlCalls).toBe(130); expect(overflow.measurement.complete).toBe(false);
        expect(overflow.measurement.rowsWritten).toBe(0);
        return { overlappingReads: samples.map(sample => sample.measurement.rowsRead),
          originalErrorPreserved: true, overflowCalls: overflow.measurement.sqlCalls, overflowComplete: false };
      } finally { output.mockRestore(); }
    });
    console.info(`READ_DIAGNOSTIC_SCOPE=${JSON.stringify(result)}`);
  });

  it("falls back only for a missing diagnostic method and preserves native method receivers", async () => {
    const logs: string[] = [];
    const output = vi.spyOn(console, "info").mockImplementation(value => { logs.push(String(value)); });
    try {
      let reads = 0;
      const stub = {
        marker: "original-receiver",
        async listDocuments() { expect(this.marker).toBe("original-receiver"); reads++; return "[]"; },
        async diagnosticRead(): Promise<unknown> { throw new Error('RPC receiver does not implement the method "diagnosticRead"'); },
      };
      const namespace = { marker: "namespace", getByName() { expect(this.marker).toBe("namespace"); return stub; } };
      const trace = startReadRequestTrace(new Request("https://nscf.invalid/api/v2/authorization/request/secret-do-not-log?token=private-token&find[x]=private-note"));
      expect(await diagnosticNamespace(namespace, trace).getByName().listDocuments()).toBe("[]");
      expect(reads).toBe(1); trace.finish(200);
      expect(logs).toHaveLength(1); expect(logs[0]).not.toContain("secret-do-not-log");
      expect(logs[0]).not.toContain("private-token"); expect(logs[0]).not.toContain("private-note");
      expect(JSON.parse(logs[0]!)).toMatchObject({ route: "/api/v2/authorization/request/:credential", complete: false,
        unmeasuredRpcCalls: 1, rpcCalls: 1, rpcAttempts: 2 });
      const failure = new Error("database unavailable");
      stub.diagnosticRead = async () => { throw failure; };
      const second = startReadRequestTrace(new Request("https://nscf.invalid/api/v1/profile/current"));
      await expect(diagnosticNamespace(namespace, second).getByName().listDocuments()).rejects.toBe(failure);
      expect(reads).toBe(1); // A real failure never retries the original method.
      const embedded = new Error('business error: RPC receiver does not implement the method "diagnosticRead"; context');
      stub.diagnosticRead = async () => { throw embedded; };
      const third = startReadRequestTrace(new Request("https://nscf.invalid/api/v1/profile/current"));
      await expect(diagnosticNamespace(namespace, third).getByName().listDocuments()).rejects.toBe(embedded);
      expect(reads).toBe(1);
      let release!: (value: unknown) => void;
      stub.diagnosticRead = () => new Promise(resolve => { release = resolve; });
      const pending = startReadRequestTrace(new Request("https://nscf.invalid/api/v1/profile/current"));
      const inFlight = diagnosticNamespace(namespace, pending).getByName().listDocuments();
      pending.finish(200);
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({ complete: false, pendingRpcCalls: 1 });
      release({ value: "[]", measurement: { rowsRead: 0, rowsWritten: 0, complete: true } });
      expect(await inFlight).toBe("[]");
    } finally { output.mockRestore(); }
  });

  it("keeps real RPC HTTP results and database writes unchanged when enabled", async () => {
    const tenant = `diag-${crypto.randomUUID().slice(0, 8)}`;
    const stub = env.ENTRY_STORE.getByName(tenant);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
        VALUES('activity','000000000000000000000001',?,1,1,1)`, JSON.stringify({ created_at: "2026-10-18T00:00:00.000Z", activity: "Walking" }));
    });
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode("nscf-test-secret-20260717")))]
      .map(value => value.toString(16).padStart(2, "0")).join("");
    const request = () => new Request(`https://nscf.invalid/api/v1/activity.json?tenant=${tenant}&count=1`,
      { headers: { "api-secret": digest } });
    const before = await worker.fetch(request(), env);
    const beforeBody = await before.text();
    const logs: string[] = [];
    const output = vi.spyOn(console, "info").mockImplementation(value => { logs.push(String(value)); });
    let status: number, body: string;
    try {
      const after = await worker.fetch(request(), { ...env, READ_DIAGNOSTICS: "1" });
      status = after.status; body = await after.text();
    } finally { output.mockRestore(); }
    expect(status).toBe(before.status); expect(body).toBe(beforeBody);
    const reports = logs.map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(item => item?.event === "nscf_read_request");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ status: 200, rowsWritten: 0, complete: true });
    expect(reports[0].rowsRead).toBeGreaterThan(0); expect(reports[0].rpcCalls).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(tenant); expect(logs.join("\n")).not.toContain("Walking");
    expect(logs.join("\n")).not.toContain("nscf-test-secret-20260717");
    console.info(`READ_DIAGNOSTIC_HTTP=${JSON.stringify(reports[0])}`);
  });
});
