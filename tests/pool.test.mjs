import test from 'node:test';
import assert from 'node:assert/strict';
import {PoolSync,pullSummary} from '../src/pool-sync.mjs';
import {demandToNote,noteToTopic,topicChanges,topicOf,topicScope,sectionFolder,safeName,newTopicDemand,topicFingerprint} from '../src/pool-model.mjs';
import {createCenterClient} from '../src/center-client.mjs';
import {yaml,memoryVault} from './helpers.mjs';

const registry={workspaces:[
 {id:'pets',name:'萌宠',sections:[{id:'daily-cat',name:'每日一猫'},{id:'daily-dog',name:'每日一狗'}]},
 {id:'metho',name:'研究方法',sections:[{id:'methods',name:'方法百科'}]}]};
let clock=Date.parse('2026-11-19T00:00:00Z');
const tick=()=>new Date(clock+=1000).toISOString();
const demand=(id,title,extra={})=>({id,workspaceId:'pets',sectionId:'daily-cat',kind:'write',title,state:'queued',priority:0,generation:0,workerId:null,
 createdAt:tick(),updatedAt:tick(),...extra,payload:{brief:'写清识别特征与照护需求。',requiredLocales:['zh-CN','en'],...(extra.payload||{})}});
// A Center that holds demands and answers like the real one: filters, optimistic edits, refusals.
function center(rows=[]){
 const store=new Map(rows.map(row=>[row.id,row])),calls=[];
 const touch=row=>{row.updatedAt=tick();return row;};
 const client={calls,store,
  demands:async options=>{
   calls.push(['demands',options]);
   let list=[...store.values()].filter(row=>(!options.workspaceId||row.workspaceId===options.workspaceId)&&(!options.sectionId||row.sectionId===options.sectionId)&&(!options.search||row.title.includes(options.search)));
   if(options.states)list=list.filter(row=>options.states.split(',').includes(row.state));
   if(options.updatedSince)list=list.filter(row=>Date.parse(row.updatedAt)>Date.parse(options.updatedSince)).sort((a,b)=>Date.parse(a.updatedAt)-Date.parse(b.updatedAt));
   return list.slice(options.offset||0,(options.offset||0)+(options.limit||100)).map(row=>structuredClone(row));
  },
  createDemand:async body=>{
   calls.push(['createDemand',body]);
   if([...store.values()].some(row=>row.sectionId===body.sectionId&&row.state==='queued'&&row.title.split('：')[0]===body.title.split('：')[0]))throw Object.assign(Error('This topic repeats the open demand d1: same-subject'),{status:409,code:'topic_repeat'});
   const {workspaceId,sectionId,kind,title,priority=0,...payload}=body,row=demand('new-'+(store.size+1),title,{workspaceId,sectionId,priority,payload});
   store.set(row.id,row);return {...structuredClone(row),status:'created'};
  },
  editDemand:async(id,{baseGeneration,changes})=>{
   calls.push(['editDemand',id,changes]);const row=store.get(id);
   if(row.generation!==baseGeneration)throw Object.assign(Error('需求已变化'),{status:409,code:'revision_conflict'});
   if(row.state!=='queued')throw Object.assign(Error('认领后写作规则已冻结'),{status:409,code:'demand_frozen'});
   for(const [key,value] of Object.entries(changes)){
    if(key==='title'||key==='priority')row[key]=value;else if(value===null)delete row.payload[key];else row.payload[key]=value;
   }
   row.generation++;return structuredClone(touch(row));
  },
  changeDemand:async(id,{action})=>{calls.push(['changeDemand',id,action]);const row=store.get(id);if(row.workerId)throw Object.assign(Error('Claim no longer belongs to this device'),{status:409,code:'claim_revoked'});row.state='cancelled';return structuredClone(touch(row));},
 };
 return client;
}
function memoryIndex(){
 const entries=new Map(),cursors=new Map();
 return {entries,cursors,get:async id=>entries.get(id)??null,set:async(id,value)=>{entries.set(id,value);},delete:async id=>{entries.delete(id);},list:async()=>[...entries.values()],
  cursor:async space=>cursors.get(space)??null,setCursor:async(space,value)=>{cursors.set(space,value);}};
}
const setup=rows=>{const client=center(rows),vault=memoryVault(),index=memoryIndex();return {client,vault,index,pool:new PoolSync({client,vault,yaml,index})};};
const edit=async(vault,path,from,to)=>{const before=await vault.read(path);assert.ok(before.includes(from),'fixture text is present');await vault.write(path,before.replace(from,to));};

