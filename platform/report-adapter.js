/* Report-only fixes. The official source snapshot/main bundle stay untouched. */
import distributionFactory from '../vendor/nightscout/lib/report_plugins/glucosedistribution.js';
import hourlyFactory from '../vendor/nightscout/lib/report_plugins/hourlystats.js';
import dayTodayFactory from '../vendor/nightscout/lib/report_plugins/daytoday.js';

const original = window.Nightscout.report_plugins_preinit;
window.Nightscout.report_plugins_preinit = function (ctx) {
  const plugins = original(ctx);
  plugins('glucosedistribution').report = distributionFactory().report;
  plugins('hourlystats').report = hourlyFactory().report;
  plugins('daytoday').report = dayTodayFactory().report;
  return plugins;
};

// Upstream adds a fixed 24h to local midnight. A DST day can be 23 or 25h.
// Rewrite only its exact per-day GET query, preserving all filters and auth.
const $ = window.$ || window.jQuery;
const pendingReports = new Set();
function isReportRequest(url) {
  return url.origin === window.location.origin && /^\/api\/v1\/(entries\.json|treatments\.json|devicestatus\.json|profiles\/?)(?:$)/.test(url.pathname);
}
let recovering = false;
$(window.document).ajaxError(function (_event, _xhr, options) {
  if (recovering || !isReportRequest(new URL(options.url, window.location.href)) || !$('#rp_show').length || $('#rp_show').is(':visible')) return;
  recovering = true;
  for (const request of pendingReports) request.abort();
  pendingReports.clear();
  $('#pluginchartplaceholders').hide();
  $('#info').text(window.Nightscout.client.translate('Report could not load. Please retry.'));
  $('#rp_show').show();
  recovering = false;
});
window.document.addEventListener('click', function (event) {
  if (event.target?.id !== 'rp_show') return;
  let error;
  if ($('#rp_enabledate').is(':checked')) {
    const start=$('#rp_from').val(),end=$('#rp_to').val();
    const from=window.moment.utc(start,'YYYY-MM-DD',true),to=window.moment.utc(end,'YYYY-MM-DD',true);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start||'') || !/^\d{4}-\d{2}-\d{2}$/.test(end||'') || !from.isValid() || !to.isValid() || to.isBefore(from)) error='Please select valid dates';
    // The upstream 186-load ceiling includes the previous day's treatments.
    else if (to.diff(from,'days') >= 185) error='Please select at most 185 days';
  }
  const low=Number($('#rp_targetlow').val()),high=Number($('#rp_targethigh').val());
  if (!error && (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= low)) error='Please select a valid target range';
  if (!error && !['mo','tu','we','th','fr','sa','su'].some(day=>$('#rp_'+day).is(':checked'))) error='Result is empty';
  $('#pluginchartplaceholders').toggle(!error);
  if (error) {
    event.preventDefault(); event.stopImmediatePropagation();
    $('#info').text(window.Nightscout.client.translate(error));
  }
}, true);

$.ajaxPrefilter(function (options, _original, request) {
  const url = new URL(options.url, window.location.href);
  if (url.origin !== window.location.origin) return;
  if (isReportRequest(url) && $('#rp_show').length && !$('#rp_show').is(':visible')) {
    pendingReports.add(request);request.always(()=>pendingReports.delete(request));
  }
  const tenant = new URLSearchParams(window.location.search).get('tenant');
  if (tenant && url.pathname.startsWith('/api/') && !url.searchParams.has('tenant')) {
    url.searchParams.set('tenant', tenant);
    options.url = url.pathname + url.search;
  }
  if (options.type && options.type.toUpperCase() !== 'GET') return;
  const match = /^\/api\/v1\/(entries|treatments|devicestatus)\.json$/.exec(url.pathname);
  if (!match) return;
  const field = match[1] === 'entries' ? 'date' : 'created_at';
  const fromKey = 'find[' + field + '][$gte]', toKey = 'find[' + field + '][$lt]';
  const fromValue = url.searchParams.get(fromKey), toValue = url.searchParams.get(toKey);
  if (!fromValue || !toValue) return;
  const from = field === 'date' ? Number(fromValue) : Date.parse(fromValue);
  const to = field === 'date' ? Number(toValue) : Date.parse(toValue);
  if (!Number.isFinite(from) || to - from !== 86400000) return;
  const profile = window.Nightscout.client?.sbx?.data?.profile;
  if (!profile) return;
  const start = profile.applyTimezone(window.moment(from));
  if (start.clone().startOf('day').valueOf() !== from) return;
  const nextDay = start.clone().add(1, 'day').format('YYYY-MM-DD');
  const end = profile.parseInTimezone(nextDay).valueOf();
  if (!Number.isFinite(end) || end <= from || end === to) return;
  url.searchParams.set(toKey, field === 'date' ? String(end) : new Date(end).toISOString());
  options.url = url.pathname + url.search;
});
