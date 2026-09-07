import { EntryStore } from "./entry-store";
import { DexcomShareConnector } from "./dexcom-share-connector";
import mime from "mime";
import qs from "qs";
import type {
  DocumentCollection,
  JsonDocument,
  LegacyTreatmentCreateResult,
} from "./entry-store";
import {
  apiSecretDigestMatches,
  authorizationDefaultRoleNames,
  authorizationPermissionGroups,
  authorizationRoleNames,
  boundedTokenCandidates,
  BUILTIN_AUTHORIZATION_ROLES,
  extractRequestCredentials,
  type PresentedToken,
  type RequestCredentials,
} from "./authorization";
import { newTrie } from "shiro-trie";
import {
  filterDocuments,
  findInvalidLegacyObjectId,
  isValidLegacyObjectId,
  normalizeTreatmentNumbers,
  parseDocumentPayload,
  parseTreatmentQuery,
  parseLegacyUuidHandling,
  sanitizeLegacyTreatmentDocument,
} from "./documents";
import {
  ApiError,
  legacyEntryPreview,
  parseLegacyEntryPayload,
  parseEntryTypeFilter,
  parseHistoryCountQuery,
  parseHistoryQuery,
} from "./model";
import type { PublicEntry } from "./model";
import { permissionGroupsAllow } from "./permissions";
import {
  handleSocketIo,
  storageQuotaEngineError,
} from "./realtime/http-adapter";
import {
  durableObjectWriteQuotaRetryAfterSeconds,
  isDurableObjectWriteQuotaError,
  isDurableObjectReadQuotaError,
} from "./platform-errors";
import { normalizePlatformAuthFailDelay } from "./status";
import {
  handleApi3DeviceStatus,
  handleApi3Entries,
  handleApi3Food,
  handleApi3LastModified,
  handleApi3Profile,
  handleApi3Settings,
  handleApi3Treatments,
  matchApi3DeviceStatusRoute,
  matchApi3EntriesRoute,
  matchApi3FoodRoute,
  matchApi3ProfileRoute,
  matchApi3SettingsRoute,
  matchApi3TreatmentRoute,
  api3BodyParserFailure,
  splitApi3Extension,
  type Api3CollectionRoute,
} from "./api3/treatments";
import { nightscoutCorsHeaders as corsHeaders } from "./api3/response";
import { normalizeApi3MaxLimit } from "./api3/input";
import { buildNightscoutSummary } from "./api2/summary";
import {
  fitTreatmentsToBgCurve,
  type TreatmentCurveData,
} from "./data/treatment-to-curve";
import type { NightscoutGlucoseUnits } from "./plugins/bgnow";
import {
  calculatePluginProperties,
  loadPluginPropertyContext,
} from "./plugins/properties";
import { buildNightscoutPebbleResponse } from "./pebble";
import {
  LoopPushError,
  prepareLoopPush,
  sendPreparedLoopPush,
} from "./loop-push";
import {
  createLegacyMongoQuery,
  LegacyObjectId,
  parseLegacyRegularExpression,
  type LegacyQueryObject,
  type LegacyQueryOptions,
} from "./server-query";
import type {
  Api3CollectionName,
  DocumentFilter,
  DocumentQuery,
  DocumentSort,
} from "./document-repository";
import {
  resolveDexcomShareConfig,
  type DexcomShareEnvironment,
} from "./dexcom-share";

export { DexcomShareConnector, EntryStore };

const MAX_BODY_BYTES = 512 * 1024;
const DEFAULT_TENANT = "demo";
const TENANT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTF8_CONTENT_TYPES = [
  "text/",
  "application/javascript",
  "application/json",
  "application/xml",
  "image/svg+xml",
];
const MIN_API_SECRET_LENGTH = 12;
const MAX_AUTH_FAIL_DELAY_MS = 60_000;
const SEEN_PERMISSIONS = [
  "admin:api:permissions:read",
  "admin:api:roles:create",
  "admin:api:roles:delete",
  "admin:api:roles:list",
  "admin:api:roles:update",
  "admin:api:subjects:create",
  "admin:api:subjects:delete",
  "admin:api:subjects:read",
  "admin:api:subjects:update",
  "api:*:read",
  "api:activity:create",
  "api:activity:delete",
  "api:activity:read",
  "api:activity:update",
  "api:devicestatus:create",
  "api:devicestatus:delete",
  "api:devicestatus:read",
  "api:entries:create",
  "api:entries:delete",
  "api:entries:read",
  "api:food:create",
  "api:food:delete",
  "api:food:read",
  "api:food:update",
  "api:pebble,entries:read",
  "api:profile:create",
  "api:profile:delete",
  "api:profile:read",
  "api:profile:update",
  "api:status:read",
  "api:treatments:create",
  "api:treatments:delete",
  "api:treatments:read",
  "api:treatments:update",
  "authorization:debug:test",
  "notifications:*:ack",
  "notifications:loop:push",
] as const;

type AppEnv = Omit<Env, "API_SECRET"> & DexcomShareEnvironment & {
  DEXCOM_SHARE_CONNECTOR: DurableObjectNamespace<DexcomShareConnector>;
  API_SECRET?: string;
  API3_MAX_LIMIT?: string;
  ALLOW_UNRESTRICTED_FRAME_EMBEDDING?: string;
  AUTH_DEFAULT_ROLES?: string;
  AUTH_FAIL_DELAY?: string;
  LOOP_APNS_KEY?: string;
  LOOP_APNS_KEY_ID?: string;
  LOOP_DEVELOPER_TEAM_ID?: string;
  LOOP_PUSH_SERVER_ENVIRONMENT?: string;
  UUID_HANDLING?: string;
};

function isMissingDurableObjectRpcMethod(error: unknown, method: string): boolean {
  return error instanceof Error
    && error.message.includes("RPC receiver does not implement the method")
    && error.message.includes(`"${method}"`);
}

async function callUuidAwareRpc<T>(
  uuidHandling: boolean,
  method: string,
  current: () => Promise<T>,
  defaultCompatibleFallback: () => Promise<T>,
): Promise<T> {
  try {
    return await current();
  } catch (error) {
    if (!isMissingDurableObjectRpcMethod(error, method)) throw error;
    if (uuidHandling) return defaultCompatibleFallback();
    throw new ApiError(
      503,
      "rolling_upgrade_in_progress",
      "UUID_HANDLING=false is temporarily unavailable while a previous Durable Object isolate drains",
    );
  }
}

function json(data: unknown, init: ResponseInit = {}, space?: number): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(corsHeaders())) headers.set(name, value);
  return new Response(JSON.stringify(data, null, space), { ...init, headers });
}

function isOfficialAdminPageRequest(request: Request): boolean {
  const referer = request.headers.get("Referer");
  if (referer === null) return false;
  try {
    const requestUrl = new URL(request.url);
    const refererUrl = new URL(referer);
    return refererUrl.origin === requestUrl.origin && /^\/admin\/?$/.test(refererUrl.pathname);
  } catch {
    return false;
  }
}

/**
 * Locked v15.0.7 server collection removal exposes MongoDB 5's
 * `{ acknowledged, deletedCount }` result. Its unchanged Admin Tools client
 * still reads the legacy `n` field. Keep the public API byte shape locked for
 * normal callers and add the compatibility aliases only to same-origin
 * requests made by the official `/admin/` page.
 */
function legacyMongoDeleteResult(request: Request, deletedCount: number): Response {
  const result = { acknowledged: true, deletedCount };
  return json(isOfficialAdminPageRequest(request)
    ? { ...result, n: deletedCount, ok: 1 }
    : result);
}

function legacyOk(): Response {
  const body = new TextEncoder().encode("OK");
  const headers = new Headers(corsHeaders());
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Content-Length", String(body.byteLength));
  headers.set("Cache-Control", "no-store");
  return new Response(body, { status: 200, headers });
}

function legacyInternalError(): Response {
  const body = new TextEncoder().encode("Internal Server Error");
  const headers = new Headers(corsHeaders());
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Content-Length", String(body.byteLength));
  headers.set("Cache-Control", "no-store");
  return new Response(body, { status: 500, headers });
}

function legacyLoopNotificationError(message: string): Response {
  const body = new TextEncoder().encode(message);
  const headers = new Headers(corsHeaders());
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Length", String(body.byteLength));
  headers.set("Cache-Control", "no-store");
  return new Response(body, { status: 500, headers });
}

function legacyAlexaSpeechletResponse(
  title: string,
  output: string,
  repromptText: string,
  shouldEndSession: boolean,
): Record<string, unknown> {
  return {
    version: "1.0",
    response: {
      outputSpeech: {
        type: "PlainText",
        text: output,
      },
      card: {
        type: "Simple",
        title,
        content: output,
      },
      reprompt: {
        outputSpeech: {
          type: "PlainText",
          text: repromptText,
        },
      },
      shouldEndSession,
    },
  };
}

function legacyDocumentIdError(id: unknown, create: boolean): Response {
  return json(
    {
      status: 400,
      message: "Invalid _id format",
      description: create
        ? `Must be 24-character hex string or omit for auto-generation. Got: ${String(id)}`
        : `Must be 24-character hex string. Got: ${String(id)}`,
    },
    { status: 400 },
  );
}

