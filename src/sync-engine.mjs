// Pull a space into the vault and save notes back as private drafts. The vault adapter and the baseline store
// are injected. Rules (see the RSSD business spec): the Center is the source of truth; a pull never overwrites a
// note with local changes; a save carries the exact base and is refused when the Center moved; saving never
// publishes; a save whose answer was lost is recovered by its original request key, never resent.
import {workToNote,noteToWork,workFingerprint,centerMediaPaths,localMediaPaths,workState,draftEnvelope,isReadOnlyWork,
 bytesToBase64,base64ToBytes,notePath,MEDIA_FOLDER} from './sync-model.mjs';

const PAGE=100;
export const newRequestKey=()=>'obsidian-'+crypto.randomUUID().replace(/-/g,'');

async function* catalogPages(client,workspaceId){
 let after,generation;
 for(;;){
  let page;
  try{page=await client.catalog(workspaceId,{limit:PAGE,...(after!==undefined?{after,generation}:{})});}
  catch(error){if(error.code==='catalog_changed'){after=undefined;generation=undefined;continue;}throw error;}
  generation=page.generation;yield page.items;
  if(page.next==null)return;after=page.next;
 }
}

export class SyncEngine{
 /** `store` keeps baselines: get(workspaceId,articleId), set(...), delete(...), list(workspaceId). */
 constructor({client,vault,store,yaml}){this.client=client;this.vault=vault;this.store=store;this.yaml=yaml;}

 async noteFingerprint(path){
  const content=await this.vault.read(path);if(content==null)return null;
  const work=noteToWork(content,this.yaml.parse);if(!work)return null;
  return {work,fingerprint:await workFingerprint(work.data,localMediaPaths(work.media))};
 }

 async writeWork(workspaceId,detail){
  const note=workToNote(detail,this.yaml.stringify);
  for(const item of note.media)await this.vault.writeBinary(MEDIA_FOLDER+'/'+item.name,base64ToBytes(item.data));
  await this.vault.write(note.path,note.content);
  const local=await this.noteFingerprint(note.path);
  await this.store.set(workspaceId,detail.data.id,{articleId:detail.data.id,sectionId:detail.data.sectionId,locale:detail.data.locale||'zh-CN',
   version:detail.version,publishedVersion:detail.publishedVersion??null,fingerprint:local.fingerprint,readOnly:isReadOnlyWork(detail)});
  return note.path;
 }

 /**
  * Downloads new and changed works. A note with local changes is never touched: it is reported as a conflict
  * when the Center also moved, and left alone otherwise. Returns a summary and per-work states.
  */
 async pull(workspaceId,{onProgress=()=>{}}={}){
  const summary={downloaded:[],updated:[],skipped:[],conflicts:[],unchanged:0,removedFromCenter:[]};
  const seen=new Set();
  for await(const items of catalogPages(this.client,workspaceId)){
   for(const item of items){
    seen.add(item.articleId);
    const base=await this.store.get(workspaceId,item.articleId),path=notePath(item.articleId),local=await this.noteFingerprint(path);
    const state=workState({base,localFingerprint:local?.fingerprint??null,remote:{version:item.version}});
    onProgress({articleId:item.articleId,state});
    if(state==='synced'){summary.unchanged++;continue;}
    if(state==='local_changed'){summary.skipped.push(item.articleId);continue;}
    if(state==='conflict'){summary.conflicts.push(item.articleId);continue;}
    if(state==='unlinked'||state==='remote_changed'||state==='not_downloaded'||state==='missing'||state==='unpublished'){
     if(local&&!base){summary.conflicts.push(item.articleId);continue;}
     const detail=await this.client.work(workspaceId,item.articleId);
     await this.writeWork(workspaceId,detail);(base?summary.updated:summary.downloaded).push(item.articleId);
    }
   }
  }
  for(const base of await this.store.list(workspaceId))if(!seen.has(base.articleId))summary.removedFromCenter.push(base.articleId);
  return summary;
 }

 /** The state of every downloaded work against the Center's current versions (one catalog pass). */
 async states(workspaceId){
  const remote=new Map();
  for await(const items of catalogPages(this.client,workspaceId))for(const item of items)remote.set(item.articleId,item);
  const result={};
  for(const base of await this.store.list(workspaceId)){
   const local=await this.noteFingerprint(notePath(base.articleId));
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
  const {work,fingerprint}=local,base=await this.store.get(workspaceId,work.data.id);
  if(base?.pending)return this.recover(workspaceId,path,base);
  if(base&&base.fingerprint===fingerprint)return {state:'unchanged'};
  const assets=[];
  for(const name of work.media){
   const bytes=await this.vault.readBinary(MEDIA_FOLDER+'/'+name);
   if(!bytes)throw Error('The image '+name+' is missing from the vault');
   assets.push({path:'/article-media/'+name,data:bytesToBase64(bytes)});
  }
  const requestKey=newRequestKey(),envelope=draftEnvelope({work,base,requestKey,assets});
  // Keep the key before the first request so a lost answer can be recovered rather than resent.
  await this.store.set(workspaceId,work.data.id,{...base,pending:{requestKey,fingerprint}});
  let receipt;
  try{receipt=await this.client.saveDraft(workspaceId,envelope);}
  catch(error){
   if(error.status===409){await this.store.set(workspaceId,work.data.id,base);throw Object.assign(error,{conflict:true});}
   if(error.status>=400&&error.status<500){await this.store.set(workspaceId,work.data.id,base);throw error;}
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
  await this.store.set(workspaceId,articleId,{...rest,version:receipt.revision,fingerprint});
  return {state:'saved',revision:receipt.revision};
 }
}
