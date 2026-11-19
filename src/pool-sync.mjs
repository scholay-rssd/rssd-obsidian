// Keeps a pool vault in step with the Center's demand queue. The Center is the source of truth: an update never
// overwrites a note with unsaved edits, and a save sends only what changed, against the generation the note was
// last in step with, so two people editing one topic cannot silently overwrite each other.
//
// `client` is the Center client, `vault` reads and writes notes ({read, write(path,content,{expectedContent}),
// remove}), `yaml` is {parse, stringify}, and `index` remembers, per demand, where its note is and what it was last
// in step with: {get(id), set(id,value), delete(id), list(), cursor(space), setCursor(space,value)}.
import {POOL_FOLDER,demandToNote,noteToTopic,topicOf,topicFingerprint,topicChanges,newTopicDemand,remoteMark,safeName,sectionFolder,topicScope} from './pool-model.mjs';

const PAGE=200,MAX_PAGES=500;
// Topics that are still open. The first update of a space brings only these, so a vault does not fill with the
// space's whole history; afterwards a known topic is followed to its end, and a finished one that was never here
// is left out.
const OPEN=['queued','claimed','blocked'];
const briefHash=brief=>topicFingerprint({title:'',brief,priority:0,workType:'',topicKey:'',dueAt:''});
const requestId=()=>'obsidian-'+crypto.randomUUID().replace(/-/g,'');
const fail=(message,code,extra={})=>Object.assign(Error(message),{code,...extra});

export class PoolSync{
 constructor({client,vault,yaml,index}){this.client=client;this.vault=vault;this.yaml=yaml;this.index=index;}

 /** A free path for a topic's note in its section folder, named after its title. */
 async freePath(folder,title){
  const name=safeName(title);
  for(let n=1;n<1000;n++){const path=folder+'/'+name+(n>1?' '+n:'')+'.md';if(await this.vault.read(path)==null)return path;}
  throw fail('Too many notes share the name '+name,'path_conflict');
 }

 /** The note of an indexed topic: where it is now, read back. A note that was moved is found by its property. */
 async local(id){
  const entry=await this.index.get(id);if(!entry)return {entry:null,content:null,note:null};
  const content=await this.vault.read(entry.path);
  let note=null;try{note=content==null?null:noteToTopic(content,this.yaml.parse);}catch{note=undefined;}
  // `undefined` marks a note whose properties cannot be read: it has edits, whatever they are.
  if(note&&note.id!==id)note=null;
  return {entry,content:note===null?null:content,note};
 }

 /** Write the Center's version of a demand as its note and remember what it is in step with. */
 async place(demand,registry,{path,expectedContent=null}={}){
  const content=demandToNote(demand,this.yaml.stringify);
  const target=path||await this.freePath(sectionFolder(registry,demand.workspaceId,demand.sectionId),demand.title);
  await this.vault.write(target,content,{expectedContent});
  // The index keeps a digest of the brief, not the brief: a pool of a thousand topics stays small in settings.
  const {brief,...fields}=topicOf(demand);
  await this.index.set(demand.id,{id:demand.id,workspaceId:demand.workspaceId,sectionId:demand.sectionId,path:target,state:demand.state,
   generation:demand.generation,mark:remoteMark(demand),fingerprint:await topicFingerprint(topicOf(demand)),base:{...fields,briefHash:await briefHash(brief)}});
  return target;
 }

 /** Every write demand of one space that changed since the last update, oldest change first after the first run. */
 async changed(workspaceId){
  const since=await this.index.cursor(workspaceId),rows=[];
  for(let page=0;page<MAX_PAGES;page++){
   const batch=await this.client.demands({workspaceId,limit:PAGE,offset:page*PAGE,...(since?{updatedSince:since}:{states:OPEN.join(',')})});
   if(!Array.isArray(batch)||batch.length>PAGE)throw fail('The Center returned an invalid demand list','invalid_response');
   rows.push(...batch);
   if(batch.length<PAGE){
    const newest=rows.map(row=>row.updatedAt).filter(value=>Number.isFinite(Date.parse(value))).sort((a,b)=>Date.parse(a)-Date.parse(b)).at(-1);
    return {rows:rows.filter(row=>row.kind==='write'),cursor:newest||since||null};
   }
  }
  throw fail('The demand list exceeds the page limit','invalid_response');
 }

