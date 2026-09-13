import {
  ENGINE_IO_V4_POLLING_SEPARATOR,
  decodeEngineIoV3Packet,
  decodeEngineIoV4Packet,
  encodeEngineIoV3Packet,
  encodeEngineIoV3PollingPayload,
  encodeEngineIoV4Packet,
} from "../protocol";
import {
  REALTIME_CLEANUP_BATCH,
  REALTIME_ENGINE_PROTOCOL,
  REALTIME_MAX_ALARM_GROUPS,
  REALTIME_MAX_PAYLOAD_BYTES,
  REALTIME_MAX_QUEUE_BYTES,
  REALTIME_MAX_QUEUE_PACKETS,
  REALTIME_MAX_SESSIONS_PER_TENANT,
  REALTIME_POLL_STALE_SESSION_MS,
  REALTIME_PING_INTERVAL_MS,
  REALTIME_PING_TIMEOUT_MS,
  REALTIME_TRANSPORT,
  REALTIME_WEBSOCKET_CLOSE_CONTINUATION_MS,
  REALTIME_WEBSOCKET_CLOSE_RETRY_BASE_MS,
  REALTIME_WEBSOCKET_CLOSE_RETRY_MAX_MS,
  type RealtimeEngineProtocol,
  type RealtimeTransport,
} from "./constants";

interface SessionRow {
  [key: string]: SqlStorageValue;
  sid: string;
  socket_sid: string;
  engine_protocol: RealtimeEngineProtocol;
  transport: RealtimeTransport;
  socket_connected: number;
  authorized: number;
  read_allowed: number;
  write_allowed: number;
  treatment_write_allowed: number;
  created_at: number;
  last_seen_at: number;
  next_ping_at: number;
  pong_deadline: number | null;
  expires_at: number;
  next_sequence: number;
  outbound_packets: number;
  outbound_bytes: number;
  poll_token: string | null;
  poll_deadline: number | null;
  post_token: string | null;
  post_deadline: number | null;
}

interface QueueRow {
  [key: string]: SqlStorageValue;
  sequence: number;
  packet: string;
  byte_length: number;
}

interface QueuePrefixRow {
  [key: string]: SqlStorageValue;
  packet_count: number;
  byte_length: number;
  last_sequence: number | null;
}

export interface RealtimeWebSocketFrameBatch {
  frames: string[];
  lastSequence: number;
  packetCount: number;
  byteLength: number;
}

interface WebSocketClosureRow {
  [key: string]: SqlStorageValue;
  sid: string;
  close_code: number;
  close_reason: string;
  created_at: number;
  attempt_count: number;
  next_attempt_at: number;
  socket_offset: number;
}

export interface RealtimeWebSocketClosure {
  sid: string;
  code: number;
  reason: string;
  createdAt: number;
  attemptCount: number;
  nextAttemptAt: number;
  socketOffset: number;
}

export interface RealtimeWebSocketClosureRetry {
  budgetDeferred: boolean;
  closeFailed: boolean;
  nextSocketOffset: number;
}

interface CountRow {
  [key: string]: SqlStorageValue;
  count: number;
}

interface DeadlineRow {
  [key: string]: SqlStorageValue;
  deadline: number | null;
}

interface SidRow {
  [key: string]: SqlStorageValue;
  sid: string;
}

interface AlarmSilenceRow {
  [key: string]: SqlStorageValue;
  last_ack_at: number;
  silence_time: number;
  last_emit_at: number | null;
}

export interface RealtimeAlarmState {
  level: number;
  group: string;
  lastAckAt: number;
  silenceTime: number;
  lastEmitAt: number | null;
}

interface RootDataStateRow {
  [key: string]: SqlStorageValue;
  snapshot: string;
}

export interface RealtimeSession {
  sid: string;
  socketSid: string;
  engineProtocol: RealtimeEngineProtocol;
  transport: RealtimeTransport;
  socketConnected: boolean;
  authorized: boolean;
  readAllowed: boolean;
  writeAllowed: boolean;
  treatmentWriteAllowed: boolean;
  createdAt: number;
  lastSeenAt: number;
  nextPingAt: number;
  pongDeadline: number | null;
  expiresAt: number;
  nextSequence: number;
  outboundPackets: number;
  outboundBytes: number;
  pollToken: string | null;
  pollDeadline: number | null;
  postToken: string | null;
  postDeadline: number | null;
}

export interface ExpiredRealtimeSession {
  sid: string;
  socketConnected: boolean;
}

export class RealtimeRepositoryError extends Error {
  constructor(readonly code: "capacity" | "queue_overflow" | "unknown_sid", message: string) {
    super(message);
    this.name = "RealtimeRepositoryError";
  }
}

function sessionFromRow(row: SessionRow): RealtimeSession {
  return {
    sid: row.sid,
    socketSid: row.socket_sid,
    engineProtocol: row.engine_protocol,
    transport: row.transport,
    socketConnected: row.socket_connected === 1,
    authorized: row.authorized === 1,
    readAllowed: row.read_allowed === 1,
    writeAllowed: row.write_allowed === 1,
    treatmentWriteAllowed: row.treatment_write_allowed === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    nextPingAt: row.next_ping_at,
    pongDeadline: row.pong_deadline,
    expiresAt: row.expires_at,
    nextSequence: row.next_sequence,
    outboundPackets: row.outbound_packets,
    outboundBytes: row.outbound_bytes,
    pollToken: row.poll_token,
    pollDeadline: row.poll_deadline,
    postToken: row.post_token,
    postDeadline: row.post_deadline,
  };
}

