import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "../src/index";
import type { EntryStore } from "../src/entry-store";
import type { AuthorizationResolution, HttpAuthorizationRequest } from "../src/http-authorization";

// Diagnostic fixture: count only calls crossing Worker -> DO, not this.method().
// It records no real credentials, patient data, endpoint names or identifiers.
it("keeps common HTTP requests within two DO calls for every supported credential shape", async () => {
  const stub = env.ENTRY_STORE.getByName(`request-audit-${crypto.randomUUID()}`);
  const report = await runInDurableObject(stub, async (instance: EntryStore, state) => {
    await instance.createDocuments("subjects", JSON.stringify([{ name: "synthetic-audit", roles: ["admin"] }]));
    const subjects = JSON.parse(await instance.listDocuments("subjects")) as { accessToken: string }[];
    const token = subjects[0]!.accessToken;
    const issued = JSON.parse(await instance.issueAccessJwt(token)) as { token: string };
    const secret = "nscf-test-secret-20260717";
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(secret))),
      byte => byte.toString(16).padStart(2, "0")).join("");
    let calls: string[] = [];
    const forward = new Proxy(instance, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          calls.push(`${String(property)}${property === "listDocuments" ? `(${String(args[0])})` : ""}`);
          return value.apply(target, args);
        };
      },
    });
    const configured = { ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => forward },
      API_SECRET: secret, AUTH_DEFAULT_ROLES: "readable", AUTH_FAIL_DELAY: "0",
    } as unknown as Parameters<typeof worker.fetch>[1];
    const modes = [
      { name: "anonymous", headers: {}, query: "" },
      { name: "admin-secret", headers: { "api-secret": hash }, query: "" },
      { name: "subject-secret", headers: { "api-secret": token }, query: "" },
      { name: "bearer-jwt", headers: { Authorization: `Bearer ${issued.token}` }, query: "" },
      { name: "query-access-token", headers: {}, query: token },
      { name: "query-jwt", headers: {}, query: issued.token },
    ];
    const rows: unknown[] = [];
    async function send(label: string, path: string, init: RequestInit = {}, credential = modes[0]!) {
      calls = [];
      const url = new URL(path, "https://synthetic.invalid");
      if (credential.query) url.searchParams.set("token", credential.query);
      const response = await worker.fetch(new Request(url, { ...init,
        headers: { ...credential.headers, ...init.headers } as HeadersInit }), configured);
      const body = await response.text();
      const result = { label, credential: credential.name, status: response.status, rpcCount: calls.length, calls: [...calls] };
      rows.push(result);
      return { ...result, body };
    }
    const paths = [
      "/api/v1/devicestatus.json?count=5", "/api/v1/treatments.json?count=1",
      "/api/v1/entries.json?count=2", "/api/v1/entries/sgv.json?count=2",
      "/api/v2/properties", "/api/v1/status.json",
    ];
    for (const mode of modes) for (const path of paths) {
      const result = await send(path.split("?")[0]!, path, {}, mode);
      expect(result.status).toBe(200);
      expect(result.rpcCount, `${mode.name} ${path}`).toBe(2);
      if (path === "/api/v1/status.json") {
        const status = JSON.parse(result.body);
        if (mode.query) expect(status.authorized?.sub).toBe("synthetic-audit");
        else expect(status.authorized).toBeNull();
      }
    }
    for (let repeat = 0; repeat < 3; repeat++) {
      expect((await send(`warm-status-${repeat}`, paths[0]!)).rpcCount).toBe(2);
    }
    const created = await send("entry-upload", "/api/v1/entries", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify([
        { type: "sgv", sgv: 110, date: Date.now(), dateString: new Date().toISOString(), device: "synthetic" },
      ]),
    }, modes[1]!);
    expect(created.status).toBe(200);
    expect(created.rpcCount).toBe(2);
    const fresh = await send("entries-304", paths[2]!, { headers: { "If-Modified-Since": new Date(Date.now() + 60_000).toUTCString() } });
    expect(fresh.status).toBe(304);
    expect(fresh.rpcCount).toBe(2);
    const api3 = await send("api3-entries", "/api/v3/entries", {}, modes[3]!);
    expect(api3.status).toBe(200);
    expect(api3.rpcCount).toBe(2);
    expect((await send("invalid-secret", paths[0]!, { headers: { "api-secret": "synthetic-invalid" } })).status).toBe(401);
    expect((await send("invalid-bearer", paths[0]!, { headers: { Authorization: "Bearer synthetic-invalid" } })).status).toBe(401);
    const handshake = await send("socket-handshake", "/socket.io/?EIO=4&transport=polling");
    expect(handshake.status).toBe(200);
    expect(handshake.rpcCount).toBe(1);
    const sid = (JSON.parse(handshake.body.slice(1)) as { sid: string }).sid;
    expect((await send("socket-connect-post", `/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
      method: "POST", headers: { "Content-Type": "text/plain" }, body: "40",
    })).status).toBe(200);
    expect((await send("socket-queued-poll", `/socket.io/?EIO=4&transport=polling&sid=${sid}`)).status).toBe(200);
    const method = instance.getLegacyDeviceStatusQueryJson;
    const failure = vi.spyOn(instance, "getLegacyDeviceStatusQueryJson").mockRejectedValue(new Error("synthetic failure"));
    try {
      expect((await send("data-error-no-retry", paths[0]!)).status).toBe(500);
      expect(failure).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(["resolveHttpAuthorizationJson", "getLegacyDeviceStatusQueryJson"]);
    } finally { failure.mockRestore(); }
    expect(instance.getLegacyDeviceStatusQueryJson).toBe(method);
    await state.storage.deleteAlarm();
    return rows;
  });
  expect(report).toHaveLength(48);
}, 30_000);

it("shares only request-local credential reads and preserves independent status query authorization", async () => {
  const stub = env.ENTRY_STORE.getByName(`request-auth-reuse-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: EntryStore, state) => {
    await instance.createDocuments("subjects", JSON.stringify([
      { name: "synthetic-first", roles: ["readable"] }, { name: "synthetic-second", roles: ["readable"] },
    ]));
    const subjects = JSON.parse(await instance.listDocuments("subjects")) as { _id: string; name: string; accessToken: string }[];
    const first = subjects.find(subject => subject.name === "synthetic-first")!;
    const second = subjects.find(subject => subject.name === "synthetic-second")!;
    const jwt = JSON.parse(await instance.issueAccessJwt(first.accessToken)) as { token: string };
    const input: HttpAuthorizationRequest = {
      credentials: { apiSecret: null, token: first.accessToken, tokenSource: "access-token" },
      ip: "198.51.100.31", configuredSecret: "nscf-test-secret-20260717", defaultRoles: "denied", failDelayMs: 0,
      statusCredential: first.accessToken,
    };
    const verify = vi.spyOn(instance, "verifyAccessJwt");
    const resolve = vi.spyOn(instance, "resolveAuthorizationSubject");
    const roles = vi.spyOn(instance, "listDocuments");
    try {
      const result = JSON.parse(await instance.resolveHttpAuthorizationJson(JSON.stringify(input))) as AuthorizationResolution;
      expect(result.authorized?.sub).toBe(first.name);
      expect(result.statusAuthorized?.sub).toBe(first.name);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(roles).toHaveBeenCalledTimes(1);

      const different = JSON.parse(await instance.resolveHttpAuthorizationJson(JSON.stringify({ ...input,
        credentials: { apiSecret: null, token: jwt.token, tokenSource: "bearer" }, statusCredential: second.accessToken,
      }))) as AuthorizationResolution;
      expect(different.authorized?.sub).toBe(first.name);
      expect(different.statusAuthorized?.sub).toBe(second.name);
      const headerOnly = JSON.parse(await instance.resolveHttpAuthorizationJson(JSON.stringify({ ...input,
        credentials: { apiSecret: null, token: jwt.token, tokenSource: "bearer" }, statusCredential: null,
      }))) as AuthorizationResolution;
      expect(headerOnly.authorized?.sub).toBe(first.name);
      expect(headerOnly.statusAuthorized).toBeNull();

      // A new request must observe revocation, even after prior successful lookups.
      await instance.deleteDocuments("subjects", [first._id]);
      const revoked = JSON.parse(await instance.resolveHttpAuthorizationJson(JSON.stringify(input))) as AuthorizationResolution;
      expect(revoked.authorized).toBeNull();
      expect(revoked.permissionGroups).toEqual([[]]);
      expect(revoked.statusAuthorized).toBeUndefined();
    } finally {
      verify.mockRestore(); resolve.mockRestore(); roles.mockRestore();
      await state.storage.deleteAlarm();
    }
  });
});

