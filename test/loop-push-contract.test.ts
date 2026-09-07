import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createLoopApnsProviderToken,
  LoopPushError,
  prepareLoopPush,
  sendPreparedLoopPush,
  type LoopApnsCredentials,
  type LoopPushEnvironment,
} from "../src/loop-push";

const TEST_API_SECRET = "nscf-test-secret-20260717";
const NOW = Date.parse("2026-07-22T08:00:00.000Z");
const ENVIRONMENT: LoopPushEnvironment = {
  apnsKey: "test-key",
  apnsKeyId: "KEYID12345",
  developerTeamId: "TEAMID1234",
};
const PROFILES = [{
  loopSettings: {
    deviceToken: "device-token/with punctuation",
    bundleIdentifier: "com.example.Loop",
  },
}];

async function secretDigest(): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(TEST_API_SECRET),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function pemFromPkcs8(key: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(key)) binary += String.fromCharCode(byte);
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
}

describe("locked Nightscout Loop remote-notification preparation", () => {
  it("preserves the upstream configuration/profile validation order and text", () => {
    expect(() => prepareLoopPush({}, "ip", [], {}, NOW)).toThrow(
      "Loop notification failed: LOOP_APNS_KEY not set.",
    );
    expect(() => prepareLoopPush({}, "ip", [], { apnsKey: "key" }, NOW)).toThrow(
      "Loop notification failed: LOOP_APNS_KEY_ID not set.",
    );
    expect(() => prepareLoopPush({}, "ip", [], {
      apnsKey: "key",
      apnsKeyId: "id",
    }, NOW)).toThrow(
      "Loop notification failed: LOOP_DEVELOPER_TEAM_ID not set.",
    );
    expect(() => prepareLoopPush({}, "ip", [], ENVIRONMENT, NOW)).toThrow(
      "Loop notification failed: Could not find loopSettings in profile.",
    );
    expect(() => prepareLoopPush({}, "ip", [{}], ENVIRONMENT, NOW)).toThrow(
      "Loop notification failed: Could not find loopSettings in profile.",
    );
    expect(() => prepareLoopPush({}, "ip", [{ loopSettings: {} }], ENVIRONMENT, NOW)).toThrow(
      "Loop notification failed: Could not find deviceToken in loopSettings.",
    );
    expect(() => prepareLoopPush({}, "ip", [{
      loopSettings: { deviceToken: "device" },
    }], ENVIRONMENT, NOW)).toThrow(
      "Loop notification failed: Could not find bundleIdentifier in loopSettings.",
    );
  });

  it("builds Temporary Override and cancel payloads exactly", () => {
    const override = prepareLoopPush({
      eventType: "Temporary Override",
      reason: "Exercise",
      reasonDisplay: "🏃 Exercise",
      duration: "45.9 minutes",
      notes: "after school",
      enteredBy: "Parent",
    }, "203.0.113.8", PROFILES, ENVIRONMENT, NOW);
    expect(override.production).toBe(false);
    expect(override.deviceToken).toBe("device-token/with punctuation");
    expect(override.notification).toEqual({
      alert: "🏃 Exercise Temporary Override - after school - Parent",
      topic: "com.example.Loop",
      contentAvailable: 1,
      interruptionLevel: "time-sensitive",
      payload: {
        "remote-address": "203.0.113.8",
        notes: "after school",
        "entered-by": "Parent",
        "override-name": "Exercise",
        "override-duration-minutes": 45,
        "sent-at": "2026-07-22T08:00:00.000Z",
        expiration: "2026-07-22T08:05:00.000Z",
      },
    });

    const cancel = prepareLoopPush(
      { eventType: "Temporary Override Cancel" },
      "unknown",
      PROFILES,
      { ...ENVIRONMENT, pushServerEnvironment: "production" },
      NOW,
    );
    expect(cancel.production).toBe(true);
    expect(cancel.notification.alert).toBe("Cancel Temporary Override");
    expect(cancel.notification.payload["cancel-temporary-override"]).toBe("true");
  });

  it("builds Remote Carbs and Bolus payloads and preserves invalid-input errors", () => {
    const carbs = prepareLoopPush({
      eventType: "Remote Carbs Entry",
      remoteCarbs: "17.5g",
      remoteAbsorption: "4.25h",
      otp: "012345",
      created_at: "2026-07-22T07:59:00.000Z",
    }, "ip", PROFILES, ENVIRONMENT, NOW);
    expect(carbs.notification.alert).toBe(
      "Remote Carbs Entry: 17.5 grams\nAbsorption Time: 4.25 hours",
    );
    expect(carbs.notification.payload).toMatchObject({
      "carbs-entry": 17.5,
      "absorption-time": 4.25,
      otp: "012345",
      "start-time": "2026-07-22T07:59:00.000Z",
    });

    const defaultAbsorption = prepareLoopPush({
      eventType: "Remote Carbs Entry",
      remoteCarbs: 12,
      remoteAbsorption: 0,
    }, "ip", PROFILES, ENVIRONMENT, NOW);
    expect(defaultAbsorption.notification.payload["absorption-time"]).toBe(3);

    const bolus = prepareLoopPush({
      eventType: "Remote Bolus Entry",
      remoteBolus: "1.25U",
      otp: "one-time-code",
      notes: "test",
    }, "ip", PROFILES, ENVIRONMENT, NOW);
    expect(bolus.notification.alert).toBe("Remote Bolus Entry: 1.25 U\n - test");
    expect(bolus.notification.payload).toMatchObject({
      "bolus-entry": 1.25,
      otp: "one-time-code",
    });

    expect(() => prepareLoopPush({
      eventType: "Remote Carbs Entry",
      remoteCarbs: 0,
    }, "ip", PROFILES, ENVIRONMENT, NOW)).toThrow(
      "Loop remote carbs failed. Incorrect carbs entry: ",
    );
    expect(() => prepareLoopPush({
      eventType: "Remote Bolus Entry",
      remoteBolus: "invalid",
    }, "ip", PROFILES, ENVIRONMENT, NOW)).toThrow(
      "Loop remote bolus failed. Incorrect bolus entry: ",
    );
    expect(() => prepareLoopPush({ eventType: "Other" }, "ip", PROFILES, ENVIRONMENT, NOW))
      .toThrow("Loop notification failed: Unhandled event type:");
  });
});

