import test from 'node:test';
import assert from 'node:assert/strict';
import {SyncEngine} from '../src/sync-engine.mjs';
import {StagedSyncEngine} from '../src/staged-sync-engine.mjs';
import {workToNote,noteToWork,workFingerprint,syncFingerprint,workFieldChanges,normalizeTags,sourceId,sourceLink,localMediaPaths,mediaHash} from '../src/sync-model.mjs';
import {sectionWorkPolicy} from '../../contracts/work-types.mjs';
import {yaml,memoryVault,memoryStore,stubCenter,detail,png} from './helpers.mjs';

const both=sectionWorkPolicy({workTypes:['article','note']}),articlesOnly=sectionWorkPolicy({});
const edit=async(vault,path,from,to)=>{const before=await vault.read(path);assert.ok(before.includes(from),'expected '+from);await vault.write(path,before.replace(from,to));};
// A Center that also creates works (a draft for an unknown ID at version 0) and says whether it keeps work types.
function setup({capable=true,policy=both,works:extra={}}={}){
 const works=new Map(Object.entries({'a-one':detail('a-one'),...extra})),center=stubCenter(works),vault=memoryVault(),store=memoryStore();
 const get=center.client.work,save=center.client.saveDraft;
 center.client.work=async(...args)=>({...await get(...args),preservesEditorialFieldsOnSave:true});
 center.client.workTypes=async()=>{center.calls.push(['site']);return capable;};
 center.client.idAvailable=async(_w,id)=>{center.calls.push(['idAvailable',id]);return !works.has(id);};
 center.client.saveDraft=async(w,envelope)=>{
  if(works.has(envelope.data.id)||envelope.expectedVersion!==0)return save(w,envelope);
  center.calls.push(['saveDraft',envelope]);
  if(center.state.failNext){const e=center.state.failNext;center.state.failNext=null;throw e;}
  const {assets,...data}=envelope.data;
  works.set(data.id,{id:data.id,articleId:data.id,version:1,revision:1,publishedVersion:null,data:{...data,assets}});
  const receipt={articleId:data.id,requestKey:envelope.requestKey,revision:1};center.state.drafts.set(envelope.requestKey,receipt);return receipt;
 };
 return {works,center,vault,store,engine:new SyncEngine({client:center.client,vault,store,yaml,sectionPolicy:()=>policy})};
}
const sent=center=>center.calls.filter(call=>call[0]==='saveDraft').map(call=>call[1]);

test('a work type, source link and tags round-trip between Center data and a note, next to the identity properties',()=>{
 const d=detail('b-note');Object.assign(d.data,{workType:'note',adaptedFrom:{articleId:'a-one',revision:3},tags:['猫','养护 指南']});
 const note=workToNote(d,yaml.stringify);
 assert.match(note.content,/rssd-type: note/);
 assert.match(note.content,/rssd-adapted-from: "\[\[Works\/a-one\]\]"/);
 assert.match(note.content,/rssd-adapted-revision: 3/);
 assert.match(note.content,/rssd-tags:\n {2}- 猫\n {2}- 养护 指南/);
 const work=noteToWork(note.content,yaml.parse);
 assert.equal(work.data.workType,'note');
 assert.deepEqual(work.data.adaptedFrom,{articleId:'a-one',revision:3});
 assert.deepEqual(work.data.tags,['猫','养护 指南']);
 // A work without them writes none, and its note states none.
 const plain=noteToWork(workToNote(detail('a-one'),yaml.stringify).content,yaml.parse);
 for(const key of ['workType','adaptedFrom','tags'])assert.equal(key in plain.data,false);
});

test('a note without work fields keeps the fingerprint it always had; stating one changes it',async()=>{
 const plain=noteToWork(workToNote(detail('a-one'),yaml.stringify).content,yaml.parse),media=localMediaPaths(plain.media);
 assert.equal(await syncFingerprint(plain.data,media),await workFingerprint(plain.data,media));
 const typed={...plain.data,workType:'article'},tagged={...plain.data,tags:[]};
 assert.notEqual(await syncFingerprint(typed,media),await workFingerprint(plain.data,media));
 assert.notEqual(await syncFingerprint(tagged,media),await syncFingerprint(typed,media));
 // Outputs (card and article packages) describe the content only.
 assert.equal(await workFingerprint(typed,media),await workFingerprint(plain.data,media));
});

