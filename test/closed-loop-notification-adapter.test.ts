import { describe, expect, it } from "vitest";
import { createNightscoutProfileFunctions } from "../src/profile-functions";
import {
  calculateClosedLoopNotificationEvaluation,
} from "../src/plugins/closed-loop-notifications";
import type { RealtimeDocument } from "../src/realtime/ddata-snapshot";

describe("Cloudflare closed-loop notification scheduler adapter", () => {
  it("preserves the locked Pump, OpenAPS, Loop request order", () => {
    const now = Date.parse("2026-07-20T12:00:00.000Z");
    const stale = now - 3 * 60 * 60_000;
    const statuses: RealtimeDocument[] = [{
      mills: now,
      device: "simulator://closed-loop-order",
      pump: {
        clock: new Date(stale).toISOString(),
        reservoir: 50,
        battery: { percent: 80 },
        status: { status: "normal" },
      },
      openaps: {
        suggested: {
          timestamp: new Date(stale).toISOString(),
          mills: stale,
          bg: 120,
        },
      },
      loop: {
        timestamp: new Date(stale).toISOString(),
        name: "Loop",
      },
    }];
    const evaluation = calculateClosedLoopNotificationEvaluation(
      statuses,
      [],
      undefined,
      now,
      60_000,
      {
        pump: {
          preferences: { enableAlerts: true, warnClock: 1, urgentClock: 60 },
          settings: {},
        },
        openaps: { preferences: { enableAlerts: true, warn: 1, urgent: 2 } },
        loop: { preferences: { enableAlerts: true, warn: 1, urgent: 2 } },
      },
    );

    expect(evaluation.notifications.map((notification) => notification.group))
      .toEqual(["Pump", "OpenAPS", "Loop"]);
    expect(evaluation.nextDueAt).toBe(now + 60_000);
  });

  it("sleeps a suppressed low-battery task until the exact local day boundary", () => {
    const now = Date.parse("2026-07-20T01:00:00.000Z");
    const profile = createNightscoutProfileFunctions([{ timezone: "UTC" }]);
    const evaluation = calculateClosedLoopNotificationEvaluation(
      [{
        mills: now,
        device: "simulator://quiet-night",
        pump: {
          clock: new Date(now).toISOString(),
          reservoir: 50,
          battery: { percent: 10 },
          status: { status: "normal" },
        },
      }],
      [],
      profile,
      now,
      60_000,
      {
        pump: {
          preferences: {
            enableAlerts: true,
            warnBattQuietNight: true,
            warnClock: 1_000,
            urgentClock: 2_000,
          },
          settings: { dayStart: 7, dayEnd: 21 },
        },
      },
    );

    expect(evaluation.notifications).toEqual([]);
    expect(evaluation.nextDueAt).toBe(Date.parse("2026-07-20T07:00:00.000Z"));
  });

  it("retains the earliest future device status as an exact activation", () => {
    const now = Date.parse("2026-07-20T12:00:00.000Z");
    const future = now + 10_000;
    const evaluation = calculateClosedLoopNotificationEvaluation(
      [{
        mills: future,
        device: "loop://future-simulator",
        loop: { timestamp: new Date(future).toISOString() },
      }],
      [],
      undefined,
      now,
      60_000,
      { loop: { preferences: { enableAlerts: true } } },
    );

    expect(evaluation.notifications).toEqual([]);
    expect(evaluation.nextDueAt).toBe(future);
  });
});

it.each([['GMT+5:30','2026-07-20T01:30:00Z'], ['GMT+5:45','2026-07-20T01:15:00Z']])(
  'keeps pump quiet-night alarm scheduling aligned for %s', (timezone,expected) => {
    const now=Date.parse('2026-07-20T00:00:00Z');
    const profile=createNightscoutProfileFunctions([{timezone}]);
    const evaluation=calculateClosedLoopNotificationEvaluation([
      {mills:now,device:'synthetic-offset',pump:{clock:new Date(now).toISOString(),reservoir:50,battery:{percent:10},status:{status:'normal'}}},
    ],[],profile,now,60000,{pump:{preferences:{enableAlerts:true,warnBattQuietNight:true,warnClock:1000,urgentClock:2000},settings:{dayStart:7,dayEnd:21}}});
    expect(evaluation.notifications).toEqual([]);
    expect(evaluation.nextDueAt).toBe(Date.parse(expected));
  });
