import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore, JsonDocument } from "../src/entry-store";
import { parseEntryPayload } from "../src/model";

const MINUTE = 60_000;
const TWO_DAYS = 2 * 24 * 60 * MINUTE;
const RAW_CACHE_CAP = 512 * 1024;
// The unchanged snapshot policy accepts 726 ordinary SGVs: its 11-node base
// plus 726 eleven-node SGV objects uses 7,997 of the existing 8,000 nodes.
const OUTPUT_ROWS = 726;
const DEVICE = "synthetic-cgm";
const API3_OPTIONS = JSON.stringify({
  canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null,
  emitRealtime: true, validate: false,
});

interface Row extends Record<string, SqlStorageValue> {
  id: string; body: string; sort_time: number;
}
interface Sgv {
  _id: string; mgdl: number; mills: number; device: string; direction: string; type: string;
}
interface Snapshot { sgvs: Sgv[] }
interface EntryCache {
  clear(): void;
  readonly entries: Map<string, { lower: number; rows: Row[]; limit: number; bytes: number }>;
}
interface Internal {
  realtimeEntryQueries: EntryCache;
  realtimeSnapshot(now: number, frame: boolean, mode: string): Snapshot;
  pluginPropertyContext(now: number): Snapshot;
  realtimeDeviceStatusQueries: { clear(): void };
  realtimeAuxiliaryQueries: Record<string, { clear(): void }>;
  recentTreatmentQueries: { clear(): void };
  boundedTreatmentQueries: { clear(): void };
  realtime: {
    now(): number;
    recordApi3StorageMutationInTransaction(event: unknown): void;
  };
}

const seedId = (n: number) => n.toString(16).padStart(24, "0");
const compactSql = (sql: string) => sql.replace(/\s+/g, " ").trim();
function isSgvWindow(sql: string, limit: 64 | 1000): boolean {
  return sql.includes("collection = 'entries'") && sql.includes("sort_time >= ?")
    && sql.includes("'$.sgv'") && !sql.includes("'$.type'")
    && sql.includes(`LIMIT ${limit}`) && !/\bAND id = \?/.test(sql);
}
function cacheState(cache: EntryCache) {
  // Empty CAL/MBG entries also make cache.ready true. Inspect the exact SGV
  // query instead of treating unrelated empty-result caches as a successful hit.
  return [...cache.entries].filter(([sql]) => isSgvWindow(sql, 1000)).map(([sql, entry]) => ({
    key: compactSql(sql), lower: entry.lower, limit: entry.limit,
    rows: entry.rows.length, bytes: entry.bytes,
  }));
}
function clearFixtureCaches(internal: Internal): void {
  internal.realtimeEntryQueries.clear();
  internal.realtimeDeviceStatusQueries.clear();
  internal.recentTreatmentQueries.clear();
  internal.boundedTreatmentQueries.clear();
  for (const cache of Object.values(internal.realtimeAuxiliaryQueries)) cache.clear();
}

async function seedCanonical(
  instance: EntryStore, state: DurableObjectState, internal: Internal, now: number, count: number,
) {
  // Obtain every canonical field through the real upload/normalization path.
  expect((await instance.putEntries(parseEntryPayload([{
    date: now, dateString: new Date(now).toISOString(),
    sgv: 120, type: "sgv", device: DEVICE,
  }]))).inserted).toBe(1);
  const source = state.storage.sql.exec<Row>(
    "SELECT id, body, sort_time FROM documents WHERE collection = 'entries' LIMIT 1",
  ).one();
  const template = JSON.parse(source.body) as JsonDocument;
  let rawCacheBytes = 0;
  state.storage.transactionSync(() => {
    state.storage.sql.exec("DELETE FROM documents WHERE collection = 'entries'");
    for (let n = 0; n < count; n++) {
      const at = now - (count - n) * MINUTE;
      const id = seedId(n);
      const dateString = new Date(at).toISOString();
      const body = JSON.stringify({ ...template, _id: id, date: at, dateString,
        sysTime: dateString, sgv: 120 + n % 60 });
      rawCacheBytes += JSON.stringify({ id, body, sort_time: at }).length * 2;
      state.storage.sql.exec(`INSERT INTO documents
        (collection,id,body,sort_time,created_at,updated_at)
        VALUES('entries',?,?,?,?,?)`, id, body, at, at, at);
    }
  });
  // Fixture INSERTs bypass mutation hooks; an activation/template-upload cache
  // of the empty/one-row database is not a valid starting point for this test.
  clearFixtureCaches(internal);
  return { seededRows: count, spacingMs: MINUTE, rawCacheBytes, rawCacheCap: RAW_CACHE_CAP,
    sourceCanonicalBodyKeys: Object.keys(template).sort(),
    sourceCanonicalBodyBytes: source.body.length * 2 };
}

