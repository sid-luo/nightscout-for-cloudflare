import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import { parseEntryPayload } from "../src/model";
import worker from "../src/index";

const MINUTE = 60_000;
const DAY = 86_400_000;
const MINUTES = 24 * 60;
const id = (n: number) => n.toString(16).padStart(24, "0");

function status(n: number, at: number) {
  return { _id: id(n), device: "synthetic-loop", date: at, created_at: new Date(at).toISOString(),
    pump: { clock: new Date(at).toISOString(), battery: { percent: 80 }, reservoir: 50 },
    openaps: { suggested: { timestamp: new Date(at).toISOString(), IOB: 0, COB: 0,
      predBGs: Object.fromEntries(["IOB", "COB", "UAM", "ZT"].map(key => [key,
        Array.from({ length: 48 }, (_, point) => 100 + point % 30)])) } } };
}

describe("mixed CGM endurance read budget", () => {
  it("measures twenty-four hours of moving windows, large predictions, glucose and treatment uploads with four readers", async () => {
    const stub = env.ENTRY_STORE.getByName(`mixed-cgm-endurance-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
      let now = Date.now();
      const start = now;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      state.storage.transactionSync(() => {
        for (let n = 0; n < 5000; n++) {
          const at = start - (5000 - n) * MINUTE;
          for (const [collection, body, time] of [
            ["devicestatus", status(n, at), at],
            ["treatments", { _id: id(n), created_at: new Date(at).toISOString(),
              eventType: n % 200 === 0 ? "Sensor Change" : "Note" }, at],
            ["entries", { _id: id(n), device: "synthetic-cgm", type: "sgv", sgv: 110,
              date: start - (5000 - n) * 5 * MINUTE,
              dateString: new Date(start - (5000 - n) * 5 * MINUTE).toISOString() }, start - (5000 - n) * 5 * MINUTE],
          ] as const) state.storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
            VALUES(?,?,?,?,?,?)`, collection, id(n), JSON.stringify(body), time, time, time);
        }
      });
      // Fixture inserts bypass callbacks; discard activation's empty caches.
      const internal = instance as unknown as {
        realtimeEntryQueries: { clear(): void }; realtimeDeviceStatusQueries: { clear(): void };
        legacyDeviceStatusCandidates: { clear(): void }; boundedTreatmentQueries: { clear(): void };
        realtimeAuxiliaryQueries: Record<string, { clear(): void }>;
        realtime: { now(): number };
      };
      internal.realtimeEntryQueries.clear(); internal.realtimeDeviceStatusQueries.clear();
      internal.legacyDeviceStatusCandidates.clear(); internal.boundedTreatmentQueries.clear();
      for (const cache of Object.values(internal.realtimeAuxiliaryQueries)) cache.clear();
      const realtimeClock = vi.spyOn(internal.realtime, "now").mockImplementation(() => now);
      const appEnv = { ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => new Proxy(instance, {
        get(target, key) { const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value; },
      }) }, API_SECRET: "synthetic-endurance-secret", AUTH_DEFAULT_ROLES: "readable", AUTH_FAIL_DELAY: "0" } as unknown as Parameters<typeof worker.fetch>[1];
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      const cursors: { sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
      const lateSql = new Map<string, { reads: number; calls: number }>();
      const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...bindings) => {
        const cursor = exec(sql, ...bindings); cursors.push({ sql: sql.replace(/\s+/g, " ").trim(), cursor }); return cursor;
      });
      const phases: { minute: number; reads: number; writes: number }[] = [];
      let requests = 0, latestSgv = 110, latestSgvAt = start - 5 * MINUTE;
      try {
        for (let minute = 0; minute < MINUTES; minute++) {
          now = start + minute * MINUTE;
          expect(JSON.parse(await instance.createDocuments("devicestatus", JSON.stringify([status(10000 + minute, now)]))))
            .toMatchObject([{ _id: id(10000 + minute) }]);
          if (minute % 5 === 0) {
            latestSgv = 120 + minute % 60;
            latestSgvAt = now;
            expect((await instance.putEntries(parseEntryPayload([{
              date: now, dateString: new Date(now).toISOString(), sgv: latestSgv, type: "sgv", device: "synthetic-cgm",
            }]))).inserted).toBe(1);
          }
          if (minute % 10 === 0) expect(await instance.createLegacyTreatments(JSON.stringify([{
            _id: id(20000 + minute), eventType: "Note", created_at: new Date(now).toISOString(),
          }]))).toMatchObject({ ok: true });
          for (let reader = 0; reader < 4; reader++) {
            now = start + minute * MINUTE + reader * 1000;
            for (const path of [
              `/api/v1/devicestatus.json?find[date][$gte]=${now - 7 * DAY}&count=5`,
              "/api/v1/entries.json?count=1",
              `/api/v1/treatments.json?find[eventType]=Sensor%20Change&find[created_at][$gte]=${new Date(now - 7 * DAY).toISOString()}&count=1`,
              `/api/v1/treatments.json?find[eventType]=Absent%20Synthetic%20Category&find[created_at][$gte]=${new Date(now - 7 * DAY).toISOString()}&count=1`,
              "/api/v2/properties",
            ]) {
              const response = await worker.fetch(new Request(`https://synthetic.invalid${path}`), appEnv);
              expect(response.status, path).toBe(200);
              const body = await response.json();
              if (path.includes("devicestatus")) expect((body as { _id: string }[])[0]?._id).toBe(id(10000 + minute));
              if (path.includes("entries.json")) expect((body as { sgv: number; date: number }[])[0])
                .toMatchObject({ sgv: latestSgv, date: latestSgvAt });
              if (path.includes("Sensor%20Change")) expect(body).toMatchObject([{ _id: id(4800) }]);
              if (path.includes("properties")) expect(body).toMatchObject({ bgnow: { last: latestSgv, mills: latestSgvAt } });
              if (path.includes("Absent")) expect(body).toEqual([]);
              requests++;
            }
          }
          if (minute >= 23 * 60) for (const item of cursors) {
            const prior = lateSql.get(item.sql) ?? { reads: 0, calls: 0 };
            prior.reads += item.cursor.rowsRead; prior.calls++;
            lateSql.set(item.sql, prior);
          }
          phases.push({ minute, reads: cursors.reduce((sum, cursor) => sum + cursor.cursor.rowsRead, 0),
            writes: cursors.reduce((sum, cursor) => sum + cursor.cursor.rowsWritten, 0) });
          cursors.length = 0;
        }
      } finally { spy.mockRestore(); realtimeClock.mockRestore(); clock.mockRestore(); }
      const counts = exec<{ collection: string; count: number }>(`SELECT collection, COUNT(*) AS count
        FROM documents WHERE collection IN ('entries','treatments','devicestatus') GROUP BY collection`).toArray();
      expect(counts).toEqual([
        { collection: "devicestatus", count: 5000 + MINUTES },
        { collection: "entries", count: 5000 + MINUTES / 5 },
        { collection: "treatments", count: 5000 + MINUTES / 10 },
      ]);
      return { requests, minutes: MINUTES, readers: 4, statusUploads: MINUTES, glucoseUploads: MINUTES / 5, treatmentUploads: MINUTES / 10,
        reads: phases.reduce((sum, phase) => sum + phase.reads, 0),
        writes: phases.reduce((sum, phase) => sum + phase.writes, 0),
        maxMinuteReads: Math.max(...phases.map(phase => phase.reads)),
        lateHourSql: [...lateSql].map(([sql, count]) => ({ sql, ...count }))
          .filter(item => item.reads > 1000).sort((a, b) => b.reads - a.reads),
        hours: Array.from({ length: 24 }, (_, hour) => {
          const group = phases.slice(hour * 60, (hour + 1) * 60);
          return { hour, reads: group.reduce((sum, phase) => sum + phase.reads, 0),
            writes: group.reduce((sum, phase) => sum + phase.writes, 0) };
        }) };
    });
    console.info(`MIXED_CGM_ENDURANCE=${JSON.stringify(report)}`);
    expect(report.requests).toBe(MINUTES * 20);
    expect(report.reads).toBeLessThan(4_000_000);
    expect(report.writes).toBeLessThan(100_000);
    expect(report).toMatchInlineSnapshot(`
      {
        "glucoseUploads": 288,
        "hours": [
          {
            "hour": 0,
            "reads": 36025,
            "writes": 1237,
          },
          {
            "hour": 1,
            "reads": 33810,
            "writes": 1254,
          },
          {
            "hour": 2,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 3,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 4,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 5,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 6,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 7,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 8,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 9,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 10,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 11,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 12,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 13,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 14,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 15,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 16,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 17,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 18,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 19,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 20,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 21,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 22,
            "reads": 33811,
            "writes": 1253,
          },
          {
            "hour": 23,
            "reads": 33811,
            "writes": 1253,
          },
        ],
        "lateHourSql": [
          {
            "calls": 6,
            "reads": 18006,
            "sql": "SELECT id, body, sort_time FROM ( SELECT id, body, sort_time, updated_at FROM documents INDEXED BY documents_collection_sort WHERE collection = 'treatments' AND sort_time >= ? AND sort_time <= ? ORDER BY sort_time DESC, updated_at DESC, id ASC LIMIT 1000 ) ORDER BY sort_time ASC, id ASC",
          },
          {
            "calls": 240,
            "reads": 2640,
            "sql": "SELECT * FROM documents WHERE collection = 'entries' AND sort_time >= ? AND ((json_type(body, '$.sgv') IN ('integer', 'real') AND json_extract(body, '$.sgv') != 0) OR (json_type(body, '$.sgv') = 'text' AND length(json_extract(body, '$.sgv')) > 0 AND json_type((CASE WHEN json_valid(trim(CAST(json_extract(body, '$.sgv') AS TEXT))) THEN trim(CAST(json_extract(body, '$.sgv') AS TEXT)) ELSE 'null' END)) IN ('integer', 'real') AND abs(CAST(json_extract(body, '$.sgv') AS REAL)) <= 1.7976931348623157e308) OR json_type(body, '$.sgv') = 'true') AND NOT COALESCE(((json_type(body, '$.mbg') IN ('integer', 'real') AND json_extract(body, '$.mbg') != 0) OR (json_type(body, '$.mbg') = 'text' AND length(json_extract(body, '$.mbg')) > 0) OR json_type(body, '$.mbg') IN ('true', 'array', 'object')), 0) ORDER BY sort_time DESC, id ASC LIMIT 1000",
          },
          {
            "calls": 1278,
            "reads": 2556,
            "sql": "SELECT MIN(deadline) AS deadline FROM ( SELECT MIN(packet.created_at) AS deadline FROM realtime_outbound_packets AS packet INNER JOIN realtime_sessions AS session ON session.sid = packet.sid WHERE session.transport = 'websocket' UNION ALL SELECT MIN(next_attempt_at) AS deadline FROM realtime_websocket_closures )",
          },
          {
            "calls": 240,
            "reads": 1440,
            "sql": "SELECT rowid AS storage_order, id, body, sort_time, updated_at FROM documents INDEXED BY documents_devicestatus_recent WHERE collection = 'devicestatus' ORDER BY sort_time DESC, updated_at DESC LIMIT 5000",
          },
          {
            "calls": 1278,
            "reads": 1278,
            "sql": "SELECT MIN(retry_at) AS retry_at FROM authorization_failures",
          },
          {
            "calls": 1278,
            "reads": 1278,
            "sql": "SELECT MIN(due_at) AS due_at FROM background_tasks",
          },
          {
            "calls": 1278,
            "reads": 1278,
            "sql": "SELECT MIN(due_at) AS due_at FROM data_update_debounce WHERE pending = 1",
          },
          {
            "calls": 1200,
            "reads": 1200,
            "sql": "SELECT EXISTS( SELECT 1 FROM authorization_failures WHERE retry_at + ? < ? ) AS present",
          },
          {
            "calls": 1200,
            "reads": 1200,
            "sql": "SELECT id, body, sort_time FROM documents WHERE collection = ? ORDER BY sort_time DESC, updated_at DESC LIMIT ?",
          },
        ],
        "maxMinuteReads": 5621,
        "minutes": 1440,
        "readers": 4,
        "reads": 813677,
        "requests": 28800,
        "statusUploads": 1440,
        "treatmentUploads": 144,
        "writes": 30057,
      }
    `);
  // This instruments 28,800 HTTP requests and every SQL cursor over a full
  // simulated day. Match the existing one-minute endurance hang guard; the
  // fixed read/write/data assertions above remain the capacity checks.
  }, 180_000);
});
