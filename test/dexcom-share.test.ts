import { describe, expect, it, vi } from "vitest";
import {
  DexcomShareClient,
  dexcomShareConfigFingerprint,
  mapDexcomShareGlucose,
  resolveDexcomShareConfig,
  runDexcomShareCycle,
  type DexcomShareConfig,
  type DexcomShareEnvironment,
  type DexcomSharePersistedState,
} from "../src/dexcom-share";

const NOW = Date.parse("2026-07-27T08:00:00.000Z");
const ACCOUNT = "parent@example.test";
const PASSWORD = "not-a-public-value";
const SESSION = "private-session-id";
const US_HOST = "share2.dexcom.com";
const OUS_HOST = "shareous1.dexcom.com";
const RESPONSE_LIMIT = 256 * 1_024;
const MAX_RECORDS = 576;
const BASE_RETRY_MS = 150_000;
const ENVIRONMENT: DexcomShareEnvironment = {
  ENABLE: "connect",
  CONNECT_SOURCE: "dexcomshare",
  CONNECT_SHARE_ACCOUNT_NAME: ACCOUNT,
  CONNECT_SHARE_PASSWORD: PASSWORD,
};

type ReadyConfig = Extract<DexcomShareConfig, { enabled: true }>;

interface RequestSnapshot {
  url: string;
  method: string;
  body: string;
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function glucose(date: number, value = 110, trend: number | string = 4): unknown {
  return {
    WT: `/Date(${date})/`,
    ST: `/Date(${date})/`,
    DT: `/Date(${date})/`,
    Value: value,
    Trend: trend,
  };
}

function scriptedFetch(
  handlers: Array<(request: Request) => Response | Promise<Response>>,
): { fetch: typeof fetch; requests: RequestSnapshot[] } {
  const requests: RequestSnapshot[] = [];
  let index = 0;
  const implementation = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      method: request.method,
      body: await request.clone().text(),
    });
    const handler = handlers[index];
    index += 1;
    if (handler === undefined) throw new Error("unexpected fetch");
    return handler(request);
  };
  return {
    fetch: implementation as typeof fetch,
    requests,
  };
}

function readyConfig(environment = ENVIRONMENT): ReadyConfig {
  const resolution = resolveDexcomShareConfig(environment);
  if (!resolution.enabled) throw new Error("expected ready config");
  return resolution;
}

async function reusableState(
  config = readyConfig(),
  sessionId = SESSION,
): Promise<DexcomSharePersistedState> {
  return {
    version: 1,
    configFingerprint: await dexcomShareConfigFingerprint(config),
    sessionId,
    sessionCreatedAt: NOW - 60_000,
    lastAttemptAt: NOW - 60_000,
    lastSuccessAt: NOW - 60_000,
    lastEntryAt: NOW - 5 * 60_000,
    consecutiveFailures: 0,
    lastErrorCode: null,
  };
}

async function runWith(
  config: ReadyConfig,
  state: DexcomSharePersistedState,
  fetcher: typeof fetch,
  latestLocalEntryAt: number | null = state.lastEntryAt,
) {
  return runDexcomShareCycle({
    config,
    configFingerprint: await dexcomShareConfigFingerprint(config),
    state,
    now: NOW,
    latestLocalEntryAt,
    fetcher,
  });
}

function dates(result: Awaited<ReturnType<typeof runDexcomShareCycle>>): number[] {
  return result.validatedEntries.map((entry) =>
    (JSON.parse(entry.documentJson) as { date: number }).date);
}