function withUtf8Charset(response: Response): Response {
  const contentType = response.headers.get("Content-Type");
  if (
    contentType === null ||
    /(?:^|;)\s*charset=/i.test(contentType) ||
    !UTF8_CONTENT_TYPES.some((prefix) => contentType.toLowerCase().startsWith(prefix))
  ) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("Content-Type", `${contentType}; charset=utf-8`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function asHtml(response: Response, noStore = false): Response {
  if (!response.ok && response.status !== 304) return response;
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  if (noStore) {
    headers.set("Cache-Control", "no-store");
    headers.delete("ETag");
    headers.delete("Last-Modified");
  }
  return new Response(response.status === 304 ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function assetAt(
  request: Request,
  env: AppEnv,
  pathname: string,
  ignoreConditionalHeaders = false,
): Promise<Response> {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = pathname;
  assetUrl.search = "";
  const headers = new Headers(request.headers);
  if (ignoreConditionalHeaders) {
    headers.delete("If-Match");
    headers.delete("If-Modified-Since");
    headers.delete("If-None-Match");
    headers.delete("If-Range");
    headers.delete("If-Unmodified-Since");
  }
  return env.ASSETS.fetch(
    new Request(assetUrl, {
      method: "GET",
      headers,
    }),
  );
}

async function transformedHtml(
  response: Response,
  transform: (html: string) => string,
): Promise<Response> {
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.delete("Content-Length");
  return new Response(transform(await response.text()), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function servePlatformPage(
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response | null> {
  const staticPage = /^\/(admin|profile|food|report|split)\/?$/.exec(url.pathname);
  if (staticPage !== null) {
    const isSplit = staticPage[1] === "split";
    return asHtml(
      await assetAt(request, env, `/${staticPage[1]}/index.html`, isSplit),
      isSplit,
    );
  }

  const clock = /^\/clock\/([a-z0-9-]{1,100})\/?$/.exec(url.pathname);
  if (clock !== null && clock[1] !== "template") {
    return transformedHtml(
      await assetAt(request, env, "/clock/template.html"),
      (html) => html.replaceAll("__CLOCK_FACE__", clock[1]!),
    );
  }
  if (url.pathname === "/clock/template.html") {
    return new Response(null, { status: 404 });
  }

  if (url.pathname === "/api-docs" || url.pathname === "/api-docs/") {
    return asHtml(await assetAt(request, env, "/api-docs/index.html"));
  }
  if (url.pathname === "/api3-docs" || url.pathname === "/api3-docs/") {
    return transformedHtml(
      await assetAt(request, env, "/api-docs/index.html"),
      (html) => html.replace('url: "/swagger.json"', 'url: "/api3-swagger.json"'),
    );
  }
  const docsAsset = /^\/api3?-docs\/swagger-ui-dist\/(.+)$/.exec(url.pathname);
  if (docsAsset !== null) {
    return withUtf8Charset(
      await assetAt(request, env, `/swagger-ui-dist/${docsAsset[1]}`),
    );
  }
  return null;
}

function resolveTenantFromUrl(url: URL): string {
  const tenant = url.searchParams.get("tenant") ?? DEFAULT_TENANT;
  if (!TENANT.test(tenant)) {
    throw new ApiError(400, "invalid_tenant", "tenant must match [a-z0-9][a-z0-9_-]{0,63}");
  }
  return tenant;
}

function resolveTenant(_request: Request, url: URL): string {
  return resolveTenantFromUrl(url);
}

function safeLogPath(pathname: string): string {
  const authorizationRequest = "/api/v2/authorization/request/";
  return pathname.startsWith(authorizationRequest)
    ? `${authorizationRequest}[redacted]`
    : pathname;
}

function configuredApiSecret(env: AppEnv): string | null {
  const secret = env.API_SECRET;
  return secret !== undefined && secret.length >= MIN_API_SECRET_LENGTH ? secret : null;
}

const API_SECRET_TOO_SHORT_MESSAGE = [
  `Nightscout configuration error: API_SECRET must contain at least ${MIN_API_SECRET_LENGTH} characters.`,
  `Nightscout 配置错误：API_SECRET 至少需要 ${MIN_API_SECRET_LENGTH} 个字符。`,
  "Update API_SECRET to a longer value, then deploy again.",
  "请把 API_SECRET 改成更长的值，然后重新部署。",
].join("\n");

function apiSecretConfigurationError(
  request: Request,
  url: URL,
  code: "api_secret_too_short",
  message: string,
): Response {
  if (url.pathname.startsWith("/api/")) {
    return withoutBodyForHead(
      request,
      json({ error: { code, message } }, { status: 503 }),
    );
  }
  const body = `${message}\n`;
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  headers.set("Content-Length", String(new TextEncoder().encode(body).byteLength));
  return new Response(request.method === "HEAD" ? null : body, { status: 503, headers });
}

function validateApiSecretConfiguration(
  request: Request,
  env: AppEnv,
  url: URL,
): Response | null {
  const secret = env.API_SECRET;
  if (secret === undefined) return null;
  if (secret.length < MIN_API_SECRET_LENGTH) {
    return apiSecretConfigurationError(
      request,
      url,
      "api_secret_too_short",
      API_SECRET_TOO_SHORT_MESSAGE,
    );
  }
  return null;
}

function configuredAuthDefaultRoles(env: AppEnv): string {
  return env.AUTH_DEFAULT_ROLES ?? "readable";
}

function configuredAuthFailDelay(env: AppEnv): number {
  return normalizePlatformAuthFailDelay(env.AUTH_FAIL_DELAY);
}

function requestRemoteIp(request: Request): string {
  const cloudflareIp = request.headers.get("CF-Connecting-IP");
  if (cloudflareIp !== null && cloudflareIp.length > 0) {
    return cloudflareIp.slice(0, 256);
  }
  const forwarded = request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim();
  return forwarded !== undefined && forwarded.length > 0
    ? forwarded.slice(0, 256)
    : "unknown";
}

async function waitForAuthorizationDelay(
  store: DurableObjectStub<EntryStore>,
  ip: string,
): Promise<void> {
  const delay = await store.authorizationDelay(ip, Date.now());
  if (delay <= 0) return;
  await new Promise<void>((resolve) =>
    setTimeout(resolve, Math.min(delay, MAX_AUTH_FAIL_DELAY_MS))
  );
}

interface AuthorizedSubject {
  token: string;
  sub: string;
  permissionGroups: string[][];
  iat: number;
  exp: number;
}

interface AccessJwtClaims {
  accessToken: string;
  iat: number;
  exp: number;
}

interface PresentedCredential extends AccessJwtClaims {
  token: string | null;
}

const API3_COLLECTIONS = [
  "devicestatus",
  "entries",
  "food",
  "profile",
  "settings",
  "treatments",
] as const;

function bearerToken(request: Request, caseInsensitive = false): string | null {
  const authorization = request.headers.get("Authorization");
  if (authorization === null) return null;
  const parts = authorization.split(" ");
  const scheme = parts[0];
  const token = parts[1];
  if (
    parts.length !== 2 ||
    token === undefined ||
    token.length === 0 ||
    (caseInsensitive
      ? scheme?.toLowerCase() !== "bearer"
      : scheme !== "Bearer")
  ) {
    return null;
  }
  return token;
}

function parseDocuments(value: string): JsonDocument[] {
  return JSON.parse(value) as JsonDocument[];
}

function parseDocument(value: string): JsonDocument {
  return JSON.parse(value) as JsonDocument;
}

function parseAccessJwtClaims(value: string): AccessJwtClaims {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).accessToken !== "string" ||
    !Number.isInteger((parsed as Record<string, unknown>).iat) ||
    !Number.isInteger((parsed as Record<string, unknown>).exp)
  ) {
    throw new Error("Durable Object returned invalid JWT claims");
  }
  return parsed as AccessJwtClaims;
}

function parseAuthorizedSubject(value: string): AuthorizedSubject {
  const parsed: unknown = JSON.parse(value);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).token !== "string" ||
    typeof (parsed as Record<string, unknown>).accessToken !== "string" ||
    !Number.isInteger((parsed as Record<string, unknown>).iat) ||
    !Number.isInteger((parsed as Record<string, unknown>).exp)
  ) {
    throw new Error("Durable Object returned an invalid issued JWT");
  }
  const issued = parsed as AccessJwtClaims & { token: string };
  return {
    token: issued.token,
    sub: "",
    permissionGroups: [],
    iat: issued.iat,
    exp: issued.exp,
  };
}

async function authorizeCredential(
  store: DurableObjectStub<EntryStore>,
  accessTokens: PresentedToken,
  configuredDefaultRoles: string | undefined,
  credential: PresentedCredential | null = null,
  refreshJwt = false,
): Promise<AuthorizedSubject | null> {
  const candidates = boundedTokenCandidates(accessTokens);
  if (candidates === null) return null;
  const subjectJson = await store.resolveAuthorizationSubject(JSON.stringify(candidates));
  if (subjectJson === null) return null;
  const subject = parseDocument(subjectJson);
  if (typeof subject.name !== "string" || typeof subject.accessToken !== "string") return null;
  const storedRoles = parseDocuments(await store.listDocuments("roles"));
  const names = authorizationRoleNames(subject.roles, configuredDefaultRoles);

  let authorization: AuthorizedSubject;
  if (credential !== null && credential.token !== null && !refreshJwt) {
    authorization = {
      token: credential.token,
      sub: subject.name,
      permissionGroups: [],
      iat: credential.iat,
      exp: credential.exp,
    };
  } else {
    authorization = parseAuthorizedSubject(
      await store.issueAccessJwt(subject.accessToken),
    );
    authorization.sub = subject.name;
  }
  authorization.permissionGroups = authorizationPermissionGroups(names, storedRoles);
  return authorization;
}

interface AuthorizationResolution {
  admin: boolean;
  authorized: AuthorizedSubject | null;
  defaults: boolean;
}

async function resolveTokenCredential(
  store: DurableObjectStub<EntryStore>,
  credentials: RequestCredentials,
  configuredDefaultRoles: string | undefined,
): Promise<{ authorized: AuthorizedSubject | null; attempted: boolean }> {
  if (credentials.token === null || credentials.tokenSource === null) {
    return { authorized: null, attempted: false };
  }
  const candidates = boundedTokenCandidates(credentials.token);
  if (candidates === null) {
    return {
      authorized: null,
      attempted: credentials.tokenSource === "bearer",
    };
  }

  if (credentials.tokenSource === "bearer") {
    const bearer = candidates.length === 1 ? candidates[0]! : null;
    if (bearer === null) return { authorized: null, attempted: true };
    const claimsJson = await store.verifyAccessJwt(bearer);
    if (claimsJson === null) return { authorized: null, attempted: true };
    const claims = parseAccessJwtClaims(claimsJson);
    return {
      authorized: await authorizeCredential(
        store,
        claims.accessToken,
        configuredDefaultRoles,
        { ...claims, token: bearer },
      ),
      attempted: true,
    };
  }

  if (candidates.length === 1) {
    const candidate = candidates[0]!;
    const claimsJson = await store.verifyAccessJwt(candidate);
    if (claimsJson !== null) {
      const claims = parseAccessJwtClaims(claimsJson);
      const authorized = await authorizeCredential(
        store,
        claims.accessToken,
        configuredDefaultRoles,
        null,
        true,
      );
      return { authorized, attempted: authorized !== null };
    }
  }
  const authorized = await authorizeCredential(
    store,
    candidates,
    configuredDefaultRoles,
    null,
    true,
  );
  // Locked extractJWTfromRequest converts only a valid query/body access token
  // into a JWT. An invalid opaque token therefore falls back to defaults.
  return { authorized, attempted: authorized !== null };
}

async function resolveRequestAuthorization(
  request: Request,
  env: AppEnv,
  url: URL,
  body?: unknown,
): Promise<AuthorizationResolution> {
  const credentials = extractRequestCredentials(request, url, body);
  const configured = configuredApiSecret(env);
  // Locked v15.0.7 passes query-string secret arrays into
  // enclave.isApiKey(), whose scalar-only toLowerCase() throws before the
  // storage layer can perform its documented ordered subject lookup. Treat
  // arrays as subject candidates but never as an admin API secret: this keeps
  // valid access-token arrays useful and makes invalid explicit credentials
  // fail closed instead of falling back to anonymous defaults.
  const scalarApiSecret = typeof credentials.apiSecret === "string"
    ? credentials.apiSecret
    : null;

  if (env.ENTRY_STORE === undefined) {
    if (await apiSecretDigestMatches(scalarApiSecret, configured)) {
      return { admin: true, authorized: null, defaults: false };
    }
    return {
      admin: false,
      authorized: null,
      defaults: credentials.apiSecret === null && credentials.tokenSource !== "bearer",
    };
  }
  const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));
  const ip = requestRemoteIp(request);
  await waitForAuthorizationDelay(store, ip);
  if (await apiSecretDigestMatches(scalarApiSecret, configured)) {
    await store.authorizationSucceeded(ip);
    return { admin: true, authorized: null, defaults: false };
  }
  const token = await resolveTokenCredential(
    store,
    credentials,
    env.AUTH_DEFAULT_ROLES,
  );
  if (token.authorized !== null) {
    await store.authorizationSucceeded(ip);
    return { admin: false, authorized: token.authorized, defaults: false };
  }

  if (credentials.apiSecret !== null) {
    const secretSubject = await authorizeCredential(
      store,
      credentials.apiSecret,
      env.AUTH_DEFAULT_ROLES,
      null,
      true,
    );
    if (secretSubject !== null) await store.authorizationSucceeded(ip);
    else await store.authorizationFailed(ip, Date.now(), configuredAuthFailDelay(env));
    return {
      admin: false,
      authorized: secretSubject,
      defaults: false,
    };
  }
  if (token.attempted) {
    await store.authorizationFailed(ip, Date.now(), configuredAuthFailDelay(env));
  }
  return {
    admin: false,
    authorized: null,
    defaults: !token.attempted,
  };
}

async function permissionGroupsForResolution(
  resolution: AuthorizationResolution,
  store: DurableObjectStub<EntryStore>,
  env: AppEnv,
): Promise<string[][]> {
  if (resolution.admin) return [["*"]];
  if (resolution.authorized !== null) return resolution.authorized.permissionGroups;
  if (!resolution.defaults) return [];
  const storedRoles = parseDocuments(await store.listDocuments("roles"));
  return authorizationPermissionGroups(
    authorizationDefaultRoleNames(configuredAuthDefaultRoles(env)),
    storedRoles,
  );
}

async function requirePermissions(
  request: Request,
  env: AppEnv,
  url: URL,
  permissions: readonly string[],
  body?: unknown,
): Promise<AuthorizationResolution> {
  const resolution = await resolveRequestAuthorization(request, env, url, body);
  if (resolution.admin) return resolution;
  if (env.ENTRY_STORE === undefined) {
    if (configuredApiSecret(env) === null) {
      throw new ApiError(
        503,
        "api_secret_not_configured",
        "API_SECRET must be configured as a Cloudflare variable before writes are enabled",
      );
    }
    throw new ApiError(
      503,
      "entry_store_not_configured",
      "ENTRY_STORE must be configured before writes are enabled",
    );
  }
  const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));
  const permissionGroups = await permissionGroupsForResolution(resolution, store, env);
  if (permissions.every((permission) =>
    permissionGroupsAllow(permissionGroups, permission)
  )) {
    return resolution;
  }
  if (configuredApiSecret(env) === null) {
    throw new ApiError(
      503,
      "api_secret_not_configured",
      "API_SECRET must be configured as a Cloudflare variable before writes are enabled",
    );
  }
  throw new ApiError(
    401,
    "unauthorized",
    `permissions ${permissions.join(", ")} are required`,
  );
}

async function requirePermission(
  request: Request,
  env: AppEnv,
  url: URL,
  permission: string,
  body?: unknown,
): Promise<AuthorizationResolution> {
  return requirePermissions(request, env, url, [permission], body);
}

function formBody(text: string): unknown {
  const parameterLimit = 50_000;
  let separators = 0;
  for (let index = text.indexOf("&"); index !== -1; index = text.indexOf("&", index + 1)) {
    separators += 1;
    if (separators >= parameterLimit) {
      throw new ApiError(413, "body_too_large", "form body has too many parameters");
    }
  }
  try {
    // Locked middleware uses body-parser urlencoded({ extended: true,
    // parameterLimit: 50000 }); these are body-parser 1.20.4's qs options.
    return qs.parse(text, {
      allowPrototypes: true,
      arrayLimit: Math.max(100, separators),
      depth: 32,
      strictDepth: true,
      parameterLimit,
    });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ApiError(400, "invalid_form", "form body exceeds the supported nesting depth");
    }
    throw error;
  }
}

async function readBoundedBody(
  request: Request,
  allowEmpty = false,
): Promise<unknown> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new ApiError(413, "body_too_large", "request body exceeds 512 KiB");
  }
  if (request.body === null) {
    if (allowEmpty) return undefined;
    throw new ApiError(400, "invalid_json", "request body is required");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ApiError(413, "body_too_large", "request body exceeds 512 KiB");
    }
    chunks.push(result.value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Cloudflare's public edge can preserve a zero-byte stream for bodyless
  // DELETE requests even though locally constructed Requests expose null.
  // Upstream accepts both representations; mutation authorization sees the
  // same undefined payload in either case.
  if (allowEmpty && total === 0) return undefined;
  const text = new TextDecoder().decode(body);
  if (request.headers.get("Content-Type")?.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return formBody(text);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "request body is not valid JSON");
  }
}

function statusQueryCredential(url: URL, name: "token" | "secret"): PresentedToken | null {
  const values: string[] = [];
  let arraySyntax = false;
  for (const [key, value] of url.searchParams) {
    if (key === name) values.push(value);
    if (key === `${name}[]`) {
      arraySyntax = true;
      values.push(value);
    }
  }
  if (values.length === 0) return null;
  return arraySyntax || values.length > 1 ? values : values[0]!;
}

function selectedStatusQueryCredential(url: URL): PresentedToken | null {
  const token = statusQueryCredential(url, "token");
  const secret = statusQueryCredential(url, "secret");
  const selected = token !== null && (Array.isArray(token) || token)
    ? token
    : secret !== null && (Array.isArray(secret) || secret)
      ? secret
      : null;
  return selected;
}

async function statusQueryAuthorization(
  store: DurableObjectStub<EntryStore>,
  url: URL,
  configuredDefaultRoles: string | undefined,
): Promise<AuthorizedSubject | null> {
  const presented = selectedStatusQueryCredential(url);
  if (presented === null || boundedTokenCandidates(presented) === null) return null;
  // Locked authorization.authorize() asks the enclave to verify only a scalar
  // JWT. Repeated/[] query values remain an array, and storage.findSubject()
  // checks those access-token prefixes in their presented order.
  if (Array.isArray(presented)) {
    return authorizeCredential(store, presented, configuredDefaultRoles);
  }
  const claimsJson = await store.verifyAccessJwt(presented);
  const accessToken = claimsJson === null
    ? presented
    : parseAccessJwtClaims(claimsJson).accessToken;
  return authorizeCredential(store, accessToken, configuredDefaultRoles);
}

async function statusForRequest(
  env: AppEnv,
  url: URL,
): Promise<Record<string, unknown>> {
  const store = env.ENTRY_STORE.getByName(resolveTenantFromUrl(url));
  const status = JSON.parse(await store.nightscoutHttpStatus(Date.now())) as Record<string, unknown>;
  // Locked status.js does not reuse the authorization middleware result. It
  // independently calls authorization.authorize(query.token || query.secret)
  // and therefore ignores Bearer and api-secret headers for this field.
  status.authorized = await statusQueryAuthorization(
    store,
    url,
    env.AUTH_DEFAULT_ROLES,
  );
  return status;
}

type StatusFormat = "html" | "png" | "svg" | "js" | "text" | "json";

interface ParsedMediaRange {
  type: string;
  subtype: string;
  params: Record<string, string | undefined>;
  quality: number;
  order: number;
}

interface MediaPriority {
  quality: number;
  specificity: number;
  acceptOrder: number;
  providedOrder: number;
}

