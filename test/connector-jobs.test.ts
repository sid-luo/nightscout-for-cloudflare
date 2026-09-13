import { env } from 'cloudflare:workers';
import { runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceConnector } from '../src/source-connector';
import type { SourceEnvironment } from '../src/connectors/config';
import { WebhookDelivery, resolveWebhook, type WebhookEnvironment, type WebhookPayload } from '../src/webhook-delivery';
import type { EntryStore } from '../src/entry-store';
import { parseEntryPayload } from '../src/model';

afterEach(() => vi.unstubAllGlobals());
const key = 'source-connector-v1';
const webhookKey = 'webhook-outbox-v1';
function name(prefix: string) { return prefix + '-' + crypto.randomUUID().slice(0,8); }
function payload(mills: number): WebhookPayload { return { source: 'nightscout', mgdl: 111, mills, iso: new Date(mills).toISOString() }; }

describe('durable source jobs', () => {
  it('is disabled without allocating a polling alarm', async () => {
    const tenant = name('source-disabled'), stub = env.SOURCE_CONNECTOR.getByName(tenant);
    expect(JSON.parse(await stub.statusJson(tenant))).toMatchObject({ enabled: false, state: 'disabled' });
    await runInDurableObject(stub, async (_instance, state) => { expect(await state.storage.getAlarm()).toBeNull(); expect(await state.storage.get(key)).toBeUndefined(); });
  });

  it('persists source progress, resumes without duplicate records, and isolates tenants', async () => {
    const tenant = name('source-resume'), stub = env.SOURCE_CONNECTOR.getByName(tenant);
    const date = Date.now() - 60_000;
    let calls = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      calls++;
      const url = new URL(String(input));
      expect(url.host).toBe('synthetic.example.test');
      const docs = url.searchParams.has('find[_id][$gt]') || url.searchParams.has('find[date][$gt]') ? [] : [{ _id: '111111111111111111111111', type: 'sgv', sgv: 111, date }];
      return Response.json(docs);
    });
    await runInDurableObject(stub, async (instance, state) => {
      const surface = instance as unknown as { env: SourceEnvironment & { ENTRY_STORE: DurableObjectNamespace<EntryStore> } };
      const before = { ...surface.env };
      try {
        Object.assign(surface.env, { ENABLE: 'connect', CONNECT_SOURCE: 'nightscout', CONNECT_SOURCE_ENDPOINT: 'https://synthetic.example.test', CONNECT_SOURCE_COLLECTIONS: 'entries' });
        await (instance as SourceConnector).reconcile(tenant); await state.storage.setAlarm(Date.now() + 600_000);
        const initial = await state.storage.get<Record<string, unknown>>(key);
        await state.storage.put(key, { ...initial, nextDue: 0 });
        await (instance as SourceConnector).alarm();
        const saved = await state.storage.get<{ lastSuccess: number; progress: { cursors: { entries: { since: number } } } }>(key);
        expect(saved?.lastSuccess).toBeGreaterThan(0); expect(saved?.progress.cursors.entries.since).toBe(date);
        // Construct a fresh instance over the actual persisted DO storage.
        const resumed = new SourceConnector(state, surface.env);
        await resumed.reconcile(tenant);
        const next = await state.storage.get<Record<string, unknown>>(key);
        await state.storage.put(key, { ...next, nextDue: 0 });
        await resumed.alarm();
        expect(calls).toBe(3);
        await expect(resumed.reconcile(name('other'))).rejects.toThrow('tenant mismatch');
      } finally { for (const k of Object.keys(surface.env)) if (!(k in before)) delete (surface.env as unknown as Record<string, unknown>)[k]; Object.assign(surface.env, before); await state.storage.deleteAlarm(); }
    });
    const query = { count: 10, filters: [], sort: [{ field: "date", direction: "desc" as const }] };
    expect(await env.ENTRY_STORE.getByName(tenant).getEntries(query)).toHaveLength(1);
    expect(await env.ENTRY_STORE.getByName(name('untouched')).getEntries(query)).toHaveLength(0);
  });

  it('keeps cursors unadvanced after a partial storage failure and safely replays the page', async () => {
    const tenant = name('source-retry'), stub = env.SOURCE_CONNECTOR.getByName(tenant);
    const date = Date.now() - 60_000;
    let fail = true;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const entry = new URL(String(input)).pathname.includes('/entries.');
      return Response.json(entry ? [{ _id: '222222222222222222222222', type: 'sgv', sgv: 112, date }] : [{ _id: '333333333333333333333333', eventType: 'Note', created_at: new Date(date).toISOString(), notes: fail ? 'x'.repeat(70_000) : 'synthetic' }]);
    });
    await runInDurableObject(stub, async (instance, state) => {
      const surface = instance as unknown as { env: SourceEnvironment & { ENTRY_STORE: DurableObjectNamespace<EntryStore> } };
      const before = { ...surface.env };
      try {
        Object.assign(surface.env, { ENABLE: 'connect', CONNECT_SOURCE: 'nightscout', CONNECT_SOURCE_ENDPOINT: 'https://synthetic.example.test', CONNECT_SOURCE_COLLECTIONS: 'entries,treatments' });
        await (instance as SourceConnector).reconcile(tenant); await state.storage.setAlarm(Date.now() + 600_000);
        await state.storage.put(key, { ...await state.storage.get<Record<string, unknown>>(key), nextDue: 0 });
        await (instance as SourceConnector).alarm();
        const failed = await state.storage.get<{ failures: number; progress: { cursors: object } }>(key);
        expect(failed?.failures).toBe(1); expect(failed?.progress.cursors).toEqual({});
        fail = false;
        await state.storage.put(key, { ...failed, nextDue: 0 });
        await (instance as SourceConnector).alarm();
        const success = await state.storage.get<{ failures: number }>(key); expect(success?.failures).toBe(0);
      } finally { for (const k of Object.keys(surface.env)) if (!(k in before)) delete (surface.env as unknown as Record<string, unknown>)[k]; Object.assign(surface.env, before); await state.storage.deleteAlarm(); }
    });
    expect(await env.ENTRY_STORE.getByName(tenant).getEntries({ count: 10, filters: [], sort: [{ field: "date", direction: "desc" as const }] })).toHaveLength(1);
  });
});

