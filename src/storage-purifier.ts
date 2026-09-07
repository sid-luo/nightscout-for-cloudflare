import sanitizeHtml from "sanitize-html";
import { decodeHTML } from "entities/decode";

// Port of Nightscout v15.0.8 lib/server/purifier.js (AGPL-3.0-only).
// Keep the upstream parser options and per-document budgets. This adapter
// returns a copy so sanitization cannot mutate a cached or caller-owned value.
const MAX_HTML_LENGTH = 64 * 1024;
const POSSIBLE_HTML = /<[!/?A-Za-z]/;
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
  allowedAttributes: sanitizeHtml.defaults.allowedAttributes,
  allowedSchemes: sanitizeHtml.defaults.allowedSchemes,
  allowedSchemesByTag: sanitizeHtml.defaults.allowedSchemesByTag,
  disallowedTagsMode: "discard",
};

function cleanString(value: string, budget: { remaining: number }): string {
  if (!POSSIBLE_HTML.test(value)) return value;
  if (value.length > budget.remaining) {
    throw new RangeError("HTML-containing text field exceeds the sanitization limit");
  }
  budget.remaining -= value.length;
  const clean = sanitizeHtml(value, OPTIONS);
  // Preserve profile identifiers and references if parsing did not change
  // their meaning. Output encoding is independently required at DOM sinks.
  return decodeHTML(clean) === decodeHTML(value) ? value : clean;
}

export function sanitizeStoredString(value: string): string {
  return cleanString(value, { remaining: MAX_HTML_LENGTH });
}

function* ownKeys(node: object): Generator<string> {
  for (const key in node) {
    if (Object.prototype.hasOwnProperty.call(node, key)) yield key;
  }
}

export function sanitizeStoredDocument<T extends object>(input: T): T {
  const copy = structuredClone(input);
  const seen = new WeakSet<object>();
  const stack: Array<{ node: Record<string, unknown>; keys: Generator<string> }> = [];
  const budget = { remaining: MAX_HTML_LENGTH };
  let objects = 0;
  let properties = 0;
  function enter(node: object): void {
    if (seen.has(node) || node instanceof Date || ArrayBuffer.isView(node)) return;
    seen.add(node);
    if (++objects > 10 * 1024 || stack.length >= 1024) {
      throw new RangeError("Object exceeds the sanitization complexity limit");
    }
    stack.push({ node: node as Record<string, unknown>, keys: ownKeys(node) });
  }
  enter(copy);
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const next = frame.keys.next();
    if (next.done) {
      stack.pop();
      continue;
    }
    if (++properties > 50 * 1024) {
      throw new RangeError("Object exceeds the sanitization complexity limit");
    }
    const value = frame.node[next.value];
    if (typeof value === "string") frame.node[next.value] = cleanString(value, budget);
    else if (typeof value === "object" && value !== null) enter(value);
  }
  return copy;
}


/** Legacy profile storage uses startDate as its ordering boundary in 15.0.8. */
export function validateLegacyProfileStartDate(document: Record<string, unknown>): void {
  const value = document.startDate;
  if (value === undefined || value === null || typeof value === "string"
    || (typeof value === "number" && Number.isFinite(value))
    || (value instanceof Date && Number.isFinite(value.getTime()))) return;
  throw new RangeError("Profile startDate must be a string, finite number, valid date, or null");
}
