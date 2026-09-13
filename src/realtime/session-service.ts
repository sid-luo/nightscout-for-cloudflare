import {
  ProtocolError,
  createEngineIoV3HandshakePacket,
  createEngineIoV4HandshakePacket,
  createSocketIoV5ServerConnectPacket,
  decodeEngineIoV3Packet,
  decodeEngineIoV3PollingPayload,
  decodeEngineIoV4Packet,
  decodeEngineIoV4PollingPayload,
  encodeEngineIoV3Packet,
  encodeEngineIoV3PollingPayload,
  encodeEngineIoV4Packet,
  encodeEngineIoV4PollingPayload,
  unwrapSocketIoV4Packet,
  wrapSocketIoV5Packet,
  wrapSocketIoV4Packet,
  unwrapSocketIoV5Packet,
  type EngineIoV4Packet,
  type SocketIoV4Packet,
  type SocketIoV5EventPacket,
  type SocketIoV5Packet,
} from "../protocol";
import type {
  Api3CollectionName,
  Api3RealtimeMutationEvent,
} from "../document-repository";
import {
  NightscoutNotificationEngine,
  type NotificationProcessResult,
} from "../notifications";
import {
  calculateRealtimeDelta,
  type RealtimeDeltaDocument,
  type RealtimeDeltaState,
} from "./calcdelta";
import {
  REALTIME_CLEANUP_BATCH,
  REALTIME_MAX_ALARM_GROUP_CHARACTERS,
  REALTIME_MAX_PAYLOAD_BYTES,
  REALTIME_PING_INTERVAL_MS,
  REALTIME_PING_TIMEOUT_MS,
  REALTIME_POLL_DURABLE_TOUCH_MS,
  REALTIME_POST_LEASE_MS,
  REALTIME_TRANSPORT,
  REALTIME_WEBSOCKET_TRANSPORT,
  REALTIME_WEBSOCKET_UPGRADE_TIMEOUT_MS,
  type RealtimeEngineProtocol,
  type RealtimeTransport,
} from "./constants";
import {
  createRealtimeSocketId,
  RealtimeRepositoryError,
  SqliteRealtimeSessionRepository,
  type RealtimeSession,
  type RealtimeWebSocketFrameBatch,
  type RealtimeWebSocketClosure,
  type RealtimeWebSocketClosureRetry,
} from "./session-repository";
import { isDurableObjectWriteQuotaError } from "../platform-errors";

export interface RealtimeAuthorization {
  read: boolean;
  write: boolean;
  write_treatment: boolean;
}

export interface RealtimePollingEnvelope {
  payload: string;
  jsonpIndex: string | null;
}

export interface RealtimePostLease {
  token: string;
  jsonpIndex: string | null;
}

export type RealtimeRootWriteCollection =
  | "activity"
  | "devicestatus"
  | "entries"
  | "food"
  | "profile"
  | "treatments";

export type RealtimeRootWriteRequest =
  | {
      event: "dbAdd";
      collection: RealtimeRootWriteCollection;
      data: unknown;
      receivedAt: number;
    }
  | {
      event: "dbUpdate" | "dbUpdateUnset";
      collection: RealtimeRootWriteCollection;
      id: string;
      data: unknown;
      receivedAt: number;
    }
  | {
      event: "dbRemove";
      collection: RealtimeRootWriteCollection;
      id: string;
      receivedAt: number;
    };

export interface RealtimeRootWriteResult {
  acknowledgement: unknown;
  changed: boolean;
}

export interface RealtimeNotificationProcessResult extends NotificationProcessResult {
  delivered: number;
}

export type RealtimeAlarmAuthorization =
  | { mode: "accessToken" }
  | { mode: "web"; read: boolean; ack: boolean };

export interface RealtimeSnapshot {
  devicestatus: unknown[];
  sgvs: unknown[];
  cals: unknown[];
  profiles: unknown[];
  mbgs: unknown[];
  food: unknown[];
  treatments: unknown[];
  dbstats: Record<string, unknown>;
  status?: Record<string, unknown>;
}

export interface RealtimeServiceOptions {
  now?: () => number;
  pollWaitMs?: number;
  authorize?: (message: Record<string, unknown>) =>
    | RealtimeAuthorization
    | null
    | Promise<RealtimeAuthorization | null>;
  authorizeStorage?: (message: Record<string, unknown>) =>
    | readonly Api3CollectionName[]
    | null
    | Promise<readonly Api3CollectionName[] | null>;
  authorizeAlarm?: (message: Record<string, unknown>) =>
    | RealtimeAlarmAuthorization
    | null
    | Promise<RealtimeAlarmAuthorization | null>;
  writeRoot?: (request: RealtimeRootWriteRequest) =>
    | RealtimeRootWriteResult
    | Promise<RealtimeRootWriteResult>;
  snapshot?: (now: number) => RealtimeSnapshot | null;
  retroDeviceStatus?: (now: number) => unknown[] | null;
  status?: (now: number) => Record<string, unknown>;
  activeProfile?: (now: number) => string | null;
}

export class RealtimeSessionError extends Error {
  constructor(
    readonly code:
      | "unknown_sid"
      | "overlap"
      | "bad_packet"
      | "capacity"
      | "storage_quota"
      | "queue_overflow"
      | "invalid_post_lease",
    message: string,
  ) {
    super(message);
    this.name = "RealtimeSessionError";
  }
}

interface PollWaiter {
  token: string;
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PollingHeartbeatState {
  lastSeenAt: number;
  nextPingAt: number;
  pongDeadline: number | null;
  expiresAt: number;
  durableTouchedAt: number;
}

interface RealtimeAlarmAcknowledgement {
  level: number;
  group: string;
  silenceTime: number;
}

interface RealtimeRootMutationState {
  changed: boolean;
}

function cloneSession(session: RealtimeSession): RealtimeSession {
  return { ...session };
}

function defaultSnapshot(_now: number): RealtimeSnapshot {
  return {
    devicestatus: [],
    sgvs: [],
    cals: [],
    profiles: [],
    mbgs: [],
    food: [],
    treatments: [],
    dbstats: {},
  };
}

function defaultAuthorization(message: Record<string, unknown>): RealtimeAuthorization | null {
  const credential = message.secret ?? message.token;
  // Nightscout's locked default role is readable. Explicit credentials must
  // be resolved by the tenant authorization adapter; they are never silently
  // treated as anonymous or valid.
  return credential === undefined || credential === null || credential === ""
    ? { read: true, write: false, write_treatment: false }
    : null;
}

function defaultStorageAuthorization(
  _message: Record<string, unknown>,
): readonly Api3CollectionName[] | null {
  return null;
}

function defaultAlarmAuthorization(
  message: Record<string, unknown>,
): RealtimeAlarmAuthorization | null {
  if (message.accessToken) return null;
  const credential = message.secret ?? message.jwtToken;
  return credential === undefined || credential === null || credential === ""
    ? { mode: "web", read: true, ack: false }
    : null;
}

function defaultRootWrite(request: RealtimeRootWriteRequest): RealtimeRootWriteResult {
  return {
    acknowledgement: request.event === "dbAdd" ? [] : { result: "success" },
    changed: false,
  };
}

const REALTIME_ROOT_WRITE_COLLECTIONS: readonly RealtimeRootWriteCollection[] = [
  "treatments",
  "entries",
  "devicestatus",
  "profile",
  "food",
  "activity",
];

function realtimeRootWriteCollection(value: unknown): RealtimeRootWriteCollection | null {
  return typeof value === "string"
      && REALTIME_ROOT_WRITE_COLLECTIONS.includes(value as RealtimeRootWriteCollection)
    ? value as RealtimeRootWriteCollection
    : null;
}

function realtimeRootWriteId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
  return value;
}

function alarmLevelDisplay(level: number): string {
  switch (level) {
    case 2: return "Urgent";
    case 1: return "Warning";
    case 0: return "Info";
    case -1: return "Low";
    case -2: return "Lowest";
    case -3: return "None";
    default: return "Unknown";
  }
}

function alarmEventName(notification: Record<string, unknown>): string {
  if (notification.clear) return "clear_alarm";
  if (notification.level === 1) return "alarm";
  if (notification.level === 2) return "urgent_alarm";
  if (notification.isAnnouncement) return "announcement";
  return "notification";
}

function normalizeAlarmAcknowledgement(
  level: number,
  group: string,
  rawSilenceTime: number,
): RealtimeAlarmAcknowledgement | null {
  if (
    !Number.isSafeInteger(level)
    || level < -3
    || level > 2
    || typeof group !== "string"
    || group.length === 0
    || group.length > REALTIME_MAX_ALARM_GROUP_CHARACTERS
  ) {
    return null;
  }
  let silenceTime = 30 * 60 * 1_000;
  // Locked notifications.ack() uses the default for every falsy value,
  // including 0 and NaN. A truthy value must fit SQLite's integer contract.
  if (rawSilenceTime) {
    if (!Number.isSafeInteger(rawSilenceTime)) return null;
    silenceTime = rawSilenceTime;
  }
  return { level, group, silenceTime };
}

