// Pull a space into the vault and save notes back as private drafts. The vault adapter and the baseline store
// are injected. Rules (see the RSSD business spec): the Center is the source of truth; a pull never overwrites a
// note with local changes; a save carries the exact base and is refused when the Center moved; saving never
// publishes; a save whose answer was lost is recovered by its original request key, never resent.
import {workToNote,noteToWork,updateNoteVersion,workFingerprint,centerMediaPaths,localMediaPaths,workState,draftEnvelope,isReadOnlyWork,isStructuredKind,verifyStructuredDetail,mediaHash,packWorkMedia,
 bytesToBase64,base64ToBytes,notePath,checkLocale,MEDIA_FOLDER} from './sync-model.mjs';
import {checkCanonicalPull} from './path-guard.mjs';

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
   if(restart===MAX_CATALOG_RESTARTS)throw Object.assign(Error('The Center catalog changed repeatedly; try updating again when it is stable'),{code:'catalog_changed'});
  }
 }
}

export class SyncEngine{
 /** `store` keeps baselines: get(workspaceId,articleId), set(...), delete(...), list(workspaceId). */
 constructor({client,vault,store,yaml,pathRecords=()=>({})}){this.client=client;this.vault=vault;this.store=store;this.yaml=yaml;this.pathRecords=pathRecords;}

 async noteFingerprint(path){
  const content=await this.vault.read(path);if(content==null)return null;
  const work=noteToWork(content,this.yaml.parse);if(!work)return null;
  const mediaBytes={},mediaHashes={};
  for(const name of work.media){
   const bytes=await this.vault.readBinary(MEDIA_FOLDER+'/'+name);
   mediaBytes[name]=bytes==null?null:new Uint8Array(bytes);
   mediaHashes[name]=bytes==null?null:await mediaHash(mediaBytes[name]);
  }
  return {work,content,fingerprint:await workFingerprint(work.data,localMediaPaths(work.media)),mediaBytes,mediaHashes};
 }

 /** Compare legacy text baseline and byte-level image baseline without trusting
  * a newly observed local image as evidence of its original Center contents. */
 localChanges(base,local){
  if(!base||!local)return true;
  if(base.fingerprint!==local.fingerprint)return true;
  let expected=base.mediaHashes;
  if(!expected){
   expected={};
   for(const name of local.work.media){
    const match=/^([a-f0-9]{64})\.(?:png|jpg|webp)$/.exec(name);
    if(!match)return null;
    expected[name]=match[1];
   }
  }
  const keys=Object.keys(expected).sort(),now=Object.keys(local.mediaHashes).sort();
  return JSON.stringify(keys)!==JSON.stringify(now)||keys.some(name=>expected[name]!==local.mediaHashes[name]);
 }

 assertLocalPath(base,id,locale,canonicalExists){
  const decision=checkCanonicalPull({articleId:id,locale,hasBaseline:!!base,canonicalExists,records:this.pathRecords()});
  if(!decision.allowed)throw Object.assign(Error('This linked note was moved or removed; restore its original path before syncing'),{code:decision.code,conflict:true});
 }

 async hasLocalChanges(workspaceId,path){
  const local=await this.noteFingerprint(path);
  if(!local){if(await this.vault.read(path)==null)return false;throw Object.assign(Error('This note is not linked to an RSSD work; its local content was kept'),{code:'unlinked_work'});}
  const base=await this.store.get(workspaceId,local.work.data.id,local.work.data.locale);
  this.assertLocalPath(base,local.work.data.id,local.work.data.locale,true);
  if(!base||base.pending)return true;
  return this.localChanges(base,local)!==false;
 }

 /** Derive original media hashes from the authenticated Center response, not
  * from a local file that may already have been modified. */
 async centerMediaHashes(detail){
  const note=workToNote(detail,this.yaml.stringify),work=noteToWork(note.content,this.yaml.parse),hashes={};
  for(const name of work.media){
   const asset=note.media.find(item=>item.name===name);
   if(!asset)throw Object.assign(Error('The Center omitted an image referenced by this work'),{code:'invalid_media'});
   hashes[name]=await mediaHash(base64ToBytes(asset.data));
  }
  return hashes;
 }

