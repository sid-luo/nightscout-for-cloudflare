import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository } from "../src/document-repository";
import type { EntryStore, JsonDocument } from "../src/entry-store";

const OPTIONS = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false };

function seed(storage: DurableObjectStorage, count: number, now: number): void {
  const repository = new SqliteDocumentRepository(storage);
  storage.transactionSync(() => {
    for (let index = 0; index < count; index++) {
      const date = now - (count - index) * 60_000;
      expect(repository.createDocumentForApi3("devicestatus", {
        identifier: `continuous-status-${index}`, date, created_at: new Date(date).toISOString(),
        device: "synthetic", app: "synthetic", utcOffset: 0,
        // The raw 5,000-document result exceeds the old per-entry 1 MiB cache.
        payload: "x".repeat(300), nested: { score: index % 3 }, checks: [{ value: 8 }],
      }, OPTIONS).ok).toBe(true);
    }
  });
}

function oracle(storage: DurableObjectStorage, limit = 5000): JsonDocument[] {
  return storage.sql.exec<{ body: string }>(
    "SELECT body FROM documents WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT ?",
    "devicestatus", limit,
  ).toArray().map(row => JSON.parse(row.body));
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
    return { result, reads: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      writes: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0) };
  } finally { spy.mockRestore(); }
}

describe("legacy device status continuous-read budget", () => {
  it("keeps the complete candidate window current while uploads and changing queries continue", async () => {
    const stub = env.ENTRY_STORE.getByName(`continuous-status-budget-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const now = Date.now();
      seed(state.storage, 5100, now);
      const samples: { stage: string; reads: number; writes: number }[] = [];
      for (let iteration = 0; iteration < 4; iteration++) {
        if (iteration === 1) await instance.createDocuments("devicestatus", JSON.stringify([
          { _id: "111111111111111111111111", device: "legacy", created_at: new Date(now + 1000).toISOString() },
        ]));
        if (iteration === 2) expect(JSON.parse(await instance.api3CreateDocument("devicestatus", JSON.stringify({
          identifier: "continuous-new", device: "api3", app: "synthetic", date: now + 2000, utcOffset: 0,
        }), JSON.stringify(OPTIONS)))).toMatchObject({ ok: true });
        const expected = oracle(state.storage);
        const measured = await measure(state.storage, () => instance.getLegacyDeviceStatusJson(5000));
        expect(JSON.parse(measured.result)).toEqual(expected);
        samples.push({ stage: ["cold", "legacy-upload", "api3-upload", "unchanged"][iteration]!, reads: measured.reads, writes: measured.writes });
      }
      console.info(JSON.stringify({ label: "legacy-continuous-status-candidates", records: 5100, samples }));
      expect(samples).toMatchInlineSnapshot(`
        [
          {
            "reads": 5001,
            "stage": "cold",
            "writes": 0,
          },
          {
            "reads": 0,
            "stage": "legacy-upload",
            "writes": 0,
          },
          {
            "reads": 0,
            "stage": "api3-upload",
            "writes": 0,
          },
          {
            "reads": 0,
            "stage": "unchanged",
            "writes": 0,
          },
        ]
      `);
      expect(samples[0]!.reads).toBeGreaterThanOrEqual(5000);
      expect(samples.slice(1).every(sample => sample.reads === 0)).toBe(true);
      expect(samples.every(sample => sample.writes === 0)).toBe(true);
    });
  }, 30_000);
});
