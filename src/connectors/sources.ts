import type { SourceCollection, SourceConfig } from './config';
import { LLU_REGIONS } from './config';
import { array, ConnectorError, digest, object, requestJson } from './http';

export interface SourceCursor { since: number; afterId?: string }
export interface SourceSession { expires: number; data: Record<string, unknown> }
export interface SourceProgress { session?: SourceSession; cursors: Partial<Record<SourceCollection, SourceCursor>> }
export interface SourceBatch { collection: SourceCollection; documents: Record<string, unknown>[]; cursor?: SourceCursor }
export interface SourceResult { session?: SourceSession; batches: SourceBatch[] }
export const LOOKBACK = 2 * 24 * 3600_000;
const USER_AGENT = 'nightscout-connect/0.0.13 NSCF/1.3';
type NightscoutConfig = Extract<SourceConfig, { source: 'nightscout' }>;
type LinkUpConfig = Extract<SourceConfig, { source: 'linkup' }>;

export async function readNightscout(config: NightscoutConfig, progress: SourceProgress, now: number, fetcher: typeof fetch): Promise<SourceResult> {
  const endpoint = new URL(config.endpoint);
  const token = endpoint.searchParams.get('token');
  endpoint.search = '';
  endpoint.pathname = endpoint.pathname.replace(/\/$/, '');
  const base = endpoint.toString().replace(/\/$/, '');
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  let session = progress.session;
  // A supplied access token is exchanged for a short-lived bearer; API secret
  // mode remains read-only and never creates subjects on the remote server.
  if (token) {
    if (!session || session.expires <= now) {
      const auth = object(await requestJson(`${base}/api/v2/authorization/request/${encodeURIComponent(token)}`, { headers }, fetcher));
      if (typeof auth.token !== 'string' || !Number.isFinite(Number(auth.exp))) throw new ConnectorError('authentication_failed');
      session = { expires: Number(auth.exp) * 1000 - 60_000, data: { bearer: auth.token } };
    }
    headers.Authorization = `Bearer ${session.data.bearer}`;
  } else if (config.secret) headers['api-secret'] = await digest(config.secret, 'SHA-1');
  const batches: SourceBatch[] = [];
  for (const collection of config.collections) {
    const profile = collection === 'profiles';
    const cursor = progress.cursors[collection] || { since: profile ? 0 : now - LOOKBACK };
    const count = Math.min(config.maxCount, 100);
    const field = collection === 'entries' ? 'date' : profile ? 'startDate' : 'created_at';
    const timeOf = (doc: Record<string, unknown>) => collection === 'entries' ? Number(doc.date) : Date.parse(String(doc[field]));
    // V1 ignores skip. Use a separate same-timestamp/_id page and then the
    // following timestamps; nested _id operators are converted by upstream.
    async function page(ties: boolean, limit: number): Promise<Record<string, unknown>[]> {
      const url = new URL(`${base}/api/v1/${profile ? 'profile' : collection}.json`);
      url.searchParams.set('count', String(limit));
      const operator = ties ? '$eq' : cursor.afterId ? '$gt' : '$gte';
      url.searchParams.set(`find[${field}][${operator}]`, collection === 'entries' ? String(cursor.since) : new Date(cursor.since).toISOString());
      if (ties) url.searchParams.set('find[_id][$gt]', cursor.afterId!);
      url.searchParams.set(`sort[${field}]`, '1'); url.searchParams.set('sort[_id]', '1');
      return array(await requestJson(url, { headers }, fetcher), limit);
    }
    const documents = cursor.afterId ? await page(true, count) : [];
    if (documents.length < count) documents.push(...await page(false, count - documents.length));
    // The entries response formatter reorders rows descending after its DB
    // limit, so normalize the selected page before advancing its cursor.
    documents.sort((a,b) => timeOf(a) - timeOf(b) || String(a._id).localeCompare(String(b._id)));
    let next = { ...cursor };
    for (const doc of documents) {
      const time = timeOf(doc), id = String(doc._id);
      if (!Number.isSafeInteger(time) || time < next.since || !/^[a-f0-9]{24}$/i.test(id)) throw new ConnectorError('source_order_invalid');
      if (time > now + 300_000) throw new ConnectorError('source_timestamp_invalid');
      if (time === next.since && next.afterId && id <= next.afterId) throw new ConnectorError('source_order_invalid');
      next = { since: time, afterId: id };
    }
    if (profile && documents.length === 0) next = { since: 0 };
    batches.push({ collection, documents, cursor: next });
  }
  return { ...(session ? { session } : {}), batches };
}

