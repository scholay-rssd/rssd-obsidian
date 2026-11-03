// Center API client for the Obsidian plugin. `http` is injected (Obsidian's requestUrl at runtime, a stub in
// tests) so this module has no Obsidian or Node dependency and also runs on mobile.
export class CenterError extends Error {
 constructor(message,{status=0,code='network_error'}={}){super(message);this.status=status;this.code=code;}
}
const TOKEN=/^rssd_device_[A-Za-z0-9_-]{48}$/;

/** Accept only an HTTPS origin (or localhost for development), never a path, query or credentials. */
export function centerOrigin(value){
 let url;try{url=new URL(String(value||'').trim());}catch{throw Error('Enter the Center address, e.g. https://center.example.org');}
 if(url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw Error('The Center address must be an origin without a path');
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('Center connections require HTTPS');
 return url.origin;
}

/** One JSON request. Errors keep the Center's status and code so callers can tell a conflict from an outage. */
export async function centerRequest(http,origin,path,{method='GET',body,token,timeoutMs=30000}={}){
 let response,timer;
 try{response=await Promise.race([http({url:origin+'/api/rssd/v1'+path,method,throw:false,contentType:'application/json',
  headers:{Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Request timed out')),timeoutMs);})]);}
 catch(error){const detail=String(error?.message||'network error').replace(/rssd_device_[A-Za-z0-9_-]+/g,'[redacted]').slice(0,300);throw new CenterError((method==='GET'?'Center is unreachable; try again when the connection is restored':'Center response was lost; a submitted save may still have been accepted. Recover it by its original request key')+' ('+detail+')');}finally{clearTimeout(timer);}
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
 return {origin,
  identity:()=>request('/identity'),
  registry:()=>request('/registry'),
  demands:options=>request('/demands?'+query(options)),
  createDemand:body=>request('/demands',{method:'POST',body}),
  /** One page of every work in the space (drafts included), newest Center snapshot. */
  catalog:(workspaceId,options)=>request(editorial(workspaceId,'catalog?'+query({scope:'all',...options}))),
  /** The current Center edition of one work, with its data and image bytes. */
  work:(workspaceId,articleId)=>request(editorial(workspaceId,'cloud/'+encodeURIComponent(articleId))),
  /** Exact-base private save; never publishes. */
  saveDraft:(workspaceId,envelope)=>request(editorial(workspaceId,'drafts'),{method:'POST',body:envelope}),
  /** Recovery of a draft save whose answer was lost, by its original request key. */
  draftReceipt:(workspaceId,requestKey)=>request(editorial(workspaceId,'drafts/requests/'+encodeURIComponent(requestKey))),
 };
}