function randomLeaseToken(): string {
  return crypto.randomUUID();
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RealtimeSessionError("bad_packet", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function socketIoV5FromV4(packet: SocketIoV4Packet): SocketIoV5Packet {
  if (packet.type !== "connect" || !packet.namespace.includes("?")) {
    return packet as SocketIoV5Packet;
  }
  const queryAt = packet.namespace.indexOf("?");
  const namespace = packet.namespace.slice(0, queryAt);
  const params = new URLSearchParams(packet.namespace.slice(queryAt + 1));
  const data: Record<string, string | string[]> = {};
  for (const [key, value] of params) {
    const prior = data[key];
    data[key] = prior === undefined
      ? value
      : Array.isArray(prior)
        ? [...prior, value]
        : [prior, value];
  }
  return Object.keys(data).length === 0
    ? { type: "connect", namespace }
    : { type: "connect", namespace, data } as SocketIoV5Packet;
}

function engineFrameForSession(
  session: RealtimeSession,
  packet: EngineIoV4Packet,
): string {
  if (session.engineProtocol === 4) return encodeEngineIoV4Packet(packet);
  if (packet.type !== "message") return encodeEngineIoV3Packet(packet);
  const socketPacket = unwrapSocketIoV5Packet(packet);
  const legacyPacket = socketPacket.type === "connect"
    ? { type: "connect", namespace: socketPacket.namespace } as SocketIoV4Packet
    : socketPacket as SocketIoV4Packet;
  return encodeEngineIoV3Packet(wrapSocketIoV4Packet(legacyPacket));
}

function engineFrames(
  session: RealtimeSession,
  packets: readonly EngineIoV4Packet[],
): string[] {
  return packets.map((packet) => engineFrameForSession(session, packet));
}

function pollingPayloadForSession(
  session: RealtimeSession,
  packets: readonly EngineIoV4Packet[],
): string {
  return session.engineProtocol === 3
    ? encodeEngineIoV3PollingPayload(
      packets.map((packet) => decodeEngineIoV3Packet(engineFrameForSession(session, packet))),
    )
    : encodeEngineIoV4PollingPayload(packets);
}

function socketPacketForSession(
  session: RealtimeSession,
  packet: EngineIoV4Packet,
): SocketIoV5Packet {
  return session.engineProtocol === 3
    ? socketIoV5FromV4(unwrapSocketIoV4Packet(packet))
    : unwrapSocketIoV5Packet(packet);
}

function deltaDocuments(values: unknown[]): RealtimeDeltaDocument[] {
  return values.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("realtime snapshot arrays must contain objects");
    }
    return value as RealtimeDeltaDocument;
  });
}

function deltaState(
  snapshot: RealtimeSnapshot,
  now: number,
  activeProfile: string | null,
): RealtimeDeltaState {
  return {
    sgvs: deltaDocuments(snapshot.sgvs),
    treatments: deltaDocuments(snapshot.treatments),
    mbgs: deltaDocuments(snapshot.mbgs),
    cals: deltaDocuments(snapshot.cals),
    profiles: snapshot.profiles,
    devicestatus: deltaDocuments(snapshot.devicestatus),
    food: deltaDocuments(snapshot.food),
    activity: [],
    dbstats: snapshot.dbstats,
    lastUpdated: now,
    activeProfile,
  };
}

export class RealtimeSessionService {
  private readonly repository: SqliteRealtimeSessionRepository;
  private readonly now: () => number;
  private readonly pollWaitMs: number;
  private readonly authorize: NonNullable<RealtimeServiceOptions["authorize"]>;
  private readonly authorizeStorage: NonNullable<RealtimeServiceOptions["authorizeStorage"]>;
  private readonly authorizeAlarm: NonNullable<RealtimeServiceOptions["authorizeAlarm"]>;
  private readonly writeRoot: NonNullable<RealtimeServiceOptions["writeRoot"]>;
  private readonly snapshot: NonNullable<RealtimeServiceOptions["snapshot"]>;
  private readonly retroDeviceStatus: NonNullable<RealtimeServiceOptions["retroDeviceStatus"]>;
  private readonly status: RealtimeServiceOptions["status"];
  private readonly activeProfile: NonNullable<RealtimeServiceOptions["activeProfile"]>;
  private readonly waiters = new Map<string, PollWaiter>();
  private readonly pollingHeartbeats = new Map<string, PollingHeartbeatState>();
  private readonly pendingApplicationWakeSids = new Set<string>();

  constructor(
    private readonly storage: DurableObjectStorage,
    options: RealtimeServiceOptions = {},
  ) {
    this.repository = new SqliteRealtimeSessionRepository(storage);
    this.now = options.now ?? Date.now;
    this.pollWaitMs = options.pollWaitMs ?? REALTIME_PING_INTERVAL_MS;
    this.authorize = options.authorize ?? defaultAuthorization;
    this.authorizeStorage = options.authorizeStorage ?? defaultStorageAuthorization;
    this.authorizeAlarm = options.authorizeAlarm ?? defaultAlarmAuthorization;
    this.writeRoot = options.writeRoot ?? defaultRootWrite;
    this.snapshot = options.snapshot ?? defaultSnapshot;
    this.retroDeviceStatus = options.retroDeviceStatus ?? ((now) =>
      this.snapshot(now)?.devicestatus ?? null
    );
    this.status = options.status;
    this.activeProfile = options.activeProfile ?? (() => null);
  }

  createHandshake(
    engineProtocol: RealtimeEngineProtocol = 4,
    jsonpIndex: string | null = null,
  ): { sid: string; payload: string } {
    const now = this.now();
    this.cleanup(now);
    let session: RealtimeSession;
    try {
      session = this.repository.createSession(
        now,
        REALTIME_TRANSPORT,
        engineProtocol,
        jsonpIndex,
      );
    } catch (error) {
      throw this.translateRepositoryError(error);
    }
    this.rememberPollingHeartbeat(session);
    if (engineProtocol === 3) {
      // Socket.IO 2.x automatically connects the root namespace as soon as
      // Engine.IO 3 opens; unlike SIO5, the client does not send a root CONNECT.
      const wakeTargets = this.storage.transactionSync(() => {
        session.socketSid = session.sid;
        session.socketConnected = true;
        this.repository.updateSession(session);
        this.repository.enqueueFrames(
          session.sid,
          engineFrames(session, [wrapSocketIoV5Packet({
            type: "connect",
            namespace: "/",
          })]),
          now,
        );
        return this.enqueueClientsForConnectedSessions(now);
      });
      for (const targetSid of wakeTargets) {
        if (targetSid !== session.sid) this.wake(targetSid);
      }
      return {
        sid: session.sid,
        payload: encodeEngineIoV3PollingPayload([
          createEngineIoV3HandshakePacket({
            sid: session.sid,
            upgrades: [REALTIME_WEBSOCKET_TRANSPORT],
            pingInterval: REALTIME_PING_INTERVAL_MS,
            pingTimeout: REALTIME_PING_TIMEOUT_MS,
            maxPayload: REALTIME_MAX_PAYLOAD_BYTES,
          }),
        ]),
      };
    }
    const payload = encodeEngineIoV4PollingPayload([
      createEngineIoV4HandshakePacket({
        sid: session.sid,
        // Locked Nightscout enables polling and WebSocket, so a normal EIO4
        // client probes and upgrades after this initial polling handshake.
        upgrades: [REALTIME_WEBSOCKET_TRANSPORT],
        pingInterval: REALTIME_PING_INTERVAL_MS,
        pingTimeout: REALTIME_PING_TIMEOUT_MS,
        maxPayload: REALTIME_MAX_PAYLOAD_BYTES,
      }),
    ]);
    return { sid: session.sid, payload };
  }

  createWebSocketHandshake(
    engineProtocol: RealtimeEngineProtocol = 4,
  ): { sid: string; frame: string } {
    const now = this.now();
    this.cleanup(now);
    let session: RealtimeSession;
    try {
      session = this.repository.createSession(
        now,
        REALTIME_WEBSOCKET_TRANSPORT,
        engineProtocol,
      );
    } catch (error) {
      throw this.translateRepositoryError(error);
    }
    if (engineProtocol === 3) {
      // Socket.IO 2.x automatically connects root after the Engine.IO open.
      // Queue it separately so the WebSocket sends the open frame first,
      // matching the locked Socket.IO 4.5.4 allowEIO3 server.
      const wakeTargets = this.storage.transactionSync(() => {
        session.socketSid = session.sid;
        session.socketConnected = true;
        this.repository.updateSession(session);
        this.repository.enqueueFrames(
          session.sid,
          engineFrames(session, [wrapSocketIoV5Packet({
            type: "connect",
            namespace: "/",
          })]),
          now,
        );
        return this.enqueueClientsForConnectedSessions(now);
      });
      for (const targetSid of wakeTargets) {
        if (targetSid !== session.sid) this.wake(targetSid);
      }
      return {
        sid: session.sid,
        frame: encodeEngineIoV3Packet(createEngineIoV3HandshakePacket({
          sid: session.sid,
          upgrades: [],
          pingInterval: REALTIME_PING_INTERVAL_MS,
          pingTimeout: REALTIME_PING_TIMEOUT_MS,
          maxPayload: REALTIME_MAX_PAYLOAD_BYTES,
        })),
      };
    }
    return {
      sid: session.sid,
      frame: encodeEngineIoV4Packet(createEngineIoV4HandshakePacket({
        sid: session.sid,
        // A direct WebSocket is already at Engine.IO's terminal transport.
        upgrades: [],
        pingInterval: REALTIME_PING_INTERVAL_MS,
        pingTimeout: REALTIME_PING_TIMEOUT_MS,
        maxPayload: REALTIME_MAX_PAYLOAD_BYTES,
      })),
    };
  }

