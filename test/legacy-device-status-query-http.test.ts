import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { filterDocuments } from "../src/documents";
import type { EntryStore, JsonDocument } from "../src/entry-store";
import worker from "../src/index";
import { syntheticDeviceStatus } from "./fixtures/synthetic-device-status";

const ORIGIN = "https://synthetic.invalid";
const RECORDS = 5105;
const id = (index: number) => index.toString(16).padStart(24, "0");

function status(index: number, at: number): JsonDocument {
  return {
    ...syntheticDeviceStatus(`synthetic-${index}`, at), _id: id(index), created_at: new Date(at).toISOString(),
    pump: { battery: { percent: index % 80 }, clock: new Date(at).toISOString(), reservoir: 50 },
    openaps: { suggested: { timestamp: new Date(at).toISOString(), IOB: 0, COB: 0,
      predBGs: { IOB: Array(48).fill(110), COB: Array(48).fill(110), UAM: Array(48).fill(110), ZT: Array(48).fill(110) } } },
    checks: [{ value: index % 3 }, { value: 8 }], ...(index === 0 ? { onlyOldest: "yes" } : {}),
  };
}

function seed(storage: DurableObjectStorage, now: number): void {
  storage.transactionSync(() => {
    for (let index = 0; index < RECORDS; index++) {
      const at = now - (RECORDS - index) * 60_000;
      storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
        VALUES('devicestatus',?,?,?,?,?)`, id(index), JSON.stringify(status(index, at)), at, at, at);
    }
  });
}

function oracle(sql: SqlStorage, search: string): JsonDocument[] {
  return filterDocuments(sql.exec<{ body: string }>(
    "SELECT body FROM documents WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT 5000", "devicestatus",
  ).toArray().map(row => JSON.parse(row.body)), new URL(`${ORIGIN}/api/v1/devicestatus.json${search}`), 10);
}

function configuration(instance: EntryStore, intercept?: (property: string) => unknown): Parameters<typeof worker.fetch>[1] {
  const forward = new Proxy(instance, { get(target, property) {
    const replacement = typeof property === "string" ? intercept?.(property) : undefined;
    if (replacement !== undefined) return replacement;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return { ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => forward },
    API_SECRET: "synthetic-query-http-secret", AUTH_DEFAULT_ROLES: "readable", AUTH_FAIL_DELAY: "0",
  } as unknown as Parameters<typeof worker.fetch>[1];
}

async function measure(storage: DurableObjectStorage, action: () => Promise<Response>) {
  const exec = storage.sql.exec.bind(storage.sql);
  const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  const spy = vi.spyOn(storage.sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = exec(statement, ...bindings); cursors.push(cursor); return cursor;
  });
  try {
    const response = await action();
    const body = await response.json<JsonDocument[]>();
    return { response, body, reads: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      writes: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0) };
  } finally { spy.mockRestore(); }
}

describe("query-aware device status HTTP reads", () => {
  it("keeps large-prediction filtered reads current and bounded during uploads, preserving sorted and absent-result semantics", async () => {
    const stub = env.ENTRY_STORE.getByName(`query-device-http-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const now = Date.now();
      seed(state.storage, now);
      const configured = configuration(instance);
      for (let cycle = 0; cycle < 3; cycle++) {
        const at = now + cycle * 60_000;
        await instance.createDocuments("devicestatus", JSON.stringify([status(70_000 + cycle, at)]));
        for (const search of [
          `?find[date][$gte]=${at - 7 * 86_400_000}&count=5`,
          "?find[device]=openaps://synthetic-phone&count=5", "?find[checks.value]=8&count=5",
          "?find[openaps.suggested.timestamp][$exists]=true&count=5",
        ]) {
          const expected = oracle(state.storage.sql, search);
          const measured = await measure(state.storage, () => worker.fetch(
            new Request(`${ORIGIN}/api/v1/devicestatus.json${search}`), configured));
          expect(measured.response.status).toBe(200);
          expect(measured.body).toEqual(expected);
          expect(measured.body[0]!._id).toBe(id(70_000 + cycle));
          expect(measured.reads, search).toBeLessThan(100);
          expect(measured.writes).toBe(0);
        }
      }
      for (const search of ["?sort[pump.battery.percent]=1&count=5", "?find[onlyOldest]=yes&count=1"]) {
        for (let repeat = 0; repeat < 2; repeat++) {
          const measured = await measure(state.storage, () => worker.fetch(
            new Request(`${ORIGIN}/api/v1/devicestatus.json${search}`), configured));
          expect(measured.response.status).toBe(200);
          expect(measured.body).toEqual(oracle(state.storage.sql, search));
          if (repeat === 0) {
            expect(measured.reads).toBeGreaterThanOrEqual(5000);
            expect(measured.reads).toBeLessThanOrEqual(5100);
          } else expect(measured.reads).toBeLessThan(100);
          expect(measured.writes).toBe(0);
        }
      }
    });
  }, 60_000);

  it("falls back through precise missing query-aware and candidate RPCs without changing the candidate window", async () => {
    const stub = env.ENTRY_STORE.getByName(`query-device-fallback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      seed(state.storage, Date.now());
      const search = "?find[onlyOldest]=yes&count=1";
      const missing = (method: string) => new Error(`RPC receiver does not implement the method "${method}".`);
      for (const missingCandidate of [false, true]) {
        const next = vi.fn().mockRejectedValue(missing("getLegacyDeviceStatusQueryJson"));
        const candidate = missingCandidate ? vi.fn().mockRejectedValue(missing("getLegacyDeviceStatusJson"))
          : vi.fn(instance.getLegacyDeviceStatusJson.bind(instance));
        const list = vi.fn(instance.listDocuments.bind(instance));
        const configured = configuration(instance, property => property === "getLegacyDeviceStatusQueryJson" ? next
          : property === "getLegacyDeviceStatusJson" ? candidate : property === "listDocuments" ? list : undefined);
        const response = await worker.fetch(new Request(`${ORIGIN}/api/v1/devicestatus.json${search}`), configured);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(oracle(state.storage.sql, search));
        expect(next).toHaveBeenCalledExactlyOnceWith(search);
        expect(candidate).toHaveBeenCalledExactlyOnceWith(5000);
        expect(list).toHaveBeenCalledTimes(missingCandidate ? 1 : 0);
      }
      const candidate = vi.fn(instance.getLegacyDeviceStatusJson.bind(instance));
      // A local stub lacking a property takes the same older-DO path.
      const configured = configuration(instance, property => property === "getLegacyDeviceStatusQueryJson" ? null
        : property === "getLegacyDeviceStatusJson" ? candidate : undefined);
      const response = await worker.fetch(new Request(`${ORIGIN}/api/v1/devicestatus.json?count=5`), configured);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(oracle(state.storage.sql, "?count=5"));
      expect(candidate).toHaveBeenCalledExactlyOnceWith(5);
    });
  }, 60_000);

  it("never falls back for operational, quota or differently named missing-method errors", async () => {
    const stub = env.ENTRY_STORE.getByName(`query-device-errors-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore) => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        for (const [message, expectedStatus] of [
          ["synthetic operational failure", 500],
          ['RPC receiver does not implement the method "anotherMethod".', 500],
          ["Exceeded allowed rows read in Durable Objects free tier.", 503],
        ] as const) {
          const next = vi.fn().mockRejectedValue(new Error(message));
          const candidate = vi.fn(instance.getLegacyDeviceStatusJson.bind(instance));
          const list = vi.fn(instance.listDocuments.bind(instance));
          const configured = configuration(instance, property => property === "getLegacyDeviceStatusQueryJson" ? next
            : property === "getLegacyDeviceStatusJson" ? candidate : property === "listDocuments" ? list : undefined);
          const response = await worker.fetch(new Request(`${ORIGIN}/api/v1/devicestatus.json?count=5`), configured);
          expect(response.status, message).toBe(expectedStatus);
          expect(next).toHaveBeenCalledTimes(1);
          expect(candidate).not.toHaveBeenCalled();
          expect(list).not.toHaveBeenCalled();
          if (expectedStatus === 503) {
            expect(await response.json()).toMatchObject({ error: { code: "storage_read_quota_exceeded" } });
            expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
          }
        }
        const next = vi.fn(instance.getLegacyDeviceStatusQueryJson.bind(instance));
        const configured = configuration(instance, property => property === "getLegacyDeviceStatusQueryJson" ? next : undefined);
        expect((await worker.fetch(new Request(`${ORIGIN}/api/v1/devicestatus.json?count=0`), configured)).status).toBe(400);
        expect(next).not.toHaveBeenCalled();
        expect((await worker.fetch(new Request(`${ORIGIN}/api/v1/devicestatus.json?count=5`, {
          headers: { "api-secret": "synthetic-invalid" },
        }), configured)).status).toBe(401);
        expect(next).not.toHaveBeenCalled();
      } finally { errorLog.mockRestore(); }
    });
  });
});
