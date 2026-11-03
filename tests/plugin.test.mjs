import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {OperationGate} from '../src/operations.mjs';
const result=await build({entryPoints:['src/main.js'],bundle:true,format:'cjs',platform:'browser',external:['obsidian'],write:false});
let response,modal;
const mock={Plugin:class{},PluginSettingTab:class{},ItemView:class{},TFile:class{},Setting:class{},Notice:class{},Platform:{isMobile:false},
 Modal:class{constructor(){modal=this;}open(){}close(){this.closed=true;this.onCancel?.();}},requestUrl:async req=>response(req)};
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
 p.engine=()=>({pull:async(_space,{onProgress})=>{
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
 const result={downloaded:['one'],updated:[],unchanged:0,skipped:[],conflicts:[],removedFromCenter:[]};
 p.engine=()=>({pull:async(_space,{onProgress})=>{await onProgress({articleId:'one',summary:{downloaded:[]}});return result;}});
 await p.pull();
 assert.equal(p.records.at(-1).state,'completed');assert.equal(p.records.at(-1).ok,true);
 assert.deepEqual(p.records.at(-1).result,result);
});