test('tags are read the way a writer types them, and a source link in any of its spellings',()=>{
 assert.deepEqual(normalizeTags([' #猫 ','猫','','##狗',2026,null]),['猫','狗','2026']);
 assert.deepEqual(normalizeTags(null),[]);assert.deepEqual(normalizeTags('单个'),['单个']);
 assert.equal(sourceLink('a-one'),'[[Works/a-one]]');
 for(const spelling of ['[[Works/a-one]]','[[Works/a-one.md]]','[[Works/a-one|文章]]','[[a-one]]','a-one',[['Works/a-one']]])assert.equal(sourceId(spelling),'a-one');
 const note=workToNote(detail('a-one'),yaml.stringify).content.replace('---\n','---\nrssd-tags:\nrssd-adapted-from: ""\n');
 const work=noteToWork(note,yaml.parse);
 assert.deepEqual(work.data.tags,[],'an emptied list of tags is stated, so it clears');
 assert.equal(work.data.adaptedFrom,null,'an emptied source link is stated, so it clears');
});

test('a save sends only the stated work fields that differ from the Center, checked against the section',()=>{
 const data={id:'b-note',workType:'note',adaptedFrom:{articleId:'a-one',revision:2},tags:['猫']};
 assert.deepEqual(workFieldChanges({data,current:{},capable:true,policy:both}),{workType:'note',adaptedFrom:{articleId:'a-one',revision:2},tags:['猫']});
 assert.deepEqual(workFieldChanges({data,current:{workType:'note',adaptedFrom:{revision:2,articleId:'a-one'},tags:['猫']},capable:true,policy:both}),{});
 assert.deepEqual(workFieldChanges({data:{id:'x',tags:[]},current:{tags:['猫']},capable:true}),{tags:[]},'an emptied list clears the tags');
 assert.deepEqual(workFieldChanges({data:{id:'x',adaptedFrom:null},current:{workType:'note',adaptedFrom:{articleId:'a-one',revision:1}},capable:true}),{adaptedFrom:null});
 assert.deepEqual(workFieldChanges({data:{id:'x',workType:'article',adaptedFrom:{articleId:'a-one',revision:1}},current:{workType:'note'},capable:true,policy:both}),{workType:'article'},'an article never sends a source link');
 assert.deepEqual(workFieldChanges({data:{id:'x'},current:{workType:'note',tags:['猫']},capable:true}),{},'omitted fields keep the stored values');
 assert.throws(()=>workFieldChanges({data:{id:'x',workType:'note'},capable:true,policy:articlesOnly}),{code:'invalid_work_type',message:/does not take notes/});
 assert.throws(()=>workFieldChanges({data:{id:'x',workType:'event'},capable:true}),{code:'invalid_work_type'});
 assert.throws(()=>workFieldChanges({data:{id:'x',tags:Array.from({length:11},(_,i)=>'t'+i)},capable:true}),{code:'invalid_work_fields'});
 assert.throws(()=>workFieldChanges({data:{id:'x',tags:['x'.repeat(41)]},capable:true}),{code:'invalid_work_fields'});
 assert.throws(()=>workFieldChanges({data:{id:'b-note',workType:'note',adaptedFrom:{articleId:'b-note',revision:1}},capable:true}),{code:'invalid_work_fields',message:/itself/});
 assert.throws(()=>workFieldChanges({data:{id:'x',workType:'note',adaptedFrom:{articleId:'a-one',revision:NaN}},capable:true}),{code:'invalid_work_fields'});
 // A type the section no longer takes but the work already has does not block other edits.
 assert.deepEqual(workFieldChanges({data:{id:'x',workType:'note',tags:['猫']},current:{workType:'note'},capable:true,policy:articlesOnly}),{tags:['猫']});
 assert.throws(()=>workFieldChanges({data:{id:'x',workType:'note'},kind:'history',capable:true}),{message:/record kind/});
});

test('a Center without work-types-v1 gets nothing new, and a note asking for a type, tags or a source is kept local',()=>{
 assert.deepEqual(workFieldChanges({data:{id:'x'},capable:false}),{});
 assert.deepEqual(workFieldChanges({data:{id:'x',workType:'article',tags:[]},capable:false}),{});
 for(const data of [{workType:'note'},{tags:['猫']},{workType:'note',adaptedFrom:{articleId:'a-one',revision:1}}])
  assert.throws(()=>workFieldChanges({data:{id:'x',...data},capable:false}),{code:'work_types_unavailable'});
 assert.throws(()=>workFieldChanges({data:{id:'x',workType:'note'},current:{workType:'article'},capable:true,staged:true}),{code:'staged_work_fields'});
 assert.deepEqual(workFieldChanges({data:{id:'x',workType:'note'},current:{workType:'note'},capable:true,staged:true}),{});
});

