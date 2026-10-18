import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import { LegacyReadCache } from "../src/legacy-read-cache";
import { TreatmentMembershipReadView, TREATMENT_MEMBERSHIP_VIEW_KEY as KEY } from "../src/treatment-membership-read-view";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const id = (n: number) => n.toString(16).padStart(24, "0");
const query = (category: string, limit = 1): DocumentQuery => ({ limit,
  filters: [{ field: "eventType", operator: "eq", value: category }] });
function stateOf(cache: LegacyReadCache): unknown[] | undefined {
  const value = cache.get(KEY);
  return value === undefined || value === "pending" || value === "rejected" ? undefined : JSON.parse(value) as unknown[];
}
function measured<T>(sql: SqlStorage, operation: () => T) {
  const execute = sql.exec.bind(sql);
  const queries: { statement: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = execute(statement, ...bindings); queries.push({ statement, cursor }); return cursor;
  });
  try {
    const result = operation();
    const source = queries.filter(item => item.statement.includes(" AS valid_json") && item.statement.includes("FROM documents"));
    return { result, reads: queries.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: queries.reduce((sum, item) => sum + item.cursor.rowsWritten, 0),
      sourceReads: source.reduce((sum, item) => sum + item.cursor.rowsRead, 0), sourceCalls: source.length };
  } finally { spy.mockRestore(); }
}
function seed(sql: SqlStorage, count: number, unique = false): void {
  sql.exec(`WITH RECURSIVE s(n) AS(VALUES(0) UNION ALL SELECT n+1 FROM s WHERE n<?)
    INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,identifier_present,
      srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
    SELECT 'treatments',printf('%024x',n),json_object('_id',printf('%024x',n),'identifier','cold-'||n,
      'created_at','2026-10-18T12:00:00.000Z','rank',n,'isValid',1,
      'eventType',json(CASE WHEN n IN(137,5001,5900)
        THEN json_array('Note',?||n||?, 'Rare') ELSE json_array('Note',?||n||?) END)),
      ?+n,?,?, 'cold-'||n,1,?,?+n,?+n,1,1,1 FROM s`, count - 1,
  unique ? "Unique-" : "Other-", unique ? `-${"x".repeat(400)}` : "",
  unique ? "Unique-" : "Other-", unique ? `-${"x".repeat(400)}` : "", AT, AT, AT, AT, AT, AT);
  if (!unique) sql.exec("UPDATE documents SET body=json_set(body,'$.eventType',json('[\"Note\",\"Other\"]')) WHERE collection='treatments'");
}
function complete(sql: SqlStorage, view: TreatmentMembershipReadView, cache: LegacyReadCache, category: string) {
  if (cache.get(KEY) === undefined || stateOf(cache)?.[1] === "overlay") {
    view.candidates(category); view.noteExpensiveRead(513);
  }
  const samples = [];
  for (let attempt = 0; stateOf(cache)?.[1] !== "complete" && attempt < 8; attempt++) {
    samples.push(measured(sql, () => view.candidates(category)));
    expect(cache.get(KEY)).not.toBe("rejected");
  }
  expect(stateOf(cache)?.[1]).toBe("complete");
  return samples;
}

// Calibrate the deliberately overflowing row independently from the runtime
// incremental ledger: one full serialization before/after its non-target key.
function overflowFixture(sql: SqlStorage): { key: string; beforeBytes: number; afterBytes: number } {
  const key = id(1177), categories = new Map<string, string[] | null>();
  const fold = (key: string, members: string[]) => {
    for (const member of members) {
      const previous = categories.get(member);
      if (previous === null) continue;
      const ids = previous ?? [];
      if (!ids.includes(key)) ids.push(key);
      categories.set(member, ids.length > 64 ? null : ids);
    }
  };
  for (const row of sql.exec<{ id: string; event: string }>(`SELECT id,json_extract(body,'$.eventType') AS event
    FROM documents WHERE collection='treatments' AND id<? ORDER BY id`, key)) fold(row.id, JSON.parse(row.event) as string[]);
  const bytes = () => 2 * (KEY.length + JSON.stringify([2, "partial", null, [...categories]]).length);
  const beforeBytes = bytes();
  const row = sql.exec<{ event: string }>("SELECT json_extract(body,'$.eventType') AS event FROM documents WHERE collection='treatments' AND id=?", key).one();
  const selected = JSON.parse(row.event) as string[];
  expect(selected.at(-1)).toBe("Overflow Tail Target");
  fold(key, selected.slice(0, -1));
  const afterBytes = bytes();
  expect(beforeBytes).toBeLessThanOrEqual(1024 * 1024); expect(afterBytes).toBeGreaterThan(1024 * 1024);
  return { key, beforeBytes, afterBytes };
}

