import {
  apiSecretDigestMatches,
  authorizationDefaultRoleNames,
  authorizationPermissionGroups,
  authorizationRoleNames,
  boundedTokenCandidates,
  type PresentedToken,
  type RequestCredentials,
} from "./authorization";
import { permissionGroupsAllow } from "./permissions";

export interface AuthorizedSubject {
  token: string;
  sub: string;
  permissionGroups: string[][];
  iat: number;
  exp: number;
}

interface AccessJwtClaims { accessToken: string; iat: number; exp: number }
export interface PresentedCredential extends AccessJwtClaims { token: string | null }

export interface AuthorizationResolution {
  admin: boolean;
  authorized: AuthorizedSubject | null;
  defaults: boolean;
  permissionGroups?: string[][];
  statusAuthorized?: AuthorizedSubject | null;
}

export interface HttpAuthorizationRequest {
  credentials: RequestCredentials;
  ip: string;
  configuredSecret: string | null;
  defaultRoles?: string;
  failDelayMs: number;
  api3?: boolean;
  statusCredential?: PresentedToken | null;
}

export interface AuthorizationBackend {
  authorizationDelay(ip: string, now: number): Promise<number>;
  authorizationSucceeded(ip: string): Promise<void>;
  authorizationFailed(ip: string, now: number, delayMs: number): Promise<void>;
  resolveAuthorizationSubject(candidatesJson: string): Promise<string | null>;
  listDocuments(collection: "roles"): Promise<string>;
  verifyAccessJwt(token: string): Promise<string | null>;
  issueAccessJwt(token: string): Promise<string>;
}

export function parseAccessJwtClaims(value: string): AccessJwtClaims {
  const parsed = JSON.parse(value) as Partial<AccessJwtClaims> | null;
  if (parsed === null || typeof parsed !== "object" || typeof parsed.accessToken !== "string"
    || !Number.isInteger(parsed.iat) || !Number.isInteger(parsed.exp)) {
    throw new Error("Durable Object returned invalid JWT claims");
  }
  return parsed as AccessJwtClaims;
}

function parseAuthorizedSubject(value: string): AuthorizedSubject {
  const parsed = JSON.parse(value) as Partial<AccessJwtClaims & { token: string }> | null;
  if (parsed === null || typeof parsed !== "object" || typeof parsed.token !== "string"
    || typeof parsed.accessToken !== "string" || !Number.isInteger(parsed.iat) || !Number.isInteger(parsed.exp)) {
    throw new Error("Durable Object returned an invalid issued JWT");
  }
  return { token: parsed.token, sub: "", permissionGroups: [], iat: parsed.iat!, exp: parsed.exp! };
}

export async function authorizeCredential(
  store: AuthorizationBackend,
  accessTokens: PresentedToken,
  configuredDefaultRoles: string | undefined,
  credential: PresentedCredential | null = null,
  refreshJwt = false,
): Promise<AuthorizedSubject | null> {
  const candidates = boundedTokenCandidates(accessTokens);
  if (candidates === null) return null;
  const subjectJson = await store.resolveAuthorizationSubject(JSON.stringify(candidates));
  if (subjectJson === null) return null;
  const subject = JSON.parse(subjectJson) as Record<string, unknown>;
  if (typeof subject.name !== "string" || typeof subject.accessToken !== "string") return null;
  const storedRoles = JSON.parse(await store.listDocuments("roles"));
  const names = authorizationRoleNames(subject.roles, configuredDefaultRoles);
  const authorization = credential !== null && credential.token !== null && !refreshJwt
    ? { token: credential.token, sub: subject.name, permissionGroups: [], iat: credential.iat, exp: credential.exp }
    : { ...parseAuthorizedSubject(await store.issueAccessJwt(subject.accessToken)), sub: subject.name };
  authorization.permissionGroups = authorizationPermissionGroups(names, storedRoles);
  return authorization;
}

async function resolveTokenCredential(
  store: AuthorizationBackend,
  credentials: RequestCredentials,
  configuredDefaultRoles: string | undefined,
): Promise<{ authorized: AuthorizedSubject | null; attempted: boolean }> {
  if (credentials.token === null || credentials.tokenSource === null) return { authorized: null, attempted: false };
  const candidates = boundedTokenCandidates(credentials.token);
  if (candidates === null) return { authorized: null, attempted: credentials.tokenSource === "bearer" };
  if (credentials.tokenSource === "bearer") {
    const bearer = candidates.length === 1 ? candidates[0]! : null;
    if (bearer === null) return { authorized: null, attempted: true };
    const claimsJson = await store.verifyAccessJwt(bearer);
    if (claimsJson === null) return { authorized: null, attempted: true };
    const claims = parseAccessJwtClaims(claimsJson);
    return { authorized: await authorizeCredential(store, claims.accessToken, configuredDefaultRoles,
      { ...claims, token: bearer }), attempted: true };
  }
  if (candidates.length === 1) {
    const claimsJson = await store.verifyAccessJwt(candidates[0]!);
    if (claimsJson !== null) {
      const claims = parseAccessJwtClaims(claimsJson);
      const authorized = await authorizeCredential(store, claims.accessToken, configuredDefaultRoles, null, true);
      return { authorized, attempted: authorized !== null };
    }
  }
  const authorized = await authorizeCredential(store, candidates, configuredDefaultRoles, null, true);
  // Invalid opaque query/body tokens fall back to defaults in the locked API.
  return { authorized, attempted: authorized !== null };
}

