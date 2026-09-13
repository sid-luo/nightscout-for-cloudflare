import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { PLUGIN_NOTIFICATIONS_TASK, type BackgroundTaskRow } from "../src/background-tasks";
import type { EntryStore } from "../src/entry-store";
import { parseEntryPayload } from "../src/model";
import { calculatePluginProperties, type PluginPropertyContext } from "../src/plugins/properties";
import { timeAgoVisualization } from "../src/plugins/timeago";
import type { RealtimeDocument } from "../src/realtime/ddata-snapshot";
import { RealtimeEntryQueryCache } from "../src/realtime/entry-query-cache";
import { URGENT, WARN } from "../src/runtime/levels";
import type { NightscoutStatusEnvironment } from "../src/status";

interface Runtime {
  enabled: Set<string>;
  settings: Record<string, unknown>;
  extendedSettings: Record<string, unknown>;
  timeAgo: boolean;
}

interface Internal {
  env: NightscoutStatusEnvironment;
  realtime: { now(): number };
  realtimeEntryQueries: RealtimeEntryQueryCache<{ id: string; body: string; sort_time: number }>;
  realtimeSnapshot(now: number): { sgvs: RealtimeDocument[] };
  pluginPropertyContext(now: number): PluginPropertyContext;
  resolvedAutomaticNotificationRuntime(now: number): Runtime;
  automaticPluginNotificationEvaluation(now: number, runtime: Runtime): {
    notifications: RealtimeDocument[];
    nextDueAt: number | null;
  };
  processDueBackgroundTasks(now: number): Promise<void>;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const SETTINGS = {
  ENABLE: "timeago",
  DISABLE: "ar2 simplealarms errorcodes treatmentnotify pump openaps loop xdripjs upbat bwp cage sage iage bage dbsize",
  TIMEAGO_ENABLE_ALERTS: "true",
  // Use the actual default 15/30-minute thresholds and 60-second heartbeat.
  ALARM_TIMEAGO_WARN: undefined,
  ALARM_TIMEAGO_WARN_MINS: undefined,
  ALARM_TIMEAGO_URGENT: undefined,
  ALARM_TIMEAGO_URGENT_MINS: undefined,
  HEARTBEAT: undefined,
} satisfies { [Key in keyof NightscoutStatusEnvironment]?: NightscoutStatusEnvironment[Key] | undefined };

function observe(internal: Internal, now: number, runtime: Runtime) {
  const context = internal.pluginPropertyContext(now);
  const properties = calculatePluginProperties(
    context, "mg/dl", now, runtime.enabled, runtime.extendedSettings, runtime.settings,
  );
  return {
    context,
    properties,
    timeago: timeAgoVisualization(context.sgvs, now, runtime.settings),
    evaluation: internal.automaticPluginNotificationEvaluation(now, runtime),
    snapshot: internal.realtimeSnapshot(now),
  };
}

describe("entry cache staleness and recovery", () => {
  it.each(["v1", "v3"] as const)(
    "%s uploads preserve data age and the configured notification schedule through gaps and recovery",
    async (protocol) => {
      const stub = env.ENTRY_STORE.getByName(`staleness-${protocol}-${crypto.randomUUID()}`);
      const results = await runInDurableObject(stub, async (instance: EntryStore, state) => {
        const internal = instance as unknown as Internal;
        const originalEnvironment = { ...internal.env };
        Object.assign(internal.env, SETTINGS);
        let now = Date.now();
        const startedAt = now;
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
        // The realtime service captured Date.now when constructed.
        const realtimeClock = vi.spyOn(internal.realtime, "now").mockImplementation(() => now);
        const rows: {
          label: string;
          ageMs: number | null;
          displayedAge: unknown;
          state: unknown;
          notificationLevel: unknown;
          nextDueInMs: number | null;
          scheduledDueInMs: number | null;
        }[] = [];
        const task = () => state.storage.sql.exec<BackgroundTaskRow>(
          "SELECT kind, due_at, attempt_count, updated_at FROM background_tasks WHERE kind = ?",
          PLUGIN_NOTIFICATIONS_TASK,
        ).toArray()[0];
        const upload = async (index: number) => {
          const entry = {
            device: "synthetic-cgm", date: now, dateString: new Date(now).toISOString(),
            type: "sgv", sgv: 110 + index, direction: "Flat",
          };
          if (protocol === "v1") {
            expect((await instance.putEntries(parseEntryPayload([entry]))).inserted).toBe(1);
          } else {
            expect(JSON.parse(await instance.api3CreateDocument("entries", JSON.stringify({
              ...entry, identifier: `synthetic-gap-${index}`, app: "synthetic", utcOffset: 0,
            }), JSON.stringify({
              canCreate: true, canUpdate: true, actor: null, ifUnmodifiedSince: null, emitRealtime: true,
            })))).toMatchObject({ ok: true });
          }
        };
        const checkpoint = async (
          label: string, lastAt: number | null, expectedState: "current" | "warn" | "urgent",
          expectedDueAt: number | null, expectedScheduledDueAt = expectedDueAt,
        ) => {
          const runtime = internal.resolvedAutomaticNotificationRuntime(now);
          expect(runtime.timeAgo).toBe(true);
          expect(runtime.settings).toMatchObject({
            alarmTimeagoWarn: true, alarmTimeagoWarnMins: 15,
            alarmTimeagoUrgent: true, alarmTimeagoUrgentMins: 30, heartbeat: 60,
          });
          expect(internal.realtimeEntryQueries.ready).toBe(true);
          const sql = vi.spyOn(state.storage.sql, "exec");
          let warm: ReturnType<typeof observe>;
          try {
            warm = observe(internal, now, runtime);
            expect(sql.mock.calls.filter(([statement]) => statement.includes("collection = 'entries'") &&
              statement.includes("$.sgv") && statement.includes("LIMIT 64"))).toHaveLength(0);
          } finally { sql.mockRestore(); }

          // Keep the original warm cache across every checkpoint and upload.
          // A separate empty cache forces the unmodified SQL fallback as oracle.
          const committed = internal.realtimeEntryQueries;
          internal.realtimeEntryQueries = new RealtimeEntryQueryCache();
          const freshSql = vi.spyOn(state.storage.sql, "exec");
          try {
            expect(observe(internal, now, runtime), label).toEqual(warm);
            expect(freshSql.mock.calls.filter(([statement]) => statement.includes("collection = 'entries'") &&
              statement.includes("$.sgv") && statement.includes("LIMIT 64"))).toHaveLength(2);
          } finally {
            freshSql.mockRestore();
            internal.realtimeEntryQueries = committed;
          }

          const last = warm.context.sgvs.at(-1);
          const bgnow = warm.properties.bgnow as RealtimeDocument;
          expect(last?.mills ?? null, label).toBe(lastAt);
          expect(bgnow.mills ?? null, label).toBe(lastAt);
          expect(warm.snapshot.sgvs.at(-1)?.mills ?? null, label).toBe(lastAt);
          expect(warm.timeago.pillClass, label).toBe(expectedState);
          expect(warm.evaluation.nextDueAt, label).toBe(expectedDueAt);
          const notification = warm.evaluation.notifications.find((item) => item.eventName === "timeago");
          if (expectedState === "current") expect(notification, label).toBeUndefined();
          else expect(notification, label).toMatchObject({
            eventName: "timeago", level: expectedState === "warn" ? WARN : URGENT,
          });
          if (lastAt === null) {
            expect(warm.context.sgvs).toEqual([]);
            expect(warm.snapshot.sgvs).toEqual([]);
            expect(warm.timeago.value).toBeUndefined();
          }

          await internal.processDueBackgroundTasks(now);
          const scheduledDueAt = task()?.due_at ?? null;
          expect(scheduledDueAt, `${label} persisted timer`).toBe(expectedScheduledDueAt);
          rows.push({
            label, ageMs: lastAt === null ? null : now - lastAt,
            displayedAge: warm.timeago.value ?? null, state: warm.timeago.pillClass,
            notificationLevel: notification?.level ?? null,
            nextDueInMs: expectedDueAt === null ? null : expectedDueAt - now,
            scheduledDueInMs: scheduledDueAt === null ? null : scheduledDueAt - now,
          });
        };

        try {
          internal.realtimeSnapshot(now);
          for (let index = 0; index < 3; index++) {
            now = startedAt + index * 5 * MINUTE;
            await upload(index);
            await checkpoint(`normal-${index}`, now, "current", now + 15 * MINUTE + 1);
          }
          let lastAt = now;
          now = lastAt + 8 * MINUTE;
          await checkpoint("short-gap", lastAt, "current", lastAt + 15 * MINUTE + 1);
          now = lastAt + 10 * MINUTE;
          await upload(3);
          await checkpoint("short-gap-recovered", now, "current", now + 15 * MINUTE + 1);
          lastAt = now;
          now = lastAt + 15 * MINUTE;
          await checkpoint("warn-boundary", lastAt, "current", now + 1);
          now++;
          await checkpoint("warn", lastAt, "warn", now + MINUTE);
          now = lastAt + 30 * MINUTE;
          await checkpoint("urgent-boundary", lastAt, "warn", now + 1);
          now++;
          await checkpoint("urgent", lastAt, "urgent", now + MINUTE);
          now = lastAt + 6 * 60 * MINUTE;
          await checkpoint("six-hour-gap", lastAt, "urgent", now + MINUTE);
          now += 5 * MINUTE;
          await upload(4);
          await checkpoint("six-hour-gap-recovered", now, "current", now + 15 * MINUTE + 1);
          lastAt = now;
          now = lastAt + 2 * DAY;
          await checkpoint("two-day-boundary", lastAt, "urgent", now + MINUTE);
          now++;
          // Original two-day SQL window semantics: no SGV means no age value,
          // no timeago notification and no next evaluation. The already stored
          // heartbeat remains until it actually runs; cache reuse cannot extend
          // the original alert window or pretend an old point is fresh.
          await checkpoint("outside-window", null, "current", null, lastAt + 2 * DAY + MINUTE);
          now = lastAt + 2 * DAY + MINUTE;
          await checkpoint("outside-window-heartbeat", null, "current", null);
          now = lastAt + 2 * DAY + 60 * MINUTE;
          await upload(5);
          await checkpoint("recovered", now, "current", now + 15 * MINUTE + 1);
          expect(state.storage.sql.exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM documents WHERE collection = 'entries'",
          ).one().count).toBe(6);
          return rows;
        } finally {
          realtimeClock.mockRestore();
          clock.mockRestore();
          for (const key of Object.keys(SETTINGS) as (keyof NightscoutStatusEnvironment)[]) {
            if (Object.hasOwn(originalEnvironment, key)) Object.assign(internal.env, { [key]: originalEnvironment[key] });
            else delete internal.env[key];
          }
        }
      });
      console.log("ENTRY_CACHE_STALENESS", protocol, JSON.stringify(results));
    },
  );
});
