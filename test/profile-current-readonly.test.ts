import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore, JsonDocument } from "../src/entry-store";
import worker from "../src/index";

const ORIGIN = "https://synthetic.invalid";
const AT = Date.parse("2026-10-18T12:00:00.000Z");
const id = (n: number) => n.toString(16).padStart(24, "0");
const ORDER = "CASE WHEN json_valid(body) THEN json_extract(body, '$.startDate') ELSE NULL END DESC, id DESC";
type Failure = "missing" | "embedded" | "operational";
function seed(storage: DurableObjectStorage, count: number, mixed = true): void {
  storage.transactionSync(() => {
    for (let n = 0; n < count; n++) {
      const start = mixed ? [new Date(AT + n).toISOString(), AT + n, null, undefined, "", ["array", n], { rank: n }, true][n % 8]
        : new Date(AT + n).toISOString();
      const body = JSON.stringify({ _id: id(n), defaultProfile: "Default", ...(start === undefined ? {} : { startDate: start }),
        store: { Default: { units: "mg/dl", basal: [{ time: "00:00", value: 1 }] } },
        ...(n === count - 1 ? { largeField: "x".repeat(96 * 1024) } : {}) });
      storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
        VALUES('profile',?,?,?,?,?)`, id(n), body, AT + n, AT, AT + n);
    }
  });
}
function oracle(sql: SqlStorage): unknown {
  const all = sql.exec<{ body: string }>(`SELECT body FROM documents WHERE collection='profile'
    ORDER BY ${ORDER} LIMIT 5000`).toArray().map(row => JSON.parse(row.body) as JsonDocument);
  return JSON.parse(JSON.stringify(all[0] ?? null));
}
async function measure(state: DurableObjectState, instance: EntryStore, search = "", failure?: Failure) {
  const rpc: string[] = [];
  const forward = new Proxy(instance, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      rpc.push(String(property));
      if (property === "getLegacyProfileCurrentJson" && failure !== undefined) {
        const missing = 'RPC receiver does not implement the method "getLegacyProfileCurrentJson"';
        throw new Error(failure === "missing" ? missing : failure === "embedded" ? `unrelated failure: ${missing}` : "synthetic operational failure");
      }
      return value.apply(target, args);
    };
  } });
  const configured = { ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => forward },
    API_SECRET: "synthetic-profile-read-secret", AUTH_DEFAULT_ROLES: "readable", AUTH_FAIL_DELAY: "0" } as unknown as Parameters<typeof worker.fetch>[1];
  const execute = state.storage.sql.exec.bind(state.storage.sql);
  const queries: { sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...bindings) => {
    const cursor = execute(sql, ...bindings); queries.push({ sql, cursor }); return cursor;
  });
  try {
    const response = await worker.fetch(new Request(`${ORIGIN}/api/v1/profile/current${search}`), configured);
    const body = await response.json();
    return { status: response.status, body, rpc,
      reads: queries.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: queries.reduce((sum, item) => sum + item.cursor.rowsWritten, 0),
      validityCalls: queries.filter(item => item.sql.includes("AS valid_json FROM documents")).length,
      originalCalls: queries.filter(item => item.sql.includes(ORDER)).length,
      fastCalls: queries.filter(item => item.sql.includes("ORDER BY json_extract(body, '$.startDate') DESC, id DESC LIMIT 1")).length,
      queries: queries.map(item => ({ sql: item.sql.replace(/\s+/g, " ").trim(), reads: item.cursor.rowsRead, writes: item.cursor.rowsWritten })) };
  } finally { spy.mockRestore(); }
}
function metrics(sample: Awaited<ReturnType<typeof measure>>) {
  return { status: sample.status, reads: sample.reads, writes: sample.writes, rpc: sample.rpc,
    validityCalls: sample.validityCalls, originalCalls: sample.originalCalls, fastCalls: sample.fastCalls, queries: sample.queries };
}

describe("read-only activation Profile/current native index", () => {
  it("uses a complete bounded whole-collection proof after real eviction and keeps mixed JSON ordering and large values exact", async () => {
    const reports = [];
    for (const count of [32, 6001]) {
      const stub = env.ENTRY_STORE.getByName(`profile-readonly-${count}-${crypto.randomUUID()}`);
      await runInDurableObject(stub, (_instance, state) => seed(state.storage, count));
      await evictDurableObject(stub);
      reports.push(await runInDurableObject(stub, async (instance, state) => {
        const expected = oracle(state.storage.sql), samples = [];
        for (let repeat = 0; repeat < 4; repeat++) {
          const sample = await measure(state, instance, repeat % 2 ? "?count=0&find[unused]=ignored" : "");
          expect(sample.status).toBe(200); expect(sample.body).toEqual(expected); expect(sample.writes).toBe(0);
          samples.push(metrics(sample));
        }
        expect(samples[2]!.validityCalls + samples[2]!.originalCalls).toBe(0);
        expect(samples[2]!.fastCalls).toBe(1); expect(samples[2]!.reads).toBeLessThan(100);
        expect(samples[3]!.reads).toBeLessThan(100);
        if (count > 5000) { expect(samples[0]!.originalCalls).toBe(1); expect(samples[1]!.originalCalls).toBe(0); }
        const plan = state.storage.sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT id,body,sort_time FROM documents
          WHERE collection='profile' AND json_valid(body) ORDER BY json_extract(body,'$.startDate') DESC,id DESC LIMIT 1`)
          .toArray().map(row => row.detail);
        expect(plan.some(detail => detail.includes("documents_collection_profile_start"))).toBe(true);
        return { sourceRows: count, samples, fourRequestReads: samples.reduce((sum, sample) => sum + sample.reads, 0), plan };
      }));
    }
    console.info(`PROFILE_READONLY_EVICTION_HTTP=${JSON.stringify(reports)}`);
  }, 60_000);

  it("declines an unsupported whole-collection row without changing old inside/outside-window errors", async () => {
    const reports = [];
    for (const count of [32, 6001]) {
      const stub = env.ENTRY_STORE.getByName(`profile-unsupported-${count}-${crypto.randomUUID()}`);
      await runInDurableObject(stub, (_instance, state) => {
        seed(state.storage, count, false);
        state.storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
          VALUES('profile',?,'{broken',?,?,?)`, id(99_999), AT - 1000, AT, AT);
      });
      await evictDurableObject(stub);
      reports.push(await runInDurableObject(stub, async (instance, state) => {
        const samples = [];
        for (let repeat = 0; repeat < 3; repeat++) {
          const sample = await measure(state, instance);
          expect(sample.status).toBe(count > 5000 ? 200 : 500);
          if (sample.status === 200) expect(sample.body).toEqual(oracle(state.storage.sql));
          expect(sample.fastCalls).toBe(0); expect(sample.originalCalls).toBe(1); expect(sample.writes).toBe(0);
          samples.push(metrics(sample));
        }
        return { sourceRows: count + 1, badRowOutsideOriginalWindow: count > 5000, samples };
      }));
    }
    console.info(`PROFILE_READONLY_UNSUPPORTED_HTTP=${JSON.stringify(reports)}`);
  }, 60_000);

  it("proves the current live collection again after raw changes and private transaction rollback", async () => {
    const reports = [];
    for (const lateFirstFill of [false, true]) {
      const stub = env.ENTRY_STORE.getByName(`profile-readonly-rollback-${lateFirstFill}-${crypto.randomUUID()}`);
      await runInDurableObject(stub, (_instance, state) => {
        seed(state.storage, 32, false);
        if (lateFirstFill) state.storage.sql.exec("UPDATE documents SET body='{broken' WHERE collection='profile' AND id=?", id(0));
      });
      await evictDurableObject(stub);
      reports.push(await runInDurableObject(stub, async (instance, state) => {
        if (!lateFirstFill) {
          const initial = await measure(state, instance);
          expect(initial.status).toBe(200); expect(initial.fastCalls).toBe(1);
          state.storage.sql.exec("UPDATE documents SET body=json_set(body,'$.defaultProfile','Changed') WHERE collection='profile' AND id=?", id(31));
          const changed = await measure(state, instance);
          expect(changed.status).toBe(200); expect(changed.body).toEqual(oracle(state.storage.sql));
          expect(changed.validityCalls).toBe(2); expect(changed.fastCalls).toBe(1); expect(changed.originalCalls).toBe(0);
          expect(changed.writes).toBe(0);
        }
        let pending: Promise<string> | undefined;
        expect(() => state.storage.transactionSync(() => {
          if (lateFirstFill) state.storage.sql.exec("UPDATE documents SET body=? WHERE collection='profile' AND id=?",
            JSON.stringify({ _id: id(0), startDate: new Date(AT).toISOString() }), id(0));
          else state.storage.sql.exec("UPDATE documents SET body=json_set(body,'$.defaultProfile','Uncommitted') WHERE collection='profile' AND id=?", id(31));
          pending = instance.getLegacyProfileCurrentJson();
          throw new Error("rollback profile read");
        })).toThrow("rollback profile read");
        await pending;
        const after = await measure(state, instance);
        expect(after.status).toBe(lateFirstFill ? 500 : 200);
        if (!lateFirstFill) expect(after.body).toEqual(oracle(state.storage.sql));
        expect(after.validityCalls).toBe(2); expect(after.fastCalls).toBe(lateFirstFill ? 0 : 1);
        expect(after.originalCalls).toBe(lateFirstFill ? 1 : 0); expect(after.writes).toBe(0);
        return { lateFirstFill, after: metrics(after) };
      }));
    }
    console.info(`PROFILE_READONLY_ROLLBACK_HTTP=${JSON.stringify(reports)}`);
  });

  it("falls back once only for the exact old-DO missing-method error", async () => {
    const stub = env.ENTRY_STORE.getByName(`profile-old-do-fallback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => seed(state.storage, 32));
    await evictDurableObject(stub);
    const reports = await runInDurableObject(stub, async (instance, state) => {
      const results = [];
      for (const failure of ["missing", "embedded", "operational"] as const) {
        const sample = await measure(state, instance, "", failure);
        expect(sample.status).toBe(failure === "missing" ? 200 : 500);
        expect(sample.rpc.filter(method => method === "getLegacyProfileCurrentJson")).toHaveLength(1);
        expect(sample.rpc.filter(method => method === "listDocuments")).toHaveLength(failure === "missing" ? 1 : 0);
        if (failure === "missing") expect(sample.body).toEqual(oracle(state.storage.sql));
        expect(sample.writes).toBe(0); results.push({ failure, ...metrics(sample) });
      }
      return results;
    });
    console.info(`PROFILE_READONLY_OLD_DO_HTTP=${JSON.stringify(reports)}`);
  });

  it("declines unsupported keyset ids and oversized proof bodies without marking them complete", async () => {
    const reports = [];
    for (const specimen of [
      { name: "unicode-id", key: "é-tail", malformed: false },
      { name: "nul-id-and-bad-body", key: "unsupported\0tail", malformed: true },
      { name: "huge-id", key: "u".repeat(300), malformed: false },
      { name: "oversized-body", key: id(99_999), malformed: false, large: true },
    ]) {
      const stub = env.ENTRY_STORE.getByName(`profile-unsupported-key-${specimen.name}-${crypto.randomUUID()}`);
      await runInDurableObject(stub, (_instance, state) => {
        seed(state.storage, 32, false);
        const body = specimen.malformed ? "{broken" : JSON.stringify({ _id: specimen.key,
          startDate: "2026-10-19T12:00:00.000Z", ...(specimen.large ? { large: "x".repeat(200 * 1024) } : {}) });
        state.storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
          VALUES('profile',?,?,?,?,?)`, specimen.key, body, AT, AT, AT);
      });
      await evictDurableObject(stub);
      reports.push(await runInDurableObject(stub, async (instance, state) => {
        const samples = [];
        for (let repeat = 0; repeat < 2; repeat++) {
          const sample = await measure(state, instance);
          expect(sample.status).toBe(specimen.malformed ? 500 : 200);
          if (!specimen.malformed) expect(sample.body).toEqual(oracle(state.storage.sql));
          expect(sample.fastCalls).toBe(0); expect(sample.originalCalls).toBe(1); expect(sample.writes).toBe(0);
          samples.push(metrics(sample));
        }
        expect(samples[1]!.validityCalls).toBe(0);
        return { name: specimen.name, samples };
      }));
    }
    console.info(`PROFILE_READONLY_KEYSET_BOUNDARIES=${JSON.stringify(reports)}`);
  });
});
