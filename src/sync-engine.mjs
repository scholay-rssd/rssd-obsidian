// Pull a space into the vault and save notes back as private drafts. The vault adapter and the baseline store
// are injected. Rules (see the RSSD business spec): the Center is the source of truth; a pull never overwrites a
// note with local changes; a save carries the exact base and is refused when the Center moved; saving never
// publishes; a save whose answer was lost is recovered by its original request key, never resent.
import {workToNote,noteToWork,workFingerprint,centerMediaPaths,localMediaPaths,workState,draftEnvelope,isReadOnlyWork,
 bytesToBase64,base64ToBytes,notePath,checkLocale,MEDIA_FOLDER} from './sync-model.mjs';

const PAGE=100,DETAIL_CONCURRENCY=3,BATCH_SIZE=8;
export const newRequestKey=()=>'obsidian-'+crypto.randomUUID().replace(/-/g,'');

// Read a complete consistent catalog snapshot before yielding any pages. If a generation
// changes mid-pagination, already-fetched pages belong to an old snapshot and must not
// be used to decide which local works have been removed from the Center.
const MAX_CATALOG_RESTARTS=3,MAX_CATALOG_PAGES=10000;
async function* catalogPages(client,workspaceId,locale){
 for(let restart=0;restart<=MAX_CATALOG_RESTARTS;restart++){
  let after,generation,pages=[];
  try{
   for(let count=0;count<MAX_CATALOG_PAGES;count++){
    const page=await client.catalog(workspaceId,{limit:PAGE,locale,...(after!==undefined?{after,generation}:{})});
    if(!Array.isArray(page?.items)||page.generation==null)throw Object.assign(Error('The Center returned an invalid catalog page'),{code:'invalid_catalog'});
    if(generation!==undefined&&page.generation!==generation)throw Object.assign(Error('The Center catalog changed during pagination'),{code:'catalog_changed'});
    generation=page.generation;pages.push(page.items);
    if(page.next==null){
     // A repeated identity would let two workers race the same note. Reject the
     // snapshot before touching the vault, including duplicates across pages.
     const identities=new Set();
     for(const items of pages)for(const item of items){
      notePath(item?.articleId,locale);
      if(identities.has(item.articleId))throw Object.assign(Error('The Center catalog contains a duplicate work identity'),{code:'identity_conflict'});
      identities.add(item.articleId);
     }
     for(const items of pages)yield items;return;
    }
    if(!Number.isSafeInteger(page.next)||page.next<0||(after!==undefined&&page.next<=after)||page.next===0)
     throw Object.assign(Error('The Center returned an invalid catalog cursor'),{code:'invalid_catalog'});
    after=page.next;
   }
   throw Object.assign(Error('The Center catalog exceeds the page limit'),{code:'invalid_catalog'});
  }catch(error){
   if(error?.code!=='catalog_changed')throw error;
   if(restart===MAX_CATALOG_RESTARTS)throw Object.assign(Error('The Center catalog changed repeatedly; try pulling again when it is stable'),{code:'catalog_changed'});
  }
 }
}

export class SyncEngine{
 /** `store` keeps baselines: get(workspaceId,articleId), set(...), delete(...), list(workspaceId). */
 constructor({client,vault,store,yaml}){this.client=client;this.vault=vault;this.store=store;this.yaml=yaml;}

 async noteFingerprint(path){
  const content=await this.vault.read(path);if(content==null)return null;
  const work=noteToWork(content,this.yaml.parse);if(!work)return null;
  return {work,content,fingerprint:await workFingerprint(work.data,localMediaPaths(work.media))};
 }

 async writeWork(workspaceId,detail,expectedContent=null,locale='zh-CN'){
  checkLocale(locale);
  if((detail?.data?.locale||'zh-CN')!==locale||(detail?.locale&&detail.locale!==locale))throw Object.assign(Error('The Center returned a different language; local notes were kept'),{code:'identity_conflict'});
  const note=workToNote(detail,this.yaml.stringify);
  for(const item of note.media)await this.vault.writeBinary(MEDIA_FOLDER+'/'+item.name,base64ToBytes(item.data));
  if(await this.vault.read(note.path)!==expectedContent)throw Object.assign(Error('The note changed while pulling; local edits were kept'),{code:'local_edit_during_pull'});
  await this.vault.write(note.path,note.content,{expectedContent});
  const written=noteToWork(note.content,this.yaml.parse);
  const fingerprint=await workFingerprint(written.data,localMediaPaths(written.media));
  await this.store.set(workspaceId,detail.data.id,{articleId:detail.data.id,sectionId:detail.data.sectionId,locale:detail.data.locale||'zh-CN',
   version:detail.version,publishedVersion:detail.publishedVersion??null,fingerprint,readOnly:isReadOnlyWork(detail)},locale);
  return note.path;
 }

