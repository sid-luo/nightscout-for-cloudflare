import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import { LegacyReadCache } from "../src/legacy-read-cache";
import { TreatmentMembershipReadView, TREATMENT_MEMBERSHIP_VIEW_KEY as KEY } from "../src/treatment-membership-read-view";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const id = (n: number) => n.toString(16).padStart(24, "0");
const CATEGORY = `((json_type(body,'$.eventType')='text' AND json_extract(body,'$.eventType')=?)
  OR (json_type(body,'$.eventType')='array' AND EXISTS (
    SELECT 1 FROM json_each(body,'$.eventType') item WHERE item.type='text' AND item.value=?)))`;
interface RawRow extends Record<string, SqlStorageValue> { id: string; body: string }
function query(category: string, limit = 100, skip = 0): DocumentQuery {
  return { limit, skip, filters: [{ field: "eventType", operator: "eq", value: category }] };
}
function measured<T>(sql: SqlStorage, operation: () => T) {
  const execute = sql.exec.bind(sql);
  const queries: { statement: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = execute(statement, ...bindings); queries.push({ statement, cursor }); return cursor;
  });
  try {
    const result = operation();
    const sources = queries.filter(item => item.statement.includes(" AS valid_json") && item.statement.includes("FROM documents"));
    const metadata = queries.filter(item => item.statement.includes(" AS valid_json") && !item.statement.includes("FROM documents"));
    return { result, reads: queries.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      writes: queries.reduce((sum, item) => sum + item.cursor.rowsWritten, 0), calls: queries.length,
      sourceReads: sources.reduce((sum, item) => sum + item.cursor.rowsRead, 0), sourceCalls: sources.length,
      metadataReads: metadata.reduce((sum, item) => sum + item.cursor.rowsRead, 0),
      metadataWrites: metadata.reduce((sum, item) => sum + item.cursor.rowsWritten, 0), metadataCalls: metadata.length };
  } finally { spy.mockRestore(); }
}
function phase(cache: LegacyReadCache): unknown {
  const value = cache.get(KEY);
  return value === undefined || value === "pending" || value === "rejected" ? value : JSON.parse(value)[1];
}
function seed(sql: SqlStorage, n: number, fragment: string): void {
  const created = new Date(AT + n * 1000).toISOString();
  const body = `{"_id":"${id(n)}","identifier":"long-${n}","created_at":"${created}",
    "date":${AT + n * 1000},"rank":${n % 3},"eventType":${fragment},
    "srvCreated":${AT},"srvModified":${AT + n * 1000},"isValid":1}`;
  sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,identifier_present,
    srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
    VALUES('treatments',?,?,?,?,?,?,1,?,?,?,1,1,1)`,
  id(n), body, AT + n * 1000, AT, AT, `long-${n}`, AT, AT + n * 1000, AT + n * 1000);
}
function original(sql: SqlStorage, storage: DurableObjectStorage, requested: DocumentQuery, legacy: boolean) {
  const category = requested.filters![0]!.value;
  const order = legacy ? "json_extract(body,'$.created_at') DESC,id ASC" : "sort_time DESC,srv_modified DESC,id ASC";
  // Independent original JSON1 predicate, full native order and pagination.
  const rows = sql.exec<RawRow>(`SELECT * FROM documents WHERE collection='treatments' AND json_valid(body)
    ${legacy ? "" : "AND is_valid!=0"} AND ${CATEGORY} ORDER BY ${order} LIMIT ? OFFSET ?`,
  category as string, category as string, requested.limit ?? 100, requested.skip ?? 0).toArray();
  const materializer = new SqliteDocumentRepository(storage);
  (materializer as unknown as { queryTreatmentRows(): RawRow[] }).queryTreatmentRows = () => rows;
  return legacy ? materializer.queryLegacyTreatments(requested) : materializer.queryTreatments(requested);
}

describe("long treatment arrays in the existing membership budget", () => {
  it("learns different missing categories and sparse long-array candidates without rejecting repeated/nontext members", async () => {
    const report = await runInDurableObject(env.ENTRY_STORE.getByName(`long-members-${crypto.randomUUID()}`), (_instance, state) => {
      const sql = state.storage.sql;
      const note = JSON.stringify(Array<string>(1025).fill("Note"));
      for (let n = 0; n < 65; n++) seed(sql, n, note);
      const otherFragments = [
        JSON.stringify([...Array<null>(1024).fill(null), "Rare"]),
        JSON.stringify([...Array<unknown>(1024).fill(["NestedOnly"]), "Rare"]),
        `[${Array<string>(1025).fill('"\\u0052are"').join(",")}]`,
        `${note},"eventType":["Wrong"]`, // SQLite's first field, rather than JSON.parse(body)'s last field.
        JSON.stringify(Array<number>(1025).fill(7)), JSON.stringify(Array<boolean>(1025).fill(true)),
        JSON.stringify(Array<string>(1025).fill("A\0suffix")), JSON.stringify(Array<string>(1025).fill("é")),
        "null", JSON.stringify(Array<string>(1025).fill("")),
        JSON.stringify([...Array<boolean>(1024).fill(false), 'Quote"x']),
        JSON.stringify([...Array<null>(1024).fill(null), "Back\\x"]),
      ];
      otherFragments.forEach((fragment, n) => seed(sql, 65 + n, fragment));
      const sourceRows = 65 + otherFragments.length;
      const cache = new LegacyReadCache(), view = new TreatmentMembershipReadView(sql, cache);
      const cached = new SqliteDocumentRepository(state.storage, undefined, undefined, cache);
      // Distinct names are essential: a successful original empty first page
      // already caches that exact order, independently of membership learning.
      const first = measured(sql, () => cached.queryLegacyTreatments(query("MissingA")));
      expect(first.result).toEqual(original(sql, state.storage, query("MissingA"), true));
      expect(first.reads).toBeGreaterThan(512); expect(phase(cache)).toBe("pending");
      const builds = [];
      for (let attempt = 0; phase(cache) !== "complete" && attempt < 8; attempt++) {
        const requested = query(`MissingB-${attempt}`);
        const build = measured(sql, () => cached.queryLegacyTreatments(requested));
        expect(build.result).toEqual(original(sql, state.storage, requested, true));
        expect(build.sourceCalls).toBe(1); expect(build.sourceReads).toBeLessThanOrEqual(34);
        if (phase(cache) === "partial") {
          // The bounded prefix is never authoritative empty: this request
          // still pays for the complete original residual, counted here.
          expect(build.reads).toBeGreaterThan(512);
        }
        builds.push({ reads: build.reads, writes: build.writes, sourceReads: build.sourceReads, phase: phase(cache) });
      }
      expect(builds.length).toBeGreaterThanOrEqual(3); expect(phase(cache)).toBe("complete");
      expect(builds.reduce((sum, sample) => sum + sample.sourceReads, 0)).toBeLessThanOrEqual(sourceRows + builds.length);
      const missing = measured(sql, () => cached.queryLegacyTreatments(query("MissingC", 3, 2)));
      expect(missing.result).toEqual(original(sql, state.storage, query("MissingC", 3, 2), true));
      expect(missing.reads).toBe(0); expect(missing.sourceCalls).toBe(0);
      expect(view.candidates("Rare")).toEqual([id(65), id(66), id(67)]);
      expect(view.candidates("Wrong")).toEqual([]); expect(view.candidates("NestedOnly")).toEqual([]);
      expect(view.candidates("Note")).toBeUndefined(); // >64 canonical rows remains dense, regardless of duplicate array members.
      const checks = [];
      for (const legacy of [true, false]) for (const category of ["Rare", "Note", "", 'Quote"x', "Back\\x", "Wrong", "7", "true", "NestedOnly"]) {
        const requested = query(category, 100, legacy ? 0 : 1);
        const actual = measured(sql, () => legacy ? cached.queryLegacyTreatments(requested) : cached.queryTreatments(requested));
        expect(actual.result, `${legacy}/${category}`).toEqual(original(sql, state.storage, requested, legacy));
        expect(actual.writes).toBe(0); expect(actual.sourceCalls).toBe(0);
        checks.push({ legacy, category, reads: actual.reads, returned: actual.result.length });
      }
      const bytes = 2 * (KEY.length + cache.get(KEY)!.length);
      expect(bytes).toBeLessThanOrEqual(1024 * 1024);
      expect((cache as unknown as { bytes: number }).bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      const buildWrites = builds.reduce((sum, sample) => sum + sample.writes, 0);
      expect(first.writes + buildWrites + missing.writes).toBe(0);
      return { sourceRows, firstMissingAReads: first.reads, builds,
        completeLearningRequestsReads: first.reads + builds.reduce((sum, sample) => sum + sample.reads, 0),
        sourceBuildReads: builds.reduce((sum, sample) => sum + sample.sourceReads, 0),
        warmDifferentMissingCReads: missing.reads, serializedBytes: bytes,
        readsOnlyWrites: first.writes + buildWrites + missing.writes, checks };
    });
    console.info(`LONG_ARRAY_MEMBERSHIP_REPO=${JSON.stringify(report)}`);
  });

  it("keeps the existing distinct-member and both fragment limits conservative without false empty answers", async () => {
    const reports = [];
    for (const boundary of [
      { name: "129-distinct", fragment: JSON.stringify([...Array<string>(1025).fill("Note"),
        ...Array.from({ length: 129 }, (_, n) => `Unique${n}`)]), target: "Unique128" },
      { name: "utf16-fragment", fragment: JSON.stringify([...Array<string>(8192).fill("A"), "Rare"]), target: "Rare" },
      { name: "sql-fragment", fragment: JSON.stringify([...Array<string>(1025).fill("x".repeat(64)), "Rare"]), target: "Rare" },
    ]) {
      reports.push(await runInDurableObject(env.ENTRY_STORE.getByName(`long-limit-${boundary.name}-${crypto.randomUUID()}`), (_instance, state) => {
        const sql = state.storage.sql; seed(sql, 0, boundary.fragment);
        const cache = new LegacyReadCache(), view = new TreatmentMembershipReadView(sql, cache);
        view.candidates("MissingA"); view.noteExpensiveRead(513);
        const build = measured(sql, () => view.candidates("MissingB"));
        expect(build.result).toBeUndefined(); expect(cache.get(KEY)).toBe("rejected"); expect(build.writes).toBe(0);
        const cached = new SqliteDocumentRepository(state.storage, undefined, undefined, cache);
        const requested = query(boundary.target);
        const fallback = measured(sql, () => cached.queryLegacyTreatments(requested));
        expect(fallback.result).toEqual(original(sql, state.storage, requested, true));
        expect(fallback.result).toHaveLength(1); expect(fallback.writes).toBe(0);
        expect(view.candidates("MissingC")).toBeUndefined();
        return { name: boundary.name, fragmentCodeUnits: boundary.fragment.length,
          buildReads: build.reads, fallbackReads: fallback.reads, returned: fallback.result.length, writes: 0 };
      }));
    }
    console.info(`LONG_ARRAY_MEMBERSHIP_LIMITS=${JSON.stringify(reports)}`);
  });

  it("keeps long-array mutation supersets through rollback and refuses authority after their history is lost", async () => {
    const report = await runInDurableObject(env.ENTRY_STORE.getByName(`long-mutation-${crypto.randomUUID()}`), (_instance, state) => {
      const sql = state.storage.sql;
      seed(sql, 0, JSON.stringify(Array<string>(1025).fill("Note")));
      seed(sql, 1, JSON.stringify([...Array<null>(1024).fill(null), "Rare"]));
      const cache = new LegacyReadCache(), view = new TreatmentMembershipReadView(sql, cache);
      const cold = measured(sql, () => new SqliteDocumentRepository(state.storage).queryLegacyTreatments(query("MissingA")));
      expect(cold.reads).toBeGreaterThan(512);
      view.candidates("MissingA"); view.noteExpensiveRead(cold.reads);
      const build = measured(sql, () => view.candidates("MissingB"));
      expect(build.result).toEqual([]); expect(phase(cache)).toBe("complete"); expect(build.writes).toBe(0);
      let failAfterCallback = false;
      const clear = () => cache.clearKeeping([KEY]);
      const repository = new SqliteDocumentRepository(state.storage, undefined, collection => {
        if (collection === "treatments") { clear(); if (failAfterCallback) throw new Error("rollback long membership"); }
      }, cache, (collection, key, oldBody, newBody) => {
        if (collection !== "treatments") return undefined;
        view.rememberMutation(key, oldBody, newBody); clear(); return clear;
      });
      const save = (category: string) => repository.upsertTreatment({ _id: id(0), identifier: "long-0",
        created_at: "2026-10-18T12:00:00.000Z", eventType: Array<string>(1025).fill(category) });
      const update = measured(sql, () => save("Live"));
      expect(update.result.document._id).toBe(id(0)); expect(update.sourceCalls).toBe(0);
      expect(update.metadataCalls).toBe(1); expect(update.metadataReads + update.metadataWrites).toBe(0);
      expect(view.candidates("Live")).toEqual([id(0)]); expect(view.candidates("Note")).toEqual([id(0)]);
      expect(repository.queryLegacyTreatments(query("Live"))).toEqual(original(sql, state.storage, query("Live"), true));
      expect(repository.queryLegacyTreatments(query("Note"))).toEqual([]);
      failAfterCallback = true;
      const rollback = measured(sql, () => {
        try { save("Rollback"); return "unexpected-success"; } catch (error) { return String(error); }
      });
      failAfterCallback = false;
      expect(rollback.result).toContain("rollback long membership");
      expect(rollback.metadataCalls).toBe(1); expect(rollback.metadataReads + rollback.metadataWrites).toBe(0);
      expect(view.candidates("Rollback")).toEqual([id(0)]);
      expect(repository.queryLegacyTreatments(query("Rollback"))).toEqual([]);
      expect(repository.queryLegacyTreatments(query("Live"))).toEqual(original(sql, state.storage, query("Live"), true));
      cache.clear(); expect(TreatmentMembershipReadView.isUnsafe(cache)).toBe(true);
      const lost = measured(sql, () => view.candidates("Rare"));
      expect(lost.result).toBeUndefined(); expect(lost.reads + lost.writes).toBe(0);
      const fallback = measured(sql, () => repository.queryLegacyTreatments(query("Rare")));
      expect(fallback.result).toEqual(original(sql, state.storage, query("Rare"), true));
      expect(fallback.result).toHaveLength(1); expect(fallback.writes).toBe(0);
      return { coldReads: cold.reads, buildReads: build.reads, businessUpdateWrites: update.writes,
        updateMetadataReads: update.metadataReads, updateMetadataWrites: update.metadataWrites,
        rollbackMetadataReads: rollback.metadataReads, rollbackMetadataWrites: rollback.metadataWrites,
        lostHistoryCandidateReads: lost.reads, lostHistoryFallbackReads: fallback.reads, stickyUnsafe: true };
    });
    console.info(`LONG_ARRAY_MEMBERSHIP_MUTATION=${JSON.stringify(report)}`);
  });
});
