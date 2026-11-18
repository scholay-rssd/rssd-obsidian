import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {updateFromCenter,rollback,verifyRelease,signedText,readRelease,compareVersions,decide,releasePath,newerVersion,diskVersion} from '../src/self-update.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Signed the way the release command signs: Node's crypto with IEEE P1363 output.
function keyPair(){
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
 return {publicKey:publicKey.export({type:'spki',format:'der'}).toString('base64'),privateKey};
}
function release(keys,{version='0.2.1',minAppVersion='1.11.4',code='module.exports=class{};',manifestVersion=version}={}){
 const main=Buffer.from(code),manifest=Buffer.from(JSON.stringify({id:'rssd',name:'RSSD',version:manifestVersion,minAppVersion}));
 const value={format:1,id:'rssd',version,minAppVersion,commit:'c'.repeat(40),coreCommit:'d'.repeat(40),publishedAt:'2026-11-19T00:00:00.000Z',
  files:[{name:'manifest.json',sha256:hash(manifest),size:manifest.length},{name:'main.js',sha256:hash(main),size:main.length}]};
 value.signature=sign('sha256',Buffer.from(signedText(value)),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
 return {value,blobs:{[hash(main)]:main,[hash(manifest)]:manifest}};
}
function center(published,{status=200}={}){
 return async({url})=>{
  const base=releasePath('https://center.test');
  if(url===base+'/latest')return published?{status,json:published.value}:{status:404};
  const bytes=published?.blobs[url.slice((base+'/files/').length)];
  return bytes?{status:200,arrayBuffer:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length)}:{status:404};
 };
}
// An in-memory vault adapter. Like Obsidian's, rename refuses an existing target; `desktop` adds the file
// system rename that replaces in one step. `failWrite` makes a write fail part-way, as a full disk does.
function adapter(files={},{desktop=false,failWrite=null}={}){
 const store=new Map(Object.entries(files).map(([k,v])=>[k,Buffer.from(v)])),renames=[];
 const value={store,renames,
  exists:async path=>store.has(path)||[...store.keys()].some(k=>k.startsWith(path+'/')),
  mkdir:async()=>{},
  read:async path=>{if(!store.has(path))throw Error('ENOENT');return store.get(path).toString('utf8');},
  readBinary:async path=>{const b=store.get(path);return b.buffer.slice(b.byteOffset,b.byteOffset+b.length);},
  writeBinary:async(path,data)=>{const b=Buffer.from(new Uint8Array(data));if(failWrite?.(path)){store.set(path,b.subarray(0,3));throw Error('ENOSPC');}store.set(path,b);},
  remove:async path=>{store.delete(path);},
  rename:async(from,to)=>{if(store.has(to))throw Error('Destination file already exists!');store.set(to,store.get(from));store.delete(from);renames.push('adapter');}};
 if(desktop){value.getFullPath=p=>'/vault/'+p;value.fsPromises={rename:async(from,to)=>{const a=from.slice(7),b=to.slice(7);store.set(b,store.get(a));store.delete(a);renames.push('fs');}};}
 return value;
}
const DIR='.obsidian/plugins/rssd';
const installed=(version='0.2.0',options)=>adapter({[DIR+'/main.js']:'old code',[DIR+'/manifest.json']:JSON.stringify({id:'rssd',version,minAppVersion:'1.11.4'})},options);
const run=(keys,published,vault,extra={})=>updateFromCenter({origin:'https://center.test/',http:center(published),adapter:vault,dir:DIR,running:'0.2.0',appVersion:'1.11.4',publicKey:keys.publicKey,...extra});
const text=(vault,path)=>vault.store.get(path)?.toString();

