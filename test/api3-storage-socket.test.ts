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
    const roleName = `storage-role-${suffix}`;
    expect((await adminWrite(tenantName, "/api/v2/authorization/roles", {
      name: roleName,
      permissions,
    })).status).toBe(200);
    assignedRoles.push(roleName);
  }

  const created = await adminWrite(
    tenantName,
    "/api/v2/authorization/subjects",
    { name: `Storage subject ${suffix}`, roles: assignedRoles },
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
    throw new Error("created storage subject has no access token");
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

async function openStoragePolling(tenantName: string): Promise<PollingSocket> {
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
  expect((await socket.send({ type: "connect", namespace: "/storage" })).status).toBe(200);
  expect(await socket.poll()).toEqual([{
    type: "connect",
    namespace: "/storage",
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
    namespace: "/storage",
    id,
    data: ["subscribe", message],
  })).status).toBe(200);
  const packets = await socket.poll();
  expect(packets).toHaveLength(1);
  return packets[0]!;
}

function api3Document(identifier: string, extra: JsonObject = {}): JsonObject {
  const createdAt = "2026-07-19T06:00:00.000Z";
  return {
    identifier,
    date: Date.parse(createdAt),
    utcOffset: 0,
    app: "nscf-storage-socket-test",
    device: "simulated",
    eventType: "Note",
    created_at: createdAt,
    ...extra,
  };
}

