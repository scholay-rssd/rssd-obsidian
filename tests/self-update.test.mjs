import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {updateFromCenter,rollback,verifyRelease,signedText,readRelease,compareVersions,decide,releasePath} from '../src/self-update.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Signed the way the release command signs: Node's crypto with IEEE P1363 output.
function keyPair(){
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
 return {publicKey:publicKey.export({type:'spki',format:'der'}).toString('base64'),privateKey};
}
function release(keys,{version='0.2.1',minAppVersion='1.11.4',code='module.exports=class{};',manifestVersion=version}={}){
 const main=Buffer.from(code),manifest=Buffer.from(JSON.stringify({id:'rssd',name:'RSSD',version:manifestVersion,minAppVersion}));
 const value={format:1,id:'rssd',version,minAppVersion,commit:'c'.repeat(40),publishedAt:'2026-11-19T00:00:00.000Z',
  files:[{name:'manifest.json',sha256:hash(manifest),size:manifest.length},{name:'main.js',sha256:hash(main),size:main.length}]};
 value.signature=sign('sha256',Buffer.from(signedText(value)),{key:keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
 return {value,blobs:{[hash(main)]:main,[hash(manifest)]:manifest}};
}
function center(published,{status=200}={}){
 const calls=[];
 const http=async({url})=>{
  calls.push(url);const base=releasePath('https://center.test');
  if(url===base+'/latest')return published?{status,json:published.value}:{status:404};
  const name=url.slice((base+'/files/').length),bytes=published?.blobs[name];
  return bytes?{status:200,arrayBuffer:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length)}:{status:404};
 };
 return {http,calls};
}
function adapter(files={}){
 const store=new Map(Object.entries(files).map(([k,v])=>[k,Buffer.from(v)]));
 return {store,
  exists:async path=>store.has(path)||[...store.keys()].some(k=>k.startsWith(path+'/')),
  mkdir:async()=>{},
  read:async path=>store.get(path).toString('utf8'),
  readBinary:async path=>{const b=store.get(path);return b.buffer.slice(b.byteOffset,b.byteOffset+b.length);},
  writeBinary:async(path,data)=>{store.set(path,Buffer.from(new Uint8Array(data)));}};
}
const DIR='.obsidian/plugins/rssd';
const installed=()=>adapter({[DIR+'/main.js']:'old code',[DIR+'/manifest.json']:JSON.stringify({id:'rssd',version:'0.2.0',minAppVersion:'1.11.4'})});
const run=(keys,published,vault,extra={})=>updateFromCenter({origin:'https://center.test/',http:center(published).http,adapter:vault,dir:DIR,current:'0.2.0',appVersion:'1.11.4',publicKey:keys.publicKey,...extra});

test('versions compare numerically and an invalid version counts as the oldest',()=>{
 assert.equal(compareVersions('0.2.10','0.2.9'),1);assert.equal(compareVersions('0.10.0','0.9.9'),1);
 assert.equal(compareVersions('0.2.1','0.2.1'),0);assert.equal(compareVersions('dev','0.0.1'),-1);
});
test('a signature from the release command verifies with the code vaults run, and nothing else does',async()=>{
 const keys=keyPair(),other=keyPair(),{value}=release(keys);
 assert.equal(await verifyRelease(value,keys.publicKey),true);
 assert.equal(await verifyRelease(value,other.publicKey),false);
 assert.equal(await verifyRelease({...value,version:'0.2.2'},keys.publicKey),false);
 assert.equal(await verifyRelease({...value,files:value.files.map(f=>f.name==='main.js'?{...f,sha256:'0'.repeat(64)}:f)},keys.publicKey),false);
 assert.equal(await verifyRelease(value,null),false);
 assert.equal(readRelease({...value,format:2}),null);
});
test('a newer signed release is installed and the running files are kept for rollback',async()=>{
 const keys=keyPair(),published=release(keys,{code:'new code'}),vault=installed();
 assert.deepEqual(await run(keys,published,vault),{state:'installed',version:'0.2.1'});
 assert.equal(vault.store.get(DIR+'/main.js').toString(),'new code');
 assert.equal(JSON.parse(vault.store.get(DIR+'/manifest.json')).version,'0.2.1');
 assert.equal(vault.store.get(DIR+'/previous/main.js').toString(),'old code');
 assert.deepEqual(await rollback({adapter:vault,dir:DIR}),{version:'0.2.0'});
 assert.equal(vault.store.get(DIR+'/main.js').toString(),'old code');
});
test('nothing is installed when the release is not newer, was rolled back from, or needs a newer Obsidian',async()=>{
 const keys=keyPair();
 for(const [options,extra,state] of [[{version:'0.2.0'},{},'current'],[{version:'0.1.9'},{},'current'],[{},{skipped:'0.2.1'},'skipped'],[{minAppVersion:'1.12.0'},{},'app_too_old']]){
  const vault=installed();
  assert.equal((await run(keys,release(keys,options),vault,extra)).state,state);
  assert.equal(vault.store.get(DIR+'/main.js').toString(),'old code');assert.equal(vault.store.has(DIR+'/previous/main.js'),false);
 }
 assert.equal(decide({release:{version:'0.2.2',minAppVersion:'1.11.4'},current:'0.2.0',appVersion:'1.11.4',skipped:'0.2.1'}),'install');
 assert.deepEqual(await run(keys,null,installed()),{state:'none'});
});
test('an unsigned, altered or mislabelled release is refused before anything is written',async()=>{
 const keys=keyPair(),other=keyPair();
 const check=async(published,code,{publicKey=keys.publicKey}={})=>{
  const vault=installed();
  await assert.rejects(run({publicKey},published,vault),e=>e.code===code);
  assert.equal(vault.store.get(DIR+'/main.js').toString(),'old code');assert.equal(vault.store.has(DIR+'/previous/main.js'),false);
 };
 await check(release(other),'update_unsigned');
 await check(release(keys),'update_unsigned',{publicKey:null});
 const altered=release(keys,{code:'signed code'});for(const k of Object.keys(altered.blobs))if(altered.blobs[k].toString()==='signed code')altered.blobs[k]=Buffer.from('other code!');
 await check(altered,'update_mismatch');
 await check(release(keys,{manifestVersion:'9.9.9'}),'update_mismatch');
 await check({value:{...release(keys).value,files:[]}},'update_invalid');
 const vault=installed();
 await assert.rejects(updateFromCenter({origin:'https://center.test',http:center(release(keys),{status:503}).http,adapter:vault,dir:DIR,current:'0.2.0',publicKey:keys.publicKey}),e=>e.code==='update_unavailable');
});
test('rollback needs a kept previous version',async()=>{
 await assert.rejects(rollback({adapter:installed(),dir:DIR}),e=>e.code==='no_previous');
});