test('a demand round-trips between Center data and a note',()=>{
 const row=demand('d1','缅因猫：温柔的巨人',{priority:5,payload:{workType:'note',topicKey:'maine-coon',dueAt:'2026-12-01T00:00:00.000Z',lead:{provider:'tikhub',platformId:'douyin',term:'大猫',observedAt:'2026-11-19T00:00:00.000Z'}}});
 const content=demandToNote(row,yaml.stringify),note=noteToTopic(content,yaml.parse);
 assert.match(content,/^---\n[\s\S]*rssd-demand: d1[\s\S]*---\n写清识别特征与照护需求。\n$/);
 assert.match(content,/rssd-lead: douyin · 大猫/);
 assert.equal(note.id,'d1');assert.equal(note.workspaceId,'pets');assert.equal(note.sectionId,'daily-cat');assert.equal(note.state,'queued');assert.equal(note.generation,0);
 assert.deepEqual(note.topic,topicOf(row));
 assert.deepEqual(topicChanges(topicOf(row),note.topic),{});
 assert.equal(noteToTopic('# plain note',yaml.parse),null);
 assert.equal(noteToTopic('---\ntitle: 新题\n---\n简述',yaml.parse).id,null);
 assert.throws(()=>noteToTopic('---\ntitle: x\npriority: high\n---\n',yaml.parse),{code:'invalid_topic'});
 assert.throws(()=>noteToTopic('---\ntitle: x\ntype: video\n---\n',yaml.parse),{code:'invalid_topic'});
 assert.throws(()=>noteToTopic('---\ntitle: [x\n---\n',yaml.parse),{code:'invalid_properties'});
});
test('changes name only what was edited; a cleared field is sent as null',()=>{
 const base=topicOf(demand('d1','缅因猫',{payload:{workType:'note',topicKey:'k',dueAt:'2026-12-01T00:00:00.000Z'}}));
 assert.deepEqual(topicChanges(base,{...base,title:'缅因猫：新标题',priority:3}),{title:'缅因猫：新标题',priority:3});
 assert.deepEqual(topicChanges(base,{...base,workType:'',topicKey:'',dueAt:''}),{workType:null,topicKey:null,dueAt:null});
 assert.deepEqual(topicChanges(base,{...base,dueAt:'2026-12-01T08:00:00+08:00'}),{});
 assert.deepEqual(topicChanges(base,{...base,brief:'另一个简述'}),{brief:'另一个简述'});
});
test('a new note belongs to the section its folder or properties name, and to nothing by guesswork',()=>{
 assert.equal(sectionFolder(registry,'pets','daily-cat'),'Topics/萌宠/每日一猫');
 assert.equal(sectionFolder(registry,'gone','x'),'Topics/gone/x');
 assert.deepEqual(topicScope('Topics/萌宠/每日一猫/新题.md',{},registry),{workspaceId:'pets',sectionId:'daily-cat'});
 assert.deepEqual(topicScope('Topics/pets/daily-dog/sub/新题.md',{},registry),{workspaceId:'pets',sectionId:'daily-dog'});
 assert.deepEqual(topicScope('Inbox/新题.md',{'rssd-space':'metho','rssd-section':'方法百科'},registry),{workspaceId:'metho',sectionId:'methods'});
 for(const path of ['新题.md','Topics/新题.md','Topics/萌宠/新题.md','Topics/萌宠/没有这个栏目/新题.md','Topics/别的站/每日一猫/新题.md','Works/萌宠/每日一猫/新题.md'])assert.equal(topicScope(path,{},registry),null,path);
 assert.equal(safeName('  缅因猫：温柔/的*巨人?  '),'缅因猫：温柔 的 巨人');assert.equal(safeName('///'),'untitled');assert.equal(safeName('x'.repeat(200)).length,80);
 assert.deepEqual(newTopicDemand({title:'题',brief:'述',priority:2,workType:'note',topicKey:'',dueAt:''},{workspaceId:'pets',sectionId:'daily-cat'}),{workspaceId:'pets',sectionId:'daily-cat',kind:'write',title:'题',brief:'述',priority:2,workType:'note'});
 assert.throws(()=>newTopicDemand({title:'题',brief:'',priority:0,workType:'',topicKey:'',dueAt:''},{workspaceId:'pets',sectionId:'daily-cat'}),{code:'invalid_topic'});
});

