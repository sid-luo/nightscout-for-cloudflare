import type { LegacyReadCache } from "./legacy-read-cache";

export const TREATMENT_MEMBERSHIP_VIEW_KEY = "\0treatment-members:v1";
const PENDING = "pending";
const REJECTED = "rejected";
const SOURCE_BATCH_ROWS = 5000;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_FRAGMENT_BYTES = 64 * 1024;
const LARGE_ARRAY_ITEMS = 1024;
const MAX_LONG_ARRAY_ITEMS_PER_BATCH = 32_768;
const MAX_DISTINCT_ROW_MEMBERS = 128;
const MAX_CANDIDATES = 64;
type Phase = "overlay" | "partial" | "complete";
type Categories = Map<string, string[] | null>;
interface MembershipView { phase: Phase; after: string | null; categories: Categories; scope: string | null }
interface MutationSafety { hadMutation: boolean; unsafe: boolean; epoch: number }
interface ReadContext { generation: number; epoch: number; serialized: string }
interface MembershipRow extends Record<string, SqlStorageValue> {
  id: string; valid_json: number; event_kind: string | null;
  event_value: SqlStorageValue; fragment_oversized: number;
}

// A lost mutation overlay cannot be reconstructed from possibly uncommitted
// SQL: a later outer rollback could restore old members. Only a small safety
// fact lives off-pool; authoritative membership remains in the shared quota.
const mutationSafety = new WeakMap<LegacyReadCache, MutationSafety>();
function safety(cache: LegacyReadCache): MutationSafety {
  let state = mutationSafety.get(cache);
  if (state === undefined) {
    state = { hadMutation: false, unsafe: false, epoch: 0 };
    mutationSafety.set(cache, state);
  }
  return state;
}
function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[\x20-\x7e]{1,128}$/.test(value);
}
export function isTreatmentMembershipCategoryEligible(category: string): boolean {
  return /^[\x20-\x7e]{0,512}$/.test(category);
}
function members(row: MembershipRow, onLargeArray?: (items: number) => void): string[] | undefined {
  if (row.valid_json !== 1 || row.fragment_oversized !== 0 || !safeId(row.id)) return undefined;
  const value = row.event_value;
  if (typeof value === "string" && value.length * 2 > MAX_FRAGMENT_BYTES) return undefined;
  if (row.event_kind === "text") return typeof value === "string"
    ? isTreatmentMembershipCategoryEligible(value) ? [value] : [] : undefined;
  if (row.event_kind !== "array") return [];
  if (typeof value !== "string") return undefined;
  let array: unknown;
  try { array = JSON.parse(value); } catch { return undefined; }
  // The existing UTF-16 fragment budget already bounds this complete parse
  // and walk (at most 16,383 compact single-character primitive members).
  // Repeated/non-text members need no additional retained membership space.
  if (!Array.isArray(array)) return undefined;
  if (array.length > LARGE_ARRAY_ITEMS) onLargeArray?.(array.length);
  const selected = new Set<string>();
  for (const item of array) {
    // First-level BINARY text equality cannot turn non-ASCII/non-printable
    // strings into an eligible printable ASCII query.
    if (typeof item === "string" && isTreatmentMembershipCategoryEligible(item)) selected.add(item);
    if (selected.size > MAX_DISTINCT_ROW_MEMBERS) return undefined;
  }
  return [...selected];
}
const INNER_COLUMNS = `id,json_valid(body) AS valid_json,
  CASE WHEN json_valid(body) THEN json_type(body,'$.eventType') END AS event_kind,
  CASE WHEN json_valid(body) THEN json_extract(body,'$.eventType') END AS event_value`;
const COLUMNS = `id,valid_json,event_kind,
  CASE WHEN typeof(event_value)='text' AND length(CAST(event_value AS BLOB))>${MAX_FRAGMENT_BYTES}
    THEN 1 ELSE 0 END AS fragment_oversized,
  CASE WHEN typeof(event_value)='text' AND length(CAST(event_value AS BLOB))>${MAX_FRAGMENT_BYTES}
    THEN NULL ELSE event_value END AS event_value`;
function encoded(view: MembershipView): string {
  return JSON.stringify(view.scope === null
    ? [2, view.phase, view.after, [...view.categories]]
    : [3, view.phase, view.after, view.scope, [...view.categories]]);
}
function size(view: MembershipView): number {
  return 2 * (TREATMENT_MEMBERSHIP_VIEW_KEY.length + encoded(view).length);
}
function pairSize(category: string, ids: string[] | null): number {
  return 2 * JSON.stringify([category, ids]).length;
}