function splitQuoted(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') quoted = !quoted;
    if (!quoted && value[index] === delimiter) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function parsedMediaRange(value: string, order: number): ParsedMediaRange | null {
  const match = /^\s*([^\s/;]+)\/([^;\s]+)\s*(?:;(.*))?$/.exec(value);
  if (match === null) return null;
  const params: Record<string, string | undefined> = {};
  let quality = 1;
  if (match[3] !== undefined) {
    for (const rawParameter of splitQuoted(match[3], ";")) {
      const parameter = rawParameter.trim();
      const equals = parameter.indexOf("=");
      const key = (equals < 0 ? parameter : parameter.slice(0, equals)).toLowerCase();
      const rawValue = equals < 0 ? undefined : parameter.slice(equals + 1);
      const parsed = rawValue?.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : rawValue;
      if (key === "q") {
        quality = Number.parseFloat(parsed ?? "");
        break;
      }
      params[key] = parsed;
    }
  }
  return {
    type: match[1]!,
    subtype: match[2]!,
    params,
    quality,
    order,
  };
}

function priorityForMediaType(
  mediaType: string,
  accepted: ParsedMediaRange[],
  providedOrder: number,
): MediaPriority {
  const provided = parsedMediaRange(mediaType, providedOrder);
  let priority: MediaPriority = {
    acceptOrder: -1,
    quality: 0,
    specificity: 0,
    providedOrder,
  };
  if (provided === null) return priority;

  for (const range of accepted) {
    let specificity = 0;
    if (range.type.toLowerCase() === provided.type.toLowerCase()) specificity |= 4;
    else if (range.type !== "*") continue;
    if (range.subtype.toLowerCase() === provided.subtype.toLowerCase()) specificity |= 2;
    else if (range.subtype !== "*") continue;
    const parameterKeys = Object.keys(range.params);
    if (!parameterKeys.every((key) =>
      range.params[key] === "*"
      || (range.params[key] ?? "").toLowerCase()
        === (provided.params[key] ?? "").toLowerCase()
    )) {
      continue;
    }
    if (parameterKeys.length > 0) specificity |= 1;
    const candidate: MediaPriority = {
      acceptOrder: range.order,
      quality: range.quality,
      specificity,
      providedOrder,
    };
    // Exact negotiator priority: first choose the most-specific Accept range
    // for each offered type, then its q value and header order.
    if (
      candidate.specificity > priority.specificity
      || (
        candidate.specificity === priority.specificity
        && candidate.quality > priority.quality
      )
      || (
        candidate.specificity === priority.specificity
        && candidate.quality === priority.quality
        && candidate.acceptOrder > priority.acceptOrder
      )
    ) {
      priority = candidate;
    }
  }
  return priority;
}

function negotiatedFormat<Format extends string>(
  request: Request,
  offered: ReadonlyArray<readonly [Format, string]>,
): Format | null {
  const accept = request.headers.get("Accept") ?? "*/*";
  const accepted = splitQuoted(accept, ",")
    .map((value, order) => parsedMediaRange(value.trim(), order))
    .filter((value): value is ParsedMediaRange => value !== null);
  const priorities = offered.map(([format, mediaType], providedOrder) => ({
    format,
    priority: priorityForMediaType(mediaType, accepted, providedOrder),
  })).filter(({ priority }) => priority.quality > 0);
  priorities.sort((left, right) =>
    right.priority.quality - left.priority.quality
    || right.priority.specificity - left.priority.specificity
    || left.priority.acceptOrder - right.priority.acceptOrder
    || left.priority.providedOrder - right.priority.providedOrder
  );
  return priorities[0]?.format ?? null;
}

function negotiatedStatusFormat(request: Request): StatusFormat | null {
  const offered = [
    ["html", "text/html"],
    ["png", "image/png"],
    ["svg", "image/svg+xml"],
    ["js", "application/javascript"],
    ["text", "text/plain"],
    ["json", "application/json"],
  ] as const;
  return negotiatedFormat(request, offered);
}

function statusText(
  body: string,
  contentType: string,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(corsHeaders())) headers.set(name, value);
  headers.set("Content-Type", `${contentType}; charset=utf-8`);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Length", String(new TextEncoder().encode(body).byteLength));
  headers.set("Vary", "Accept");
  return new Response(body, { ...init, headers });
}

function statusRedirect(
  request: Request,
  extension: "png" | "svg",
  explicitExtension: boolean,
): Response {
  const headers = new Headers(corsHeaders());
  const location = `http://img.shields.io/badge/Nightscout-OK-green.${extension}`;
  headers.set("Location", location);
  let body = "";
  let contentType = extension === "png" ? "image/png" : "image/svg+xml";
  // Express first chooses png/svg in the route's res.format(), then
  // res.redirect() negotiates text/html a second time. An explicit extension
  // has already replaced Accept with its image MIME type, so it keeps the
  // outer image Content-Type and the redirect body remains empty.
  const redirectFormat = explicitExtension
    ? null
    : negotiatedFormat(request, [
      ["text", "text/plain"],
      ["html", "text/html"],
    ] as const);
  if (redirectFormat === "text") {
    contentType = "text/plain; charset=utf-8";
    body = `Found. Redirecting to ${location}`;
  } else if (redirectFormat === "html") {
    contentType = "text/html; charset=utf-8";
    body = `<p>Found. Redirecting to <a href="${location}">${location}</a></p>`;
  }
  headers.set("Content-Type", contentType);
  headers.set("Content-Length", String(new TextEncoder().encode(body).byteLength));
  headers.set("Cache-Control", "no-store");
  headers.set("Vary", "Accept");
  return new Response(body, { status: 302, headers });
}

function statusNotAcceptable(request: Request): Response {
  // res.format() forwards this error to the production app's errorhandler(),
  // which falls back to a plain-text stack for an unacceptable Accept value.
  const error = new Error("Not Acceptable");
  const body = error.stack ?? error.toString();
  const encodedBody = new TextEncoder().encode(body);
  const headers = new Headers(corsHeaders());
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Vary", "Accept");
  headers.set("X-Content-Type-Options", "nosniff");
  if (request.method !== "HEAD") {
    headers.set("Content-Length", String(encodedBody.byteLength));
  }
  // A TypedArray is a fixed-length Workers response source. Unlike a manual
  // Content-Length on a generic stream, the runtime can preserve its length
  // on the actual HTTP boundary.
  return new Response(request.method === "HEAD" ? null : encodedBody, {
    status: 406,
    headers,
  });
}

function renderStatus(
  request: Request,
  status: Record<string, unknown>,
  format: StatusFormat,
  explicitExtension: boolean,
): Response {
  switch (format) {
    case "html":
      return statusText("<h1>STATUS OK</h1>", "text/html");
    case "png":
    case "svg":
      return statusRedirect(request, format, explicitExtension);
    case "js":
      return statusText(
        `this.serverSettings = ${JSON.stringify(status)} ;`,
        "application/javascript",
      );
    case "text":
      return statusText("STATUS OK", "text/plain");
    case "json":
      return statusText(JSON.stringify(status), "application/json");
  }
}

function withoutBodyForHead(request: Request, response: Response): Response {
  if (request.method !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function escapeFinalhandlerMessage(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("\n", "<br>")
    .replaceAll("  ", " &nbsp;");
}

function expressFinalNotFound(request: Request, url: URL): Response {
  const message = escapeFinalhandlerMessage(
    `Cannot ${request.method} ${url.pathname}`,
  );
  const body = "<!DOCTYPE html>\n"
    + '<html lang="en">\n'
    + "<head>\n"
    + '<meta charset="utf-8">\n'
    + "<title>Error</title>\n"
    + "</head>\n"
    + "<body>\n"
    + `<pre>${message}</pre>\n`
    + "</body>\n"
    + "</html>\n";
  const encodedBody = new TextEncoder().encode(body);
  const headers = new Headers(corsHeaders());
  headers.set("Content-Security-Policy", "default-src 'none'");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Length", String(encodedBody.byteLength));
  // Keep a fixed-length source even for HEAD. The HTTP layer suppresses a
  // HEAD body while retaining the representation length where the Workers
  // transport permits it, matching Express's method-specific response.
  return new Response(encodedBody, {
    status: 404,
    headers,
  });
}

function isStatusFinalhandlerPath(pathname: string): boolean {
  return /^\/api\/(?:v[12]\/)?status/i.test(pathname);
}

function entryDeleteBoundary(url: URL, name: string): number | null {
  const value = url.searchParams.get(name);
  if (value === null || value === "") return null;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ApiError(400, "invalid_query", `${name} must be epoch milliseconds or ISO time`);
  }
  return Math.trunc(parsed);
}

function entryDeleteDateString(url: URL): string | null {
  const values = url.searchParams.getAll("find[dateString]");
  if (values.length > 1) {
    throw new ApiError(400, "invalid_query", "find[dateString] must not be repeated");
  }
  const value = values[0];
  if (value === undefined) return null;
  if (value.length === 0 || value.length > 4096 || !Number.isFinite(Date.parse(value))) {
    throw new ApiError(400, "invalid_query", "find[dateString] must be an ISO timestamp");
  }
  return value;
}

function entryDeleteDateStringBoundary(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new ApiError(400, "invalid_query", `${name} must not be repeated`);
  }
  const value = values[0];
  if (value === undefined) return null;
  if (value.length === 0 || value.length > 4096) {
    throw new ApiError(400, "invalid_query", `${name} has an invalid format`);
  }
  return value;
}

function entryDeleteExactDate(url: URL): number | null {
  const values = url.searchParams.getAll("find[date]");
  if (values.length > 1) {
    throw new ApiError(400, "invalid_query", "find[date] must not be repeated");
  }
  const value = values[0];
  if (value === undefined) return null;
  const parsed = Number.parseInt(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiError(400, "invalid_query", "find[date] must begin with an integer");
  }
  return parsed;
}

function assertSupportedEntryDeleteFilters(url: URL): void {
  const supported = new Set([
    "find[date][$gte]",
    "find[date][$lte]",
    "find[date]",
    "find[dateString]",
    "find[dateString][$gte]",
    "find[dateString][$lte]",
    "find[type]",
    "find[type][$eq]",
  ]);
  for (const name of url.searchParams.keys()) {
    if (name.startsWith("find[") && !supported.has(name)) {
      throw new ApiError(
        400,
        "unsupported_delete_filter",
        `entry deletion does not safely support ${name}`,
      );
    }
  }
}

function latestDocumentTime(documents: JsonDocument[]): number | null {
  let latest: number | null = null;
  for (const document of documents) {
    const value = document.created_at ?? document.timestamp;
    const timestamp =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Date.parse(value)
          : Number.NaN;
    if (Number.isFinite(timestamp) && (latest === null || timestamp > latest)) {
      latest = timestamp;
    }
  }
  return latest;
}

function notModified(lastModified: number): Response {
  const headers = new Headers(corsHeaders());
  headers.set("Cache-Control", "no-store");
  headers.set("Last-Modified", new Date(lastModified).toUTCString());
  return new Response(null, { status: 304, headers });
}

function hasFindQuery(url: URL): boolean {
  return Array.from(url.searchParams.keys()).some((name) => name.startsWith("find["));
}

type LegacyEntryFormat = "json" | "csv" | "tsv" | "text";
type LegacyEntryExtension = "json" | "svg" | "csv" | "txt" | "png" | "html" | "tsv";

interface LegacyEntriesPath {
  pathname: string;
  extension?: LegacyEntryExtension;
}

function splitLegacyEntriesExtension(pathname: string): LegacyEntriesPath {
  // The locked extension middleware's regexp is case-insensitive, but its
  // MIME lookup uses the original match as a lowercase-only object key. That
  // long-standing quirk means `.JSON` is not stripped and falls through.
  const match = /\.(json|svg|csv|txt|png|html|tsv)$/.exec(pathname);
  if (match === null) return { pathname };
  return {
    pathname: pathname.slice(0, -match[0].length),
    extension: match[1]! as LegacyEntryExtension,
  };
}

function legacyEntryFormat(request: Request, extension: LegacyEntryExtension | undefined): LegacyEntryFormat {
  if (extension !== undefined) {
    if (extension === "csv") return "csv";
    if (extension === "tsv") return "tsv";
    if (extension === "txt") return "text";
    // json is direct; html/svg/png select no offered representation and hit
    // the locked res.format() default, which is also JSON.
    return "json";
  }
  return negotiatedFormat(request, [
    ["text", "text/plain"],
    ["tsv", "text/tab-separated-values"],
    ["csv", "text/csv"],
    ["json", "application/json"],
  ] as const) ?? "json";
}

function legacyEntryTime(entry: PublicEntry): number {
  const candidate = (entry as PublicEntry & { mills?: unknown }).mills;
  if (typeof candidate === "number" && candidate !== 0) return candidate;
  return entry.date;
}

function prepareLegacyEntries(entries: PublicEntry[], assumedType: string | undefined): PublicEntry[] {
  return entries.map((entry) => {
    const prepared = { ...entry };
    if (!prepared.type && assumedType) prepared.type = assumedType;
    return prepared;
  }).sort((left, right) => legacyEntryTime(right) - legacyEntryTime(left));
}

function formatLegacyEntryCells(entries: PublicEntry[], separator: "," | "\t"): string {
  const fields = ["dateString", "date", "sgv", "direction", "device"] as const;
  return entries.map((entry) => fields.map((field) => {
    const value = entry[field];
    const rendered = JSON.stringify(value, (_key, item: unknown) => item === null ? "" : item);
    return rendered ?? "";
  }).join(separator)).join("\r\n");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function expressWeakEtag(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength === 0) return 'W/"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"';
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  return `W/"${bytes.byteLength.toString(16)}-${base64(digest).slice(0, 27)}"`;
}

async function legacyEntryJson(data: unknown, status = 200): Promise<Response> {
  const body = JSON.stringify(data);
  const headers = new Headers(corsHeaders());
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Content-Length", String(new TextEncoder().encode(body).byteLength));
  headers.set("ETag", await expressWeakEtag(body));
  return new Response(body, { status, headers });
}

type LegacyUtilityStorage = "entries" | "treatments" | "devicestatus";

function legacyInteger(value: unknown): number {
  return Number.parseInt(String(value), 10);
}

function legacyStorageQueryOptions(
  storage: LegacyUtilityStorage,
  uuidHandling: boolean,
): LegacyQueryOptions {
  if (storage === "entries") {
    return {
      walker: {
        date: legacyInteger,
        sgv: legacyInteger,
        filtered: legacyInteger,
        unfiltered: legacyInteger,
        rssi: legacyInteger,
        noise: legacyInteger,
        mbg: legacyInteger,
      },
      useEpoch: true,
      uuidHandling,
    };
  }
  if (storage === "treatments") {
    return {
      walker: {
        insulin: legacyInteger,
        carbs: legacyInteger,
        glucose: legacyInteger,
        notes: (value) => parseLegacyRegularExpression(String(value)),
        eventType: (value) => parseLegacyRegularExpression(String(value)),
        enteredBy: (value) => parseLegacyRegularExpression(String(value)),
      },
      dateField: "created_at",
      uuidHandling,
    };
  }
  return { walker: {}, dateField: "created_at", uuidHandling };
}

function legacyJsonSafeQuery(value: unknown): unknown {
  if (value instanceof LegacyObjectId) return value.toString();
  if (value instanceof RegExp) return value;
  if (Array.isArray(value)) return value.map(legacyJsonSafeQuery);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, legacyJsonSafeQuery(nested)]),
  );
}

function legacyEchoInput(
  url: URL,
  model: string | undefined,
  spec: string | undefined,
): Record<string, unknown> {
  if (spec !== undefined && /^[a-f\d]{24}$/.test(spec)) {
    return { find: { _id: spec } };
  }
  const parameters = new URLSearchParams(url.search);
  // Tenant routing and credentials belong to the Cloudflare boundary, not to
  // the official Mongo query debugger, and must never be reflected as data.
  for (const name of ["tenant", "secret", "token", "api-secret"]) parameters.delete(name);
  let parsed: unknown;
  try {
    parsed = qs.parse(parameters.toString(), {
      allowPrototypes: true,
      arrayLimit: 100,
      depth: 32,
      strictDepth: true,
      parameterLimit: 50_000,
    });
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ApiError(400, "invalid_query", "query exceeds the supported nesting depth");
    }
    throw error;
  }
  const input = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? { ...(parsed as Record<string, unknown>) }
    : {};
  if (model !== undefined) {
    const rawFind = input.find;
    const find = typeof rawFind === "object" && rawFind !== null && !Array.isArray(rawFind)
      ? { ...(rawFind as Record<string, unknown>) }
      : {};
    find.type = model;
    input.find = find;
  }
  return input;
}

function legacyEchoMongoQuery(
  input: Record<string, unknown>,
  storage: LegacyUtilityStorage,
  uuidHandling: boolean,
): Record<string, unknown> {
  const query = createLegacyMongoQuery(
    structuredClone(input) as LegacyQueryObject,
    legacyStorageQueryOptions(storage, uuidHandling),
  );
  return legacyJsonSafeQuery(query) as Record<string, unknown>;
}