describe("Dexcom Share configuration", () => {
  it("migrates complete BRIDGE credentials and EU server without mutating configuration", () => {
    const env = { BRIDGE_USER_NAME: ACCOUNT, BRIDGE_PASSWORD: PASSWORD, BRIDGE_SERVER: "EU" };
    expect(readyConfig(env)).toMatchObject({ bridgeMode: "migrated", region: "ous", baseUrl: `https://${OUS_HOST}`, accountName: ACCOUNT });
    expect(Object.keys(env)).toHaveLength(3);
    expect(readyConfig({ ...env, ...ENVIRONMENT })).toMatchObject({ accountName: ACCOUNT, bridgeMode: "migrated" });
    expect(readyConfig({ ...env, ...ENVIRONMENT, CONNECT_SHARE_REGION: "us" }).baseUrl).toBe(`https://${US_HOST}`);
    expect(resolveDexcomShareConfig({ ...env, ENABLE: "connect", CONNECT_SOURCE: "nightscout" })).toMatchObject({ error: "unsupported_source" });
    expect(resolveDexcomShareConfig({ BRIDGE_USER_NAME: ACCOUNT })).toMatchObject({ state: "disabled" });
  });

  it("explicit Connect credentials and server win over automatic BRIDGE migration", async () => {
    const config = readyConfig({ ...ENVIRONMENT, CONNECT_SHARE_SERVER: "share.example.test", BRIDGE_USER_NAME: "old", BRIDGE_PASSWORD: "old", BRIDGE_SERVER: "EU" });
    expect(config).toMatchObject({ accountName: ACCOUNT, password: PASSWORD, baseUrl: "https://share.example.test" });
    expect(await dexcomShareConfigFingerprint(config)).not.toBe(await dexcomShareConfigFingerprint(readyConfig()));
    for (const server of ['https://example.test', 'user@host.test', 'host.test/path', '127.0.0.1']) {
      expect(resolveDexcomShareConfig({ ...ENVIRONMENT, CONNECT_SHARE_SERVER: server })).toMatchObject({ error: "invalid_server" });
    }
  });

  it("legacy opt-in uses BRIDGE credentials and the bounded legacy poll settings", () => {
    const config = readyConfig({ ...ENVIRONMENT, BRIDGE_USER_NAME: "old", BRIDGE_PASSWORD: "old-password", BRIDGE_SERVER: "EU", DEXCOM_BRIDGE_USE_LEGACY: "true", BRIDGE_INTERVAL: "9000" });
    expect(config).toMatchObject({ accountName: "old", password: "old-password", bridgeMode: "legacy", legacyInterval: 9000, legacyMinutes: 1440, baseUrl: `https://${OUS_HOST}` });
  });
  it("requires the connect gate, explicit source and both credentials", () => {
    expect(resolveDexcomShareConfig({})).toEqual({
      enabled: false,
      state: "disabled",
    });
    expect(resolveDexcomShareConfig({
      ...ENVIRONMENT,
      ENABLE: "iob pump",
    })).toEqual({
      enabled: false,
      state: "disabled",
    });
    expect(resolveDexcomShareConfig({
      ENABLE: "connect",
      CONNECT_SHARE_ACCOUNT_NAME: ACCOUNT,
      CONNECT_SHARE_PASSWORD: PASSWORD,
    })).toEqual({
      enabled: false,
      state: "configuration_error",
      error: "missing_source",
    });
    expect(resolveDexcomShareConfig({
      ...ENVIRONMENT,
      CONNECT_SOURCE: "other",
    })).toEqual({
      enabled: false,
      state: "configuration_error",
      error: "unsupported_source",
    });
    expect(resolveDexcomShareConfig({
      ...ENVIRONMENT,
      CONNECT_SHARE_ACCOUNT_NAME: "",
    })).toMatchObject({
      enabled: false,
      state: "configuration_error",
      error: "missing_credentials",
    });
    expect(resolveDexcomShareConfig({
      ...ENVIRONMENT,
      CONNECT_SHARE_PASSWORD: "",
    })).toMatchObject({
      enabled: false,
      state: "configuration_error",
      error: "missing_credentials",
    });
  });

  it("maps only the official us and ous regions", () => {
    expect(readyConfig()).toMatchObject({
      region: "us",
      baseUrl: `https://${US_HOST}`,
    });
    expect(readyConfig({
      ...ENVIRONMENT,
      CONNECT_SHARE_REGION: "ous",
    })).toMatchObject({
      region: "ous",
      baseUrl: `https://${OUS_HOST}`,
    });
    expect(resolveDexcomShareConfig({
      ...ENVIRONMENT,
      CONNECT_SHARE_REGION: "eu",
    })).toEqual({
      enabled: false,
      state: "configuration_error",
      error: "unsupported_region",
    });
  });
});

