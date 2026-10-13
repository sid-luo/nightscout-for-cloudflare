import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository } from "../src/document-repository";
import { filterDocuments } from "../src/documents";
import type { EntryStore, JsonDocument } from "../src/entry-store";
import worker from "../src/index";

const OPTIONS = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false };
const ORIGIN = "https://synthetic.invalid";

function forwardingEnvironment(instance: EntryStore): Parameters<typeof worker.fetch>[1] {
  const forwarded = new Proxy(instance, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => forwarded },
    API_SECRET: "synthetic-read-budget-secret", AUTH_DEFAULT_ROLES: "readable", AUTH_FAIL_DELAY: "0",
  } as unknown as Parameters<typeof worker.fetch>[1];
}

async function read(instance: EntryStore, query = "", version = 1): Promise<JsonDocument[]> {
  const response = await worker.fetch(
    new Request(`${ORIGIN}/api/v${version}/devicestatus.json${query}`), forwardingEnvironment(instance),
  );
  expect(response.status, query).toBe(200);
  return response.json<JsonDocument[]>();
}

/** Preserve the pre-optimization SQL prefix and JavaScript query semantics. */
function oracle(storage: DurableObjectStorage, query = ""): JsonDocument[] {
  const documents = storage.sql.exec<{ body: string }>(
    "SELECT body FROM documents WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT ?",
    "devicestatus", 5000,
  ).toArray().map(row => JSON.parse(row.body) as JsonDocument);
  return filterDocuments(documents, new URL(`${ORIGIN}/api/v1/devicestatus.json${query}`), 10);
}

function seed(storage: DurableObjectStorage, count: number, now: number): void {
  const repository = new SqliteDocumentRepository(storage);
  storage.transactionSync(() => {
    for (let index = 0; index < count; index++) {
      const date = now - (count - index) * 60_000;
      const result = repository.createDocumentForApi3("devicestatus", {
        identifier: `synthetic-device-status-${index}`, app: "synthetic", device: `synthetic-${index % 3}`,
        date, created_at: new Date(date).toISOString(), utcOffset: 0,
        uploaderBattery: index % 2 === 0 ? 8 : "08",
        nested: { score: index % 5, flag: index % 2 === 0, label: index % 2 === 0 ? "MiXeD.[literal]" : "other" },
        checks: [{ value: index % 3 }, { value: 8 }],
        ...(index === 0 ? { onlyOldest: "yes" } : {}),
      }, OPTIONS);
      expect(result.ok).toBe(true);
    }
  });
}

async function measure<T>(storage: DurableObjectStorage, action: () => Promise<T>) {
  const exec = storage.sql.exec.bind(storage.sql);
  const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  const spy = vi.spyOn(storage.sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = exec(statement, ...bindings);
    cursors.push(cursor);
    return cursor;
  });
  try {
    const result = await action();
    return {
      result,
      reads: cursors.reduce((total, cursor) => total + cursor.rowsRead, 0),
      writes: cursors.reduce((total, cursor) => total + cursor.rowsWritten, 0),
    };
  } finally {
    spy.mockRestore();
  }
}