test('versions compare numerically and an invalid version counts as the oldest',()=>{
 assert.equal(compareVersions('0.2.10','0.2.9'),1);assert.equal(compareVersions('0.10.0','0.9.9'),1);
 assert.equal(compareVersions('0.2.1','0.2.1'),0);assert.equal(compareVersions('dev','0.0.1'),-1);
 assert.equal(newerVersion('0.2.3',null),'0.2.3');assert.equal(newerVersion('0.2.3','0.2.10'),'0.2.10');
});
test('a signature from the release command verifies with the code vaults run, and nothing else does',async()=>{
 const keys=keyPair(),other=keyPair(),{value}=release(keys);
 assert.equal(await verifyRelease(value,keys.publicKey),true);
 assert.equal(await verifyRelease(value,other.publicKey),false);
 for(const changed of [{version:'0.2.2'},{coreCommit:'e'.repeat(40)},{files:value.files.map(f=>f.name==='main.js'?{...f,sha256:'0'.repeat(64)}:f)}])
  assert.equal(await verifyRelease({...value,...changed},keys.publicKey),false);
 assert.equal(await verifyRelease(value,null),false);
 assert.equal(readRelease({...value,format:2}),null);assert.equal(readRelease({...value,coreCommit:undefined}),null);
});
for(const desktop of [true,false])test('a newer signed release is staged, checked and swapped in, keeping the running files ('+(desktop?'desktop':'mobile')+')',async()=>{
 const keys=keyPair(),published=release(keys,{code:'new code'}),vault=installed('0.2.0',{desktop});
 assert.deepEqual(await run(keys,published,vault),{state:'installed',version:'0.2.1'});
 assert.equal(text(vault,DIR+'/main.js'),'new code');assert.equal(await diskVersion(vault,DIR),'0.2.1');
 assert.equal(text(vault,DIR+'/previous/main.js'),'old code');
 assert.ok(vault.renames.length===2&&vault.renames.every(kind=>kind===(desktop?'fs':'adapter')));
 assert.deepEqual(await rollback({adapter:vault,dir:DIR}),{version:'0.2.0',replaced:'0.2.1'});
 assert.equal(text(vault,DIR+'/main.js'),'old code');
 await assert.rejects(rollback({adapter:vault,dir:DIR}),e=>e.code==='no_previous');
});
test('a second install before the reload keeps the copy of what runs',async()=>{
 const keys=keyPair(),vault=installed();
 await run(keys,release(keys,{version:'0.2.1',code:'first'}),vault);
 // Still running 0.2.0: a check before the reload installs 0.2.2 but leaves previous/ at 0.2.0.
 await run(keys,release(keys,{version:'0.2.2',code:'second'}),vault);
 assert.equal(text(vault,DIR+'/main.js'),'second');assert.equal(text(vault,DIR+'/previous/main.js'),'old code');
 assert.deepEqual(await rollback({adapter:vault,dir:DIR}),{version:'0.2.0',replaced:'0.2.2'});
});
test('a write that fails part-way changes nothing the plugin loads',async()=>{
 const keys=keyPair(),vault=installed('0.2.0',{failWrite:path=>path.endsWith('/update/main.js')});
 await assert.rejects(run(keys,release(keys,{code:'new code'}),vault),/ENOSPC/);
 assert.equal(text(vault,DIR+'/main.js'),'old code');assert.equal(await diskVersion(vault,DIR),'0.2.0');
});
test('nothing is installed when the release is not newer, was rolled back from, or needs a newer Obsidian',async()=>{
 const keys=keyPair();
 for(const [options,extra,state] of [[{version:'0.2.0'},{},'current'],[{version:'0.1.9'},{},'current'],[{},{skipped:'0.2.1'},'skipped'],[{minAppVersion:'1.12.0'},{},'app_too_old']]){
  const vault=installed();
  assert.equal((await run(keys,release(keys,options),vault,extra)).state,state);
  assert.equal(text(vault,DIR+'/main.js'),'old code');assert.equal(vault.store.has(DIR+'/previous/main.js'),false);
 }
 assert.equal(decide({release:{version:'0.2.2',minAppVersion:'1.11.4'},running:'0.2.0',appVersion:'1.11.4',skipped:'0.2.1'}),'install');
 assert.deepEqual(await run(keys,null,installed()),{state:'none'});
});
test('an unsigned, altered or mislabelled release is refused before anything is written',async()=>{
 const keys=keyPair(),other=keyPair();
 const check=async(published,code,{publicKey=keys.publicKey,status}={})=>{
  const vault=installed();
  await assert.rejects(updateFromCenter({origin:'https://center.test',http:center(published,{status}),adapter:vault,dir:DIR,running:'0.2.0',publicKey}),e=>e.code===code);
  assert.equal(text(vault,DIR+'/main.js'),'old code');assert.equal([...vault.store.keys()].length,2);
 };
 await check(release(other),'update_unsigned');
 await check(release(keys),'update_unsigned',{publicKey:null});
 const altered=release(keys,{code:'signed code'});for(const k of Object.keys(altered.blobs))if(altered.blobs[k].toString()==='signed code')altered.blobs[k]=Buffer.from('other code!');
 await check(altered,'update_mismatch');
 await check(release(keys,{manifestVersion:'9.9.9'}),'update_mismatch');
 await check({value:{...release(keys).value,files:[]}},'update_invalid');
 await check(release(keys),'update_unavailable',{status:503});
});
test('rollback needs an older kept version',async()=>{
 await assert.rejects(rollback({adapter:installed(),dir:DIR}),e=>e.code==='no_previous');
 const same=adapter({[DIR+'/main.js']:'a',[DIR+'/manifest.json']:JSON.stringify({id:'rssd',version:'0.2.1'}),[DIR+'/previous/main.js']:'b',[DIR+'/previous/manifest.json']:JSON.stringify({id:'rssd',version:'0.2.1'})});
 await assert.rejects(rollback({adapter:same,dir:DIR}),e=>e.code==='no_previous');
});
