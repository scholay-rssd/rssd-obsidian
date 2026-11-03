import test from 'node:test';
import assert from 'node:assert/strict';
import {SyncEngine} from '../src/sync-engine.mjs';
import {workToNote,noteToWork,updateNoteVersion,toVaultMarkdown,toCenterMarkdown,workState,draftEnvelope,notePath} from '../src/sync-model.mjs';
import {yaml,memoryVault,memoryStore,stubCenter,detail,png} from './helpers.mjs';

const setup=(...ids)=>{
 const works=new Map(ids.map(id=>[id,detail(id)])),center=stubCenter(works),vault=memoryVault(),store=memoryStore();
 const get=center.client.work;
 center.client.work=async(...args)=>({...await get(...args),preservesEditorialFieldsOnSave:true});
 return {works,center,vault,store,engine:new SyncEngine({client:center.client,vault,store,yaml})};
};
const edit=async(vault,path,from,to)=>vault.write(path,(await vault.read(path)).replace(from,to));

test('a work round-trips between Center data and a vault note',()=>{
 const note=workToNote(detail('news-one'),yaml.stringify);
 assert.equal(note.path,'Works/news-one.md');
 assert.match(note.content,/^---\n[\s\S]*rssd-id: news-one[\s\S]*---\nBody/);
 assert.match(note.content,/!\[\]\(\.\.\/article-media\/a\.png\)/);
 const back=noteToWork(note.content,yaml.parse);
 assert.equal(back.data.id,'news-one');
 assert.equal(back.data.markdown,'Body\n\n![](/article-media/a.png)\n');
 assert.deepEqual(back.media,['a.png']);
 assert.equal(noteToWork('# plain note',yaml.parse),null);
 assert.equal(noteToWork('---\ntitle: x\n---\nbody',yaml.parse),null);
 assert.equal(toCenterMarkdown(toVaultMarkdown('x ![](/article-media/b.png) y')),'x ![](/article-media/b.png) y');
});

test('pull downloads works and images, then reports them synced',async()=>{
 const {engine,vault,store,center}=setup('a-one','b-two');
 const summary=await engine.pull('metho');
 assert.deepEqual(summary.downloaded.sort(),['a-one','b-two']);
 assert.ok(vault.files.has('Works/a-one.md'));
 assert.deepEqual([...vault.files.get('article-media/a.png')],[...png]);
 assert.equal((await store.get('metho','a-one')).version,1);
 const again=await engine.pull('metho');
 assert.equal(again.unchanged,2);
 assert.equal(center.calls.filter(c=>c[0]==='work').length,2,'unchanged works are not downloaded again');
 assert.deepEqual(Object.values(await engine.states('metho')),['synced','synced']);
});

test('an interrupted pull retains earlier progress and a retry preserves subsequent local edits',async()=>{
 const {engine,vault,center,store}=setup('a-one','b-two','c-three');
 const get=center.client.work;let fail=true;
 center.client.work=async(space,id)=>{if(id==='b-two'&&fail){fail=false;throw Object.assign(Error('temporarily unavailable'),{status:503});}return get(space,id);};
 const err=await engine.pull('metho').catch(e=>e);
 assert.equal(err.articleId,'b-two');assert.deepEqual(err.pullSummary.downloaded,['a-one']);
 assert.ok(await store.get('metho','a-one'));assert.equal(await store.get('metho','b-two'),null);
 await edit(vault,'Works/a-one.md','Body','Keep this edit');
 const retry=await engine.pull('metho');
 assert.deepEqual(retry.skipped,['a-one']);assert.deepEqual(retry.downloaded,['b-two','c-three']);
 assert.match(await vault.read('Works/a-one.md'),/Keep this edit/);
});

test('pull updates an untouched note but never overwrites local changes',async()=>{
 const {engine,vault,works}=setup('a-one','b-two');
 await engine.pull('metho');
 works.set('a-one',detail('a-one',{version:2,title:'Newer'}));
 assert.deepEqual((await engine.pull('metho')).updated,['a-one']);
 assert.match(await vault.read('Works/a-one.md'),/title: Newer/);
 await edit(vault,'Works/b-two.md','Body','My edit');
 const skipped=await engine.pull('metho');
 assert.deepEqual(skipped.skipped,['b-two']);
 assert.match(await vault.read('Works/b-two.md'),/My edit/);
 works.set('b-two',detail('b-two',{version:2}));
 const conflict=await engine.pull('metho');
 assert.deepEqual(conflict.conflicts,['b-two']);
 assert.match(await vault.read('Works/b-two.md'),/My edit/,'a conflicting note is left exactly as written');
 assert.equal((await engine.states('metho'))['b-two'],'conflict');
});

test('an existing note without a baseline is a conflict, not overwritten',async()=>{
 const {engine,vault}=setup('a-one');
 await vault.write('Works/a-one.md',workToNote(detail('a-one',{title:'Mine'}),yaml.stringify).content);
 assert.deepEqual((await engine.pull('metho')).conflicts,['a-one']);
 assert.match(await vault.read('Works/a-one.md'),/title: Mine/);
});

test('save sends an exact-base private draft with the edit and its images',async()=>{
 const {engine,vault,center,store}=setup('a-one');
 await engine.pull('metho');
 assert.deepEqual(await engine.save('metho','Works/a-one.md'),{state:'unchanged'});
 assert.equal(center.calls.filter(c=>c[0]==='saveDraft').length,0);
 await edit(vault,'Works/a-one.md','Body','Edited body');
 assert.equal((await engine.states('metho'))['a-one'],'local_changed');
 const result=await engine.save('metho','Works/a-one.md');
 assert.deepEqual(result,{state:'saved',revision:2,metadataUpdated:true});
 const sent=center.calls.find(c=>c[0]==='saveDraft')[1];
 assert.equal(sent.expectedVersion,1);
 assert.equal(sent.expectedPublishedVersion,null);
 assert.match(sent.data.markdown,/^Edited body/);
 assert.match(sent.data.markdown,/\/article-media\/a\.png/);
 assert.equal(sent.data.assets[0].path,'/article-media/a.png');
 assert.match(sent.requestKey,/^obsidian-[0-9a-f]{32}$/);
 const base=await store.get('metho','a-one');
 assert.equal(base.version,2);assert.equal(base.pending,undefined);
 assert.equal((await engine.states('metho'))['a-one'],'synced');
 assert.equal(sent.publish,undefined,'saving never publishes');
});

