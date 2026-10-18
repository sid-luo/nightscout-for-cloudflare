import { filterDocuments } from "./documents";
import type { JsonDocument } from "./entry-store";

const MAX_CANDIDATES = 5000;
const FIND_PARAMETER = /^find\[([A-Za-z0-9_.-]+)\](?:\[(\$gt|\$gte|\$lt|\$lte|\$ne|\$exists|\$in)\])?$/;
const SORT_PARAMETER = /^sort\[([A-Za-z0-9_.-]+)\]$/;

interface ProjectionPath {
  terminal: boolean;
  children: Map<string, ProjectionPath>;
}
const projectionPaths = new WeakMap<readonly string[], ProjectionPath>();

function pathsFor(fields: readonly string[]): ProjectionPath {
  const cached = Object.isFrozen(fields) ? projectionPaths.get(fields) : undefined;
  if (cached !== undefined) return cached;
  const root: ProjectionPath = { terminal: false, children: new Map() };
  for (const field of fields) {
    let node = root;
    for (const segment of field.split(".")) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { terminal: false, children: new Map() };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.terminal = true;
  }
  // Internal callers freeze their field sets. Do not reuse a compiled trie for
  // an externally supplied mutable array that may change between calls.
  if (Object.isFrozen(fields)) projectionPaths.set(fields, root);
  return root;
}

function referencedValue(value: unknown, path: ProjectionPath): unknown {
  // A compared object/array is a complete leaf: comparable() stringifies it,
  // including its key order. A referenced parent also subsumes its children.
  if (path.terminal) return value;
  // properties() traverses every array member without consuming a segment.
  if (Array.isArray(value)) return value.map(item => referencedValue(item, path));
  if (typeof value !== "object" || value === null) return value;
  const object = value as Record<string, unknown>;
  // Missing parents stay missing, present empty parents stay {}, and ordinary
  // Object inheritance is unchanged. Own __proto__ remains a data property.
  return Object.fromEntries([...path.children].filter(([key]) => Object.hasOwn(object, key))
    .map(([key, child]) => [key, referencedValue(object[key], child)]));
}

/** Keep each complete referenced leaf and the original path/array structure. */
export function projectLegacyDeviceStatusCandidate<Row extends { body: string }>(
  row: Row,
  fields: readonly string[],
): Row {
  let document: unknown;
  try { document = JSON.parse(row.body); }
  catch { return row; }
  if (typeof document !== "object" || document === null || Array.isArray(document)) return row;
  // JSON.parse can produce Infinity from a legal numeric exponent. Reencoding
  // that, or -0, changes the original representation; use its untouched body.
  const work: unknown[] = [document];
  while (work.length > 0) {
    const value = work.pop();
    if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) return row;
    if (typeof value === "object" && value !== null) {
      for (const child of Object.values(value)) work.push(child);
    }
  }
  const projected = referencedValue(document, pathsFor(fields));
  return { ...row, body: JSON.stringify(projected) };
}

/** Preserves the legacy JavaScript query over the original SQL candidate window. */
export class LegacyDeviceStatusQuery {
  readonly count: number;
  readonly isSimple: boolean;
  readonly requiresFullWindow: boolean;
  readonly projectionFields: readonly string[];
  private readonly url: URL;

  constructor(search: string) {
    this.url = new URL("https://legacy-query.invalid/api/v1/devicestatus.json");
    this.url.search = search;
    filterDocuments([], this.url, 10);
    this.count = Number(this.url.searchParams.get("count") ?? "10");
    this.isSimple = ![...this.url.searchParams.keys()].some(key => key.startsWith("find[") || key.startsWith("sort["));
    const paths = new Set<string>();
    let selectedSort: string | undefined;
    for (const [key, value] of this.url.searchParams) {
      const find = FIND_PARAMETER.exec(key);
      if (find !== null) paths.add(find[1]!);
      const sort = SORT_PARAMETER.exec(key);
      if (sort !== null && (value === "1" || value === "-1")) selectedSort = sort[1]!;
    }
    this.requiresFullWindow = selectedSort !== undefined;
    if (selectedSort !== undefined) paths.add(selectedSort);
    this.projectionFields = Object.freeze([...paths].sort());
  }

  projectCandidate<Row extends { body: string }>(row: Row): Row {
    return projectLegacyDeviceStatusCandidate(row, this.projectionFields);
  }

  /** Select canonical rows without relying on the public JSON document's _id. */
  selectCandidateRows<Row extends { body: string }>(rows: Iterable<Row>): Row[] {
    const paths = pathsFor(this.projectionFields);
    if (!this.requiresFullWindow) {
      const selected: Row[] = [];
      let current: Row | undefined;
      function* documents(): IterableIterator<JsonDocument> {
        for (const row of rows) {
          current = row;
          const original = JSON.parse(row.body) as JsonDocument;
          yield typeof original === "object" && original !== null && !Array.isArray(original)
            ? referencedValue(original, paths) as JsonDocument : original;
        }
      }
      // Keep the original read() generator/IteratorClose boundary, including
      // its error precedence. Only matches retain full rows; a long cold miss
      // must not accumulate thousands of unrelated original prediction bodies.
      const iterator = documents()[Symbol.iterator]();
      let ended = false;
      try {
        for (let visited = 0; visited < MAX_CANDIDATES; visited++) {
          const next = iterator.next();
          if (next.done) { ended = true; break; }
          if (filterDocuments([next.value], this.url, 10).length > 0) {
            selected.push(current!);
            if (selected.length >= this.count) break;
          }
        }
      } finally { if (!ended) iterator.return?.(); }
      return selected;
    }
    const references = new Map<unknown, { rows: Row[]; used: number }>();
    function* documents(): IterableIterator<JsonDocument> {
      for (const row of rows) {
        const original = JSON.parse(row.body) as JsonDocument;
        // The cold cursor still supplies original bodies for the eventual
        // response. Sorting only needs referenced paths: do not keep thousands
        // of unrelated parsed prediction arrays alive. No JSON reencoding here
        // means even Infinity and -0 remain their original JavaScript values.
        const document = typeof original === "object" && original !== null && !Array.isArray(original)
          ? referencedValue(original, paths) as JsonDocument : original;
        const queue = references.get(document);
        if (queue === undefined) references.set(document, { rows: [row], used: 0 });
        else queue.rows.push(row);
        yield document;
      }
    }
    return this.read(documents()).map(document => {
      // Separate parsed objects have separate identity. Non-object legacy
      // bodies use an input-order queue, preserving their stable equal sorts.
      const queue = references.get(document)!;
      return queue.rows[queue.used++]!;
    });
  }

  read(documents: Iterable<JsonDocument>): JsonDocument[] {
    const selected: JsonDocument[] = [];
    const iterator = documents[Symbol.iterator]();
    let ended = false;
    try {
      for (let visited = 0; visited < MAX_CANDIDATES; visited++) {
        const next = iterator.next();
        if (next.done) { ended = true; break; }
        if (this.requiresFullWindow) selected.push(next.value);
        else if (filterDocuments([next.value], this.url, 10).length > 0) {
          selected.push(next.value);
          if (selected.length >= this.count) break;
        }
      }
    } finally {
      if (!ended) iterator.return?.();
    }
    return this.requiresFullWindow ? filterDocuments(selected, this.url, 10) : selected;
  }
}