 /**
  * Downloads new and changed works. A note with local changes is never touched: it is reported as a conflict
  * when the Center also moved, and left alone otherwise. Returns a summary and per-work states.
  */
 async pull(workspaceId,{locale='zh-CN',onProgress=()=>{}}={}){
  checkLocale(locale);
  const summary={downloaded:[],updated:[],skipped:[],conflicts:[],pending:[],failed:[],unchanged:0,removedFromCenter:[]};
  const seen=new Set(),retry=[];
  let batchAvailable=typeof this.client.workBatch==='function',failedBatches=0;
  const failure=(item,error)=>({articleId:item.articleId,code:error.code||'network_error',
   message:String(error.message||'Center is unreachable').replace(/rssd_device_[A-Za-z0-9_-]+/g,'[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi,'$1[redacted]').slice(0,500)});
  const snapshot=()=>({...summary,downloaded:[...summary.downloaded],updated:[...summary.updated],skipped:[...summary.skipped],
   conflicts:[...summary.conflicts],pending:[...summary.pending],failed:[...summary.failed],removedFromCenter:[...summary.removedFromCenter]});
  const attach=(item,error)=>{
   if(error&&typeof error==='object')Object.assign(error,{articleId:item.articleId,pullSummary:snapshot()});
   return error;
  };
  // Prepare and apply in one ordered lane: the Obsidian vault adapter, settings
  // store and progress receipts are shared mutable state. Only network reads
  // are allowed to overlap.
  const prepare=async item=>{
   const base=await this.store.get(workspaceId,item.articleId,locale),path=notePath(item.articleId,locale),local=base?.pending?null:await this.noteFingerprint(path);
   const state=base?.pending?'publishing':workState({base,localFingerprint:local?.fingerprint??null,remote:{version:item.version}});
   await onProgress({articleId:item.articleId,locale,state,summary:snapshot()});
   if(state==='publishing'){summary.pending.push(item.articleId);return null;}
   if(state==='synced'){summary.unchanged++;return null;}
   if(state==='local_changed'){summary.skipped.push(item.articleId);return null;}
   if(state==='conflict'){summary.conflicts.push(item.articleId);return null;}
   if(!['unlinked','remote_changed','not_downloaded','missing','unpublished'].includes(state))return null;
   if(local&&!base){summary.conflicts.push(item.articleId);return null;}
   return {item,base,baseSnapshot:JSON.stringify(base),local};
  };
  const single=async item=>{
   try{return await this.client.work(workspaceId,item.articleId,locale);}
   catch(error){
    if(error?.code==='network_error'&&(!error.status||error.status===0))error.retryableDetail=true;
    throw error;
   }
  };
  const apply=async(prepared,detail)=>{
   const {item,base,local}=prepared;
   if(detail?.articleId!==item.articleId||detail?.data?.id!==item.articleId)
    throw Object.assign(Error('The Center returned a different work; local notes were kept'),{code:'identity_conflict'});
   // An intervening pending save or baseline change must not be overwritten.
   const currentBase=await this.store.get(workspaceId,item.articleId,locale);
   if(JSON.stringify(currentBase)!==prepared.baseSnapshot){
    (currentBase?.pending?summary.pending:summary.conflicts).push(item.articleId);return;
   }
   try{await this.writeWork(workspaceId,detail,local?.content??null,locale);(base?summary.updated:summary.downloaded).push(item.articleId);}
   catch(error){if(error.code!=='local_edit_during_pull')throw error;summary.conflicts.push(item.articleId);}
  };
  // Single-detail fallback is capped at three concurrent requests and waits for
  // every started request before returning, even when one of them fails.
  const singles=async entries=>{
   const outcomes=new Array(entries.length);let next=0;
   const worker=async()=>{for(;;){const index=next++;if(index>=entries.length)return;
    try{outcomes[index]={status:'fulfilled',value:await single(entries[index].item)};}
    catch(reason){outcomes[index]={status:'rejected',reason};}
   }};
   await Promise.all(Array.from({length:Math.min(DETAIL_CONCURRENCY,entries.length)},worker));return outcomes;
  };
  const fetchDetails=async entries=>{
   if(!batchAvailable)return singles(entries);
   let response;
   try{response=await this.client.workBatch(workspaceId,entries.map(x=>x.item.articleId),locale);}
   catch(error){
    // Old Centers do not implement the route. A batch-level 404 is safe to
    // retry as individual reads; no mutation is sent by either endpoint.
    if(error?.status===404){batchAvailable=false;return singles(entries);}
    if(error?.code==='network_error'&&(!error.status||error.status===0)){
     error.retryableDetail=true;return entries.map(()=>({status:'rejected',reason:error}));
    }
    throw error;
   }
   if(response?.locale!==locale||!Array.isArray(response.items)||response.items.length!==entries.length)
    throw Object.assign(Error('The Center returned an invalid batch; local notes were kept'),{code:'invalid_batch'});
   const outcomes=[],fallback=[];
   for(let i=0;i<entries.length;i++){
    const item=response.items[i];
    if(!item||item.articleId!==entries[i].item.articleId||typeof item.ok!=='boolean')
     throw Object.assign(Error('The Center returned mismatched batch identities; local notes were kept'),{code:'invalid_batch'});
    if(item.ok){if(!item.detail||typeof item.detail!=='object')throw Object.assign(Error('The Center returned an invalid batch detail'),{code:'invalid_batch'});outcomes[i]={status:'fulfilled',value:item.detail};continue;}
    const error=item.error;
    if(!error||typeof error.code!=='string'||!Number.isInteger(error.status)||error.status<400||error.status>599)
     throw Object.assign(Error('The Center returned an invalid batch error'),{code:'invalid_batch'});
    if(error.code==='batch_response_limit'&&error.status===413){fallback.push({index:i,entry:entries[i]});continue;}
    outcomes[i]={status:'rejected',batchError:true,reason:Object.assign(Error(String(error.message||'Center request failed').slice(0,500)),{code:error.code,status:error.status})};
   }
   if(fallback.length){const results=await singles(fallback.map(x=>x.entry));for(let i=0;i<fallback.length;i++)outcomes[fallback[i].index]=results[i];}
   return outcomes;
  };
  for await(const items of catalogPages(this.client,workspaceId,locale)){
   for(let offset=0;offset<items.length;offset+=BATCH_SIZE){
    const group=items.slice(offset,offset+BATCH_SIZE),entries=[];
    for(const item of group){
     seen.add(item.articleId);
     try{const prepared=await prepare(item);if(prepared)entries.push(prepared);}
     catch(error){throw attach(item,error);}
    }
    if(!entries.length)continue;
    let outcomes;
    try{outcomes=await fetchDetails(entries);}catch(error){throw attach(entries[0].item,error);}
    for(let i=0;i<entries.length;i++){
     const {item}=entries[i],outcome=outcomes[i];
     if(outcome.status==='rejected'){
      const error=outcome.reason;
      // A batch explicitly reports each item's independent failure. Retain it
      // in the incomplete result without hiding other valid works or retrying
      // non-network errors such as 404, 409 or 500.
      if(outcome.batchError){summary.failed.push(failure(item,error));continue;}
      if(!error?.retryableDetail)throw attach(item,error);
      retry.push(item);summary.failed.push(failure(item,error));continue;
     }
     try{await apply(entries[i],outcome.value);}catch(error){throw attach(item,error);}
    }
    // Bound requests during an outage: requestUrl cannot cancel a timed-out GET,
    // so do not launch batches indefinitely while the connection is down.
    const allNetworkFailures=outcomes.every(x=>x.status==='rejected'&&x.reason?.retryableDetail);
    failedBatches=allNetworkFailures?failedBatches+1:0;
    if(failedBatches>=2)throw attach(entries[0].item,Object.assign(Error('Center connection failed repeatedly; retry the pull when it is available'),{code:'network_error'}));
   }
  }
  // Re-evaluate the note and baseline on retry: a user may have edited it while
  // other works were downloading. This second pass uses single reads only.
  for(const item of retry){
   try{
    const prepared=await prepare(item);if(prepared)await apply(prepared,await single(item));
    summary.failed=summary.failed.filter(entry=>entry.articleId!==item.articleId);
   }catch(error){
    if(!error?.retryableDetail)throw attach(item,error);
    const index=summary.failed.findIndex(entry=>entry.articleId===item.articleId);
    if(index>=0)summary.failed[index]=failure(item,error);
   }
  }
  for(const base of await this.store.list(workspaceId,locale))if(!seen.has(base.articleId))summary.removedFromCenter.push(base.articleId);
  return summary;
 }

 /** The state of every downloaded work against the Center's current versions (one catalog pass). */
 async states(workspaceId,{locale='zh-CN'}={}){
  checkLocale(locale);
  const remote=new Map();
  for await(const items of catalogPages(this.client,workspaceId,locale))for(const item of items)remote.set(item.articleId,item);
  const result={};
  for(const base of await this.store.list(workspaceId,locale)){
   if(base.pending){result[base.articleId]='publishing';continue;}
   const local=await this.noteFingerprint(notePath(base.articleId,locale));
   result[base.articleId]=workState({base,localFingerprint:local?.fingerprint??null,remote:remote.get(base.articleId)?{version:remote.get(base.articleId).version}:null});
  }
  for(const [id,item] of remote)if(!(id in result))result[id]=workState({base:null,localFingerprint:null,remote:{version:item.version}});
  return result;
 }

 /**
  * Saves one note as a private draft. Nothing is sent when there is no change. A pending request (its answer
  * was lost) is queried first and never resent with a new key.
  */
 async save(workspaceId,path){
  const local=await this.noteFingerprint(path);
  if(!local)throw Error('This note is not an RSSD work');
  if(path!==notePath(local.work.data.id,local.work.data.locale))throw Error('The rssd-id property does not match this work file; restore it before saving');
  const {work,fingerprint}=local,base=await this.store.get(workspaceId,work.data.id,work.data.locale);
  if(base?.pending)return this.recover(workspaceId,path,base);
  if(base&&base.fingerprint===fingerprint)return {state:'unchanged'};
  const assets=[];
  for(const name of work.media){
   const bytes=await this.vault.readBinary(MEDIA_FOLDER+'/'+name);
   if(!bytes)throw Error('The image '+name+' is missing from the vault');
   assets.push({path:'/article-media/'+name,data:bytesToBase64(bytes)});
  }
  const requestKey=newRequestKey(),envelope=draftEnvelope({work,base,requestKey,assets});
  // Older Centers silently replace hidden attachment alt text and nested editorial
  // metadata when saving. Their detail response cannot expose enough information
  // for the plugin to reconstruct those fields, so do not submit to them. Read the
  // current revision first and require the server's explicit preservation guarantee.
  const current=await this.client.work(workspaceId,work.data.id,work.data.locale);
  if(current?.version!==base.version||(current?.publishedVersion??null)!==(base.publishedVersion??null))
   throw Object.assign(Error('The Center version changed; local edits were kept. Pull or resolve the conflict before saving'),{status:409,code:'revision_conflict',conflict:true});
  if(current?.articleId!==work.data.id||current?.data?.id!==work.data.id||(current?.data?.locale||'zh-CN')!==work.data.locale||(current?.locale&&current.locale!==work.data.locale))
   throw Object.assign(Error('The Center returned a different work; local edits were kept'),{code:'identity_conflict'});
  if(current?.preservesEditorialFieldsOnSave!==true)
   throw Object.assign(Error('This Center cannot confirm safe preservation of existing attachments and editorial metadata. Local edits were kept; update the Center before saving'),{code:'lossless_save_unavailable'});
  // Keep the key before the first request so a lost answer can be recovered rather than resent.
  await this.store.set(workspaceId,work.data.id,{...base,pending:{requestKey,fingerprint}},work.data.locale);
  let receipt;
  try{receipt=await this.client.saveDraft(workspaceId,envelope);}
  catch(error){
   if(error.status===409){await this.store.set(workspaceId,work.data.id,base,work.data.locale);throw Object.assign(error,{conflict:true});}
   // A request timeout can be generated by an intermediary after the Center
   // committed the draft. Keep its key; another POST could create a duplicate.
   if(error.status>=400&&error.status<500&&error.status!==408){await this.store.set(workspaceId,work.data.id,base,work.data.locale);throw error;}
   throw Object.assign(error,{retained:true});
  }
  return this.confirm(workspaceId,work.data.id,base,fingerprint,receipt,requestKey);
 }

 async recover(workspaceId,path,base){
  const receipt=await this.client.draftReceipt(workspaceId,base.pending.requestKey);
  if(!receipt?.revision)throw Object.assign(Error('The earlier save has not finished at the Center; try again shortly'),{retained:true});
  // The baseline is what was sent; any edit made since stays a local change.
  return this.confirm(workspaceId,base.articleId,base,base.pending.fingerprint,receipt,base.pending.requestKey);
 }

 async confirm(workspaceId,articleId,base,fingerprint,receipt,requestKey){
  // Never discard the pending key unless the Center receipt identifies the exact
  // request and work and advances its original base revision. A malformed or
  // mismatched response leaves the write outcome uncertain and recoverable.
  if(receipt?.requestKey!==requestKey||receipt?.articleId!==articleId||!Number.isSafeInteger(receipt?.revision)||receipt.revision<=base.version)
   throw Object.assign(Error('The Center returned an invalid save receipt; keep the original request and retry recovery'),{code:'invalid_receipt',retained:true});
  const {pending,...rest}=base;
  await this.store.set(workspaceId,articleId,{...rest,version:receipt.revision,fingerprint},base.locale||'zh-CN');
  return {state:'saved',revision:receipt.revision};
 }
}