const MAX_LEGACY_PATTERN_PREFIXES = 8;
const MAX_LEGACY_PATTERN_EXPANSIONS = 256;
const MAX_LEGACY_PATTERN_CANDIDATES = 10_000;

function expandLegacyNumericBraces(input: string, limit = MAX_LEGACY_PATTERN_EXPANSIONS): string[] {
  const match = /\{(-?\d+)\.\.(-?\d+)\}/.exec(input);
  if (match === null) return [input];
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new ApiError(400, "invalid_query", "pattern range must contain safe integers");
  }
  const size = Math.abs(end - start) + 1;
  if (size > limit) {
    throw new ApiError(400, "invalid_query", "pattern expansion exceeds the 256-item limit");
  }
  const width = Math.max(
    match[1]!.replace(/^-/, "").length,
    match[2]!.replace(/^-/, "").length,
  );
  const step = start <= end ? 1 : -1;
  const output: string[] = [];
  for (let value = start; ; value += step) {
    const absolute = Math.abs(value).toString().padStart(width, "0");
    const replacement = value < 0 ? `-${absolute}` : absolute;
    const expanded = `${input.slice(0, match.index)}${replacement}${input.slice(
      match.index + match[0].length,
    )}`;
    const nested = expandLegacyNumericBraces(expanded, limit - output.length);
    output.push(...nested);
    if (output.length > limit) {
      throw new ApiError(400, "invalid_query", "pattern expansion exceeds the 256-item limit");
    }
    if (value === end) break;
  }
  return output;
}

interface LegacyPatternPlan {
  prefixes: string[];
  patterns: string[];
}

function legacyPatternPlan(rawPrefix: string | undefined, rawRegex: string | undefined): LegacyPatternPlan {
  const prefix = rawPrefix ?? ".*";
  if (prefix.length > 256 || (rawRegex?.length ?? 0) > 256) {
    throw new ApiError(400, "invalid_query", "pattern path segments must not exceed 256 characters");
  }
  const prefixes = Array.from(new Set(expandLegacyNumericBraces(prefix)));
  if (prefixes.length > MAX_LEGACY_PATTERN_PREFIXES) {
    throw new ApiError(
      400,
      "invalid_query",
      `prefix expansion exceeds the ${MAX_LEGACY_PATTERN_PREFIXES}-item Workers limit`,
    );
  }
  let patternSource = prefixes.length > 1 ? `^${prefix}` : "";
  if (rawRegex !== undefined) patternSource += `.*${rawRegex}`;
  const patterns = patternSource === ""
    ? [""]
    : Array.from(new Set(expandLegacyNumericBraces(patternSource)));
  for (const pattern of patterns) {
    // The locked routes expose arbitrary RegExp construction. Workers accepts
    // only the fixture-required linear subset before compiling JavaScript.
    if (!/^[A-Za-z0-9.*^$:_-]*$/.test(pattern)) {
      throw new ApiError(400, "unsupported_pattern", "pattern contains unsupported regex syntax");
    }
  }
  return { prefixes, patterns };
}

function legacyPatternMatches(value: string, plan: LegacyPatternPlan): boolean {
  if (!plan.prefixes.some((prefix) => prefix === ".*" || value.startsWith(prefix))) return false;
  if (plan.patterns.length === 1 && plan.patterns[0] === "") return true;
  return plan.patterns.some((pattern) => new RegExp(pattern).test(value));
}

function legacyDocumentCount(parameters: Record<string, unknown>): number {
  if (parameters.count === undefined || parameters.count === null || parameters.count === "") return 10;
  const count = Number.parseInt(String(parameters.count), 10);
  // Mongo cursor.limit(0) is unbounded. Keep that spelling useful while
  // mapping it to the documented Workers candidate ceiling.
  if (count === 0) return MAX_LEGACY_PATTERN_CANDIDATES;
  if (!Number.isInteger(count) || count < 1 || count > MAX_LEGACY_PATTERN_CANDIDATES) {
    throw new ApiError(
      400,
      "invalid_query",
      `count must be 0 or an integer from 1 to ${MAX_LEGACY_PATTERN_CANDIDATES}`,
    );
  }
  return count;
}

function legacyFilterValue(value: unknown): JsonDocument[string] {
  if (value instanceof LegacyObjectId) return value.toString();
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) return value;
  if (Array.isArray(value)) return value.map(legacyFilterValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, legacyFilterValue(nested)]),
    );
  }
  throw new ApiError(400, "invalid_query", "query contains an unsupported value");
}

function legacyRegexFilter(field: string, value: unknown, flags = ""): DocumentFilter {
  const expression = value instanceof RegExp ? value : new RegExp(String(value), flags);
  if (expression.flags !== "") {
    throw new ApiError(
      400,
      "unsupported_query_regex",
      "case-insensitive or stateful Mongo regex flags are not supported by the bounded SQLite adapter",
    );
  }
  return { field, operator: "re", value: expression.source };
}

function legacyUuidOrFilter(value: unknown): DocumentFilter | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const objects = value.filter(
    (candidate): candidate is Record<string, unknown> =>
      typeof candidate === "object" && candidate !== null && !Array.isArray(candidate),
  );
  if (objects.length !== 2) return null;
  const identifier = objects.find((candidate) => Object.hasOwn(candidate, "identifier"))?.identifier;
  const id = objects.find((candidate) => Object.hasOwn(candidate, "_id"))?._id;
  if (typeof identifier !== "string" || identifier !== id) return null;
  return { field: "_id", operator: "eq", value: identifier };
}

function legacyMongoDocumentQuery(
  mongoQuery: LegacyQueryObject,
  parameters: Record<string, unknown>,
  patternField: string,
  uuidHandling: boolean,
): DocumentQuery {
  const filters: DocumentFilter[] = [];
  const operatorMap = {
    $eq: "eq",
    $ne: "ne",
    $gt: "gt",
    $gte: "gte",
    $lt: "lt",
    $lte: "lte",
    $in: "in",
    $nin: "nin",
    $exists: "exists",
  } as const;
  for (const [field, value] of Object.entries(mongoQuery)) {
    if (field === "$or") {
      const filter = legacyUuidOrFilter(value);
      if (filter === null) {
        throw new ApiError(400, "unsupported_query_or", "this Mongo $or shape is not supported");
      }
      filters.push(filter);
      continue;
    }
    if (value instanceof RegExp) {
      if (field !== patternField) filters.push(legacyRegexFilter(field, value));
      continue;
    }
    if (typeof value !== "object" || value === null || value instanceof LegacyObjectId) {
      filters.push({ field, operator: "eq", value: legacyFilterValue(value) });
      continue;
    }
    if (Array.isArray(value)) {
      filters.push({ field, operator: "eq", value: legacyFilterValue(value) });
      continue;
    }
    const operators = value as Record<string, unknown>;
    const flags = typeof operators.$options === "string" ? operators.$options : "";
    const names = Object.keys(operators).filter((name) => name !== "$options");
    if (names.length === 0) {
      filters.push({ field, operator: "eq", value: legacyFilterValue(value) });
      continue;
    }
    for (const [operator, operand] of Object.entries(operators)) {
      if (operator === "$options") continue;
      if (field === patternField && (operator === "$in" || operator === "$regex")) continue;
      if (operator === "$regex") {
        filters.push(legacyRegexFilter(field, operand, flags));
        continue;
      }
      const mapped = operatorMap[operator as keyof typeof operatorMap];
      if (mapped === undefined) {
        throw new ApiError(400, "unsupported_query_operator", `Mongo operator ${operator} is not supported`);
      }
      const converted = mapped === "in" || mapped === "nin"
        ? Array.isArray(operand)
          ? operand.map(legacyFilterValue)
          : String(operand).split(",").map((item) => legacyFilterValue(item.trim()))
        : legacyFilterValue(operand);
      filters.push({ field, operator: mapped, value: converted });
    }
  }

  const sorts: DocumentSort[] = [];
  const rawSort = parameters.sort;
  if (typeof rawSort === "object" && rawSort !== null && !Array.isArray(rawSort)) {
    for (const [field, direction] of Object.entries(rawSort)) {
      if (String(direction) !== "1" && String(direction) !== "-1") {
        throw new ApiError(400, "invalid_query", `sort[${field}] must be 1 or -1`);
      }
      sorts.push({ field, direction: String(direction) === "1" ? "asc" : "desc" });
    }
  }
  return {
    filters,
    ...(sorts.length === 0 ? {} : { sort: sorts }),
    limit: MAX_LEGACY_PATTERN_CANDIDATES,
    includeDeleted: true,
    legacyUuidHandling: uuidHandling,
  };
}

function legacySliceParameters(
  url: URL,
  field: string,
  type: string | undefined,
  plan: LegacyPatternPlan,
): Record<string, unknown> {
  const parameters = legacyEchoInput(url, undefined, undefined);
  const rawFind = parameters.find;
  const find = typeof rawFind === "object" && rawFind !== null && !Array.isArray(rawFind)
    ? { ...(rawFind as Record<string, unknown>) }
    : {};
  const rawField = find[field];
  const fieldQuery = typeof rawField === "object" && rawField !== null && !Array.isArray(rawField)
    ? { ...(rawField as Record<string, unknown>) }
    : {};
  fieldQuery.$in = plan.patterns.map((pattern) => new RegExp(pattern));
  if (plan.prefixes.length === 1) fieldQuery.$regex = new RegExp(`^${plan.prefixes[0]}`);
  find[field] = fieldQuery;
  if (type !== undefined) find.type = type;
  parameters.find = find;
  return parameters;
}

function legacyDocumentField(document: JsonDocument, field: string): JsonDocument[string] | undefined {
  let value: JsonDocument[string] | undefined = document;
  for (const segment of field.split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    if (!Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

async function queryLegacyPatternDocuments(
  request: Request,
  env: AppEnv,
  url: URL,
  storage: LegacyUtilityStorage,
  field: string,
  type: string | undefined,
  plan: LegacyPatternPlan,
): Promise<JsonDocument[]> {
  const uuidHandling = parseLegacyUuidHandling(env.UUID_HANDLING);
  const parameters = legacySliceParameters(url, field, type, plan);
  const requestedCount = legacyDocumentCount(parameters);
  const mongoQuery = createLegacyMongoQuery(
    structuredClone(parameters) as LegacyQueryObject,
    legacyStorageQueryOptions(storage, uuidHandling),
  );
  const query = legacyMongoDocumentQuery(mongoQuery, parameters, field, uuidHandling);
  const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));
  const decision = JSON.parse(
    await store.queryLegacyDocumentsJson(storage as Api3CollectionName, JSON.stringify(query)),
  ) as
    | { ok: true; result: JsonDocument[] }
    | { ok: false; status?: number; message: string };
  if (!decision.ok) {
    if (decision.status === 400 || decision.status === 413) {
      throw new ApiError(
        decision.status,
        decision.status === 413 ? "entry_query_limit" : "invalid_query",
        decision.message,
      );
    }
    throw new Error(decision.message);
  }
  const selected = decision.result.filter((document) => {
    const value = legacyDocumentField(document, field);
    return typeof value === "string" && legacyPatternMatches(value, plan);
  }).slice(0, requestedCount);
  return storage === "treatments" ? normalizeTreatmentNumbers(selected) : selected;
}

async function queryLegacyPatternEntries(
  request: Request,
  env: AppEnv,
  url: URL,
  type: string | undefined,
  plan: LegacyPatternPlan,
): Promise<PublicEntry[]> {
  if (Array.from(url.searchParams.keys()).some((name) => name.startsWith("sort["))) {
    throw new ApiError(400, "unsupported_query_sort", "pattern routes currently use locked date ordering only");
  }
  const countProbe = new URL(url);
  countProbe.searchParams.delete("find[dateString]");
  countProbe.searchParams.delete("find[dateString][$gte]");
  countProbe.searchParams.delete("find[dateString][$lt]");
  if (type !== undefined) countProbe.searchParams.set("find[type]", type);
  countProbe.searchParams.set("find[dateString][$gte]", "0000");
  const requestedCount = parseHistoryQuery(countProbe).count;
  const candidateCount = plan.patterns.length === 1 && plan.patterns[0] === ""
    ? requestedCount
    : MAX_LEGACY_PATTERN_CANDIDATES;
  const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));
  const merged = new Map<string, PublicEntry>();
  for (const prefix of plan.prefixes) {
    if (prefix === ".*") {
      throw new ApiError(
        400,
        "unsupported_pattern",
        "a literal dateString prefix is required on the Workers adapter",
      );
    }
    const queryUrl = new URL(url);
    queryUrl.searchParams.delete("find[dateString]");
    queryUrl.searchParams.delete("find[dateString][$gte]");
    queryUrl.searchParams.delete("find[dateString][$lt]");
    queryUrl.searchParams.set("find[dateString][$gte]", prefix);
    queryUrl.searchParams.set("find[dateString][$lt]", `${prefix}\uffff`);
    queryUrl.searchParams.set("count", String(candidateCount));
    if (type !== undefined) queryUrl.searchParams.set("find[type]", type);
    const query = parseHistoryQuery(queryUrl);
    const decision = JSON.parse(await store.getEntriesJson(query)) as
      | { ok: true; result: PublicEntry[] }
      | { ok: false; status?: number; message: string };
    if (!decision.ok) {
      if (decision.status === 400 || decision.status === 413) {
        throw new ApiError(
          decision.status,
          decision.status === 413 ? "entry_query_limit" : "invalid_query",
          decision.message,
        );
      }
      throw new Error(decision.message);
    }
    for (const entry of decision.result) {
      const dateString = entry.dateString;
      if (typeof dateString !== "string" || !legacyPatternMatches(dateString, plan)) continue;
      merged.set(entry._id, entry);
    }
  }
  return Array.from(merged.values())
    .sort((left, right) => {
      const delta = Number(right.date) - Number(left.date);
      return delta === 0 ? left._id.localeCompare(right._id) : delta;
    })
    .slice(0, requestedCount);
}

function requestValidatorsAreFresh(request: Request, headers: Headers): boolean {
  if (/(?:^|,)\s*?no-cache\s*?(?:,|$)/i.test(request.headers.get("Cache-Control") ?? "")) {
    return false;
  }
  const noneMatch = request.headers.get("If-None-Match");
  const modifiedSince = request.headers.get("If-Modified-Since");
  if (noneMatch === null && modifiedSince === null) return false;
  if (noneMatch !== null && noneMatch !== "*") {
    const etag = headers.get("ETag");
    if (etag === null) return false;
    const matched = noneMatch.split(",").map((value) => value.trim()).some((value) =>
      value === etag || value === `W/${etag}` || `W/${value}` === etag
    );
    if (!matched) return false;
  }
  if (modifiedSince !== null) {
    const lastModified = headers.get("Last-Modified");
    if (
      lastModified === null
      || !(Date.parse(lastModified) <= Date.parse(modifiedSince))
    ) return false;
  }
  return true;
}

async function legacyEntryNotModified(lastModified: number): Promise<Response> {
  const body = JSON.stringify({ status: 304, message: "Not modified", type: "internal" });
  const headers = new Headers(corsHeaders());
  headers.set("Cache-Control", "no-store");
  headers.set("Last-Modified", new Date(lastModified).toUTCString());
  headers.set("ETag", await expressWeakEtag(body));
  return new Response(null, { status: 304, headers });
}