test('a save is refused when the Center moved, and the note stays untouched',async()=>{
 const {engine,vault,works,store}=setup('a-one');
 await engine.pull('metho');
 await edit(vault,'Works/a-one.md','Body','Edited');
 works.set('a-one',detail('a-one',{version:2}));
 const before=await vault.read('Works/a-one.md');
 await assert.rejects(engine.save('metho','Works/a-one.md'),error=>error.conflict===true&&error.code==='revision_conflict');
 assert.equal(await vault.read('Works/a-one.md'),before);
 assert.equal((await store.get('metho','a-one')).pending,undefined);
});

test('a save whose answer is lost is recovered by its original key, never resent',async()=>{
 const {engine,vault,center,store}=setup('a-one');
 await engine.pull('metho');
 await edit(vault,'Works/a-one.md','Body','Edited');
 center.state.failNext=Object.assign(new Error('Center is unreachable; nothing was changed'),{status:0,code:'network_error'});
 await assert.rejects(engine.save('metho','Works/a-one.md'),error=>error.retained===true);
 const pending=(await store.get('metho','a-one')).pending;
 assert.ok(pending.requestKey);
 // The Center did accept it before the answer was lost.
 center.state.drafts.set(pending.requestKey,{articleId:'a-one',requestKey:pending.requestKey,revision:2});
 const result=await engine.save('metho','Works/a-one.md');
 assert.deepEqual(result,{state:'saved',revision:2,metadataUpdated:true});
 assert.equal(center.calls.filter(c=>c[0]==='saveDraft').length,1,'the request was not sent a second time');
 assert.deepEqual(center.calls.at(-1),['draftReceipt',pending.requestKey]);
});

test('an unfinished earlier save keeps its key and reports that it is still pending',async()=>{
 const {engine,vault,center,store}=setup('a-one');
 await engine.pull('metho');
 await edit(vault,'Works/a-one.md','Body','Edited');
 center.state.failNext=Object.assign(new Error('Center is unreachable'),{status:0,code:'network_error'});
 await assert.rejects(engine.save('metho','Works/a-one.md'));
 const key=(await store.get('metho','a-one')).pending.requestKey;
 await assert.rejects(engine.save('metho','Works/a-one.md'),/not finished/);
 assert.equal((await store.get('metho','a-one')).pending.requestKey,key);
});

test('invalid notes are reported before anything is sent',()=>{
 const base={articleId:'a-one',sectionId:'frontiers',locale:'zh-CN',version:1,publishedVersion:null};
 const work=(overrides={},kind='news')=>({kind,media:[],data:{id:'a-one',title:'T',summary:'S',date:'2026-11-03',author:'A',category:'C',sectionId:'frontiers',locale:'zh-CN',markdown:'x',...overrides}});
 const key='obsidian-0123456789abcdef';
 assert.ok(draftEnvelope({work:work(),base,requestKey:key,assets:[]}));
 assert.throws(()=>draftEnvelope({work:work(),base:null,requestKey:key,assets:[]}),/Pull this work/);
 assert.throws(()=>draftEnvelope({work:work({id:'other'}),base,requestKey:key,assets:[]}),/rssd-id/);
 assert.throws(()=>draftEnvelope({work:work({sectionId:'x'}),base,requestKey:key,assets:[]}),/cannot be changed/);
 assert.throws(()=>draftEnvelope({work:work({title:' '}),base,requestKey:key,assets:[]}),/title property is empty/);
 assert.throws(()=>draftEnvelope({work:work({date:'3 Nov'}),base,requestKey:key,assets:[]}),/2026-11-03/);
 assert.throws(()=>draftEnvelope({work:work({},'history'),base,requestKey:key,assets:[]}),/Structured records/);
 assert.throws(()=>draftEnvelope({work:work(),base,requestKey:'x',assets:[]}),/request key/);
});

test('work state covers missing notes and combines with the shared sync states',()=>{
 const base={fingerprint:'F',version:2};
 assert.equal(workState({base:null,localFingerprint:null,remote:{version:1}}),'not_downloaded');
 assert.equal(workState({base,localFingerprint:null,remote:{version:2}}),'missing');
 assert.equal(workState({base,localFingerprint:'F',remote:{version:2}}),'synced');
 assert.equal(workState({base,localFingerprint:'G',remote:{version:2}}),'local_changed');
 assert.equal(workState({base,localFingerprint:'F',remote:{version:3}}),'remote_changed');
 assert.equal(workState({base,localFingerprint:'G',remote:{version:3}}),'conflict');
 assert.equal(notePath('x'),'Works/x.md');
});

test('structured records are downloaded read-only and never saved',async()=>{
 const works=new Map([['rec-one',detail('rec-one',{record:{kind:'history',fields:{}}})]]);
 const center=stubCenter(works),vault=memoryVault(),store=memoryStore();
 const engine=new SyncEngine({client:center.client,vault,store,yaml});
 await engine.pull('metho');
 assert.equal((await store.get('metho','rec-one')).readOnly,true);
 await edit(vault,'Works/rec-one.md','Body','Edited');
 await assert.rejects(engine.save('metho','Works/rec-one.md'),/Structured records/);
 assert.equal(center.calls.filter(c=>c[0]==='saveDraft').length,0);
});

test('a refused save keeps the Center reason so the message names the real cause',async()=>{
 const {saveFailureMessage}=await import('../src/messages.mjs');
 const {engine,vault,center,store}=setup('a-one');
 await engine.pull('metho');
 await edit(vault,'Works/a-one.md','Body','Edited');
 center.state.failNext=Object.assign(new Error('Query the current website publication first'),{status:409,code:'publication_pending'});
 const error=await engine.save('metho','Works/a-one.md').catch(e=>e);
 assert.equal(error.conflict,true);assert.equal(error.code,'publication_pending');
 assert.equal((await store.get('metho','a-one')).pending,undefined,'the baseline is restored');
 assert.match(saveFailureMessage(error),/still publishing.*\[publication_pending\]$/);
 assert.match(saveFailureMessage(Object.assign(new Error('x'),{conflict:true,code:'revision_conflict'})),/newer version.*\[revision_conflict\]$/);
 assert.match(saveFailureMessage(Object.assign(new Error('odd'),{conflict:true,code:'something_new'})),/refused the save: odd\. \[something_new\]$/);
 assert.match(saveFailureMessage(Object.assign(new Error('offline'),{retained:true})),/save is kept/);
 assert.match(saveFailureMessage(Object.assign(new Error('bad date'),{status:400,code:'invalid_request'})),/Save failed: bad date \[invalid_request\]/);
});

