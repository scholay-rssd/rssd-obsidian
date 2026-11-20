// The Obsidian side of the topic pool: the vault setting that turns a vault into a pool vault, its commands, and
// the glue between the plugin and PoolSync. Kept apart from main.js so the works vault code is not touched.
//
// A pool vault is not bound to one space. It shows the open write demands of every space this device is
// authorized for under Topics/<space>/<section>/, lets a topic be edited while nobody has claimed it, queues a
// new note as a topic, and withdraws one. It never publishes and never writes a work.
import {PoolSync,pullSummary} from './pool-sync.mjs';
import {POOL_FOLDER} from './pool-model.mjs';
import {prefixedVault} from './vault-layout.mjs';

export const POOL_DEFAULTS={mode:'works'};
const HOUR=60*60*1000;
const REFUSALS={
 topic_repeat:'The Center already has this topic',read_only:'This topic can no longer be edited',demand_frozen:'This topic was claimed and can no longer be edited',
 revision_conflict:'This topic changed at the Center. Update the topic pool, or replace this note with the Center\'s version',
 claim_revoked:'This topic was claimed by a device and cannot be withdrawn here',no_section:'This note is not in a section folder',
 not_indexed:'Update the topic pool first',forbidden:'This device is not authorized for that space',migration_staged:'That space is still migrating and accepts no changes',
};
export const poolFailure=error=>(REFUSALS[error?.code]||'The topic pool could not do that')+': '+String(error?.message||error).slice(0,300);
export const isPoolVault=settings=>settings?.mode==='pool';
/** A vault whose key includes RSSD Center: each site's folder also holds that site's topics, under Topics/<section>/. */
export const isCenterVault=settings=>settings?.center===true&&settings?.layout==='spaces'&&settings?.mode!=='pool';
/** A works vault has a space; a pool vault has topics. Neither may be turned into the other in place. */
export const canBecomePool=settings=>!settings?.boundSpace&&!settings?.workspaceId&&!Object.values(settings?.baselines||{}).some(bucket=>Object.keys(bucket||{}).length);
export const canBecomeWorks=settings=>!Object.keys(settings?.pool?.entries||{}).length;

/** Where each topic's note is and what it was last in step with, kept in the plugin settings. */
export function poolIndex(settings,space=''){
 // A Center vault keeps one index per site, with paths inside that site's folder.
 const pool=()=>{const root=space?(settings().poolBySpace??={}):null,value=space?(root[space]??={entries:{},cursors:{}}):(settings().pool??={entries:{},cursors:{}});value.entries??={};value.cursors??={};return value;};
 return {get:async id=>pool().entries[id]??null,set:async(id,value)=>{pool().entries[id]=value;},delete:async id=>{delete pool().entries[id];},
  list:async()=>Object.values(pool().entries),cursor:async space=>pool().cursors[space]??null,setCursor:async(space,value)=>{pool().cursors[space]=value;}};
}

/**
 * Register the pool commands on `plugin`. `obsidian` passes the few Obsidian values this module needs
 * ({Notice,TFile,Platform,parseYaml,stringifyYaml}), which keeps it loadable in tests.
 */
