import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import worker from "../src/index";
import { parseEntryPayload } from "../src/model";

const DAY = 86_400_000;

function appEnvironment(instance: EntryStore): Parameters<typeof worker.fetch>[1] {
  return {
    ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => new Proxy(instance, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) }, API_SECRET: "synthetic-deep-entry-secret", AUTH_DEFAULT_ROLES: "readable", AUTH_FAIL_DELAY: "0",
  } as unknown as Parameters<typeof worker.fetch>[1];
}

function seedEntries(storage: DurableObjectStorage, now: number, instance: EntryStore): void {
  storage.transactionSync(() => {
    for (let n = 0; n < 5_000; n++) {
      const at = now - (5_000 - n) * 300_000;
      storage.sql.exec(`INSERT INTO documents
        (collection,id,body,sort_time,created_at,updated_at,is_valid,identifier,identifier_present)
        VALUES('entries',?,?,?,?,?,1,?,1)`, n.toString(16).padStart(24, "0"), JSON.stringify({
        _id: n.toString(16).padStart(24, "0"), identifier: `synthetic-deep-entry-${n}`, device: "synthetic-cgm", type: "sgv", sgv: 110,
        date: at, dateString: new Date(at).toISOString(),
      }), at, at, at, `synthetic-deep-entry-${n}`);
    }
  });
  // Direct fixture SQL bypasses normal write invalidation. Activation may have
  // warmed an empty notification/root cache before the historical rows existed.
  (instance as unknown as { realtimeEntryQueries: { clear(): void } }).realtimeEntryQueries.clear();
}