function factoryTimestamp(value: unknown): number {
  if (typeof value !== 'string') throw new ConnectorError('invalid_timestamp');
  // Libre factory timestamps without an offset denote UTC. Parsing a US
  // factory date explicitly avoids the host's locale/timezone dependence.
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i.exec(value);
  let time: number;
  if (us) {
    if (Number(us[1]) < 1 || Number(us[1]) > 12 || Number(us[2]) < 1 || Number(us[2]) > 31 ||
      Number(us[4]) < 1 || Number(us[4]) > 12 || Number(us[5]) > 59 || Number(us[6]) > 59) throw new ConnectorError('invalid_timestamp');
    const hour = Number(us[4]) % 12 + (us[7]!.toUpperCase() === 'PM' ? 12 : 0);
    time = Date.UTC(Number(us[3]), Number(us[1]) - 1, Number(us[2]), hour, Number(us[5]), Number(us[6]));
    if (new Date(time).getUTCDate() !== Number(us[2])) throw new ConnectorError('invalid_timestamp');
  } else {
    const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/i.exec(value);
    if (!iso || Number(iso[2]) < 1 || Number(iso[2]) > 12 || Number(iso[3]) < 1 ||
        Number(iso[4]) > 23 || Number(iso[5]) > 59 || Number(iso[6]) > 59 ||
        new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))).getUTCDate() !== Number(iso[3])) throw new ConnectorError('invalid_timestamp');
    time = Date.parse(/(?:z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : value.replace(' ', 'T') + 'Z');
  }
  if (!Number.isSafeInteger(time)) throw new ConnectorError('invalid_timestamp');
  return time;
}

export function mapLinkUp(payload: unknown): Record<string, unknown>[] {
  const data = object(object(payload).data);
  const graph = array(data.graphData || []);
  const connection = data.connection ? object(data.connection) : {};
  if (connection.glucoseItem) graph.push(object(connection.glucoseItem));
  const entries = new Map<number, Record<string, unknown>>();
  for (const row of graph) {
    const date = factoryTimestamp(row.FactoryTimestamp);
    const sgv = Number(row.ValueInMgPerDl);
    if (!Number.isFinite(sgv) || sgv <= 0) throw new ConnectorError('invalid_glucose');
    const direction = ['', 'SingleDown','FortyFiveDown','Flat','FortyFiveUp','SingleUp'][Number(row.TrendArrow)] || 'NOT COMPUTABLE';
    entries.set(date, { type: 'sgv', device: 'nightscout-connect-librelinkup', date, dateString: new Date(date).toISOString(), sgv, direction });
  }
  return [...entries.values()].sort((a,b) => Number(a.date) - Number(b.date));
}

export async function readLinkUp(config: LinkUpConfig, progress: SourceProgress, now: number, fetcher: typeof fetch): Promise<SourceResult> {
  let session = progress.session;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', version: config.version, product: config.product, 'User-Agent': USER_AGENT };
  if (!session || session.expires <= now) {
    let endpoint = config.endpoint;
    let auth: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 2; attempt++) {
      auth = object(await requestJson(endpoint + '/llu/auth/login', { method: 'POST', headers, body: JSON.stringify({ email: config.username, password: config.password }) }, fetcher));
      const data = object(auth.data);
      if (!data.redirect) break;
      const region = String(data.region).toUpperCase();
      if (attempt || !LLU_REGIONS.includes(region)) throw new ConnectorError('invalid_region_redirect');
      endpoint = `https://api-${region.toLowerCase()}.libreview.io`;
    }
    if (Number(auth.status) !== 0) throw new ConnectorError('authentication_failed');
    const data = object(auth.data), ticket = object(data.authTicket);
    if (typeof ticket.token !== 'string') throw new ConnectorError('authentication_failed');
    headers.Authorization = `Bearer ${ticket.token}`;
    if (data.user) {
      const user = object(data.user);
      if (typeof user.id === 'string') headers['Account-Id'] = await digest(user.id);
    }
    const result = object(await requestJson(endpoint + '/llu/connections', { headers }, fetcher));
    if (Number(result.status) !== 0) throw new ConnectorError('invalid_response');
    const connections = array(result.data);
    const matches = config.patientId ? connections.filter(row => row.patientId === config.patientId) : connections;
    if (matches.length !== 1 || typeof matches[0]!.patientId !== 'string') throw new ConnectorError('patient_selection_required');
    const expires = Number(ticket.expires) * 1000;
    session = { expires: Math.min(Number.isFinite(expires) && expires > now ? expires - 60_000 : now + 3000_000, now + 3000_000), data: { endpoint, token: ticket.token, patientId: matches[0]!.patientId, accountId: headers['Account-Id'] || '' } };
  }
  headers.Authorization = `Bearer ${session.data.token}`;
  if (session.data.accountId) headers['Account-Id'] = String(session.data.accountId);
  const payload = object(await requestJson(`${session.data.endpoint}/llu/connections/${encodeURIComponent(String(session.data.patientId))}/graph`, { headers }, fetcher));
  if (Number(payload.status) !== 0) throw new ConnectorError('authentication_failed');
  return { session, batches: [{ collection: 'entries', documents: mapLinkUp(payload) }] };
}
