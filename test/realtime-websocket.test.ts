import { env } from "cloudflare:workers";
import {
  SELF,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import {
  decodeEngineIoV4Handshake,
  decodeEngineIoV4Packet,
  decodeEngineIoV4PollingPayload,
  encodeEngineIoV4Packet,
  unwrapSocketIoV5Packet,
  wrapSocketIoV5Packet,
  type SocketIoV5Packet,
} from "../src/protocol";
import {
  REALTIME_MAX_PAYLOAD_BYTES,
  REALTIME_MAX_QUEUE_PACKETS,
  REALTIME_MAX_SESSIONS_PER_TENANT,
  REALTIME_PING_INTERVAL_MS,
  REALTIME_PING_TIMEOUT_MS,
  REALTIME_WEBSOCKET_FLUSH_MAX_FRAMES,
} from "../src/realtime/constants";
import { SqliteRealtimeSessionRepository } from "../src/realtime/session-repository";

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function secretDigest(): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode("nscf-test-secret-20260717"),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function endpoint(tenantName: string, query = ""): string {
  return `https://example.test/socket.io/?EIO=4&transport=websocket&tenant=${tenantName}${query}`;
}

function pollingEndpoint(tenantName: string, query = ""): string {
  return `https://example.test/socket.io/?EIO=4&transport=polling&tenant=${tenantName}${query}`;
}

function store(tenantName: string): DurableObjectStub<EntryStore> {
  return env.ENTRY_STORE.getByName(tenantName);
}

function clientFrame(packet: SocketIoV5Packet): string {
  return encodeEngineIoV4Packet(wrapSocketIoV5Packet(packet));
}

function socketPacket(frame: string): SocketIoV5Packet {
  return unwrapSocketIoV5Packet(decodeEngineIoV4Packet(frame));
}

interface MessageWaiter {
  resolve: (value: string | ArrayBuffer) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CloseWaiter {
  resolve: (value: CloseEvent) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class WebSocketInbox {
  private readonly messages: Array<string | ArrayBuffer> = [];
  private readonly messageWaiters: MessageWaiter[] = [];
  private closeEvent: CloseEvent | null = null;
  private readonly closeWaiters: CloseWaiter[] = [];

  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const waiter = this.messageWaiters.shift();
      if (waiter === undefined) {
        this.messages.push(event.data as string | ArrayBuffer);
        return;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(event.data as string | ArrayBuffer);
    });
    socket.addEventListener("close", (event) => {
      this.closeEvent = event;
      for (const waiter of this.closeWaiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
    });
  }

  next(timeoutMs = 2_000): Promise<string | ArrayBuffer> {
    const queued = this.messages.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const waiter: MessageWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.messageWaiters.indexOf(waiter);
          if (index !== -1) this.messageWaiters.splice(index, 1);
          reject(new Error("timed out waiting for WebSocket message"));
        }, timeoutMs),
      };
      this.messageWaiters.push(waiter);
    });
  }

  async nextString(timeoutMs = 2_000): Promise<string> {
    const value = await this.next(timeoutMs);
    if (typeof value !== "string") throw new Error("expected a text WebSocket frame");
    return value;
  }

  closed(timeoutMs = 2_000): Promise<CloseEvent> {
    if (this.closeEvent !== null) return Promise.resolve(this.closeEvent);
    return new Promise((resolve, reject) => {
      const waiter: CloseWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.closeWaiters.indexOf(waiter);
          if (index !== -1) this.closeWaiters.splice(index, 1);
          reject(new Error("timed out waiting for WebSocket close"));
        }, timeoutMs),
      };
      this.closeWaiters.push(waiter);
    });
  }
}

interface OpenWebSocket {
  sid: string;
  inbox: WebSocketInbox;
  handshakeFrame: string;
}

