import accepts from "accepts";
import csvStringifySync from "csv-stringify/lib/sync.js";
import EasyXml from "easyxml";
import { API3_MESSAGES, Api3InputError } from "./input";

export type Api3Format = "json" | "csv" | "xml";

/**
 * The locked server-wide CORS middleware advertises GET/PUT/POST/DELETE/OPTIONS.
 * Keep those methods and add the API3 PATCH plus implicit Express HEAD methods,
 * together with the conditional headers used by the generic API3 routes.
 */
export function nightscoutCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": [
      "Content-Type",
      "Authorization",
      "Content-Length",
      "X-Requested-With",
      "api-secret",
      "Last-Modified",
      "If-Modified-Since",
      "If-Unmodified-Since",
    ].join(", "),
  };
}

export class Api3RenderError extends Error {
  readonly responseHeaders: Headers;

  constructor(cause: unknown, responseHeaders: Headers) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "Api3RenderError";
    this.responseHeaders = new Headers(responseHeaders);
  }
}

// Express' locked res.format() order is JSON, CSV, then XML.
const NEGOTIABLE_FORMATS = ["json", "csv", "xml"] as const;

function negotiateFormat(accept: string | null): Api3Format | null {
  // This is the exact package and offered-format order used by the locked
  // Nightscout Express response helper. Keep it instead of a local parser.
  const request = accept === null
    ? { headers: {} }
    : { headers: { accept } };
  const selected = accepts(request).types([...NEGOTIABLE_FORMATS]);
  return selected === false ? null : selected;
}

function varyOnAccept(headers: Headers): void {
  const existing = headers.get("Vary");
  if (existing === null || existing.trim() === "") {
    headers.set("Vary", "Accept");
    return;
  }
  if (!existing.split(",").some((value) => value.trim().toLowerCase() === "accept")) {
    headers.set("Vary", `${existing}, Accept`);
  }
}

function responseHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(nightscoutCorsHeaders())) {
    headers.set(name, value);
  }
  return headers;
}

export function api3Json(data: unknown, status = 200, initHeaders?: HeadersInit): Response {
  const headers = responseHeaders(initHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

export function api3Status(
  status: number,
  message?: string,
  description?: string,
  initHeaders?: HeadersInit,
): Response {
  const body: Record<string, unknown> = { status };
  if (message !== undefined) body.message = message;
  if (description !== undefined) body.description = description;
  const headers = responseHeaders(initHeaders);
  if (status === 406) varyOnAccept(headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function api3Result(result: unknown, initHeaders?: HeadersInit): Response {
  return api3Json({ status: 200, result }, 200, initHeaders);
}

// Port of v15.0.8 shared/renderer.js: keys are data, never XML syntax.
function normalizeXmlElementNames(value: unknown): unknown {
  if (value === null || typeof value !== "object" || value instanceof Date
    || ArrayBuffer.isView(value) || typeof (value as { toJSON?: unknown }).toJSON === "function") return value;
  const source = value as Record<string, unknown>;
  const safe = /^[A-Za-z_][A-Za-z0-9._-]*$/;
  const keys = Object.keys(source);
  const result: Record<string, unknown> = Array.isArray(value) ? [] as unknown as Record<string, unknown> : Object.create(null);
  const reserved = new Set(keys.filter(key => safe.test(key)));
  const used = new Set<string>();
  for (const key of keys) {
    const arrayIndex = Array.isArray(value) && /^(0|[1-9][0-9]*)$/.test(key);
    let name = key;
    if (!arrayIndex && !safe.test(key)) {
      const encoded = `_encoded_${Buffer.from(key, "utf8").toString("base64url")}`;
      name = encoded;
      let suffix = 2;
      while (reserved.has(name) || used.has(name)) name = `${encoded}_${suffix++}`;
    }
    used.add(name);
    result[name] = normalizeXmlElementNames(source[key]);
  }
  return result;
}

export function renderApi3(format: Api3Format, data: unknown, initHeaders?: HeadersInit): Response {
  const headers = new Headers(initHeaders);
  varyOnAccept(headers);
  if (format === "json") return api3Result(data, headers);

  const renderedHeaders = responseHeaders(headers);
  if (format === "csv") {
    renderedHeaders.set("Content-Type", "text/csv; charset=utf-8");
    const source = Array.isArray(data) ? data : [data];
    try {
      return new Response(csvStringifySync(source, { header: true }), {
        status: 200,
        headers: renderedHeaders,
      });
    } catch (error) {
      throw new Api3RenderError(error, renderedHeaders);
    }
  }

  renderedHeaders.set("Content-Type", "application/xml; charset=utf-8");
  const serializer = new EasyXml({
    rootElement: "item",
    dateFormat: "ISO",
    manifest: true,
    attributePrefix: false,
  });
  try {
    return new Response(serializer.render(normalizeXmlElementNames(data)), { status: 200, headers: renderedHeaders });
  } catch (error) {
    throw new Api3RenderError(error, renderedHeaders);
  }
}

export function api3FormatFromRequest(request: Request, extensionMimeType?: string): Api3Format {
  if (extensionMimeType !== undefined) {
    const normalized = extensionMimeType.toLowerCase();
    if (normalized === "json" || normalized === "application/json") return "json";
    if (normalized === "csv" || normalized === "text/csv") return "csv";
    if (normalized === "xml" || normalized === "application/xml") return "xml";
    throw new Api3InputError(406, API3_MESSAGES.unsupportedFormat, true);
  }

  const negotiated = negotiateFormat(request.headers.get("Accept"));
  if (negotiated !== null) return negotiated;
  throw new Api3InputError(406, API3_MESSAGES.unsupportedFormat, true);
}
