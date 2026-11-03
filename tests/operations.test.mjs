import test from 'node:test';
import assert from 'node:assert/strict';
import {OperationGate,automationRequest,recordedOperation} from '../src/operations.mjs';

test('all vault entrypoints share a gate, which releases after failure',async()=>{
 const gate=new OperationGate();let release;
 const pending=gate.run('save',()=>new Promise(r=>release=r));
 await assert.rejects(gate.run('pull',()=>assert.fail()),e=>e.code==='operation_busy');
 release('saved');assert.equal(await pending,'saved');
 await assert.rejects(gate.run('login',()=>{throw Error('declined');}),/declined/);
 assert.equal(await gate.run('status',()=>42),42);
});
test('protocol save paths and request ids cannot escape the vault',()=>{
 for(const path of ['../a','Works/../a.md','Works/x/../../a.md','Works/x.md/../b'])assert.throws(()=>automationRequest({do:'save',path}));
 assert.throws(()=>automationRequest({do:'status',requestId:'../x'}));
 assert.equal(automationRequest({do:'save',path:'Works/en/work-1.md'}).path,'Works/en/work-1.md');
 assert.throws(()=>automationRequest({do:'save',path:'Works/en/../../other.md'}));
 assert.equal(automationRequest({do:'save',path:'Works/work-1.md',requestId:'test-1'}).id,'test-1');
});
test('repeated command IDs return the original receipt, including interrupted operations',async()=>{
 const records=new Map();let sent=0;
 const args={request:{id:'one',action:'save',path:'Works/a.md'},read:async id=>records.get(id),write:async r=>records.set(r.id,structuredClone(r)),execute:async()=>{sent++;return {revision:2};}};
 assert.equal((await recordedOperation(args)).result.revision,2);
 await recordedOperation(args);assert.equal(sent,1);
 await assert.rejects(recordedOperation({...args,request:{...args.request,path:'Works/b.md'}}),/different operation/);
 records.set('one',{...args.request,state:'running'});assert.equal((await recordedOperation(args)).state,'running');assert.equal(sent,1);
});
test('failure receipts retain the actual login code and HTTP status',async()=>{
 const records=new Map();
 const r=await recordedOperation({request:{id:'login',action:'login',path:''},read:async()=>null,write:async r=>records.set(r.id,structuredClone(r)),execute:async()=>{throw Object.assign(Error('Access denied'),{code:'access_denied',status:403});}});
 assert.equal(r.ok,false);assert.equal(r.code,'access_denied');assert.equal(records.get('login').status,403);
});

test('a command receipt cannot be reused after its Center or space changes',async()=>{
 const original={id:'scope',action:'pull',path:'',origin:'https://one.example',workspaceId:'metho',state:'completed'};
 for(const changed of [{origin:'https://two.example'},{workspaceId:'personal'}])await assert.rejects(recordedOperation({request:{...original,...changed},read:async()=>original,write:async()=>assert.fail(),execute:async()=>assert.fail()}),/different operation/);
});

test('a partially downloaded catalog is not reported as a successful command',async()=>{
 const records=new Map();
 const request={id:'pull-partial',action:'pull',path:'',origin:'https://center.example.org',workspaceId:'metho'};
 const record=await recordedOperation({request,read:async id=>records.get(id),write:async value=>records.set(value.id,{...value}),execute:async()=>({downloaded:['a'],failed:[{articleId:'b',code:'network_error'}]})});
 assert.equal(record.state,'partial');assert.equal(record.ok,false);assert.equal(record.result.failed[0].articleId,'b');
});

test('pull receipts report conflicts and unresolved saves as partial',async()=>{
 for(const key of ['conflicts','pending','metadataPending']){
  const request={id:'case-'+key,action:'pull',path:'',origin:'https://center.example.org',workspaceId:'metho'};
  const record=await recordedOperation({request,read:async()=>null,write:async()=>{},execute:async()=>({[key]:['a'],failed:[]})});
  assert.equal(record.state,'partial');assert.equal(record.ok,false);
 }
});
