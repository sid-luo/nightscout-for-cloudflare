import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import { LegacyReadCache } from "../src/legacy-read-cache";
import { TreatmentMembershipReadView, TREATMENT_MEMBERSHIP_VIEW_KEY as KEY } from "../src/treatment-membership-read-view";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const BATCH = 5000;
const id = (n: number) => n.toString(16).padStart(24, "0");
const OPTIONS = { canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: false };
const CATEGORY = `((json_type(body,'$.eventType')='text' AND json_extract(body,'$.eventType')=?)
  OR (json_type(body,'$.eventType')='array' AND EXISTS (
    SELECT 1 FROM json_each(body,'$.eventType') item WHERE item.type='text' AND item.value=?)))`;
interface RawRow extends Record<string, SqlStorageValue> { id: string; body: string }
function phase(cache: LegacyReadCache): unknown {
  const value = cache.get(KEY);
  return value === undefined || value === "pending" || value === "rejected" ? value : JSON.parse(value)[1];
}
function measured<T>(sql: SqlStorage, operation: () => T) {
  const execute = sql.exec.bind(sql);
  const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  const statements: string[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = execute(statement, ...bindings); cursors.push(cursor); statements.push(statement); return cursor;
  });
  try {
    const result = operation();
    const metadata = cursors.filter((_cursor, index) => statements[index]!.includes(" AS valid_json") && !statements[index]!.includes("FROM documents"));
    return { result, reads: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      writes: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0), calls: cursors.length,
      membershipReads: metadata.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      membershipWrites: metadata.reduce((sum, cursor) => sum + cursor.rowsWritten, 0), membershipCalls: metadata.length,
      sourceCalls: statements.filter(statement => statement.includes(" AS valid_json") && statement.includes("FROM documents")).length };
  } finally { spy.mockRestore(); }
}
async function measuredAsync<T>(sql: SqlStorage, operation: () => Promise<T>) {
  const execute = sql.exec.bind(sql);
  const queries: { statement: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = execute(statement, ...bindings); queries.push({ statement, cursor }); return cursor;
  });
  try {
    const result = await operation();
    const metadata = queries.filter(query => query.statement.includes(" AS valid_json") && !query.statement.includes("FROM documents"));
    return { result, reads: queries.reduce((sum, query) => sum + query.cursor.rowsRead, 0),
      writes: queries.reduce((sum, query) => sum + query.cursor.rowsWritten, 0),
      membershipReads: metadata.reduce((sum, query) => sum + query.cursor.rowsRead, 0),
      membershipWrites: metadata.reduce((sum, query) => sum + query.cursor.rowsWritten, 0),
      queries: queries.map(query => ({ sql: query.statement.replace(/\s+/g, " "), reads: query.cursor.rowsRead, writes: query.cursor.rowsWritten })),
      sourceCalls: queries.filter(query => query.statement.includes(" AS valid_json") && query.statement.includes("FROM documents")).length };
  } finally { spy.mockRestore(); }
}
function seed(sql: SqlStorage, count: number): void {
  sql.exec(`WITH RECURSIVE s(n) AS(VALUES(0) UNION ALL SELECT n+1 FROM s WHERE n<?)
    INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,identifier_present,
      srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
    SELECT 'treatments',printf('%024x',n),json_object('_id',printf('%024x',n),'identifier','large-'||n,
      'date',?+n,'utcOffset',0,'app','large-membership-audit','created_at','2026-10-18T12:00:00.000Z',
      'eventType',json(CASE WHEN n IN(137,5001,5900) THEN '["Note","Rare","Note",null,7,["Absent"]]'
        ELSE '["Note","Other","Note",7,["Absent"],{"kind":"Absent"},null,false]' END),
      'rank',n%7,'srvCreated',?,'srvModified',?+n,'isValid',1),?+n,?,?,
      'large-'||n,1,?,?+n,?+n,1,1,1 FROM s`, count - 1, AT, AT, AT, AT, AT, AT, AT, AT, AT);
}
function originalRows(sql: SqlStorage, category: string, limit = 3, lower = "2026-10-17T00:00:00.000Z") {
  return sql.exec<RawRow>(`SELECT * FROM documents WHERE collection='treatments' AND json_valid(body)
    AND ${CATEGORY} AND json_extract(body,'$.created_at')>=?
    ORDER BY json_extract(body,'$.rank') ASC,json_extract(body,'$.created_at') DESC,id ASC LIMIT ?`,
  category, category, lower, limit).toArray();
}
function candidateRows(sql: SqlStorage, view: TreatmentMembershipReadView, category: string,
  limit = 3, lower = "2026-10-17T00:00:00.000Z") {
  const ids = view.candidates(category);
  if (ids === undefined) return originalRows(sql, category, limit, lower);
  if (ids.length === 0) return [];
  return sql.exec<RawRow>(`SELECT * FROM (SELECT * FROM documents WHERE collection='treatments'
    AND id IN (SELECT value FROM json_each(?)) LIMIT -1) WHERE collection='treatments' AND json_valid(body)
    AND ${CATEGORY} AND json_extract(body,'$.created_at')>=?
    ORDER BY json_extract(body,'$.rank') ASC,json_extract(body,'$.created_at') DESC,id ASC LIMIT ?`,
  JSON.stringify(ids), category, category, lower, limit).toArray();
}
function complete(sql: SqlStorage, view: TreatmentMembershipReadView, cache: LegacyReadCache) {
  if (phase(cache) === undefined || phase(cache) === "overlay") {
    view.candidates("Absent"); view.noteExpensiveRead(513);
  }
  const samples: { reads: number; writes: number; sourceCalls: number }[] = [];
  for (let calls = 0; phase(cache) !== "complete" && calls < 100; calls++) {
    const sample = measured(sql, () => view.candidates("Absent"));
    samples.push({ reads: sample.reads, writes: sample.writes, sourceCalls: sample.sourceCalls });
    expect(cache.get(KEY)).not.toBe("rejected");
  }
  expect(phase(cache)).toBe("complete");
  return samples;
}