function oracle(sql: SqlStorage, now: number, count = OUTPUT_ROWS, frame = false): Sgv[] {
  // This fixture contains only finite numeric SGVs. The existing policy keeps
  // the latest accepted prefix, then presents it oldest first. Current loads
  // include future entries; explicit historical frames additionally cap at now.
  return sql.exec<Row>(`SELECT id, body, sort_time FROM documents
    WHERE collection = 'entries' AND sort_time >= ? ${frame ? "AND sort_time <= ?" : ""}
    ORDER BY sort_time DESC, id ASC LIMIT ?`,
  ...(frame ? [now - TWO_DAYS, now, count] : [now - TWO_DAYS, count]))
    .toArray().map(({ body }) => {
      const document = JSON.parse(body) as JsonDocument;
      return { _id: document._id as string, mgdl: document.sgv as number,
        mills: document.date as number, device: document.device as string,
        direction: document.direction as string, type: "sgv" };
    }).reverse();
}

async function measureRead(
  state: DurableObjectState, internal: Internal, label: string, now: number,
  read: () => Snapshot | Promise<Snapshot>,
) {
  const execute = state.storage.sql.exec.bind(state.storage.sql);
  const cursors: { sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...bindings) => {
    const cursor = execute(sql, ...bindings);
    cursors.push({ sql, cursor });
    return cursor;
  });
  let result: Snapshot;
  try { result = await read(); }
  finally { spy.mockRestore(); }
  const sgvs = JSON.parse(JSON.stringify(result.sgvs)) as Sgv[];
  const text = JSON.stringify(sgvs);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const sgvCursors = cursors.filter(({ sql }) => isSgvWindow(sql, 1000));
  return { sgvs, sample: {
    label, now,
    reads: cursors.reduce((sum, { cursor }) => sum + cursor.rowsRead, 0),
    writes: cursors.reduce((sum, { cursor }) => sum + cursor.rowsWritten, 0),
    sgv1000Reads: sgvCursors.reduce((sum, { cursor }) => sum + cursor.rowsRead, 0),
    sgv1000Calls: sgvCursors.length,
    sgv1000Queries: sgvCursors.map(({ sql, cursor }) => ({ key: compactSql(sql), reads: cursor.rowsRead })),
    cache: cacheState(internal.realtimeEntryQueries),
    returned: sgvs.length, first: sgvs[0] ?? null, last: sgvs.at(-1) ?? null,
    contentsSha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
  } };
}
type ReadSample = Awaited<ReturnType<typeof measureRead>>["sample"];