test('pull writes the Center\'s type and tags; a type change is saved as workType alone',async()=>{
 const {engine,vault,center,works}=setup();
 Object.assign(works.get('a-one').data,{workType:'article',tags:['猫']});
 await engine.pull('pets');
 const path='Works/a-one.md';
 assert.match(await vault.read(path),/rssd-type: article/);
 assert.equal((await engine.states('pets'))['a-one'],'synced');
 await edit(vault,path,'rssd-type: article','rssd-type: note');
 assert.equal((await engine.states('pets'))['a-one'],'local_changed','changing the type is an edit');
 const result=await engine.save('pets',path);
 assert.equal(result.state,'saved');
 const [envelope]=sent(center);
 assert.equal(envelope.data.workType,'note');
 assert.equal('tags' in envelope.data,false,'unchanged tags are not sent');
 assert.equal('adaptedFrom' in envelope.data,false);
 assert.equal((await engine.states('pets'))['a-one'],'synced');
});

test('tags edited or emptied in the note are sent, and an unchanged legacy note sends nothing new',async()=>{
 const {engine,vault,center,works}=setup();
 await engine.pull('pets');
 const path='Works/a-one.md';
 await edit(vault,path,'Body','Edited body');
 await engine.save('pets',path);
 let [envelope]=sent(center);
 for(const key of ['workType','adaptedFrom','tags'])assert.equal(key in envelope.data,false,'a note that states none sends none');
 await edit(vault,path,'rssd-kind: news','rssd-kind: news\nrssd-tags:\n  - "#猫"\n  - 狗');
 await engine.save('pets',path);
 envelope=sent(center)[1];
 assert.deepEqual(envelope.data.tags,['猫','狗']);
 works.get('a-one').data.tags=['猫','狗'];
 await edit(vault,path,'rssd-tags:\n  - "#猫"\n  - 狗','rssd-tags: []');
 await engine.save('pets',path);
 assert.deepEqual(sent(center)[2].data.tags,[],'an emptied list clears the tags');
});

test('a Center without work types refuses nothing it always took, but keeps a typed note local',async()=>{
 const {engine,vault,center}=setup({capable:false});
 await engine.pull('pets');
 const path='Works/a-one.md';
 await edit(vault,path,'Body','Edited body');
 assert.equal((await engine.save('pets',path)).state,'saved');
 for(const key of ['workType','adaptedFrom','tags'])assert.equal(key in sent(center)[0].data,false);
 await edit(vault,path,'rssd-kind: news','rssd-kind: news\nrssd-type: note');
 await assert.rejects(engine.save('pets',path),{code:'work_types_unavailable'});
 assert.equal(sent(center).length,1,'nothing was sent');
 assert.match(await vault.read(path),/rssd-type: note/,'the note keeps the edit');
});

test('a section that does not take notes refuses the note type before anything is sent',async()=>{
 const {engine,vault,center}=setup({policy:articlesOnly});
 await engine.pull('pets');
 await edit(vault,'Works/a-one.md','rssd-kind: news','rssd-kind: news\nrssd-type: note');
 await assert.rejects(engine.save('pets','Works/a-one.md'),{code:'invalid_work_type'});
 assert.equal(sent(center).length,0);
});

test('a staged draft sends back nothing new and refuses a changed type before saving',async()=>{
 const {engine,vault,works,store}=setup();
 Object.assign(works.get('a-one').data,{workType:'article',tags:['猫']});
 await engine.pull('pets');
 let calls=[];const hash='a'.repeat(64);
 const info={articleId:'a-one',workId:'work-one',locale:'zh-CN',baseRevision:1,baseHash:hash,basePublishedVersion:null,overlayRevision:0};
 const client={stagedSite:async()=>({capabilities:['staged-drafts-v1','work-types-v1']}),workTypes:async()=>true,
  stagedWork:async()=>({...info,baseState:'current',preservesEditorialFieldsOnSave:true,data:works.get('a-one').data}),
  saveStaged:async(_s,input)=>{calls.push(input);return {...info,overlayRevision:1,requestKey:input.requestKey,status:'draft_saved'};}};
 const stage=new StagedSyncEngine({engine:Object.assign(engine,{client:Object.assign(Object.create(engine.client),client)}),client});
 await edit(vault,'Works/a-one.md','rssd-type: article','rssd-type: note');
 await assert.rejects(stage.save('pets','Works/a-one.md'),{code:'staged_work_fields'});
 assert.equal(calls.length,0);assert.equal((await store.get('pets','a-one')).pending,undefined);
 await edit(vault,'Works/a-one.md','rssd-type: note','rssd-type: article');
 await edit(vault,'Works/a-one.md','Body','Staged body');
 assert.equal((await stage.save('pets','Works/a-one.md')).stagedRevision,1);
 for(const key of ['workType','adaptedFrom','tags'])assert.equal(key in calls[0].data,false,'the staged edition keeps its own values');
});