test('an edit made while a remote detail is loading survives pull',async()=>{
 const {engine,vault,works,center}=setup('one');await engine.pull('metho');
 works.set('one',detail('one',{version:2,title:'Remote new title'}));
 const work=center.client.work;
 center.client.work=async(...args)=>{await edit(vault,'Works/one.md','Body','Local typing');return work(...args);};
 const result=await engine.pull('metho');
 assert.deepEqual(result.conflicts,['one']);assert.match(await vault.read('Works/one.md'),/Local typing/);
 assert.equal((await engine.states('metho')).one,'conflict');
});
test('an edit immediately after writing does not become the downloaded baseline',async()=>{
 const {engine,vault}=setup('one');const write=vault.write;
 vault.write=async(path,text)=>write(path,text.replace('Body','New local edit'));
 await engine.pull('metho');assert.equal((await engine.states('metho')).one,'local_changed');
});
test('changing a note ID cannot save over another downloaded work',async()=>{
 const {engine,vault,center}=setup('one','two');await engine.pull('metho');
 await edit(vault,'Works/one.md','rssd-id: one','rssd-id: two');
 await assert.rejects(engine.save('metho','Works/one.md'),/does not match/);
 assert.equal(center.calls.filter(x=>x[0]==='saveDraft').length,0);
});
test('changing kind cannot turn a structured record into an editable article',async()=>{
 const {engine,vault,works,center}=setup('one');works.set('one',detail('one',{record:{kind:'resource'}}));
 await engine.pull('metho');await edit(vault,'Works/one.md','rssd-kind: resource','rssd-kind: news');await edit(vault,'Works/one.md','Body','Changed');
 await assert.rejects(engine.save('metho','Works/one.md'),/Structured records/);
 assert.equal(center.calls.filter(x=>x[0]==='saveDraft').length,0);
});

test('catalog changes restart before applying pages from a mixed snapshot',async()=>{
 const {engine,center,vault,store}=setup('one','two');
 const original=center.client.catalog;let calls=0;
 center.client.catalog=async(space,options)=>{
  calls++;
  if(calls===1)return {generation:1,items:[{articleId:'old-only',version:1}],next:1};
  if(calls===2)throw Object.assign(Error('catalog changed'),{code:'catalog_changed'});
  if(calls===3)return {generation:2,items:[{articleId:'one',version:1}],next:1};
  if(calls===4)return {generation:2,items:[{articleId:'two',version:1}],next:null};
  return original(space,options);
 };
 const summary=await engine.pull('metho');
 assert.deepEqual(summary.downloaded,['one','two']);assert.equal(calls,4);
 assert.equal(await vault.read('Works/old-only.md'),null);
 assert.equal(await store.get('metho','old-only'),null);
});

test('a repeatedly changing catalog stops before touching local notes',async()=>{
 const {engine,center,vault,store}=setup('one');let calls=0;
 await vault.write('Works/local.md','Local work');
 center.client.catalog=async()=>{calls++;throw Object.assign(Error('changed'),{code:'catalog_changed'});};
 await assert.rejects(engine.pull('metho'),error=>error.code==='catalog_changed'&&/repeatedly/.test(error.message));
 assert.equal(calls,4);assert.equal(await vault.read('Works/local.md'),'Local work');
 assert.deepEqual(await store.list('metho'),[]);
});

test('malformed catalog cursor fails instead of looping forever',async()=>{
 const {engine,center}=setup('one');let calls=0;
 center.client.catalog=async()=>{calls++;return {generation:1,items:[],next:1};};
 await assert.rejects(engine.pull('metho'),error=>error.code==='invalid_catalog');
 assert.equal(calls,2);
});

test('pull preserves a pending save and locally reverted edits even if the Center moved',async()=>{
 const {engine,vault,center,works,store}=setup('one');
 await engine.pull('metho');
 const original=await vault.read('Works/one.md');
 await edit(vault,'Works/one.md','Body','Uncertain edit');
 center.state.failNext=Object.assign(new Error('connection lost'),{status:0,code:'network_error'});
 await assert.rejects(engine.save('metho','Works/one.md'),error=>error.retained===true);
 const pending=(await store.get('metho','one')).pending;
 // The user deliberately reverts after the uncertain submission, and the Center moves.
 await vault.write('Works/one.md',original);
 works.set('one',detail('one',{version:2,title:'Changed at Center'}));
 const result=await engine.pull('metho');
 assert.deepEqual(result.pending,['one']);assert.equal(await vault.read('Works/one.md'),original);
 assert.deepEqual((await store.get('metho','one')).pending,pending);
 assert.equal((await engine.states('metho')).one,'publishing');
 // Even a missing file must not make pull erase the original recovery key.
 vault.files.delete('Works/one.md');
 assert.deepEqual((await engine.pull('metho')).pending,['one']);
 assert.equal(await vault.read('Works/one.md'),null);
 assert.deepEqual((await store.get('metho','one')).pending,pending);
});

test('saving to an older Center is blocked before posting, even without attachments',async()=>{
 const {engine,vault,center,store}=setup('one');
 await engine.pull('metho');await edit(vault,'Works/one.md','Body','Local change');
 const prior=await store.get('metho','one'),read=center.client.work;
 center.client.work=async(...args)=>{const d=await read(...args);delete d.preservesEditorialFieldsOnSave;return {...d,data:{...d.data,assets:[]}};};
 const original=await vault.read('Works/one.md');
 await assert.rejects(engine.save('metho','Works/one.md'),error=>error.code==='lossless_save_unavailable'&&/Local edits were kept/.test(error.message));
 assert.equal(center.calls.filter(x=>x[0]==='saveDraft').length,0);
 assert.deepEqual(await store.get('metho','one'),prior);assert.equal((await store.get('metho','one')).pending,undefined);assert.equal(await vault.read('Works/one.md'),original);
});

test('save preflight rejects a different Center work without creating a pending submission',async()=>{
 const {engine,vault,center,store}=setup('one');await engine.pull('metho');
 await edit(vault,'Works/one.md','Body','Local change');const read=center.client.work;
 center.client.work=async(...args)=>({...await read(...args),articleId:'different'});
 await assert.rejects(engine.save('metho','Works/one.md'),error=>error.code==='identity_conflict');
 assert.equal(center.calls.filter(x=>x[0]==='saveDraft').length,0);
 assert.equal((await store.get('metho','one')).pending,undefined);
});

