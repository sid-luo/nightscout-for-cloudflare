import { describe, expect, it } from "vitest";
import { LegacyReadCache } from "../src/legacy-read-cache";
import { TreatmentMembershipReadView, TREATMENT_MEMBERSHIP_VIEW_KEY as KEY } from "../src/treatment-membership-read-view";

const ID = "000000000000000000000001";
const OTHER = "000000000000000000000002";
// These cursors exercise lookup/admission control only. SQLite JSON spelling
// and mutation extraction semantics are covered by the real native suites.
function fakeSql() {
  const calls: string[] = [];
  const row = { id: ID, valid_json: 1, event_kind: "array", event_value: '["Rare"]', fragment_oversized: 0 };
  const sql = { exec(statement: string) {
    calls.push(statement);
    return { toArray: () => [row], [Symbol.iterator]: () => [row][Symbol.iterator]() };
  } } as unknown as SqlStorage;
  return { sql, calls };
}
function stored(cache: LegacyReadCache): unknown {
  const value = cache.get(KEY);
  return value === undefined || value === "pending" || value === "rejected" ? value : JSON.parse(value);
}

describe("complete membership peek without optional source learning", () => {
  it("reuses complete old/global/focused supersets and returns isolated ids without SQL", () => {
    for (const format of [[[ID, ["Rare"]]], [2,"complete",ID,[["Rare",[ID]], ["Dense",null]]],
      [3,"complete",ID,"Rare",[["Rare",[ID]]]]]) {
      const cache = new LegacyReadCache(), { sql, calls } = fakeSql(); cache.set(KEY, JSON.stringify(format));
      const view = new TreatmentMembershipReadView(sql, cache);
      const ids = view.peekCandidates("Rare"); expect(ids).toEqual([ID]);
      ids!.push(OTHER); expect(view.peekCandidates("Rare")).toEqual([ID]);
      const focused = format[0] === 3;
      expect(view.peekCandidates("Absent")).toEqual(focused ? undefined : []);
      expect(view.peekCandidates("Dense")).toEqual(focused || format[0] === 2 ? undefined : []);
      expect(view.peekCandidates("é")).toBeUndefined(); expect(calls).toEqual([]);
      cache.clear();
      expect(view.peekCandidates("Rare")).toBeUndefined(); expect(calls).toEqual([]);
    }
    // A rejected shared-pool admission cannot become authority held by a view.
    const cache = new LegacyReadCache(128, 64, 64), { sql, calls } = fakeSql();
    expect(cache.set(KEY, JSON.stringify([2, "complete", ID, [["Rare", [ID]]]]))).toBe(false);
    const view = new TreatmentMembershipReadView(sql, cache);
    expect(view.peekCandidates("Rare")).toBeUndefined();
    expect(view.peekCandidates("Absent")).toBeUndefined(); expect(calls).toEqual([]);
  });

  it("never builds pending/partial/overlay while retaining the existing next-query admission gate", () => {
    for (const format of ["pending", [2,"partial",ID,[["Rare",[ID]]]], [2,"overlay",null,[["Rare",[ID]]]]]) {
      const cache = new LegacyReadCache(), { sql, calls } = fakeSql();
      cache.set(KEY, typeof format === "string" ? format : JSON.stringify(format));
      const view = new TreatmentMembershipReadView(sql, cache);
      expect(view.peekCandidates("Rare")).toBeUndefined(); expect(calls).toEqual([]);
      view.noteExpensiveRead(513); expect(calls).toEqual([]);
      expect(view.peekCandidates("Absent")).toBeUndefined(); expect(calls).toEqual([]);
    }
    const cache = new LegacyReadCache(), { sql, calls } = fakeSql();
    const view = new TreatmentMembershipReadView(sql, cache);
    expect(view.peekCandidates("Rare")).toBeUndefined(); view.noteExpensiveRead(512);
    expect(stored(cache)).toBeUndefined();
    view.peekCandidates("Rare"); view.noteExpensiveRead(513);
    expect(stored(cache)).toBe("pending"); expect(calls).toEqual([]);
    expect(view.candidates("Rare")).toEqual([ID]); expect(calls).toHaveLength(1);
    expect(view.peekCandidates("Rare")).toEqual([ID]); expect(calls).toHaveLength(1);
  });

  it("keeps generation/epoch admission guards after a no-scan lookup", () => {
    const cache = new LegacyReadCache(), { sql, calls } = fakeSql();
    const view = new TreatmentMembershipReadView(sql, cache);
    view.peekCandidates("Rare"); cache.clear(); view.noteExpensiveRead(1000);
    expect(stored(cache)).toBeUndefined(); expect(calls).toEqual([]);
    view.peekCandidates("é"); view.noteExpensiveRead(1000);
    expect(stored(cache)).toBeUndefined(); expect(calls).toEqual([]);
    view.peekCandidates("Rare"); view.rememberMutation(ID, undefined, '{"eventType":["Rare"]}');
    expect(calls).toHaveLength(1); expect((stored(cache) as unknown[])[1]).toBe("overlay");
    view.noteExpensiveRead(1000); expect((stored(cache) as unknown[])[1]).toBe("overlay");
    view.peekCandidates("Rare"); view.noteExpensiveRead(1000);
    expect((stored(cache) as unknown[])[1]).toBe("partial"); expect(calls).toHaveLength(1);
  });

  it("declines invalid authority and lost mutation history without any source probe", () => {
    for (const format of ["not-json", [2,"complete",ID,[["Rare",["unsafe\0id"]]]],
      [3,"complete",ID,"Other",[["Rare",[ID]]]]]) {
      const cache = new LegacyReadCache(), { sql, calls } = fakeSql();
      cache.set(KEY, typeof format === "string" ? format : JSON.stringify(format));
      expect(new TreatmentMembershipReadView(sql, cache).peekCandidates("Rare")).toBeUndefined();
      expect(cache.get(KEY)).toBe("rejected"); expect(calls).toEqual([]);
    }
    const cache = new LegacyReadCache(), { sql, calls } = fakeSql();
    const view = new TreatmentMembershipReadView(sql, cache);
    view.rememberMutation(ID, undefined, '{"eventType":["Rare"]}'); cache.clear();
    expect(view.peekCandidates("Rare")).toBeUndefined(); expect(TreatmentMembershipReadView.isUnsafe(cache)).toBe(true);
    view.noteExpensiveRead(1000); expect(stored(cache)).toBeUndefined(); expect(calls).toHaveLength(1);
  });

  it("leaves original builder operational errors observable only on the explicit building path", () => {
    let calls = 0;
    const failure = new Error("synthetic original SQL operational failure");
    const sql = { exec() { calls++; throw failure; } } as unknown as SqlStorage;
    const cache = new LegacyReadCache(); cache.set(KEY, "pending");
    const view = new TreatmentMembershipReadView(sql, cache);
    expect(view.peekCandidates("Rare")).toBeUndefined(); expect(calls).toBe(0);
    expect(() => view.candidates("Rare")).toThrow(failure); expect(calls).toBe(1);
    expect(cache.get(KEY)).toBe("pending");
  });
});