test('rewrite as note creates a linked note draft in the same section from the article\'s saved revision',async()=>{
 const {engine,vault,center,store,works}=setup();
 works.get('a-one').version=4;works.get('a-one').data.tags=['猫'];
 await engine.pull('pets');
 const result=await engine.rewriteAsNote('pets','Works/a-one.md',{date:'2026-11-19'});
 assert.deepEqual({state:result.state,path:result.path,articleId:result.articleId,revision:result.revision},{state:'created',path:'Works/a-one-note.md',articleId:'a-one-note',revision:1});
 const [envelope]=sent(center);
 assert.equal(envelope.expectedVersion,0);assert.equal(envelope.expectedPublishedVersion,null);
 assert.equal(envelope.data.workType,'note');
 assert.deepEqual(envelope.data.adaptedFrom,{articleId:'a-one',revision:4});
 assert.deepEqual(envelope.data.tags,['猫']);
 assert.equal(envelope.data.sectionId,'frontiers');assert.equal(envelope.data.date,'2026-11-19');
 assert.equal(envelope.data.title,'Title');assert.equal(envelope.data.author,'Ed');
 const imagePath='/article-media/'+await mediaHash(png)+'.png';
 assert.equal(envelope.data.markdown,'Summary\n\n![]('+imagePath+')\n','the summary and the article\'s pictures to start from');
 assert.equal(envelope.data.assets[0].path,imagePath);
 assert.equal(envelope.publish,undefined,'a new note is never published');
 const note=await vault.read('Works/a-one-note.md');
 assert.match(note,/rssd-type: note/);assert.match(note,/rssd-adapted-from: "\[\[Works\/a-one\]\]"/);assert.match(note,/rssd-adapted-revision: 4/);
 assert.match(note,/rssd-version: 1/,'the version label follows the saved revision');
 assert.equal((await store.get('pets','a-one-note')).version,1);
 assert.equal((await engine.states('pets'))['a-one-note'],'synced');
 assert.equal((await engine.states('pets'))['a-one'],'synced','the article is not touched');
 // A second rewrite takes the next free ID.
 assert.equal((await engine.rewriteAsNote('pets','Works/a-one.md')).articleId,'a-one-note-2');
});

test('rewrite as note is refused for edited, English or note works, sections without notes and older Centers',async()=>{
 let x=setup();await x.engine.pull('pets');
 await edit(x.vault,'Works/a-one.md','Body','Unsaved');
 await assert.rejects(x.engine.rewriteAsNote('pets','Works/a-one.md'),{code:'article_edited'});
 x=setup({policy:articlesOnly});await x.engine.pull('pets');
 await assert.rejects(x.engine.rewriteAsNote('pets','Works/a-one.md'),{code:'section_takes_no_notes'});
 x=setup({capable:false});await x.engine.pull('pets');
 await assert.rejects(x.engine.rewriteAsNote('pets','Works/a-one.md'),{code:'work_types_unavailable'});
 x=setup();x.works.get('a-one').data.workType='note';await x.engine.pull('pets');
 await assert.rejects(x.engine.rewriteAsNote('pets','Works/a-one.md'),{code:'not_article'});
 x=setup();const en=detail('a-one');en.data.locale='en';x.works.set('a-one',en);await x.engine.pull('pets',{locale:'en'});
 await assert.rejects(x.engine.rewriteAsNote('pets','Works/en/a-one.md'),{code:'not_chinese'});
 for(const y of [x])assert.equal(sent(y.center).length,0);
});

