import { env } from "cloudflare:workers";
import {
  SELF,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ENTRY_STORE_ACTIVATION_SEAL, type EntryStore } from "../src/entry-store";
import {
  decodeEngineIoV4Handshake,
  decodeEngineIoV4Packet,
  decodeEngineIoV4PollingPayload,
  encodeEngineIoV4Packet,
  encodeEngineIoV4PollingPayload,
  unwrapSocketIoV5Packet,
  wrapSocketIoV5Packet,
  type SocketIoV5Packet,
} from "../src/protocol";

const TEST_API_SECRET = "nscf-test-secret-20260717";

type JsonObject = Record<string, unknown>;

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function store(name: string): DurableObjectStub<EntryStore> {
  return env.ENTRY_STORE.getByName(name);
}

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

async function adminWrite(
  tenantName: string,
  path: string,
  payload: unknown,
): Promise<Response> {
  return SELF.fetch(`https://example.test${path}?tenant=${tenantName}`, {
    method: "POST",
    headers: {
      "api-secret": await secretDigest(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function issueSubject(
  tenantName: string,
  roles: string[],
  permissions?: string[],
): Promise<{ accessToken: string; jwt: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const assignedRoles = [...roles];
  if (permissions !== undefined) {
    const roleName = `alarm-role-${suffix}`;
    expect((await adminWrite(tenantName, "/api/v2/authorization/roles", {
      name: roleName,
      permissions,
    })).status).toBe(200);
    assignedRoles.push(roleName);
  }

  const created = await adminWrite(
    tenantName,
    "/api/v2/authorization/subjects",
    { name: `Alarm subject ${suffix}`, roles: assignedRoles },
  );
  expect(created.status).toBe(200);
  const createdBody = await created.json<JsonObject>();
  const listed = await SELF.fetch(
    `https://example.test/api/v2/authorization/subjects?tenant=${tenantName}`,
    { headers: { "api-secret": await secretDigest() } },
  );
  expect(listed.status).toBe(200);
  const subject = (await listed.json<JsonObject[]>()).find(
    (candidate) => candidate._id === createdBody._id,
  );
  if (subject === undefined || typeof subject.accessToken !== "string") {
    throw new Error("created alarm subject has no access token");
  }
  const jwtResponse = await SELF.fetch(
    `https://example.test/api/v2/authorization/request/${encodeURIComponent(subject.accessToken)}?tenant=${tenantName}`,
  );
  expect(jwtResponse.status).toBe(200);
  const jwt = (await jwtResponse.json<JsonObject>()).token;
  if (typeof jwt !== "string") throw new Error("authorization response has no JWT");
  return { accessToken: subject.accessToken, jwt };
}

function pollingEndpoint(tenantName: string, sid?: string): string {
  const suffix = sid === undefined ? "" : `&sid=${encodeURIComponent(sid)}`;
  return `https://example.test/socket.io/?EIO=4&transport=polling&tenant=${tenantName}${suffix}`;
}

function clientPayload(packet: SocketIoV5Packet): string {
  return encodeEngineIoV4PollingPayload([wrapSocketIoV5Packet(packet)]);
}

function socketPackets(payload: string): SocketIoV5Packet[] {
  return decodeEngineIoV4PollingPayload(payload)
    .filter((packet) => packet.type === "message")
    .map((packet) => unwrapSocketIoV5Packet(packet));
}

interface PollingSocket {
  sid: string;
  send(packet: SocketIoV5Packet): Promise<Response>;
  poll(): Promise<SocketIoV5Packet[]>;
}

async function openAlarmPolling(tenantName: string): Promise<PollingSocket> {
  const handshake = await SELF.fetch(pollingEndpoint(tenantName));
  expect(handshake.status).toBe(200);
  const [openPacket] = decodeEngineIoV4PollingPayload(await handshake.text());
  const sid = decodeEngineIoV4Handshake(openPacket!).sid;
  const socket: PollingSocket = {
    sid,
    send: (packet) => SELF.fetch(pollingEndpoint(tenantName, sid), {
      method: "POST",
      body: clientPayload(packet),
    }),
    poll: async () => socketPackets(
      await (await SELF.fetch(pollingEndpoint(tenantName, sid))).text(),
    ),
  };
  expect((await socket.send({ type: "connect", namespace: "/alarm" })).status).toBe(200);
  expect(await socket.poll()).toEqual([{
    type: "connect",
    namespace: "/alarm",
    data: { sid: expect.stringMatching(/^[A-Za-z0-9_-]{20}$/) },
  }]);
  return socket;
}

async function subscribe(
  socket: PollingSocket,
  id: number,
  message: JsonObject,
): Promise<SocketIoV5Packet> {
  expect((await socket.send({
    type: "event",
    namespace: "/alarm",
    id,
    data: ["subscribe", message],
  })).status).toBe(200);
  const packets = await socket.poll();
  expect(packets).toHaveLength(1);
  return packets[0]!;
}

async function queuedFrames(tenantName: string, sid: string): Promise<number> {
  return runInDurableObject(store(tenantName), async (_instance, state) =>
    state.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM realtime_outbound_packets WHERE sid = ?",
      sid,
    ).one().count
  );
}

class WebSocketInbox {
  private readonly queued: string[] = [];
  private readonly waiters: Array<(value: string) => void> = [];

  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const waiter = this.waiters.shift();
      if (waiter === undefined) this.queued.push(event.data);
      else waiter(event.data);
    });
  }

  next(timeoutMs = 2_000): Promise<string> {
    const queued = this.queued.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for websocket")),
        timeoutMs,
      );
      this.waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }
}

