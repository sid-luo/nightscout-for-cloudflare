import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import worker from "../src/index";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const ORDER = "CASE WHEN json_valid(body) THEN json_extract(body, '$.startDate') ELSE NULL END DESC, id DESC";
const id = (n: number) => n.toString(16).padStart(24, "0");
interface Cost { statement: string; reads: number; writes: number }
function seed(sql: SqlStorage, count: number, largeAt?: number) {
  sql.exec(`WITH RECURSIVE s(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM s WHERE n<?)
    INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
    SELECT 'profile',printf('%024x',n),json_object('_id',printf('%024x',n),
      'startDate',strftime('%Y-%m-%dT%H:%M:%fZ',(?+n)/1000.0,'unixepoch'),
      'defaultProfile','Default','store',json('{"Default":{"units":"mg/dl","basal":[{"time":"00:00","value":1}]}}')),
      ?+n,?,?+n FROM s`, count - 1, AT, AT, AT, AT);
  if (largeAt !== undefined) sql.exec("UPDATE documents SET body=json_set(body,'$.large',?) WHERE collection='profile' AND id=?",
    "x".repeat(200 * 1024), id(largeAt));
}
function oracle(sql: SqlStorage): unknown {
  return JSON.parse(JSON.stringify(sql.exec<{ body: string }>(`SELECT body FROM documents
    WHERE collection='profile' ORDER BY ${ORDER} LIMIT 5000`).toArray().map(row => JSON.parse(row.body))[0] ?? null));
}
function configured(instance: EntryStore): Parameters<typeof worker.fetch>[1] {
  const proxy = new Proxy(instance, { get(target, property) {
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
  } });
  return { ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => proxy }, API_SECRET: "synthetic-profile-refusal-secret",
    AUTH_DEFAULT_ROLES: "readable", AUTH_FAIL_DELAY: "0" } as unknown as Parameters<typeof worker.fetch>[1];
}
async function measured(state: DurableObjectState, instance: EntryStore) {
  const exec = state.storage.sql.exec.bind(state.storage.sql);
  const cursors: { statement: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = exec(statement, ...bindings); cursors.push({ statement, cursor }); return cursor;
  });
  try {
    const response = await worker.fetch(new Request("https://synthetic.invalid/api/v1/profile/current?count=0"), configured(instance));
    const body: unknown = await response.json();
    const sql: Cost[] = cursors.map(({ statement, cursor }) => ({ statement: statement.replace(/\s+/g, " ").trim(),
      reads: cursor.rowsRead, writes: cursor.rowsWritten }));
    return { body, status: response.status, reads: sql.reduce((sum, row) => sum + row.reads, 0),
      writes: sql.reduce((sum, row) => sum + row.writes, 0),
      validityReads: sql.filter(row => row.statement.includes("AS valid_json")).reduce((sum, row) => sum + row.reads, 0),
      originalCalls: sql.filter(row => row.statement.includes(ORDER)).length,
      fastCalls: sql.filter(row => row.statement.includes("ORDER BY json_extract(body, '$.startDate') DESC, id DESC LIMIT 1")).length,
      sql };
  } finally { spy.mockRestore(); }
}
function metrics(sample: Awaited<ReturnType<typeof measured>>) {
  const { body: _body, ...result } = sample;
  return result;
}
function rawDml(sql: SqlStorage) {
  // A real DML after constructor sealing, without trusting a commit clock or
  // a known-write hook. The original profile values remain unchanged.
  expect(sql.exec("UPDATE documents SET updated_at=updated_at WHERE collection='profile' AND id=?", id(0)).rowsWritten).toBe(1);
}