/** Incrementally accounts for serialized memory as a bounded source streams. */
class MembershipUnion {
  private bytes: number;
  constructor(readonly view: MembershipView) { this.bytes = size(view); }
  add(id: string, selected: string[]): boolean {
    for (const category of selected) {
      if (this.view.scope !== null && category !== this.view.scope) continue;
      const previous = this.view.categories.get(category);
      if (previous === null || previous?.includes(id)) continue;
      const next = previous === undefined ? [id]
        : previous.length === MAX_CANDIDATES ? null : [...previous, id];
      const delta = pairSize(category, next) - (previous === undefined ? 0 : pairSize(category, previous))
        + (previous === undefined && this.view.categories.size > 0 ? 2 : 0);
      if (this.bytes + delta > MAX_ENTRY_BYTES) return false;
      this.bytes += delta;
      this.view.categories.set(category, next);
    }
    return true;
  }
  focus(category: string): boolean {
    if (this.view.scope !== null && this.view.scope !== category) return false;
    const previous = this.view.categories.get(category);
    this.view.categories = new Map(previous === undefined ? [] : [[category, previous]]);
    this.view.scope = category;
    this.bytes = size(this.view);
    return this.bytes <= MAX_ENTRY_BYTES;
  }
  progress(phase: Phase, after: string | null): boolean {
    this.view.phase = phase; this.view.after = after;
    this.bytes = size(this.view);
    return this.bytes <= MAX_ENTRY_BYTES;
  }
}
function decoded(serialized: string): MembershipView | undefined {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { return undefined; }
  if (!Array.isArray(value)) return undefined;
  const view: MembershipView = { phase: "complete", after: null, categories: new Map(), scope: null };
  if (value[0] === 2 || value[0] === 3) {
    const focused = value[0] === 3;
    if (value.length !== (focused ? 5 : 4) || !["overlay", "partial", "complete"].includes(value[1] as string)
      || !(value[2] === null || safeId(value[2]))) return undefined;
    view.phase = value[1] as Phase; view.after = value[2] as string | null;
    if (view.phase === "overlay" && view.after !== null) return undefined;
    if (focused) {
      if (typeof value[3] !== "string" || !isTreatmentMembershipCategoryEligible(value[3])) return undefined;
      view.scope = value[3];
    }
    const pairs: unknown = value[focused ? 4 : 3];
    if (!Array.isArray(pairs)) return undefined;
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string"
        || !isTreatmentMembershipCategoryEligible(pair[0]) || view.categories.has(pair[0])
        || (view.scope !== null && pair[0] !== view.scope)) return undefined;
      const ids: unknown = pair[1];
      if (ids !== null && (!Array.isArray(ids) || ids.length > MAX_CANDIDATES || !ids.every(safeId))) return undefined;
      view.categories.set(pair[0], ids === null ? null : [...new Set(ids as string[])]);
    }
  } else {
    // Earlier local complete [canonicalId,members][] fixtures/views remain valid.
    const union = new MembershipUnion(view);
    for (const pair of value as unknown[]) {
      if (!Array.isArray(pair) || pair.length !== 2 || !safeId(pair[0]) || !Array.isArray(pair[1])
        || !pair[1].every(member => typeof member === "string" && isTreatmentMembershipCategoryEligible(member))) return undefined;
      if (!union.add(pair[0], pair[1] as string[])) return undefined;
    }
  }
  return size(view) <= MAX_ENTRY_BYTES ? view : undefined;
}

/**
 * Complete necessary membership supersets in the existing serialized pool.
 * Writes only union old/new members; original SQL filters stale ids after
 * updates, deletion or outer rollback. Partial overlays never answer empty.
 */
export class TreatmentMembershipReadView {
  private queryEligible = false;
  private queryGeneration = -1;
  private queryEpoch = -1;
  constructor(private readonly sql: SqlStorage, private readonly cache: LegacyReadCache) {}

