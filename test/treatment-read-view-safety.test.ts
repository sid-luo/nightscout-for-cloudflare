import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import { LegacyReadCache } from "../src/legacy-read-cache";
import { TreatmentMembershipReadView, TREATMENT_MEMBERSHIP_VIEW_KEY } from "../src/treatment-membership-read-view";
import { TreatmentOrderReadView } from "../src/treatment-order-read-view";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const id = (n: number) => n.toString(16).padStart(24, "0");
function caught(operation: () => unknown) {
  try { operation(); return { threw: false }; }
  catch (error) { return { threw: true, error }; }
}
function insert(sql: SqlStorage, key: string, body: string, valid = 1): void {
  sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,srv_modified,is_valid)
    VALUES('treatments',?,?,?,?,?,?,?)`, key, body, AT, AT, AT, AT, valid);
}
const ORDER_STATEMENT = "SELECT * FROM documents WHERE collection=? ORDER BY json_extract(body,?) ASC,id ASC LIMIT ? OFFSET ?";
const ORDER_BINDINGS: SqlStorageValue[] = ["treatments", "$.rank", 1, 0];

describe("treatment reusable read-view independent safety", () => {
  it("matches actual SQLite text membership for escapes/NUL/Unicode/surrogates/duplicates and JSON spelling", async () => {
    const stub = env.ENTRY_STORE.getByName(`read-view-exotic-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      // Keep JSON source spellings intact. JSON.parse of the whole document
      // would choose the last duplicate key, whereas SQLite picks its first.
      const fragments = [
        '"eventType":"A"', '"eventType":"\\u0041"',
        '"eventType":["\\u0041","Note"]',
        '"eventType":["Note\\u0000suffix","A"]',
        '"eventType":["Nöté","🧪","A"]',
        '"eventType":["\\ud800","Note"]',
        '"eventType":[["Note"],{"kind":"Note"},"A"]',
        '"eventType":"Note","eventType":"Other"',
        '"eventType":["Other"],"eventType":"Note"',
        '"eventType": [ "Note" , "A", 7, "07", true, null ]',
        '"eventType":["Quote\\\"x","Back\\\\x"]',
        '"eventType":""',
        '"eventType":["Note\\nsuffix","Note\\tsuffix"]',
        '"eventType":["Note","Note","A"]',
      ];
      fragments.forEach((fragment, index) => insert(sql, id(index),
        `{"created_at":"2026-10-18T12:00:00.000Z",${fragment}}`));
      const cache = new LegacyReadCache();
      const view = new TreatmentMembershipReadView(sql, cache);
      expect(view.candidates("Absent")).toBeUndefined();
      view.noteExpensiveRead(513);
      const categories = ["A", "Note", "Other", "7", "07", 'Quote"x', "Back\\x", "", "Absent"];
      const reports = [];
      for (const category of categories) {
        const oracle = sql.exec<{ id: string }>(`SELECT id FROM documents WHERE collection='treatments' AND (
          (json_type(body,'$.eventType')='text' AND json_extract(body,'$.eventType')=?)
          OR (json_type(body,'$.eventType')='array' AND EXISTS (
            SELECT 1 FROM json_each(body,'$.eventType') item WHERE item.type='text' AND item.value=?
          ))) ORDER BY id ASC`, category, category).toArray().map(row => row.id);
        const actual = view.candidates(category);
        expect(actual, category).toEqual(oracle);
        reports.push({ category, ids: actual });
      }
      expect(view.candidates("Note")).not.toContain(id(3)); // Embedded NUL is not a terminator for BINARY equality.
      expect(view.candidates("Note")).not.toContain(id(6)); // Nested arrays/objects are not first-level text members.
      expect(view.candidates("Note")).toContain(id(7)); // First duplicate eventType wins in SQLite.
      expect(view.candidates("Note")).not.toContain(id(8));
      expect(view.candidates("A")).toContain(id(1)); // Escaped ASCII remains eligible ASCII.
      expect(view.candidates("7")).toEqual([]); // JSON numeric 7 is not text "7".
      return reports;
    });
    console.info(`TREATMENT_MEMBERSHIP_EXOTIC_SQL_ORACLE=${JSON.stringify(report)}`);
  });

  it("keeps a malformed row outside the complete fixed WHERE from introducing a new order-build error", async () => {
    const stub = env.ENTRY_STORE.getByName(`read-view-fixed-where-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`WITH RECURSIVE s(n) AS(VALUES(0) UNION ALL SELECT n+1 FROM s WHERE n<599)
        INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,srv_modified,is_valid,identifier,identifier_present)
        SELECT 'treatments',printf('%024x',n),json_object('identifier','fixed-'||n,
          'created_at','2026-10-18T12:00:00.000Z','rank',600-n),?,?,?,?,1,'fixed-'||n,1 FROM s`, AT, AT, AT, AT);
      insert(sql, id(1000), "{malformed");
      sql.exec("UPDATE documents SET identifier='outside',identifier_present=1 WHERE collection='treatments' AND id=?", id(1000));
      const cache = new LegacyReadCache();
      const cached = new SqliteDocumentRepository(state.storage, undefined, undefined, cache);
      const original = new SqliteDocumentRepository(state.storage);
      const base: DocumentQuery = { limit: 3, sort: { field: "rank", direction: "asc" },
        filters: [{ field: "identifier", operator: "lt", value: "m" }] };
      for (const skip of [0, 3, 17]) {
        const query = { ...base, skip };
        expect(cached.queryDocumentsForApi3("treatments", query)).toEqual(original.queryDocumentsForApi3("treatments", query));
      }
      const retained = [...(cache as unknown as { entries: Map<string, string> }).entries]
        .filter(([key]) => key.startsWith("\0treatment-order:v1:"));
      expect(retained).toHaveLength(1);
      expect(JSON.parse(retained[0]![1])).toHaveLength(600);
      expect(sql.exec<{ body: string }>("SELECT body FROM documents WHERE collection='treatments' AND id=?", id(1000)).one().body)
        .toBe("{malformed");
    });
  });

  it("retains legal 100 bindings and near-100k SQL and rejects original invalid queries even with a complete membership view", async () => {
    const stub = env.ENTRY_STORE.getByName(`read-view-query-limits-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      insert(sql, id(1), '{"identifier":"limits","eventType":"Note","created_at":"2026-10-18T12:00:00.000Z"}');
      const cache = new LegacyReadCache();
      cache.set(TREATMENT_MEMBERSHIP_VIEW_KEY, JSON.stringify([[id(1), ["Note"]]]));
      const cached = new SqliteDocumentRepository(state.storage, undefined, undefined, cache);
      const original = new SqliteDocumentRepository(state.storage);
      const note = { field: "eventType", operator: "eq", value: "Note" } as const;
      const legal: DocumentQuery = { limit: 1, filters: [...Array.from({ length: 48 }, () => note),
        { field: "_id", operator: "ne", value: "absent" }] };
      const execute = sql.exec.bind(sql);
      const observed: { statement: string; bindings: number }[] = [];
      const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
        if (/^SELECT\b/.test(statement) && /\b(?:FROM|JOIN) documents\b/.test(statement)) observed.push({ statement, bindings: bindings.length });
        return execute(statement, ...bindings);
      });
      try {
        expect(cached.queryDocumentsForApi3("treatments", legal)).toEqual(original.queryDocumentsForApi3("treatments", legal));
        expect(observed.some(item => item.bindings === 100)).toBe(true);
        expect(observed.every(item => item.bindings <= 100)).toBe(true);
        // Current compiler measured in a read-only Node probe: four 95-member
        // predicates compile to 97722 bytes; four 100-member ones exceed 100k.
        const values = ["Note", ...Array<null>(94).fill(null)];
        const large: DocumentQuery = { limit: 1, filters: [note,
          ...Array.from({ length: 4 }, () => ({ field: "eventType", operator: "in" as const, value: values }))] };
        expect(cached.queryDocumentsForApi3("treatments", large)).toEqual(original.queryDocumentsForApi3("treatments", large));
        const maximumBytes = Math.max(...observed.map(item => new TextEncoder().encode(item.statement).byteLength));
        expect(maximumBytes).toBeGreaterThan(90_000);
        expect(maximumBytes).toBeLessThanOrEqual(100_000);
        const before = observed.length;
        const missing = { field: "eventType", operator: "eq", value: "Missing" } as const;
        const illegal = [
          { filters: [missing], sort: [] },
          { filters: [missing], limit: -1 },
          { filters: [missing], skip: -1 },
          { ...legal, filters: [...legal.filters!, { field: "_id", operator: "ne", value: "another" }] },
          { limit: 1, filters: [missing, ...Array.from({ length: 5 }, () => ({ field: "eventType", operator: "in", value: values }))] },
        ] as DocumentQuery[];
        for (const query of illegal) expect(() => cached.queryDocumentsForApi3("treatments", query)).toThrow();
        expect(observed).toHaveLength(before); // Validation precedes an authoritative empty-membership shortcut.
      } finally { spy.mockRestore(); }
    });
  });

  it("closes both builder iterators on throw undefined and preserves that original error over a return getter error", () => {
    for (const kind of ["membership", "order"] as const) {
      const cache = new LegacyReadCache();
      let closed = 0;
      const cursor = { [Symbol.iterator]() {
        let index = 0;
        return { next() {
          if (index++ === 0) return { done: false, value: { id: id(1), valid_json: 1,
            fragment_oversized: 0, event_kind: "array", event_value: '["Note"]' } };
          throw undefined;
        }, get return(): () => IteratorResult<Record<string, SqlStorageValue>> { closed++; throw new Error("secondary close getter"); } };
      } };
      const sql = { exec(statement: string) { return statement.startsWith("SELECT COUNT(*)") ? { one: () => ({ count: 2 }) } : cursor; } } as unknown as SqlStorage;
      if (kind === "membership") {
        cache.set(TREATMENT_MEMBERSHIP_VIEW_KEY, "pending");
        expect(caught(() => new TreatmentMembershipReadView(sql, cache).candidates("Note"))).toEqual({ threw: true, error: undefined });
        expect(cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY)).toBe("pending");
      } else {
        const view = new TreatmentOrderReadView(sql, cache);
        const key = view.key(ORDER_STATEMENT, ORDER_BINDINGS);
        view.noteExpensiveRead(key, 513);
        expect(caught(() => view.read(key, ORDER_STATEMENT, ORDER_BINDINGS, 1, 0))).toEqual({ threw: true, error: undefined });
        expect(cache.get(key)).toBe("pending");
      }
      expect(closed, kind).toBe(1);
    }
  });

  it("does not publish either builder after clear during a SQL cursor iteration", () => {
    for (const kind of ["membership", "order"] as const) {
      const cache = new LegacyReadCache();
      const cursor = { [Symbol.iterator]() {
        let index = 0;
        return { next() {
          if (index === 1) cache.clear();
          if (index++ < 2) return { done: false, value: { id: id(index), valid_json: 1,
            fragment_oversized: 0, event_kind: "text", event_value: "Note" } };
          return { done: true, value: undefined };
        }, return() { return { done: true, value: undefined }; } };
      } };
      const sql = { exec(statement: string) { return statement.startsWith("SELECT COUNT(*)") ? { one: () => ({ count: 2 }) } : cursor; } } as unknown as SqlStorage;
      if (kind === "membership") {
        cache.set(TREATMENT_MEMBERSHIP_VIEW_KEY, "pending");
        expect(new TreatmentMembershipReadView(sql, cache).candidates("Note")).toBeUndefined();
        expect(cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY)).toBeUndefined();
      } else {
        const view = new TreatmentOrderReadView(sql, cache);
        const key = view.key(ORDER_STATEMENT, ORDER_BINDINGS);
        view.noteExpensiveRead(key, 513);
        expect(view.read(key, ORDER_STATEMENT, ORDER_BINDINGS, 1, 0)).toBeUndefined();
        expect(cache.get(key)).toBeUndefined();
      }
    }
  });
});
