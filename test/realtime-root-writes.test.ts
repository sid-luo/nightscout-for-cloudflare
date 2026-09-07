import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { EntryStore } from "../src/entry-store";
import {
  decodeEngineIoV4Handshake,
  decodeEngineIoV4PollingPayload,
  encodeEngineIoV4PollingPayload,
  unwrapSocketIoV5Packet,
  wrapSocketIoV5Packet,
  type SocketIoV5Packet,
} from "../src/protocol";

const TEST_API_SECRET = "nscf-test-secret-20260717";

type JsonObject = Record<string, unknown>;
type RootWriteEvent = "dbAdd" | "dbUpdate" | "dbUpdateUnset" | "dbRemove";

function tenant(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function store(tenantName: string): DurableObjectStub<EntryStore> {
  return env.ENTRY_STORE.getByName(tenantName);
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

function endpoint(tenantName: string, sid?: string): string {
  const suffix = sid === undefined ? "" : `&sid=${encodeURIComponent(sid)}`;
  return `https://example.test/socket.io/?EIO=4&transport=polling&tenant=${tenantName}${suffix}`;
}

function clientPayload(packet: SocketIoV5Packet): string {
  return encodeEngineIoV4PollingPayload([wrapSocketIoV5Packet(packet)]);
}

interface PollingSocket {
  sid: string;
  send: (packet: SocketIoV5Packet) => Promise<void>;
  poll: () => Promise<SocketIoV5Packet[]>;
  write: (
    event: RootWriteEvent,
    message: JsonObject,
  ) => Promise<{ acknowledgement: unknown; packets: SocketIoV5Packet[] }>;
}

async function openPollingSocket(
  tenantName: string,
  authorization: "admin" | "readable" | "none" = "admin",
): Promise<PollingSocket> {
  const handshake = await SELF.fetch(endpoint(tenantName));
  expect(handshake.status).toBe(200);
  const [open] = decodeEngineIoV4PollingPayload(await handshake.text());
  const sid = decodeEngineIoV4Handshake(open!).sid;
  let callbackId = 20;

  const send = async (packet: SocketIoV5Packet): Promise<void> => {
    const response = await SELF.fetch(endpoint(tenantName, sid), {
      method: "POST",
      body: clientPayload(packet),
    });
    expect(response.status).toBe(200);
  };
  const poll = async (): Promise<SocketIoV5Packet[]> => {
    const response = await SELF.fetch(endpoint(tenantName, sid));
    expect(response.status).toBe(200);
    return decodeEngineIoV4PollingPayload(await response.text())
      .map((packet) => unwrapSocketIoV5Packet(packet));
  };

  await send({ type: "connect", namespace: "/" });
  await poll();
  if (authorization !== "none") {
    const id = callbackId++;
    await send({
      type: "event",
      namespace: "/",
      id,
      data: [
        "authorize",
        authorization === "admin"
          ? { client: "test", secret: await secretDigest() }
          : { client: "test" },
      ],
    });
    const packets = await poll();
    const acknowledgement = packets.find((packet) =>
      packet.type === "ack" && packet.namespace === "/" && packet.id === id
    );
    expect(acknowledgement).toBeDefined();
    expect(
      (acknowledgement as Extract<SocketIoV5Packet, { type: "ack" }>).data[0],
    ).toEqual(authorization === "admin"
      ? { read: true, write: true, write_treatment: true }
      : { read: true, write: false, write_treatment: false });
  }

  const write = async (
    event: RootWriteEvent,
    message: JsonObject,
  ): Promise<{ acknowledgement: unknown; packets: SocketIoV5Packet[] }> => {
    const id = callbackId++;
    await send({
      type: "event",
      namespace: "/",
      id,
      data: [event, message],
    });
    const packets = await poll();
    const acknowledgement = packets.find((packet) =>
      packet.type === "ack" && packet.namespace === "/" && packet.id === id
    );
    expect(acknowledgement).toBeDefined();
    return {
      acknowledgement:
        (acknowledgement as Extract<SocketIoV5Packet, { type: "ack" }>).data[0],
      packets,
    };
  };

  return { sid, send, poll, write };
}

async function storedDocuments(
  tenantName: string,
  collection: string,
): Promise<JsonObject[]> {
  return runInDurableObject(store(tenantName), async (_instance, state) =>
    state.storage.sql
      .exec<{ id: string; body: string }>(
        `SELECT id, body FROM documents
         WHERE collection = ?
         ORDER BY sort_time ASC, id ASC`,
        collection,
      )
      .toArray()
      .map((row) => ({ ...JSON.parse(row.body) as JsonObject, _id: row.id }))
  );
}

function acknowledgementDocuments(value: unknown): JsonObject[] {
  expect(Array.isArray(value)).toBe(true);
  return value as JsonObject[];
}

function expectAckBeforeRootDelta(packets: SocketIoV5Packet[]): void {
  const acknowledgementIndex = packets.findIndex((packet) => packet.type === "ack");
  const deltaIndex = packets.findIndex((packet) =>
    packet.type === "event"
    && packet.namespace === "/"
    && packet.data[0] === "dataUpdate"
  );
  expect(acknowledgementIndex).toBeGreaterThanOrEqual(0);
  expect(deltaIndex).toBeGreaterThan(acknowledgementIndex);
}

function aapsProfile(startDate: number, carbratio: number): JsonObject {
  const iso = new Date(startDate).toISOString();
  return {
    defaultProfile: "aaps-test",
    date: startDate,
    created_at: iso,
    startDate: iso,
    units: "mg/dl",
    store: {
      "aaps-test": {
        dia: 5,
        carbratio: [{ time: "00:00", value: carbratio }],
        sens: [{ time: "00:00", value: 50 }],
        basal: [{ time: "00:00", value: 0.5 }],
        target_low: [{ time: "00:00", value: 100 }],
        target_high: [{ time: "00:00", value: 120 }],
        timezone: "UTC",
      },
    },
  };
}

describe("locked websocket.js root mutation adapter", () => {
  it("keeps checkConditions ordering and exact callback errors", async () => {
    const unauthenticated = await openPollingSocket(tenant("root-write-unauth"), "none");
    expect((await unauthenticated.write("dbAdd", {
      collection: "unknown",
      data: {},
    })).acknowledgement).toEqual({ result: "Wrong collection" });
    expect((await unauthenticated.write("dbAdd", {
      collection: "food",
      data: {},
    })).acknowledgement).toEqual({ result: "Not authorized" });

    const readable = await openPollingSocket(tenant("root-write-readable"), "readable");
    expect((await readable.write("dbAdd", {
      collection: "food",
      data: {},
    })).acknowledgement).toEqual({ result: "Not permitted" });

    const admin = await openPollingSocket(tenant("root-write-missing-id"));
    expect((await admin.write("dbUpdate", {
      collection: "food",
      data: { carbs: 10 },
    })).acknowledgement).toEqual({ result: "Missing _id" });
    expect((await admin.write("dbUpdateUnset", {
      collection: "food",
      data: { carbs: 1 },
    })).acknowledgement).toEqual({ result: "Missing _id" });
    expect((await admin.write("dbRemove", {
      collection: "food",
    })).acknowledgement).toEqual({ result: "Missing _id" });
  });

  it("accepts treatment single/array shapes, defaults fields, and exact dedupes", async () => {
    const name = tenant("root-write-treatments");
    const socket = await openPollingSocket(name);
    const firstAt = Date.now() - 20_000;
    const first = await socket.write("dbAdd", {
      collection: "treatments",
      data: {
        eventType: "Note",
        created_at: new Date(firstAt).toISOString(),
        notes: "ws single object test",
      },
    });
    const [firstDocument] = acknowledgementDocuments(first.acknowledgement);
    expect(firstDocument).toMatchObject({
      eventType: "Note",
      notes: "ws single object test",
      _id: expect.any(String),
    });
    expectAckBeforeRootDelta(first.packets);

    const array = await socket.write("dbAdd", {
      collection: "treatments",
      data: [
        {
          eventType: "Exercise",
          created_at: new Date(firstAt + 5_000).toISOString(),
          notes: "ws array item 1",
        },
        {
          eventType: "Announcement",
          created_at: new Date(firstAt + 10_000).toISOString(),
          notes: "ws array item 2",
        },
      ],
    });
    expect(acknowledgementDocuments(array.acknowledgement)).toHaveLength(2);

    const defaulted = await socket.write("dbAdd", {
      collection: "treatments",
      data: { notes: "defaults" },
    });
    const [defaultedDocument] = acknowledgementDocuments(defaulted.acknowledgement);
    expect(defaultedDocument).toMatchObject({
      eventType: "", // 15.0.8 storage purification removes the synthetic tag.
      created_at: expect.any(String),
    });

    const replay = await socket.write("dbAdd", {
      collection: "treatments",
      data: {
        eventType: "Note",
        created_at: new Date(firstAt).toISOString(),
        notes: "ignored exact replay",
      },
    });
    expect(acknowledgementDocuments(replay.acknowledgement)[0]?._id)
      .toBe(firstDocument?._id);
    expect(await storedDocuments(name, "treatments")).toHaveLength(4);
  });

  it("accepts devicestatus and entries as both one object and arrays", async () => {
    const name = tenant("root-write-shapes");
    const socket = await openPollingSocket(name);
    const now = Date.now() - 30_000;

    const status = await socket.write("dbAdd", {
      collection: "devicestatus",
      data: {
        device: "ws-test-device",
        created_at: new Date(now).toISOString(),
        uploaderBattery: 99,
      },
    });
    expect(acknowledgementDocuments(status.acknowledgement)[0])
      .toMatchObject({ uploaderBattery: 99 });
    const statuses = await socket.write("dbAdd", {
      collection: "devicestatus",
      data: [
        {
          device: "ws-device-1",
          created_at: new Date(now + 1_000).toISOString(),
          uploaderBattery: 80,
        },
        {
          device: "ws-device-2",
          created_at: new Date(now + 2_000).toISOString(),
          uploaderBattery: 75,
        },
      ],
    });
    expect(acknowledgementDocuments(statuses.acknowledgement)).toHaveLength(2);

    const entry = await socket.write("dbAdd", {
      collection: "entries",
      data: {
        type: "sgv",
        sgv: 120,
        date: now,
        dateString: new Date(now).toISOString(),
      },
    });
    expect(acknowledgementDocuments(entry.acknowledgement)).toHaveLength(1);
    const entries = await socket.write("dbAdd", {
      collection: "entries",
      data: [
        {
          type: "sgv",
          sgv: 115,
          date: now + 300_000,
          dateString: new Date(now + 300_000).toISOString(),
        },
        {
          type: "sgv",
          sgv: 125,
          date: now + 600_000,
          dateString: new Date(now + 600_000).toISOString(),
        },
      ],
    });
    expect(acknowledgementDocuments(entries.acknowledgement)).toHaveLength(2);
    expect(await storedDocuments(name, "devicestatus")).toHaveLength(3);
    expect(await storedDocuments(name, "entries")).toHaveLength(3);
  });

  it("updates, unsets, removes, and fuzzy-dedupes custom treatment ids", async () => {
    const name = tenant("root-write-custom-treatment");
    const socket = await openPollingSocket(name);
    const createdAt = new Date(Date.now() - 10_000).toISOString();
    const customId = "legacy-string-id-update";
    await socket.write("dbAdd", {
      collection: "treatments",
      data: {
        _id: customId,
        eventType: "Note",
        created_at: createdAt,
        notes: "legacy original",
      },
    });
    expect((await socket.write("dbUpdate", {
      collection: "treatments",
      _id: customId,
      data: { notes: "legacy updated", nested: { value: 1 } },
    })).acknowledgement).toEqual({ result: "success" });
    expect((await storedDocuments(name, "treatments"))[0])
      .toMatchObject({ _id: customId, notes: "legacy updated" });

    expect((await socket.write("dbUpdateUnset", {
      collection: "treatments",
      _id: customId,
      data: { notes: 1 },
    })).acknowledgement).toEqual({ result: "success" });
    expect((await storedDocuments(name, "treatments"))[0]).not.toHaveProperty("notes");

    expect((await socket.write("dbRemove", {
      collection: "treatments",
      _id: customId,
    })).acknowledgement).toEqual({ result: "success" });
    expect(await storedDocuments(name, "treatments")).toEqual([]);

    const generated = acknowledgementDocuments((await socket.write("dbAdd", {
      collection: "treatments",
      data: {
        eventType: "Note",
        created_at: new Date(Date.now() - 8_000).toISOString(),
        notes: "generated original",
      },
    })).acknowledgement)[0]!;
    expect(generated._id).toEqual(expect.any(String));
    expect((await socket.write("dbUpdate", {
      collection: "treatments",
      _id: generated._id,
      data: { notes: "generated updated" },
    })).acknowledgement).toEqual({ result: "success" });
    expect(await storedDocuments(name, "treatments")).toEqual([
      expect.objectContaining({ _id: generated._id, notes: "generated updated" }),
    ]);
    expect((await socket.write("dbRemove", {
      collection: "treatments",
      _id: generated._id,
    })).acknowledgement).toEqual({ result: "success" });
    expect(await storedDocuments(name, "treatments")).toEqual([]);

    const fuzzyId = "legacy-string-id-dedupe";
    const originalAt = Date.now() - 5_000;
    await socket.write("dbAdd", {
      collection: "treatments",
      data: {
        _id: fuzzyId,
        eventType: "Note",
        created_at: new Date(originalAt).toISOString(),
        notes: "existing legacy note",
      },
    });
    const dedupedAt = new Date(originalAt + 1_000).toISOString();
    const fuzzy = await socket.write("dbAdd", {
      collection: "treatments",
      data: {
        eventType: "Note",
        created_at: dedupedAt,
        notes: "incoming legacy note",
      },
    });
    expect(acknowledgementDocuments(fuzzy.acknowledgement)[0])
      .toMatchObject({ _id: fuzzyId, created_at: dedupedAt, notes: "existing legacy note" });
    expect(await storedDocuments(name, "treatments")).toEqual([
      expect.objectContaining({
        _id: fuzzyId,
        created_at: dedupedAt,
        notes: "existing legacy note",
      }),
    ]);
  });

  it("replaces AAPS profiles in place and orders distinct startDate versions", async () => {
    const name = tenant("root-write-profile");
    const socket = await openPollingSocket(name);
    const timestamp = Date.now() - 60_000;
    const first = await socket.write("dbAdd", {
      collection: "profile",
      data: aapsProfile(timestamp, 10),
    });
    const firstId = acknowledgementDocuments(first.acknowledgement)[0]?._id;
    expect(firstId).toEqual(expect.any(String));

    const replacement = await socket.write("dbAdd", {
      collection: "profile",
      data: aapsProfile(timestamp, 12),
    });
    expect(acknowledgementDocuments(replacement.acknowledgement)[0]?._id).toBe(firstId);
    let profiles = await storedDocuments(name, "profile");
    expect(profiles).toHaveLength(1);
    expect(
      (((profiles[0]!.store as JsonObject)["aaps-test"] as JsonObject)
        .carbratio as JsonObject[])[0]?.value,
    ).toBe(12);

    await socket.write("dbAdd", {
      collection: "profile",
      data: aapsProfile(timestamp + 60_000, 14),
    });
    profiles = await storedDocuments(name, "profile");
    expect(profiles).toHaveLength(2);
    const newest = profiles.sort((left, right) =>
      String(right.startDate).localeCompare(String(left.startDate))
    )[0]!;
    expect(
      (((newest.store as JsonObject)["aaps-test"] as JsonObject)
        .carbratio as JsonObject[])[0]?.value,
    ).toBe(14);
  });

  it("preserves generic custom ids through food add/update/remove and supports activity", async () => {
    const name = tenant("root-write-generic");
    const socket = await openPollingSocket(name);
    const customId = "legacy-food-id";
    const added = await socket.write("dbAdd", {
      collection: "food",
      data: { _id: customId, name: "ws food", carbs: 15 },
    });
    expect(acknowledgementDocuments(added.acknowledgement)[0])
      .toMatchObject({ _id: customId, name: "ws food", carbs: 15 });

    expect((await socket.write("dbUpdate", {
      collection: "food",
      _id: customId,
      data: {
        carbs: 18,
        protein: 4,
        "__proto__.polluted": "stored-only",
      },
    })).acknowledgement).toEqual({ result: "success" });
    const food = await storedDocuments(name, "food");
    expect(food).toEqual([
      expect.objectContaining({ _id: customId, carbs: 18, protein: 4 }),
    ]);
    expect((food[0]!["__proto__"] as JsonObject).polluted).toBe("stored-only");
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();

    expect((await socket.write("dbRemove", {
      collection: "food",
      _id: customId,
    })).acknowledgement).toEqual({ result: "success" });
    expect(await storedDocuments(name, "food")).toEqual([]);

    const activity = await socket.write("dbAdd", {
      collection: "activity",
      data: { _id: "activity-custom-id", type: "walking", duration: 30 },
    });
    expect(acknowledgementDocuments(activity.acknowledgement)[0])
      .toMatchObject({ _id: "activity-custom-id", type: "walking", duration: 30 });
    expect(await storedDocuments(name, "activity")).toHaveLength(1);
  });
});

describe("15.0.8 realtime stored text protection", () => {
  it("cleans dbAdd acknowledgements, dbUpdate persistence and nested values", async () => {
    const name = tenant('xss-realtime');
    const socket = await openPollingSocket(name);
    const payload = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const added = await socket.write('dbAdd', { collection: 'food',
      data: { name: payload, nested: { notes: payload } } });
    const [document] = acknowledgementDocuments(added.acknowledgement);
    expect(document?.name).toBe('<img src="x" />');
    await socket.write('dbUpdate', { collection: 'food', _id: document?._id,
      data: { name: payload, 'nested.notes': payload } });
    const [stored] = await storedDocuments(name, 'food');
    expect(stored?.name).toBe('<img src="x" />');
    expect(stored?.nested).toEqual({ notes: '<img src="x" />' });
  });
});

describe("15.0.8 realtime batch preflight", () => {
  it("rejects the whole batch before committing its valid prefix", async () => {
    const name = tenant('invalid-batch-preflight');
    const socket = await openPollingSocket(name);
    await socket.write('dbAdd', { collection: 'food', data: [{ name: 'valid' }, null] });
    expect(await storedDocuments(name, 'food')).toEqual([]);
  });
});