function websocketEndpoint(tenantName: string): string {
  return `https://example.test/socket.io/?EIO=4&transport=websocket&tenant=${tenantName}`;
}

function websocketClientFrame(packet: SocketIoV5Packet): string {
  return encodeEngineIoV4Packet(wrapSocketIoV5Packet(packet));
}

function websocketPacket(frame: string): SocketIoV5Packet {
  return unwrapSocketIoV5Packet(decodeEngineIoV4Packet(frame));
}

async function openAlarmWebSocket(tenantName: string): Promise<WebSocketInbox> {
  const response = await SELF.fetch(websocketEndpoint(tenantName), {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  if (response.webSocket === null) throw new Error("websocket upgrade returned no socket");
  const inbox = new WebSocketInbox(response.webSocket);
  response.webSocket.accept();
  decodeEngineIoV4Handshake(decodeEngineIoV4Packet(await inbox.next()));
  inbox.socket.send(websocketClientFrame({ type: "connect", namespace: "/alarm" }));
  expect(websocketPacket(await inbox.next())).toMatchObject({
    type: "connect",
    namespace: "/alarm",
  });
  return inbox;
}

describe("API3 /alarm Socket.IO namespace", () => {
  it("connects independently and preserves native versus web subscription responses", async () => {
    const name = tenant("alarm-subscribe");
    const ordinary = await issueSubject(name, []);
    const acknowledger = await issueSubject(name, [], ["notifications:*:ack"]);
    const socket = await openAlarmPolling(name);

    expect(await subscribe(socket, 1, {})).toEqual({
      type: "ack",
      namespace: "/alarm",
      id: 1,
      data: [{
        success: true,
        message: "Subscribed for alarms",
        read: true,
        ack: false,
      }],
    });
    expect(await subscribe(socket, 2, { accessToken: "INVALID" })).toEqual({
      type: "ack",
      namespace: "/alarm",
      id: 2,
      data: [{ success: false, message: "Missing or bad accessToken" }],
    });
    expect(await subscribe(socket, 3, {
      accessToken: "INVALID",
      secret: await secretDigest(),
    })).toEqual({
      type: "ack",
      namespace: "/alarm",
      id: 3,
      data: [{ success: false, message: "Missing or bad accessToken" }],
    });
    expect(await subscribe(socket, 4, { accessToken: "" })).toMatchObject({
      type: "ack",
      data: [{ success: true, read: true, ack: false }],
    });
    expect(await subscribe(socket, 5, { accessToken: ordinary.accessToken })).toEqual({
      type: "ack",
      namespace: "/alarm",
      id: 5,
      data: [{ success: true, message: "Subscribed for alarms" }],
    });
    expect(await subscribe(socket, 6, { jwtToken: ordinary.jwt })).toMatchObject({
      type: "ack",
      data: [{ success: true, read: true, ack: false }],
    });
    expect(await subscribe(socket, 7, { jwtToken: acknowledger.jwt })).toMatchObject({
      type: "ack",
      data: [{ success: true, read: true, ack: true }],
    });
    expect(await subscribe(socket, 8, { jwtToken: "INVALID" })).toEqual({
      type: "ack",
      namespace: "/alarm",
      id: 8,
      data: [{ success: false, message: "Missing or bad accessToken" }],
    });
    expect(await subscribe(socket, 9, { secret: await secretDigest() })).toMatchObject({
      type: "ack",
      data: [{ success: true, read: true, ack: true }],
    });
  });

  it("broadcasts the five locked event classes to current namespace connections only", async () => {
    const name = tenant("alarm-events");
    const beta = tenant("alarm-events-beta");
    const first = await openAlarmPolling(name);
    const second = await openAlarmPolling(name);
    const isolated = await openAlarmPolling(beta);
    const events: Array<{ notification: JsonObject; name: string }> = [
      {
        notification: { clear: true, level: 2, title: "clear" },
        name: "clear_alarm",
      },
      {
        notification: { level: 1, isAnnouncement: true, title: "warning wins" },
        name: "alarm",
      },
      {
        notification: { level: 2, title: "urgent" },
        name: "urgent_alarm",
      },
      {
        notification: { level: 0, isAnnouncement: true, title: "announcement" },
        name: "announcement",
      },
      {
        notification: { level: 0, title: "information" },
        name: "notification",
      },
    ];

    for (const event of events) {
      expect(await store(name).publishAlarmNotification(
        JSON.stringify(event.notification),
      )).toBe(2);
      for (const socket of [first, second]) {
        expect(await socket.poll()).toEqual([{
          type: "event",
          namespace: "/alarm",
          data: [event.name, event.notification],
        }]);
      }
      expect(await queuedFrames(beta, isolated.sid)).toBe(0);
    }

    expect((await second.send({ type: "disconnect", namespace: "/alarm" })).status).toBe(200);
    const afterDisconnect = { level: 1, title: "one remaining connection" };
    expect(await store(name).publishAlarmNotification(
      JSON.stringify(afterDisconnect),
    )).toBe(1);
    expect(await first.poll()).toEqual([{
      type: "event",
      namespace: "/alarm",
      data: ["alarm", afterDisconnect],
    }]);
    expect(await queuedFrames(name, second.sid)).toBe(0);

    const beforeConnect = tenant("alarm-no-replay");
    expect(await store(beforeConnect).publishAlarmNotification(
      JSON.stringify({ level: 1, title: "not replayed" }),
    )).toBe(0);
    const later = await openAlarmPolling(beforeConnect);
    expect(await queuedFrames(beforeConnect, later.sid)).toBe(0);
  });

  it("enforces ACK authority, broadcasts exact clear payloads, and persists silence", async () => {
    const name = tenant("alarm-ack");
    const native = await issueSubject(name, ["denied"]);
    const authorized = await openAlarmPolling(name);
    const readOnly = await openAlarmPolling(name);
    const connectedOnly = await openAlarmPolling(name);
    expect(await subscribe(authorized, 10, { accessToken: native.accessToken }))
      .toMatchObject({ type: "ack", data: [{ success: true }] });
    // Socket.IO adds another listener on every successful subscribe. A later
    // read-only web subscription therefore must not revoke the earlier native
    // ACK listener for this namespace connection.
    expect(await subscribe(authorized, 12, {}))
      .toMatchObject({ type: "ack", data: [{ success: true, ack: false }] });
    expect(await subscribe(readOnly, 11, {}))
      .toMatchObject({ type: "ack", data: [{ success: true, ack: false }] });

    expect((await readOnly.send({
      type: "event",
      namespace: "/alarm",
      data: ["ack", 2, "default", 60_000],
    })).status).toBe(200);
    for (const socket of [authorized, readOnly, connectedOnly]) {
      expect(await queuedFrames(name, socket.sid)).toBe(0);
    }

    expect((await authorized.send({
      type: "event",
      namespace: "/alarm",
      data: ["ack", 2, "default", 60_000],
    })).status).toBe(200);
    const expectedClear: SocketIoV5Packet = {
      type: "event",
      namespace: "/alarm",
      data: ["clear_alarm", {
        clear: true,
        title: "All Clear",
        message: "default - Urgent was ack'd",
        group: "default",
      }],
    };
    for (const socket of [authorized, readOnly, connectedOnly]) {
      expect(await socket.poll()).toEqual([expectedClear]);
    }

    await runInDurableObject(store(name), async (_instance, state) => {
      expect(state.storage.sql.exec<{
        level: number;
        alarm_group: string;
        silence_time: number;
      }>(
        `SELECT level, alarm_group, silence_time
         FROM realtime_alarm_silences ORDER BY level`,
      ).toArray()).toEqual([
        { level: 1, alarm_group: "default", silence_time: 60_000 },
        { level: 2, alarm_group: "default", silence_time: 60_000 },
      ]);
    });

    await evictDurableObject(store(name));
    expect((await authorized.send({
      type: "event",
      namespace: "/alarm",
      data: ["ack", 2, "default", 60_000],
    })).status).toBe(200);
    for (const socket of [authorized, readOnly, connectedOnly]) {
      expect(await queuedFrames(name, socket.sid)).toBe(0);
    }

    expect((await authorized.send({
      type: "event",
      namespace: "/alarm",
      data: ["ack", 1, "null-time", null],
    })).status).toBe(200);
    for (const socket of [authorized, readOnly, connectedOnly]) {
      expect(await socket.poll()).toEqual([{
        type: "event",
        namespace: "/alarm",
        data: ["clear_alarm", {
          clear: true,
          title: "All Clear",
          message: "null-time - Warning was ack'd",
          group: "null-time",
        }],
      }]);
    }
    await runInDurableObject(store(name), async (_instance, state) => {
      expect(state.storage.sql.exec<{ silence_time: number }>(
        `SELECT silence_time FROM realtime_alarm_silences
         WHERE level = 1 AND alarm_group = 'null-time'`,
      ).one().silence_time).toBe(30 * 60 * 1_000);
    });
  });

  it("inherits the official HTTP notification ACK through v1 and v2", async () => {
    for (const version of ["v1", "v2"] as const) {
      const name = tenant(`notification-http-${version}`);
      const socket = await openAlarmPolling(name);
      const level = version === "v1" ? 1 : 2;
      const group = `http-${version}`;
      const target =
        `https://example.test/api/${version}/notifications/ack`
        + `?tenant=${name}&level=${level}&group=${group}&time=60000`;

      const anonymous = await SELF.fetch(target);
      expect(anonymous.status).toBe(401);
      expect(await queuedFrames(name, socket.sid)).toBe(0);

      const headers = version === "v1"
        ? { "api-secret": await secretDigest() }
        : {
          "api-secret": (await issueSubject(
            name,
            [],
            ["notifications:*:ack"],
          )).accessToken,
        };
      const acknowledged = await SELF.fetch(target, { headers });
      expect(acknowledged.status).toBe(200);
      expect(acknowledged.headers.get("Content-Type")).toBe(
        "text/plain; charset=utf-8",
      );
      expect(acknowledged.headers.get("Cache-Control")).toBe("no-store");
      expect(await acknowledged.text()).toBe("OK");
      expect(await socket.poll()).toEqual([{
        type: "event",
        namespace: "/alarm",
        data: ["clear_alarm", {
          clear: true,
          title: "All Clear",
          message: `${group} - ${level === 2 ? "Urgent" : "Warning"} was ack'd`,
          group,
        }],
      }]);

      await runInDurableObject(store(name), async (_instance, state) => {
        const rows = state.storage.sql.exec<{
          level: number;
          alarm_group: string;
          silence_time: number;
        }>(
          `SELECT level, alarm_group, silence_time
           FROM realtime_alarm_silences
           WHERE alarm_group = ? ORDER BY level`,
          group,
        ).toArray();
        expect(rows).toEqual(level === 2
          ? [
            { level: 1, alarm_group: group, silence_time: 60_000 },
            { level: 2, alarm_group: group, silence_time: 60_000 },
          ]
          : [{ level: 1, alarm_group: group, silence_time: 60_000 }]);
      });

      await evictDurableObject(store(name));
      const repeated = await SELF.fetch(target, { headers });
      expect(repeated.status).toBe(200);
      expect(await repeated.text()).toBe("OK");
      expect(await queuedFrames(name, socket.sid)).toBe(0);
    }
  });

  it("delivers an HTTP ACK to an evicted hibernatable socket and bounds malformed state", async () => {
    const name = tenant("notification-http-websocket");
    const inbox = await openAlarmWebSocket(name);
    await evictDurableObject(store(name));

    const target =
      `https://example.test/api/v2/notifications/ack`
      + `?tenant=${name}&level=1&group=http-websocket&time=45000`;
    const response = await SELF.fetch(target, {
      headers: { "api-secret": await secretDigest() },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(websocketPacket(await inbox.next())).toEqual({
      type: "event",
      namespace: "/alarm",
      data: ["clear_alarm", {
        clear: true,
        title: "All Clear",
        message: "http-websocket - Warning was ack'd",
        group: "http-websocket",
      }],
    });

    const invalidName = tenant("notification-http-invalid");
    const invalidTargets = [
      `https://example.test/api/v1/notifications/ack?tenant=${invalidName}`,
      `https://example.test/api/v1/notifications/ack?tenant=${invalidName}&level=99`,
      `https://example.test/api/v2/notifications/ack?tenant=${invalidName}&level=1&group=${"x".repeat(257)}`,
      `https://example.test/api/v2/notifications/ack?tenant=${invalidName}&level=1&group=bad-time&time=Infinity`,
    ];
    for (const invalidTarget of invalidTargets) {
      const invalid = await SELF.fetch(invalidTarget, {
        headers: { "api-secret": await secretDigest() },
      });
      expect(invalid.status).toBe(200);
      expect(await invalid.text()).toBe("OK");
    }
    await runInDurableObject(store(invalidName), async (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM realtime_alarm_silences",
      ).one().count).toBe(0);
    });
  });

  it("delivers notifications and ACK clears to a hibernatable WebSocket after eviction", async () => {
    const name = tenant("alarm-websocket");
    const native = await issueSubject(name, []);
    const inbox = await openAlarmWebSocket(name);
    inbox.socket.send(websocketClientFrame({
      type: "event",
      namespace: "/alarm",
      id: 12,
      data: ["subscribe", { accessToken: native.accessToken }],
    }));
    expect(websocketPacket(await inbox.next())).toEqual({
      type: "ack",
      namespace: "/alarm",
      id: 12,
      data: [{ success: true, message: "Subscribed for alarms" }],
    });

    await evictDurableObject(store(name));
    const warning = { level: 1, title: "Warning HIGH", group: "default" };
    expect(await store(name).publishAlarmNotification(JSON.stringify(warning))).toBe(1);
    expect(websocketPacket(await inbox.next())).toEqual({
      type: "event",
      namespace: "/alarm",
      data: ["alarm", warning],
    });

    inbox.socket.send(websocketClientFrame({
      type: "event",
      namespace: "/alarm",
      data: ["ack", 1, "default", 30_000],
    }));
    expect(websocketPacket(await inbox.next())).toEqual({
      type: "event",
      namespace: "/alarm",
      data: ["clear_alarm", {
        clear: true,
        title: "All Clear",
        message: "default - Warning was ack'd",
        group: "default",
      }],
    });
  });

  it("drops a broken alarm recipient without failing the trusted publisher", async () => {
    const name = tenant("alarm-outbox-failure");
    const socket = await openAlarmPolling(name);
    await runInDurableObject(store(name), async (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER fail_alarm_outbound
        BEFORE INSERT ON realtime_outbound_packets
        BEGIN
          SELECT RAISE(ABORT, 'forced alarm outbound failure');
        END;
      `);
    });

    expect(await store(name).publishAlarmNotification(
      JSON.stringify({ level: 1, title: "bounded failure" }),
    )).toBe(0);
    await runInDurableObject(store(name), async (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM realtime_sessions WHERE sid = ?",
        socket.sid,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM realtime_alarm_connections WHERE sid = ?",
        socket.sid,
      ).one().count).toBe(0);
      state.storage.sql.exec("DROP TRIGGER fail_alarm_outbound");
    });
  });

  it("persists an HTTP ACK while isolating a broken alarm recipient", async () => {
    const name = tenant("notification-http-outbox-failure");
    const socket = await openAlarmPolling(name);
    await runInDurableObject(store(name), async (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER fail_http_ack_outbound
        BEFORE INSERT ON realtime_outbound_packets
        BEGIN
          SELECT RAISE(ABORT, 'forced HTTP ACK outbound failure');
        END;
      `);
    });

    const response = await SELF.fetch(
      `https://example.test/api/v1/notifications/ack`
        + `?tenant=${name}&level=1&group=broken-recipient&time=30000`,
      { headers: { "api-secret": await secretDigest() } },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    await runInDurableObject(store(name), async (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM realtime_sessions WHERE sid = ?",
        socket.sid,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{
        last_ack_at: number;
        silence_time: number;
      }>(
        `SELECT last_ack_at, silence_time
         FROM realtime_alarm_silences
         WHERE level = 1 AND alarm_group = 'broken-recipient'`,
      ).one()).toMatchObject({
        last_ack_at: expect.any(Number),
        silence_time: 30_000,
      });
      state.storage.sql.exec("DROP TRIGGER fail_http_ack_outbound");
    });
  });

  it("repairs the v10 alarm schema despite a higher independent marker", async () => {
    const name = tenant("alarm-migrate-v10");
    const stub = store(name);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`
        DROP INDEX IF EXISTS realtime_alarm_connections_order;
        DROP TABLE realtime_alarm_silences;
        DROP TABLE realtime_alarm_connections;
      `);
      state.storage.sql.exec(
        "DELETE FROM _sql_schema_migrations WHERE id IN (10, ?)",
        ENTRY_STORE_ACTIVATION_SEAL,
      );
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (99)",
      );
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      for (const table of [
        "realtime_alarm_connections",
        "realtime_alarm_silences",
      ]) {
        expect(state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = ?`,
          table,
        ).one().count).toBe(1);
      }
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'index' AND name = 'realtime_alarm_connections_order'`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id = 10",
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id = 99",
      ).one().count).toBe(1);
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id = 10",
      ).one().count).toBe(1);
    });
  });
});
