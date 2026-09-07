const APNS_RESPONSE_LIMIT_BYTES = 8 * 1024;
const APNS_REQUEST_TIMEOUT_MS = 10_000;
const APNS_PROVIDER_TOKEN_REUSE_MS = 50 * 60 * 1000;

export interface LoopPushEnvironment {
  apnsKey?: string | undefined;
  apnsKeyId?: string | undefined;
  developerTeamId?: string | undefined;
  pushServerEnvironment?: string | undefined;
}

export interface LoopApnsCredentials {
  key: string;
  keyId: string;
  teamId: string;
}

export interface LoopPushNotification {
  alert: string;
  topic: string;
  contentAvailable: 1;
  interruptionLevel: "time-sensitive";
  payload: Record<string, unknown>;
}

export interface PreparedLoopPush {
  credentials: LoopApnsCredentials;
  production: boolean;
  deviceToken: string;
  notification: LoopPushNotification;
}

export interface LoopPushTransportOptions {
  fetch?: typeof fetch;
  now?: number;
  signal?: AbortSignal;
  providerToken?: (
    credentials: LoopApnsCredentials,
    now: number,
  ) => Promise<string>;
}

export class LoopPushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopPushError";
  }
}

interface CachedProviderToken {
  fingerprint: string;
  issuedAt: number;
  token: Promise<string>;
}

let cachedProviderToken: CachedProviderToken | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPositiveLength(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const length = (value as { length?: unknown }).length;
  return typeof length === "number" && length > 0;
}

function parsedInteger(value: unknown): number {
  return Number.parseInt(String(value));
}

function parsedFloat(value: unknown): number {
  return Number.parseFloat(String(value));
}

/**
 * Workers-native port of locked Nightscout v15.0.7 lib/server/loop.js.
 * This function is deliberately pure: it keeps the upstream validation order,
 * error text and event payload contract while leaving APNs I/O to the adapter
 * below.
 */
export function prepareLoopPush(
  dataValue: unknown,
  remoteAddress: string,
  profiles: readonly Record<string, unknown>[],
  environment: LoopPushEnvironment,
  now: number,
): PreparedLoopPush {
  if (environment.apnsKey === undefined || environment.apnsKey.length === 0) {
    throw new LoopPushError("Loop notification failed: LOOP_APNS_KEY not set.");
  }
  if (environment.apnsKeyId === undefined || environment.apnsKeyId.length === 0) {
    throw new LoopPushError("Loop notification failed: LOOP_APNS_KEY_ID not set.");
  }
  if (
    environment.developerTeamId === undefined
    || environment.developerTeamId.length !== 10
  ) {
    throw new LoopPushError("Loop notification failed: LOOP_DEVELOPER_TEAM_ID not set.");
  }

  const firstProfile = profiles[0];
  const loopSettings = firstProfile === undefined
    ? undefined
    : firstProfile.loopSettings;
  if (!isRecord(loopSettings)) {
    throw new LoopPushError(
      "Loop notification failed: Could not find loopSettings in profile.",
    );
  }
  if (loopSettings.deviceToken === undefined) {
    throw new LoopPushError(
      "Loop notification failed: Could not find deviceToken in loopSettings.",
    );
  }
  if (loopSettings.bundleIdentifier === undefined) {
    throw new LoopPushError(
      "Loop notification failed: Could not find bundleIdentifier in loopSettings.",
    );
  }

  const data = isRecord(dataValue) ? dataValue : {};
  const payload: Record<string, unknown> = {
    "remote-address": remoteAddress,
    notes: data.notes,
    "entered-by": data.enteredBy,
  };
  let alert: string;

  if (data.eventType === "Temporary Override Cancel") {
    payload["cancel-temporary-override"] = "true";
    alert = "Cancel Temporary Override";
  } else if (data.eventType === "Temporary Override") {
    payload["override-name"] = data.reason;
    if (data.duration !== undefined && parsedInteger(data.duration) > 0) {
      payload["override-duration-minutes"] = parsedInteger(data.duration);
    }
    alert = `${String(data.reasonDisplay)} Temporary Override`;
  } else if (data.eventType === "Remote Carbs Entry") {
    const carbs = parsedFloat(data.remoteCarbs);
    payload["carbs-entry"] = carbs;
    if (!(carbs > 0)) {
      // The locked completion callback receives a second, ignored argument.
      // Preserve the exact first argument returned by the Express route.
      throw new LoopPushError("Loop remote carbs failed. Incorrect carbs entry: ");
    }
    let absorption = 3;
    if (data.remoteAbsorption !== undefined && parsedFloat(data.remoteAbsorption) > 0) {
      absorption = parsedFloat(data.remoteAbsorption);
    }
    payload["absorption-time"] = absorption;
    if (data.otp !== undefined && hasPositiveLength(data.otp)) {
      payload.otp = String(data.otp);
    }
    if (data.created_at !== undefined) payload["start-time"] = data.created_at;
    alert = `Remote Carbs Entry: ${carbs} grams\nAbsorption Time: ${absorption} hours`;
  } else if (data.eventType === "Remote Bolus Entry") {
    const bolus = parsedFloat(data.remoteBolus);
    payload["bolus-entry"] = bolus;
    if (!(bolus > 0)) {
      throw new LoopPushError("Loop remote bolus failed. Incorrect bolus entry: ");
    }
    alert = `Remote Bolus Entry: ${bolus} U\n`;
    if (data.otp !== undefined && hasPositiveLength(data.otp)) {
      payload.otp = String(data.otp);
    }
  } else {
    throw new LoopPushError("Loop notification failed: Unhandled event type:");
  }

  if (data.notes !== undefined && hasPositiveLength(data.notes)) {
    alert += ` - ${String(data.notes)}`;
  }
  if (data.enteredBy !== undefined && hasPositiveLength(data.enteredBy)) {
    alert += ` - ${String(data.enteredBy)}`;
  }

  const sentAt = new Date(now);
  payload["sent-at"] = sentAt.toISOString();
  payload.expiration = new Date(now + 5 * 60 * 1000).toISOString();

  return {
    credentials: {
      key: environment.apnsKey,
      keyId: environment.apnsKeyId,
      teamId: environment.developerTeamId,
    },
    production: firstProfile?.isAPNSProduction !== undefined
      ? Boolean(firstProfile.isAPNSProduction)
      : environment.pushServerEnvironment === "production",
    deviceToken: String(loopSettings.deviceToken),
    notification: {
      alert,
      topic: String(loopSettings.bundleIdentifier),
      contentAvailable: 1,
      payload,
      interruptionLevel: "time-sensitive",
    },
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodePkcs8Pem(pem: string): ArrayBuffer {
  const encoded = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  if (encoded.length === 0) throw new Error("Invalid provider key");
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  } catch {
    throw new Error("Invalid provider key");
  }
}

export async function createLoopApnsProviderToken(
  credentials: LoopApnsCredentials,
  now: number,
): Promise<string> {
  const encodedHeader = base64UrlJson({ alg: "ES256", kid: credentials.keyId });
  const encodedClaims = base64UrlJson({
    iss: credentials.teamId,
    iat: Math.floor(now / 1000),
  });
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    decodePkcs8Pem(credentials.key),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(signingInput),
  ));
  if (signature.byteLength !== 64) {
    throw new Error("Invalid ES256 signature returned by Web Crypto");
  }
  return `${signingInput}.${base64Url(signature)}`;
}