describe("large mutation membership read view", () => {
  it("completes >5000 canonical rows with bounded keyset steps and never answers empty while partial", async () => {
    const reports = [];
    for (const count of [6001, 20_001]) {
      const stub = env.ENTRY_STORE.getByName(`membership-large-${count}-${crypto.randomUUID()}`);
      reports.push(await runInDurableObject(stub, (_instance, state) => {
        const sql = state.storage.sql; seed(sql, count);
        const original = new SqliteDocumentRepository(state.storage);
        const query = { limit: 1, filters: [{ field: "eventType", operator: "eq" as const, value: "Absent" }] };
        const baseline = measured(sql, () => original.queryLegacyTreatments(query));
        expect(baseline.result).toEqual([]); expect(baseline.writes).toBe(0);
        const cache = new LegacyReadCache(), view = new TreatmentMembershipReadView(sql, cache);
        view.candidates("Absent"); view.noteExpensiveRead(baseline.reads);
        const batches = [];
        let partialFallbackReads = 0;
        while (phase(cache) !== "complete") {
          const batch = measured(sql, () => view.candidates("Absent")); batches.push(batch);
          expect(batch.reads).toBeLessThanOrEqual(BATCH + 1); expect(batch.writes).toBe(0);
          if (phase(cache) === "partial") {
            expect(batch.result).toBeUndefined();
            if (partialFallbackReads === 0) {
              const fallback = measured(sql, () => originalRows(sql, "Absent"));
              expect(fallback.result).toEqual([]); partialFallbackReads = fallback.reads;
            }
          }
          expect(batches.length).toBeLessThanOrEqual(5);
        }
        const warm = measured(sql, () => candidateRows(sql, view, "Absent"));
        const rare = measured(sql, () => candidateRows(sql, view, "Rare"));
        expect(warm.result).toEqual(originalRows(sql, "Absent"));
        expect(rare.result).toEqual(originalRows(sql, "Rare"));
        expect(view.candidates("Rare")).toEqual([id(137), id(5001), id(5900)]);
        expect(view.candidates("Note")).toBeUndefined();
        const bytes = 2 * (KEY.length + cache.get(KEY)!.length);
        expect(bytes).toBeLessThan(2048); expect(warm.reads).toBe(0);
        const plan = sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT id FROM documents
          WHERE collection='treatments' AND id>? ORDER BY id ASC LIMIT 5001`, id(4999)).toArray().map(row => row.detail);
        expect(plan.some(detail => detail.includes("collection=? AND id>?"))).toBe(true);
        return { sourceRows: count, originalMissingReads: baseline.reads,
          sourceBatchReads: batches.map(sample => sample.reads), sourceBuildReads: batches.reduce((sum, sample) => sum + sample.reads, 0),
          partialFallbackReads, warmMissingReads: warm.reads, rareReads: rare.reads, serializedBytes: bytes,
          optionalWrites: batches.reduce((sum, sample) => sum + sample.writes, 0) + warm.writes + rare.writes, keysetPlan: plan };
      }));
    }
    console.info(`MEMBERSHIP_LARGE_BOUNDED=${JSON.stringify(reports)}`);
    expect(reports).toMatchInlineSnapshot(`
      [
        {
          "keysetPlan": [
            "SEARCH documents USING COVERING INDEX sqlite_autoindex_documents_1 (collection=? AND id>?)",
          ],
          "optionalWrites": 0,
          "originalMissingReads": 6001,
          "partialFallbackReads": 54004,
          "rareReads": 15,
          "serializedBytes": 370,
          "sourceBatchReads": [
            5001,
            1001,
          ],
          "sourceBuildReads": 6002,
          "sourceRows": 6001,
          "warmMissingReads": 0,
        },
        {
          "keysetPlan": [
            "SEARCH documents USING COVERING INDEX sqlite_autoindex_documents_1 (collection=? AND id>?)",
          ],
          "optionalWrites": 0,
          "originalMissingReads": 20001,
          "partialFallbackReads": 180004,
          "rareReads": 15,
          "serializedBytes": 370,
          "sourceBatchReads": [
            5001,
            5001,
            5001,
            5001,
            1,
          ],
          "sourceBuildReads": 20005,
          "sourceRows": 20001,
          "warmMissingReads": 0,
        },
      ]
    `);
  }, 60_000);

  it("keeps complete necessary supersets through real uploads, changes and deletes with no historical rebuild", async () => {
    const stub = env.ENTRY_STORE.getByName(`membership-large-upserts-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql; seed(sql, 6001);
      const cache = new LegacyReadCache(), view = new TreatmentMembershipReadView(sql, cache);
      const source = complete(sql, view, cache);
      let failAfterCallback = false;
      const clear = () => cache.clearKeeping([KEY]);
      const repository = new SqliteDocumentRepository(state.storage, undefined, collection => {
        if (collection === "treatments") {
          clear();
          if (failAfterCallback) throw new Error("rollback after monotone membership");
        }
      }, cache, (collection, key, oldBody, newBody) => {
        if (collection !== "treatments") return undefined;
        view.rememberMutation(key, oldBody, newBody);
        clear(); return clear;
      });
      const samples = [];
      for (let n = 0; n < 8; n++) {
        const key = id(100_000 + n);
        const upload = measured(sql, () => repository.createDocumentForApi3("treatments", {
          _id: key, identifier: `upload-${n}`, date: AT + n + 1, utcOffset: 0, app: "large-membership-audit",
          created_at: "2026-10-18T12:00:00.000Z", rank: n % 7, eventType: ["Note", "Live", `Only-${n}`],
        }, OPTIONS));
        expect(upload.result.ok).toBe(true);
        expect(upload.membershipReads).toBe(0); expect(upload.membershipWrites).toBe(0); expect(upload.membershipCalls).toBe(1);
        const missing = measured(sql, () => candidateRows(sql, view, "Absent", n % 3 + 1));
        const selected = measured(sql, () => candidateRows(sql, view, "Live", n % 3 + 1));
        expect(missing.result).toEqual(originalRows(sql, "Absent", n % 3 + 1));
        expect(selected.result).toEqual(originalRows(sql, "Live", n % 3 + 1));
        expect(missing.reads).toBe(0); expect(selected.sourceCalls).toBe(0);
        expect(phase(cache)).toBe("complete");
        samples.push({ uploadReads: upload.reads, businessWrites: upload.writes,
          maintenance: { reads: upload.membershipReads, writes: upload.membershipWrites, calls: upload.membershipCalls },
          missingReads: missing.reads, selectedReads: selected.reads });
      }
      const patchedKey = id(100_000);
      // API3 keeps eventType immutable. The real legacy save/upsert contract
      // permits replacing it, so use that path for membership movement.
      const patch = measured(sql, () => repository.upsertTreatment({ _id: patchedKey, identifier: "upload-0",
        created_at: "2026-10-18T12:00:00.000Z", rank: 0, eventType: ["Moved", "Note"] }));
      expect(patch.result.document._id).toBe(patchedKey);
      expect(view.candidates("Only-0")).toContain(patchedKey); // Stale candidate remains, original residual removes it.
      expect(candidateRows(sql, view, "Only-0")).toEqual([]);
      expect(candidateRows(sql, view, "Moved")).toEqual(originalRows(sql, "Moved"));
      const removedKey = id(100_001);
      const deletion = measured(sql, () => repository.deleteDocumentById("treatments", removedKey));
      expect(deletion.result).toBe(true);
      expect(view.candidates("Only-1")).toContain(removedKey);
      expect(candidateRows(sql, view, "Only-1")).toEqual([]);
      failAfterCallback = true;
      expect(() => repository.upsertTreatment({ _id: patchedKey, identifier: "upload-0",
        created_at: "2026-10-18T12:00:00.000Z", rank: 0, eventType: ["Rollback Only"] }))
        .toThrow("rollback after monotone membership");
      failAfterCallback = false;
      expect(view.candidates("Rollback Only")).toContain(patchedKey);
      expect(candidateRows(sql, view, "Rollback Only")).toEqual([]);
      expect(candidateRows(sql, view, "Moved")).toEqual(originalRows(sql, "Moved"));
      expect(patch.membershipReads + deletion.membershipReads + patch.membershipWrites + deletion.membershipWrites).toBe(0);
      expect(patch.membershipCalls).toBe(1); expect(deletion.membershipCalls).toBe(1);
      return { sourceBatchReads: source.map(sample => sample.reads), samples,
        patchReads: patch.reads, patchWrites: patch.writes, deleteReads: deletion.reads, deleteWrites: deletion.writes,
        serializedBytes: 2 * (KEY.length + cache.get(KEY)!.length), rollbackResidualEqual: true };
    });
    console.info(`MEMBERSHIP_LARGE_MUTATION=${JSON.stringify(report)}`);
    expect(report).toMatchInlineSnapshot(`
      {
        "deleteReads": 4,
        "deleteWrites": 2,
        "patchReads": 5,
        "patchWrites": 15,
        "rollbackResidualEqual": true,
        "samples": [
          {
            "businessWrites": 18,
            "maintenance": {
              "calls": 1,
              "reads": 0,
              "writes": 0,
            },
            "missingReads": 0,
            "selectedReads": 5,
            "uploadReads": 2,
          },
          {
            "businessWrites": 17,
            "maintenance": {
              "calls": 1,
              "reads": 0,
              "writes": 0,
            },
            "missingReads": 0,
            "selectedReads": 10,
            "uploadReads": 4,
          },
          {
            "businessWrites": 17,
            "maintenance": {
              "calls": 1,
              "reads": 0,
              "writes": 0,
            },
            "missingReads": 0,
            "selectedReads": 15,
            "uploadReads": 4,
          },
          {
            "businessWrites": 17,
            "maintenance": {
              "calls": 1,
              "reads": 0,
              "writes": 0,
            },
            "missingReads": 0,
            "selectedReads": 20,
            "uploadReads": 4,
          },
          {
            "businessWrites": 17,
            "maintenance": {
              "calls": 1,
              "reads": 0,
              "writes": 0,
            },
            "missingReads": 0,
            "selectedReads": 25,
            "uploadReads": 4,
          },
          {
            "businessWrites": 17,
            "maintenance": {
              "calls": 1,
              "reads": 0,
              "writes": 0,
            },
            "missingReads": 0,
            "selectedReads": 30,
            "uploadReads": 4,
          },
          {
            "businessWrites": 17,
            "maintenance": {
              "calls": 1,
              "reads": 0,
              "writes": 0,
            },
            "missingReads": 0,
            "selectedReads": 35,
            "uploadReads": 4,
          },
          {
            "businessWrites": 17,
            "maintenance": {
              "calls": 1,
              "reads": 0,
              "writes": 0,
            },
            "missingReads": 0,
            "selectedReads": 40,
            "uploadReads": 4,
          },
        ],
        "serializedBytes": 1636,
        "sourceBatchReads": [
          5001,
          1001,
        ],
      }
    `);
  }, 60_000);

  it("unions mutations on both sides of a partial cursor and deduplicates their later canonical scans", async () => {
    const stub = env.ENTRY_STORE.getByName(`membership-partial-mutations-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql; seed(sql, 6001);
      const cache = new LegacyReadCache(), view = new TreatmentMembershipReadView(sql, cache);
      view.candidates("Absent"); view.noteExpensiveRead(513); view.candidates("Absent");
      expect(phase(cache)).toBe("partial");
      const edits = [
        { key: id(12), event: ["Behind", "Behind"] },
        { key: id(5001), event: ["Ahead", "Rare"] },
        { key: "00000000000000000000000c-late", event: ["Late Behind"] },
        { key: id(70_000), event: ["Late Ahead", "\u0000cannot-match", "é"] },
      ];
      const maintenance = [];
      for (const edit of edits) {
        const oldBody = sql.exec<{ body: string }>("SELECT body FROM documents WHERE collection='treatments' AND id=?", edit.key).toArray()[0]?.body;
        const body = JSON.stringify({ created_at: "2026-10-18T12:00:00.000Z", rank: 1, eventType: edit.event });
        maintenance.push(measured(sql, () => view.rememberMutation(edit.key, oldBody, body)));
        sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
          VALUES('treatments',?,?,?,?,?,1) ON CONFLICT(collection,id) DO UPDATE SET body=excluded.body`, edit.key, body, AT, AT, AT);
        cache.clearKeeping([KEY]);
        expect(phase(cache)).toBe("partial");
      }
      const oldBody = sql.exec<{ body: string }>("SELECT body FROM documents WHERE collection='treatments' AND id=?", id(137)).one().body;
      view.rememberMutation(id(137), oldBody);
      sql.exec("DELETE FROM documents WHERE collection='treatments' AND id=?", id(137));
      const ending = complete(sql, view, cache);
      for (const category of ["Behind", "Ahead", "Late Behind", "Late Ahead", "Rare", "Absent"])
        expect(candidateRows(sql, view, category), category).toEqual(originalRows(sql, category));
      expect(view.candidates("Ahead")).toEqual([id(5001)]);
      expect(view.candidates("Rare")).toContain(id(137)); // Deleted prefix id is only a safe extra.
      expect(view.candidates("\0cannot-match")).toBeUndefined();
      return { endSourceBatchReads: ending.map(sample => sample.reads), maintenanceReads: maintenance.map(sample => sample.reads),
        maintenanceWrites: maintenance.map(sample => sample.writes), serializedBytes: 2 * (KEY.length + cache.get(KEY)!.length) };
    });
    console.info(`MEMBERSHIP_PARTIAL_MUTATION=${JSON.stringify(report)}`);
    expect(report).toMatchInlineSnapshot(`
      {
        "endSourceBatchReads": [
          1002,
        ],
        "maintenanceReads": [
          0,
          0,
          0,
          0,
        ],
        "maintenanceWrites": [
          0,
          0,
          0,
          0,
        ],
        "serializedBytes": 716,
      }
    `);
  });

  it("retains conservative dense markers and refuses malformed/oversized mutations without adding write errors", async () => {
    const stub = env.ENTRY_STORE.getByName(`membership-large-boundaries-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql; seed(sql, 80);
      const cache = new LegacyReadCache(), view = new TreatmentMembershipReadView(sql, cache); complete(sql, view, cache);
      for (let n = 0; n < 70; n++) {
        const body = sql.exec<{ body: string }>("SELECT body FROM documents WHERE collection='treatments' AND id=?", id(n)).one().body;
        view.rememberMutation(id(n), body);
        sql.exec("DELETE FROM documents WHERE collection='treatments' AND id=?", id(n));
      }
      expect(view.candidates("Note")).toBeUndefined(); // Ten rows remain; dense cannot be inferred to become sparse.
      const bad = measured(sql, () => view.rememberMutation(id(70), undefined, "{malformed"));
      expect(bad.reads).toBe(0); expect(bad.writes).toBe(0);
      expect(TreatmentMembershipReadView.isUnsafe(cache)).toBe(true);
      const refused = measured(sql, () => view.candidates("Absent"));
      expect(refused.result).toBeUndefined(); expect(refused.reads).toBe(0);
      const fresh = new LegacyReadCache(), exotic = new TreatmentMembershipReadView(sql, fresh);
      const body = '{"eventType":["A","A","A\\u0000suffix","\\u0041","\\ud800"],"eventType":"Wrong"}';
      exotic.rememberMutation(id(70), undefined, body);
      sql.exec("UPDATE documents SET body=? WHERE collection='treatments' AND id=?", body, id(70));
      expect(phase(fresh)).toBe("overlay");
      expect(measured(sql, () => exotic.candidates("A")).reads).toBe(0);
      complete(sql, exotic, fresh);
      expect(exotic.candidates("A")).toEqual([id(70)]); expect(exotic.candidates("Wrong")).toEqual([]);
      const huge = measured(sql, () => exotic.rememberMutation(id(71), undefined, JSON.stringify({ eventType: ["x".repeat(100_000)] })));
      expect(huge.reads).toBe(0); expect(huge.writes).toBe(0); expect(TreatmentMembershipReadView.isUnsafe(fresh)).toBe(true);
    });
  });

  it("does not overwrite an overlay remembered reentrantly during a canonical source cursor", async () => {
    const stub = env.ENTRY_STORE.getByName(`membership-reentrant-source-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql; seed(sql, 3);
      const cache = new LegacyReadCache(), view = new TreatmentMembershipReadView(sql, cache);
      view.candidates("Absent"); view.noteExpensiveRead(513);
      const execute = sql.exec.bind(sql), key = id(90_000);
      const body = JSON.stringify({ eventType: ["Reentrant"], created_at: "2026-10-18T12:00:00.000Z", rank: 1 });
      let fired = false, closed = 0;
      const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
        const cursor = execute(statement, ...bindings);
        if (!statement.includes(" AS valid_json") || !statement.includes("FROM documents") || fired) return cursor;
        const iterator = cursor[Symbol.iterator]();
        return { [Symbol.iterator]() { return {
          next() {
            const next = iterator.next();
            if (!fired && !next.done) {
              fired = true;
              view.rememberMutation(key, undefined, body);
            }
            return next;
          },
          return() { closed++; return iterator.return?.() ?? { done: true, value: undefined }; },
        }; } } as unknown as SqlStorageCursor<Record<string, SqlStorageValue>>;
      });
      try { expect(view.candidates("Absent")).toBeUndefined(); }
      finally { spy.mockRestore(); }
      expect(closed).toBe(1); expect(phase(cache)).toBe("partial");
      execute(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,is_valid)
        VALUES('treatments',?,?,?,?,?,1)`, key, body, AT, AT, AT);
      complete(sql, view, cache);
      expect(view.candidates("Reentrant")).toEqual([key]);
      expect(candidateRows(sql, view, "Reentrant")).toEqual(originalRows(sql, "Reentrant"));
    });
  });

  it("keeps the actual EntryStore membership lane hot through public API3 create, notes patch and delete", async () => {
    const stub = env.ENTRY_STORE.getByName(`membership-public-upload-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql; seed(sql, 6001);
      const cache = (instance as unknown as { legacyTreatmentQueries: LegacyReadCache }).legacyTreatmentQueries;
      const view = new TreatmentMembershipReadView(sql, cache);
      const build = complete(sql, view, cache);
      const oracle = new SqliteDocumentRepository(state.storage);
      const samples = [];
      for (let n = 0; n < 3; n++) {
        const identity = `public-upload-${n}`;
        const upload = await measuredAsync(sql, () => instance.api3CreateDocument("treatments", JSON.stringify({
          _id: id(200_000 + n), identifier: identity, date: AT + n + 1, utcOffset: 0, app: "public-membership-audit",
          created_at: "2026-10-18T12:00:00.000Z", eventType: ["Live", "Note"], notes: `initial-${n}`,
          extraPublicField: { preserved: [n, null, true] },
        }), JSON.stringify(OPTIONS)));
        console.info(`MEMBERSHIP_PUBLIC_UPLOAD_DIAG=${JSON.stringify({ n, reads: upload.reads, writes: upload.writes,
          membershipReads: upload.membershipReads, membershipWrites: upload.membershipWrites, sourceCalls: upload.sourceCalls,
          queries: upload.queries.filter(query => query.reads > 0 || query.writes > 0 || query.sql.includes(" AS valid_json")) })}`);
        expect(JSON.parse(upload.result).ok).toBe(true);
        expect(upload.membershipReads).toBe(0); expect(upload.membershipWrites).toBe(0);
        expect(upload.sourceCalls).toBe(0); expect(phase(cache)).toBe("complete");
        const absent: DocumentQuery = { limit: n + 1, filters: [{ field: "eventType", operator: "eq", value: "Absent" }] };
        const missing = await measuredAsync(sql, () => instance.api3QueryCollection("treatments", JSON.stringify(absent)));
        console.info(`MEMBERSHIP_PUBLIC_MISSING_DIAG=${JSON.stringify({ n, reads: missing.reads, writes: missing.writes,
          sourceCalls: missing.sourceCalls, queries: missing.queries })}`);
        expect(JSON.parse(missing.result)).toEqual({ ok: true, result: oracle.queryDocumentsForApi3("treatments", absent) });
        expect(missing.reads).toBe(0); expect(missing.writes).toBe(0); expect(missing.sourceCalls).toBe(0);
        const patch = await measuredAsync(sql, () => instance.api3PatchDocument("treatments", identity,
          JSON.stringify({ notes: `corrected-${n}` }), JSON.stringify(OPTIONS)));
        console.info(`MEMBERSHIP_PUBLIC_PATCH_DIAG=${JSON.stringify({ n, reads: patch.reads, writes: patch.writes,
          membershipReads: patch.membershipReads, membershipWrites: patch.membershipWrites, sourceCalls: patch.sourceCalls,
          queries: patch.queries.filter(query => query.reads > 0 || query.writes > 0 || query.sql.includes(" AS valid_json")) })}`);
        expect(JSON.parse(patch.result).ok).toBe(true);
        expect(patch.membershipReads).toBe(0); expect(patch.membershipWrites).toBe(0); expect(patch.sourceCalls).toBe(0);
        const live: DocumentQuery = { limit: n + 1, filters: [{ field: "eventType", operator: "eq", value: "Live" }] };
        const selected = await measuredAsync(sql, () => instance.api3QueryCollection("treatments", JSON.stringify(live)));
        const expected = oracle.queryDocumentsForApi3("treatments", live);
        expect(JSON.parse(selected.result)).toEqual({ ok: true, result: expected });
        expect(expected.some(document => document.notes === `corrected-${n}` && document.extraPublicField !== undefined)).toBe(true);
        expect(selected.sourceCalls).toBe(0); expect(selected.writes).toBe(0);
        samples.push({ uploadReads: upload.reads, uploadWrites: upload.writes,
          patchReads: patch.reads, patchWrites: patch.writes, missingReads: missing.reads, selectedReads: selected.reads,
          membershipSourceReads: upload.membershipReads + patch.membershipReads,
          membershipWrites: upload.membershipWrites + patch.membershipWrites });
      }
      const deletion = await measuredAsync(sql, () => instance.api3DeleteDocument("treatments", "public-upload-0", true, null));
      expect(deletion.result.deleted).toBe(true); expect(deletion.membershipReads).toBe(0); expect(deletion.membershipWrites).toBe(0);
      const after: DocumentQuery = { limit: 10, filters: [{ field: "eventType", operator: "eq", value: "Live" }] };
      const selected = await measuredAsync(sql, () => instance.api3QueryCollection("treatments", JSON.stringify(after)));
      expect(JSON.parse(selected.result)).toEqual({ ok: true, result: oracle.queryDocumentsForApi3("treatments", after) });
      expect(selected.sourceCalls).toBe(0); expect(selected.writes).toBe(0); expect(phase(cache)).toBe("complete");
      return { sourceBatchReads: build.map(sample => sample.reads), samples, deleteReads: deletion.reads,
        deleteWrites: deletion.writes, afterDeleteReads: selected.reads, extraMembershipWrites: 0 };
    });
    console.info(`MEMBERSHIP_PUBLIC_MUTATION=${JSON.stringify(report)}`);
    expect(report).toMatchInlineSnapshot(`
      {
        "afterDeleteReads": 10,
        "deleteReads": 19,
        "deleteWrites": 3,
        "extraMembershipWrites": 0,
        "samples": [
          {
            "membershipSourceReads": 0,
            "membershipWrites": 0,
            "missingReads": 0,
            "patchReads": 13,
            "patchWrites": 16,
            "selectedReads": 4,
            "uploadReads": 9,
            "uploadWrites": 18,
          },
          {
            "membershipSourceReads": 0,
            "membershipWrites": 0,
            "missingReads": 0,
            "patchReads": 13,
            "patchWrites": 16,
            "selectedReads": 8,
            "uploadReads": 11,
            "uploadWrites": 17,
          },
          {
            "membershipSourceReads": 0,
            "membershipWrites": 0,
            "missingReads": 0,
            "patchReads": 13,
            "patchWrites": 16,
            "selectedReads": 12,
            "uploadReads": 11,
            "uploadWrites": 17,
          },
        ],
        "sourceBatchReads": [
          5001,
          1001,
        ],
      }
    `);
  }, 60_000);
});