test('recovering an uncertain prior save does not require new-save capability or repeat its POST',async()=>{
 const {engine,vault,center,store}=setup('one');await engine.pull('metho');
 await edit(vault,'Works/one.md','Body','Local change');
 center.state.failNext=Object.assign(Error('connection lost'),{code:'network_error'});
 await assert.rejects(engine.save('metho','Works/one.md'),error=>error.retained===true);
 const key=(await store.get('metho','one')).pending.requestKey;
 center.state.drafts.set(key,{articleId:'one',requestKey:key,revision:2});
 center.client.work=async()=>{throw Error('must not read a new version to recover a pending request');};
 assert.deepEqual(await engine.save('metho','Works/one.md'),{state:'saved',revision:2,metadataUpdated:true});
 assert.equal(center.calls.filter(x=>x[0]==='saveDraft').length,1);
});

test('pull retries a transient detail error after other works and reports successful recovery',async()=>{
 const {engine,center,vault}=setup('one','two','three');const read=center.client.work;let first=true;
 center.client.work=async(space,id)=>{if(id==='one'&&first){first=false;throw Object.assign(Error('temporary timeout'),{code:'network_error',status:0});}return read(space,id);};
 const result=await engine.pull('metho');
 assert.deepEqual(result.downloaded,['two','three','one']);assert.deepEqual(result.failed,[]);
 assert.equal(result.transport.singleRequests,4);assert.equal(result.transport.fallbackSingles,3);assert.equal(result.transport.retrySingles,1);
 assert.ok(await vault.read('Works/one.md'));assert.ok(await vault.read('Works/two.md'));
});

test('persistent per-work network failure is reported, bounded, and other works remain downloaded',async()=>{
 const {engine,center,vault,store}=setup('one','two');const read=center.client.work;let attempts=0;
 center.client.work=async(space,id)=>{if(id==='one'){attempts++;throw Object.assign(Error('timeout rssd_device_abc'),{code:'network_error',status:0});}return read(space,id);};
 const result=await engine.pull('metho');
 assert.equal(attempts,2);assert.deepEqual(result.downloaded,['two']);
 assert.deepEqual(result.failed,[{articleId:'one',code:'network_error',message:'timeout [redacted]'}]);
 assert.equal(await vault.read('Works/one.md'),null);assert.ok(await store.get('metho','two'));
});

test('a local edit made after a deferred detail failure survives the retry',async()=>{
 const {engine,center,vault,works}=setup('one','two');await engine.pull('metho');
 works.set('one',detail('one',{version:2,title:'Remote changed'}));
 works.set('two',detail('two',{version:2,title:'Remote two'}));
 const read=center.client.work;let failed=false;
 center.client.work=async(space,id)=>{
  if(id==='one'&&!failed){failed=true;throw Object.assign(Error('offline'),{code:'network_error',status:0});}
  if(id==='two')await edit(vault,'Works/one.md','Body','Keep local editing');
  return read(space,id);
 };
 const result=await engine.pull('metho');
 assert.deepEqual(result.failed,[]);assert.deepEqual(result.conflicts,['one']);
 assert.match(await vault.read('Works/one.md'),/Keep local editing/);
 assert.deepEqual(result.updated,['two']);
});

test('network failure reading the catalog still stops the pull immediately',async()=>{
 const {engine,center,vault}=setup('one');center.client.catalog=async()=>{throw Object.assign(Error('offline'),{code:'network_error',status:0});};
 await assert.rejects(engine.pull('metho'),error=>error.code==='network_error');
 assert.equal(await vault.read('Works/one.md'),null);
});

test('English and Chinese versions with the same ID stay separate through pull, edit, and save',async()=>{
 const zh=detail('same',{version:1,title:'中文'}),en=detail('same',{version:4,title:'English'});en.locale='en';en.data.locale='en';
 const entries={'zh-CN':zh,en},vault=memoryVault(),store=memoryStore(),calls=[];
 const client={
  catalog:async(_s,options)=>{calls.push(['catalog',options.locale]);return {generation:1,items:[{articleId:'same',version:entries[options.locale].version}],next:null};},
  work:async(_s,id,locale)=>{calls.push(['work',id,locale]);return {...entries[locale],preservesEditorialFieldsOnSave:true};},
  saveDraft:async(_s,envelope)=>{calls.push(['save',envelope]);assert.equal(envelope.data.locale,'en');assert.equal(envelope.expectedVersion,4);return {articleId:envelope.data.id,requestKey:envelope.requestKey,revision:5};}
 };
 const engine=new SyncEngine({client,vault,store,yaml});
 await engine.pull('metho',{locale:'zh-CN'});await engine.pull('metho',{locale:'en'});
 const chinese=await vault.read('Works/same.md');const english=await vault.read('Works/en/same.md');
 assert.match(chinese,/title: 中文/);assert.match(chinese,/\.\.\/article-media\/a\.png/);
 assert.match(english,/title: English/);assert.match(english,/\.\.\/\.\.\/article-media\/a\.png/);
 assert.equal((await store.get('metho','same','zh-CN')).version,1);assert.equal((await store.get('metho','same','en')).version,4);
 await edit(vault,'Works/en/same.md','Body','English edit');
 assert.deepEqual(await engine.save('metho','Works/en/same.md'),{state:'saved',revision:5,metadataUpdated:true});
 assert.equal(await vault.read('Works/same.md'),chinese);assert.equal((await store.get('metho','same','zh-CN')).version,1);
 assert.match(await vault.read('Works/en/same.md'),/rssd-version: 5/);assert.match(await vault.read('Works/same.md'),/rssd-version: 1/);
 assert.equal((await store.get('metho','same','en')).version,5);
 const payload=calls.find(c=>c[0]==='save')[1].data;
 assert.match(payload.markdown,/English edit/);assert.match(payload.markdown,/\/article-media\/a\.png/);assert.equal(payload.assets[0].path,'/article-media/a.png');
 assert.ok(calls.some(c=>c[0]==='work'&&c[2]==='en'));assert.ok(calls.some(c=>c[0]==='work'&&c[2]==='zh-CN'));
});

test('language identity changes and wrong-language Center details never overwrite another note',async()=>{
 const {engine,vault,center}=setup('one');await engine.pull('metho');
 const original=await vault.read('Works/one.md');
 await vault.write('Works/one.md',original.replace('rssd-locale: zh-CN','rssd-locale: en'));
 await assert.rejects(engine.save('metho','Works/one.md'),/does not match/);
 assert.equal(center.calls.filter(c=>c[0]==='saveDraft').length,0);
 const english=detail('two');english.locale='zh-CN';
 const store=memoryStore(),other=new SyncEngine({client:{catalog:async()=>({generation:1,items:[{articleId:'two',version:1}],next:null}),work:async()=>english},vault,store,yaml});
 await assert.rejects(other.pull('metho',{locale:'en'}),error=>error.code==='identity_conflict');
 assert.equal(await vault.read('Works/en/two.md'),null);
});


