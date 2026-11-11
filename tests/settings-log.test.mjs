import test from 'node:test';
import assert from 'node:assert/strict';
import {SettingsLog,applyEntry,replay,baselineBucket} from '../src/settings-log.mjs';

// A settings file and a journal that survive a "restart": open() builds a fresh log over what was written.
function disk(){
 const d={data:null,journal:null,saves:0,appends:0,failAppend:false,failRemove:false};
 d.open=(options={})=>{
  const settings=d.data?structuredClone(d.data):{baselines:{}};
  const log=new SettingsLog({settings:()=>settings,saveData:async snapshot=>{d.saves++;d.data=snapshot;},files:{
   read:async()=>d.journal,
   append:async text=>{if(d.failAppend)throw Error('append unavailable');d.appends++;d.journal=(d.journal??'')+text;},
   remove:async()=>{if(d.failRemove)throw Error('locked');d.journal=null;},
  },...options});
  return {settings,log};
 };
 return d;
}
const set=(id,value,locale)=>({op:'set',space:'metho',id,value,...(locale?{locale}:{})});

test('a baseline change is durable without rewriting the settings file',async()=>{
 const d=disk();let {log}=d.open();
 await log.record(set('one',{articleId:'one',version:1,pending:{requestKey:'keep'}}));
 await log.record(set('two',{articleId:'two',version:4},'en'));
 await log.record({op:'delete',space:'metho',id:'two',locale:'en'});
 await log.record(set('one',{articleId:'one',version:2}));
 assert.equal(d.saves,0);assert.equal(d.appends,4);assert.equal(log.pending,true);
 // The session ends here without a checkpoint.
 const next=d.open();assert.equal(await next.log.load(),4);
 assert.deepEqual(next.settings.baselines,{metho:{one:{articleId:'one',version:2}}});
 assert.deepEqual(next.settings.baselinesByLocale,{metho:{en:{}}});assert.equal(next.settings.boundSpace,'metho');
 await next.log.checkpoint();
 assert.equal(d.journal,null);assert.equal(next.log.pending,false);assert.deepEqual(d.data.baselines.metho.one,{articleId:'one',version:2});
});
test('a pending request key recorded before a crash is restored on load',async()=>{
 const d=disk();d.data={baselines:{metho:{one:{articleId:'one',version:1}}}};const {log}=d.open();
 await log.record(set('one',{articleId:'one',version:1,pending:{requestKey:'obsidian-abc',fingerprint:'f'}}));
 const next=d.open();await next.log.load();
 assert.equal(next.settings.baselines.metho.one.pending.requestKey,'obsidian-abc');
});
test('the journal is folded into the settings file at its limit',async()=>{
 const d=disk(),{log}=d.open({limit:3});
 for(const id of ['a','b','c','d'])await log.record(set(id,{articleId:id,version:1}));
 assert.equal(d.saves,1);assert.deepEqual(Object.keys(d.data.baselines.metho),['a','b','c']);
 assert.equal(d.journal.trim().split('\n').length,1);assert.equal(JSON.parse(d.journal.trim()).id,'d');
});
test('where appending fails, every change still rewrites the settings file',async()=>{
 const d=disk();d.failAppend=true;const {log}=d.open();
 await log.record(set('one',{articleId:'one',version:1}));
 assert.equal(d.saves,1);assert.equal(d.data.baselines.metho.one.version,1);assert.equal(log.pending,false);
});
test('a journal that could not be removed is replayed harmlessly over its checkpoint',async()=>{
 const d=disk(),{log}=d.open();
 await log.record(set('one',{articleId:'one',version:1}));await log.record(set('one',{articleId:'one',version:2}));
 d.failRemove=true;await log.checkpoint();assert.equal(log.pending,true);assert.notEqual(d.journal,null);
 d.failRemove=false;await log.record(set('one',{articleId:'one',version:3}));
 const next=d.open();await next.log.load();assert.equal(next.settings.baselines.metho.one.version,3);
 await next.log.checkpoint();assert.equal(d.journal,null);
});
test('a line cut short by a crash and invalid entries are skipped',()=>{
 const settings={baselines:{}};
 const text='\n'+JSON.stringify(set('one',{version:1}))+'\n\n{"op":"set","space":"metho","id":"tw'+'\n'+JSON.stringify(set('__proto__',{polluted:true}))+'\n'+
  JSON.stringify({op:'set',space:'metho',id:'three',value:'text'})+'\n'+JSON.stringify(set('four',{version:4}))+'\n';
 assert.equal(replay(settings,text),2);assert.deepEqual(Object.keys(settings.baselines.metho),['one','four']);assert.equal({}.polluted,undefined);
 assert.equal(applyEntry(settings,{op:'rename',space:'metho',id:'one'}),false);
 assert.equal(baselineBucket(settings,'missing'),undefined);
});
test('an invalid change is refused before anything is written',async()=>{
 const d=disk(),{log,settings}=d.open();
 await assert.rejects(log.record({op:'set',space:'',id:'one',value:{}}),e=>e.code==='invalid_baseline');
 assert.equal(d.appends,0);assert.deepEqual(settings.baselines,{});
});
test('a full write queued behind a journal append includes that change and later ones',async()=>{
 const d=disk(),{log,settings}=d.open();
 const a=log.record(set('one',{articleId:'one',version:1}));settings.pathRecords={'zh-CN/one':{state:'moved'}};const b=log.checkpoint();
 await Promise.all([a,b]);
 assert.equal(d.data.baselines.metho.one.version,1);assert.equal(d.data.pathRecords['zh-CN/one'].state,'moved');assert.equal(d.journal,null);
});
