// Center API client for the Obsidian plugin. `http` is injected (Obsidian's requestUrl at runtime, a stub in
// tests) so this module has no Obsidian or Node dependency and also runs on mobile.
export class CenterError extends Error {
 constructor(message,{status=0,code='network_error'}={}){super(message);this.status=status;this.code=code;}
}
const TOKEN=/^rssd_device_[A-Za-z0-9_-]{48}$/;
// requestUrl cannot cancel a request after our deadline. Keep unresolved GETs
// by transport and authenticated URL so a new pull cannot duplicate one.
const inFlightReads=new WeakMap();

function readRequest(http,key,request){
 let active=inFlightReads.get(http);
 if(!active){active=new Map();inFlightReads.set(http,active);}
 if(active.has(key))return active.get(key);
 const pending=Promise.resolve().then(()=>http(request));
 active.set(key,pending);
 pending.then(()=>{if(active.get(key)===pending)active.delete(key);},()=>{if(active.get(key)===pending)active.delete(key);});
 return pending;
}

async function waitForRequest(pending,timeoutMs){
 let timer;
 try{return await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Request timed out'),{timedOut:true})),timeoutMs);})]);}
 finally{clearTimeout(timer);}
}

/** Accept only an HTTPS origin (or localhost for development), never a path, query or credentials. */
export function centerOrigin(value){
 let url;try{url=new URL(String(value||'').trim());}catch{throw Error('Enter the Center address, e.g. https://center.example.org');}
 if(url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw Error('The Center address must be an origin without a path');
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('Center connections require HTTPS');
 return url.origin;
}

/** Retry only transport failures on GET. Never replay writes or HTTP error responses. */
export async function centerRequest(http,origin,path,{method='GET',body,token,timeoutMs=30000,timeoutGraceMs=0,retryDelaysMs=[5000],sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
 let response,lastError;
 const delays=method==='GET'?retryDelaysMs:[];
 for(let attempt=0;attempt<=delays.length;attempt++){
  try{
   const request={url:origin+'/api/rssd/v1'+path,method,throw:false,contentType:'application/json',
    headers:{Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})};
   const pending=method==='GET'?readRequest(http,(token||'')+'\0'+request.url,request):Promise.resolve().then(()=>http(request));
   try{response=await waitForRequest(pending,timeoutMs);}
   catch(error){
    // Continue waiting for the original batch, not another request. A response
    // received during the grace window is processed exactly like an on-time one.
    if(!error?.timedOut||method!=='GET'||timeoutGraceMs<=0)throw error;
    response=await waitForRequest(pending,timeoutGraceMs);
   }
   break;
  }catch(error){lastError=error;}
  // A deadline does not cancel the original request, so it must never trigger
  // a second request. Explicitly rejected transport failures have settled and
  // may be retried within the bounded attempt limit.
  if(lastError?.timedOut)break;
  if(attempt<delays.length)await sleep(delays[attempt]);
 }
 if(!response){const detail=String(lastError?.message||'network error').replace(/rssd_device_[A-Za-z0-9_-]+/g,'[redacted]').slice(0,300);throw Object.assign(new CenterError((method==='GET'?'Center is unreachable; try again when the connection is restored':'Center response was lost; a submitted save may still have been accepted. Recover it by its original request key')+' ('+detail+')'),{timedOut:lastError?.timedOut===true});}
 let value=null;try{value=typeof response.json==='function'?await response.json():response.json;}catch{value=null;}
 if(response.status<200||response.status>=300)throw new CenterError(value?.message||'Center request failed ('+response.status+')',{status:response.status,code:value?.code||'http_error'});
 if(value===null&&response.status!==204)throw new CenterError('Center response could not be read',{code:'invalid_response'});
 return value;
}

export function createCenterClient({http,origin,token}){
 origin=centerOrigin(origin);
 if(!TOKEN.test(token||''))throw Error('Invalid Center device credential');
 const request=(path,options={})=>centerRequest(http,origin,path,{...options,token});
 const query=options=>new URLSearchParams(Object.entries(options||{}).filter(([,v])=>v!==undefined&&v!==null)).toString();
 const editorial=(workspaceId,path)=>'/editorial/'+encodeURIComponent(workspaceId)+'/'+path;
 const site=workspaceId=>request(editorial(workspaceId,'site')),boundedSites=new Map();
 const requireBounded=async workspaceId=>{
  if(!boundedSites.has(workspaceId))boundedSites.set(workspaceId,site(workspaceId).then(value=>{
   if(!value?.capabilities?.includes('bounded-media-v1'))throw Object.assign(Error('This Center does not support bounded media reads; update it before syncing'),{code:'bounded_media_unavailable'});
  }).catch(error=>{boundedSites.delete(workspaceId);throw error;}));
  return boundedSites.get(workspaceId);
 };
 const boundedDetail=async(workspaceId,path,options)=>{
  await requireBounded(workspaceId);const value=await request(path,options);
  if(value?.boundedMediaReads!==true)throw Object.assign(Error('The Center did not confirm bounded media reads'),{code:'bounded_media_unavailable'});
  return value;
 };
 return {origin,
  identity:()=>request('/identity'),
  registry:()=>request('/registry'),
  demands:options=>request('/demands?'+query(options)),
  createDemand:body=>request('/demands',{method:'POST',body}),
  /** One page of every work in the space (drafts included), newest Center snapshot. */
  catalog:(workspaceId,options)=>request(editorial(workspaceId,'catalog?'+query({scope:'all',...options}))),
  /** The current Center edition of one work, with its data and image bytes. */
  work:(workspaceId,articleId,locale)=>boundedDetail(workspaceId,editorial(workspaceId,'cloud/'+encodeURIComponent(articleId)+'?'+query({locale,media:'referenced'}))),
  /** Small bounded catalog batches. Older Centers return 404 and can use work(). */
  // Images can make a batch substantially larger than a single note. Give it a
  // bounded longer window and do not duplicate a request that is still in flight.
  workBatch:async(workspaceId,ids,locale)=>{await requireBounded(workspaceId);const result=await request(editorial(workspaceId,'cloud/batch/read?'+query({locale,ids:ids.join(','),media:'referenced'})),{timeoutMs:120000,timeoutGraceMs:180000});if(result?.items?.some(item=>item?.ok&&item.detail?.boundedMediaReads!==true))throw Object.assign(Error('The Center did not confirm bounded media reads'),{code:'bounded_media_unavailable'});return result;},
  /** Exact-base private save; never publishes. */
  saveDraft:(workspaceId,envelope)=>request(editorial(workspaceId,'drafts'),{method:'POST',body:envelope}),
  /** Recovery of a draft save whose answer was lost, by its original request key. */
  draftReceipt:(workspaceId,requestKey)=>request(editorial(workspaceId,'drafts/requests/'+encodeURIComponent(requestKey))),
  /** The edition the website shows, with its referenced images. 404 not_published for drafts. */
  published:(workspaceId,articleId,locale)=>request(editorial(workspaceId,'published/'+encodeURIComponent(articleId)+'?'+query({locale,media:'referenced'}))),
  /** The newest Center edition (drafts included) for reading only. */
  latest:(workspaceId,articleId,locale)=>request(editorial(workspaceId,'cloud/'+encodeURIComponent(articleId)+'?'+query({locale,media:'referenced'}))),
  /** The private writing record kept with an edition: notes and the agents and models that ran. Read only. */
  privateNotes:(workspaceId,articleId,revision)=>request(editorial(workspaceId,'source-archives/private-notes/'+encodeURIComponent(articleId)+(revision?'?'+query({revision}):''))),
  stagedSite:site,
  stagedList:(workspaceId,locale,options={})=>request(editorial(workspaceId,'staged-drafts?'+query({locale,...options}))),
  stagedWork:(workspaceId,articleId,locale)=>boundedDetail(workspaceId,editorial(workspaceId,'staged-drafts/'+encodeURIComponent(articleId)+'?'+query({locale}))),
  saveStaged:(workspaceId,envelope)=>request(editorial(workspaceId,'staged-drafts'),{method:'POST',body:envelope}),
  stagedReceipt:(workspaceId,key)=>request(editorial(workspaceId,'staged-drafts/requests/'+encodeURIComponent(key))),
  stagedPromotion:(workspaceId,articleId,locale,overlayRevision)=>request(editorial(workspaceId,'staged-drafts/promotions/'+encodeURIComponent(articleId)+'?'+query({locale,overlayRevision}))),
 };
}
