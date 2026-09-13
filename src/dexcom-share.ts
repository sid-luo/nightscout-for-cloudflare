import { parseEntryPayload, type ValidatedEntry } from "./model";

const DEXCOM_APPLICATION_ID = "d89443d2-327c-4a6f-89e5-496bbb0317db";
const DEXCOM_USER_AGENT =
  'nightscout-connect, nightscout-connect@0.0.13, "Dexcom Share", https://github.com/nightscout/nightscout-connect';
const DEXCOM_TIMEOUT_MS = 15_000;
const DEXCOM_MAX_RESPONSE_BYTES = 256 * 1_024;
const DEXCOM_MAX_RECORDS = 576;
const DEXCOM_MAX_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1_000;
const DEXCOM_READING_INTERVAL_MS = 5 * 60 * 1_000;
const DEXCOM_READING_DELAY_MS = 18_000;
const DEXCOM_STALE_RETRY_MS = 2.5 * 60 * 1_000;
const DEXCOM_SESSION_REFRESH_MS = 23 * 60 * 60 * 1_000 + 50 * 60 * 1_000;
const DEXCOM_STATE_VERSION = 1;

const DEXCOM_HOSTS = {
  us: "https://share2.dexcom.com",
  ous: "https://shareous1.dexcom.com",
} as const;

const DEXCOM_TRENDS = [
  "NONE",
  "DoubleUp",
  "SingleUp",
  "FortyFiveUp",
  "Flat",
  "FortyFiveDown",
  "SingleDown",
  "DoubleDown",
  "NOT COMPUTABLE",
  "RATE OUT OF RANGE",
] as const;

export type DexcomShareRegion = keyof typeof DEXCOM_HOSTS;
export type DexcomShareConfigurationError =
  | "missing_source"
  | "unsupported_source"
  | "missing_credentials"
  | "unsupported_region"
  | "invalid_server";

export interface DexcomShareEnvironment {
  ENABLE?: string;
  CONNECT_SOURCE?: string;
  CONNECT_SHARE_ACCOUNT_NAME?: string;
  CONNECT_SHARE_PASSWORD?: string;
  CONNECT_SHARE_REGION?: string;
  CONNECT_SHARE_SERVER?: string;
  BRIDGE_USER_NAME?: string;
  BRIDGE_PASSWORD?: string;
  BRIDGE_SERVER?: string;
  BRIDGE_USE_LEGACY?: string;
  BRIDGE_DEXCOM_BRIDGE_USE_LEGACY?: string;
  DEXCOM_BRIDGE_USE_LEGACY?: string;
  CUSTOMCONNSTR_DEXCOM_BRIDGE_USE_LEGACY?: string;
  BRIDGE_INTERVAL?: string;
  BRIDGE_MINUTES?: string;
}

export type DexcomShareConfig =
  | {
      enabled: false;
      state: "disabled";
    }
  | {
      enabled: false;
      state: "configuration_error";
      error: DexcomShareConfigurationError;
    }
  | {
      enabled: true;
      source: "dexcomshare";
      region: DexcomShareRegion;
      baseUrl: string;
      accountName: string;
      password: string;
      bridgeMode?: "migrated" | "legacy";
      legacyInterval?: number;
      legacyMinutes?: number;
    };

export type DexcomShareErrorCode =
  | "timeout"
  | "network_error"
  | "http_error"
  | "authentication_failed"
  | "session_invalid"
  | "protocol_error"
  | "response_too_large"
  | "internal_error";

export interface DexcomSharePersistedState {
  version: 1;
  configFingerprint: string;
  sessionId: string | null;
  sessionCreatedAt: number | null;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastEntryAt: number | null;
  consecutiveFailures: number;
  lastErrorCode: DexcomShareErrorCode | null;
}

export interface DexcomShareCycleResult {
  state: DexcomSharePersistedState;
  status: DexcomSharePublicStatus;
  validatedEntries: ValidatedEntry[];
  nextDueAt: number;
}

