import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import { DurableObjectWriteQuotaError, durableObjectWriteQuotaResetAt } from "../src/platform-errors";
import { initialize, readState } from "../src/treatment-read-side-index";

const MINUTE = 60_000;
const DAY = 86_400_000;
const OPTIONS = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false };
interface Internal {
  treatmentCategoryIndexAvailable: boolean | undefined;
  treatmentReadIndexCooldownUntil: number;
  storageWriteQuotaBlockedUntil: number;
  realtimeSnapshot(at: number): unknown;
  pluginPropertyContext(at: number): unknown;
}

function prepare(instance: EntryStore, storage: DurableObjectStorage, now: number, count = 130): void {
  storage.sql.exec("DROP INDEX documents_treatments_created_at");
  storage.sql.exec("DROP INDEX documents_treatments_event_type_created_at");
  storage.sql.exec(`WITH RECURSIVE sequence(n) AS (
    VALUES(0) UNION ALL SELECT n+1 FROM sequence WHERE n < ?
  ) INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
    SELECT 'treatments', printf('%024x',n), json_object('_id',printf('%024x',n),
      'created_at', strftime('%Y-%m-%dT%H:%M:%fZ',?/1000.0,'unixepoch'), 'eventType','Note'),
      ?,?,?,1 FROM sequence`, count - 1, now, now, now, now);
  storage.transactionSync(() => initialize(storage.sql));
  (instance as unknown as Internal).treatmentCategoryIndexAvailable = undefined;
  expect(readState(storage.sql)).toMatchObject({ cursor: null, complete: false, budgetRows: 0 });
}

function coreSnapshot(sql: SqlStorage): string {
  return JSON.stringify({
    documents: sql.exec("SELECT * FROM documents ORDER BY collection,id").toArray(),
    revisions: sql.exec("SELECT * FROM document_changes ORDER BY change_id").toArray(),
    clocks: sql.exec("SELECT * FROM collection_clocks ORDER BY collection").toArray(),
  });
}

