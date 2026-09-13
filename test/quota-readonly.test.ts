import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  ENTRY_STORE_ACTIVATION_SEAL,
  entryStoreSchemaIsActivationReady,
  entryStoreSchemaSupportsCoreReadOnly,
  entryStoreSchemaSupportsReadOnly,
  type EntryStore,
} from "../src/entry-store";
import { SqliteRealtimeSessionRepository } from "../src/realtime/session-repository";
import { RealtimeSessionError } from "../src/realtime/session-service";

describe("SQLite write-quota read-only fallback", () => {
  it("does not rerun migrations after an activation seal survives eviction", async () => {
    const stub = env.ENTRY_STORE.getByName(
      `quota-sealed-eviction-${crypto.randomUUID().slice(0, 8)}`,
    );
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER reject_repeated_activation
        BEFORE INSERT ON _sql_schema_migrations
        BEGIN
          SELECT RAISE(ABORT, 'sealed activation attempted a write');
        END;
      `);
    });

    await evictDurableObject(stub);
    expect(JSON.parse(await stub.nightscoutHttpStatus(Date.now()))).toMatchObject({
      status: "ok",
    });
  });

  it("uses a zero-write activation preflight after the schema is ready", async () => {
    const stub = env.ENTRY_STORE.getByName(
      `quota-activation-${crypto.randomUUID().slice(0, 8)}`,
    );
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      let writeAttempts = 0;
      const exec = state.storage.sql.exec.bind(state.storage.sql);
      const guardedSql = new Proxy(state.storage.sql, {
        get(target, property, receiver) {
          if (property !== "exec") return Reflect.get(target, property, receiver);
          return (statement: string, ...bindings: SqlStorageValue[]) => {
            if (
              /^\s*(?:ALTER|CREATE|DELETE|DROP|INSERT|REPLACE|UPDATE)\b/i.test(
                statement,
              )
            ) {
              writeAttempts += 1;
              throw new Error("Exceeded allowed rows written");
            }
            return exec(statement, ...bindings);
          };
        },
      }) as SqlStorage;

      expect(entryStoreSchemaIsActivationReady(guardedSql)).toBe(true);
      expect(writeAttempts).toBe(0);
    });
  });

  it("keeps core HTTP reads eligible when optional migration artifacts are missing", async () => {
    const stub = env.ENTRY_STORE.getByName(
      `quota-core-read-${crypto.randomUUID().slice(0, 8)}`,
    );
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
      state.storage.sql.exec(
        "DELETE FROM _sql_schema_migrations WHERE id IN (22, ?)",
        ENTRY_STORE_ACTIVATION_SEAL,
      );
      state.storage.sql.exec(
        "DELETE FROM realtime_root_state WHERE singleton = 1",
      );

      expect(entryStoreSchemaIsActivationReady(state.storage.sql)).toBe(false);
      expect(entryStoreSchemaSupportsReadOnly(state.storage.sql)).toBe(false);
      expect(entryStoreSchemaSupportsCoreReadOnly(state.storage.sql)).toBe(true);

      const internal = instance as unknown as {
        storageWriteQuotaBlockedUntil: number;
      };
      internal.storageWriteQuotaBlockedUntil = Date.now() + 60_000;
      expect(JSON.parse(instance.nightscoutHttpStatus(Date.now()))).toMatchObject({
        status: "ok",
      });
      await expect(instance.listDocuments("roles")).resolves.toBe("[]");
    });
  });

  it("requires every migration marker and the exact Entries contract", async () => {
    const stub = env.ENTRY_STORE.getByName(
      `quota-readonly-${crypto.randomUUID().slice(0, 8)}`,
    );
    await runInDurableObject(stub, async (_instance: EntryStore, state) => {
      expect(entryStoreSchemaSupportsReadOnly(state.storage.sql)).toBe(true);

      state.storage.sql.exec(
        "DELETE FROM _sql_schema_migrations WHERE id = 10",
      );
      expect(entryStoreSchemaSupportsReadOnly(state.storage.sql)).toBe(false);
      state.storage.sql.exec(
        "INSERT INTO _sql_schema_migrations (id) VALUES (10)",
      );

      state.storage.sql.exec("DROP INDEX entries_date_desc");
      expect(entryStoreSchemaSupportsReadOnly(state.storage.sql)).toBe(false);
    });
  });

  it("automatically leaves quota mode at the next UTC reset", async () => {
    vi.useFakeTimers();
    try {
      const stub = env.ENTRY_STORE.getByName(
        `quota-reset-${crypto.randomUUID().slice(0, 8)}`,
      );
      await runInDurableObject(stub, async (instance: EntryStore) => {
        const internal = instance as unknown as {
          storageWriteQuotaBlockedUntil: number;
          storageWritesBlocked: () => boolean;
        };
        internal.storageWriteQuotaBlockedUntil =
          Date.parse("2026-07-26T00:00:00.000Z");

        vi.setSystemTime("2026-07-25T23:59:59.000Z");
        expect(internal.storageWritesBlocked()).toBe(true);

        vi.setSystemTime("2026-07-26T00:00:00.000Z");
        expect(internal.storageWritesBlocked()).toBe(false);
        expect(internal.storageWriteQuotaBlockedUntil).toBe(0);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes an interrupted schema activation before reopening writes", async () => {
    vi.useFakeTimers();
    try {
      const stub = env.ENTRY_STORE.getByName(
        `quota-schema-reset-${crypto.randomUUID().slice(0, 8)}`,
      );
      await runInDurableObject(stub, async (instance: EntryStore, state) => {
        state.storage.sql.exec(
          "DELETE FROM _sql_schema_migrations WHERE id = ?",
          ENTRY_STORE_ACTIVATION_SEAL,
        );
        const internal = instance as unknown as {
          storageWriteQuotaBlockedUntil: number;
          storageSchemaInitializationPending: boolean;
          storageWritesBlocked: () => boolean;
        };
        internal.storageSchemaInitializationPending = true;
        internal.storageWriteQuotaBlockedUntil =
          Date.parse("2026-07-26T00:00:00.000Z");

        vi.setSystemTime("2026-07-25T23:59:59.000Z");
        expect(internal.storageWritesBlocked()).toBe(true);
        expect(entryStoreSchemaIsActivationReady(state.storage.sql)).toBe(false);

        vi.setSystemTime("2026-07-26T00:00:00.000Z");
        expect(internal.storageWritesBlocked()).toBe(false);
        expect(internal.storageSchemaInitializationPending).toBe(false);
        expect(entryStoreSchemaIsActivationReady(state.storage.sql)).toBe(true);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks subsequent realtime work after a wrapped storage-quota error", async () => {
    const stub = env.ENTRY_STORE.getByName(
      `quota-wrapped-realtime-${crypto.randomUUID().slice(0, 8)}`,
    );
    await runInDurableObject(stub, async (instance: EntryStore) => {
      const internal = instance as unknown as {
        storageWriteQuotaBlockedUntil: number;
        realtimeScheduledResult: (
          operation: () => unknown,
        ) => Promise<{
          ok: boolean;
          error?: { code: string; message: string };
        }>;
      };
      let operations = 0;

      const first = await internal.realtimeScheduledResult(() => {
        operations += 1;
        throw new RealtimeSessionError(
          "storage_quota",
          "Temporary storage quota exceeded",
        );
      });
      const second = await internal.realtimeScheduledResult(() => {
        operations += 1;
        return "must not execute";
      });

      expect(first).toMatchObject({
        ok: false,
        error: { code: "storage_quota" },
      });
      expect(second).toMatchObject({
        ok: false,
        error: { code: "storage_quota" },
      });
      expect(operations).toBe(1);
      expect(internal.storageWriteQuotaBlockedUntil).toBeGreaterThan(Date.now());
    });
  });

  it("marks a consumed blocked alarm for lazy recovery", async () => {
    const stub = env.ENTRY_STORE.getByName(
      `quota-alarm-recovery-${crypto.randomUUID().slice(0, 8)}`,
    );
    await runInDurableObject(stub, async (instance: EntryStore) => {
      const internal = instance as unknown as {
        storageWriteQuotaBlockedUntil: number;
        realtimeAlarmRecoveryPending: boolean;
      };
      internal.storageWriteQuotaBlockedUntil = Date.now() + 60_000;

      await expect(instance.alarm()).resolves.toBeUndefined();
      expect(internal.realtimeAlarmRecoveryPending).toBe(true);
    });
  });

  it("closes an existing WebSocket without mutating its durable session while blocked", async () => {
    const stub = env.ENTRY_STORE.getByName(
      `quota-websocket-${crypto.randomUUID().slice(0, 8)}`,
    );
    await runInDurableObject(stub, async (instance: EntryStore, state) => {
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
        mode: "session",
      });
      client.accept();

      const before = state.storage.sql.exec<Record<string, SqlStorageValue>>(
        "SELECT * FROM realtime_sessions WHERE sid = ?",
        session.sid,
      ).one();
      const internal = instance as unknown as {
        storageWriteQuotaBlockedUntil: number;
      };
      internal.storageWriteQuotaBlockedUntil = Date.now() + 60_000;

      await instance.webSocketMessage(server, "2");

      const after = state.storage.sql.exec<Record<string, SqlStorageValue>>(
        "SELECT * FROM realtime_sessions WHERE sid = ?",
        session.sid,
      ).one();
      expect(after).toEqual(before);
    });
  });
});
