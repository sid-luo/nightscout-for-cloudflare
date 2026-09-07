import type { EntryStore, JsonDocument } from "../entry-store";
import type {
  Api3CollectionName,
  Api3MutationDecision,
  Api3MutationOptions,
  DocumentMutationResult,
  DocumentQuery,
} from "../document-repository";
import { permissionGroupsAllow } from "../permissions";
import {
  API3_MESSAGES,
  Api3InputError,
  ifUnmodifiedSince,
  normalizeApi3Date,
  parseApi3Document,
  parseApi3Fields,
  parseApi3History,
  parseApi3Search,
  resolveApi3Identifier,
} from "./input";
import {
  api3FormatFromRequest,
  api3Json,
  Api3RenderError,
  api3Result,
  api3Status,
  renderApi3,
} from "./response";

const MAX_BODY_BYTES = 512 * 1_024;
const STORAGE_ERROR = "Database error";

export interface Api3Authorization {
  sub: string;
  permissionGroups: string[][];
}

export type Api3CollectionRoute =
  | { kind: "collection"; extension?: string }
  | { kind: "resource"; identifier: string; extension?: string }
  | { kind: "history"; lastModified?: string; extension?: string };

export type Api3TreatmentRoute = Api3CollectionRoute;

export function splitApi3Extension(pathname: string): { pathname: string; extension?: string } {
  const slash = pathname.lastIndexOf("/");
  const segment = pathname.slice(slash + 1);
  const dot = segment.indexOf(".");
  if (dot < 0) return { pathname };
  const extension = segment.slice(dot + 1);
  return {
    pathname: `${pathname.slice(0, slash + 1)}${segment.slice(0, dot)}`,
    ...(extension.length === 0 ? {} : { extension }),
  };
}

function decodedPathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function matchApi3CollectionRoute(
  method: string,
  pathname: string,
  collection: Api3CollectionName,
): Api3CollectionRoute | null {
  const reads = method === "GET" || method === "HEAD";
  const trailingTrimmed = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  const split = splitApi3Extension(trailingTrimmed);
  if (
    split.pathname === `/api/v3/${collection}`
    && (reads || method === "POST")
  ) {
    return { kind: "collection", ...(split.extension === undefined ? {} : { extension: split.extension }) };
  }

  if (reads) {
    const history = new RegExp(`^/api/v3/${collection}/history(?:/([^/]+))?$`).exec(
      split.pathname,
    );
    if (history !== null) {
      const lastModified = history[1] === undefined ? undefined : decodedPathSegment(history[1]);
      if (lastModified === null) return null;
      return {
        kind: "history",
        ...(lastModified === undefined ? {} : { lastModified }),
        ...(split.extension === undefined ? {} : { extension: split.extension }),
      };
    }
  }

  if (!["GET", "HEAD", "PUT", "PATCH", "DELETE"].includes(method)) return null;
  const resource = new RegExp(`^/api/v3/${collection}/([^/]+)$`).exec(split.pathname);
  if (resource === null) return null;
  const identifier = decodedPathSegment(resource[1]!);
  if (identifier === null) return null;
  return {
    kind: "resource",
    identifier,
    ...(split.extension === undefined ? {} : { extension: split.extension }),
  };
}

export function matchApi3TreatmentRoute(
  method: string,
  pathname: string,
): Api3TreatmentRoute | null {
  return matchApi3CollectionRoute(method, pathname, "treatments");
}

export function matchApi3DeviceStatusRoute(
  method: string,
  pathname: string,
): Api3CollectionRoute | null {
  return matchApi3CollectionRoute(method, pathname, "devicestatus");
}

export function matchApi3EntriesRoute(
  method: string,
  pathname: string,
): Api3CollectionRoute | null {
  return matchApi3CollectionRoute(method, pathname, "entries");
}

export function matchApi3ProfileRoute(
  method: string,
  pathname: string,
): Api3CollectionRoute | null {
  return matchApi3CollectionRoute(method, pathname, "profile");
}

export function matchApi3FoodRoute(
  method: string,
  pathname: string,
): Api3CollectionRoute | null {
  return matchApi3CollectionRoute(method, pathname, "food");
}