 async writeWork(workspaceId,detail,expectedContent=null,locale='zh-CN',expectedMediaHashes=null){
  checkLocale(locale);
  if((detail?.data?.locale||'zh-CN')!==locale||(detail?.locale&&detail.locale!==locale))throw Object.assign(Error('The Center returned a different language; local notes were kept'),{code:'identity_conflict'});
  const note=workToNote(detail,this.yaml.stringify);
  const mediaHashes=await this.centerMediaHashes(detail);
  for(const item of note.media)await this.vault.writeBinary(MEDIA_FOLDER+'/'+item.name,base64ToBytes(item.data));
  if(await this.vault.read(note.path)!==expectedContent)throw Object.assign(Error('The note changed while updating; local edits were kept'),{code:'local_edit_during_pull'});
  if(expectedMediaHashes){
   const latest=await this.noteFingerprint(note.path);
   if(!latest||JSON.stringify(latest.mediaHashes)!==JSON.stringify(expectedMediaHashes))
    throw Object.assign(Error('An image changed while updating; local edits were kept'),{code:'local_edit_during_pull'});
  }
  await this.vault.write(note.path,note.content,{expectedContent});
  if(expectedMediaHashes){
   const hashes={};
   for(const name of Object.keys(expectedMediaHashes)){
    const bytes=await this.vault.readBinary(MEDIA_FOLDER+'/'+name);hashes[name]=bytes==null?null:await mediaHash(bytes);
   }
   if(JSON.stringify(hashes)!==JSON.stringify(expectedMediaHashes)){
    // If an image changed during the write, restore the original note only if
    // nobody has edited the newly written note in the meantime.
    try{await this.vault.write(note.path,expectedContent,{expectedContent:note.content});}catch{}
    throw Object.assign(Error('An image changed while updating; local edits were kept'),{code:'local_edit_during_pull'});
   }
  }
  const written=noteToWork(note.content,this.yaml.parse);
  const fingerprint=await workFingerprint(written.data,localMediaPaths(written.media));
  await this.store.set(workspaceId,detail.data.id,{articleId:detail.data.id,sectionId:detail.data.sectionId,locale:detail.data.locale||'zh-CN',
   version:detail.version,publishedVersion:detail.publishedVersion??null,fingerprint,mediaHashes,readOnly:isReadOnlyWork(detail)},locale);
  return note.path;
 }

