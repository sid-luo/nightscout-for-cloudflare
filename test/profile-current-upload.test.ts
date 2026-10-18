import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import worker from "../src/index";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const SECRET = "synthetic-profile-upload-secret";
const ORDER = "CASE WHEN json_valid(body) THEN json_extract(body, '$.startDate') ELSE NULL END DESC, id DESC";
const id = (n: number) => n.toString(16).padStart(24, "0");
function seed(storage: DurableObjectStorage, count: number, extraChars = 0): void {
  storage.transactionSync(() => {
    for (let n = 0; n < count; n++) storage.sql.exec(`INSERT INTO documents
      (collection,id,body,sort_time,created_at,updated_at) VALUES('profile',?,?,?,?,?)`,
      id(n), JSON.stringify({ _id: id(n), startDate: new Date(AT + n).toISOString(), defaultProfile: "Default",
        store: { Default: { units: "mg/dl", basal: [{ time: "00:00", value: 1 }] } },
        ...(extraChars ? { extra: "x".repeat(extraChars) } : {}) }), AT + n, AT, AT + n);
  });
}
function oracle(sql: SqlStorage): unknown {
  const all = sql.exec<{ body: string }>(`SELECT body FROM documents WHERE collection='profile'
    ORDER BY ${ORDER} LIMIT 5000`).toArray().map(row => JSON.parse(row.body));
  return JSON.parse(JSON.stringify(all[0] ?? null));
}
async function setup(instance: EntryStore): Promise<Parameters<typeof worker.fetch>[1]> {
  const forward = new Proxy(instance, { get(target, property) {
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
  } });
  return { ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => forward },
    API_SECRET: SECRET, AUTH_DEFAULT_ROLES: "readable", AUTH_FAIL_DELAY: "0" } as unknown as Parameters<typeof worker.fetch>[1];
}
async function measured(state: DurableObjectState, configured: Parameters<typeof worker.fetch>[1], request: Request) {
  const original = state.storage.sql.exec.bind(state.storage.sql);
  const cursors: { statement: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = original(statement, ...bindings); cursors.push({ statement, cursor }); return cursor;
  });
  try {
    const response = await worker.fetch(request, configured);
    return { status: response.status, body: await response.json(),
      reads: cursors.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: cursors.reduce((sum, item) => sum + item.cursor.rowsWritten, 0),
      validityCalls: cursors.filter(item => item.statement.includes("AS valid_json")).length,
      validityReads: cursors.filter(item => item.statement.includes("AS valid_json"))
        .reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      originalCalls: cursors.filter(item => item.statement.includes(ORDER)).length,
      fastCalls: cursors.filter(item => item.statement.includes("ORDER BY json_extract(body, '$.startDate') DESC, id DESC LIMIT 1")).length,
    };
  } finally { spy.mockRestore(); }
}
const current = () => new Request("https://synthetic.invalid/api/v1/profile/current?count=0&find[unused]=ignored");
function metrics(sample: Awaited<ReturnType<typeof measured>>) {
  const { body: _body, ...result } = sample;
  return result;
}
async function upload(state: DurableObjectState, configured: Parameters<typeof worker.fetch>[1], n: number) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(SECRET)));
  const digest = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return measured(state, configured, new Request("https://synthetic.invalid/api/v1/entries", {
    method: "POST", headers: { "Content-Type": "application/json", "api-secret": digest },
    body: JSON.stringify([{ type: "sgv", sgv: 110 + n, date: AT + n * 60000,
      dateString: new Date(AT + n * 60000).toISOString(), device: "synthetic-profile-upload" }]),
  }));
}

