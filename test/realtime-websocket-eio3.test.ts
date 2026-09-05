import { env } from "cloudflare:workers";
import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryStore } from "../src/entry-store";
import {
  decodeEngineIoV3Handshake,
  decodeEngineIoV3Packet,
  decodeEngineIoV3PollingPayload,
  encodeEngineIoV3Packet,
  unwrapSocketIoV4Packet,
  wrapSocketIoV4Packet,
  type SocketIoV4Packet,
} from "../src/protocol";
import { SqliteRealtimeSessionRepository } from "../src/realtime/session-repository";

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function websocketEndpoint(tenantName: string, sid?: string): string {
  return `https://example.test/socket.io/?EIO=3&transport=websocket&tenant=${tenantName}`
    + (sid === undefined ? "" : `&sid=${sid}`);
}

function pollingEndpoint(tenantName: string, sid?: string): string {
  return `https://example.test/socket.io/?EIO=3&transport=polling&tenant=${tenantName}`
    + (sid === undefined ? "" : `&sid=${sid}`);
}

function store(tenantName: string): DurableObjectStub<EntryStore> {
  return env.ENTRY_STORE.getByName(tenantName);
}

function clientFrame(packet: SocketIoV4Packet): string {
  return encodeEngineIoV3Packet(wrapSocketIoV4Packet(packet));
}

function socketPacket(frame: string): SocketIoV4Packet {
  return unwrapSocketIoV4Packet(decodeEngineIoV3Packet(frame));
}

class WebSocketInbox {
  private readonly messages: Array<string | ArrayBuffer> = [];
  private readonly waiters: Array<{
    resolve: (value: string | ArrayBuffer) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        this.messages.push(event.data as string | ArrayBuffer);
        return;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(event.data as string | ArrayBuffer);
    });
  }

  async nextString(timeoutMs = 2_000): Promise<string> {
    const queued = this.messages.shift();
    const value = queued ?? await new Promise<string | ArrayBuffer>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(new Error("timed out waiting for EIO3 WebSocket message"));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
    if (typeof value !== "string") throw new Error("expected a text WebSocket frame");
    return value;
  }
}

