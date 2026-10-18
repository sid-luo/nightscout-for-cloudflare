import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { SqliteDocumentRepository } from "../src/document-repository";

const ROWS = 16;
const BLOCKS = 3;
const TARGET_BATCH_MS = 10;
const CALIBRATION_BUDGET_MS = 40;
const MIN_CALLS = 16;
const MAX_CALLS = 256;
const WARMUP_CALLS = 4;
const TARGET = "Target";
const AT = Date.parse("2026-10-18T00:00:00.000Z");
const MODES = ["original", "precedingSamePlan", "current", "foldedCurrent"] as const;
type Mode = typeof MODES[number];

interface RawRow extends Record<string, SqlStorageValue> { id: string; body: string }
interface Statement { sql: string; bindings: SqlStorageValue[] }
interface Sample { ms: number; calls: number; reads: number; writes: number; returned: number; last: RawRow[] }
interface Fixture {
  name: string;
  members: unknown[];
  scalar?: string;
  payload?: "notes" | "nested";
  notesChars?: number;
  escaped?: boolean;
}

function fixture(name: string, length: number, match: "missing" | "prefix" | "suffix", payload?: Fixture["payload"]): Fixture {
  const members: unknown[] = Array.from({ length }, (_, n) => `Other${n}`);
  if (match !== "missing") members[match === "prefix" ? 0 : length - 1] = TARGET;
  return { name, members, ...(payload === undefined ? {} : { payload }) };
}

const fixtures: Fixture[] = [
  ...([2, 8, 9, 64] as const).flatMap(length => (["missing", "prefix", "suffix"] as const)
    .map(match => fixture(`array${length}-${match}`, length, match,
      length === 8 ? "notes" : length === 64 ? "nested" : undefined))),
  fixture("array1025-missing", 1025, "missing"),
  { name: "nested-members-missing", members: [[TARGET], { value: TARGET }], payload: "nested" },
  { ...fixture("escaped-members-missing", 9, "missing", "notes"), escaped: true },
  { ...fixture("escaped-members-prefix", 9, "prefix"), escaped: true },
  ...(["missing", "prefix", "suffix"] as const).map(match => fixture(`compact-array64-${match}`, 64, match)),
  { ...fixture("array9-notes1024-missing", 9, "missing", "notes"), notesChars: 1024 },
  { ...fixture("array64-notes1024-missing", 64, "missing", "notes"), notesChars: 1024 },
  { name: "scalar-target", members: [], scalar: TARGET },
  { name: "scalar-other", members: [], scalar: "Other" },
];

// Independent preceding predicate. Capture production SQL below instead of
// reproducing the optional short-array builder or a proposed replacement.
const original: Statement = {
  sql: `SELECT * FROM documents WHERE collection = 'treatments'
    AND collection IN ('treatments', 'devicestatus') AND json_valid(body)
    AND ((json_type(body, '$.eventType') = 'text' AND json_extract(body, '$.eventType') = ?)
      OR (json_type(body, '$.eventType') = 'array' AND EXISTS (
        SELECT 1 FROM json_each(body, '$.eventType') AS item
        WHERE item.type = 'text' AND item.value = ?)))
    ORDER BY json_extract(body, '$.created_at') DESC, id ASC LIMIT ? OFFSET ?`,
  bindings: [TARGET, TARGET, 3, 0],
};

function canonicalRows(rows: RawRow[]) {
  return rows.map(row => ({ id: row.id, body: row.body }));
}

/** Experiment only: generated SQL has anonymous parameters and no comments. */
function foldStringBindings(statement: Statement): Statement {
  const bindings: SqlStorageValue[] = [];
  const strings = new Map<string, number>();
  let consumed = 0;
  // Doubled SQL quotes stay within their original single/double-quoted token.
  // The transformation runs once outside every measured interval. Its cost is
  // deliberately excluded, so this is not an end-to-end production proposal.
  const sql = statement.sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, (token: string, offset: number) => {
    if (token !== "?") return token;
    if (/\d/.test(statement.sql.charAt(offset + 1))) throw new Error("Diagnostic expects anonymous parameters only");
    expect(consumed).toBeLessThan(statement.bindings.length);
    const value = statement.bindings[consumed++]!;
    let parameter = typeof value === "string" ? strings.get(value) : undefined;
    if (parameter === undefined) {
      bindings.push(value);
      parameter = bindings.length;
      if (typeof value === "string") strings.set(value, parameter);
    }
    return `?${parameter}`;
  });
  expect(consumed, "Every original binding must have exactly one anonymous SQL parameter").toBe(statement.bindings.length);
  return { sql, bindings };
}

