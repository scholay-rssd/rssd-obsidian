// Sync baselines live in the plugin settings, which Obsidian can only rewrite whole. A large space makes that
// file close to a megabyte, and a pull or a save changes one baseline at a time. Each change is therefore
// appended to a small journal first (still durable before the caller continues, so a pending request key is
// never lost) and the whole settings file is rewritten only at a checkpoint. Entries left by a session that
// ended before its checkpoint are replayed on load; replaying entries a checkpoint already holds is harmless
// because the last entry for a work is the value the checkpoint recorded.
const UNSAFE=new Set(['__proto__','constructor','prototype']);
const key=value=>typeof value==='string'&&value!==''&&!UNSAFE.has(value);

/** The baselines of one space and language; zh-CN keeps its original place in the settings. */
export function baselineBucket(settings,space,locale='zh-CN',create=false){
 if(locale==='zh-CN')return create?((settings.baselines??={})[space]??={}):settings.baselines?.[space];
 return create?(((settings.baselinesByLocale??={})[space]??={})[locale]??={}):settings.baselinesByLocale?.[space]?.[locale];
}

/** Apply one baseline change to the settings. Returns false for anything that is not a valid entry. */
export function applyEntry(settings,entry){
 if(!entry||typeof entry!=='object'||!key(entry.space)||!key(entry.id))return false;
 const locale=entry.locale??'zh-CN';if(!key(locale))return false;
 if(entry.op==='set'){
  if(!entry.value||typeof entry.value!=='object'||Array.isArray(entry.value))return false;
  settings.boundSpace=entry.space;baselineBucket(settings,entry.space,locale,true)[entry.id]=entry.value;return true;
 }
 if(entry.op==='delete'){const bucket=baselineBucket(settings,entry.space,locale);if(bucket)delete bucket[entry.id];return true;}
 return false;
}

/** Replay journal text in order. A line cut short by a crash was never acknowledged and is skipped. */
export function replay(settings,text){
 let applied=0;
 for(const line of String(text||'').split('\n')){
  if(!line.trim())continue;
  let entry;try{entry=JSON.parse(line);}catch{continue;}
  if(applyEntry(settings,entry))applied++;
 }
 return applied;
}

export class SettingsLog{
 /** `files` reads, appends to and removes the journal: read() → text or null, append(text), remove(). */
 constructor({settings,saveData,files,limit=500,now=Date.now}){
  Object.assign(this,{settings,saveData,files,limit,now});this.count=0;this.lastRecord=0;this.tail=Promise.resolve();
 }
 // Journal appends and whole-file writes share one lane, and a whole-file write takes its snapshot only when
 // its turn starts, so a slow earlier write cannot erase a later path guard or request key.
 enqueue(task){const next=this.tail.catch(()=>{}).then(task);this.tail=next;return next;}
 get pending(){return this.count>0;}
 /** Call once before the settings are used. A journal that exists but cannot be read is an error, not empty. */
 async load(){
  const text=await this.files.read();if(text==null)return 0;
  const applied=replay(this.settings(),text);
  // Even an empty or unreadable-line journal is removed by the next checkpoint.
  this.count=Math.max(1,applied);return applied;
 }
 /** Change one baseline. Resolves once the change would survive a restart. */
 record(entry){
  // Serialize now: the caller may reuse its objects after this returns.
  const line='\n'+JSON.stringify(entry)+'\n';
  if(!applyEntry(this.settings(),entry))return Promise.reject(Object.assign(Error('Invalid baseline record'),{code:'invalid_baseline'}));
  this.lastRecord=this.now();
  return this.enqueue(async()=>{
   if(this.count+1>=this.limit)return this.write();
   // Where the journal cannot be appended to, the whole settings file is still written as before.
   try{await this.files.append(line);this.count++;}catch{await this.write();}
  });
 }
 /** Rewrite the whole settings file and drop the journal it now covers. */
 checkpoint(){return this.enqueue(()=>this.write());}
 async write(){
  await this.saveData(structuredClone(this.settings()));
  // A journal that could not be removed stays replayable and is removed by a later checkpoint.
  if(this.count){try{await this.files.remove();this.count=0;}catch{}}
 }
}
