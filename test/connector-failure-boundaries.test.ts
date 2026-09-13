import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { SourceConnector } from '../src/source-connector';
import { WebhookDelivery, type WebhookEnvironment, type WebhookPayload } from '../src/webhook-delivery';
import type { SourceEnvironment } from '../src/connectors/config';

afterEach(()=>vi.unstubAllGlobals());
const sourceKey='source-connector-v1', webhookKey='webhook-outbox-v1';
const name=()=>`failure-${crypto.randomUUID()}`;
const payload=(mills:number):WebhookPayload=>({source:'nightscout',mgdl:110,mills,iso:new Date(mills).toISOString()});
function restore(target:Record<string,unknown>,before:Record<string,unknown>){for(const k of Object.keys(target))if(!(k in before))delete target[k];Object.assign(target,before);}

it('source auth failure clears only its session, retains cursor and schedules backoff without health detail',async()=>{
 const tenant=name(),stub=env.SOURCE_CONNECTOR.getByName(tenant);
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('private credential diagnostic',{status:401})));
 await runInDurableObject(stub,async(instance,state)=>{
  const target=(instance as unknown as {env:SourceEnvironment}).env;const before={...target};
  try{
   Object.assign(target,{ENABLE:'connect',CONNECT_SOURCE:'nightscout',CONNECT_SOURCE_ENDPOINT:'https://source.example.test?token=synthetic',CONNECT_SOURCE_COLLECTIONS:'entries'});
   await (instance as SourceConnector).reconcile(tenant);await state.storage.setAlarm(Date.now()+600000);
   const original=await state.storage.get<Record<string,unknown>>(sourceKey);
   const since=Date.now()-600000;
   await state.storage.put(sourceKey,{...original,nextDue:0,progress:{cursors:{entries:{since,afterId:'111111111111111111111111'}},session:{expires:Date.now()+3600000,data:{bearer:'synthetic-session'}}}});
   const started=Date.now();await (instance as SourceConnector).alarm();
   const saved=await state.storage.get<{progress:{session?:unknown;cursors:{entries:{since:number}}};nextDue:number}>(sourceKey);
   expect(saved?.progress.session).toBeUndefined();expect(saved?.progress.cursors.entries.since).toBe(since);expect(saved?.nextDue).toBeGreaterThanOrEqual(started+1800000);
   const status=await (instance as SourceConnector).statusJson(tenant);expect(JSON.parse(status)).toMatchObject({state:'backoff',consecutiveFailures:1,lastErrorCode:'authentication_failed'});expect(status).not.toMatch(/private|synthetic|bearer/);
  }finally{restore(target as Record<string,unknown>,before);await state.storage.deleteAlarm();}
 });
});

it('disabling a source while its request is in flight prevents the stale result from being ingested',async()=>{
 const tenant=name(),stub=env.SOURCE_CONNECTOR.getByName(tenant);
 await runInDurableObject(stub,async(instance,state)=>{
  const target=(instance as unknown as {env:SourceEnvironment}).env,before={...target};
  try{
   Object.assign(target,{ENABLE:'connect',CONNECT_SOURCE:'nightscout',CONNECT_SOURCE_ENDPOINT:'https://source.example.test',CONNECT_SOURCE_COLLECTIONS:'entries'});
   await (instance as SourceConnector).reconcile(tenant);await state.storage.setAlarm(Date.now()+600000);await state.storage.put(sourceKey,{...await state.storage.get<Record<string,unknown>>(sourceKey),nextDue:0});
   vi.stubGlobal('fetch',async()=>{target.ENABLE='';await (instance as SourceConnector).reconcile(tenant);return Response.json([{_id:'111111111111111111111111',type:'sgv',sgv:110,date:Date.now()-1000}]);});
   await (instance as SourceConnector).alarm();expect(await state.storage.get(sourceKey)).toBeUndefined();expect(await state.storage.getAlarm()).toBeNull();
  }finally{restore(target as Record<string,unknown>,before);await state.storage.deleteAlarm();}
 });
 expect(await env.ENTRY_STORE.getByName(tenant).getEntries({count:10,filters:[],sort:[{field:'date',direction:'desc'}]})).toHaveLength(0);
});