export function matchApi3SettingsRoute(
  method: string,
  pathname: string,
): Api3CollectionRoute | null {
  return matchApi3CollectionRoute(method, pathname, "settings");
}

function allowed(
  authorization: Api3Authorization,
  collection: Api3CollectionName,
  action: string,
): boolean {
  return permissionGroupsAllow(
    authorization.permissionGroups,
    `api:${collection}:${action}`,
  );
}

function forbidden(collection: Api3CollectionName, action: string): Response {
  return api3Status(403, `Missing permission api:${collection}:${action}`);
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentType = request.headers.get("Content-Type")?.toLowerCase();
  if (contentType === undefined || (!contentType.includes("application/json") && !contentType.includes("+json"))) {
    throw new Api3InputError(400, API3_MESSAGES.badBody);
  }
  if (request.body === null) throw new Api3InputError(400, API3_MESSAGES.badBody);
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new Api3InputError(413, "Request body exceeds the Workers adapter limit", true);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Api3InputError(413, "Request body exceeds the Workers adapter limit", true);
    }
    chunks.push(part.value);
  }
  if (total === 0) throw new Api3InputError(400, API3_MESSAGES.badBody);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    // The locked body-parser error middleware uses API3's 500 envelope.
    throw new Api3InputError(500, "Internal Server Error");
  }
}

/** Mirrors the global JSON parser's position before extension and route handling. */
export async function api3BodyParserFailure(request: {
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}): Promise<Response | null> {
  const contentType = request.headers.get("Content-Type")?.toLowerCase();
  if (contentType === undefined || (!contentType.includes("application/json") && !contentType.includes("+json"))) {
    return null;
  }
  if (request.body === null) return null;
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    return api3Status(413, "Request body exceeds the Workers adapter limit");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return api3Status(413, "Request body exceeds the Workers adapter limit");
    }
    chunks.push(part.value);
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    JSON.parse(new TextDecoder().decode(bytes));
    return null;
  } catch {
    return api3Status(500, "Internal Server Error");
  }
}

function parseDecision(value: string): Api3MutationDecision {
  return JSON.parse(value) as Api3MutationDecision;
}

function mutationOptions(
  authorization: Api3Authorization,
  request: Request,
  collection: Api3CollectionName,
): Api3MutationOptions {
  return {
    canCreate: allowed(authorization, collection, "create"),
    canUpdate: allowed(authorization, collection, "update"),
    actor: authorization.sub || null,
    ifUnmodifiedSince: ifUnmodifiedSince(request),
    validate: true,
    emitRealtime: true,
  };
}

function mutationFailure(
  collection: Api3CollectionName,
  decision: Extract<Api3MutationDecision, { ok: false }>,
): Response {
  switch (decision.reason) {
    case "operation-error":
      return operationError(new Error(decision.message)) ?? api3Status(500, STORAGE_ERROR);
    case "missing-create-permission":
      return forbidden(collection, "create");
    case "missing-update-permission":
      return forbidden(collection, "update");
    case "not-found":
      return api3Status(404);
    case "gone":
      return api3Status(410);
    case "precondition-failed":
      return api3Status(412);
  }
}

function lastModifiedHeaders(modified: number | null): Headers {
  const headers = new Headers();
  if (modified !== null) headers.set("Last-Modified", new Date(modified).toUTCString());
  return headers;
}

function mutationIdentifier(
  collection: Api3CollectionName,
  mutation: DocumentMutationResult,
): string {
  const identifier = mutation.document.identifier;
  if (typeof identifier !== "string" || identifier.length === 0) {
    throw new Error(`API3 ${collection} mutation returned no identifier`);
  }
  return identifier;
}

function project(document: JsonDocument, fields: string[] | undefined): JsonDocument {
  if (fields === undefined) return document;
  const projected: JsonDocument = {};
  for (const field of fields) {
    const value = document[field];
    if (value !== undefined) projected[field] = value;
  }
  return projected;
}

function documentModified(document: JsonDocument): number | null {
  const value = document.srvModified;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
}

function conditionallyNotModified(request: Request, modified: number | null): boolean {
  if (modified === null) return false;
  const value = request.headers.get("If-Modified-Since");
  if (value === null) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    && Math.floor(modified / 1_000) * 1_000 <= Math.floor(parsed / 1_000) * 1_000;
}

