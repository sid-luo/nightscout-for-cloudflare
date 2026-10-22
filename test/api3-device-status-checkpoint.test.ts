import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { Api3DeviceStatusQueryCache } from "../src/api3/device-status-query-cache";
import { SqliteDocumentRepository, type DbDocumentV4, type DocumentQuery } from "../src/document-repository";
import type { EntryStore } from "../src/entry-store";

const AT = Date.UTC(2026,9,21,10);
const id=(n:number)=>n.toString(16).padStart(24,"0");
const OPTIONS=JSON.stringify({canCreate:true,canUpdate:true,actor:null,ifUnmodifiedSince:null,validate:false,emitRealtime:false});
function seed(sql:SqlStorage,count=12000) {
  sql.exec(`WITH RECURSIVE sequence(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM sequence WHERE n<?)
    INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,identifier_present,
      srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
    SELECT 'devicestatus',printf('%024x',n),json_object('_id',printf('%024x',n),'identifier','seed-'||n,
      'date',?+n*1000,'created_at',strftime('%Y-%m-%dT%H:%M:%fZ',(?+n*1000)/1000.0,'unixepoch'),
      'device','present','rank',n%13),?+n*1000,?+n*1000,?+n*1000,'seed-'||n,1,?+n*1000,
      ?+n*1000,?+n*1000,1,1,1 FROM sequence`,count-1,AT,AT,AT,AT,AT,AT,AT,AT);
}
const missing:DocumentQuery={limit:1,filters:[{field:"device",operator:"eq",value:"absent"}]};
const ranked:DocumentQuery={limit:3,sort:{field:"rank",direction:"desc"},fields:["identifier","rank"]};
const window:DocumentQuery={limit:1,filters:[{field:"device",operator:"eq",value:"absent"},
  {field:"created_at",operator:"gte",value:new Date(AT).toISOString()}]};
const read=(instance:EntryStore,query:DocumentQuery)=>instance.api3QueryCollection("devicestatus",JSON.stringify(query));
const oracle=(storage:DurableObjectStorage,query:DocumentQuery)=>JSON.stringify({ok:true,
  result:new SqliteDocumentRepository(storage).queryDocumentsForApi3("devicestatus",query)});
async function measure<T>(sql:SqlStorage,action:()=>T|Promise<T>) {
  const exec=sql.exec.bind(sql),calls:{sql:string;cursor:SqlStorageCursor<Record<string,SqlStorageValue>>}[]=[];
  const spy=vi.spyOn(sql,"exec").mockImplementation((statement,...bindings)=>{
    const cursor=exec(statement,...bindings);calls.push({sql:statement,cursor});return cursor;
  });
  try{return{value:await action(),reads:calls.reduce((n,c)=>n+c.cursor.rowsRead,0),
    writes:calls.reduce((n,c)=>n+c.cursor.rowsWritten,0),nativeReads:calls.filter(c=>/FROM documents/.test(c.sql))
      .reduce((n,c)=>n+c.cursor.rowsRead,0),statements:calls.map(c=>c.sql)};}
  finally{spy.mockRestore();}
}
interface Internal {api3DeviceStatusQueries:Api3DeviceStatusQueryCache<DbDocumentV4>}
interface Snapshot {format:string;entries:{query:DocumentQuery;planKey:string;rows:DbDocumentV4[]}[]}

