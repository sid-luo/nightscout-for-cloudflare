import { describe, expect, it, vi } from "vitest";
import { filterDocuments } from "../src/documents";
import type { JsonDocument } from "../src/entry-store";
import { LegacyDeviceStatusQuery } from "../src/legacy-device-status-query";

const documents: JsonDocument[] = Array.from({ length: 5005 }, (_, index) => ({
  _id: String(index), date: Date.UTC(2026, 0, 1) - index * 60_000,
  created_at: new Date(Date.UTC(2026, 0, 1) - index * 60_000).toISOString(),
  device: `synthetic-${index % 3}`, battery: index % 2 === 0 ? 8 : "08",
  nested: { score: index % 5, flag: index % 2 === 0, label: index % 2 === 0 ? "MiXeD.[literal]" : "other" },
  checks: [{ value: index % 3 }, { value: 8 }],
  ...(index >= 5000 ? { onlyOutside: "yes" } : {}),
}));

function oracle(search: string) {
  const url = new URL("https://synthetic.invalid/api/v1/devicestatus.json");
  url.search = search;
  return filterDocuments(documents.slice(0, 5000), url, 10);
}

function observedSource() {
  let visited = 0;
  const close = vi.fn();
  const source = function* () {
    try { for (const document of documents) { visited++; yield document; } }
    finally { close(); }
  };
  return { source: source(), visited: () => visited, close };
}