function permanentDeleteRequested(url: URL): boolean {
  const values = url.searchParams.getAll("permanent");
  return values.length === 1 && values[0] === "true";
}

function operationError(error: unknown): Response | null {
  if (error instanceof Api3InputError) return api3Status(error.status, error.message);
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Trying to modify read-only document") return api3Status(422, message);
  const validationMessages: readonly string[] = [
    API3_MESSAGES.badDate,
    API3_MESSAGES.badUtcOffset,
    API3_MESSAGES.badApp,
    API3_MESSAGES.badIdentifier,
  ];
  if (validationMessages.includes(message)) {
    return api3Status(400, message);
  }
  if (message.startsWith("Field ") && message.endsWith(" cannot be modified by the client")) {
    return api3Status(400, message);
  }
  if (
    message.startsWith("invalid query field")
    || message.startsWith("invalid document sort")
    || message.startsWith("document query skip")
    || message.startsWith("document query exceeds SQLite")
    || message.startsWith("LIKE pattern exceeds SQLite")
  ) {
    return api3Status(400, message);
  }
  return null;
}

async function createTreatment(
  request: Request,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  collection: Api3CollectionName,
): Promise<Response> {
  const document = parseApi3Document(await readJsonBody(request));
  normalizeApi3Date(document);
  await resolveApi3Identifier(document);
  const decision = parseDecision(await store.api3CreateDocument(
    collection,
    JSON.stringify(document),
    JSON.stringify(mutationOptions(authorization, request, collection)),
  ));
  if (!decision.ok) return mutationFailure(collection, decision);

  const identifier = mutationIdentifier(collection, decision.mutation);
  const modified = decision.mutation.srvModified;
  const headers = lastModifiedHeaders(modified);
  headers.set("Location", `/api/v3/${collection}/${identifier}`);
  if (decision.mutation.created) {
    return api3Json({ status: 201, identifier, lastModified: modified }, 201, headers);
  }
  const body: Record<string, unknown> = {
    status: 200,
    identifier,
    lastModified: modified,
    isDeduplication: true,
  };
  if (decision.mutation.deduplicatedIdentifier !== undefined) {
    body.deduplicatedIdentifier = decision.mutation.deduplicatedIdentifier;
  }
  return api3Json(body, 200, headers);
}

async function replaceTreatment(
  request: Request,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  identifier: string,
  collection: Api3CollectionName,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (body && typeof body === "object" && Object.keys(body).length > 0
    && !allowed(authorization, collection, "create") && !allowed(authorization, collection, "update")) {
    return forbidden(collection, "update");
  }
  const document = parseApi3Document(body);
  normalizeApi3Date(document);
  await resolveApi3Identifier(document);
  document.identifier = identifier;
  const decision = parseDecision(await store.api3ReplaceDocument(
    collection,
    identifier,
    JSON.stringify(document),
    JSON.stringify(mutationOptions(authorization, request, collection)),
  ));
  if (!decision.ok) return mutationFailure(collection, decision);

  const modified = decision.mutation.srvModified;
  const headers = lastModifiedHeaders(modified);
  if (decision.mutation.created) {
    const actualIdentifier = mutationIdentifier(collection, decision.mutation);
    // insert() joins req.path and identifier even for PUT in the locked handler.
    headers.set("Location", `/api/v3/${collection}/${identifier}/${actualIdentifier}`);
    return api3Json(
      { status: 201, identifier: actualIdentifier, lastModified: modified },
      201,
      headers,
    );
  }
  return api3Json({ status: 200, lastModified: modified }, 200, headers);
}

async function patchTreatment(
  request: Request,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  identifier: string,
  collection: Api3CollectionName,
): Promise<Response> {
  const patch = parseApi3Document(await readJsonBody(request));
  const decision = parseDecision(await store.api3PatchDocument(
    collection,
    identifier,
    JSON.stringify(patch),
    JSON.stringify(mutationOptions(authorization, request, collection)),
  ));
  if (!decision.ok) return mutationFailure(collection, decision);
  return api3Json(
    { status: 200 },
    200,
    lastModifiedHeaders(decision.mutation.srvModified),
  );
}