describe("legacy REST device status read budget", () => {
  it("pushes small counts to storage without changing response content, on cold and repeated reads", async () => {
    const stub = env.ENTRY_STORE.getByName(`legacy-status-budget-${crypto.randomUUID()}`);
    const samples = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      seed(state.storage, 5000, Date.now());
      const samples: { repeat: number; reads: number; writes: number }[] = [];
      for (const query of ["?count=5", "", "?count=1", "?count=5.0", "?count=5&count=9"]) {
        const expected = oracle(state.storage, query);
        for (let repeat = 0; repeat < 3; repeat++) {
          const measured = await measure(state.storage, () => read(instance, query));
          expect(measured.result, `${query}, repeat ${repeat}`).toEqual(expected);
          expect(measured.reads, `${query}, repeat ${repeat}`).toBeLessThan(100);
          expect(measured.writes).toBe(0);
          if (query === "?count=5") samples.push({ repeat, reads: measured.reads, writes: measured.writes });
        }
      }
      expect(await read(instance, "?count=5", 2)).toEqual(oracle(state.storage, "?count=5"));
      for (const count of ["0", "-1", "1.5", "10001", "NaN"]) {
        const response = await worker.fetch(new Request(`${ORIGIN}/api/v1/devicestatus.json?count=${count}`), forwardingEnvironment(instance));
        expect(response.status, count).toBe(400);
      }
      return samples;
    });
    console.info(JSON.stringify({ label: "legacy-rest-device-status-count5", records: 5000, samples }));
  }, 30_000);

  it("preserves fallback filtering, coercion, sort stability, ties and the existing 5000-document prefix", async () => {
    const stub = env.ENTRY_STORE.getByName(`legacy-status-semantics-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const now = Date.now();
      seed(state.storage, 5105, now);
      // Deliberate timestamp and update ties exercise the original SQL order.
      state.storage.sql.exec(
        "UPDATE documents SET sort_time = ?, updated_at = ? WHERE collection = 'devicestatus' AND identifier IN (?, ?, ?)",
        now, now, "synthetic-device-status-5102", "synthetic-device-status-5103", "synthetic-device-status-5104",
      );
      const queries = [
        "?count=5", "?count=10000", "?count=5000", "?find[onlyOldest]=yes&count=1",
        "?find[nested.score][$gte]=2&count=7",
        "?find[checks.value]=8&count=9",
        "?find[uploaderBattery]=8&count=11",
        "?find[nested.label]=/mixed.[literal]/i&count=13",
        "?find[nested.flag]=true&count=5",
        "?find[missing][$exists]=false&count=5",
        "?find[checks.value][$ne]=8&count=5",
        "?find[nested.score][$in]=1,3&sort[device]=1&count=12",
        "?sort[nested.score]=1&count=15",
        "?sort[date]=-1&sort[device]=1&count=8",
        "?find[nested.score][$unknown]=2&count=5",
        "?ignored=value&count=5",
      ];
      for (const query of queries) {
        const expected = oracle(state.storage, query);
        expect(await read(instance, query), query).toEqual(expected);
        expect(await read(instance, query), `repeat ${query}`).toEqual(expected);
      }
      expect(await read(instance, "?count=10000")).toHaveLength(5000);
      expect(await read(instance, "?find[onlyOldest]=yes&count=1")).toEqual([]);
    });
  }, 30_000);

  it("invalidates empty and warm responses across API1/API3 mutations, deletion, maintenance and rollback", async () => {
    const stub = env.ENTRY_STORE.getByName(`legacy-status-mutations-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const now = Date.now();
      const queries = ["?count=5", "?find[diagnosticTag]=changed&count=5"];
      const verify = async () => {
        for (const query of queries) expect(await read(instance, query), query).toEqual(oracle(state.storage, query));
      };
      const document = (identifier: string, date: number, diagnosticTag = "original") => ({
        identifier, app: "synthetic", device: "synthetic", diagnosticTag,
        date, created_at: new Date(date).toISOString(), utcOffset: 0,
      });
      const create = (identifier: string, date: number) => instance.api3CreateDocument(
        "devicestatus", JSON.stringify(document(identifier, date)), JSON.stringify(OPTIONS),
      );
      await verify();
      const legacy = JSON.parse(await instance.createDocuments("devicestatus", JSON.stringify([
        { _id: "111111111111111111111111", device: "synthetic", created_at: new Date(now - 10_000).toISOString() },
      ]))) as JsonDocument[];
      expect(legacy).toHaveLength(1);
      await verify();
      expect(JSON.parse(await create("mutable", now))).toMatchObject({ ok: true });
      await verify();
      expect(JSON.parse(await instance.api3ReplaceDocument("devicestatus", "mutable",
        JSON.stringify(document("mutable", now, "changed")), JSON.stringify(OPTIONS)))).toMatchObject({ ok: true });
      await verify();
      expect(JSON.parse(await instance.api3PatchDocument("devicestatus", "mutable",
        JSON.stringify({ diagnosticTag: "patched" }), JSON.stringify(OPTIONS)))).toMatchObject({ ok: true });
      await verify();
      expect((await instance.api3DeleteDocument("devicestatus", "mutable", false, null)).deleted).toBe(true);
      await verify();
      expect((await instance.api3DeleteDocument("devicestatus", "mutable", true, null)).deleted).toBe(true);
      await verify();
      expect(await instance.deleteDocuments("devicestatus", [String(legacy[0]!._id)])).toBe(1);
      await verify();
      expect(JSON.parse(await create("cleanup", now))).toMatchObject({ ok: true });
      await verify();
      expect((await instance.maintenanceDelete("devicestatus", now - 60_000, now + 60_000, null, false)).n).toBe(1);
      await verify();

      expect(JSON.parse(await create("retained", now))).toMatchObject({ ok: true });
      await verify();
      const before = oracle(state.storage);
      const internal = instance as unknown as { recordDataMutationInTransaction(collection: string): void };
      const original = internal.recordDataMutationInTransaction;
      internal.recordDataMutationInTransaction = function (collection) {
        original.call(this, collection);
        throw new Error("synthetic REST cache rollback");
      };
      try {
        expect(JSON.parse(await create("rolled-back", now + 1000))).toMatchObject({ ok: false });
      } finally {
        internal.recordDataMutationInTransaction = original;
      }
      expect(oracle(state.storage)).toEqual(before);
      await verify();
    });
  });

  it("rebuilds a correct response after Durable Object eviction", async () => {
    const stub = env.ENTRY_STORE.getByName(`legacy-status-eviction-${crypto.randomUUID()}`);
    const expected = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      seed(state.storage, 20, Date.now());
      expect(await read(instance, "?count=5")).toEqual(oracle(state.storage, "?count=5"));
      return oracle(state.storage, "?count=5");
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (instance: EntryStore) => {
      expect(await read(instance, "?count=5")).toEqual(expected);
    });
  });
});
