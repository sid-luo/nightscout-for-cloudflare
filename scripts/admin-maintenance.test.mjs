import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const moment = require('../vendor/nightscout/node_modules/moment-timezone');
const source = readFileSync(new URL('../platform/admin-maintenance.js', import.meta.url), 'utf8');
function fixture(results, authenticated = true) {
  const values = { '#admin_profile_records_keep': '10', '#admin_daterange_collection': 'all',
    '#admin_daterange_start': '2026-03-08', '#admin_daterange_end': '2026-03-08' };
  const text = {}; const calls = []; const plugins = {};
  const $ = selector => ({ val: () => values[selector], show() { return this; }, text(value) { text[selector] = value; return this; } });
  $.ajax = async request => { calls.push(request); const result = results.shift(); if (result instanceof Error) throw result; return result; };
  let confirmed = true;
  const window = { Nightscout: { admin_plugins: name => plugins[name] ??= { actions: [{}] } },
    jQuery: $, moment, location: { search: '?tenant=isolated' }, confirm: () => confirmed };
  vm.runInNewContext(source, { window, URLSearchParams });
  const client = { hashauth: { isAuthenticated: () => authenticated }, headers: () => ({ 'api-secret': 'test-digest' }),
    translate: (value, options) => value.replace('%1', options?.params[0]), sbx: { data: { profile: { getTimezone: () => 'America/Los_Angeles' } } } };
  return { plugins, client, calls, text, cancel: () => { confirmed = false; } };
}
test('profile cleanup repeats only until complete and sums confirmed counts', async () => {
  const f = fixture([{ n: 64, more: true }, { n: 3, more: false }]); let completed = 0;
  await f.plugins.cleanprofiledb.actions[0].code(f.client, () => completed++);
  assert.equal(completed, 1); assert.equal(f.calls.length, 2);
  const url = new URL(f.calls[0].url, 'https://example.test');
  assert.equal(url.searchParams.get('keep'), '10'); assert.equal(url.searchParams.get('tenant'), 'isolated');
  assert.equal(url.searchParams.get('_nscf_batch'), '1');
  assert.equal(f.text['#admin_cleanprofiledb_0_status'], '67 records deleted total');
});
test('date cleanup uses the profile timezone including DST and processes all collections', async () => {
  const f = fixture(Array.from({ length: 3 }, () => ({ n: 1, more: false })));
  await f.plugins.daterangedelete.actions[0].code(f.client);
  assert.equal(f.calls.length, 3);
  const entries = new URL(f.calls[0].url, 'https://example.test').searchParams;
  const treatments = new URL(f.calls[1].url, 'https://example.test').searchParams;
  assert.equal(entries.get('find[date][$gte]'), String(Date.parse('2026-03-08T08:00:00.000Z')));
  assert.equal(entries.get('find[date][$lte]'), String(Date.parse('2026-03-09T06:59:59.999Z')));
  assert.equal(treatments.get('find[created_at][$gte]'), '2026-03-08T08:00:00.000Z');
});
test('failure stops later collections and retains a truthful partial count', async () => {
  const f = fixture([{ n: 64, more: true }, new Error('quota reached')]);
  await f.plugins.daterangedelete.actions[0].code(f.client);
  assert.equal(f.calls.length, 2);
  assert.equal(f.text['#admin_daterangedelete_0_status'], 'Error: quota reached (64 deleted)');
});
test('untrusted response and no-progress replies never report completion', async () => {
  for (const result of [{ n: 0, more: true }, { n: 5 }, { n: -1, more: false }]) {
    const f = fixture([result]);
    await f.plugins.cleanprofiledb.actions[0].code(f.client);
    assert.match(f.text['#admin_cleanprofiledb_0_status'], /^Error:/);
  }
});
test('cancellation and unauthenticated actions perform no writes', async () => {
  for (const authorized of [true, false]) {
    const f = fixture([], authorized); f.cancel(); let complete = 0;
    await f.plugins.daterangedelete.actions[0].code(f.client, () => complete++);
    assert.equal(f.calls.length, 0); assert.equal(complete, 1);
  }
});
