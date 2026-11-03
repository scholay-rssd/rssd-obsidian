import test from 'node:test';
import assert from 'node:assert/strict';
import {SyncEngine} from '../src/sync-engine.mjs';
import {StagedSyncEngine} from '../src/staged-sync-engine.mjs';
import {yaml,memoryVault,memoryStore,stubCenter,detail} from './helpers.mjs';
import {trackRename} from '../src/path-guard.mjs';
async function setup(){
 const works=new Map([['test-one',detail('test-one')]]),center=stubCenter(works),vault=memoryVault(),store=memoryStore();
 const engine=new SyncEngine({client:center.client,vault,store,yaml});await engine.pull('site');
 let revision=0, saved=null;const receipts=new Map(),hash='a'.repeat(64),calls=[];
 const info=()=>({articleId:'test-one',workId:'work-one',locale:'zh-CN',baseRevision:1,baseHash:hash,basePublishedVersion:null,overlayRevision:revision});
 const client={stagedSite:async()=>({capabilities:['staged-drafts-v1']}),stagedList:async()=>({items:revision?[info()]:[],generation:1,next:null}),stagedWork:async()=>({...info(),baseState:'current',preservesEditorialFieldsOnSave:true,data:saved||works.get('test-one').data}),saveStaged:async(_s,input)=>{calls.push(input);saved=input.data;revision++;const out={...info(),requestKey:input.requestKey,status:'draft_saved'};receipts.set(input.requestKey,out);return out;},stagedReceipt:async(_s,key)=>receipts.get(key)};
 return {works,center,vault,store,client,calls,stage:new StagedSyncEngine({engine,client}),info};
}