async function openWebSocket(tenantName: string, sid?: string): Promise<WebSocketInbox> {
  const response = await SELF.fetch(websocketEndpoint(tenantName, sid), {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (socket === null) throw new Error("EIO3 upgrade returned no WebSocket");
  const inbox = new WebSocketInbox(socket);
  socket.accept();
  return inbox;
}

describe("locked Engine.IO 3 WebSocket transport", () => {
  it("matches direct open, automatic SIO4 root, client heartbeat and hibernation", async () => {
    const name = tenant("eio3-ws-direct");
    const stub = store(name);
    const inbox = await openWebSocket(name);

    const openFrame = await inbox.nextString();
    const handshake = decodeEngineIoV3Handshake(decodeEngineIoV3Packet(openFrame));
    expect(openFrame).toBe(
      `0{"sid":"${handshake.sid}","upgrades":[],"pingInterval":25000,`
        + `"pingTimeout":20000,"maxPayload":1000000}`,
    );
    expect(socketPacket(await inbox.nextString())).toEqual({
      type: "connect",
      namespace: "/",
    });
    expect(socketPacket(await inbox.nextString())).toEqual({
      type: "event",
      namespace: "/",
      data: ["clients", 1],
    });

    await runInDurableObject(stub, async (_instance, state) => {
      expect(new SqliteRealtimeSessionRepository(state.storage).requireSession(handshake.sid))
        .toMatchObject({
          engineProtocol: 3,
          transport: "websocket",
          socketConnected: true,
        });
    });

    let sessionBeforePing:
      | ReturnType<SqliteRealtimeSessionRepository["requireSession"]>
      | null = null;
    await runInDurableObject(stub, async (_instance, state) => {
      sessionBeforePing =
        new SqliteRealtimeSessionRepository(state.storage).requireSession(handshake.sid);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM realtime_outbound_packets WHERE sid = ?",
        handshake.sid,
      ).one().count).toBe(0);
    });
    await evictDurableObject(stub);
    inbox.socket.send(encodeEngineIoV3Packet({ type: "ping", data: "client-data" }));
    expect(await inbox.nextString()).toBe("3");
    await runInDurableObject(stub, async (_instance, state) => {
      expect(new SqliteRealtimeSessionRepository(state.storage).requireSession(handshake.sid))
        .toEqual(sessionBeforePing);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM realtime_outbound_packets WHERE sid = ?",
        handshake.sid,
      ).one().count).toBe(0);
      const socket = state.getWebSockets(`eio4-sid:${handshake.sid}`)[0];
      if (socket === undefined) throw new Error("missing EIO3 server WebSocket");
      expect(socket.deserializeAttachment()).toMatchObject({
        version: 2,
        sid: handshake.sid,
        mode: "session",
        engineProtocol: 3,
        nextPingAt: null,
        pongDeadline: null,
      });
    });

    inbox.socket.send(clientFrame({
      type: "event",
      namespace: "/",
      id: 7,
      data: ["authorize", { client: "legacy-websocket" }],
    }));
    expect(socketPacket(await inbox.nextString())).toEqual({
      type: "event",
      namespace: "/",
      data: ["connected"],
    });
    expect(socketPacket(await inbox.nextString())).toMatchObject({
      type: "event",
      namespace: "/",
      data: ["dataUpdate", { sgvs: [] }],
    });
    expect(socketPacket(await inbox.nextString())).toEqual({
      type: "ack",
      namespace: "/",
      id: 7,
      data: [{ read: true, write: false, write_treatment: false }],
    });
    inbox.socket.close(1000, "done");
  });

  it("matches polling probe/noop/upgrade and keeps protocol after eviction", async () => {
    const name = tenant("eio3-ws-upgrade");
    const stub = store(name);
    const opened = await SELF.fetch(pollingEndpoint(name));
    expect(opened.status).toBe(200);
    const handshake = decodeEngineIoV3Handshake(
      decodeEngineIoV3PollingPayload(await opened.text())[0]!,
    );
    expect(handshake.upgrades).toEqual(["websocket"]);

    const initial = decodeEngineIoV3PollingPayload(
      await (await SELF.fetch(pollingEndpoint(name, handshake.sid))).text(),
    ).map((packet) => unwrapSocketIoV4Packet(packet));
    expect(initial).toEqual([
      { type: "connect", namespace: "/" },
      { type: "event", namespace: "/", data: ["clients", 1] },
    ]);

    const pendingPoll = SELF.fetch(pollingEndpoint(name, handshake.sid));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const inbox = await openWebSocket(name, handshake.sid);
    inbox.socket.send("2probe");
    expect(await inbox.nextString()).toBe("3probe");
    expect(await (await pendingPoll).text()).toBe("1:6");

    inbox.socket.send("5");
    // Wait for the server to process the upgrade before inspecting persisted state.
    inbox.socket.send("2");
    expect(await inbox.nextString()).toBe("3");
    await runInDurableObject(stub, async (_instance, state) => {
      expect(new SqliteRealtimeSessionRepository(state.storage).requireSession(handshake.sid))
        .toMatchObject({
          engineProtocol: 3,
          transport: "websocket",
          pollToken: null,
        });
    });

    await evictDurableObject(stub);
    inbox.socket.send("2");
    expect(await inbox.nextString()).toBe("3");
    inbox.socket.send(clientFrame({ type: "connect", namespace: "/storage" }));
    expect(socketPacket(await inbox.nextString())).toEqual({
      type: "connect",
      namespace: "/storage",
    });
    inbox.socket.close(1000, "done");
  });

  it("rejects a cross-protocol upgrade SID without damaging polling", async () => {
    const name = tenant("eio3-ws-mismatch");
    const opened = await SELF.fetch(pollingEndpoint(name));
    const handshake = decodeEngineIoV3Handshake(
      decodeEngineIoV3PollingPayload(await opened.text())[0]!,
    );

    const mismatch = await SELF.fetch(
      websocketEndpoint(name, handshake.sid).replace("EIO=3", "EIO=4"),
      { headers: { Upgrade: "websocket" } },
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({ code: 1, message: "Session ID unknown" });

    const stillPolling = await SELF.fetch(pollingEndpoint(name, handshake.sid));
    expect(stillPolling.status).toBe(200);
    expect(decodeEngineIoV3PollingPayload(await stillPolling.text())).toHaveLength(2);
  });
});