function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let n = 0; n < text.length; n++) value = Math.imul(value ^ text.charCodeAt(n), 0x01000193);
  return (value >>> 0).toString(16).padStart(8, "0");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function checkLocalClock(): { elapsedMs: number; checksum: number } {
  const start = performance.now();
  let checksum = 0x811c9dc5;
  for (let n = 0; n < 1_000_000; n++) checksum = Math.imul(checksum ^ n, 0x01000193);
  let elapsedMs = performance.now() - start;
  if (elapsedMs === 0) {
    for (let n = 0; n < 8_000_000; n++) checksum = Math.imul(checksum ^ n, 0x01000193);
    elapsedMs = performance.now() - start;
  }
  // A frozen deployment/fake clock cannot measure synchronous SQL. Fail the
  // diagnostic explicitly instead of reporting zero/NaN as a CPU result.
  if (!(elapsedMs > 0)) throw new Error("LOCAL_WALL_CLOCK_NOT_ADVANCING: stop the synchronous SQL timing comparison");
  return { elapsedMs, checksum: checksum >>> 0 };
}

describe("local workerd treatment-array SQL timing diagnostic", () => {
  it("compares captured production SQL with the complete preceding query without a timing golden", async () => {
    const stub = env.ENTRY_STORE.getByName(`treatment-array-cpu-${crypto.randomUUID()}`);
    const report = await runInDurableObject(stub, (_instance, state) => {
      const benchmark = (env as unknown as { TREATMENT_ARRAY_CPU_BENCHMARK?: string })
        .TREATMENT_ARRAY_CPU_BENCHMARK === "1";
      const clock = benchmark ? checkLocalClock() : null;
      const sql = state.storage.sql;
      const exec = sql.exec.bind(sql);
      let numberedPlaceholderProbe: { supported: boolean; error?: string; result?: unknown; reads?: number; writes?: number };
      let numberedCursor: SqlStorageCursor<{ repeated: number; other: number }> | undefined;
      try {
        numberedCursor = exec<{ repeated: number; other: number }>(
          "SELECT ?1 = ?1 AS repeated, ?2 AS other", TARGET, 7);
        numberedPlaceholderProbe = { supported: true };
      } catch (error) {
        // Do not force an unsupported extension into any production statement.
        numberedPlaceholderProbe = { supported: false, error: String(error) };
      }
      if (numberedCursor !== undefined) {
        const result = numberedCursor.one();
        expect(result).toEqual({ repeated: 1, other: 7 });
        expect(numberedCursor.rowsRead).toBe(0);
        expect(numberedCursor.rowsWritten).toBe(0);
        numberedPlaceholderProbe = { supported: true, result,
          reads: numberedCursor.rowsRead, writes: numberedCursor.rowsWritten };
      }
      const repository = new SqliteDocumentRepository(state.storage);
      const cases = [];
      let firstSql: Record<Mode, Statement> | undefined;
      const nested = Array.from({ length: 16 }, (_, branch) => ({
        branch, values: Array.from({ length: 8 }, () => "n".repeat(512)),
      }));
      for (const [caseNumber, item] of fixtures.entries()) {
        let eventJson = JSON.stringify(item.scalar === undefined ? item.members : item.scalar);
        if (item.escaped) eventJson = eventJson.replaceAll("Other", "\\u004fther").replaceAll(TARGET, "\\u0054arget");
        const payload = item.payload === "notes" ? `,"notes":${JSON.stringify("p".repeat(item.notesChars ?? 65_536))}`
          : item.payload === "nested" ? `,"unrelated":${JSON.stringify(nested)}` : "";
        state.storage.transactionSync(() => {
          exec("DELETE FROM documents WHERE collection='treatments'");
          for (let n = 0; n < ROWS; n++) {
            const at = AT + n;
            const body = `{"created_at":${JSON.stringify(new Date(at).toISOString())},"eventType":${eventJson},"marker":${n}${payload}}`;
            exec(`INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at)
              VALUES('treatments',?,?,?,?,?)`, n.toString(16).padStart(24, "0"), body, at, at, at);
          }
        });
        const oracle = exec<RawRow>(original.sql, ...original.bindings).toArray();
        const expected = canonicalRows(oracle);
        const capture = (value: string, expectedResponse: unknown[]): Statement => {
          const selected: Statement[] = [];
          const captured: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
          const spy = vi.spyOn(sql, "exec").mockImplementation((statement, ...bindings) => {
            const cursor = exec(statement, ...bindings);
            captured.push(cursor);
            if (/^SELECT\b/i.test(statement.trim()) && /\b(?:FROM|JOIN) documents\b/.test(statement)) {
              selected.push({ sql: statement, bindings });
            }
            return cursor;
          });
          try {
            expect(repository.queryLegacyTreatments({ limit: 3, filters: [
              { field: "eventType", operator: "eq", value },
            ] }), item.name).toEqual(expectedResponse);
            expect(captured.reduce((sum, cursor) => sum + cursor.rowsWritten, 0), item.name).toBe(0);
          } finally { spy.mockRestore(); }
          expect(selected, "Stop and adapt this harness if production becomes a multi-stage data query").toHaveLength(1);
          return selected[0]!;
        };
        const current = capture(TARGET, oracle.map(row => ({ ...JSON.parse(row.body), _id: row.id })));
        // The production 512-unit eligibility guard supplies its real original
        // predicate and native source/UNION/page shape. Only substitute bound
        // category values afterwards; do not reverse-engineer its SQL builder.
        const marker = "P".repeat(513);
        const preceding = capture(marker, []);
        expect(preceding.bindings.some(value => value === marker)).toBe(true);
        const precedingSamePlan: Statement = { sql: preceding.sql,
          bindings: preceding.bindings.map(value => value === marker ? TARGET : value) };
        const foldedCurrent = foldStringBindings(current);
        const statements = { original, precedingSamePlan, current, foldedCurrent };
        firstSql ??= statements;
        const columns = (statement: Statement) => {
          const cursor = exec(statement.sql, ...statement.bindings);
          const names = [...cursor.columnNames];
          cursor.toArray();
          expect(cursor.rowsWritten).toBe(0);
          return names;
        };
        expect(columns(precedingSamePlan), `${item.name}:same production result-column shape`).toEqual(columns(current));
        expect(columns(foldedCurrent), `${item.name}:folded result-column shape`).toEqual(columns(current));
        const run = (statement: Statement, calls: number): Sample => {
          let reads = 0, writes = 0, returned = 0;
          let last: RawRow[] = [];
          const start = benchmark ? performance.now() : 0;
          for (let n = 0; n < calls; n++) {
            const cursor = exec<RawRow>(statement.sql, ...statement.bindings);
            last = cursor.toArray();
            reads += cursor.rowsRead; writes += cursor.rowsWritten; returned += last.length;
          }
          return { ms: benchmark ? performance.now() - start : 0, calls, reads, writes, returned, last };
        };
        const baselines = { original: run(original, 1), precedingSamePlan: run(precedingSamePlan, 1),
          current: run(current, 1), foldedCurrent: run(foldedCurrent, 1) };
        for (const [mode, sample] of Object.entries(baselines)) {
          expect(canonicalRows(sample.last), `${item.name}:${mode}`).toEqual(expected);
          expect(sample.writes).toBe(0);
          expect(sample.reads).toBeLessThanOrEqual(ROWS * (item.members.length + 2) + 4);
        }
        expect(baselines.current.reads, item.name).toBeLessThanOrEqual(baselines.original.reads + ROWS + 4);
        expect(baselines.precedingSamePlan.reads, item.name).toBeLessThanOrEqual(baselines.original.reads + ROWS + 4);
        expect(baselines.foldedCurrent.reads, item.name).toBeLessThanOrEqual(baselines.original.reads + ROWS + 4);
        const verify = (sample: Sample, mode: keyof typeof statements) => {
          // Consume every cursor inside the measured interval. Full raw-body
          // comparisons stay outside it; retain only the final result tree.
          expect(canonicalRows(sample.last), `${item.name}:${mode}`).toEqual(expected);
          expect(sample.reads).toBe(baselines[mode].reads * sample.calls);
          expect(sample.returned).toBe(expected.length * sample.calls);
          expect(sample.writes).toBe(0);
        };
        const initialCalls = benchmark ? MIN_CALLS : 1;
        const batchCalls = { original: initialCalls, precedingSamePlan: initialCalls,
          current: initialCalls, foldedCurrent: initialCalls };
        if (benchmark) {
          for (const mode of MODES) verify(run(statements[mode], WARMUP_CALLS), mode);
          // A cold/GC spike must not select a one-call batch whose subsequent
          // timer readings round to zero. The minimum applies even if the first
          // batch consumes the calibration budget; there is no latency assertion.
          for (const mode of MODES) {
            const started = performance.now();
            for (;;) {
              const sample = run(statements[mode], batchCalls[mode]);
              verify(sample, mode);
              if (sample.ms >= TARGET_BATCH_MS || batchCalls[mode] >= MAX_CALLS
                || performance.now() - started >= CALIBRATION_BUDGET_MS) break;
              batchCalls[mode] *= 2;
            }
          }
        }
        const samples: Record<Mode, number[]> = { original: [], precedingSamePlan: [], current: [], foldedCurrent: [] };
        let seed = (0x9e3779b9 ^ caseNumber) >>> 0;
        for (let block = 0; block < (benchmark ? BLOCKS : 1); block++) {
          const order = [...MODES];
          for (let n = order.length - 1; n > 0; n--) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const selected = seed % (n + 1);
            [order[n], order[selected]] = [order[selected]!, order[n]!];
          }
          for (const mode of order) {
            const sample = run(statements[mode], batchCalls[mode]);
            verify(sample, mode);
            samples[mode].push(sample.ms / sample.calls);
          }
        }
        const originalMedianMs = median(samples.original), currentMedianMs = median(samples.current);
        const precedingSamePlanMedianMs = median(samples.precedingSamePlan);
        const foldedCurrentMedianMs = median(samples.foldedCurrent);
        cases.push({ name: item.name, kind: item.scalar === undefined ? "array" : "scalar",
          topLevelMembers: item.scalar === undefined ? item.members.length : null,
          bodyCodeUnits: exec<{ body: string }>("SELECT body FROM documents WHERE collection='treatments' LIMIT 1").one().body.length,
          returned: expected.length, originalReads: baselines.original.reads,
          precedingSamePlanReads: baselines.precedingSamePlan.reads, currentReads: baselines.current.reads,
          foldedCurrentReads: baselines.foldedCurrent.reads,
          writes: 0, originalSqlHash: hash(original.sql), currentSqlHash: hash(current.sql),
          precedingSamePlanSqlHash: hash(precedingSamePlan.sql), foldedCurrentSqlHash: hash(foldedCurrent.sql),
          originalSqlCodeUnits: original.sql.length, currentSqlCodeUnits: current.sql.length,
          precedingSamePlanSqlCodeUnits: precedingSamePlan.sql.length, foldedCurrentSqlCodeUnits: foldedCurrent.sql.length,
          currentBindings: current.bindings.length, precedingSamePlanBindings: precedingSamePlan.bindings.length,
          foldedCurrentBindings: foldedCurrent.bindings.length,
          batchCalls, originalMsPerCall: benchmark ? samples.original : null,
          precedingSamePlanMsPerCall: benchmark ? samples.precedingSamePlan : null,
          currentMsPerCall: benchmark ? samples.current : null, foldedCurrentMsPerCall: benchmark ? samples.foldedCurrent : null,
          originalMedianMs: benchmark ? originalMedianMs : null,
          precedingSamePlanMedianMs: benchmark ? precedingSamePlanMedianMs : null,
          currentMedianMs: benchmark ? currentMedianMs : null, foldedCurrentMedianMs: benchmark ? foldedCurrentMedianMs : null,
          zeroTimerSamples: benchmark ? { original: samples.original.filter(value => value === 0).length,
            precedingSamePlan: samples.precedingSamePlan.filter(value => value === 0).length,
            current: samples.current.filter(value => value === 0).length,
            foldedCurrent: samples.foldedCurrent.filter(value => value === 0).length } : null,
          currentToOriginalRatio: benchmark && originalMedianMs > 0 && currentMedianMs > 0
            ? currentMedianMs / originalMedianMs : null,
          currentToPrecedingSamePlanRatio: benchmark && precedingSamePlanMedianMs > 0 && currentMedianMs > 0
            ? currentMedianMs / precedingSamePlanMedianMs : null,
          foldedToCurrentRatio: benchmark && currentMedianMs > 0 && foldedCurrentMedianMs > 0
            ? foldedCurrentMedianMs / currentMedianMs : null,
          foldedToPrecedingSamePlanRatio: benchmark && precedingSamePlanMedianMs > 0 && foldedCurrentMedianMs > 0
            ? foldedCurrentMedianMs / precedingSamePlanMedianMs : null });
      }
      return { mode: benchmark ? "benchmark" : "functional",
        measurement: benchmark ? "local synchronous SQL wall time; not production billed CPU"
          : "functional SQL contracts; CPU timing disabled", clock, numberedPlaceholderProbe,
        rowsPerCase: ROWS, blocks: benchmark ? BLOCKS : 1, targetBatchMs: benchmark ? TARGET_BATCH_MS : null,
        calibrationBudgetMs: benchmark ? CALIBRATION_BUDGET_MS : null, minBatchCalls: benchmark ? MIN_CALLS : 1,
        maxBatchCalls: benchmark ? MAX_CALLS : 1, warmupCallsPerVariant: benchmark ? WARMUP_CALLS : 0,
        sqlHash: "FNV-1a32 of exact SQL text", firstSql, cases };
    });
    console.info(`TREATMENT_ARRAY_CPU_AUDIT=${JSON.stringify(report)}`);
  }, 60_000);
});
