import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import worker from "../src/index";

const ORIGIN = "https://synthetic.invalid";
const DAY = 86_400_000;

function forwardingEnvironment(instance: EntryStore): Parameters<typeof worker.fetch>[1] {
  return {
    ASSETS: env.ASSETS,
    ENTRY_STORE: { getByName: () => new Proxy(instance, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) },
    API_SECRET: "synthetic-continuous-http-secret", AUTH_DEFAULT_ROLES: "readable", AUTH_FAIL_DELAY: "0",
  } as unknown as Parameters<typeof worker.fetch>[1];
}

describe("continuous uploads and multiple HTTP readers", () => {
  it("keeps current results and measures changing queries across a twelve-minute mixed workload", async () => {
    const stub = env.ENTRY_STORE.getByName(`continuous-http-budget-${crypto.randomUUID()}`);
    const measured = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const storage = state.storage;
      let now = Date.now();
      const start = now;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      storage.transactionSync(() => {
        for (let n = 0; n < 5_000; n++) {
          const at = now - (5_000 - n) * 60_000;
          storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
            VALUES(?,?,?,?,?,?)`, "devicestatus", n.toString(16).padStart(24, "0"), JSON.stringify({
            device: "synthetic", created_at: new Date(at).toISOString(), date: at, payload: "x".repeat(300),
          }), at, at, at);
          storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
            VALUES(?,?,?,?,?,?)`, "treatments", n.toString(16).padStart(24, "0"), JSON.stringify({
            created_at: new Date(at).toISOString(), eventType: n % 200 === 0 ? "Sensor Change" : "Note",
          }), at, at, at);
        }
      });
      const exec = storage.sql.exec.bind(storage.sql);
      let cursors: { sql: string; bindings: SqlStorageValue[]; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
      const spy = vi.spyOn(storage.sql, "exec").mockImplementation((sql, ...bindings) => {
        const cursor = exec(sql, ...bindings);
        cursors.push({ sql: sql.replace(/\s+/g, " ").trim(), bindings, cursor });
        return cursor;
      });
      const phases: { label: string; reads: number; writes: number; requests: number }[] = [];
      const expensiveQueries: { sql: string; reads: number; plan: unknown[] }[] = [];
      const take = (label: string, requests: number) => {
        if (label === "read-0") for (const item of cursors) {
          if (item.cursor.rowsRead >= 5_000) expensiveQueries.push({
            sql: item.sql, reads: item.cursor.rowsRead,
            plan: exec(`EXPLAIN QUERY PLAN ${item.sql}`, ...item.bindings).toArray(),
          });
        }
        phases.push({ label, requests,
          reads: cursors.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
          writes: cursors.reduce((sum, item) => sum + item.cursor.rowsWritten, 0) });
        cursors = [];
      };
      const appEnv = forwardingEnvironment(instance);
      const get = async (path: string) => {
        const response = await worker.fetch(new Request(`${ORIGIN}${path}`), appEnv);
        expect(response.status, path).toBe(200);
        return response.json<unknown>();
      };
      try {
        for (let cycle = 0; cycle < 12; cycle++) {
          now = start + cycle * 60_000;
          const id = (10_000 + cycle).toString(16).padStart(24, "0");
          await instance.createDocuments("devicestatus", JSON.stringify([{
            _id: id, device: "synthetic", created_at: new Date(now).toISOString(), date: now,
          }]));
          if (cycle % 6 === 0) await instance.createLegacyTreatments(JSON.stringify([{
            _id: (20_000 + cycle).toString(16).padStart(24, "0"),
            created_at: new Date(now).toISOString(), eventType: "Note",
          }]));
          take(`upload-${cycle}`, 0);
          for (let reader = 0; reader < 4; reader++) {
            // Readers arrive at different times. A fixed millisecond must not
            // manufacture exact-key cache hits for naturally moving windows.
            now = start + cycle * 60_000 + reader * 1_000;
            const status = await get(`/api/v1/devicestatus.json?find[date][$gte]=${now - 7 * DAY}&count=5`) as { _id: string }[];
            expect(status).toHaveLength(5);
            expect(status[0]!._id).toBe(id);
            for (const eventType of ["Sensor Change", "Absent Synthetic Type"]) {
              const treatments = await get(`/api/v1/treatments.json?find[eventType]=${encodeURIComponent(eventType)}&find[created_at][$gte]=${new Date(now - 7 * DAY).toISOString()}&count=1`) as unknown[];
              expect(treatments).toHaveLength(eventType === "Sensor Change" ? 1 : 0);
            }
            await get("/api/v2/properties");
          }
          take(`read-${cycle}`, 16);
        }
      } finally {
        spy.mockRestore();
        clock.mockRestore();
      }
      expect(storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM documents WHERE collection='devicestatus'").one().count).toBe(5012);
      expect(storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM documents WHERE collection='treatments'").one().count).toBe(5002);
      return { phases, expensiveQueries, reads: phases.reduce((sum, phase) => sum + phase.reads, 0),
        writes: phases.reduce((sum, phase) => sum + phase.writes, 0),
        requests: phases.reduce((sum, phase) => sum + phase.requests, 0) };
    });
    console.log(`CONTINUOUS_HTTP_READ_BUDGET=${JSON.stringify(measured)}`);
    expect(measured).toMatchInlineSnapshot(`
      {
        "expensiveQueries": [],
        "phases": [
          {
            "label": "upload-0",
            "reads": 21,
            "requests": 0,
            "writes": 30,
          },
          {
            "label": "read-0",
            "reads": 3221,
            "requests": 16,
            "writes": 0,
          },
          {
            "label": "upload-1",
            "reads": 11,
            "requests": 0,
            "writes": 14,
          },
          {
            "label": "read-1",
            "reads": 156,
            "requests": 16,
            "writes": 0,
          },
          {
            "label": "upload-2",
            "reads": 11,
            "requests": 0,
            "writes": 14,
          },
          {
            "label": "read-2",
            "reads": 156,
            "requests": 16,
            "writes": 0,
          },
          {
            "label": "upload-3",
            "reads": 11,
            "requests": 0,
            "writes": 14,
          },
          {
            "label": "read-3",
            "reads": 156,
            "requests": 16,
            "writes": 0,
          },
          {
            "label": "upload-4",
            "reads": 11,
            "requests": 0,
            "writes": 14,
          },
          {
            "label": "read-4",
            "reads": 156,
            "requests": 16,
            "writes": 0,
          },
          {
            "label": "upload-5",
            "reads": 11,
            "requests": 0,
            "writes": 14,
          },
          {
            "label": "read-5",
            "reads": 156,
            "requests": 16,
            "writes": 0,
          },
          {
            "label": "upload-6",
            "reads": 21,
            "requests": 0,
            "writes": 30,
          },
          {
            "label": "read-6",
            "reads": 3221,
            "requests": 16,
            "writes": 0,
          },
          {
            "label": "upload-7",
            "reads": 11,
            "requests": 0,
            "writes": 14,
          },
          {
            "label": "read-7",
            "reads": 156,
            "requests": 16,
            "writes": 0,
          },
          {
            "label": "upload-8",
            "reads": 11,
            "requests": 0,
            "writes": 14,
          },
          {
            "label": "read-8",
            "reads": 156,
            "requests": 16,
            "writes": 0,
          },
          {
            "label": "upload-9",
            "reads": 11,
            "requests": 0,
            "writes": 14,
          },
          {
            "label": "read-9",
            "reads": 156,
            "requests": 16,
            "writes": 0,
          },
          {
            "label": "upload-10",
            "reads": 11,
            "requests": 0,
            "writes": 14,
          },
          {
            "label": "read-10",
            "reads": 156,
            "requests": 16,
            "writes": 0,
          },
          {
            "label": "upload-11",
            "reads": 11,
            "requests": 0,
            "writes": 14,
          },
          {
            "label": "read-11",
            "reads": 156,
            "requests": 16,
            "writes": 0,
          },
        ],
        "reads": 8154,
        "requests": 192,
        "writes": 200,
      }
    `);
    // Every result must remain current while the query date, writes and reader
    // count change. The bound includes authorization and background SQL too.
    expect(measured.requests).toBe(192);
    expect(measured.reads).toBeLessThan(50_000);
  }, 30_000);
});
