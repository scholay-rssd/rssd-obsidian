import test from 'node:test';
import assert from 'node:assert/strict';
import {SyncEngine} from '../src/sync-engine.mjs';
import {workToNote,noteToWork,toVaultMarkdown,toCenterMarkdown,workState,draftEnvelope,notePath} from '../src/sync-model.mjs';
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
 assert.deepEqual(result,{state:'saved',revision:2});
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
 center.state.drafts.set(pending.requestKey,{revision:2});
 const result=await engine.save('metho','Works/a-one.md');
 assert.deepEqual(result,{state:'saved',revision:2});
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
 center.state.drafts.set(key,{revision:2});
 center.client.work=async()=>{throw Error('must not read a new version to recover a pending request');};
 assert.deepEqual(await engine.save('metho','Works/one.md'),{state:'saved',revision:2});
 assert.equal(center.calls.filter(x=>x[0]==='saveDraft').length,1);
});

test('pull retries a transient detail error after other works and reports successful recovery',async()=>{
 const {engine,center,vault}=setup('one','two','three');const read=center.client.work;let first=true;
 center.client.work=async(space,id)=>{if(id==='one'&&first){first=false;throw Object.assign(Error('temporary timeout'),{code:'network_error',status:0});}return read(space,id);};
 const result=await engine.pull('metho');
 assert.deepEqual(result.downloaded,['two','three','one']);assert.deepEqual(result.failed,[]);
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
  saveDraft:async(_s,envelope)=>{calls.push(['save',envelope]);assert.equal(envelope.data.locale,'en');assert.equal(envelope.expectedVersion,4);return {revision:5};}
 };
 const engine=new SyncEngine({client,vault,store,yaml});
 await engine.pull('metho',{locale:'zh-CN'});await engine.pull('metho',{locale:'en'});
 const chinese=await vault.read('Works/same.md');const english=await vault.read('Works/en/same.md');
 assert.match(chinese,/title: 中文/);assert.match(chinese,/\.\.\/article-media\/a\.png/);
 assert.match(english,/title: English/);assert.match(english,/\.\.\/\.\.\/article-media\/a\.png/);
 assert.equal((await store.get('metho','same','zh-CN')).version,1);assert.equal((await store.get('metho','same','en')).version,4);
 await edit(vault,'Works/en/same.md','Body','English edit');
 assert.deepEqual(await engine.save('metho','Works/en/same.md'),{state:'saved',revision:5});
 assert.equal(await vault.read('Works/same.md'),chinese);assert.equal((await store.get('metho','same','zh-CN')).version,1);
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