describe("bounded side backfill piggybacks on existing Durable Object alarm turns", () => {
  it("advances a partial index on an already scheduled alarm, once per minute, without creating a backfill alarm", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-existing-alarm-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      let now = Date.now();
      prepare(instance, state.storage, now);
      expect(await state.storage.getAlarm()).toBeNull();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        // Schedule an existing application alarm sufficiently in the future
        // that the test controls delivery via the real alarm entry point.
        const due = now + MINUTE;
        await state.storage.setAlarm(due);
        expect(await state.storage.getAlarm()).toBe(due);
        now = due;
        const setAlarm = vi.spyOn(state.storage, "setAlarm");
        try {
          await instance.alarm();
          expect(readState(state.storage.sql)).toMatchObject({ budgetRows: 64, complete: false, lastRunAt: now });
          const first = readState(state.storage.sql);
          expect(await state.storage.getAlarm()).toBeNull();
          await instance.alarm(); // At-least-once redelivery in the same minute.
          expect(readState(state.storage.sql)).toEqual(first);
          now += MINUTE - 1;
          await instance.alarm();
          expect(readState(state.storage.sql)).toEqual(first);
          expect(setAlarm).not.toHaveBeenCalled();
        } finally { setAlarm.mockRestore(); }
        now += 1;
        await state.storage.setAlarm(now);
        await instance.alarm();
        expect(readState(state.storage.sql)).toMatchObject({ budgetRows: 128, complete: false });
        now += MINUTE;
        await state.storage.setAlarm(now);
        await instance.alarm();
        expect(readState(state.storage.sql)).toMatchObject({ budgetRows: 130, complete: true });
        expect(await state.storage.getAlarm()).toBeNull();
      } finally { clock.mockRestore(); }
    });
  });

  it("retains the shared 5000-row UTC budget and resumes only when another alarm arrives after reset", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-alarm-daily-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      let now = Date.now() + MINUTE;
      prepare(instance, state.storage, now);
      state.storage.sql.exec(`UPDATE treatment_read_side_state
        SET read_budget_day=?,read_day_rows=4999,read_last_run_at=? WHERE singleton=1`,
      Math.floor(now / DAY), now - MINUTE);
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        await state.storage.setAlarm(now);
        await instance.alarm();
        expect(readState(state.storage.sql)).toMatchObject({ budgetRows: 5000, complete: false });
        const exhausted = readState(state.storage.sql);
        now += MINUTE;
        await state.storage.setAlarm(now);
        await instance.alarm();
        expect(readState(state.storage.sql)).toEqual(exhausted);
        expect(await state.storage.getAlarm()).toBeNull();
        now = durableObjectWriteQuotaResetAt(now);
        const atReset = readState(state.storage.sql);
        // Advancing wall-clock time itself schedules no new wakeup or batch.
        expect(await state.storage.getAlarm()).toBeNull();
        expect(atReset).toEqual(exhausted);
        await state.storage.setAlarm(now);
        await instance.alarm();
        expect(readState(state.storage.sql)).toMatchObject({ budgetRows: 64,
          budgetDay: Math.floor(now / DAY), complete: false, lastRunAt: now });
        expect(await state.storage.getAlarm()).toBeNull();
      } finally { clock.mockRestore(); }
    });
  });

  it("rolls optional quota work back without contaminating an already committed canonical upload or the main write gate", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-alarm-quota-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      let now = Date.now();
      prepare(instance, state.storage, now);
      const internal = instance as unknown as Internal;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        const created = JSON.parse(await instance.api3CreateDocument("treatments", JSON.stringify({
          identifier: "committed-before-alarm", app: "synthetic-alarm-side", utcOffset: 0,
          date: now, created_at: new Date(now).toISOString(), eventType: "Note", notes: "must remain committed",
        }), JSON.stringify(OPTIONS)));
        expect(created).toMatchObject({ ok: true });
        expect(await state.storage.getAlarm()).toBeNull();
        const canonical = coreSnapshot(state.storage.sql);
        const progress = readState(state.storage.sql);
        const keys = state.storage.sql.exec("SELECT * FROM treatment_read_side_keys ORDER BY read_document_id").toArray();
        expect(keys).toHaveLength(1);
        const exec = state.storage.sql.exec.bind(state.storage.sql);
        let fail = true;
        let attempts = 0;
        const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((statement, ...bindings) => {
          const cursor = exec(statement, ...bindings);
          if (/^\s*INSERT INTO treatment_read_side_keys\b/.test(statement)) {
            attempts++;
            if (fail) throw new DurableObjectWriteQuotaError();
          }
          return cursor;
        });
        try {
          now += MINUTE;
          await state.storage.setAlarm(now);
          await expect(instance.alarm()).resolves.toBeUndefined();
          expect(attempts).toBe(1);
          expect(coreSnapshot(state.storage.sql)).toBe(canonical);
          expect(readState(state.storage.sql)).toEqual(progress);
          expect(state.storage.sql.exec("SELECT * FROM treatment_read_side_keys ORDER BY read_document_id").toArray()).toEqual(keys);
          expect(internal.treatmentReadIndexCooldownUntil).toBe(durableObjectWriteQuotaResetAt(now));
          expect(internal.storageWriteQuotaBlockedUntil).toBe(0);
          expect(await state.storage.getAlarm()).toBeNull();
          fail = false;
          now += MINUTE;
          await state.storage.setAlarm(now);
          await instance.alarm();
          expect(attempts).toBe(1);
          expect(readState(state.storage.sql)).toEqual(progress);
          now = durableObjectWriteQuotaResetAt(now);
          await state.storage.setAlarm(now);
          await instance.alarm();
          expect(attempts).toBe(2);
          expect(readState(state.storage.sql)).toMatchObject({ budgetRows: 64, complete: false, lastRunAt: now });
          expect(coreSnapshot(state.storage.sql)).toBe(canonical);
          expect(await instance.findApi3Document("treatments", "committed-before-alarm", "null")).not.toBeNull();
          expect(await state.storage.getAlarm()).toBeNull();
        } finally { spy.mockRestore(); }
      } finally { clock.mockRestore(); }
    });
  });

  it("does not promise autonomous progress when writes and private snapshots have no existing alarm", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-no-independent-alarm-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      let now = Date.now();
      prepare(instance, state.storage, now);
      const internal = instance as unknown as Internal;
      const initial = readState(state.storage.sql);
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const setAlarm = vi.spyOn(state.storage, "setAlarm");
      try {
        expect(await state.storage.getAlarm()).toBeNull();
        for (let n = 0; n < 2; n++) {
          now += DAY;
          expect(JSON.parse(await instance.api3CreateDocument("treatments", JSON.stringify({
            identifier: `no-alarm-upload-${n}`, app: "synthetic-alarm-side", utcOffset: 0,
            date: now, created_at: new Date(now).toISOString(), eventType: "Note",
          }), JSON.stringify(OPTIONS)))).toMatchObject({ ok: true });
          internal.realtimeSnapshot(now);
          internal.pluginPropertyContext(now);
          expect(readState(state.storage.sql)).toEqual(initial);
          expect(await state.storage.getAlarm()).toBeNull();
        }
        expect(setAlarm).not.toHaveBeenCalled();
      } finally { setAlarm.mockRestore(); clock.mockRestore(); }
    });
  });
});
