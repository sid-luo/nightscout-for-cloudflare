import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository, type DocumentQuery } from "../src/document-repository";
import { LegacyReadCache } from "../src/legacy-read-cache";
import { TreatmentMembershipReadView, TREATMENT_MEMBERSHIP_VIEW_KEY } from "../src/treatment-membership-read-view";
import { TREATMENT_ORDER_SOURCE_KEY } from "../src/treatment-order-read-view";

const AT = Date.parse("2026-10-18T12:00:00.000Z");
const id = (n: number) => n.toString(16).padStart(24, "0");
interface Internal {
  legacyTreatmentQueries: LegacyReadCache;
  documentRepository(): SqliteDocumentRepository;
  recordDataMutationInTransaction(collection: string): void;
}

function seed(sql: SqlStorage, n: number, eventFragment = '"eventType":"Note"'): void {
  const body = `{"_id":"${id(n)}","identifier":"mutation-${n}","created_at":"2026-10-18T12:00:00.000Z",${eventFragment},"rank":${n}}`;
  sql.exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,
    identifier_present,srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
    VALUES('treatments',?,?,?,?,?,?,1,?,?,?,1,1,1)`,
  id(n), body, AT, AT, AT, `mutation-${n}`, AT, AT, AT);
}

function learn(sql: SqlStorage, cache: LegacyReadCache, category = "Absent"): string[] {
  // Exercise production admission and complete chunk publication. No test
  // constructs the serialized categories or independently merges them.
  const view = new TreatmentMembershipReadView(sql, cache);
  for (let attempt = 0; attempt < 8; attempt++) {
    const ids = view.candidates(category);
    if (ids !== undefined) return ids;
    view.noteExpensiveRead(513);
  }
  throw new Error("membership did not finish the bounded test fixture");
}

function candidates(sql: SqlStorage, cache: LegacyReadCache, category: string): string[] | undefined {
  return new TreatmentMembershipReadView(sql, cache).candidates(category);
}

function replaceMember(repo: SqliteDocumentRepository, n: number, eventType: string | string[], rank = n): void {
  // API3 deliberately makes eventType immutable. Locked legacy save/upsert
  // resolves this canonical _id and replaces the body without that API3 rule.
  repo.upsertTreatment({ _id: id(n), identifier: `mutation-${n}`, eventType,
    created_at: new Date(AT).toISOString(), rank });
}

function oracle(storage: DurableObjectStorage, cached: SqliteDocumentRepository, category: string): void {
  const query: DocumentQuery = { limit: 100, includeDeleted: true,
    sort: { field: "rank", direction: "asc" },
    filters: [{ field: "eventType", operator: "eq", value: category }] };
  expect(cached.queryDocumentsForApi3("treatments", query), category)
    .toEqual(new SqliteDocumentRepository(storage).queryDocumentsForApi3("treatments", query));
}

function clearAfterCapacityChurn(cache: LegacyReadCache): void {
  for (let n = 0; n < 129; n++) expect(cache.set(`api3:mutation-lru-${n}`, "[]")).toBe(true);
  // Capacity churn now retains protected history. Explicit invalidation still
  // destroys it and must retain the original rollback-safe fallback contract.
  expect(cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY)).toBeDefined();
  cache.clear();
  expect(cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY)).toBeUndefined();
}

describe("monotone treatment membership survives real write failure and rollback", () => {
  it("remembers SQLite's first duplicate member before canonical SQL fails, without publishing failed exact/order responses", async () => {
    const stub = env.ENTRY_STORE.getByName(`member-prewrite-fault-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (instance, state) => {
      const internal = instance as unknown as Internal;
      const sql = state.storage.sql;
      seed(sql, 1, '"eventType":"Note","eventType":"LastDuplicate"');
      const cache = internal.legacyTreatmentQueries;
      expect(learn(sql, cache, "Note")).toEqual([id(1)]);
      cache.set(TREATMENT_ORDER_SOURCE_KEY, "1");
      cache.set("api3:before-failed-write", "old exact response");
      cache.set("\0treatment-order:v1:before-failed-write", "[]");
      const repo = internal.documentRepository();
      sql.exec(`CREATE TRIGGER membership_test_reject BEFORE INSERT ON documents
        WHEN NEW.collection='treatments' BEGIN SELECT RAISE(ABORT,'synthetic canonical fault'); END`);
      try {
        expect(() => replaceMember(repo, 1, ["Added", "LastDuplicate"]))
          .toThrow("synthetic canonical fault");
        expect(() => repo.createTreatment({ _id: id(9), identifier: "failed-create", eventType: "CreatedOnly",
          created_at: new Date(AT).toISOString() })).toThrow("synthetic canonical fault");
      } finally { sql.exec("DROP TRIGGER membership_test_reject"); }
      expect(candidates(sql, cache, "Note")).toEqual([id(1)]);
      expect(candidates(sql, cache, "Added")).toEqual([id(1)]);
      expect(candidates(sql, cache, "CreatedOnly")).toEqual([id(9)]);
      expect(cache.get(TREATMENT_ORDER_SOURCE_KEY)).toBe("2"); // Failed create only loosens the count upper bound.
      expect(cache.get("api3:before-failed-write")).toBeUndefined();
      expect(cache.get("\0treatment-order:v1:before-failed-write")).toBeUndefined();
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM documents WHERE collection='treatments'").one().count).toBe(1);
      for (const category of ["Note", "LastDuplicate", "Added", "CreatedOnly", "Absent"]) oracle(state.storage, repo, category);
      expect(TreatmentMembershipReadView.isUnsafe(cache)).toBe(false);
    });
  });

  it("keeps old/new/delete/create candidates across nested writes and an outer rollback while the original SQL removes extras", async () => {
    const stub = env.ENTRY_STORE.getByName(`member-outer-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (instance, state) => {
      const internal = instance as unknown as Internal;
      const sql = state.storage.sql;
      seed(sql, 1); seed(sql, 2, '"eventType":["Other","Note"]');
      const cache = internal.legacyTreatmentQueries;
      expect(learn(sql, cache, "Note")).toEqual([id(1), id(2)]);
      cache.set(TREATMENT_ORDER_SOURCE_KEY, "2");
      const repo = internal.documentRepository();
      expect(repo.patchTreatment("mutation-1", { notes: "allowed API3 patch", rank: 101 })).not.toBeNull();
      expect(candidates(sql, cache, "Note")).toEqual([id(1), id(2)]);
      expect(cache.get(TREATMENT_ORDER_SOURCE_KEY)).toBe("2");
      expect(() => state.storage.transactionSync(() => {
        replaceMember(repo, 1, ["Other", "Added"], -1);
        expect(repo.deleteTreatmentById(id(2))).toBe(true);
        repo.createTreatment({ _id: id(3), identifier: "mutation-created", eventType: "CreatedOnly",
          created_at: new Date(AT).toISOString(), rank: 100 });
        for (const category of ["Note", "Other", "Added", "CreatedOnly", "Absent"]) oracle(state.storage, repo, category);
        throw new Error("synthetic outer rollback");
      })).toThrow("synthetic outer rollback");
      expect(candidates(sql, cache, "Note")).toEqual([id(1), id(2)]);
      expect(candidates(sql, cache, "Added")).toEqual([id(1)]);
      expect(candidates(sql, cache, "CreatedOnly")).toEqual([id(3)]);
      expect(cache.get(TREATMENT_ORDER_SOURCE_KEY)).toBe("3"); // Delete/rollback cannot shrink the proof.
      expect(sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM documents WHERE collection='treatments'").one().count).toBe(2);
      for (const category of ["Note", "Other", "Added", "CreatedOnly", "Absent"]) oracle(state.storage, repo, category);
      expect(TreatmentMembershipReadView.isUnsafe(cache)).toBe(false);
    });
  });

  it("falls back safely after a callback explicitly clears the monotone lane and throws, clearing callback-only exact/order values", async () => {
    const stub = env.ENTRY_STORE.getByName(`member-callback-eviction-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (instance, state) => {
      const internal = instance as unknown as Internal;
      const sql = state.storage.sql;
      seed(sql, 1);
      const cache = internal.legacyTreatmentQueries;
      expect(learn(sql, cache, "Note")).toEqual([id(1)]);
      cache.set(TREATMENT_ORDER_SOURCE_KEY, "1");
      const repo = internal.documentRepository();
      let observedUncommitted = false;
      const spy = vi.spyOn(internal, "recordDataMutationInTransaction").mockImplementation(collection => {
        if (collection !== "treatments") return;
        observedUncommitted = sql.exec<{ value: string }>(
          "SELECT json_extract(body,'$.eventType') AS value FROM documents WHERE collection='treatments' AND id=?", id(1)).one().value === "Added";
        clearAfterCapacityChurn(cache);
        cache.set("api3:callback-only", "uncommitted");
        cache.set("\0treatment-order:v1:callback-only", "[]");
        throw new Error("synthetic callback rollback");
      });
      try { expect(() => replaceMember(repo, 1, "Added")).toThrow("synthetic callback rollback"); }
      finally { spy.mockRestore(); }
      expect(observedUncommitted).toBe(true);
      // Do not blindly restore a prior capsule: a nested write may have
      // extended it. Lost history makes authority unsafe for this activation.
      expect(TreatmentMembershipReadView.isUnsafe(cache)).toBe(true);
      expect(candidates(sql, cache, "Note")).toBeUndefined();
      expect(candidates(sql, cache, "Added")).toBeUndefined();
      expect(cache.get(TREATMENT_ORDER_SOURCE_KEY)).toBeUndefined();
      expect(cache.get("api3:callback-only")).toBeUndefined();
      expect(cache.get("\0treatment-order:v1:callback-only")).toBeUndefined();
      for (const category of ["Note", "Added", "Absent"]) oracle(state.storage, repo, category);
    });
  });

  it("merges a no-view mutation overlay into a build inside an uncommitted transaction instead of losing rollback's old category", async () => {
    const stub = env.ENTRY_STORE.getByName(`member-no-view-overlay-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (instance, state) => {
      const internal = instance as unknown as Internal;
      const sql = state.storage.sql;
      seed(sql, 1);
      const cache = internal.legacyTreatmentQueries;
      expect(cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY)).toBeUndefined();
      const repo = internal.documentRepository();
      expect(() => state.storage.transactionSync(() => {
        replaceMember(repo, 1, "Added");
        expect(learn(sql, cache, "Note")).toEqual([id(1)]);
        expect(candidates(sql, cache, "Added")).toEqual([id(1)]);
        for (const category of ["Note", "Added", "Absent"]) oracle(state.storage, repo, category);
        throw new Error("rollback after uncommitted view build");
      })).toThrow("rollback after uncommitted view build");
      expect(candidates(sql, cache, "Note")).toEqual([id(1)]);
      expect(candidates(sql, cache, "Added")).toEqual([id(1)]);
      for (const category of ["Note", "Added", "Absent"]) oracle(state.storage, repo, category);
      expect(TreatmentMembershipReadView.isUnsafe(cache)).toBe(false);
    });
  });

  it("disables authoritative rebuilding after mutation history is explicitly lost or cannot fit, until a fresh activation cache exists", async () => {
    const stub = env.ENTRY_STORE.getByName(`member-sticky-unsafe-${crypto.randomUUID()}`);
    await runInDurableObject(stub, (instance, state) => {
      const internal = instance as unknown as Internal;
      const sql = state.storage.sql;
      seed(sql, 1);
      const cache = internal.legacyTreatmentQueries;
      expect(learn(sql, cache, "Note")).toEqual([id(1)]);
      const repo = internal.documentRepository();
      expect(() => state.storage.transactionSync(() => {
        replaceMember(repo, 1, "Added");
        clearAfterCapacityChurn(cache);
        expect(TreatmentMembershipReadView.isUnsafe(cache)).toBe(true);
        for (let n = 0; n < 3; n++) {
          const view = new TreatmentMembershipReadView(sql, cache);
          expect(view.candidates("Note")).toBeUndefined();
          view.noteExpensiveRead(10_000);
          expect(cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY)).toBeUndefined();
        }
        throw new Error("rollback after losing membership history");
      })).toThrow("rollback after losing membership history");
      cache.clear(); // A plain clear is not a new activation or a safety proof.
      expect(TreatmentMembershipReadView.isUnsafe(cache)).toBe(true);
      for (const category of ["Note", "Added", "Absent"]) oracle(state.storage, repo, category);
      expect(cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY)).toBeUndefined();

      const tiny = new LegacyReadCache(128, 4096, 256);
      expect(learn(sql, tiny, "Note")).toEqual([id(1)]);
      new TreatmentMembershipReadView(sql, tiny).rememberMutation(id(1), '{"eventType":"Note"}',
        JSON.stringify({ eventType: "A".repeat(512) }));
      expect(TreatmentMembershipReadView.isUnsafe(tiny)).toBe(true);
      expect(candidates(sql, tiny, "Note")).toBeUndefined();
      expect(learn(sql, new LegacyReadCache(), "Note")).toEqual([id(1)]);
    });
  });
});
