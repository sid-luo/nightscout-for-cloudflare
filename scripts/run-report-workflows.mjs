import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const vendor=path.join(root,'vendor/nightscout');
const filename=path.join(vendor,'tests/reports.test.js');
const source=await readFile(filename,'utf8');
if(source.split("describe.skip('reports'").length!==2)throw Error('Review changed upstream report suite before replaying');
const dir=await mkdtemp(path.join(os.tmpdir(),'nscf-report-replay-'));
const loader=path.join(dir,'replay.cjs');
await writeFile(loader,`const fs=require('fs'),Module=require('module'),path=require('path');
const filename=${JSON.stringify(filename)};
const source=fs.readFileSync(filename,'utf8').replace("describe.skip('reports'", "describe('reports'");
const replay=new Module(filename,module);replay.filename=filename;replay.paths=Module._nodeModulePaths(path.dirname(filename));replay._compile(source,filename);
`);
try {
  // The legacy benv fixture leaves the browser bundle in Node's cache after
  // tearing down global $. Each workflow therefore needs a fresh process.
  // Only suite activation changes; original fixture and assertions stay exact.
  // These are upstream workflow evidence, not tests of NSCF's report overlay.
  for(const name of ['should produce some html','should produce week to week report']){
    const r=spawnSync(path.join(vendor,'node_modules/.bin/env-cmd'),['-f','./tests/ci.test.env',path.join(vendor,'node_modules/.bin/mocha'),'--require','./tests/hooks.js','--exit','--grep',name,loader],{cwd:vendor,env:{...process.env,TZ:'UTC'},stdio:'inherit',timeout:45000});
    if(r.error)throw r.error;if(r.status!==0)throw Error('Report workflow failed: '+name);
  }
  console.log('PASS both upstream report workflows replayed with their original assertions in isolated processes. Original file remains skipped; no whole-file pass reclassification.');
}finally{await rm(dir,{recursive:true,force:true});}