async function deleteTreatment(
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  identifier: string,
  permanent: boolean,
  collection: Api3CollectionName,
): Promise<Response> {
  if (!allowed(authorization, collection, "delete")) return forbidden(collection, "delete");
  const result = await store.api3DeleteDocument(
    collection,
    identifier,
    permanent,
    authorization.sub || null,
  );
  if (result.error !== undefined) {
    return operationError(new Error(result.error)) ?? api3Status(500, STORAGE_ERROR);
  }
  if (result.tooLarge === true) {
    return api3Status(
      413,
      "Permanent delete has more than 128 stored revisions; compact history first",
    );
  }
  return result.deleted ? api3Status(200) : api3Status(404);
}

async function readTreatment(
  request: Request,
  url: URL,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  route: Extract<Api3TreatmentRoute, { kind: "resource" }>,
  collection: Api3CollectionName,
): Promise<Response> {
  if (!allowed(authorization, collection, "read")) return forbidden(collection, "read");
  const fields = parseApi3Fields(url);
  const value = await store.findApi3Document(
    collection,
    route.identifier,
    JSON.stringify(fields ?? null),
  );
  if (value === null) return api3Status(404);
  const document = JSON.parse(value) as JsonDocument;
  if (document.isValid === false) return api3Status(410);
  const modified = documentModified(document);
  const headers = lastModifiedHeaders(modified);
  if (conditionallyNotModified(request, modified)) {
    return new Response(null, { status: 304, headers });
  }
  const format = api3FormatFromRequest(request, route.extension);
  return renderApi3(format, project(document, fields), headers);
}

async function searchTreatments(
  request: Request,
  url: URL,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  extension: string | undefined,
  collection: Api3CollectionName,
  maxLimit: number,
): Promise<Response> {
  const action = collection === "settings" ? "admin" : "read";
  if (!allowed(authorization, collection, action)) return forbidden(collection, action);
  const input = parseApi3Search(url, maxLimit);
  const query: DocumentQuery = {
    filters: input.filters,
    sort: input.sort,
    limit: input.limit,
    skip: input.skip,
    includeDeleted: false,
  };
  if (input.fields !== undefined) query.fields = input.fields;
  const decision = JSON.parse(await store.api3QueryCollection(
    collection,
    JSON.stringify(query),
  )) as
    | { ok: true; result: JsonDocument[] }
    | { ok: false; message: string; status?: number };
  if (!decision.ok) {
    return decision.status === 400 || decision.status === 413
      ? api3Status(decision.status, decision.message)
      : api3Status(500, STORAGE_ERROR);
  }
  const result = decision.result;
  return renderApi3(api3FormatFromRequest(request, extension), result);
}

async function historyTreatments(
  request: Request,
  url: URL,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  route: Extract<Api3TreatmentRoute, { kind: "history" }>,
  collection: Api3CollectionName,
  maxLimit: number,
): Promise<Response> {
  const action = collection === "settings" ? "admin" : "read";
  if (!allowed(authorization, collection, action)) return forbidden(collection, action);
  const input = parseApi3History(
    url,
    route.lastModified,
    request.headers.get("Last-Modified"),
    maxLimit,
  );
  const requestedFields = input.fields;
  const storageInput = { ...input };
  if (requestedFields !== undefined) {
    storageInput.fields = Array.from(new Set([
      ...requestedFields,
      "identifier",
      "srvCreated",
      "created_at",
      "date",
    ]));
  }
  const result = JSON.parse(
    await store.api3CollectionHistory(collection, JSON.stringify(storageInput)),
  ) as JsonDocument[];
  const headers = new Headers();
  if (result.length > 0) {
    const maximum = Math.max(...result.map((document) => {
      const modified = documentModified(document);
      if (modified !== null) return modified;
      const createdAt = document.created_at;
      const parsed = typeof createdAt === "number"
        ? createdAt
        : typeof createdAt === "string"
          ? Date.parse(createdAt)
          : Number.NaN;
      return Number.isFinite(parsed) ? Math.trunc(parsed) : Number.NaN;
    }));
    if (Number.isFinite(maximum)) {
      headers.set("Last-Modified", new Date(maximum).toUTCString());
      headers.set("ETag", `W/"${maximum}"`);
    }
  }
  const rendered = requestedFields === undefined
    ? result
    : result.map((document) => project(document, requestedFields));
  return renderApi3(api3FormatFromRequest(request, route.extension), rendered, headers);
}