test('a malformed save receipt retains the original request key and recovers without resubmitting',async()=>{
 const {engine,vault,center,store}=setup('one');await engine.pull('metho');
 await edit(vault,'Works/one.md','Body','Edited');const save=center.client.saveDraft;
 center.client.saveDraft=async(...args)=>{await save(...args);return {revision:2,articleId:'other',requestKey:args[1].requestKey};};
 await assert.rejects(engine.save('metho','Works/one.md'),error=>error.code==='invalid_receipt'&&error.retained===true);
 const base=await store.get('metho','one'),key=base.pending.requestKey;assert.equal(base.version,1);
 assert.deepEqual(await engine.save('metho','Works/one.md'),{state:'saved',revision:2,metadataUpdated:true});
 assert.equal(center.calls.filter(c=>c[0]==='saveDraft').length,1);assert.equal(center.calls.at(-1)[1],key);
});

test('a wrong recovery receipt cannot clear the pending request',async()=>{
 const {engine,vault,center,store}=setup('one');await engine.pull('metho');
 await edit(vault,'Works/one.md','Body','Edited');
 center.state.failNext=Object.assign(Error('lost'),{code:'network_error',status:0});
 await assert.rejects(engine.save('metho','Works/one.md'));const key=(await store.get('metho','one')).pending.requestKey;
 center.state.drafts.set(key,{articleId:'one',requestKey:'another-request',revision:2});
 await assert.rejects(engine.save('metho','Works/one.md'),error=>error.code==='invalid_receipt'&&error.retained===true);
 assert.equal((await store.get('metho','one')).pending.requestKey,key);
});


test('an HTTP 408 response preserves the original write key for recovery',async()=>{
 const {engine,vault,center,store}=setup('one');await engine.pull('metho');
 await edit(vault,'Works/one.md','Body','Edited');
 center.state.failNext=Object.assign(Error('gateway timeout'),{status:408,code:'http_error'});
 await assert.rejects(engine.save('metho','Works/one.md'),error=>error.retained===true);
 const key=(await store.get('metho','one')).pending.requestKey;assert.ok(key);
 center.state.drafts.set(key,{articleId:'one',requestKey:key,revision:2});
 assert.deepEqual(await engine.save('metho','Works/one.md'),{state:'saved',revision:2,metadataUpdated:true});
 assert.equal(center.calls.filter(c=>c[0]==='saveDraft').length,1);
});


test('invalid remote identities cannot escape the vault or overwrite an existing work',async()=>{
 const {engine,center,vault,store}=setup('one');
 await vault.write('outside.md','keep this');
 center.client.catalog=async()=>({generation:1,items:[{articleId:'../outside',version:1}],next:null});
 await assert.rejects(engine.pull('metho'),error=>error.code==='invalid_work_id');
 assert.equal(await vault.read('outside.md'),'keep this');assert.deepEqual(await store.list('metho'),[]);
});

test('invalid Center media paths are rejected before any vault write',async()=>{
 const {engine,works,vault,store}=setup('one');
 const work=works.get('one');work.data.assets=[{path:'/article-media/../../outside.md',data:'aGVsbG8='}];
 await vault.write('outside.md','keep this');
 await assert.rejects(engine.pull('metho'),error=>error.code==='invalid_media_path');
 assert.equal(await vault.read('outside.md'),'keep this');assert.equal(await vault.read('Works/one.md'),null);assert.deepEqual(await store.list('metho'),[]);
});

test('small batches reduce requests and preserve sequential vault writes',async()=>{
 const ids=Array.from({length:10},(_,i)=>'batch-'+i),{engine,center,vault,works}=setup(...ids),calls=[];
 let activeWrites=0,peakWrites=0;const write=vault.write;
 vault.write=async(...args)=>{activeWrites++;peakWrites=Math.max(peakWrites,activeWrites);await new Promise(resolve=>setTimeout(resolve,1));try{return await write(...args);}finally{activeWrites--;}};
 center.client.workBatch=async(space,asked,locale)=>{calls.push({space,asked,locale});return {locale,items:asked.map(id=>({articleId:id,ok:true,detail:works.get(id)}))};};
 const result=await engine.pull('metho');
 assert.deepEqual(calls.map(x=>x.asked.length),[8,2]);assert.equal(center.calls.filter(x=>x[0]==='work').length,0);
 assert.equal(result.downloaded.length,10);assert.equal(peakWrites,1);assert.deepEqual(result.failed,[]);
 assert.deepEqual(result.transport,{batchRequests:2,batchWorks:10,batchDelivered:10,batchRequestErrors:0,batchUnsupported:0,batchOverLimit:0,batchItemFailures:0,singleRequests:0,fallbackSingles:0,retrySingles:0});
});

test('transport progress snapshots remain stable and contain only counters',async()=>{
 const ids=Array.from({length:9},(_,i)=>'private-id-'+i),{engine,center,works}=setup(...ids),snapshots=[];
 center.client.workBatch=async(_space,asked,locale)=>({locale,items:asked.map(id=>({articleId:id,ok:true,detail:works.get(id)}))});
 const result=await engine.pull('metho',{onProgress:({summary})=>snapshots.push(summary.transport)});
 assert.equal(snapshots[0].batchRequests,0);assert.equal(snapshots[8].batchRequests,1);assert.equal(snapshots[8].batchWorks,8);
 assert.equal(result.transport.batchRequests,2);assert.ok(Object.values(result.transport).every(value=>Number.isInteger(value)&&value>=0));
 assert.doesNotMatch(JSON.stringify(result.transport),/private-id|rssd_device|Bearer/);
});

test('older Center falls back once to bounded parallel single-work reads',async()=>{
 const ids=Array.from({length:10},(_,i)=>'legacy-'+i),{engine,center}=setup(...ids);let batches=0,active=0,peak=0;
 center.client.workBatch=async()=>{batches++;throw Object.assign(Error('Unknown editorial operation'),{status:404,code:'not_found'});};
 const get=center.client.work;center.client.work=async(...args)=>{active++;peak=Math.max(peak,active);try{await new Promise(resolve=>setTimeout(resolve,2));return await get(...args);}finally{active--;}};
 const result=await engine.pull('metho');assert.equal(batches,1);assert.equal(result.downloaded.length,10);
 assert.equal(center.calls.filter(x=>x[0]==='work').length,10);assert.equal(peak,3);
 assert.deepEqual(result.transport,{batchRequests:1,batchWorks:8,batchDelivered:0,batchRequestErrors:1,batchUnsupported:1,batchOverLimit:0,batchItemFailures:0,singleRequests:10,fallbackSingles:10,retrySingles:0});
});

