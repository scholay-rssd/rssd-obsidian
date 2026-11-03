import test from 'node:test';
import assert from 'node:assert/strict';
import {centerOrigin,createCenterClient,centerRequest,CenterError} from '../src/center-client.mjs';
import {deviceLogin} from '../src/device-login.mjs';

const TOKEN='rssd_device_'+'a'.repeat(48);
const reply=(status,json)=>({status,json});

test('the Center address must be an HTTPS origin',()=>{
 assert.equal(centerOrigin('https://center.example.org/'),'https://center.example.org');
 assert.equal(centerOrigin('http://localhost:3000'),'http://localhost:3000');
 for(const bad of ['http://center.example.org','https://user:pw@center.example.org','https://center.example.org/app','https://center.example.org?x=1','nonsense',''])
  assert.throws(()=>centerOrigin(bad),bad);
});

test('requests carry the device token and keep the Center error code',async()=>{
 const seen=[];
 const http=async request=>{seen.push(request);
  if(request.url.endsWith('/identity'))return reply(200,{orgId:'o'});
  if(request.url.includes('/catalog'))return reply(200,{items:[],next:null});
  return reply(409,{message:'changed',code:'revision_conflict'});};
 const client=createCenterClient({http,origin:'https://center.example.org',token:TOKEN});
 assert.deepEqual(await client.identity(),{orgId:'o'});
 assert.equal(seen[0].headers.Authorization,'Bearer '+TOKEN);
 assert.equal(seen[0].url,'https://center.example.org/api/rssd/v1/identity');
 await assert.rejects(client.saveDraft('metho',{x:1}),error=>error instanceof CenterError&&error.status===409&&error.code==='revision_conflict');
 assert.equal(seen[1].url,'https://center.example.org/api/rssd/v1/editorial/metho/drafts');
 assert.equal(seen[1].method,'POST');
 assert.throws(()=>createCenterClient({http,origin:'https://center.example.org',token:'bad'}),/credential/);
 await client.catalog('metho',{limit:50});
 assert.match(seen[2].url,/\/editorial\/metho\/catalog\?scope=all&limit=50$/);
});

test('an unreachable Center does not claim that a write was rejected',async()=>{
 const http=async()=>{throw new Error('offline');};
 await assert.rejects(centerRequest(http,'https://center.example.org','/editorial/metho/drafts',{method:'POST',body:{}}),error=>error.code==='network_error'&&/may still have been accepted/.test(error.message));
});

test('GET retries bounded transport failures without changing the request',async()=>{
 const attempts=[],delays=[];
 const http=async request=>{attempts.push(request);if(attempts.length<2)throw Error('net::ERR_NETWORK_CHANGED');return reply(200,{items:['ok']});};
 const result=await centerRequest(http,'https://center.example.org','/editorial/metho/catalog?scope=all&after=100&generation=42',{
  token:TOKEN,sleep:async ms=>{delays.push(ms);}});
 assert.deepEqual(result,{items:['ok']});
 assert.deepEqual(delays,[5000]);
 assert.equal(attempts.length,2);
 assert.deepEqual(attempts[0],attempts[1]);
});

test('GET stops after bounded timeouts and does not retry server conflicts',async()=>{
 let attempts=0;
 await assert.rejects(centerRequest(()=>{attempts++;return new Promise(()=>{});},'https://center.example.org','/x',{
  timeoutMs:2,sleep:async()=>{}}),error=>error.code==='network_error'&&/timed out/.test(error.message));
 assert.equal(attempts,1);
 attempts=0;
 await assert.rejects(centerRequest(async()=>{attempts++;return reply(409,{message:'catalog changed',code:'catalog_changed'});},
  'https://center.example.org','/catalog',{sleep:async()=>{}}),error=>error.status===409&&error.code==='catalog_changed');
 assert.equal(attempts,1);
});

test('a non-cancellable timed-out batch is not duplicated, but settled transport failures can retry',async()=>{
 let attempts=0;
 await assert.rejects(centerRequest(()=>{attempts++;return new Promise(()=>{});},'https://center.example.org','/batch',{
  timeoutMs:2,sleep:async()=>{throw Error('must not retry timeout');}}),error=>error.code==='network_error'&&error.timedOut===true);
 assert.equal(attempts,1);
 attempts=0;
 assert.deepEqual(await centerRequest(async()=>{if(++attempts===1)throw Error('offline');return reply(200,{ok:true});},'https://center.example.org','/batch',{
  sleep:async()=>{}}),{ok:true});
 assert.equal(attempts,2);
});