describe("one-minute canonical SGV node cutoff and raw cache admission", () => {
  for (const count of [727, 1000]) {
    it(`reuses the complete raw window for ${count} canonical one-minute SGVs without changing its output cutoff`, async () => {
      const stub = env.ENTRY_STORE.getByName(`one-minute-sgv-${count}-${crypto.randomUUID()}`);
      const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
        let now = Date.now();
        const internal = instance as unknown as Internal;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        const realtimeClock = vi.spyOn(internal.realtime, "now").mockImplementation(() => now);
        try {
          const fixture = await seedCanonical(instance, state, internal, now, count);
          if (count === 727) expect(fixture.rawCacheBytes).toBeLessThan(RAW_CACHE_CAP);
          else expect(fixture.rawCacheBytes).toBeGreaterThan(RAW_CACHE_CAP);
          const samples: ReadSample[] = [];
          for (const [repeat, mode] of (["root", "ddata", "root", "ddata"] as const).entries()) {
            now += 1000;
            const measured = await measureRead(state, internal, mode, now, () => mode === "root"
              ? internal.realtimeSnapshot(now, false, "root")
              : instance.getDdataSnapshotJson(now, false).then(json => JSON.parse(json) as Snapshot));
            expect(measured.sgvs).toEqual(oracle(state.storage.sql, now));
            expect(measured.sgvs).toHaveLength(OUTPUT_ROWS);
            if (repeat === 0) {
              expect(measured.sample.sgv1000Calls).toBe(1);
              expect(measured.sample.sgv1000Reads).toBeGreaterThan(OUTPUT_ROWS);
              // Count actual workerd reads, allowing bounded evaluation of the
              // same original 1,000-row SQL window on its one cold load.
              expect(measured.sample.sgv1000Reads).toBeLessThanOrEqual(count * 5 + 8);
            } else {
              expect(measured.sample.sgv1000Calls).toBe(0);
              expect(measured.sample.sgv1000Reads).toBe(0);
            }
            expect(measured.sample.cache).toHaveLength(1);
            expect(measured.sample.cache[0]).toMatchObject({ rows: count, limit: 1000 });
            expect(measured.sample.cache[0]!.bytes).toBeLessThanOrEqual(RAW_CACHE_CAP);
            samples.push(measured.sample);
          }
          const properties: ReadSample[] = [];
          for (let repeat = 0; repeat < 2; repeat++) {
            now += 1000;
            const measured = await measureRead(state, internal, `properties-${repeat}`, now,
              () => internal.pluginPropertyContext(now));
            expect(measured.sgvs).toEqual(oracle(state.storage.sql, now, 64));
            expect(measured.sample.sgv1000Calls).toBe(0);
            if (repeat === 1) expect(measured.sample.reads).toBeLessThan(40);
            properties.push(measured.sample);
          }
          return { ...fixture, expectedReturned: OUTPUT_ROWS, samples, properties };
        } finally { realtimeClock.mockRestore(); clock.mockRestore(); }
      });
      console.info(`ONE_MINUTE_SGV_READ_BUDGET=${JSON.stringify(report)}`);
    }, 30_000);
  }

  it("preserves the selected SGV prefix through uploads, changes, rollback and future/frame boundaries", async () => {
    const stub = env.ENTRY_STORE.getByName(`one-minute-sgv-mutations-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      let now = Date.now();
      const internal = instance as unknown as Internal;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const realtimeClock = vi.spyOn(internal.realtime, "now").mockImplementation(() => now);
      try {
        const fixture = await seedCanonical(instance, state, internal, now, 727);
        expect(fixture.rawCacheBytes).toBeLessThan(RAW_CACHE_CAP);
        const samples: ReadSample[] = [];
        const verify = async (label: string, frame = false) => {
          now += 1000;
          const measured = await measureRead(state, internal, label, now,
            () => internal.realtimeSnapshot(now, frame, "root"));
          expect(measured.sgvs).toEqual(oracle(state.storage.sql, now, OUTPUT_ROWS, frame));
          expect(measured.sgvs).toHaveLength(OUTPUT_ROWS);
          samples.push(measured.sample);
          if (!frame) {
            now += 1000;
            const warm = await measureRead(state, internal, `${label}-warm`, now,
              () => internal.realtimeSnapshot(now, false, "root"));
            expect(warm.sgvs).toEqual(oracle(state.storage.sql, now));
            expect(warm.sgvs).toEqual(measured.sgvs);
            expect(warm.sample.sgv1000Calls).toBe(0);
            expect(warm.sample.sgv1000Reads).toBe(0);
            expect(warm.sample.cache).toHaveLength(1);
            expect(warm.sample.cache[0]!.bytes).toBeLessThanOrEqual(RAW_CACHE_CAP);
            samples.push(warm.sample);
          }
          return measured.sgvs;
        };
        await verify("initial");
        for (let n = 0; n < 3; n++) {
          now += MINUTE;
          const id = (100_000 + n).toString(16).padStart(24, "0");
          expect((await instance.putEntries(parseEntryPayload([{
            _id: id, date: now, dateString: new Date(now).toISOString(),
            sgv: 180 + n, type: "sgv", device: DEVICE,
          }]))).inserted).toBe(1);
          const sgvs = await verify(`upload-${n}`);
          expect(sgvs.at(-1)).toMatchObject({ _id: id, mgdl: 180 + n });
        }
        const selectedIdentifier = "one-minute-selected";
        now += 1000;
        expect(JSON.parse(await instance.api3CreateDocument("entries", JSON.stringify({
          identifier: selectedIdentifier, date: now, sgv: 198, device: DEVICE,
          direction: "NONE", utcOffset: 0, app: "synthetic", type: "sgv",
        }), API3_OPTIONS))).toMatchObject({ ok: true });
        const changedId = state.storage.sql.exec<{ id: string }>(
          "SELECT id FROM documents WHERE collection = 'entries' AND identifier = ?",
          selectedIdentifier,
        ).one().id;
        expect((await verify("create-selected")).at(-1)).toMatchObject({ _id: changedId, mgdl: 198 });
        expect(JSON.parse(await instance.api3PatchDocument("entries", selectedIdentifier,
          JSON.stringify({ sgv: 199 }), API3_OPTIONS))).toMatchObject({ ok: true });
        expect((await verify("patch-selected")).find(sgv => sgv._id === changedId)?.mgdl).toBe(199);
        expect((await instance.api3DeleteDocument("entries", selectedIdentifier, true, null)).deleted).toBe(true);
        expect((await verify("delete-selected")).some(sgv => sgv._id === changedId)).toBe(false);

        const before = oracle(state.storage.sql, now);
        const committed = internal.realtimeEntryQueries;
        const callback = internal.realtime.recordApi3StorageMutationInTransaction;
        const failedIdentifier = "one-minute-rollback";
        internal.realtime.recordApi3StorageMutationInTransaction = () => {
          expect(internal.realtimeSnapshot(now, false, "root").sgvs.at(-1)?.mgdl).toBe(210);
          throw new Error("synthetic one-minute SGV rollback");
        };
        try {
          expect(JSON.parse(await instance.api3CreateDocument("entries", JSON.stringify({
            identifier: failedIdentifier, date: now, sgv: 210, device: DEVICE,
            utcOffset: 0, app: "synthetic", type: "sgv",
          }), API3_OPTIONS))).toMatchObject({ ok: false });
        } finally { internal.realtime.recordApi3StorageMutationInTransaction = callback; }
        expect(internal.realtimeEntryQueries).toBe(committed);
        expect(await instance.findApi3Document("entries", failedIdentifier, "null")).toBeNull();
        expect(await verify("rollback-restored")).toEqual(before);

        const futureId = "ffffffffffffffffffffffff";
        const futureAt = now + 60 * MINUTE;
        expect((await instance.putEntries(parseEntryPayload([{
          _id: futureId, date: futureAt, dateString: new Date(futureAt).toISOString(),
          sgv: 188, type: "sgv", device: DEVICE,
        }]))).inserted).toBe(1);
        expect((await verify("current-includes-future")).at(-1)).toMatchObject({ _id: futureId, mills: futureAt });
        expect((await verify("explicit-frame-excludes-future", true)).some(sgv => sgv._id === futureId)).toBe(false);
        expect(state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM documents WHERE collection = 'entries'",
        ).one().count).toBe(731);
        return { ...fixture, expectedReturned: OUTPUT_ROWS, samples };
      } finally { realtimeClock.mockRestore(); clock.mockRestore(); }
    });
    console.info(`ONE_MINUTE_SGV_MUTATIONS=${JSON.stringify(report)}`);
  }, 30_000);
});