async function handleApi3Collection(
  request: Request,
  url: URL,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  route: Api3CollectionRoute,
  collection: Api3CollectionName,
  maxLimit: number,
): Promise<Response> {
  try {
    if (route.kind === "collection") {
      if (request.method === "GET" || request.method === "HEAD") {
        return await searchTreatments(
          request,
          url,
          store,
          authorization,
          route.extension,
          collection,
          maxLimit,
        );
      }
      if (request.method === "POST") {
        return await createTreatment(request, store, authorization, collection);
      }
      return api3Status(404, "Bad operation or collection");
    }
    if (route.kind === "history") {
      return request.method === "GET" || request.method === "HEAD"
        ? await historyTreatments(
          request,
          url,
          store,
          authorization,
          route,
          collection,
          maxLimit,
        )
        : api3Status(404, "Bad operation or collection");
    }
    if (request.method === "GET" || request.method === "HEAD") {
      return await readTreatment(request, url, store, authorization, route, collection);
    }
    if (request.method === "PUT") {
      return await replaceTreatment(
        request,
        store,
        authorization,
        route.identifier,
        collection,
      );
    }
    if (request.method === "PATCH") {
      return await patchTreatment(
        request,
        store,
        authorization,
        route.identifier,
        collection,
      );
    }
    if (request.method === "DELETE") {
      return await deleteTreatment(
        store,
        authorization,
        route.identifier,
        permanentDeleteRequested(url),
        collection,
      );
    }
    return api3Status(404, "Bad operation or collection");
  } catch (error) {
    if (error instanceof Api3RenderError) {
      console.error(JSON.stringify({
        message: `API3 ${collection} render failed`,
        error: error.message,
      }));
      return api3Status(500, STORAGE_ERROR, undefined, error.responseHeaders);
    }
    const response = operationError(error);
    if (response !== null) return response;
    console.error(JSON.stringify({
      message: `API3 ${collection} operation failed`,
      error: error instanceof Error ? error.message : String(error),
    }));
    return api3Status(500, STORAGE_ERROR);
  }
}

export async function handleApi3Treatments(
  request: Request,
  url: URL,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  route: Api3TreatmentRoute,
  maxLimit: number,
): Promise<Response> {
  return handleApi3Collection(request, url, store, authorization, route, "treatments", maxLimit);
}

export async function handleApi3DeviceStatus(
  request: Request,
  url: URL,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  route: Api3CollectionRoute,
  maxLimit: number,
): Promise<Response> {
  return handleApi3Collection(request, url, store, authorization, route, "devicestatus", maxLimit);
}

export async function handleApi3Entries(
  request: Request,
  url: URL,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  route: Api3CollectionRoute,
  maxLimit: number,
): Promise<Response> {
  return handleApi3Collection(request, url, store, authorization, route, "entries", maxLimit);
}

export async function handleApi3Profile(
  request: Request,
  url: URL,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  route: Api3CollectionRoute,
  maxLimit: number,
): Promise<Response> {
  return handleApi3Collection(request, url, store, authorization, route, "profile", maxLimit);
}

export async function handleApi3Food(
  request: Request,
  url: URL,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  route: Api3CollectionRoute,
  maxLimit: number,
): Promise<Response> {
  return handleApi3Collection(request, url, store, authorization, route, "food", maxLimit);
}

export async function handleApi3Settings(
  request: Request,
  url: URL,
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
  route: Api3CollectionRoute,
  maxLimit: number,
): Promise<Response> {
  return handleApi3Collection(request, url, store, authorization, route, "settings", maxLimit);
}

export async function handleApi3LastModified(
  store: DurableObjectStub<EntryStore>,
  authorization: Api3Authorization,
): Promise<Response> {
  const collections: Record<string, number> = {};
  for (const collection of [
    "devicestatus",
    "entries",
    "food",
    "profile",
    "settings",
    "treatments",
  ] as const) {
    if (!allowed(authorization, collection, "read")) continue;
    const modified = await store.api3CollectionLastModified(collection);
    if (modified !== null) collections[collection] = modified;
  }
  return api3Result({ srvDate: Date.now(), collections });
}