describe('durable Webhook delivery', () => {
  it('receives canonical storage notification updates only from the default dataset', async () => {
    // Local alarms may run before the inspection under full-suite contention.
    // A synthetic retryable response retains the outbox in either schedule.
    const send = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', send);
    const delivery = env.WEBHOOK_DELIVERY.getByName('demo');
    const now = Date.now();
    let restoreDelivery: WebhookEnvironment;
    await runInDurableObject(delivery, async (instance) => {
      const surface = instance as unknown as { env: WebhookEnvironment };
      restoreDelivery = { ...surface.env };
      Object.assign(surface.env, { ENABLE: 'webhook', WEBHOOK_HOST: 'receiver.example.test' });
    });
    try {
      for (const tenant of ['demo', name('webhook-other')]) {
        await runInDurableObject(env.ENTRY_STORE.getByName(tenant), async (instance) => {
          const surface = instance as unknown as { env: WebhookEnvironment; processDueBackgroundTasks(now: number): Promise<void> };
          const before = { ...surface.env };
          try {
            Object.assign(surface.env, { ENABLE: 'webhook', WEBHOOK_HOST: 'receiver.example.test' });
            const store = instance as EntryStore;
            for (const offset of tenant === 'demo' ? [600_000, 300_000] : [60_000]) {
              await store.putEntriesJson(parseEntryPayload([{ type: 'sgv', sgv: 111, date: now - offset }]));
              await surface.processDueBackgroundTasks(Date.now() + 10_000);
            }
          } finally { for (const k of Object.keys(surface.env)) if (!(k in before)) delete (surface.env as unknown as Record<string, unknown>)[k]; Object.assign(surface.env, before); }
        });
        await runInDurableObject(delivery, async (_instance, state) => {
          await state.storage.setAlarm(Date.now() + 600_000);
          const outbox = await state.storage.get<{ lastSeen: number; pending: { payload: WebhookPayload } }>(webhookKey);
          expect(outbox?.lastSeen).toBe(now - 300_000);
          expect(outbox?.pending.payload).toEqual(payload(now - 300_000));
        });
      }
      for (const [, init] of send.mock.calls) expect(JSON.parse(String(init?.body))).toEqual(payload(now - 300_000));
    } finally {
      await runInDurableObject(delivery, async (instance, state) => {
        const surface = instance as unknown as { env: WebhookEnvironment };
        for (const k of Object.keys(surface.env)) if (!(k in restoreDelivery!)) delete (surface.env as unknown as Record<string, unknown>)[k]; Object.assign(surface.env, restoreDelivery!);
        await state.storage.deleteAlarm();
      });
    }
  });
  it('requires explicit enablement and an HTTPS receiver, with no localhost fallback', () => {
    expect(resolveWebhook({})).toEqual({ enabled: false });
    expect(resolveWebhook({ ENABLE: 'webhook' })).toMatchObject({ error: 'invalid_endpoint' });
    expect(resolveWebhook({ ENABLE: 'webhook', WEBHOOK_HOST: 'receiver.example.test' })).toEqual({ enabled: true, endpoint: 'https://receiver.example.test/nightscout' });
    expect(resolveWebhook({ ENABLE: 'webhook', WEBHOOK_HOST: 'receiver.example.test', WEBHOOK_PROTOCOL: 'http' })).toMatchObject({ error: 'invalid_endpoint' });
  });
  it('persists first-reading suppression, retries identical payload/idempotency key, then drains one queued latest reading', async () => {
    const stub = env.WEBHOOK_DELIVERY.getByName(name('webhook'));
    const now = Date.now();
    const sent: { body: string; key: string | null }[] = [];
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ body: String(init?.body), key: new Headers(init?.headers).get('Idempotency-Key') });
      return new Response(null, { status: sent.length === 1 ? 503 : 204 });
    });
    await runInDurableObject(stub, async (instance, state) => {
      const surface = instance as unknown as { env: WebhookEnvironment };
      const before = { ...surface.env };
      try {
        Object.assign(surface.env, { ENABLE: 'webhook', WEBHOOK_HOST: 'receiver.example.test' });
        await (instance as WebhookDelivery).observe(payload(now - 600_000));
        expect(await state.storage.getAlarm()).toBeNull();
        const resumed = new WebhookDelivery(state, surface.env);
        await resumed.observe(payload(now - 600_000));
        await resumed.observe(payload(now - 300_000));
        await state.storage.setAlarm(Date.now() + 600_000);
        async function fire() {
          const stored = await state.storage.get<{ pending: { nextDue: number } }>(webhookKey);
          if (!stored) throw new Error('outbox missing');
          stored.pending.nextDue = 0; await state.storage.put(webhookKey, stored); await resumed.alarm();
        }
        await fire();
        expect(JSON.parse(await resumed.statusJson())).toMatchObject({ pending: true, attempts: 1, lastSuccessAt: null });
        await resumed.observe(payload(now - 60_000));
        await fire();
        expect(sent[0]).toEqual(sent[1]);
        expect(JSON.parse(await resumed.statusJson())).toMatchObject({ pending: true, lastSuccessAt: now - 300_000 });
        await fire();
        expect(JSON.parse(await resumed.statusJson())).toMatchObject({ pending: false, lastSuccessAt: now - 60_000 });
        expect(sent.map(item => JSON.parse(item.body).mills)).toEqual([now - 300_000, now - 300_000, now - 60_000]);
        expect(await state.storage.getAlarm()).toBeNull();
      } finally { for (const k of Object.keys(surface.env)) if (!(k in before)) delete (surface.env as unknown as Record<string, unknown>)[k]; Object.assign(surface.env, before); await state.storage.deleteAlarm(); }
    });
  });
  it('disabling cancels queued delivery and anonymous status is denied', async () => {
    const stub = env.WEBHOOK_DELIVERY.getByName(name('webhook-disabled'));
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await runInDurableObject(stub, async (instance, state) => {
      const surface = instance as unknown as { env: WebhookEnvironment };
      const before = { ...surface.env };
      try {
        Object.assign(surface.env, { ENABLE: 'webhook', WEBHOOK_HOST: 'receiver.example.test' });
        await (instance as WebhookDelivery).observe(payload(Date.now() - 600_000)); await (instance as WebhookDelivery).observe(payload(Date.now() - 300_000));
        surface.env.ENABLE = '';
        await (instance as WebhookDelivery).alarm();
        expect(await state.storage.get(webhookKey)).toBeUndefined(); expect(await state.storage.getAlarm()).toBeNull(); expect(fetcher).not.toHaveBeenCalled();
      } finally { for (const k of Object.keys(surface.env)) if (!(k in before)) delete (surface.env as unknown as Record<string, unknown>)[k]; Object.assign(surface.env, before); }
    });
    expect((await SELF.fetch('https://example.test/_nscf/webhook/status')).status).toBe(401);
  });
});
