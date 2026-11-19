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
// A note with a private record waiting, on the plugin's clock. The save sends the record, whose vault file is
// removed once the Center confirms; a refused save sends nothing.
function waitingRecord({refuse=()=>false}={}){
 const s={time:0,record:true,saves:0,reports:[]};
 s.sync=new AutoSync({now:()=>s.time,pull:async()=>({}),report:r=>s.reports.push(r),save:async()=>{
  s.saves++;
  if(refuse())throw Object.assign(Error('The summary property is read-only for this structured record; local edits were kept'),{code:'structured_property_unmapped'});
  if(!s.record)return {state:'unchanged'};
  s.record=false;return {state:'saved',revision:2};
 }});
 const minute=async()=>{for(let i=0;i<6;i++){s.time+=10000;await s.sync.tick();}};
 // An hour as the plugin runs it: a scan that queues the notes whose record still waits, then a tick every 10 seconds.
 s.hour=async()=>{if(s.record)s.sync.queueWaiting('Works/a.md');await s.sync.tick({scan:true});await minute();s.time+=3540000;};
 s.edit=async()=>{s.sync.mark('Works/a.md');await minute();};
 return s;
}
test('a waiting private record leaves a refused note blocked and reported once until the user edits it',async()=>{
 let refused=true;const s=waitingRecord({refuse:()=>refused});
 await s.hour();
 assert.equal(s.saves,1,'an unchanged note with a waiting record is saved');
 assert.deepEqual(s.reports.map(r=>r.path),['Works/a.md']);assert.equal(s.sync.blocked.has('Works/a.md'),true);
 for(let i=0;i<3;i++)await s.hour();
 assert.equal(s.saves,1,'later scans do not retry it');assert.equal(s.reports.length,1,'nor report it again');
 refused=false;await s.edit();
 assert.equal(s.record,false,'an edit retries it and the record goes with the save');assert.equal(s.saves,3,'the save, then the check after it');
 assert.equal(s.sync.blocked.size,0);
 await s.hour();assert.equal(s.saves,3);assert.equal(s.reports.length,1);assert.equal(s.sync.dirty.size,0);
});
test('a waiting private record queues a note once per session, and again for a record written after a save',async()=>{
 const s=waitingRecord();
 await s.hour();assert.equal(s.record,false);assert.equal(s.saves,2,'the save, then the check after it');
 await s.hour();assert.equal(s.saves,2);
 s.record=true;await s.hour();
 assert.equal(s.record,false,'a record written later in the session is sent');assert.equal(s.saves,4);assert.equal(s.reports.length,0);
 // A record that cannot go yet (its note is not downloaded) is tried once, not on every scan.
 let tries=0,time=0;const t=new AutoSync({now:()=>time,pull:async()=>({}),save:async()=>{tries++;return {state:'unchanged'};}});
 for(let i=0;i<3;i++){t.queueWaiting('Works/en/b.md');await t.tick({scan:true});time+=10000;await t.tick();time+=3600000;}
 assert.equal(tries,1);
});
test('after a manual save of a refused note, a record written later queues it again',async()=>{
 let refused=true;const s=waitingRecord({refuse:()=>refused});
 await s.hour();assert.equal(s.sync.blocked.has('Works/a.md'),true);
 // The user fixes the note and saves it with the command, which sends the record and clears the block.
 refused=false;s.record=false;s.sync.unblock('Works/a.md');
 s.record=true;await s.hour();
 assert.equal(s.record,false);assert.equal(s.reports.length,1);
});
test('a waiting private record neither lifts a conflict nor queues paths outside Works',async()=>{
 const saved=[];const s=new AutoSync({pull:async()=>({conflicts:['b']}),save:async path=>{saved.push(path);return {state:'unchanged'};}});
 await s.tick({scan:true});s.queueWaiting('Works/b.md');s.queueWaiting('Notes/c.md');s.queueWaiting('Works/../d.md');await s.tick();
 assert.deepEqual(saved,[]);assert.equal(s.blocked.has('Works/b.md'),true);
 s.stop();s.queueWaiting('Works/e.md');assert.equal(s.dirty.has('Works/e.md'),false);
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
 const spaces=['academic','design','enter','legis','xsime','metho','personal','pets','study','xsiching'];
 const values=spaces.map(space=>startupDelay(space,spaces,()=>0));assert.equal(new Set(values).size,spaces.length);
 assert.equal(startupDelay('lingxi',spaces,()=>0),startupDelay('xsime',spaces,()=>0),'the retired ID keeps its slot');
 for(let i=1;i<values.length;i++)assert.equal(values[i]-values[i-1],120000);
});
test('the startup slots follow the bundled site profiles, so a new site gets its own slot',async()=>{
 const {wechatSites}=await import('../build-templates.mjs');
 const spaces=Object.keys(wechatSites());assert.ok(spaces.length>=10);
 const values=spaces.map(space=>startupDelay(space,spaces,()=>0));assert.equal(new Set(values).size,spaces.length);
 const grown=[...spaces,'newsite'];
 assert.equal(startupDelay('newsite',grown,()=>0),15000+spaces.length*120000,'a site added to the profiles takes the next slot');
 assert.equal(startupDelay('academic',grown,()=>0),startupDelay('academic',spaces,()=>0),'existing sites keep their slots');
});
test('an unknown space takes a random slot, also when no spaces are known',()=>{
 assert.equal(startupDelay('unknown',['academic'],()=>0.99),15000+9*120000+29700);
 assert.equal(startupDelay('unknown',[],()=>0),15000);
});
test('gate readiness, stop and changed generation prevent overlapping operations',async()=>{
 let release,calls=0;const s=new AutoSync({pull:async()=>new Promise(r=>release=r),save:async()=>{calls++;return {state:'unchanged'};}});
 const one=s.tick({scan:true});assert.equal(await s.tick({scan:true}),false);release({skipped:['a']});await one;assert.equal(calls,1);s.stop();assert.equal(await s.tick(),false);
});
