import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, TREATMENT_EVENT_TYPE_INDEX_VALUE_SQL } from "../src/document-repository";
import {
  advance, initialize, readState,
  TREATMENT_READ_SIDE_TABLE as KEYS,
  TREATMENT_READ_SIDE_STATE_TABLE as STATE,
  TREATMENT_READ_SIDE_DATE_INDEX as DATE_INDEX,
  TREATMENT_READ_SIDE_CATEGORY_INDEX as CATEGORY_INDEX,
  TREATMENT_READ_SIDE_API3_INDEX as API3_INDEX,
  TREATMENT_READ_SIDE_DAILY_ROWS,
} from "../src/treatment-read-side-index";

const NOW = Date.parse("2026-10-18T00:00:00.000Z");
const MINUTE = 60_000;
const DAY = 86_400_000;
const id = (n: number) => n.toString(16).padStart(24, "0");

function dropNative(sql: SqlStorage): void {
  sql.exec("DROP INDEX IF EXISTS documents_treatments_created_at");
  sql.exec("DROP INDEX IF EXISTS documents_treatments_event_type_created_at");
}

function seed(sql: SqlStorage, count: number): void {
  sql.exec(`WITH RECURSIVE sequence(n) AS (
    VALUES(0) UNION ALL SELECT n + 1 FROM sequence WHERE n < ${count - 1}
  ) INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,srv_modified)
    SELECT 'treatments', printf('%024x', n), json_object(
      'created_at', strftime('%Y-%m-%dT%H:%M:%fZ', (? + n) / 1000.0, 'unixepoch'),
      'eventType', CASE WHEN n % 7 = 0 THEN 'Sensor Change' ELSE 'Note' END
    ), ? + n, ?, ? + n, CASE WHEN n % 3 = 0 THEN NULL ELSE n END FROM sequence`, NOW, NOW, NOW, NOW);
}

