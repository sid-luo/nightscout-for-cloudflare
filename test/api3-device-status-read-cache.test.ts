import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { Api3DeviceStatusQueryCache, type Api3DeviceStatusPlan } from "../src/api3/device-status-query-cache";
import { parseApi3Search } from "../src/api3/input";
import { SqliteDocumentRepository, type DocumentQuery, type DbDocumentV4 } from "../src/document-repository";
import type { EntryStore, JsonDocument } from "../src/entry-store";

const AT = Date.UTC(2026, 9, 21, 10);
const OPTIONS = JSON.stringify({ canCreate: true, canUpdate: true, actor: null,
  ifUnmodifiedSince: null, validate: false, emitRealtime: false });
const id = (n: number) => n.toString(16).padStart(24, "0");
function seed(sql: SqlStorage, count = 12000): void {
  sql.exec(`WITH RECURSIVE sequence(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM sequence WHERE n < ?)
    INSERT INTO documents(collection,id,body,sort_time,created_at,updated_at,identifier,identifier_present,
      srv_created,srv_modified,effective_modified,is_valid,revision,srv_metadata_version)
    SELECT 'devicestatus',printf('%024x',n),json_object('_id',printf('%024x',n),'identifier','seed-'||n,
      'date',?+n*1000,'created_at',strftime('%Y-%m-%dT%H:%M:%fZ',(?+n*1000)/1000.0,'unixepoch'),
      'device','present','rank',n%13),?+n*1000,?+n*1000,?+n*1000,'seed-'||n,1,?+n*1000,
      ?+n*1000,?+n*1000,1,1,1 FROM sequence`, count-1,AT,AT,AT,AT,AT,AT,AT,AT);
}
function oracle(storage: DurableObjectStorage, query: DocumentQuery): string {
  return JSON.stringify({ ok: true, result: new SqliteDocumentRepository(storage).queryDocumentsForApi3("devicestatus", query) });
}
async function measured<T>(sql: SqlStorage, action: () => Promise<T>) {
  const exec = sql.exec.bind(sql);
  const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  const statements: string[] = [];
  const spy = vi.spyOn(sql,"exec").mockImplementation((statement,...bindings) => {
    const cursor=exec(statement,...bindings); cursors.push(cursor); statements.push(statement); return cursor;
  });
  try { return { value: await action(), reads: cursors.reduce((n,c)=>n+c.rowsRead,0),
    writes: cursors.reduce((n,c)=>n+c.rowsWritten,0),
    nativeReads: cursors.reduce((n,c,index)=>n+(/FROM documents/.test(statements[index]!)?c.rowsRead:0),0), statements }; }
  finally { spy.mockRestore(); }
}
function read(instance: EntryStore, query: DocumentQuery): Promise<string> {
  return instance.api3QueryCollection("devicestatus", JSON.stringify(query));
}
function payload(n: number, extra: JsonDocument = {}): JsonDocument {
  return { _id: id(n), identifier: `upload-${n}`, date: AT+n*1000,
    created_at: new Date(AT+n*1000).toISOString(), device: "present", rank: n%13, ...extra };
}
interface Internals {
  api3DeviceStatusQueries: Api3DeviceStatusQueryCache<DbDocumentV4>;
  recordDataMutationInTransaction(collection: string): void;
}