describe("query-aware legacy device status consumption", () => {
  it("matches the existing filter and last-sort semantics, including coercion, arrays and the candidate cap", () => {
    for (const search of [
      "?count=5", "?count=5&count=9", "?count=10000",
      "?find[nested.score][$gte]=3&count=7", "?find[checks.value]=8&count=9",
      "?find[checks.value][$ne]=8&count=5", "?find[battery]=8&count=11",
      "?find[nested.label]=/mixed.[literal]/i&count=13", "?find[nested.flag]=true&count=5",
      "?find[missing][$exists]=false&count=5", "?find[nested.score][$in]=1,3&count=12",
      "?find[created_at][$gte]=2025-12-31T00:00:00Z&count=5",
      "?sort[nested.score]=1&count=15", "?sort[date]=-1&sort[device]=1&count=8",
      "?sort[device]=1&sort[date]=invalid&count=8",
      "?sort[bad$field]=1&count=5", "?sort[device]=invalid&count=5",
      "?find[nested.score][$unknown]=2&count=5", "?ignored=value&count=5",
      "?find[onlyOutside]=yes&count=1",
    ]) {
      const source = observedSource();
      const query = new LegacyDeviceStatusQuery(search);
      expect(query.read(source.source), search).toEqual(oracle(search));
      expect(source.visited(), search).toBeLessThanOrEqual(5000);
      expect(source.close, search).toHaveBeenCalledTimes(1);
    }
  });

  it("stops when enough filtered rows arrive and fully consumes arbitrary valid sorts", () => {
    const unsorted = observedSource();
    expect(new LegacyDeviceStatusQuery("?find[nested.score]=3&count=2").read(unsorted.source)).toEqual(oracle("?find[nested.score]=3&count=2"));
    expect(unsorted.visited()).toBe(9);
    expect(unsorted.close).toHaveBeenCalledTimes(1);
    const sorted = observedSource();
    expect(new LegacyDeviceStatusQuery("?sort[nested.score]=1&count=2").read(sorted.source)).toEqual(oracle("?sort[nested.score]=1&count=2"));
    expect(sorted.visited()).toBe(5000);
    const absent = observedSource();
    expect(new LegacyDeviceStatusQuery("?find[onlyOutside]=yes&count=1").read(absent.source)).toEqual([]);
    expect(absent.visited()).toBe(5000);
  });

  it("validates count before any source consumption and keeps the simple-query classification", () => {
    for (const count of ["0", "-1", "1.5", "10001", "NaN"]) {
      expect(() => new LegacyDeviceStatusQuery(`?count=${count}`)).toThrow("count must be an integer from 1 to 10000");
    }
    expect(new LegacyDeviceStatusQuery("?count=5&ignored=yes").isSimple).toBe(true);
    expect(new LegacyDeviceStatusQuery("?find[ignored][$unknown]=1").isSimple).toBe(false);
    expect(new LegacyDeviceStatusQuery("?sort[device]=invalid").requiresFullWindow).toBe(false);
    expect(new LegacyDeviceStatusQuery("?sort[device]=1&sort[device]=invalid").requiresFullWindow).toBe(true);
    expect(new LegacyDeviceStatusQuery("?find[nested.score][$gte]=3&sort[date]=-1&sort[checks.value]=1&sort[device]=invalid")
      .projectionFields).toEqual(["checks.value", "nested.score"]);
  });

  it("projects exact dotted leaves for cold selection and reusable cache representations", () => {
    const input: JsonDocument[] = [{ nested: { score: 3, irrelevant: [1, 2, 3] }, checks: [{ value: 2, other: 4 }, {}, null] },
      { nested: {}, checks: [] }, {}, { nested: null, checks: [{ value: 1 }] }];
    const searches = ["?find[nested.score][$exists]=false&sort[checks.value]=1&count=4",
      "?find[checks.value][$ne]=2&sort[nested.score]=1&count=4", "?find[nested.score][$gte]=0&count=4",
      "?find[nested][$ne]=absent&sort[nested.score]=1&count=4"];
    const rows = input.map((document, index) => ({ id: `canonical-${index}`, body: JSON.stringify(document) }));
    for (const search of searches) {
      const query = new LegacyDeviceStatusQuery(search);
      const expected = filterDocuments(input, new URL(`https://synthetic.invalid/${search}`), 10)
        .map(document => `canonical-${input.indexOf(document)}`);
      expect(query.selectCandidateRows(rows).map(row => row.id), search).toEqual(expected);
      expect(query.selectCandidateRows(rows.map(row => query.projectCandidate(row))).map(row => row.id), search).toEqual(expected);
    }
    expect(JSON.parse(new LegacyDeviceStatusQuery("?sort[nested.score]=1").projectCandidate(rows[0]!).body))
      .toEqual({ nested: { score: 3 } });
    expect(JSON.parse(new LegacyDeviceStatusQuery("?sort[nested]=1").projectCandidate(rows[0]!).body))
      .toEqual({ nested: { score: 3, irrelevant: [1, 2, 3] } });
  });

  it("streams a full cold miss over large prediction bodies within the original candidate bound", () => {
    const query = new LegacyDeviceStatusQuery("?find[missing.child][$exists]=false&count=5");
    const body = JSON.stringify({ openaps: { suggested: { predBGs: {
      IOB: Array(256).fill(110), COB: Array(256).fill(110), UAM: Array(256).fill(110), ZT: Array(256).fill(110),
    } } } });
    let visited = 0, closed = 0;
    const source = function* () {
      try { for (let n = 0; n < 5005; n++) { visited++; yield { id: `canonical-${n}`, body }; } }
      finally { closed++; }
    };
    const selected = query.selectCandidateRows(source());
    expect(selected!).toEqual([]);
    expect(visited).toBe(5000);
    expect(closed).toBe(1);
  });

  it("keeps only matching original rows and closes early over large prediction bodies", () => {
    const query = new LegacyDeviceStatusQuery("?find[nested.score]=3&count=2");
    let visited = 0, closed = 0;
    const source = function* () {
      try {
        for (let n = 0; n < 5005; n++) {
          visited++;
          yield { id: `canonical-${n}`, body: JSON.stringify({ _id: `public-${n}`, nested: { score: n % 5 },
            openaps: { predBGs: Array(2048).fill(110) } }) };
        }
      } finally { closed++; }
    };
    const selected = query.selectCandidateRows(source());
    expect(selected.map(row => row.id)).toEqual(["canonical-3", "canonical-8"]);
    for (const row of selected) expect((JSON.parse(row.body) as { openaps: { predBGs: number[] } }).openaps.predBGs).toHaveLength(2048);
    expect(visited).toBe(9);
    expect(closed).toBe(1);
  });

  it("keeps the original read-plus-generator closing and error precedence for unsorted rows", () => {
    const storage = new Error("original storage failure"), close = new Error("original close failure");
    for (const scenario of ["source-next", "parse", "early-match", "eof", "throw-undefined"] as const) {
      const query = new LegacyDeviceStatusQuery("?find[a]=1&count=1");
      const make = () => {
        let closed = 0;
        const rows: Iterable<{ body: string }> = { [Symbol.iterator]: () => ({
          next: () => {
            if (scenario === "source-next") throw storage;
            if (scenario === "throw-undefined") throw undefined;
            return scenario === "eof" ? { done: true as const, value: undefined }
              : { done: false as const, value: { body: scenario === "parse" ? "invalid JSON" : '{"a":1}' } };
          },
          return: () => { closed++; throw close; },
        }) };
        return { rows, closed: () => closed };
      };
      const capture = (action: () => unknown) => {
        try { return { thrown: false, value: action() }; }
        catch (error) { return { thrown: true, value: error }; }
      };
      const original = make(), current = make();
      function* originalDocuments(): IterableIterator<JsonDocument> {
        for (const row of original.rows) yield JSON.parse(row.body) as JsonDocument;
      }
      const before = capture(() => query.read(originalDocuments()));
      const after = capture(() => query.selectCandidateRows(current.rows));
      expect(after.thrown, scenario).toBe(before.thrown);
      expect(current.closed(), scenario).toBe(original.closed());
      if (scenario === "parse") {
        expect(after.value).toBeInstanceOf(SyntaxError);
        expect((after.value as Error).message).toBe((before.value as Error).message);
      } else expect(after.value, scenario).toEqual(before.value);
    }
  });

  it("propagates source failures and closes the cursor rather than returning a plausible partial success", () => {
    const close = vi.fn();
    const failure = new Error("synthetic storage failure");
    const source: Iterable<JsonDocument> = { [Symbol.iterator]: () => ({
      next: () => { throw failure; },
      return: () => { close(); return { done: true, value: undefined }; },
    }) };
    expect(() => new LegacyDeviceStatusQuery("?find[device]=synthetic&count=5").read(source)).toThrow(failure);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