async function structuredSetup(kind='history',capable=true){
 const id='record-123e4567-e89b-42f0-a456-426614174000',labels={year:['摘要','正文'],history:['事实摘要','历史意义'],openSource:['项目简介','使用价值']}[kind];
 const d=detail(id,{record:{kind,documentId:id.slice(7),fields:{privateField:'preserve'}},markdown:'# Title\n\n## '+labels[0]+'\n\nFirst\n\n## '+labels[1]+'\n\nSecond\n'});
 const works=new Map([[id,d]]),center=stubCenter(works),vault=memoryVault(),store=memoryStore(),engine=new SyncEngine({client:center.client,vault,store,yaml});await engine.pull('site');
 let revision=0,saved=null;const calls=[],hash='a'.repeat(64);
 const info=()=>({articleId:id,workId:'work-structured',locale:'zh-CN',baseRevision:1,baseHash:hash,basePublishedVersion:null,overlayRevision:revision});
 const client={stagedSite:async()=>({capabilities:['staged-drafts-v1']}),stagedList:async()=>({items:revision?[info()]:[],generation:1,next:null}),
  stagedWork:async()=>({...info(),baseState:'current',preservesEditorialFieldsOnSave:true,...(capable?{preservesStructuredDraftsOnSave:true}:{}),data:saved||d.data}),
  saveStaged:async(_space,input)=>{calls.push(input);saved={...input.data,record:d.data.record};revision++;return {...info(),requestKey:input.requestKey,status:'draft_saved'};}};
 return {id,works,center,vault,store,engine,client,calls,stage:new StagedSyncEngine({engine,client})};
}
for(const kind of ['year','history','openSource'])test('staged '+kind+' saves only verified prose without exposing raw structured fields',async()=>{
 const x=await structuredSetup(kind),path='Works/'+x.id+'.md';await x.vault.write(path,(await x.vault.read(path)).replace('First','Changed first'));
 const result=await x.stage.save('site',path);assert.equal(result.stagedRevision,1);assert.equal('record' in x.calls[0].data,false);
 assert.equal((await x.store.get('site',x.id)).readOnly,true);assert.equal((await x.store.get('site',x.id)).version,1);
});
test('staged structured saves reject old capability, changed kind or unmapped attributes',async()=>{
 for(const mutation of ['old-server','kind','identity','summary','author','date','category','title']){
  const x=await structuredSetup('history',mutation!=='old-server'),path='Works/'+x.id+'.md';let value=(await x.vault.read(path)).replace('First','Changed');
  if(mutation==='kind')value=value.replace('rssd-kind: history','rssd-kind: news');
  if(mutation==='summary')value=value.replace('summary: Summary','summary: Other');
  if(mutation==='author')value=value.replace('author: Ed','author: Other');
  if(mutation==='date')value=value.replace('date: 2026-11-03','date: 2026-11-04');
  if(mutation==='category')value=value.replace('category: News','category: Other');
  if(mutation==='title')value=value.replace('title: Title','title: Other');
  await x.vault.write(path,value);
  if(mutation==='identity'){const get=x.client.stagedWork;x.client.stagedWork=async(...args)=>{const result=await get(...args);return {...result,data:{...result.data,record:{...result.data.record,documentId:'incorrect'}}};};}
  await assert.rejects(x.stage.save('site',path),undefined,mutation);assert.equal(x.calls.length,0,mutation);
 }
});
test('another device pulls a structured private branch without exposing private fields',async()=>{
 const x=await structuredSetup('history'),path='Works/'+x.id+'.md';
 const secondVault=memoryVault(),secondStore=memoryStore(),secondEngine=new SyncEngine({client:x.center.client,vault:secondVault,store:secondStore,yaml});
 await secondEngine.pull('site');await x.vault.write(path,(await x.vault.read(path)).replace('First','Remote prose'));await x.stage.save('site',path);
 const secondStage=new StagedSyncEngine({engine:secondEngine,client:x.client});assert.deepEqual((await secondStage.pull('site')).updated,[x.id]);
 assert.match(await secondVault.read(path),/Remote prose/);assert.doesNotMatch(await secondVault.read(path),/privateField/);assert.equal((await secondStore.get('site',x.id)).readOnly,true);
});
test('a locally edited structured record is never replaced by a remote private branch',async()=>{
 const x=await structuredSetup('history'),path='Works/'+x.id+'.md';
 const secondVault=memoryVault(),secondStore=memoryStore(),secondEngine=new SyncEngine({client:x.center.client,vault:secondVault,store:secondStore,yaml});await secondEngine.pull('site');
 await secondVault.write(path,(await secondVault.read(path)).replace('First','Local prose'));
 await x.vault.write(path,(await x.vault.read(path)).replace('First','Remote prose'));await x.stage.save('site',path);
 const secondStage=new StagedSyncEngine({engine:secondEngine,client:x.client});assert.deepEqual((await secondStage.pull('site')).conflicts,[x.id]);
 assert.match(await secondVault.read(path),/Local prose/);assert.equal((await secondStore.get('site',x.id)).staged,undefined);
});
test('staged saves retain canonical version and advance independent overlay',async()=>{
 const x=await setup(),path='Works/test-one.md';await x.vault.write(path,(await x.vault.read(path)).replace('Body','Edited'));
 const result=await x.stage.save('site',path);assert.equal(result.stagedRevision,1);assert.equal((await x.store.get('site','test-one')).version,1);assert.equal((await x.store.get('site','test-one')).staged.overlayRevision,1);assert.match(x.calls[0].data.markdown,/Edited/);
});
test('stale staged branch and corrupt identity cannot overwrite local changes',async()=>{
 const x=await setup(),path='Works/test-one.md';await x.vault.write(path,(await x.vault.read(path)).replace('Body','Edited'));
 x.client.stagedWork=async()=>({...x.info(),baseState:'current',preservesEditorialFieldsOnSave:true,overlayRevision:1});await assert.rejects(x.stage.save('site',path),{code:'staged_conflict'});assert.equal(x.calls.length,0);
 x.client.stagedWork=async()=>({...x.info(),articleId:'wrong'});await assert.rejects(x.stage.save('site',path),{code:'invalid_response'});
});
test('uncertain save retains original request key and recovers without a second write',async()=>{
 const x=await setup(),path='Works/test-one.md';await x.vault.write(path,(await x.vault.read(path)).replace('Body','Edited'));
 const real=x.client.saveStaged;x.client.saveStaged=async(...args)=>{await real(...args);throw Object.assign(Error('lost'),{status:0});};
 await assert.rejects(x.stage.save('site',path),{retained:true});const key=(await x.store.get('site','test-one')).pending.requestKey;
 assert.equal((await x.stage.save('site',path)).stagedRevision,1);assert.equal(x.calls.length,1);assert.equal(x.calls[0].requestKey,key);
});
test('pull preserves changed local notes when another device saved an overlay',async()=>{
 const x=await setup(),path='Works/test-one.md';await x.client.saveStaged('site',{data:{...x.works.get('test-one').data,markdown:'Other edit'},requestKey:'another-request'});
 await x.vault.write(path,(await x.vault.read(path)).replace('Body','Local edit'));assert.deepEqual((await x.stage.pull('site')).conflicts,['test-one']);assert.match(await x.vault.read(path),/Local edit/);
});
test('pull applies an overlay only to an unchanged local note',async()=>{
 const x=await setup(),path='Works/test-one.md';await x.client.saveStaged('site',{data:{...x.works.get('test-one').data,markdown:'Other edit'},requestKey:'another-request'});
 assert.deepEqual((await x.stage.pull('site')).updated,['test-one']);assert.match(await x.vault.read(path),/Other edit/);assert.equal((await x.store.get('site','test-one')).version,1);
});
test('staged pull never overwrites the old path of a moved linked note',async()=>{
 const x=await setup(),path='Works/test-one.md';await x.client.saveStaged('site',{data:{...x.works.get('test-one').data,markdown:'Other edit'},requestKey:'another-request'});
 const before=await x.vault.read(path);x.stage.engine.pathRecords=()=>trackRename({},path,'Archive/moved.md');
 assert.deepEqual((await x.stage.pull('site')).conflicts,['test-one']);assert.equal(await x.vault.read(path),before);
});
test('staged save refuses an old-path copy when the original note has moved',async()=>{
 const x=await setup(),path='Works/test-one.md';x.stage.engine.pathRecords=()=>trackRename({},path,'Archive/moved.md');
 await x.vault.write(path,(await x.vault.read(path)).replace('Body','Changed copy'));
 await assert.rejects(x.stage.save('site',path),{code:'local_work_moved'});assert.equal(x.calls.length,0);
});
test('migration changes to the canonical base preserve the local staged branch',async()=>{
 const x=await setup(),path='Works/test-one.md';await x.vault.write(path,(await x.vault.read(path)).replace('Body','Edited'));await x.stage.save('site',path);
 x.client.stagedWork=async()=>({...x.info(),baseRevision:2});await x.vault.write(path,(await x.vault.read(path)).replace('Edited','Edited again'));
 await assert.rejects(x.stage.save('site',path),{code:'staged_conflict'});assert.match(await x.vault.read(path),/Edited again/);
});
test('a missing recovery receipt never resubmits or clears the original key',async()=>{
 const x=await setup(),path='Works/test-one.md';await x.vault.write(path,(await x.vault.read(path)).replace('Body','Edited'));
 x.client.saveStaged=async()=>{throw Object.assign(Error('lost'),{status:0});};x.client.stagedReceipt=async()=>{throw Object.assign(Error('unknown'),{status:404});};
 await assert.rejects(x.stage.save('site',path));const key=(await x.store.get('site','test-one')).pending.requestKey;
 await assert.rejects(x.stage.save('site',path),{retained:true});assert.equal((await x.store.get('site','test-one')).pending.requestKey,key);
});
test('other-device staged revision never overwrites a simultaneous local change',async()=>{
 const x=await setup(),path='Works/test-one.md';await x.vault.write(path,(await x.vault.read(path)).replace('Body','First'));await x.stage.save('site',path);
 await x.client.saveStaged('site',{data:{...x.works.get('test-one').data,markdown:'Remote next'},requestKey:'next-request'});
 await x.vault.write(path,(await x.vault.read(path)).replace('First','Local next'));
 assert.deepEqual((await x.stage.pull('site')).conflicts,['test-one']);assert.match(await x.vault.read(path),/Local next/);
});
test('lost overlay in list is a conflict, never a deletion',async()=>{
 const x=await setup(),path='Works/test-one.md';await x.vault.write(path,(await x.vault.read(path)).replace('Body','Edited'));await x.stage.save('site',path);
 x.client.stagedList=async()=>({items:[],generation:1,next:null});assert.deepEqual((await x.stage.pull('site')).conflicts,['test-one']);assert.match(await x.vault.read(path),/Edited/);
});
test('a stale canonical base is reported even when the overlay revision matches',async()=>{
 const x=await setup(),path='Works/test-one.md';await x.vault.write(path,(await x.vault.read(path)).replace('Body','Edited'));await x.stage.save('site',path);
 const original=x.client.stagedWork;x.client.stagedWork=async(...args)=>({...await original(...args),baseState:'changed'});
 assert.deepEqual((await x.stage.pull('site')).conflicts,['test-one']);await x.vault.write(path,(await x.vault.read(path)).replace('Edited','New edit'));
 await assert.rejects(x.stage.save('site',path),{code:'staged_conflict'});assert.equal(x.calls.length,1);
});
test('staged capability is required and changing paginated snapshots are rejected',async()=>{
 const x=await setup();x.client.stagedSite=async()=>({capabilities:[]});await assert.rejects(x.stage.pull('site'),{code:'staged_drafts_unavailable'});
 x.client.stagedSite=async()=>({capabilities:['staged-drafts-v1']});x.client.stagedList=async(_space,_locale,{after})=>after===0?{items:[],generation:1,next:100}:{items:[],generation:2,next:null};
 await assert.rejects(x.stage.pull('site'),{code:'invalid_response'});
});
test('image-only edit uses content-addressed bytes in staged draft',async()=>{
 const x=await setup(),path='Works/test-one.md';const image=new Uint8Array([137,80,78,71,13,10,26,10,4,5]);x.vault.files.set('article-media/a.png',image);
 const result=await x.stage.save('site',path);assert.equal(result.state,'saved');assert.match(x.calls[0].data.assets[0].path,/^\/article-media\/[a-f0-9]{64}\.png$/);assert.match(x.calls[0].data.markdown,/\/article-media\/[a-f0-9]{64}\.png/);
});