describe("API3 device-status checkpoint payload",()=>{
  it("restores only exact freshly compiled native plans and bounded raw canonical rows, without SQL",async()=>{
    const stub=env.ENTRY_STORE.getByName(`api3-checkpoint-codec-${crypto.randomUUID()}`);
    await runInDurableObject(stub,async(instance:EntryStore,state)=>{
      seed(state.storage.sql,100);
      for(const query of [missing,ranked,window]) await read(instance,query);
      const current=(instance as unknown as Internal).api3DeviceStatusQueries;
      const snapshot=current.snapshotCheckpoint() as Snapshot;
      expect(snapshot.entries).toHaveLength(3);
      const copy=new Api3DeviceStatusQueryCache<DbDocumentV4>();
      const restored=await measure(state.storage.sql,()=>copy.restoreCheckpoint(structuredClone(snapshot)));
      expect(restored).toMatchObject({value:true,reads:0,writes:0});
      const noLoad=()=>{throw new Error("Checkpoint must satisfy the exact native plan");};
      const revision=copy.checkpointRevision;
      expect(copy.read(missing,SqliteDocumentRepository.compileApi3DeviceStatusPlan(missing),noLoad)).toEqual([]);
      const shifted={...window,filters:[window.filters![0]!,{field:"created_at",operator:"gte" as const,
        value:new Date(AT+60000).toISOString()}]};
      expect(copy.read(shifted,SqliteDocumentRepository.compileApi3DeviceStatusPlan(shifted),noLoad)).toEqual([]);
      expect(copy.checkpointRevision).toBe(revision);
      expect(copy.fork().checkpointRevision).toBe(revision);
      const mutations:((value:Snapshot)=>void)[]=[
        value=>{value.format="old-format";},
        value=>{value.entries[0]!.planKey+="; DELETE FROM documents";},
        value=>{value.entries[1]!.query.sort={field:"device",direction:"asc"};},
        value=>{value.entries[1]!.rows[0]!.body="{broken-json";},
        value=>{value.entries[1]!.rows[0]!.sort_time=Number.NaN;},
        value=>{value.entries[1]!.rows[0]!.collection="food";},
        value=>{value.entries[1]!.rows[1]=structuredClone(value.entries[1]!.rows[0]!);},
        value=>{value.entries[1]!.rows[0]!.unknown_column="untrusted";},
      ];
      for(const mutate of mutations) {
        const changed=structuredClone(snapshot);mutate(changed);
        expect(await measure(state.storage.sql,()=>new Api3DeviceStatusQueryCache<DbDocumentV4>().restoreCheckpoint(changed)))
          .toMatchObject({value:false,reads:0,writes:0});
      }
      expect(new Api3DeviceStatusQueryCache<DbDocumentV4>(1).restoreCheckpoint(snapshot)).toBe(false);
      expect(new Api3DeviceStatusQueryCache<DbDocumentV4>(16,1024,1024).restoreCheckpoint(snapshot)).toBe(false);
      expect(state.storage.sql.exec<{count:number}>("SELECT COUNT(*) AS count FROM documents WHERE collection='devicestatus'").one().count).toBe(100);
    });
  });

  it("reuses newly enrolled native plans after every 15-second eviction and maintains them on cold minute uploads",async()=>{
    let now=AT+20000000;
    const clock=vi.spyOn(Date,"now").mockImplementation(()=>now);
    const stub=env.ENTRY_STORE.getByName(`api3-checkpoint-every-cold-${crypto.randomUUID()}`);
    const report:{initial:{reads:number;writes:number;nativeReads:number}[];
      polls:{reads:number;writes:number;nativeReads:number}[];uploads:{reads:number;writes:number;nativeReads:number}[]}=
      {initial:[],polls:[],uploads:[]};
    try {
      await runInDurableObject(stub,async(instance:EntryStore,state)=>{
        seed(state.storage.sql);
        for(const query of [missing,ranked,window]) {
          const initial=await measure(state.storage.sql,()=>read(instance,query));
          expect(initial.value).toBe(oracle(state.storage,query));
          expect(initial.nativeReads).toBeGreaterThanOrEqual(12000);
          report.initial.push({reads:initial.reads,writes:initial.writes,nativeReads:initial.nativeReads});
        }
      });
      for(let tick=0;tick<16;tick++) {
        now=AT+20000000+tick*15000;
        await evictDurableObject(stub);
        if(tick%4===0) {
          const upload=await runInDurableObject(stub,async(instance:EntryStore,state)=>{
            const result=await measure(state.storage.sql,()=>instance.api3CreateDocument("devicestatus",JSON.stringify({
              _id:id(20000+tick),identifier:`cold-upload-${tick}`,date:now,created_at:new Date(now).toISOString(),
              device:tick===12?"absent":"present",rank:100+tick,
            }),OPTIONS));
            expect(JSON.parse(result.value)).toMatchObject({ok:true});
            expect(result.nativeReads).toBeLessThan(128);
            return {reads:result.reads,writes:result.writes,nativeReads:result.nativeReads};
          });
          report.uploads.push(upload);
          await evictDurableObject(stub);
        }
        report.polls.push(await runInDurableObject(stub,async(instance:EntryStore,state)=>{
          const shifted:DocumentQuery={...window,filters:[window.filters![0]!,
            {field:"created_at",operator:"gte",value:new Date(AT+tick*15000).toISOString()}]};
          const queries=[missing,ranked,shifted];
          const expected=queries.map(query=>oracle(state.storage,query));
          const poll=await measure(state.storage.sql,()=>Promise.all(queries.map(query=>read(instance,query))));
          expect(poll.value).toEqual(expected);
          // Before the first matching upload, empty narrowing is SQL-free.
          // Afterwards the changing window uses only its selected primary key.
          if(tick<12) expect(poll.nativeReads).toBe(0);
          else {expect(poll.nativeReads).toBeGreaterThan(0);expect(poll.nativeReads).toBeLessThanOrEqual(8);}
          expect(poll.reads).toBeLessThan(200);
          expect(poll.writes).toBe(0);
          return {reads:poll.reads,writes:poll.writes,nativeReads:poll.nativeReads};
        }));
      }
      expect(report).toMatchSnapshot("every-15s cold API3 native checkpoint budget");
      console.info(`API3_CHECKPOINT_EVERY_COLD=${JSON.stringify(report)}`);
    } finally {clock.mockRestore();}
  });

  it("invalidates persisted plans for direct source changes, deletion, failed callbacks and schema repair",async()=>{
    const stub=env.ENTRY_STORE.getByName(`api3-checkpoint-mutations-${crypto.randomUUID()}`);
    await runInDurableObject(stub,async(instance:EntryStore,state)=>{
      seed(state.storage.sql,100);
      await read(instance,missing);await read(instance,ranked);
      const internal=instance as unknown as Internal & {recordDataMutationInTransaction(collection:string):void};
      const original=internal.recordDataMutationInTransaction;
      internal.recordDataMutationInTransaction=()=>{throw new Error("checkpoint callback rollback");};
      try {
        expect(JSON.parse(await instance.api3CreateDocument("devicestatus",JSON.stringify({
          _id:id(1001),identifier:"rolledback",date:AT,created_at:new Date(AT).toISOString(),device:"absent",rank:100,
        }),OPTIONS))).toMatchObject({ok:false,message:"checkpoint callback rollback"});
      } finally {internal.recordDataMutationInTransaction=original;}
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub,async(instance:EntryStore,state)=>{
      const restored=await measure(state.storage.sql,()=>read(instance,missing));
      expect(restored).toMatchObject({value:oracle(state.storage,missing),nativeReads:0,writes:0});
      // No EntryStore callback participates in direct SQL, including a second
      // change while both persisted valid bits are already clear.
      state.storage.sql.exec("UPDATE documents SET body=json_set(body,'$.device','absent') WHERE collection='devicestatus' AND id=?",id(3));
      state.storage.sql.exec("UPDATE documents SET body=json_set(body,'$.device','absent') WHERE collection='devicestatus' AND id=?",id(4));
      const invalid=await measure(state.storage.sql,()=>read(instance,missing));
      expect(invalid.value).toBe(oracle(state.storage,missing));expect(invalid.nativeReads).toBeGreaterThan(0);
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub,async(instance:EntryStore,state)=>{
      const selected=JSON.parse(await read(instance,ranked)).result[0].identifier as string;
      expect(await instance.api3DeleteDocument("devicestatus",selected,true,null)).toMatchObject({deleted:true});
      expect(await read(instance,ranked)).toBe(oracle(state.storage,ranked));
      state.storage.sql.exec("DROP TRIGGER nscf_ds_checkpoint_update");
      state.storage.sql.exec("UPDATE documents SET body=json_set(body,'$.rank',1000) WHERE collection='devicestatus' AND id=?",id(99));
    });
    await evictDurableObject(stub);
    await runInDurableObject(stub,async(instance:EntryStore,state)=>{
      const repaired=await measure(state.storage.sql,()=>read(instance,ranked));
      expect(repaired.value).toBe(oracle(state.storage,ranked));expect(repaired.nativeReads).toBeGreaterThan(0);
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='trigger' AND name='nscf_ds_checkpoint_update'").toArray()).toHaveLength(1);
    });
  });

  it("narrows nonempty native prefixes only when all selected rows survive or the old result is complete",async()=>{
    const stub=env.ENTRY_STORE.getByName(`api3-checkpoint-selected-window-${crypto.randomUUID()}`);
    await runInDurableObject(stub,async(instance:EntryStore,state)=>{
      seed(state.storage.sql,3);
      const query=(lower:number,limit:number,skip=0):DocumentQuery=>({limit,skip,
        filters:[{field:"date",operator:"gte",value:lower}],sort:{field:"date",direction:"desc"}});
      const isHistory=(statement:string)=>/FROM documents\s+WHERE/.test(statement) && !statement.includes("LIMIT -1");
      await read(instance,query(AT,2));
      const surviving=await measure(state.storage.sql,()=>read(instance,query(AT+1000,2)));
      expect(surviving.value).toBe(oracle(state.storage,query(AT+1000,2)));
      expect(surviving.statements.some(isHistory)).toBe(false);expect(surviving.nativeReads).toBeLessThanOrEqual(8);
      expect(surviving.writes).toBe(0);
      // One of the full prefix's rows leaves. We cannot treat its unknown
      // suffix as absent, so retain the native whole-history fallback.
      const lost=await measure(state.storage.sql,()=>read(instance,query(AT+2000,2)));
      expect(lost.value).toBe(oracle(state.storage,query(AT+2000,2)));
      expect(lost.statements.some(isHistory)).toBe(true);
      await read(instance,query(AT,10));
      const complete=await measure(state.storage.sql,()=>read(instance,query(AT+1000,10)));
      expect(complete.value).toBe(oracle(state.storage,query(AT+1000,10)));
      expect(complete.statements.some(isHistory)).toBe(false);expect(complete.writes).toBe(0);
      await read(instance,query(AT,1,1));
      const skipped=await measure(state.storage.sql,()=>read(instance,query(AT+1000,1,1)));
      expect(skipped.value).toBe(oracle(state.storage,query(AT+1000,1,1)));
      expect(skipped.statements.some(isHistory)).toBe(true);
    });
  });
});