  static isUnsafe(cache: LegacyReadCache): boolean {
    const state = safety(cache);
    if (state.hadMutation && cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY) === undefined) state.unsafe = true;
    return state.unsafe;
  }
  candidates(category: string): string[] | undefined {
    return this.lookup(category, true);
  }

  /** Reuse existing complete authority without starting optional source work. */
  peekCandidates(category: string): string[] | undefined {
    return this.lookup(category, false);
  }

  private lookup(category: string, allowBuild: boolean): string[] | undefined {
    this.queryEligible = isTreatmentMembershipCategoryEligible(category);
    this.queryGeneration = this.cache.generation; this.queryEpoch = safety(this.cache).epoch;
    if (!this.queryEligible || TreatmentMembershipReadView.isUnsafe(this.cache)) return undefined;
    let serialized = this.cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY);
    if (serialized === undefined || serialized === REJECTED) return undefined;
    let view: MembershipView | undefined = serialized === PENDING
      ? { phase: "partial", after: null, categories: new Map(), scope: null } : decoded(serialized);
    if (view === undefined) { this.reject(this.context(serialized)); return undefined; }
    if (view.scope !== null && view.scope !== category) return undefined;
    if (view.phase === "overlay") return undefined;
    if (view.phase === "partial") {
      if (!allowBuild) return undefined;
      // A dense necessary superset can never supply a bounded candidate list.
      // Another category can continue this same canonical prefix later.
      if (view.categories.get(category) === null) return undefined;
      serialized = this.build(serialized, view, category);
      if (serialized === undefined) return undefined;
      view = decoded(serialized);
    }
    if (view?.phase !== "complete") return undefined;
    const ids = view.categories.get(category);
    return ids === null ? undefined : ids ?? [];
  }

  /**
   * A validated partial prefix may exclude only its known non-members. Every
   * unvisited id remains eligible, as do monotone old/new mutation candidates.
   * This is a necessary SQL superset, never a complete candidate list.
   */
  partialPrefix(category: string): { after: string; ids: string[] } | undefined {
    if (!isTreatmentMembershipCategoryEligible(category) || TreatmentMembershipReadView.isUnsafe(this.cache)) return undefined;
    const serialized = this.cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY);
    if (serialized === undefined || serialized === PENDING || serialized === REJECTED) return undefined;
    const view = decoded(serialized);
    // Focused views already bound retained work to one category. The extra
    // sparse-id SQL probe can add a read without a useful prefix reduction.
    if (view?.phase !== "partial" || view.after === null || view.scope !== null) return undefined;
    const ids = view.categories.get(category);
    return ids === null ? undefined : { after: view.after, ids: ids ?? [] };
  }

  /** Call only after the original query succeeds; the next query may scan. */
  noteExpensiveRead(rowsRead: number): void {
    const state = safety(this.cache);
    if (!this.queryEligible || !Number.isFinite(rowsRead) || rowsRead <= 512
      || this.queryGeneration !== this.cache.generation || this.queryEpoch !== state.epoch
      || TreatmentMembershipReadView.isUnsafe(this.cache)) return;
    const serialized = this.cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY);
    if (serialized === undefined) this.cache.set(TREATMENT_MEMBERSHIP_VIEW_KEY, PENDING);
    else if (serialized !== PENDING && serialized !== REJECTED) {
      const view = decoded(serialized);
      if (view?.phase === "overlay") {
        view.phase = "partial";
        if (!this.cache.set(TREATMENT_MEMBERSHIP_VIEW_KEY, encoded(view))) this.disable();
      }
    }
  }

  /**
   * Before canonical SQL, extract old/new JSON using SQLite (zero source rows).
   * Optional data/size refusal disables authority without failing the write;
   * operational SQL errors still propagate through the canonical transaction.
   */
  rememberMutation(id: string, oldBody?: string, newBody?: string): void {
    const state = safety(this.cache);
    const previous = this.cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY);
    if (state.hadMutation && previous === undefined) state.unsafe = true;
    state.hadMutation = true; state.epoch++;
    if (state.unsafe || previous === REJECTED) return;
    if (!safeId(id) || (oldBody === undefined && newBody === undefined)) { this.disable(); return; }
    const view: MembershipView | undefined = previous === undefined || previous === PENDING
      ? { phase: previous === PENDING ? "partial" : "overlay", after: null, categories: new Map(), scope: null }
      : decoded(previous);
    if (view === undefined) { this.disable(); return; }
    const generation = this.cache.generation, epoch = state.epoch;
    const bodies = [oldBody, newBody].filter((body): body is string => body !== undefined);
    const values: SqlStorageValue[] = bodies.flatMap(body => [id, body]);
    const rows = this.sql.exec<MembershipRow>(`SELECT ${COLUMNS} FROM (SELECT ${INNER_COLUMNS}
      FROM (${bodies.map(() => "SELECT ? AS id, ? AS body").join(" UNION ALL ")}))`, ...values).toArray();
    if (generation !== this.cache.generation || epoch !== state.epoch
      || this.cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY) !== previous) { this.disable(); return; }
    const union = new MembershipUnion(view);
    for (const row of rows) {
      const selected = members(row);
      if (selected === undefined || !union.add(id, selected)) { this.disable(); return; }
    }
    if (!this.cache.set(TREATMENT_MEMBERSHIP_VIEW_KEY, encoded(view))) this.disable();
  }
  private context(serialized: string): ReadContext {
    return { generation: this.cache.generation, epoch: safety(this.cache).epoch, serialized };
  }
  private unchanged(context: ReadContext): boolean {
    return context.generation === this.cache.generation && context.epoch === safety(this.cache).epoch
      && this.cache.get(TREATMENT_MEMBERSHIP_VIEW_KEY) === context.serialized
      && !TreatmentMembershipReadView.isUnsafe(this.cache);
  }
  private disable(): void {
    safety(this.cache).unsafe = true;
    this.cache.set(TREATMENT_MEMBERSHIP_VIEW_KEY, REJECTED);
  }
  private reject(context: ReadContext): void {
    if (this.unchanged(context)) this.cache.set(TREATMENT_MEMBERSHIP_VIEW_KEY, REJECTED);
  }
  private build(serialized: string, view: MembershipView, category: string): string | undefined {
    const context = this.context(serialized), union = new MembershipUnion(view);
    let cursor: Iterator<MembershipRow> | undefined;
    let done = false, throwing = false, processed = 0;
    let after = view.after;
    let longArrayItems = 0;
    const onLargeArray = (items: number): void => { longArrayItems += items; };
    try {
      cursor = this.sql.exec<MembershipRow>(`SELECT ${COLUMNS} FROM (SELECT ${INNER_COLUMNS}
        FROM documents WHERE collection='treatments'${after === null ? "" : " AND id > ?"}
        ORDER BY id ASC LIMIT ${SOURCE_BATCH_ROWS + 1})`, ...(after === null ? [] : [after]))[Symbol.iterator]();
      while (true) {
        // Only newly admitted long arrays use this work budget. Stop before
        // another source row, retaining the exact processed prefix as partial.
        if (longArrayItems >= MAX_LONG_ARRAY_ITEMS_PER_BATCH) break;
        const next = cursor.next();
        if (next.done) { done = true; break; }
        if (!this.unchanged(context)) return undefined;
        // A lookahead proves another source row exists. Limited cursor EOF
        // alone cannot prove the whole collection is complete.
        if (processed === SOURCE_BATCH_ROWS) break;
        const row = next.value, selected = members(row, onLargeArray);
        if (selected === undefined) { this.reject(context); return undefined; }
        if (!union.add(row.id, selected)) {
          // Retain the requested category's entire prefix and mutation overlay.
          // Omitted categories become explicitly unknown, never false empty.
          if (!union.focus(category) || !union.add(row.id, selected)) { this.reject(context); return undefined; }
        }
        after = row.id; processed++;
        if (view.categories.get(category) === null) break;
      }
    } catch (error) { throwing = true; throw error; }
    finally {
      if (!done && cursor !== undefined) {
        try { cursor.return?.(); } catch (error) { if (!throwing) throw error; }
      }
    }
    if (!this.unchanged(context)) return undefined;
    if (!union.progress(done ? "complete" : "partial", after)
      && (!union.focus(category) || !union.progress(done ? "complete" : "partial", after))) {
      this.reject(context); return undefined;
    }
    let result = encoded(view);
    if (!this.cache.set(TREATMENT_MEMBERSHIP_VIEW_KEY, result)) {
      // A shared-pool refusal is atomic. The original prefix still exists, so
      // retry a smaller explicitly scoped proof before abandoning this load.
      if (!union.focus(category)) { this.reject(context); return undefined; }
      result = encoded(view);
      if (!this.cache.set(TREATMENT_MEMBERSHIP_VIEW_KEY, result)) { this.reject(context); return undefined; }
    }
    return result;
  }
}
