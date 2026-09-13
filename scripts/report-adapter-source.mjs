import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distributionPath = path.join(root, 'vendor/nightscout/lib/report_plugins/glucosedistribution.js');

// Keep the locked upstream tree and its main bundle byte-identical. Only the
// report page installs this reviewed overlay. Fail closed if upstream changes.
export function patchDistribution(source) {
  function replace(before, after) {
    if (source.split(before).length !== 2) throw new Error('Distribution patch anchor changed: ' + before.slice(0, 60));
    source = source.replace(before, after);
  }
  replace('var seen = [];', 'var seen = new Set();');
  replace("if (!item.sgv || !item.bgValue || !item.displayTime || item.bgValue < 39) {\n      console.log(item);", "if (!Number.isFinite(item.sgv) || !Number.isFinite(item.bgValue) || !item.displayTime || !Number.isFinite(item.displayTime.getTime()) || item.sgv <= 0 || item.bgValue < 39) {");
  replace('return seen.includes(item.displayTime) ? false : (seen[item.displayTime] = true);', 'var timestamp = item.displayTime.getTime();\n    if (seen.has(timestamp)) return false;\n    seen.add(timestamp);\n    return true;');
  replace('var glucose_data = [data[0]];', 'var glucose_data = [];');
  replace('glucose_data2.push(glucose_data[glucose_data.length - 1]);', 'if (glucose_data.length > 1) glucose_data2.push(glucose_data[glucose_data.length - 1]);');
  replace('  var timeTotal = 0;\n  for (i = 1; i <= glucose_data.length - 2; i++) {', "  if (!glucose_data.length) {\n    $('#glucosedistribution-days').text(translate('Result is empty'));\n    $('#glucosedistribution-overviewchart').empty();\n    return;\n  }\n\n  var timeTotal = 0;\n  for (i = 0; i <= glucose_data.length - 2; i++) {");
  replace('if (timeDelta < maxGap) {', 'if (timeDelta > 0 && timeDelta <= maxGap) {');
  replace('var RMS = Math.sqrt(RMSTotal / events);', 'var RMS = Math.sqrt(glucose_data.reduce(function(sum, entry) {\n    return sum + Math.pow(Math.max(options.targetLow - entry.sgv, entry.sgv - options.targetHigh, 0), 2);\n  }, 0) / glucose_data.length);');
  replace('  stabilitytable.appendTo(stability);', "  // Interval-dependent metrics are undefined for isolated readings; do not\n  // present NaN/Infinity as a result. Reading-based RMS and GMI remain valid.\n  stabilitytable.find('td').each(function() {\n    if (/NaN|Infinity/.test($(this).text())) $(this).text('N/A');\n  });\n  stabilitytable.appendTo(stability);");
  replace("    $('#glucosedistribution-days').text(translate('Result is empty'));\n    return;", "    $('#glucosedistribution-days').text(translate('Result is empty'));\n    $('#glucosedistribution-overviewchart').empty();\n    return;");
  // No health-derived diagnostics in the console.
  source = source.replace(/^  console\.log\([^\n]+\);$/gm, '');
  return source;
}

export async function buildReportAdapter() {
  const result = await build({
    entryPoints: [path.join(root, 'platform/report-adapter.js')], bundle: true,
    platform: 'browser', format: 'iife', write: false, logLevel: 'silent', define: { global: 'window' },
    plugins: [{ name: 'nscf-distribution-overlay', setup(builder) {
      builder.onLoad({ filter: /[/\\]report_plugins[/\\](glucosedistribution|hourlystats|daytoday)\.js$/ }, async ({path: filename}) => ({
        contents: (filename === distributionPath ? patchDistribution : filename.endsWith('hourlystats.js') ? patchHourly : patchDayToday)(await readFile(filename, 'utf8')),
        loader: 'js', resolveDir: path.dirname(filename),
      }));
    } }],
  });
  return result.outputFiles[0].text;
}

export function patchHourly(source) {
  function replace(before, after) {
    if (source.split(before).length !== 2) throw new Error('Hourly patch anchor changed');
    source = source.replace(before, after);
  }
  replace('  data = data.filter(function(o) { return !isNaN(o.sgv); });', '  data = data.filter(function(o) { return Number.isFinite(Number(o.sgv)) && Number(o.sgv) > 0 && o.displayTime && Number.isFinite(o.displayTime.getTime()); });');
  replace('    var avg = Math.floor(pivotedByHour[hour].map(function(r) {', "    if (!pivotedByHour[hour].length) {\n      stats.push([new Date(times.hours(hour).msecs), null, null, null, null]);\n      $('<td>').text(display).appendTo(tr);\n      $('<td>').text('0 (0%)').appendTo(tr);\n      for (var col = 0; col < 7; col++) $('<td>').text('N/A').appendTo(tr);\n      table.append(tr);\n      return;\n    }\n    var avg = Math.round(10 * pivotedByHour[hour].map(function(r) {");
  replace('    }, 0) / pivotedByHour[hour].length);', '    }, 0) / pivotedByHour[hour].length) / 10;');
  return source;
}

export function patchCandles(source) {
  const from = '        function getAndDrawCandle(ctx, serie, width, data){';
  if (source.split(from).length !== 2) throw new Error('Candle patch anchor changed');
  return source.replace(from, from + '\n            if (data.slice(1).some(function(value) { return !Number.isFinite(value); })) return;');
}

export function patchDayToday(source) {
  function replace(before, after) {
    if (source.split(before).length !== 2) throw new Error('Day-to-day patch anchor changed');
    source=source.replace(before,after);
  }
  const start=source.indexOf('  function timeTicks(n,i) {'),end=source.indexOf('\n  function drawChart',start);
  if(start<0||end<0)throw new Error('Day-to-day time axis changed');
  source=source.slice(0,start)+"  function timeTicks(value) {\n    return profile.applyTimezone(window.moment(value)).format(client.settings.timeFormat === 24 ? 'HH:mm' : 'ha');\n  }\n"+source.slice(end);
  replace('      .domain(d3.extent(data.sgv, dateFn));', "      .domain([profile.parseInTimezone(day).toDate(), profile.parseInTimezone(day).add(1, 'day').toDate()]);");
  replace('    var dataRange = d3.extent(data.sgv, dateFn);', '    var dataRange = xScale2.domain();');
  replace(".attr('width', xScale2(dataRange[1] - xScale2(dataRange[0])))", ".attr('width', xScale2(dataRange[1]) - xScale2(dataRange[0]))");
  return source;
}