  beginWebSocketUpgrade(
    sid: string,
    engineProtocol: RealtimeEngineProtocol = 4,
  ): number {
    const now = this.now();
    this.cleanup(now);
    const deadline = now + REALTIME_WEBSOCKET_UPGRADE_TIMEOUT_MS;
    this.storage.transactionSync(() => {
      this.requireLiveSession(sid, now, REALTIME_TRANSPORT, engineProtocol);
      this.repository.scheduleWebSocketClosure(
        sid,
        1008,
        "upgrade timeout",
        now,
        deadline,
      );
    });
    return deadline;
  }

  probeWebSocketUpgrade(sid: string): void {
    const now = this.now();
    this.cleanup(now);
    this.storage.transactionSync(() => {
      this.requireLiveSession(sid, now, REALTIME_TRANSPORT);
    });
    // engine.io 6.2.1 forces one polling cycle to finish after the probe. A
    // waiter with no queued application packet returns the ordinary noop.
    this.wake(sid);
  }

  completeWebSocketUpgrade(sid: string): void {
    const now = this.now();
    this.cleanup(now);
    this.storage.transactionSync(() => {
      const session = this.requireLiveSession(sid, now, REALTIME_TRANSPORT);
      // The official client pauses polling and waits for its outstanding GET
      // and POST before sending Engine.IO `upgrade`. Refuse a transport race
      // instead of allowing both transports to own one durable SID.
      if (
        this.waiters.has(sid)
        || (
          session.postToken !== null
          && session.postDeadline !== null
          && session.postDeadline > now
        )
      ) {
        throw new RealtimeSessionError(
          "overlap",
          "polling transport has not paused before websocket upgrade",
        );
      }
      session.transport = REALTIME_WEBSOCKET_TRANSPORT;
      session.pollToken = null;
      session.pollDeadline = null;
      session.postToken = null;
      session.postDeadline = null;
      this.refreshInboundLiveness(session, now);
      this.repository.updateSession(session);
      this.repository.cancelWebSocketClosure(sid);
    });
    this.pollingHeartbeats.delete(sid);
  }

  abortWebSocketUpgrade(sid: string): void {
    this.storage.transactionSync(() => {
      const session = this.repository.getSession(sid);
      if (session === null || session.transport === REALTIME_TRANSPORT) {
        this.repository.cancelWebSocketClosure(sid);
      }
    });
  }

  validateSession(sid: string, engineProtocol: RealtimeEngineProtocol = 4): void {
    const now = this.now();
    this.cleanup(now);
    this.storage.transactionSync(() => {
      this.requireLiveSession(sid, now, REALTIME_TRANSPORT, engineProtocol);
    });
  }

  beginPost(sid: string, engineProtocol: RealtimeEngineProtocol = 4): string {
    const now = this.now();
    this.cleanup(now);
    const token = randomLeaseToken();
    const result = this.storage.transactionSync(() => {
      const session = this.requireLiveSession(
        sid,
        now,
        REALTIME_TRANSPORT,
        engineProtocol,
      );
      if (
        session.postToken !== null
        && session.postDeadline !== null
        && session.postDeadline > now
      ) {
        const wasConnected = session.socketConnected;
        this.repository.deleteSessionInTransaction(sid);
        return {
          overlap: true,
          wakeTargets: wasConnected ? this.enqueueClientsForConnectedSessions(now) : [],
        };
      }
      session.postToken = token;
      session.postDeadline = now + REALTIME_POST_LEASE_MS;
      this.repository.setPostLease(sid, token, session.postDeadline);
      return { overlap: false, wakeTargets: [] };
    });
    if (result.overlap) {
      this.dropPollingRuntime(sid);
      this.wake(sid);
      for (const targetSid of result.wakeTargets) this.wake(targetSid);
      throw new RealtimeSessionError("overlap", "concurrent polling POST closed the session");
    }
    return token;
  }

  beginPostEnvelope(
    sid: string,
    engineProtocol: RealtimeEngineProtocol = 4,
  ): RealtimePostLease {
    const token = this.beginPost(sid, engineProtocol);
    return {
      token,
      jsonpIndex: this.repository.jsonpIndex(sid),
    };
  }

  abortPost(sid: string, token: string): void {
    const now = this.now();
    this.storage.transactionSync(() => {
      const session = this.repository.getSession(sid);
      if (session?.postToken !== token) return;
      this.applyPollingHeartbeat(session, now);
      session.postToken = null;
      session.postDeadline = null;
      if (!this.touchPollingSessionIfDue(session, now)) {
        this.repository.clearPostLease(sid, token);
      }
    });
  }

  rejectPost(sid: string, token: string): void {
    const now = this.now();
    this.cleanup(now);
    const result = this.storage.transactionSync((): {
      error: RealtimeSessionError | null;
      wakeTargets: string[];
    } => {
      const session = this.repository.getSession(sid);
      if (session === null) {
        return {
          error: new RealtimeSessionError("unknown_sid", "session ID is unknown"),
          wakeTargets: [],
        };
      }
      const leaseIsValid =
        session.postToken === token
        && session.postDeadline !== null
        && session.postDeadline > now;
      const wasConnected = session.socketConnected;
      this.repository.deleteSessionInTransaction(sid);
      return {
        error: leaseIsValid
          ? null
          : new RealtimeSessionError(
              "invalid_post_lease",
              "polling POST lease is invalid",
            ),
        wakeTargets: wasConnected ? this.enqueueClientsForConnectedSessions(now) : [],
      };
    });
    this.dropPollingRuntime(sid);
    this.wake(sid);
    for (const targetSid of result.wakeTargets) this.wake(targetSid);
    if (result.error !== null) throw result.error;
  }

  async submitPost(
    sid: string,
    token: string,
    payload: string,
    engineProtocol: RealtimeEngineProtocol = 4,
  ): Promise<void> {
    const startedAt = this.now();
    const initial = this.storage.transactionSync(() =>
      this.requireLiveSession(sid, startedAt, REALTIME_TRANSPORT, engineProtocol)
    );
    if (
      initial.postToken !== token
      || initial.postDeadline === null
      || initial.postDeadline <= startedAt
    ) {
      this.closeForBadPacket(sid);
      throw new RealtimeSessionError("invalid_post_lease", "polling POST lease is invalid");
    }

    let packets: EngineIoV4Packet[];
    try {
      packets = initial.engineProtocol === 3
        ? decodeEngineIoV3PollingPayload(payload)
        : decodeEngineIoV4PollingPayload(payload);
    } catch (error) {
      this.closeForBadPacket(sid);
      throw this.badPacket(error);
    }

    const session = cloneSession(initial);
    const outbound: EngineIoV4Packet[] = [];
    const broadcasts: EngineIoV4Packet[] = [];
    const alarmAcknowledgements: RealtimeAlarmAcknowledgement[] = [];
    const rootMutation: RealtimeRootMutationState = { changed: false };
    let applicationPacketProcessed = false;
    let closed = false;
    try {
      for (const packet of packets) {
        if (packet.type === "close") {
          closed = true;
          break;
        }
        if (packet.type === "pong" && session.engineProtocol === 4) {
          this.acceptPong(session, packet);
          this.rememberPollingHeartbeat(session);
          continue;
        }
        if (packet.type === "ping" && session.engineProtocol === 3) {
          this.refreshInboundLiveness(session, this.now());
          this.rememberPollingHeartbeat(session);
          // engine.io 6.2.1 answers the EIO3 client heartbeat without echoing
          // optional ping data on the ordinary transport path.
          outbound.push({ type: "pong" });
          continue;
        }
        if (packet.type !== "message") {
          throw new RealtimeSessionError(
            "bad_packet",
            `client packet type ${packet.type} is invalid for EIO${session.engineProtocol} polling`,
          );
        }
        applicationPacketProcessed = true;
        this.refreshInboundLiveness(session, this.now());
        this.rememberPollingHeartbeat(session);
        const socketPacket = socketPacketForSession(session, packet);
        await this.processSocketPacket(
          session,
          socketPacket,
          outbound,
          broadcasts,
          alarmAcknowledgements,
          rootMutation,
        );
      }
    } catch (error) {
      this.closeForBadPacket(sid);
      throw this.badPacket(error);
    }

    if (closed) {
      this.closeSession(sid);
      return;
    }

    // The ordinary EIO4 pong is pure transport liveness. Keeping it in the
    // live Durable Object avoids the old FIFO/alarm write amplification. The
    // POST lease itself remains durable because request-body streaming happens
    // between two Durable Object RPCs and the object may be evicted between them.
    if (!applicationPacketProcessed && outbound.length === 0) {
      const now = this.now();
      const result = this.storage.transactionSync(() => {
        // No application packet means the loop above never awaited a handler.
        // This is still the same synchronous turn as requireLiveSession(); no
        // other RPC can replace the durable POST lease between these reads.
        // Keep the persisted lease and its deadline checks, but reuse that
        // fresh row instead of selecting the identical session again.
        const current = initial;
        this.applyPollingHeartbeat(current, now);
        if (
          current.expiresAt <= now
          || (current.pongDeadline !== null && current.pongDeadline <= now)
        ) {
          return new RealtimeSessionError(
            "unknown_sid",
            "session ID is unknown or expired",
          );
        }
        if (
          current.postToken !== token
          || current.postDeadline === null
          || current.postDeadline <= now
        ) {
          return new RealtimeSessionError(
            "invalid_post_lease",
            "polling POST lease changed or expired",
          );
        }
        current.postToken = null;
        current.postDeadline = null;
        if (!this.touchPollingSessionIfDue(current, now)) {
          this.repository.clearPostLease(sid, token);
        }
        return null;
      });
      if (result !== null) {
        this.closeForBadPacket(sid);
        throw result;
      }
      return;
    }

    const now = this.now();
    session.postToken = null;
    session.postDeadline = null;
    const commit = this.commitProcessedSession(
      sid,
      session,
      outbound,
      broadcasts,
      alarmAcknowledgements,
      now,
      (current) => {
        if (
          current.transport !== REALTIME_TRANSPORT
          || current.engineProtocol !== engineProtocol
        ) {
          return new RealtimeSessionError("unknown_sid", "session ID is unknown");
        }
        return (
          current.postToken !== token
          || current.postDeadline === null
          || current.postDeadline <= now
        )
          ? new RealtimeSessionError(
              "invalid_post_lease",
              "polling POST lease changed or expired",
            )
          : null;
      },
    );
    if (commit.error !== null) {
      this.wake(sid);
      throw commit.error;
    }
    if (rootMutation.changed) {
      this.storage.transactionSync(() => this.recordRootDataUpdateInTransaction());
      this.flushApplicationWakes();
    }
    for (const targetSid of commit.wakeTargets) this.wake(targetSid);
    if (outbound.length > 0) this.wake(sid);
  }

