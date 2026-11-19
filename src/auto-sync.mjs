// A bounded in-memory scheduler. The catalog scan rediscovers local edits after
// restart; it never treats deletion or a rename as a remote delete.
import {renamedSiteId} from '../../contracts/site-renames.mjs';
// Give each known space its own two-minute slot after opening Obsidian, so open vaults do not all scan at once.
// `spaces` is the list of known space IDs in a stable order; the plugin passes the spaces of RSSD's
// sites/profiles.json, bundled at build time, so a new site gets a slot without touching this file. An unknown
// space takes a random slot. Edits still enter the regular debounce queue immediately. This is a fallback for
// hosts where Web Locks are unavailable or do not span vault windows.
export function startupDelay(space,spaces=[],random=Math.random){
 const known=[...new Set(spaces.map(renamedSiteId))],index=known.indexOf(renamedSiteId(space));
 const slot=index<0?Math.floor(random()*Math.max(known.length,10)):index;
 return 15000+slot*120000+Math.floor(random()*30000);
}
// Web Locks can coordinate same-origin windows where the host supports them;
// distinct browser partitions may not share the lock manager.
export function syncLease(locks,origin){
 if(!locks||typeof locks.request!=='function')return async run=>run();
 return async run=>{
  let entered=false;
  try{return await locks.request('rssd-auto-sync:'+origin,{mode:'exclusive',ifAvailable:true},lock=>{entered=true;return lock?run():false;});}
  catch(error){if(entered)throw error;return run();}
 };
}
// A work note, in a single-space vault or inside a space folder of a vault of several spaces.
const WORK_PATH=/^(?:[A-Za-z0-9][A-Za-z0-9.-]*\/)?Works\/(?:en\/)?[a-zA-Z0-9._:-]+\.md$/;
// A scan reports works by ID ("x", "en/x") in a single-space vault, or by their vault path ("…/Works/x.md").
const workPath=id=>id.endsWith('.md')?id:'Works/'+id+'.md';
export class AutoSync {
 constructor({save,pull,ready=()=>true,report=()=>{},now=Date.now,lease=async run=>run()}){
  Object.assign(this,{save,pull,ready,report,now,lease});this.dirty=new Map();this.blocked=new Set();this.fixable=new Set();this.waiting=new Set();this.sequence=0;this.running=false;this.stopped=false;
 }
 // A user edit. It lifts a block the edit may have fixed, never a conflict.
 mark(path){if(this.stopped||!WORK_PATH.test(path))return;
  if(this.fixable.delete(path))this.blocked.delete(path);
  const old=this.dirty.get(path);this.dirty.set(path,{generation:(old?.generation||0)+1,sequence:++this.sequence,attempts:0,next:this.now()+5000});
 }
 enqueue(path){if(!this.blocked.has(path)&&!this.dirty.has(path))this.dirty.set(path,{generation:1,attempts:0,next:this.now()});}
 // A private record is waiting for this note, so it is saved even when unchanged. Every scan finds the record
 // again, so a note is queued once per session, and again only after one of its saves went through. This is not
 // an edit: a refused note stays blocked, reported once, until the user edits it.
 queueWaiting(path){if(this.stopped||!WORK_PATH.test(path)||this.waiting.has(path))return;this.waiting.add(path);this.enqueue(path);}
 unblock(path){this.blocked.delete(path);this.fixable.delete(path);this.waiting.delete(path);}
 stop(){this.stopped=true;}
 async tick({scan=false}={}){
  if(this.stopped||this.running||!this.ready())return false;
  this.running=true;
  try{
   return await this.lease(async()=>{
   if(this.stopped||!this.ready())return false;
   let incomplete=false;
   if(scan){
    const result=await this.pull();
    for(const id of [...(result.skipped||[]),...(result.pending||[])])this.enqueue(workPath(id));
    for(const id of result.conflicts||[]){const path=workPath(id);this.blocked.add(path);this.fixable.delete(path);}
    if(result.conflicts?.length)this.report({error:Error(result.conflicts.length+' works have conflicts; local edits were kept')});
    if(result.failed?.length||result.metadataPending?.length){incomplete=true;this.report({error:Error('Some works could not be refreshed; the next scan will retry')});}
   }
   let n=0;
   // Recent user edits should not wait behind thousands of events caused by a
   // large pull; still check every path because real edits can happen during it.
   for(const [path,item] of [...this.dirty].sort((a,b)=>(b[1].sequence||0)-(a[1].sequence||0))){
    if(this.stopped||!this.ready()||n>=5)break;
    if(this.blocked.has(path)||item.next>this.now())continue;
    n++;
    try{
     const result=await this.save(path);
     if(result?.metadataWarning)this.report({path,error:Error(result.metadataWarning)});
     const current=this.dirty.get(path);
     // Recheck once after a save: the user may have edited while its request
     // was in flight, or the result may have recovered an earlier receipt.
     if(current===item){this.dirty.delete(path);if(result?.state==='saved'){this.waiting.delete(path);this.enqueue(path);}}
    }catch(error){
     if(error?.code==='operation_busy')break;
     const current=this.dirty.get(path);if(current!==item)continue;
     const retryable=error?.code==='network_error'||error?.code==='migration_staged'||error?.code==='staged_drafts_unavailable'||error?.code==='structured_draft_unavailable'||error?.code==='bounded_media_unavailable'||error?.retained||error?.status===408||error?.status===429||error?.status>=500;
     if(retryable){
      item.attempts++;item.next=this.now()+[60000,300000,900000][Math.min(item.attempts-1,2)];
      // Continue slowly after notifying once: an uncertain POST keeps its key,
      // and an offline workspace should recover without another edit.
      if(item.attempts===4)this.report({path,error});
     }else{
      this.blocked.add(path);this.dirty.delete(path);
      if(!error?.conflict&&error?.status!==409&&!['revision_conflict','staged_conflict','staged_base_changed','identity_conflict'].includes(error?.code))this.fixable.add(path);
      this.report({path,error});
     }
    }
   }
   return !incomplete;
   });
  }catch(error){if(error?.code!=='operation_busy')this.report({error});return false;}
  finally{this.running=false;}
 }
}