describe("Profile/current first refusal admission", () => {
  it("records head/middle/tail large-body refusal against the complete original HTTP result", async () => {
    const reports = [];
    for (const specimen of [{ name: "head-outside-old-window", largeAt: 0 },
      { name: "middle-inside-old-window", largeAt: 3000 }, { name: "tail-current", largeAt: 6000 }]) {
      const stub = env.ENTRY_STORE.getByName(`profile-tail-${specimen.name}-${crypto.randomUUID()}`);
      await runInDurableObject(stub, (_instance, state) => seed(state.storage.sql, 6001, specimen.largeAt));
      await evictDurableObject(stub);
      reports.push(await runInDurableObject(stub, async (instance: EntryStore, state) => {
        rawDml(state.storage.sql);
        const expected = oracle(state.storage.sql), samples = [];
        for (let repeat = 0; repeat < 2; repeat++) {
          const sample = await measured(state, instance);
          expect(sample.status).toBe(200); expect(sample.body).toEqual(expected); expect(sample.writes).toBe(0);
          expect(sample.fastCalls).toBe(0); expect(sample.originalCalls).toBe(1);
          samples.push(metrics(sample));
        }
        expect(samples[1]!.validityReads).toBe(0);
        // The strict prefix endpoint is charged once by native SQLite. Only
        // the unsupported tail avoids the prefix altogether.
        const sourceReads = specimen.largeAt === 6000 ? 1 : specimen.largeAt + 3;
        expect(samples[0]!.validityReads).toBe(sourceReads);
        expect(samples[0]!.reads).toBe(samples[1]!.reads + sourceReads);
        expect(samples[0]!.sql.filter(row => row.statement.includes("AS valid_json")))
          .toHaveLength(specimen.largeAt === 6000 ? 1 : 2);
        return { ...specimen, sourceRows: 6001, largeChars: 200 * 1024, samples };
      }));
    }
    console.info(`PROFILE_REFUSAL_LARGE_POSITION=${JSON.stringify(reports)}`);
  }, 60_000);

  it("keeps the exact 9999/10000/10001 source boundary without treating a limited cursor as whole EOF", async () => {
    const reports = [];
    for (const count of [9999, 10000, 10001]) {
      const stub = env.ENTRY_STORE.getByName(`profile-tail-boundary-${count}-${crypto.randomUUID()}`);
      await runInDurableObject(stub, (_instance, state) => seed(state.storage.sql, count));
      await evictDurableObject(stub);
      reports.push(await runInDurableObject(stub, async (instance: EntryStore, state) => {
        rawDml(state.storage.sql);
        const expected = oracle(state.storage.sql), samples = [];
        for (let repeat = 0; repeat < 2; repeat++) {
          const sample = await measured(state, instance);
          expect(sample.status).toBe(200); expect(sample.body).toEqual(expected); expect(sample.writes).toBe(0);
          expect(sample.fastCalls).toBe(count <= 10000 ? 1 : 0);
          expect(sample.originalCalls).toBe(count <= 10000 ? 0 : 1);
          expect(sample.validityReads).toBe(count > 10000 && repeat > 0 ? 0 : Math.min(count + 1, 10001));
          expect(sample.validityReads).toBeLessThanOrEqual(10001);
          samples.push(metrics(sample));
        }
        if (count > 10000) expect(samples[1]!.validityReads).toBe(0);
        return { sourceRows: count, samples };
      }));
    }
    console.info(`PROFILE_REFUSAL_EXACT_BOUNDARY=${JSON.stringify(reports)}`);
  }, 60_000);

  it("keeps a bad tail's original 5000-row error window and never reuses an outer-transaction repair", async () => {
    const reports = [];
    for (const count of [32, 6001]) {
      const stub = env.ENTRY_STORE.getByName(`profile-tail-rollback-${count}-${crypto.randomUUID()}`);
      await runInDurableObject(stub, (_instance, state) => {
        seed(state.storage.sql, count);
        state.storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
          VALUES('profile',?,'{bad tail',?,?,?)`, id(99999), AT - 1, AT, AT - 1);
      });
      await evictDurableObject(stub);
      reports.push(await runInDurableObject(stub, async (instance: EntryStore, state) => {
        let pending: Promise<string> | undefined, repairedExpected: unknown;
        expect(() => state.storage.transactionSync(() => {
          state.storage.sql.exec("UPDATE documents SET body=? WHERE collection='profile' AND id=?",
            JSON.stringify({ _id: id(99999), startDate: new Date(AT - 1).toISOString() }), id(99999));
          repairedExpected = oracle(state.storage.sql);
          pending = instance.getLegacyProfileCurrentJson();
          throw new Error("rollback valid tail");
        })).toThrow("rollback valid tail");
        expect(JSON.parse(await pending!)).toEqual(repairedExpected);
        const restored = await measured(state, instance);
        expect(restored.status).toBe(count > 5000 ? 200 : 500); expect(restored.writes).toBe(0);
        if (count > 5000) expect(restored.body).toEqual(oracle(state.storage.sql));
        expect(restored.fastCalls).toBe(0); expect(restored.originalCalls).toBe(1);
        expect(restored.validityReads).toBe(1);
        expect(restored.sql.filter(row => row.statement.includes("AS valid_json"))).toHaveLength(1);
        state.storage.sql.exec("UPDATE documents SET body=? WHERE collection='profile' AND id=?",
          JSON.stringify({ _id: id(99999), startDate: new Date(AT - 1).toISOString() }), id(99999));
        const repaired = await measured(state, instance);
        expect(repaired.status).toBe(200); expect(repaired.body).toEqual(oracle(state.storage.sql)); expect(repaired.writes).toBe(0);
        expect(repaired.validityReads).toBe(0); expect(repaired.originalCalls).toBe(1);
        return { sourceRows: count + 1, badOutsideOldWindow: count > 5000,
          restored: metrics(restored), repaired: metrics(repaired) };
      }));
    }
    console.info(`PROFILE_REFUSAL_TAIL_ROLLBACK=${JSON.stringify(reports)}`);
  }, 60_000);
});
