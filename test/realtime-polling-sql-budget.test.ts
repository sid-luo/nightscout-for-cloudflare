import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { EntryStore } from "../src/entry-store";
import { decodeEngineIoV4PollingPayload, encodeEngineIoV4PollingPayload, wrapSocketIoV5Packet } from "../src/protocol";
import { RealtimeSessionError, RealtimeSessionService } from "../src/realtime/session-service";
import { migrateRealtimeOutboundIndexV29, SqliteRealtimeSessionRepository } from "../src/realtime/session-repository";

type Measurement = { label: string; reads: number; writes: number; queries: { sql: string; calls: number; reads: number; writes: number }[] };

/** Count runtime cursor work, including index writes, not SQLite total_changes(). */
function recorder(storage: DurableObjectStorage) {
  const exec = storage.sql.exec.bind(storage.sql);
  const cursors: { sql: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }[] = [];
  const spy = vi.spyOn(storage.sql, "exec").mockImplementation((statement, ...bindings) => {
    const cursor = exec(statement, ...bindings);
    cursors.push({ sql: statement.replace(/\s+/g, " ").trim(), cursor });
    return cursor;
  });
  return {
    restore: () => spy.mockRestore(),
    take(label: string): Measurement {
      const groups = new Map<string, { calls: number; reads: number; writes: number }>();
      for (const { sql, cursor } of cursors) {
        const group = groups.get(sql) ?? { calls: 0, reads: 0, writes: 0 };
        group.calls++;
        group.reads += cursor.rowsRead;
        group.writes += cursor.rowsWritten;
        groups.set(sql, group);
      }
      cursors.length = 0;
      const queries = [...groups].map(([sql, metrics]) => ({ sql, ...metrics }));
      return { label, reads: queries.reduce((sum, q) => sum + q.reads, 0), writes: queries.reduce((sum, q) => sum + q.writes, 0), queries };
    },
  };
}