export interface DexcomSharePublicStatus {
  enabled: boolean;
  source: "dexcomshare" | null;
  region: DexcomShareRegion | null;
  state:
    | "disabled"
    | "configuration_error"
    | "idle"
    | "ok"
    | "backoff";
  configurationError?: DexcomShareConfigurationError;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastEntryAt: number | null;
  consecutiveFailures: number;
  lastErrorCode: DexcomShareErrorCode | null;
  nextAttemptAt: number | null;
}

interface DexcomGlucoseValue {
  WT?: unknown;
  Trend?: unknown;
  Value?: unknown;
}

interface DexcomShareEntry {
  sgv: number;
  date: number;
  dateString: string;
  trend: number;
  direction: string;
  device: "nightscout-connect" | "share2";
  type: "sgv";
}

interface DexcomSession {
  id: string;
  createdAt: number;
}

export class DexcomShareError extends Error {
  constructor(readonly code: DexcomShareErrorCode) {
    super(code);
    this.name = "DexcomShareError";
  }
}

function enabledFeatures(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(/[\s,]+/)
      .map((feature) => feature.trim().toLowerCase())
      .filter((feature) => feature.length > 0),
  );
}

export function resolveDexcomShareConfig(
  env: DexcomShareEnvironment,
): DexcomShareConfig {
  const bridge = Boolean(env.BRIDGE_USER_NAME && env.BRIDGE_PASSWORD);
  const legacy = bridge && [env.BRIDGE_USE_LEGACY, env.BRIDGE_DEXCOM_BRIDGE_USE_LEGACY,
    env.DEXCOM_BRIDGE_USE_LEGACY, env.CUSTOMCONNSTR_DEXCOM_BRIDGE_USE_LEGACY]
    .some(value => value?.toLowerCase() === "true");
  if (!enabledFeatures(env.ENABLE).has("connect") && !bridge) {
    return { enabled: false, state: "disabled" };
  }
  const source = legacy ? "dexcomshare" : env.CONNECT_SOURCE?.trim().toLowerCase() || (bridge ? "dexcomshare" : "");
  if (source === undefined || source.length === 0) {
    return {
      enabled: false,
      state: "configuration_error",
      error: "missing_source",
    };
  }
  if (source !== "dexcomshare") {
    return {
      enabled: false,
      state: "configuration_error",
      error: "unsupported_source",
    };
  }
  const accountName = (legacy ? env.BRIDGE_USER_NAME : env.CONNECT_SHARE_ACCOUNT_NAME || env.BRIDGE_USER_NAME)?.trim() ?? "";
  const password = (legacy ? env.BRIDGE_PASSWORD : env.CONNECT_SHARE_PASSWORD || env.BRIDGE_PASSWORD) ?? "";
  if (
    accountName.length === 0
    || accountName.length > 1_024
    || password.length === 0
    || password.length > 1_024
  ) {
    return {
      enabled: false,
      state: "configuration_error",
      error: "missing_credentials",
    };
  }
  const bridgeServer = (!env.CONNECT_SHARE_REGION && !env.CONNECT_SHARE_SERVER || legacy) ? env.BRIDGE_SERVER : undefined;
  const rawRegion = (!legacy && env.CONNECT_SHARE_REGION?.trim().toLowerCase()) || (bridgeServer?.toUpperCase() === "EU" ? "ous" : "us");
  if (rawRegion !== "us" && rawRegion !== "ous") {
    return {
      enabled: false,
      state: "configuration_error",
      error: "unsupported_region",
    };
  }
  const server = legacy ? bridgeServer : env.CONNECT_SHARE_SERVER || bridgeServer;
  let baseUrl: string = DEXCOM_HOSTS[rawRegion];
  if (server && server.toUpperCase() !== "EU") {
    // A host only, as in upstream CONNECT_SHARE_SERVER. No URL credentials,
    // path or scheme may redirect a configured Dexcom password elsewhere.
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(server)) {
      return { enabled: false, state: "configuration_error", error: "invalid_server" };
    }
    baseUrl = `https://${server.toLowerCase()}`;
  }
  const interval = Number(env.BRIDGE_INTERVAL) || 156_000;
  return {
    enabled: true,
    source: "dexcomshare",
    region: rawRegion,
    baseUrl,
    accountName,
    password,
    ...(bridge ? { bridgeMode: legacy ? "legacy" as const : "migrated" as const } : {}),
    ...(legacy ? {
      legacyInterval: interval >= 1_000 && interval <= 300_000 ? interval : 156_000,
      legacyMinutes: Math.max(5, Math.min(2880, Number(env.BRIDGE_MINUTES) || 1440)),
    } : {}),
  };
}