describe("Dexcom Share HTTP contract", () => {
  it("legacy fallback executes the bridge protocol, fresh login and legacy entry provenance", async () => {
    const config = readyConfig({ BRIDGE_USER_NAME: ACCOUNT, BRIDGE_PASSWORD: PASSWORD, DEXCOM_BRIDGE_USE_LEGACY: "true" });
    const mock = scriptedFetch([
      request => { expect(request.headers.get('User-Agent')).toBe('share2nightscout-bridge/0.2.12'); return json('account-id'); },
      () => json('new-session'),
      () => json([glucose(NOW - 60_000)]),
    ]);
    const result = await runWith(config, await reusableState(config), mock.fetch);
    expect(result.state.lastErrorCode).toBeNull();
    expect(mock.requests).toHaveLength(3);
    expect(new URL(mock.requests[0]!.url).search).toBe('');
    expect(mock.requests[2]!.body).toBe('');
    expect(JSON.parse(result.validatedEntries[0]!.documentJson).device).toBe('share2');
    expect(result.nextDueAt).toBe(NOW + 156_000);
  });
  it("uses the official US endpoints, query parameters and request bodies", async () => {
    const mock = scriptedFetch([
      () => json("account-id"),
      () => json("session-id"),
      () => json([glucose(NOW - 60_000)]),
    ]);
    const client = new DexcomShareClient(readyConfig(), mock.fetch);
    const session = await client.createSession(NOW);
    const entries = await client.read(session.id, 10, 2);

    expect(entries).toHaveLength(1);
    expect(mock.requests).toHaveLength(3);
    const authenticate = new URL(mock.requests[0]?.url ?? "");
    const login = new URL(mock.requests[1]?.url ?? "");
    const read = new URL(mock.requests[2]?.url ?? "");
    expect(authenticate.host).toBe(US_HOST);
    expect(authenticate.pathname).toBe(
      "/ShareWebServices/Services/General/AuthenticatePublisherAccount",
    );
    expect(authenticate.searchParams.get("applicationId")).toBe(
      "d89443d2-327c-4a6f-89e5-496bbb0317db",
    );
    expect(JSON.parse(mock.requests[0]?.body ?? "{}")).toEqual({
      password: PASSWORD,
      applicationId: "d89443d2-327c-4a6f-89e5-496bbb0317db",
      accountName: ACCOUNT,
    });
    expect(login.pathname).toBe(
      "/ShareWebServices/Services/General/LoginPublisherAccountById",
    );
    expect(JSON.parse(mock.requests[1]?.body ?? "{}")).toEqual({
      password: PASSWORD,
      applicationId: "d89443d2-327c-4a6f-89e5-496bbb0317db",
      accountId: "account-id",
    });
    expect(read.pathname).toBe(
      "/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues",
    );
    expect(read.searchParams.get("sessionID")).toBe("session-id");
    expect(read.searchParams.get("minutes")).toBe("10");
    expect(read.searchParams.get("maxCount")).toBe("2");
    expect(mock.requests[2]?.body).toBe("{}");
  });

  it("uses the official OUS host without changing the service paths", async () => {
    const mock = scriptedFetch([
      () => json("account-id"),
      () => json("session-id"),
    ]);
    const client = new DexcomShareClient(readyConfig({
      ...ENVIRONMENT,
      CONNECT_SHARE_REGION: "ous",
    }), mock.fetch);
    await client.createSession(NOW);
    for (const request of mock.requests) {
      expect(new URL(request.url).host).toBe(OUS_HOST);
    }
  });

  it("accepts the newer Dexcom account object response used by G7 accounts", async () => {
    const mock = scriptedFetch([
      () => json({ accountId: "g7-account-id" }),
      () => json("g7-session-id"),
    ]);
    const client = new DexcomShareClient(readyConfig(), mock.fetch);

    await expect(client.createSession(NOW)).resolves.toEqual({
      id: "g7-session-id",
      createdAt: NOW,
    });
    expect(JSON.parse(mock.requests[1]?.body ?? "{}")).toMatchObject({
      accountId: "g7-account-id",
    });
  });

  it("bounds response bodies and rejects malformed JSON/records", async () => {
    const oversized = scriptedFetch([
      () => new Response("[]", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(RESPONSE_LIMIT + 1),
        },
      }),
    ]);
    await expect(new DexcomShareClient(
      readyConfig(),
      oversized.fetch,
    ).read(SESSION, 5, 1)).rejects.toMatchObject({
      code: "response_too_large",
    });

    const malformed = scriptedFetch([() => new Response("{not-json")]);
    await expect(new DexcomShareClient(
      readyConfig(),
      malformed.fetch,
    ).read(SESSION, 5, 1)).rejects.toMatchObject({
      code: "protocol_error",
    });

    const invalidRecord = scriptedFetch([
      () => json([{ WT: "bad", Value: 100, Trend: 4 }]),
    ]);
    await expect(new DexcomShareClient(
      readyConfig(),
      invalidRecord.fetch,
    ).read(SESSION, 5, 1)).rejects.toMatchObject({
      code: "protocol_error",
    });
  });

  it("keeps the timeout active after headers while the response body stalls", async () => {
    vi.useFakeTimers();
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let observed = Promise.resolve();
    try {
      const fetcher = ((
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const request = new Request(input, init);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
            request.signal.addEventListener("abort", () => {
              controller.error(new DOMException("aborted", "AbortError"));
            }, { once: true });
          },
        });
        return Promise.resolve(new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }) as typeof fetch;
      const operation = new DexcomShareClient(
        readyConfig(),
        fetcher,
      ).read(SESSION, 5, 1);
      let outcome:
        | { state: "pending" }
        | { state: "fulfilled" }
        | { state: "rejected"; error: unknown } = { state: "pending" };
      observed = operation.then(
        () => {
          outcome = { state: "fulfilled" };
        },
        (error: unknown) => {
          outcome = { state: "rejected", error };
        },
      );

      await vi.advanceTimersByTimeAsync(15_000);
      await Promise.resolve();

      expect(outcome).toMatchObject({
        state: "rejected",
        error: { code: "timeout" },
      });
    } finally {
      try {
        bodyController?.error(new DOMException("test cleanup", "AbortError"));
      } catch {
        // The timeout path may already have errored the stream.
      }
      await observed;
      vi.useRealTimers();
    }
  });
});

