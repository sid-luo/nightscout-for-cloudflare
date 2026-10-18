import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import type { JsonDocument } from "../src/entry-store";
import { LegacyReadCache } from "../src/legacy-read-cache";
import { TreatmentMembershipReadView, TREATMENT_MEMBERSHIP_VIEW_KEY } from "../src/treatment-membership-read-view";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const CATEGORY = `((json_type(body,'$.eventType')='text' AND json_extract(body,'$.eventType')=?)
  OR (json_type(body,'$.eventType')='array' AND EXISTS (
    SELECT 1 FROM json_each(body,'$.eventType') item WHERE item.type='text' AND item.value=?)))`;
const LOWER = `((json_type(body,'$.created_at')='text' AND json_extract(body,'$.created_at')>=?)
  OR (json_type(body,'$.created_at')='array' AND EXISTS (
    SELECT 1 FROM json_each(body,'$.created_at') item WHERE item.type='text' AND item.value>=?)))`;
const MEMBERSHIP_COLUMNS = `id,json_valid(body) AS valid_json,
  CASE WHEN json_valid(body) THEN json_type(body,'$.eventType') END AS event_kind,
  CASE WHEN json_valid(body) THEN json_extract(body,'$.eventType') END AS event_value`;
const OPTIONS = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false };
const id = (n: number) => n.toString(16).padStart(24, "0");
interface RawRow extends Record<string, SqlStorageValue> { id: string; body: string }
interface MemberRow extends Record<string, SqlStorageValue> {
  id: string; valid_json: number; event_kind: string | null; event_value: SqlStorageValue;
}
interface Audit {
  policy: "api3" | "legacy"; category: string; query: DocumentQuery;
  lower?: string; order?: string; where?: string; values?: SqlStorageValue[];
}
type MemberView = [string, string[]][];