 /**
  * Downloads new and changed works. A note with local changes is never touched: it is reported as a conflict
  * when the Center also moved, and left alone otherwise. Returns a summary and per-work states.
  */
 async pull(workspaceId,{locale='zh-CN',onProgress=()=>{}}={}){
  checkLocale(locale);
  // Counts are logical client method calls, not low-level HTTP attempts: the
  // transport may internally retry a GET. No IDs, paths, tokens or content are
  // included in these diagnostics.
  const transport={batchRequests:0,batchWorks:0,batchDelivered:0,batchRequestErrors:0,batchUnsupported:0,
   batchOverLimit:0,batchItemFailures:0,singleRequests:0,fallbackSingles:0,retrySingles:0};
  const summary={downloaded:[],updated:[],skipped:[],conflicts:[],pending:[],metadataPending:[],failed:[],unchanged:0,removedFromCenter:[],transport};
  // Which Center work each edition belongs to, so a Chinese work and its English edition can be paired.
  summary.documents={};
  const seen=new Set(),retry=[];
  let batchAvailable=typeof this.client.workBatch==='function',failedBatches=0;
  const failure=(item,error)=>({articleId:item.articleId,code:error.code||'network_error',
   message:String(error.message||'Center is unreachable').replace(/rssd_device_[A-Za-z0-9_-]+/g,'[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi,'$1[redacted]').slice(0,500)});
  const snapshot=()=>({...summary,downloaded:[...summary.downloaded],updated:[...summary.updated],skipped:[...summary.skipped],
   conflicts:[...summary.conflicts],pending:[...summary.pending],metadataPending:[...summary.metadataPending],failed:[...summary.failed],removedFromCenter:[...summary.removedFromCenter],transport:{...transport}});
  const attach=(item,error)=>{
   if(error&&typeof error==='object')Object.assign(error,{articleId:item.articleId,pullSummary:snapshot()});
   return error;
  };
  // Prepare and apply in one ordered lane: the Obsidian vault adapter, settings
  // store and progress receipts are shared mutable state. Only network reads
  // are allowed to overlap.
  const prepare=async item=>{
   let base=await this.store.get(workspaceId,item.articleId,locale);
   if(base){
    const path=notePath(item.articleId,locale),decision=checkCanonicalPull({articleId:item.articleId,locale,hasBaseline:true,canonicalExists:await this.vault.read(path)!==null,records:this.pathRecords()});
    if(!decision.allowed){summary[base.pending?'pending':'conflicts'].push(item.articleId);return null;}
   }
   // A staged draft is an independent branch, not a canonical edition. A
   // canonical pull must never overwrite it, even when canonical has advanced.
   if(base?.staged){summary[base.pending?'pending':'skipped'].push(item.articleId);return null;}
   if(base&&!base.pending){
    const repaired=await this.repairMetadata(workspaceId,item.articleId,locale,{infer:true});
    if(!repaired.metadataUpdated&&!summary.metadataPending.includes(item.articleId))summary.metadataPending.push(item.articleId);
    if(repaired.metadataUpdated)summary.metadataPending=summary.metadataPending.filter(id=>id!==item.articleId);
    base=await this.store.get(workspaceId,item.articleId,locale);
   }
   const path=notePath(item.articleId,locale),local=base?.pending?null:await this.noteFingerprint(path);
   const mediaChanged=base&&local?this.localChanges(base,local):false;
   const state=base?.pending?'publishing':workState({base,localFingerprint:local?(mediaChanged===false?local.fingerprint:'media-changed:'+local.fingerprint):null,remote:{version:item.version}});
   await onProgress({articleId:item.articleId,locale,state,summary:snapshot()});
   if(state==='publishing'){summary.pending.push(item.articleId);return null;}
   if(state==='synced'){summary.unchanged++;return null;}
   if(state==='local_changed'){summary.skipped.push(item.articleId);return null;}
   if(state==='conflict'){summary.conflicts.push(item.articleId);return null;}
   if(!['unlinked','remote_changed','not_downloaded','missing','unpublished'].includes(state))return null;
   if(local&&!base){summary.conflicts.push(item.articleId);return null;}
   return {item,base,baseSnapshot:JSON.stringify(base),local};
  };
  const single=async(item,reason)=>{
   transport.singleRequests++;
   if(reason==='fallback')transport.fallbackSingles++;
   if(reason==='retry')transport.retrySingles++;
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
   // A referenced image can change without changing the Markdown file. Recheck
   // its bytes after the network read, before replacing any note content.
   if(local){
    const latest=await this.noteFingerprint(notePath(item.articleId,locale));
    if(!latest||latest.content!==local.content||JSON.stringify(latest.mediaHashes)!==JSON.stringify(local.mediaHashes)){
     summary.conflicts.push(item.articleId);return;
    }
   }
   try{await this.writeWork(workspaceId,detail,local?.content??null,locale,local?.mediaHashes??null);(base?summary.updated:summary.downloaded).push(item.articleId);summary.metadataPending=summary.metadataPending.filter(id=>id!==item.articleId);}
   catch(error){if(error.code!=='local_edit_during_pull')throw error;summary.conflicts.push(item.articleId);}
  };
  // Single-detail fallback is capped at three concurrent requests and waits for
  // every started request before returning, even when one of them fails.
  const singles=async entries=>{
   const outcomes=new Array(entries.length);let next=0,timedOut=null;
   const worker=async()=>{for(;;){if(timedOut)return;const index=next++;if(index>=entries.length)return;
    try{outcomes[index]={status:'fulfilled',value:await single(entries[index].item,'fallback')};}
    catch(reason){outcomes[index]={status:'rejected',reason};if(reason?.timedOut)timedOut=reason;}
   }};
   await Promise.all(Array.from({length:Math.min(DETAIL_CONCURRENCY,entries.length)},worker));
   if(timedOut){for(const entry of entries)summary.failed.push(failure(entry.item,timedOut));throw timedOut;}
   return outcomes;
  };
  const fetchDetails=async entries=>{
   if(!batchAvailable)return singles(entries);
   let response;
   transport.batchRequests++;transport.batchWorks+=entries.length;
   try{response=await this.client.workBatch(workspaceId,entries.map(x=>x.item.articleId),locale);}
   catch(error){
    transport.batchRequestErrors++;
    // Old Centers do not implement the route. A batch-level 404 is safe to
    // retry as individual reads; no mutation is sent by either endpoint.
    if(error?.status===404){batchAvailable=false;transport.batchUnsupported++;return singles(entries);}
    if(error?.code==='network_error'&&(!error.status||error.status===0)){
     // requestUrl cannot cancel a timed-out request. Stop this pull instead of
     // starting a new batch while the previous request may still be active.
     if(error.timedOut){for(const entry of entries)summary.failed.push(failure(entry.item,error));throw error;}
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
   transport.batchDelivered+=outcomes.filter(x=>x?.status==='fulfilled').length;
   transport.batchItemFailures+=outcomes.filter(x=>x?.batchError).length;
   transport.batchOverLimit+=fallback.length;
   if(fallback.length){const results=await singles(fallback.map(x=>x.entry));for(let i=0;i<fallback.length;i++)outcomes[fallback[i].index]=results[i];}
   return outcomes;
  };
  for await(const items of catalogPages(this.client,workspaceId,locale)){
   for(let offset=0;offset<items.length;offset+=BATCH_SIZE){
    const group=items.slice(offset,offset+BATCH_SIZE),entries=[];
    for(const item of group){
     seen.add(item.articleId);
     if(typeof item.documentId==='string'&&item.documentId)summary.documents[item.articleId]=item.documentId;
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
    if(failedBatches>=2)throw attach(entries[0].item,Object.assign(Error('Center connection failed repeatedly; retry the update when it is available'),{code:'network_error'}));
   }
  }
  // Re-evaluate the note and baseline on retry: a user may have edited it while
  // other works were downloading. This second pass uses single reads only.
  for(const item of retry){
   try{
    const prepared=await prepare(item);if(prepared)await apply(prepared,await single(item,'retry'));
    summary.failed=summary.failed.filter(entry=>entry.articleId!==item.articleId);
   }catch(error){
    if(error?.timedOut||!error?.retryableDetail)throw attach(item,error);
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
   if(base.staged){const local=await this.noteFingerprint(notePath(base.articleId,locale));result[base.articleId]=!local?'missing':this.localChanges(base,local)===false?'staged_saved':'local_changed';continue;}
   const local=await this.noteFingerprint(notePath(base.articleId,locale));
   const changed=local?this.localChanges(base,local):false;
   result[base.articleId]=workState({base,localFingerprint:local?(changed===false?local.fingerprint:'media-changed:'+local.fingerprint):null,remote:remote.get(base.articleId)?{version:remote.get(base.articleId).version}:null});
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
  const {work,fingerprint,mediaHashes,mediaBytes}=local,base=await this.store.get(workspaceId,work.data.id,work.data.locale);
  this.assertLocalPath(base,work.data.id,work.data.locale,true);
  if(base?.staged||base?.pending?.kind==='staged')throw Object.assign(Error('This staged draft requires its original staged save handler; local edits were kept'),{code:'staged_handler_required',retained:!!base?.pending});
  if(base?.pending)return this.recover(workspaceId,path,base);
  const structured=base?.readOnly===true&&isStructuredKind(work.kind);
  if((base?.readOnly&&!structured)||(!base?.readOnly&&work.kind!=='news'))throw Error('Structured records cannot be edited in Obsidian with a changed or unsupported kind');
  const changed=this.localChanges(base,local);
  if(base&&changed===false){
   const repaired=await this.repairMetadata(workspaceId,work.data.id,work.data.locale,{infer:true});
   return repaired.metadataUpdated?{state:'unchanged'}:{state:'unchanged',...repaired};
  }
  if(!base)throw Error('Update this work from the Center before saving it');
  // Older Centers silently replace hidden attachment alt text and nested editorial
  // metadata when saving. Their detail response cannot expose enough information
  // for the plugin to reconstruct those fields, so do not submit to them. Read the
  // current revision first and require the server's explicit preservation guarantee.
  const current=await this.client.work(workspaceId,work.data.id,work.data.locale);
  if(current?.version!==base.version||(current?.publishedVersion??null)!==(base.publishedVersion??null))
   throw Object.assign(Error('The Center version changed; local edits were kept. Update or resolve the conflict before saving'),{status:409,code:'revision_conflict',conflict:true});
  if(current?.articleId!==work.data.id||current?.data?.id!==work.data.id||(current?.data?.locale||'zh-CN')!==work.data.locale||(current?.locale&&current.locale!==work.data.locale))
   throw Object.assign(Error('The Center returned a different work; local edits were kept'),{code:'identity_conflict'});
  if(structured)verifyStructuredDetail({work,base,detail:current});
  else if(current.data?.record)throw Object.assign(Error('The Center work kind changed; local edits were kept'),{code:'identity_conflict',conflict:true});
  if(current?.preservesEditorialFieldsOnSave!==true)
   throw Object.assign(Error('This Center cannot confirm safe preservation of existing attachments and editorial metadata. Local edits were kept; update the Center before saving'),{code:'lossless_save_unavailable'});
  const optional=['summary','author','category'],blank=optional.filter(key=>!work.data[key].trim());
  if(blank.length&&(current.preservesLegacyOptionalBlanksOnSave!==true||blank.some(key=>typeof current.data?.[key]!=='string'||current.data[key].trim())))
   throw Object.assign(Error('The Center cannot safely retain an empty manuscript property; local edits were kept'),{code:'optional_property_unavailable'});
  if(changed===null){
   // An older baseline can lack image hashes. Rebuild it only from the same
   // authenticated Center revision and verify its text fingerprint first.
   const original=noteToWork(workToNote(current,this.yaml.stringify).content,this.yaml.parse);
   if(await workFingerprint(original.data,localMediaPaths(original.media))!==base.fingerprint)
    throw Object.assign(Error('The original image baseline could not be verified; local edits were kept'),{code:'media_baseline_unknown'});
   const originalHashes=await this.centerMediaHashes(current),verified={...base,mediaHashes:originalHashes};
   if(this.localChanges(verified,local)===false){
    const latest=await this.store.get(workspaceId,work.data.id,work.data.locale);
    if(JSON.stringify(latest)!==JSON.stringify(base))throw Object.assign(Error('The local baseline changed; retry safely'),{code:'local_baseline_changed'});
    await this.store.set(workspaceId,work.data.id,verified,work.data.locale);
    const repaired=await this.repairMetadata(workspaceId,work.data.id,work.data.locale,{infer:true});
    return repaired.metadataUpdated?{state:'unchanged'}:{state:'unchanged',...repaired};
   }
  }
  const packed=await packWorkMedia(work,mediaBytes);
  const requestKey=newRequestKey(),envelope=draftEnvelope({work:packed.work,base,requestKey,assets:packed.assets,allowEmptyOptional:blank.length>0,allowStructured:structured});
  // Keep the key before the first request so a lost answer can be recovered rather than resent.
  await this.store.set(workspaceId,work.data.id,{...base,pending:{requestKey,fingerprint,mediaHashes}},work.data.locale);
  let receipt;
  try{receipt=await this.client.saveDraft(workspaceId,envelope);}
  catch(error){
   if(error.status===409){await this.store.set(workspaceId,work.data.id,base,work.data.locale);throw Object.assign(error,{conflict:true});}
   // A request timeout can be generated by an intermediary after the Center
   // committed the draft. Keep its key; another POST could create a duplicate.
   if(error.status>=400&&error.status<500&&error.status!==408){await this.store.set(workspaceId,work.data.id,base,work.data.locale);throw error;}
   throw Object.assign(error,{retained:true});
  }
  return this.confirm(workspaceId,work.data.id,base,fingerprint,receipt,requestKey,mediaHashes);
 }

 async recover(workspaceId,path,base){
  if(base.pending?.kind==='staged')throw Object.assign(Error('Recover this staged draft through its original staged handler'),{code:'staged_handler_required',retained:true});
  let receipt;
  try{receipt=await this.client.draftReceipt(workspaceId,base.pending.requestKey);}
  catch(error){if(error?.status===404)throw Object.assign(Error('The earlier save is not yet confirmed; its original request is retained'),{code:'receipt_pending',retained:true});throw error;}
  if(!receipt?.revision)throw Object.assign(Error('The earlier save has not finished at the Center; try again shortly'),{retained:true});
  // The baseline is what was sent; any edit made since stays a local change.
  return this.confirm(workspaceId,base.articleId,base,base.pending.fingerprint,receipt,base.pending.requestKey,base.pending.mediaHashes);
 }

 async confirm(workspaceId,articleId,base,fingerprint,receipt,requestKey,mediaHashes){
  // Never discard the pending key unless the Center receipt identifies the exact
  // request and work and advances its original base revision. A malformed or
  // mismatched response leaves the write outcome uncertain and recoverable.
  if(receipt?.requestKey!==requestKey||receipt?.articleId!==articleId||!Number.isSafeInteger(receipt?.revision)||receipt.revision<=base.version)
   throw Object.assign(Error('The Center returned an invalid save receipt; keep the original request and retry recovery'),{code:'invalid_receipt',retained:true});
  const locale=base.locale||'zh-CN',live=await this.store.get(workspaceId,articleId,locale);
  if(live?.pending?.requestKey!==requestKey||live.pending.fingerprint!==fingerprint||live.version!==base.version||
   JSON.stringify(live.pending.mediaHashes)!==JSON.stringify(mediaHashes))
   throw Object.assign(Error('The local save record changed; keep the original request for recovery'),{code:'local_baseline_changed',retained:true});
  const {pending,...rest}=live;
  // The server save is final once the new baseline is persisted. A separate
  // marker makes the display-only YAML version recoverable without replaying POST.
  await this.store.set(workspaceId,articleId,{...rest,version:receipt.revision,fingerprint,
   ...(pending.mediaHashes?{mediaHashes:pending.mediaHashes}:{mediaHashes:undefined}),metadataSync:{revision:receipt.revision}},locale);
  return {state:'saved',revision:receipt.revision,...await this.repairMetadata(workspaceId,articleId,locale)};
 }

 /** Best-effort version-label repair; never turns a confirmed Center save into
  * a failed or retried POST. The entire latest note is compare-and-swapped. */
 async repairMetadata(workspaceId,articleId,locale,{infer=false}={}){
  const warning={metadataUpdated:false,metadataWarning:'The local version label could not be safely updated; update again after resolving local changes.'};
  try{
   const path=notePath(articleId,locale);
   for(let attempt=0;attempt<2;attempt++){
    const base=await this.store.get(workspaceId,articleId,locale),marker=base?.metadataSync;
    if(!marker&&!infer)return {metadataUpdated:true};
    const revision=marker?.revision??base?.version;
    if(!base||base.pending||base.articleId!==articleId||(base.locale||'zh-CN')!==locale||
     !Number.isSafeInteger(revision)||revision!==base.version)return warning;
    const content=await this.vault.read(path);
    const patched=updateNoteVersion(content,{articleId,sectionId:base.sectionId,locale,version:revision},this.yaml.parse);
    if(!patched)return warning;
    // Earlier plugin versions advanced the baseline without updating the YAML.
    // If detected on a pull, record a repair marker before touching the file.
    if(!marker&&patched.changed){
     const current=await this.store.get(workspaceId,articleId,locale);
     if(current?.pending||current?.version!==revision||current?.metadataSync||current?.articleId!==articleId||
      current?.sectionId!==base.sectionId||(current?.locale||'zh-CN')!==locale)return warning;
     await this.store.set(workspaceId,articleId,{...current,metadataSync:{revision}},locale);
    }
    if(patched.changed){
     const current=await this.store.get(workspaceId,articleId,locale);
     if(current?.pending||current?.version!==revision||current?.metadataSync?.revision!==revision||
      current?.articleId!==articleId||current?.sectionId!==base.sectionId||(current?.locale||'zh-CN')!==locale)return warning;
     try{await this.vault.write(path,patched.content,{expectedContent:content});}
     catch(error){if(error?.code==='local_edit_during_pull')continue;return warning;}
    }
    const current=await this.store.get(workspaceId,articleId,locale);
    if(current?.pending||current?.version!==revision)return warning;
    if(!current.metadataSync)return {metadataUpdated:true};
    if(current.metadataSync.revision!==revision)return warning;
    const {metadataSync,...rest}=current;
    await this.store.set(workspaceId,articleId,rest,locale);
    return {metadataUpdated:true};
   }
  }catch{return warning;}
  return warning;
 }
}
