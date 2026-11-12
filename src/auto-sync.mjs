// A bounded in-memory scheduler. The catalog scan rediscovers local edits after
// restart; it never treats deletion or a rename as a remote delete.
import {renamedSiteId} from '../../contracts/site-renames.mjs';
const SPACES=['academic','design','enter','legis','xsime','metho','personal','pets','study','xsiching'];
// Distribute the ten known vaults across twenty minutes after opening Obsidian.
// Edits still enter the regular debounce queue immediately. This is a fallback
// for hosts where Web Locks are unavailable or do not span vault windows.
export function startupDelay(space,random=Math.random){
 const index=SPACES.indexOf(renamedSiteId(space)),slot=index<0?Math.floor(random()*SPACES.length):index;
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
export class AutoSync {
 constructor({save,pull,ready=()=>true,report=()=>{},now=Date.now,lease=async run=>run()}){
  Object.assign(this,{save,pull,ready,report,now,lease});this.dirty=new Map();this.blocked=new Set();this.fixable=new Set();this.sequence=0;this.running=false;this.stopped=false;
 }
 mark(path){if(this.stopped||!/^Works\/(?:en\/)?[a-zA-Z0-9._:-]+\.md$/.test(path))return;
  if(this.fixable.delete(path))this.blocked.delete(path);
  const old=this.dirty.get(path);this.dirty.set(path,{generation:(old?.generation||0)+1,sequence:++this.sequence,attempts:0,next:this.now()+5000});
 }
 enqueue(path){if(!this.blocked.has(path)&&!this.dirty.has(path))this.dirty.set(path,{generation:1,attempts:0,next:this.now()});}
 unblock(path){this.blocked.delete(path);this.fixable.delete(path);}
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
    for(const id of [...(result.skipped||[]),...(result.pending||[])])this.enqueue(id.startsWith('en/')?'Works/'+id+'.md':'Works/'+id+'.md');
    for(const id of result.conflicts||[]){const path='Works/'+id+'.md';this.blocked.add(path);this.fixable.delete(path);}
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
     if(current===item){this.dirty.delete(path);if(result?.state==='saved')this.enqueue(path);}
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
