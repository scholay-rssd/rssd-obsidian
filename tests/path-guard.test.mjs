import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalPathIdentity,trackRename,trackDelete,confirmReturn,checkCanonicalPull} from '../src/path-guard.mjs';
import {SyncEngine} from '../src/sync-engine.mjs';
import {yaml,memoryVault,memoryStore,stubCenter,detail} from './helpers.mjs';

test('canonical paths keep locale and article identity separate',()=>{
 assert.deepEqual(canonicalPathIdentity('Works/work-1.md'),{articleId:'work-1',locale:'zh-CN',canonicalPath:'Works/work-1.md'});
 assert.deepEqual(canonicalPathIdentity('Works/en/work-1.md'),{articleId:'work-1',locale:'en',canonicalPath:'Works/en/work-1.md'});
 for(const path of ['Works/../x.md','Works/en/../../x.md','Works/untitled 中文.md','Other/work-1.md'])assert.equal(canonicalPathIdentity(path),null);
});
test('moving a work and moving it again never authorizes recreating its former location',()=>{
 let state=trackRename({},'Works/work-1.md','Archive/My note.md');
 state=trackRename(state,'Archive/My note.md','Archive/Other name.md');
 assert.deepEqual(checkCanonicalPull({articleId:'work-1',locale:'zh-CN',hasBaseline:true,canonicalExists:false,records:state}),{allowed:false,code:'local_work_moved',canonicalPath:'Works/work-1.md',currentPath:'Archive/Other name.md'});
 assert.equal(checkCanonicalPull({articleId:'work-1',locale:'zh-CN',hasBaseline:true,canonicalExists:true,records:state}).allowed,false,'even a duplicate old path requires reconciliation');
 assert.equal(checkCanonicalPull({articleId:'work-1',locale:'en',hasBaseline:true,canonicalExists:true,records:state}).allowed,true);
});
test('return to the canonical location requires a verified id and locale',()=>{
 let state=trackRename({},'Works/work-1.md','Archive/My note.md');state=trackRename(state,'Archive/My note.md','Works/work-1.md');
 assert.equal(state['zh-CN/work-1'].state,'verify_return');
 assert.throws(()=>confirmReturn(state,{articleId:'work-1',locale:'zh-CN',path:'Works/work-1.md',observedArticleId:'another',observedLocale:'zh-CN'}),{code:'identity_conflict'});
 assert.throws(()=>confirmReturn(state,{articleId:'work-1',locale:'zh-CN',path:'Works/work-1.md',observedArticleId:'work-1',observedLocale:'en'}),{code:'identity_conflict'});
 state=confirmReturn(state,{articleId:'work-1',locale:'zh-CN',path:'Works/work-1.md',observedArticleId:'work-1',observedLocale:'zh-CN'});
 assert.deepEqual(state,{});
});
test('a locally deleted or offline-moved baseline is protected, never a remote delete',()=>{
 const state=trackDelete({},'Works/en/work-1.md');
 assert.equal(state['en/work-1'].state,'missing');
 assert.equal(checkCanonicalPull({articleId:'work-1',locale:'en',hasBaseline:true,canonicalExists:false,records:state}).code,'local_work_missing');
 assert.equal(checkCanonicalPull({articleId:'work-1',locale:'en',hasBaseline:true,canonicalExists:false}).allowed,false,'an event may have occurred while the app was closed');
 assert.equal(checkCanonicalPull({articleId:'work-1',locale:'en',hasBaseline:false,canonicalExists:false}).allowed,true,'initial downloads still work');
});
test('reject unsafe paths and ambiguous existing identity claims',()=>{
 for(const path of ['../outside.md','/outside.md','Works/../outside.md','Works\\file.md'])assert.throws(()=>trackRename({},'Works/work-1.md',path));
 const state=trackRename({},'Works/work-1.md','Archive/note.md');
 assert.throws(()=>trackRename(state,'Works/work-1.md','Archive/duplicate.md'),{code:'identity_conflict'});
 assert.deepEqual(trackRename({},'Notes/unrelated.md','Notes/other.md'),{});
});
test('guard prevents the actual pull from duplicating a renamed note',async()=>{
 const works=new Map([['test-one',detail('test-one')]]),center=stubCenter(works),vault=memoryVault(),store=memoryStore();
 let records={};const engine=new SyncEngine({client:center.client,vault,store,yaml,pathRecords:()=>records});await engine.pull('site');
 const canonical='Works/test-one.md',moved='Archive/renamed.md';await vault.write(moved,(await vault.read(canonical)).replace('Body','Local edit'));vault.files.delete(canonical);
 records=trackRename({},canonical,moved);const result=await engine.pull('site');
 assert.deepEqual(result.conflicts,['test-one']);assert.equal(await vault.read(canonical),null);assert.match(await vault.read(moved),/Local edit/);
});
test('a copied old path cannot be saved while its linked note is moved',async()=>{
 const works=new Map([['test-one',detail('test-one')]]),center=stubCenter(works),vault=memoryVault(),store=memoryStore();let records={};
 const engine=new SyncEngine({client:center.client,vault,store,yaml,pathRecords:()=>records});const get=center.client.work;center.client.work=async(...args)=>({...await get(...args),preservesEditorialFieldsOnSave:true});
 await engine.pull('site');records=trackRename({},'Works/test-one.md','Archive/moved.md');await vault.write('Works/test-one.md',(await vault.read('Works/test-one.md')).replace('Body','Changed copy'));
 await assert.rejects(engine.hasLocalChanges('site','Works/test-one.md'),{code:'local_work_moved'});
 await assert.rejects(engine.save('site','Works/test-one.md'),{code:'local_work_moved'});assert.equal(center.calls.filter(c=>c[0]==='saveDraft').length,0);
});