  async submitWebSocketFrame(sid: string, frame: string): Promise<{ closed: boolean }> {
    const initial = this.repository.getSession(sid);
    if (initial === null || initial.transport !== REALTIME_WEBSOCKET_TRANSPORT) {
      throw new RealtimeSessionError("unknown_sid", "session ID is unknown");
    }

    let packet: EngineIoV4Packet;
    try {
      packet = initial.engineProtocol === 3
        ? decodeEngineIoV3Packet(frame)
        : decodeEngineIoV4Packet(frame);
    } catch (error) {
      this.closeForBadPacket(sid);
      throw this.badPacket(error);
    }

    if (packet.type === "close") {
      this.closeSession(sid);
      return { closed: true };
    }

    const session = cloneSession(initial);
    const outbound: EngineIoV4Packet[] = [];
    const broadcasts: EngineIoV4Packet[] = [];
    const alarmAcknowledgements: RealtimeAlarmAcknowledgement[] = [];
    const rootMutation: RealtimeRootMutationState = { changed: false };
    try {
      if (packet.type === "pong" && session.engineProtocol === 4) {
        this.acceptPong(session, packet);
      } else if (packet.type === "ping" && session.engineProtocol === 3) {
        this.refreshInboundLiveness(session, this.now());
        // The locked allowEIO3 server replies with a data-less pong even when
        // the client ping carries optional data.
        outbound.push({ type: "pong" });
      } else if (packet.type === "message") {
        this.refreshInboundLiveness(session, this.now());
        await this.processSocketPacket(
          session,
          socketPacketForSession(session, packet),
          outbound,
          broadcasts,
          alarmAcknowledgements,
          rootMutation,
        );
      } else {
        throw new RealtimeSessionError(
          "bad_packet",
          `client packet type ${packet.type} is invalid for EIO${session.engineProtocol} websocket`,
        );
      }
    } catch (error) {
      this.closeForBadPacket(sid);
      throw this.badPacket(error);
    }

    const now = this.now();
    const commit = this.commitProcessedSession(
      sid,
      session,
      outbound,
      broadcasts,
      alarmAcknowledgements,
      now,
      (current) =>
        current.transport === REALTIME_WEBSOCKET_TRANSPORT
          && current.engineProtocol === initial.engineProtocol
          ? null
          : new RealtimeSessionError("unknown_sid", "session ID is unknown"),
    );
    if (commit.error !== null) throw commit.error;
    if (rootMutation.changed) {
      this.storage.transactionSync(() => this.recordRootDataUpdateInTransaction());
      this.flushApplicationWakes();
    }
    for (const targetSid of commit.wakeTargets) this.wake(targetSid);
    return { closed: false };
  }

  validateWebSocketSession(sid: string): void {
    const now = this.now();
    this.cleanup(now);
    this.storage.transactionSync(() => {
      this.requireLiveSession(sid, now, REALTIME_WEBSOCKET_TRANSPORT);
    });
  }

  sessionEngineProtocol(sid: string): RealtimeEngineProtocol | null {
    return this.repository.getSession(sid)?.engineProtocol ?? null;
  }

  webSocketSessionEngineProtocol(sid: string): RealtimeEngineProtocol | null {
    const session = this.repository.getSession(sid);
    return session?.transport === REALTIME_WEBSOCKET_TRANSPORT
      ? session.engineProtocol
      : null;
  }

  reconcileWebSocketSessions(liveSids: ReadonlySet<string>): string[] {
    const now = this.now();
    const result = this.storage.transactionSync(() => {
      const orphanedSids = this.repository
        .listWebSocketSessionIds()
        .filter((sid) => !liveSids.has(sid));
      let removedConnectedSession = false;
      for (const sid of orphanedSids) {
        const session = this.repository.getSession(sid);
        if (session === null) continue;
        removedConnectedSession ||= session.socketConnected;
        // Reconciliation has already established that no valid physical
        // hibernatable socket owns this row, so no close tombstone is needed.
        this.repository.deleteOrphanedWebSocketSessionInTransaction(sid);
      }
      return {
        orphanedSids,
        wakeTargets: removedConnectedSession
          ? this.enqueueClientsForConnectedSessions(now)
          : [],
      };
    });
    for (const sid of result.orphanedSids) this.wake(sid);
    for (const sid of result.wakeTargets) this.wake(sid);
    return result.orphanedSids;
  }

  queuedWebSocketSessionIds(limit: number): string[] {
    return this.repository.listQueuedWebSocketSessionIds(limit);
  }

  takeWebSocketClosures(limit: number, now: number): RealtimeWebSocketClosure[] {
    return this.storage.transactionSync(() =>
      this.repository.takeWebSocketClosures(limit, now)
    );
  }

  requeueWebSocketClosure(
    closure: RealtimeWebSocketClosure,
    retry: RealtimeWebSocketClosureRetry,
    now: number,
  ): void {
    this.storage.transactionSync(() => {
      this.repository.requeueWebSocketClosure(closure, retry, now);
    });
  }

  webSocketClosureDeadline(sid: string): number | null {
    return this.repository.webSocketClosureDeadline(sid);
  }

  deferWebSocketClosure(
    sid: string,
    code: number,
    reason: string,
  ): void {
    const now = this.now();
    this.storage.transactionSync(() => {
      if (this.repository.webSocketClosureDeadline(sid) !== null) return;
      this.repository.scheduleWebSocketClosure(sid, code, reason, now, now);
    });
  }

  peekWebSocketFrames(
    sid: string,
    maxPackets: number,
    maxBytes: number,
  ): RealtimeWebSocketFrameBatch | null {
    const now = this.now();
    return this.storage.transactionSync(() => {
      this.requireLiveSession(sid, now, REALTIME_WEBSOCKET_TRANSPORT);
      return this.repository.peekFrames(sid, maxPackets, maxBytes);
    });
  }

  acknowledgeWebSocketFrames(
    sid: string,
    batch: RealtimeWebSocketFrameBatch,
  ): void {
    const now = this.now();
    this.storage.transactionSync(() => {
      this.requireLiveSession(sid, now, REALTIME_WEBSOCKET_TRANSPORT);
      this.repository.acknowledgeFrames(sid, batch);
    });
  }

  closeWebSocketSession(sid: string): void {
    const session = this.repository.getSession(sid);
    if (session?.transport !== REALTIME_WEBSOCKET_TRANSPORT) return;
    this.closeSession(sid);
  }