describe("API3 devicestatus native query cache", () => {
  it("keeps empty device polls, moving lower windows and custom sorts cheap through continuous uploads", async () => {
    const stub=env.ENTRY_STORE.getByName(`api3-device-budget-${crypto.randomUUID()}`);
    const report=await runInDurableObject(stub,async(instance: EntryStore,state)=>{
      seed(state.storage.sql);
      const missing: DocumentQuery={limit:1,filters:[{field:"device",operator:"eq",value:"absent"}]};
      const sorted: DocumentQuery={limit:3,sort:{field:"rank",direction:"desc"},fields:["identifier","rank"]};
      const window: DocumentQuery={limit:1,filters:[{field:"device",operator:"eq",value:"absent"},
        {field:"created_at",operator:"gte",value:new Date(AT).toISOString()}]};
      const cases=[missing,sorted,window];
      const cold=[];
      for (const query of cases) {
        const expected=oracle(state.storage,query);
        const first=await measured(state.storage.sql,()=>read(instance,query));
        expect(first.value).toBe(expected); expect(first.reads).toBeGreaterThanOrEqual(12000);
        expect(first.writes).toBeGreaterThan(0); cold.push(first.reads);
        expect(await measured(state.storage.sql,()=>read(instance,query))).toMatchObject({value:expected,nativeReads:0,writes:0});
      }
      let uploadReads=0;
      for(let n=12000;n<12010;n++) {
        const upload=await measured(state.storage.sql,()=>instance.api3CreateDocument("devicestatus",JSON.stringify(payload(n)),OPTIONS));
        expect(JSON.parse(upload.value)).toMatchObject({ok:true});
        expect(upload.reads).toBeLessThan(200); uploadReads+=upload.reads;
        const shifted: DocumentQuery={...window,filters:[window.filters![0]!,
          {field:"created_at",operator:"gte",value:new Date(AT+(n-12000+1)*60000).toISOString()}]};
        for(const query of [missing,sorted,shifted]) {
          const expected=oracle(state.storage,query);
          expect(await measured(state.storage.sql,()=>read(instance,query))).toMatchObject({value:expected,nativeReads:0,writes:0});
        }
      }
      // A newly matching device must replace the empty proof immediately.
      expect(JSON.parse(await instance.api3CreateDocument("devicestatus",JSON.stringify(payload(13000,{device:"absent",rank:100})),OPTIONS)))
        .toMatchObject({ok:true});
      for(const query of cases) {
        const expected=oracle(state.storage,query);
        expect(await measured(state.storage.sql,()=>read(instance,query))).toMatchObject({value:expected,nativeReads:0,writes:0});
      }
      return {cold,uploadReads,uploads:10};
    });
    console.info(`API3_DEVICE_QUERY_CACHE_BUDGET=${JSON.stringify(report)}`);
  });

  it("uses original SQL for mixed types, array membership, missing fields, ties and storage projections", async()=>{
    const stub=env.ENTRY_STORE.getByName(`api3-device-semantics-${crypto.randomUUID()}`);
    await runInDurableObject(stub,async(instance:EntryStore,state)=>{
      const bodies: JsonDocument[]=[
        {date:AT,created_at:new Date(AT).toISOString(),device:["present","other"],rank:1},
        {date:[AT,AT+1000],created_at:[new Date(AT).toISOString()],device:"present",rank:"1"},
        {date:String(AT),created_at:AT,device:null,rank:[1]},
        {created_at:new Date(AT+1000).toISOString(),rank:{value:1}},
        {date:AT,created_at:new Date(AT).toISOString(),device:"present",rank:1,isValid:false},
        {date:AT,created_at:new Date(AT).toISOString(),device:"present",rank:1},
      ];
      for(let n=0;n<bodies.length;n++) state.storage.sql.exec(`INSERT INTO documents(collection,id,body,sort_time,
        created_at,updated_at,identifier,identifier_present,is_valid,srv_metadata_version,revision)
        VALUES('devicestatus',?,?,?,?,?,?,1,?,1,1)`,id(n),JSON.stringify({...bodies[n],_id:id(n),identifier:`mixed-${n}`}),
      AT,AT,AT,`mixed-${n}`,bodies[n]!.isValid===false?0:1);
      const queries: DocumentQuery[]=[
        {limit:10,filters:[{field:"device",operator:"eq",value:"present"}]},
        {limit:10,filters:[{field:"device",operator:"exists",value:false}]},
        {limit:10,filters:[{field:"date",operator:"gte",value:AT}]},
        {limit:10,filters:[{field:"created_at",operator:"gte",value:new Date(AT).toISOString()}]},
        {limit:2,sort:[{field:"rank",direction:"desc"},{field:"created_at",direction:"asc"}],fields:["identifier","rank"]},
        {limit:10,includeDeleted:true,sort:{field:"rank",direction:"asc"},fields:["_all"]},
        {limit:1,skip:2,sort:{field:"rank",direction:"desc"}},
      ];
      for(const query of queries) {
        const expected=oracle(state.storage,query);
        expect(await read(instance,query)).toBe(expected);
        expect(await measured(state.storage.sql,()=>read(instance,query))).toMatchObject({value:expected,nativeReads:0,writes:0});
      }
      // New array-shaped legacy status takes the same native filter/order path.
      await instance.createDocuments("devicestatus",JSON.stringify([payload(90,{device:["present","other"],rank:[2]})]));
      for(const query of queries) expect(await read(instance,query)).toBe(oracle(state.storage,query));
      await instance.saveDocuments("devicestatus",JSON.stringify([payload(90,{device:["different"],rank:99})]));
      for(const query of queries) expect(await read(instance,query)).toBe(oracle(state.storage,query));
      expect(await instance.deleteDocuments("devicestatus",[id(90)])).toBe(1);
      for(const query of queries) expect(await read(instance,query)).toBe(oracle(state.storage,query));
    });
  });

  it("falls back after a full-prefix selected update or skipped predecessor delete, and preserves soft deletes", async()=>{
    const stub=env.ENTRY_STORE.getByName(`api3-device-mutations-${crypto.randomUUID()}`);
    await runInDurableObject(stub,async(instance:EntryStore,state)=>{
      seed(state.storage.sql,100);
      const top: DocumentQuery={limit:1,sort:{field:"rank",direction:"desc"},fields:["identifier","rank"]};
      const first=JSON.parse(await read(instance,top)).result[0].identifier as string;
      expect(JSON.parse(await instance.api3PatchDocument("devicestatus",first,'{"rank":-100}',OPTIONS))).toMatchObject({ok:true});
      const fallback=await measured(state.storage.sql,()=>read(instance,top));
      expect(fallback.value).toBe(oracle(state.storage,top)); expect(fallback.reads).toBeGreaterThan(100);
      const skip: DocumentQuery={limit:1,skip:2};
      await read(instance,skip);
      const preceding=new SqliteDocumentRepository(state.storage).queryDocumentsForApi3("devicestatus",{limit:1})[0]!.identifier as string;
      expect(await instance.api3DeleteDocument("devicestatus",preceding,true,null)).toMatchObject({deleted:true});
      const afterDelete=await measured(state.storage.sql,()=>read(instance,skip));
      expect(afterDelete.value).toBe(oracle(state.storage,skip)); expect(afterDelete.reads).toBeGreaterThan(0);
      const active: DocumentQuery={limit:1000,filters:[{field:"device",operator:"eq",value:"present"}]};
      const all={...active,includeDeleted:true};
      await read(instance,active); await read(instance,all);
      const target=new SqliteDocumentRepository(state.storage).queryDocumentsForApi3("devicestatus",{limit:1})[0]!.identifier as string;
      expect(await instance.api3DeleteDocument("devicestatus",target,false,null)).toMatchObject({deleted:true});
      for(const query of [active,all]) expect(await read(instance,query)).toBe(oracle(state.storage,query));
      const filtered: DocumentQuery={limit:1000,filters:[{field:"tag",operator:"eq",value:"special"}]};
      await read(instance,filtered);
      expect(JSON.parse(await instance.api3PatchDocument("devicestatus","seed-5",'{"tag":"special"}',OPTIONS))).toMatchObject({ok:true});
      expect(await read(instance,filtered)).toBe(oracle(state.storage,filtered));
      expect(JSON.parse(await instance.api3PatchDocument("devicestatus","seed-5",'{"tag":"gone"}',OPTIONS))).toMatchObject({ok:true});
      expect(await measured(state.storage.sql,()=>read(instance,filtered))).toMatchObject({value:oracle(state.storage,filtered),nativeReads:0,writes:0});
    });
  });

  it("restores the committed cache after callback rollback, including a query made inside the transaction",async()=>{
    const stub=env.ENTRY_STORE.getByName(`api3-device-rollback-${crypto.randomUUID()}`);
    await runInDurableObject(stub,async(instance:EntryStore,state)=>{
      seed(state.storage.sql,100);
      const query:DocumentQuery={limit:10,filters:[{field:"device",operator:"eq",value:"rolled-back"}]};
      expect(JSON.parse(await read(instance,query)).result).toEqual([]);
      const internal=instance as unknown as Internals;
      const original=internal.recordDataMutationInTransaction;
      let uncommitted:Promise<string>|undefined;
      internal.recordDataMutationInTransaction=()=>{
        uncommitted=read(instance,query); throw new Error("synthetic API3 device rollback");
      };
      try {
        const response=JSON.parse(await instance.api3CreateDocument("devicestatus",JSON.stringify(payload(1000,{device:"rolled-back"})),OPTIONS));
        expect(response).toMatchObject({ok:false,message:"synthetic API3 device rollback"});
        expect(JSON.parse(await uncommitted!).result).toHaveLength(1);
      } finally {internal.recordDataMutationInTransaction=original;}
      expect(await measured(state.storage.sql,()=>read(instance,query))).toMatchObject({value:oracle(state.storage,query),nativeReads:0,writes:0});
      expect(state.storage.sql.exec<{count:number}>("SELECT COUNT(*) AS count FROM documents WHERE collection='devicestatus' AND id=?",id(1000)).one().count).toBe(0);
    });
  });

  it("restores bounded native results on actual object eviction and bounds query metadata, rows and entry count",async()=>{
    const stub=env.ENTRY_STORE.getByName(`api3-device-cold-${crypto.randomUUID()}`);
    const query:DocumentQuery={limit:1,filters:[{field:"device",operator:"eq",value:"absent"}]};
    await runInDurableObject(stub,async(instance:EntryStore,state)=>{seed(state.storage.sql,100);await read(instance,query);});
    await evictDurableObject(stub);
    await runInDurableObject(stub,async(instance:EntryStore,state)=>{
      const cold=await measured(state.storage.sql,()=>read(instance,query));
      expect(cold.value).toBe(oracle(state.storage,query));expect(cold.nativeReads).toBe(0);expect(cold.writes).toBe(0);
      const internal=instance as unknown as Internals;
      internal.api3DeviceStatusQueries=new Api3DeviceStatusQueryCache<DbDocumentV4>(1,4096,4096,1);
      const large:DocumentQuery={limit:100};
      await read(instance,large);
      expect((await measured(state.storage.sql,()=>read(instance,large))).reads).toBeGreaterThanOrEqual(100);
      const huge:DocumentQuery={limit:1,filters:[{field:"device",operator:"eq",value:"x".repeat(5000)}]};
      await read(instance,huge);
      expect((await measured(state.storage.sql,()=>read(instance,huge))).reads).toBeGreaterThanOrEqual(100);
      internal.api3DeviceStatusQueries=new Api3DeviceStatusQueryCache<DbDocumentV4>(16,4*1024*1024,1024*1024,128,1);
      const ranked:DocumentQuery={limit:1,sort:{field:"rank",direction:"desc"}};
      await read(instance,ranked);
      expect(JSON.parse(await instance.api3CreateDocument("devicestatus",JSON.stringify(payload(1001,{rank:100})),OPTIONS)))
        .toMatchObject({ok:true});
      const capped=await measured(state.storage.sql,()=>read(instance,ranked));
      expect(capped.value).toBe(oracle(state.storage,ranked));expect(capped.reads).toBeGreaterThan(100);
    });
    const tiny=new Api3DeviceStatusQueryCache(1,4096,4096,1);
    const plan:Api3DeviceStatusPlan={where:"collection=?",bindings:["devicestatus"],order:"id ASC",orderBindings:[],limit:1,skip:0};
    let loads=0;
    const load=()=>{loads++;return[];};
    tiny.read({},plan,load);tiny.read({},plan,load);expect(loads).toBe(1);
    tiny.read({},{...plan,limit:2},load);tiny.read({},plan,load);expect(loads).toBe(3);
  });

  it("reuses only narrowing same-type empty windows and rechecks backwards or changed bounds",async()=>{
    const stub=env.ENTRY_STORE.getByName(`api3-device-window-${crypto.randomUUID()}`);
    await runInDurableObject(stub,async(instance:EntryStore,state)=>{
      seed(state.storage.sql,100);
      const query=(lower:number|string):DocumentQuery=>({limit:1,filters:[
        {field:"device",operator:"eq",value:"absent"},{field:"date",operator:"gte",value:lower},
      ]});
      await read(instance,query(AT));
      expect(await measured(state.storage.sql,()=>read(instance,query(AT+60000)))).toMatchObject({nativeReads:0,writes:0});
      const backwards=await measured(state.storage.sql,()=>read(instance,query(AT-60000)));
      expect(backwards.value).toBe(oracle(state.storage,query(AT-60000)));expect(backwards.reads).toBeGreaterThan(0);
      const changedType=await measured(state.storage.sql,()=>read(instance,query(String(AT))));
      expect(changedType.value).toBe(oracle(state.storage,query(String(AT))));expect(changedType.reads).toBeGreaterThan(0);
      const changedResidual:DocumentQuery={limit:1,filters:[
        {field:"device",operator:"eq",value:"present"},{field:"date",operator:"gte",value:AT+60000},
      ]};
      expect(await read(instance,changedResidual)).toBe(oracle(state.storage,changedResidual));
      expect(JSON.parse(await read(instance,changedResidual)).result).toHaveLength(1);
      const strict=(lower:number):DocumentQuery=>({limit:1,filters:[
        {field:"device",operator:"eq",value:"absent"},{field:"date",operator:"gt",value:lower},
      ]});
      await read(instance,strict(AT));
      expect(await measured(state.storage.sql,()=>read(instance,strict(AT+60000)))).toMatchObject({nativeReads:0,writes:0});
    });
  });

  it("adds one transactional invalidation and one checkpoint save per successful participating upload",async()=>{
    const reports=[];
    for(const warm of [false,true]) {
      const stub=env.ENTRY_STORE.getByName(`api3-device-write-${warm}-${crypto.randomUUID()}`);
      reports.push(await runInDurableObject(stub,async(instance:EntryStore,state)=>{
        seed(state.storage.sql,100);
        if(warm) await read(instance,{limit:1,sort:{field:"rank",direction:"desc"}});
        const upload=await measured(state.storage.sql,()=>instance.api3CreateDocument("devicestatus",JSON.stringify(payload(1001,{rank:100})),OPTIONS));
        expect(JSON.parse(upload.value)).toMatchObject({ok:true});return{reads:upload.reads,writes:upload.writes,nativeReads:upload.nativeReads};
      }));
    }
    expect(reports[1]!.writes-reports[0]!.writes).toBe(2);
    expect(reports[1]!.nativeReads-reports[0]!.nativeReads).toBeLessThan(20);
    console.info(`API3_DEVICE_QUERY_CACHE_UPLOAD=${JSON.stringify(reports)}`);
  });

  it("keeps accepted near-binding-limit queries valid and drops optional native-maintenance failures",async()=>{
    const stub=env.ENTRY_STORE.getByName(`api3-device-sql-boundary-${crypto.randomUUID()}`);
    await runInDurableObject(stub,async(instance:EntryStore,state)=>{
      seed(state.storage.sql,100);
      const query:DocumentQuery={limit:1,filters:Array.from({length:16},()=>({
        field:"tag",operator:"eq" as const,value:"absent",
      }))};
      const expected=oracle(state.storage,query);
      expect(await read(instance,query)).toBe(expected);
      expect(JSON.parse(await instance.api3CreateDocument("devicestatus",JSON.stringify(payload(1001)),OPTIONS)))
        .toMatchObject({ok:true});
      expect(await measured(state.storage.sql,()=>read(instance,query))).toMatchObject({value:expected,nativeReads:0,writes:0});
      const exec=state.storage.sql.exec.bind(state.storage.sql);
      const spy=vi.spyOn(state.storage.sql,"exec").mockImplementation((statement,...bindings)=>{
        if (/^SELECT \* FROM \(\s+SELECT \* FROM documents INDEXED BY sqlite_autoindex_documents_1\s+WHERE collection = 'devicestatus' AND id = \? LIMIT -1/.test(statement)) {
          throw new Error("Expression tree is too large (maximum depth 1000)");
        }
        return exec(statement,...bindings);
      });
      try {
        expect(JSON.parse(await instance.api3CreateDocument("devicestatus",JSON.stringify(payload(1002)),OPTIONS)))
          .toMatchObject({ok:true});
      } finally {spy.mockRestore();}
      expect(state.storage.sql.exec<{count:number}>("SELECT COUNT(*) AS count FROM documents WHERE collection='devicestatus' AND id=?",id(1002)).one().count).toBe(1);
      const fallback=await measured(state.storage.sql,()=>read(instance,query));
      expect(fallback.value).toBe(oracle(state.storage,query));expect(fallback.reads).toBeGreaterThan(100);
    });
  });

  it("isolates identical cached queries between tenant objects",async()=>{
    const first=env.ENTRY_STORE.getByName(`api3-device-tenant-a-${crypto.randomUUID()}`);
    const second=env.ENTRY_STORE.getByName(`api3-device-tenant-b-${crypto.randomUUID()}`);
    const query:DocumentQuery={limit:1,filters:[{field:"device",operator:"eq",value:"tenant-only"}]};
    await runInDurableObject(first,async(instance:EntryStore)=>{
      expect(JSON.parse(await read(instance,query)).result).toEqual([]);
    });
    await runInDurableObject(second,async(instance:EntryStore,state)=>{
      expect(JSON.parse(await instance.api3CreateDocument("devicestatus",JSON.stringify(payload(1001,{device:"tenant-only"})),OPTIONS)))
        .toMatchObject({ok:true});
      expect(await read(instance,query)).toBe(oracle(state.storage,query));
      expect(JSON.parse(await read(instance,query)).result).toHaveLength(1);
    });
    await runInDurableObject(first,async(instance:EntryStore,state)=>{
      expect(await measured(state.storage.sql,()=>read(instance,query))).toMatchObject({value:'{"ok":true,"result":[]}',nativeReads:0,writes:0});
    });
  });

  it("keeps the default latest prefix fresh through legacy uploads without API3 srv metadata",async()=>{
    const stub=env.ENTRY_STORE.getByName(`api3-device-legacy-latest-${crypto.randomUUID()}`);
    await runInDurableObject(stub,async(instance:EntryStore,state)=>{
      seed(state.storage.sql,100);
      const query:DocumentQuery={limit:1};
      await read(instance,query);
      for(let n=1000;n<1003;n++) {
        await instance.createDocuments("devicestatus",JSON.stringify([{
          _id:id(n),date:AT+n*60000,created_at:new Date(AT+n*60000).toISOString(),device:"present",uploader:{battery:19},
        }]));
        const actual=await measured(state.storage.sql,()=>read(instance,query));
        expect(actual.value).toBe(oracle(state.storage,query));
        expect(JSON.parse(actual.value).result[0].date).toBe(AT+n*60000);
      }
    });
  });

  it("keeps legacy latest queries fresh across alarm and polling callbacks",async()=>{
    const bindings=env as unknown as Record<string,unknown>;
    const changes={ENABLE:"upbat",UPBAT_ENABLE_ALERTS:"true",UPBAT_WARN:"30",UPBAT_URGENT:"20",HEARTBEAT:"15"};
    const old=Object.fromEntries(Object.keys(changes).map(key=>[key,bindings[key]]));
    let now=AT+1000*60000;
    const clock=vi.spyOn(Date,"now").mockImplementation(()=>now);
    Object.assign(bindings,changes);
    try {
      const stub=env.ENTRY_STORE.getByName(`api3-device-alarm-latest-${crypto.randomUUID()}`);
      await runInDurableObject(stub,async(instance:EntryStore,state)=>{
        seed(state.storage.sql,100);
        const query:DocumentQuery={limit:1};
        for(let n=0;n<3;n++) {
          now=AT+(1000+n)*60000;
          await instance.createDocuments("devicestatus",JSON.stringify([{
            _id:id(13000+n),date:now,created_at:new Date(now).toISOString(),device:"present",uploader:{battery:19},
          }]));
          const actual=await read(instance,query);
          expect(actual).toBe(oracle(state.storage,query));
          if(n===0) {await instance.realtimeHandshake(4);await instance.realtimeHandshake(4);}
          for(let tick=0;tick<4;tick++) {
            now=AT+(1000+n)*60000+tick*15000;
            await instance.alarm();
            await read(instance,{limit:1,filters:[{field:"device",operator:"eq",value:"absent"}]});
            expect(await read(instance,query)).toBe(oracle(state.storage,query));
          }
        }
      });
    } finally {Object.assign(bindings,old);clock.mockRestore();}
  });

  it("preserves parsed HTTP default identifier order and explicit latest-date order across legacy uploads",async()=>{
    const stub=env.ENTRY_STORE.getByName(`api3-device-http-order-${crypto.randomUUID()}`);
    await runInDurableObject(stub,async(instance:EntryStore,state)=>{
      const parsed=(suffix:string):DocumentQuery=>{
        const input=parseApi3Search(new URL(`https://synthetic.invalid/api/v3/devicestatus?limit=1${suffix}`));
        return {filters:input.filters,sort:input.sort,limit:input.limit,skip:input.skip,includeDeleted:false};
      };
      const ascending=parsed("");
      const latest=parsed("&sort%24desc=date");
      for(let n=0;n<2;n++) {
        await instance.createDocuments("devicestatus",JSON.stringify([{
          _id:id(13000+n),date:AT+n*60000,created_at:new Date(AT+n*60000).toISOString(),device:"present",uploader:{battery:19},
        }]));
        for(const query of [ascending,latest]) expect(await read(instance,query)).toBe(oracle(state.storage,query));
        // The locked HTTP default orders raw identifier/created_at ascending;
        // a storage query with no sort has a different default time order.
        expect(JSON.parse(await read(instance,ascending)).result[0].date).toBe(AT);
        expect(JSON.parse(await read(instance,latest)).result[0].date).toBe(AT+n*60000);
      }
    });
  });
});