function safeIntegerOrNull(value: unknown): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function isDexcomShareErrorCode(value: unknown): value is DexcomShareErrorCode {
  return value === "timeout"
    || value === "network_error"
    || value === "http_error"
    || value === "authentication_failed"
    || value === "session_invalid"
    || value === "protocol_error"
    || value === "response_too_large"
    || value === "internal_error";
}

export function initialDexcomShareState(
  configFingerprint: string,
): DexcomSharePersistedState {
  return {
    version: DEXCOM_STATE_VERSION,
    configFingerprint,
    sessionId: null,
    sessionCreatedAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastEntryAt: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
  };
}

export function parseDexcomShareState(
  value: unknown,
  configFingerprint: string,
): DexcomSharePersistedState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return initialDexcomShareState(configFingerprint);
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== DEXCOM_STATE_VERSION
    || record.configFingerprint !== configFingerprint
  ) {
    return initialDexcomShareState(configFingerprint);
  }
  const sessionId = typeof record.sessionId === "string"
    && record.sessionId.length > 0
    && record.sessionId.length <= 1_024
    ? record.sessionId
    : null;
  const failures = Number(record.consecutiveFailures);
  return {
    version: DEXCOM_STATE_VERSION,
    configFingerprint,
    sessionId,
    sessionCreatedAt: sessionId === null
      ? null
      : safeIntegerOrNull(record.sessionCreatedAt),
    lastAttemptAt: safeIntegerOrNull(record.lastAttemptAt),
    lastSuccessAt: safeIntegerOrNull(record.lastSuccessAt),
    lastEntryAt: safeIntegerOrNull(record.lastEntryAt),
    consecutiveFailures: Number.isSafeInteger(failures) && failures >= 0
      ? Math.min(1_000_000, failures)
      : 0,
    lastErrorCode: isDexcomShareErrorCode(record.lastErrorCode)
      ? record.lastErrorCode
      : null,
  };
}

