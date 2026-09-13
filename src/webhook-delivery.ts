import { DurableObject } from 'cloudflare:workers';
import { ConnectorError, digest, externalUrl, requestText } from './connectors/http';

export interface WebhookEnvironment {
  ENABLE?: string; WEBHOOK_PROTOCOL?: string; WEBHOOK_HOST?: string; WEBHOOK_PORT?: string; WEBHOOK_PATH?: string;
}
export interface WebhookPayload { source: 'nightscout'; mgdl: number; mills: number; iso: string }
export function resolveWebhook(env: WebhookEnvironment): { enabled: true; endpoint: string } | { enabled: false; error?: string } {
  if (!(env.ENABLE || '').split(/[\s,]+/).includes('webhook')) return { enabled: false };
  try {
    // Workers has no local Node receiver. Require an explicitly configured
    // remote HTTPS endpoint instead of upstream's localhost:3000 default.
    const host = env.WEBHOOK_HOST || '';
    if (!host || /[\/@?#:]/.test(host)) throw new ConnectorError('invalid_endpoint');
    const protocol = env.WEBHOOK_PROTOCOL || 'https';
    const port = env.WEBHOOK_PORT || '443';
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new ConnectorError('invalid_endpoint');
    const path = env.WEBHOOK_PATH || '/nightscout';
    if (!path.startsWith('/') || path.startsWith('//')) throw new ConnectorError('invalid_endpoint');
    return { enabled: true, endpoint: externalUrl(`${protocol}://${host}:${port}${path}`).toString() };
  } catch { return { enabled: false, error: 'invalid_endpoint' }; }
}
interface Pending { payload: WebhookPayload; attempts: number; nextDue: number }
interface WebhookState {
  version: 1; generation: string; fingerprint: string; lastSeen: number; lastSuccess: number | null;
  pending?: Pending; queued?: WebhookPayload; error: string | null;
}
const KEY = 'webhook-outbox-v1';

export class WebhookDelivery extends DurableObject<WebhookEnvironment> {
  async observe(payload: WebhookPayload): Promise<void> {
    if (payload.source !== 'nightscout' || !Number.isFinite(payload.mgdl) || payload.mgdl <= 0 ||
      !Number.isSafeInteger(payload.mills) || payload.mills < 0 || payload.mills > Date.now() + 300_000 ||
      payload.iso !== new Date(payload.mills).toISOString()) throw new Error('invalid webhook event');
    const config = resolveWebhook(this.env);
    const fingerprint = config.enabled ? await digest(config.endpoint) : '';
    await this.ctx.storage.transaction(async tx => {
      const state = await tx.get<WebhookState>(KEY);
      if (!config.enabled) { await tx.delete(KEY); await tx.deleteAlarm(); return; }
      if (!state || state.fingerprint !== fingerprint) {
        // Suppress the first observed reading, exactly as the upstream plugin,
        // but retain that baseline across eviction/restart.
        await tx.put(KEY, { version: 1, generation: crypto.randomUUID(), fingerprint, lastSeen: payload.mills, lastSuccess: null, error: null } satisfies WebhookState);
        await tx.deleteAlarm(); return;
      }
      if (payload.mills <= state.lastSeen) return;
      state.lastSeen = payload.mills;
      if (state.pending) state.queued = payload;
      else state.pending = { payload, attempts: 0, nextDue: Date.now() + 1 };
      await tx.put(KEY, state); await tx.setAlarm(state.pending.nextDue);
    });
  }

  async statusJson(): Promise<string> {
    const config = resolveWebhook(this.env);
    let state = await this.ctx.storage.get<WebhookState>(KEY);
    if (state && (!config.enabled || await digest(config.endpoint) !== state.fingerprint)) {
      await this.ctx.storage.delete(KEY); await this.ctx.storage.deleteAlarm(); state = undefined;
    }
    return JSON.stringify({ enabled: config.enabled, configurationError: !config.enabled ? config.error : undefined,
      lastSuccessAt: state?.lastSuccess ?? null, pending: Boolean(state?.pending), attempts: state?.pending?.attempts ?? 0, lastErrorCode: state?.error ?? null });
  }

  override async alarm(): Promise<void> {
    const expected = await this.ctx.storage.get<WebhookState>(KEY);
    if (!expected?.pending) return;
    const config = resolveWebhook(this.env);
    if (!config.enabled || await digest(config.endpoint) !== expected.fingerprint) {
      await this.ctx.storage.delete(KEY); await this.ctx.storage.deleteAlarm(); return;
    }
    if (Date.now() < expected.pending.nextDue) { await this.ctx.storage.setAlarm(expected.pending.nextDue); return; }
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
    let error: string | null = null;
    try {
      const result = await requestText(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json',
        'Idempotency-Key': await digest(expected.fingerprint + ':' + expected.pending.payload.mills),
      }, body: JSON.stringify(expected.pending.payload) }, fetch, 64 * 1024, 5000);
      if (!result.response.ok) throw new ConnectorError('http_error');
    } catch (caught) { error = caught instanceof ConnectorError ? caught.code : 'internal_error'; }
    await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<WebhookState>(KEY);
      if (!current?.pending || current.generation !== expected.generation || current.pending.payload.mills !== expected.pending!.payload.mills) return;
      current.error = error;
      if (error) {
        current.pending.attempts++;
        current.pending.nextDue = Date.now() + Math.min(3600_000, 30_000 * 2 ** Math.min(7, current.pending.attempts - 1));
      } else {
        current.lastSuccess = current.pending.payload.mills;
        if (current.queued) {
          current.pending = { payload: current.queued, attempts: 0, nextDue: Date.now() + 1 };
          delete current.queued;
        } else delete current.pending;
      }
      await tx.put(KEY, current);
      if (current.pending) await tx.setAlarm(current.pending.nextDue); else await tx.deleteAlarm();
    });
  }
}
