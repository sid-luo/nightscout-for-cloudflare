import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { buildReportAdapter, patchDistribution, patchCandles } from './report-adapter-source.mjs';

const require = createRequire(new URL('../vendor/nightscout/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const moment = require('moment-timezone');
const profileFactory = require('./lib/profilefunctions');
const rawDistribution = require('./lib/report_plugins/glucosedistribution')();
const scale = require('./lib/constants').MMOL_TO_MGDL;
const adapter = await buildReportAdapter();

function fixture(units = 'mg/dl', timezone = 'UTC') {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://reports.invalid/report/', runScripts: 'outside-only' });
  const w = dom.window, $ = require('jquery')(w);
  w.$ = $; w.moment = moment; $.plot = () => {};
  const profile = profileFactory([{defaultProfile:'Default',startDate:'2020-01-01',store:{Default:{timezone,units:'mg/dl',basal:[{time:'00:00',value:1}]}}}],{moment});
  const plugin = {...rawDistribution};
  const hourly = {...require('./lib/report_plugins/hourlystats')()};
  const daytoday = {};
  const plugins = name => name === 'hourlystats' ? hourly : name === 'daytoday' ? daytoday : plugin;
  w.Nightscout = { client:{translate:v=>v,settings:{units},sbx:{data:{profile}}},report_plugins:plugins,report_plugins_preinit:()=>plugins };
  plugins.utils={localeDate:day=>String(day)};
  vm.runInContext(adapter, dom.getInternalVMContext());
  w.Nightscout.report_plugins_preinit({});
  $('body').html(plugin.html(w.Nightscout.client));
  function run(values,{interval=300000, hours, times}={}) {
    if(hours) for(let hour=0;hour<24;hour++) $('#glucosedistribution-'+hour).prop('checked',hours.includes(hour));
    const records=values.map((value,i)=>({bgValue:value,sgv:value/(units==='mmol'?scale:1),displayTime:new Date(times?.[i]??Date.parse('2026-09-08T00:00:00Z')+i*interval)}));
    plugin.report({allstatsrecords:records,alldays:1},['2026-09-08'],{targetLow:70/(units==='mmol'?scale:1),targetHigh:180/(units==='mmol'?scale:1)});
    return {count:Number($('#glucosedistribution-report tr').last().children().eq(2).text()),metrics:$('#glucosedistribution-stability tr').last().children().map((_,e)=>$(e).text()).get(),text:$('body').text()};
  }
  return {dom,$,profile,run,hourly};
}

for (const units of ['mg/dl','mmol']) {
  for(const values of [[100],[60,100],[60,100,140],[180,200,220],[100,100,100]]) {
    test(`Distribution ${units}: distinct readings ${values.join('/')} match independent GMI/RMS`,()=>{
      const f=fixture(units);try {
        const result=f.run(values),mean=values.reduce((a,b)=>a+b)/values.length;
        const rms=Math.sqrt(values.reduce((sum,v)=>sum+Math.max(70-v,v-180,0)**2,0)/values.length)/(units==='mmol'?scale:1);
        assert.equal(result.count,values.length);
        assert.deepEqual(result.metrics,[`${Math.round(rms*100)/100} ${units==='mmol'?'mmol/L':'mg/dl'}`,(3.31+.02392*mean).toFixed(1),(2.879+.023*mean).toFixed(1)]);
        assert.doesNotMatch(result.text,/NaN|Infinity/);
        if(values.length===1)assert.match(result.text,/N\/A/);
      } finally {f.dom.window.close();}
    });
  }
}
test('Distribution drops same-time duplicates even with distinct Date objects and sorts unsorted records',()=>{
 const f=fixture();try {const start=Date.parse('2026-09-08T00:00:00Z');const r=f.run([140,100,100,120],{times:[start+600000,start,start,start+300000]});assert.equal(r.count,3);assert.deepEqual(r.metrics,['0 mg/dl','6.2','5.6']);}finally{f.dom.window.close();}
});
test('Distribution interpolates a 15-minute gap once and preserves existing smoothing semantics',()=>{
 const f=fixture();try {const r=f.run([100,130],{interval:900000});assert.equal(r.count,4);assert.deepEqual(r.metrics,['0 mg/dl','6.1','5.5']);}finally{f.dom.window.close();}
});
test('Distribution sparse gap retains reading metrics and marks interval metrics unavailable',()=>{
 const f=fixture();try {const r=f.run([60,200],{interval:3600000});assert.equal(r.count,2);assert.deepEqual(r.metrics,['15.81 mg/dl','6.4','5.9']);assert.doesNotMatch(r.text,/NaN|Infinity/);}finally{f.dom.window.close();}
});
test('Distribution empty-hour selection and empty data clear all prior results without throwing',()=>{
 const f=fixture();try {f.run([100,110]);let r=f.run([100,110],{hours:[]});assert.deepEqual(r.metrics,[]);assert.match(r.text,/Result is empty/);r=f.run([]);assert.deepEqual(r.metrics,[]);assert.doesNotMatch(r.text,/NaN|Infinity/);}finally{f.dom.window.close();}
});
test('Distribution rejects nonfinite/invalid records without contaminating metrics',()=>{
 const f=fixture();try {const r=f.run([NaN,Infinity,0,38,100]);assert.equal(r.count,1);assert.deepEqual(r.metrics,['0 mg/dl','5.7','5.2']);}finally{f.dom.window.close();}
});

for (const [zone,day,hours] of [['America/Los_Angeles','2026-03-08',23],['America/Los_Angeles','2026-11-01',25],['GMT+5:30','2026-09-08',24],['UTC+5:45','2026-09-08',24],['Asia/Shanghai','2026-09-08',24]]) {
 test(`actual jQuery report GET bounds: ${zone} ${day} is ${hours} hours`,async()=>{
  const f=fixture('mg/dl',zone);try {
   const seen=[];f.$.ajaxTransport('+*',opts=>({send(headers,complete){seen.push({url:opts.url,headers});complete(200,'OK',{text:'[]'},'Content-Type: application/json');},abort(){}}));
   const start=f.profile.parseInTimezone(day).valueOf();
   for(const collection of ['entries','treatments','devicestatus']) {
    const field=collection==='entries'?'date':'created_at',toValue=n=>field==='date'?String(n):new Date(n).toISOString();
    const q=new URLSearchParams({[`find[${field}][$gte]`]:toValue(start),[`find[${field}][$lt]`]:toValue(start+86400000),count:'10000',tenant:'isolated'});
    await f.$.ajax({url:'/api/v1/'+collection+'.json?'+q,headers:{'api-secret':'synthetic-digest'},dataType:'json'});
    const actual=new URL(seen.at(-1).url,'https://reports.invalid').searchParams;
    assert.equal(actual.get(`find[${field}][$gte]`),toValue(start));assert.equal(actual.get(`find[${field}][$lt]`),toValue(start+hours*3600000));assert.equal(actual.get('tenant'),'isolated');assert.equal(seen.at(-1).headers['api-secret'],'synthetic-digest');
   }
  }finally{f.dom.window.close();}
 });
}
test('report overlay fails closed when locked source no longer matches',()=>assert.throws(()=>patchDistribution('changed upstream'),/anchor changed/));

for (const values of [[],[4.2],[4.2,4.4]]) test('Hourly stats: empty hours and fractional average '+values.join('/'),()=>{
 const f=fixture('mmol');try {
  f.$('body').html(f.hourly.html(f.dom.window.Nightscout.client));
  f.hourly.report({allstatsrecords:values.map(sgv=>({sgv,displayTime:new Date('2026-09-08T12:00:00Z')}))},[],{});
  assert.equal(f.$('#hourlystats-report table').first().find('tr').length,25);
  assert.doesNotMatch(f.$('#hourlystats-report').text(),/NaN|Infinity/);
  const row=f.$('#hourlystats-report table').first().find('tr').eq(13).find('td');
  assert.equal(row.eq(2).text(),values.length===2?'4.3':values.length===1?'4.2':'N/A');
 }finally{f.dom.window.close();}
});

test('report AJAX keeps the explicit tenant, auth, method and origin boundaries',async()=>{
 const f=fixture();try{
  f.dom.reconfigure({url:'https://reports.invalid/report/?tenant=chosen'});
  const seen=[];f.$.ajaxTransport('+*',opts=>({send(headers,complete){seen.push({url:opts.url,type:opts.type,headers});complete(200,'OK',{text:'[]'},'Content-Type: application/json');},abort(){}}));
  for(const [url,type,expected] of [['/api/v1/entries.json','GET','chosen'],['/api/v1/treatments/id','DELETE','chosen'],['/api/v1/profile.json?tenant=explicit','GET','explicit'],['https://external.invalid/api/v1/entries.json','GET',null],['/unrelated','GET',null]]){
   await f.$.ajax({url,type,headers:{'api-secret':'synthetic-digest'},dataType:'json'});
   const request=seen.at(-1);assert.equal(new URL(request.url,'https://reports.invalid').searchParams.get('tenant'),expected);assert.equal(request.type,type);
  }
 }finally{f.dom.window.close();}
});

test('actual candle renderer ignores empty hours and only draws finite geometry',async()=>{
 const code=patchCandles(await readFile(new URL('../vendor/nightscout/static/report/js/flotcandle.js',import.meta.url),'utf8'));
 const $={plot:{plugins:[]}};vm.runInNewContext(code,{$});
 const plot={hooks:{processOptions:[],drawSeries:[]},getPlotOffset:()=>({left:0,top:0})};
 $.plot.plugins[0].init(plot);plot.hooks.processOptions[0](plot,{series:{candle:true}});
 const series={candle:true,data:[[0,null,null,null,null],[3600000,4.2,4.4,4,5]],xaxis:{p2c:x=>Number(x)/3600000},yaxis:{p2c:y=>y}};
 let draws=0;const ctx=new Proxy({}, {get(_target,name){if(['fillRect','strokeRect','moveTo','lineTo'].includes(name))return (...coords)=>{assert.ok(coords.every(Number.isFinite));draws++;};return ()=>{};},set(){return true;}});
 plot.hooks.drawSeries[0](plot,ctx,series);assert.ok(draws>0);
 series.data[1]=[3600000,null,null,null,null];draws=0;plot.hooks.drawSeries[0](plot,ctx,series);assert.equal(draws,0);
});

function reportControls(f) {
 f.$('body').append('<input type="checkbox" id="rp_enabledate" checked><input id="rp_from" value="2026-09-05"><input id="rp_to" value="2026-09-07"><input id="rp_targetlow" value="70"><input id="rp_targethigh" value="180"><button id="rp_show">Show</button><div id="info"></div><div id="pluginchartplaceholders">old result</div>'+['mo','tu','we','th','fr','sa','su'].map(day=>'<input type="checkbox" checked id="rp_'+day+'">').join(''));
}
for(const [label,change,message] of [
 ['empty date',f=>f.$('#rp_from').val(''),'valid dates'],
 ['invalid calendar date',f=>f.$('#rp_from').val('2026-02-30'),'valid dates'],
 ['reversed dates',f=>f.$('#rp_to').val('2026-09-01'),'valid dates'],
 ['unbounded range',f=>f.$('#rp_from').val('2020-01-01'),'185 days'],
 ['invalid targets',f=>f.$('#rp_targetlow').val('200'),'target range'],
 ['no weekdays',f=>f.$('input[type=checkbox]').prop('checked',false),'Result is empty'],
])test('report form blocks '+label+' and hides stale results',()=>{
 const f=fixture();try{reportControls(f);let called=0;f.$('#rp_show').on('click',()=>called++);change(f);f.dom.window.document.getElementById('rp_show').click();assert.equal(called,0);assert.match(f.$('#info').text(),new RegExp(message));assert.equal(f.$('#pluginchartplaceholders').css('display'),'none');
 f.$('#rp_from').val('2026-09-05');f.$('#rp_to').val('2026-09-07');f.$('#rp_targetlow').val('70');f.$('input[type=checkbox]').prop('checked',true);f.dom.window.document.getElementById('rp_show').click();assert.equal(called,1);assert.notEqual(f.$('#pluginchartplaceholders').css('display'),'none');}finally{f.dom.window.close();}
});
test('report request failure cancels other pending reads and restores a retryable form',()=>{
 const f=fixture();try{reportControls(f);f.$('#rp_show').hide();const completions=[];let aborted=0;f.$.ajaxTransport('+*',()=>({send(_headers,done){completions.push(done);},abort(){aborted++;}}));
 const a=f.$.ajax({url:'/api/v1/entries.json',dataType:'json'}),b=f.$.ajax({url:'/api/v1/treatments.json',dataType:'json'});
 completions[0](503,'Unavailable',{text:'private service detail'});
 assert.equal(a.state(),'rejected');assert.equal(b.state(),'rejected');assert.equal(aborted,1);assert.match(f.$('#info').text(),/Please retry/);assert.doesNotMatch(f.$('#info').text(),/private/);assert.notEqual(f.$('#rp_show').css('display'),'none');assert.equal(f.$('#pluginchartplaceholders').css('display'),'none');
 }finally{f.dom.window.close();}
});
