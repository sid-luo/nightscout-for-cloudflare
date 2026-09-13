import { DurableObject } from 'cloudflare:workers';
import type { EntryStore } from './entry-store';
import { parseEntryPayload } from './model';
import { parseDocumentPayload } from './documents';
import { resolveSourceConfig, type SourceConfig, type SourceEnvironment } from './connectors/config';
import { ConnectorError, digest } from './connectors/http';
import { readGlooko } from './connectors/glooko';
import { readLinkUp, readNightscout, type SourceProgress, type SourceResult } from './connectors/sources';

interface ConnectorEnv extends SourceEnvironment { ENTRY_STORE: DurableObjectNamespace<EntryStore> }
interface RecordState {
  version: 1; tenant: string; generation: string; fingerprint: string; source: SourceConfig['source'];
  progress: SourceProgress; hashes: Record<string, string>; nextDue: number;
  lastAttempt: number | null; lastSuccess: number | null; failures: number; error: string | null;
}
const KEY = 'source-connector-v1';
const TENANT = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class SourceConnector extends DurableObject<ConnectorEnv> {
  async reconcile(tenant: string): Promise<void> {
    if (!TENANT.test(tenant)) throw new Error('invalid connector tenant');
    const resolution = resolveSourceConfig(this.env);
    const fingerprint = resolution.enabled ? await digest(JSON.stringify(resolution.config)) : '';
    await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<RecordState>(KEY);
      if (current && current.tenant !== tenant) throw new Error('connector tenant mismatch');
      if (!resolution.enabled) { await tx.delete(KEY); await tx.deleteAlarm(); return; }
      if (!current || current.fingerprint !== fingerprint || current.version !== 1) {
        const state: RecordState = { version: 1, tenant, generation: crypto.randomUUID(), fingerprint, source: resolution.config.source,
          progress: { cursors: {} }, hashes: {}, nextDue: Date.now() + 1,
          lastAttempt: null, lastSuccess: null, failures: 0, error: null };
        await tx.put(KEY, state); await tx.setAlarm(state.nextDue);
      } else if (await tx.getAlarm() === null) await tx.setAlarm(Math.max(Date.now() + 1, current.nextDue));
    });
  }

  async statusJson(tenant: string): Promise<string> {
    await this.reconcile(tenant);
    const resolution = resolveSourceConfig(this.env);
    const state = await this.ctx.storage.get<RecordState>(KEY);
    return JSON.stringify({ enabled: resolution.enabled, source: resolution.enabled ? resolution.config.source : null,
      state: !resolution.enabled ? resolution.error ? 'configuration_error' : 'disabled' : state?.failures ? 'backoff' : state?.lastSuccess ? 'ok' : 'idle',
      configurationError: !resolution.enabled ? resolution.error : undefined,
      lastAttemptAt: state?.lastAttempt ?? null, lastSuccessAt: state?.lastSuccess ?? null,
      consecutiveFailures: state?.failures ?? 0, lastErrorCode: state?.error ?? null, nextAttemptAt: state?.nextDue ?? null });
  }

  private async current(expected: RecordState): Promise<boolean> {
    const state = await this.ctx.storage.get<RecordState>(KEY);
    return state?.generation === expected.generation && state.tenant === expected.tenant;
  }

  private async ingest(config: SourceConfig, expected: RecordState, result: SourceResult): Promise<RecordState> {
    const state = structuredClone(expected);
    const store = this.env.ENTRY_STORE.getByName(expected.tenant);
    // Stable identity excludes passwords/session tokens, preserving deduplication
    // after a credential rotation or process eviction.
    const identity = JSON.stringify([config.source, config.endpoint.split('?')[0],
      config.source === 'linkup' ? [config.username, result.session?.data.patientId] : config.source === 'glooko' ? config.email : '']);
    for (const batch of result.batches) {
      if (batch.documents.length > 10000) throw new ConnectorError('batch_too_large');
      for (let start = 0; start < batch.documents.length; start += 100) {
        if (!await this.current(expected)) throw new ConnectorError('configuration_changed');
        const changed: Record<string, unknown>[] = [];
        for (const value of batch.documents.slice(start, start + 100)) {
          const doc = { ...value };
          const key = String(doc._id || doc._sourceId || (batch.collection === 'entries' ? doc.date : JSON.stringify([doc.created_at, doc.eventTime, doc.eventType, doc.insulin, doc.carbs, doc.rate])));
          const id = (await digest(identity + '\0' + batch.collection + '\0' + key)).slice(0,24);
          delete doc._sourceId;
          doc._id = id;
          const hash = await digest(JSON.stringify(doc));
          if (state.hashes[id] !== hash) { changed.push(doc); state.hashes[id] = hash; }
        }
        if (changed.length) {
          if (batch.collection === 'entries') {
            // Validate timestamp before allowing a bad upstream reading to pin
            // the cursor in the future. Storage sanitization remains canonical.
            if (changed.some(doc => !Number.isSafeInteger(Number(doc.date)) || Number(doc.date) > Date.now() + 300_000)) throw new ConnectorError('source_timestamp_invalid');
            const result = JSON.parse(await store.putEntriesJson(parseEntryPayload(changed))) as { ok: boolean };
            if (!result.ok) throw new ConnectorError('storage_failed');
          } else {
            const collection = batch.collection === 'profiles' ? 'profile' : batch.collection;
            const parsed = parseDocumentPayload(changed, collection, false);
            await store.saveDocuments(collection, JSON.stringify(parsed.documents));
          }
        }
      }
      // A page cursor advances only after all of its documents are stored.
      if (batch.cursor) state.progress.cursors[batch.collection] = batch.cursor;
    }
    if (result.session) state.progress.session = result.session;
    else delete state.progress.session;
    state.hashes = Object.fromEntries(Object.entries(state.hashes).slice(-2000));
    return state;
  }

  override async alarm(): Promise<void> {
    const expected = await this.ctx.storage.get<RecordState>(KEY);
    if (!expected) return;
    const resolution = resolveSourceConfig(this.env);
    if (!resolution.enabled || await digest(JSON.stringify(resolution.config)) !== expected.fingerprint) {
      await this.reconcile(expected.tenant); return;
    }
    const now = Date.now();
    if (now < expected.nextDue) { await this.ctx.storage.setAlarm(expected.nextDue); return; }
    // A persistent retry remains scheduled if the worker is interrupted after
    // external I/O. Replaying a page uses deterministic document identifiers.
    await this.ctx.storage.setAlarm(now + 150_000);
    let updated = structuredClone(expected);
    try {
      const { config } = resolution;
      const result = config.source === 'nightscout' ? await readNightscout(config, expected.progress, now, fetch)
        : config.source === 'linkup' ? await readLinkUp(config, expected.progress, now, fetch)
          : await readGlooko(config, expected.progress, now, fetch);
      updated = await this.ingest(config, expected, result);
      updated.lastSuccess = now; updated.failures = 0; updated.error = null;
      updated.nextDue = now + config.interval;
    } catch (error) {
      updated.error = error instanceof ConnectorError ? error.code : 'internal_error';
      updated.failures = Math.min(1000, expected.failures + 1);
      if (updated.error === 'authentication_failed') delete updated.progress.session;
      const base = updated.error === 'authentication_failed' || updated.error === 'two_factor_required' ? 1800_000 : 150_000;
      updated.nextDue = now + Math.min(6 * 3600_000, base * 2 ** Math.min(8, updated.failures - 1));
    }
    updated.lastAttempt = now;
    await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<RecordState>(KEY);
      if (current?.generation !== expected.generation) return;
      await tx.put(KEY, updated); await tx.setAlarm(updated.nextDue);
    });
  }
}
