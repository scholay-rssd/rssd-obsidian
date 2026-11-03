// Pull a space into the vault and save notes back as private drafts. The vault adapter and the baseline store
// are injected. Rules (see the RSSD business spec): the Center is the source of truth; a pull never overwrites a
// note with local changes; a save carries the exact base and is refused when the Center moved; saving never
// publishes; a save whose answer was lost is recovered by its original request key, never resent.
import {workToNote,noteToWork,workFingerprint,centerMediaPaths,localMediaPaths,workState,draftEnvelope,isReadOnlyWork,
 bytesToBase64,base64ToBytes,notePath,checkLocale,MEDIA_FOLDER} from './sync-model.mjs';

const PAGE=100;
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
    if(page.next==null){for(const items of pages)yield items;return;}
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
  const failure=(item,error)=>({articleId:item.articleId,code:error.code||'network_error',
   message:String(error.message||'Center is unreachable').replace(/rssd_device_[A-Za-z0-9_-]+/g,'[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi,'$1[redacted]').slice(0,500)});
  const snapshot=()=>({...summary,downloaded:[...summary.downloaded],updated:[...summary.updated],skipped:[...summary.skipped],
   conflicts:[...summary.conflicts],pending:[...summary.pending],failed:[...summary.failed],removedFromCenter:[...summary.removedFromCenter]});
  const processItem=async item=>{
   const base=await this.store.get(workspaceId,item.articleId,locale),path=notePath(item.articleId,locale),local=base?.pending?null:await this.noteFingerprint(path);
   const state=base?.pending?'publishing':workState({base,localFingerprint:local?.fingerprint??null,remote:{version:item.version}});
   await onProgress({articleId:item.articleId,locale,state,summary:snapshot()});
   if(state==='publishing'){summary.pending.push(item.articleId);return;}
   if(state==='synced'){summary.unchanged++;return;}
   if(state==='local_changed'){summary.skipped.push(item.articleId);return;}
   if(state==='conflict'){summary.conflicts.push(item.articleId);return;}
   if(state==='unlinked'||state==='remote_changed'||state==='not_downloaded'||state==='missing'||state==='unpublished'){
    if(local&&!base){summary.conflicts.push(item.articleId);return;}
    let detail;
    try{detail=await this.client.work(workspaceId,item.articleId,locale);}
    catch(error){
     // Only defer a transport failure from this GET. Local vault errors, HTTP
     // failures and uncertain writes must never be silently classified as retries.
     if(error?.code==='network_error'&&(!error.status||error.status===0))error.retryableDetail=true;
     throw error;
    }
    if(detail?.articleId!==item.articleId||detail?.data?.id!==item.articleId)
     throw Object.assign(Error('The Center returned a different work; local notes were kept'),{code:'identity_conflict'});
    try{await this.writeWork(workspaceId,detail,local?.content??null,locale);(base?summary.updated:summary.downloaded).push(item.articleId);}
    catch(error){if(error.code!=='local_edit_during_pull')throw error;summary.conflicts.push(item.articleId);}
   }
  };
  const attach=(item,error)=>{
   if(error&&typeof error==='object')Object.assign(error,{articleId:item.articleId,pullSummary:snapshot()});
   return error;
  };
  for await(const items of catalogPages(this.client,workspaceId,locale)){
   for(const item of items){
    seen.add(item.articleId);
    try{await processItem(item);}
    catch(error){
     if(!error?.retryableDetail)throw attach(item,error);
     retry.push(item);summary.failed.push(failure(item,error));
    }
   }
  }
  // Re-evaluate the local file and baseline on the second pass. A user may have
  // edited or created the note while other works downloaded; preserve that edit.
  for(const item of retry){
   try{
    await processItem(item);
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
   if(error.status>=400&&error.status<500){await this.store.set(workspaceId,work.data.id,base,work.data.locale);throw error;}
   throw Object.assign(error,{retained:true});
  }
  return this.confirm(workspaceId,work.data.id,base,fingerprint,receipt);
 }

 async recover(workspaceId,path,base){
  const receipt=await this.client.draftReceipt(workspaceId,base.pending.requestKey);
  if(!receipt?.revision)throw Object.assign(Error('The earlier save has not finished at the Center; try again shortly'),{retained:true});
  // The baseline is what was sent; any edit made since stays a local change.
  return this.confirm(workspaceId,base.articleId,base,base.pending.fingerprint,receipt);
 }

 async confirm(workspaceId,articleId,base,fingerprint,receipt){
  const {pending,...rest}=base;
  await this.store.set(workspaceId,articleId,{...rest,version:receipt.revision,fingerprint},base.locale||'zh-CN');
  return {state:'saved',revision:receipt.revision};
 }
}
