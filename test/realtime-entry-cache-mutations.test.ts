import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore, JsonDocument } from "../src/entry-store";
import { parseLegacyEntryPayload } from "../src/model";
import type { RealtimeEntryQueryCache } from "../src/realtime/entry-query-cache";

interface Row { id: string; body: string; sort_time: number }
interface Snapshot { sgvs: unknown[]; mbgs: unknown[]; cals: unknown[] }
interface Internal {
  realtimeEntryQueries: RealtimeEntryQueryCache<Row>;
  realtimeSnapshot: (now: number, frame?: boolean) => Snapshot;
  realtime: { recordApi3StorageMutationInTransaction: (event: unknown) => void };
}
const options = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: true };
const create = async (instance: EntryStore, identifier: string, date: number, fields: JsonDocument = {}) => {
  const result = JSON.parse(await instance.api3CreateDocument("entries", JSON.stringify({
    identifier, date, utcOffset: 0, app: "synthetic", device: "synthetic", type: "sgv", sgv: 110, ...fields,
  }), JSON.stringify({ ...options, validate: false })));
  expect(result).toMatchObject({ ok: true });
  return result;
};

function verify(internal: Internal, now: number): Snapshot {
  const cached = internal.realtimeSnapshot(now);
  internal.realtimeEntryQueries.clear();
  expect(internal.realtimeSnapshot(now)).toEqual(cached);
  return cached;
}

const isWindowScan = (sql: string) => sql.includes("collection = 'entries'") &&
  sql.includes("sort_time >= ?") && sql.includes("LIMIT 1000") && !sql.includes("AND id = ?");

