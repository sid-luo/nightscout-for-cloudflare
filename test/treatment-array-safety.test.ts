import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";

const AT = Date.parse("2026-10-18T00:00:00.000Z");
const ORIGINAL = `((json_type(body,'$.eventType')='text' AND json_extract(body,'$.eventType')=?) OR
  (json_type(body,'$.eventType')='array' AND EXISTS (SELECT 1 FROM json_each(body,'$.eventType') item
    WHERE item.type='text' AND item.value=?)))`;
interface Row extends Record<string, SqlStorageValue> { id: string; body: string }
const id = (n: number) => n.toString(16).padStart(24, "0");
function insert(sql: SqlStorage, n: number, fragment: string) {
  const body = `{"_id":"${id(n)}","identifier":"array-safety-${n}","created_at":"2026-10-18T00:00:00.000Z",
    "date":${AT + n},"rank":${n % 3},"eventType":${fragment},"srvCreated":${AT},"srvModified":${AT + n},"isValid":1}`;
  sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,identifier_present,
    srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
    VALUES('treatments',?,?,?,?,?,?,1,?,?,?,1,1,1)`, id(n), body, AT + n, AT, AT, `array-safety-${n}`, AT, AT + n, AT + n);
}
function materialize(storage: DurableObjectStorage, rows: Row[], query: DocumentQuery, legacy: boolean) {
  const oracle = new SqliteDocumentRepository(storage);
  (oracle as unknown as { queryTreatmentRows(): Row[] }).queryTreatmentRows = () => rows;
  return legacy ? oracle.queryLegacyTreatments(query) : oracle.queryTreatments(query);
}
function outcome(read: () => unknown) {
  try { return { result: read() }; } catch (error) { return { error: String(error) }; }
}

describe("treatment-array optimization native safety", () => {
  it("preserves text-only membership, separators, escapes, array boundaries and native pagination", async () => {
    await runInDurableObject(env.ENTRY_STORE.getByName(`array-safety-${crypto.randomUUID()}`), (_instance, state) => {
      const sql = state.storage.sql;
      const fragments = [
        '["x","y"]', '["x",7,"y"]', '["x",null,"y"]', '["",""]',
        '["A",null,7,["Absent"],{"value":"Absent"}]', '[null,null,"A"]',
        '[0,1,2,3,4,5,6,"A"]', '[0,1,2,3,4,5,6,7,null]',
        '[0,1,2,3,4,5,6,7,"A"]', JSON.stringify([...Array<string>(1024).fill("Other"), "A"]),
        '["\\u0041","A\\u0000suffix","Quote\\\"x","Back\\\\x"]',
        '["A"],"eventType":["Other"]', '["Other"],"eventType":["A"]',
        '[]', '"A"', 'null', '["é",7,"7",true,"true",",",",7,",",null,"," "]',
      ];
      fragments.forEach((fragment, n) => insert(sql, n, fragment));
      const repo = new SqliteDocumentRepository(state.storage);
      for (const category of ["A", "Absent", "Other", "7", "true", "", ",", ",7,", ",null,", " ", "é", "A\0suffix", 'Quote"x', "Back\\x"]) {
        for (const legacy of [false, true]) for (const skip of [0, 1]) {
          const query: DocumentQuery = { limit: 3, skip, filters: [{ field: "eventType", operator: "eq", value: category }] };
          const order = legacy ? "json_extract(body,'$.created_at') DESC,id ASC" : "sort_time DESC,srv_modified DESC,id ASC";
          const rows = sql.exec<Row>(`SELECT * FROM documents WHERE collection='treatments' AND json_valid(body)
            AND is_valid != 0 AND ${ORIGINAL} ORDER BY ${order} LIMIT ? OFFSET ?`, category, category, 3, skip).toArray();
          expect(legacy ? repo.queryLegacyTreatments(query) : repo.queryTreatments(query), `${category}/${legacy}/${skip}`)
            .toEqual(materialize(state.storage, rows, query, legacy));
        }
      }
    });
  });

  it("preserves native scalar, short, long and nested binary-JSON results", async () => {
    await runInDurableObject(env.ENTRY_STORE.getByName(`array-binary-lazy-${crypto.randomUUID()}`), (_instance, state) => {
      const sql = state.storage.sql;
      // Default API3 permits a native binary body in SQL. Capture its actual
      // predicate on text first; raw cursors isolate SQL laziness from the
      // public materializer's separate canonical-JSON contract.
      sql.exec("DROP INDEX documents_treatments_event_type_created_at");
      insert(sql, 0, '["A","B"]');
      const repo = new SqliteDocumentRepository(state.storage), execute = sql.exec.bind(sql);
      const statements: { sql: string; bindings: SqlStorageValue[] }[] = [];
      const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
        if (/^SELECT \*/.test(statement) && statement.includes("FROM documents")) statements.push({ sql: statement, bindings });
        return execute(statement, ...bindings);
      });
      try { expect(repo.queryTreatments({ limit: 1, filters: [{ field: "eventType", operator: "eq", value: "A" }] })).toHaveLength(1); }
      finally { spy.mockRestore(); }
      expect(statements).toHaveLength(1);
      const optimized = statements[0]!;
      const original = `SELECT * FROM documents INDEXED BY documents_treatments_api3_order WHERE collection='treatments'
        AND is_valid != 0 AND ${ORIGINAL} ORDER BY sort_time DESC,srv_modified DESC,id ASC LIMIT 1 OFFSET 0`;
      // Keep permanently valid JSONB fixtures. Deliberately damaged tail
      // headers can hang the underlying iterator on some SQLite versions;
      // their bounded prefix-only experiment belongs in the audit evidence.
      for (const document of [
        { eventType: ["A", "B"] }, { eventType: [...Array<string>(64).fill("Other"), "A"] },
        { eventType: [null, 7, ["A"], { value: "A" }] }, { eventType: "A" },
      ]) {
        sql.exec("UPDATE documents SET body=jsonb(?) WHERE collection='treatments' AND id=?", JSON.stringify(document), id(0));
        for (const category of ["A", "Other", "Missing", "7"]) {
          const bindings = optimized.bindings.map(value => value === "A" ? category : value);
          const expected = outcome(() => sql.exec<Row>(original, category, category).toArray());
          expect(outcome(() => sql.exec<Row>(optimized.sql, ...bindings).toArray()), category).toEqual(expected);
        }
      }
    });
  });
});