function randomSessionId(): string {
  const bytes = new Uint8Array(15);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function createRealtimeSocketId(): string {
  return randomSessionId();
}

export function migrateRealtimeSessions(storage: DurableObjectStorage): void {
  // The v8 repair owns the closure due-time index. Keeping index creation out
  // of this legacy-safe bootstrap avoids create/drop schema churn on every
  // activation of an already-migrated object.
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS realtime_sessions (
      sid TEXT PRIMARY KEY,
      socket_sid TEXT NOT NULL UNIQUE,
      engine_protocol INTEGER NOT NULL CHECK (engine_protocol IN (3, 4)),
      transport TEXT NOT NULL CHECK (transport IN ('polling', 'websocket')),
      socket_connected INTEGER NOT NULL DEFAULT 0 CHECK (socket_connected IN (0, 1)),
      authorized INTEGER NOT NULL DEFAULT 0 CHECK (authorized IN (0, 1)),
      read_allowed INTEGER NOT NULL DEFAULT 0 CHECK (read_allowed IN (0, 1)),
      write_allowed INTEGER NOT NULL DEFAULT 0 CHECK (write_allowed IN (0, 1)),
      treatment_write_allowed INTEGER NOT NULL DEFAULT 0
        CHECK (treatment_write_allowed IN (0, 1)),
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
      post_deadline INTEGER,
      jsonp_index TEXT
    );
    CREATE INDEX IF NOT EXISTS realtime_sessions_expiry
      ON realtime_sessions(expires_at, sid);
    CREATE TABLE IF NOT EXISTS realtime_outbound_packets (
      sid TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      packet TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (sid, sequence)
    );
    CREATE TABLE IF NOT EXISTS realtime_websocket_closures (
      sid TEXT PRIMARY KEY,
      close_code INTEGER NOT NULL,
      close_reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at INTEGER NOT NULL,
      socket_offset INTEGER NOT NULL DEFAULT 0 CHECK (socket_offset >= 0)
    );
  `);
  // Keep the public bootstrap sufficient for repository users and tests; the
  // independent v9/v10 markers below still record deployment provenance.
  migrateRealtimeStorageNamespaceV9(storage);
  migrateRealtimeAlarmNamespaceV10(storage);
  migrateRealtimeRootUpdatesV11(storage);
  migrateRealtimeWriteAuthorityV12(storage);
  migrateRealtimeNotificationStateV13(storage);
}

/**
 * The composite PRIMARY KEY already indexes every FIFO lookup by sid/sequence.
 * Retire only its duplicate secondary index; pending frames, their primary key,
 * durable acknowledgement, and all session counters remain unchanged.
 */
export function migrateRealtimeOutboundIndexV29(storage: DurableObjectStorage): void {
  storage.sql.exec("DROP INDEX IF EXISTS realtime_outbound_by_session");
}

interface SchemaRow {
  [key: string]: SqlStorageValue;
  sql: string | null;
}

/**
 * v5 created `realtime_sessions` with a polling-only CHECK constraint. SQLite
 * cannot alter that constraint in place, so v7 rebuilds only this bounded
 * table while retaining the existing FIFO packet table.
 */
export function migrateRealtimeTransportsV7(storage: DurableObjectStorage): void {
  const definition = storage.sql
    .exec<SchemaRow>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'realtime_sessions'",
    )
    .one().sql;
  if (definition?.includes("transport IN ('polling', 'websocket')")) return;

  storage.sql.exec(`
    DROP INDEX IF EXISTS realtime_sessions_expiry;
    ALTER TABLE realtime_sessions RENAME TO realtime_sessions_polling_v5;
    CREATE TABLE realtime_sessions (
      sid TEXT PRIMARY KEY,
      socket_sid TEXT NOT NULL UNIQUE,
      engine_protocol INTEGER NOT NULL CHECK (engine_protocol = 4),
      transport TEXT NOT NULL CHECK (transport IN ('polling', 'websocket')),
      socket_connected INTEGER NOT NULL DEFAULT 0 CHECK (socket_connected IN (0, 1)),
      authorized INTEGER NOT NULL DEFAULT 0 CHECK (authorized IN (0, 1)),
      read_allowed INTEGER NOT NULL DEFAULT 0 CHECK (read_allowed IN (0, 1)),
      write_allowed INTEGER NOT NULL DEFAULT 0 CHECK (write_allowed IN (0, 1)),
      treatment_write_allowed INTEGER NOT NULL DEFAULT 0
        CHECK (treatment_write_allowed IN (0, 1)),
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
    INSERT INTO realtime_sessions (
      sid, socket_sid, engine_protocol, transport, socket_connected,
      authorized, read_allowed, write_allowed, treatment_write_allowed,
      created_at, last_seen_at, next_ping_at,
      pong_deadline, expires_at, next_sequence, outbound_packets,
      outbound_bytes, poll_token, poll_deadline, post_token, post_deadline
    )
    SELECT
      sid, socket_sid, engine_protocol, transport, socket_connected,
      authorized, read_allowed, write_allowed, treatment_write_allowed,
      created_at, last_seen_at, next_ping_at,
      pong_deadline, expires_at, next_sequence, outbound_packets,
      outbound_bytes, poll_token, poll_deadline, post_token, post_deadline
    FROM realtime_sessions_polling_v5;
    DROP TABLE realtime_sessions_polling_v5;
    CREATE INDEX realtime_sessions_expiry
      ON realtime_sessions(expires_at, sid);
  `);
}

/**
 * v19 admits the legacy Engine.IO 3 protocol on the existing bounded session
 * table. SQLite cannot alter a CHECK constraint in place, so preserve every
 * durable session field while rebuilding only this tenant-local table.
 */
export function migrateRealtimeProtocolsV19(storage: DurableObjectStorage): void {
  const definition = storage.sql
    .exec<SchemaRow>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'realtime_sessions'",
    )
    .one().sql;
  if (definition?.includes("engine_protocol IN (3, 4)")) return;

  storage.sql.exec(`
    DROP INDEX IF EXISTS realtime_sessions_expiry;
    ALTER TABLE realtime_sessions RENAME TO realtime_sessions_eio4_v18;
    CREATE TABLE realtime_sessions (
      sid TEXT PRIMARY KEY,
      socket_sid TEXT NOT NULL UNIQUE,
      engine_protocol INTEGER NOT NULL CHECK (engine_protocol IN (3, 4)),
      transport TEXT NOT NULL CHECK (transport IN ('polling', 'websocket')),
      socket_connected INTEGER NOT NULL DEFAULT 0 CHECK (socket_connected IN (0, 1)),
      authorized INTEGER NOT NULL DEFAULT 0 CHECK (authorized IN (0, 1)),
      read_allowed INTEGER NOT NULL DEFAULT 0 CHECK (read_allowed IN (0, 1)),
      write_allowed INTEGER NOT NULL DEFAULT 0 CHECK (write_allowed IN (0, 1)),
      treatment_write_allowed INTEGER NOT NULL DEFAULT 0
        CHECK (treatment_write_allowed IN (0, 1)),
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
    INSERT INTO realtime_sessions (
      sid, socket_sid, engine_protocol, transport, socket_connected,
      authorized, read_allowed, write_allowed, treatment_write_allowed,
      created_at, last_seen_at, next_ping_at, pong_deadline, expires_at,
      next_sequence, outbound_packets, outbound_bytes, poll_token,
      poll_deadline, post_token, post_deadline
    )
    SELECT
      sid, socket_sid, engine_protocol, transport, socket_connected,
      authorized, read_allowed, write_allowed, treatment_write_allowed,
      created_at, last_seen_at, next_ping_at, pong_deadline, expires_at,
      next_sequence, outbound_packets, outbound_bytes, poll_token,
      poll_deadline, post_token, post_deadline
    FROM realtime_sessions_eio4_v18;
    DROP TABLE realtime_sessions_eio4_v18;
    CREATE INDEX realtime_sessions_expiry
      ON realtime_sessions(expires_at, sid);
  `);
}

/**
 * Engine.IO chooses its polling implementation when the SID is created. A
 * JSONP SID therefore keeps the sanitized callback index even when later
 * requests omit or change the `j` query. The Node server kept that choice in
 * the transport instance; v21 persists it beside the durable polling session.
 */
export function migrateRealtimeJsonpV21(storage: DurableObjectStorage): void {
  const columns = new Set(
    storage.sql
      .exec<TableInfoRow>("PRAGMA table_info(realtime_sessions)")
      .toArray()
      .map((row) => row.name),
  );
  if (!columns.has("jsonp_index")) {
    storage.sql.exec("ALTER TABLE realtime_sessions ADD COLUMN jsonp_index TEXT");
  }
}

interface TableInfoRow {
  [key: string]: SqlStorageValue;
  name: string;
}

/**
 * v8 adds durable close retry state. Keep this repair idempotent because a
 * higher independent migration marker is not proof that these columns exist.
 */
export function migrateRealtimeClosuresV8(storage: DurableObjectStorage): void {
  const columns = new Set(
    storage.sql
      .exec<TableInfoRow>("PRAGMA table_info(realtime_websocket_closures)")
      .toArray()
      .map((row) => row.name),
  );
  if (!columns.has("attempt_count")) {
    storage.sql.exec(
      `ALTER TABLE realtime_websocket_closures
       ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)`,
    );
  }
  if (!columns.has("next_attempt_at")) {
    storage.sql.exec(
      `ALTER TABLE realtime_websocket_closures
       ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!columns.has("socket_offset")) {
    storage.sql.exec(
      `ALTER TABLE realtime_websocket_closures
       ADD COLUMN socket_offset INTEGER NOT NULL DEFAULT 0 CHECK (socket_offset >= 0)`,
    );
  }
  storage.sql.exec(
    `UPDATE realtime_websocket_closures
     SET next_attempt_at = created_at
     WHERE next_attempt_at <= 0`,
  );
  storage.sql.exec(`
    DROP INDEX IF EXISTS realtime_websocket_closures_created;
    CREATE INDEX IF NOT EXISTS realtime_websocket_closures_due
      ON realtime_websocket_closures(next_attempt_at, created_at, sid);
  `);
}

/**
 * API v3's `/storage` namespace keeps connection and room membership durable so
 * a Durable Object eviction does not silently unsubscribe an Engine.IO SID.
 */
export function migrateRealtimeStorageNamespaceV9(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS realtime_storage_connections (
      sid TEXT PRIMARY KEY,
      socket_sid TEXT NOT NULL UNIQUE,
      connected_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS realtime_storage_subscriptions (
      sid TEXT NOT NULL,
      collection TEXT NOT NULL CHECK (
        collection IN ('entries', 'treatments', 'devicestatus', 'profile', 'food', 'settings')
      ),
      subscribed_at INTEGER NOT NULL,
      PRIMARY KEY (sid, collection)
    );
    CREATE INDEX IF NOT EXISTS realtime_storage_by_collection
      ON realtime_storage_subscriptions(collection, subscribed_at, sid);
  `);
}

/**
 * API v3's `/alarm` namespace keeps connection/subscription authority and the
 * notification engine's ACK/silence state durable across isolate eviction.
 * Socket.IO notification delivery itself remains live-only in the bounded
 * per-session queue; this table is not an offline replay journal.
 */
export function migrateRealtimeAlarmNamespaceV10(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS realtime_alarm_connections (
      sid TEXT PRIMARY KEY,
      socket_sid TEXT NOT NULL UNIQUE,
      connected_at INTEGER NOT NULL,
      subscribed_at INTEGER,
      subscribe_mode TEXT CHECK (subscribe_mode IN ('accessToken', 'web')),
      read_allowed INTEGER CHECK (read_allowed IN (0, 1)),
      ack_allowed INTEGER CHECK (ack_allowed IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS realtime_alarm_connections_order
      ON realtime_alarm_connections(connected_at, sid);
    CREATE TABLE IF NOT EXISTS realtime_alarm_silences (
      level INTEGER NOT NULL,
      alarm_group TEXT NOT NULL,
      last_ack_at INTEGER NOT NULL,
      silence_time INTEGER NOT NULL,
      last_emit_at INTEGER,
      PRIMARY KEY (level, alarm_group)
    );
  `);
}

/**
 * The Node server keeps websocket `lastData` in process memory. Workers may be
 * evicted between every request, so v11 persists the one tenant-local baseline
 * used by the locked calcdelta algorithm.
 */
export function migrateRealtimeRootUpdatesV11(storage: DurableObjectStorage): void {
  storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS realtime_root_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      snapshot TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

/**
 * Root write authorization is established once by `authorize` and must remain
 * authoritative after a Durable Object/WebSocket hibernation boundary. The
 * Node server kept these flags in the per-socket closure; v12 persists them on
 * the Engine.IO session row.
 */
export function migrateRealtimeWriteAuthorityV12(storage: DurableObjectStorage): void {
  const columns = new Set(
    storage.sql
      .exec<TableInfoRow>("PRAGMA table_info(realtime_sessions)")
      .toArray()
      .map((row) => row.name),
  );
  if (!columns.has("write_allowed")) {
    storage.sql.exec(
      `ALTER TABLE realtime_sessions
       ADD COLUMN write_allowed INTEGER NOT NULL DEFAULT 0
       CHECK (write_allowed IN (0, 1))`,
    );
  }
  if (!columns.has("treatment_write_allowed")) {
    storage.sql.exec(
      `ALTER TABLE realtime_sessions
       ADD COLUMN treatment_write_allowed INTEGER NOT NULL DEFAULT 0
       CHECK (treatment_write_allowed IN (0, 1))`,
    );
  }
}

/**
 * The Node notification engine keeps lastEmitTime in a process-global Alarm
 * object. Workers can be evicted between evaluation and all-clear processing,
 * so v13 persists that single field beside the existing ACK/silence state.
 */
export function migrateRealtimeNotificationStateV13(
  storage: DurableObjectStorage,
): void {
  const columns = new Set(
    storage.sql
      .exec<TableInfoRow>("PRAGMA table_info(realtime_alarm_silences)")
      .toArray()
      .map((row) => row.name),
  );
  if (!columns.has("last_emit_at")) {
    storage.sql.exec(
      "ALTER TABLE realtime_alarm_silences ADD COLUMN last_emit_at INTEGER",
    );
  }
}

export class SqliteRealtimeSessionRepository {
  constructor(private readonly storage: DurableObjectStorage) {}

  createSession(
    now: number,
    transport: RealtimeTransport = REALTIME_TRANSPORT,
    engineProtocol: RealtimeEngineProtocol = REALTIME_ENGINE_PROTOCOL,
    jsonpIndex: string | null = null,
  ): RealtimeSession {
    const count = this.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM realtime_sessions")
      .one().count;
    if (count >= REALTIME_MAX_SESSIONS_PER_TENANT) {
      throw new RealtimeRepositoryError(
        "capacity",
        `tenant already has ${REALTIME_MAX_SESSIONS_PER_TENANT} realtime sessions`,
      );
    }

    const sid = randomSessionId();
    const socketSid = randomSessionId();
    const expiresAt = now + REALTIME_PING_INTERVAL_MS + REALTIME_PING_TIMEOUT_MS;
    // EIO3 clients own the heartbeat and therefore have no server-ping due
    // time. Reuse the expiry deadline so the shared alarm query stays bounded.
    const nextPingAt = engineProtocol === 4
      ? now + REALTIME_PING_INTERVAL_MS
      : expiresAt;
    if (jsonpIndex === null) {
      this.storage.sql.exec(
        `INSERT INTO realtime_sessions (
           sid, socket_sid, engine_protocol, transport, created_at, last_seen_at,
           next_ping_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        sid,
        socketSid,
        engineProtocol,
        transport,
        now,
        now,
        nextPingAt,
        expiresAt,
      );
    } else {
      if (transport !== REALTIME_TRANSPORT) {
        throw new RealtimeRepositoryError(
          "unknown_sid",
          "JSONP is available only for polling sessions",
        );
      }
      this.storage.sql.exec(
        `INSERT INTO realtime_sessions (
           sid, socket_sid, engine_protocol, transport, created_at, last_seen_at,
           next_ping_at, expires_at, jsonp_index
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sid,
        socketSid,
        engineProtocol,
        transport,
        now,
        now,
        nextPingAt,
        expiresAt,
        jsonpIndex,
      );
    }
    return this.requireSession(sid);
  }

  jsonpIndex(sid: string): string | null {
    const row = this.storage.sql
      .exec<{ jsonp_index: string | null }>(
        "SELECT jsonp_index FROM realtime_sessions WHERE sid = ? LIMIT 1",
        sid,
      )
      .toArray()[0];
    if (row === undefined) {
      throw new RealtimeRepositoryError("unknown_sid", "Engine.IO session is unknown");
    }
    return row.jsonp_index;
  }

  getSession(sid: string): RealtimeSession | null {
    const row = this.storage.sql
      .exec<SessionRow>(
        `SELECT sid, socket_sid, engine_protocol, transport,
                socket_connected, authorized, read_allowed,
                write_allowed, treatment_write_allowed,
                created_at, last_seen_at, next_ping_at, pong_deadline, expires_at,
                next_sequence, outbound_packets, outbound_bytes,
                poll_token, poll_deadline, post_token, post_deadline
         FROM realtime_sessions WHERE sid = ? LIMIT 1`,
        sid,
      )
      .toArray()[0];
    return row === undefined ? null : sessionFromRow(row);
  }

  requireSession(sid: string): RealtimeSession {
    const session = this.getSession(sid);
    if (session === null) {
      throw new RealtimeRepositoryError("unknown_sid", "Engine.IO session is unknown");
    }
    return session;
  }

  deleteSession(sid: string): void {
    this.storage.transactionSync(() => this.deleteSessionInTransaction(sid));
  }

  deleteSessionInTransaction(sid: string): void {
    const now = Date.now();
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO realtime_websocket_closures
         (sid, close_code, close_reason, created_at, attempt_count,
          next_attempt_at, socket_offset)
       SELECT sid, 1008, 'session unavailable', ?, 0, ?, 0
       FROM realtime_sessions
       WHERE sid = ? AND transport = 'websocket'`,
      now,
      now,
      sid,
    );
    this.deleteSessionStateInTransaction(sid);
  }

  deleteOrphanedWebSocketSessionInTransaction(sid: string): void {
    this.storage.sql.exec(
      "DELETE FROM realtime_websocket_closures WHERE sid = ?",
      sid,
    );
    this.deleteSessionStateInTransaction(sid);
  }

  private deleteSessionStateInTransaction(sid: string): void {
    this.storage.sql.exec("DELETE FROM realtime_storage_subscriptions WHERE sid = ?", sid);
    this.storage.sql.exec("DELETE FROM realtime_storage_connections WHERE sid = ?", sid);
    this.storage.sql.exec("DELETE FROM realtime_alarm_connections WHERE sid = ?", sid);
    this.storage.sql.exec("DELETE FROM realtime_outbound_packets WHERE sid = ?", sid);
    this.storage.sql.exec("DELETE FROM realtime_sessions WHERE sid = ?", sid);
  }

  listWebSocketSessionIds(): string[] {
    return this.storage.sql
      .exec<SidRow>(
        `SELECT sid
         FROM realtime_sessions
         WHERE transport = 'websocket'
         ORDER BY created_at, sid
         LIMIT ?`,
        REALTIME_MAX_SESSIONS_PER_TENANT,
      )
      .toArray()
      .map((row) => row.sid);
  }

  connectStorageNamespace(sid: string, now: number): string | null {
    this.requireSession(sid);
    const existing = this.storage.sql
      .exec<SidRow>(
        "SELECT socket_sid AS sid FROM realtime_storage_connections WHERE sid = ? LIMIT 1",
        sid,
      )
      .toArray()[0];
    if (existing !== undefined) return null;
    const socketSid = randomSessionId();
    this.storage.sql.exec(
      `INSERT INTO realtime_storage_connections (sid, socket_sid, connected_at)
       VALUES (?, ?, ?)`,
      sid,
      socketSid,
      now,
    );
    return socketSid;
  }

  storageNamespaceConnected(sid: string): boolean {
    return this.storage.sql
      .exec<CountRow>(
        `SELECT EXISTS(
           SELECT 1 FROM realtime_storage_connections WHERE sid = ?
         ) AS count`,
        sid,
      )
      .one().count === 1;
  }

  disconnectStorageNamespace(sid: string): void {
    this.storage.sql.exec("DELETE FROM realtime_storage_subscriptions WHERE sid = ?", sid);
    this.storage.sql.exec("DELETE FROM realtime_storage_connections WHERE sid = ?", sid);
  }

  addStorageSubscriptions(
    sid: string,
    collections: readonly string[],
    now: number,
  ): void {
    if (!this.storageNamespaceConnected(sid)) {
      throw new RealtimeRepositoryError("unknown_sid", "storage namespace is not connected");
    }
    for (const collection of new Set(collections)) {
      this.storage.sql.exec(
        `INSERT OR IGNORE INTO realtime_storage_subscriptions
           (sid, collection, subscribed_at)
         VALUES (?, ?, ?)`,
        sid,
        collection,
        now,
      );
    }
  }

  listStorageSubscriberSessionIds(collection: string, now: number): string[] {
    return this.storage.sql
      .exec<SidRow>(
        `SELECT session.sid AS sid
         FROM realtime_storage_subscriptions AS subscription
         INNER JOIN realtime_storage_connections AS connection
           ON connection.sid = subscription.sid
         INNER JOIN realtime_sessions AS session
           ON session.sid = subscription.sid
         WHERE subscription.collection = ?
           AND (
             (
               session.transport = 'polling'
               AND session.last_seen_at > ?
             )
             OR (
               session.transport = 'websocket'
             )
           )
         ORDER BY subscription.subscribed_at, session.created_at, session.sid
         LIMIT ?`,
        collection,
        now - REALTIME_POLL_STALE_SESSION_MS,
        REALTIME_MAX_SESSIONS_PER_TENANT,
      )
      .toArray()
      .map((row) => row.sid);
  }

  connectAlarmNamespace(sid: string, now: number): string | null {
    this.requireSession(sid);
    const existing = this.storage.sql
      .exec<SidRow>(
        "SELECT socket_sid AS sid FROM realtime_alarm_connections WHERE sid = ? LIMIT 1",
        sid,
      )
      .toArray()[0];
    if (existing !== undefined) return null;
    const socketSid = randomSessionId();
    this.storage.sql.exec(
      `INSERT INTO realtime_alarm_connections (sid, socket_sid, connected_at)
       VALUES (?, ?, ?)`,
      sid,
      socketSid,
      now,
    );
    return socketSid;
  }

  alarmNamespaceConnected(sid: string): boolean {
    return this.storage.sql
      .exec<CountRow>(
        `SELECT EXISTS(
           SELECT 1 FROM realtime_alarm_connections WHERE sid = ?
         ) AS count`,
        sid,
      )
      .one().count === 1;
  }

  disconnectAlarmNamespace(sid: string): void {
    this.storage.sql.exec("DELETE FROM realtime_alarm_connections WHERE sid = ?", sid);
  }

  setAlarmSubscription(
    sid: string,
    mode: "accessToken" | "web",
    readAllowed: boolean,
    ackAllowed: boolean,
    now: number,
  ): void {
    const written = this.storage.sql.exec(
      `UPDATE realtime_alarm_connections
       SET subscribed_at = ?, subscribe_mode = ?, read_allowed = ?,
           ack_allowed = MAX(COALESCE(ack_allowed, 0), ?)
       WHERE sid = ?`,
      now,
      mode,
      readAllowed ? 1 : 0,
      ackAllowed ? 1 : 0,
      sid,
    ).rowsWritten;
    if (written !== 1) {
      throw new RealtimeRepositoryError("unknown_sid", "alarm namespace is not connected");
    }
  }

  alarmAckAllowed(sid: string): boolean {
    return this.storage.sql
      .exec<CountRow>(
        `SELECT EXISTS(
           SELECT 1 FROM realtime_alarm_connections
           WHERE sid = ? AND subscribed_at IS NOT NULL AND ack_allowed = 1
         ) AS count`,
        sid,
      )
      .one().count === 1;
  }

  listAlarmConnectionSessionIds(now: number): string[] {
    return this.storage.sql
      .exec<SidRow>(
        `SELECT session.sid AS sid
         FROM realtime_alarm_connections AS connection
         INNER JOIN realtime_sessions AS session ON session.sid = connection.sid
         WHERE (
           (
             session.transport = 'polling'
             AND session.last_seen_at > ?
           )
           OR (
             session.transport = 'websocket'
           )
         )
         ORDER BY connection.connected_at, session.created_at, session.sid
         LIMIT ?`,
        now - REALTIME_POLL_STALE_SESSION_MS,
        REALTIME_MAX_SESSIONS_PER_TENANT,
      )
      .toArray()
      .map((row) => row.sid);
  }

  alarmState(level: number, group: string): RealtimeAlarmState {
    const row = this.storage.sql
      .exec<AlarmSilenceRow>(
        `SELECT last_ack_at, silence_time, last_emit_at
         FROM realtime_alarm_silences
         WHERE level = ? AND alarm_group = ? LIMIT 1`,
        level,
        group,
      )
      .toArray()[0];
    return {
      level,
      group,
      lastAckAt: row?.last_ack_at ?? 0,
      silenceTime: row?.silence_time ?? 30 * 60 * 1_000,
      lastEmitAt: row?.last_emit_at ?? null,
    };
  }

  alarmGroups(): string[] {
    return this.storage.sql
      .exec<{ alarm_group: string }>(
        `SELECT DISTINCT alarm_group
         FROM realtime_alarm_silences
         ORDER BY alarm_group
         LIMIT ?`,
        REALTIME_MAX_ALARM_GROUPS,
      )
      .toArray()
      .map((row) => row.alarm_group);
  }

  markAlarmEmitted(level: number, group: string, lastUpdated: number): boolean {
    if (!this.alarmGroupCanBeCreated(group)) return false;
    this.storage.sql.exec(
      `INSERT INTO realtime_alarm_silences
         (level, alarm_group, last_ack_at, silence_time, last_emit_at)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(level, alarm_group) DO UPDATE SET
         last_emit_at = excluded.last_emit_at`,
      level,
      group,
      30 * 60 * 1_000,
      lastUpdated,
    );
    return true;
  }

  ackAlarm(level: number, group: string, silenceTime: number, now: number): boolean {
    const accepted = this.ackAlarmLevel(level, group, silenceTime, now);
    if (!accepted) return false;
    // Locked notifications.ack() also silences Warning when Urgent is ACKed,
    // but sends one clear notification for the original Urgent level only.
    if (level === 2) this.ackAlarmLevel(1, group, silenceTime, now);
    return true;
  }

  private ackAlarmLevel(
    level: number,
    group: string,
    silenceTime: number,
    now: number,
  ): boolean {
    const current = this.storage.sql
      .exec<AlarmSilenceRow>(
        `SELECT last_ack_at, silence_time
         FROM realtime_alarm_silences
         WHERE level = ? AND alarm_group = ? LIMIT 1`,
        level,
        group,
      )
      .toArray()[0];
    if (current !== undefined && now < current.last_ack_at + current.silence_time) {
      return false;
    }
    if (current === undefined && !this.alarmGroupCanBeCreated(group)) return false;
    this.storage.sql.exec(
      `INSERT INTO realtime_alarm_silences
         (level, alarm_group, last_ack_at, silence_time, last_emit_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(level, alarm_group) DO UPDATE SET
         last_ack_at = excluded.last_ack_at,
         silence_time = excluded.silence_time,
         last_emit_at = NULL`,
      level,
      group,
      now,
      silenceTime,
    );
    return true;
  }

  private alarmGroupCanBeCreated(group: string): boolean {
    const groupExists = this.storage.sql.exec<CountRow>(
      `SELECT EXISTS(
         SELECT 1 FROM realtime_alarm_silences WHERE alarm_group = ?
       ) AS count`,
      group,
    ).one().count === 1;
    if (groupExists) return true;
    return this.storage.sql
      .exec<CountRow>(
        "SELECT COUNT(DISTINCT alarm_group) AS count FROM realtime_alarm_silences",
      )
      .one().count < REALTIME_MAX_ALARM_GROUPS;
  }

  cleanupOpportunity(
    now: number,
    limit = REALTIME_CLEANUP_BATCH,
  ): ExpiredRealtimeSession[] {
    return this.storage.transactionSync(() =>
      this.cleanupOpportunityInTransaction(now, limit),
    );
  }

  cleanupOpportunityInTransaction(
    now: number,
    limit = REALTIME_CLEANUP_BATCH,
  ): ExpiredRealtimeSession[] {
    const boundedLimit = Math.max(1, Math.min(REALTIME_CLEANUP_BATCH, Math.trunc(limit)));
    const expired = this.storage.sql
      .exec<SessionRow>(
        `SELECT sid, socket_sid, engine_protocol, transport,
                socket_connected, authorized, read_allowed,
                write_allowed, treatment_write_allowed,
                created_at, last_seen_at, next_ping_at, pong_deadline, expires_at,
                next_sequence, outbound_packets, outbound_bytes,
                poll_token, poll_deadline, post_token, post_deadline
         FROM realtime_sessions
         WHERE transport = 'polling'
           AND last_seen_at <= ?
         ORDER BY last_seen_at, expires_at, sid
         LIMIT ?`,
        now - REALTIME_POLL_STALE_SESSION_MS,
        boundedLimit,
      )
      .toArray()
      .map((row) => ({ sid: row.sid, socketConnected: row.socket_connected === 1 }));
    for (const session of expired) this.deleteSessionInTransaction(session.sid);

    return expired;
  }

  nextDeadline(): number | null {
    // WebSocket heartbeat deadlines live in hibernatable attachments. SQLite
    // retains only application frames and durable close retries.
    return this.storage.sql
      .exec<DeadlineRow>(
        `SELECT MIN(deadline) AS deadline
         FROM (
           SELECT MIN(packet.created_at) AS deadline
           FROM realtime_outbound_packets AS packet
           INNER JOIN realtime_sessions AS session ON session.sid = packet.sid
           WHERE session.transport = 'websocket'
           UNION ALL
           SELECT MIN(next_attempt_at) AS deadline
           FROM realtime_websocket_closures
         )`,
      )
      .one().deadline;
  }

  updateSession(session: RealtimeSession): void {
    this.storage.sql.exec(
      `UPDATE realtime_sessions SET
         engine_protocol = ?, transport = ?,
         socket_sid = ?, socket_connected = ?, authorized = ?, read_allowed = ?,
         write_allowed = ?, treatment_write_allowed = ?,
         last_seen_at = ?, next_ping_at = ?, pong_deadline = ?, expires_at = ?,
         poll_token = ?, poll_deadline = ?, post_token = ?, post_deadline = ?
       WHERE sid = ?`,
      session.engineProtocol,
      session.transport,
      session.socketSid,
      session.socketConnected ? 1 : 0,
      session.authorized ? 1 : 0,
      session.readAllowed ? 1 : 0,
      session.writeAllowed ? 1 : 0,
      session.treatmentWriteAllowed ? 1 : 0,
      session.lastSeenAt,
      session.nextPingAt,
      session.pongDeadline,
      session.expiresAt,
      session.pollToken,
      session.pollDeadline,
      session.postToken,
      session.postDeadline,
      session.sid,
    );
  }

  setPostLease(sid: string, token: string, deadline: number): void {
    this.storage.sql.exec(
      `UPDATE realtime_sessions
       SET post_token = ?, post_deadline = ?
       WHERE sid = ?`,
      token,
      deadline,
      sid,
    );
  }

  clearPostLease(sid: string, token: string): void {
    this.storage.sql.exec(
      `UPDATE realtime_sessions
       SET post_token = NULL, post_deadline = NULL
       WHERE sid = ? AND post_token = ?`,
      sid,
      token,
    );
  }

  scheduleWebSocketClosure(
    sid: string,
    code: number,
    reason: string,
    createdAt: number,
    nextAttemptAt: number,
  ): void {
    this.storage.sql.exec(
      `INSERT INTO realtime_websocket_closures
         (sid, close_code, close_reason, created_at, attempt_count,
          next_attempt_at, socket_offset)
       VALUES (?, ?, ?, ?, 0, ?, 0)
       ON CONFLICT(sid) DO UPDATE SET
         close_code = excluded.close_code,
         close_reason = excluded.close_reason,
         created_at = excluded.created_at,
         attempt_count = 0,
         next_attempt_at = excluded.next_attempt_at,
         socket_offset = 0`,
      sid,
      code,
      reason,
      createdAt,
      nextAttemptAt,
    );
  }

  webSocketClosureDeadline(sid: string): number | null {
    return this.storage.sql
      .exec<DeadlineRow>(
        `SELECT next_attempt_at AS deadline
         FROM realtime_websocket_closures
         WHERE sid = ?
         LIMIT 1`,
        sid,
      )
      .toArray()[0]?.deadline ?? null;
  }

  cancelWebSocketClosure(sid: string): void {
    this.storage.sql.exec(
      "DELETE FROM realtime_websocket_closures WHERE sid = ?",
      sid,
    );
  }

  countConnectedSessions(now: number): number {
    return this.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count
         FROM realtime_sessions
         WHERE socket_connected = 1
           AND (
             (
               transport = 'polling'
               AND last_seen_at > ?
             )
             OR (
               transport = 'websocket'
             )
           )`,
        now - REALTIME_POLL_STALE_SESSION_MS,
      )
      .one().count;
  }

  listConnectedSessionIds(
    now: number,
    transport?: RealtimeTransport,
  ): string[] {
    const transportClause = transport === undefined ? "" : " AND transport = ?";
    const bindings: SqlStorageValue[] = transport === undefined
      ? [
        now - REALTIME_POLL_STALE_SESSION_MS,
        REALTIME_MAX_SESSIONS_PER_TENANT,
      ]
      : [
        now - REALTIME_POLL_STALE_SESSION_MS,
        transport,
        REALTIME_MAX_SESSIONS_PER_TENANT,
      ];
    return this.storage.sql
      .exec<SessionRow>(
        `SELECT sid, socket_sid, engine_protocol, transport,
                socket_connected, authorized, read_allowed,
                write_allowed, treatment_write_allowed,
                created_at, last_seen_at, next_ping_at, pong_deadline, expires_at,
                next_sequence, outbound_packets, outbound_bytes,
                poll_token, poll_deadline, post_token, post_deadline
         FROM realtime_sessions
         WHERE socket_connected = 1
           AND (
             (
               transport = 'polling'
               AND last_seen_at > ?
             )
             OR (
               transport = 'websocket'
             )
           )${transportClause}
         ORDER BY created_at, sid
         LIMIT ?`,
        ...bindings,
      )
      .toArray()
      .map((row) => row.sid);
  }

  listDataReceiverSessionIds(now: number): string[] {
    return this.storage.sql
      .exec<SidRow>(
        `SELECT sid
         FROM realtime_sessions
         WHERE socket_connected = 1
           AND authorized = 1
           AND read_allowed = 1
           AND (
             (
               transport = 'polling'
               AND last_seen_at > ?
             )
             OR (
               transport = 'websocket'
             )
           )
         ORDER BY created_at, sid
         LIMIT ?`,
        now - REALTIME_POLL_STALE_SESSION_MS,
        REALTIME_MAX_SESSIONS_PER_TENANT,
      )
      .toArray()
      .map((row) => row.sid);
  }

  hasDataReceiverSession(now: number): boolean {
    return this.storage.sql
      .exec<CountRow>(
        `SELECT EXISTS(
           SELECT 1
           FROM realtime_sessions
           WHERE socket_connected = 1
             AND authorized = 1
             AND read_allowed = 1
             AND (
               (
                 transport = 'polling'
                 AND last_seen_at > ?
               )
               OR (
                 transport = 'websocket'
               )
             )
         ) AS count`,
        now - REALTIME_POLL_STALE_SESSION_MS,
      )
      .one().count !== 0;
  }

  rootDataStateJson(): string | null {
    return this.storage.sql
      .exec<RootDataStateRow>(
        "SELECT snapshot FROM realtime_root_state WHERE singleton = 1 LIMIT 1",
      )
      .toArray()[0]?.snapshot ?? null;
  }

  initializeRootDataState(snapshot: string, now: number): void {
    this.storage.sql.exec(
      `INSERT OR IGNORE INTO realtime_root_state (singleton, snapshot, updated_at)
       VALUES (1, ?, ?)`,
      snapshot,
      now,
    );
  }

  replaceRootDataState(snapshot: string, now: number): void {
    this.storage.sql.exec(
      `INSERT INTO realtime_root_state (singleton, snapshot, updated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         snapshot = excluded.snapshot,
         updated_at = excluded.updated_at`,
      snapshot,
      now,
    );
  }

  listQueuedWebSocketSessionIds(limit: number): string[] {
    const boundedLimit = Math.max(
      1,
      Math.min(REALTIME_MAX_SESSIONS_PER_TENANT, Math.trunc(limit)),
    );
    return this.storage.sql
      .exec<SidRow>(
        `SELECT session.sid AS sid
         FROM realtime_sessions AS session
         INNER JOIN realtime_outbound_packets AS packet ON packet.sid = session.sid
         WHERE session.transport = 'websocket'
         GROUP BY session.sid
         ORDER BY MIN(packet.created_at), session.sid
         LIMIT ?`,
        boundedLimit,
      )
      .toArray()
      .map((row) => row.sid);
  }

  takeWebSocketClosures(limit: number, now: number): RealtimeWebSocketClosure[] {
    const boundedLimit = Math.max(
      1,
      Math.min(REALTIME_MAX_SESSIONS_PER_TENANT, Math.trunc(limit)),
    );
    const rows = this.storage.sql
      .exec<WebSocketClosureRow>(
        `SELECT sid, close_code, close_reason, created_at, attempt_count,
                next_attempt_at, socket_offset
         FROM realtime_websocket_closures
         WHERE next_attempt_at <= ?
         ORDER BY next_attempt_at, created_at, sid
         LIMIT ?`,
        now,
        boundedLimit,
      )
      .toArray();
    for (const row of rows) {
      this.storage.sql.exec(
        "DELETE FROM realtime_websocket_closures WHERE sid = ?",
        row.sid,
      );
    }
    return rows.map((row) => ({
      sid: row.sid,
      code: row.close_code,
      reason: row.close_reason,
      createdAt: row.created_at,
      attemptCount: row.attempt_count,
      nextAttemptAt: row.next_attempt_at,
      socketOffset: row.socket_offset,
    }));
  }

  requeueWebSocketClosure(
    closure: RealtimeWebSocketClosure,
    retry: RealtimeWebSocketClosureRetry,
    now: number,
  ): void {
    if (!retry.budgetDeferred && !retry.closeFailed) return;
    const attemptCount = retry.closeFailed
      ? Math.min(closure.attemptCount + 1, 31)
      : closure.attemptCount;
    let nextAttemptAt: number;
    if (retry.closeFailed) {
      const exponent = Math.min(closure.attemptCount, 30);
      const retryDelay = Math.min(
        REALTIME_WEBSOCKET_CLOSE_RETRY_MAX_MS,
        REALTIME_WEBSOCKET_CLOSE_RETRY_BASE_MS * (2 ** exponent),
      );
      // A real close failure always wins over the short budget continuation.
      // Otherwise a corrupt SID with more than one batch of sockets can retain
      // both conditions forever and wake the object at 10 Hz.
      nextAttemptAt = now + retryDelay;
    } else {
      nextAttemptAt = now + REALTIME_WEBSOCKET_CLOSE_CONTINUATION_MS;
    }
    this.storage.sql.exec(
      `INSERT INTO realtime_websocket_closures
         (sid, close_code, close_reason, created_at, attempt_count,
          next_attempt_at, socket_offset)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sid) DO UPDATE SET
         close_code = excluded.close_code,
         close_reason = excluded.close_reason,
         created_at = MIN(realtime_websocket_closures.created_at, excluded.created_at),
         attempt_count = MAX(
           realtime_websocket_closures.attempt_count,
           excluded.attempt_count
         ),
         next_attempt_at = MIN(
           realtime_websocket_closures.next_attempt_at,
           excluded.next_attempt_at
         ),
         socket_offset = excluded.socket_offset`,
      closure.sid,
      closure.code,
      closure.reason,
      closure.createdAt,
      attemptCount,
      nextAttemptAt,
      Math.max(0, Math.trunc(retry.nextSocketOffset)),
    );
  }

  enqueueFrames(sid: string, frames: readonly string[], now: number): void {
    if (frames.length === 0) return;
    const session = this.requireSession(sid);
    const encoded: Array<{ frame: string; bytes: number }> = [];
    let addedBytes = 0;
    for (const frame of frames) {
      const canonical = session.engineProtocol === 3
        ? encodeEngineIoV3Packet(decodeEngineIoV3Packet(frame))
        : encodeEngineIoV4Packet(decodeEngineIoV4Packet(frame));
      if (
        canonical !== frame
        || (session.engineProtocol === 4
          && canonical.includes(ENGINE_IO_V4_POLLING_SEPARATOR))
      ) {
        throw new RealtimeRepositoryError("queue_overflow", "outbound packet is not canonical");
      }
      const bytes = new TextEncoder().encode(frame).byteLength;
      encoded.push({ frame, bytes });
      addedBytes += bytes;
    }

    const totalPackets = session.outboundPackets + encoded.length;
    const totalBytes = session.outboundBytes + addedBytes;
    // EIO3 prefixes each frame with a decimal UTF-16 length and a colon.
    // Twelve bytes per queued frame is a conservative bound for the parser's
    // ten-digit header cap; EIO4 uses one separator between frames.
    const framedBytes = session.engineProtocol === 3
      ? totalBytes + totalPackets * 12
      : totalBytes + Math.max(0, totalPackets - 1);
    if (
      totalPackets > REALTIME_MAX_QUEUE_PACKETS ||
      totalBytes > REALTIME_MAX_QUEUE_BYTES ||
      framedBytes > REALTIME_MAX_PAYLOAD_BYTES
    ) {
      throw new RealtimeRepositoryError(
        "queue_overflow",
        "realtime outbound queue reached its bounded capacity",
      );
    }

    let sequence = session.nextSequence;
    for (const packet of encoded) {
      this.storage.sql.exec(
        `INSERT INTO realtime_outbound_packets
           (sid, sequence, packet, byte_length, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        sid,
        sequence,
        packet.frame,
        packet.bytes,
        now,
      );
      sequence += 1;
    }
    this.storage.sql.exec(
      `UPDATE realtime_sessions
       SET next_sequence = ?, outbound_packets = ?, outbound_bytes = ?
       WHERE sid = ?`,
      sequence,
      totalPackets,
      totalBytes,
      sid,
    );
  }

  dequeueFrames(
    sid: string,
    maxPackets = REALTIME_MAX_QUEUE_PACKETS,
    maxBytes = REALTIME_MAX_PAYLOAD_BYTES,
  ): string[] {
    const batch = this.peekFrames(sid, maxPackets, maxBytes);
    if (batch === null) return [];
    this.acknowledgeFrames(sid, batch);
    return batch.frames;
  }

  peekFrames(
    sid: string,
    maxPackets = REALTIME_MAX_QUEUE_PACKETS,
    maxBytes = REALTIME_MAX_PAYLOAD_BYTES,
  ): RealtimeWebSocketFrameBatch | null {
    const session = this.requireSession(sid);
    if (session.outboundPackets === 0) return null;
    const boundedPackets = Math.max(
      1,
      Math.min(REALTIME_MAX_QUEUE_PACKETS, Math.trunc(maxPackets)),
    );
    const boundedBytes = Math.max(
      1,
      Math.min(REALTIME_MAX_PAYLOAD_BYTES, Math.trunc(maxBytes)),
    );
    const rows = this.storage.sql
      .exec<QueueRow>(
        `SELECT sequence, packet, byte_length
         FROM realtime_outbound_packets
         WHERE sid = ?
         ORDER BY sequence
         LIMIT ?`,
        sid,
        boundedPackets,
      )
      .toArray();
    if (rows.length === 0) {
      throw new Error("realtime queue counters do not match stored packets");
    }

    const selected: QueueRow[] = [];
    let selectedBytes = 0;
    for (const row of rows) {
      if (selectedBytes + row.byte_length > boundedBytes) break;
      selected.push(row);
      selectedBytes += row.byte_length;
    }
    // Leave a large first frame durable when the caller has already spent its
    // global turn budget. A fresh alarm invocation can send it with a full
    // budget without reordering later frames.
    if (selected.length === 0) return null;

    const frames = selected.map((row) => row.packet);
    const payload = session.engineProtocol === 3
      ? encodeEngineIoV3PollingPayload(frames.map((frame) => decodeEngineIoV3Packet(frame)))
      : frames.join(ENGINE_IO_V4_POLLING_SEPARATOR);
    const payloadBytes = new TextEncoder().encode(payload).byteLength;
    if (payloadBytes > REALTIME_MAX_PAYLOAD_BYTES) {
      throw new Error("stored realtime payload exceeds the advertised maxPayload");
    }
    return {
      frames,
      lastSequence: selected[selected.length - 1]!.sequence,
      packetCount: selected.length,
      byteLength: selectedBytes,
    };
  }

  acknowledgeFrames(sid: string, batch: RealtimeWebSocketFrameBatch): void {
    const session = this.requireSession(sid);
    if (
      batch.packetCount <= 0
      || batch.packetCount > session.outboundPackets
      || batch.byteLength < 0
      || batch.byteLength > session.outboundBytes
      || !Number.isSafeInteger(batch.lastSequence)
    ) {
      throw new Error("realtime acknowledgement does not fit the stored queue");
    }
    const prefix = this.storage.sql.exec<QueuePrefixRow>(
      `SELECT COUNT(*) AS packet_count,
              COALESCE(SUM(byte_length), 0) AS byte_length,
              MAX(sequence) AS last_sequence
       FROM realtime_outbound_packets
       WHERE sid = ? AND sequence <= ?`,
      sid,
      batch.lastSequence,
    ).one();
    if (
      prefix.packet_count !== batch.packetCount
      || prefix.byte_length !== batch.byteLength
      || prefix.last_sequence !== batch.lastSequence
    ) {
      throw new Error("realtime acknowledgement no longer matches the stored FIFO prefix");
    }
    this.storage.sql.exec(
      `DELETE FROM realtime_outbound_packets
       WHERE sid = ? AND sequence <= ?`,
      sid,
      batch.lastSequence,
    );
    this.storage.sql.exec(
      `UPDATE realtime_sessions
       SET outbound_packets = outbound_packets - ?,
           outbound_bytes = outbound_bytes - ?
       WHERE sid = ?`,
      batch.packetCount,
      batch.byteLength,
      sid,
    );
  }

  dequeuePayload(sid: string): string | null {
    const session = this.requireSession(sid);
    const frames = this.dequeueFrames(sid);
    return frames.length === 0
      ? null
      : session.engineProtocol === 3
        ? encodeEngineIoV3PollingPayload(
          frames.map((frame) => decodeEngineIoV3Packet(frame)),
        )
        : frames.join(ENGINE_IO_V4_POLLING_SEPARATOR);
  }
}
