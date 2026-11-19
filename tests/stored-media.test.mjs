import test from 'node:test';
import assert from 'node:assert/strict';
import {SyncEngine} from '../src/sync-engine.mjs';
import {mediaHash,packWorkMedia} from '../src/sync-model.mjs';
import {yaml,memoryVault,memoryStore,stubCenter,b64} from './helpers.mjs';

// A PNG of about `size` bytes; `fill` makes each one different.
const bigPng=(size,fill)=>{const bytes=new Uint8Array(size).fill(fill);bytes.set([137,80,78,71,13,10,26,10]);return bytes;};
const asset=async bytes=>({path:'/article-media/'+await mediaHash(bytes)+'.png',data:b64(bytes)});

// A work whose two stored pictures add up to more than 2 MiB, like the pets work that could never be saved.
async function setup({reuses=true}={}){
 const one=bigPng(1300000,1),two=bigPng(1300000,2),assets=[await asset(one),await asset(two)];
 const data={id:'large-pictures',title:'Title',summary:'Summary',markdown:'Body\n\n![](' +assets[0].path+')\n\n![]('+assets[1].path+')\n',date:'2026-11-03',author:'Ed',category:'News',sectionId:'pets',assets};
 const works=new Map([['large-pictures',{id:data.id,articleId:data.id,version:1,revision:1,publishedVersion:null,data}]]);
 const center=stubCenter(works),vault=memoryVault(),store=memoryStore(),get=center.client.work;
 center.client.work=async(...args)=>({...await get(...args),preservesEditorialFieldsOnSave:true,...(reuses?{reusesStoredMediaOnSave:true}:{})});
 // Like the Center, keep the bytes of a picture that was named by path alone.
 const save=center.client.saveDraft;
 center.client.saveDraft=async(w,envelope)=>{const before=works.get(envelope.data.id).data.assets,receipt=await save(w,envelope),after=works.get(envelope.data.id);
  after.data={...after.data,assets:after.data.assets.map(a=>a.data?a:before.find(b=>b.path===a.path))};return receipt;};
 const engine=new SyncEngine({client:center.client,vault,store,yaml});
 await engine.pull('pets');
 return {engine,vault,center,works,assets};
}
const edit=async vault=>vault.write('Works/large-pictures.md',(await vault.read('Works/large-pictures.md')).replace('Body','Edited body'));
const saves=center=>center.calls.filter(c=>c[0]==='saveDraft');

test('a text edit to a work with large stored pictures sends the pictures by path, not their bytes',async()=>{
 const {engine,vault,center,works,assets}=await setup();
 await edit(vault);
 const result=await engine.save('pets','Works/large-pictures.md');
 assert.equal(result.state,'saved');
 const [[,envelope]]=saves(center);
 const byPath=(a,b)=>a.path.localeCompare(b.path);
 assert.deepEqual([...envelope.data.assets].sort(byPath),assets.map(a=>({path:a.path})).sort(byPath));
 assert.match(envelope.data.markdown,/^Edited body/);
 assert.equal(works.get('large-pictures').version,2);
 assert.deepEqual(Object.values(await engine.states('pets')),['synced']);
});

test('a new picture is sent with its bytes next to stored ones, and only new bytes count toward 2 MiB',async()=>{
 const {engine,vault,center}=await setup();
 const fresh=bigPng(900000,3),path=(await asset(fresh)).path;
 await vault.writeBinary('article-media/'+path.slice(15),fresh);
 await vault.write('Works/large-pictures.md',(await vault.read('Works/large-pictures.md'))+'\n![](../article-media/'+path.slice(15)+')\n');
 await engine.save('pets','Works/large-pictures.md');
 const [[,envelope]]=saves(center);
 assert.deepEqual(envelope.data.assets.filter(a=>a.data).map(a=>a.path),[path]);
 assert.equal(envelope.data.assets.length,3);
});

test('a Center that cannot keep stored pictures gets no request, and the refusal names the pictures',async()=>{
 const {engine,vault,center}=await setup({reuses:false});
 await edit(vault);
 await assert.rejects(engine.save('pets','Works/large-pictures.md'),error=>{
  assert.equal(error.code,'media_too_large');
  assert.match(error.message,/2\.5 MB.*\.png 1\.2 MB.*update the Center/);
  return true;
 });
 assert.equal(saves(center).length,0);
});

test('new pictures over 2 MiB are refused even when the Center keeps stored ones',async()=>{
 const work={data:{markdown:'![](/article-media/x.png)'},media:['x.png']},bytes=bigPng(2200000,4);
 await assert.rejects(packWorkMedia(work,{'x.png':bytes},{stored:new Set(['/article-media/other.png'])}),{code:'media_too_large',message:/Make them smaller\./});
 const packed=await packWorkMedia(work,{'x.png':bytes},{stored:new Set([(await asset(bytes)).path])});
 assert.deepEqual(packed.assets,[{path:(await asset(bytes)).path}]);
});

test('local refusals carry codes, so automatic sync reports them once',async()=>{
 const work=(media,markdown='')=>({data:{markdown},media});
 await assert.rejects(packWorkMedia(work(Array.from({length:13},(_,i)=>i+'.png')),{}),{code:'too_many_media'});
 await assert.rejects(packWorkMedia(work(['gone.png']),{}),{code:'media_missing'});
 await assert.rejects(packWorkMedia(work(['x.gif']),{'x.gif':new Uint8Array([71,73,70,56])}),{code:'unsupported_media'});
});