async function renderLegacyEntries(
  request: Request,
  entries: PublicEntry[],
  extension: LegacyEntryExtension | undefined,
  assumedType?: string,
  fallbackLastModified?: number,
): Promise<Response> {
  const prepared = prepareLegacyEntries(entries, assumedType);
  const firstTime = prepared.length === 0 ? null : legacyEntryTime(prepared[0]!);
  const lastModified = firstTime !== null && Number.isFinite(firstTime) && firstTime !== 0
    ? firstTime
    : fallbackLastModified !== undefined
        && Number.isFinite(fallbackLastModified)
        && fallbackLastModified !== 0
      ? fallbackLastModified
      : null;
  const ifModifiedSince = request.headers.get("If-Modified-Since");
  if (
    lastModified !== null
    && ifModifiedSince !== null
    && lastModified <= new Date(ifModifiedSince).getTime()
  ) {
    return legacyEntryNotModified(lastModified);
  }

  const format = legacyEntryFormat(request, extension);
  const body = format === "json"
    ? JSON.stringify(prepared)
    : formatLegacyEntryCells(prepared, format === "csv" ? "," : "\t");
  const headers = new Headers(corsHeaders());
  headers.set("Cache-Control", "no-store");
  headers.set("Vary", "Accept");
  headers.set("Content-Type", format === "json"
    ? "application/json; charset=utf-8"
    : format === "csv"
      ? "text/csv; charset=utf-8"
      : format === "tsv"
        ? "text/tab-separated-values; charset=utf-8"
        : "text/plain; charset=utf-8");
  if (lastModified !== null) headers.set("Last-Modified", new Date(lastModified).toUTCString());
  headers.set("Content-Length", String(new TextEncoder().encode(body).byteLength));
  headers.set("ETag", await expressWeakEtag(body));
  if (requestValidatorsAreFresh(request, headers)) {
    headers.delete("Content-Type");
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }
  return withoutBodyForHead(request, new Response(body, { status: 200, headers }));
}

async function handleEntriesApi(
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response | null> {
  const splitPath = splitLegacyEntriesExtension(url.pathname);
  const readMethod = request.method === "GET" || request.method === "HEAD";

  const echoMatch = /^\/api\/v[12]\/echo\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?\/?$/.exec(
    splitPath.pathname,
  );
  if (readMethod && echoMatch !== null) {
    await requirePermission(request, env, url, "api:entries:read");
    let storage: string;
    let model: string | undefined;
    let spec: string | undefined;
    try {
      storage = decodeURIComponent(echoMatch[1]!);
      model = echoMatch[2] === undefined ? undefined : decodeURIComponent(echoMatch[2]);
      spec = echoMatch[3] === undefined ? undefined : decodeURIComponent(echoMatch[3]);
    } catch {
      throw new ApiError(400, "invalid_query", "echo path contains invalid encoding");
    }
    if (storage !== "entries" && storage !== "treatments" && storage !== "devicestatus") {
      throw new ApiError(
        400,
        "unsupported_echo_storage",
        "echo storage must be entries, treatments or devicestatus",
      );
    }
    const input = legacyEchoInput(url, model, spec);
    const params: Record<string, string> = { echo: storage };
    if (model !== undefined) params.model = model;
    if (spec !== undefined) params.spec = spec;
    const response = await legacyEntryJson({
      query: legacyEchoMongoQuery(input, storage, parseLegacyUuidHandling(env.UUID_HANDLING)),
      input,
      params,
      storage,
    });
    return withoutBodyForHead(request, response);
  }

  const countMatch = /^\/api\/v[12]\/count\/([A-Za-z0-9_-]+)\/where\/?$/.exec(
    splitPath.pathname,
  );
  if (readMethod && countMatch !== null) {
    await requirePermission(request, env, url, "api:entries:read");
    const requestedStorage = countMatch[1]!;
    // Locked prep_storage selects these three names and falls back to Entries
    // for every other path value. Keep that routing quirk while executing a
    // bounded SQLite COUNT instead of materializing the selected documents.
    const collection = requestedStorage === "treatments"
      ? "treatments"
      : requestedStorage === "devicestatus"
        ? "devicestatus"
        : "entries";
    const query = parseHistoryCountQuery(url);
    const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));
    const decision = JSON.parse(await store.countLegacyDocumentsJson(collection, query)) as
      | { ok: true; result: number }
      | { ok: false; status?: number; message: string };
    if (!decision.ok) {
      if (decision.status === 400 || decision.status === 413) {
        throw new ApiError(
          decision.status,
          decision.status === 413 ? "entry_query_limit" : "invalid_query",
          decision.message,
        );
      }
      throw new Error(decision.message);
    }
    const response = await legacyEntryJson(
      decision.result === 0 ? [] : [{ _id: null, count: decision.result }],
    );
    return withoutBodyForHead(request, response);
  }

  const timesEchoMatch = /^\/api\/v[12]\/times\/echo(?:\/([^/]+))?(?:\/([^/]+))?\/?$/.exec(
    splitPath.pathname,
  );
  if (readMethod && timesEchoMatch !== null) {
    await requirePermission(request, env, url, "api:entries:read");
    let prefix: string | undefined;
    let regex: string | undefined;
    try {
      prefix = timesEchoMatch[1] === undefined ? undefined : decodeURIComponent(timesEchoMatch[1]);
      regex = timesEchoMatch[2] === undefined ? undefined : decodeURIComponent(timesEchoMatch[2]);
    } catch {
      throw new ApiError(400, "invalid_query", "times path contains invalid encoding");
    }
    const plan = legacyPatternPlan(prefix, regex);
    const input = legacyEchoInput(url, undefined, undefined);
    const rawFind = input.find;
    const find = typeof rawFind === "object" && rawFind !== null && !Array.isArray(rawFind)
      ? { ...(rawFind as Record<string, unknown>) }
      : {};
    find.dateString = {
      $in: [...plan.patterns],
      ...(plan.prefixes.length === 1 && plan.prefixes[0] !== ".*"
        ? { $regex: `^${plan.prefixes[0]}` }
        : {}),
    };
    input.find = find;
    const params: Record<string, string> = {};
    if (prefix !== undefined) params.prefix = prefix;
    if (regex !== undefined) params.regex = regex;
    const response = await legacyEntryJson({
      req: { params, query: input },
      pattern: plan.patterns,
    });
    return withoutBodyForHead(request, response);
  }

  const timesMatch = /^\/api\/v[12]\/times(?:\/([^/]+))?(?:\/([^/]+))?\/?$/.exec(
    splitPath.pathname,
  );
  if (readMethod && timesMatch !== null) {
    await requirePermission(request, env, url, "api:entries:read");
    let prefix: string | undefined;
    let regex: string | undefined;
    try {
      prefix = timesMatch[1] === undefined ? undefined : decodeURIComponent(timesMatch[1]);
      regex = timesMatch[2] === undefined ? undefined : decodeURIComponent(timesMatch[2]);
    } catch {
      throw new ApiError(400, "invalid_query", "times path contains invalid encoding");
    }
    const plan = legacyPatternPlan(prefix, regex);
    return renderLegacyEntries(
      request,
      await queryLegacyPatternEntries(request, env, url, undefined, plan),
      splitPath.extension,
    );
  }

  const sliceMatch = /^\/api\/v[12]\/slice\/([^/]+)\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?\/?$/.exec(
    splitPath.pathname,
  );
  if (readMethod && sliceMatch !== null) {
    await requirePermission(request, env, url, "api:entries:read");
    let storage: string;
    let field: string;
    let type: string | undefined;
    let prefix: string | undefined;
    let regex: string | undefined;
    try {
      storage = decodeURIComponent(sliceMatch[1]!);
      field = decodeURIComponent(sliceMatch[2]!);
      type = sliceMatch[3] === undefined ? undefined : decodeURIComponent(sliceMatch[3]);
      prefix = sliceMatch[4] === undefined ? undefined : decodeURIComponent(sliceMatch[4]);
      regex = sliceMatch[5] === undefined ? undefined : decodeURIComponent(sliceMatch[5]);
    } catch {
      throw new ApiError(400, "invalid_query", "slice path contains invalid encoding");
    }
    // Locked prep_storage recognizes these three names and falls back to
    // Entries for every other route value.
    const selectedStorage: LegacyUtilityStorage = storage === "treatments"
      ? "treatments"
      : storage === "devicestatus"
        ? "devicestatus"
        : "entries";
    if (field.length === 0 || field.length > 512) {
      throw new ApiError(400, "invalid_query", "slice field must contain from 1 to 512 characters");
    }
    if (type !== undefined && !/^[A-Za-z0-9_-]{1,32}$/.test(type)) {
      throw new ApiError(400, "invalid_entry", "entry model has an invalid format");
    }
    const plan = legacyPatternPlan(prefix, regex);
    if (
      selectedStorage === "entries"
      && field === "dateString"
      && prefix !== undefined
      && prefix.length > 0
    ) {
      return renderLegacyEntries(
        request,
        await queryLegacyPatternEntries(request, env, url, type, plan),
        splitPath.extension,
        type,
      );
    }
    return renderLegacyEntries(
      request,
      await queryLegacyPatternDocuments(
        request,
        env,
        url,
        selectedStorage,
        field,
        type,
        plan,
      ) as unknown as PublicEntry[],
      splitPath.extension,
      type,
    );
  }

  if (
    readMethod &&
    /^\/api\/v[12]\/entries\/current\/?$/.test(splitPath.pathname)
  ) {
    await requirePermission(request, env, url, "api:entries:read");
    const tenant = resolveTenant(request, url);
    return renderLegacyEntries(
      request,
      await env.ENTRY_STORE.getByName(tenant).getCurrent(),
      splitPath.extension,
      "sgv",
    );
  }

  // API v2 mounts the complete v1 router at `/` before registering its
  // additional v2-only endpoints (locked upstream lib/api2/index.js:14-19).
  const match = /^\/api\/v[12]\/entries(?:\/([^/]+))?\/?$/.exec(splitPath.pathname);
  if (match === null) return null;
  const tenant = resolveTenant(request, url);
  const spec = match[1];

  if (request.method === "POST" && spec === "preview") {
    const payload = await readBoundedBody(request);
    await requirePermissions(
      request,
      env,
      url,
      ["api:entries:read", "api:entries:create"],
      payload,
    );
    return legacyEntryJson(legacyEntryPreview(payload));
  }

  if (request.method === "POST" && spec === undefined) {
    const payload = await readBoundedBody(request);
    await requirePermissions(
      request,
      env,
      url,
      ["api:entries:read", "api:entries:create"],
      payload,
    );
    const store = env.ENTRY_STORE.getByName(tenant);
    const entries = parseLegacyEntryPayload(payload);
    const decision = JSON.parse(await store.putEntriesJson(entries)) as
      | { ok: true; result: { entriesJson: string } }
      | { ok: false; message: string };
    if (!decision.ok) {
      return legacyEntryJson({ status: 500, message: "Mongo Error", description: {} }, 500);
    }
    return legacyEntryJson(JSON.parse(decision.result.entriesJson));
  }

  if (readMethod) {
    await requirePermission(request, env, url, "api:entries:read");
    const store = env.ENTRY_STORE.getByName(tenant);
    if (spec !== undefined && /^[a-f\d]{24}$/.test(spec)) {
      // Locked getEntry() bypasses the default count/date window and the
      // formatter always emits an array, even for this single-record route.
      const entries = await store.getEntryById(spec.toLowerCase());
      if (entries.length === 0) {
        return json({
          status: 500,
          message: "Mongo Error",
          description: `No such id: '${spec}'`,
        }, { status: 500 });
      }
      return renderLegacyEntries(request, entries, splitPath.extension, entries[0]?.type);
    }
    const query = parseHistoryQuery(url);
    if (spec !== undefined) query.type = spec;
    let contextLastModified: number | undefined;
    if (spec === undefined) {
      // Locked exact `/entries` runs ifModifiedSinceCTX against the latest
      // runtime SGV before executing its Mongo query. The DO's bounded SGV
      // bucket is the Cloudflare equivalent of ctx.ddata.sgvs.
      const latestSgv = (await store.getSgvEntries(1))[0];
      if (latestSgv !== undefined) {
        const latestTime = legacyEntryTime(latestSgv);
        if (Number.isFinite(latestTime) && latestTime !== 0) {
          contextLastModified = latestTime;
          const ifModifiedSince = request.headers.get("If-Modified-Since");
          if (
            ifModifiedSince !== null
            && latestTime <= Date.parse(ifModifiedSince)
          ) {
            return legacyEntryNotModified(latestTime);
          }
        }
      }
    }
    const decision = JSON.parse(await store.getEntriesJson(query)) as
      | { ok: true; result: PublicEntry[] }
      | { ok: false; status?: number; message: string };
    if (!decision.ok) {
      if (decision.status === 400 || decision.status === 413) {
        throw new ApiError(
          decision.status,
          decision.status === 413 ? "entry_query_limit" : "invalid_query",
          decision.message,
        );
      }
      throw new Error(decision.message);
    }
    return renderLegacyEntries(
      request,
      decision.result,
      splitPath.extension,
      spec ?? query.type ?? undefined,
      contextLastModified,
    );
  }

  if (request.method === "DELETE") {
    const payload = await readBoundedBody(request, true);
    await requirePermissions(
      request,
      env,
      url,
      ["api:entries:read", "api:entries:delete"],
      payload,
    );
    const store = env.ENTRY_STORE.getByName(tenant);
    if (url.searchParams.has("_nscf_batch") && (spec === undefined || spec === "*")) {
      return handleMaintenanceDelete(store, "entries", url);
    }
    const id = spec !== undefined && /^[a-f\d]{24}$/.test(spec);
    const model = spec !== undefined && spec !== "*" && !id
      ? spec
      : null;
    if (model !== null && !/^[A-Za-z0-9_-]{1,32}$/.test(model)) {
      throw new ApiError(400, "invalid_entry", "entry model has an invalid format");
    }
    if (!id) assertSupportedEntryDeleteFilters(url);
    const lte = id ? null : entryDeleteBoundary(url, "find[date][$lte]");
    const gte = id ? null : entryDeleteBoundary(url, "find[date][$gte]");
    const dateString = id ? null : entryDeleteDateString(url);
    const date = id ? null : entryDeleteExactDate(url);
    const dateStringLte = id
      ? null
      : entryDeleteDateStringBoundary(url, "find[dateString][$lte]");
    const dateStringGte = id
      ? null
      : entryDeleteDateStringBoundary(url, "find[dateString][$gte]");
    if (
      !id
      && lte === null
      && gte === null
      && dateString === null
      && date === null
      && dateStringLte === null
      && dateStringGte === null
    ) {
      throw new ApiError(
        400,
        "invalid_query",
        "a date or dateString selector is required for bulk entry deletion",
      );
    }
    const type = id || spec === "*"
      ? null
      : model ?? parseEntryTypeFilter(url);
    const deleted = await store.deleteEntries(
      id ? [spec.toLowerCase()] : [],
      lte,
      gte,
      type,
      dateString,
      date,
      dateStringLte,
      dateStringGte,
    );
    if (deleted < 0) {
      throw new ApiError(
        413,
        "entry_delete_limit",
        "entry deletion exceeds 128 records or stored revisions; narrow the request",
      );
    }
    return legacyMongoDeleteResult(request, deleted);
  }

  return null;
}

interface CollectionRoute {
  requested: "activity" | "food" | "profile" | "profiles" | "treatments" | "devicestatus";
  collection: DocumentCollection;
  segment: string | undefined;
}

