/* Cloudflare admin boundary. Official forms and previews remain in the upstream
 * bundle; destructive requests are bounded and failures stop the whole action. */
(function installMaintenance(global) {
  "use strict";
  var plugins = global.Nightscout.admin_plugins;
  var $ = global.jQuery;
  var active = false;

  function selectedRange(client) {
    var startValue = $('#admin_daterange_start').val();
    var endValue = $('#admin_daterange_end').val();
    for (var value of [startValue, endValue]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !global.moment(value, 'YYYY-MM-DD', true).isValid()) {
        throw new Error(client.translate('Please select valid dates'));
      }
    }
    var profile = client.sbx && client.sbx.data && client.sbx.data.profile;
    var zone = profile && profile.getTimezone();
    function parse(value) {
      if (profile && typeof profile.parseInTimezone === 'function') return profile.parseInTimezone(value);
      if (/^[+-]\d{2}:\d{2}$/.test(zone || '')) return global.moment.parseZone(value + 'T00:00:00' + zone);
      return zone ? global.moment.tz(value, 'YYYY-MM-DD', true, zone) : global.moment(value, 'YYYY-MM-DD', true);
    }
    var start = parse(startValue), end = parse(endValue);
    if (!start.isValid() || !end.isValid() || start.isAfter(end)) throw new Error(client.translate('Please select valid dates'));
    var collection = $('#admin_daterange_collection').val();
    var collections = collection === 'all' ? ['entries', 'treatments', 'devicestatus'] : [collection];
    if (collections.some(function (item) { return !['entries', 'treatments', 'devicestatus'].includes(item); })) throw new Error('Invalid collection');
    return { start: start.startOf('day'), end: end.endOf('day'), collections, startValue, endValue };
  }

  function rangeQuery(range, collection) {
    var field = collection === 'entries' ? 'date' : 'created_at';
    var query = new URLSearchParams();
    query.set('find[' + field + '][$gte]', collection === 'entries' ? String(range.start.valueOf()) : range.start.toISOString());
    query.set('find[' + field + '][$lte]', collection === 'entries' ? String(range.end.valueOf()) : range.end.toISOString());
    var tenant = new URLSearchParams(global.location.search).get('tenant');
    if (tenant) query.set('tenant', tenant);
    return query;
  }

  // Both actions use the same timezone/date validation; never preview one day
  // then delete another. Keep the upstream form, replace its transport handler.
  var dateAction = plugins('daterangedelete').actions[0];
  var originalDateInit = dateAction.init;
  var previewGeneration = 0;
  dateAction.init = function (client, callback) {
    return originalDateInit(client, function () {
      async function preview(event) {
        if (event && event.preventDefault) event.preventDefault();
        var generation = ++previewGeneration;
        var output = $('#admin_daterange_preview_count');
        try {
          var range = selectedRange(client), total = 0, capped = false, labels = [];
          output.text(client.translate('Checking...'));
          for (var collection of range.collections) {
            var query = rangeQuery(range, collection); query.set('count', '10000');
            var data = await $.ajax({ url: '/api/v1/' + collection + '.json?' + query.toString(), method: 'GET', headers: client.headers(), cache: false, dataType: 'json' });
            if (generation !== previewGeneration) return;
            if (!Array.isArray(data)) throw new Error('Invalid preview response');
            total += data.length; capped = capped || data.length >= 10000;
            labels.push(collection + ': ' + (data.length >= 10000 ? '≥ ' : '') + data.length);
          }
          output.text(labels.join(' | ') + ' | Total: ' + (capped ? '≥ ' : '') + total);
        } catch (error) {
          if (generation === previewGeneration) output.text(client.translate('Error') + ': ' + (error.message || 'Preview failed'));
        }
      }
      $('#admin_daterange_preview').off('click').on('click', preview);
      $('#admin_daterange_collection').off('change').on('change', preview);
      $('#admin_daterange_start, #admin_daterange_end').off('change').on('change', function () {
        previewGeneration++; $('#admin_daterange_preview_count').text('');
      });
      if (callback) callback();
    });
  };

  async function run(client, name, work, callback) {
    if (active) return;
    active = true;
    var status = $('#admin_' + name + '_0_status');
    var total = 0;
    try {
      if (!client.hashauth.isAuthenticated()) throw new Error(client.translate('Your device is not authenticated yet'));
      await work(async function remove(collection, query) {
        query.set('_nscf_batch', '1');
        var tenant = new URLSearchParams(global.location.search).get('tenant');
        if (tenant) query.set('tenant', tenant);
        for (var batch = 0; batch < 10000; batch++) {
          var result = await $.ajax({
            url: '/api/v1/' + collection + '/?' + query.toString(),
            method: 'DELETE', headers: client.headers(), dataType: 'json'
          });
          if (!result || !Number.isSafeInteger(result.n) || result.n < 0 || typeof result.more !== 'boolean') {
            throw new Error('Invalid cleanup response');
          }
          total += result.n;
          status.show().text(client.translate('%1 records deleted', { params: [total] }));
          if (!result.more) return;
          if (result.n === 0) throw new Error('Cleanup made no progress');
        }
        throw new Error('Cleanup batch limit reached. Run the action again to continue.');
      });
      status.show().text(client.translate('%1 records deleted total', { params: [total] }));
    } catch (error) {
      var reason = error && error.responseJSON && error.responseJSON.error
        ? error.responseJSON.error.message : error.message || client.translate('Error');
      status.show().text(client.translate('Error') + ': ' + reason + ' (' + total + ' deleted)');
    } finally {
      active = false;
      if (callback) callback();
    }
  }

  plugins('cleanprofiledb').label = 'Profile records maintenance';
  plugins('cleanprofiledb').actions[0].code = function (client, callback) {
    return run(client, 'cleanprofiledb', async function (remove) {
      var keep = Number($('#admin_profile_records_keep').val());
      if (!Number.isSafeInteger(keep) || keep < 10 || keep > 10000) throw new Error('Keep must be a whole number between 10 and 10000');
      await remove('profile', new URLSearchParams({ keep: String(keep) }));
    }, callback);
  };
  plugins('daterangedelete').label = 'Delete records by date range';
  plugins('daterangedelete').actions[0].description = 'Remove records from selected collections within the chosen date range.';
  plugins('daterangedelete').actions[0].code = function (client, callback) {
    return run(client, 'daterangedelete', async function (remove) {
      var range = selectedRange(client);
      if (!global.confirm(client.translate('Delete records in date range') + ': ' + range.collections.join(', ') + ' / ' + range.startValue + ' – ' + range.endValue + '?')) return;
      for (var item of range.collections) {
        await remove(item, rangeQuery(range, item));
      }
    }, callback);
  };
})(window);
