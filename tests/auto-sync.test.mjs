import test from 'node:test';
import assert from 'node:assert/strict';
import {AutoSync,startupDelay,syncLease} from '../src/auto-sync.mjs';

test('an unavailable Web Locks implementation falls back without repeating an executed action',async()=>{
 let calls=0;const unavailable={request:async()=>{throw Error('SecurityError');}};
 assert.equal(await syncLease(unavailable,'https://center.example')(async()=>++calls),1);
 const afterStart={request:async(_name,_options,fn)=>fn({})};
 await assert.rejects(syncLease(afterStart,'https://center.example')(async()=>{calls++;throw Error('failed after starting');}),/failed after starting/);
 assert.equal(calls,2);
});
test('a missing structured-draft capability retries after the Center is upgraded',async()=>{
 let now=0,calls=0;const s=new AutoSync({now:()=>now,pull:async()=>({}),save:async()=>{calls++;if(calls===1)throw Object.assign(Error('upgrade needed'),{code:'structured_draft_unavailable'});return {state:'saved'};}});
 s.enqueue('Works/a.md');await s.tick();assert.equal(s.blocked.size,0);now=60000;await s.tick();assert.equal(calls,2);
});

test('catalog scan discovers local edits and pending saves, but never saves conflicts',async()=>{
 const saved=[];let now=10000;
 const s=new AutoSync({now:()=>now,pull:async()=>({skipped:['a','en/b'],pending:['c'],conflicts:['d']}),save:async p=>{saved.push(p);return {state:'unchanged'};}});
 await s.tick({scan:true});assert.deepEqual(saved,['Works/a.md','Works/en/b.md','Works/c.md']);
 s.mark('Works/d.md');now+=6000;await s.tick();assert.equal(saved.length,3);
});
test('edit during save is retained and confirmed save is checked again',async()=>{
 let now=0,release,calls=0;const s=new AutoSync({now:()=>now,pull:async()=>({}),save:async()=>{calls++;if(calls===1)return await new Promise(r=>release=r);return {state:'unchanged'};}});
 s.mark('Works/a.md');now=5000;const first=s.tick();s.mark('Works/a.md');release({state:'saved'});await first;
 now=10000;await s.tick();assert.equal(calls,2);assert.equal(s.dirty.size,0);
});
test('network and pending saves retry at a bounded rate without losing pending work; conflicts block',async()=>{
 let now=0,calls=0,reports=0;const s=new AutoSync({now:()=>now,pull:async()=>({}),report:()=>reports++,save:async()=>{calls++;throw Object.assign(Error('offline'),{code:'network_error'});}});
 s.enqueue('Works/a.md');await s.tick();await s.tick();assert.equal(calls,1);
 now+=60000;await s.tick();now+=300000;await s.tick();now+=900000;await s.tick();assert.equal(calls,4);assert.equal(reports,1);await s.tick();assert.equal(calls,4);
 now+=900000;await s.tick();assert.equal(calls,5);assert.equal(reports,1);assert.equal(s.blocked.has('Works/a.md'),false);
 const conflict=new AutoSync({now:()=>now,pull:async()=>({}),save:async()=>{throw Object.assign(Error('conflict'),{status:409});}});
 conflict.enqueue('Works/c.md');await conflict.tick();assert.equal(conflict.blocked.has('Works/c.md'),true);
});
test('a missing original receipt remains queued for a slow retry without a new edit',async()=>{
 let now=0,queries=0;const s=new AutoSync({now:()=>now,pull:async()=>({}),save:async()=>{queries++;if(queries<5)throw Object.assign(Error('not confirmed'),{status:404,retained:true});return {state:'unchanged'};}});
 s.enqueue('Works/a.md');await s.tick();for(const delay of [60000,300000,900000,900000]){now+=delay;await s.tick();}
 assert.equal(queries,5);assert.equal(s.dirty.size,0);assert.equal(s.blocked.size,0);
});
test('editing fixes a validation error but does not silently clear an unresolved conflict',async()=>{
 let now=0,fail=true,calls=0;const s=new AutoSync({now:()=>now,pull:async()=>({}),save:async()=>{calls++;if(fail)throw Object.assign(Error('invalid'),{code:'unsupported_embed'});return {state:'unchanged'};}});
 s.enqueue('Works/a.md');await s.tick();assert.equal(s.blocked.has('Works/a.md'),true);
 fail=false;s.mark('Works/a.md');now+=5000;await s.tick();assert.equal(calls,2);assert.equal(s.blocked.size,0);
 const c=new AutoSync({now:()=>now,pull:async()=>({}),save:async()=>{throw Object.assign(Error('conflict'),{status:409,conflict:true});}});
 c.enqueue('Works/a.md');await c.tick();c.mark('Works/a.md');assert.equal(c.blocked.has('Works/a.md'),true);
});
test('an incomplete scan is retried while genuine edits arriving during a scan remain queued',async()=>{
 let release,now=0,calls=0;const s=new AutoSync({now:()=>now,pull:async()=>await new Promise(r=>release=r),save:async()=>{calls++;return {state:'unchanged'};}});
 const tick=s.tick({scan:true});s.mark('Works/a.md');release({failed:[{articleId:'remote'}]});assert.equal(await tick,false);
 now+=5000;await s.tick();assert.equal(calls,1);
});
test('same-origin Web Locks refuse concurrent automatic cycles without silently skipping retry',async()=>{
 let held=false,release;const locks={request:async(_name,_options,fn)=>{if(held)return fn(null);held=true;try{return await fn({});}finally{held=false;}}};
 const a=new AutoSync({lease:syncLease(locks,'https://center.example'),pull:async()=>await new Promise(r=>release=r),save:async()=>({state:'unchanged'})});
 const b=new AutoSync({lease:syncLease(locks,'https://center.example'),pull:async()=>({}),save:async()=>({state:'unchanged'})});
 const active=a.tick({scan:true});assert.equal(await b.tick({scan:true}),false);release({});assert.equal(await active,true);assert.equal(await b.tick({scan:true}),true);
});
test('known vault startup scans are separated by two minutes',()=>{
 const spaces=['academic','design','enter','legis','lingxi','metho','personal','pets','study','xsiching'];
 const values=spaces.map(space=>startupDelay(space,()=>0));assert.equal(new Set(values).size,spaces.length);
 for(let i=1;i<values.length;i++)assert.equal(values[i]-values[i-1],120000);
});
test('gate readiness, stop and changed generation prevent overlapping operations',async()=>{
 let release,calls=0;const s=new AutoSync({pull:async()=>new Promise(r=>release=r),save:async()=>{calls++;return {state:'unchanged'};}});
 const one=s.tick({scan:true});assert.equal(await s.tick({scan:true}),false);release({skipped:['a']});await one;assert.equal(calls,1);s.stop();assert.equal(await s.tick(),false);
});