function compareLegacyFoodPosition(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  // MongoDB sorts numeric BSON values before strings. Food Editor writes a
  // consistent type per batch, but retaining this boundary avoids silently
  // turning mixed legacy data into JavaScript's string-coercion order.
  if (typeof left === "number") return -1;
  if (typeof right === "number") return 1;
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function legacyFoodRead(documents: JsonDocument[], segment: string | undefined): JsonDocument[] {
  if (segment === "quickpicks") {
    // Locked lib/server/food.js uses exact Mongo equality with the string
    // "false" (Food Editor submits URL-encoded booleans), then position ASC.
    return documents
      .filter((document) => document.type === "quickpick" && document.hidden === "false")
      .sort((left, right) => compareLegacyFoodPosition(left.position, right.position));
  }
  if (segment === "regular") {
    return documents.filter((document) => document.type === "food");
  }
  return documents;
}

function collectionRoute(pathname: string): CollectionRoute | null {
  // API v2 inherits these v1 collection routers unchanged; only the mount
  // prefix differs (locked upstream lib/api2/index.js:14).
  const match = /^\/api\/v[12]\/(activity|food|profile|profiles|treatments|devicestatus)(?:\.json)?(?:\/([^/]+))?\/?$/.exec(
    pathname,
  );
  if (match === null) return null;
  const requested = match[1] as CollectionRoute["requested"];
  return {
    requested,
    collection: requested === "profiles" ? "profile" : (requested as DocumentCollection),
    segment: match[2]?.replace(/\.json$/, ""),
  };
}

function isLegacyCollectionGetRoute(route: CollectionRoute): boolean {
  if (route.requested === "food") {
    return route.segment === undefined || route.segment === "quickpicks" || route.segment === "regular";
  }
  if (route.requested === "profile") {
    return route.segment === undefined || route.segment === "current";
  }
  if (route.requested === "profiles") return route.segment === undefined;
  return route.segment === undefined;
}

function defaultDocumentCount(collection: DocumentCollection, url: URL): number {
  if (collection === "activity") return 5000;
  if (collection === "food") return 5000;
  if (collection === "profile") return 10;
  if (collection === "treatments") return hasFindQuery(url) ? 1000 : 100;
  return 10;
}

function legacyCount(url: URL, defaultCount: number): number {
  const rawCount = url.searchParams.get("count") ?? String(defaultCount);
  const count = Number(rawCount);
  if (!Number.isInteger(count) || count < 1 || count > 10000) {
    throw new ApiError(400, "invalid_query", "count must be an integer from 1 to 10000");
  }
  return count;
}

async function handleCollectionApi(
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response | null> {
  const route = collectionRoute(url.pathname);
  if (route === null) return null;
  const { collection, requested, segment } = route;
  const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));
  const uuidHandling = parseLegacyUuidHandling(env.UUID_HANDLING);

  if (request.method === "GET") {
    if (!isLegacyCollectionGetRoute(route)) return null;
    await requirePermission(request, env, url, `api:${collection}:read`);
    const all = collection === "treatments"
      ? normalizeTreatmentNumbers(parseDocuments(await callUuidAwareRpc(
        uuidHandling,
        "queryLegacyTreatmentsWithUuidHandling",
        () => store.queryLegacyTreatmentsWithUuidHandling(
          JSON.stringify(parseTreatmentQuery(
            url,
            defaultDocumentCount(collection, url),
            uuidHandling,
          )),
          uuidHandling,
        ),
        () => store.queryLegacyTreatments(
          JSON.stringify(parseTreatmentQuery(url, defaultDocumentCount(collection, url), true)),
        ),
      )))
      : parseDocuments(await store.listDocuments(collection));
    if (collection === "profile" && segment === "current") return json(all[0] ?? null);
    // The locked Food storage helpers do not consume request query options.
    // Preserve their all/regular/quickpicks behavior instead of routing Food
    // through the generic Profile/Activity query adapter.
    const filtered = collection === "treatments"
      ? all
      : collection === "food"
        ? legacyFoodRead(all, segment)
        : collection === "profile" && requested === "profile"
          ? all.slice(0, legacyCount(url, defaultDocumentCount(collection, url)))
          : filterDocuments(all, url, defaultDocumentCount(collection, url));
    if (collection === "activity" || collection === "treatments") {
      const lastModified = latestDocumentTime(filtered);
      if (lastModified !== null) {
        const ifModifiedSince = request.headers.get("If-Modified-Since");
        if (
          ifModifiedSince !== null &&
          Number.isFinite(Date.parse(ifModifiedSince)) &&
          lastModified <= Date.parse(ifModifiedSince)
        ) {
          return notModified(lastModified);
        }
        return json(filtered, {
          headers: { "Last-Modified": new Date(lastModified).toUTCString() },
        });
      }
    }
    return json(filtered);
  }

  // The plural Profile route is read-only in locked lib/api/profile/index.js.
  if (requested === "profiles") return null;

  if (request.method === "POST" && segment === undefined) {
    const payload = await readBoundedBody(request);
    await requirePermissions(
      request,
      env,
      url,
      [`api:${collection}:read`, `api:${collection}:create`],
      payload,
    );
    if (Array.isArray(payload) && payload.length === 0) return json([]);
    if (collection !== "treatments") {
      const invalid = findInvalidLegacyObjectId(Array.isArray(payload) ? payload : [payload]);
      if (invalid !== null) return legacyDocumentIdError(invalid.id, true);
    }
    const parsed = parseDocumentPayload(payload, collection, false);
    if (collection === "treatments") {
      const sanitized = parsed.documents.map(sanitizeLegacyTreatmentDocument);
      const created = await callUuidAwareRpc<LegacyTreatmentCreateResult>(
        uuidHandling,
        "createLegacyTreatmentsWithUuidHandling",
        () => store.createLegacyTreatmentsWithUuidHandling(
          JSON.stringify(sanitized),
          uuidHandling,
        ),
        () => store.createLegacyTreatments(JSON.stringify(sanitized)),
      );
      if (!created.ok) throw new ApiError(500, "mongo_error", "Mongo Error");
      return json(parseDocuments(created.value));
    }
    return json(parseDocuments(await store.createDocuments(collection, JSON.stringify(parsed.documents))));
  }

  if (request.method === "PUT" && segment === undefined) {
    if (collection === "devicestatus") return null;
    const payload = await readBoundedBody(request);
    await requirePermissions(
      request,
      env,
      url,
      [`api:${collection}:read`, `api:${collection}:update`],
      payload,
    );
    if (collection === "food" && Array.isArray(payload) && payload.length === 0) return json([]);
    if (collection !== "treatments") {
      const invalid = findInvalidLegacyObjectId(Array.isArray(payload) ? payload : [payload]);
      if (invalid !== null) return legacyDocumentIdError(invalid.id, false);
    }
    const parsed = parseDocumentPayload(payload, collection, false);
    if (collection === "treatments") {
      const saved = parseDocuments(
        await callUuidAwareRpc(
          uuidHandling,
          "saveLegacyTreatmentsWithUuidHandling",
          () => store.saveLegacyTreatmentsWithUuidHandling(
            JSON.stringify(parsed.documents),
            uuidHandling,
          ),
          () => store.saveDocuments(collection, JSON.stringify(parsed.documents)),
        ),
      );
      return json(parsed.inputWasArray ? saved : saved[0]);
    }
    const existing = parsed.documents.filter((document) => typeof document._id === "string");
    const fresh = parsed.documents.filter((document) => typeof document._id !== "string");
    const saved = [
      ...(existing.length === 0
        ? []
        : parseDocuments(await store.saveDocuments(collection, JSON.stringify(existing)))),
      ...(fresh.length === 0
        ? []
        : parseDocuments(await store.createDocuments(collection, JSON.stringify(fresh)))),
    ];
    return json(parsed.inputWasArray || collection === "food" ? saved : saved[0]);
  }

  if (request.method === "DELETE") {
    const payload = await readBoundedBody(request, true);
    await requirePermissions(
      request,
      env,
      url,
      [`api:${collection}:read`, `api:${collection}:delete`],
      payload,
    );
    if ((segment === undefined || segment === "*") && (
      (collection === "profile" && (url.searchParams.has("keep") || (segment === undefined && !hasFindQuery(url))))
      || ((collection === "treatments" || collection === "devicestatus") && url.searchParams.has("_nscf_batch"))
    )) {
      return handleMaintenanceDelete(store, collection as "profile" | "treatments" | "devicestatus", url);
    }
    let selected: JsonDocument[];
    if (segment !== undefined && segment !== "*") {
      if (collection === "treatments" && (OBJECT_ID.test(segment) || UUID.test(segment))) {
        const deleted = await callUuidAwareRpc(
          uuidHandling,
          "deleteLegacyTreatmentWithUuidHandling",
          () => store.deleteLegacyTreatmentWithUuidHandling(segment, uuidHandling),
          () => store.deleteLegacyTreatment(segment),
        );
        return legacyMongoDeleteResult(request, deleted ? 1 : 0);
      }
      if (!isValidLegacyObjectId(segment)) return legacyDocumentIdError(segment, false);
      selected = [{ _id: segment }];
    } else {
      if (segment !== "*" && !hasFindQuery(url)) {
        throw new ApiError(400, "invalid_query", "a find query is required for bulk deletion");
      }
      const available = parseDocuments(await store.listDocuments(collection));
      selected = segment === "*" && !hasFindQuery(url)
        ? available
        : filterDocuments(available, url, 5000);
    }
    const ids = selected
      .map((document) => document._id)
      .filter((id): id is string => typeof id === "string" && OBJECT_ID.test(id));
    const deleted = await store.deleteDocuments(collection, ids);
    if (collection === "activity" || collection === "food" || collection === "profile") {
      return json({});
    }
    if (collection === "treatments") {
      return legacyMongoDeleteResult(request, deleted);
    }
    return json({ n: deleted, ok: 1 });
  }

  return null;
}

async function mergedRoles(store: DurableObjectStub<EntryStore>): Promise<JsonDocument[]> {
  const stored = parseDocuments(await store.listDocuments("roles"));
  const names = new Set(stored.map((role) => role.name).filter((name): name is string => typeof name === "string"));
  const builtins: JsonDocument[] = BUILTIN_AUTHORIZATION_ROLES.map((role) => ({
    name: role.name,
    permissions: [...role.permissions],
  }));
  return [...stored, ...builtins.filter((role) => !names.has(role.name as string))].sort((left, right) =>
    String(left.name).localeCompare(String(right.name)),
  );
}

async function handleMaintenanceDelete(
  store: DurableObjectStub<EntryStore>,
  collection: "entries" | "treatments" | "devicestatus" | "profile",
  url: URL,
): Promise<Response> {
  const isProfile = collection === "profile";
  const field = collection === "entries" ? "date" : "created_at";
  const allowed = new Set(["_nscf_batch", "token", "secret", "tenant", "count", ...(isProfile
    ? ["keep"] : [`find[${field}][$gte]`, `find[${field}][$lte]`])]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "invalid_query", "unsupported or repeated maintenance parameter");
    }
  }
  const batchValue = url.searchParams.get("_nscf_batch");
  if (batchValue !== null && batchValue !== "1") throw new ApiError(400, "invalid_query", "invalid batch mode");
  const keep = isProfile ? Number(url.searchParams.get("keep") ?? "100") : null;
  const boundary = (op: string): number | null => {
    const raw = url.searchParams.get(`find[${field}][$${op}]`);
    if (raw === null || raw.trim() === "") return null;
    return collection === "entries" ? Number(raw) : Date.parse(raw);
  };
  const from = isProfile ? null : boundary("gte");
  const to = isProfile ? null : boundary("lte");
  if (isProfile
    ? !Number.isSafeInteger(keep) || keep! < 10 || keep! > 10000
    : from === null || to === null || !Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    throw new ApiError(400, "invalid_query", isProfile
      ? "keep must be an integer between 10 and 10000" : "a valid inclusive date range is required");
  }
  const result = await store.maintenanceDelete(collection, from, to, keep, batchValue === "1");
  if (result.limited) throw new ApiError(413, "maintenance_delete_limit",
    "Cleanup exceeds the per-request record or revision budget. Use the admin batch tool; a record with over 128 revisions requires separate history cleanup.");
  return json({ n: result.n, deletedCount: result.n, ok: 1, ...(batchValue === "1" ? { more: result.more } : {}) });
}

function publicAuthorizationSubjectMutation(subject: JsonDocument): JsonDocument {
  const result = { ...subject };
  for (const field of Object.keys(result)) {
    if (
      field === "accessToken" ||
      field === "digest" ||
      field === "accessTokenDigest" ||
      field.startsWith("_nscf")
    ) {
      delete result[field];
    }
  }
  return result;
}

function authorizationMongoError(description: string): Response {
  return json(
    { status: 500, message: "Mongo Error", description },
    { status: 500 },
  );
}

async function handleAuthorizationApi(
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response | null> {
  const prefix = "/api/v2/authorization/";
  if (!url.pathname.startsWith(prefix)) return null;
  const path = url.pathname.slice(prefix.length).replace(/\/$/, "");
  const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));

  if (request.method === "GET" && path.startsWith("request/")) {
    const presented = decodeURIComponent(path.slice("request/".length));
    const presentedAllowed = boundedTokenCandidates(presented) !== null;
    const claimsJson = presentedAllowed
      ? await store.verifyAccessJwt(presented)
      : null;
    const credential: PresentedCredential | null = claimsJson === null
      ? null
      : { ...parseAccessJwtClaims(claimsJson), token: presented };
    const authorized = presentedAllowed
      ? await authorizeCredential(
          store,
          credential?.accessToken ?? presented,
          env.AUTH_DEFAULT_ROLES,
          credential,
          true,
        )
      : null;
    return authorized === null
      ? json(
          { status: 401, message: "Unauthorized", description: "Invalid/Missing" },
          { status: 401 },
        )
      : json(authorized);
  }

  if (path === "permissions" || path === "permissions/trie") {
    await requirePermission(request, env, url, "admin:api:permissions:read");
    if (!path.endsWith("/trie")) return json(SEEN_PERMISSIONS);
    const permissions = newTrie();
    permissions.add(...SEEN_PERMISSIONS);
    return json(permissions);
  }

  const match = /^(subjects|roles)(?:\/([^/]+))?$/.exec(path);
  if (match === null) return null;
  const collection = match[1] as "subjects" | "roles";
  const id = match[2];
  const permissionAction = request.method === "GET" && collection === "roles" ? "list" :
    request.method === "GET" ? "read" :
      request.method === "POST" ? "create" :
        request.method === "PUT" ? "update" : "delete";
  const payload = request.method === "POST" || request.method === "PUT"
    ? await readBoundedBody(request)
    : request.method === "DELETE"
      ? await readBoundedBody(request, true)
      : undefined;
  await requirePermission(
    request,
    env,
    url,
    `admin:api:${collection}:${permissionAction}`,
    payload,
  );

  if (request.method === "GET") {
    const subjectsJson = collection === "subjects"
      ? await store.listAuthorizationSubjects()
      : null;
    if (collection === "subjects" && subjectsJson === null) {
      throw new Error("authorization subject limit exceeded");
    }
    return json(
      collection === "roles"
        ? await mergedRoles(store)
        : parseDocuments(subjectsJson!),
    );
  }
  if (request.method === "POST" && id === undefined) {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return authorizationMongoError("Authorization document must be a single object");
    }
    const parsed = parseDocumentPayload(payload, collection, false);
    const serialized = JSON.stringify(parsed.documents);
    const subjectMutation = collection === "subjects"
      ? await store.createAuthorizationSubjects(serialized)
      : null;
    if (subjectMutation !== null && !subjectMutation.ok) {
      return authorizationMongoError(subjectMutation.error);
    }
    const created = parseDocuments(subjectMutation?.value ??
      await store.createDocuments(collection, serialized));
    const response = collection === "subjects"
      ? created.map(publicAuthorizationSubjectMutation)
      : created;
    return json(parsed.inputWasArray ? response : response[0]);
  }
  if (request.method === "PUT" && id === undefined) {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return authorizationMongoError("Missing _id for update");
    }
    const rawId = (payload as Record<string, unknown>)._id;
    if (rawId === undefined || rawId === null || rawId === "") {
      return authorizationMongoError("Missing _id for update");
    }
    if (typeof rawId !== "string" || !OBJECT_ID.test(rawId)) {
      return authorizationMongoError(`Invalid _id format: ${String(rawId)}`);
    }
    const parsed = parseDocumentPayload(payload, collection, true);
    const serialized = JSON.stringify(parsed.documents);
    const subjectMutation = collection === "subjects"
      ? await store.saveAuthorizationSubjects(serialized)
      : null;
    if (subjectMutation !== null && !subjectMutation.ok) {
      return authorizationMongoError(subjectMutation.error);
    }
    const saved = parseDocuments(subjectMutation?.value ??
      await store.saveDocuments(collection, serialized));
    const response = collection === "subjects"
      ? saved.map(publicAuthorizationSubjectMutation)
      : saved;
    return json(parsed.inputWasArray ? response : response[0]);
  }
  if (request.method === "DELETE" && id !== undefined) {
    if (!OBJECT_ID.test(id)) throw new ApiError(400, "invalid_document", "invalid document id");
    await store.deleteDocuments(collection, [id]);
    return json({});
  }
  return null;
}

