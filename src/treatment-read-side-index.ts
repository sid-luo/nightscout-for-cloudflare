import { TREATMENT_EVENT_TYPE_INDEX_VALUE_SQL } from "./document-repository";

export const TREATMENT_READ_SIDE_TABLE = "treatment_read_side_keys";
export const TREATMENT_READ_SIDE_STATE_TABLE = "treatment_read_side_state";
export const TREATMENT_READ_SIDE_DATE_INDEX = "treatment_read_side_date";
export const TREATMENT_READ_SIDE_CATEGORY_INDEX = "treatment_read_side_category";
export const TREATMENT_READ_SIDE_API3_INDEX = "treatment_read_side_api3";
export const TREATMENT_READ_SIDE_BATCH_SIZE = 64;
export const TREATMENT_READ_SIDE_DAILY_ROWS = 5_000;
export const TREATMENT_READ_SIDE_INTERVAL_MS = 60_000;
const DAY_MS = 86_400_000;

export interface TreatmentReadSideIndexState {
  cursor: string | null;
  complete: boolean;
  lastRunAt: number | null;
  budgetDay: number | null;
  budgetRows: number;
}

export interface TreatmentReadSideIndexAdvanceResult {
  advanced: boolean;
  processed: number;
  complete: boolean;
  reason: "uninitialized" | "complete" | "interval" | "daily-budget" | "advanced";
  state: TreatmentReadSideIndexState | null;
}

interface StateRow extends Record<string, SqlStorageValue> {
  read_schema_version: number;
  read_cursor_id: string | null;
  read_complete: number;
  read_last_run_at: number | null;
  read_budget_day: number | null;
  read_day_rows: number;
}

/** Every call observes committed/transaction-local SQL state, never an in-memory ready flag. */
export function readState(sql: SqlStorage): TreatmentReadSideIndexState | null {
  // Missing-index PRAGMA has zero data rows read on normal native-index stores.
  if (sql.exec(`PRAGMA index_info(${TREATMENT_READ_SIDE_DATE_INDEX})`).toArray().length !== 2) return null;
  const row = sql.exec<StateRow>(`SELECT read_schema_version, read_cursor_id, read_complete,
      read_last_run_at, read_budget_day, read_day_rows
    FROM ${TREATMENT_READ_SIDE_STATE_TABLE} WHERE singleton = 1`).toArray()[0];
  if (row === undefined || row.read_schema_version !== 1) return null;
  return { cursor: row.read_cursor_id, complete: row.read_complete === 1,
    lastRunAt: row.read_last_run_at, budgetDay: row.read_budget_day, budgetRows: row.read_day_rows };
}

function newRowUpsert(): string {
  const eventValue = TREATMENT_EVENT_TYPE_INDEX_VALUE_SQL.replace(/\bbody\b/g, "NEW.body");
  return `INSERT INTO ${TREATMENT_READ_SIDE_TABLE} (
      read_document_id, read_date_key, read_event_type, read_event_value,
      read_sort_time, read_srv_modified, read_updated_at
    ) SELECT NEW.id,
      CASE WHEN json_valid(NEW.body) THEN json_extract(NEW.body, '$.created_at') END,
      CASE WHEN json_valid(NEW.body) THEN json_type(NEW.body, '$.eventType') END,
      CASE WHEN json_valid(NEW.body) THEN ${eventValue} END,
      NEW.sort_time, NEW.srv_modified, NEW.updated_at
      WHERE NEW.collection = 'treatments'
    ON CONFLICT(read_document_id) DO UPDATE SET
      read_date_key = excluded.read_date_key, read_event_type = excluded.read_event_type,
      read_event_value = excluded.read_event_value, read_sort_time = excluded.read_sort_time,
      read_srv_modified = excluded.read_srv_modified, read_updated_at = excluded.read_updated_at;`;
}

/** Call inside the surrounding schema transaction. This creates only empty structures. */
export function initialize(sql: SqlStorage): void {
  const nativeDate = sql.exec("PRAGMA index_info(documents_treatments_created_at)").toArray().length;
  const nativeCategory = sql.exec("PRAGMA index_info(documents_treatments_event_type_created_at)").toArray().length;
  if (nativeDate === 3 && nativeCategory === 5) return;
  if (readState(sql) !== null) return;
  sql.exec(`CREATE TABLE IF NOT EXISTS ${TREATMENT_READ_SIDE_STATE_TABLE} (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    read_schema_version INTEGER NOT NULL CHECK (read_schema_version = 1),
    read_cursor_id TEXT,
    read_complete INTEGER NOT NULL CHECK (read_complete IN (0, 1)),
    read_last_run_at INTEGER,
    read_budget_day INTEGER,
    read_day_rows INTEGER NOT NULL CHECK (read_day_rows BETWEEN 0 AND ${TREATMENT_READ_SIDE_DAILY_ROWS})
  )`);
  // No affinity on extracted keys or copied SQL values: preserve SQLite's
  // NULL/number/text ordering and equality, including serialized JSON arrays.
  sql.exec(`CREATE TABLE IF NOT EXISTS ${TREATMENT_READ_SIDE_TABLE} (
    read_document_id TEXT PRIMARY KEY,
    read_date_key,
    read_event_type TEXT,
    read_event_value,
    read_sort_time,
    read_srv_modified,
    read_updated_at
  ) WITHOUT ROWID`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${TREATMENT_READ_SIDE_DATE_INDEX}
    ON ${TREATMENT_READ_SIDE_TABLE}(read_date_key DESC, read_document_id ASC)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${TREATMENT_READ_SIDE_CATEGORY_INDEX}
    ON ${TREATMENT_READ_SIDE_TABLE}(read_event_type, read_event_value, read_date_key DESC, read_document_id ASC)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS ${TREATMENT_READ_SIDE_API3_INDEX}
    ON ${TREATMENT_READ_SIDE_TABLE}(read_sort_time DESC, read_srv_modified DESC, read_document_id ASC)`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS treatment_read_side_insert
    AFTER INSERT ON documents WHEN NEW.collection = 'treatments'
    BEGIN ${newRowUpsert()} END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS treatment_read_side_update
    AFTER UPDATE OF collection, id, body, sort_time, srv_modified, updated_at ON documents
    WHEN OLD.collection = 'treatments' OR NEW.collection = 'treatments'
    BEGIN
      DELETE FROM ${TREATMENT_READ_SIDE_TABLE}
        WHERE read_document_id = OLD.id AND OLD.collection = 'treatments'
          AND (NEW.collection != 'treatments' OR NEW.id IS NOT OLD.id);
      ${newRowUpsert()}
    END`);
  sql.exec(`CREATE TRIGGER IF NOT EXISTS treatment_read_side_delete
    AFTER DELETE ON documents WHEN OLD.collection = 'treatments'
    BEGIN DELETE FROM ${TREATMENT_READ_SIDE_TABLE} WHERE read_document_id = OLD.id; END`);
  // State becomes visible only after all required empty indexes and triggers.
  sql.exec(`INSERT OR IGNORE INTO ${TREATMENT_READ_SIDE_STATE_TABLE}
    (singleton, read_schema_version, read_cursor_id, read_complete, read_last_run_at, read_budget_day, read_day_rows)
    VALUES (1, 1, NULL, 0, NULL, NULL, 0)`);
}