async function openWebSocket(tenantName: string): Promise<OpenWebSocket> {
  const response = await SELF.fetch(endpoint(tenantName), {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("WebSocket upgrade did not return a socket");
  const inbox = new WebSocketInbox(socket);
  socket.accept();
  const handshakeFrame = await inbox.nextString();
  const handshake = decodeEngineIoV4Handshake(decodeEngineIoV4Packet(handshakeFrame));
  return { sid: handshake.sid, inbox, handshakeFrame };
}

async function openPolling(tenantName: string): Promise<{
  sid: string;
  handshake: ReturnType<typeof decodeEngineIoV4Handshake>;
}> {
  const response = await SELF.fetch(pollingEndpoint(tenantName));
  expect(response.status).toBe(200);
  const packets = decodeEngineIoV4PollingPayload(await response.text());
  const handshake = decodeEngineIoV4Handshake(packets[0]!);
  return { sid: handshake.sid, handshake };
}

async function openUpgradeWebSocket(
  tenantName: string,
  sid: string,
): Promise<WebSocketInbox> {
  const response = await SELF.fetch(endpoint(tenantName, `&sid=${sid}`), {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("WebSocket upgrade did not return a socket");
  const inbox = new WebSocketInbox(socket);
  socket.accept();
  return inbox;
}

async function nextSocketPackets(
  inbox: WebSocketInbox,
  count: number,
): Promise<SocketIoV5Packet[]> {
  const packets: SocketIoV5Packet[] = [];
  for (let index = 0; index < count; index += 1) {
    packets.push(socketPacket(await inbox.nextString()));
  }
  return packets;
}

async function expectStoredSession(
  tenantName: string,
  sid: string,
): Promise<ReturnType<SqliteRealtimeSessionRepository["requireSession"]>> {
  return runInDurableObject(store(tenantName), async (_instance, state) =>
    new SqliteRealtimeSessionRepository(state.storage).requireSession(sid)
  );
}

interface StoredWebSocketAttachment {
  version: number;
  objectId: string;
  sid: string;
  mode: "session" | "upgrade";
  engineProtocol: 3 | 4;
  lastSeenAt: number;
  nextPingAt: number | null;
  pongDeadline: number | null;
}

async function expectStoredWebSocketAttachment(
  tenantName: string,
  sid: string,
): Promise<StoredWebSocketAttachment> {
  return runInDurableObject(store(tenantName), async (_instance, state) => {
    const socket = state.getWebSockets(`eio4-sid:${sid}`)[0];
    if (socket === undefined) throw new Error("missing server WebSocket");
    const attachment = socket.deserializeAttachment() as StoredWebSocketAttachment;
    expect(attachment).toMatchObject({
      version: 2,
      objectId: state.id.toString(),
      sid,
      mode: "session",
      engineProtocol: 4,
    });
    return attachment;
  });
}

async function hasActivePoll(
  tenantName: string,
  sid: string,
): Promise<boolean> {
  return runInDurableObject(store(tenantName), async (instance) => {
    const realtime = (
      instance as unknown as {
        realtime: { waiters: Map<string, unknown> };
      }
    ).realtime;
    return realtime.waiters.has(sid);
  });
}

describe("direct Engine.IO 4 WebSocket transport", () => {
  it("validates direct-handshake HTTP boundaries and rejects an invalid upgrade SID", async () => {
    const name = tenant("ws-http");
    const unknownTransport = await SELF.fetch(
      `https://example.test/socket.io/?EIO=4&transport=bogus&tenant=${name}`,
    );
    expect(unknownTransport.status).toBe(400);
    expect(await unknownTransport.json()).toEqual({ code: 0, message: "Transport unknown" });

    const noUpgrade = await SELF.fetch(endpoint(name));
    expect(noUpgrade.status).toBe(400);
    expect(await noUpgrade.json()).toEqual({ code: 3, message: "Bad request" });

    const wrongProtocol = await SELF.fetch(
      endpoint(name).replace("EIO=4", "EIO=2"),
      { headers: { Upgrade: "websocket" } },
    );
    expect(wrongProtocol.status).toBe(400);
    expect(await wrongProtocol.json()).toEqual({
      code: 5,
      message: "Unsupported protocol version",
    });

    const wrongMethod = await SELF.fetch(endpoint(name), {
      method: "POST",
    });
    expect(wrongMethod.status).toBe(400);
    expect(await wrongMethod.json()).toEqual({ code: 2, message: "Bad handshake method" });

    const sidUpgrade = await SELF.fetch(endpoint(name, "&sid=not-a-direct-handshake"), {
      headers: { Upgrade: "websocket" },
    });
    expect(sidUpgrade.status).toBe(400);
    expect(await sidUpgrade.json()).toEqual({ code: 1, message: "Session ID unknown" });
  });

  it("upgrades a live EIO4 polling SID with the locked probe/noop/upgrade order", async () => {
    const name = tenant("ws-upgrade");
    const opened = await openPolling(name);
    expect(opened.handshake).toMatchObject({
      sid: opened.sid,
      upgrades: ["websocket"],
    });

    const pendingPoll = SELF.fetch(pollingEndpoint(name, `&sid=${opened.sid}`));
    await vi.waitFor(async () => {
      expect(await hasActivePoll(name, opened.sid)).toBe(true);
    });
    await expect(expectStoredSession(name, opened.sid)).resolves.toMatchObject({
      transport: "polling",
      pollToken: null,
    });

    const inbox = await openUpgradeWebSocket(name, opened.sid);
    inbox.socket.send("2probe");
    expect(await inbox.nextString()).toBe("3probe");
    const releasedPoll = await pendingPoll;
    expect(releasedPoll.status).toBe(200);
    expect(await releasedPoll.text()).toBe("6");

    inbox.socket.send("5");
    await vi.waitFor(async () => {
      await expect(expectStoredSession(name, opened.sid)).resolves.toMatchObject({
        transport: "websocket",
        engineProtocol: 4,
        pollToken: null,
      });
    });

    await evictDurableObject(store(name));
    inbox.socket.send(clientFrame({ type: "connect", namespace: "/" }));
    expect(await nextSocketPackets(inbox, 2)).toMatchObject([
      { type: "connect", namespace: "/" },
      { type: "event", namespace: "/", data: ["clients", 1] },
    ]);

    const stalePolling = await SELF.fetch(
      pollingEndpoint(name, `&sid=${opened.sid}`),
    );
    expect(stalePolling.status).toBe(400);
    expect(await stalePolling.json()).toEqual({
      code: 1,
      message: "Session ID unknown",
    });
    inbox.socket.close(1000, "done");
  });

  it("keeps polling alive when an upgrade candidate fails and rejects duplicates", async () => {
    const name = tenant("ws-upgrade-abort");
    const opened = await openPolling(name);
    const first = await openUpgradeWebSocket(name, opened.sid);

    const duplicate = await SELF.fetch(endpoint(name, `&sid=${opened.sid}`), {
      headers: { Upgrade: "websocket" },
    });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({ code: 3, message: "Bad request" });

    first.socket.send("4not-a-probe");
    expect((await first.closed()).code).toBe(1002);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await runInDurableObject(store(name), async (_instance, state) => {
      expect(new SqliteRealtimeSessionRepository(state.storage).requireSession(opened.sid))
        .toMatchObject({ transport: "polling", engineProtocol: 4 });
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM realtime_websocket_closures WHERE sid = ?",
        opened.sid,
      ).one().count).toBe(0);
    });
  });

  it("closes an abandoned upgrade through the persisted alarm without deleting polling", async () => {
    const name = tenant("ws-upgrade-timeout");
    const stub = store(name);
    const opened = await openPolling(name);
    const candidate = await openUpgradeWebSocket(name, opened.sid);

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE realtime_websocket_closures
         SET next_attempt_at = ?
         WHERE sid = ?`,
        Date.now() - 1,
        opened.sid,
      );
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await candidate.closed()).code).toBe(1008);
    await expect(expectStoredSession(name, opened.sid)).resolves.toMatchObject({
      transport: "polling",
      engineProtocol: 4,
    });
  });

  it("matches the locked open, CONNECT, authorize and loadRetro frame order read-only", async () => {
    const name = tenant("ws-order");
    const { sid, inbox, handshakeFrame } = await openWebSocket(name);
    expect(handshakeFrame).toBe(
      `0{"sid":"${sid}","upgrades":[],"pingInterval":25000,` +
        `"pingTimeout":20000,"maxPayload":1000000}`,
    );
    await expect(expectStoredSession(name, sid)).resolves.toMatchObject({
      transport: "websocket",
      socketConnected: false,
      outboundPackets: 0,
    });

    inbox.socket.send(clientFrame({ type: "connect", namespace: "/" }));
    const connected = await nextSocketPackets(inbox, 2);
    expect(connected[0]).toMatchObject({
      type: "connect",
      namespace: "/",
      data: { sid: expect.stringMatching(/^[A-Za-z0-9_-]{20}$/) },
    });
    expect(connected[1]).toEqual({
      type: "event",
      namespace: "/",
      data: ["clients", 1],
    });

    inbox.socket.send(clientFrame({
      type: "event",
      namespace: "/",
      id: 7,
      data: ["authorize", { client: "web", status: true }],
    }));
    const authorized = await nextSocketPackets(inbox, 3);
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
          version: "15.0.7",
          versionNum: 150007,
        },
      }],
    });
    expect(authorized[2]).toEqual({
      type: "ack",
      namespace: "/",
      id: 7,
      data: [{ read: true, write: false, write_treatment: false }],
    });

    inbox.socket.send(clientFrame({
      type: "event",
      namespace: "/",
      id: 8,
      data: ["loadRetro", {}],
    }));
    expect(await nextSocketPackets(inbox, 2)).toEqual([
      { type: "ack", namespace: "/", id: 8, data: [{ result: "success" }] },
      {
        type: "event",
        namespace: "/",
        data: ["retroUpdate", { devicestatus: [] }],
      },
    ]);

    // A readable-only socket receives the locked permission failure shape and
    // cannot mutate tenant storage.
    inbox.socket.send(clientFrame({
      type: "event",
      namespace: "/",
      id: 9,
      data: ["dbAdd", { collection: "treatments", data: { carbs: 10 } }],
    }));
    expect(await nextSocketPackets(inbox, 1)).toEqual([
      {
        type: "ack",
        namespace: "/",
        id: 9,
        data: [{ result: "Not permitted" }],
      },
    ]);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await runInDurableObject(store(name), async (_instance, state) => {
      expect(new SqliteRealtimeSessionRepository(state.storage).requireSession(sid))
        .toMatchObject({ outboundPackets: 0, readAllowed: true });
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM documents",
      ).one().count).toBe(0);
    });
    await expect(inbox.nextString(50)).rejects.toThrow("timed out");
    inbox.socket.close(1000, "done");
  });

  it("persists write authority across hibernation and sends ACK before root dataUpdate", async () => {
    const name = tenant("ws-root-write");
    const stub = store(name);
    const { sid, inbox } = await openWebSocket(name);

    inbox.socket.send(clientFrame({ type: "connect", namespace: "/" }));
    await nextSocketPackets(inbox, 2);
    inbox.socket.send(clientFrame({
      type: "event",
      namespace: "/",
      id: 30,
      data: ["authorize", {
        client: "test",
        secret: await secretDigest(),
      }],
    }));
    const authorization = await nextSocketPackets(inbox, 3);
    expect(authorization.at(-1)).toEqual({
      type: "ack",
      namespace: "/",
      id: 30,
      data: [{ read: true, write: true, write_treatment: true }],
    });
    await expect(expectStoredSession(name, sid)).resolves.toMatchObject({
      authorized: true,
      readAllowed: true,
      writeAllowed: true,
      treatmentWriteAllowed: true,
    });

    await evictDurableObject(stub);
    inbox.socket.send(clientFrame({
      type: "event",
      namespace: "/",
      id: 31,
      data: ["dbAdd", {
        collection: "treatments",
        data: {
          _id: "hibernated-treatment-id",
          eventType: "Note",
          created_at: new Date().toISOString(),
          notes: "hibernated write",
        },
      }],
    }));
    const mutation = await nextSocketPackets(inbox, 2);
    expect(mutation[0]).toEqual({
      type: "ack",
      namespace: "/",
      id: 31,
      data: [[expect.objectContaining({
        _id: "hibernated-treatment-id",
        eventType: "Note",
        notes: "hibernated write",
      })]],
    });
    expect(mutation[1]).toMatchObject({
      type: "event",
      namespace: "/",
      data: ["dataUpdate", {
        delta: true,
        treatments: [expect.objectContaining({
          _id: "hibernated-treatment-id",
          notes: "hibernated write",
        })],
      }],
    });
    await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql.exec<{ body: string }>(
        `SELECT body FROM documents
         WHERE collection = 'treatments' AND id = 'hibernated-treatment-id'`,
      ).one();
      expect(JSON.parse(row.body)).toMatchObject({
        _id: "hibernated-treatment-id",
        eventType: "Note",
        notes: "hibernated write",
      });
    });
    inbox.socket.close(1000, "done");
  });

  it("resumes hibernated attachments and drives ping/pong without SQLite heartbeat writes", async () => {
    const name = tenant("ws-hibernate");
    const stub = store(name);
    const { sid, inbox } = await openWebSocket(name);

    await evictDurableObject(stub);
    inbox.socket.send(clientFrame({ type: "connect", namespace: "/" }));
    expect(await nextSocketPackets(inbox, 2)).toMatchObject([
      { type: "connect", namespace: "/" },
      { type: "event", data: ["clients", 1] },
    ]);

    const due = Date.now() - 1;
    let storedBeforeHeartbeat:
      | ReturnType<SqliteRealtimeSessionRepository["requireSession"]>
      | null = null;
    await runInDurableObject(stub, async (_instance, state) => {
      const socket = state.getWebSockets(`eio4-sid:${sid}`)[0];
      if (socket === undefined) throw new Error("missing hibernated server WebSocket");
      const attachment = socket.deserializeAttachment() as StoredWebSocketAttachment;
      socket.serializeAttachment({
        ...attachment,
        nextPingAt: due,
        pongDeadline: null,
      } satisfies StoredWebSocketAttachment);
      storedBeforeHeartbeat =
        new SqliteRealtimeSessionRepository(state.storage).requireSession(sid);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM realtime_outbound_packets WHERE sid = ?",
        sid,
      ).one().count).toBe(0);
      await state.storage.setAlarm(Date.now() + 60_000);
    });
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await inbox.nextString()).toBe("2");

    const pingState = await expectStoredWebSocketAttachment(name, sid);
    expect(pingState.nextPingAt).toBeNull();
    expect(pingState.pongDeadline).not.toBeNull();
    expect(await expectStoredSession(name, sid)).toEqual(storedBeforeHeartbeat);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM realtime_outbound_packets WHERE sid = ?",
        sid,
      ).one().count).toBe(0);
      expect(await state.storage.getAlarm()).toBe(pingState.pongDeadline);
    });

    const beforePong = Date.now();
    inbox.socket.send("3");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const pongState = await expectStoredWebSocketAttachment(name, sid);
    expect(pongState.pongDeadline).toBeNull();
    expect(pongState.nextPingAt).toBe(
      pingState.pongDeadline! +
        REALTIME_PING_INTERVAL_MS -
        REALTIME_PING_TIMEOUT_MS,
    );
    expect(pongState.nextPingAt).toBeGreaterThan(beforePong);
    expect(await expectStoredSession(name, sid)).toEqual(storedBeforeHeartbeat);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM realtime_outbound_packets WHERE sid = ?",
        sid,
      ).one().count).toBe(0);
      expect(await state.storage.getAlarm()).toBe(pongState.nextPingAt);
    });

    inbox.socket.send("1");
    expect((await inbox.closed()).code).toBe(1000);
    await expect(expectStoredSession(name, sid)).rejects.toThrow("unknown");
    const reconnected = await openWebSocket(name);
    expect(reconnected.sid).not.toBe(sid);
    reconnected.inbox.socket.close(1000, "done");
  });

  it("coalesces staggered EIO4 sockets into one tenant heartbeat alarm phase", async () => {
    const name = tenant("ws-heartbeat-coalesce");
    const stub = store(name);
    const sockets: OpenWebSocket[] = [];
    for (let index = 0; index < 8; index += 1) {
      sockets.push(await openWebSocket(name));
    }
    const due = Date.now() - 1;

    await runInDurableObject(stub, async (_instance, state) => {
      for (const [index, socket] of sockets.entries()) {
        const server = state.getWebSockets(`eio4-sid:${socket.sid}`)[0];
        if (server === undefined) throw new Error("missing coalesced server WebSocket");
        const attachment =
          server.deserializeAttachment() as StoredWebSocketAttachment;
        server.serializeAttachment({
          ...attachment,
          nextPingAt: index === 0 ? due : due + (index + 1) * 3_000,
          pongDeadline: null,
        } satisfies StoredWebSocketAttachment);
      }
      await state.storage.setAlarm(due);
    });

    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    for (const socket of sockets) {
      expect(await socket.inbox.nextString()).toBe("2");
    }

    const pingStates = await Promise.all(
      sockets.map((socket) => expectStoredWebSocketAttachment(name, socket.sid)),
    );
    expect(new Set(pingStates.map((state) => state.pongDeadline)).size).toBe(1);
    expect(pingStates.every((state) => state.nextPingAt === null)).toBe(true);

    for (const socket of sockets) socket.inbox.socket.send("3");
    const nextPingAt = pingStates[0]!.pongDeadline! +
      REALTIME_PING_INTERVAL_MS -
      REALTIME_PING_TIMEOUT_MS;
    await vi.waitFor(async () => {
      const pongStates = await Promise.all(
        sockets.map((socket) =>
          expectStoredWebSocketAttachment(name, socket.sid)
        ),
      );
      expect(new Set(pongStates.map((state) => state.nextPingAt))).toEqual(
        new Set([nextPingAt]),
      );
      expect(pongStates.every((state) => state.pongDeadline === null)).toBe(true);
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(nextPingAt);
    });

    for (const socket of sockets) socket.inbox.socket.close(1000, "done");
  });

  it("keeps a late EIO4 pong on a future shared heartbeat phase", async () => {
    const name = tenant("ws-late-pong-phase");
    const stub = store(name);
    const { sid, inbox } = await openWebSocket(name);
    const beforePong = Date.now();

    await runInDurableObject(stub, async (_instance, state) => {
      const server = state.getWebSockets(`eio4-sid:${sid}`)[0];
      if (server === undefined) throw new Error("missing late-pong server WebSocket");
      const attachment =
        server.deserializeAttachment() as StoredWebSocketAttachment;
      server.serializeAttachment({
        ...attachment,
        nextPingAt: null,
        pongDeadline: beforePong - 6_000,
      } satisfies StoredWebSocketAttachment);
    });

    inbox.socket.send("3");
    await vi.waitFor(async () => {
      const attachment = await expectStoredWebSocketAttachment(name, sid);
      expect(attachment.pongDeadline).toBeNull();
      expect(attachment.nextPingAt).toBeGreaterThan(beforePong);
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBeGreaterThan(beforePong);
    });
    inbox.socket.close(1000, "done");
  });

  it("upgrades a live version-1 attachment without changing its SQL session", async () => {
    const name = tenant("ws-v1-attachment-upgrade");
    const stub = store(name);
    const { sid, inbox } = await openWebSocket(name);
    let storedBeforeUpgrade:
      | ReturnType<SqliteRealtimeSessionRepository["requireSession"]>
      | null = null;

    await runInDurableObject(stub, async (_instance, state) => {
      const socket = state.getWebSockets(`eio4-sid:${sid}`)[0];
      if (socket === undefined) throw new Error("missing version-1 server WebSocket");
      socket.serializeAttachment({
        version: 1,
        objectId: state.id.toString(),
        sid,
      });
      storedBeforeUpgrade =
        new SqliteRealtimeSessionRepository(state.storage).requireSession(sid);
    });

    await evictDurableObject(stub);
    inbox.socket.send("3");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const upgraded = await expectStoredWebSocketAttachment(name, sid);
    expect(upgraded.lastSeenAt).toBeGreaterThan(0);
    expect(upgraded.nextPingAt).toBeGreaterThan(Date.now());
    expect(upgraded.pongDeadline).toBeNull();
    expect(await expectStoredSession(name, sid)).toEqual(storedBeforeUpgrade);
    inbox.socket.close(1000, "done");
  });

  it("accepts a pong while an application frame owns the session mutex", async () => {
    const name = tenant("ws-concurrent-pong");
    const stub = store(name);
    const { sid, inbox } = await openWebSocket(name);

    await runInDurableObject(stub, async (instance) => {
      const active = (instance as unknown as {
        activeWebSocketSessions: Set<string>;
      }).activeWebSocketSessions;
      active.add(sid);
    });
    const beforePong = Date.now();
    inbox.socket.send("3");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const attachment = await expectStoredWebSocketAttachment(name, sid);
    expect(attachment.nextPingAt).toBeGreaterThanOrEqual(
      beforePong + REALTIME_PING_INTERVAL_MS,
    );
    expect(attachment.pongDeadline).toBeNull();
    expect(await expectStoredSession(name, sid)).toMatchObject({
      sid,
      transport: "websocket",
    });
    await runInDurableObject(stub, async (instance) => {
      const active = (instance as unknown as {
        activeWebSocketSessions: Set<string>;
      }).activeWebSocketSessions;
      active.delete(sid);
    });
    inbox.socket.close(1000, "done");
  });

  it("reaps orphaned SQL WebSocket rows before enforcing session capacity", async () => {
    const name = tenant("ws-orphan-capacity");
    const stub = store(name);
    const live = await openWebSocket(name);
    await runInDurableObject(stub, async (_instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      for (let index = 1; index < REALTIME_MAX_SESSIONS_PER_TENANT; index += 1) {
        repository.createSession(Date.now() + index, "websocket", 4);
      }
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM realtime_sessions",
      ).one().count).toBe(REALTIME_MAX_SESSIONS_PER_TENANT);
    });

    await evictDurableObject(stub);
    const newcomer = await openWebSocket(name);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM realtime_sessions",
      ).one().count).toBe(2);
    });
    live.inbox.socket.close(1000, "done");
    newcomer.inbox.socket.close(1000, "done");
  });

  it("closes an EIO4 WebSocket that misses its pong after hibernation", async () => {
    const name = tenant("ws-pong-timeout");
    const stub = store(name);
    const { sid, inbox } = await openWebSocket(name);

    await runInDurableObject(stub, async (_instance, state) => {
      const socket = state.getWebSockets(`eio4-sid:${sid}`)[0];
      if (socket === undefined) throw new Error("missing timeout server WebSocket");
      const attachment = socket.deserializeAttachment() as StoredWebSocketAttachment;
      socket.serializeAttachment({
        ...attachment,
        nextPingAt: null,
        pongDeadline: Date.now() - 1,
      } satisfies StoredWebSocketAttachment);
      // The test triggers this alarm after eviction; avoid an automatic alarm race.
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await inbox.closed()).code).toBe(1008);
    await expect(expectStoredSession(name, sid)).rejects.toThrow("unknown");
  });

  it("keeps one stable EIO4 socket below ten thousand alarm writes per day", () => {
    const heartbeatCycles = Math.ceil(
      (24 * 60 * 60 * 1_000) / REALTIME_PING_INTERVAL_MS,
    );
    const initialAlarmWrite = 1;
    const pingAndPongAlarmWrites = heartbeatCycles * 2;

    expect(heartbeatCycles).toBe(3_456);
    expect(initialAlarmWrite + pingAndPongAlarmWrites).toBe(6_913);
    expect(initialAlarmWrite + pingAndPongAlarmWrites).toBeLessThan(10_000);
  });

  it("closes binary, malformed, client-ping and oversized frames with bounded codes", async () => {
    const cases: Array<{
      prefix: string;
      frame: string | ArrayBuffer;
      code: number;
    }> = [
      { prefix: "binary", frame: new Uint8Array([4, 0]).buffer, code: 1003 },
      { prefix: "malformed", frame: "4not-socket-io", code: 1002 },
      { prefix: "client-ping", frame: "2", code: 1002 },
      {
        prefix: "oversized",
        frame: `4${"a".repeat(REALTIME_MAX_PAYLOAD_BYTES)}`,
        code: 1009,
      },
    ];

    for (const item of cases) {
      const name = tenant(`ws-${item.prefix}`);
      const { sid, inbox } = await openWebSocket(name);
      inbox.socket.send(item.frame);
      expect((await inbox.closed(4_000)).code).toBe(item.code);
      await runInDurableObject(store(name), async (_instance, state) => {
        expect(new SqliteRealtimeSessionRepository(state.storage).getSession(sid)).toBeNull();
      });
    }
  });

  it("keeps global flush work bounded and recovers pending FIFO frames through the alarm", async () => {
    const name = tenant("ws-flush-budget");
    const stub = store(name);
    const first = await openWebSocket(name);
    const second = await openWebSocket(name);
    const queuedAt = Date.now() - 100;

    await runInDurableObject(stub, async (_instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      repository.enqueueFrames(
        first.sid,
        Array.from({ length: REALTIME_MAX_QUEUE_PACKETS }, () => "6"),
        queuedAt,
      );
      repository.enqueueFrames(
        second.sid,
        Array.from({ length: REALTIME_MAX_QUEUE_PACKETS }, () => "6"),
        queuedAt + 1,
      );
    });

    // Any normal RPC turn may flush, but only within the global turn budget.
    const trigger = await stub.realtimeHandshake();
    expect(trigger.ok).toBe(true);
    for (let index = 0; index < REALTIME_WEBSOCKET_FLUSH_MAX_FRAMES; index += 1) {
      expect(await first.inbox.nextString()).toBe("6");
    }
    await runInDurableObject(stub, async (_instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      expect(repository.requireSession(first.sid).outboundPackets).toBe(64);
      expect(repository.requireSession(second.sid).outboundPackets).toBe(128);
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm!).toBeLessThanOrEqual(Date.now() + 1_000);
    });

    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    for (let index = 0; index < REALTIME_WEBSOCKET_FLUSH_MAX_FRAMES; index += 1) {
      expect(await first.inbox.nextString()).toBe("6");
    }
    await runInDurableObject(stub, async (_instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      expect(repository.requireSession(first.sid).outboundPackets).toBe(0);
      expect(repository.requireSession(second.sid).outboundPackets).toBe(128);
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm!).toBeLessThanOrEqual(Date.now() + 1_000);
    });

    first.inbox.socket.close(1000, "done");
    second.inbox.socket.close(1000, "done");
  });

  it("limits aggregate WebSocket bytes and socket fan-out in each flush turn", async () => {
    const byteName = tenant("ws-byte-budget");
    const byteStub = store(byteName);
    const large = await openWebSocket(byteName);
    const deferred = await openWebSocket(byteName);
    const firstFrame = `6${"a".repeat(699_999)}`;
    const secondFrame = `6${"b".repeat(399_999)}`;
    await runInDurableObject(byteStub, async (_instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      repository.enqueueFrames(large.sid, [firstFrame], Date.now() - 2);
      repository.enqueueFrames(deferred.sid, [secondFrame], Date.now() - 1);
    });
    expect((await byteStub.realtimeHandshake()).ok).toBe(true);
    expect(await large.inbox.nextString(4_000)).toBe(firstFrame);
    await runInDurableObject(byteStub, async (_instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      expect(repository.requireSession(large.sid).outboundPackets).toBe(0);
      expect(repository.requireSession(deferred.sid).outboundPackets).toBe(1);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect(await runDurableObjectAlarm(byteStub)).toBe(true);
    expect(await deferred.inbox.nextString(4_000)).toBe(secondFrame);
    large.inbox.socket.close(1000, "done");
    deferred.inbox.socket.close(1000, "done");

    const socketName = tenant("ws-socket-budget");
    const socketStub = store(socketName);
    const sockets: OpenWebSocket[] = [];
    for (let index = 0; index < 17; index += 1) {
      sockets.push(await openWebSocket(socketName));
    }
    await runInDurableObject(socketStub, async (_instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      const queuedAt = Date.now() - 100;
      for (const [index, socket] of sockets.entries()) {
        repository.enqueueFrames(socket.sid, ["6"], queuedAt + index);
      }
    });
    expect((await socketStub.realtimeHandshake()).ok).toBe(true);
    await runInDurableObject(socketStub, async (_instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      const remaining = sockets.filter(
        (socket) => repository.requireSession(socket.sid).outboundPackets === 1,
      );
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.sid).toBe(sockets.at(-1)!.sid);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    for (const socket of sockets) socket.inbox.socket.close(1000, "done");
  });

  it("keeps the close budget when a corrupt SID tag maps to many physical sockets", async () => {
    const name = tenant("ws-duplicate-tag-budget");
    const stub = store(name);
    await runInDurableObject(stub, async (instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      const session = repository.createSession(Date.now(), "websocket");
      const clients: WebSocket[] = [];
      for (let index = 0; index < 20; index += 1) {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        state.acceptWebSocket(server, [
          "eio4-websocket",
          `eio4-sid:${session.sid}`,
        ]);
        server.serializeAttachment({
          version: 1,
          objectId: state.id.toString(),
          sid: session.sid,
        });
        client.accept();
        clients.push(client);
      }
      repository.deleteSession(session.sid);

      const flush = (instance as unknown as {
        flushRealtimeWebSockets(): void;
      }).flushRealtimeWebSockets.bind(instance);
      const activeCount = (): number => state
        .getWebSockets(`eio4-sid:${session.sid}`)
        .filter((socket) =>
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ).length;
      const closureCount = (): number => state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM realtime_websocket_closures WHERE sid = ?",
        session.sid,
      ).one().count;

      flush();
      expect(activeCount()).toBe(4);
      expect(closureCount()).toBe(1);

      const deferred = state.storage.sql.exec<{
        attempt_count: number;
        next_attempt_at: number;
      }>(
        `SELECT attempt_count, next_attempt_at
         FROM realtime_websocket_closures WHERE sid = ?`,
        session.sid,
      ).one();
      expect(deferred.attempt_count).toBe(0);
      expect(deferred.next_attempt_at).toBeGreaterThan(Date.now());

      // An ordinary turn before the bounded continuation is due must not
      // bypass the persisted deadline.
      flush();
      expect(activeCount()).toBe(4);
      expect(closureCount()).toBe(1);
      state.storage.sql.exec(
        `UPDATE realtime_websocket_closures
         SET next_attempt_at = ? WHERE sid = ?`,
        Date.now() - 1,
        session.sid,
      );
      flush();
      expect(activeCount()).toBe(0);
      expect(closureCount()).toBe(0);
      expect(clients).toHaveLength(20);
    });
  });

  it("backs off and rotates when every socket in an oversized close batch fails", async () => {
    const name = tenant("ws-duplicate-tag-failure");
    const stub = store(name);
    await runInDurableObject(stub, async (instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      const session = repository.createSession(Date.now(), "websocket");
      const servers: WebSocket[] = [];
      const clients: WebSocket[] = [];
      const originalCloses: Array<WebSocket["close"]> = [];
      const closeCalls = Array.from({ length: 20 }, () => 0);
      for (let index = 0; index < 20; index += 1) {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        state.acceptWebSocket(server, [
          "eio4-websocket",
          `eio4-sid:${session.sid}`,
        ]);
        server.serializeAttachment({
          version: 1,
          objectId: state.id.toString(),
          sid: session.sid,
        });
        client.accept();
        originalCloses.push(server.close);
        server.close = (): void => {
          closeCalls[index] = (closeCalls[index] ?? 0) + 1;
          throw new Error("forced duplicate close failure");
        };
        servers.push(server);
        clients.push(client);
      }
      repository.deleteSession(session.sid);

      const flush = (instance as unknown as {
        flushRealtimeWebSockets(): void;
      }).flushRealtimeWebSockets.bind(instance);
      const closureState = (): {
        attempt_count: number;
        next_attempt_at: number;
        socket_offset: number;
      } => state.storage.sql.exec<{
        attempt_count: number;
        next_attempt_at: number;
        socket_offset: number;
      }>(
        `SELECT attempt_count, next_attempt_at, socket_offset
         FROM realtime_websocket_closures WHERE sid = ?`,
        session.sid,
      ).one();
      const totalCloseCalls = (): number =>
        closeCalls.reduce((total, count) => total + count, 0);

      const firstStartedAt = Date.now();
      flush();
      const firstFailure = closureState();
      expect(totalCloseCalls()).toBe(16);
      expect(firstFailure.attempt_count).toBe(1);
      expect(firstFailure.next_attempt_at).toBeGreaterThanOrEqual(
        firstStartedAt + 1_000,
      );
      expect(firstFailure.socket_offset).toBe(16);

      flush();
      expect(totalCloseCalls()).toBe(16);
      expect(closureState()).toEqual(firstFailure);

      state.storage.sql.exec(
        `UPDATE realtime_websocket_closures
         SET next_attempt_at = ? WHERE sid = ?`,
        Date.now() - 1,
        session.sid,
      );
      const secondStartedAt = Date.now();
      flush();
      const secondFailure = closureState();
      expect(totalCloseCalls()).toBe(32);
      expect(closeCalls.slice(16)).toEqual([1, 1, 1, 1]);
      expect(secondFailure.attempt_count).toBe(2);
      expect(secondFailure.next_attempt_at).toBeGreaterThanOrEqual(
        secondStartedAt + 2_000,
      );
      expect(secondFailure.socket_offset).toBe(12);

      // Restore the runtime implementation and finish the bounded teardown.
      for (let index = 0; index < servers.length; index += 1) {
        servers[index]!.close = originalCloses[index]!;
      }
      for (let turn = 0; turn < 2; turn += 1) {
        state.storage.sql.exec(
          `UPDATE realtime_websocket_closures
           SET next_attempt_at = ? WHERE sid = ?`,
          Date.now() - 1,
          session.sid,
        );
        flush();
      }
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM realtime_websocket_closures WHERE sid = ?",
        session.sid,
      ).one().count).toBe(0);
      expect(clients).toHaveLength(20);
    });
  });

  it("backs off persistent physical close failures across early alarm turns", async () => {
    const name = tenant("ws-close-failure");
    const stub = store(name);
    await runInDurableObject(stub, async (instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      const session = repository.createSession(Date.now(), "websocket");
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      state.acceptWebSocket(server, [
        "eio4-websocket",
        `eio4-sid:${session.sid}`,
      ]);
      server.serializeAttachment({
        version: 1,
        objectId: state.id.toString(),
        sid: session.sid,
      });
      client.accept();
      repository.deleteSession(session.sid);

      const originalClose = server.close;
      let closeCalls = 0;
      server.close = (): void => {
        closeCalls += 1;
        throw new Error("forced close failure");
      };
      const flush = (instance as unknown as {
        flushRealtimeWebSockets(): void;
      }).flushRealtimeWebSockets.bind(instance);
      const synchronizeAlarm = (instance as unknown as {
        synchronizeRealtimeAlarm(): Promise<void>;
      }).synchronizeRealtimeAlarm.bind(instance);
      const closureCount = (): number => state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM realtime_websocket_closures WHERE sid = ?",
        session.sid,
      ).one().count;
      const closureState = (): { attempt_count: number; next_attempt_at: number } =>
        state.storage.sql.exec<{
          attempt_count: number;
          next_attempt_at: number;
        }>(
          `SELECT attempt_count, next_attempt_at
           FROM realtime_websocket_closures WHERE sid = ?`,
          session.sid,
        ).one();

      const firstStartedAt = Date.now();
      flush();
      expect(server.readyState).toBe(WebSocket.OPEN);
      expect(closureCount()).toBe(1);
      expect(closeCalls).toBe(1);
      const firstFailure = closureState();
      expect(firstFailure.attempt_count).toBe(1);
      expect(firstFailure.next_attempt_at).toBeGreaterThanOrEqual(
        firstStartedAt + 1_000,
      );
      await synchronizeAlarm();
      expect(await state.storage.getAlarm()).toBe(firstFailure.next_attempt_at);

      // Repeated normal turns and even an early at-least-once alarm delivery
      // preserve the future retry without another close attempt.
      flush();
      flush();
      await instance.alarm();
      expect(closeCalls).toBe(1);
      expect(closureState()).toEqual(firstFailure);
      expect(await state.storage.getAlarm()).toBe(firstFailure.next_attempt_at);

      state.storage.sql.exec(
        `UPDATE realtime_websocket_closures
         SET next_attempt_at = ? WHERE sid = ?`,
        Date.now() - 1,
        session.sid,
      );
      const secondStartedAt = Date.now();
      await instance.alarm();
      expect(closeCalls).toBe(2);
      const secondFailure = closureState();
      expect(secondFailure.attempt_count).toBe(2);
      expect(secondFailure.next_attempt_at).toBeGreaterThanOrEqual(
        secondStartedAt + 2_000,
      );
      expect(await state.storage.getAlarm()).toBe(secondFailure.next_attempt_at);

      await instance.alarm();
      expect(closeCalls).toBe(2);
      expect(closureState()).toEqual(secondFailure);

      server.close = originalClose;
      state.storage.sql.exec(
        `UPDATE realtime_websocket_closures
         SET next_attempt_at = ? WHERE sid = ?`,
        Date.now() - 1,
        session.sid,
      );
      await instance.alarm();
      expect(server.readyState).not.toBe(WebSocket.OPEN);
      expect(closureCount()).toBe(0);
    });
  });

  it("multiplexes authorization cleanup and websocket close retries on the earliest alarm", async () => {
    const name = tenant("ws-auth-alarm-multiplex");
    const stub = store(name);
    const liveIp = "198.51.100.40";
    const expiredIp = "198.51.100.41";
    const liveFailureAt = Date.now();
    const liveCleanupAt = liveFailureAt + 60_001;
    await stub.authorizationFailed(liveIp, liveFailureAt, 0);

    let sid = "";
    let client: WebSocket | null = null;
    let originalClose: WebSocket["close"] | null = null;
    let closeCalls = 0;
    let firstRetryAt = 0;

    await runInDurableObject(stub, async (instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      const session = repository.createSession(Date.now(), "websocket");
      sid = session.sid;
      const pair = new WebSocketPair();
      client = pair[0];
      const server = pair[1];
      state.acceptWebSocket(server, [
        "eio4-websocket",
        `eio4-sid:${session.sid}`,
      ]);
      const attachedAt = Date.now();
      server.serializeAttachment({
        version: 2,
        objectId: state.id.toString(),
        sid: session.sid,
        mode: "session",
        engineProtocol: 4,
        lastSeenAt: attachedAt,
        nextPingAt: attachedAt + REALTIME_PING_INTERVAL_MS,
        pongDeadline: null,
      });
      client.accept();
      repository.deleteSession(session.sid);

      originalClose = server.close;
      server.close = (): void => {
        closeCalls += 1;
        throw new Error("forced multiplex close failure");
      };

      const firstStartedAt = Date.now();
      expect(await instance.realtimeValidateSession(session.sid)).toMatchObject({
        ok: false,
        error: { code: "unknown_sid" },
      });
      const firstFailure = state.storage.sql.exec<{
        attempt_count: number;
        next_attempt_at: number;
      }>(
        `SELECT attempt_count, next_attempt_at
         FROM realtime_websocket_closures WHERE sid = ?`,
        session.sid,
      ).one();
      firstRetryAt = firstFailure.next_attempt_at;
      expect(closeCalls).toBe(1);
      expect(firstFailure.attempt_count).toBe(1);
      expect(firstRetryAt).toBeGreaterThanOrEqual(firstStartedAt + 1_000);
      expect(firstRetryAt).toBeLessThan(liveCleanupAt);
      expect(await state.storage.getAlarm()).toBe(firstRetryAt);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM authorization_failures WHERE ip = ?",
        liveIp,
      ).one().count).toBe(1);
    });

    // Protect the close retry from wall-clock test jitter, then deliberately
    // deliver its alarm early. The durable retry remains untouched and still
    // wins over the later authorization cleanup deadline.
    const protectedRetryAt = Date.now() + 10_000;
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE realtime_websocket_closures
         SET next_attempt_at = ? WHERE sid = ?`,
        protectedRetryAt,
        sid,
      );
    });
    expect(await stub.authorizationDelay(liveIp, Date.now())).toBe(0);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).toBe(protectedRetryAt);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(closeCalls).toBe(1);
      expect(state.storage.sql.exec<{
        attempt_count: number;
        next_attempt_at: number;
      }>(
        `SELECT attempt_count, next_attempt_at
         FROM realtime_websocket_closures WHERE sid = ?`,
        sid,
      ).one()).toEqual({
        attempt_count: 1,
        next_attempt_at: protectedRetryAt,
      });
      expect(await state.storage.getAlarm()).toBe(protectedRetryAt);
    });

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE realtime_websocket_closures
         SET next_attempt_at = ? WHERE sid = ?`,
        Date.now() - 1,
        sid,
      );
    });
    const secondStartedAt = Date.now();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    let secondRetryAt = 0;
    await runInDurableObject(stub, async (_instance, state) => {
      const secondFailure = state.storage.sql.exec<{
        attempt_count: number;
        next_attempt_at: number;
      }>(
        `SELECT attempt_count, next_attempt_at
         FROM realtime_websocket_closures WHERE sid = ?`,
        sid,
      ).one();
      secondRetryAt = secondFailure.next_attempt_at;
      expect(closeCalls).toBe(2);
      expect(secondFailure.attempt_count).toBe(2);
      expect(secondRetryAt).toBeGreaterThanOrEqual(secondStartedAt + 2_000);
      expect(secondRetryAt).toBeLessThan(liveCleanupAt);
      expect(await state.storage.getAlarm()).toBe(secondRetryAt);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM authorization_failures WHERE ip = ?",
        liveIp,
      ).one().count).toBe(1);
    });

    // Reverse priority: leave the close retry in the future and add an already
    // expired failure through the public RPC. Its prompt alarm runs cleanup
    // first, without consuming or advancing the WebSocket retry.
    const futureRetryAt = Date.now() + 10_000;
    let promptStartedAt = 0;
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(
        `UPDATE realtime_websocket_closures
         SET next_attempt_at = ? WHERE sid = ?`,
        futureRetryAt,
        sid,
      );
      // Model the Cloudflare edge where an already-due alarm timestamp is
      // still observable until delivery is queued. synchronizeRealtimeAlarm()
      // must replace it instead of letting the only wakeup disappear.
      await state.storage.setAlarm(Date.now() - 1);
      promptStartedAt = Date.now();
      await instance.authorizationFailed(expiredIp, promptStartedAt - 60_100, 0);
      const promptAlarm = await state.storage.getAlarm();
      expect(promptAlarm).not.toBeNull();
      expect(promptAlarm!).toBeGreaterThanOrEqual(promptStartedAt + 100);
      expect(promptAlarm!).toBeLessThanOrEqual(Date.now() + 100);
      expect(promptAlarm!).toBeLessThan(futureRetryAt);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(closeCalls).toBe(2);
      expect(state.storage.sql.exec<{
        attempt_count: number;
        next_attempt_at: number;
      }>(
        `SELECT attempt_count, next_attempt_at
         FROM realtime_websocket_closures WHERE sid = ?`,
        sid,
      ).one()).toEqual({
        attempt_count: 2,
        next_attempt_at: futureRetryAt,
      });
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM authorization_failures WHERE ip = ?",
        expiredIp,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM authorization_failures WHERE ip = ?",
        liveIp,
      ).one().count).toBe(1);
      expect(await state.storage.getAlarm()).toBe(futureRetryAt);
    });

    await runInDurableObject(stub, async (_instance, state) => {
      const server = state.getWebSockets(`eio4-sid:${sid}`)[0];
      if (server === undefined || originalClose === null) {
        throw new Error("missing multiplex test websocket");
      }
      server.close = originalClose;
      state.storage.sql.exec(
        `UPDATE realtime_websocket_closures
         SET next_attempt_at = ? WHERE sid = ?`,
        Date.now() - 1,
        sid,
      );
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await stub.authorizationSucceeded(liveIp);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM realtime_websocket_closures WHERE sid = ?",
        sid,
      ).one().count).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(client).not.toBeNull();
    expect(firstRetryAt).toBeGreaterThan(0);
    expect(secondRetryAt).toBeGreaterThan(firstRetryAt);
  });

  it("drops a saturated client, closes its socket and sends corrected client counts", async () => {
    const name = tenant("ws-backpressure");
    const stub = store(name);
    const saturated = await openWebSocket(name);
    const survivor = await openWebSocket(name);

    saturated.inbox.socket.send(clientFrame({ type: "connect", namespace: "/" }));
    await nextSocketPackets(saturated.inbox, 2);
    survivor.inbox.socket.send(clientFrame({ type: "connect", namespace: "/" }));
    await nextSocketPackets(survivor.inbox, 2);
    expect(await nextSocketPackets(saturated.inbox, 1)).toEqual([{
      type: "event",
      namespace: "/",
      data: ["clients", 2],
    }]);

    const newcomer = await openWebSocket(name);

    await runInDurableObject(stub, async (_instance, state) => {
      new SqliteRealtimeSessionRepository(state.storage).enqueueFrames(
        saturated.sid,
        Array.from({ length: REALTIME_MAX_QUEUE_PACKETS }, () => "6"),
        Date.now(),
      );
    });

    newcomer.inbox.socket.send(clientFrame({ type: "connect", namespace: "/" }));
    expect((await saturated.inbox.closed()).code).toBe(1008);
    expect(await nextSocketPackets(survivor.inbox, 2)).toEqual([
      { type: "event", namespace: "/", data: ["clients", 3] },
      { type: "event", namespace: "/", data: ["clients", 2] },
    ]);
    expect(await nextSocketPackets(newcomer.inbox, 3)).toMatchObject([
      { type: "connect", namespace: "/" },
      { type: "event", data: ["clients", 3] },
      { type: "event", data: ["clients", 2] },
    ]);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(new SqliteRealtimeSessionRepository(state.storage).getSession(saturated.sid))
        .toBeNull();
    });
    survivor.inbox.socket.close(1000, "done");
    newcomer.inbox.socket.close(1000, "done");
  });

  it("rejects cross-tenant attachment substitution after hibernation", async () => {
    const alphaName = tenant("ws-alpha");
    const betaName = tenant("ws-beta");
    const alpha = await openWebSocket(alphaName);
    const beta = await openWebSocket(betaName);
    const alphaStub = store(alphaName);
    const betaStub = store(betaName);

    const betaAttachment = await runInDurableObject(betaStub, async (_instance, state) => {
      const socket = state.getWebSockets("eio4-websocket")[0];
      if (socket === undefined) throw new Error("missing beta server socket");
      return socket.deserializeAttachment();
    });
    await runInDurableObject(alphaStub, async (_instance, state) => {
      const socket = state.getWebSockets("eio4-websocket")[0];
      if (socket === undefined) throw new Error("missing alpha server socket");
      socket.serializeAttachment(betaAttachment);
    });

    await evictDurableObject(alphaStub);
    alpha.inbox.socket.send(clientFrame({ type: "connect", namespace: "/" }));
    expect((await alpha.inbox.closed()).code).toBe(1008);
    await runInDurableObject(alphaStub, async (_instance, state) => {
      expect(new SqliteRealtimeSessionRepository(state.storage).getSession(alpha.sid)).toBeNull();
    });

    beta.inbox.socket.send(clientFrame({ type: "connect", namespace: "/" }));
    expect(await nextSocketPackets(beta.inbox, 2)).toMatchObject([
      { type: "connect", namespace: "/" },
      { type: "event", data: ["clients", 1] },
    ]);
    beta.inbox.socket.close(1000, "done");
  });

  it("enforces the shared per-tenant session cap on a direct WebSocket handshake", async () => {
    const name = tenant("ws-cap");
    const stub = store(name);
    await runInDurableObject(stub, async (_instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      for (let index = 0; index < REALTIME_MAX_SESSIONS_PER_TENANT; index += 1) {
        repository.createSession(Date.now());
      }
    });
    const response = await SELF.fetch(endpoint(name), {
      headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(503);
    expect(response.webSocket).toBeNull();
    expect(await response.json()).toEqual({ code: 3, message: "Bad request" });
  });
});

describe("realtime transport schema migration", () => {
  it("repairs a high-version polling-only table idempotently and records v7", async () => {
    const name = tenant("ws-migrate-v7");
    const stub = store(name);
    const sid = "abcdefghijklmnopqrst";
    const socketSid = "tsrqponmlkjihgfedcba";
    const now = Date.now();

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`
        DROP INDEX IF EXISTS realtime_sessions_expiry;
        DROP TABLE realtime_sessions;
        CREATE TABLE realtime_sessions (
          sid TEXT PRIMARY KEY,
          socket_sid TEXT NOT NULL UNIQUE,
          engine_protocol INTEGER NOT NULL CHECK (engine_protocol = 4),
          transport TEXT NOT NULL CHECK (transport = 'polling'),
          socket_connected INTEGER NOT NULL DEFAULT 0 CHECK (socket_connected IN (0, 1)),
          authorized INTEGER NOT NULL DEFAULT 0 CHECK (authorized IN (0, 1)),
          read_allowed INTEGER NOT NULL DEFAULT 0 CHECK (read_allowed IN (0, 1)),
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          next_ping_at INTEGER NOT NULL,
          pong_deadline INTEGER,
          expires_at INTEGER NOT NULL,
          next_sequence INTEGER NOT NULL DEFAULT 1,
          outbound_packets INTEGER NOT NULL DEFAULT 0,
          outbound_bytes INTEGER NOT NULL DEFAULT 0,
          poll_token TEXT,
          poll_deadline INTEGER,
          post_token TEXT,
          post_deadline INTEGER
        );
        CREATE INDEX realtime_sessions_expiry ON realtime_sessions(expires_at, sid);
      `);
      state.storage.sql.exec(
        `INSERT INTO realtime_sessions (
           sid, socket_sid, engine_protocol, transport, created_at, last_seen_at,
           next_ping_at, expires_at
         ) VALUES (?, ?, 4, 'polling', ?, ?, ?, ?)`,
        sid,
        socketSid,
        now,
        now,
        now + 25_000,
        now + 45_000,
      );
      state.storage.sql.exec(
        "DELETE FROM _sql_schema_migrations WHERE id IN (7, 28)",
      );
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (6)",
      );
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (99)",
      );
    });

    await evictDurableObject(stub);
    expect(await stub.realtimeValidateSession(sid)).toEqual({ ok: true, value: null });
    await runInDurableObject(stub, async (_instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      expect(repository.requireSession(sid)).toMatchObject({
        socketSid,
        transport: "polling",
      });
      expect(repository.createSession(now, "websocket").transport).toBe("websocket");
      const definition = state.storage.sql.exec<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'realtime_sessions'",
      ).one().sql;
      expect(definition).toContain("transport IN ('polling', 'websocket')");
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id = 7",
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id = 99",
      ).one().count).toBe(1);
    });

    await evictDurableObject(stub);
    expect(await stub.realtimeValidateSession(sid)).toEqual({ ok: true, value: null });
  });

  it("repairs v7 closure rows to v8 despite a higher independent marker", async () => {
    const name = tenant("ws-migrate-v8");
    const stub = store(name);
    const createdAt = Date.now() - 5_000;

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`
        DROP INDEX IF EXISTS realtime_websocket_closures_due;
        DROP TABLE realtime_websocket_closures;
        CREATE TABLE realtime_websocket_closures (
          sid TEXT PRIMARY KEY,
          close_code INTEGER NOT NULL,
          close_reason TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX realtime_websocket_closures_created
          ON realtime_websocket_closures(created_at, sid);
      `);
      state.storage.sql.exec(
        `INSERT INTO realtime_websocket_closures
           (sid, close_code, close_reason, created_at)
         VALUES ('abcdefghijklmnopqrst', 1008, 'legacy close', ?)`,
        createdAt,
      );
      state.storage.sql.exec(
        "DELETE FROM _sql_schema_migrations WHERE id IN (8, 28)",
      );
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (7)",
      );
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (99)",
      );
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      const row = state.storage.sql.exec<{
        attempt_count: number;
        next_attempt_at: number;
        socket_offset: number;
      }>(
        `SELECT attempt_count, next_attempt_at, socket_offset
         FROM realtime_websocket_closures
         WHERE sid = 'abcdefghijklmnopqrst'`,
      ).one();
      expect(row).toEqual({
        attempt_count: 0,
        next_attempt_at: createdAt,
        socket_offset: 0,
      });
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id = 8",
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id = 99",
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'index' AND name = 'realtime_websocket_closures_due'`,
      ).one().count).toBe(1);
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id = 8",
      ).one().count).toBe(1);
    });
  });
});