test('the first update brings the open topics of every space; later updates only what changed',async()=>{
 const rows=[demand('d1','缅因猫：温柔的巨人'),demand('d2','布偶猫：性格与照护',{state:'claimed',workerId:'w1',generation:1}),demand('d3','早已写完的题',{state:'completed',payload:{workId:'work-3'}}),
  demand('d4','撤回的题',{state:'cancelled'}),demand('d5','回归分析入门',{workspaceId:'metho',sectionId:'methods'}),demand('t1','译稿',{kind:'translate'})];
 const {pool,vault,index,client}=setup(rows);
 const first=await pool.pull(registry);
 assert.deepEqual(first.added.sort(),['回归分析入门','布偶猫：性格与照护','缅因猫：温柔的巨人']);
 assert.deepEqual([...vault.files.keys()].sort(),['Topics/研究方法/方法百科/回归分析入门.md','Topics/萌宠/每日一猫/布偶猫：性格与照护.md','Topics/萌宠/每日一猫/缅因猫：温柔的巨人.md']);
 assert.deepEqual(client.calls.filter(c=>c[0]==='demands').map(c=>c[1].states),['queued,claimed,blocked','queued,claimed,blocked']);
 assert.equal((await index.get('d1')).base.brief,undefined,'the index keeps a digest of the brief, not the brief');
 // Nothing changed: the Center is asked for changes since the cursor and returns none.
 client.calls.length=0;const again=await pool.pull(registry);
 assert.equal(pullSummary(again),'up to date');assert.ok(client.calls.every(c=>c[1].updatedSince&&!c[1].states));
 // One topic is edited at the Center, one is completed, one is withdrawn, one new arrives.
 const d1=client.store.get('d1');d1.title='缅因猫：大而温柔';d1.generation++;d1.updatedAt=tick();
 const d2=client.store.get('d2');d2.state='completed';d2.payload.workId='work-2';d2.updatedAt=tick();
 const d5=client.store.get('d5');d5.state='cancelled';d5.updatedAt=tick();
 client.store.set('d6',demand('d6','暹罗猫：蓝眼与重点色'));
 const next=await pool.pull(registry);
 assert.deepEqual(next.updated.sort(),['布偶猫：性格与照护','缅因猫：大而温柔']);assert.deepEqual(next.removed,['回归分析入门']);assert.deepEqual(next.added,['暹罗猫：蓝眼与重点色']);
 // An updated note keeps its path; its properties follow the Center.
 const cat=noteToTopic(await vault.read('Topics/萌宠/每日一猫/缅因猫：温柔的巨人.md'),yaml.parse);assert.equal(cat.topic.title,'缅因猫：大而温柔');assert.equal(cat.generation,1);
 assert.match(await vault.read('Topics/萌宠/每日一猫/布偶猫：性格与照护.md'),/rssd-state: completed[\s\S]*rssd-work: work-2/);
 assert.equal(vault.files.has('Topics/研究方法/方法百科/回归分析入门.md'),false);assert.equal(await index.get('d5'),null);
 assert.equal(pullSummary(next),'1 new, 2 updated, 1 withdrawn');
});
test('an update never overwrites a note with unsaved edits, and says when both sides changed',async()=>{
 const {pool,vault,client}=setup([demand('d1','缅因猫：温柔的巨人'),demand('d2','布偶猫：性格与照护')]);
 await pool.pull(registry);
 const one='Topics/萌宠/每日一猫/缅因猫：温柔的巨人.md',two='Topics/萌宠/每日一猫/布偶猫：性格与照护.md';
 await edit(vault,one,'写清识别特征与照护需求。','我改过的简述。');await edit(vault,two,'title: 布偶猫：性格与照护','title: 布偶猫：我改的标题');
 assert.equal(await pool.edited(one),true);
 const d1=client.store.get('d1');d1.state='claimed';d1.workerId='w9';d1.generation++;d1.updatedAt=tick();
 const summary=await pool.pull(registry);
 assert.deepEqual(summary.conflicts,['缅因猫：温柔的巨人']);assert.deepEqual(summary.edited,['布偶猫：我改的标题']);assert.equal(summary.updated.length,0);
 assert.match(await vault.read(one),/我改过的简述。/);assert.match(await vault.read(one),/rssd-state: queued/,'the note still shows what it was in step with');
 // Saving the stale note is refused by the Center; restoring takes the Center's version.
 await assert.rejects(pool.save(one,registry),{code:'revision_conflict'});assert.match(await vault.read(one),/我改过的简述。/);
 const restored=await pool.restore(one,registry);assert.equal(restored.state,'restored');
 assert.match(await vault.read(one),/rssd-state: claimed[\s\S]*rssd-claimed-by: w9/);assert.match(await vault.read(one),/写清识别特征与照护需求。/);assert.equal(await pool.edited(one),false);
});
test('restoring finds the topic even after its title changed at the Center, and removes a withdrawn one',async()=>{
 const {pool,vault,client,index}=setup([demand('d1','缅因猫：温柔的巨人'),demand('d2','布偶猫：性格与照护')]);
 await pool.pull(registry);const one='Topics/萌宠/每日一猫/缅因猫：温柔的巨人.md',two='Topics/萌宠/每日一猫/布偶猫：性格与照护.md';
 await edit(vault,one,'写清识别特征与照护需求。','本地改的。');
 const d1=client.store.get('d1');d1.title='完全不同的新标题';d1.generation++;d1.updatedAt=tick();
 const restored=await pool.restore(one,registry);assert.equal(restored.state,'restored');assert.equal(restored.title,'完全不同的新标题');
 assert.match(await vault.read(one),/title: 完全不同的新标题[\s\S]*rssd-generation: 1[\s\S]*写清识别特征与照护需求。/);assert.equal((await index.get('d1')).generation,1);
 client.store.get('d2').state='cancelled';
 assert.equal((await pool.restore(two,registry)).state,'removed');assert.equal(vault.files.has(two),false);assert.equal(await index.get('d2'),null);
 client.store.delete('d1');await assert.rejects(pool.restore(one,registry),{code:'not_found'});
});
test('saving sends only the edited fields against the generation the note was in step with',async()=>{
 const {pool,vault,client,index}=setup([demand('d1','缅因猫：温柔的巨人',{payload:{topicKey:'maine'}})]);
 await pool.pull(registry);const path='Topics/萌宠/每日一猫/缅因猫：温柔的巨人.md';
 assert.equal((await pool.save(path,registry)).state,'unchanged');assert.equal(client.calls.filter(c=>c[0]==='editDemand').length,0);
 await edit(vault,path,'priority: 0','priority: 7');await edit(vault,path,'type: ""','type: note');await edit(vault,path,'topic-key: maine','topic-key: ""');
 const saved=await pool.save(path,registry);
 assert.equal(saved.state,'saved');assert.deepEqual(saved.changed.sort(),['priority','topicKey','workType']);
 assert.deepEqual(client.calls.find(c=>c[0]==='editDemand')[2],{priority:7,workType:'note',topicKey:null});
 const row=client.store.get('d1');assert.equal(row.priority,7);assert.equal(row.payload.workType,'note');assert.equal('topicKey' in row.payload,false);assert.equal(row.generation,1);
 assert.equal((await index.get('d1')).generation,1);assert.equal(await pool.edited(path),false);assert.match(await vault.read(path),/rssd-generation: 1/);
 // Someone else edits the topic at the Center: the next save is refused and the note is kept as written.
 row.title='缅因猫：别人改的';row.generation++;row.updatedAt=tick();
 await edit(vault,path,'写清识别特征与照护需求。','我的新简述。');const before=await vault.read(path);
 await assert.rejects(pool.save(path,registry),{code:'revision_conflict'});assert.equal(await vault.read(path),before);
 // A note the Center has never seen, and a note without properties, say what is missing.
 await vault.write('Topics/萌宠/每日一猫/陌生.md','---\ntitle: 陌生\nrssd-demand: nope\n---\n述');await assert.rejects(pool.save('Topics/萌宠/每日一猫/陌生.md',registry),{code:'not_indexed'});
 await vault.write('Topics/萌宠/每日一猫/白纸.md','只有正文');await assert.rejects(pool.save('Topics/萌宠/每日一猫/白纸.md',registry),{code:'invalid_topic'});
});
test('a new note in a section folder is queued; a repeat and a note outside a section are refused as written',async()=>{
 const {pool,vault,client,index}=setup([demand('d1','缅因猫：温柔的巨人')]);
 await pool.pull(registry);
 const path='Topics/萌宠/每日一狗/柯基：短腿与大耳.md',content='---\ntitle: 柯基：短腿与大耳\npriority: 2\ntype: note\ndue: 2026-12-24\n---\n写清体型、性格与运动需求。\n';
 await vault.write(path,content);
 const created=await pool.save(path,registry);assert.equal(created.state,'created');
 const sent=client.calls.find(c=>c[0]==='createDemand')[1];
 assert.deepEqual(sent,{workspaceId:'pets',sectionId:'daily-dog',kind:'write',title:'柯基：短腿与大耳',brief:'写清体型、性格与运动需求。',priority:2,workType:'note'});
 const row=client.store.get(created.id);assert.equal(row.payload.dueAt,'2026-12-24T00:00:00.000Z');
 const note=noteToTopic(await vault.read(path),yaml.parse);assert.equal(note.id,created.id);assert.equal(note.state,'queued');assert.equal(note.topic.dueAt,'2026-12-24T00:00:00.000Z');
 assert.equal((await index.get(created.id)).path,path);assert.equal((await pool.save(path,registry)).state,'unchanged');
 // The next update does not duplicate it.
 const summary=await pool.pull(registry);assert.equal(summary.added.length,0);assert.equal([...vault.files.keys()].filter(p=>p.includes('柯基')).length,1);
 const repeat='Topics/萌宠/每日一猫/缅因猫：再写一次.md',body='---\ntitle: 缅因猫：再写一次\n---\n简述。\n';
 await vault.write(repeat,body);await assert.rejects(pool.save(repeat,registry),{code:'topic_repeat'});assert.equal(await vault.read(repeat),body);
 await vault.write('随手记/想法.md',body);await assert.rejects(pool.save('随手记/想法.md',registry),{code:'no_section'});
 await vault.write('Topics/萌宠/每日一猫/没简述.md','---\ntitle: 没简述\n---\n');await assert.rejects(pool.save('Topics/萌宠/每日一猫/没简述.md',registry),{code:'invalid_topic'});
});
test('withdrawing cancels the demand and removes the note; a moved note is still the same topic',async()=>{
 const {pool,vault,client,index}=setup([demand('d1','缅因猫：温柔的巨人'),demand('d2','布偶猫：性格与照护',{state:'claimed',workerId:'w1'})]);
 await pool.pull(registry);
 const path='Topics/萌宠/每日一猫/缅因猫：温柔的巨人.md';
 assert.equal((await pool.withdraw(path)).state,'withdrawn');assert.equal(client.store.get('d1').state,'cancelled');assert.equal(vault.files.has(path),false);assert.equal(await index.get('d1'),null);
 const held='Topics/萌宠/每日一猫/布偶猫：性格与照护.md';
 await assert.rejects(pool.withdraw(held),{code:'claim_revoked'});assert.ok(vault.files.has(held));
 // The user files the note elsewhere: the index entry points at the old path, so the update places it again
 // rather than losing track; the moved copy can be deleted by hand.
 const moved='归档/布偶猫.md';await vault.write(moved,await vault.read(held));await vault.remove(held);
 const d2=client.store.get('d2');d2.state='completed';d2.updatedAt=tick();
 const summary=await pool.pull(registry);assert.equal(summary.failed.length,0);assert.equal(await index.get('d2'),null,'a finished topic whose note is gone is forgotten, not recreated');
 await vault.write('x.md','# nothing');await assert.rejects(pool.withdraw('x.md'),{code:'invalid_topic'});
});
test('a failed space is reported and the others still update; the cursor waits for a clean run',async()=>{
 const {pool,vault,client,index}=setup([demand('d1','缅因猫：温柔的巨人'),demand('d5','回归分析入门',{workspaceId:'metho',sectionId:'methods'})]);
 const list=client.demands;client.demands=async options=>{if(options.workspaceId==='pets')throw Error('Center is unreachable');return list(options);};
 const summary=await pool.pull(registry);
 assert.deepEqual(summary.failed,[{workspaceId:'pets',reason:'Center is unreachable'}]);assert.deepEqual(summary.added,['回归分析入门']);
 assert.equal(await index.cursor('pets'),null);assert.ok(await index.cursor('metho'));
 client.demands=list;assert.deepEqual((await pool.pull(registry)).added,['缅因猫：温柔的巨人']);
});
test('the Center client reaches the demand endpoints the pool uses',async()=>{
 const requests=[],http=async request=>{requests.push(request);return {status:200,json:[]};};
 const client=createCenterClient({http,origin:'https://center.example.org',token:'rssd_device_'+'a'.repeat(48)});
 await client.demands({workspaceId:'pets',states:'queued,claimed',updatedSince:'2026-11-19T00:00:00.000Z',limit:200,offset:0,sectionId:undefined});
 await client.editDemand('d 1',{baseGeneration:0,requestId:'r',changes:{priority:1}});await client.changeDemand('d1',{action:'cancel'});
 assert.equal(requests[0].url,'https://center.example.org/api/rssd/v1/demands?workspaceId=pets&states=queued%2Cclaimed&updatedSince=2026-11-19T00%3A00%3A00.000Z&limit=200&offset=0');
 assert.deepEqual([requests[1].method,requests[1].url],['PATCH','https://center.example.org/api/rssd/v1/demands/d%201/definition']);
 assert.deepEqual([requests[2].method,requests[2].url,requests[2].body],['PATCH','https://center.example.org/api/rssd/v1/demands/d1','{"action":"cancel"}']);
});