async function measure<T>(storage: DurableObjectStorage, operation: () => Promise<T>) {
  const exec = storage.sql.exec.bind(storage.sql);
  const cursors: { sql: string; bindings: SqlStorageValue[]; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(storage.sql, "exec").mockImplementation((sql, ...bindings) => {
    const cursor = exec(sql, ...bindings);
    cursors.push({ sql: sql.replace(/\s+/g, " ").trim(), bindings, cursor });
    return cursor;
  });
  try {
    const result = await operation();
    return { result, reads: cursors.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: cursors.reduce((sum, item) => sum + item.cursor.rowsWritten, 0),
      expensive: cursors.filter(item => item.cursor.rowsRead > 100).map(item => ({
        sql: item.sql, reads: item.cursor.rowsRead,
        plan: exec(`EXPLAIN QUERY PLAN ${item.sql}`, ...item.bindings).toArray(),
      })) };
  } finally { spy.mockRestore(); }
}

describe("deep entry read audit", () => {
  it("measures real HTTP entry and properties reads with actual CGM history present", async () => {
    const stub = env.ENTRY_STORE.getByName(`deep-entry-http-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      seedEntries(state.storage, now, instance);
      const appEnv = appEnvironment(instance);
      const reports = [];
      try {
        for (const path of [
          "/api/v1/entries.json?count=1",
          "/api/v1/entries.json?find[type]=sgv&count=1",
          `/api/v1/entries.json?find[date][$gte]=${now - 2 * DAY}&find[device]=synthetic-cgm&count=1`,
          "/api/v1/count/entries/where",
          "/api/v2/properties",
        ]) {
          const repeats = [];
          for (let n = 0; n < 3; n++) {
            const result = await measure(state.storage, async () => {
              const response = await worker.fetch(new Request(`https://synthetic.invalid${path}`), appEnv);
              expect(response.status, path).toBe(200);
              const body = await response.json();
              if (path.startsWith("/api/v1/entries")) expect(body).toHaveLength(1);
              return null;
            });
            repeats.push({ reads: result.reads, writes: result.writes, expensive: result.expensive });
          }
          reports.push({ path: path.replace(/\d{13}/g, "<relative-date>"), repeats });
        }
        return reports;
      } finally { clock.mockRestore(); }
    });
    console.log(`DEEP_ENTRY_HTTP=${JSON.stringify(report)}`);
    expect(report).toMatchInlineSnapshot(`
      [
        {
          "path": "/api/v1/entries.json?count=1",
          "repeats": [
            {
              "expensive": [],
              "reads": 21,
              "writes": 0,
            },
            {
              "expensive": [],
              "reads": 21,
              "writes": 0,
            },
            {
              "expensive": [],
              "reads": 21,
              "writes": 0,
            },
          ],
        },
        {
          "path": "/api/v1/entries.json?find[type]=sgv&count=1",
          "repeats": [
            {
              "expensive": [],
              "reads": 21,
              "writes": 0,
            },
            {
              "expensive": [],
              "reads": 21,
              "writes": 0,
            },
            {
              "expensive": [],
              "reads": 21,
              "writes": 0,
            },
          ],
        },
        {
          "path": "/api/v1/entries.json?find[date][$gte]=<relative-date>&find[device]=synthetic-cgm&count=1",
          "repeats": [
            {
              "expensive": [
                {
                  "plan": [
                    {
                      "detail": "SCAN CONSTANT ROW",
                      "id": 1,
                      "notused": 0,
                      "parent": 0,
                    },
                    {
                      "detail": "SCALAR SUBQUERY 1",
                      "id": 4,
                      "notused": 0,
                      "parent": 0,
                    },
                    {
                      "detail": "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "id": 16,
                      "notused": 50,
                      "parent": 4,
                    },
                  ],
                  "reads": 577,
                  "sql": "SELECT EXISTS( SELECT 1 FROM documents WHERE collection = 'entries' AND sort_time >= ? ORDER BY sort_time DESC, id ASC LIMIT 1 OFFSET 10000 ) AS present",
                },
              ],
              "reads": 598,
              "writes": 0,
            },
            {
              "expensive": [
                {
                  "plan": [
                    {
                      "detail": "SCAN CONSTANT ROW",
                      "id": 1,
                      "notused": 0,
                      "parent": 0,
                    },
                    {
                      "detail": "SCALAR SUBQUERY 1",
                      "id": 4,
                      "notused": 0,
                      "parent": 0,
                    },
                    {
                      "detail": "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "id": 16,
                      "notused": 50,
                      "parent": 4,
                    },
                  ],
                  "reads": 577,
                  "sql": "SELECT EXISTS( SELECT 1 FROM documents WHERE collection = 'entries' AND sort_time >= ? ORDER BY sort_time DESC, id ASC LIMIT 1 OFFSET 10000 ) AS present",
                },
              ],
              "reads": 598,
              "writes": 0,
            },
            {
              "expensive": [
                {
                  "plan": [
                    {
                      "detail": "SCAN CONSTANT ROW",
                      "id": 1,
                      "notused": 0,
                      "parent": 0,
                    },
                    {
                      "detail": "SCALAR SUBQUERY 1",
                      "id": 4,
                      "notused": 0,
                      "parent": 0,
                    },
                    {
                      "detail": "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "id": 16,
                      "notused": 50,
                      "parent": 4,
                    },
                  ],
                  "reads": 577,
                  "sql": "SELECT EXISTS( SELECT 1 FROM documents WHERE collection = 'entries' AND sort_time >= ? ORDER BY sort_time DESC, id ASC LIMIT 1 OFFSET 10000 ) AS present",
                },
              ],
              "reads": 598,
              "writes": 0,
            },
          ],
        },
        {
          "path": "/api/v1/count/entries/where",
          "repeats": [
            {
              "expensive": [
                {
                  "plan": [
                    {
                      "detail": "SEARCH documents USING COVERING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "id": 6,
                      "notused": 46,
                      "parent": 0,
                    },
                  ],
                  "reads": 1153,
                  "sql": "SELECT COUNT(*) AS count FROM documents WHERE collection = 'entries' AND ('integer' IN ('integer', 'real') AND sort_time >= ?)",
                },
              ],
              "reads": 1160,
              "writes": 0,
            },
            {
              "expensive": [
                {
                  "plan": [
                    {
                      "detail": "SEARCH documents USING COVERING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "id": 6,
                      "notused": 46,
                      "parent": 0,
                    },
                  ],
                  "reads": 1153,
                  "sql": "SELECT COUNT(*) AS count FROM documents WHERE collection = 'entries' AND ('integer' IN ('integer', 'real') AND sort_time >= ?)",
                },
              ],
              "reads": 1160,
              "writes": 0,
            },
            {
              "expensive": [
                {
                  "plan": [
                    {
                      "detail": "SEARCH documents USING COVERING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "id": 6,
                      "notused": 46,
                      "parent": 0,
                    },
                  ],
                  "reads": 1153,
                  "sql": "SELECT COUNT(*) AS count FROM documents WHERE collection = 'entries' AND ('integer' IN ('integer', 'real') AND sort_time >= ?)",
                },
              ],
              "reads": 1160,
              "writes": 0,
            },
          ],
        },
        {
          "path": "/api/v2/properties",
          "repeats": [
            {
              "expensive": [
                {
                  "plan": [
                    {
                      "detail": "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "id": 5,
                      "notused": 50,
                      "parent": 0,
                    },
                    {
                      "detail": "USE TEMP B-TREE FOR LAST TERM OF ORDER BY",
                      "id": 137,
                      "notused": 0,
                      "parent": 0,
                    },
                  ],
                  "reads": 259,
                  "sql": "SELECT id, body, sort_time FROM documents WHERE collection = 'entries' AND sort_time >= ? AND ((json_type(body, '$.sgv') IN ('integer', 'real') AND json_extract(body, '$.sgv') != 0) OR (json_type(body, '$.sgv') = 'text' AND length(json_extract(body, '$.sgv')) > 0 AND json_type((CASE WHEN json_valid(trim(CAST(json_extract(body, '$.sgv') AS TEXT))) THEN trim(CAST(json_extract(body, '$.sgv') AS TEXT)) ELSE 'null' END)) IN ('integer', 'real') AND abs(CAST(json_extract(body, '$.sgv') AS REAL)) <= 1.7976931348623157e308) OR json_type(body, '$.sgv') = 'true') AND NOT COALESCE(((json_type(body, '$.mbg') IN ('integer', 'real') AND json_extract(body, '$.mbg') != 0) OR (json_type(body, '$.mbg') = 'text' AND length(json_extract(body, '$.mbg')) > 0) OR json_type(body, '$.mbg') IN ('true', 'array', 'object')), 0) ORDER BY sort_time DESC, id ASC LIMIT 64",
                },
                {
                  "plan": [
                    {
                      "detail": "SEARCH documents USING INDEX documents_collection_sort (collection=? AND sort_time>?)",
                      "id": 5,
                      "notused": 50,
                      "parent": 0,
                    },
                    {
                      "detail": "USE TEMP B-TREE FOR LAST TERM OF ORDER BY",
                      "id": 72,
                      "notused": 0,
                      "parent": 0,
                    },
                  ],
                  "reads": 578,
                  "sql": "SELECT id, body, sort_time FROM documents WHERE collection = 'entries' AND sort_time >= ? AND ((json_type(body, '$.mbg') IN ('integer', 'real') AND json_extract(body, '$.mbg') != 0) OR (json_type(body, '$.mbg') = 'text' AND length(json_extract(body, '$.mbg')) > 0 AND json_type((CASE WHEN json_valid(trim(CAST(json_extract(body, '$.mbg') AS TEXT))) THEN trim(CAST(json_extract(body, '$.mbg') AS TEXT)) ELSE 'null' END)) IN ('integer', 'real') AND abs(CAST(json_extract(body, '$.mbg') AS REAL)) <= 1.7976931348623157e308) OR json_type(body, '$.mbg') = 'true') ORDER BY sort_time DESC, id ASC LIMIT 10",
                },
              ],
              "reads": 863,
              "writes": 0,
            },
            {
              "expensive": [],
              "reads": 7,
              "writes": 0,
            },
            {
              "expensive": [],
              "reads": 7,
              "writes": 0,
            },
          ],
        },
      ]
    `);
  }, 30_000);

  it("reuses empty MBG windows without hiding uploads, replacement, deletion or clock changes", async () => {
    const stub = env.ENTRY_STORE.getByName(`deep-entry-property-cache-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      let now = Date.now();
      const start = now;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const internal = instance as unknown as { realtimeEntryQueries: { clear(): void } };
      const options = JSON.stringify({ canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: true });
      const context = async () => JSON.parse(await instance.getPluginPropertyContextJson(now)) as {
        sgvs: { mgdl: number }[]; mbgs: { mgdl: number }[];
      };
      const compareFresh = async () => {
        const warm = await context();
        internal.realtimeEntryQueries.clear();
        expect(await context()).toEqual(warm);
        return warm;
      };
      try {
        seedEntries(state.storage, now, instance);
        expect((await context()).mbgs).toEqual([]);
        const warm = await measure(state.storage, context);
        expect(warm.reads).toBeLessThan(40);
        await instance.putEntries(parseEntryPayload([{
          date: now, dateString: new Date(now).toISOString(), device: "synthetic-new-cgm", type: "sgv", sgv: 145,
        }]));
        expect((await compareFresh()).sgvs.at(-1)?.mgdl).toBe(145);
        const body = { identifier: "deep-entry-mbg", date: now, utcOffset: 0, app: "synthetic", type: "mbg", mbg: 105 };
        expect(JSON.parse(await instance.api3CreateDocument("entries", JSON.stringify(body), options))).toMatchObject({ ok: true });
        expect((await compareFresh()).mbgs.map(row => row.mgdl)).toEqual([105]);
        expect(JSON.parse(await instance.api3ReplaceDocument("entries", body.identifier,
          JSON.stringify({ ...body, mbg: 115 }), options))).toMatchObject({ ok: true });
        expect((await compareFresh()).mbgs.map(row => row.mgdl)).toEqual([115]);
        expect((await instance.api3DeleteDocument("entries", body.identifier, true, null)).deleted).toBe(true);
        expect((await compareFresh()).mbgs).toEqual([]);
        now = start + 3 * DAY;
        expect((await compareFresh()).sgvs).toEqual([]);
        now = start - 3600_000;
        expect((await compareFresh()).sgvs.length).toBeGreaterThan(0);
      } finally { clock.mockRestore(); }
    });
  }, 30_000);

  it("preserves read-quota classification when storage fails inside legacy result envelopes", async () => {
    const stub = env.ENTRY_STORE.getByName(`deep-entry-quota-${crypto.randomUUID()}`);
    const results = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      seedEntries(state.storage, Date.now(), instance);
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      const appEnv = appEnvironment(instance);
      const reports = [];
      for (const [path, target] of [
        ["/api/v1/entries.json?count=1", /^SELECT \* FROM documents/],
        ["/api/v1/count/entries/where", /^SELECT COUNT\(\*\) AS count FROM documents/],
      ] as const) {
        const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...bindings) => {
          if (target.test(sql.trim()) && !sql.includes("$.sgv")) {
            throw new Error("Exceeded allowed rows read in Durable Objects free tier.");
          }
          return exec(sql, ...bindings);
        });
        try {
          const response = await worker.fetch(new Request(`https://synthetic.invalid${path}`), appEnv);
          reports.push({ path, status: response.status, retryAfterPresent: Number(response.headers.get("Retry-After")) > 0, body: await response.json() });
        } finally { spy.mockRestore(); }
      }
      return reports;
    });
    console.log(`DEEP_ENTRY_QUOTA=${JSON.stringify(results)}`);
    expect(results).toMatchInlineSnapshot(`
      [
        {
          "body": {
            "error": {
              "code": "storage_read_quota_exceeded",
              "message": "Storage reads are temporarily unavailable until the next daily reset",
            },
          },
          "path": "/api/v1/entries.json?count=1",
          "retryAfterPresent": true,
          "status": 503,
        },
        {
          "body": {
            "error": {
              "code": "storage_read_quota_exceeded",
              "message": "Storage reads are temporarily unavailable until the next daily reset",
            },
          },
          "path": "/api/v1/count/entries/where",
          "retryAfterPresent": true,
          "status": 503,
        },
      ]
    `);
  }, 30_000);
});