function api3VersionInfo(): Record<string, unknown> {
  return {
    version: "15.0.8",
    apiVersion: "3.0.5",
    srvDate: Date.now(),
    storage: {
      storage: "sqlite-durable-object",
      version: "managed",
    },
  };
}

function api3Error(status: number, message: string): Response {
  return json(
    { status, message },
    { status, ...(status === 406 ? { headers: { Vary: "Accept" } } : {}) },
  );
}

async function handleApi3Status(
  authorized: AuthorizedSubject,
): Promise<Response> {
  let permissions = "";
  for (const [action, abbreviation] of [
    ["create", "c"],
    ["read", "r"],
    ["update", "u"],
    ["delete", "d"],
  ] as const) {
    if (
      permissionGroupsAllow(
        authorized.permissionGroups,
        `api:undefined:${action}`,
      )
    ) {
      permissions += abbreviation;
    }
  }

  const apiPermissions: Record<string, string> = {};
  if (permissions !== "") {
    for (const collection of API3_COLLECTIONS) {
      apiPermissions[collection] = permissions;
    }
  }

  return json({
    status: 200,
    result: {
      ...api3VersionInfo(),
      // Upstream v15.0.7 passes the property name from `for...in` to
      // permsForCol instead of the collection descriptor. Its permission
      // check therefore uses the literal `api:undefined:<action>` for every
      // collection. Preserve that locked-release behavior instead of silently
      // substituting the intended per-collection check from the Swagger.
      apiPermissions,
    },
  });
}

type Api3Authentication =
  | {
    ok: true;
    authorized: AuthorizedSubject;
    store: DurableObjectStub<EntryStore>;
  }
  | { ok: false; response: Response };

async function authenticateApi3(
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Api3Authentication> {
  const bearer = bearerToken(request, true);
  if (bearer === null) {
    return { ok: false, response: api3Error(401, "Missing or bad access token or JWT") };
  }
  const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));
  const ip = requestRemoteIp(request);
  await waitForAuthorizationDelay(store, ip);
  if (boundedTokenCandidates(bearer) === null) {
    await store.authorizationFailed(ip, Date.now(), configuredAuthFailDelay(env));
    return { ok: false, response: api3Error(401, "Bad access token or JWT") };
  }

  const claimsJson = await store.verifyAccessJwt(bearer);
  if (claimsJson === null) {
    await store.authorizationFailed(ip, Date.now(), configuredAuthFailDelay(env));
    return { ok: false, response: api3Error(401, "Bad access token or JWT") };
  }
  const claims = parseAccessJwtClaims(claimsJson);
  const authorized = await authorizeCredential(
    store,
    claims.accessToken,
    env.AUTH_DEFAULT_ROLES,
    { ...claims, token: bearer },
  );
  if (authorized === null) {
    await store.authorizationFailed(ip, Date.now(), configuredAuthFailDelay(env));
    return { ok: false, response: api3Error(401, "Bad access token or JWT") };
  }
  await store.authorizationSucceeded(ip);
  return { ok: true, authorized, store };
}

async function handleApi(request: Request, env: AppEnv, url: URL): Promise<Response> {
  const isApi3 = url.pathname === "/api/v3" || url.pathname.startsWith("/api/v3/");
  let api3Pathname = url.pathname;
  let api3ExtensionMimeType: string | undefined;
  if (isApi3) {
    const parserFailure = await api3BodyParserFailure(request.clone());
    if (parserFailure !== null) return parserFailure;
    const split = splitApi3Extension(url.pathname);
    api3Pathname = split.pathname;
    if (split.extension !== undefined) {
      const extensionMimeType = mime.getType(split.extension);
      if (extensionMimeType === null) {
        return withoutBodyForHead(
          request,
          api3Error(406, "Unsupported output format requested"),
        );
      }
      api3ExtensionMimeType = extensionMimeType;
    }
  }

  const statusMatch = /^\/api\/v[12]\/status(?:\/|\.(json|html|txt|png|svg|js|csv|tsv))?$/i.exec(
    url.pathname,
  );
  const statusExtension = statusMatch?.[1];
  const statusExtensionHasLockedCase = statusExtension === undefined
    || statusExtension === "json"
    || statusExtension === "html"
    || statusExtension === "txt"
    || statusExtension === "png"
    || statusExtension === "svg"
    || statusExtension === "js"
    || statusExtension === "csv"
    || statusExtension === "tsv";
  if (
    (request.method === "GET" || request.method === "HEAD")
    && statusMatch !== null
    && statusExtensionHasLockedCase
  ) {
    await requirePermission(
      request,
      env,
      url,
      "api:status:read",
    );
    const extension = statusExtension;
    if (extension === "csv" || extension === "tsv") {
      return statusNotAcceptable(request);
    }
    const format: StatusFormat | null = extension === undefined
      ? negotiatedStatusFormat(request)
      : extension === "txt"
        ? "text"
        : extension as StatusFormat;
    if (format === null) {
      return statusNotAcceptable(request);
    }
    const status = await statusForRequest(env, url);
    return withoutBodyForHead(
      request,
      renderStatus(request, status, format, extension !== undefined),
    );
  }

  if (isStatusFinalhandlerPath(url.pathname)) {
    if (/^\/api\/v[12]\/status/i.test(url.pathname)) {
      await requirePermission(request, env, url, "api:status:read");
    }
    return expressFinalNotFound(request, url);
  }

  if (request.method === "OPTIONS") {
    const headers = new Headers(corsHeaders());
    headers.set("Cache-Control", "no-store");
    headers.set("Content-Type", "text/plain; charset=utf-8");
    return new Response("OK", { status: 200, headers });
  }

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/api/versions") {
    return withoutBodyForHead(request, json([
      { version: "1.0.0", url: "/api/v1" },
      { version: "2.0.0", url: "/api/v2" },
      { version: "3.0.5", url: "/api/v3" },
    ]));
  }

  if ((request.method === "GET" || request.method === "HEAD") && api3Pathname === "/api/v3/version") {
    resolveTenant(request, url);
    return withoutBodyForHead(request, json({
      status: 200,
      result: api3VersionInfo(),
    }));
  }

  if ((request.method === "GET" || request.method === "HEAD") && api3Pathname === "/api/v3/status") {
    const authentication = await authenticateApi3(request, env, url);
    const response = authentication.ok
      ? await handleApi3Status(authentication.authorized)
      : authentication.response;
    return withoutBodyForHead(request, response);
  }

  if ((request.method === "GET" || request.method === "HEAD") && api3Pathname === "/api/v3/lastModified") {
    const authentication = await authenticateApi3(request, env, url);
    const response = authentication.ok
      ? await handleApi3LastModified(authentication.store, authentication.authorized)
      : authentication.response;
    return withoutBodyForHead(request, response);
  }

  const matchedTreatmentRoute = matchApi3TreatmentRoute(request.method, api3Pathname);
  const matchedDeviceStatusRoute = matchApi3DeviceStatusRoute(request.method, api3Pathname);
  const matchedEntriesRoute = matchApi3EntriesRoute(request.method, api3Pathname);
  const matchedFoodRoute = matchApi3FoodRoute(request.method, api3Pathname);
  const matchedProfileRoute = matchApi3ProfileRoute(request.method, api3Pathname);
  const matchedSettingsRoute = matchApi3SettingsRoute(request.method, api3Pathname);
  const matchedApi3Route = matchedTreatmentRoute === null
    ? matchedDeviceStatusRoute === null
      ? matchedEntriesRoute === null
        ? matchedFoodRoute === null
          ? matchedProfileRoute === null
            ? matchedSettingsRoute === null
              ? null
              : { route: matchedSettingsRoute, collection: "settings" as const }
            : { route: matchedProfileRoute, collection: "profile" as const }
          : { route: matchedFoodRoute, collection: "food" as const }
        : { route: matchedEntriesRoute, collection: "entries" as const }
      : { route: matchedDeviceStatusRoute, collection: "devicestatus" as const }
    : { route: matchedTreatmentRoute, collection: "treatments" as const };
  const api3CollectionRoute: Api3CollectionRoute | null =
    matchedApi3Route === null || api3ExtensionMimeType === undefined
      ? matchedApi3Route?.route ?? null
      : { ...matchedApi3Route.route, extension: api3ExtensionMimeType };
  if (matchedApi3Route !== null && api3CollectionRoute !== null) {
    const authentication = await authenticateApi3(request, env, url);
    if (!authentication.ok) {
      return withoutBodyForHead(request, authentication.response);
    }
    const api3MaxLimit = normalizeApi3MaxLimit(env.API3_MAX_LIMIT);
    const response = matchedApi3Route.collection === "treatments"
      ? handleApi3Treatments(
        request,
        url,
        authentication.store,
        authentication.authorized,
        api3CollectionRoute,
        api3MaxLimit,
      )
      : matchedApi3Route.collection === "devicestatus"
        ? handleApi3DeviceStatus(
          request,
          url,
          authentication.store,
          authentication.authorized,
          api3CollectionRoute,
          api3MaxLimit,
        )
        : matchedApi3Route.collection === "entries"
          ? handleApi3Entries(
            request,
            url,
            authentication.store,
            authentication.authorized,
            api3CollectionRoute,
            api3MaxLimit,
          )
          : matchedApi3Route.collection === "food"
            ? handleApi3Food(
              request,
              url,
              authentication.store,
              authentication.authorized,
              api3CollectionRoute,
              api3MaxLimit,
            )
            : matchedApi3Route.collection === "profile"
              ? handleApi3Profile(
                request,
                url,
                authentication.store,
                authentication.authorized,
                api3CollectionRoute,
                api3MaxLimit,
              )
              : handleApi3Settings(
                request,
                url,
                authentication.store,
                authentication.authorized,
                api3CollectionRoute,
                api3MaxLimit,
              );
    return withoutBodyForHead(request, await response);
  }

  if (isApi3) {
    return withoutBodyForHead(request, api3Error(404, "Bad operation or collection"));
  }

  if (
    request.method === "POST"
    && /^\/api\/v[12]\/alexa\/?$/.test(url.pathname)
  ) {
    const payload = await readBoundedBody(request);
    await requirePermission(request, env, url, "api:*:read", payload);
    const alexaRequest = typeof payload === "object"
        && payload !== null
        && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).request
      : undefined;
    const requestRecord = typeof alexaRequest === "object"
        && alexaRequest !== null
        && !Array.isArray(alexaRequest)
      ? alexaRequest as Record<string, unknown>
      : {};

    if (requestRecord.type === "SessionEndedRequest") return json("");

    if (requestRecord.type === "LaunchRequest" && requestRecord.intent === undefined) {
      const launch = "What would you like to check on Nightscout?";
      return json(legacyAlexaSpeechletResponse(
        "Welcome to Nightscout",
        launch,
        launch,
        false,
      ));
    }

    return json(legacyAlexaSpeechletResponse(
      "Unknown Intent",
      "I'm sorry, I don't know what you're asking for.",
      "",
      true,
    ));
  }

  const ddataRoute = /^\/api\/v2\/ddata\/at(?:\/([^/]+))?\/?$/.exec(url.pathname);
  if (request.method === "GET" && ddataRoute !== null) {
    await requirePermissions(
      request,
      env,
      url,
      ["api:entries:read", "api:treatments:read"],
    );
    const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));
    const now = Date.now();
    let at = now;
    if (ddataRoute[1] !== undefined) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(ddataRoute[1]);
      } catch {
        throw new ApiError(400, "invalid_query", "ddata frame time is invalid");
      }
      const numeric = Number(decoded);
      at = Number.isFinite(numeric) ? numeric : Date.parse(decoded);
      if (!Number.isFinite(at)) {
        throw new ApiError(400, "invalid_query", "ddata frame time is invalid");
      }
    }
    // Locked ddata_at reuses the live cache inside five minutes; older/future
    // explicit frames run a two-day bounded load ending at the requested time.
    const frame = ddataRoute[1] !== undefined && Math.abs(at - now) >= 5 * 60_000;
    const [snapshotJson, statusJson] = await Promise.all([
      store.getDdataSnapshotJson(at, frame),
      store.nightscoutHttpStatus(now),
    ]);
    const snapshot = JSON.parse(snapshotJson) as TreatmentCurveData;
    const status = JSON.parse(statusJson) as {
      settings?: { units?: unknown; enable?: unknown };
    };
    const enabled = Array.isArray(status.settings?.enable)
      ? status.settings.enable
      : [];
    fitTreatmentsToBgCurve(snapshot, {
      units: status.settings?.units,
      rawBgEnabled: enabled.includes("rawbg"),
    });
    return json(snapshot);
  }

  const propertiesRoute = /^\/api\/v2\/properties(?:\/.*)?$/.test(url.pathname);
  if (request.method === "GET" && propertiesRoute) {
    await requirePermissions(
      request,
      env,
      url,
      ["api:entries:read", "api:treatments:read"],
    );
    const tenant = resolveTenant(request, url);
    // The upstream sandbox derives enabled plugin properties from ddata. Use a
    // bounded DO projection containing SGVs, calibrations, recent device
    // status, database stats, the official 2.5-day Treatment window, current
    // Profile and one latest row per age-event type rather than materializing
    // unrelated food or long-range Treatment history.
    const store = env.ENTRY_STORE.getByName(tenant);
    const now = Date.now();
    const [context, status] = await Promise.all([
      loadPluginPropertyContext(store, now),
      store.nightscoutHttpStatus(now).then((value) => JSON.parse(value) as {
        settings?: { units?: unknown; enable?: unknown };
        extendedSettings?: Record<string, unknown>;
        runtimeState?: unknown;
      }),
    ]);
    const units: NightscoutGlucoseUnits = status.settings?.units === "mmol"
      ? "mmol"
      : "mg/dl";
    const enabled = new Set(
      Array.isArray(status.settings?.enable)
        ? status.settings.enable.filter((value): value is string => typeof value === "string")
        : [],
    );
    const properties = calculatePluginProperties(
      context,
      units,
      now,
      enabled,
      status.extendedSettings ?? {},
      status.settings ?? {},
      status.runtimeState,
    );
    let result = properties;
    const rawSelection = url.pathname
      .slice("/api/v2/properties".length)
      .split("/")
      .find((segment) => segment.length > 0);
    if (rawSelection !== undefined) {
      let decodedSelection: string;
      try {
        decodedSelection = decodeURIComponent(rawSelection);
      } catch {
        throw new ApiError(400, "invalid_query", "properties selection is invalid");
      }
      const selected = decodedSelection.split(",").filter((property) => property.length > 0);
      if (selected.length > 0) {
        result = Object.fromEntries(
          selected
            .filter((property) => Object.prototype.hasOwnProperty.call(properties, property))
            .map((property) => [property, properties[property]]),
        );
      }
    }
    // Express only enables the indented form for a truthy query value.
    const pretty = Boolean(url.searchParams.get("pretty"));
    return json(result, {}, pretty ? 2 : undefined);
  }

  if (request.method === "GET" && /^\/api\/v2\/summary\/?$/.test(url.pathname)) {
    await requirePermission(request, env, url, "api:*:read");
    const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));
    const now = Date.now();
    const [snapshotJson, context, statusJson] = await Promise.all([
      store.getDdataSnapshotJson(now, false),
      loadPluginPropertyContext(store, now),
      store.nightscoutHttpStatus(now),
    ]);
    const status = JSON.parse(statusJson) as {
      settings?: { units?: unknown; enable?: unknown };
      extendedSettings?: Record<string, unknown>;
      runtimeState?: unknown;
    };
    const units: NightscoutGlucoseUnits = status.settings?.units === "mmol"
      ? "mmol"
      : "mg/dl";
    const enabled = new Set(
      Array.isArray(status.settings?.enable)
        ? status.settings.enable.filter((value): value is string => typeof value === "string")
        : [],
    );
    const properties = calculatePluginProperties(
      context,
      units,
      now,
      enabled,
      status.extendedSettings ?? {},
      status.settings ?? {},
      status.runtimeState,
    );
    const snapshot = JSON.parse(snapshotJson);
    const hours = url.searchParams.get("hours") || 6;
    return json(buildNightscoutSummary(snapshot, hours, now, properties));
  }

  if (
    request.method === "POST"
    && /^\/api\/v2\/notifications\/loop\/?$/.test(url.pathname)
  ) {
    const payload = await readBoundedBody(request);
    await requirePermission(
      request,
      env,
      url,
      "notifications:loop:push",
      payload,
    );
    const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));
    const profiles = parseDocuments(await store.listDocuments("profile"));
    try {
      const prepared = prepareLoopPush(
        payload,
        requestRemoteIp(request),
        profiles,
        {
          apnsKey: env.LOOP_APNS_KEY,
          apnsKeyId: env.LOOP_APNS_KEY_ID,
          developerTeamId: env.LOOP_DEVELOPER_TEAM_ID,
          pushServerEnvironment: env.LOOP_PUSH_SERVER_ENVIRONMENT,
        },
        Date.now(),
      );
      await sendPreparedLoopPush(prepared);
      return legacyOk();
    } catch (error) {
      return legacyLoopNotificationError(
        error instanceof LoopPushError
          ? error.message
          : "APNs delivery failed: Unknown error",
      );
    }
  }

  if (
    request.method === "GET"
    && /^\/api\/v[12]\/notifications\/ack\/?$/.test(url.pathname)
  ) {
    await requirePermission(request, env, url, "notifications:*:ack");
    if (env.ENTRY_STORE === undefined) {
      throw new ApiError(
        503,
        "entry_store_not_configured",
        "ENTRY_STORE must be configured before notification acknowledgements are enabled",
      );
    }
    // Locked v15.0.7 uses Number(req.query.level), defaults an empty group,
    // and lets notifications.ack() replace every falsy time with 30 minutes.
    // The DO adapter accepts the ordinary bounded level/group domain and keeps
    // malformed authenticated requests as the upstream route's 200 no-op.
    const rawLevel = url.searchParams.get("level");
    const rawTime = url.searchParams.get("time");
    await env.ENTRY_STORE.getByName(resolveTenant(request, url)).acknowledgeAlarmNotification(
      Number(rawLevel === null ? undefined : rawLevel),
      url.searchParams.get("group") || "default",
      rawTime === null || rawTime === "" ? 0 : Number(rawTime),
    );
    // Express res.sendStatus(200) returns this exact text body.
    return legacyOk();
  }

  if (
    request.method === "POST"
    && /^\/api\/v[12]\/notifications\/pushovercallback\/?$/.test(url.pathname)
  ) {
    if (env.ENTRY_STORE === undefined) {
      throw new ApiError(
        503,
        "entry_store_not_configured",
        "ENTRY_STORE must be configured before Pushover callbacks are enabled",
      );
    }
    const payload = await readBoundedBody(request);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return legacyInternalError();
    }
    const accepted = await env.ENTRY_STORE.getByName(resolveTenant(request, url))
      .acknowledgePushoverReceipt(JSON.stringify(payload), Date.now());
    // Locked v15.0.7 leaves provider callbacks unauthenticated: only a
    // short-lived, previously persisted receipt can acknowledge an alarm.
    return accepted
      ? legacyOk()
      : legacyInternalError();
  }

  if (
    request.method === "GET"
    && /^\/api\/v[12]\/experiments\/test\/?$/.test(url.pathname)
  ) {
    // Locked lib/api/experiments/index.js intentionally exposes only this
    // authorization probe. Keep it behind the exact upstream permission and
    // inherit it through both v1 and v2 without adding a general experiments
    // surface.
    await requirePermission(request, env, url, "authorization:debug:test");
    return json({ status: "ok" });
  }

  if (request.method === "GET" && /^\/api\/v[12]\/verifyauth\/?$/.test(url.pathname)) {
    const resolution = await resolveRequestAuthorization(request, env, url);
    const permissionGroups = env.ENTRY_STORE === undefined
      ? resolution.admin ? [["*"]] : []
      : await permissionGroupsForResolution(
        resolution,
        env.ENTRY_STORE.getByName(resolveTenant(request, url)),
        env,
      );
    const canRead = permissionGroupsAllow(permissionGroups, "*:*:read");
    const canWrite = permissionGroupsAllow(permissionGroups, "*:*:write");
    const isAdmin = permissionGroupsAllow(permissionGroups, "*:*:admin");
    return json({
      status: 200,
      message: {
        canRead,
        canWrite,
        isAdmin,
        permissions: resolution.defaults ? "DEFAULT" : "ROLE",
        rolefound: resolution.authorized === null ? "NOTFOUND" : "FOUND",
        message: canRead && !resolution.defaults ? "OK" : "UNAUTHORIZED",
      },
    });
  }

  if (request.method === "GET" && /^\/api\/v[12]\/adminnotifies\/?$/.test(url.pathname)) {
    // Locked adminnotifies is public but still resolves credentials so a bad
    // explicit secret participates in the shared failure delay-list.
    const resolution = await resolveRequestAuthorization(request, env, url);
    if (env.ENTRY_STORE === undefined) {
      return json({ message: { notifies: [], notifyCount: 0 } });
    }
    const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));
    const permissionGroups = await permissionGroupsForResolution(resolution, store, env);
    const notifies = parseDocuments(await store.listAdminNotifications(Date.now()));
    return json({
      message: {
        notifies: permissionGroupsAllow(permissionGroups, "*:*:admin") ? notifies : [],
        notifyCount: notifies.length,
      },
    });
  }

  const entriesResponse = await handleEntriesApi(request, env, url);
  if (entriesResponse !== null) return entriesResponse;

  const collectionResponse = await handleCollectionApi(request, env, url);
  if (collectionResponse !== null) return collectionResponse;

  const authorizationResponse = await handleAuthorizationApi(request, env, url);
  if (authorizationResponse !== null) return authorizationResponse;

  return json(
    {
      error: {
        code: "not_found",
        message: "API route not implemented by the current compatibility adapter",
      },
    },
    { status: 404 },
  );
}