it("waits inside the DO before authorization and observes role changes from other RPCs during that wait", async () => {
  const stub = env.ENTRY_STORE.getByName(`request-auth-wait-${crypto.randomUUID()}`);
  const roleId = "000000000000000000000071";
  await stub.createDocuments("roles", JSON.stringify([{ _id: roleId, name: "synthetic-role", permissions: ["*:*:read"] }]));
  await stub.createDocuments("subjects", JSON.stringify([{ name: "synthetic-wait", roles: ["synthetic-role"] }]));
  const [subject] = JSON.parse(await stub.listDocuments("subjects")) as { accessToken: string }[];
  const jwt = JSON.parse(await stub.issueAccessJwt(subject!.accessToken)) as { token: string };
  const input: HttpAuthorizationRequest = {
    credentials: { apiSecret: null, token: jwt.token, tokenSource: "bearer" },
    ip: "198.51.100.32", configuredSecret: "nscf-test-secret-20260717", defaultRoles: "denied", failDelayMs: 0,
  };
  await stub.authorizationFailed(input.ip, Date.now(), 350);
  const started = Date.now();
  let completed = false;
  const waiting = stub.resolveHttpAuthorizationJson(JSON.stringify(input)).then(value => { completed = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(completed).toBe(false);
  await stub.saveDocuments("roles", JSON.stringify([{ _id: roleId, name: "synthetic-role", permissions: [] }]));
  expect(completed).toBe(false);
  const result = JSON.parse(await waiting) as AuthorizationResolution;
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  expect(result.authorized?.permissionGroups).toEqual([[], []]);
  expect(await stub.authorizationDelay(input.ip, Date.now())).toBe(0);
});

it("falls back only for a missing combined RPC and never retries operational failures", async () => {
  const stub = env.ENTRY_STORE.getByName(`request-auth-fallback-${crypto.randomUUID()}`);
  await runInDurableObject(stub, async (instance: EntryStore, state) => {
    const forward = new Proxy(instance, { get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? async (...args: unknown[]) => value.apply(target, args) : value;
    } });
    const configured = { ASSETS: env.ASSETS, ENTRY_STORE: { getByName: () => forward },
      API_SECRET: "nscf-test-secret-20260717", AUTH_DEFAULT_ROLES: "readable", AUTH_FAIL_DELAY: "0",
    } as unknown as Parameters<typeof worker.fetch>[1];
    const cases = [
      { method: "resolveHttpAuthorizationJson", path: "/api/v1/treatments.json" },
      { method: "getLegacyEntriesResponseJson", path: "/api/v1/entries.json" },
      { method: "getPluginPropertyResponseJson", path: "/api/v2/properties" },
      { method: "getLegacyDeviceStatusQueryJson", path: "/api/v1/devicestatus.json?count=5" },
    ] as const;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const { method, path } of cases) {
        const missing = vi.spyOn(instance, method).mockRejectedValue(new Error(`RPC receiver does not implement the method "${method}".`));
        try {
          const response = await worker.fetch(new Request(`https://synthetic.invalid${path}`), configured);
          expect(response.status, `${method}: ${JSON.stringify(errorLog.mock.calls)}`).toBe(200);
          expect(missing).toHaveBeenCalledTimes(1);
        } finally { missing.mockRestore(); }
        const failed = vi.spyOn(instance, method).mockRejectedValue(new Error("synthetic operational error"));
        try {
          expect((await worker.fetch(new Request(`https://synthetic.invalid${path}`), configured)).status).toBe(500);
          expect(failed).toHaveBeenCalledTimes(1);
        } finally { failed.mockRestore(); }
      }
    } finally { errorLog.mockRestore(); await state.storage.deleteAlarm(); }
  });
});