describe("polling cursor budget and durable lease boundaries", () => {
  for (const connections of [1, 4]) {
    it(`measures ${connections} live SIDs through empty polls and five minutes of complete RPC heartbeats`, async () => {
      const stub = env.ENTRY_STORE.getByName(`polling-cursors-${crypto.randomUUID()}`);
      const reports = await runInDurableObject(stub, async (instance: EntryStore, state) => {
        let now = Date.now();
        const service = new RealtimeSessionService(state.storage, { now: () => now, pollWaitMs: 0 });
        // Invoke EntryStore's real envelope/lease RPC wrappers, including their
        // WebSocket flush and shared alarm/deadline work, against a fake clock.
        (instance as unknown as { realtime: RealtimeSessionService }).realtime = service;
        const sids = Array.from({ length: connections }, () => service.createHandshake().sid);
        const capture = recorder(state.storage);
        const measured: Measurement[] = [];
        try {
          for (const sid of sids) {
            expect(await instance.realtimePollEnvelope(sid)).toMatchObject({ ok: true, value: { payload: "6", jsonpIndex: null } });
          }
          measured.push(capture.take(`empty-poll-${connections}`));
          for (let cycle = 0; cycle < 12; cycle++) {
            now += 25_000;
            for (const sid of sids) {
              expect(await instance.realtimePollEnvelope(sid)).toMatchObject({ ok: true, value: { payload: "2" } });
              const lease = await instance.realtimeBeginPostEnvelope(sid);
              expect(lease.ok).toBe(true);
              if (!lease.ok) throw new Error(lease.error.message);
              expect(await instance.realtimeSubmitPost(sid, lease.value.token,
                encodeEngineIoV4PollingPayload([{ type: "pong" }]))).toEqual({ ok: true, value: null });
            }
          }
          measured.push(capture.take(`five-minute-heartbeats-${connections}`));
          expect(service.nextDeadline()).toBeNull();
          const sessionCount = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM realtime_sessions").one().count;
          expect(sessionCount).toBe(connections);
          expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM realtime_outbound_packets").one().count).toBe(0);
        } finally {
          capture.restore();
        }
        return measured;
      });
      for (const report of reports) console.log(JSON.stringify(report));
      expect(reports[0]!.writes).toBe(0);
      expect(reports[1]!.writes).toBeGreaterThanOrEqual(24 * connections);
      // Measured pre-repair complete RPC reads: 17/92 for an empty poll,
      // 457/2548 for five minutes. Preserve every heartbeat and durable write,
      // while avoiding 4 reads per empty poll and 3 per heartbeat cycle.
      expect(reports[0]!.reads).toBeLessThanOrEqual((connections === 1 ? 17 : 92) - 4 * connections);
      expect(reports[1]!.reads).toBeLessThanOrEqual((connections === 1 ? 457 : 2548) - 36 * connections);
      expect(reports[1]!.writes).toBe(27 * connections);
    });
  }

  it("rechecks durable queue counters after a pending empty poll is awakened by a new frame", async () => {
    const stub = env.ENTRY_STORE.getByName(`polling-queue-wake-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const now = Date.now();
      const service = new RealtimeSessionService(state.storage, { now: () => now, pollWaitMs: 1_000 });
      const { sid } = service.createHandshake();
      const pending = service.poll(sid);
      const lease = service.beginPost(sid);
      await service.submitPost(sid, lease, encodeEngineIoV4PollingPayload([
        wrapSocketIoV5Packet({ type: "connect", namespace: "/" }),
      ]));
      const packets = decodeEngineIoV4PollingPayload(await pending);
      expect(packets.some((packet) => packet.type === "message")).toBe(true);
      expect(packets.some((packet) => packet.type === "noop")).toBe(false);
      expect(new SqliteRealtimeSessionRepository(state.storage).getSession(sid)?.outboundPackets).toBe(0);
    });
  });

  it("keeps POST leases authoritative when the service is reconstructed between begin and pong", async () => {
    const stub = env.ENTRY_STORE.getByName(`polling-durable-lease-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      let now = Date.now();
      const original = new RealtimeSessionService(state.storage, { now: () => now });
      const { sid } = original.createHandshake();
      const lease = original.beginPost(sid);
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      expect(repository.getSession(sid)?.postToken).toBe(lease);
      now += 1_000;
      const resumed = new RealtimeSessionService(state.storage, { now: () => now });
      await resumed.submitPost(sid, lease, encodeEngineIoV4PollingPayload([{ type: "pong" }]));
      expect(repository.getSession(sid)?.postToken).toBeNull();

      const expired = resumed.beginPost(sid);
      now += 15_001;
      const afterPause = new RealtimeSessionService(state.storage, { now: () => now });
      await expect(afterPause.submitPost(sid, expired, encodeEngineIoV4PollingPayload([{ type: "pong" }]))).rejects.toBeInstanceOf(RealtimeSessionError);
      expect(repository.getSession(sid)).toBeNull();
    });
  });

  it("still closes an overlapping POST after reconstruction instead of trusting memory", async () => {
    const stub = env.ENTRY_STORE.getByName(`polling-overlap-lease-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (_instance, state) => {
      const now = Date.now();
      const original = new RealtimeSessionService(state.storage, { now: () => now });
      const { sid } = original.createHandshake();
      original.beginPost(sid);
      const resumed = new RealtimeSessionService(state.storage, { now: () => now });
      expect(() => resumed.beginPost(sid)).toThrowError(RealtimeSessionError);
      expect(new SqliteRealtimeSessionRepository(state.storage).getSession(sid)).toBeNull();
    });
  });

  it("retires only the duplicate FIFO index, preserving queued frames and reducing each frame's writes", async () => {
    const stub = env.ENTRY_STORE.getByName(`polling-fifo-index-${crypto.randomUUID()}`);
    const reports = await runInDurableObject(stub, async (_instance, state) => {
      const repository = new SqliteRealtimeSessionRepository(state.storage);
      const now = Date.now();
      const session = repository.createSession(now);
      const frames = ["4first", "4second", "4third", "4fourth"];
      // Reproduce the supported deployed schema explicitly, even after new
      // objects stop creating the redundant index.
      state.storage.sql.exec("CREATE INDEX realtime_outbound_by_session ON realtime_outbound_packets(sid, sequence)");
      const capture = recorder(state.storage);
      try {
        repository.enqueueFrames(session.sid, frames, now);
        expect(repository.dequeueFrames(session.sid)).toEqual(frames);
        const before = capture.take("four-frame-cycle-duplicate-index");

        repository.enqueueFrames(session.sid, frames, now);
        const snapshot = repository.peekFrames(session.sid);
        const queued = repository.requireSession(session.sid);
        capture.take("fixture");
        migrateRealtimeOutboundIndexV29(state.storage);
        const migration = capture.take("drop-duplicate-index");
        expect(repository.peekFrames(session.sid)).toEqual(snapshot);
        expect(repository.requireSession(session.sid)).toEqual(queued);
        migrateRealtimeOutboundIndexV29(state.storage);
        const indexes = state.storage.sql.exec<{ name: string; origin: string }>("PRAGMA index_list(realtime_outbound_packets)").toArray();
        expect(indexes.some((index) => index.name === "realtime_outbound_by_session")).toBe(false);
        expect(indexes.some((index) => index.origin === "pk")).toBe(true);
        const plan = state.storage.sql.exec<{ detail: string }>(
          "EXPLAIN QUERY PLAN SELECT sequence, packet, byte_length FROM realtime_outbound_packets WHERE sid = ? ORDER BY sequence LIMIT 128",
          session.sid,
        ).toArray().map((row) => row.detail).join(" ");
        expect(plan).toMatch(/USING INDEX sqlite_autoindex_realtime_outbound_packets/);
        expect(plan).not.toMatch(/TEMP B-TREE/);
        expect(repository.dequeueFrames(session.sid)).toEqual(frames);
        capture.take("fixture");
        repository.enqueueFrames(session.sid, frames, now);
        expect(repository.dequeueFrames(session.sid)).toEqual(frames);
        const after = capture.take("four-frame-cycle-primary-key-only");
        // The actual runtime cursor charges one fewer index write per INSERT;
        // its DELETE accounting does not add a second saving per frame.
        expect(after.writes).toBe(before.writes - frames.length);
        expect(after.reads).toBeLessThanOrEqual(before.reads);
        return [before, migration, after];
      } finally {
        capture.restore();
      }
    });
    for (const report of reports) console.log(JSON.stringify(report));
  });
});