async function handlePebble(
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new ApiError(405, "method_not_allowed", "Pebble accepts GET and HEAD");
  }
  if (env.ENTRY_STORE === undefined) {
    throw new ApiError(
      503,
      "entry_store_not_configured",
      "ENTRY_STORE must be configured before Pebble data can be served",
    );
  }
  await requirePermission(request, env, url, "api:pebble,entries:read");
  const store = env.ENTRY_STORE.getByName(resolveTenant(request, url));
  const now = Date.now();
  const [context, statusJson] = await Promise.all([
    loadPluginPropertyContext(store, now),
    store.nightscoutHttpStatus(now),
  ]);
  const status = JSON.parse(statusJson) as {
    settings?: { units?: unknown; enable?: unknown };
    extendedSettings?: Record<string, unknown>;
    runtimeState?: unknown;
  };
  const enabled = new Set(
    Array.isArray(status.settings?.enable)
      ? status.settings.enable.filter((value): value is string => typeof value === "string")
      : [],
  );
  const requestedUnits = url.searchParams.get("units") || status.settings?.units;
  const units: NightscoutGlucoseUnits = requestedUnits === "mmol" ? "mmol" : "mg/dl";
  const parsedCount = Number.parseInt(url.searchParams.get("count") ?? "", 10) || 1;
  const count = Math.max(1, Math.min(1_000, parsedCount));
  // Locked pebble.js invokes BWP whenever IOB output is requested, even when
  // BWP is not independently enabled in the server plugin list.
  const pebbleEnabled = new Set(enabled);
  if (enabled.has("iob")) pebbleEnabled.add("bwp");
  const properties = calculatePluginProperties(
    context,
    units,
    now,
    pebbleEnabled,
    status.extendedSettings ?? {},
    status.settings ?? {},
    status.runtimeState,
  );
  const response = buildNightscoutPebbleResponse(context, {
    now,
    count,
    mmol: units === "mmol",
    rawbg: enabled.has("rawbg"),
    iob: enabled.has("iob"),
    cob: enabled.has("cob"),
    properties,
  });
  return withoutBodyForHead(request, json(response));
}

async function handleNscfConnectStatus(
  request: Request,
  env: AppEnv,
  url: URL,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json(
      { error: { code: "method_not_allowed", message: "Method not allowed" } },
      { status: 405, headers: { "Allow": "GET, HEAD" } },
    );
  }
  if (env.DEXCOM_SHARE_CONNECTOR === undefined) {
    throw new ApiError(
      503,
      "dexcom_share_connector_not_configured",
      "DEXCOM_SHARE_CONNECTOR must be configured before connector status can be served",
    );
  }
  await requirePermission(
    request,
    env,
    url,
    "admin:api:permissions:read",
  );
  const tenant = resolveTenant(request, url);
  if (tenant !== DEFAULT_TENANT) {
    throw new ApiError(
      404,
      "dexcom_share_connector_not_available",
      "Dexcom Share connector is available only for the default tenant",
    );
  }
  const body = await env.DEXCOM_SHARE_CONNECTOR
    .getByName(tenant)
    .statusJson(tenant);
  return withoutBodyForHead(
    request,
    new Response(body, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      },
    }),
  );
}

function bootstrapDexcomShareConnector(
  request: Request,
  env: AppEnv,
  url: URL,
  ctx: ExecutionContext | undefined,
): void {
  if (request.method !== "GET" && request.method !== "HEAD") return;
  if (
    url.pathname !== "/"
    && url.pathname !== "/admin"
    && url.pathname !== "/admin/"
  ) {
    return;
  }
  if (!resolveDexcomShareConfig(env).enabled) return;
  if (ctx === undefined) return;
  const tenant = resolveTenant(request, url);
  if (tenant !== DEFAULT_TENANT) return;
  ctx.waitUntil(
    env.DEXCOM_SHARE_CONNECTOR
      .getByName(tenant)
      .reconcile(tenant)
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            message: "Dexcom Share connector bootstrap failed",
            tenant,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }),
  );
}

const application = {
  async fetch(
    request: Request,
    env: AppEnv,
    ctx?: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    try {
      const secretConfigurationError = validateApiSecretConfiguration(request, env, url);
      if (secretConfigurationError !== null) return secretConfigurationError;
      bootstrapDexcomShareConnector(request, env, url, ctx);
      if (url.pathname === "/healthz") {
        return json({ status: "ok", upstream: "v15.0.8", storage: "sqlite-durable-object" });
      }
      if (url.pathname === "/pebble" || url.pathname === "/pebble/") {
        return await handlePebble(request, env, url);
      }
      if (url.pathname === "/_nscf/connect/status") {
        return await handleNscfConnectStatus(request, env, url);
      }
      if (url.pathname === "/socket.io" || url.pathname === "/socket.io/") {
        const tenant = resolveTenant(request, url);
        return await handleSocketIo(
          request,
          url,
          env.ENTRY_STORE.getByName(tenant),
        );
      }
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }
      const platformPage = await servePlatformPage(request, env, url);
      if (platformPage !== null) return platformPage;
      return withUtf8Charset(await env.ASSETS.fetch(request));
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401 && error.code === "unauthorized") {
          return json(
            { status: 401, message: "Unauthorized", description: "Invalid/Missing" },
            { status: 401 },
          );
        }
        return json({ error: { code: error.code, message: error.message } }, { status: error.status });
      }
      if (isDurableObjectWriteQuotaError(error) || isDurableObjectReadQuotaError(error)) {
        if (url.pathname === "/socket.io" || url.pathname === "/socket.io/") {
          return storageQuotaEngineError();
        }
        return withoutBodyForHead(
          request,
          json(
            {
              error: {
                code: isDurableObjectReadQuotaError(error)
                  ? "storage_read_quota_exceeded" : "storage_write_quota_exceeded",
                message: isDurableObjectReadQuotaError(error)
                  ? "Storage reads are temporarily unavailable until the next daily reset"
                  : "Storage writes are temporarily unavailable until the next daily reset",
              },
            },
            {
              status: 503,
              headers: {
                "Retry-After": String(
                  durableObjectWriteQuotaRetryAfterSeconds(),
                ),
              },
            },
          ),
        );
      }
      console.error(
        JSON.stringify({
          message: "unhandled request error",
          path: safeLogPath(url.pathname),
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return json({ error: { code: "internal_error", message: "Internal server error" } }, { status: 500 });
    }
  },
} satisfies ExportedHandler<AppEnv>;

export default {
  async fetch(request: Request, env: AppEnv, ctx?: ExecutionContext): Promise<Response> {
    const response = await application.fetch(request, env, ctx);
    // Preserve the WebSocket upgrade object; no HTML can be embedded here.
    if (response.status === 101 || !["false", "off"].includes(String(env.ALLOW_UNRESTRICTED_FRAME_EMBEDDING).toLowerCase())) return response;
    const secured = new Response(response.body, response);
    secured.headers.set("X-Frame-Options", "SAMEORIGIN");
    secured.headers.set("Content-Security-Policy", "frame-ancestors 'self'");
    return secured;
  },
} satisfies ExportedHandler<AppEnv>;
