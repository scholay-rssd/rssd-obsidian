// Private staged drafts are a separate branch, never a canonical edition.
import {draftEnvelope,packWorkMedia,notePath,checkLocale,workToNote,noteToWork,workFingerprint,localMediaPaths,base64ToBytes,mediaHash,MEDIA_FOLDER,isStructuredKind,verifyStructuredDetail} from './sync-model.mjs';
import {newRequestKey} from './sync-engine.mjs';
import {checkCanonicalPull} from './path-guard.mjs';
const fail=(message,code='staged_conflict')=>{throw Object.assign(Error(message),{code,conflict:true});};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
const comparableData=data=>({...data,assets:[...(data?.assets||[])].sort((a,b)=>String(a.path).localeCompare(String(b.path)))});
const cursor=x=>({workId:x.workId,baseRevision:x.baseRevision,baseHash:x.baseHash,basePublishedVersion:x.basePublishedVersion??null,overlayRevision:x.overlayRevision});
function valid(value,id,locale){
 if(!value||value.articleId!==id||value.locale!==locale||typeof value.workId!=='string'||!value.workId||!Number.isSafeInteger(value.baseRevision)||value.baseRevision<1||!/^[a-f0-9]{64}$/.test(value.baseHash||'')||!(value.basePublishedVersion==null||Number.isSafeInteger(value.basePublishedVersion)&&value.basePublishedVersion>0)||!Number.isSafeInteger(value.overlayRevision)||value.overlayRevision<0)fail('The staged draft identity or version is invalid','invalid_response');
 return cursor(value);
}
function compatible(base,remote){
 if(!base||base.version!==remote.baseRevision||(base.publishedVersion??null)!==remote.basePublishedVersion)fail('The original Center snapshot changed; local edits were kept');
 if(base.staged){if(!same(base.staged,remote))fail('The staged draft changed; local edits were kept');}
 else if(remote.overlayRevision!==0)fail('A staged draft already exists; reconcile it before saving');
}
export class StagedSyncEngine{
 constructor({engine,client=engine.client,store=engine.store,vault=engine.vault,yaml=engine.yaml}){Object.assign(this,{engine,client,store,vault,yaml});}
 async mediaMatches(hashes){
  for(const [name,hash] of Object.entries(hashes||{})){
   const bytes=await this.vault.readBinary(MEDIA_FOLDER+'/'+name);
   if(bytes==null||await mediaHash(new Uint8Array(bytes))!==hash)return false;
  }
  return true;
 }
 async ensureAvailable(workspaceId){const site=await this.client.stagedSite(workspaceId);if(!Array.isArray(site?.capabilities)||!site.capabilities.includes('staged-drafts-v1'))throw Object.assign(Error('This Center does not support staged private drafts; local edits were kept'),{code:'staged_drafts_unavailable'});}
 async save(workspaceId,path){
  const local=await this.engine.noteFingerprint(path);if(!local)throw Error('This note is not an RSSD work');
  const {work,fingerprint}=local,{id,locale}=work.data;
  if(path!==notePath(id,locale))throw Error('The work identity does not match its path');
  let base=await this.store.get(workspaceId,id,locale);
  this.engine.assertLocalPath(base,id,locale,true);
  await this.ensureAvailable(workspaceId);
  if(base?.pending){if(base.pending.kind!=='staged')fail('A different save is awaiting recovery');return this.recover(workspaceId,id,locale,base);}
  const structured=base?.readOnly===true&&isStructuredKind(work.kind);
  if(!base||(base.readOnly&&!structured)||(!base.readOnly&&work.kind!=='news'))fail('This work cannot be saved as a staged draft');
  const detail=await this.client.stagedWork(workspaceId,id,locale),remote=valid(detail,id,locale);
  if(detail.baseState!=='current'||detail.preservesEditorialFieldsOnSave!==true||!detail.data||detail.data.id!==id||(detail.data.locale||'zh-CN')!==locale||detail.data.sectionId!==base?.sectionId)fail('The original staged snapshot changed or cannot be safely saved');
  if(structured)verifyStructuredDetail({work,base,detail});else if(detail.data.record)fail('The staged work kind changed');
  compatible(base,remote);
  if(!base.mediaHashes){
   if(base.staged||remote.overlayRevision!==0||!detail.data||detail.data.id!==id||(detail.data.locale||'zh-CN')!==locale||detail.data.sectionId!==base.sectionId)fail('The original media baseline cannot be verified');
   const mediaHashes=await this.engine.centerMediaHashes({data:detail.data});
   if(!same(await this.store.get(workspaceId,id,locale),base))fail('The local baseline changed');
   base={...base,mediaHashes};await this.store.set(workspaceId,id,base,locale);
  }
  if(this.engine.localChanges(base,local)===false)return {state:'unchanged'};
  const packed=await packWorkMedia(work,local.mediaBytes),requestKey=newRequestKey(),draft=draftEnvelope({work:packed.work,base,requestKey,assets:packed.assets,allowEmptyOptional:true,allowStructured:structured});
  if(detail.data.translationOf)draft.data.translationOf=detail.data.translationOf;
  const current=await this.store.get(workspaceId,id,locale);if(!same(base,current))fail('The local baseline changed; local edits were kept');
  const pending={kind:'staged',requestKey,fingerprint,mediaHashes:local.mediaHashes,cursor:remote};
  await this.store.set(workspaceId,id,{...base,pending},locale);
  let receipt;try{receipt=await this.client.saveStaged(workspaceId,{requestKey,articleId:id,locale,baseRevision:remote.baseRevision,baseHash:remote.baseHash,basePublishedVersion:remote.basePublishedVersion,overlayRevision:remote.overlayRevision,data:draft.data});}
  catch(error){if(error.status>=400&&error.status<500&&error.status!==408){const now=await this.store.get(workspaceId,id,locale);if(now?.pending?.requestKey===requestKey)await this.store.set(workspaceId,id,base,locale);}else error.retained=true;throw error;}
  return this.confirm(workspaceId,id,locale,pending,receipt);
 }
 async recover(workspaceId,id,locale,base){
  try{return await this.confirm(workspaceId,id,locale,base.pending,await this.client.stagedReceipt(workspaceId,base.pending.requestKey));}
  catch(error){error.retained=true;throw error;}
 }
 /** Adopt only an evidenced private-branch promotion, retaining any local edits. */
 async promote(workspaceId,id,locale='zh-CN'){
  checkLocale(locale);const path=notePath(id,locale);await this.ensureAvailable(workspaceId);
  let base=await this.store.get(workspaceId,id,locale);
  if(base?.pending){if(base.pending.kind!=='staged')fail('A different save is awaiting recovery');await this.recover(workspaceId,id,locale,base);base=await this.store.get(workspaceId,id,locale);}
  if(!base?.staged||base.articleId!==id||(base.locale||'zh-CN')!==locale||base.version!==base.staged.baseRevision)fail('No matching staged baseline is available');
  const saved=base.staged;
  if(!Number.isSafeInteger(saved.overlayRevision)||saved.overlayRevision<1)fail('The staged baseline is invalid');
  const promotion=await this.client.stagedPromotion(workspaceId,id,locale,saved.overlayRevision);
  if(promotion?.articleId!==id||promotion.workId!==saved.workId||promotion.locale!==locale||promotion.baseRevision!==saved.baseRevision||promotion.baseHash!==saved.baseHash||promotion.overlayRevision!==saved.overlayRevision||!Number.isSafeInteger(promotion.canonicalRevision)||promotion.canonicalRevision<=saved.baseRevision||typeof promotion.requestId!=='string'||!promotion.requestId)fail('The staged promotion identity does not match this local draft');
  const overlay=await this.client.stagedWork(workspaceId,id,locale);
  if(!same(valid(overlay,id,locale),saved)||!overlay.data||overlay.data.id!==id||(overlay.data.locale||'zh-CN')!==locale||overlay.data.sectionId!==base.sectionId)fail('The staged branch changed after the saved revision');
  const current=await this.engine.client.work(workspaceId,id,locale);
  if(current?.articleId!==id||current.workId!==saved.workId||current.locale!==locale||current.version!==promotion.canonicalRevision||(current.publishedVersion??null)!==(saved.basePublishedVersion??null)||current.preservesEditorialFieldsOnSave!==true||!current.data||current.data.id!==id||(current.data.locale||'zh-CN')!==locale||current.data.sectionId!==base.sectionId||canonical(comparableData(current.data))!==canonical(comparableData(overlay.data)))fail('The promoted Center draft differs from the saved staged branch');
  if(!same(await this.store.get(workspaceId,id,locale),base))fail('The local baseline changed during promotion');
  const {staged,...rest}=base;await this.store.set(workspaceId,id,{...rest,version:promotion.canonicalRevision,metadataSync:{revision:promotion.canonicalRevision}},locale);
  const repaired=await this.engine.repairMetadata(workspaceId,id,locale);
  return {state:'promoted',revision:promotion.canonicalRevision,...repaired};
 }
 async confirm(workspaceId,id,locale,pending,receipt){
  const actual=valid(receipt,id,locale),expected={...pending.cursor,overlayRevision:pending.cursor.overlayRevision+1};
  if(receipt.requestKey!==pending.requestKey||receipt.status!=='draft_saved'||!same(actual,expected))throw Object.assign(Error('The staged draft receipt does not match the original request'),{code:'invalid_receipt',retained:true});
  const base=await this.store.get(workspaceId,id,locale);if(!same(base?.pending,pending)||base.version!==expected.baseRevision)throw Object.assign(Error('The local save record changed; retain the original request'),{code:'local_baseline_changed',retained:true});
  const {pending:_pending,...rest}=base;await this.store.set(workspaceId,id,{...rest,fingerprint:pending.fingerprint,mediaHashes:pending.mediaHashes,staged:actual},locale);
  return {state:'saved',revision:actual.baseRevision,stagedRevision:actual.overlayRevision};
 }
 async pull(workspaceId,{locale='zh-CN'}={}){
  checkLocale(locale);await this.ensureAvailable(workspaceId);let items=[],after=0,generation;
  for(let page=0;;page++){
   if(page>=10000)fail('Staged draft list exceeds the page limit','invalid_response');
   const list=await this.client.stagedList(workspaceId,locale,{after,limit:100,...(generation===undefined?{}:{generation})});
   if(!Array.isArray(list?.items)||list.generation==null||(generation!==undefined&&generation!==list.generation))fail('Invalid or changed staged draft list','invalid_response');
   generation=list.generation;items.push(...list.items);if(list.next==null)break;
   if(!Number.isSafeInteger(list.next)||list.next<=after)fail('Invalid staged draft cursor','invalid_response');after=list.next;
  }
  const result={updated:[],unchanged:[],conflicts:[],pending:[]},seen=new Set();
  for(const item of items){const id=item?.articleId,remote=valid(item,id,locale);notePath(id,locale);if(seen.has(id))fail('Duplicate staged draft identity','invalid_response');seen.add(id);
   const path=notePath(id,locale);let base=await this.store.get(workspaceId,id,locale);const local=await this.engine.noteFingerprint(path);
   if(base?.pending){result.pending.push(id);continue;}
   if(base&&!checkCanonicalPull({articleId:id,locale,hasBaseline:true,canonicalExists:!!local,records:this.engine.pathRecords()}).allowed){result.conflicts.push(id);continue;}
   if(!base||!local||base.version!==remote.baseRevision||(base.publishedVersion??null)!==remote.basePublishedVersion){result.conflicts.push(id);continue;}
   const detail=await this.client.stagedWork(workspaceId,id,locale);if(!same(valid(detail,id,locale),remote)||detail.baseState!=='current'||detail.preservesEditorialFieldsOnSave!==true||!detail.data||detail.data.id!==id||(detail.data.locale||'zh-CN')!==locale||detail.data.sectionId!==base.sectionId){result.conflicts.push(id);continue;}
   try{if(base.readOnly)verifyStructuredDetail({work:local.work,base,detail,checkEdits:false});else if(detail.data.record||local.work.kind!=='news')throw Error('Work kind changed');}catch{result.conflicts.push(id);continue;}
   if(base.staged&&same(base.staged,remote)){result.unchanged.push(id);continue;}
   // A changed local note must never be replaced by a remote branch.
   if(this.engine.localChanges(base,local)===null&&!base.staged){
    const original=await this.engine.client.work(workspaceId,id,locale);
    if(original?.articleId!==id||original.version!==base.version||(original.publishedVersion??null)!==(base.publishedVersion??null)||original?.data?.id!==id||(original?.data?.locale||'zh-CN')!==locale){result.conflicts.push(id);continue;}
    const originalNote=workToNote(original,this.yaml.stringify),originalWork=noteToWork(originalNote.content,this.yaml.parse);
    if(await workFingerprint(originalWork.data,localMediaPaths(originalWork.media))!==base.fingerprint){result.conflicts.push(id);continue;}
    const hashes=await this.engine.centerMediaHashes(original);
    if(!same(await this.store.get(workspaceId,id,locale),base)){result.conflicts.push(id);continue;}
    base={...base,mediaHashes:hashes};await this.store.set(workspaceId,id,base,locale);
   }
   if(this.engine.localChanges(base,local)!==false||base.staged&&(base.staged.baseHash!==remote.baseHash||base.staged.workId!==remote.workId||base.staged.overlayRevision>remote.overlayRevision)){result.conflicts.push(id);continue;}
   const note=workToNote({articleId:id,locale,version:base.version,publishedVersion:base.publishedVersion,data:detail.data},this.yaml.stringify),mediaHashes=await this.engine.centerMediaHashes({data:detail.data});
   // Existing content-addressed files must match; never overwrite another note's media.
   let mediaConflict=false;for(const media of note.media){const bytes=base64ToBytes(media.data),old=await this.vault.readBinary(MEDIA_FOLDER+'/'+media.name);if(old&&(old.length!==bytes.length||old.some((x,i)=>x!==bytes[i]))){mediaConflict=true;break;}}
   if(mediaConflict){result.conflicts.push(id);continue;}
   if(!same(await this.store.get(workspaceId,id,locale),base)){result.conflicts.push(id);continue;}
   for(const media of note.media)await this.vault.writeBinary(MEDIA_FOLDER+'/'+media.name,base64ToBytes(media.data));
   // A user's image edit can arrive while the remote request is in flight.
   // Never replace the note if its original attachment snapshot has changed.
   if(!await this.mediaMatches(local.mediaHashes)){result.conflicts.push(id);continue;}
   try{await this.vault.write(path,note.content,{expectedContent:local.content});}catch(error){if(error.code==='local_edit_during_pull'){result.conflicts.push(id);continue;}throw error;}
   const written=await this.engine.noteFingerprint(path);
   if(!written||written.content!==note.content){result.conflicts.push(id);continue;}
   // Check both the old and new images again: if either changed during the
   // write, restore the prior note only if nobody has edited its text since.
   if(!await this.mediaMatches(local.mediaHashes)||!await this.mediaMatches(mediaHashes)){
    try{await this.vault.write(path,local.content,{expectedContent:note.content});}
    catch(error){if(error.code!=='local_edit_during_pull')throw error;}
    result.conflicts.push(id);continue;
   }
   const current=await this.store.get(workspaceId,id,locale);if(!same(current,base))fail('Baseline changed while applying staged draft','local_baseline_changed');
   await this.store.set(workspaceId,id,{...base,fingerprint:written.fingerprint,mediaHashes,staged:remote},locale);result.updated.push(id);
  }
  // A missing server branch may indicate removal, not a safe deletion instruction.
  for(const base of await this.store.list(workspaceId,locale))if(base.staged&&!seen.has(base.articleId))result.conflicts.push(base.articleId);
  return result;
 }
}