describe("Dexcom Share glucose mapping", () => {
  it("maps WT, Value and numeric/string trends without changing glucose units", () => {
    expect(mapDexcomShareGlucose(glucose(NOW, 123, 3))).toEqual({
      sgv: 123,
      date: NOW,
      dateString: "2026-07-27T08:00:00.000Z",
      trend: 3,
      direction: "FortyFiveUp",
      device: "nightscout-connect",
      type: "sgv",
    });
    expect(mapDexcomShareGlucose(glucose(NOW, 124, "DoubleDown"))).toMatchObject({
      trend: 7,
      direction: "DoubleDown",
    });
    expect(mapDexcomShareGlucose(glucose(NOW, 125, 8))).toMatchObject({
      direction: "NOT COMPUTABLE",
    });
    expect(mapDexcomShareGlucose(glucose(NOW, 126, "unknown"))).toMatchObject({
      trend: 0,
      direction: "NONE",
    });
  });
});

describe("Dexcom Share cycle/session contract", () => {
  it("reuses a valid persisted session without authenticating again", async () => {
    const config = readyConfig();
    const mock = scriptedFetch([() => json([glucose(NOW - 30_000)])]);
    const result = await runWith(config, await reusableState(config), mock.fetch);
    expect(result.status).toMatchObject({
      enabled: true,
      state: "ok",
      consecutiveFailures: 0,
    });
    expect(mock.requests).toHaveLength(1);
    expect(new URL(mock.requests[0]?.url ?? "").pathname).toContain(
      "ReadPublisherLatestGlucoseValues",
    );
  });

  it("authenticates and logs in exactly once after an invalid session", async () => {
    const config = readyConfig();
    const mock = scriptedFetch([
      () => json({ error: "SessionIdNotFound" }, 401),
      () => json("account-id-2"),
      () => json("session-id-2"),
      () => json([glucose(NOW - 30_000)]),
    ]);
    const result = await runWith(config, await reusableState(config), mock.fetch);
    expect(result.status).toMatchObject({
      enabled: true,
      state: "ok",
      lastErrorCode: null,
    });
    const paths = mock.requests.map(({ url }) => new URL(url).pathname);
    expect(paths.filter((path) => path.includes("AuthenticatePublisherAccount"))).toHaveLength(1);
    expect(paths.filter((path) => path.includes("LoginPublisherAccountById"))).toHaveLength(1);
    expect(paths.filter((path) => path.includes("ReadPublisherLatestGlucoseValues"))).toHaveLength(2);
  });

  it("filters already-known records, sorts ascending and deduplicates by entry identity", async () => {
    const config = readyConfig();
    const lastKnown = NOW - 10 * 60_000;
    const firstNew = NOW - 6 * 60_000;
    const newest = NOW - 60_000;
    const mock = scriptedFetch([() => json([
      glucose(newest, 120),
      glucose(firstNew, 110),
      glucose(firstNew, 111),
      glucose(lastKnown - 60_000, 100),
    ])]);
    const state = await reusableState(config);
    state.lastEntryAt = lastKnown;
    const result = await runWith(config, state, mock.fetch, lastKnown);
    expect(dates(result)).toEqual([firstNew, newest]);
    expect(new Set(result.validatedEntries.map((entry) => entry.dedupeKey)).size).toBe(2);
  });

  it("ignores a far-future record when scheduling after a normal reading", async () => {
    const config = readyConfig();
    const normal = NOW - 30_000;
    const mock = scriptedFetch([() => json([
      glucose(normal, 120),
      glucose(NOW + 10 * 365 * 24 * 60 * 60_000, 121),
    ])]);
    const result = await runWith(config, await reusableState(config), mock.fetch);

    expect(dates(result)).toEqual([normal]);
    expect(result.nextDueAt).toBeGreaterThan(NOW);
    expect(result.nextDueAt).toBeLessThanOrEqual(NOW + 6 * 60_000);
  });

  it("falls back to the current high-water mark when every record is far-future", async () => {
    const config = readyConfig();
    const mock = scriptedFetch([() => json([
      glucose(NOW + 10 * 365 * 24 * 60 * 60_000, 121),
    ])]);
    const result = await runWith(config, await reusableState(config), mock.fetch);

    expect(result.validatedEntries).toEqual([]);
    expect(result.nextDueAt).toBeGreaterThan(NOW);
    expect(result.nextDueAt).toBeLessThanOrEqual(NOW + BASE_RETRY_MS);
  });

  it("uses deterministic exponential retry/backoff", async () => {
    const config = readyConfig();
    const failing = (): Response => json({ error: "temporary" }, 503);
    const firstMock = scriptedFetch([failing]);
    const first = await runWith(config, await reusableState(config), firstMock.fetch);
    expect(first.status).toMatchObject({
      state: "backoff",
      consecutiveFailures: 1,
      lastErrorCode: "http_error",
    });
    expect(first.nextDueAt).toBe(NOW + BASE_RETRY_MS);

    const secondMock = scriptedFetch([failing]);
    const second = await runWith(config, first.state, secondMock.fetch);
    expect(second.status).toMatchObject({
      state: "backoff",
      consecutiveFailures: 2,
      lastErrorCode: "http_error",
    });
    expect(second.nextDueAt).toBe(NOW + 2 * BASE_RETRY_MS);
  });

  it("never exposes account, password or session in public success/error status", async () => {
    const config = readyConfig();
    const successMock = scriptedFetch([() => json([glucose(NOW - 30_000)])]);
    const success = await runWith(
      config,
      await reusableState(config),
      successMock.fetch,
    );
    const publicSuccess = JSON.stringify(success.status);
    expect(publicSuccess).not.toContain(ACCOUNT);
    expect(publicSuccess).not.toContain(PASSWORD);
    expect(publicSuccess).not.toContain(SESSION);

    const errorMock = scriptedFetch([
      () => json({ error: `${ACCOUNT}:${PASSWORD}:${SESSION}` }, 500),
    ]);
    const error = await runWith(
      config,
      await reusableState(config),
      errorMock.fetch,
    );
    const publicError = JSON.stringify(error.status);
    expect(publicError).not.toContain(ACCOUNT);
    expect(publicError).not.toContain(PASSWORD);
    expect(publicError).not.toContain(SESSION);
    expect(error.status).toMatchObject({
      state: "backoff",
      lastErrorCode: "http_error",
    });
  });

  it("never requests more than 576 readings/two days", async () => {
    const mock = scriptedFetch([() => json([])]);
    await new DexcomShareClient(readyConfig(), mock.fetch).read(
      SESSION,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    const request = new URL(mock.requests[0]?.url ?? "");
    expect(request.searchParams.get("maxCount")).toBe(String(MAX_RECORDS));
    expect(request.searchParams.get("minutes")).toBe("2880");
  });
});