export function installTopicPool(plugin,obsidian){
 const {Notice,TFile,Platform,parseYaml,stringifyYaml}=obsidian,app=plugin.app;
 const files={
  read:async path=>await app.vault.adapter.exists(path)?app.vault.adapter.read(path):null,
  write:async(path,content,{expectedContent=null}={})=>{
   await plugin.ensureFolder(path);const file=app.vault.getAbstractFileByPath(path);
   if(file instanceof TFile)await app.vault.process(file,current=>{if(current!==expectedContent)throw Object.assign(Error('The note changed while it was being written; local edits were kept'),{code:'local_edit_during_pull'});return content;});
   else{if(expectedContent!==null)throw Object.assign(Error('The note is gone; nothing was written'),{code:'local_edit_during_pull'});await app.vault.create(path,content);}
  },
  remove:async path=>{const file=app.vault.getAbstractFileByPath(path);if(file instanceof TFile)await app.fileManager.trashFile(file);},
 };
 // In a Center vault each site has its own pool: its folder is the pool's whole vault, and only its space is listed.
 const sync=(space='')=>new PoolSync({client:plugin.client(),vault:space?prefixedVault(files,plugin.layout().root(space)):files,yaml:{parse:parseYaml,stringify:stringifyYaml},index:poolIndex(()=>plugin.settings,space),space});
 const only=(registry,space)=>space?{...registry,workspaces:(registry?.workspaces||[]).filter(w=>w.id===space)}:registry;
 const enabled=()=>isPoolVault(plugin.settings)||isCenterVault(plugin.settings);
 // The topic note in front: {file, space, path} where path is inside the pool's vault.
 const active=()=>{
  const file=app.workspace.getActiveFile();if(!(file instanceof TFile)||file.extension!=='md')return null;
  if(isPoolVault(plugin.settings))return {file,space:'',path:file.path};
  if(!isCenterVault(plugin.settings))return null;
  const at=plugin.locate(file.path);return at?.rel.startsWith(POOL_FOLDER+'/')?{file,space:at.space,path:at.rel}:null;
 };
 const run=async(action,execute,done,space='')=>{
  try{
   if(!enabled())throw Error('This vault has no topics. A key that includes RSSD Center shows them, or choose "Topic pool" under Vault purpose.');
   const result=await plugin.operations.run(action,async()=>{try{return await execute(sync(space),only(await plugin.client().registry(),space));}finally{await plugin.saveSettings();}});
   new Notice(done(result),8000);return result;
  }catch(error){console.error('RSSD topic pool: '+action+' failed',error?.status,error?.code,error?.message);new Notice(poolFailure(error),10000);return null;}
 };
 const writable=()=>{if(Platform.isMobile)throw Error('RSSD is read-only on mobile');};
 const pool={
  update:({quiet=false}={})=>run('pool-update',async(engine,registry)=>{
    plugin.setStatus('RSSD: updating topics…');
    try{
     if(!isCenterVault(plugin.settings))return await engine.pull(registry);
     // A Center vault: every site in turn, each into its own folder.
     const total={added:[],updated:[],removed:[],conflicts:[],edited:[],failed:[],unchanged:0};
     for(const space of plugin.syncSpaces()){
      const part=await sync(space).pull(only(registry,space));
      for(const key of Object.keys(total))if(Array.isArray(total[key]))total[key].push(...part[key]);
      total.unchanged+=part.unchanged;
     }
     return total;
    }finally{plugin.setStatus(plugin.idleStatus());}
   },
   summary=>{const text=pullSummary(summary);return quiet&&text==='up to date'?'RSSD topic pool is up to date':'Topic pool: '+text+(summary.conflicts.length?'. Changed on both sides: '+summary.conflicts.slice(0,3).join('; '):'');}),
  save:({path,space})=>run('pool-save',async(engine,registry)=>{writable();return engine.save(path,registry);},
   result=>result.state==='unchanged'?'Nothing to save':result.state==='created'?'Queued as a new topic: '+result.title:'Topic saved: '+result.title,space),
  withdraw:({path,space})=>run('pool-withdraw',async engine=>{writable();return engine.withdraw(path);},result=>'Topic withdrawn: '+result.title,space),
  /** Whether a topic note has edits the Center does not have yet. Read only; no operation gate. */
  edited:async({path,space})=>{try{return await sync(space).edited(path);}catch{return false;}},
  /** The topic notes of this vault: {file, space, path} with path inside the pool's vault. */
  files:()=>app.vault.getMarkdownFiles().map(file=>{
   if(isPoolVault(plugin.settings))return file.path.startsWith(POOL_FOLDER+'/')?{file,space:'',path:file.path}:null;
   if(!isCenterVault(plugin.settings))return null;
   const at=plugin.locate(file.path);return at?.rel.startsWith(POOL_FOLDER+'/')?{file,space:at.space,path:at.rel}:null;
  }).filter(Boolean),
  enabled,
  restore:({path,space})=>run('pool-restore',async(engine,registry)=>engine.restore(path,registry),result=>result.state==='removed'?'The topic was withdrawn at the Center; its note was removed':'Replaced with the Center\'s version: '+result.title,space),
 };
 plugin.addCommand({id:'pool-update',name:'Update the topic pool',checkCallback:checking=>{if(!enabled())return false;if(!checking)void pool.update();return true;}});
 for(const [id,name,action] of [['pool-save','Save this topic to the Center',pool.save],['pool-withdraw','Withdraw this topic',pool.withdraw],['pool-restore','Replace this topic with the Center\'s version',pool.restore]])
  plugin.addCommand({id,name,checkCallback:checking=>{const topic=active();if(!topic)return false;if(!checking)void action(topic);return true;}});
 // A pool vault follows the Center on its own: once shortly after opening, then hourly. Saving stays a command.
 const follow=()=>{if(enabled()&&!plugin.settings.keyRevoked&&plugin.token()&&plugin.settings.origin&&!plugin.operations.active&&(isPoolVault(plugin.settings)||plugin.syncSpaces().length))void pool.update({quiet:true});};
 app.workspace.onLayoutReady(()=>{window.setTimeout(follow,5000);});
 plugin.registerInterval(window.setInterval(follow,HOUR));
 return pool;
}

/**
 * The pool rows of the settings tab: the vault's purpose, and in a pool vault the update button. Returns whether
 * this is a pool vault, so the caller leaves out the rows that only make sense for a space's works.
 */
export function poolSettingRows(containerEl,plugin,Setting){
 const s=plugin.settings,pool=isPoolVault(s),locked=pool?!canBecomeWorks(s):!canBecomePool(s);
 new Setting(containerEl).setName('Vault purpose')
  .setDesc(pool?'This vault is a topic pool: it shows the topics waiting to be written in every space this device is authorized for, under '+POOL_FOLDER+'/. Use a separate vault to edit a space\'s works.'
   :locked?'This vault holds the works of '+(s.boundSpace||s.workspaceId)+'. Use a separate, empty vault for the topic pool.':(s.layout==='spaces'?'Works of the spaces below':'Works of one space')+', or the topic pool of all spaces. Choose the topic pool only in a vault that holds no works.')
  .addDropdown(t=>{t.addOption('works',s.layout==='spaces'?'Works':'Works of one space');t.addOption('pool','Topic pool');t.setValue(pool?'pool':'works').setDisabled(locked).onChange(async value=>{
   if(plugin.operations.active||locked)return;s.mode=value==='pool'?'pool':'works';await plugin.saveSettings();plugin.setStatus(plugin.idleStatus());plugin.settingTab?.display?.();
  });});
 if(pool)new Setting(containerEl).setName('Update topics').setDesc('Bring new and changed topics into '+POOL_FOLDER+'/. A note with unsaved edits is never overwritten.')
  .addButton(b=>b.setButtonText('Update').onClick(()=>plugin.topicPool.update()));
 return pool;
}