  async poll(
    sid: string,
    engineProtocol: RealtimeEngineProtocol = 4,
  ): Promise<string> {
    const startedAt = this.now();
    this.cleanup(startedAt);
    if (this.waiters.has(sid)) {
      this.closeSession(sid);
      throw new RealtimeSessionError("overlap", "concurrent polling GET closed the session");
    }

    const acquired = this.storage.transactionSync(() => {
      const session = this.requireLiveSession(
        sid,
        startedAt,
        REALTIME_TRANSPORT,
        engineProtocol,
      );
      // The fresh row and queue counters were read in this same synchronous
      // transaction. An empty queue needs neither another session SELECT nor
      // a payload lookup. After the long-poll await we read a fresh row again.
      const immediate = session.outboundPackets === 0
        ? null
        : this.repository.dequeuePayload(sid);
      if (immediate !== null) {
        this.touchPollingSessionIfDue(session, startedAt);
        return { immediate, waitMs: 0 };
      }
      const ping = this.pollingPingPayloadIfDue(session, startedAt);
      if (ping !== null) {
        this.touchPollingSessionIfDue(session, startedAt);
        return { immediate: ping, waitMs: 0 };
      }
      const heartbeatDeadline = session.pongDeadline ?? session.nextPingAt;
      const waitUntil = Math.min(
        startedAt + Math.max(0, this.pollWaitMs),
        heartbeatDeadline,
        session.expiresAt,
      );
      return {
        immediate: null,
        waitMs: Math.max(0, waitUntil - startedAt),
      };
    });

    if (acquired.immediate !== null) return acquired.immediate;
    const pollToken = randomLeaseToken();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, acquired.waitMs);
      this.waiters.set(sid, { token: pollToken, resolve, timer });
    });
    const waiter = this.waiters.get(sid);
    if (waiter?.token === pollToken) {
      clearTimeout(waiter.timer);
      this.waiters.delete(sid);
    }

    const now = this.now();
    return this.storage.transactionSync(() => {
      const session = this.requireLiveSession(
        sid,
        now,
        REALTIME_TRANSPORT,
        engineProtocol,
      );
      let payload = session.outboundPackets === 0
        ? null
        : this.repository.dequeuePayload(sid);
      if (payload === null) payload = this.pollingPingPayloadIfDue(session, now);
      if (payload === null) {
        // A bounded wake without application data is represented by EIO noop.
        payload = pollingPayloadForSession(session, [{ type: "noop" }]);
      }
      this.touchPollingSessionIfDue(session, now);
      return payload;
    });
  }

  async pollEnvelope(
    sid: string,
    engineProtocol: RealtimeEngineProtocol = 4,
  ): Promise<RealtimePollingEnvelope> {
    const payload = await this.poll(sid, engineProtocol);
    return {
      payload,
      jsonpIndex: this.repository.jsonpIndex(sid),
    };
  }

  nextDeadline(): number | null {
    return this.repository.nextDeadline();
  }

  processAlarm(): void {
    const now = this.now();
    const result = this.storage.transactionSync(() => {
      const closed = new Set<string>();
      let connectedSessionRemoved = false;

      while (true) {
        const expired = this.repository.cleanupOpportunityInTransaction(now);
        for (const session of expired) {
          closed.add(session.sid);
          if (session.socketConnected) connectedSessionRemoved = true;
        }
        if (expired.length < REALTIME_CLEANUP_BATCH) break;
      }

      const wakeTargets = new Set<string>();
      if (connectedSessionRemoved) {
        for (const targetSid of this.enqueueClientsForConnectedSessions(now, closed)) {
          wakeTargets.add(targetSid);
        }
      }
      return { closed: [...closed], wakeTargets: [...wakeTargets] };
    });

    for (const sid of result.closed) {
      this.dropPollingRuntime(sid);
      this.wake(sid);
    }
    for (const sid of result.wakeTargets) this.wake(sid);
  }

  /** Seeds the persisted replacement for upstream websocket.js `lastData`. */
  synchronizeRootDataSnapshot(): void {
    const now = this.now();
    const snapshot = this.snapshot(now);
    if (snapshot === null) return;
    const encoded = JSON.stringify(deltaState(snapshot, now, this.activeProfile(now)));
    this.storage.transactionSync(() => {
      this.repository.initializeRootDataState(encoded, now);
    });
  }

  /**
   * Recomputes the bounded tenant ddata state and queues the locked calcdelta
   * event for current root DataReceivers. The caller already owns the document
   * mutation transaction, so the new baseline and accepted frames commit with
   * that mutation. Queue saturation drops only the affected realtime session.
   */
  recordRootDataUpdateInTransaction(): void {
    const now = this.now();
    if (!this.repository.hasDataReceiverSession(now)) return;
    const snapshot = this.snapshot(now);
    if (snapshot === null) return;
    const current = deltaState(snapshot, now, this.activeProfile(now));
    const currentJson = JSON.stringify(current);
    const previousJson = this.repository.rootDataStateJson();
    this.repository.replaceRootDataState(currentJson, now);
    if (previousJson === null) return;

    let previous: RealtimeDeltaState;
    try {
      const parsed = JSON.parse(previousJson) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      previous = parsed as RealtimeDeltaState;
    } catch {
      // A bad legacy baseline must not roll back the user's document mutation.
      // The valid current snapshot above repairs it for the next update.
      return;
    }

    let delta = calculateRealtimeDelta(previous, current);
    if (
      previous.activeProfile !== current.activeProfile &&
      this.status !== undefined
    ) {
      // Locked websocket.js adds a fresh status object only when the latest
      // zero-duration Profile Switch changes. Keep the active-profile marker
      // in the durable baseline, but never expose that private comparison key
      // as an extra root payload field.
      delta = delta.delta === true
        ? { ...delta, status: this.status(now) }
        : {
            delta: true,
            lastUpdated: now,
            status: this.status(now),
          };
    }
    if (delta.delta !== true) return;

    let packet: EngineIoV4Packet;
    try {
      packet = wrapSocketIoV5Packet({
        type: "event",
        namespace: "/",
        data: ["dataUpdate", delta],
      });
    } catch {
      return;
    }

    let droppedConnectedRoot = false;
    for (const sid of this.repository.listDataReceiverSessionIds(now)) {
      try {
        this.enqueuePacketsForSession(sid, [packet], now);
        this.pendingApplicationWakeSids.add(sid);
      } catch {
        this.repository.deleteSessionInTransaction(sid);
        this.pendingApplicationWakeSids.add(sid);
        droppedConnectedRoot = true;
      }
    }
    if (droppedConnectedRoot) {
      for (const sid of this.enqueueClientsForConnectedSessions(now)) {
        this.pendingApplicationWakeSids.add(sid);
      }
    }
  }

  /**
   * Called from the document repository while its API3 mutation transaction is
   * still open. The persisted per-session packet queues are therefore the
   * change outbox: either the document and every accepted frame commit
   * together, or neither does. A saturated subscriber is dropped without
   * failing the storage mutation.
   */
  recordApi3StorageMutationInTransaction(event: Api3RealtimeMutationEvent): void {
    if (event.recordRootUpdate !== false) this.recordRootDataUpdateInTransaction();
    let packet: EngineIoV4Packet;
    try {
      const payload = event.type === "delete"
        ? { colName: event.collection, identifier: event.identifier }
        : { colName: event.collection, doc: event.document };
      packet = wrapSocketIoV5Packet({
        type: "event",
        namespace: "/storage",
        data: [event.type, payload],
      });
    } catch {
      // A document mutation must never be rolled back because one realtime
      // representation cannot fit the bounded transport adapter.
      return;
    }

    const now = this.now();
    let droppedConnectedRoot = false;
    for (const sid of this.repository.listStorageSubscriberSessionIds(event.collection, now)) {
      try {
        this.enqueuePacketsForSession(sid, [packet], now);
        this.pendingApplicationWakeSids.add(sid);
      } catch {
        const session = this.repository.getSession(sid);
        if (session?.socketConnected === true) droppedConnectedRoot = true;
        this.repository.deleteSessionInTransaction(sid);
        this.pendingApplicationWakeSids.add(sid);
      }
    }
    if (droppedConnectedRoot) {
      for (const sid of this.enqueueClientsForConnectedSessions(now)) {
        this.pendingApplicationWakeSids.add(sid);
      }
    }
  }

  /**
   * Trusted server-side notification outlet used by the future plugin/bus
   * adapter. Like upstream namespace.emit(), this broadcasts to every current
   * `/alarm` connection (subscription only controls ACK authority) and does not
   * create an offline replay log.
   */
  publishAlarmNotification(notification: Record<string, unknown>): number {
    let packet: EngineIoV4Packet;
    try {
      packet = wrapSocketIoV5Packet({
        type: "event",
        namespace: "/alarm",
        data: [alarmEventName(notification), notification],
      });
    } catch {
      return 0;
    }
    const now = this.now();
    const result = this.storage.transactionSync(() => {
      const wakeTargets = new Set<string>();
      const delivered = this.enqueueAlarmFrameInTransaction(packet, now, wakeTargets);
      return { delivered, wakeTargets: [...wakeTargets] };
    });
    for (const sid of result.wakeTargets) this.wake(sid);
    return result.delivered;
  }

  /**
   * Runs the locked notification arbitration against durable ACK/silence/
   * last-emission state, then publishes every selected object through the
   * existing live-only `/alarm` namespace in the same SQLite transaction.
   */
  processAlarmNotificationRequests(
    notifications: Record<string, unknown>[],
    snoozes: Record<string, unknown>[],
    lastUpdated: number,
    commitInTransaction?: (result: NotificationProcessResult) => void,
  ): RealtimeNotificationProcessResult {
    const now = this.now();
    const result = this.storage.transactionSync(() => {
      const engine = new NightscoutNotificationEngine(
        this.repository,
        () => undefined,
        () => now,
      );
      for (const notification of notifications) engine.requestNotify(notification);
      for (const snooze of snoozes) engine.requestSnooze(snooze);
      const processed = engine.process(lastUpdated);
      const wakeTargets = new Set<string>();
      let delivered = 0;
      for (const notification of processed.emitted) {
        try {
          const packet = wrapSocketIoV5Packet({
            type: "event",
            namespace: "/alarm",
            data: [alarmEventName(notification), notification],
          });
          delivered += this.enqueueAlarmFrameInTransaction(packet, now, wakeTargets);
        } catch {
          // Notification state remains authoritative even when one oversized
          // live-only representation cannot fit the bounded transport.
        }
      }
      commitInTransaction?.(processed);
      return {
        ...processed,
        delivered,
        wakeTargets: [...wakeTargets],
      };
    });
    for (const sid of result.wakeTargets) this.wake(sid);
    return {
      acceptedNotifications: result.acceptedNotifications,
      acceptedSnoozes: result.acceptedSnoozes,
      emitted: result.emitted,
      delivered: result.delivered,
    };
  }

  acknowledgeAlarm(level: number, group: string, rawSilenceTime: number): boolean {
    const acknowledgement = normalizeAlarmAcknowledgement(level, group, rawSilenceTime);
    if (acknowledgement === null) return false;
    const now = this.now();
    const result = this.storage.transactionSync(() => {
      const wakeTargets = new Set<string>();
      const accepted = this.acknowledgeAlarmInTransaction(
        acknowledgement,
        now,
        wakeTargets,
      );
      return { accepted, wakeTargets: [...wakeTargets] };
    });
    for (const sid of result.wakeTargets) this.wake(sid);
    return result.accepted;
  }

  flushApplicationWakes(): number {
    const sids = [...this.pendingApplicationWakeSids];
    this.pendingApplicationWakeSids.clear();
    for (const sid of sids) this.wake(sid);
    return sids.length;
  }

  private enqueuePacketsForSession(
    sid: string,
    packets: readonly EngineIoV4Packet[],
    now: number,
  ): void {
    const session = this.repository.requireSession(sid);
    this.repository.enqueueFrames(sid, engineFrames(session, packets), now);
  }

  private enqueueAlarmFrameInTransaction(
    packet: EngineIoV4Packet,
    now: number,
    wakeTargets: Set<string>,
  ): number {
    let delivered = 0;
    let droppedConnectedRoot = false;
    for (const sid of this.repository.listAlarmConnectionSessionIds(now)) {
      try {
        this.enqueuePacketsForSession(sid, [packet], now);
        wakeTargets.add(sid);
        delivered += 1;
      } catch {
        const session = this.repository.getSession(sid);
        if (session?.socketConnected === true) droppedConnectedRoot = true;
        this.repository.deleteSessionInTransaction(sid);
        wakeTargets.add(sid);
      }
    }
    if (droppedConnectedRoot) {
      for (const sid of this.enqueueClientsForConnectedSessions(now)) {
        wakeTargets.add(sid);
      }
    }
    return delivered;
  }

  private acknowledgeAlarmInTransaction(
    acknowledgement: RealtimeAlarmAcknowledgement,
    now: number,
    wakeTargets: Set<string>,
  ): boolean {
    const { level, group, silenceTime } = acknowledgement;
    if (!this.repository.ackAlarm(level, group, silenceTime, now)) return false;
    const clear = {
      clear: true,
      title: "All Clear",
      message: `${group} - ${alarmLevelDisplay(level)} was ack'd`,
      group,
    };
    const packet = wrapSocketIoV5Packet({
      type: "event",
      namespace: "/alarm",
      data: ["clear_alarm", clear],
    });
    this.enqueueAlarmFrameInTransaction(packet, now, wakeTargets);
    return true;
  }

  private commitProcessedSession(
    sid: string,
    session: RealtimeSession,
    outbound: readonly EngineIoV4Packet[],
    broadcasts: readonly EngineIoV4Packet[],
    alarmAcknowledgements: readonly RealtimeAlarmAcknowledgement[],
    now: number,
    validateCurrent: (current: RealtimeSession) => RealtimeSessionError | null,
  ): { error: RealtimeSessionError | null; wakeTargets: string[] } {
    return this.storage.transactionSync(() => {
      const wakeTargets = new Set<string>();
      const current = this.repository.getSession(sid);
      if (current === null) {
        return {
          error: new RealtimeSessionError("unknown_sid", "session ID is unknown"),
          wakeTargets: [],
        };
      }
      this.applyPollingHeartbeat(current, now);
      const closeCurrent = (
        error: RealtimeSessionError,
        wasConnected: boolean,
      ): { error: RealtimeSessionError; wakeTargets: string[] } => {
        this.repository.deleteSessionInTransaction(sid);
        this.dropPollingRuntime(sid);
        if (wasConnected) {
          for (const targetSid of this.enqueueClientsForConnectedSessions(now)) {
            wakeTargets.add(targetSid);
          }
        }
        return { error, wakeTargets: [...wakeTargets] };
      };
      if (
        current.transport !== REALTIME_WEBSOCKET_TRANSPORT &&
        (
          current.expiresAt <= now ||
          (current.pongDeadline !== null && current.pongDeadline <= now)
        )
      ) {
        return closeCurrent(
          new RealtimeSessionError("unknown_sid", "session ID is unknown or expired"),
          current.socketConnected,
        );
      }
      const validationError = validateCurrent(current);
      if (validationError !== null) {
        return closeCurrent(validationError, current.socketConnected);
      }

      // Authorization may await tenant storage/crypto while another transport
      // event advances heartbeat state. WebSocket liveness remains durable;
      // polling liveness is owned by the active DO runtime.
      if (current.transport === REALTIME_TRANSPORT) {
        this.applyPollingHeartbeat(session, now);
      }
      session.lastSeenAt = Math.max(session.lastSeenAt, current.lastSeenAt, now);
      if (current.transport === REALTIME_WEBSOCKET_TRANSPORT) {
        // Hibernatable WebSocket attachments own transport liveness. Preserve
        // the legacy columns only as inert compatibility data when committing
        // a genuine Socket.IO application message.
        session.nextPingAt = current.nextPingAt;
        session.pongDeadline = current.pongDeadline;
        session.expiresAt = current.expiresAt;
      }
      session.pollToken = null;
      session.pollDeadline = null;
      session.postToken = null;
      session.postDeadline = null;
      this.repository.updateSession(session);
      this.rememberPollingHeartbeat(session, now);
      try {
        this.repository.enqueueFrames(sid, engineFrames(session, outbound), now);
      } catch (error) {
        return closeCurrent(
          this.translateRepositoryError(error),
          session.socketConnected,
        );
      }
      for (const broadcast of broadcasts) {
        let droppedTarget = false;
        for (const targetSid of this.repository.listConnectedSessionIds(now)) {
          if (targetSid === sid) continue;
          try {
            this.enqueuePacketsForSession(targetSid, [broadcast], now);
            wakeTargets.add(targetSid);
          } catch (error) {
            if (
              error instanceof RealtimeRepositoryError &&
              error.code === "queue_overflow"
            ) {
              this.repository.deleteSessionInTransaction(targetSid);
              droppedTarget = true;
              continue;
            }
            throw error;
          }
        }
        if (droppedTarget) {
          for (const targetSid of this.enqueueClientsForConnectedSessions(now)) {
            wakeTargets.add(targetSid);
          }
        }
      }
      for (const acknowledgement of alarmAcknowledgements) {
        this.acknowledgeAlarmInTransaction(acknowledgement, now, wakeTargets);
      }
      return { error: null, wakeTargets: [...wakeTargets] };
    });
  }

  private async processSocketPacket(
    session: RealtimeSession,
    packet: SocketIoV5Packet,
    outbound: EngineIoV4Packet[],
    broadcasts: EngineIoV4Packet[],
    alarmAcknowledgements: RealtimeAlarmAcknowledgement[],
    rootMutation: RealtimeRootMutationState,
  ): Promise<void> {
    if (packet.type === "connect") {
      if (packet.namespace === "/storage") {
        const socketSid = this.repository.connectStorageNamespace(session.sid, this.now());
        if (socketSid === null) {
          throw new RealtimeSessionError(
            "bad_packet",
            "storage namespace is already connected",
          );
        }
        outbound.push(wrapSocketIoV5Packet(
          createSocketIoV5ServerConnectPacket("/storage", socketSid),
        ));
        return;
      }
      if (packet.namespace === "/alarm") {
        const socketSid = this.repository.connectAlarmNamespace(session.sid, this.now());
        if (socketSid === null) {
          throw new RealtimeSessionError(
            "bad_packet",
            "alarm namespace is already connected",
          );
        }
        outbound.push(wrapSocketIoV5Packet(
          createSocketIoV5ServerConnectPacket("/alarm", socketSid),
        ));
        return;
      }
      if (packet.namespace !== "/") {
        outbound.push(wrapSocketIoV5Packet({
          type: "error",
          namespace: packet.namespace,
          data: { message: "Invalid namespace" },
        }));
        return;
      }
      if (session.socketConnected) {
        throw new RealtimeSessionError("bad_packet", "root namespace is already connected");
      }
      session.socketSid = createRealtimeSocketId();
      session.socketConnected = true;
      outbound.push(wrapSocketIoV5Packet(
        createSocketIoV5ServerConnectPacket("/", session.socketSid),
      ));
      const clients = wrapSocketIoV5Packet({
        type: "event",
        namespace: "/",
        data: ["clients", this.repository.countConnectedSessions(this.now()) + 1],
      });
      // Socket.IO sends the root CONNECT response before invoking the locked
      // Nightscout connection handler, which then broadcasts `clients`.
      outbound.push(clients);
      broadcasts.push(clients);
      return;
    }

    if (packet.type === "disconnect") {
      if (packet.namespace === "/storage") {
        this.repository.disconnectStorageNamespace(session.sid);
        return;
      }
      if (packet.namespace === "/alarm") {
        this.repository.disconnectAlarmNamespace(session.sid);
        return;
      }
      if (packet.namespace === "/") {
        session.socketConnected = false;
        session.authorized = false;
        session.readAllowed = false;
        session.writeAllowed = false;
        session.treatmentWriteAllowed = false;
        broadcasts.push(wrapSocketIoV5Packet({
          type: "event",
          namespace: "/",
          data: [
            "clients",
            Math.max(0, this.repository.countConnectedSessions(this.now()) - 1),
          ],
        }));
      }
      return;
    }

    if (packet.type === "ack" || packet.type === "error") return;
    if (packet.namespace === "/alarm") {
      if (!this.repository.alarmNamespaceConnected(session.sid)) {
        throw new RealtimeSessionError(
          "bad_packet",
          "alarm event requires the connected alarm namespace",
        );
      }
      await this.processAlarmEvent(session, packet, outbound, alarmAcknowledgements);
      return;
    }
    if (packet.namespace === "/storage") {
      if (!this.repository.storageNamespaceConnected(session.sid)) {
        throw new RealtimeSessionError(
          "bad_packet",
          "storage event requires the connected storage namespace",
        );
      }
      await this.processStorageEvent(session, packet, outbound);
      return;
    }
    if (packet.namespace !== "/" || !session.socketConnected) {
      throw new RealtimeSessionError("bad_packet", "event requires the connected root namespace");
    }
    await this.processRootEvent(session, packet, outbound, broadcasts, rootMutation);
  }

  private async processAlarmEvent(
    session: RealtimeSession,
    packet: SocketIoV5EventPacket,
    outbound: EngineIoV4Packet[],
    alarmAcknowledgements: RealtimeAlarmAcknowledgement[],
  ): Promise<void> {
    const eventName = packet.data[0];
    if (eventName === "subscribe") {
      const rawMessage = packet.data.length === 2 ? packet.data[1] : undefined;
      const message = typeof rawMessage === "object"
          && rawMessage !== null
          && !Array.isArray(rawMessage)
        ? rawMessage as Record<string, unknown>
        : {};
      const authorization = await this.authorizeAlarm(message);
      let result: Record<string, unknown>;
      if (authorization === null) {
        result = { success: false, message: "Missing or bad accessToken" };
      } else if (authorization.mode === "accessToken") {
        this.repository.setAlarmSubscription(
          session.sid,
          "accessToken",
          false,
          true,
          this.now(),
        );
        result = { success: true, message: "Subscribed for alarms" };
      } else {
        this.repository.setAlarmSubscription(
          session.sid,
          "web",
          authorization.read,
          authorization.ack,
          this.now(),
        );
        result = {
          success: true,
          message: "Subscribed for alarms",
          read: authorization.read,
          ack: authorization.ack,
        };
      }
      if (packet.id !== undefined) {
        outbound.push(wrapSocketIoV5Packet({
          type: "ack",
          namespace: "/alarm",
          id: packet.id,
          data: [result],
        }));
      }
      return;
    }

    if (eventName !== "ack" || !this.repository.alarmAckAllowed(session.sid)) return;
    const acknowledgement = normalizeAlarmAcknowledgement(
      packet.data[1] as number,
      packet.data[2] as string,
      packet.data[3] as number,
    );
    if (acknowledgement === null) {
      // Upstream has no protocol ACK or error for malformed alarm ACK events.
      // Ignore them without allocating tenant state or closing the transport.
      return;
    }
    alarmAcknowledgements.push(acknowledgement);
  }

  private async processStorageEvent(
    session: RealtimeSession,
    packet: SocketIoV5EventPacket,
    outbound: EngineIoV4Packet[],
  ): Promise<void> {
    if (packet.data[0] !== "subscribe") return;

    const rawMessage = packet.data.length === 2 ? packet.data[1] : undefined;
    const message = typeof rawMessage === "object"
      && rawMessage !== null
      && !Array.isArray(rawMessage)
      ? rawMessage as Record<string, unknown>
      : null;
    const collections = message === null ? null : await this.authorizeStorage(message);
    let result: Record<string, unknown>;
    if (collections === null) {
      result = { success: false, message: "Missing or bad accessToken" };
    } else if (collections.length === 0) {
      result = { success: false, message: "Unauthorized to receive any collection" };
    } else {
      const granted = [...collections];
      this.repository.addStorageSubscriptions(session.sid, granted, this.now());
      result = { success: true, collections: granted };
    }

    if (packet.id !== undefined) {
      outbound.push(wrapSocketIoV5Packet({
        type: "ack",
        namespace: "/storage",
        id: packet.id,
        data: [result],
      }));
    }
  }

  private async processRootEvent(
    session: RealtimeSession,
    packet: SocketIoV5EventPacket,
    outbound: EngineIoV4Packet[],
    broadcasts: EngineIoV4Packet[],
    rootMutation: RealtimeRootMutationState,
  ): Promise<void> {
    const eventName = packet.data[0];
    if (eventName === "authorize") {
      if (packet.data.length !== 2) {
        throw new RealtimeSessionError("bad_packet", "authorize requires one object payload");
      }
      const message = recordValue(packet.data[1], "authorize payload");
      const authorization = await this.authorize(message);

      if (authorization === null) {
        // Locked verifyAuthorization errors call socket.disconnect() and never
        // invoke the callback. This disconnects only root; EIO stays alive so
        // the client may reconnect a namespace on the same transport.
        session.socketConnected = false;
        session.authorized = false;
        session.readAllowed = false;
        session.writeAllowed = false;
        session.treatmentWriteAllowed = false;
        outbound.push(wrapSocketIoV5Packet({ type: "disconnect", namespace: "/" }));
        broadcasts.push(wrapSocketIoV5Packet({
          type: "event",
          namespace: "/",
          data: [
            "clients",
            Math.max(0, this.repository.countConnectedSessions(this.now()) - 1),
          ],
        }));
        return;
      }

      // Locked Nightscout v15.0.7 order: connected, authorization state,
      // optional initial dataUpdate, then the callback ACK.
      outbound.push(wrapSocketIoV5Packet({
        type: "event",
        namespace: "/",
        data: ["connected"],
      }));
      session.authorized = true;
      session.readAllowed = authorization.read;
      session.writeAllowed = authorization.write;
      session.treatmentWriteAllowed = authorization.write_treatment;
      if (authorization.read) {
        const now = this.now();
        const firstDataReceiver = !this.repository.hasDataReceiverSession(now);
        const snapshot = this.snapshot(now);
        if (snapshot !== null) {
          const data: RealtimeSnapshot = { ...snapshot };
          if (message.status && this.status !== undefined) {
            data.status = this.status(now);
          }
          outbound.push(wrapSocketIoV5Packet({
            type: "event",
            namespace: "/",
            data: ["dataUpdate", data],
          }));
          if (firstDataReceiver) {
            this.repository.replaceRootDataState(
              JSON.stringify(deltaState(snapshot, now, this.activeProfile(now))),
              now,
            );
          }
        }
      }
      if (packet.id !== undefined) {
        outbound.push(wrapSocketIoV5Packet({
          type: "ack",
          namespace: "/",
          id: packet.id,
          data: [{
            read: authorization.read,
            write: authorization.write,
            write_treatment: authorization.write_treatment,
          }],
        }));
      }
      return;
    }

    if (
      eventName === "dbAdd"
      || eventName === "dbUpdate"
      || eventName === "dbUpdateUnset"
      || eventName === "dbRemove"
    ) {
      const rawMessage = packet.data.length >= 2 ? packet.data[1] : undefined;
      const message = typeof rawMessage === "object"
          && rawMessage !== null
          && !Array.isArray(rawMessage)
        ? rawMessage as Record<string, unknown>
        : {};
      const collection = realtimeRootWriteCollection(message.collection);
      let acknowledgement: unknown;
      if (collection === null) {
        acknowledgement = { result: "Wrong collection" };
      } else if (!session.authorized) {
        acknowledgement = { result: "Not authorized" };
      } else if (
        collection === "treatments"
          ? !session.treatmentWriteAllowed
          : !session.writeAllowed
      ) {
        acknowledgement = { result: "Not permitted" };
      } else {
        const receivedAt = this.now();
        const id = eventName === "dbAdd" ? null : realtimeRootWriteId(message._id);
        if (eventName !== "dbAdd" && id === null) {
          acknowledgement = { result: "Missing _id" };
        } else {
          let result: RealtimeRootWriteResult;
          try {
            result = eventName === "dbAdd"
              ? await this.writeRoot({
                event: "dbAdd",
                collection,
                data: message.data,
                receivedAt,
              })
              : eventName === "dbRemove"
                ? await this.writeRoot({
                  event: "dbRemove",
                  collection,
                  id: id!,
                  receivedAt,
                })
                : await this.writeRoot({
                  event: eventName,
                  collection,
                  id: id!,
                  data: message.data,
                  receivedAt,
                });
          } catch {
            // Locked websocket.js logs storage failures but keeps the namespace
            // connected. dbAdd reports an empty result; update/unset/remove
            // have already exposed their optimistic success callback shape.
            result = {
              acknowledgement: eventName === "dbAdd" ? [] : { result: "success" },
              changed: false,
            };
          }
          acknowledgement = result.acknowledgement;
          rootMutation.changed ||= result.changed;
        }
      }

      if (packet.id !== undefined) {
        outbound.push(wrapSocketIoV5Packet({
          type: "ack",
          namespace: "/",
          id: packet.id,
          data: [acknowledgement],
        }));
      }
      return;
    }

    if (eventName === "loadRetro") {
      if (packet.data.length !== 2) {
        throw new RealtimeSessionError("bad_packet", "loadRetro requires one object payload");
      }
      recordValue(packet.data[1], "loadRetro payload");
      const devicestatus = this.retroDeviceStatus(this.now());
      // Locked upstream calls the callback before emitting retroUpdate.
      if (packet.id !== undefined) {
        outbound.push(wrapSocketIoV5Packet({
          type: "ack",
          namespace: "/",
          id: packet.id,
          data: [{ result: "success" }],
        }));
      }
      outbound.push(wrapSocketIoV5Packet({
        type: "event",
        namespace: "/",
        data: ["retroUpdate", { devicestatus: devicestatus ?? [] }],
      }));
      return;
    }

    // `subscribe` is intentionally included here only as locked evidence: the
    // v15.0.7 root namespace has no listener, so Socket.IO produces no ACK.
    // Other unimplemented events behave the same.
  }

  private acceptPong(session: RealtimeSession, _packet: EngineIoV4Packet): void {
    const now = this.now();
    // engine.io 6.2.1 ignores optional pong data on the normal polling path.
    session.pongDeadline = null;
    session.nextPingAt = now + REALTIME_PING_INTERVAL_MS;
    session.expiresAt = session.nextPingAt + REALTIME_PING_TIMEOUT_MS;
    session.lastSeenAt = now;
  }

  private refreshInboundLiveness(session: RealtimeSession, now: number): void {
    session.lastSeenAt = now;
    // engine.io 6.2.1 resets its liveness timeout for every inbound packet.
    // The independent server-ping interval remains unchanged until a pong.
    session.expiresAt = now + REALTIME_PING_INTERVAL_MS + REALTIME_PING_TIMEOUT_MS;
    if (session.engineProtocol === 3) {
      session.nextPingAt = session.expiresAt;
      session.pongDeadline = null;
      return;
    }
    if (session.pongDeadline !== null) session.pongDeadline = session.expiresAt;
  }

  private pollingPingPayloadIfDue(
    session: RealtimeSession,
    now: number,
  ): string | null {
    if (session.engineProtocol === 3) return null;
    if (session.pongDeadline !== null || now < session.nextPingAt) return null;
    session.pongDeadline = now + REALTIME_PING_TIMEOUT_MS;
    session.expiresAt = session.pongDeadline;
    this.rememberPollingHeartbeat(session);
    return pollingPayloadForSession(session, [{ type: "ping" }]);
  }

  private rememberPollingHeartbeat(
    session: RealtimeSession,
    durableTouchedAt?: number,
  ): void {
    if (session.transport !== REALTIME_TRANSPORT) return;
    const prior = this.pollingHeartbeats.get(session.sid);
    this.pollingHeartbeats.set(session.sid, {
      lastSeenAt: session.lastSeenAt,
      nextPingAt: session.nextPingAt,
      pongDeadline: session.pongDeadline,
      expiresAt: session.expiresAt,
      durableTouchedAt: durableTouchedAt ?? prior?.durableTouchedAt ?? session.lastSeenAt,
    });
  }

  private applyPollingHeartbeat(session: RealtimeSession, now: number): void {
    if (session.transport !== REALTIME_TRANSPORT) return;
    let heartbeat = this.pollingHeartbeats.get(session.sid);
    if (heartbeat === undefined) {
      // A DO activation may happen between two polling requests. The durable
      // row keeps authorization and subscriptions; transport liveness restarts
      // from the request that woke the object.
      heartbeat = {
        lastSeenAt: now,
        nextPingAt: session.engineProtocol === 4
          ? now + REALTIME_PING_INTERVAL_MS
          : now + REALTIME_PING_INTERVAL_MS + REALTIME_PING_TIMEOUT_MS,
        pongDeadline: null,
        expiresAt: now + REALTIME_PING_INTERVAL_MS + REALTIME_PING_TIMEOUT_MS,
        durableTouchedAt: session.lastSeenAt,
      };
      this.pollingHeartbeats.set(session.sid, heartbeat);
    }
    session.lastSeenAt = heartbeat.lastSeenAt;
    session.nextPingAt = heartbeat.nextPingAt;
    session.pongDeadline = heartbeat.pongDeadline;
    session.expiresAt = heartbeat.expiresAt;
    session.pollToken = null;
    session.pollDeadline = null;
  }

  private touchPollingSessionIfDue(session: RealtimeSession, now: number): boolean {
    const heartbeat = this.pollingHeartbeats.get(session.sid);
    if (
      heartbeat === undefined
      || now - heartbeat.durableTouchedAt < REALTIME_POLL_DURABLE_TOUCH_MS
    ) {
      return false;
    }
    const durable = cloneSession(session);
    durable.lastSeenAt = now;
    durable.nextPingAt = heartbeat.nextPingAt;
    durable.pongDeadline = heartbeat.pongDeadline;
    durable.expiresAt = heartbeat.expiresAt;
    durable.pollToken = null;
    durable.pollDeadline = null;
    this.repository.updateSession(durable);
    heartbeat.durableTouchedAt = now;
    return true;
  }

  private dropPollingRuntime(sid: string): void {
    this.pollingHeartbeats.delete(sid);
  }

  private requireLiveSession(
    sid: string,
    now: number,
    transport: RealtimeTransport = REALTIME_TRANSPORT,
    engineProtocol?: RealtimeEngineProtocol,
  ): RealtimeSession {
    const session = this.repository.getSession(sid);
    if (
      session === null
      || session.transport !== transport
      || (engineProtocol !== undefined && session.engineProtocol !== engineProtocol)
    ) {
      throw new RealtimeSessionError("unknown_sid", "session ID is unknown or expired");
    }
    this.applyPollingHeartbeat(session, now);
    if (
      transport !== REALTIME_WEBSOCKET_TRANSPORT &&
      (
        session.expiresAt <= now ||
        (session.pongDeadline !== null && session.pongDeadline <= now)
      )
    ) {
      this.repository.deleteSessionInTransaction(sid);
      this.dropPollingRuntime(sid);
      throw new RealtimeSessionError("unknown_sid", "session ID is unknown or expired");
    }
    return session;
  }

  private cleanup(now: number): void {
    for (const [sid, heartbeat] of this.pollingHeartbeats) {
      if (
        heartbeat.expiresAt <= now
        || (heartbeat.pongDeadline !== null && heartbeat.pongDeadline <= now)
      ) {
        this.closeSession(sid);
      }
    }
    const expired = this.repository.cleanupOpportunity(now);
    for (const session of expired) {
      this.dropPollingRuntime(session.sid);
      this.wake(session.sid);
    }
    if (expired.some((session) => session.socketConnected)) {
      const targets = this.storage.transactionSync(() =>
        this.enqueueClientsForConnectedSessions(now),
      );
      for (const targetSid of targets) this.wake(targetSid);
    }
  }

  private wake(sid: string): void {
    const waiter = this.waiters.get(sid);
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    waiter.resolve();
  }

  private closeForBadPacket(sid: string): void {
    this.closeSession(sid);
  }

  private closeSession(sid: string): void {
    const now = this.now();
    const targets = this.storage.transactionSync(() => {
      const session = this.repository.getSession(sid);
      if (session === null) return [];
      const wasConnected = session.socketConnected;
      this.repository.deleteSessionInTransaction(sid);
      return wasConnected ? this.enqueueClientsForConnectedSessions(now) : [];
    });
    this.dropPollingRuntime(sid);
    this.wake(sid);
    for (const targetSid of targets) this.wake(targetSid);
  }

  private enqueueClientsForConnectedSessions(
    now: number,
    droppedSessions?: Set<string>,
  ): string[] {
    const enqueued = new Set<string>();
    // A saturated client's removal changes the count. Append a corrected count
    // and repeat until every surviving connected session has received the final
    // value (or all saturated sessions have been removed).
    while (true) {
      const targets = this.repository.listConnectedSessionIds(now);
      if (targets.length === 0) return [...enqueued];
      const packet = wrapSocketIoV5Packet({
        type: "event",
        namespace: "/",
        data: ["clients", targets.length],
      });
      let droppedTarget = false;
      for (const targetSid of targets) {
        try {
          this.enqueuePacketsForSession(targetSid, [packet], now);
          enqueued.add(targetSid);
        } catch (error) {
          if (
            error instanceof RealtimeRepositoryError &&
            error.code === "queue_overflow"
          ) {
            this.repository.deleteSessionInTransaction(targetSid);
            droppedSessions?.add(targetSid);
            droppedTarget = true;
            continue;
          }
          throw error;
        }
      }
      if (!droppedTarget) return [...enqueued];
    }
  }

  private badPacket(error: unknown): RealtimeSessionError {
    if (error instanceof RealtimeSessionError) return error;
    if (error instanceof ProtocolError) {
      return new RealtimeSessionError("bad_packet", `${error.code}: ${error.message}`);
    }
    return new RealtimeSessionError(
      "bad_packet",
      error instanceof Error ? error.message : "invalid realtime packet",
    );
  }

  private translateRepositoryError(error: unknown): RealtimeSessionError {
    if (error instanceof RealtimeSessionError) return error;
    if (isDurableObjectWriteQuotaError(error)) {
      return new RealtimeSessionError(
        "storage_quota",
        "Temporary storage quota exceeded",
      );
    }
    if (error instanceof RealtimeRepositoryError) {
      return new RealtimeSessionError(error.code, error.message);
    }
    throw error;
  }
}
