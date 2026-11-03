import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {OperationGate} from '../src/operations.mjs';
import {yaml} from './helpers.mjs';
const result=await build({entryPoints:['src/main.js'],bundle:true,format:'cjs',platform:'browser',external:['obsidian'],write:false});
let response,modal;
const mock={Plugin:class{},PluginSettingTab:class{},ItemView:class{},TFile:class{},Setting:class{},Notice:class{},Platform:{isMobile:false},
 Modal:class{constructor(){modal=this;}open(){}close(){this.closed=true;this.onCancel?.();}},requestUrl:async req=>response(req),parseYaml:yaml.parse,stringifyYaml:yaml.stringify};
const module={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(()=>mock,module,module.exports);
const Plugin=module.exports.default;
function plugin(){
 const p=new Plugin();p.operations=new OperationGate();p.settings={origin:'https://center.example.org',boundOrigin:'https://center.example.org',workspaceId:'metho'};
 let secret='rssd_device_'+'a'.repeat(48);p.app={secretStorage:{getSecret:()=>secret,setSecret:(_k,v)=>secret=v}};p.saveSettings=async()=>{};p.records=[];p.writeRun=async r=>p.records.push(r);return p;
}
const start={status:200,json:{verificationUriComplete:'https://center.example.org/device',userCode:'ABCD',deviceCode:'secret',expiresIn:0}};
test('failed login preserves the original error even when an old token exists',async()=>{
 response=async()=>({status:403,json:{code:'access_denied',message:'Not authorized'}});
 const p=plugin();await assert.rejects(p.login(),e=>e.code==='access_denied'&&e.status===403);
 assert.ok(p.token());assert.equal(p.operations.active,null);assert.equal(p.records.at(-1).code,'access_denied');
});
test('expired login closes its modal and clears its cancellation controller',async()=>{
 response=async()=>start;const p=plugin();await assert.rejects(p.login(),e=>e.code==='expired_token');
 assert.equal(modal.closed,true);assert.equal(modal.onCancel,null);assert.equal(p.loginController,null);
});
test('changing the Center or space refuses use of an existing credential before HTTP',()=>{
 const p=plugin();p.settings.origin='https://another.example.org';assert.throws(()=>p.client(),/different Center/);
 p.settings.origin=p.settings.boundOrigin;p.settings.boundSpace='personal';assert.throws(()=>p.client(),/bound to personal/);
});
test('mobile cannot save a private draft',async()=>{
 const p=plugin();mock.Platform.isMobile=true;
 try{await assert.rejects(p.assertWritable(),/read-only on mobile/);}finally{mock.Platform.isMobile=false;}
});
test('a failed interactive pull retains its failed work and partial progress without a token',async()=>{
 const p=plugin();p.setStatus=()=>{};
 p.client=()=>({registry:async()=>({workspaces:[{id:'metho',writable:true,migrationState:'active'}]})});
 p.engine=()=>({store:{list:async()=>[]},pull:async(_space,{onProgress})=>{
  await onProgress({articleId:'one',summary:{downloaded:[]}});
  throw Object.assign(new Error('offline rssd_device_'+'b'.repeat(48)),{code:'network_error',articleId:'two',pullSummary:{downloaded:['one']}});
 }});
 await p.pull();
 assert.equal(p.records[0].state,'running');
 assert.equal(p.records.at(-1).state,'failed');
 assert.equal(p.records.at(-1).articleId,'two');
 assert.deepEqual(p.records.at(-1).partial,{downloaded:['one']});
 assert.doesNotMatch(JSON.stringify(p.records),/rssd_device_/);
 assert.equal(p.operations.active,null);
});
test('an interactive pull records its final result after its progress',async()=>{
 const p=plugin();p.setStatus=()=>{};
 p.client=()=>({registry:async()=>({workspaces:[{id:'metho',writable:true,migrationState:'active'}]})});
 const result={downloaded:['one'],updated:[],unchanged:0,skipped:[],conflicts:[],removedFromCenter:[]};
 p.engine=()=>({store:{list:async()=>[]},pull:async(_space,{onProgress,locale})=>{await onProgress({articleId:'one',summary:{downloaded:[]}});return locale==='zh-CN'?result:{...result,downloaded:['two']};}});
 await p.pull();
 assert.equal(p.records.at(-1).state,'completed');assert.equal(p.records.at(-1).ok,true);
 assert.deepEqual(p.records.at(-1).result.downloaded,['one','en/two']);
});

test('save routes active and staged spaces to separate write handlers',async()=>{
 const p=plugin();let canonical=0;
 const engine={save:async()=>{canonical++;return {state:'saved'};},noteFingerprint:async()=>null};
 p.client=()=>({registry:async()=>({workspaces:[{id:'metho',writable:true,migrationState:'active'},{id:'personal',writable:false,migrationState:'staged'}]})});
 assert.equal((await p.saveWork('metho','Works/one.md',engine)).state,'saved');assert.equal(canonical,1);
 await assert.rejects(p.saveWork('personal','Works/one.md',engine),/not an RSSD work/);assert.equal(canonical,1,'staged writes never use the canonical handler');
 await assert.rejects(p.saveWork('unknown','Works/one.md',engine),{code:'forbidden'});
});

test('a staged pull reconciles both languages through the private branch',async()=>{
 const p=plugin(),seen=[];p.settings.workspaceId='personal';
 p.client=()=>({registry:async()=>({workspaces:[{id:'personal',writable:false,migrationState:'staged'}]})});
 p.engine=()=>({client:{stagedSite:async()=>({capabilities:['staged-drafts-v1']}),stagedList:async(_space,locale)=>{seen.push(locale);return {items:[],generation:1,next:null};}},store:{list:async()=>[]},pull:async()=>({downloaded:[],updated:[],skipped:[],conflicts:[],pending:[],failed:[],metadataPending:[],removedFromCenter:[],unchanged:0})});
 const result=await p.pullAll('personal');assert.deepEqual(seen,['zh-CN','en']);assert.deepEqual(result.conflicts,[]);
});

test('moving a linked note blocks recreation until the returned identity is verified',async()=>{
 const p=plugin();p.settings.baselines={metho:{'one':{articleId:'one'}}};p.settings.pathRecords={};let marked='',unblocked='';
 p.autoSync={mark:path=>marked=path,unblock:path=>unblocked=path};
 p.app.vault={adapter:{read:async()=>"---\nrssd-id: one\nrssd-locale: zh-CN\n---\nBody"}};
 await p.recordPathChange('rename','Works/one.md','Archive/one.md');
 assert.equal(p.settings.pathRecords['zh-CN/one'].state,'moved');
 await p.recordPathChange('rename','Archive/one.md','Works/one.md');
 assert.deepEqual(p.settings.pathRecords,{});assert.equal(marked,'Works/one.md');assert.equal(unblocked,marked);
});
test('concurrent settings writes preserve pending saves and path guards in order',async()=>{
 const p=plugin();let release;const writes=[];p.saveSettings=Plugin.prototype.saveSettings.bind(p);
 p.saveData=async snapshot=>{writes.push(snapshot);if(writes.length===1)await new Promise(resolve=>release=resolve);};
 p.settings.baselines={metho:{one:{pending:{requestKey:'keep-original'}}}};const a=p.saveSettings();await new Promise(resolve=>setImmediate(resolve));
 p.settings.pathRecords={'zh-CN/one':{state:'moved'}};const b=p.saveSettings();release();await Promise.all([a,b]);
 assert.equal(writes.length,2);assert.equal(writes[1].baselines.metho.one.pending.requestKey,'keep-original');assert.equal(writes[1].pathRecords['zh-CN/one'].state,'moved');
});

test('interactive spaces checks persist a fresh scoped receipt',async()=>{
 const p=plugin();p.client=()=>({registry:async()=>({workspaces:[{id:'metho',writable:true,migrationState:'active'}]})});
 await p.showSpaces();const r=p.records.at(-1);
 assert.equal(r.action,'spaces');assert.equal(r.workspaceId,'metho');assert.equal(r.origin,'https://center.example.org');assert.equal(r.path,'');
 assert.equal(r.state,'completed');assert.equal(r.ok,true);assert.deepEqual(r.result,[{id:'metho',writable:true,migrationState:'active'}]);
});
test('failed interactive spaces checks preserve the failure in a receipt',async()=>{
 const p=plugin();p.client=()=>({registry:async()=>{throw Object.assign(Error('offline'),{code:'network_error'});}});
 await p.showSpaces();assert.equal(p.records.at(-1).state,'failed');assert.equal(p.records.at(-1).code,'network_error');
});