test('batch size-limit fallback fetches only oversized works individually',async()=>{
 const {engine,center,works}=setup('one','two','three');
 center.client.workBatch=async(_space,ids,locale)=>({locale,items:ids.map(id=>id==='two'?
  {articleId:id,ok:false,error:{code:'batch_response_limit',status:413,message:'Read this work individually'}}:
  {articleId:id,ok:true,detail:works.get(id)})});
 const result=await engine.pull('metho');assert.deepEqual(result.downloaded,['one','two','three']);
 assert.deepEqual(center.calls.filter(x=>x[0]==='work').map(x=>x[1]),['two']);
 assert.equal(result.transport.batchDelivered,2);assert.equal(result.transport.batchOverLimit,1);assert.equal(result.transport.singleRequests,1);assert.equal(result.transport.fallbackSingles,1);
});

test('batch per-work errors leave other works usable and make the result incomplete',async()=>{
 const {engine,center,works,vault}=setup('one','two');
 center.client.workBatch=async(_space,ids,locale)=>({locale,items:ids.map(id=>id==='one'?
  {articleId:id,ok:false,error:{code:'identity_conflict',status:409,message:'Duplicate identity'}}:
  {articleId:id,ok:true,detail:works.get(id)})});
 const result=await engine.pull('metho');assert.deepEqual(result.failed,[{articleId:'one',code:'identity_conflict',message:'Duplicate identity'}]);
 assert.deepEqual(result.downloaded,['two']);assert.equal(await vault.read('Works/one.md'),null);assert.ok(await vault.read('Works/two.md'));
 assert.equal(result.transport.batchDelivered,1);assert.equal(result.transport.batchItemFailures,1);assert.equal(result.transport.singleRequests,0);
});

test('mismatched batch identities are rejected before any note is written',async()=>{
 const {engine,center,works,vault}=setup('one','two');
 center.client.workBatch=async(_space,_ids,locale)=>({locale,items:[{articleId:'two',ok:true,detail:works.get('two')},{articleId:'one',ok:true,detail:works.get('one')}]});
 await assert.rejects(engine.pull('metho'),error=>error.code==='invalid_batch');assert.equal(vault.files.size,0);
});

test('local edits and pending saves made during a batch read are preserved',async()=>{
 const {engine,center,vault,works,store}=setup('one','two');await engine.pull('metho');
 for(const id of ['one','two'])works.set(id,detail(id,{version:2,title:'Remote '+id}));
 center.client.workBatch=async(_space,ids,locale)=>{
  await edit(vault,'Works/one.md','Body','Local edit');
  const base=await store.get('metho','two');await store.set('metho','two',{...base,pending:{requestKey:'keep-original'}});
  return {locale,items:ids.map(id=>({articleId:id,ok:true,detail:works.get(id)}))};
 };
 const result=await engine.pull('metho');assert.deepEqual(result.conflicts,['one']);assert.deepEqual(result.pending,['two']);
 assert.match(await vault.read('Works/one.md'),/Local edit/);assert.equal((await store.get('metho','two')).pending.requestKey,'keep-original');
});

test('repeated full-batch outages stop further requests and retain partial failures',async()=>{
 const ids=Array.from({length:24},(_,i)=>'offline-'+i),{engine,center}=setup(...ids);let calls=0;
 center.client.workBatch=async()=>{calls++;throw Object.assign(Error('unreachable'),{code:'network_error',status:0});};
 await assert.rejects(engine.pull('metho'),error=>{assert.equal(error.code,'network_error');assert.equal(error.pullSummary.failed.length,16);assert.equal(error.pullSummary.transport.batchRequests,2);assert.equal(error.pullSummary.transport.batchWorks,16);assert.equal(error.pullSummary.transport.batchRequestErrors,2);return true;});
 assert.equal(calls,2);assert.equal(center.calls.filter(x=>x[0]==='work').length,0);
});

test('a timed-out batch stops the pull without starting another request',async()=>{
 const ids=Array.from({length:24},(_,i)=>'slow-'+i),{engine,center}=setup(...ids);let calls=0;
 center.client.workBatch=async()=>{calls++;throw Object.assign(Error('timed out'),{code:'network_error',status:0,timedOut:true});};
 await assert.rejects(engine.pull('metho'),error=>{assert.equal(error.timedOut,true);assert.equal(error.pullSummary.failed.length,8);assert.equal(error.pullSummary.transport.batchRequests,1);return true;});
 assert.equal(calls,1);assert.equal(center.calls.filter(x=>x[0]==='work').length,0);
});

test('a timed-out single fallback stops scheduling more work and reports the incomplete batch',async()=>{
 const ids=Array.from({length:8},(_,i)=>'single-'+i),{engine,center}=setup(...ids);let calls=0;
 center.client.work=async()=>{calls++;if(calls===1)throw Object.assign(Error('timed out'),{code:'network_error',status:0,timedOut:true});await new Promise(resolve=>setTimeout(resolve,5));return {};};
 await assert.rejects(engine.pull('metho'),error=>{assert.equal(error.timedOut,true);assert.equal(error.pullSummary.failed.length,8);assert.equal(error.pullSummary.transport.singleRequests,3);return true;});
 assert.equal(calls,3);
});

test('duplicate catalog identities cannot race one vault note',async()=>{
 const {engine,center,vault}=setup('same');
 center.client.catalog=async()=>({generation:1,items:[{articleId:'same',version:1},{articleId:'same',version:1}],next:null});
 await assert.rejects(engine.pull('metho'),error=>error.code==='identity_conflict');assert.equal(vault.files.size,0);
});

test('single-read fallback waits for all in-flight requests before reporting a fatal error',async()=>{
 const {engine,center,vault}=setup('one','two','three');const read=center.client.work;let active=0;
 center.client.work=async(space,id)=>{active++;try{if(id==='one')throw Object.assign(Error('server failure'),{status:503});await new Promise(resolve=>setTimeout(resolve,4));return await read(space,id);}finally{active--;}};
 await assert.rejects(engine.pull('metho'),error=>error.status===503);assert.equal(active,0);assert.equal(vault.files.size,0);
});