 /**
  * Bring the Center's topics into the vault. A note without unsaved edits follows the Center. A note with edits is
  * left as written; when the Center's side changed too it is reported as a conflict. A withdrawn topic's note is
  * removed unless it has edits. Returns what happened, by topic title.
  */
 async pull(registry,{onProgress=()=>{}}={}){
  const summary={added:[],updated:[],removed:[],conflicts:[],edited:[],failed:[],unchanged:0},seen=new Set();
  for(const space of registry?.workspaces||[]){
   let result;try{result=await this.changed(space.id);}catch(error){summary.failed.push({workspaceId:space.id,reason:error.message});continue;}
   let complete=true;
   for(const demand of result.rows){
    seen.add(demand.id);
    try{
     const {entry,content,note}=await this.local(demand.id),gone=demand.state==='cancelled';
     if(!entry||content==null&&note!==undefined){
      // Not here, or its note was deleted: only an open topic is (re)placed. A Center that does not know the
      // `states` filter returns everything, so the state is checked here too.
      if(!OPEN.includes(demand.state)){if(entry)await this.index.delete(demand.id);continue;}
      await this.place(demand,registry);summary.added.push(demand.title);
     }else{
      const edited=note===undefined||await topicFingerprint(note.topic)!==entry.fingerprint,moved=entry.mark!==remoteMark(demand);
      if(edited){(moved?summary.conflicts:summary.edited).push(note?.topic?.title||demand.title);continue;}
      if(!moved){summary.unchanged++;continue;}
      if(gone){await this.vault.remove(entry.path);await this.index.delete(demand.id);summary.removed.push(demand.title);}
      else{await this.place(demand,registry,{path:entry.path,expectedContent:content});summary.updated.push(demand.title);}
     }
    }catch(error){complete=false;summary.failed.push({id:demand.id,title:demand.title,reason:error.message});}
    onProgress(summary);
   }
   // The cursor moves only when every change of this space was handled, so a failed note is tried again.
   if(complete&&result.cursor)await this.index.setCursor(space.id,result.cursor);
  }
  // Notes the Center had no news for may still hold edits that were never saved: say so, they are easy to forget.
  for(const entry of await this.index.list()){
   if(seen.has(entry.id))continue;
   const {content,note}=await this.local(entry.id);
   if(content==null&&note!==undefined)continue;
   if(note===undefined||await topicFingerprint(note.topic)!==entry.fingerprint)summary.edited.push(note?.topic?.title||entry.base?.title||entry.id);
  }
  return summary;
 }

 /**
  * Save one note. A note that is not yet a topic is queued in the section its folder or properties name; a topic's
  * edits are sent against the generation it was last in step with. Returns {state, title} where state is created,
  * saved or unchanged. Refusals keep the note as written and say why: `topic_repeat`, `revision_conflict`,
  * `demand_frozen`, `read_only`, `no_section`.
  */
 async save(path,registry){
  const content=await this.vault.read(path);if(content==null)throw fail('The note is gone','not_found');
  const note=noteToTopic(content,this.yaml.parse);
  if(!note)throw fail('Add a properties block with a title to make this note a topic','invalid_topic');
  if(!note.id){
   const scope=topicScope(path,note.properties,registry);
   if(!scope)throw fail('Put the note in a section folder ('+POOL_FOLDER+'/<space>/<section>/) or name its rssd-space and rssd-section','no_section');
   let demand=await this.client.createDemand(newTopicDemand(note.topic,scope));
   if(note.topic.dueAt)demand=await this.client.editDemand(demand.id,{baseGeneration:demand.generation,requestId:requestId(),changes:{dueAt:note.topic.dueAt}});
   await this.place(demand,registry,{path,expectedContent:content});
   return {state:'created',id:demand.id,title:demand.title};
  }
  const entry=await this.index.get(note.id);
  if(!entry)throw fail('This topic is not known to this vault yet; update the topic pool first','not_indexed');
  if(await topicFingerprint(note.topic)===entry.fingerprint)return {state:'unchanged',id:note.id,title:note.topic.title};
  if(entry.state!=='queued')throw fail('This topic is '+entry.state+'; only a topic nobody has claimed can be edited','read_only');
  if(!note.topic.title)throw fail('A topic needs a title property','invalid_topic');
  const changes=topicChanges({...entry.base,brief:await briefHash(note.topic.brief)===entry.base.briefHash?note.topic.brief:null},note.topic);
  const demand=await this.client.editDemand(note.id,{baseGeneration:entry.generation,requestId:requestId(),changes});
  await this.place(demand,registry,{path,expectedContent:content});
  return {state:'saved',id:demand.id,title:demand.title,changed:Object.keys(changes)};
 }

