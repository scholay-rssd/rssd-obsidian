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

test('an unreachable Center says nothing was changed',async()=>{
 const http=async()=>{throw new Error('offline');};
 await assert.rejects(centerRequest(http,'https://center.example.org','/identity'),error=>error.code==='network_error'&&/nothing was changed/.test(error.message));
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