async function api3Mutation(
  tenantName: string,
  jwt: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = new URL(`https://example.test${path}`);
  url.searchParams.set("tenant", tenantName);
  return SELF.fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
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
      const timer = setTimeout(() => reject(new Error("timed out waiting for websocket")), timeoutMs);
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

async function openStorageWebSocket(tenantName: string): Promise<WebSocketInbox> {
  const response = await SELF.fetch(websocketEndpoint(tenantName), {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  if (response.webSocket === null) throw new Error("websocket upgrade returned no socket");
  const inbox = new WebSocketInbox(response.webSocket);
  response.webSocket.accept();
  decodeEngineIoV4Handshake(decodeEngineIoV4Packet(await inbox.next()));
  inbox.socket.send(websocketClientFrame({ type: "connect", namespace: "/storage" }));
  expect(websocketPacket(await inbox.next())).toMatchObject({
    type: "connect",
    namespace: "/storage",
  });
  return inbox;
}

describe("API3 /storage Socket.IO namespace", () => {
  it("connects independently and returns the locked missing/bad token failures", async () => {
    const name = tenant("storage-auth-fail");
    const socket = await openStoragePolling(name);

    expect(await subscribe(socket, 1, {})).toEqual({
      type: "ack",
      namespace: "/storage",
      id: 1,
      data: [{ success: false, message: "Missing or bad accessToken" }],
    });
    expect(await subscribe(socket, 2, { accessToken: "INVALID" })).toEqual({
      type: "ack",
      namespace: "/storage",
      id: 2,
      data: [{ success: false, message: "Missing or bad accessToken" }],
    });

    expect((await socket.send({ type: "connect", namespace: "/admin" })).status).toBe(200);
    expect(await socket.poll()).toEqual([{
      type: "error",
      namespace: "/admin",
      data: { message: "Invalid namespace" },
    }]);
  });

  it("filters requested rooms and preserves the Settings admin exception", async () => {
    const name = tenant("storage-room-perms");
    const readable = await issueSubject(name, []);
    const socket = await openStoragePolling(name);

    expect(await subscribe(socket, 3, {
      accessToken: readable.accessToken,
      collections: ["settings"],
    })).toEqual({
      type: "ack",
      namespace: "/storage",
      id: 3,
      data: [{ success: false, message: "Unauthorized to receive any collection" }],
    });
    expect(await subscribe(socket, 4, {
      accessToken: readable.accessToken,
      collections: ["treatments", "unknown", "treatments"],
    })).toEqual({
      type: "ack",
      namespace: "/storage",
      id: 4,
      data: [{ success: true, collections: ["treatments", "treatments"] }],
    });

    const admin = await issueSubject(name, ["admin"]);
    const adminSocket = await openStoragePolling(name);
    expect(await subscribe(adminSocket, 5, {
      accessToken: admin.accessToken,
      collections: ["settings"],
    })).toEqual({
      type: "ack",
      namespace: "/storage",
      id: 5,
      data: [{ success: true, collections: ["settings"] }],
    });
    expect(await subscribe(adminSocket, 6, {
      accessToken: admin.accessToken,
    })).toEqual({
      type: "ack",
      namespace: "/storage",
      id: 6,
      data: [{
        success: true,
        collections: [
          "devicestatus",
          "entries",
          "food",
          "profile",
          "settings",
          "treatments",
        ],
      }],
    });
  });

  it("persists subscriptions across eviction and emits API3-shaped events for every API", async () => {
    const name = tenant("storage-events");
    const beta = tenant("storage-events-beta");
    const subject = await issueSubject(name, [], [
      "api:treatments:read,create,update,delete",
      "api:food:create",
    ]);
    const betaSubject = await issueSubject(beta, [], ["api:treatments:read"]);
    const socket = await openStoragePolling(name);
    const betaSocket = await openStoragePolling(beta);
    expect(await subscribe(socket, 7, {
      accessToken: subject.accessToken,
      collections: ["treatments"],
    })).toMatchObject({ type: "ack", data: [{ success: true }] });
    expect(await subscribe(betaSocket, 8, {
      accessToken: betaSubject.accessToken,
      collections: ["treatments"],
    })).toMatchObject({ type: "ack", data: [{ success: true }] });

    await evictDurableObject(store(name));
    const identifier = `storage-treatment-${crypto.randomUUID()}`;
    const original = api3Document(identifier, {
      notes: "created",
      eventType: "Temp Basal",
      absolute: 1.2,
      duration: 30,
    });
    expect((await api3Mutation(
      name,
      subject.jwt,
      "POST",
      "/api/v3/treatments",
      original,
    )).status).toBe(201);
    const [created] = await socket.poll();
    expect(created).toMatchObject({
      type: "event",
      namespace: "/storage",
      data: ["create", {
        colName: "treatments",
        doc: { identifier, notes: "created" },
      }],
    });

    expect((await api3Mutation(
      name,
      subject.jwt,
      "POST",
      "/api/v3/treatments",
      { ...original, notes: "deduplicated update" },
    )).status).toBe(200);
    expect((await socket.poll())[0]).toMatchObject({
      type: "event",
      namespace: "/storage",
      data: ["update", {
        colName: "treatments",
        doc: { identifier, notes: "deduplicated update" },
      }],
    });

    expect((await api3Mutation(
      name,
      subject.jwt,
      "PUT",
      `/api/v3/treatments/${encodeURIComponent(identifier)}`,
      { ...original, notes: "replaced" },
    )).status).toBe(200);
    expect((await socket.poll())[0]).toMatchObject({
      type: "event",
      namespace: "/storage",
      data: ["update", { colName: "treatments", doc: { identifier, notes: "replaced" } }],
    });

    expect((await api3Mutation(
      name,
      subject.jwt,
      "PATCH",
      `/api/v3/treatments/${encodeURIComponent(identifier)}`,
      {
        notes: "patched",
        absolute: 0.7,
        duration: 0,
        durationInMilliseconds: 26_584,
      },
    )).status).toBe(200);
    expect((await socket.poll())[0]).toMatchObject({
      type: "event",
      namespace: "/storage",
      data: ["update", {
        colName: "treatments",
        doc: {
          identifier,
          notes: "patched",
          absolute: 0.7,
          duration: 0,
          durationInMilliseconds: 26_584,
          endmills: Date.parse("2026-07-19T06:00:00.000Z") + 26_584,
        },
      }],
    });

    expect((await api3Mutation(
      name,
      subject.jwt,
      "DELETE",
      `/api/v3/treatments/${encodeURIComponent(identifier)}`,
    )).status).toBe(200);
    expect((await socket.poll())[0]).toEqual({
      type: "event",
      namespace: "/storage",
      data: ["delete", { colName: "treatments", identifier }],
    });

    const putIdentifier = `storage-put-create-${crypto.randomUUID()}`;
    expect((await api3Mutation(
      name,
      subject.jwt,
      "PUT",
      `/api/v3/treatments/${encodeURIComponent(putIdentifier)}`,
      api3Document(putIdentifier, { notes: "PUT inserted this document" }),
    )).status).toBe(201);
    expect((await socket.poll())[0]).toMatchObject({
      type: "event",
      namespace: "/storage",
      data: ["create", {
        colName: "treatments",
        doc: { identifier: putIdentifier, notes: "PUT inserted this document" },
      }],
    });

    const foodIdentifier = `storage-food-${crypto.randomUUID()}`;
    expect((await api3Mutation(
      name,
      subject.jwt,
      "POST",
      "/api/v3/food",
      api3Document(foodIdentifier, { name: "Room isolation test" }),
    )).status).toBe(201);
    expect((await api3Mutation(
      name,
      subject.jwt,
      "PATCH",
      `/api/v3/treatments/${crypto.randomUUID()}`,
      { notes: "missing documents do not emit" },
    )).status).toBe(404);
    expect((await api3Mutation(
      name,
      subject.jwt,
      "DELETE",
      `/api/v3/treatments/${encodeURIComponent(identifier)}?permanent=true`,
    )).status).toBe(200);
    expect((await socket.poll())[0]).toEqual({
      type: "event",
      namespace: "/storage",
      data: ["delete", { colName: "treatments", identifier }],
    });

    const legacy = await SELF.fetch(
      `https://example.test/api/v1/treatments?tenant=${name}`,
      {
        method: "POST",
        headers: {
          "api-secret": await secretDigest(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          eventType: "Note",
          created_at: "2026-07-19T06:30:00.000Z",
          notes: "v1 broadcasts an API3-shaped storage event",
        }),
      },
    );
    expect(legacy.status).toBe(200);
    const [legacyStored] = await legacy.json<JsonObject[]>();
    const legacyIdentifier = String(legacyStored?._id);
    const [legacyCreated] = await socket.poll();
    expect(legacyCreated).toMatchObject({
      type: "event",
      namespace: "/storage",
      data: ["create", {
        colName: "treatments",
        doc: {
          identifier: legacyIdentifier,
          notes: "v1 broadcasts an API3-shaped storage event",
          srvCreated: Date.parse("2026-07-19T06:30:00.000Z"),
          srvModified: Date.parse("2026-07-19T06:30:00.000Z"),
        },
      }],
    });
    const legacyDelete = await SELF.fetch(
      `https://example.test/api/v1/treatments/${legacyIdentifier}?tenant=${name}`,
      {
        method: "DELETE",
        headers: { "api-secret": await secretDigest() },
      },
    );
    expect(legacyDelete.status).toBe(200);
    expect((await socket.poll())[0]).toEqual({
      type: "event",
      namespace: "/storage",
      data: ["delete", {
        colName: "treatments",
        identifier: legacyIdentifier,
      }],
    });
    expect(await runInDurableObject(store(beta), async (_instance, state) =>
      state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM realtime_outbound_packets WHERE sid = ?",
        betaSocket.sid,
      ).one().count
    )).toBe(0);
  });

  it("publishes an API3-shaped entries event for an xDrip-style v1 CGM upload", async () => {
    const name = tenant("storage-legacy-entry");
    const subject = await issueSubject(name, [], ["api:entries:read"]);
    const socket = await openStoragePolling(name);
    expect(await subscribe(socket, 9, {
      accessToken: subject.accessToken,
      collections: ["entries"],
    })).toMatchObject({ type: "ack", data: [{ success: true }] });

    const identifier = `xdrip-${crypto.randomUUID()}`;
    const date = Date.UTC(2026, 6, 25, 4, 20, 0);
    const uploaded = await SELF.fetch(
      `https://example.test/api/v1/entries?tenant=${name}`,
      {
        method: "POST",
        headers: {
          "api-secret": await secretDigest(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          identifier,
          date,
          dateString: new Date(date).toISOString(),
          device: "xDrip-NSFollower",
          type: "sgv",
          sgv: 157,
          direction: "Flat",
        }),
      },
    );
    expect(uploaded.status).toBe(200);

    const [created] = await socket.poll();
    expect(created).toMatchObject({
      type: "event",
      namespace: "/storage",
      data: ["create", {
        colName: "entries",
        doc: {
          identifier,
          date,
          device: "xDrip-NSFollower",
          type: "sgv",
          sgv: 157,
          direction: "Flat",
          srvCreated: date,
          srvModified: date,
        },
      }],
    });
    if (created?.type !== "event") throw new Error("expected a storage event");
    expect(created.data[1]).toEqual(expect.objectContaining({
      doc: expect.not.objectContaining({ _id: expect.anything() }),
    }));
  });

  it("delivers a persisted API3 event to a hibernatable WebSocket after eviction", async () => {
    const name = tenant("storage-websocket");
    const subject = await issueSubject(name, [], [
      "api:treatments:read,create",
    ]);
    const inbox = await openStorageWebSocket(name);
    inbox.socket.send(websocketClientFrame({
      type: "event",
      namespace: "/storage",
      id: 9,
      data: ["subscribe", {
        accessToken: subject.accessToken,
        collections: ["treatments"],
      }],
    }));
    expect(websocketPacket(await inbox.next())).toEqual({
      type: "ack",
      namespace: "/storage",
      id: 9,
      data: [{ success: true, collections: ["treatments"] }],
    });

    await evictDurableObject(store(name));
    const identifier = `storage-ws-${crypto.randomUUID()}`;
    expect((await api3Mutation(
      name,
      subject.jwt,
      "POST",
      "/api/v3/treatments",
      api3Document(identifier),
    )).status).toBe(201);
    expect(websocketPacket(await inbox.next())).toMatchObject({
      type: "event",
      namespace: "/storage",
      data: ["create", { colName: "treatments", doc: { identifier } }],
    });
  });

  it("drops a broken subscriber without rolling back the API3 document", async () => {
    const name = tenant("storage-outbox-failure");
    const subject = await issueSubject(name, [], [
      "api:treatments:read,create",
    ]);
    const socket = await openStoragePolling(name);
    expect(await subscribe(socket, 10, {
      accessToken: subject.accessToken,
      collections: ["treatments"],
    })).toMatchObject({ type: "ack", data: [{ success: true }] });

    await runInDurableObject(store(name), async (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER fail_storage_outbound
        BEFORE INSERT ON realtime_outbound_packets
        BEGIN
          SELECT RAISE(ABORT, 'forced storage outbound failure');
        END;
      `);
    });
    const identifier = `storage-failure-${crypto.randomUUID()}`;
    expect((await api3Mutation(
      name,
      subject.jwt,
      "POST",
      "/api/v3/treatments",
      api3Document(identifier),
    )).status).toBe(201);

    await runInDurableObject(store(name), async (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM realtime_sessions WHERE sid = ?",
        socket.sid,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM documents
         WHERE collection = 'treatments'
           AND json_extract(body, '$.identifier') = ?`,
        identifier,
      ).one().count).toBe(1);
      state.storage.sql.exec("DROP TRIGGER fail_storage_outbound");
    });
  });

  it("repairs the v9 namespace schema despite a higher independent marker", async () => {
    const name = tenant("storage-migrate-v9");
    const stub = store(name);

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`
        DROP INDEX IF EXISTS realtime_storage_by_collection;
        DROP TABLE realtime_storage_subscriptions;
        DROP TABLE realtime_storage_connections;
      `);
      state.storage.sql.exec(
        "DELETE FROM _sql_schema_migrations WHERE id IN (9, ?)",
        ENTRY_STORE_ACTIVATION_SEAL,
      );
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (99)",
      );
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      for (const table of [
        "realtime_storage_connections",
        "realtime_storage_subscriptions",
      ]) {
        expect(state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM sqlite_master
           WHERE type = 'table' AND name = ?`,
          table,
        ).one().count).toBe(1);
      }
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'index' AND name = 'realtime_storage_by_collection'`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id = 9",
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id = 99",
      ).one().count).toBe(1);
    });

    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM _sql_schema_migrations WHERE id = 9",
      ).one().count).toBe(1);
    });
  });
});
