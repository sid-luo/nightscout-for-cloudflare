import { describe, expect, it } from "vitest";
import nightscoutPackageLock from "../vendor/nightscout/package-lock.json";
import {
  ENGINE_IO_V4_HEARTBEAT,
  ENGINE_IO_V4_POLLING_SEPARATOR,
  ENGINE_IO_V4_PROTOCOL,
  LEGACY_EIO3_SIO4_STACK,
  OFFICIAL_EIO4_SIO5_STACK,
  SOCKET_IO_V4_PROTOCOL,
  SOCKET_IO_V5_PROTOCOL,
  ProtocolError,
  createEngineIoV4HandshakePacket,
  createSocketIoV5ServerConnectPacket,
  decodeEngineIoV4Handshake,
  decodeEngineIoV4Packet,
  decodeEngineIoV4PollingPayload,
  decodeSocketIoPacketForStack,
  decodeSocketIoV5Packet,
  encodeEngineIoPollingPayloadForStack,
  encodeEngineIoV4Packet,
  encodeEngineIoV4PollingPayload,
  encodeSocketIoPacketForStack,
  encodeSocketIoV5Packet,
  negotiateProtocolStack,
  unwrapSocketIoV5Packet,
  wrapSocketIoV5Packet,
  type EngineIoV4Handshake,
  type EngineIoV4Packet,
  type SocketIoV5Packet,
} from "../src/protocol";