it('webhook keeps one in-flight request, ignores duplicate/older observations, and queues only the newest',async()=>{
 const stub=env.WEBHOOK_DELIVERY.getByName(name()),now=Date.now();
 await runInDurableObject(stub,async(instance,state)=>{
  const target=(instance as unknown as {env:WebhookEnvironment}).env,before={...target};
  try{
   Object.assign(target,{ENABLE:'webhook',WEBHOOK_HOST:'receiver.example.test'});
   const job=instance as WebhookDelivery;await job.observe(payload(now-600000));await job.observe(payload(now-300000));await state.storage.setAlarm(Date.now()+600000);
   const queued=await state.storage.get<{pending:{nextDue:number}}>(webhookKey);queued!.pending.nextDue=Date.now()-1;await state.storage.put(webhookKey,queued);
   let arrived!:()=>void, release!:(r:Response)=>void;const seen=new Promise<void>(resolve=>arrived=resolve);
   const sender=vi.fn(async()=>{arrived();return new Promise<Response>(resolve=>release=resolve);});vi.stubGlobal('fetch',sender);
   const running=job.alarm();await seen;
   await job.observe(payload(now-300000));await job.observe(payload(now-900000));await job.observe(payload(now-200000));await job.observe(payload(now-100000));
   expect(sender).toHaveBeenCalledTimes(1);release(new Response(null,{status:204}));await running;
   const saved=await state.storage.get<{pending:{payload:WebhookPayload};lastSuccess:number;queued?:unknown}>(webhookKey);
   expect(saved?.lastSuccess).toBe(now-300000);expect(saved?.pending.payload.mills).toBe(now-100000);expect(saved?.queued).toBeUndefined();
  }finally{restore(target as Record<string,unknown>,before);await state.storage.deleteAlarm();}
 });
});

it('webhook redirect stays pending and endpoint rotation drops the old queue and resets the baseline',async()=>{
 const stub=env.WEBHOOK_DELIVERY.getByName(name()),now=Date.now();
 await runInDurableObject(stub,async(instance,state)=>{
  const target=(instance as unknown as {env:WebhookEnvironment}).env,before={...target};
  try{
   Object.assign(target,{ENABLE:'webhook',WEBHOOK_HOST:'receiver.example.test'});const job=instance as WebhookDelivery;
   await job.observe(payload(now-600000));await job.observe(payload(now-300000));await state.storage.setAlarm(Date.now()+600000);
   const queued=await state.storage.get<{pending:{nextDue:number}}>(webhookKey);queued!.pending.nextDue=Date.now()-1;await state.storage.put(webhookKey,queued);
   const sender=vi.fn(async()=>new Response(null,{status:302,headers:{location:'https://untrusted.example.test'}}));vi.stubGlobal('fetch',sender);
   await job.alarm();expect(sender).toHaveBeenCalledTimes(1);expect(JSON.parse(await job.statusJson())).toMatchObject({pending:true,lastErrorCode:'http_error',attempts:1});
   target.WEBHOOK_HOST='replacement.example.test';await job.statusJson();expect(await state.storage.get(webhookKey)).toBeUndefined();expect(await state.storage.getAlarm()).toBeNull();
   await job.observe(payload(now-300000));expect(JSON.parse(await job.statusJson())).toMatchObject({pending:false,lastSuccessAt:null});expect(sender).toHaveBeenCalledTimes(1);
  }finally{restore(target as Record<string,unknown>,before);await state.storage.deleteAlarm();}
 });
});

it('webhook rejects malformed observations before creating state or making requests',async()=>{
 const stub=env.WEBHOOK_DELIVERY.getByName(name());const sender=vi.fn();vi.stubGlobal('fetch',sender);
 await runInDurableObject(stub,async(instance,state)=>{
  for(const value of [null,{}, {...payload(Date.now()-1000),mgdl:NaN},{...payload(Date.now()-1000),iso:'wrong'},payload(Date.now()+3600000)])await expect((instance as WebhookDelivery).observe(value as WebhookPayload)).rejects.toThrow();
  expect(await state.storage.get(webhookKey)).toBeUndefined();expect(await state.storage.getAlarm()).toBeNull();expect(sender).not.toHaveBeenCalled();
 });
});