function insert(sql: SqlStorage, key: string, body: string, collection = "treatments", at = NOW): SqlStorageCursor<Record<string, SqlStorageValue>> {
  return sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,srv_modified,is_valid)
    VALUES(?,?,?,?,?,?,?,1)`, collection, key, body, at, at, at + 1, at + 2);
}

function expectedKeys(sql: SqlStorage) {
  return sql.exec(`SELECT id AS read_document_id,
      CASE WHEN json_valid(body) THEN json_extract(body, '$.created_at') END AS read_date_key,
      CASE WHEN json_valid(body) THEN json_type(body, '$.eventType') END AS read_event_type,
      CASE WHEN json_valid(body) THEN ${TREATMENT_EVENT_TYPE_INDEX_VALUE_SQL} END AS read_event_value,
      sort_time AS read_sort_time, srv_modified AS read_srv_modified, updated_at AS read_updated_at
    FROM documents WHERE collection = 'treatments' ORDER BY id ASC`).toArray();
}

function actualKeys(sql: SqlStorage) {
  return sql.exec(`SELECT * FROM ${KEYS} ORDER BY read_document_id ASC`).toArray();
}

function measured<T>(sql: SqlStorage, operation: () => T) {
  const execute = sql.exec.bind(sql);
  const cursors: { sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = execute(statement, ...bindings);
    cursors.push({ sql: statement, cursor });
    return cursor;
  });
  let result: T;
  try { result = operation(); }
  finally { spy.mockRestore(); }
  return { result, reads: cursors.reduce((sum, row) => sum + row.cursor.rowsRead, 0),
    writes: cursors.reduce((sum, row) => sum + row.cursor.rowsWritten, 0),
    statements: cursors.map(row => row.sql) };
}

describe("bounded progressive treatment read side index", () => {
  it("leaves native-index stores untouched and missing side state reads consume no data rows", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-native-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const before = insert(sql, "native-before", '{"created_at":"2026-10-18T00:00:00.000Z","eventType":"Note"}').rowsWritten;
      const initialized = measured(sql, () => state.storage.transactionSync(() => initialize(sql)));
      expect(initialized.statements.some(statement => /\b(?:CREATE|INSERT|UPDATE|DELETE)\b/.test(statement))).toBe(false);
      expect(initialized.writes).toBe(0);
      expect(measured(sql, () => readState(sql))).toMatchObject({ result: null, reads: 0, writes: 0 });
      expect(advance(state.storage, NOW)).toMatchObject({ advanced: false, reason: "uninitialized" });
      expect(sql.exec(`PRAGMA table_info(${KEYS})`).toArray()).toEqual([]);
      const after = insert(sql, "native-after", '{"created_at":"2026-10-18T00:00:00.000Z","eventType":"Note"}').rowsWritten;
      expect(after).toBe(before);
    });
  });

  it("creates empty structures without scanning history and resumes 64-row batches only at minute boundaries", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-batches-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      dropNative(sql);
      seed(sql, 130);
      const initialized = measured(sql, () => state.storage.transactionSync(() => initialize(sql)));
      expect(initialized.statements.some(statement => /\bFROM documents\b/.test(statement))).toBe(false);
      expect(initialized.reads).toBeLessThan(30);
      expect(actualKeys(sql)).toEqual([]);
      expect(sql.exec(`PRAGMA index_info(${DATE_INDEX})`).toArray()).toHaveLength(2);
      expect(sql.exec(`PRAGMA index_info(${CATEGORY_INDEX})`).toArray()).toHaveLength(4);
      expect(sql.exec(`PRAGMA index_info(${API3_INDEX})`).toArray()).toHaveLength(3);
      expect(readState(sql)).toEqual({ cursor: null, complete: false, lastRunAt: null, budgetDay: null, budgetRows: 0 });
      const first = measured(sql, () => advance(state.storage, NOW));
      expect(first.result).toMatchObject({ advanced: true, processed: 64, complete: false,
        state: { cursor: id(63), budgetRows: 64 } });
      expect(first.reads).toBeLessThan(300);
      expect(first.writes).toBe(64 * 4 + 1);
      expect(advance(state.storage, NOW + MINUTE - 1)).toMatchObject({ advanced: false, reason: "interval" });
      expect(advance(state.storage, NOW - DAY)).toMatchObject({ advanced: false, reason: "interval" });
      expect(readState(sql)?.budgetRows).toBe(64);
      // A late canonical write behind the cursor is maintained immediately.
      insert(sql, "!late", '{"created_at":0,"eventType":["Note","Sensor Change"]}');
      expect(sql.exec(`SELECT read_document_id FROM ${KEYS} WHERE read_document_id = '!late'`).toArray()).toHaveLength(1);
      expect(readState(sql)?.cursor).toBe(id(63));
      expect(advance(state.storage, NOW + MINUTE)).toMatchObject({ processed: 64, complete: false, state: { cursor: id(127) } });
      expect(advance(state.storage, NOW + 2 * MINUTE)).toMatchObject({ processed: 2, complete: true, state: { budgetRows: 130 } });
      expect(actualKeys(sql)).toEqual(expectedKeys(sql));
      const done = measured(sql, () => advance(state.storage, NOW + 3 * MINUTE));
      expect(done.result).toMatchObject({ advanced: false, reason: "complete", complete: true });
      expect(done.writes).toBe(0);
      console.info(`TREATMENT_SIDE_BATCH_COST=${JSON.stringify({ initializeReads: initialized.reads,
        initializeWrites: initialized.writes, first64Reads: first.reads, first64Writes: first.writes })}`);
    });
  });

  it("preserves raw mixed keys and atomically tracks inserts, updates, collection moves, ids and deletes", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-triggers-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      dropNative(sql);
      state.storage.transactionSync(() => initialize(sql));
      const bodies = [
        '{}', '{"created_at":null,"eventType":null}', '{"created_at":7,"eventType":true}',
        '{"created_at":false,"eventType":7}', '{"created_at":"007","eventType":"7"}',
        '{"created_at":["z",null],"eventType":["Note","Note",null]}',
        '{"created_at":{"date":"x"},"eventType":{"kind":"Note"}}', '{',
      ];
      for (const [n, body] of bodies.entries()) insert(sql, n === 0 ? "" : id(n), body);
      expect(actualKeys(sql)).toEqual(expectedKeys(sql));
      const malformed = sql.exec(`SELECT * FROM ${KEYS} WHERE read_document_id = ?`, id(7)).one();
      expect(malformed).toMatchObject({ read_date_key: null, read_event_type: null, read_event_value: null });
      const array = sql.exec(`SELECT * FROM ${KEYS} WHERE read_document_id = ?`, id(5)).one();
      expect(array).toMatchObject({ read_event_type: "array", read_event_value: null });
      sql.exec("UPDATE documents SET body = ?, sort_time = ?, srv_modified = ?, updated_at = ? WHERE collection = 'treatments' AND id = ?",
        '{"created_at":"new","eventType":"Changed"}', NOW + 100, NOW + 200, NOW + 300, id(1));
      sql.exec("UPDATE documents SET body = '{' WHERE collection = 'treatments' AND id = ?", id(1));
      expect(sql.exec(`SELECT read_document_id FROM ${KEYS} WHERE read_document_id = ?`, id(1)).toArray()).toHaveLength(1);
      sql.exec("UPDATE documents SET body = ? WHERE collection = 'treatments' AND id = ?", '{"eventType":false}', id(1));
      sql.exec("UPDATE documents SET collection = 'food' WHERE collection = 'treatments' AND id = ?", id(2));
      expect(sql.exec(`SELECT read_document_id FROM ${KEYS} WHERE read_document_id = ?`, id(2)).toArray()).toEqual([]);
      // A non-treatment with the same id must not remove an unrelated key
      // when it changes both collection and id into a new treatment.
      insert(sql, id(3), '{"type":"food"}', "food");
      sql.exec("UPDATE documents SET collection = 'treatments', id = ? WHERE collection = 'food' AND id = ?", "new-from-food", id(3));
      expect(sql.exec(`SELECT read_document_id FROM ${KEYS} WHERE read_document_id = ?`, id(3)).toArray()).toHaveLength(1);
      sql.exec("UPDATE documents SET id = ? WHERE collection = 'treatments' AND id = ?", "renamed", id(4));
      sql.exec("DELETE FROM documents WHERE collection = 'treatments' AND id = ?", id(6));
      expect(actualKeys(sql)).toEqual(expectedKeys(sql));
      // Existing trigger-maintained rows still get bounded backfill coverage.
      expect(advance(state.storage, NOW)).toMatchObject({ complete: true });
      const dateOrder = sql.exec(`SELECT read_document_id AS id FROM ${KEYS}
        ORDER BY read_date_key DESC, read_document_id ASC`).toArray();
      expect(dateOrder).toEqual(sql.exec(`SELECT id FROM documents WHERE collection = 'treatments'
        ORDER BY CASE WHEN json_valid(body) THEN json_extract(body, '$.created_at') END DESC, id ASC`).toArray());
      expect(sql.exec(`SELECT read_document_id AS id FROM ${KEYS}
        ORDER BY read_sort_time DESC, read_srv_modified DESC, read_document_id ASC`).toArray())
        .toEqual(sql.exec(`SELECT id FROM documents WHERE collection = 'treatments'
          ORDER BY sort_time DESC, srv_modified DESC, id ASC`).toArray());
    });
  });

  it("never publishes rolled-back schema or completion and propagates trigger/batch failures atomically", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      dropNative(sql);
      seed(sql, 1);
      expect(() => state.storage.transactionSync(() => {
        initialize(sql);
        expect(readState(sql)?.complete).toBe(false);
        throw new Error("outer initialization rollback");
      })).toThrow("outer initialization rollback");
      expect(readState(sql)).toBeNull();
      state.storage.transactionSync(() => initialize(sql));
      expect(() => state.storage.transactionSync(() => {
        expect(advance(state.storage, NOW).complete).toBe(true);
        expect(readState(sql)?.complete).toBe(true);
        throw new Error("outer completion rollback");
      })).toThrow("outer completion rollback");
      expect(readState(sql)).toEqual({ cursor: null, complete: false, lastRunAt: null, budgetDay: null, budgetRows: 0 });
      expect(actualKeys(sql)).toEqual([]);
      sql.exec(`CREATE TRIGGER audit_side_write_failure BEFORE INSERT ON ${KEYS}
        BEGIN SELECT RAISE(ABORT, 'synthetic side write failure'); END`);
      expect(() => advance(state.storage, NOW)).toThrow("synthetic side write failure");
      expect(readState(sql)?.budgetRows).toBe(0);
      expect(readState(sql)?.cursor).toBeNull();
      expect(actualKeys(sql)).toEqual([]);
      expect(() => insert(sql, "failed-canonical", '{"eventType":"Note"}')).toThrow("synthetic side write failure");
      expect(sql.exec("SELECT id FROM documents WHERE collection = 'treatments' AND id = 'failed-canonical'").toArray()).toEqual([]);
      sql.exec("DROP TRIGGER audit_side_write_failure");
      expect(advance(state.storage, NOW)).toMatchObject({ processed: 1, complete: true });
      const original = actualKeys(sql);
      expect(() => state.storage.transactionSync(() => {
        insert(sql, "temporary", '{"eventType":"Temporary"}');
        sql.exec("DELETE FROM documents WHERE collection = 'treatments' AND id = ?", id(0));
        throw new Error("canonical mutation rollback");
      })).toThrow("canonical mutation rollback");
      expect(actualKeys(sql)).toEqual(original);
      expect(actualKeys(sql)).toEqual(expectedKeys(sql));
    });
  });

  it("limits each UTC day to 5000 processed rows and never resets budget for a backwards clock", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-daily-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      dropNative(sql);
      seed(sql, 5100);
      state.storage.transactionSync(() => initialize(sql));
      let processed = 0;
      const costs = measured(sql, () => {
        for (let batch = 0; batch < 79; batch++) processed += advance(state.storage, NOW + batch * MINUTE).processed;
      });
      expect(processed).toBe(TREATMENT_READ_SIDE_DAILY_ROWS);
      expect(costs.writes).toBe(TREATMENT_READ_SIDE_DAILY_ROWS * 4 + 79);
      expect(readState(sql)).toMatchObject({ cursor: id(4999), complete: false, budgetRows: 5000,
        budgetDay: Math.floor(NOW / DAY) });
      expect(advance(state.storage, NOW + 80 * MINUTE)).toMatchObject({ advanced: false, reason: "daily-budget" });
      expect(advance(state.storage, NOW - DAY)).toMatchObject({ advanced: false, reason: "interval" });
      expect(readState(sql)?.budgetRows).toBe(5000);
      const nextDay = advance(state.storage, NOW + DAY);
      expect(nextDay).toMatchObject({ processed: 64, complete: false, state: {
        budgetDay: Math.floor(NOW / DAY) + 1, budgetRows: 64,
      } });
      const checkpoint = readState(sql);
      expect(advance(state.storage, NOW + DAY - 1)).toMatchObject({ advanced: false, reason: "interval" });
      expect(readState(sql)).toEqual(checkpoint);
      expect(advance(state.storage, NOW + DAY + MINUTE)).toMatchObject({ processed: 36, complete: true, state: { budgetRows: 100 } });
      expect(actualKeys(sql)).toEqual(expectedKeys(sql));
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM documents WHERE collection = 'treatments'").one().count).toBe(5100);
      expect(sql.exec<{ read_day_rows: number }>(`SELECT read_day_rows FROM ${STATE} WHERE singleton = 1`).one().read_day_rows).toBe(100);
      console.info(`TREATMENT_SIDE_DAILY_COST=${JSON.stringify({ processed, reads: costs.reads, writes: costs.writes })}`);
    });
  }, 60_000);

  it("retains malformed bodies in time keys and preserves the original API3 read error", async () => {
    const stub = env.ENTRY_STORE.getByName(`side-malformed-api3-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      dropNative(sql);
      insert(sql, "valid", '{"created_at":"2026-10-18T00:00:00.000Z","eventType":"Note"}', "treatments", NOW - 1);
      insert(sql, "malformed", '{', "treatments", NOW);
      const outcome = () => {
        try { return { value: new SqliteDocumentRepository(state.storage).queryDocumentsForApi3("treatments", { limit: 1 }) }; }
        catch (error) { return { error: error instanceof Error ? { name: error.name, message: error.message } : String(error) }; }
      };
      const original = outcome();
      expect(original).toHaveProperty("error");
      state.storage.transactionSync(() => initialize(sql));
      expect(advance(state.storage, NOW)).toMatchObject({ complete: true, processed: 2 });
      expect(actualKeys(sql)).toEqual(expectedKeys(sql));
      expect(sql.exec(`SELECT read_document_id FROM ${KEYS} ORDER BY read_sort_time DESC,
        read_srv_modified DESC, read_document_id ASC LIMIT 1`).one().read_document_id).toBe("malformed");
      expect(outcome()).toEqual(original);
      sql.exec("UPDATE documents SET body = ? WHERE collection = 'treatments' AND id = 'malformed'",
        '{"created_at":"2026-10-18T00:00:00.001Z","eventType":"Recovered"}');
      expect(actualKeys(sql)).toEqual(expectedKeys(sql));
      expect(outcome()).toHaveProperty("value");
    });
  });
});