describe("Workers-native APNs transport", () => {
  it("creates a verifiable ES256 APNs provider JWT from a p8 key", async () => {
    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const credentials: LoopApnsCredentials = {
      key: pemFromPkcs8(await crypto.subtle.exportKey("pkcs8", keys.privateKey)),
      keyId: "KEYID12345",
      teamId: "TEAMID1234",
    };
    const token = await createLoopApnsProviderToken(credentials, NOW);
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
    expect(JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[0]!)))).toEqual({
      alg: "ES256",
      kid: "KEYID12345",
    });
    expect(JSON.parse(new TextDecoder().decode(decodeBase64Url(parts[1]!)))).toEqual({
      iss: "TEAMID1234",
      iat: Math.floor(NOW / 1000),
    });
    expect(await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keys.publicKey,
      decodeBase64Url(parts[2]!),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    )).toBe(true);
  });

  it("sends the official payload to the correct APNs endpoint and headers", async () => {
    const prepared = prepareLoopPush(
      { eventType: "Temporary Override Cancel" },
      "198.51.100.2",
      PROFILES,
      { ...ENVIRONMENT, pushServerEnvironment: "production" },
      NOW,
    );
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchStub: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(null, { status: 200 });
    };
    await sendPreparedLoopPush(prepared, {
      now: NOW,
      fetch: fetchStub,
      providerToken: async () => "provider-jwt",
    });
    expect(capturedUrl).toBe(
      "https://api.push.apple.com/3/device/device-token%2Fwith%20punctuation",
    );
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("Authorization")).toBe("bearer provider-jwt");
    expect(headers.get("apns-topic")).toBe("com.example.Loop");
    expect(headers.get("apns-push-type")).toBe("alert");
    expect(headers.get("apns-priority")).toBe("10");
    expect(headers.get("apns-expiration")).toBe(String(Math.floor((NOW + 300_000) / 1000)));
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      aps: {
        alert: "Cancel Temporary Override",
        "content-available": 1,
        "interruption-level": "time-sensitive",
      },
      "remote-address": "198.51.100.2",
      "cancel-temporary-override": "true",
      "sent-at": "2026-07-22T08:00:00.000Z",
      expiration: "2026-07-22T08:05:00.000Z",
    });
  });

  it("maps bounded APNs and network failures to the upstream callback shape", async () => {
    const prepared = prepareLoopPush(
      { eventType: "Temporary Override Cancel" },
      "ip",
      PROFILES,
      ENVIRONMENT,
      NOW,
    );
    const options = {
      now: NOW,
      providerToken: async () => "provider-jwt",
    };
    await expect(sendPreparedLoopPush(prepared, {
      ...options,
      fetch: async () => new Response(
        JSON.stringify({ reason: "BadDeviceToken" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    })).rejects.toEqual(new LoopPushError("APNs delivery failed: BadDeviceToken"));

    await expect(sendPreparedLoopPush(prepared, {
      ...options,
      fetch: async () => new Response(null, { status: 500 }),
    })).rejects.toEqual(new LoopPushError("APNs delivery failed: Unknown reason"));

    await expect(sendPreparedLoopPush(prepared, {
      ...options,
      fetch: async () => {
        throw new TypeError("network unavailable");
      },
    })).rejects.toEqual(new LoopPushError("APNs delivery failed: network unavailable"));

    await expect(sendPreparedLoopPush(prepared, {
      ...options,
      fetch: async () => new Response("x".repeat(8 * 1024 + 1), { status: 500 }),
    })).rejects.toEqual(new LoopPushError("APNs delivery failed: APNs response exceeded 8 KiB"));
  });
});

describe("/api/v2/notifications/loop route", () => {
  it("requires the locked notifications:loop:push permission", async () => {
    const response = await SELF.fetch(
      "https://example.test/api/v2/notifications/loop?tenant=loop-route-unauthorized",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventType: "Temporary Override Cancel" }),
      },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      status: 401,
      message: "Unauthorized",
    });
  });

  it("accepts the official form body and returns the first upstream config error", async () => {
    const response = await SELF.fetch(
      "https://example.test/api/v2/notifications/loop?tenant=loop-route-config",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "api-secret": await secretDigest(),
          "CF-Connecting-IP": "203.0.113.55",
        },
        body: "eventType=Temporary+Override+Cancel",
      },
    );
    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe(
      "Loop notification failed: LOOP_APNS_KEY not set.",
    );
  });

  it("does not invent the v2-only route under API v1", async () => {
    const response = await SELF.fetch(
      "https://example.test/api/v1/notifications/loop?tenant=loop-route-v1",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-secret": await secretDigest(),
        },
        body: JSON.stringify({ eventType: "Temporary Override Cancel" }),
      },
    );
    expect(response.status).toBe(404);
  });
});


it("prefers explicit profile APNS production flags over the environment", () => {
  for (const isAPNSProduction of [true, false]) {
    const prepared = prepareLoopPush({ eventType: "Temporary Override Cancel" }, "ip",
      [{ ...PROFILES[0], isAPNSProduction }],
      { ...ENVIRONMENT, pushServerEnvironment: isAPNSProduction ? "sandbox" : "production" }, NOW);
    expect(prepared.production).toBe(isAPNSProduction);
  }
});
