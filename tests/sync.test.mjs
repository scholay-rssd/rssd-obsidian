import test from 'node:test';
import assert from 'node:assert/strict';
import {SyncEngine} from '../src/sync-engine.mjs';
import {workToNote,noteToWork,toVaultMarkdown,toCenterMarkdown,workState,draftEnvelope,notePath} from '../src/sync-model.mjs';
import {yaml,memoryVault,memoryStore,stubCenter,detail,png} from './helpers.mjs';

const setup=(...ids)=>{
 const works=new Map(ids.map(id=>[id,detail(id)])),center=stubCenter(works),vault=memoryVault(),store=memoryStore();
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