describe("membership cold prewarm and capacity boundaries", () => {
  it("stops a cold chunk as soon as the requested category becomes dense and lets another category finish the prefix", async () => {
    const stub = env.ENTRY_STORE.getByName(`member-cold-dense-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql; seed(sql, 4900);
      const cache = new LegacyReadCache();
      const cached = new SqliteDocumentRepository(state.storage, undefined, undefined, cache);
      const original = new SqliteDocumentRepository(state.storage);
      const first = measured(sql, () => cached.queryLegacyTreatments(query("Absent")));
      expect(first.result).toEqual(original.queryLegacyTreatments(query("Absent")));
      expect(cache.get(KEY)).toBe("pending");
      const beforeFullChunk = measured(sql, () => sql.exec(`SELECT id,json_valid(body) AS valid_json,
        CASE WHEN json_valid(body) THEN json_type(body,'$.eventType') END AS event_kind,
        CASE WHEN json_valid(body) THEN json_extract(body,'$.eventType') END AS event_value
        FROM documents WHERE collection='treatments' ORDER BY id ASC LIMIT 5001`).toArray());
      const cold = measured(sql, () => cached.queryLegacyTreatments(query("Note")));
      const repeat = measured(sql, () => cached.queryLegacyTreatments(query("Note", 2)));
      expect(cold.result).toEqual(original.queryLegacyTreatments(query("Note")));
      expect(repeat.result).toEqual(original.queryLegacyTreatments(query("Note", 2)));
      expect(cold.sourceReads).toBeLessThanOrEqual(67); expect(cold.sourceReads).toBeGreaterThanOrEqual(65);
      expect(repeat.sourceReads).toBe(0); expect(stateOf(cache)?.[1]).toBe("partial");
      // The original successful empty first page now already proves this
      // exact native order. Reusing it must not finish unrelated membership.
      const reused = measured(sql, () => cached.queryLegacyTreatments(query("Absent", 3)));
      expect(reused.result).toEqual([]); expect(reused.reads).toBe(0); expect(reused.sourceReads).toBe(0);
      expect(stateOf(cache)?.[1]).toBe("partial");
      // A previously unqueried category can resume the same complete prefix;
      // its absence is authoritative only after the remaining true EOF.
      const completed = measured(sql, () => cached.queryLegacyTreatments(query("Another Absent", 3)));
      const warm = measured(sql, () => cached.queryLegacyTreatments(query("Another Absent", 7)));
      expect(completed.result).toEqual([]); expect(warm.result).toEqual([]); expect(warm.reads).toBe(0);
      expect(completed.sourceReads).toBe(4835);
      expect(stateOf(cache)?.[1]).toBe("complete");
      expect([first, cold, repeat, reused, completed, warm].every(sample => sample.writes === 0)).toBe(true);
      const totalReads = first.reads + cold.reads + repeat.reads + reused.reads + completed.reads + warm.reads;
      expect(totalReads).toBeLessThanOrEqual(19604);
      return { firstRequestReads: first.reads, baselineUnconditionalChunkReads: beforeFullChunk.reads,
        coldDenseRequestReads: cold.reads, coldDenseSourceReads: cold.sourceReads, repeatDenseRequestReads: repeat.reads,
        repeatDenseSourceReads: repeat.sourceReads, reusedSameMissingReads: reused.reads, reusedSameMissingSourceReads: reused.sourceReads,
        laterMissingRequestReads: completed.reads, laterMissingSourceReads: completed.sourceReads,
        warmMissingReads: warm.reads, requests: 6, totalSixRequestsReads: totalReads, writes: 0 };
    });
    console.info(`MEMBERSHIP_COLD_DENSE_PROGRESS=${JSON.stringify(report)}`);
    expect(report).toMatchInlineSnapshot(`
      {
        "baselineUnconditionalChunkReads": 4900,
        "coldDenseRequestReads": 67,
        "coldDenseSourceReads": 66,
        "firstRequestReads": 4900,
        "laterMissingRequestReads": 4835,
        "laterMissingSourceReads": 4835,
        "repeatDenseRequestReads": 2,
        "repeatDenseSourceReads": 0,
        "requests": 6,
        "reusedSameMissingReads": 0,
        "reusedSameMissingSourceReads": 0,
        "totalSixRequestsReads": 9804,
        "warmMissingReads": 0,
        "writes": 0,
      }
    `);
  });

  it("narrows overflowing global membership without losing a target at the end of the exact overflow row", async () => {
    const stub = env.ENTRY_STORE.getByName(`member-cold-capacity-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql; seed(sql, 6001, true);
      sql.exec("UPDATE documents SET body=json_insert(body,'$.eventType[#]','Overflow Tail Target') WHERE collection='treatments' AND id=?", id(1177));
      const overflow = overflowFixture(sql);
      const cache = new LegacyReadCache();
      const cached = new SqliteDocumentRepository(state.storage, undefined, undefined, cache);
      const original = new SqliteDocumentRepository(state.storage);
      const target = query("Overflow Tail Target");
      const first = measured(sql, () => cached.queryLegacyTreatments(target));
      const partial = measured(sql, () => cached.queryLegacyTreatments(target));
      expect(first.result).toEqual(original.queryLegacyTreatments(target));
      expect(partial.result).toEqual(original.queryLegacyTreatments(target));
      expect(stateOf(cache)?.[0]).toBe(3); expect(stateOf(cache)?.[1]).toBe("partial");
      expect(stateOf(cache)?.[3]).toBe("Overflow Tail Target");
      const complete = measured(sql, () => cached.queryLegacyTreatments({ ...target, limit: 3 }));
      const warm = measured(sql, () => cached.queryLegacyTreatments({ ...target, limit: 7 }));
      expect(complete.result).toEqual(original.queryLegacyTreatments({ ...target, limit: 3 }));
      expect(warm.result).toEqual(original.queryLegacyTreatments({ ...target, limit: 7 }));
      expect(new TreatmentMembershipReadView(sql, cache).candidates("Overflow Tail Target")).toEqual([overflow.key]);
      expect(new TreatmentMembershipReadView(sql, cache).candidates("Rare")).toBeUndefined();
      const foreign = measured(sql, () => cached.queryLegacyTreatments(query("Rare", 3)));
      expect(foreign.result).toEqual(original.queryLegacyTreatments(query("Rare", 3)));
      expect(foreign.result).toHaveLength(3); expect(foreign.sourceReads).toBe(0);
      expect(stateOf(cache)?.[3]).toBe("Overflow Tail Target");
      expect([first, partial, complete, warm, foreign].every(sample => sample.writes === 0)).toBe(true);
      return { overflow, firstRequestReads: first.reads, partialRequestReads: partial.reads, partialSourceReads: partial.sourceReads,
        completionRequestReads: complete.reads, completionSourceReads: complete.sourceReads, warmRequestReads: warm.reads,
        foreignScopeFallbackReads: foreign.reads, foreignScopeSourceReads: foreign.sourceReads,
        sourceBuildTotalReads: partial.sourceReads + complete.sourceReads,
        fourTargetRequestsReads: first.reads + partial.reads + complete.reads + warm.reads,
        scopedBytes: 2 * (KEY.length + cache.get(KEY)!.length), writes: 0 };
    });
    console.info(`MEMBERSHIP_CAPACITY_FOCUSED=${JSON.stringify(report)}`);
    expect(report).toMatchInlineSnapshot(`
      {
        "completionRequestReads": 1007,
        "completionSourceReads": 1001,
        "firstRequestReads": 1178,
        "foreignScopeFallbackReads": 5901,
        "foreignScopeSourceReads": 0,
        "fourTargetRequestsReads": 8370,
        "overflow": {
          "afterBytes": 1048742,
          "beforeBytes": 1047850,
          "key": "000000000000000000000499",
        },
        "partialRequestReads": 6179,
        "partialSourceReads": 5001,
        "scopedBytes": 282,
        "sourceBuildTotalReads": 6002,
        "warmRequestReads": 6,
        "writes": 0,
      }
    `);
  }, 60_000);

  it("preserves preexisting and mutation-overlay target members while narrowing under an outer rollback", async () => {
    const stub = env.ENTRY_STORE.getByName(`member-focused-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (instance, state) => {
      const sql = state.storage.sql; seed(sql, 6001, true);
      sql.exec("UPDATE documents SET body=? WHERE collection='treatments' AND id=?", JSON.stringify({
        _id: id(12), identifier: "cold-12", created_at: "2026-10-18T12:00:00.000Z", rank: 12, eventType: ["Rare", "Original Overlay"],
      }), id(12));
      const internal = instance as unknown as { legacyTreatmentQueries: LegacyReadCache; documentRepository(): SqliteDocumentRepository };
      const cache = internal.legacyTreatmentQueries, view = new TreatmentMembershipReadView(sql, cache);
      expect(() => state.storage.transactionSync(() => {
        internal.documentRepository().upsertTreatment({ _id: id(12), identifier: "cold-12",
          created_at: "2026-10-18T12:00:00.000Z", rank: 12, eventType: ["Other", "Uncommitted"] });
        complete(sql, view, cache, "Rare");
        expect(stateOf(cache)?.[0]).toBe(3); expect(stateOf(cache)?.[3]).toBe("Rare");
        expect(view.candidates("Rare")).toEqual([id(12), id(137), id(5001), id(5900)]);
        throw new Error("rollback focused collection");
      })).toThrow("rollback focused collection");
      const original = new SqliteDocumentRepository(state.storage);
      expect(internal.documentRepository().queryLegacyTreatments(query("Rare", 10)))
        .toEqual(original.queryLegacyTreatments(query("Rare", 10)));
      expect(view.candidates("Original Overlay")).toBeUndefined();
      expect(TreatmentMembershipReadView.isUnsafe(cache)).toBe(false);
      cache.clear(); // A real lost rollback overlay remains unsafe; never rebuild from uncommitted state.
      expect(TreatmentMembershipReadView.isUnsafe(cache)).toBe(true);
      const refused = measured(sql, () => { view.candidates("Rare"); view.noteExpensiveRead(100_000); return view.candidates("Rare"); });
      expect(refused.result).toBeUndefined(); expect(refused.sourceReads).toBe(0);
      expect(internal.documentRepository().queryLegacyTreatments(query("Rare", 10)))
        .toEqual(original.queryLegacyTreatments(query("Rare", 10)));
    });
  }, 60_000);

  it("retries an atomic shared-cache admission refusal with a smaller explicitly scoped EOF proof", async () => {
    const stub = env.ENTRY_STORE.getByName(`member-focused-admission-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql; seed(sql, 256, true);
      const originalMembers = sql.exec<{ id: string; event: string }>(`SELECT id,json_extract(body,'$.eventType') AS event
        FROM documents WHERE collection='treatments' ORDER BY id`).toArray();
      // Keep the real >512 delayed admission contract after short-array
      // optimization: append seven nulls, preserving every original member.
      // The original 2/3 members become 9/10 and use the unchanged long ELSE.
      sql.exec(`UPDATE documents SET body=json_insert(body,
        '$.eventType[#]',null,'$.eventType[#]',null,'$.eventType[#]',null,'$.eventType[#]',null,
        '$.eventType[#]',null,'$.eventType[#]',null,'$.eventType[#]',null) WHERE collection='treatments'`);
      const paddedMembers = sql.exec<{ id: string; event: string }>(`SELECT id,json_extract(body,'$.eventType') AS event
        FROM documents WHERE collection='treatments' ORDER BY id`).toArray();
      expect(paddedMembers.map(row => {
        const values = JSON.parse(row.event) as unknown[];
        expect(values.length).toBeGreaterThan(8); expect(values.slice(-7)).toEqual(Array(7).fill(null));
        return { id: row.id, values: values.slice(0, -7) };
      })).toEqual(originalMembers.map(row => ({ id: row.id, values: JSON.parse(row.event) as unknown[] })));
      const cache = new LegacyReadCache(128, 4 * 1024 * 1024, 512);
      const cached = new SqliteDocumentRepository(state.storage, undefined, undefined, cache);
      const first = measured(sql, () => cached.queryLegacyTreatments(query("Absent")));
      expect(first.reads).toBeGreaterThan(512);
      expect(first.result).toEqual([]); expect(cache.get(KEY)).toBe("pending");
      let rejectedGlobal = false, admittedFocused = false;
      const put = cache.set.bind(cache);
      const spy = vi.spyOn(cache, "set").mockImplementation((key, value) => {
        const admitted = put(key, value);
        if (key === KEY && value.startsWith("[2,")) rejectedGlobal ||= !admitted;
        if (key === KEY && value.startsWith("[3,")) admittedFocused ||= admitted;
        return admitted;
      });
      let build;
      try { build = measured(sql, () => cached.queryLegacyTreatments(query("Absent", 3))); }
      finally { spy.mockRestore(); }
      const warm = measured(sql, () => cached.queryLegacyTreatments(query("Absent", 7)));
      expect(rejectedGlobal).toBe(true); expect(admittedFocused).toBe(true);
      expect(stateOf(cache)?.[0]).toBe(3); expect(stateOf(cache)?.[3]).toBe("Absent");
      expect(build.result).toEqual([]); expect(warm.result).toEqual([]); expect(warm.reads).toBe(0);
      expect(first.writes + build.writes + warm.writes).toBe(0);
      return { firstRequestReads: first.reads, buildRequestReads: build.reads, buildSourceReads: build.sourceReads,
        warmRequestReads: warm.reads, scopedBytes: 2 * (KEY.length + cache.get(KEY)!.length), rejectedGlobal, admittedFocused, writes: 0 };
    });
    console.info(`MEMBERSHIP_CAPACITY_ADMISSION=${JSON.stringify(report)}`);
    expect(report).toMatchInlineSnapshot(`
      {
        "admittedFocused": true,
        "buildRequestReads": 256,
        "buildSourceReads": 256,
        "firstRequestReads": 2561,
        "rejectedGlobal": true,
        "scopedBytes": 148,
        "warmRequestReads": 0,
        "writes": 0,
      }
    `);
  });

  it("decodes the independent focused version strictly and never treats an uncovered category as absent", () => {
    const sql = { exec() { throw new Error("unexpected SQL for serialized proof"); } } as unknown as SqlStorage;
    const valid = new LegacyReadCache();
    valid.set(KEY, JSON.stringify([3, "complete", null, "Rare", [["Rare", [id(1)]]]]));
    const view = new TreatmentMembershipReadView(sql, valid);
    expect(view.candidates("Rare")).toEqual([id(1)]); expect(view.candidates("Absent")).toBeUndefined();
    for (const payload of [
      [3, "complete", null, null, []],
      [3, "complete", null, "Rare", [["Other", []]]],
      [3, "complete", null, "Rare", [["Rare", []], ["Rare", []]]],
      [3, "complete", null, "Rare", [["Rare", Array(65).fill(id(1))]]],
      [3, "overlay", id(1), "Rare", []],
      [3, "complete", null, "Rare", [], "extra"],
      [4, "complete", null, "Rare", []],
    ]) {
      const cache = new LegacyReadCache(); cache.set(KEY, JSON.stringify(payload));
      expect(new TreatmentMembershipReadView(sql, cache).candidates("Rare")).toBeUndefined();
      expect(cache.get(KEY)).toBe("rejected");
    }
  });
});
