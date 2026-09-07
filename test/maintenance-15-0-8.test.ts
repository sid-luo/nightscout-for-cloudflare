import { createHash } from 'node:crypto';
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const headers = { 'Accept': 'application/json', 'api-secret': createHash('sha1').update('nscf-test-secret-20260717').digest('hex'), 'Content-Type': 'application/json' };
const from = Date.parse('2026-08-01T00:00:00.000Z');
const to = from + 86400000 - 1;
function address(name: string, collection: string, query = '') {
  return `https://example.test/api/v1/${collection}/?tenant=${name}${query}`;
}
async function create(name: string, collection: string, rows: unknown[]) {
  for (let offset = 0; offset < rows.length; offset += 100) {
    const response = await SELF.fetch(address(name, collection), { method: 'POST', headers, body: JSON.stringify(rows.slice(offset, offset + 100)) });
    expect(response.status, await response.text()).toBe(200);
  }
}

describe('15.0.8 bounded admin maintenance', () => {
  for (const collection of ['entries', 'treatments', 'devicestatus']) {
    it(`deletes a full day of ${collection} in bounded batches and preserves outside records`, async () => {
      const name = `maintenance-${crypto.randomUUID()}`;
      const rows = Array.from({ length: 150 }, (_, i) => ({
        _id: (i + 1).toString(16).padStart(24, '0'),
        ...(collection === 'entries'
          ? { type: 'sgv', sgv: 100, date: from + i * 1000, dateString: new Date(from + i * 1000).toISOString() }
          : { created_at: new Date(from + i * 1000).toISOString(), eventType: 'Note', device: `fixture-${i}`, date: to + 99999 }),
      }));
      rows.push({ _id: 'ffffffffffffffffffffffff', ...(collection === 'entries'
        ? { type: 'sgv', sgv: 100, date: to + 1, dateString: new Date(to + 1).toISOString() }
        : { created_at: new Date(to + 1).toISOString(), eventType: 'Note', device: 'outside', date: from }) });
      await create(name, collection, rows);
      const field = collection === 'entries' ? 'date' : 'created_at';
      const params = new URLSearchParams({ _nscf_batch: '1', count: '100000',
        [`find[${field}][$gte]`]: collection === 'entries' ? String(from) : new Date(from).toISOString(),
        [`find[${field}][$lte]`]: collection === 'entries' ? String(to) : new Date(to).toISOString() });
      const target = address(name, collection, '&' + params);
      const denied = await SELF.fetch(target, { method: 'DELETE' });
      expect(denied.status).toBe(401);
      let total = 0;
      let more = true;
      for (let attempt = 0; attempt < 10 && more; attempt++) {
        const response = await SELF.fetch(target, { method: 'DELETE', headers });
        expect(response.status).toBe(200);
        const result = await response.json() as { n: number; more: boolean };
        expect(result.n).toBeLessThanOrEqual(64);
        expect(result.n).toBeGreaterThan(0);
        total += result.n; more = result.more;
      }
      expect(more).toBe(false); expect(total).toBe(150);
      const remaining = await SELF.fetch(address(name, collection, '&count=1000&find[_id]=ffffffffffffffffffffffff'), { headers });
      const stored = await remaining.json() as Array<{ _id: string }>;
      expect(stored.map(item => item._id)).toEqual(['ffffffffffffffffffffffff']);
      const repeated = await SELF.fetch(target, { method: 'DELETE', headers });
      expect(await repeated.json()).toMatchObject({ n: 0, more: false });
    });
  }

  it('keeps profiles by startDate and descending id, including ties and missing dates', async () => {
    const name = `profile-prune-${crypto.randomUUID()}`;
    const rows = Array.from({ length: 150 }, (_, i) => ({
      _id: (i + 1).toString(16).padStart(24, '0'),
      ...(i === 0 ? {} : { startDate: i < 130 ? '2025-01-01' : '2026-01-01' }),
      defaultProfile: 'Default', store: { Default: { dia: 3 } },
    }));
    await create(name, 'profile', rows);
    for (const query of ['&keep=9', '&keep=10.5', '&keep=10001', '&keep=10&find[x]=1']) {
      const invalid = await SELF.fetch(address(name, 'profile', query), { method: 'DELETE', headers });
      expect(invalid.status).toBe(400);
    }
    const tooMany = await SELF.fetch(address(name, 'profile', '&keep=10'), { method: 'DELETE', headers });
    expect(tooMany.status).toBe(413);
    let deleted = 0;
    for (let i = 0; i < 10; i++) {
      const response = await SELF.fetch(address(name, 'profile', '&keep=10&_nscf_batch=1'), { method: 'DELETE', headers });
      expect(response.status).toBe(200);
      const result = await response.json() as { n: number; more: boolean };
      deleted += result.n;
      if (!result.more) break;
    }
    expect(deleted).toBe(140);
    const remaining = await SELF.fetch(address(name, 'profile', '&count=1000'), { headers });
    const stored = await remaining.json() as Array<{ _id: string }>;
    expect(stored.map(item => item._id).sort()).toEqual(rows.slice(-10).map(item => item._id).sort());
  });

  it('rejects malformed legacy profile ordering fields before a batch writes', async () => {
    const name = `profile-shape-${crypto.randomUUID()}`;
    const response = await SELF.fetch(address(name, 'profile'), { method: 'POST', headers,
      body: JSON.stringify([{ startDate: '2026-01-01' }, { startDate: { injected: true } }]) });
    expect(response.status).toBe(400);
    const stored = await SELF.fetch(address(name, 'profile'), { headers });
    expect(await stored.json()).toEqual([]);
  });

  it('rejects invalid/repeated/extra range filters before writing', async () => {
    const name = `bad-range-${crypto.randomUUID()}`;
    for (const query of [
      '&_nscf_batch=1',
      '&_nscf_batch=1&find[date][$gte]=NaN&find[date][$lte]=10',
      '&_nscf_batch=1&find[date][$gte]=20&find[date][$lte]=10',
      '&_nscf_batch=1&find[date][$gte]=1&find[date][$gte]=2&find[date][$lte]=10',
      '&_nscf_batch=1&find[date][$gte]=1&find[date][$lte]=10&find[sgv]=100',
    ]) {
      const result = await SELF.fetch(address(name, 'entries', query), { method: 'DELETE', headers });
      expect(result.status).toBe(400);
    }
  });
});

it('matches upstream framing opt-out on assets and API responses', async () => {
  for (const path of ['/admin/', '/api/v1/status.json']) {
    const request = new Request(`https://example.test${path}`);
    const enabled = await worker.fetch(request, { ...env, ALLOW_UNRESTRICTED_FRAME_EMBEDDING: 'false' });
    expect(enabled.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(enabled.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self'");
    const defaultResponse = await worker.fetch(request, env);
    expect(defaultResponse.headers.has('X-Frame-Options')).toBe(false);
  }
});