test('a refused creation leaves no note behind; a lost answer keeps its key and is recovered, never resent',async()=>{
 let x=setup();await x.engine.pull('pets');
 x.center.state.failNext=Object.assign(Error('refused'),{status:409,code:'identity_conflict'});
 await assert.rejects(x.engine.rewriteAsNote('pets','Works/a-one.md'),{code:'identity_conflict'});
 assert.equal(await x.vault.read('Works/a-one-note.md'),null);assert.equal(await x.store.get('pets','a-one-note'),null);
 x=setup();await x.engine.pull('pets');
 x.center.state.failNext=Object.assign(Error('lost'),{status:0,code:'network_error'});
 const original=x.center.client.saveDraft;
 // The Center commits the draft, then the answer is lost.
 x.center.client.saveDraft=async(w,envelope)=>{const failure=x.center.state.failNext;x.center.state.failNext=null;const receipt=await original(w,envelope);if(failure)throw failure;return receipt;};
 await assert.rejects(x.engine.rewriteAsNote('pets','Works/a-one.md'),{retained:true});
 const pending=await x.store.get('pets','a-one-note');assert.ok(pending.pending.requestKey);
 assert.equal((await x.engine.save('pets','Works/a-one-note.md')).state,'saved');
 assert.equal(sent(x.center).length,1,'recovered by its key, not sent again');
 assert.equal((await x.store.get('pets','a-one-note')).version,1);
});

test('the Type row offers only what the section takes, and says when the Center or section decides',async()=>{
 const {typeChoice,parseTagInput,tagProblems}=await import('../src/details.mjs');
 let choice=typeChoice({policy:both,capable:true});
 assert.equal(choice.value,'article');assert.equal(choice.editable,true);
 assert.deepEqual(choice.options.map(o=>o.value),['article','note']);assert.match(choice.options[0].label,/section default/);
 choice=typeChoice({stated:'note',policy:both,capable:true});
 assert.equal(choice.value,'note');assert.equal(choice.options.some(o=>/default/.test(o.label)),false);
 choice=typeChoice({policy:articlesOnly,capable:true});
 assert.equal(choice.editable,false);assert.deepEqual(choice.options.map(o=>o.value),['article']);assert.match(choice.hint,/articles only/);
 choice=typeChoice({policy:both,capable:false});
 assert.equal(choice.editable,false);assert.match(choice.hint,/does not keep work types/);
 choice=typeChoice({stated:'note',policy:articlesOnly,capable:true});
 assert.equal(choice.value,'note');assert.equal(choice.options.find(o=>o.value==='note').disabled,true,'a type the section no longer takes stays visible');
 choice=typeChoice({kind:'history',policy:both,capable:true});
 assert.equal(choice.value,'event');assert.equal(choice.editable,false);
 assert.deepEqual(parseTagInput(' #猫，狗、 养护指南 ,\n猫 '),['猫','狗','养护指南']);
 assert.deepEqual(parseTagInput(''),[]);
 assert.deepEqual(tagProblems(['a','b']),[]);
 assert.equal(tagProblems(Array.from({length:11},(_,i)=>'t'+i)).length,1);
 assert.match(tagProblems(['长'.repeat(41)])[0],/40 characters/);
});

test('a note gets no card set, and each language edition exports its own set from its own revision',async()=>{
 const {cardSetRefusal,packageCardPages}=await import('../src/cards.mjs');
 const {wechatSource}=await import('../src/wechat.mjs');
 assert.equal(cardSetRefusal('note').code,'note_has_no_cards');
 assert.equal(cardSetRefusal('article'),null);
 const {exportFolderName}=await import('../src/card-export.mjs');
 assert.equal(exportFolderName('a-one',()=>false,'zh-CN'),'a-one');
 assert.equal(exportFolderName('a-one',()=>false,'en'),'a-one (en)','the English set never replaces the Chinese one');
 const zh=detail('a-one',{version:5}),en=detail('a-one',{version:2,title:'English title'});en.data.locale='en';
 const blob={size:3,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer};
 const pack=async(d)=>(await packageCardPages({source:wechatSource(workToNote(d,yaml.stringify).content,yaml.parse),site:{id:'pets',name:'Pets'},style:'site',blobs:[blob],version:d.version,publishedVersion:null,engineVersion:'1'})).manifest;
 const zhManifest=await pack(zh),enManifest=await pack(en);
 assert.equal(zhManifest.locale,'zh-CN');assert.equal(zhManifest.source.version,5);
 assert.equal(enManifest.locale,'en');assert.equal(enManifest.source.version,2,'made from the English edition\'s own revision');
 assert.notEqual(enManifest.source.hash,zhManifest.source.hash);
});
