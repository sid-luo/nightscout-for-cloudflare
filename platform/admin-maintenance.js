/* Cloudflare admin boundary. Official forms and previews remain in the upstream
 * bundle; destructive requests are bounded and failures stop the whole action. */
(function installMaintenance(global) {
  "use strict";
  var plugins = global.Nightscout.admin_plugins;
  var $ = global.jQuery;
  var active = false;

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
      var collection = $('#admin_daterange_collection').val();
      var collections = collection === 'all' ? ['entries', 'treatments', 'devicestatus'] : [collection];
      if (collections.some(function (item) { return !['entries', 'treatments', 'devicestatus'].includes(item); })) throw new Error('Invalid collection');
      var startValue = $('#admin_daterange_start').val();
      var endValue = $('#admin_daterange_end').val();
      var profile = client.sbx && client.sbx.data && client.sbx.data.profile;
      var zone = profile && profile.getTimezone();
      var start = zone ? global.moment.tz(startValue, 'YYYY-MM-DD', true, zone) : global.moment(startValue, 'YYYY-MM-DD', true);
      var end = zone ? global.moment.tz(endValue, 'YYYY-MM-DD', true, zone) : global.moment(endValue, 'YYYY-MM-DD', true);
      if (!start.isValid() || !end.isValid() || start.isAfter(end)) throw new Error(client.translate('Please select valid dates'));
      start.startOf('day'); end.endOf('day');
      if (!global.confirm(client.translate('Delete records in date range') + ': ' + collections.join(', ') + ' / ' + startValue + ' – ' + endValue + '?')) return;
      for (var item of collections) {
        var field = item === 'entries' ? 'date' : 'created_at';
        var query = new URLSearchParams();
        query.set('find[' + field + '][$gte]', item === 'entries' ? String(start.valueOf()) : start.toISOString());
        query.set('find[' + field + '][$lte]', item === 'entries' ? String(end.valueOf()) : end.toISOString());
        await remove(item, query);
      }
    }, callback);
  };
})(window);