export async function statusQueryAuthorization(
  store: AuthorizationBackend,
  presented: PresentedToken | null,
  defaultRoles: string | undefined,
): Promise<AuthorizedSubject | null> {
  if (presented === null || boundedTokenCandidates(presented) === null) return null;
  if (Array.isArray(presented)) return authorizeCredential(store, presented, defaultRoles);
  const claimsJson = await store.verifyAccessJwt(presented);
  return authorizeCredential(store, claimsJson === null ? presented : parseAccessJwtClaims(claimsJson).accessToken, defaultRoles);
}

/** A single request owns these memoized reads; no roles or credentials survive it. */
function requestBackend(source: AuthorizationBackend): AuthorizationBackend {
  const subjects = new Map<string, Promise<string | null>>();
  const verified = new Map<string, Promise<string | null>>();
  let roles: Promise<string> | undefined;
  const once = (cache: Map<string, Promise<string | null>>, key: string, load: () => Promise<string | null>) => {
    let value = cache.get(key);
    if (value === undefined) { value = load(); cache.set(key, value); }
    return value;
  };
  return {
    authorizationDelay: (ip, now) => source.authorizationDelay(ip, now),
    authorizationSucceeded: (ip) => source.authorizationSucceeded(ip),
    authorizationFailed: (ip, now, delayMs) => source.authorizationFailed(ip, now, delayMs),
    resolveAuthorizationSubject: (key) => once(subjects, key, () => source.resolveAuthorizationSubject(key)),
    listDocuments: () => roles ??= source.listDocuments("roles"),
    verifyAccessJwt: (key) => once(verified, key, () => source.verifyAccessJwt(key)),
    issueAccessJwt: (token) => source.issueAccessJwt(token),
  };
}

/** Keep the failure-delay gate before all credential/role reads, including on the DO. */
export async function resolveHttpAuthorization(
  source: AuthorizationBackend,
  input: HttpAuthorizationRequest,
): Promise<AuthorizationResolution> {
  const delay = await source.authorizationDelay(input.ip, Date.now());
  if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delay, 60_000)));
  const store = requestBackend(source);
  const { credentials, ip } = input;
  let resolution: AuthorizationResolution;
  if (!input.api3 && await apiSecretDigestMatches(
    typeof credentials.apiSecret === "string" ? credentials.apiSecret : null, input.configuredSecret,
  )) {
    await store.authorizationSucceeded(ip);
    resolution = { admin: true, authorized: null, defaults: false };
  } else {
    const token = await resolveTokenCredential(store, credentials, input.defaultRoles);
    if (token.authorized !== null) {
      await store.authorizationSucceeded(ip);
      resolution = { admin: false, authorized: token.authorized, defaults: false };
    } else if (!input.api3 && credentials.apiSecret !== null) {
      const subject = await authorizeCredential(store, credentials.apiSecret, input.defaultRoles, null, true);
      if (subject !== null) await store.authorizationSucceeded(ip);
      else await store.authorizationFailed(ip, Date.now(), input.failDelayMs);
      resolution = { admin: false, authorized: subject, defaults: false };
    } else {
      if (token.attempted || input.api3) await store.authorizationFailed(ip, Date.now(), input.failDelayMs);
      resolution = { admin: false, authorized: null, defaults: !input.api3 && !token.attempted };
    }
  }
  resolution.permissionGroups = resolution.admin ? [["*"]]
    : resolution.authorized !== null ? resolution.authorized.permissionGroups
      : resolution.defaults ? authorizationPermissionGroups(
        authorizationDefaultRoleNames(input.defaultRoles), JSON.parse(await store.listDocuments("roles")),
      ) : [];
  if (input.statusCredential !== undefined && permissionGroupsAllow(resolution.permissionGroups, "api:status:read")) {
    // Only the separately selected query credential determines status.authorized.
    resolution.statusAuthorized = await statusQueryAuthorization(store, input.statusCredential, input.defaultRoles);
  }
  return resolution;
}