export async function dexcomShareConfigFingerprint(
  config: Extract<DexcomShareConfig, { enabled: true }>,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify(config),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function publicStatus(
  config: DexcomShareConfig,
  state: DexcomSharePersistedState | null,
  nextAttemptAt: number | null,
): DexcomSharePublicStatus {
  if (!config.enabled) {
    if (config.state === "configuration_error") {
      return {
        enabled: false,
        source: null,
        region: null,
        state: "configuration_error",
        configurationError: config.error,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastEntryAt: null,
        consecutiveFailures: 0,
        lastErrorCode: null,
        nextAttemptAt: null,
      };
    }
    return {
      enabled: false,
      source: null,
      region: null,
      state: "disabled",
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastEntryAt: null,
      consecutiveFailures: 0,
      lastErrorCode: null,
      nextAttemptAt: null,
    };
  }
  return {
    enabled: true,
    source: "dexcomshare",
    region: config.region,
    state: state === null || state.lastAttemptAt === null
      ? "idle"
      : state.consecutiveFailures > 0
        ? "backoff"
        : "ok",
    lastAttemptAt: state?.lastAttemptAt ?? null,
    lastSuccessAt: state?.lastSuccessAt ?? null,
    lastEntryAt: state?.lastEntryAt ?? null,
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    lastErrorCode: state?.lastErrorCode ?? null,
    nextAttemptAt,
  };
}

export function dexcomSharePublicStatus(
  config: DexcomShareConfig,
  state: DexcomSharePersistedState | null,
  nextAttemptAt: number | null,
): DexcomSharePublicStatus {
  return publicStatus(config, state, nextAttemptAt);
}

async function boundedResponseText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > DEXCOM_MAX_RESPONSE_BYTES) {
    throw new DexcomShareError("response_too_large");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > DEXCOM_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new DexcomShareError("response_too_large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function responseIndicatesSessionFailure(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes("session")
    && (
      normalized.includes("invalid")
      || normalized.includes("notfound")
      || normalized.includes("not found")
      || normalized.includes("expired")
    );
}

function responseIndicatesAuthenticationFailure(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes("password")
    || normalized.includes("accountnotfound")
    || normalized.includes("account not found")
    || normalized.includes("authenticateaccount");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new DexcomShareError("protocol_error");
  }
}

function requiredResponseString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) {
    throw new DexcomShareError("protocol_error");
  }
  return value;
}

function requiredAccountId(value: unknown): string {
  if (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && "accountId" in value
  ) {
    return requiredResponseString(
      (value as Record<string, unknown>).accountId,
    );
  }
  return requiredResponseString(value);
}

function trendNumber(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value >= 0 && value < DEXCOM_TRENDS.length) return value;
    return 0;
  }
  if (typeof value !== "string") return 0;
  const normalized = value.replaceAll(/[\s_-]/g, "").toLowerCase();
  const index = DEXCOM_TRENDS.findIndex(
    (trend) => trend.replaceAll(/[\s_-]/g, "").toLowerCase() === normalized,
  );
  return index < 0 ? 0 : index;
}

function dexcomTimestamp(value: unknown): number {
  if (typeof value !== "string") throw new DexcomShareError("protocol_error");
  const match = /^\/Date\((-?\d+)/.exec(value);
  if (match === null) throw new DexcomShareError("protocol_error");
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new DexcomShareError("protocol_error");
  }
  return timestamp;
}

export function mapDexcomShareGlucose(value: unknown): DexcomShareEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DexcomShareError("protocol_error");
  }
  const record = value as DexcomGlucoseValue;
  const date = dexcomTimestamp(record.WT);
  const sgv = Number(record.Value);
  if (!Number.isInteger(sgv) || sgv <= 0 || sgv > 1_000) {
    throw new DexcomShareError("protocol_error");
  }
  const trend = trendNumber(record.Trend);
  return {
    sgv,
    date,
    dateString: new Date(date).toISOString(),
    trend,
    direction: DEXCOM_TRENDS[trend]!,
    device: "nightscout-connect",
    type: "sgv",
  };
}

