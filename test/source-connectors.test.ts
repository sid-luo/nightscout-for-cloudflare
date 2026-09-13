import { describe, expect, it } from 'vitest';
import { resolveSourceConfig, type SourceConfig, type SourceEnvironment } from '../src/connectors/config';
import { ConnectorError, externalUrl, requestJson, requestText } from '../src/connectors/http';
import { mapLinkUp, readLinkUp, readNightscout } from '../src/connectors/sources';
import { mapGlooko, readGlooko } from '../src/connectors/glooko';

const NOW = Date.parse('2026-09-08T00:00:00Z');
const json = (value: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(value), { status, headers });
function config<T extends SourceConfig['source']>(source: T, overrides: SourceEnvironment = {}): Extract<SourceConfig, { source: T }> {
  const result = resolveSourceConfig({ ENABLE: 'connect', CONNECT_SOURCE: source, CONNECT_SOURCE_ENDPOINT: 'https://source.example.test', CONNECT_LINK_UP_USERNAME: 'synthetic@example.test', CONNECT_LINK_UP_PASSWORD: 'synthetic-password', CONNECT_GLOOKO_EMAIL: 'synthetic@example.test', CONNECT_GLOOKO_PASSWORD: 'synthetic-password', ...overrides });
  if (!result.enabled) throw new Error('configuration failed');
  return result.config as Extract<SourceConfig, { source: T }>;
}
function sequence(handlers: Array<(request: Request) => Response | Promise<Response>>) {
  const seen: Request[] = [];
  return { seen, fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); seen.push(request);
    const handler = handlers[seen.length - 1]; if (!handler) throw new Error('unexpected external request');
    return handler(request);
  }) as typeof fetch };
}

describe('source configuration and bounded HTTP', () => {
  it('defaults off and validates collections, credentials, intervals and endpoints', () => {
    expect(resolveSourceConfig({ CONNECT_SOURCE: 'linkup' })).toEqual({ enabled: false });
    expect(resolveSourceConfig({ ENABLE: 'connect', CONNECT_SOURCE: 'linkup' })).toMatchObject({ error: 'missing_credentials' });
    expect(resolveSourceConfig({ ENABLE: 'connect', CONNECT_SOURCE: 'nightscout', CONNECT_SOURCE_ENDPOINT: 'https://source.example.test', CONNECT_SOURCE_COLLECTIONS: 'subjects' })).toMatchObject({ error: 'invalid_collections' });
    expect(config('nightscout', { CONNECT_SOURCE_MAX_COUNT: '10000' }).maxCount).toBe(10000);
    for (const url of ['http://source.example.test', 'https://user:password@source.example.test', 'https://127.0.0.1', 'https://host.local', 'https://[::1]']) expect(() => externalUrl(url)).toThrow(ConnectorError);
  });
  it('rejects redirects and oversized responses without following or exposing body text', async () => {
    const redirect = sequence([() => new Response('private response', { status: 302, headers: { location: 'https://other.example.test' } })]);
    await expect(requestJson('https://source.example.test', {}, redirect.fetcher)).rejects.toMatchObject({ code: 'http_error' });
    expect(redirect.seen).toHaveLength(1);
    const large = sequence([() => new Response('{}', { headers: { 'Content-Length': '9999999' } })]);
    await expect(requestJson('https://source.example.test', {}, large.fetcher)).rejects.toMatchObject({ code: 'response_too_large' });
  });
});