function skipped(
  state: TreatmentReadSideIndexState | null,
  reason: Exclude<TreatmentReadSideIndexAdvanceResult["reason"], "advanced">,
): TreatmentReadSideIndexAdvanceResult {
  return { advanced: false, processed: 0, complete: state?.complete ?? false, reason, state };
}

/**
 * One bounded optional batch. The caller controls which public read entry
 * points invoke it and handles quota cooldown; all errors propagate unchanged.
 * Partial indexes must never serve queries. Canonical writes are synchronized
 * by triggers from initialization onward, including ids behind the cursor.
 */
export function advance(storage: DurableObjectStorage, now: number): TreatmentReadSideIndexAdvanceResult {
  if (!Number.isFinite(now) || !Number.isSafeInteger(Math.trunc(now))) throw new RangeError("invalid side-index time");
  const at = Math.trunc(now);
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const state = readState(sql);
    if (state === null) return skipped(null, "uninitialized");
    if (state.complete) return skipped(state, "complete");
    if (state.lastRunAt !== null && at < state.lastRunAt + TREATMENT_READ_SIDE_INTERVAL_MS) {
      return skipped(state, "interval");
    }
    const today = Math.floor(at / DAY_MS);
    // A backwards clock never resets or increases the remaining daily budget.
    const budgetDay = state.budgetDay === null || today > state.budgetDay ? today : state.budgetDay;
    const priorRows = state.budgetDay === null || today > state.budgetDay ? 0 : state.budgetRows;
    const limit = Math.min(TREATMENT_READ_SIDE_BATCH_SIZE, TREATMENT_READ_SIDE_DAILY_ROWS - priorRows);
    if (limit <= 0) return skipped(state, "daily-budget");

    const initial = state.cursor === null;
    const ids = sql.exec<{ id: string }>(`SELECT id FROM documents
      WHERE collection = 'treatments' ${initial ? "" : "AND id > ?"}
      ORDER BY id ASC LIMIT ?`, ...(initial ? [] : [state.cursor!]), limit + 1).toArray();
    const selected = ids.slice(0, limit);
    const cursor = selected.at(-1)?.id ?? state.cursor;
    if (selected.length > 0) {
      // Even malformed bodies receive time/id keys so API3 keeps its original
      // body/error behavior. Guard only JSON extraction inside the 64-row range.
      sql.exec(`INSERT INTO ${TREATMENT_READ_SIDE_TABLE} (
          read_document_id, read_date_key, read_event_type, read_event_value,
          read_sort_time, read_srv_modified, read_updated_at
        ) SELECT id,
          CASE WHEN json_valid(body) THEN json_extract(body, '$.created_at') END,
          CASE WHEN json_valid(body) THEN json_type(body, '$.eventType') END,
          CASE WHEN json_valid(body) THEN ${TREATMENT_EVENT_TYPE_INDEX_VALUE_SQL} END,
          sort_time, srv_modified, updated_at
        FROM documents WHERE collection = 'treatments' ${initial ? "" : "AND id > ?"}
          AND id <= ?
        ON CONFLICT(read_document_id) DO UPDATE SET
          read_date_key = excluded.read_date_key, read_event_type = excluded.read_event_type,
          read_event_value = excluded.read_event_value, read_sort_time = excluded.read_sort_time,
          read_srv_modified = excluded.read_srv_modified, read_updated_at = excluded.read_updated_at`,
      ...(initial ? [] : [state.cursor!]), cursor);
    }
    const complete = ids.length <= limit;
    const budgetRows = priorRows + selected.length;
    sql.exec(`UPDATE ${TREATMENT_READ_SIDE_STATE_TABLE}
      SET read_cursor_id = ?, read_complete = ?, read_last_run_at = ?, read_budget_day = ?, read_day_rows = ?
      WHERE singleton = 1`, cursor, complete ? 1 : 0, at, budgetDay, budgetRows);
    const updated: TreatmentReadSideIndexState = { cursor, complete, lastRunAt: at, budgetDay, budgetRows };
    return { advanced: true, processed: selected.length, complete, reason: "advanced" as const, state: updated };
  });
}