export class DexcomShareClient {
  constructor(
    private readonly config: Extract<DexcomShareConfig, { enabled: true }>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async post(
    path: string,
    query: Record<string, string>,
    body: Record<string, unknown>,
    phase: "authentication" | "session" | "read",
  ): Promise<unknown> {
    const url = new URL(path, this.config.baseUrl);
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, value);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEXCOM_TIMEOUT_MS);
    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(url.toString(), {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
          "User-Agent": this.config.bridgeMode === "legacy" ? "share2nightscout-bridge/0.2.12" : DEXCOM_USER_AGENT,
        },
        body: phase === "read" && this.config.bridgeMode === "legacy" ? "" : JSON.stringify(body),
        redirect: "manual",
        signal: controller.signal,
      });
      // Keep the timeout active until the bounded response body is consumed.
      // A server that sends headers and then stalls must not pin the Durable
      // Object indefinitely.
      text = await boundedResponseText(response);
    } catch (error) {
      if (
        controller.signal.aborted
        || (error instanceof DOMException && error.name === "AbortError")
      ) {
        throw new DexcomShareError("timeout");
      }
      if (error instanceof DexcomShareError) throw error;
      throw new DexcomShareError("network_error");
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      if (
        phase === "read"
        && (
          response.status === 400
          || response.status === 401
          || responseIndicatesSessionFailure(text)
        )
      ) {
        throw new DexcomShareError("session_invalid");
      }
      if (
        phase !== "read"
        && (
          response.status === 400
          || response.status === 401
          || responseIndicatesAuthenticationFailure(text)
        )
      ) {
        throw new DexcomShareError("authentication_failed");
      }
      throw new DexcomShareError("http_error");
    }
    if (phase === "read" && responseIndicatesSessionFailure(text)) {
      throw new DexcomShareError("session_invalid");
    }
    return parseJson(text);
  }

  async createSession(now: number): Promise<DexcomSession> {
    const application: Record<string, string> = this.config.bridgeMode === "legacy" ? {} : { applicationId: DEXCOM_APPLICATION_ID };
    const accountId = requiredAccountId(await this.post(
      "/ShareWebServices/Services/General/AuthenticatePublisherAccount",
      application,
      {
        password: this.config.password,
        applicationId: DEXCOM_APPLICATION_ID,
        accountName: this.config.accountName,
      },
      "authentication",
    ));
    const sessionId = requiredResponseString(await this.post(
      "/ShareWebServices/Services/General/LoginPublisherAccountById",
      application,
      {
        password: this.config.password,
        applicationId: DEXCOM_APPLICATION_ID,
        accountId,
      },
      "session",
    ));
    return { id: sessionId, createdAt: now };
  }

  async read(sessionId: string, minutes: number, maxCount: number): Promise<DexcomShareEntry[]> {
    const boundedCount = Math.max(1, Math.min(DEXCOM_MAX_RECORDS, Math.trunc(maxCount)));
    const boundedMinutes = Math.max(5, Math.min(
      2 * 24 * 60,
      Math.trunc(minutes),
    ));
    const value = await this.post(
      "/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues",
      {
        sessionID: sessionId,
        minutes: String(boundedMinutes),
        maxCount: String(boundedCount),
      },
      {},
      "read",
    );
    if (!Array.isArray(value) || value.length > DEXCOM_MAX_RECORDS) {
      throw new DexcomShareError("protocol_error");
    }
    return value.map(item => {
      const entry = mapDexcomShareGlucose(item);
      return this.config.bridgeMode === "legacy" ? { ...entry, device: "share2" } : entry;
    });
  }
}

function retryDelay(code: DexcomShareErrorCode, failures: number): number {
  const exponent = Math.min(8, Math.max(0, failures - 1));
  if (code === "authentication_failed") {
    return Math.min(6 * 60 * 60 * 1_000, 30 * 60 * 1_000 * (2 ** exponent));
  }
  return Math.min(60 * 60 * 1_000, DEXCOM_STALE_RETRY_MS * (2 ** exponent));
}

function nextSuccessDueAt(now: number, latestEntryAt: number | null): number {
  if (latestEntryAt === null) return now + DEXCOM_STALE_RETRY_MS;
  const expected = latestEntryAt + DEXCOM_READING_INTERVAL_MS + DEXCOM_READING_DELAY_MS;
  return expected > now + 5_000 ? expected : now + DEXCOM_STALE_RETRY_MS;
}

function normalizedCycleError(error: unknown): DexcomShareErrorCode {
  return error instanceof DexcomShareError ? error.code : "network_error";
}