describe("Profile/current after unrelated uploads", () => {
  it("records complete HTTP cost after actual CGM uploads while preserving the original current value", async () => {
    const reports = [];
    for (const count of [32, 6001]) {
      const stub = env.ENTRY_STORE.getByName(`profile-upload-${count}-${crypto.randomUUID()}`);
      await runInDurableObject(stub, (_instance, state) => seed(state.storage, count));
      await evictDurableObject(stub);
      reports.push(await runInDurableObject(stub, async (instance, state) => {
        const configured = await setup(instance), expected = oracle(state.storage.sql), warm = [];
        for (let n = 0; n < 3; n++) {
          const sample = await measured(state, configured, current());
          expect(sample.status).toBe(200); expect(sample.body).toEqual(expected); expect(sample.writes).toBe(0);
          warm.push(metrics(sample));
        }
        expect(warm.map(sample => sample.validityReads)).toEqual(count === 32 ? [32, 0, 0] : [5001, 1001, 0]);
        const uploaded = [], reads = [];
        for (let n = 1; n <= 3; n++) {
          const written = await upload(state, configured, n);
          expect(written.status).toBe(200); expect(written.writes).toBeGreaterThan(0);
          uploaded.push(metrics(written));
          const sample = await measured(state, configured, current());
          expect(sample.status).toBe(200); expect(sample.body).toEqual(expected); expect(sample.writes).toBe(0);
          expect(sample.validityCalls).toBe(2); expect(sample.validityReads).toBe(count + 1);
          expect(sample.fastCalls).toBe(1); expect(sample.originalCalls).toBe(0);
          expect(sample.reads).toBeLessThanOrEqual(count + 16);
          reads.push(metrics(sample));
        }
        return { sourceRows: count, measurementScope: "real eviction then owner proxy plus Worker HTTP, constructor excluded",
          warm, uploaded, afterEachUpload: reads,
          afterUploadReadTotal: reads.reduce((sum, sample) => sum + sample.reads, 0) };
      }));
    }
    console.info(`PROFILE_UPLOAD_HTTP=${JSON.stringify(reports)}`);
  }, 60_000);

  it("does not reuse a first valid fill from raw repair inside an outer rollback", async () => {
    const stub = env.ENTRY_STORE.getByName(`profile-upload-latefill-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      seed(state.storage, 32);
      state.storage.sql.exec("UPDATE documents SET body='{broken' WHERE collection='profile' AND id=?", id(0));
    });
    await evictDurableObject(stub);
    const report = await runInDurableObject(stub, async (instance, state) => {
      const configured = await setup(instance);
      let pending: Promise<string> | undefined;
      let repairedInsideTransaction: unknown;
      expect(() => state.storage.transactionSync(() => {
        state.storage.sql.exec("UPDATE documents SET body=? WHERE collection='profile' AND id=?",
          JSON.stringify({ _id: id(0), startDate: new Date(AT).toISOString() }), id(0));
        repairedInsideTransaction = oracle(state.storage.sql);
        pending = instance.getLegacyProfileCurrentJson();
        throw new Error("rollback repaired profile");
      })).toThrow("rollback repaired profile");
      expect(JSON.parse(await pending!)).toEqual(repairedInsideTransaction);
      const restored = await measured(state, configured, current());
      expect(restored.status).toBe(500); expect(restored.writes).toBe(0);
      state.storage.sql.exec("UPDATE documents SET body=? WHERE collection='profile' AND id=?",
        JSON.stringify({ _id: id(0), startDate: new Date(AT).toISOString() }), id(0));
      const repaired = await measured(state, configured, current());
      expect(repaired.status).toBe(200); expect(repaired.body).toEqual(oracle(state.storage.sql)); expect(repaired.writes).toBe(0);
      state.storage.sql.exec("UPDATE documents SET body='{broken' WHERE collection='profile' AND id=?", id(0));
      const brokenAgain = await measured(state, configured, current());
      expect(brokenAgain.status).toBe(500); expect(brokenAgain.writes).toBe(0);
      return { restored: metrics(restored), repaired: metrics(repaired), brokenAgain: metrics(brokenAgain) };
    });
    console.info(`PROFILE_UPLOAD_RAW_ROLLBACK=${JSON.stringify(report)}`);
  });

  it("records first and repeated work for a row-cap or aggregate-body refusal without truncating the old response", async () => {
    const reports = [];
    for (const specimen of [{ name: "over-10000", count: 10001, extraChars: 0 },
      { name: "over-4MiB-work", count: 6001, extraChars: 1024 }]) {
      const stub = env.ENTRY_STORE.getByName(`profile-upload-refusal-${specimen.name}-${crypto.randomUUID()}`);
      await runInDurableObject(stub, (_instance, state) => seed(state.storage, specimen.count, specimen.extraChars));
      await evictDurableObject(stub);
      reports.push(await runInDurableObject(stub, async (instance, state) => {
        const configured = await setup(instance), expected = oracle(state.storage.sql);
        const written = await upload(state, configured, 1); expect(written.status).toBe(200);
        const samples = [];
        for (let n = 0; n < 2; n++) {
          const sample = await measured(state, configured, current());
          expect(sample.status).toBe(200); expect(sample.body).toEqual(expected); expect(sample.writes).toBe(0);
          samples.push(metrics(sample));
        }
        expect(samples[0]!.validityCalls).toBe(2);
        expect(samples[0]!.validityReads).toBeGreaterThan(0);
        expect(samples[0]!.validityReads).toBeLessThanOrEqual(10001);
        expect(samples[0]!.fastCalls).toBe(0); expect(samples[0]!.originalCalls).toBe(1);
        expect(samples[1]!.validityCalls).toBe(0);
        expect(samples[1]!.originalCalls).toBe(1); expect(samples[1]!.fastCalls).toBe(0);
        expect(samples[1]!.reads).toBe(specimen.count * 2 + 7);
        // A successful business upload clears shared query entries. A refusal
        // may survive that loss because it cannot authorize a profile response.
        expect((await upload(state, configured, 2)).status).toBe(200);
        const afterClear = await measured(state, configured, current());
        expect(afterClear.status).toBe(200); expect(afterClear.body).toEqual(expected); expect(afterClear.writes).toBe(0);
        expect(afterClear.validityCalls).toBe(0); expect(afterClear.originalCalls).toBe(1);
        expect(afterClear.reads).toBe(samples[1]!.reads);
        return { ...specimen, uploaded: metrics(written), samples, afterClear: metrics(afterClear) };
      }));
    }
    console.info(`PROFILE_UPLOAD_REFUSAL=${JSON.stringify(reports)}`);
  }, 60_000);
});