test('confirmed private saves update only the local version label, not the published version',async()=>{
 const {engine,vault,works,store}=setup('one');works.set('one',detail('one',{published:1}));await engine.pull('metho');
 await edit(vault,'Works/one.md','Body','Edited body');const before=await vault.read('Works/one.md'),fingerprint=(await engine.noteFingerprint('Works/one.md')).fingerprint;
 const result=await engine.save('metho','Works/one.md'),after=await vault.read('Works/one.md');
 assert.deepEqual(result,{state:'saved',revision:2,metadataUpdated:true});
 assert.equal(after,before.replace('rssd-version: 1','rssd-version: 2'));assert.match(after,/rssd-published-version: 1/);
 assert.equal((await engine.noteFingerprint('Works/one.md')).fingerprint,fingerprint);
 assert.equal((await store.get('metho','one')).metadataSync,undefined);
 await edit(vault,'Works/one.md','Edited body','Edited twice');await engine.save('metho','Works/one.md');
 assert.match(await vault.read('Works/one.md'),/rssd-version: 3/);assert.match(await vault.read('Works/one.md'),/rssd-published-version: 1/);
});

test('edits made during the Center save survive the version label update',async()=>{
 const {engine,vault,center}=setup('one');await engine.pull('metho');await edit(vault,'Works/one.md','Body','First edit');
 const submit=center.client.saveDraft;center.client.saveDraft=async(...args)=>{const receipt=await submit(...args);await edit(vault,'Works/one.md','First edit','First edit plus concurrent typing');return receipt;};
 const result=await engine.save('metho','Works/one.md');assert.equal(result.metadataUpdated,true);
 const content=await vault.read('Works/one.md');assert.match(content,/First edit plus concurrent typing/);assert.match(content,/rssd-version: 2/);
 assert.equal((await engine.states('metho')).one,'local_changed');assert.equal(center.calls.filter(x=>x[0]==='saveDraft').length,1);
});

test('repeated compare-and-swap races keep the save successful and can be repaired on pull',async()=>{
 const {engine,vault,center,store}=setup('one');await engine.pull('metho');await edit(vault,'Works/one.md','Body','Original edit');
 const write=vault.write;let races=0;
 vault.write=async(path,content,options={})=>{
  if(path==='Works/one.md'&&options.expectedContent&&content.includes('rssd-version: 2')){
   races++;await write(path,(await vault.read(path))+'concurrent '+races+'\n');
  }
  return write(path,content,options);
 };
 const result=await engine.save('metho','Works/one.md');
 assert.equal(result.state,'saved');assert.equal(result.revision,2);assert.equal(result.metadataUpdated,false);assert.match(result.metadataWarning,/local version label/);
 const base=await store.get('metho','one');assert.equal(base.pending,undefined);assert.equal(base.metadataSync.revision,2);
 assert.match(await vault.read('Works/one.md'),/concurrent 1\nconcurrent 2/);assert.match(await vault.read('Works/one.md'),/rssd-version: 1/);
 vault.write=write;const pull=await engine.pull('metho');assert.deepEqual(pull.metadataPending,[]);assert.deepEqual(pull.skipped,['one']);
 assert.match(await vault.read('Works/one.md'),/rssd-version: 2/);assert.match(await vault.read('Works/one.md'),/concurrent 1\nconcurrent 2/);
 assert.equal((await store.get('metho','one')).metadataSync,undefined);assert.equal(center.calls.filter(x=>x[0]==='saveDraft').length,1);
});

test('a removed or reidentified note is never recreated or overwritten after a confirmed save',async()=>{
 for(const mode of ['removed','identity']){
  const {engine,vault,center,store}=setup('one');await engine.pull('metho');await edit(vault,'Works/one.md','Body','Edited');const submit=center.client.saveDraft;
  center.client.saveDraft=async(...args)=>{const receipt=await submit(...args);if(mode==='removed')vault.files.delete('Works/one.md');else await edit(vault,'Works/one.md','rssd-id: one','rssd-id: different');return receipt;};
  const result=await engine.save('metho','Works/one.md');assert.equal(result.state,'saved');assert.equal(result.metadataUpdated,false);
  assert.equal((await store.get('metho','one')).version,2);assert.equal((await store.get('metho','one')).pending,undefined);
  if(mode==='removed')assert.equal(await vault.read('Works/one.md'),null);else assert.match(await vault.read('Works/one.md'),/rssd-id: different/);
 }
});

test('failed saves do not change the local version; original-key recovery updates it safely',async()=>{
 const {engine,vault,center,store}=setup('one');await engine.pull('metho');await edit(vault,'Works/one.md','Body','Saved content');
 const submit=center.client.saveDraft;center.client.saveDraft=async(...args)=>{await submit(...args);throw Object.assign(Error('response lost'),{status:408});};
 await assert.rejects(engine.save('metho','Works/one.md'),e=>e.retained===true);assert.match(await vault.read('Works/one.md'),/rssd-version: 1/);
 const key=(await store.get('metho','one')).pending.requestKey;await edit(vault,'Works/one.md','Saved content','Saved content plus later work');
 const recovered=await engine.save('metho','Works/one.md');assert.equal(recovered.state,'saved');assert.equal(recovered.metadataUpdated,true);
 assert.match(await vault.read('Works/one.md'),/rssd-version: 2/);assert.match(await vault.read('Works/one.md'),/plus later work/);
 assert.equal(center.calls.filter(x=>x[0]==='saveDraft').length,1);assert.equal(center.calls.find(x=>x[0]==='draftReceipt')[1],key);
 assert.equal((await engine.states('metho')).one,'local_changed');
});

test('version marker patch preserves CRLF, quotes, comments and all body bytes',()=>{
 const before='---\r\ntitle: Example\r\nrssd-id: one\r\nrssd-section: frontiers\r\nrssd-locale: zh-CN\r\nrssd-version: "1"  # preserved\r\nrssd-published-version: 1\r\n---\r\nBody\r\nrssd-version: 1\r\n';
 const patched=updateNoteVersion(before,{articleId:'one',sectionId:'frontiers',locale:'zh-CN',version:2},yaml.parse);
 assert.equal(patched.content,before.replace('rssd-version: "1"  # preserved','rssd-version: "2"  # preserved'));
 assert.equal(updateNoteVersion(before,{articleId:'other',sectionId:'frontiers',locale:'zh-CN',version:2},yaml.parse),null);
 assert.equal(updateNoteVersion(before.replace('rssd-version: "1"','rssd-version: "9"'),{articleId:'one',sectionId:'frontiers',locale:'zh-CN',version:2},yaml.parse),null);
 const duplicate=before.replace('rssd-published-version: 1','rssd-version: 1\r\nrssd-published-version: 1');
 assert.equal(updateNoteVersion(duplicate,{articleId:'one',sectionId:'frontiers',locale:'zh-CN',version:2},yaml.parse),null);
});