export async function runDexcomShareCycle(options: {
  config: Extract<DexcomShareConfig, { enabled: true }>;
  configFingerprint: string;
  state: DexcomSharePersistedState;
  now: number;
  latestLocalEntryAt: number | null;
  fetcher?: typeof fetch;
}): Promise<DexcomShareCycleResult> {
  const now = Number.isSafeInteger(options.now) && options.now >= 0
    ? options.now
    : Date.now();
  const client = new DexcomShareClient(options.config, options.fetcher ?? fetch);
  let session: DexcomSession | null = options.config.bridgeMode !== "legacy" && options.state.sessionId !== null
      && options.state.sessionCreatedAt !== null
      && now - options.state.sessionCreatedAt < DEXCOM_SESSION_REFRESH_MS
    ? { id: options.state.sessionId, createdAt: options.state.sessionCreatedAt }
    : null;
  try {
    if (session === null) session = await client.createSession(now);
    const highWater = Math.max(
      options.state.lastEntryAt ?? 0,
      options.latestLocalEntryAt ?? 0,
      now - (options.config.bridgeMode === "legacy" ? options.config.legacyMinutes! * 60_000 : DEXCOM_MAX_LOOKBACK_MS),
    );
    const maxCount = Math.max(1, Math.min(
      DEXCOM_MAX_RECORDS,
      Math.ceil((now - highWater) / DEXCOM_READING_INTERVAL_MS),
    ));
    let values: DexcomShareEntry[];
    try {
      values = await client.read(session.id, maxCount * 5, maxCount);
    } catch (error) {
      if (!(error instanceof DexcomShareError) || error.code !== "session_invalid") {
        throw error;
      }
      session = await client.createSession(now);
      values = await client.read(session.id, maxCount * 5, maxCount);
    }
    const unique = new Map<number, DexcomShareEntry>();
    for (const value of values) {
      if (value.date > highWater && value.date <= now + DEXCOM_READING_INTERVAL_MS) {
        unique.set(value.date, value);
      }
    }
    const entries = [...unique.values()].sort((left, right) => left.date - right.date);
    const validatedEntries = parseEntryPayload(entries);
    const newestSchedulable = values.reduce<number | null>((latest, entry) => {
      if (
        entry.date < now - DEXCOM_MAX_LOOKBACK_MS
        || entry.date > now + DEXCOM_READING_INTERVAL_MS
      ) {
        return latest;
      }
      const schedulableDate = Math.min(entry.date, now);
      return latest === null || schedulableDate > latest ? schedulableDate : latest;
    }, null);
    const lastEntryAt = entries.length === 0
      ? options.state.lastEntryAt
      : entries[entries.length - 1]!.date;
    const state: DexcomSharePersistedState = {
      version: DEXCOM_STATE_VERSION,
      configFingerprint: options.configFingerprint,
      sessionId: session.id,
      sessionCreatedAt: session.createdAt,
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastEntryAt,
      consecutiveFailures: 0,
      lastErrorCode: null,
    };
    const nextDueAt = options.config.bridgeMode === "legacy" ? now + options.config.legacyInterval! : nextSuccessDueAt(
      now,
      newestSchedulable ?? highWater,
    );
    return {
      state,
      status: publicStatus(options.config, state, nextDueAt),
      validatedEntries,
      nextDueAt,
    };
  } catch (error) {
    const code = normalizedCycleError(error);
    const failures = Math.min(1_000_000, options.state.consecutiveFailures + 1);
    const clearSession = code === "authentication_failed" || code === "session_invalid";
    const state: DexcomSharePersistedState = {
      ...options.state,
      version: DEXCOM_STATE_VERSION,
      configFingerprint: options.configFingerprint,
      sessionId: clearSession ? null : session?.id ?? null,
      sessionCreatedAt: clearSession ? null : session?.createdAt ?? null,
      lastAttemptAt: now,
      consecutiveFailures: failures,
      lastErrorCode: code,
    };
    const nextDueAt = now + retryDelay(code, failures);
    return {
      state,
      status: publicStatus(options.config, state, nextDueAt),
      validatedEntries: [],
      nextDueAt,
    };
  }
}