function safeUnicode(value: string): boolean {
  for (let n = 0; n < value.length; n++) {
    const unit = value.charCodeAt(n);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++n);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function textMembers(row: MemberRow): string[] | null {
  if (row.valid_json !== 1 || typeof row.id !== "string" || !safeUnicode(row.id)) return null;
  if (row.event_kind === "text") return typeof row.event_value === "string" && safeUnicode(row.event_value)
    ? [row.event_value] : null;
  if (row.event_kind !== "array") return [];
  if (typeof row.event_value !== "string" || row.event_value.length > 256 * 1024) return null;
  try {
    const value: unknown = JSON.parse(row.event_value);
    if (!Array.isArray(value)) return null;
    const strings = value.filter((member): member is string => typeof member === "string");
    if (strings.some(member => !safeUnicode(member))) return null;
    return [...new Set(strings)];
  } catch { return null; }
}

/**
 * Test-only prototype. Retains only one serialized complete membership view,
 * sized with the existing LegacyReadCache 1 MiB/key UTF-16 rule. It never
 * supplies a SQLite sort key, partial membership or persistent storage row.
 */
class CompleteMembershipPrototype {
  private serialized: string | undefined;
  private unavailable: string | undefined;
  private generation = 0;
  constructor(readonly maxRows = 5000, readonly maxBytes = 1024 * 1024) {}
  get bytes(): number { return this.serialized === undefined ? 0 : this.serialized.length * 2; }
  get ready(): boolean { return this.serialized !== undefined; }
  clear(): void { this.generation++; this.serialized = undefined; this.unavailable = undefined; }
  fork(): CompleteMembershipPrototype {
    const copy = new CompleteMembershipPrototype(this.maxRows, this.maxBytes);
    copy.serialized = this.serialized; copy.unavailable = this.unavailable; copy.generation = this.generation;
    return copy;
  }
  ensure(sql: SqlStorage, onRow?: (visited: number) => void): { ready: boolean; reason: string; visited: number } {
    if (this.serialized !== undefined) return { ready: true, reason: "cached-complete", visited: 0 };
    if (this.unavailable !== undefined) return { ready: false, reason: this.unavailable, visited: 0 };
    const generation = this.generation;
    const view: MemberView = [];
    let visited = 0;
    let serializedBytes = 4;
    for (const row of sql.exec<MemberRow>(`SELECT ${MEMBERSHIP_COLUMNS} FROM documents
      WHERE collection='treatments' ORDER BY id ASC LIMIT ?`, this.maxRows + 1)) {
      visited++;
      onRow?.(visited);
      if (visited > this.maxRows) {
        this.unavailable = "row-overflow";
        return { ready: false, reason: "row-overflow", visited };
      }
      const members = textMembers(row);
      if (members === null) {
        this.unavailable = "unsafe-source";
        return { ready: false, reason: "unsafe-source", visited };
      }
      const pair: [string, string[]] = [row.id, members];
      serializedBytes += 2 * JSON.stringify(pair).length + (view.length === 0 ? 0 : 2);
      if (serializedBytes > this.maxBytes) {
        this.unavailable = "byte-overflow";
        return { ready: false, reason: "byte-overflow", visited };
      }
      view.push(pair);
    }
    if (generation !== this.generation) return { ready: false, reason: "generation-change", visited };
    const serialized = JSON.stringify(view);
    if (serialized.length * 2 > this.maxBytes) return { ready: false, reason: "byte-overflow", visited };
    this.serialized = serialized;
    return { ready: true, reason: "complete-eof", visited };
  }
  ids(category: string): string[] | undefined {
    if (!safeUnicode(category) || this.serialized === undefined) return undefined;
    const view = JSON.parse(this.serialized) as MemberView;
    return view.filter(([, members]) => members.includes(category)).map(([key]) => key);
  }
  reconcile(sql: SqlStorage, key: string): void {
    this.generation++;
    const row = sql.exec<MemberRow>(`SELECT ${MEMBERSHIP_COLUMNS} FROM documents
      WHERE collection='treatments' AND id=?`, key).toArray()[0];
    if (this.serialized === undefined) {
      // An insert/update cannot make a known oversized collection smaller.
      // A deletion/collection move can, and must permit a later retry.
      if (row === undefined || this.unavailable !== "row-overflow") this.unavailable = undefined;
      return;
    }
    const view = (JSON.parse(this.serialized) as MemberView).filter(([existing]) => existing !== key);
    if (row !== undefined) {
      const members = textMembers(row);
      if (members === null) { this.clear(); return; }
      view.push([row.id, members]);
    }
    const serialized = JSON.stringify(view);
    if (view.length > this.maxRows || serialized.length * 2 > this.maxBytes) {
      this.serialized = undefined;
      this.unavailable = view.length > this.maxRows ? "row-overflow" : "byte-overflow";
    } else this.serialized = serialized;
  }
}

function sourceQuery(audit: Audit) {
  const where = audit.where ?? `${CATEGORY}${audit.lower === undefined ? "" : ` AND ${LOWER}`}`;
  return { statement: `SELECT * FROM documents WHERE collection=?
    ${audit.policy === "legacy" ? "AND collection IN ('treatments','devicestatus') AND json_valid(body)"
      : audit.query.includeDeleted === true ? "" : "AND is_valid != 0"}
    AND ${where}
    ORDER BY ${audit.order ?? (audit.policy === "legacy"
      ? "json_extract(body,'$.created_at') DESC,id ASC" : "sort_time DESC,srv_modified DESC,id ASC")} LIMIT ? OFFSET ?`,
  bindings: ["treatments", ...(audit.values ?? [audit.category, audit.category,
    ...(audit.lower === undefined ? [] : [audit.lower, audit.lower])]),
  audit.query.limit ?? 1000, audit.query.skip ?? 0] as SqlStorageValue[] };
}

function fits(statement: string, bindings: SqlStorageValue[]): boolean {
  return bindings.length <= 100 && new TextEncoder().encode(statement).byteLength <= 100_000;
}

function candidateQuery(sql: SqlStorage, cache: CompleteMembershipPrototype, audit: Audit) {
  const original = sourceQuery(audit);
  if (!fits(original.statement, original.bindings)) throw new Error("original SQL exceeds limits");
  const fallback = (reason: string, visited = 0, candidates: number | null = null) => ({
    rows: sql.exec<RawRow>(original.statement, ...original.bindings).toArray(), reason, visited, candidates, bytes: cache.bytes,
  });
  const expanded = original.statement.replace("ORDER BY", "AND id IN (SELECT value FROM json_each(?)) ORDER BY");
  const expandedBindings = [...original.bindings.slice(0, -2), "[]", ...original.bindings.slice(-2)];
  if (!fits(expanded, expandedBindings)) return fallback("sql-limit");
  if (!safeUnicode(audit.category)) return fallback("unsafe-query");
  const loaded = cache.ensure(sql);
  if (!loaded.ready) return fallback(loaded.reason, loaded.visited);
  const candidates = cache.ids(audit.category);
  if (candidates === undefined) return fallback("unsafe-query", loaded.visited);
  if (candidates.length === 0) return { rows: [], reason: "complete-empty", visited: loaded.visited, candidates: 0, bytes: cache.bytes };
  if (candidates.length > 64) return fallback("dense-members", loaded.visited, candidates.length);
  const serializedIds = JSON.stringify(candidates);
  if (serializedIds.length > 256 * 1024) return fallback("candidate-payload", loaded.visited, candidates.length);
  return { rows: sql.exec<RawRow>(expanded, ...original.bindings.slice(0, -2), serializedIds,
    ...original.bindings.slice(-2)).toArray(), reason: "complete-sparse-residual", visited: loaded.visited,
  candidates: candidates.length, bytes: cache.bytes };
}

function materialize(rows: RawRow[], policy: Audit["policy"]): JsonDocument[] {
  return rows.map(row => {
    const document = JSON.parse(row.body) as JsonDocument;
    if (policy === "legacy") document._id = row.id;
    else delete document._id;
    return document;
  });
}

function measured<T>(sql: SqlStorage, operation: () => T) {
  const exec = sql.exec.bind(sql);
  const queries: { statement: string; bindings: SqlStorageValue[];
    cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = exec(statement, ...bindings); queries.push({ statement, bindings, cursor }); return cursor;
  });
  try {
    const result = operation();
    return { result, reads: queries.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: queries.reduce((sum, item) => sum + item.cursor.rowsWritten, 0), calls: queries.length,
      plans: queries.filter(item => /^SELECT\b/.test(item.statement)).flatMap(item => exec<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${item.statement}`, ...item.bindings).toArray().map(row => row.detail)) };
  } finally { spy.mockRestore(); }
}

function seed(sql: SqlStorage, count = 5000): void {
  sql.exec(`WITH RECURSIVE sequence(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM sequence WHERE n < ?)
    INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,
      identifier_present,srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
    SELECT 'treatments',printf('%024x',n),json_object('_id',printf('%024x',n),'identifier','member-'||n,
      'created_at',json(CASE WHEN n%7=0 THEN '["2026-10-18T00:00:00.000Z",null]'
        WHEN n%7=1 THEN '7' ELSE '"2026-10-18T00:00:00.000Z"' END),
      'eventType',json(CASE WHEN n IN (137,2701,4100) THEN '["Note","Rare","Note",7,["Absent"],{"kind":"Absent"}]'
        WHEN n=999 THEN '["7",7]' WHEN n%17=0 THEN '"Note"'
        ELSE '["Note","Other","Note","07",7,["Absent"],{"kind":"Absent"},null,false]' END),
      'rank',json(CASE n%7 WHEN 0 THEN 'null' WHEN 1 THEN '1' WHEN 2 THEN '"1"' WHEN 3 THEN 'true'
        WHEN 4 THEN '"abc"' WHEN 5 THEN '[1]' ELSE '{"x":1}' END),
      'srvCreated',?,'srvModified',?+n,'isValid',1),
      ?+n,?,?, 'member-'||n,1,?,CASE WHEN n%5=0 THEN NULL ELSE ?+n END,?+n,
      CASE WHEN n%31=0 THEN 0 ELSE 1 END,1,1 FROM sequence`, count - 1, AT, AT, AT, AT, AT, AT, AT, AT);
}

describe("zero-persistent-write dense array candidate audit", () => {
  it("reuses complete first-level text membership across moving dates while SQLite keeps residual filters and mixed ordering", async () => {
    const stub = env.ENTRY_STORE.getByName(`dense-low-write-moving-${crypto.randomUUID()}`);
    const reports = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      seed(sql);
      const cache = new CompleteMembershipPrototype();
      const repository = new SqliteDocumentRepository(state.storage);
      const reports = [];
      for (const policy of ["api3", "legacy"] as const) for (const category of ["Absent", "Rare", "7", "Note"]) {
        for (let repeat = 0; repeat < 3; repeat++) {
          const lower = new Date(AT - 7 * 86_400_000 + repeat * 1000).toISOString();
          const mixed = category === "Rare";
          const audit: Audit = { policy, category, lower, query: { limit: 3, skip: mixed ? 1 : 0,
            filters: [{ field: "eventType", operator: "eq", value: category }, { field: "created_at", operator: "gte", value: lower }],
            ...(mixed ? { sort: [{ field: "rank", direction: "asc" }, { field: "created_at", direction: "desc" }] } : {}) },
          ...(mixed ? { order: "json_extract(body,'$.rank') ASC,json_extract(body,'$.created_at') DESC,id DESC" } : {}) };
          const original = sourceQuery(audit);
          const oracle = measured(sql, () => sql.exec<RawRow>(original.statement, ...original.bindings).toArray());
          const current = measured(sql, () => policy === "api3" ? repository.queryDocumentsForApi3("treatments", audit.query)
            : repository.queryLegacyTreatments(audit.query));
          const candidate = measured(sql, () => candidateQuery(sql, cache, audit));
          expect(current.result, `${policy}/${category}/${repeat}`).toEqual(materialize(oracle.result, policy));
          expect(candidate.result.rows).toEqual(oracle.result);
          expect(candidate.writes).toBe(0); expect(current.writes).toBe(0);
          expect(cache.bytes).toBeLessThanOrEqual(1024 * 1024);
          if (category === "Absent") expect(candidate.result.reason).toBe("complete-empty");
          if (category === "Rare" || category === "7") expect(candidate.result.reason).toBe("complete-sparse-residual");
          if (category === "Note") expect(candidate.result.reason).toBe("dense-members");
          reports.push({ policy, category, repeat, originalReads: oracle.reads, currentReads: current.reads,
            candidateReads: candidate.reads, candidates: candidate.result.candidates, reason: candidate.result.reason,
            builtRows: candidate.result.visited, retainedBytes: cache.bytes, candidatePlans: candidate.plans });
        }
      }
      return reports;
    });
    console.info(`DENSE_ARRAY_LOW_WRITE_MOVING=${JSON.stringify(reports)}`);
    expect(reports).toMatchInlineSnapshot(`
      [
        {
          "builtRows": 5000,
          "candidatePlans": [
            "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=?)",
          ],
          "candidateReads": 5000,
          "candidates": 0,
          "category": "Absent",
          "currentReads": 45959,
          "originalReads": 45961,
          "policy": "api3",
          "reason": "complete-empty",
          "repeat": 0,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [],
          "candidateReads": 0,
          "candidates": 0,
          "category": "Absent",
          "currentReads": 45959,
          "originalReads": 45961,
          "policy": "api3",
          "reason": "complete-empty",
          "repeat": 1,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [],
          "candidateReads": 0,
          "candidates": 0,
          "category": "Absent",
          "currentReads": 45959,
          "originalReads": 45961,
          "policy": "api3",
          "reason": "complete-empty",
          "repeat": 2,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [
            "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=? AND id=?)",
            "LIST SUBQUERY 3",
            "SCAN json_each VIRTUAL TABLE INDEX 1:",
            "CREATE BLOOM FILTER",
            "CORRELATED SCALAR SUBQUERY 1",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "CORRELATED SCALAR SUBQUERY 2",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "USE TEMP B-TREE FOR ORDER BY",
          ],
          "candidateReads": 15,
          "candidates": 3,
          "category": "Rare",
          "currentReads": 45961,
          "originalReads": 45949,
          "policy": "api3",
          "reason": "complete-sparse-residual",
          "repeat": 0,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [
            "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=? AND id=?)",
            "LIST SUBQUERY 3",
            "SCAN json_each VIRTUAL TABLE INDEX 1:",
            "CREATE BLOOM FILTER",
            "CORRELATED SCALAR SUBQUERY 1",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "CORRELATED SCALAR SUBQUERY 2",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "USE TEMP B-TREE FOR ORDER BY",
          ],
          "candidateReads": 15,
          "candidates": 3,
          "category": "Rare",
          "currentReads": 45961,
          "originalReads": 45949,
          "policy": "api3",
          "reason": "complete-sparse-residual",
          "repeat": 1,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [
            "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=? AND id=?)",
            "LIST SUBQUERY 3",
            "SCAN json_each VIRTUAL TABLE INDEX 1:",
            "CREATE BLOOM FILTER",
            "CORRELATED SCALAR SUBQUERY 1",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "CORRELATED SCALAR SUBQUERY 2",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "USE TEMP B-TREE FOR ORDER BY",
          ],
          "candidateReads": 15,
          "candidates": 3,
          "category": "Rare",
          "currentReads": 45961,
          "originalReads": 45949,
          "policy": "api3",
          "reason": "complete-sparse-residual",
          "repeat": 2,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [
            "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
            "LIST SUBQUERY 3",
            "SCAN json_each VIRTUAL TABLE INDEX 1:",
            "CREATE BLOOM FILTER",
            "CORRELATED SCALAR SUBQUERY 1",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "CORRELATED SCALAR SUBQUERY 2",
            "SCAN item VIRTUAL TABLE INDEX 3:",
          ],
          "candidateReads": 5001,
          "candidates": 1,
          "category": "7",
          "currentReads": 45959,
          "originalReads": 45959,
          "policy": "api3",
          "reason": "complete-sparse-residual",
          "repeat": 0,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [
            "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
            "LIST SUBQUERY 3",
            "SCAN json_each VIRTUAL TABLE INDEX 1:",
            "CREATE BLOOM FILTER",
            "CORRELATED SCALAR SUBQUERY 1",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "CORRELATED SCALAR SUBQUERY 2",
            "SCAN item VIRTUAL TABLE INDEX 3:",
          ],
          "candidateReads": 5001,
          "candidates": 1,
          "category": "7",
          "currentReads": 45959,
          "originalReads": 45959,
          "policy": "api3",
          "reason": "complete-sparse-residual",
          "repeat": 1,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [
            "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
            "LIST SUBQUERY 3",
            "SCAN json_each VIRTUAL TABLE INDEX 1:",
            "CREATE BLOOM FILTER",
            "CORRELATED SCALAR SUBQUERY 1",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "CORRELATED SCALAR SUBQUERY 2",
            "SCAN item VIRTUAL TABLE INDEX 3:",
          ],
          "candidateReads": 5001,
          "candidates": 1,
          "category": "7",
          "currentReads": 45959,
          "originalReads": 45959,
          "policy": "api3",
          "reason": "complete-sparse-residual",
          "repeat": 2,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [
            "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
            "CORRELATED SCALAR SUBQUERY 1",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "CORRELATED SCALAR SUBQUERY 2",
            "SCAN item VIRTUAL TABLE INDEX 3:",
          ],
          "candidateReads": 4,
          "candidates": 4999,
          "category": "Note",
          "currentReads": 22,
          "originalReads": 4,
          "policy": "api3",
          "reason": "dense-members",
          "repeat": 0,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [
            "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
            "CORRELATED SCALAR SUBQUERY 1",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "CORRELATED SCALAR SUBQUERY 2",
            "SCAN item VIRTUAL TABLE INDEX 3:",
          ],
          "candidateReads": 4,
          "candidates": 4999,
          "category": "Note",
          "currentReads": 22,
          "originalReads": 4,
          "policy": "api3",
          "reason": "dense-members",
          "repeat": 1,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [
            "SEARCH documents USING INDEX documents_treatments_api3_order (collection=?)",
            "CORRELATED SCALAR SUBQUERY 1",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "CORRELATED SCALAR SUBQUERY 2",
            "SCAN item VIRTUAL TABLE INDEX 3:",
          ],
          "candidateReads": 4,
          "candidates": 4999,
          "category": "Note",
          "currentReads": 22,
          "originalReads": 4,
          "policy": "api3",
          "reason": "dense-members",
          "repeat": 2,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [],
          "candidateReads": 0,
          "candidates": 0,
          "category": "Absent",
          "currentReads": 40286,
          "originalReads": 47329,
          "policy": "legacy",
          "reason": "complete-empty",
          "repeat": 0,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [],
          "candidateReads": 0,
          "candidates": 0,
          "category": "Absent",
          "currentReads": 40286,
          "originalReads": 47329,
          "policy": "legacy",
          "reason": "complete-empty",
          "repeat": 1,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [],
          "candidateReads": 0,
          "candidates": 0,
          "category": "Absent",
          "currentReads": 40286,
          "originalReads": 47329,
          "policy": "legacy",
          "reason": "complete-empty",
          "repeat": 2,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [
            "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=? AND id=?)",
            "LIST SUBQUERY 3",
            "SCAN json_each VIRTUAL TABLE INDEX 1:",
            "CREATE BLOOM FILTER",
            "CORRELATED SCALAR SUBQUERY 1",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "CORRELATED SCALAR SUBQUERY 2",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "USE TEMP B-TREE FOR ORDER BY",
          ],
          "candidateReads": 15,
          "candidates": 3,
          "category": "Rare",
          "currentReads": 40541,
          "originalReads": 47317,
          "policy": "legacy",
          "reason": "complete-sparse-residual",
          "repeat": 0,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [
            "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=? AND id=?)",
            "LIST SUBQUERY 3",
            "SCAN json_each VIRTUAL TABLE INDEX 1:",
            "CREATE BLOOM FILTER",
            "CORRELATED SCALAR SUBQUERY 1",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "CORRELATED SCALAR SUBQUERY 2",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "USE TEMP B-TREE FOR ORDER BY",
          ],
          "candidateReads": 15,
          "candidates": 3,
          "category": "Rare",
          "currentReads": 40541,
          "originalReads": 47317,
          "policy": "legacy",
          "reason": "complete-sparse-residual",
          "repeat": 1,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [
            "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=? AND id=?)",
            "LIST SUBQUERY 3",
            "SCAN json_each VIRTUAL TABLE INDEX 1:",
            "CREATE BLOOM FILTER",
            "CORRELATED SCALAR SUBQUERY 1",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "CORRELATED SCALAR SUBQUERY 2",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "USE TEMP B-TREE FOR ORDER BY",
          ],
          "candidateReads": 15,
          "candidates": 3,
          "category": "Rare",
          "currentReads": 40541,
          "originalReads": 47317,
          "policy": "legacy",
          "reason": "complete-sparse-residual",
          "repeat": 2,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [
            "SEARCH documents USING INDEX documents_treatments_created_at (collection=?)",
            "LIST SUBQUERY 3",
            "SCAN json_each VIRTUAL TABLE INDEX 1:",
            "CREATE BLOOM FILTER",
            "CORRELATED SCALAR SUBQUERY 1",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "CORRELATED SCALAR SUBQUERY 2",
            "SCAN item VIRTUAL TABLE INDEX 3:",
          ],
          "candidateReads": 5001,
          "candidates": 1,
          "category": "7",
          "currentReads": 40286,
          "originalReads": 47327,
          "policy": "legacy",
          "reason": "complete-sparse-residual",
          "repeat": 0,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [
            "SEARCH documents USING INDEX documents_treatments_created_at (collection=?)",
            "LIST SUBQUERY 3",
            "SCAN json_each VIRTUAL TABLE INDEX 1:",
            "CREATE BLOOM FILTER",
            "CORRELATED SCALAR SUBQUERY 1",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "CORRELATED SCALAR SUBQUERY 2",
            "SCAN item VIRTUAL TABLE INDEX 3:",
          ],
          "candidateReads": 5001,
          "candidates": 1,
          "category": "7",
          "currentReads": 40286,
          "originalReads": 47327,
          "policy": "legacy",
          "reason": "complete-sparse-residual",
          "repeat": 1,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [
            "SEARCH documents USING INDEX documents_treatments_created_at (collection=?)",
            "LIST SUBQUERY 3",
            "SCAN json_each VIRTUAL TABLE INDEX 1:",
            "CREATE BLOOM FILTER",
            "CORRELATED SCALAR SUBQUERY 1",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "CORRELATED SCALAR SUBQUERY 2",
            "SCAN item VIRTUAL TABLE INDEX 3:",
          ],
          "candidateReads": 5001,
          "candidates": 1,
          "category": "7",
          "currentReads": 40286,
          "originalReads": 47327,
          "policy": "legacy",
          "reason": "complete-sparse-residual",
          "repeat": 2,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [
            "SEARCH documents USING INDEX documents_treatments_created_at (collection=?)",
            "CORRELATED SCALAR SUBQUERY 1",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "CORRELATED SCALAR SUBQUERY 2",
            "SCAN item VIRTUAL TABLE INDEX 3:",
          ],
          "candidateReads": 3,
          "candidates": 4999,
          "category": "Note",
          "currentReads": 4,
          "originalReads": 3,
          "policy": "legacy",
          "reason": "dense-members",
          "repeat": 0,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [
            "SEARCH documents USING INDEX documents_treatments_created_at (collection=?)",
            "CORRELATED SCALAR SUBQUERY 1",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "CORRELATED SCALAR SUBQUERY 2",
            "SCAN item VIRTUAL TABLE INDEX 3:",
          ],
          "candidateReads": 3,
          "candidates": 4999,
          "category": "Note",
          "currentReads": 4,
          "originalReads": 3,
          "policy": "legacy",
          "reason": "dense-members",
          "repeat": 1,
          "retainedBytes": 502264,
        },
        {
          "builtRows": 0,
          "candidatePlans": [
            "SEARCH documents USING INDEX documents_treatments_created_at (collection=?)",
            "CORRELATED SCALAR SUBQUERY 1",
            "SCAN item VIRTUAL TABLE INDEX 3:",
            "CORRELATED SCALAR SUBQUERY 2",
            "SCAN item VIRTUAL TABLE INDEX 3:",
          ],
          "candidateReads": 3,
          "candidates": 4999,
          "category": "Note",
          "currentReads": 4,
          "originalReads": 3,
          "policy": "legacy",
          "reason": "dense-members",
          "repeat": 2,
          "retainedBytes": 502264,
        },
      ]
    `);
  }, 60_000);

  it("keeps new membership current with zero extra persistent writes and forks uncommitted views for rollback", async () => {
    const stub = env.ENTRY_STORE.getByName(`dense-low-write-mutations-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      seed(sql);
      const cache = new CompleteMembershipPrototype(6000);
      expect(cache.ensure(sql).ready).toBe(true);
      const repository = new SqliteDocumentRepository(state.storage);
      const samples = [];
      for (let n = 0; n < 4; n++) {
        const identifier = `dense-upload-${n}`;
        const upload = measured(sql, () => repository.createDocumentForApi3("treatments", {
          _id: id(6000+n), identifier, app: "synthetic-dense", utcOffset: 0, date: AT+n,
          created_at: new Date(AT+n).toISOString(), eventType: ["Note", "Fresh", "Fresh"], rank: n,
        }, OPTIONS));
        expect(upload.result).toMatchObject({ ok: true });
        const key = sql.exec<{ id: string }>("SELECT id FROM documents WHERE collection='treatments' AND identifier=?", identifier).one().id;
        const maintenance = measured(sql, () => cache.reconcile(sql, key));
        const audit: Audit = { policy: "api3", category: "Fresh", lower: new Date(AT - 1000 + n).toISOString(),
          query: { limit: 2, filters: [{ field: "eventType", operator: "eq", value: "Fresh" }] } };
        const original = sourceQuery(audit);
        const oracle = sql.exec<RawRow>(original.statement, ...original.bindings).toArray();
        const selected = measured(sql, () => candidateQuery(sql, cache, audit));
        expect(selected.result.rows).toEqual(oracle);
        expect(maintenance.writes).toBe(0); expect(selected.writes).toBe(0);
        samples.push({ uploadReads: upload.reads, uploadWrites: upload.writes, maintenanceReads: maintenance.reads,
          maintenanceWrites: maintenance.writes, queryReads: selected.reads, candidates: selected.result.candidates });
      }
      const before = sql.exec("SELECT * FROM documents ORDER BY collection,id").toArray();
      const committedView = cache.ids("Rolled Back");
      const working = cache.fork();
      expect(() => state.storage.transactionSync(() => {
        sql.exec("UPDATE documents SET body=json_set(body,'$.eventType',json('[\"Rolled Back\"]')) WHERE collection='treatments' AND id=?", id(137));
        working.reconcile(sql, id(137));
        expect(working.ids("Rolled Back")).toEqual([id(137)]);
        throw new Error("rollback candidate membership and canonical update");
      })).toThrow("rollback candidate membership");
      expect(sql.exec("SELECT * FROM documents ORDER BY collection,id").toArray()).toEqual(before);
      expect(cache.ids("Rolled Back")).toEqual(committedView);
      const invalidated = new CompleteMembershipPrototype(6000);
      expect(invalidated.ensure(sql, visited => { if (visited === 3) invalidated.clear(); }).reason).toBe("generation-change");
      expect(invalidated.ready).toBe(false);
      return { samples, retainedBytes: cache.bytes, rollbackRetainedCommittedView: true, generationChangeAdmitted: false };
    });
    console.info(`DENSE_ARRAY_LOW_WRITE_MUTATIONS=${JSON.stringify(report)}`);
    expect(report).toMatchInlineSnapshot(`
      {
        "generationChangeAdmitted": false,
        "retainedBytes": 502632,
        "rollbackRetainedCommittedView": true,
        "samples": [
          {
            "candidates": 1,
            "maintenanceReads": 1,
            "maintenanceWrites": 0,
            "queryReads": 5003,
            "uploadReads": 2,
            "uploadWrites": 18,
          },
          {
            "candidates": 2,
            "maintenanceReads": 1,
            "maintenanceWrites": 0,
            "queryReads": 5005,
            "uploadReads": 4,
            "uploadWrites": 17,
          },
          {
            "candidates": 3,
            "maintenanceReads": 1,
            "maintenanceWrites": 0,
            "queryReads": 5005,
            "uploadReads": 4,
            "uploadWrites": 17,
          },
          {
            "candidates": 4,
            "maintenanceReads": 1,
            "maintenanceWrites": 0,
            "queryReads": 5005,
            "uploadReads": 4,
            "uploadWrites": 17,
          },
        ],
      }
    `);
  }, 60_000);

  it("falls back completely on row/byte overflow, unsafe strings and malformed bodies rather than caching a false empty membership", async () => {
    const stub = env.ENTRY_STORE.getByName(`dense-low-write-fallbacks-${crypto.randomUUID()}`);
    const reports = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      seed(sql, 65);
      sql.exec("UPDATE documents SET body=json_set(body,'$.eventType',json('[\"After Prefix\"]')) WHERE collection='treatments' AND id=?", id(64));
      const audit: Audit = { policy: "legacy", category: "After Prefix", query: { limit: 1 } };
      const original = sourceQuery(audit);
      const oracle = sql.exec<RawRow>(original.statement, ...original.bindings).toArray();
      expect(oracle).toHaveLength(1);
      const overflow = new CompleteMembershipPrototype(16);
      const first = measured(sql, () => candidateQuery(sql, overflow, audit));
      const repeat = measured(sql, () => candidateQuery(sql, overflow, audit));
      expect(first.result.rows).toEqual(oracle); expect(repeat.result.rows).toEqual(oracle);
      expect(first.result.reason).toBe("row-overflow"); expect(first.result.visited).toBe(17);
      expect(repeat.result.reason).toBe("row-overflow"); expect(repeat.result.visited).toBe(0);
      const tiny = new CompleteMembershipPrototype(100, 64);
      const byte = measured(sql, () => candidateQuery(sql, tiny, audit));
      expect(byte.result.rows).toEqual(oracle); expect(byte.result.reason).toBe("byte-overflow");
      const reports = [{ scenario: "row-overflow", firstReads: first.reads, repeatReads: repeat.reads, reason: first.result.reason },
        { scenario: "byte-overflow", firstReads: byte.reads, repeatReads: null, reason: byte.result.reason }];
      sql.exec("UPDATE documents SET body=? WHERE collection='treatments' AND id=?", '{"eventType":["\\ud800"]}', id(0));
      const unsafe = measured(sql, () => candidateQuery(sql, new CompleteMembershipPrototype(), audit));
      expect(unsafe.result.rows).toEqual(oracle); expect(unsafe.result.reason).toBe("unsafe-source");
      reports.push({ scenario: "unpaired-surrogate", firstReads: unsafe.reads, repeatReads: null, reason: unsafe.result.reason });
      // The seed deliberately gives id0 validity=0. Use a nonzero value to
      // make the malformed row eligible for the original API3 JSON predicate.
      sql.exec("UPDATE documents SET body='{',is_valid=2 WHERE collection='treatments' AND id=?", id(0));
      const api3: Audit = { ...audit, policy: "api3" };
      const outcome = (read: () => unknown) => {
        try { return { result: read() }; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
      };
      const prior = sourceQuery(api3);
      // Even validity=2 does not force this lazy LIMIT1 query to touch id0:
      // id64 is the newest matching row. Rejection must retain that success.
      const originalSuccess = sql.exec<RawRow>(prior.statement, ...prior.bindings).toArray();
      expect(originalSuccess.map(row => row.id)).toEqual([id(64)]);
      const lazy = candidateQuery(sql, new CompleteMembershipPrototype(), api3);
      expect(lazy.reason).toBe("unsafe-source");
      expect(lazy.rows).toEqual(originalSuccess);
      const absent: Audit = { ...api3, category: "Guaranteed Missing Category" };
      const missing = sourceQuery(absent);
      const originalError = outcome(() => sql.exec(missing.statement, ...missing.bindings).toArray());
      expect(originalError).toHaveProperty("error");
      expect(outcome(() => candidateQuery(sql, new CompleteMembershipPrototype(), absent))).toEqual(originalError);
      expect([first, repeat, byte, unsafe].every(sample => sample.writes === 0)).toBe(true);
      return reports;
    });
    console.info(`DENSE_ARRAY_LOW_WRITE_FALLBACKS=${JSON.stringify(reports)}`);
    expect(reports).toMatchInlineSnapshot(`
      [
        {
          "firstReads": 622,
          "reason": "row-overflow",
          "repeatReads": 605,
          "scenario": "row-overflow",
        },
        {
          "firstReads": 607,
          "reason": "byte-overflow",
          "repeatReads": null,
          "scenario": "byte-overflow",
        },
        {
          "firstReads": 606,
          "reason": "unsafe-source",
          "repeatReads": null,
          "scenario": "unpaired-surrogate",
        },
      ]
    `);
  });

  it("preserves legal 100-binding and near-100kB SQL without adding an unrepresentable candidate predicate", async () => {
    const stub = env.ENTRY_STORE.getByName(`dense-low-write-limits-${crypto.randomUUID()}`);
    const reports = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      seed(sql, 65);
      const cache = new CompleteMembershipPrototype();
      const bindings: Audit = { policy: "legacy", category: "Note", query: { limit: 1 },
        where: `${Array<string>(48).fill(CATEGORY).join(" AND ")} AND id != ?`,
        values: [...Array<string>(96).fill("Note"), "absent"] };
      const narrow: Audit = { policy: "legacy", category: "Note", query: { limit: 1 } };
      const base = sourceQuery(narrow);
      // Explicit SQLite boundary fixture: padding has no semantic effect and
      // tests the prototype's SQL-byte guard independently of a public parser.
      const bytes: Audit = { ...narrow, where: `${CATEGORY} /*${"p".repeat(99_980 - new TextEncoder().encode(base.statement).byteLength - 5)}*/` };
      return [bindings, bytes].map((audit, n) => {
        const original = sourceQuery(audit);
        expect(fits(original.statement, original.bindings)).toBe(true);
        if (n === 0) expect(original.bindings).toHaveLength(100);
        else expect(new TextEncoder().encode(original.statement).byteLength).toBe(99_980);
        const oracle = sql.exec<RawRow>(original.statement, ...original.bindings).toArray();
        const candidate = measured(sql, () => candidateQuery(sql, cache, audit));
        expect(candidate.result.rows).toEqual(oracle);
        expect(candidate.result.reason).toBe("sql-limit");
        expect(candidate.result.visited).toBe(0);
        expect(candidate.writes).toBe(0);
        return { boundary: n === 0 ? "100-bindings" : "99980-bytes", reads: candidate.reads,
          reason: candidate.result.reason, writes: candidate.writes };
      });
    });
    console.info(`DENSE_ARRAY_LOW_WRITE_LIMITS=${JSON.stringify(reports)}`);
    expect(reports).toMatchInlineSnapshot(`
      [
        {
          "boundary": "100-bindings",
          "reads": 1,
          "reason": "sql-limit",
          "writes": 0,
        },
        {
          "boundary": "99980-bytes",
          "reads": 1,
          "reason": "sql-limit",
          "writes": 0,
        },
      ]
    `);
  });

  it("runs the production fourth-argument cache with complete membership beyond the 17th array and changing fields/time/page", async () => {
    const stub = env.ENTRY_STORE.getByName(`dense-production-members-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      seed(sql, 4900);
      const cache = new LegacyReadCache();
      const repository = new SqliteDocumentRepository(state.storage, undefined, () => cache.clear(), cache);
      const absent: DocumentQuery = { limit: 1, filters: [{ field: "eventType", operator: "eq", value: "Absent" }] };
      const first = measured(sql, () => repository.queryLegacyTreatments(absent));
      expect(first.result).toEqual([]);
      expect(cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY)).toBe("pending");
      const build = measured(sql, () => repository.queryLegacyTreatments(absent));
      const warm = measured(sql, () => repository.queryLegacyTreatments({ ...absent, limit: 7 }));
      expect(build.result).toEqual([]); expect(warm.result).toEqual([]);
      // Successful native EOF now answers repeated Absent shapes directly.
      // Keep the member prewarm pending until a different category needs it.
      expect(build.reads).toBe(0); expect(build.calls).toBe(0);
      expect(cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY)).toBe("pending");
      expect(warm.reads).toBe(0); expect(first.writes + build.writes + warm.writes).toBe(0);
      const samples = [];
      for (const policy of ["api3", "legacy"] as const) for (let n = 0; n < 3; n++) {
        const lower = new Date(n === 2 ? AT + 1000 : AT - (n + 1) * 86_400_000).toISOString();
        const query: DocumentQuery = { limit: 2, skip: n % 2,
          filters: [{ field: "eventType", operator: "eq", value: "Rare" }, { field: "created_at", operator: "gte", value: lower }],
          sort: [{ field: "rank", direction: "asc" }, { field: "created_at", direction: "desc" }],
          ...(n === 1 ? { fields: ["identifier", "rank"] } : {}) };
        const audit: Audit = { policy, category: "Rare", lower, query,
          order: "json_extract(body,'$.rank') ASC,json_extract(body,'$.created_at') DESC,id DESC" };
        const original = sourceQuery(audit);
        const full = materialize(sql.exec<RawRow>(original.statement, ...original.bindings).toArray(), policy);
        const expected = query.fields === undefined ? full : full.map(document => Object.fromEntries(query.fields!
          .filter(field => Object.hasOwn(document, field)).map(field => [field, document[field]])));
        const actual = measured(sql, () => policy === "api3" ? repository.queryDocumentsForApi3("treatments", query)
          : repository.queryLegacyTreatments(query));
        expect(actual.result, `${policy}/${n}`).toEqual(expected);
        expect(actual.writes).toBe(0);
        if (policy === "api3" && n === 0) {
          expect(actual.reads).toBe(4900 + 15);
          expect(JSON.parse(cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY)!)[1]).toBe("complete");
        } else expect(actual.reads).toBeLessThan(40);
        samples.push({ policy, n, reads: actual.reads, returned: actual.result.length, plans: actual.plans });
      }
      // Before native EOF reuse: first=46095, build=4900, six pages=83.
      // A deferred first-Rare rebuild must stay within that entire budget.
      expect(first.reads + build.reads + warm.reads + samples.reduce((sum, page) => sum + page.reads, 0))
        .toBeLessThanOrEqual(51_078);
      const uploads = [];
      for (let n = 0; n < 2; n++) {
        const uploaded = measured(sql, () => repository.createDocumentForApi3("treatments", {
          identifier: `production-member-${n}`, app: "synthetic-membership", utcOffset: 0,
          date: AT + n, created_at: new Date(AT + n).toISOString(), eventType: ["Note", "Fresh"],
        }, OPTIONS));
        expect(uploaded.result).toMatchObject({ ok: true });
        expect(cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY)).toBeUndefined();
        const relearn = measured(sql, () => repository.queryLegacyTreatments(absent));
        const rebuild = measured(sql, () => repository.queryLegacyTreatments({ ...absent, limit: 3 }));
        const fresh: Audit = { policy: "legacy", category: "Fresh", query: { limit: 3 } };
        const original = sourceQuery(fresh);
        const expected = materialize(sql.exec<RawRow>(original.statement, ...original.bindings).toArray(), "legacy");
        const selected = measured(sql, () => repository.queryLegacyTreatments({ limit: 3,
          filters: [{ field: "eventType", operator: "eq", value: "Fresh" }] }));
        expect(selected.result).toEqual(expected);
        expect(rebuild.reads).toBe(0);
        expect(selected.reads).toBe(4901 + n + 5 * (n + 1));
        expect(relearn.reads + rebuild.reads + selected.reads).toBeLessThanOrEqual(n === 0 ? 51_004 : 51_013);
        expect(relearn.writes + rebuild.writes + selected.writes).toBe(0);
        uploads.push({ uploadReads: uploaded.reads, uploadWrites: uploaded.writes,
          relearnReads: relearn.reads, rebuildReads: rebuild.reads, selectedReads: selected.reads });
      }
      let rejectMutation = false;
      const transactional = new SqliteDocumentRepository(state.storage, undefined, () => {
        cache.clear();
        try {
          if (rejectMutation) {
            const uncommitted = new TreatmentMembershipReadView(sql, cache);
            uncommitted.candidates("RollbackMember");
            uncommitted.noteExpensiveRead(513);
            expect(uncommitted.candidates("RollbackMember")).toHaveLength(1);
            throw new Error("synthetic membership callback rollback");
          }
        } finally { cache.clear(); }
      }, cache);
      const before = sql.exec("SELECT * FROM documents ORDER BY collection,id").toArray();
      rejectMutation = true;
      expect(() => transactional.createDocumentForApi3("treatments", {
        identifier: "rolled-back-member", app: "synthetic-membership", utcOffset: 0,
        date: AT, created_at: new Date(AT).toISOString(), eventType: ["RollbackMember"],
      }, OPTIONS)).toThrow("synthetic membership callback rollback");
      expect(sql.exec("SELECT * FROM documents ORDER BY collection,id").toArray()).toEqual(before);
      expect(cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY)).toBeUndefined();
      expect(repository.queryLegacyTreatments({ limit: 1,
        filters: [{ field: "eventType", operator: "eq", value: "RollbackMember" }] })).toEqual([]);
      return { firstReads: first.reads, buildReads: build.reads, warmReads: warm.reads, samples, uploads };
    });
    console.info(`DENSE_ARRAY_PRODUCTION_MEMBERS=${JSON.stringify(report)}`);
    expect(report).toMatchInlineSnapshot(`
      {
        "buildReads": 0,
        "firstReads": 46075,
        "samples": [
          {
            "n": 0,
            "plans": [
              "CO-ROUTINE (subquery-1)",
              "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=?)",
              "SCAN (subquery-1)",
              "CO-ROUTINE (subquery-2)",
              "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=? AND id=?)",
              "LIST SUBQUERY 1",
              "SCAN json_each VIRTUAL TABLE INDEX 1:",
              "CREATE BLOOM FILTER",
              "SCAN (subquery-2)",
              "CORRELATED SCALAR SUBQUERY 3",
              "SCAN item VIRTUAL TABLE INDEX 3:",
              "CORRELATED SCALAR SUBQUERY 4",
              "SCAN item VIRTUAL TABLE INDEX 3:",
              "USE TEMP B-TREE FOR ORDER BY",
            ],
            "policy": "api3",
            "reads": 4915,
            "returned": 2,
          },
          {
            "n": 1,
            "plans": [
              "CO-ROUTINE (subquery-2)",
              "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=? AND id=?)",
              "LIST SUBQUERY 1",
              "SCAN json_each VIRTUAL TABLE INDEX 1:",
              "CREATE BLOOM FILTER",
              "SCAN (subquery-2)",
              "CORRELATED SCALAR SUBQUERY 3",
              "SCAN item VIRTUAL TABLE INDEX 3:",
              "CORRELATED SCALAR SUBQUERY 4",
              "SCAN item VIRTUAL TABLE INDEX 3:",
              "USE TEMP B-TREE FOR ORDER BY",
            ],
            "policy": "api3",
            "reads": 15,
            "returned": 2,
          },
          {
            "n": 2,
            "plans": [
              "CO-ROUTINE (subquery-2)",
              "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=? AND id=?)",
              "LIST SUBQUERY 1",
              "SCAN json_each VIRTUAL TABLE INDEX 1:",
              "CREATE BLOOM FILTER",
              "SCAN (subquery-2)",
              "CORRELATED SCALAR SUBQUERY 3",
              "SCAN item VIRTUAL TABLE INDEX 3:",
              "CORRELATED SCALAR SUBQUERY 4",
              "SCAN item VIRTUAL TABLE INDEX 3:",
              "USE TEMP B-TREE FOR ORDER BY",
            ],
            "policy": "api3",
            "reads": 13,
            "returned": 0,
          },
          {
            "n": 0,
            "plans": [
              "CO-ROUTINE (subquery-2)",
              "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=? AND id=?)",
              "LIST SUBQUERY 1",
              "SCAN json_each VIRTUAL TABLE INDEX 1:",
              "CREATE BLOOM FILTER",
              "SCAN (subquery-2)",
              "CORRELATED SCALAR SUBQUERY 3",
              "SCAN item VIRTUAL TABLE INDEX 3:",
              "CORRELATED SCALAR SUBQUERY 4",
              "SCAN item VIRTUAL TABLE INDEX 3:",
              "USE TEMP B-TREE FOR ORDER BY",
            ],
            "policy": "legacy",
            "reads": 15,
            "returned": 2,
          },
          {
            "n": 1,
            "plans": [
              "CO-ROUTINE (subquery-2)",
              "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=? AND id=?)",
              "LIST SUBQUERY 1",
              "SCAN json_each VIRTUAL TABLE INDEX 1:",
              "CREATE BLOOM FILTER",
              "SCAN (subquery-2)",
              "CORRELATED SCALAR SUBQUERY 3",
              "SCAN item VIRTUAL TABLE INDEX 3:",
              "CORRELATED SCALAR SUBQUERY 4",
              "SCAN item VIRTUAL TABLE INDEX 3:",
              "USE TEMP B-TREE FOR ORDER BY",
            ],
            "policy": "legacy",
            "reads": 15,
            "returned": 2,
          },
          {
            "n": 2,
            "plans": [
              "CO-ROUTINE (subquery-2)",
              "SEARCH documents USING INDEX sqlite_autoindex_documents_1 (collection=? AND id=?)",
              "LIST SUBQUERY 1",
              "SCAN json_each VIRTUAL TABLE INDEX 1:",
              "CREATE BLOOM FILTER",
              "SCAN (subquery-2)",
              "CORRELATED SCALAR SUBQUERY 3",
              "SCAN item VIRTUAL TABLE INDEX 3:",
              "CORRELATED SCALAR SUBQUERY 4",
              "SCAN item VIRTUAL TABLE INDEX 3:",
              "USE TEMP B-TREE FOR ORDER BY",
            ],
            "policy": "legacy",
            "reads": 10,
            "returned": 0,
          },
        ],
        "uploads": [
          {
            "rebuildReads": 0,
            "relearnReads": 46076,
            "selectedReads": 4906,
            "uploadReads": 2,
            "uploadWrites": 18,
          },
          {
            "rebuildReads": 0,
            "relearnReads": 46077,
            "selectedReads": 4912,
            "uploadReads": 4,
            "uploadWrites": 17,
          },
        ],
        "warmReads": 0,
      }
    `);
  }, 60_000);

  it("completes sources beyond 5000 in bounded steps, guards generation and SQL errors, and uses SQLite's duplicate-path/ASCII membership semantics", async () => {
    const stub = env.ENTRY_STORE.getByName(`dense-production-boundaries-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      seed(sql, 5001);
      const cache = new LegacyReadCache();
      const view = new TreatmentMembershipReadView(sql, cache);
      expect(view.candidates("Absent")).toBeUndefined();
      view.noteExpensiveRead(512);
      expect(cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY)).toBeUndefined();
      view.noteExpensiveRead(513);
      const first = measured(sql, () => view.candidates("Absent"));
      const repeat = measured(sql, () => view.candidates("Absent"));
      const warm = measured(sql, () => view.candidates("Absent"));
      expect(first.result).toBeUndefined(); expect(repeat.result).toEqual([]); expect(warm.result).toEqual([]);
      expect(JSON.parse(cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY)!)[1]).toBe("complete");
      expect(repeat.reads).toBe(1); expect(warm.reads).toBe(0); expect(warm.calls).toBe(0);
      view.noteExpensiveRead(100_000);
      expect(JSON.parse(cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY)!)[1]).toBe("complete");
      sql.exec("DELETE FROM documents WHERE collection='treatments'");
      const bodies = [
        '{"eventType":["Rare"],"eventType":["Absent"]}',
        '{"eventType":[null,7,false,["Absent"],{"name":"Absent"},"7","\\u0041","é","\\ud800"]}',
        '{"eventType":"Note"}', '{}', '{"eventType":[]}',
      ];
      for (const [n, body] of bodies.entries()) sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
        VALUES('treatments',?,?,?,?,?,1)`, id(n), body, AT, AT, AT);
      cache.clear();
      view.candidates("Absent"); view.noteExpensiveRead(513);
      expect(view.candidates("Absent")).toEqual([]);
      for (const category of ["Rare", "7", "A", "Note", ""]) {
        const expected = sql.exec<{ id: string }>(`SELECT id FROM documents WHERE collection='treatments'
          AND ${CATEGORY} ORDER BY id`, category, category).toArray().map(row => row.id);
        expect(view.candidates(category), category).toEqual(expected);
      }
      expect(view.candidates("é")).toBeUndefined(); expect(view.candidates("has\0nul")).toBeUndefined();
      expect(view.candidates("x".repeat(513))).toBeUndefined();
      cache.clear(); view.candidates("Absent"); view.noteExpensiveRead(513);
      const execute = sql.exec.bind(sql);
      const clear = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
        const cursor = execute(statement, ...bindings);
        if (statement.includes("AS valid_json")) cache.clear();
        return cursor;
      });
      try { expect(view.candidates("Absent")).toBeUndefined(); }
      finally { clear.mockRestore(); }
      expect(cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY)).toBeUndefined();
      view.candidates("Absent"); view.noteExpensiveRead(513);
      const fail = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
        if (statement.includes("AS valid_json")) throw new Error("Exceeded allowed rows read in Durable Objects free tier.");
        return execute(statement, ...bindings);
      });
      try { expect(() => view.candidates("Absent")).toThrow("Exceeded allowed rows read in Durable Objects free tier."); }
      finally { fail.mockRestore(); }
      cache.clear();
      sql.exec("UPDATE documents SET body=? WHERE collection='treatments' AND id=?", JSON.stringify({ eventType: ["x".repeat(100_000)] }), id(0));
      view.candidates("Absent"); view.noteExpensiveRead(513);
      const huge = measured(sql, () => view.candidates("Absent"));
      expect(huge.result).toBeUndefined(); expect(cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY)).toBe("rejected");
      expect(first.writes + repeat.writes + warm.writes + huge.writes).toBe(0);
      return { firstChunkReads: first.reads, completionReads: repeat.reads, warmReads: warm.reads,
        hugeFragmentBuildReads: huge.reads, writes: first.writes + repeat.writes + warm.writes + huge.writes };
    });
    console.info(`DENSE_ARRAY_PRODUCTION_BOUNDARIES=${JSON.stringify(report)}`);
    expect(report).toMatchInlineSnapshot(`
      {
        "completionReads": 1,
        "firstChunkReads": 5001,
        "hugeFragmentBuildReads": 2,
        "warmReads": 0,
        "writes": 0,
      }
    `);
  }, 60_000);
});