describe("transactional incremental Entries queries", () => {
  it("updates canonical v3 rows through primary-key predicates without rescanning the window", async () => {
    const stub = env.ENTRY_STORE.getByName(`entry-point-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const internal = instance as unknown as Internal;
      const now = Date.now();
      for (let index = 0; index < 288; index++) await create(instance, `seed-${index}`, now - (288-index)*300_000);
      internal.realtimeSnapshot(now);
      const execute = state.storage.sql.exec.bind(state.storage.sql);
      const points: { sql: string; bindings: SqlStorageValue[]; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...bindings) => {
        const cursor = execute(sql, ...bindings);
        if (sql.includes("collection = 'entries' AND id = ?") && sql.includes("LIMIT 1000")) points.push({ sql, bindings, cursor });
        return cursor;
      });
      try {
        await create(instance, "new", now);
        expect(internal.realtimeSnapshot(now).sgvs).toHaveLength(289);
        expect(JSON.parse(await instance.api3CreateDocument("devicestatus", JSON.stringify({
          identifier: "state", date: now, utcOffset: 0, app: "synthetic", uploaderBattery: 80,
        }), JSON.stringify(options)))).toMatchObject({ ok: true });
        internal.realtimeSnapshot(now);
        expect(spy.mock.calls.filter(([sql]) => isWindowScan(sql))).toHaveLength(0);
      } finally { spy.mockRestore(); }
      expect(points).toHaveLength(3);
      for (const point of points) {
        expect(point.cursor.rowsRead).toBeLessThanOrEqual(3);
        const plan = execute(`EXPLAIN QUERY PLAN ${point.sql}`, ...point.bindings).toArray();
        expect(plan.some(row => String(row.detail).includes("collection=? AND id=?"))).toBe(true);
      }
      verify(internal, now);
    });
  });

  it("retains original SQL coercion, exclusion predicates and tie ordering across v3 changes", async () => {
    const stub = env.ENTRY_STORE.getByName(`entry-predicates-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore) => {
      const internal = instance as unknown as Internal;
      const now = Date.now();
      internal.realtimeSnapshot(now);
      const values: JsonDocument[] = [
        { sgv: "110" }, { sgv: "0" }, { sgv: true }, { sgv: false }, { sgv: "0x10" },
        { sgv: "1e309" }, { sgv: " 99 " }, { sgv: 111, mbg: "0" },
        { sgv: 0, mbg: 90, type: "mbg" }, { sgv: 0, type: "cal", slope: 1 },
      ];
      for (const [index, fields] of values.entries()) {
        await create(instance, `numeric-${index}`, now, fields);
        verify(internal, now);
      }
      expect(JSON.parse(await instance.api3ReplaceDocument("entries", "numeric-0", JSON.stringify({
        identifier: "numeric-0", date: now, utcOffset: 0, app: "synthetic", device: "synthetic", type: "mbg", mbg: 105,
      }), JSON.stringify(options)))).toMatchObject({ ok: true });
      verify(internal, now);
      expect(JSON.parse(await instance.api3PatchDocument("entries", "numeric-0", JSON.stringify({ mbg: 0, sgv: 120, type: "sgv" }), JSON.stringify(options)))).toMatchObject({ ok: true });
      verify(internal, now);
      expect((await instance.api3DeleteDocument("entries", "numeric-0", false, null)).deleted).toBe(true);
      verify(internal, now);
      expect((await instance.api3DeleteDocument("entries", "numeric-0", true, null)).deleted).toBe(true);
      verify(internal, now);
      verify(internal, now + 49 * 3600_000);
      verify(internal, now - 3600_000);
      const frame = internal.realtimeSnapshot(now - 1, true);
      internal.realtimeEntryQueries.clear();
      expect(internal.realtimeSnapshot(now - 1, true)).toEqual(frame);
    });
  });

  it("restores the committed v3 cache after a mutation callback fails", async () => {
    const stub = env.ENTRY_STORE.getByName(`entry-fork-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore) => {
      const internal = instance as unknown as Internal;
      const now = Date.now();
      await create(instance, "kept", now - 300_000);
      const before = internal.realtimeSnapshot(now);
      const committed = internal.realtimeEntryQueries;
      const original = internal.realtime.recordApi3StorageMutationInTransaction;
      internal.realtime.recordApi3StorageMutationInTransaction = () => {
        expect(internal.realtimeSnapshot(now).sgvs).toHaveLength(2);
        throw new Error("synthetic post-cache callback failure");
      };
      try {
        expect(JSON.parse(await instance.api3CreateDocument("entries", JSON.stringify({
          identifier: "failed", date: now, utcOffset: 0, app: "synthetic", sgv: 120,
        }), JSON.stringify(options)))).toMatchObject({ ok: false });
      } finally { internal.realtime.recordApi3StorageMutationInTransaction = original; }
      expect(internal.realtimeEntryQueries).toBe(committed);
      expect(verify(internal, now)).toEqual(before);
      expect(await instance.findApi3Document("entries", "failed", "null")).toBeNull();
    });
  });

  it("merges v1 insert/replay and preserves the committed prefix after a later batch error", async () => {
    const stub = env.ENTRY_STORE.getByName(`entry-v1-fork-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const internal = instance as unknown as Internal;
      const now = Date.now();
      const input = (date: number, id: string, sgv = 110) => ({ _id: id, date, dateString: new Date(date).toISOString(), type: "sgv", sgv, device: "synthetic" });
      const first = input(now - 300_000, "aaaaaaaaaaaaaaaaaaaaaaaa");
      await instance.putEntries(parseLegacyEntryPayload(first));
      internal.realtimeSnapshot(now);
      const spy = vi.spyOn(state.storage.sql, "exec");
      try {
        await instance.putEntries(parseLegacyEntryPayload({ ...first, sgv: 112 }));
        expect(internal.realtimeSnapshot(now).sgvs).toHaveLength(1);
        await instance.putEntries(parseLegacyEntryPayload(input(now, "bbbbbbbbbbbbbbbbbbbbbbbb")));
        expect(internal.realtimeSnapshot(now).sgvs).toHaveLength(2);
        expect(spy.mock.calls.filter(([sql]) => isWindowScan(sql))).toHaveLength(0);
      } finally { spy.mockRestore(); }
      verify(internal, now);
      await expect(instance.putEntries(parseLegacyEntryPayload([
        input(now + 300_000, "cccccccccccccccccccccccc"),
        { ...first, _id: "dddddddddddddddddddddddd" },
        input(now + 600_000, "eeeeeeeeeeeeeeeeeeeeeeee"),
      ]))).rejects.toThrow("immutable field _id");
      expect(verify(internal, now).sgvs).toHaveLength(3);
      expect(await instance.getEntryById("cccccccccccccccccccccccc")).toHaveLength(1);
      expect(await instance.getEntryById("eeeeeeeeeeeeeeeeeeeeeeee")).toHaveLength(0);
      expect(await instance.deleteEntries(["cccccccccccccccccccccccc"])).toBe(1);
      expect(verify(internal, now).sgvs).toHaveLength(2);
    });
  });

  it("restores the v1 cache if shadow persistence fails after the canonical row and cache update", async () => {
    const stub = env.ENTRY_STORE.getByName(`entry-v1-shadow-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const internal = instance as unknown as Internal;
      const now = Date.now();
      const entry = (id: string, date: number) => parseLegacyEntryPayload({
        _id: id, date, dateString: new Date(date).toISOString(), type: "sgv", sgv: 110,
      });
      await instance.putEntries(entry("aaaaaaaaaaaaaaaaaaaaaaaa", now - 300_000));
      const before = internal.realtimeSnapshot(now);
      const committed = internal.realtimeEntryQueries;
      const execute = state.storage.sql.exec.bind(state.storage.sql);
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...bindings) => {
        if (sql.includes("INSERT INTO entries") && bindings[0] === "bbbbbbbbbbbbbbbbbbbbbbbb") {
          expect(internal.realtimeSnapshot(now).sgvs).toHaveLength(2);
          throw new Error("synthetic shadow persistence failure");
        }
        return execute(sql, ...bindings);
      });
      try {
        await expect(instance.putEntries(entry("bbbbbbbbbbbbbbbbbbbbbbbb", now)))
          .rejects.toThrow("synthetic shadow persistence failure");
      } finally { spy.mockRestore(); }
      expect(internal.realtimeEntryQueries).toBe(committed);
      expect(verify(internal, now)).toEqual(before);
      expect(await instance.getEntryById("bbbbbbbbbbbbbbbbbbbbbbbb")).toHaveLength(0);
      await instance.putEntries(entry("bbbbbbbbbbbbbbbbbbbbbbbb", now));
      expect(verify(internal, now).sgvs).toHaveLength(2);
    });
  });
});