function expectProtocolError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`expected ProtocolError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
  }
}

const HANDSHAKE: EngineIoV4Handshake = {
  sid: "engine123",
  upgrades: ["websocket"],
  pingInterval: 25_000,
  pingTimeout: 20_000,
  maxPayload: 1_000_000,
};

describe("official Nightscout Socket.IO 4.8.3 dependency contract", () => {
  it("pins the browser server bundle and parser protocols independently from the test client", () => {
    expect(nightscoutPackageLock.packages["node_modules/socket.io"].version).toBe("4.8.3");
    expect(nightscoutPackageLock.packages["node_modules/engine.io"].version).toBe("6.6.7");
    expect(nightscoutPackageLock.packages["node_modules/engine.io-parser"].version).toBe("5.2.3");
    expect(nightscoutPackageLock.packages["node_modules/socket.io-parser"].version).toBe("4.2.6");
    expect(nightscoutPackageLock.packages["node_modules/socket.io-client"].version).toBe("4.8.3");
    expect(ENGINE_IO_V4_PROTOCOL).toBe(4);
    expect(SOCKET_IO_V5_PROTOCOL).toBe(5);
    expect(SOCKET_IO_V4_PROTOCOL).toBe(4);
  });

  it("binds EIO=4 only to SIO5 and keeps EIO=3/SIO4 explicitly legacy", () => {
    expect(negotiateProtocolStack("4")).toBe(OFFICIAL_EIO4_SIO5_STACK);
    expect(negotiateProtocolStack(4)).toBe(OFFICIAL_EIO4_SIO5_STACK);
    expect(negotiateProtocolStack("3")).toBe(LEGACY_EIO3_SIO4_STACK);
    expect(OFFICIAL_EIO4_SIO5_STACK).toMatchObject({
      compatibility: "official",
      engineIoProtocol: 4,
      socketIoProtocol: 5,
    });
    expect(LEGACY_EIO3_SIO4_STACK).toMatchObject({
      compatibility: "legacy",
      engineIoProtocol: 3,
      socketIoProtocol: 4,
    });
    expectProtocolError(() => negotiateProtocolStack(undefined), "missing_engine_protocol");
    expectProtocolError(() => negotiateProtocolStack("4.0"), "unsupported_engine_protocol");
    expectProtocolError(() => negotiateProtocolStack("5"), "unsupported_engine_protocol");
  });
});

describe("Engine.IO 4 packet and polling codec", () => {
  it("uses the locked packet type bytes", () => {
    const cases: Array<[EngineIoV4Packet, string]> = [
      [{ type: "open", data: "{}" }, "0{}"],
      [{ type: "close" }, "1"],
      [{ type: "ping" }, "2"],
      [{ type: "ping", data: "probe" }, "2probe"],
      [{ type: "pong", data: "probe" }, "3probe"],
      [{ type: "message", data: "0" }, "40"],
      [{ type: "upgrade" }, "5"],
      [{ type: "noop" }, "6"],
    ];

    for (const [packet, encoded] of cases) {
      expect(encodeEngineIoV4Packet(packet)).toBe(encoded);
      expect(decodeEngineIoV4Packet(encoded)).toEqual(packet);
    }
  });

  it("matches the official browser polling sequence in its actual directions", () => {
    const open = encodeEngineIoV4PollingPayload([
      createEngineIoV4HandshakePacket(HANDSHAKE),
    ]);
    expect(open).toBe(
      '0{"sid":"engine123","upgrades":["websocket"],"pingInterval":25000,' +
      '"pingTimeout":20000,"maxPayload":1000000}',
    );
    expect(decodeEngineIoV4Handshake(decodeEngineIoV4PollingPayload(open)[0] as EngineIoV4Packet))
      .toEqual(HANDSHAKE);

    const clientConnectPost = encodeEngineIoV4PollingPayload([
      wrapSocketIoV5Packet({ type: "connect", namespace: "/" }),
    ]);
    expect(clientConnectPost).toBe("40");
    expect(unwrapSocketIoV5Packet(decodeEngineIoV4PollingPayload(clientConnectPost)[0] as EngineIoV4Packet))
      .toEqual({ type: "connect", namespace: "/" });

    const serverConnectGet = encodeEngineIoV4PollingPayload([
      wrapSocketIoV5Packet(createSocketIoV5ServerConnectPacket("/", "socket123")),
    ]);
    expect(serverConnectGet).toBe('40{"sid":"socket123"}');
  });

  it("makes the EIO4 server-ping/client-pong direction explicit", () => {
    expect(ENGINE_IO_V4_HEARTBEAT).toMatchObject({
      pingSender: "server",
      pongSender: "client",
    });
    expect(encodeEngineIoV4PollingPayload([{ type: "ping" }])).toBe("2");
    expect(decodeEngineIoV4PollingPayload("3")).toEqual([{ type: "pong" }]);
  });

  it("requires the complete EIO4 open object including maxPayload", () => {
    expectProtocolError(
      () => decodeEngineIoV4Handshake({
        type: "open",
        data: '{"sid":"x","upgrades":[],"pingInterval":25000,"pingTimeout":20000}',
      }),
      "invalid_handshake",
    );
    expectProtocolError(
      () => decodeEngineIoV4Handshake({
        type: "open",
        data: '{"sid":"x","upgrades":[],"pingInterval":25000,"pingTimeout":20000,' +
          '"maxPayload":1000000,"extra":true}',
      }),
      "invalid_handshake",
    );
    expectProtocolError(
      () => decodeEngineIoV4Handshake({ type: "open", data: "{" }),
      "invalid_handshake",
    );
  });

  it("uses raw RS only between packets and round-trips Unicode", () => {
    expect(ENGINE_IO_V4_POLLING_SEPARATOR).toBe("\u001e");
    const packets: EngineIoV4Packet[] = [
      wrapSocketIoV5Packet({
        type: "event",
        namespace: "/",
        data: ["evt", "夜间🍚", "A\u001eB"],
      }),
      { type: "ping" },
      wrapSocketIoV5Packet({
        type: "ack",
        namespace: "/storage",
        id: 17,
        data: [{ ok: true }],
      }),
    ];
    const payload = encodeEngineIoV4PollingPayload(packets);
    expect(payload).toBe(
      '42["evt","夜间🍚","A\\u001eB"]\u001e2\u001e43/storage,17[{"ok":true}]',
    );
    expect(decodeEngineIoV4PollingPayload(payload)).toEqual(packets);
  });

  it("rejects malformed separators, binary frames, unknown frames and bounded overflow", () => {
    expectProtocolError(() => decodeEngineIoV4PollingPayload(""), "invalid_engine_payload");
    expectProtocolError(() => encodeEngineIoV4PollingPayload([]), "invalid_engine_payload");
    expectProtocolError(() => decodeEngineIoV4PollingPayload("2\u001e"), "empty_engine_packet");
    expectProtocolError(() => decodeEngineIoV4PollingPayload("2\u001e\u001e3"), "empty_engine_packet");
    expectProtocolError(() => decodeEngineIoV4Packet("7"), "unknown_engine_packet");
    expectProtocolError(() => decodeEngineIoV4Packet("bAAAA"), "unsupported_binary_packet");
    expectProtocolError(
      () => encodeEngineIoV4PollingPayload([{ type: "message", data: "A\u001eB" }]),
      "invalid_engine_packet",
    );
    expectProtocolError(
      () => decodeEngineIoV4PollingPayload("2\u001e3\u001e4", { maxPacketsPerPayload: 2 }),
      "too_many_engine_packets",
    );
    expectProtocolError(
      () => encodeEngineIoV4Packet({ type: "message", data: "🙂" }, { maxPacketBytes: 4 }),
      "engine_packet_too_large",
    );
  });
});

describe("Socket.IO protocol 5 codec", () => {
  it("matches connect/auth/sid, namespace, ack, error and disconnect bytes", () => {
    const cases: Array<[SocketIoV5Packet, string]> = [
      [{ type: "connect", namespace: "/" }, "0"],
      [{ type: "connect", namespace: "/", data: { token: "abc" } }, '0{"token":"abc"}'],
      [createSocketIoV5ServerConnectPacket("/", "socket123"), '0{"sid":"socket123"}'],
      [
        { type: "connect", namespace: "/admin", data: { token: "abc" } },
        '0/admin,{"token":"abc"}',
      ],
      [
        { type: "event", namespace: "/admin", id: 12, data: ["evt", "汉字"] },
        '2/admin,12["evt","汉字"]',
      ],
      [{ type: "ack", namespace: "/admin", id: 12, data: ["好"] }, '3/admin,12["好"]'],
      [
        { type: "error", namespace: "/admin", data: { message: "Invalid namespace" } },
        '4/admin,{"message":"Invalid namespace"}',
      ],
      [{ type: "disconnect", namespace: "/admin" }, "1/admin,"],
    ];

    for (const [packet, frame] of cases) {
      expect(encodeSocketIoV5Packet(packet)).toBe(frame);
      expect(decodeSocketIoV5Packet(frame)).toEqual(packet);
    }
  });

  it("matches native JSON.stringify normalization used by the locked parser", () => {
    const custom = {
      toJSON(): { kind: string; value: number } {
        return { kind: "custom", value: 7 };
      },
    };
    const packet: SocketIoV5Packet = {
      type: "event",
      namespace: "/",
      data: [
        "json",
        new Date("2026-07-18T00:00:00.000Z"),
        { nan: Number.NaN, inf: Number.POSITIVE_INFINITY, dropped: undefined, kept: 1 },
        [undefined, undefined],
        custom,
      ],
    };
    const frame = encodeSocketIoV5Packet(packet);
    expect(frame).toBe(
      '2["json","2026-07-18T00:00:00.000Z",{"nan":null,"inf":null,"kept":1},' +
      '[null,null],{"kind":"custom","value":7}]',
    );
    expect(decodeSocketIoV5Packet(frame)).toEqual({
      type: "event",
      namespace: "/",
      data: [
        "json",
        "2026-07-18T00:00:00.000Z",
        { nan: null, inf: null, kept: 1 },
        [null, null],
        { kind: "custom", value: 7 },
      ],
    });
  });

  it("rejects BigInt, cycles and binary rather than changing protocol families", () => {
    expectProtocolError(
      () => encodeSocketIoV5Packet({
        type: "event",
        namespace: "/",
        data: ["evt", 1n],
      }),
      "invalid_json_value",
    );

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expectProtocolError(
      () => encodeSocketIoV5Packet({ type: "event", namespace: "/", data: ["evt", circular] }),
      "invalid_json_value",
    );
    expectProtocolError(
      () => encodeSocketIoV5Packet({
        type: "event",
        namespace: "/",
        data: ["evt", new Uint8Array([1, 2, 3])],
      }),
      "unsupported_binary_packet",
    );

    const binaryWithToJson = Object.defineProperty(
      new Uint8Array([1, 2, 3]),
      "toJSON",
      { value: () => ({ type: "Buffer", data: [1, 2, 3] }) },
    );
    expectProtocolError(
      () => encodeSocketIoV5Packet({
        type: "event",
        namespace: "/",
        data: ["evt", binaryWithToJson],
      }),
      "unsupported_binary_packet",
    );

    const inheritedPrototype = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(inheritedPrototype, "binary", {
      enumerable: true,
      value: new Uint8Array([1, 2, 3]),
    });
    Object.defineProperty(inheritedPrototype, "danger", {
      enumerable: true,
      get: () => {
        throw new Error("inherited getters are not part of JSON.stringify");
      },
    });
    const inheritedValues = Object.create(inheritedPrototype) as Record<string, unknown>;
    inheritedValues.kept = 1;
    expect(encodeSocketIoV5Packet({
      type: "event",
      namespace: "/",
      data: ["evt", inheritedValues],
    })).toBe('2["evt",{"kept":1}]');

    const rawJsonFactory = Reflect.get(JSON, "rawJSON");
    if (typeof rawJsonFactory === "function") {
      const rawJson = Reflect.apply(rawJsonFactory, JSON, ["true"]);
      expectProtocolError(
        () => encodeSocketIoV5Packet({
          type: "event",
          namespace: "/",
          data: ["evt", rawJson],
        }),
        "invalid_json_value",
      );
    }
  });

  it("rejects locked-parser invalid shapes and enforces JSON budgets", () => {
    expect(decodeSocketIoV5Packet("0")).toEqual({ type: "connect", namespace: "/" });
    expectProtocolError(() => decodeSocketIoV5Packet("0null"), "invalid_socket_payload");
    expectProtocolError(() => decodeSocketIoV5Packet("0[]"), "invalid_socket_payload");
    expectProtocolError(() => decodeSocketIoV5Packet('2["connect"]'), "invalid_event_name");
    expectProtocolError(() => decodeSocketIoV5Packet("2[]"), "invalid_socket_payload");
    expectProtocolError(() => decodeSocketIoV5Packet("2{}"), "invalid_socket_payload");
    expectProtocolError(() => decodeSocketIoV5Packet("1[]"), "invalid_socket_payload");
    expectProtocolError(() => decodeSocketIoV5Packet("4[]"), "invalid_socket_payload");
    expectProtocolError(() => decodeSocketIoV5Packet('2["evt",'), "invalid_socket_payload");
    expectProtocolError(
      () => encodeSocketIoV5Packet(
        { type: "event", namespace: "/", data: ["evt", "12345"] },
        { maxJsonStringCharacters: 4 },
      ),
      "json_string_too_large",
    );
    expectProtocolError(
      () => encodeSocketIoV5Packet(
        { type: "event", namespace: "/", data: ["evt", new String("12345")] },
        { maxJsonStringCharacters: 4 },
      ),
      "json_string_too_large",
    );
    expectProtocolError(
      () => encodeSocketIoV5Packet(
        { type: "event", namespace: "/", data: ["x"] },
        { maxPacketCharacters: 4 },
      ),
      "socket_packet_too_large",
    );
    expectProtocolError(
      () => decodeSocketIoV5Packet('2["x"]', { maxPacketCharacters: 4 }),
      "socket_packet_too_large",
    );
    expectProtocolError(
      () => decodeSocketIoV5Packet('2["evt",[[[]]]]', { maxJsonDepth: 2 }),
      "json_too_deep",
    );
  });
});

describe("versioned protocol dispatch", () => {
  it("dispatches polling and Socket.IO codecs from one negotiated stack", () => {
    expect(encodeEngineIoPollingPayloadForStack(
      LEGACY_EIO3_SIO4_STACK,
      [{ type: "ping" }],
    )).toBe("1:2");
    expect(encodeEngineIoPollingPayloadForStack(
      OFFICIAL_EIO4_SIO5_STACK,
      [{ type: "ping" }],
    )).toBe("2");
    expect(encodeSocketIoPacketForStack(
      LEGACY_EIO3_SIO4_STACK,
      { type: "connect", namespace: "/" },
    )).toBe("0");
    expect(encodeSocketIoPacketForStack(
      OFFICIAL_EIO4_SIO5_STACK,
      createSocketIoV5ServerConnectPacket("/", "socket123"),
    )).toBe('0{"sid":"socket123"}');
    expect(decodeSocketIoPacketForStack(
      OFFICIAL_EIO4_SIO5_STACK,
      '0{"sid":"socket123"}',
    )).toEqual(createSocketIoV5ServerConnectPacket("/", "socket123"));
  });
});
