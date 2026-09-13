import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createRequire } from 'node:module';

// Execute the unchanged report modules. Only the pie drawing outlet is stubbed;
// Profile, timezone conversion, statistics, filtering and table rendering are real.
const require = createRequire(new URL('../vendor/nightscout/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://reports.invalid/' });
const $ = require('jquery')(dom.window);
global.window = dom.window;
global.document = dom.window.document;
global.$ = $;
$.plot = () => {};
window.moment = require('moment-timezone');
const profileFactory = require('./lib/profilefunctions');
const distribution = require('./lib/report_plugins/glucosedistribution')();
const utils = require('./lib/report_plugins/utils')();
const daytoday = require('./lib/report_plugins/daytoday')();
const { MMOL_TO_MGDL } = require('./lib/constants');
after(() => dom.window.close());

function fixture(units = 'mg/dl', timezone = 'UTC') {
  const profile = profileFactory([{
    defaultProfile: 'Default', startDate: '2020-01-01',
    store: { Default: { timezone, units: 'mg/dl', basal: [{ time: '00:00', value: 1 }] } },
  }], { moment: window.moment });
  window.Nightscout = {
    client: { translate: value => value, settings: { units }, sbx: { data: { profile } } },
    report_plugins: { utils },
  };
  $('body').html(distribution.html(window.Nightscout.client) + '<div id="daytodaycharts"></div>');
  return profile;
}

function runDistribution(mgdl, units, timezone = 'UTC', hours) {
  fixture(units, timezone);
  if (hours) for (let hour = 0; hour < 24; hour++) {
    $('#glucosedistribution-' + hour).prop('checked', hours.includes(hour));
  }
  const scale = units === 'mmol' ? MMOL_TO_MGDL : 1;
  const records = Array.from({ length: 13 }, (_, i) => ({
    bgValue: mgdl, sgv: mgdl / scale,
    displayTime: new Date(Date.parse('2026-09-07T18:00:00Z') + i * 300_000),
  }));
  distribution.report({ allstatsrecords: records, alldays: 1 }, ['2026-09-07'], {
    targetLow: 70 / scale, targetHigh: 180 / scale,
  });
  return $('#glucosedistribution-stability tr').last().children().map((_, el) => $(el).text()).get();
}

for (const [mgdl, gmi, revised, rms] of [
  [100, '5.7', '5.2', 0], [180, '7.6', '7.0', 0],
  [216, '8.5', '7.8', 36], [54, '4.6', '4.1', 16],
]) {
  for (const units of ['mg/dl', 'mmol']) {
    test(`real Distribution ${mgdl} mg/dl shown in ${units}: GMI, revised GMI and RMS`, () => {
      const actual = runDistribution(mgdl, units);
      const expectedRms = units === 'mmol' ? Math.round(rms / MMOL_TO_MGDL * 100) / 100 : rms;
      assert.deepEqual(actual, [`${expectedRms} ${units === 'mmol' ? 'mmol/L' : 'mg/dl'}`, gmi, revised]);
    });
  }
}

test('real Distribution empty input produces empty result without fabricated metrics', () => {
  fixture();
  distribution.report({ allstatsrecords: [], alldays: 0 }, [], { targetLow: 70, targetHigh: 180 });
  assert.equal($('#glucosedistribution-days').text(), 'Result is empty');
  assert.equal($('#glucosedistribution-stability').text(), '');
});

for (const [zone, midnight] of [['GMT+5:30', '2026-09-07T18:30:00.000Z'], ['UTC+5:45', '2026-09-07T18:15:00.000Z']]) {
  test(`real browser Profile and report hours cross local midnight in ${zone}`, () => {
    const profile = fixture('mg/dl', zone);
    assert.equal(profile.parseInTimezone('2026-09-08T00:00:00').toISOString(), midnight);
    assert.equal(utils.localeDate(new Date(midnight)), 'Tuesday 09/08/2026');
    assert.deepEqual(runDistribution(216, 'mg/dl', zone, [0]), ['36 mg/dl', '8.5', '7.8']);
  });
}

test('real day-to-day summary separates unit values and following labels', () => {
  fixture();
  // This checks summary presentation only, not daily dose calculations.
  daytoday.report({ alldays: 1 }, [], { insulindistribution: true });
  const html = $('#daytodaycharts').html();
  assert.equal((html.match(/&nbsp; /g) || []).length, 6);
  assert.match($('#daytodaycharts').text(), /0g\u00a0 Protein average/);
  assert.match($('#daytodaycharts').text(), /0g\u00a0 Fat average/);
});

test('real browser Profile includes sub-minute AAPS basal boundaries once, in order', () => {
  const profile = fixture();
  const start = Date.parse('2026-09-08T00:00:00Z');
  profile.tempbasaltreatments = [{ mills: start + 12_345, endmills: start + 46_789 }];
  profile.profiletreatments = [{ mills: start - 30_000, duration: 1 }];
  profile.combobolustreatments = [{ mills: start + 12_345, duration: 0.5 }];
  assert.deepEqual(profile.getBasalRenderTimes(start, start + 120_000, 60_000), [
    0, 12_345, 30_001, 42_346, 46_790, 60_000, 120_000,
  ].map(ms => start + ms));
});