 /** Withdraw a queued topic: the Center cancels the demand and the note is removed. */
 async withdraw(path){
  const content=await this.vault.read(path),note=content==null?null:noteToTopic(content,this.yaml.parse);
  if(!note?.id)throw fail('This note is not a topic of the Center','invalid_topic');
  const demand=await this.client.changeDemand(note.id,{action:'cancel'});
  await this.vault.remove(path);await this.index.delete(note.id);
  return {state:'withdrawn',id:note.id,title:demand?.title||note.topic.title};
 }

 /**
  * One demand by its ID. The Center has no such read, so this looks where the topic most likely is: a search by
  * the titles this vault knows it under, then, because the title may have changed at the Center, every demand of
  * its section. Null when the Center does not list it.
  */
 async find(id,{workspaceId,sectionId,titles=[]}){
  for(const title of [...new Set(titles.filter(Boolean))]){
   const rows=await this.client.demands({workspaceId,sectionId,search:title,limit:PAGE});
   const hit=(Array.isArray(rows)?rows:[]).find(row=>row.id===id);if(hit)return hit;
  }
  for(let page=0;page<MAX_PAGES;page++){
   const rows=await this.client.demands({workspaceId,sectionId,limit:PAGE,offset:page*PAGE});
   if(!Array.isArray(rows))return null;
   const hit=rows.find(row=>row.id===id);if(hit)return hit;
   if(rows.length<PAGE)return null;
  }
  return null;
 }

 /** Replace one note with the Center's version, discarding its unsaved edits. */
 async restore(path,registry){
  const content=await this.vault.read(path),note=content==null?null:noteToTopic(content,this.yaml.parse);
  if(!note?.id)throw fail('This note is not a topic of the Center','invalid_topic');
  const entry=await this.index.get(note.id);
  const demand=await this.find(note.id,{workspaceId:entry?.workspaceId||note.workspaceId,sectionId:entry?.sectionId||note.sectionId,titles:[entry?.base?.title,note.topic.title]});
  if(!demand)throw fail('The Center no longer lists this topic; update the topic pool','not_found');
  if(demand.state==='cancelled'){await this.vault.remove(path);await this.index.delete(note.id);return {state:'removed',id:note.id,title:demand.title};}
  await this.place(demand,registry,{path,expectedContent:content});
  return {state:'restored',id:note.id,title:demand.title};
 }

 /** Whether a note has edits the Center does not have yet. */
 async edited(path){
  const content=await this.vault.read(path);if(content==null)return false;
  let note;try{note=noteToTopic(content,this.yaml.parse);}catch{return true;}
  if(!note)return false;if(!note.id)return true;
  const entry=await this.index.get(note.id);
  return !entry||await topicFingerprint(note.topic)!==entry.fingerprint;
 }
}

/** One line for a notice after an update. */
export function pullSummary(summary){
 const parts=[];
 if(summary.added.length)parts.push(summary.added.length+' new');
 if(summary.updated.length)parts.push(summary.updated.length+' updated');
 if(summary.removed.length)parts.push(summary.removed.length+' withdrawn');
 if(summary.edited.length)parts.push(summary.edited.length+' with unsaved edits');
 if(summary.conflicts.length)parts.push(summary.conflicts.length+' changed on both sides');
 if(summary.failed.length)parts.push(summary.failed.length+' failed');
 return parts.length?parts.join(', '):'up to date';
}