async function providerTokenFingerprint(
  credentials: LoopApnsCredentials,
): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${credentials.teamId}\u0000${credentials.keyId}\u0000${credentials.key}`,
    ),
  ));
  return base64Url(digest);
}

async function reusableLoopApnsProviderToken(
  credentials: LoopApnsCredentials,
  now: number,
): Promise<string> {
  const fingerprint = await providerTokenFingerprint(credentials);
  if (
    cachedProviderToken !== null
    && cachedProviderToken.fingerprint === fingerprint
    && now >= cachedProviderToken.issuedAt
    && now - cachedProviderToken.issuedAt < APNS_PROVIDER_TOKEN_REUSE_MS
  ) {
    return cachedProviderToken.token;
  }

  const token = createLoopApnsProviderToken(credentials, now);
  cachedProviderToken = { fingerprint, issuedAt: now, token };
  try {
    return await token;
  } catch (error) {
    if (cachedProviderToken?.token === token) cachedProviderToken = null;
    throw error;
  }
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null && Number(declared) > APNS_RESPONSE_LIMIT_BYTES) {
    await response.body?.cancel();
    throw new Error("APNs response exceeded 8 KiB");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > APNS_RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      throw new Error("APNs response exceeded 8 KiB");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function apnsFailureReason(response: Response): Promise<string> {
  const text = await readBoundedResponseText(response);
  if (text.length === 0) return "Unknown reason";
  try {
    const body: unknown = JSON.parse(text);
    return isRecord(body) && typeof body.reason === "string"
      ? body.reason
      : "Unknown reason";
  } catch {
    return "Unknown reason";
  }
}

/**
 * Deliver the prepared official Loop payload through Apple's HTTP/2 APNs API.
 * Workers fetch negotiates the transport; Web Crypto replaces node-apn's
 * Node-only key/JWT implementation. The network function is injectable so the
 * complete request/response contract can be tested without contacting Apple.
 */
export async function sendPreparedLoopPush(
  prepared: PreparedLoopPush,
  options: LoopPushTransportOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  const tokenProvider = options.providerToken ?? reusableLoopApnsProviderToken;
  try {
    const providerToken = await tokenProvider(prepared.credentials, now);
    const body = JSON.stringify({
      aps: {
        alert: prepared.notification.alert,
        "content-available": prepared.notification.contentAvailable,
        "interruption-level": prepared.notification.interruptionLevel,
      },
      ...prepared.notification.payload,
    });
    const endpoint = prepared.production
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";
    const response = await (options.fetch ?? fetch)(
      `${endpoint}/3/device/${encodeURIComponent(prepared.deviceToken)}`,
      {
        method: "POST",
        headers: {
          Authorization: `bearer ${providerToken}`,
          "Content-Type": "application/json",
          "apns-push-type": "alert",
          "apns-topic": prepared.notification.topic,
          "apns-priority": "10",
          "apns-expiration": String(Math.floor((now + 5 * 60 * 1000) / 1000)),
        },
        body,
        cache: "no-store",
        signal: options.signal ?? AbortSignal.timeout(APNS_REQUEST_TIMEOUT_MS),
      },
    );
    if (response.status === 200) {
      await response.body?.cancel();
      return;
    }
    throw new LoopPushError(
      `APNs delivery failed: ${await apnsFailureReason(response)}`,
    );
  } catch (error) {
    if (error instanceof LoopPushError) throw error;
    throw new LoopPushError(
      `APNs delivery failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}
