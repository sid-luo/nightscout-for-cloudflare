import { env } from "cloudflare:workers";
import { evictDurableObject, SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import worker from "../src/index";
import { parseEntryPayload } from "../src/model";
import { handleSocketIoPolling } from "../src/realtime/http-adapter";
import {
  decodeEngineIoV3Handshake,
  decodeEngineIoV3PollingPayload,
  decodeEngineIoV4Handshake,
  decodeEngineIoV4PollingPayload,
  encodeEngineIoV3PollingPayload,
  encodeEngineIoV4PollingPayload,
  unwrapSocketIoV4Packet,
  unwrapSocketIoV5Packet,
  wrapSocketIoV4Packet,
  wrapSocketIoV5Packet,
  type SocketIoV4Packet,
  type SocketIoV5Packet,
} from "../src/protocol";
import {
  REALTIME_SNAPSHOT_MAX_BYTES,
  REALTIME_SNAPSHOT_MAX_DOCUMENTS,
  REALTIME_SNAPSHOT_MAX_NODES,
} from "../src/realtime/constants";
import type { RealtimeSnapshot } from "../src/realtime/session-service";

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function endpoint(tenantName: string, query = ""): string {
  return `https://example.test/socket.io/?EIO=4&transport=polling&tenant=${tenantName}${query}`;
}

function legacyEndpoint(tenantName: string, query = ""): string {
  return `https://example.test/socket.io/?EIO=3&transport=polling&tenant=${tenantName}${query}`;
}

function clientPayload(packet: SocketIoV5Packet): string {
  return encodeEngineIoV4PollingPayload([wrapSocketIoV5Packet(packet)]);
}

function legacyClientPayload(packet: SocketIoV4Packet): string {
  return encodeEngineIoV3PollingPayload([wrapSocketIoV4Packet(packet)]);
}

async function open(tenantName: string): Promise<{ sid: string; response: Response }> {
  const response = await SELF.fetch(endpoint(tenantName));
  const packets = decodeEngineIoV4PollingPayload(await response.clone().text());
  const handshake = decodeEngineIoV4Handshake(packets[0]!);
  return { sid: handshake.sid, response };
}

async function openLegacy(
  tenantName: string,
): Promise<{ sid: string; response: Response; packets: ReturnType<typeof decodeEngineIoV3PollingPayload> }> {
  const response = await SELF.fetch(legacyEndpoint(tenantName));
  const packets = decodeEngineIoV3PollingPayload(await response.clone().text());
  const handshake = decodeEngineIoV3Handshake(packets[0]!);
  return { sid: handshake.sid, response, packets };
}

async function send(
  tenantName: string,
  sid: string,
  payload: string,
  headers?: HeadersInit,
): Promise<Response> {
  return SELF.fetch(endpoint(tenantName, `&sid=${sid}`), {
    method: "POST",
    ...(headers === undefined ? {} : { headers }),
    body: payload,
  });
}

async function poll(tenantName: string, sid: string): Promise<Response> {
  return SELF.fetch(endpoint(tenantName, `&sid=${sid}`));
}

async function sendLegacy(
  tenantName: string,
  sid: string,
  payload: string,
): Promise<Response> {
  return SELF.fetch(legacyEndpoint(tenantName, `&sid=${sid}`), {
    method: "POST",
    body: payload,
  });
}

async function pollLegacy(tenantName: string, sid: string): Promise<Response> {
  return SELF.fetch(legacyEndpoint(tenantName, `&sid=${sid}`));
}

async function hasActivePoll(
  stub: DurableObjectStub<EntryStore>,
  sid: string,
): Promise<boolean> {
  return runInDurableObject(stub, async (instance) => {
    const realtime = (
      instance as unknown as {
        realtime: { waiters: Map<string, unknown> };
      }
    ).realtime;
    return realtime.waiters.has(sid);
  });
}

function socketPackets(payload: string): SocketIoV5Packet[] {
  return decodeEngineIoV4PollingPayload(payload).map((packet) =>
    unwrapSocketIoV5Packet(packet)
  );
}

function eventValue(packets: SocketIoV5Packet[], name: string): unknown {
  const event = packets.find((packet) =>
    packet.type === "event" && packet.data[0] === name
  );
  if (event === undefined || event.type !== "event") {
    throw new Error(`missing ${name} event`);
  }
  return event.data[1];
}

function jsonNodeCount(value: unknown): number {
  const work = [value];
  let nodes = 0;
  while (work.length > 0) {
    const current = work.pop();
    nodes += 1;
    if (Array.isArray(current)) {
      work.push(...current);
    } else if (typeof current === "object" && current !== null) {
      work.push(...Object.values(current));
    }
  }
  return nodes;
}

describe("Engine.IO 3/4 polling HTTP adapter", () => {
  it("returns a retryable Engine.IO 503 when SQLite writes are exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-25T23:59:30.000Z");
    try {
      const url = new URL(endpoint("typed-storage-quota"));
      const typed = await handleSocketIoPolling(
        new Request(url),
        url,
        {
          realtimeHandshake: async () => ({
            ok: false,
            error: {
              code: "storage_quota",
              message: "Temporary storage quota exceeded",
            },
          }),
        } as unknown as DurableObjectStub<EntryStore>,
      );
      expect(typed.status).toBe(503);
      expect(typed.headers.get("Retry-After")).toBe("30");
      expect(typed.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(typed.headers.get("Cache-Control")).toBe("no-store");
      expect(await typed.json()).toEqual({ code: 3, message: "Bad request" });

      const raw = await worker.fetch(
        new Request(endpoint("raw-storage-quota")),
        {
          ASSETS: env.ASSETS,
          ENTRY_STORE: {
            getByName: () => ({
              realtimeHandshake: async () => {
                throw new Error(
                  "Exceeded allowed rows written in Durable Objects free tier.",
                );
              },
            }),
          },
          API_SECRET: "nscf-test-secret-20260717",
          AUTH_DEFAULT_ROLES: "readable",
          AUTH_FAIL_DELAY: "0",
        } as unknown as Parameters<typeof worker.fetch>[1],
      );
      expect(raw.status).toBe(503);
      expect(raw.headers.get("Retry-After")).toBe("30");
      expect(raw.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(await raw.json()).toEqual({ code: 3, message: "Bad request" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the versioned official Socket.IO client on the static asset path", async () => {
    const response = await SELF.fetch(
      "https://example.test/socket.io/socket.io.js?cachebuster-test",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^(?:text|application)\/javascript/);
    const source = await response.text();
    expect(source).toContain("Socket.IO v4.8.3");
    expect(source).not.toContain("/api/v2/ddata/at");
  });

  it("serves the exact polling open contract and Engine.IO query errors", async () => {
    const name = tenant("eio-open");
    const { sid, response } = await open(name);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=UTF-8");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toBe(
      `0{"sid":"${sid}","upgrades":["websocket"],"pingInterval":25000,` +
        `"pingTimeout":20000,"maxPayload":1000000}`,
    );

    const withoutTrailingSlash = await SELF.fetch(
      `https://example.test/socket.io?EIO=4&transport=polling&tenant=${name}`,
    );
    expect(withoutTrailingSlash.status).toBe(200);
    expect(await withoutTrailingSlash.text()).toMatch(/^0\{"sid":"[A-Za-z0-9_-]{20}"/);

    const unsupported = await SELF.fetch(
      `https://example.test/socket.io/?EIO=2&transport=polling&tenant=${name}`,
    );
    expect(unsupported.status).toBe(400);
    expect(unsupported.headers.get("Content-Type")).toBe("application/json");
    expect(await unsupported.json()).toEqual({
      code: 5,
      message: "Unsupported protocol version",
    });

    const unknownTransport = await SELF.fetch(
      `https://example.test/socket.io/?EIO=4&transport=unknown&tenant=${name}`,
    );
    expect(unknownTransport.status).toBe(400);
    expect(await unknownTransport.json()).toEqual({ code: 0, message: "Transport unknown" });

    const badHandshake = await SELF.fetch(endpoint(name), { method: "POST", body: "" });
    expect(badHandshake.status).toBe(400);
    expect(await badHandshake.json()).toEqual({ code: 2, message: "Bad handshake method" });

    const wrongMethod = await SELF.fetch(endpoint(name, `&sid=${sid}`), { method: "PUT" });
    expect(wrongMethod.status).toBe(500);
    expect(await wrongMethod.text()).toBe("");

    const unknownWrongMethod = await SELF.fetch(endpoint(name, "&sid=unknown-sid"), {
      method: "PUT",
    });
    expect(unknownWrongMethod.status).toBe(400);
    expect(unknownWrongMethod.headers.get("Content-Type")).toBe("application/json");
    expect(await unknownWrongMethod.json()).toEqual({
      code: 1,
      message: "Session ID unknown",
    });

    const options = await SELF.fetch(endpoint(name), { method: "OPTIONS" });
    expect(options.status).toBe(204);
  });

  it("runs the legacy EIO3/SIO4 heartbeat, root authorization, namespaces, and mixed broadcast", async () => {
    const name = tenant("eio3-flow");
    const opened = await openLegacy(name);
    expect(opened.response.status).toBe(200);
    expect(opened.response.headers.get("Content-Type")).toBe("text/plain; charset=UTF-8");
    expect(opened.packets).toHaveLength(1);
    expect(decodeEngineIoV3Handshake(opened.packets[0]!)).toEqual({
      sid: opened.sid,
      upgrades: ["websocket"],
      pingInterval: 25_000,
      pingTimeout: 20_000,
      maxPayload: 1_000_000,
    });
    const automaticRoot = decodeEngineIoV3PollingPayload(
      await (await pollLegacy(name, opened.sid)).text(),
    ).map((packet) => unwrapSocketIoV4Packet(packet));
    expect(automaticRoot).toEqual([
      { type: "connect", namespace: "/" },
      { type: "event", namespace: "/", data: ["clients", 1] },
    ]);

    const ping = await sendLegacy(
      name,
      opened.sid,
      encodeEngineIoV3PollingPayload([{ type: "ping", data: "client-data" }]),
    );
    expect(ping.status).toBe(200);
    expect(await ping.text()).toBe("ok");
    expect(await (await pollLegacy(name, opened.sid)).text()).toBe("1:3");

    expect((await sendLegacy(name, opened.sid, legacyClientPayload({
      type: "event",
      namespace: "/",
      id: 4,
      data: ["authorize", { client: "legacy" }],
    }))).status).toBe(200);
    const authorized = decodeEngineIoV3PollingPayload(
      await (await pollLegacy(name, opened.sid)).text(),
    ).map((packet) => unwrapSocketIoV4Packet(packet));
    expect(authorized[0]).toEqual({
      type: "event",
      namespace: "/",
      data: ["connected"],
    });
    expect(authorized[1]).toMatchObject({
      type: "event",
      namespace: "/",
      data: ["dataUpdate", { sgvs: [] }],
    });
    expect(authorized[2]).toEqual({
      type: "ack",
      namespace: "/",
      id: 4,
      data: [{ read: true, write: false, write_treatment: false }],
    });

    expect((await sendLegacy(name, opened.sid, legacyClientPayload({
      type: "connect",
      namespace: "/storage?source=legacy",
    }))).status).toBe(200);
    const storageConnect = decodeEngineIoV3PollingPayload(
      await (await pollLegacy(name, opened.sid)).text(),
    ).map((packet) => unwrapSocketIoV4Packet(packet));
    expect(storageConnect).toEqual([{ type: "connect", namespace: "/storage" }]);

    const wrongProtocol = await SELF.fetch(endpoint(name, `&sid=${opened.sid}`));
    expect(wrongProtocol.status).toBe(400);
    expect(await wrongProtocol.json()).toEqual({
      code: 1,
      message: "Session ID unknown",
    });

    const current = await open(name);
    expect((await send(name, current.sid, clientPayload({
      type: "connect",
      namespace: "/",
    }))).status).toBe(200);
    await poll(name, current.sid);
    const legacyBroadcast = decodeEngineIoV3PollingPayload(
      await (await pollLegacy(name, opened.sid)).text(),
    ).map((packet) => unwrapSocketIoV4Packet(packet));
    expect(legacyBroadcast).toContainEqual({
      type: "event",
      namespace: "/",
      data: ["clients", 2],
    });
  });

  it("maps SGV raw fields, MBGs, and calibrations exactly into the upstream ddata buckets", async () => {
    const name = tenant("eio-entry-buckets");
    const stub = env.ENTRY_STORE.getByName(name);
    const now = Date.now();
    await stub.putEntries(parseEntryPayload([
      {
        _id: "111111111111111111111111",
        type: "sgv",
        sgv: 123,
        date: now - 180_000,
        dateString: new Date(now - 180_000).toISOString(),
        direction: "Flat",
        device: "raw-cgm",
        filtered: 23_456,
        unfiltered: 24_567,
        noise: 2,
        rssi: 177,
      },
      {
        _id: "222222222222222222222222",
        type: "mbg",
        mbg: 117,
        date: now - 120_000,
        dateString: new Date(now - 120_000).toISOString(),
        device: "meter",
      },
      {
        _id: "333333333333333333333333",
        type: "cal",
        date: now - 60_000,
        dateString: new Date(now - 60_000).toISOString(),
        device: "raw-cgm",
        scale: 1.1,
        intercept: 31_102.3,
        slope: 776.9,
      },
      {
        _id: "444444444444444444444444",
        type: "sgv",
        sgv: 124,
        mbg: 118,
        date: now - 45_000,
        dateString: new Date(now - 45_000).toISOString(),
        direction: "Flat",
        device: "hybrid-meter",
      },
      {
        _id: "555555555555555555555555",
        type: "cal",
        sgv: 126,
        date: now - 30_000,
        dateString: new Date(now - 30_000).toISOString(),
        direction: "SingleUp",
        device: "cal-with-sgv",
        scale: 9,
        intercept: 9,
        slope: 9,
      },
      {
        _id: "888888888888888888888881",
        type: "sgv",
        sgv: 99,
        date: now - 3 * 24 * 60 * 60_000,
        dateString: new Date(now - 3 * 24 * 60 * 60_000).toISOString(),
        direction: "Flat",
        device: "stale-cgm",
      },
      {
        _id: "888888888888888888888882",
        type: "mbg",
        mbg: 98,
        date: now - 3 * 24 * 60 * 60_000,
        dateString: new Date(now - 3 * 24 * 60 * 60_000).toISOString(),
        device: "stale-meter",
      },
      {
        _id: "888888888888888888888883",
        type: "cal",
        date: now - 3 * 24 * 60 * 60_000,
        dateString: new Date(now - 3 * 24 * 60 * 60_000).toISOString(),
        device: "stale-calibration",
        scale: 2,
        intercept: 2,
        slope: 2,
      },
    ]));
    for (const document of [
      {
        identifier: "optional-type-realtime",
        date: now - 15_000,
        utcOffset: 0,
        app: "realtime-test",
        device: "optional-type-cgm",
        direction: "Flat",
        sgv: "128",
      },
      {
        identifier: "string-mbg-realtime",
        date: now - 10_000,
        utcOffset: 0,
        app: "realtime-test",
        device: "string-meter",
        mbg: "129",
      },
      {
        identifier: "cal-string-sgv-realtime",
        date: now - 5_000,
        utcOffset: 0,
        app: "realtime-test",
        device: "cal-string-sgv",
        direction: "FortyFiveUp",
        type: "cal",
        sgv: "130",
        scale: 8,
        intercept: 8,
        slope: 8,
      },
    ]) {
      const decision = JSON.parse(await stub.api3CreateDocument(
        "entries",
        JSON.stringify(document),
        JSON.stringify({
          canCreate: true,
          canUpdate: true,
          actor: null,
          ifUnmodifiedSince: null,
          validate: true,
        }),
      )) as { ok: boolean };
      expect(decision.ok).toBe(true);
    }

    const { sid } = await open(name);
    expect((await send(name, sid, clientPayload({ type: "connect", namespace: "/" }))).status)
      .toBe(200);
    expect((await poll(name, sid)).status).toBe(200);
    expect((await send(name, sid, clientPayload({
      type: "event",
      namespace: "/",
      id: 12,
      data: ["authorize", { client: "web" }],
    }))).status).toBe(200);
    const packets = socketPackets(await (await poll(name, sid)).text());
    const snapshot = eventValue(packets, "dataUpdate") as RealtimeSnapshot;
    expect(snapshot.sgvs).toEqual([
      {
        _id: "111111111111111111111111",
        mgdl: 123,
        mills: now - 180_000,
        device: "raw-cgm",
        direction: "Flat",
        filtered: 23_456,
        unfiltered: 24_567,
        noise: 2,
        rssi: 177,
        type: "sgv",
      },
      {
        _id: "555555555555555555555555",
        mgdl: 126,
        mills: now - 30_000,
        device: "cal-with-sgv",
        direction: "SingleUp",
        type: "sgv",
      },
      {
        _id: expect.stringMatching(/^[0-9a-f]{24}$/),
        mgdl: 128,
        mills: now - 15_000,
        device: "optional-type-cgm",
        direction: "Flat",
        type: "sgv",
      },
      {
        _id: expect.stringMatching(/^[0-9a-f]{24}$/),
        mgdl: 130,
        mills: now - 5_000,
        device: "cal-string-sgv",
        direction: "FortyFiveUp",
        type: "sgv",
      },
    ]);
    expect(snapshot.mbgs).toEqual([
      {
        _id: "222222222222222222222222",
        mgdl: 117,
        mills: now - 120_000,
        device: "meter",
        type: "mbg",
      },
      {
        _id: "444444444444444444444444",
        mgdl: 118,
        mills: now - 45_000,
        device: "hybrid-meter",
        type: "mbg",
      },
      {
        _id: expect.stringMatching(/^[0-9a-f]{24}$/),
        mgdl: 129,
        mills: now - 10_000,
        device: "string-meter",
        type: "mbg",
      },
    ]);
    expect(snapshot.cals).toEqual([{
      _id: "333333333333333333333333",
      mills: now - 60_000,
      scale: 1.1,
      intercept: 31_102.3,
      slope: 776.9,
      type: "cal",
    }]);
  });

  it("reserves realtime snapshot budget for SGV before oversized profile state", async () => {
    const name = tenant("eio-snapshot-sgv-priority");
    const stub = env.ENTRY_STORE.getByName(name) as DurableObjectStub<EntryStore>;
    const now = Date.now();
    await stub.putEntries(parseEntryPayload([{
      _id: "676767676767676767676767",
      type: "sgv",
      sgv: 147,
      date: now - 60_000,
      dateString: new Date(now - 60_000).toISOString(),
      direction: "Flat",
      device: "priority-cgm",
      filtered: 31_001,
      unfiltered: 31_002,
      noise: 1,
      rssi: 181,
    }]));
    await runInDurableObject(stub, async (_instance, state) => {
      const profile = JSON.stringify({
        _id: "node-heavy-profile",
        values: Array.from({ length: 7_985 }, () => 0),
      });
      state.storage.sql.exec(
        `INSERT INTO documents
          (collection, id, body, sort_time, created_at, updated_at)
         VALUES ('profile', 'node-heavy-profile', ?, ?, ?, ?)`,
        profile,
        now,
        now,
        now,
      );
      state.storage.sql.exec(
        `WITH RECURSIVE candidates(value) AS (
           VALUES (1)
           UNION ALL SELECT value + 1 FROM candidates WHERE value < 1000
         )
         INSERT INTO documents
           (collection, id, body, sort_time, created_at, updated_at)
         SELECT 'entries', printf('%024x', value + 5000),
                json_object(
                  '_id', printf('%024x', value + 5000),
                  'date', ? + value,
                  'type', 'sgv',
                  'sgv', CASE WHEN value % 2 = 0 THEN 151 ELSE 'not-a-number' END,
                  'mbg', CASE WHEN value % 2 = 0 THEN 111 ELSE NULL END,
                  'device', 'newer-non-sgv-candidate'
                ),
                ? + value, ?, ?
         FROM candidates`,
        now,
        now,
        now,
        now,
      );
    });

    const { sid } = await open(name);
    expect((await send(name, sid, clientPayload({ type: "connect", namespace: "/" }))).status)
      .toBe(200);
    expect((await poll(name, sid)).status).toBe(200);
    expect((await send(name, sid, clientPayload({
      type: "event",
      namespace: "/",
      id: 13,
      data: ["authorize", { client: "web" }],
    }))).status).toBe(200);
    const packets = socketPackets(await (await poll(name, sid)).text());
    const snapshot = eventValue(packets, "dataUpdate") as RealtimeSnapshot;
    expect(snapshot.sgvs).toEqual([expect.objectContaining({
      _id: "676767676767676767676767",
      mgdl: 147,
      device: "priority-cgm",
    })]);
    expect(snapshot.profiles).toEqual([]);
    expect(jsonNodeCount(snapshot)).toBeLessThanOrEqual(REALTIME_SNAPSHOT_MAX_NODES);

    const ddata = await SELF.fetch(
      `https://example.test/api/v2/ddata/at?tenant=${name}`,
    );
    expect(ddata.status).toBe(200);
    expect(await ddata.json()).toMatchObject({
      sgvs: [{
        _id: "676767676767676767676767",
        mgdl: 147,
        device: "priority-cgm",
        filtered: 31_001,
        unfiltered: 31_002,
        noise: 1,
        rssi: 181,
      }],
    });
  });

  it("bounds explicit ddata frames to the preceding two days and requested time", async () => {
    const name = tenant("eio-ddata-frame-window");
    const stub = env.ENTRY_STORE.getByName(name);
    const now = Date.now();
    const frameAt = now - 10 * 60_000;
    await stub.putEntries(parseEntryPayload([
      {
        _id: "919191919191919191919191",
        type: "sgv",
        sgv: 91,
        date: frameAt - 3 * 24 * 60 * 60_000,
        dateString: new Date(frameAt - 3 * 24 * 60 * 60_000).toISOString(),
        direction: "Flat",
        device: "stale-frame-cgm",
      },
      {
        _id: "929292929292929292929292",
        type: "sgv",
        sgv: 122,
        date: frameAt - 60_000,
        dateString: new Date(frameAt - 60_000).toISOString(),
        direction: "Flat",
        device: "before-frame-cgm",
        filtered: 42_001,
        unfiltered: 42_002,
        noise: 2,
        rssi: 172,
      },
      {
        _id: "939393939393939393939393",
        type: "sgv",
        sgv: 133,
        date: frameAt + 60_000,
        dateString: new Date(frameAt + 60_000).toISOString(),
        direction: "SingleUp",
        device: "after-frame-cgm",
      },
    ]));

    const response = await SELF.fetch(
      `https://example.test/api/v2/ddata/at/${frameAt}?tenant=${name}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      lastUpdated: frameAt,
      sgvs: [{
        _id: "929292929292929292929292",
        mgdl: 122,
        device: "before-frame-cgm",
        filtered: 42_001,
        unfiltered: 42_002,
        noise: 2,
        rssi: 172,
      }],
    });
  });

  it("round-trips root CONNECT and read-only authorize in locked packet order", async () => {
    const name = tenant("eio-root");
    const { sid } = await open(name);

    const connected = await send(
      name,
      sid,
      clientPayload({ type: "connect", namespace: "/" }),
    );
    expect(connected.status).toBe(200);
    expect(connected.headers.get("Content-Type")).toBe("text/html");
    expect(await connected.text()).toBe("ok");

    const connectPackets = decodeEngineIoV4PollingPayload(await (await poll(name, sid)).text())
      .map((packet) => unwrapSocketIoV5Packet(packet));
    expect(connectPackets).toHaveLength(2);
    expect(connectPackets[0]).toMatchObject({
      type: "connect",
      namespace: "/",
      data: { sid: expect.stringMatching(/^[A-Za-z0-9_-]{20}$/) },
    });
    expect(connectPackets[1]).toEqual({
      type: "event",
      namespace: "/",
      data: ["clients", 1],
    });

    expect((await send(name, sid, clientPayload({
      type: "event",
      namespace: "/",
      id: 4,
      data: ["authorize", { client: "web", status: true }],
    }))).status).toBe(200);
    const authorized = decodeEngineIoV4PollingPayload(await (await poll(name, sid)).text())
      .map((packet) => unwrapSocketIoV5Packet(packet));
    expect(authorized[0]).toEqual({
      type: "event",
      namespace: "/",
      data: ["connected"],
    });
    expect(authorized[1]).toMatchObject({
      type: "event",
      namespace: "/",
      data: ["dataUpdate", {
        devicestatus: [],
        sgvs: [],
        cals: [],
        profiles: [],
        mbgs: [],
        food: [],
        treatments: [],
        dbstats: {},
        status: {
          status: "ok",
          version: "15.0.8",
          versionNum: 150007,
        },
      }],
    });
    expect(authorized[2]).toEqual({
      type: "ack",
      namespace: "/",
      id: 4,
      data: [{ read: true, write: false, write_treatment: false }],
    });
  });

  it("loads 150 small one-day device groups without the former fixed 100-row cutoff", async () => {
    const name = tenant("eio-snapshot-bytes");
    const stub = env.ENTRY_STORE.getByName(name) as DurableObjectStub<EntryStore>;
    const now = Date.now();
    const statuses = Array.from({ length: 150 }, (_unused, deviceIndex) => ({
      _id: `status-${deviceIndex}`,
      device: `device-${deviceIndex.toString().padStart(3, "0")}`,
      created_at: new Date(now - (150 - deviceIndex) * 60_000).toISOString(),
      pump: { battery: 50 + (deviceIndex % 50) },
    }));
    statuses.push(...Array.from({ length: 12 }, (_unused, index) => ({
      _id: `same-device-${index}`,
      device: "same-device",
      created_at: new Date(now - (12 - index) * 30_000).toISOString(),
      pump: { battery: 70 + index },
    })));
    statuses.push({
      _id: "outside-one-day-window",
      device: "outside-device",
      created_at: new Date(now - 24 * 60 * 60_000 - 60_000).toISOString(),
      pump: { battery: 1 },
    });
    await stub.createDocuments("devicestatus", JSON.stringify(statuses));
    await stub.createDocuments("profile", JSON.stringify([{
      _id: "public-profile",
      defaultProfile: "Default",
      store: { Default: {}, "Private@@@@@copy": {} },
    }]));

    const huge = JSON.stringify({
      _id: "oversized-food",
      created_at: new Date(now + 60_000).toISOString(),
      partA: "a".repeat(225_000),
      partB: "b".repeat(225_000),
      partC: "c".repeat(225_000),
      partD: "d".repeat(225_000),
    });
    const trailing = JSON.stringify({
      _id: "lower-priority-food",
      created_at: new Date(now).toISOString(),
      carbs: 10,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO documents
           (collection, id, body, sort_time, created_at, updated_at)
         VALUES ('food', 'oversized-food', ?, ?, ?, ?),
                ('food', 'lower-priority-food', ?, ?, ?, ?)`,
        huge,
        now + 60_000,
        now,
        now,
        trailing,
        now,
        now,
        now,
      );
    });

    const { sid } = await open(name);
    expect((await send(name, sid, clientPayload({ type: "connect", namespace: "/" }))).status)
      .toBe(200);
    expect((await poll(name, sid)).status).toBe(200);
    expect((await send(name, sid, clientPayload({
      type: "event",
      namespace: "/",
      id: 40,
      data: ["authorize", { client: "web" }],
    }))).status).toBe(200);
    const authorizedResponse = await poll(name, sid);
    expect(authorizedResponse.status).toBe(200);
    const authorized = socketPackets(await authorizedResponse.text());
    expect(authorized.at(-1)).toEqual({
      type: "ack",
      namespace: "/",
      id: 40,
      data: [{ read: true, write: false, write_treatment: false }],
    });
    const data = eventValue(authorized, "dataUpdate") as RealtimeSnapshot;
    expect(data.devicestatus).toHaveLength(160);
    const groupCounts = new Map<string, number>();
    for (const status of data.devicestatus as Array<Record<string, unknown>>) {
      const device = String(status.device);
      groupCounts.set(device, (groupCounts.get(device) ?? 0) + 1);
    }
    expect(groupCounts.size).toBe(151);
    expect(groupCounts.get("same-device")).toBe(10);
    expect(groupCounts.get("device-000")).toBe(1);
    expect(data.devicestatus).not.toContainEqual(
      expect.objectContaining({ _id: "same-device-0" }),
    );
    expect(data.devicestatus).not.toContainEqual(
      expect.objectContaining({ _id: "same-device-1" }),
    );
    expect(data.devicestatus).not.toContainEqual(
      expect.objectContaining({ _id: "outside-one-day-window" }),
    );
    expect(data.profiles).toHaveLength(1);
    expect((data.profiles[0] as Record<string, any>).store)
      .not.toHaveProperty("Private@@@@@copy");
    expect(data).not.toHaveProperty("activity");
    expect(data).not.toHaveProperty("sitechangeTreatments");
    expect(data.food).toEqual([]);
    expect(new TextEncoder().encode(JSON.stringify(data)).byteLength)
      .toBeLessThanOrEqual(REALTIME_SNAPSHOT_MAX_BYTES);
    expect(await stub.realtimeValidateSession(sid)).toEqual({ ok: true, value: null });

    expect((await send(name, sid, clientPayload({
      type: "event",
      namespace: "/",
      id: 41,
      data: ["loadRetro", { loadedMills: 0 }],
    }))).status).toBe(200);
    const retroResponse = await poll(name, sid);
    expect(retroResponse.status).toBe(200);
    const retro = socketPackets(await retroResponse.text());
    expect(retro[0]).toEqual({
      type: "ack",
      namespace: "/",
      id: 41,
      data: [{ result: "success" }],
    });
    const retroStatuses = (
      eventValue(retro, "retroUpdate") as { devicestatus: Array<Record<string, unknown>> }
    ).devicestatus;
    expect(retroStatuses).toHaveLength(162);
    expect(retroStatuses.filter((status) => status.device === "same-device"))
      .toHaveLength(12);
    expect(retroStatuses).not.toContainEqual(
      expect.objectContaining({ _id: "outside-one-day-window" }),
    );
    expect(await stub.realtimeValidateSession(sid)).toEqual({ ok: true, value: null });
  });

  it("rejects an over-deep stored document before runtime cloning without closing the SID", async () => {
    const name = tenant("eio-snapshot-depth");
    const stub = env.ENTRY_STORE.getByName(name) as DurableObjectStub<EntryStore>;
    const now = Date.now();
    const createdAt = new Date(now + 60_000).toISOString();
    const tooDeep =
      `{"_id":"too-deep","created_at":"${createdAt}","nested":` +
      "{\"child\":".repeat(5_000) +
      "{\"leaf\":true}" +
      "}".repeat(5_000) +
      "}";
    const trailing = JSON.stringify({
      _id: "after-too-deep",
      created_at: new Date(now).toISOString(),
      carbs: 12,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO documents
           (collection, id, body, sort_time, created_at, updated_at)
         VALUES ('food', 'too-deep', ?, ?, ?, ?),
                ('food', 'after-too-deep', ?, ?, ?, ?)`,
        tooDeep,
        now + 60_000,
        now,
        now,
        trailing,
        now,
        now,
        now,
      );
    });

    const { sid } = await open(name);
    expect((await send(name, sid, clientPayload({ type: "connect", namespace: "/" }))).status)
      .toBe(200);
    expect((await poll(name, sid)).status).toBe(200);
    expect((await send(name, sid, clientPayload({
      type: "event",
      namespace: "/",
      id: 45,
      data: ["authorize", { client: "web" }],
    }))).status).toBe(200);
    const authorizedResponse = await poll(name, sid);
    expect(authorizedResponse.status).toBe(200);
    const authorized = socketPackets(await authorizedResponse.text());
    expect(authorized.at(-1)).toEqual({
      type: "ack",
      namespace: "/",
      id: 45,
      data: [{ read: true, write: false, write_treatment: false }],
    });
    expect((eventValue(authorized, "dataUpdate") as RealtimeSnapshot).food).toEqual([]);
    expect(await stub.realtimeValidateSession(sid)).toEqual({ ok: true, value: null });
  });

  it("truncates thousands of tiny documents at the shared node budget without closing the SID", async () => {
    const name = tenant("eio-snapshot-nodes");
    const stub = env.ENTRY_STORE.getByName(name) as DurableObjectStub<EntryStore>;
    const now = Date.now();
    await runInDurableObject(stub, async (_instance, state) => {
      const depth24Profile =
        `{"_id":"depth-24-profile","nested":` +
        "[".repeat(23) +
        "0" +
        "]".repeat(23) +
        "}";
      state.storage.sql.exec(
        `INSERT INTO documents
           (collection, id, body, sort_time, created_at, updated_at)
         VALUES ('profile', 'depth-24-profile', ?, ?, ?, ?)`,
        depth24Profile,
        now,
        now,
        now,
      );
      state.storage.sql.exec(
        `WITH digits(value) AS (
           VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
         ), sequence(value) AS (
           SELECT ones.value + 10 * tens.value + 100 * hundreds.value + 1000 * thousands.value
           FROM digits AS ones
           CROSS JOIN digits AS tens
           CROSS JOIN digits AS hundreds
           CROSS JOIN digits AS thousands
           WHERE ones.value + 10 * tens.value + 100 * hundreds.value + 1000 * thousands.value < 2500
         )
         INSERT INTO documents
           (collection, id, body, sort_time, created_at, updated_at)
         SELECT 'food',
                'tiny-' || value,
                json_object(
                  '_id', 'tiny-' || value,
                  'created_at', ? - value,
                  'carbs', value % 10
                ),
                ? - value,
                ?,
                ?
         FROM sequence`,
        now,
        now,
        now,
        now,
      );
    });

    const { sid } = await open(name);
    expect((await send(name, sid, clientPayload({ type: "connect", namespace: "/" }))).status)
      .toBe(200);
    expect((await poll(name, sid)).status).toBe(200);
    expect((await send(name, sid, clientPayload({
      type: "event",
      namespace: "/",
      id: 50,
      data: ["authorize", { client: "web" }],
    }))).status).toBe(200);
    const authorizedResponse = await poll(name, sid);
    expect(authorizedResponse.status).toBe(200);
    const authorized = socketPackets(await authorizedResponse.text());
    expect(authorized.at(-1)).toEqual({
      type: "ack",
      namespace: "/",
      id: 50,
      data: [{ read: true, write: false, write_treatment: false }],
    });
    const data = eventValue(authorized, "dataUpdate") as RealtimeSnapshot;
    expect(data.profiles).toHaveLength(1);
    expect((data.profiles[0] as Record<string, unknown>)._id).toBe("depth-24-profile");
    expect(data.food.length).toBeGreaterThan(1_000);
    expect(data.food.length).toBeLessThan(REALTIME_SNAPSHOT_MAX_DOCUMENTS);
    const foods = data.food as Array<Record<string, unknown>>;
    expect(foods[0]?._id).toBe("tiny-0");
    expect(foods.at(-1)?._id).toBe(`tiny-${foods.length - 1}`);
    const nodes = jsonNodeCount(data);
    expect(nodes).toBeGreaterThan(REALTIME_SNAPSHOT_MAX_NODES - 10);
    expect(nodes).toBeLessThanOrEqual(REALTIME_SNAPSHOT_MAX_NODES);
    expect(new TextEncoder().encode(JSON.stringify(data)).byteLength)
      .toBeLessThan(REALTIME_SNAPSHOT_MAX_BYTES);
    expect(await stub.realtimeValidateSession(sid)).toEqual({ ok: true, value: null });
  });

  it("stops an otherwise-small snapshot at exactly the shared document cap", async () => {
    const name = tenant("eio-snapshot-documents");
    const stub = env.ENTRY_STORE.getByName(name) as DurableObjectStub<EntryStore>;
    const now = Date.now();
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `WITH digits(value) AS (
           VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
         ), sequence(value) AS (
           SELECT ones.value + 10 * tens.value + 100 * hundreds.value + 1000 * thousands.value
           FROM digits AS ones
           CROSS JOIN digits AS tens
           CROSS JOIN digits AS hundreds
           CROSS JOIN digits AS thousands
           WHERE ones.value + 10 * tens.value + 100 * hundreds.value + 1000 * thousands.value < 2100
         )
         INSERT INTO documents
           (collection, id, body, sort_time, created_at, updated_at)
         SELECT 'food',
                'doccap-' || printf('%04d', value),
                '{}',
                ? - value,
                ?,
                ?
         FROM sequence`,
        now,
        now,
        now,
      );
    });

    const { sid } = await open(name);
    expect((await send(name, sid, clientPayload({ type: "connect", namespace: "/" }))).status)
      .toBe(200);
    expect((await poll(name, sid)).status).toBe(200);
    expect((await send(name, sid, clientPayload({
      type: "event",
      namespace: "/",
      id: 55,
      data: ["authorize", { client: "web" }],
    }))).status).toBe(200);
    const authorizedResponse = await poll(name, sid);
    expect(authorizedResponse.status).toBe(200);
    const authorized = socketPackets(await authorizedResponse.text());
    expect(authorized.at(-1)).toEqual({
      type: "ack",
      namespace: "/",
      id: 55,
      data: [{ read: true, write: false, write_treatment: false }],
    });
    const data = eventValue(authorized, "dataUpdate") as RealtimeSnapshot;
    const foods = data.food as Array<Record<string, unknown>>;
    expect(foods).toHaveLength(REALTIME_SNAPSHOT_MAX_DOCUMENTS);
    expect(foods[0]?._id).toBe("doccap-0000");
    expect(foods.at(-1)?._id).toBe("doccap-1999");
    expect(foods.every((food) => String(food._id).startsWith("doccap-"))).toBe(true);
    expect(jsonNodeCount(data)).toBeLessThanOrEqual(REALTIME_SNAPSHOT_MAX_NODES);
    expect(new TextEncoder().encode(JSON.stringify(data)).byteLength)
      .toBeLessThan(REALTIME_SNAPSHOT_MAX_BYTES);
    expect(await stub.realtimeValidateSession(sid)).toEqual({ ok: true, value: null });
  });

  it("keeps SIDs tenant-local and rejects invalid tenant names", async () => {
    const alpha = tenant("eio-alpha");
    const beta = tenant("eio-beta");
    const { sid } = await open(alpha);

    const crossed = await poll(beta, sid);
    expect(crossed.status).toBe(400);
    expect(await crossed.json()).toEqual({ code: 1, message: "Session ID unknown" });

    await send(alpha, sid, clientPayload({ type: "connect", namespace: "/" }));
    expect((await poll(alpha, sid)).status).toBe(200);

    const invalid = await SELF.fetch(
      "https://example.test/socket.io/?EIO=4&transport=polling&tenant=Not%20Safe",
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: "invalid_tenant" },
    });
  });

  it("bounds POST bodies, rejects binary polling, and releases the POST lease", async () => {
    const contentTypeTenant = tenant("eio-content-type");
    const contentTypeSid = (await open(contentTypeTenant)).sid;
    const binary = await send(
      contentTypeTenant,
      contentTypeSid,
      "4binary",
      { "Content-Type": "application/octet-stream" },
    );
    expect(binary.status).toBe(400);
    expect(await binary.json()).toEqual({ code: 3, message: "Bad request" });

    const binaryClosed = await poll(contentTypeTenant, contentTypeSid);
    expect(binaryClosed.status).toBe(400);
    expect(await binaryClosed.json()).toEqual({
      code: 1,
      message: "Session ID unknown",
    });
    const unknownBinary = await send(
      contentTypeTenant,
      "unknown-sid",
      "4binary",
      { "Content-Type": "application/octet-stream" },
    );
    expect(unknownBinary.status).toBe(400);
    expect(await unknownBinary.json()).toEqual({
      code: 1,
      message: "Session ID unknown",
    });

    const textTenant = tenant("eio-content-type-text");
    const textSid = (await open(textTenant)).sid;
    await send(
      textTenant,
      textSid,
      clientPayload({ type: "connect", namespace: "/" }),
      { "Content-Type": "application/json" },
    );
    expect((await poll(textTenant, textSid)).status).toBe(200);

    const parameterTenant = tenant("eio-content-type-parameter");
    const parameterSid = (await open(parameterTenant)).sid;
    expect((await send(
      parameterTenant,
      parameterSid,
      clientPayload({ type: "connect", namespace: "/" }),
      { "Content-Type": "application/octet-stream; charset=UTF-8" },
    )).status).toBe(200);
    expect((await poll(parameterTenant, parameterSid)).status).toBe(200);

    const largeTenant = tenant("eio-large");
    const largeSid = (await open(largeTenant)).sid;
    const oversized = await send(largeTenant, largeSid, "4" + "a".repeat(1_000_000));
    expect(oversized.status).toBe(413);
    expect(await oversized.text()).toBe("");
    await send(largeTenant, largeSid, clientPayload({ type: "connect", namespace: "/" }));
    expect((await poll(largeTenant, largeSid)).status).toBe(200);

    const utf8Tenant = tenant("eio-utf8");
    const utf8Sid = (await open(utf8Tenant)).sid;
    const invalidUtf8 = await SELF.fetch(endpoint(utf8Tenant, `&sid=${utf8Sid}`), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: new Uint8Array([0xff]),
    });
    expect(invalidUtf8.status).toBe(200);
    expect(invalidUtf8.headers.get("Content-Type")).toBe("text/html");
    expect(await invalidUtf8.text()).toBe("ok");
    const invalidUtf8Closed = await poll(utf8Tenant, utf8Sid);
    expect(invalidUtf8Closed.status).toBe(400);
    expect(await invalidUtf8Closed.json()).toEqual({
      code: 1,
      message: "Session ID unknown",
    });
  });

  it("returns 200 ok for a malformed protocol POST, then makes the closed SID unknown", async () => {
    const name = tenant("eio-malformed");
    const { sid } = await open(name);
    const malformed = await send(name, sid, "4not-socket-io");
    expect(malformed.status).toBe(200);
    expect(malformed.headers.get("Content-Type")).toBe("text/html");
    expect(await malformed.text()).toBe("ok");

    const closed = await poll(name, sid);
    expect(closed.status).toBe(400);
    expect(await closed.json()).toEqual({ code: 1, message: "Session ID unknown" });
  });

  it("returns empty 500 responses for active GET and POST lease overlap", async () => {
    const pollTenant = tenant("eio-get-overlap");
    const pollSid = (await open(pollTenant)).sid;
    const pollStub = env.ENTRY_STORE.getByName(pollTenant) as DurableObjectStub<EntryStore>;
    const activePoll = pollStub.realtimePoll(pollSid);
    await vi.waitFor(async () => {
      expect(await hasActivePoll(pollStub, pollSid)).toBe(true);
    });
    const getOverlap = await poll(pollTenant, pollSid);
    expect(getOverlap.status).toBe(500);
    expect(await getOverlap.text()).toBe("");
    await expect(activePoll).resolves.toMatchObject({
      ok: false,
      error: { code: "unknown_sid" },
    });

    const postTenant = tenant("eio-post-overlap");
    const postSid = (await open(postTenant)).sid;
    const postStub = env.ENTRY_STORE.getByName(postTenant) as DurableObjectStub<EntryStore>;
    const activeLease = await postStub.realtimeBeginPost(postSid);
    expect(activeLease.ok).toBe(true);
    const postOverlap = await send(postTenant, postSid, "3");
    expect(postOverlap.status).toBe(500);
    expect(await postOverlap.text()).toBe("");
  });

  it("accepts pong data and rejects durably stale SIDs after eviction", async () => {
    const name = tenant("eio-heartbeat");
    const { sid } = await open(name);
    const stub = env.ENTRY_STORE.getByName(name) as DurableObjectStub<EntryStore>;

    const pong = await send(
      name,
      sid,
      encodeEngineIoV4PollingPayload([{ type: "pong", data: "probe" }]),
    );
    expect(pong.status).toBe(200);

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE realtime_sessions SET last_seen_at = ? WHERE sid = ?",
        Date.now() - 10 * 60_000,
        sid,
      );
    });
    await evictDurableObject(stub);
    const expired = await poll(name, sid);
    expect(expired.status).toBe(400);
    expect(await expired.json()).toEqual({ code: 1, message: "Session ID unknown" });
  });
});