describe('additional connector failure boundaries', () => {
  it('rejects headerless oversized bodies, malformed JSON, network failures and deadlines', async () => {
    await expect(requestText('https://source.example.test', {}, (async () => new Response('123456789')) as typeof fetch, 8)).rejects.toMatchObject({ code: 'response_too_large' });
    await expect(requestJson('https://source.example.test', {}, (async () => new Response('private invalid body')) as typeof fetch)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(requestJson('https://source.example.test', {}, (async () => { throw new Error('private network detail'); }) as typeof fetch)).rejects.toMatchObject({ code: 'network_error', message: 'network_error' });
    await expect(requestText('https://source.example.test', {}, (async (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch, 8, 5)).rejects.toMatchObject({ code: 'timeout' });
  });
  it('rejects localhost aliases and URL credentials before any request', () => {
    for (const url of ['https://localhost.', 'https://host.local.', 'https://host.localhost.', 'https://user:pass@source.example.test', 'https://2130706433']) expect(() => externalUrl(url)).toThrow(ConnectorError);
  });
  it('rejects impossible Libre factory dates in both US and ISO form', () => {
    for (const FactoryTimestamp of ['2/30/2026 12:00:00 AM', '2026-02-30T00:00:00Z', '2026-09-08T24:01:00Z']) expect(() => mapLinkUp({data:{graphData:[{FactoryTimestamp,ValueInMgPerDl:110}]}})).toThrow(ConnectorError);
  });
  it('renews an expired Nightscout bearer before reading and never forwards the source URL token in a data query', async () => {
    const mocked=sequence([
      request=>{expect(new URL(request.url).pathname).toBe('/api/v2/authorization/request/synthetic-token');return json({token:'new-bearer',exp:NOW/1000+3600});},
      request=>{expect(new URL(request.url).pathname).toBe('/api/v1/entries.json');expect(request.headers.get('authorization')).toBe('Bearer new-bearer');expect(new URL(request.url).searchParams.has('token')).toBe(false);return json([]);},
    ]);
    const r=await readNightscout(config('nightscout',{CONNECT_SOURCE_ENDPOINT:'https://source.example.test?token=synthetic-token',CONNECT_SOURCE_COLLECTIONS:'entries'}),{cursors:{},session:{expires:NOW-1,data:{bearer:'old-bearer'}}},NOW,mocked.fetcher);
    expect(r.session?.data.bearer).toBe('new-bearer');
  });
  it('a full timestamp-tie page does not prematurely skip to later records',async()=>{
    const first='111111111111111111111111',second='222222222222222222222222';
    const mocked=sequence([request=>{expect(new URL(request.url).searchParams.get('find[date][$eq]')).toBe(String(NOW-1000));return json([{_id:second,date:NOW-1000,sgv:110}]);}]);
    const r=await readNightscout(config('nightscout',{CONNECT_SOURCE_COLLECTIONS:'entries',CONNECT_SOURCE_MAX_COUNT:'1'}),{cursors:{entries:{since:NOW-1000,afterId:first}}},NOW,mocked.fetcher);
    expect(mocked.seen).toHaveLength(1);expect(r.batches[0]?.cursor).toEqual({since:NOW-1000,afterId:second});
  });
});

describe('Nightscout source collection protocol', () => {
  it('uses a bearer, preserves a base path and selects all four collections', async () => {
    const mocked = sequence([
      request => { expect(request.url).toBe('https://source.example.test/ns/api/v2/authorization/request/reader-token'); return json({ token: 'session-only', exp: NOW / 1000 + 3600 }); },
      ...['entries','treatments','devicestatus','profile'].map(collection => (request: Request) => {
        const url = new URL(request.url); expect(url.pathname).toBe(`/ns/api/v1/${collection}.json`);
        expect(request.headers.get('Authorization')).toBe('Bearer session-only'); expect(url.searchParams.has('token')).toBe(false);
        expect(url.searchParams.get('count')).toBe('100'); expect(url.searchParams.has('skip')).toBe(false); return json([]);
      }),
    ]);
    const result = await readNightscout(config('nightscout', { CONNECT_SOURCE_ENDPOINT: 'https://source.example.test/ns?token=reader-token' }), { cursors: {} }, NOW, mocked.fetcher);
    expect(result.batches.map(b => b.collection)).toEqual(['entries','treatments','devicestatus','profiles']);
    expect(result.session?.data.bearer).toBe('session-only');
  });
  it('paginates tied timestamps with _id, tolerates the upstream descending response formatter', async () => {
    const since = NOW - 60_000;
    const first = '111111111111111111111111', second = '222222222222222222222222', third = '333333333333333333333333';
    const mocked = sequence([
      request => { const q = new URL(request.url).searchParams; expect(q.get('find[date][$eq]')).toBe(String(since)); expect(q.get('find[_id][$gt]')).toBe(first); return json([{ _id: second, date: since, sgv: 100 }]); },
      request => { const q = new URL(request.url).searchParams; expect(q.get('find[date][$gt]')).toBe(String(since)); expect(q.get('count')).toBe('1'); return json([{ _id: third, date: since + 1000, sgv: 101 }]); },
    ]);
    const result = await readNightscout(config('nightscout', { CONNECT_SOURCE_COLLECTIONS: 'entries', CONNECT_SOURCE_MAX_COUNT: '2' }), { cursors: { entries: { since, afterId: first } } }, NOW, mocked.fetcher);
    expect(result.batches[0]?.documents.map(d => d._id)).toEqual([second, third]);
    expect(result.batches[0]?.cursor).toEqual({ since: since + 1000, afterId: third });
  });
  it('API-secret mode only reads and hashes the secret; invalid ordering fails without advancing', async () => {
    const mocked = sequence([request => { expect(request.method).toBe('GET'); expect(request.headers.get('api-secret')).toMatch(/^[a-f0-9]{40}$/); return json([{ _id: '111111111111111111111111', date: NOW + 86400_000 }]); }]);
    await expect(readNightscout(config('nightscout', { CONNECT_SOURCE_COLLECTIONS: 'entries', CONNECT_SOURCE_API_SECRET: 'private-not-sent-plain' }), { cursors: {} }, NOW, mocked.fetcher)).rejects.toMatchObject({ code: 'source_timestamp_invalid' });
  });
});

describe('LibreLinkUp protocol', () => {
  const row = { FactoryTimestamp: '9/8/2026 12:00:00 AM', ValueInMgPerDl: 110, TrendArrow: 3 };
  it('merges current glucose with graph, de-duplicates and handles factory UTC time', () => {
    const entries = mapLinkUp({ data: { graphData: [row], connection: { glucoseItem: { ...row, ValueInMgPerDl: 111 } } } });
    expect(entries).toHaveLength(1); expect(entries[0]).toMatchObject({ date: NOW, sgv: 111, direction: 'Flat' });
  });
  it('authenticates, follows one allowlisted region hint and persists the chosen patient/session', async () => {
    const mocked = sequence([
      () => json({ status: 0, data: { redirect: true, region: 'US' } }),
      request => { expect(new URL(request.url).host).toBe('api-us.libreview.io'); return json({ status: 0, data: { authTicket: { token: 'session', expires: NOW / 1000 + 3600 }, user: { id: 'synthetic-id' } } }); },
      request => { expect(request.headers.get('Account-Id')).toMatch(/^[a-f0-9]{64}$/); return json({ status: 0, data: [{ patientId: 'chosen' }] }); },
      request => { expect(request.url).toContain('/chosen/graph'); return json({ status: 0, data: { graphData: [], connection: { glucoseItem: row } } }); },
    ]);
    const result = await readLinkUp(config('linkup'), { cursors: {} }, NOW, mocked.fetcher);
    expect(result.batches[0]?.documents[0]?.date).toBe(NOW); expect(result.session?.data.patientId).toBe('chosen');
    const resumed = sequence([() => json({ status: 0, data: { graphData: [row] } })]);
    await readLinkUp(config('linkup'), { cursors: {}, session: result.session! }, NOW + 1000, resumed.fetcher);
    expect(resumed.seen).toHaveLength(1);
  });
  it('refuses ambiguous/mismatched patients and untrusted region redirects', async () => {
    const ambiguous = sequence([
      () => json({ status: 0, data: { authTicket: { token: 'session' } } }),
      () => json({ status: 0, data: [{ patientId: 'one' }, { patientId: 'two' }] }),
    ]);
    await expect(readLinkUp(config('linkup'), { cursors: {} }, NOW, ambiguous.fetcher)).rejects.toMatchObject({ code: 'patient_selection_required' });
    const redirect = sequence([() => json({ status: 0, data: { redirect: true, region: 'attacker.example.test' } })]);
    await expect(readLinkUp(config('linkup'), { cursors: {} }, NOW, redirect.fetcher)).rejects.toMatchObject({ code: 'invalid_region_redirect' });
  });
});

describe('Glooko protocol and conversions', () => {
  it('normalizes v2 mg/dl x100, basal seconds, bolus and timezone offsets', () => {
    const result = mapGlooko({ readings: [{ timestamp: '2026-09-08T00:00:00Z', value: 12300 }], scheduledBasals: [{ pumpTimestamp: '2026-09-08T00:00:00Z', rate: 0.8, duration: 3600 }], normalBoluses: [{ pumpTimestamp: '2026-09-08T00:00:00Z', insulinDelivered: 2, carbsInput: 20 }] }, -3600_000);
    expect(result[0]?.documents[0]).toMatchObject({ date: NOW - 3600_000, sgv: 123 });
    expect(result[1]?.documents[0]).toMatchObject({ eventType: 'Temp Basal', duration: 60, absolute: 0.8 });
    expect(result[1]?.documents[1]).toMatchObject({ eventType: 'Meal Bolus', insulin: 2, carbs: 20 });
  });
  it('converts v3 mmol/L y while preserving raw value and excluding calculated data', () => {
    const result = mapGlooko({ userProfile: { currentUser: { meterUnits: 'mmol/L' } }, v3Graph: { series: { cgmNormal: [{ x: NOW / 1000, y: 6 }, { x: NOW / 1000 + 300, y: 7, calculated: true }, { x: NOW / 1000 + 600, value: 15000, y: 8.3 }] } } }, 0);
    expect(result[0]?.documents.map(d => d.sgv)).toEqual([108,150]);
  });
  it('auto mode falls back only on API 422, submits decoded CSRF and reads v3 graph', async () => {
    const mocked = sequence([
      () => json({}, 422),
      () => new Response('<input name="authenticity_token" value="a&amp;b">', { headers: { 'Set-Cookie': 'initial=one; Path=/' } }),
      async request => { expect(new URLSearchParams(await request.text()).get('authenticity_token')).toBe('a&b'); expect(request.headers.get('Cookie')).toBe('initial=one'); return new Response('', { status: 302, headers: { 'Set-Cookie': 'session=two; HttpOnly; Path=/', Location: '/' } }); },
      request => { expect(request.headers.get('Cookie')).toBe('session=two'); return json({ currentUser: { glookoCode: 'synthetic-code', meterUnits: 'mmol/L' } }); },
      request => { expect(new URL(request.url).searchParams.getAll('series[]')).toEqual(['cgmHigh','cgmNormal','cgmLow']); return json({ series: { cgmNormal: [{ x: NOW / 1000, y: 6 }] } }); },
    ]);
    const result = await readGlooko(config('glooko', { CONNECT_GLOOKO_AUTH_MODE: 'auto', CONNECT_GLOOKO_USE_V3_GRAPH: 'true' }), { cursors: {} }, NOW, mocked.fetcher);
    expect(result.batches[0]?.documents[0]?.sgv).toBe(108);
    expect(result.session?.data.cookie).toBe('session=two');
  });
  it('does not hide 2FA or fall back on invalid credentials', async () => {
    const twoFactor = sequence([() => json({ twoFaRequired: true }, 200, { 'Set-Cookie': 'session=none' })]);
    await expect(readGlooko(config('glooko'), { cursors: {} }, NOW, twoFactor.fetcher)).rejects.toMatchObject({ code: 'two_factor_required' });
    const invalid = sequence([() => json({}, 401)]);
    await expect(readGlooko(config('glooko', { CONNECT_GLOOKO_AUTH_MODE: 'auto' }), { cursors: {} }, NOW, invalid.fetcher)).rejects.toMatchObject({ code: 'authentication_failed' });
    expect(invalid.seen).toHaveLength(1);
  });
});