test('image-only save retains local path and supports subsequent staged saves',async()=>{
 const x=await setup(),path='Works/test-one.md';x.vault.files.set('article-media/a.png',new Uint8Array([137,80,78,71,13,10,26,10,4,5]));
 await x.stage.save('site',path);assert.match(await x.vault.read(path),/article-media\/a\.png/);
 assert.deepEqual((await x.stage.pull('site')).unchanged,['test-one']);
 assert.equal((await x.stage.save('site',path)).state,'unchanged');
 await x.vault.write(path,(await x.vault.read(path)).replace('Body','Edited later'));
 assert.equal((await x.stage.save('site',path)).stagedRevision,2);assert.equal(x.calls.length,2);assert.match(x.calls[1].data.markdown,/\/article-media\/[a-f0-9]{64}\.png/);
});
test('staged list is fully paginated before applying any changes',async()=>{
 const x=await setup(),calls=[];x.client.stagedList=async(_space,_locale,options)=>{calls.push(options);return options.after===0?{items:[],generation:123,next:100}:{items:[],generation:123,next:null};};
 assert.deepEqual((await x.stage.pull('site')).conflicts,[]);assert.equal(calls.length,2);assert.deepEqual(calls[1],{after:100,limit:100,generation:123});
});
test('changed legacy local media is compared to Center not adopted as original',async()=>{
 const x=await setup(),path='Works/test-one.md',base=await x.store.get('site','test-one');delete base.mediaHashes;await x.store.set('site','test-one',base);
 x.vault.files.set('article-media/a.png',new Uint8Array([137,80,78,71,13,10,26,10,9,9]));
 assert.equal((await x.stage.save('site',path)).state,'saved');assert.equal(x.calls.length,1);
});
test('legacy attachment baseline is hydrated from matching canonical data before overlay pull',async()=>{
 const x=await setup(),path='Works/test-one.md',base=await x.store.get('site','test-one');delete base.mediaHashes;await x.store.set('site','test-one',base);
 await x.client.saveStaged('site',{data:{...x.works.get('test-one').data,markdown:'Other edit'},requestKey:'another-request'});
 assert.deepEqual((await x.stage.pull('site')).updated,['test-one']);assert.match(await x.vault.read(path),/Other edit/);
});
test('legacy locally edited image is never overwritten while pulling overlay',async()=>{
 const x=await setup(),path='Works/test-one.md',base=await x.store.get('site','test-one');delete base.mediaHashes;await x.store.set('site','test-one',base);
 x.vault.files.set('article-media/a.png',new Uint8Array([137,80,78,71,13,10,26,10,9]));
 await x.client.saveStaged('site',{data:{...x.works.get('test-one').data,markdown:'Other edit'},requestKey:'another-request'});
 assert.deepEqual((await x.stage.pull('site')).conflicts,['test-one']);assert.match(await x.vault.read(path),/Body/);
});
test('staged translation saves retain the Center translation source reference',async()=>{
 const w=detail('test-one');w.data.locale='en';w.data.translationOf={articleId:'zh-source',revision:2,sha256:'a'.repeat(64)};
 const works=new Map([['test-one',w]]),center=stubCenter(works),vault=memoryVault(),store=memoryStore(),engine=new SyncEngine({client:center.client,vault,store,yaml});await engine.pull('site',{locale:'en'});
 const ref={articleId:'test-one',workId:'work-one',locale:'en',baseRevision:1,baseHash:'a'.repeat(64),basePublishedVersion:null,overlayRevision:0},calls=[];
 const client={stagedSite:async()=>({capabilities:['staged-drafts-v1']}),stagedWork:async()=>({...ref,data:w.data,baseState:'current',preservesEditorialFieldsOnSave:true}),saveStaged:async(_s,input)=>{calls.push(input);return {...ref,overlayRevision:1,requestKey:input.requestKey,status:'draft_saved'};}};
 const stage=new StagedSyncEngine({engine,client}),path='Works/en/test-one.md';await vault.write(path,(await vault.read(path)).replace('Body','Edited'));await stage.save('site',path);assert.deepEqual(calls[0].data.translationOf,w.data.translationOf);
});
test('staged pull preserves an image changed during the remote request',async()=>{
 const x=await setup(),path='Works/test-one.md',before=await x.vault.read(path);
 await x.client.saveStaged('site',{data:{...x.works.get('test-one').data,markdown:'Other edit'},requestKey:'another-request'});
 const get=x.client.stagedWork;x.client.stagedWork=async(...args)=>{const result=await get(...args);x.vault.files.set('article-media/a.png',new Uint8Array([137,80,78,71,13,10,26,10,9]));return result;};
 assert.deepEqual((await x.stage.pull('site')).conflicts,['test-one']);assert.equal(await x.vault.read(path),before);assert.equal((await x.store.get('site','test-one')).staged,undefined);
});
test('staged pull restores note when its old image changes during note write',async()=>{
 const x=await setup(),path='Works/test-one.md',before=await x.vault.read(path);
 await x.client.saveStaged('site',{data:{...x.works.get('test-one').data,markdown:'Other edit'},requestKey:'another-request'});
 const write=x.vault.write;let inject=true;x.vault.write=async(p,content,options)=>{await write(p,content,options);if(p===path&&inject){inject=false;x.vault.files.set('article-media/a.png',new Uint8Array([137,80,78,71,13,10,26,10,9]));}};
 assert.deepEqual((await x.stage.pull('site')).conflicts,['test-one']);assert.equal(await x.vault.read(path),before);assert.equal((await x.store.get('site','test-one')).staged,undefined);
});
test('staged rollback does not overwrite a concurrent note edit',async()=>{
 const x=await setup(),path='Works/test-one.md';
 await x.client.saveStaged('site',{data:{...x.works.get('test-one').data,markdown:'Other edit'},requestKey:'another-request'});
 const write=x.vault.write;let inject=true;x.vault.write=async(p,content,options)=>{await write(p,content,options);if(p===path&&inject){inject=false;x.vault.files.set('article-media/a.png',new Uint8Array([137,80,78,71,13,10,26,10,9]));x.vault.files.set(path,content+'Concurrent edit');}};
 assert.deepEqual((await x.stage.pull('site')).conflicts,['test-one']);assert.match(await x.vault.read(path),/Concurrent edit/);assert.equal((await x.store.get('site','test-one')).staged,undefined);
});
test('staged private save accepts empty optional legacy fields while active save remains strict',async()=>{
 const x=await setup(),path='Works/test-one.md';let text=await x.vault.read(path);
 text=text.replace('summary: Summary',"summary: ''").replace('author: Ed',"author: ''").replace('category: News',"category: ''");await x.vault.write(path,text);
 const fetch=x.stage.engine.client.work;x.stage.engine.client.work=async(...args)=>({...await fetch(...args),preservesEditorialFieldsOnSave:true});
 await assert.rejects(x.stage.engine.save('site',path),{code:'optional_property_unavailable'});
 const result=await x.stage.save('site',path);assert.equal(result.state,'saved');assert.equal(x.calls[0].data.summary,'');assert.equal(x.calls[0].data.author,'');assert.equal(x.calls[0].data.category,'');
});
test('staged private save still requires a title',async()=>{
 const x=await setup(),path='Works/test-one.md';await x.vault.write(path,(await x.vault.read(path)).replace('title: Title',"title: ''"));
 await assert.rejects(x.stage.save('site',path),/title property is empty/);assert.equal(x.calls.length,0);
});
test('staged save sends only the server request allowlist',async()=>{
 const x=await setup(),path='Works/test-one.md';await x.vault.write(path,(await x.vault.read(path)).replace('Body','Edited'));
 const real=x.client.saveStaged;x.client.saveStaged=async(space,input)=>{assert.deepEqual(Object.keys(input).sort(),['requestKey','articleId','locale','baseRevision','baseHash','basePublishedVersion','overlayRevision','data'].sort());return real(space,input);};
 assert.equal((await x.stage.save('site',path)).state,'saved');
});
async function promotedSetup(){
 const x=await setup(),path='Works/test-one.md';await x.vault.write(path,(await x.vault.read(path)).replace('Body','Staged edit'));await x.stage.save('site',path);
 x.client.stagedPromotion=async(_space,id,locale,rev)=>({articleId:id,workId:'work-one',locale,baseRevision:1,baseHash:'a'.repeat(64),overlayRevision:rev,canonicalRevision:2,requestId:'staged-promote-test'});
 x.stage.engine.client.work=async(_space,id,locale)=>({articleId:id,workId:'work-one',locale,version:2,publishedVersion:null,preservesEditorialFieldsOnSave:true,data:x.calls[0].data});
 return {...x,path};
}
test('promotion adopts exact canonical version while retaining newer local edits',async()=>{
 const x=await promotedSetup(),before=await x.vault.read(x.path);await x.vault.write(x.path,before.replace('Staged edit','New local edit'));
 const result=await x.stage.promote('site','test-one','zh-CN');assert.equal(result.state,'promoted');assert.equal(result.revision,2);
 const base=await x.store.get('site','test-one');assert.equal(base.version,2);assert.equal(base.staged,undefined);assert.equal(base.pending,undefined);assert.match(await x.vault.read(x.path),/New local edit/);assert.notEqual((await x.stage.engine.noteFingerprint(x.path)).fingerprint,base.fingerprint);
});
test('promotion mismatches or changed canonical content preserve the staged baseline',async()=>{
 for(const variant of ['wrong-work','wrong-branch','wrong-published','wrong-data','wrong-revision']){
  const x=await promotedSetup(),baseline=structuredClone(await x.store.get('site','test-one')),text=await x.vault.read(x.path);
  if(variant==='wrong-work')x.client.stagedPromotion=async()=>({articleId:'test-one',workId:'wrong',locale:'zh-CN',baseRevision:1,baseHash:'a'.repeat(64),overlayRevision:1,canonicalRevision:2,requestId:'promote'});
  if(variant==='wrong-branch'){const get=x.client.stagedWork;x.client.stagedWork=async(...args)=>({...await get(...args),overlayRevision:2});}
  const get=x.stage.engine.client.work;
  if(variant==='wrong-published')x.stage.engine.client.work=async(...args)=>({...await get(...args),publishedVersion:2});
  if(variant==='wrong-data')x.stage.engine.client.work=async(...args)=>{const r=await get(...args);return {...r,data:{...r.data,markdown:'Unexpected'}};};
  if(variant==='wrong-revision')x.stage.engine.client.work=async(...args)=>({...await get(...args),version:3});
  await assert.rejects(x.stage.promote('site','test-one'),{code:'staged_conflict'});assert.deepEqual(await x.store.get('site','test-one'),baseline);assert.equal(await x.vault.read(x.path),text);
 }
});
test('missing promotion preserves a staged baseline and original local note',async()=>{
 const x=await promotedSetup(),base=structuredClone(await x.store.get('site','test-one')),text=await x.vault.read(x.path);
 x.client.stagedPromotion=async()=>{throw Object.assign(Error('not found'),{status:404});};await assert.rejects(x.stage.promote('site','test-one'),{status:404});
 assert.deepEqual(await x.store.get('site','test-one'),base);assert.equal(await x.vault.read(x.path),text);
});
test('promotion recovers uncertain staged save by original key without sending a second POST',async()=>{
 const x=await setup(),path='Works/test-one.md';await x.vault.write(path,(await x.vault.read(path)).replace('Body','Staged edit'));
 const save=x.client.saveStaged;x.client.saveStaged=async(...args)=>{await save(...args);throw Object.assign(Error('lost'),{status:0});};
 await assert.rejects(x.stage.save('site',path),{retained:true});const key=(await x.store.get('site','test-one')).pending.requestKey;
 x.client.stagedPromotion=async(_s,id,locale,overlayRevision)=>({articleId:id,workId:'work-one',locale,baseRevision:1,baseHash:'a'.repeat(64),overlayRevision,canonicalRevision:2,requestId:'promote'});
 x.stage.engine.client.work=async(_s,id,locale)=>({articleId:id,workId:'work-one',locale,version:2,publishedVersion:null,preservesEditorialFieldsOnSave:true,data:x.calls[0].data});
 assert.equal((await x.stage.promote('site','test-one')).state,'promoted');assert.equal(x.calls.length,1);assert.equal(x.calls[0].requestKey,key);
});
test('promotion never replaces a baseline changed while reading the server',async()=>{
 const x=await promotedSetup(),before=await x.vault.read(x.path),get=x.stage.engine.client.work;
 x.stage.engine.client.work=async(...args)=>{const result=await get(...args);const base=await x.store.get('site','test-one');await x.store.set('site','test-one',{...base,pending:{kind:'staged',requestKey:'do-not-lose'}},'zh-CN');return result;};
 await assert.rejects(x.stage.promote('site','test-one'),{code:'staged_conflict'});assert.equal((await x.store.get('site','test-one')).pending.requestKey,'do-not-lose');assert.equal(await x.vault.read(x.path),before);
});