test('pull safely repairs a version label left stale by an older plugin',async()=>{
 const {engine,vault,center,store}=setup('one');await engine.pull('metho');await edit(vault,'Works/one.md','Body','Sent edit');await engine.save('metho','Works/one.md');
 await edit(vault,'Works/one.md','rssd-version: 2','rssd-version: 1');await edit(vault,'Works/one.md','Sent edit','Sent edit plus local work');
 const before=await vault.read('Works/one.md'),result=await engine.pull('metho');
 assert.equal(await vault.read('Works/one.md'),before.replace('rssd-version: 1','rssd-version: 2'));
 assert.deepEqual(result.skipped,['one']);assert.deepEqual(result.metadataPending,[]);assert.equal((await store.get('metho','one')).metadataSync,undefined);
 assert.equal(center.calls.filter(x=>x[0]==='saveDraft').length,1);
});

test('unrepairable stale metadata is reported without changing the file or sending a save',async()=>{
 const {engine,vault,center}=setup('one');await engine.pull('metho');await edit(vault,'Works/one.md','Body','Changed');await engine.save('metho','Works/one.md');
 await edit(vault,'Works/one.md','rssd-version: 2','rssd-version: 99');const before=await vault.read('Works/one.md');
 const result=await engine.pull('metho');assert.deepEqual(result.metadataPending,['one']);assert.equal(await vault.read('Works/one.md'),before);
 assert.equal(center.calls.filter(x=>x[0]==='saveDraft').length,1);
});

test('a baseline persistence failure retains the request key and recovery never resubmits',async()=>{
 const {engine,vault,center,store}=setup('one');await engine.pull('metho');await edit(vault,'Works/one.md','Body','Edited');
 const set=store.set;let fail=true;store.set=async(space,id,value,locale)=>{if(fail&&value.version===2&&!value.pending){fail=false;throw Error('disk full');}return set(space,id,value,locale);};
 await assert.rejects(engine.save('metho','Works/one.md'),/disk full/);const pending=(await store.get('metho','one')).pending;
 assert.ok(pending?.requestKey);assert.match(await vault.read('Works/one.md'),/rssd-version: 1/);
 const recovered=await engine.save('metho','Works/one.md');assert.equal(recovered.state,'saved');assert.equal(recovered.metadataUpdated,true);
 assert.match(await vault.read('Works/one.md'),/rssd-version: 2/);assert.equal(center.calls.filter(x=>x[0]==='saveDraft').length,1);
 assert.equal(center.calls.find(x=>x[0]==='draftReceipt')[1],pending.requestKey);
});

test('metadata repair failure never causes a repeated private draft POST',async()=>{
 const {engine,vault,center,store}=setup('one');await engine.pull('metho');await edit(vault,'Works/one.md','Body','Edited');
 const write=vault.write;let blocked=true;vault.write=async(path,content,options={})=>{
  if(blocked&&path==='Works/one.md'&&content.includes('rssd-version: 2')&&options.expectedContent)throw Error('local file locked');
  return write(path,content,options);
 };
 const saved=await engine.save('metho','Works/one.md');assert.equal(saved.state,'saved');assert.equal(saved.metadataUpdated,false);
 const unchanged=await engine.save('metho','Works/one.md');assert.equal(unchanged.state,'unchanged');assert.equal(unchanged.metadataUpdated,false);
 assert.equal(center.calls.filter(x=>x[0]==='saveDraft').length,1);assert.equal((await store.get('metho','one')).metadataSync.revision,2);
 blocked=false;assert.deepEqual(await engine.save('metho','Works/one.md'),{state:'unchanged'});
 assert.match(await vault.read('Works/one.md'),/rssd-version: 2/);assert.equal((await store.get('metho','one')).metadataSync,undefined);
 assert.equal(center.calls.filter(x=>x[0]==='saveDraft').length,1);
});

test('a restored missing note can repair its version marker without a new remote write',async()=>{
 const {engine,vault,center,store}=setup('one');await engine.pull('metho');await edit(vault,'Works/one.md','Body','Edited');
 const original=await vault.read('Works/one.md'),submit=center.client.saveDraft;
 center.client.saveDraft=async(...args)=>{const receipt=await submit(...args);vault.files.delete('Works/one.md');return receipt;};
 const saved=await engine.save('metho','Works/one.md');assert.equal(saved.metadataUpdated,false);assert.equal(await vault.read('Works/one.md'),null);
 await vault.write('Works/one.md',original);const result=await engine.pull('metho');
 assert.deepEqual(result.metadataPending,[]);assert.match(await vault.read('Works/one.md'),/rssd-version: 2/);
 assert.equal((await store.get('metho','one')).metadataSync,undefined);assert.equal(center.calls.filter(x=>x[0]==='saveDraft').length,1);
});

test('metadata repair refuses a baseline with another work identity or language',async()=>{
 for(const change of [{articleId:'other'},{locale:'en'}]){
  const {engine,vault,store}=setup('one');await engine.pull('metho');
  const before=await vault.read('Works/one.md'),base=await store.get('metho','one');
  await store.set('metho','one',{...base,...change,version:2,metadataSync:{revision:2}});
  const result=await engine.repairMetadata('metho','one','zh-CN');assert.equal(result.metadataUpdated,false);
  assert.equal(await vault.read('Works/one.md'),before);assert.equal((await store.get('metho','one')).metadataSync.revision,2);
 }
});

test('a single version-marker CAS conflict retries against the latest user edit',async()=>{
 const {engine,vault,center}=setup('one');await engine.pull('metho');await edit(vault,'Works/one.md','Body','Sent text');
 const write=vault.write;let raced=false;
 vault.write=async(path,content,options={})=>{
  if(!raced&&path==='Works/one.md'&&options.expectedContent&&content.includes('rssd-version: 2')){
   raced=true;await write(path,(await vault.read(path)).replace('Sent text','Sent text plus newer edit'));
  }
  return write(path,content,options);
 };
 const result=await engine.save('metho','Works/one.md');assert.equal(result.metadataUpdated,true);
 assert.match(await vault.read('Works/one.md'),/Sent text plus newer edit/);assert.match(await vault.read('Works/one.md'),/rssd-version: 2/);
 assert.equal((await engine.states('metho')).one,'local_changed');assert.equal(center.calls.filter(x=>x[0]==='saveDraft').length,1);
});