test('a slow batch response is recovered during bounded grace without another request',async()=>{
 let attempts=0;
 const result=await centerRequest(()=>{attempts++;return new Promise(resolve=>setTimeout(()=>resolve(reply(200,{ok:true})),15));},'https://center.example.org','/batch',{
  timeoutMs:2,timeoutGraceMs:100,sleep:async()=>{throw Error('must not retry');}});
 assert.deepEqual(result,{ok:true});assert.equal(attempts,1);
});

test('a transport rejection during grace can be retried only after it settles',async()=>{
 let attempts=0;
 const result=await centerRequest(()=>{attempts++;if(attempts===1)return new Promise((_,reject)=>setTimeout(()=>reject(Error('offline')),15));return Promise.resolve(reply(200,{ok:true}));},'https://center.example.org','/batch',{
  timeoutMs:2,timeoutGraceMs:100,sleep:async()=>{}});
 assert.deepEqual(result,{ok:true});assert.equal(attempts,2);
});

test('HTTP errors received during grace are returned without retry',async()=>{
 let attempts=0;
 await assert.rejects(centerRequest(()=>{attempts++;return new Promise(resolve=>setTimeout(()=>resolve(reply(503,{code:'unavailable'})),15));},'https://center.example.org','/batch',{
  timeoutMs:2,timeoutGraceMs:100,sleep:async()=>{throw Error('must not retry HTTP');}}),e=>e.status===503&&e.code==='unavailable');
 assert.equal(attempts,1);
});

test('manual retry reuses an unresolved GET rather than duplicating it',async()=>{
 let attempts=0,finish;
 const http=()=>{attempts++;return new Promise(resolve=>{finish=resolve;});};
 await assert.rejects(centerRequest(http,'https://center.example.org','/batch',{timeoutMs:2,timeoutGraceMs:2}),e=>e.timedOut===true);
 const next=centerRequest(http,'https://center.example.org','/batch',{timeoutMs:100});
 finish(reply(200,{ok:true}));
 assert.deepEqual(await next,{ok:true});assert.equal(attempts,1);
});

test('batch details get a longer bounded timeout than ordinary requests',async()=>{
 const realSetTimeout=globalThis.setTimeout,windows=[];
 globalThis.setTimeout=(callback,ms,...args)=>{windows.push(ms);return realSetTimeout(callback,ms,...args);};
 try{
  const client=createCenterClient({origin:'https://center.example.org',token:TOKEN,http:async req=>reply(200,req.url.endsWith('/site')?{capabilities:['bounded-media-v1']}:{ok:true,items:[]})});
  await client.identity();await client.workBatch('metho',['one'],'zh-CN');
  assert.deepEqual(windows,[30000,30000,120000]);
 }finally{globalThis.setTimeout=realSetTimeout;}
});

test('uncertain POST failures are never retried',async()=>{
 let attempts=0;
 await assert.rejects(centerRequest(async()=>{attempts++;throw Error('offline');},'https://center.example.org','/drafts',{
  method:'POST',body:{},sleep:async()=>{throw Error('unexpected retry');}}),error=>error.code==='network_error');
 assert.equal(attempts,1);
});

test('device login shows the code, waits for approval and returns the token',async()=>{
 const origin='https://center.example.org',polls=[];let shown;
 const http=async request=>{
  if(request.url.endsWith('/auth/start'))return reply(200,{verificationUri:origin+'/rssd/device',verificationUriComplete:origin+'/rssd/device?code=AB12',userCode:'AB12',deviceCode:'dc',expiresIn:600,interval:5});
  polls.push(request.body);
  if(polls.length===1)return reply(400,{code:'authorization_pending',message:'wait'});
  if(polls.length===2)return reply(400,{code:'slow_down',message:'slower'});
  return reply(200,{token:TOKEN,identity:{workspaceIds:['metho']}});
 };
 const sleeps=[];
 const result=await deviceLogin({http,origin,name:'Obsidian',onCode:info=>{shown=info;},sleep:async ms=>{sleeps.push(ms);}});
 assert.equal(shown.userCode,'AB12');
 assert.equal(result.token,TOKEN);
 assert.deepEqual(sleeps,[5000,5000,10000],'slow_down widens the polling interval');
 assert.match(polls[0],/"grantType":"device_code"/);
});