test('a works vault and a pool vault are never turned into each other in place; the index lives in settings',async()=>{
 const {isPoolVault,canBecomePool,canBecomeWorks,poolIndex,poolFailure,POOL_DEFAULTS}=await import('../src/pool-plugin.mjs');
 assert.equal(POOL_DEFAULTS.mode,'works');assert.equal(isPoolVault({}),false);assert.equal(isPoolVault({mode:'pool'}),true);
 assert.equal(canBecomePool({}),true);assert.equal(canBecomePool({workspaceId:'pets'}),false);assert.equal(canBecomePool({boundSpace:'pets'}),false);
 assert.equal(canBecomeWorks({mode:'pool'}),true);assert.equal(canBecomeWorks({pool:{entries:{d1:{}}}}),false);
 const settings={},index=poolIndex(()=>settings);
 assert.equal(await index.get('d1'),null);assert.equal(await index.cursor('pets'),null);
 await index.set('d1',{id:'d1',path:'Topics/a.md'});await index.setCursor('pets','2026-11-19T00:00:00.000Z');
 assert.deepEqual(settings.pool,{entries:{d1:{id:'d1',path:'Topics/a.md'}},cursors:{pets:'2026-11-19T00:00:00.000Z'}});
 assert.deepEqual(await index.list(),[{id:'d1',path:'Topics/a.md'}]);await index.delete('d1');assert.deepEqual(await index.list(),[]);
 assert.match(poolFailure(Object.assign(Error('This topic repeats the work w1'),{code:'topic_repeat'})),/^The Center already has this topic: This topic repeats the work w1$/);
 assert.match(poolFailure(Error('boom')),/could not do that: boom/);
});
test('a topic that was claimed can no longer be saved from the note',async()=>{
 const {pool,vault}=setup([demand('d2','布偶猫：性格与照护',{state:'claimed',workerId:'w1',generation:1})]);
 await pool.pull(registry);const path='Topics/萌宠/每日一猫/布偶猫：性格与照护.md';
 await edit(vault,path,'priority: 0','priority: 9');
 await assert.rejects(pool.save(path,registry),{code:'read_only'});assert.match(await vault.read(path),/priority: 9/);
});