test('device login rejects a foreign authorization address, expiry and cancellation',async()=>{
 const origin='https://center.example.org';
 const foreign=async()=>reply(200,{verificationUri:'https://evil.example/x',verificationUriComplete:'https://evil.example/x?code=1',userCode:'1',deviceCode:'d',expiresIn:600});
 await assert.rejects(deviceLogin({http:foreign,origin,name:'n',onCode(){}}),/does not match/);
 let now=0;
 const pending=async request=>request.url.endsWith('/auth/start')?reply(200,{verificationUri:origin+'/d',verificationUriComplete:origin+'/d?code=1',userCode:'1',deviceCode:'d',expiresIn:10,interval:5}):reply(400,{code:'authorization_pending'});
 await assert.rejects(deviceLogin({http:pending,origin,name:'n',onCode(){},now:()=>now,sleep:async ms=>{now+=ms;}}),error=>error.code==='expired_token');
 const controller=new AbortController();
 await assert.rejects(deviceLogin({http:pending,origin,name:'n',onCode(){},signal:controller.signal,sleep:async()=>controller.abort()}),error=>error.code==='cancelled');
});

test('a timeout of an uncertain POST retains the original-request recovery instruction',async()=>{
 await assert.rejects(centerRequest(()=>new Promise(()=>{}),'https://center.example.org','/editorial/metho/drafts',{method:'POST',timeoutMs:5}),e=>e.code==='network_error'&&/timed out/.test(e.message)&&/original request key/.test(e.message));
});

test('work detail requests the explicitly selected language',async()=>{
 const seen=[];const client=createCenterClient({origin:'https://center.example.org',token:TOKEN,http:async request=>{if(request.url.endsWith('/site'))return reply(200,{capabilities:['bounded-media-v1']});seen.push(request);return reply(200,{ok:true,boundedMediaReads:true});}});
 await client.work('metho','work-one','en');await client.work('metho','work-one','zh-CN');
 assert.match(seen[0].url,/\/editorial\/metho\/cloud\/work-one\?locale=en&media=referenced$/);
 assert.match(seen[1].url,/\/editorial\/metho\/cloud\/work-one\?locale=zh-CN&media=referenced$/);
});

test('batch detail requests include explicit locale and ordered encoded identities',async()=>{
 let seen;const http=async request=>{if(request.url.endsWith('/site'))return reply(200,{capabilities:['bounded-media-v1']});seen=request;return reply(200,{locale:'en',items:[]});};
 const client=createCenterClient({http,origin:'https://center.example.org',token:TOKEN});
 await client.workBatch('metho',['one','two'],'en');
 const url=new URL(seen.url);assert.equal(url.pathname,'/api/rssd/v1/editorial/metho/cloud/batch/read');
 assert.equal(url.searchParams.get('locale'),'en');assert.equal(url.searchParams.get('ids'),'one,two');assert.equal(url.searchParams.get('media'),'referenced');assert.equal(seen.method,'GET');
});
test('unbounded old Centers are rejected before requesting article data',async()=>{
 const calls=[],client=createCenterClient({origin:'https://center.example.org',token:TOKEN,http:async req=>{calls.push(req);return reply(200,{capabilities:[]});}});
 await assert.rejects(client.work('site','a','zh-CN'),{code:'bounded_media_unavailable'});assert.equal(calls.length,1);assert.match(calls[0].url,/\/site$/);
});
test('a Center must confirm each successful bounded media response',async()=>{
 const client=createCenterClient({origin:'https://center.example.org',token:TOKEN,http:async req=>reply(200,req.url.endsWith('/site')?{capabilities:['bounded-media-v1']}:{items:[{ok:true,detail:{}}]})});
 await assert.rejects(client.workBatch('site',['a'],'zh-CN'),{code:'bounded_media_unavailable'});
});
test('promotion lookup sends the exact overlay identity and device credential',async()=>{
 const calls=[],client=createCenterClient({http:async request=>{calls.push(request);return reply(200,{canonicalRevision:4});},origin:'https://center.example.org',token:TOKEN});
 assert.deepEqual(await client.stagedPromotion('site-id','article-one','en',3),{canonicalRevision:4});assert.equal(calls.length,1);assert.equal(calls[0].url,'https://center.example.org/api/rssd/v1/editorial/site-id/staged-drafts/promotions/article-one?locale=en&overlayRevision=3');assert.equal(calls[0].headers.Authorization,'Bearer '+TOKEN);assert.equal(calls[0].method,'GET');
});
