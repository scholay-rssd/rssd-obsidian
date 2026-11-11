// RSSD for Obsidian, stage 1: open a space from the RSSD Center as a vault of drafts, see each work's sync
// state, and save edits back as private drafts. Publishing is never done here.
import {Plugin,PluginSettingTab,Setting,Notice,Modal,requestUrl,parseYaml,stringifyYaml,Platform,TFile,normalizePath,ItemView,MarkdownRenderer,Component,Menu} from 'obsidian';
import {createCenterClient,centerOrigin} from './center-client.mjs';
import {OperationGate,automationRequest,recordedOperation,diagnosticError} from './operations.mjs';
import {deviceLogin} from './device-login.mjs';
import {SyncEngine} from './sync-engine.mjs';
import {StagedSyncEngine} from './staged-sync-engine.mjs';
import {canonicalPathIdentity,trackRename,trackDelete,confirmReturn} from './path-guard.mjs';
import {AutoSync,startupDelay,syncLease} from './auto-sync.mjs';
import {saveFailureMessage} from './messages.mjs';
import {spaceInfo,readOnlyReason,spacesSummary} from './spaces.mjs';
import {readerCatalog,filterCatalog,readerArticle,MEDIA_HOST} from './reader.mjs';
import {workLabel,labelText} from './titles.mjs';
import {SettingsLog,baselineBucket} from './settings-log.mjs';
import {wechatHtml,copyRich} from './wechat.mjs';
import {wechatTemplate,wechatSite,cardTemplate} from './wechat-template.mjs';
import {decorateWechat} from './wechat-designs.mjs';
import {buildCards} from './cards.mjs';
import {STATE_LABELS,WORKS_FOLDER,MEDIA_FOLDER,notePath,noteToWork} from './sync-model.mjs';

const TOKEN_SECRET='rssd-center-device-token';
// The Scholay Center. A build can point elsewhere with RSSD_DEFAULT_ORIGIN; the address stays editable until login.
export const DEFAULT_ORIGIN=typeof RSSD_DEFAULT_ORIGIN==='string'?RSSD_DEFAULT_ORIGIN:'https://post.linkc.cloud';
const DEFAULTS={origin:'',readerSpace:'',readerLocale:'zh-CN',readerDrafts:false,deviceName:'',workspaceId:'',baselines:{},baselinesByLocale:{},pathRecords:{},allowAutomation:false,autoSync:true,previewOpened:false};
const LOCALES=['zh-CN','en'];
// Work notes show their title and date; the stable ID file name stays underneath. The inline title and the
// header title are hidden for them because editing either one renames the file and would stop its sync.
const TITLE_STYLE=`
.rssd-work-note .inline-title,.rssd-work-note .view-header-title-parent,.rssd-work-note .view-header-title{display:none}
.rssd-work-header{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:var(--font-semibold);padding:0 var(--size-2-2)}
.rssd-preview-tabs{display:flex;gap:var(--size-2-1);padding:var(--size-4-1) var(--size-4-3) 0;border-bottom:1px solid var(--background-modifier-border)}
.rssd-preview-tabs.rssd-preview-styles{padding:0;border-bottom:0}
.rssd-preview-tab,.rssd-preview-tab:hover{padding:var(--size-2-2) var(--size-4-2);height:auto;border:0;border-bottom:2px solid transparent;border-radius:0;background:none;box-shadow:none;color:var(--text-muted);font-size:var(--font-ui-small);cursor:pointer}
.rssd-preview-tab.is-active{color:var(--text-normal);border-bottom-color:var(--interactive-accent);font-weight:var(--font-semibold)}
.rssd-preview-styles .rssd-preview-tab{font-size:var(--font-ui-smaller)}
/* The bar wraps in a narrow sidebar: style tabs and buttons share the first line, the status takes a line of its own. */
.rssd-preview-bar{display:flex;flex-wrap:wrap;align-items:center;gap:var(--size-2-2) var(--size-4-2);padding:var(--size-4-2) var(--size-4-3);border-bottom:1px solid var(--background-modifier-border)}
.rssd-preview-bar>button{flex:0 0 auto;white-space:nowrap}.rssd-preview-bar>button:first-of-type{margin-left:auto}
.rssd-preview-bar .rssd-preview-info{order:9;flex:1 0 100%;min-width:0;color:var(--text-muted);font-size:var(--font-ui-smaller);line-height:var(--line-height-tight)}
.rssd-preview-host{display:block}
.rssd-work-header .rssd-date,.nav-file-title-content .rssd-date{color:var(--text-faint);font-size:var(--font-ui-smaller);margin-right:.5em;font-variant-numeric:tabular-nums}
`;
const http=request=>requestUrl(request);

class CodeModal extends Modal{
 constructor(app,info){super(app);this.info=info;}
 onOpen(){
  const {contentEl}=this;contentEl.createEl('h3',{text:'Approve this device in your browser'});
  contentEl.createEl('p',{text:'Open the link, check the code and choose the spaces this vault may use.'});
  contentEl.createEl('p').createEl('a',{text:this.info.verificationUriComplete,href:this.info.verificationUriComplete});
  contentEl.createEl('h2',{text:this.info.userCode});
  contentEl.createEl('p',{text:'This window closes when you approve. Closing it cancels the login.'});
 }
 onClose(){this.contentEl.empty();this.onCancel?.();}
}

class WelcomeModal extends Modal{
 constructor(app,plugin){super(app);this.plugin=plugin;}
 onOpen(){
  const {contentEl}=this;contentEl.createEl('h3',{text:'Welcome to RSSD'});
  contentEl.createEl('p',{text:'Log in once to read your site\'s articles here. Your browser opens; sign in to RSSD and approve this device. Nothing is downloaded into the vault.'});
  contentEl.createEl('p',{text:'Center: '+this.plugin.settings.origin,cls:'setting-item-description'});
  new Setting(contentEl).addButton(b=>b.setButtonText('Log in to RSSD').setCta().onClick(async()=>{
   this.close();
   try{await this.plugin.login({openBrowser:true,selectSyncSpace:false});await this.plugin.openReader();}
   catch(error){if(error?.code!=='cancelled')new Notice('Login failed: '+error.message,10000);}
  })).addButton(b=>b.setButtonText('Later').onClick(()=>this.close()));
 }
 onClose(){this.contentEl.empty();}
}

export default class RssdPlugin extends Plugin{
 async onload(){
  this.settings=Object.assign({},DEFAULTS,await this.loadData());
  // Baseline changes a previous session journaled but had not yet folded into the settings file.
  await this.log().load();
  this.operations=new OperationGate();
  // An empty address before any login takes the default Center, so a new vault needs no typing.
  if(!this.settings.origin&&!this.token()&&!this.settings.boundSpace){this.settings.origin=DEFAULT_ORIGIN;this.settings.boundOrigin=DEFAULT_ORIGIN;}
  if(!this.settings.boundOrigin)this.settings.boundOrigin=this.settings.origin;
  this.settings.boundSpace??=Object.keys(this.settings.baselines).find(k=>Object.keys(this.settings.baselines[k]||{}).length)||'';
  await this.saveSettings();
  this.registerView('rssd-works',leaf=>new WorksView(leaf,this));
  this.addRibbonIcon('files','RSSD works',()=>this.openWorks());
  this.addCommand({id:'works',name:'Open RSSD works',callback:()=>this.openWorks()});
  this.registerView('rssd-reader',leaf=>new ReaderView(leaf,this));
  this.addRibbonIcon('book-open','RSSD reader',()=>this.openReader());
  this.addCommand({id:'reader',name:'Read site articles online',callback:()=>this.openReader()});
  this.status=this.addStatusBarItem();this.setStatus(this.idleStatus());
  // The status item is the quick way in: reading, works, sync and login in one menu.
  this.status.addClass('mod-clickable');this.status.setAttribute('aria-label','RSSD');
  this.registerDomEvent(this.status,'click',event=>this.statusMenu().showAtMouseEvent(event));
  this.addSettingTab(new RssdSettings(this.app,this));
  this.addCommand({id:'login',name:'Log in to the RSSD Center',callback:()=>this.login().catch(error=>new Notice('Login failed: '+error.message))});
  this.addCommand({id:'pull',name:'Pull works from the Center',callback:()=>this.pull()});
  this.addCommand({id:'save',name:'Save this work to the Center as a private draft',checkCallback:checking=>{
   const file=this.app.workspace.getActiveFile();if(!file||!this.isWork(file))return false;if(!checking)this.save(file);return true;}});
  this.addCommand({id:'copy-article',name:'Copy this work as a formatted article',checkCallback:checking=>{
   const file=this.app.workspace.getActiveFile();if(!file||!this.isWork(file))return false;if(!checking)void this.copyForWechat(file);return true;}});
  this.registerView('rssd-preview',leaf=>new LayoutPreview(leaf,this));
  // A panel saved under the preview's first name keeps working.
  this.registerView('rssd-wechat',leaf=>new LayoutPreview(leaf,this,'rssd-wechat'));
  this.addCommand({id:'preview-layout',name:'Preview this work\'s layout',checkCallback:checking=>{
   const file=this.app.workspace.getActiveFile();if(!file||!this.isWork(file))return false;if(!checking)void this.openPreview();return true;}});
  this.addCommand({id:'save-cards',name:'Save this work as cards',checkCallback:checking=>{
   const file=this.app.workspace.getActiveFile();if(!file||!this.isWork(file))return false;if(!checking)void this.saveCards(file);return true;}});
  this.addCommand({id:'status',name:'Check sync state of all works',callback:()=>this.refreshStates()});
  this.addCommand({id:'spaces',name:'Show which spaces accept saves',callback:()=>this.showSpaces()});
  // obsidian://rssd?vault=<vault>&do=login|pull|save|status|spaces[&path=Works/x.md] lets scripts and agents drive
  // the plugin. Any app or page can open such a link, so it only works when the vault opts in.
  this.registerObsidianProtocolHandler('rssd',params=>this.automate(params));
  this.titleStyle=document.head.createEl('style',{text:TITLE_STYLE});
  const relabel=()=>{window.clearTimeout(this.titleTimer);this.titleTimer=window.setTimeout(()=>this.refreshTitles(),150);};
  this.app.workspace.onLayoutReady(relabel);
  for(const event of ['changed','resolved'])this.registerEvent(this.app.metadataCache.on(event,relabel));
  for(const event of ['layout-change','file-open','active-leaf-change'])this.registerEvent(this.app.workspace.on(event,relabel));
  for(const event of ['create','rename','delete'])this.registerEvent(this.app.vault.on(event,relabel));
  // First launch: one button logs in and opens the reader. Afterwards the reader opens from the ribbon.
  // A vault that edits works gets the layout preview in its sidebar the first time it starts with this version.
  this.app.workspace.onLayoutReady(()=>{void this.autoOpenPreview().catch(error=>console.error('RSSD layout preview',error));});
  this.app.workspace.onLayoutReady(()=>{if(!this.token())new WelcomeModal(this.app,this).open();});
  this.autoSync=new AutoSync({
   ready:()=>this.settings.autoSync!==false&&!!this.settings.origin&&!!this.settings.workspaceId&&!!this.token()&&!this.operations.active,
   lease:run=>{let locks;try{locks=globalThis.navigator?.locks;}catch{}return syncLease(locks,this.settings.origin)(run);},
   pull:()=>this.operations.run('automatic-pull',()=>this.pullAll(this.settings.workspaceId)),
   save:path=>this.operations.run('automatic-save',async()=>{const engine=this.engine(),space=this.settings.workspaceId;if(!await engine.hasLocalChanges(space,path))return {state:'unchanged'};return this.saveWork(space,path,engine);}),
   report:({path,error})=>{console.error('RSSD automatic sync',path||'',error?.code||'',error?.message||error);new Notice('RSSD automatic sync needs attention'+(path?' for '+path:'')+': '+saveFailureMessage(error),10000);}
  });
  this.registerEvent(this.app.vault.on('modify',file=>{if(!(file instanceof TFile))return;if(this.isWork(file))this.autoSync.mark(file.path);else if(file.path.startsWith(MEDIA_FOLDER+'/'))void this.markMedia(file.path);}));
  this.registerEvent(this.app.vault.on('create',file=>{if(file instanceof TFile&&this.isWork(file)){if(canonicalPathIdentity(file.path))this.autoSync.mark(file.path);else new Notice('RSSD: this new note is not linked to a Center work and has not been synced.',10000);}}));
  this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{if(file instanceof TFile)void this.recordPathChange('rename',oldPath,file.path);}));
  this.registerEvent(this.app.vault.on('delete',file=>{if(file instanceof TFile)void this.recordPathChange('delete',file.path);}));
  // Stagger open vaults; each successful scan repeats hourly. The scan also
  // rediscovers changes made while Obsidian was closed.
  let nextScan=Date.now()+startupDelay(this.settings.workspaceId);
  this.registerInterval(window.setInterval(()=>{
   // Fold journaled baselines into the settings file once saving has been quiet for half a minute.
   if(this.log().pending&&!this.operations.active&&Date.now()-this.log().lastRecord>30000)void this.saveSettings().catch(()=>{});
   if(this.autoSync.running||!this.autoSync.ready())return;const scan=Date.now()>=nextScan;if(scan)nextScan=Date.now()+300000;void this.autoSync.tick({scan}).then(ok=>{if(scan&&ok)nextScan=Date.now()+3600000;});},10000));
 }
 async writeRun(record){
  try{await this.app.vault.adapter.write(this.manifest.dir+'/last-run.json',JSON.stringify({...record,at:new Date().toISOString()},null,2));}catch{}
 }
 async automate(params){
  try {
   if(!this.settings.allowAutomation)throw Object.assign(Error('Command links are off for this vault'),{code:'automation_off'});
   const request={...automationRequest(params),origin:centerOrigin(this.settings.origin),workspaceId:this.settings.workspaceId},directory=this.manifest.dir+'/runs';
   if(!await this.app.vault.adapter.exists(directory))await this.app.vault.adapter.mkdir(directory);
   const record=await this.operations.run(request.action,()=>recordedOperation({request,
    read:async id=>{const p=directory+'/'+id+'.json';return await this.app.vault.adapter.exists(p)?JSON.parse(await this.app.vault.adapter.read(p)):null;},
    write:async record=>{await this.app.vault.adapter.write(directory+'/'+record.id+'.json',JSON.stringify(record,null,2));await this.writeRun(record);},
    execute:async()=>{
     const space=this.settings.workspaceId;
     if(request.action==='login')return this.performLogin({openBrowser:true});
     if(request.action==='pull')return this.pullAll(space);
     if(request.action==='status')return this.statesAll(space);
     if(request.action==='spaces')return (await this.client().registry()).workspaces?.map(w=>({id:w.id,writable:w.writable===true,migrationState:w.migrationState??null}));
     return this.saveWork(space,request.path);
    }}));
   new Notice('RSSD '+request.action+': '+(record.error||record.state));
  }catch(error){new Notice('RSSD: '+error.message);}
 }
 async assertWritable(){
  if(Platform.isMobile)throw Error('RSSD is read-only on mobile');
  const reason=readOnlyReason(spaceInfo(await this.client().registry(),this.settings.workspaceId),this.settings.workspaceId);
  if(reason)throw Object.assign(Error(reason),{code:'migration_staged'});
 }
 async saveWork(space,path,engine=this.engine()){
  if(Platform.isMobile)throw Error('RSSD is read-only on mobile');
  const info=spaceInfo(await this.client().registry(),space);
  if(!info.found)throw Object.assign(Error(readOnlyReason(info,space)),{code:'forbidden'});
  if(info.writable){
   const local=await engine.noteFingerprint(path);
   if(local){const base=await engine.store.get(space,local.work.data.id,local.work.data.locale);if(base?.staged||base?.pending?.kind==='staged')await new StagedSyncEngine({engine}).promote(space,local.work.data.id,local.work.data.locale);}
   return engine.save(space,path);
  }
  if(info.migrationState==='staged')return new StagedSyncEngine({engine}).save(space,path);
  throw Object.assign(Error(readOnlyReason(info,space)),{code:'migration_staged'});
 }
 assertBinding(){
  if(centerOrigin(this.settings.origin)!==centerOrigin(this.settings.boundOrigin||this.settings.origin))throw Error('This login belongs to a different Center. Use a separate vault.');
  if(this.settings.boundSpace&&this.settings.workspaceId!==this.settings.boundSpace)throw Error('This vault is bound to '+this.settings.boundSpace+'. Open a separate vault for another space.');
 }
 async openReader(){
  if(!this.token()){new WelcomeModal(this.app,this).open();return;}
  const leaf=this.app.workspace.getLeavesOfType('rssd-reader')[0]||this.app.workspace.getLeaf('tab');
  await leaf.setViewState({type:'rssd-reader',active:true});this.app.workspace.revealLeaf(leaf);
 }
 /** Reading needs only the login's Center, not the vault's sync space. */
 readClient(){
  if(centerOrigin(this.settings.origin)!==centerOrigin(this.settings.boundOrigin||this.settings.origin))throw Error('This login belongs to a different Center. Use a separate vault.');
  const token=this.token();if(!token||!this.settings.origin)throw Error('Log in to RSSD first');
  return createCenterClient({http,origin:this.settings.origin,token});
 }
 async openWorks(){const leaf=this.app.workspace.getLeavesOfType('rssd-works')[0]||this.app.workspace.getRightLeaf(false);await leaf.setViewState({type:'rssd-works',active:true});this.app.workspace.revealLeaf(leaf);}
 isWork(file){return file.extension==='md'&&file.path.startsWith(WORKS_FOLDER+'/');}
 setStatus(text){this.status?.setText(text);}
 idleStatus(){return this.token()?'RSSD'+(this.settings.workspaceId?' · '+this.settings.workspaceId:''):'RSSD · log in';}
 statusMenu(){
  const menu=new Menu(),loggedIn=!!this.token(),space=this.settings.workspaceId,active=this.app.workspace.getActiveFile();
  const login=()=>this.login({openBrowser:true,selectSyncSpace:false}).then(()=>this.setStatus(this.idleStatus())).catch(error=>{if(error?.code!=='cancelled')new Notice('Login failed: '+error.message,10000);});
  if(!loggedIn)menu.addItem(item=>item.setTitle('Log in to RSSD').setIcon('log-in').onClick(login));
  menu.addItem(item=>item.setTitle('Read site articles online').setIcon('book-open').onClick(()=>this.openReader()));
  if(loggedIn&&space){
   menu.addItem(item=>item.setTitle('Open RSSD works').setIcon('files').onClick(()=>this.openWorks()));
   menu.addItem(item=>item.setTitle('Pull works from the Center').setIcon('download').onClick(()=>this.pull()));
   if(active&&this.isWork(active))menu.addItem(item=>item.setTitle('Save this work as a private draft').setIcon('upload').onClick(()=>this.save(active)));
   menu.addItem(item=>item.setTitle('Check sync state').setIcon('refresh-cw').onClick(()=>this.refreshStates()));
  }
  if(active&&this.isWork(active)){
   menu.addItem(item=>item.setTitle('Preview layout').setIcon('eye').onClick(()=>this.openPreview()));
   menu.addItem(item=>item.setTitle('Copy as formatted article').setIcon('copy').onClick(()=>this.copyForWechat(active)));
  }
  menu.addSeparator();
  if(loggedIn)menu.addItem(item=>item.setTitle('Log in again').setIcon('log-in').onClick(login));
  menu.addItem(item=>item.setTitle('RSSD settings').setIcon('settings').onClick(()=>{const setting=this.app.setting;setting?.open();setting?.openTabById(this.manifest.id);}));
  return menu;
 }
 token(){return this.app.secretStorage.getSecret(TOKEN_SECRET);}
 saveSettings(){
  // Vault events and sync receipts may update different parts of settings at
  // once. Serialize writes and take the snapshot only when its turn starts so
  // a slow earlier write cannot erase a later path guard or request key.
  return this.log().checkpoint();
 }
 /** Baseline changes go to a small journal; the whole settings file is rewritten only at checkpoints. */
 log(){
  if(!this.settingsLog){
   const adapter=()=>this.app.vault.adapter,path=()=>this.manifest.dir+'/baselines.journal';
   this.settingsLog=new SettingsLog({settings:()=>this.settings,saveData:snapshot=>this.saveData(snapshot),files:{
    read:async()=>await adapter().exists(path())?adapter().read(path()):null,
    append:text=>adapter().append(path(),text),
    remove:async()=>{if(await adapter().exists(path()))await adapter().remove(path());},
   }});
  }
  return this.settingsLog;
 }

 engine(){
  this.assertBinding();
  const token=this.token();if(!token||!this.settings.origin)throw Error('Log in to the RSSD Center first');
  if(!this.settings.workspaceId)throw Error('Choose a space in the RSSD settings');
  const adapter=this.app.vault.adapter,vault=this.app.vault;
  return new SyncEngine({
   client:createCenterClient({http,origin:this.settings.origin,token}),
   pathRecords:()=>this.settings.pathRecords||{},
   yaml:{parse:parseYaml,stringify:stringifyYaml},
   vault:{
    read:async path=>await adapter.exists(path)?adapter.read(path):null,
    readBinary:async path=>await adapter.exists(path)?new Uint8Array(await adapter.readBinary(path)):null,
    write:async(path,content,{expectedContent=null}={})=>{await this.ensureFolder(path);const file=vault.getAbstractFileByPath(path);if(file instanceof TFile)await vault.process(file,current=>{if(current!==expectedContent)throw Object.assign(Error('Local edits were kept'),{code:'local_edit_during_pull'});return content;});else{if(expectedContent!==null)throw Object.assign(Error('The local file was moved or removed'),{code:'local_edit_during_pull'});await vault.create(path,content);}},
    writeBinary:async(path,bytes)=>{await this.ensureFolder(path);if(!await adapter.exists(path))await vault.createBinary(path,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));},
   },
   store:{
    get:async(space,id,locale='zh-CN')=>baselineBucket(this.settings,space,locale)?.[id]??null,
    set:(space,id,value,locale='zh-CN')=>this.log().record({op:'set',space,id,locale,value}),
    delete:(space,id,locale='zh-CN')=>this.log().record({op:'delete',space,id,locale}),
    list:async(space,locale='zh-CN')=>Object.values(baselineBucket(this.settings,space,locale)||{}),
   },
  });
 }
 async pullAll(space,{onProgress=()=>{}}={}){
  const summary={downloaded:[],updated:[],skipped:[],conflicts:[],pending:[],failed:[],metadataPending:[],unchanged:0,removedFromCenter:[],transportByLocale:{}},engine=this.engine();
  const info=spaceInfo(await this.client().registry(),space);
  if(!info.found)throw Object.assign(Error(readOnlyReason(info,space)),{code:'forbidden'});
  try{
  for(const locale of LOCALES){
   if(info.writable){
    for(const base of await engine.store.list(space,locale))if(base.staged||base.pending?.kind==='staged'){
     try{await new StagedSyncEngine({engine}).promote(space,base.articleId,locale);}
     catch(error){if(error?.code==='network_error'||error?.retained||error?.status>=500)throw error;const id=locale==='zh-CN'?base.articleId:locale+'/'+base.articleId;if(!summary.conflicts.includes(id))summary.conflicts.push(id);}
    }
   }
   const result=await engine.pull(space,{locale,onProgress:progress=>onProgress({...progress,locale})});
   for(const key of ['downloaded','updated','skipped','conflicts','pending','metadataPending','removedFromCenter'])summary[key].push(...(result[key]||[]).map(id=>locale==='zh-CN'?id:locale+'/'+id));
   summary.failed.push(...(result.failed||[]).map(item=>({...item,locale})));summary.unchanged+=result.unchanged||0;
   summary.transportByLocale[locale]=result.transport;
   if(!info.writable&&info.migrationState==='staged'){
    const overlay=await new StagedSyncEngine({engine}).pull(space,{locale});
    for(const key of ['updated','conflicts','pending'])for(const id of overlay[key]||[]){const name=locale==='zh-CN'?id:locale+'/'+id;if(!summary[key].includes(name))summary[key].push(name);}
   }
  }
  return summary;
  // Fold this pull's journal into the settings file. If that fails the journal still holds every change.
  }finally{if(this.log().pending)await this.saveSettings().catch(()=>{});}
 }
 async statesAll(space){
  const states={},engine=this.engine();
  for(const locale of LOCALES)for(const [id,state] of Object.entries(await engine.states(space,{locale})))states[notePath(id,locale)]=state;
  return states;
 }
 async ensureFolder(path){
  const folder=path.split('/').slice(0,-1).join('/');
  if(folder&&!await this.app.vault.adapter.exists(folder))await this.app.vault.createFolder(folder);
 }
 async recordPathChange(action,oldPath,newPath){
  try{
   const records=this.settings.pathRecords||{},identity=canonicalPathIdentity(oldPath),space=this.settings.workspaceId;
   const tracked=Object.values(records).some(item=>item?.currentPath===oldPath);
   const bucket=identity&&(identity.locale==='zh-CN'?this.settings.baselines?.[space]:this.settings.baselinesByLocale?.[space]?.[identity.locale]);
   if(!tracked&&(!identity||!bucket?.[identity.articleId]))return;
   let next=action==='rename'?trackRename(records,oldPath,newPath):trackDelete(records,oldPath);
   this.settings.pathRecords=next;await this.saveSettings();
   if(action==='rename'){
    const entry=Object.values(next).find(item=>item?.currentPath===newPath&&item?.state==='verify_return');
    if(entry){const text=await this.app.vault.adapter.read(newPath),work=noteToWork(text,parseYaml);next=confirmReturn(next,{articleId:entry.articleId,locale:entry.locale,path:newPath,observedArticleId:work?.data.id,observedLocale:work?.data.locale});this.settings.pathRecords=next;await this.saveSettings();this.autoSync?.unblock(newPath);this.autoSync?.mark(newPath);return;}
   }
   new Notice('RSSD: a linked work was moved or removed locally. Its Center copy was not deleted; return it to its original path to resume sync.',10000);
  }catch(error){console.error('RSSD path protection',error);new Notice('RSSD could not verify a moved work; its local changes were kept.',10000);}
 }
 async markMedia(path){
  const name=path.slice((MEDIA_FOLDER+'/').length);if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(name))return;
  const space=this.settings.workspaceId,adapter=this.app.vault.adapter;
  for(const locale of LOCALES){
   const bucket=locale==='zh-CN'?this.settings.baselines?.[space]:this.settings.baselinesByLocale?.[space]?.[locale];
   for(const base of Object.values(bucket||{})){
    const workPath=notePath(base.articleId,locale);
    try{if(await adapter.exists(workPath)&&noteToWork(await adapter.read(workPath),parseYaml)?.media.includes(name))this.autoSync.mark(workPath);}catch(error){console.error('RSSD media scan failed',workPath,error);}
   }
  }
 }

 async login(options={}){return this.operations.run('login',async()=>{const id=crypto.randomUUID();await this.writeRun({id,action:'login',state:'running',ok:null});try{const result=await this.performLogin(options);await this.writeRun({id,action:'login',state:'completed',ok:true,result});return result;}catch(error){await this.writeRun({id,action:'login',state:'failed',ok:false,error:error.message,code:error.code||null,status:error.status||null});throw error;}});}
 async performLogin({openBrowser=false,selectSyncSpace=true}={}){
  this.assertBinding();
  const origin=centerOrigin(this.settings.origin),space=this.settings.workspaceId,controller=new AbortController();
  this.loginController=controller;let modal;
  try{
   const result=await deviceLogin({http,origin,name:this.settings.deviceName||('Obsidian on '+(Platform.isMobile?'mobile':'desktop')),signal:controller.signal,
    onCode:info=>{modal=new CodeModal(this.app,info);modal.onCancel=()=>controller.abort();modal.open();if(openBrowser)window.open(info.verificationUriComplete);}});
   const spaces=result.identity?.workspaceIds||[];
   if(space&&!spaces.includes(space))throw Error('This device was not approved for '+space);
   if(centerOrigin(this.settings.origin)!==origin||this.settings.workspaceId!==space)throw Error('Connection changed during login; start again');
   createCenterClient({http,origin,token:result.token});
   this.app.secretStorage.setSecret(TOKEN_SECRET,result.token);
   this.settings.boundOrigin=origin;
   // Choosing a sync space starts downloading works into the vault; reader logins leave that to Settings.
   if(selectSyncSpace&&!space&&spaces.length===1)this.settings.workspaceId=spaces[0];
   this.settings.spaces=spaces;await this.saveSettings();
   new Notice('Logged in to the RSSD Center');this.setStatus(this.idleStatus());
   return {loggedIn:true,spaces};
  }finally{if(modal){modal.onCancel=null;modal.close();}this.loginController=null;}
 }
 onunload(){this.autoSync?.stop();this.loginController?.abort();window.clearTimeout(this.titleTimer);this.refreshTitles({restore:true});this.titleStyle?.remove();}
 workLabel(file){return file instanceof TFile&&this.isWork(file)?workLabel(this.app.metadataCache.getFileCache(file)?.frontmatter):null;}
 /** Paint titles and dates over ID file names in the explorer, tabs and note headers. Never renames a file. */
 refreshTitles({restore=false}={}){
  try{
   for(const leaf of this.app.workspace.getLeavesOfType('file-explorer')){
    for(const [path,item] of Object.entries(leaf.view?.fileItems||{})){
     const el=item?.innerEl;if(!el||!path.startsWith(WORKS_FOLDER+'/'))continue;
     const label=restore?null:this.workLabel(item.file),key=label?label.title+'\n'+label.date:'';
     if(label){
      if(el.dataset.rssdLabel===key&&el.querySelector('.rssd-title'))continue;
      el.empty();if(label.date)el.createSpan({cls:'rssd-date',text:label.date});el.createSpan({cls:'rssd-title',text:label.title});
      el.dataset.rssdLabel=key;item.selfEl?.setAttribute('aria-label',path);
     }else if(el.dataset.rssdLabel!==undefined){delete el.dataset.rssdLabel;el.setText(item.file?.basename||path.split('/').at(-1).replace(/\.md$/,''));item.selfEl?.removeAttribute('aria-label');}
    }
   }
   for(const leaf of this.app.workspace.getLeavesOfType('markdown')){
    const view=leaf.view,file=view?.file,label=restore?null:this.workLabel(file);
    view?.containerEl?.toggleClass('rssd-work-note',!!label);
    const container=view?.titleContainerEl||view?.containerEl?.querySelector('.view-header-title-container');
    let header=container?.querySelector('.rssd-work-header');
    if(label&&container){
     if(!header)header=container.createDiv({cls:'rssd-work-header'});
     header.empty();if(label.date)header.createSpan({cls:'rssd-date',text:label.date});header.createSpan({text:label.title});
     header.setAttribute('aria-label',file.path);
    }else header?.remove();
    const tab=leaf.tabHeaderInnerTitleEl;
    if(tab&&label)tab.setText(labelText(label));else if(tab&&restore&&file)tab.setText(file.basename);
   }
  }catch(error){console.error('RSSD titles',error);}
 }
 async pull(){
  try{
   const summary=await this.operations.run('pull',async()=>{
    let checked=0,lastProgress;const id=crypto.randomUUID(),workspaceId=this.settings.workspaceId;
    this.setStatus('RSSD: pulling…');
    await this.writeRun({id,action:'pull',workspaceId,state:'running',ok:null,checked});
    try{
     const result=await this.pullAll(workspaceId,{onProgress:async({articleId,summary,locale})=>{
      this.setStatus('RSSD: pulling… '+(++checked)+' works');
      lastProgress={articleId,locale,partial:summary};
      await this.writeRun({id,action:'pull',workspaceId,state:'running',ok:null,checked,articleId,locale,partial:summary});
     }});
     const incomplete=['failed','conflicts','pending','metadataPending'].some(key=>result[key]?.length);
     await this.writeRun({id,action:'pull',workspaceId,state:incomplete?'partial':'completed',ok:!incomplete,checked,result});
     return result;
    }catch(error){
     await this.writeRun({id,action:'pull',workspaceId,state:'failed',ok:false,checked,...lastProgress,...(error.pullSummary?{partial:error.pullSummary}:{}),...diagnosticError(error)});
     throw error;
    }
    finally{this.setStatus(this.idleStatus());}
   });
   const parts=[summary.downloaded.length+' new',summary.updated.length+' updated',summary.unchanged+' unchanged'];
   if(summary.skipped.length)parts.push(summary.skipped.length+' kept (local changes)');
   if(summary.conflicts.length)parts.push(summary.conflicts.length+' in conflict');
   if(summary.pending?.length)parts.push(summary.pending.length+' waiting for save recovery');
   if(summary.metadataPending?.length)parts.push(summary.metadataPending.length+' local version labels need refresh');
   if(summary.failed?.length)parts.push(summary.failed.length+' failed; pull again to retry');
   const incomplete=['failed','conflicts','pending','metadataPending'].some(key=>summary[key]?.length);
   new Notice((incomplete?'Pull incomplete: ':'Pull finished: ')+parts.join(', '));
   if(summary.conflicts.length)new Notice('Conflicts were not changed: '+summary.conflicts.join(', '),10000);
  }catch(error){new Notice('Pull failed: '+error.message);}
 }

 client(){
  this.assertBinding();
  const token=this.token();if(!token||!this.settings.origin)throw Error('Log in to the RSSD Center first');
  return createCenterClient({http,origin:this.settings.origin,token});
 }
 async showSpaces(){
  const id=crypto.randomUUID(),workspaceId=this.settings.workspaceId;
  try{
   const registry=await this.operations.run('spaces',async()=>{
    const origin=centerOrigin(this.settings.origin),record={id,action:'spaces',path:'',origin,workspaceId};
    await this.writeRun({...record,state:'running',ok:null});
    try{
     const value=await this.client().registry();
     const result=value.workspaces?.map(w=>({id:w.id,writable:w.writable===true,migrationState:w.migrationState??null}));
     await this.writeRun({...record,state:'completed',ok:true,result});return value;
    }catch(error){await this.writeRun({...record,state:'failed',ok:false,...diagnosticError(error)});throw error;}
   });
   let stagedDraftsAvailable=false;
   const staged=registry.workspaces?.find(w=>w.writable===false&&w.migrationState==='staged');
   if(staged){try{stagedDraftsAvailable=(await this.client().stagedSite(staged.id)).capabilities?.includes('staged-drafts-v1')===true;}catch{}}
   new Notice(spacesSummary(registry,{stagedDraftsAvailable}),15000);
  }catch(error){new Notice('Could not read spaces: '+error.message);}
 }
 async save(file){
  try{
   const result=await this.operations.run('save',async()=>this.saveWork(this.settings.workspaceId,file.path));
   this.autoSync?.unblock(file.path);
   new Notice(result.state==='unchanged'?'Nothing to save':result.stagedRevision?'Saved as a private migration draft (revision '+result.stagedRevision+'). It is not published.':'Saved as a private draft (revision '+result.revision+'). It is not published.');
   if(result.metadataWarning)new Notice('The draft was saved, but its local version label could not be refreshed: '+result.metadataWarning,10000);
  }catch(error){
   console.error('RSSD save failed',error.status,error.code,error.message);
   new Notice(saveFailureMessage(error),10000);
  }
 }

 /** A work as a styled article for pasting into a rich-text editor (the WeChat official-account editor is
  * the one it is tuned for). Reads the note; changes nothing. */
 async wechatResult(file,content,{style='site'}={}){
  const component=new Component();component.load();
  try{
   const adapter=this.app.vault.adapter;content??=await this.app.vault.read(file);
   // Each space and section has its own colours and fonts, the same ones its public page uses.
   // 'plain' keeps the section's colours and fonts but leaves out the site's chapter openings and name marks.
   const space=this.settings.workspaceId,site=style==='plain'?null:wechatSite(space);
   return await wechatHtml({doc:document,content,parseYaml,template:source=>wechatTemplate(space,source.sectionId),
    decorate:(html,{look,source})=>decorateWechat(document,html,{site,look,category:source.category}),
    pack:{site:wechatSite(space)||{id:space||'unknown',name:''},style,engineVersion:this.manifest?.version||'0',...this.noteVersions(file)},
    render:(markdown,el)=>MarkdownRenderer.render(this.app,markdown,el,file.path,component),
    readMedia:async name=>{const path=MEDIA_FOLDER+'/'+name;return await adapter.exists(path)?new Uint8Array(await adapter.readBinary(path)):null;}});
  }finally{component.unload();}
 }
 /** The Center versions a note records in its properties, for an output's manifest. */
 noteVersions(file){
  const properties=this.app.metadataCache?.getFileCache(file)?.frontmatter||{},integer=value=>Number.isSafeInteger(value)?value:null;
  return {version:integer(properties['rssd-version']),publishedVersion:integer(properties['rssd-published-version'])};
 }
 /** Puts the styled article on the clipboard only. Nothing is sent to the Center or to any platform. */
 async copyForWechat(file,options={}){
  try{
   const result=await this.wechatResult(file,undefined,options);
   await copyRich(result);
   new Notice('Copied as a formatted article'+(result.images?' with '+result.images+(result.images===1?' image':' images'):'')+'. Paste it into your editor; the title is not part of it and goes in the editor\'s own title field.',8000);
   if(result.missing.length)new Notice('Left out '+result.missing.length+' image'+(result.missing.length===1?'':'s')+' not found in '+MEDIA_FOLDER+'/: '+result.missing.join(', '),10000);
   return result;
  }catch(error){console.error('RSSD article copy',error);new Notice('Could not copy the article: '+error.message,10000);}
 }
 /** A work as picture cards (1080×1440 PNG). Reads the note and its images; changes nothing. */
 async cardsResult(file,content,{style='site',signal,onProgress}={}){
  const component=new Component();component.load();
  try{
   const adapter=this.app.vault.adapter;content??=await this.app.vault.read(file);
   const space=this.settings.workspaceId,site=wechatSite(space);
   return await buildCards({doc:document,content,parseYaml,signal,onProgress,style,site,url:site?.origin||centerOrigin(this.settings.origin),
    template:source=>cardTemplate(space,source.sectionId),engineVersion:this.manifest?.version||'0',...this.noteVersions(file),
    render:(markdown,el)=>MarkdownRenderer.render(this.app,markdown,el,file.path,component),
    readMedia:async name=>{const path=MEDIA_FOLDER+'/'+name;return await adapter.exists(path)?new Uint8Array(await adapter.readBinary(path)):null;},
    // The page engine measures in a document of its own, kept off screen.
    frame:()=>{const frame=document.createElement('iframe');frame.setAttribute('aria-hidden','true');frame.tabIndex=-1;frame.style.cssText='position:fixed;left:-10000px;top:0;width:720px;height:960px;border:0;visibility:hidden';document.body.append(frame);return frame;}});
  }finally{component.unload();}
 }
 /** Writes the cards as a package into the vault: the pictures, their caption and the manifest. Nothing is sent anywhere. */
 async saveCards(file,result){
  try{
   result??=await this.cardsResult(file);
   const adapter=this.app.vault.adapter,folder=normalizePath('Exports/cards/'+file.basename);
   for(const part of ['Exports','Exports/cards',folder])if(!await adapter.exists(part))await adapter.mkdir(part);
   // A shorter set must not leave pages of an earlier, longer one behind.
   const keep=new Set(result.pages.map(page=>page.name));
   for(const path of (await adapter.list(folder)).files){const name=path.split('/').at(-1);if(/^\d+\.png$/.test(name)&&!keep.has(name))await adapter.remove(path);}
   for(const page of result.pages)await adapter.writeBinary(folder+'/'+page.name,await page.blob.arrayBuffer());
   await adapter.write(folder+'/caption.txt',result.caption);
   await adapter.write(folder+'/manifest.json',JSON.stringify(result.manifest,null,2));
   new Notice('Saved '+result.pages.length+(result.pages.length===1?' card':' cards')+' to '+folder+'/ with the caption and manifest.',10000);
   return folder;
  }catch(error){console.error('RSSD cards save',error);new Notice('Could not save the cards: '+error.message,10000);}
 }
 /**
  * Open the layout preview once per vault, on the first start with this version. Only vaults bound to a sync
  * space (they hold works) get it, never on mobile, and never again after that: closing it is respected.
  * Returns true when it opened the panel.
  */
 async autoOpenPreview(){
  if(this.settings.previewOpened||!this.settings.workspaceId||Platform.isMobile)return false;
  const workspace=this.app.workspace,present=workspace.getLeavesOfType('rssd-preview').length+workspace.getLeavesOfType('rssd-wechat').length>0;
  let opened=false;
  if(!present){const leaf=workspace.getRightLeaf(false);if(!leaf)return false;await leaf.setViewState({type:'rssd-preview',active:true});workspace.revealLeaf(leaf);opened=true;}
  this.settings.previewOpened=true;await this.saveSettings();
  return opened;
 }
 async openPreview(){
  const workspace=this.app.workspace,leaf=workspace.getLeavesOfType('rssd-preview')[0]||workspace.getLeavesOfType('rssd-wechat')[0]||workspace.getRightLeaf(false);
  if(leaf.view?.getViewType?.()!=='rssd-preview')await leaf.setViewState({type:'rssd-preview',active:true});
  workspace.revealLeaf(leaf);
 }

 async refreshStates(){
  try{
   const states=await this.operations.run('status',()=>this.statesAll(this.settings.workspaceId)),counts={};
   for(const state of Object.values(states))counts[state]=(counts[state]||0)+1;
   new Notice(Object.entries(counts).map(([state,n])=>n+' '+(STATE_LABELS[state]||state)).join(' · ')||'No works');
  }catch(error){new Notice('Check failed: '+error.message);}
 }
}

class RssdSettings extends PluginSettingTab{
 constructor(app,plugin){super(app,plugin);this.plugin=plugin;}
 display(){
  const {containerEl}=this,s=this.plugin.settings;containerEl.empty();
  new Setting(containerEl).setName('Center address').setDesc('The HTTPS address of your RSSD Center.')
   .addText(t=>t.setPlaceholder('https://center.example.org').setValue(s.origin).setDisabled(!!this.plugin.token()||!!s.boundSpace).onChange(async v=>{if(this.plugin.operations.active||this.plugin.token()||s.boundSpace)return;t.inputEl.value=v;s.origin=v.trim();s.boundOrigin=s.origin;await this.plugin.saveSettings();}));
  new Setting(containerEl).setName('Read articles online').setDesc('Browse the site\'s articles without downloading them into this vault.')
   .addButton(b=>b.setButtonText('Open reader').onClick(()=>this.plugin.openReader()));
  new Setting(containerEl).setName('Device name').setDesc('Shown in the Center when you approve this device.')
   .addText(t=>t.setValue(s.deviceName).onChange(async v=>{s.deviceName=v.trim();await this.plugin.saveSettings();}));
  new Setting(containerEl).setName('Sync space').setDesc(s.boundSpace?'This vault is bound to '+s.boundSpace+'. Use a separate vault for another space.':'Only for editing: choosing a space downloads its works into this vault and syncs edits as private drafts. Reading online needs no space here.')
   .addDropdown(t=>{t.addOption('','Choose a space');for(const id of new Set([s.workspaceId,...(s.spaces||[])].filter(Boolean)))t.addOption(id,id);t.setValue(s.workspaceId).setDisabled(!!s.boundSpace).onChange(async v=>{if(this.plugin.operations.active||s.boundSpace)return;s.workspaceId=v;await this.plugin.saveSettings();});});
  new Setting(containerEl).setName('Log in').setDesc(this.plugin.token()?'This device is logged in.':'Approve this device in your browser.')
   .addButton(b=>b.setButtonText('Log in').setCta().onClick(()=>this.plugin.login().catch(error=>new Notice('Login failed: '+error.message))));
  new Setting(containerEl).setName('Command links').setDesc('Allow local commands to drive this vault. Each request has its own receipt.').addToggle(t=>t.setValue(!!s.allowAutomation).onChange(async v=>{s.allowAutomation=v;await this.plugin.saveSettings();}));
  new Setting(containerEl).setName('Automatic sync').setDesc('Periodically pull and save changed works as private drafts. Conflicts and read-only spaces need attention; this never publishes.').addToggle(t=>t.setValue(s.autoSync!==false).onChange(async v=>{s.autoSync=v;await this.plugin.saveSettings();}));
  new Setting(containerEl).setName('Pull works').setDesc('Download new and changed works into '+WORKS_FOLDER+'/ (images go to '+MEDIA_FOLDER+'/). Notes with local changes are never overwritten.')
   .addButton(b=>b.setButtonText('Pull').onClick(()=>this.plugin.pull()));
 }
}

class WorksView extends ItemView{
 constructor(leaf,plugin){super(leaf);this.plugin=plugin;}
 getViewType(){return 'rssd-works';}
 getDisplayText(){return 'RSSD works';}
 getIcon(){return 'files';}
 async onOpen(){void this.render();}
 async render(){
  const el=this.contentEl;el.empty();el.createEl('h3',{text:'RSSD · '+(this.plugin.settings.workspaceId||'Choose a space')});
  new Setting(el).addButton(b=>b.setButtonText('Refresh').onClick(()=>this.render())).addButton(b=>b.setButtonText('Pull works').onClick(async()=>{await this.plugin.pull();await this.render();}));
  try{
   const data=await this.plugin.operations.run('works',async()=>({registry:await this.plugin.client().registry(),states:await this.plugin.statesAll(this.plugin.settings.workspaceId)}));
   const info=spaceInfo(data.registry,this.plugin.settings.workspaceId);
   let reason=readOnlyReason(info,this.plugin.settings.workspaceId);
   if(!info.writable&&info.migrationState==='staged'){
    try{const site=await this.plugin.client().stagedSite(this.plugin.settings.workspaceId);if(site.capabilities?.includes('staged-drafts-v1'))reason='Edits are saved as private migration drafts. The original site still owns publishing; its later changes may require reconciliation.';}catch{}
   }
   if(reason)el.createEl('p',{text:reason});
   for(const [path,state] of Object.entries(data.states)){
    const id=path.split('/').at(-1).replace(/\.md$/,'');const file=this.app.vault.getAbstractFileByPath(path);
    const label=file?this.plugin.workLabel(file):null;
    new Setting(el).setName(label?.title||id).setDesc([label?.date,path.startsWith('Works/en/')?'English':'',STATE_LABELS[state]||state].filter(Boolean).join(' · ')).addButton(b=>b.setButtonText(file?'Open':'Pull first').setDisabled(!file).onClick(()=>this.app.workspace.getLeaf(false).openFile(file)));
   }
  }catch(error){el.createEl('p',{text:error.message});}
 }
}

// One preview panel for every layout a work can be exported in. The top tabs are the views and the tabs under
// them are that view's styles. Views are named for what they produce, not for a platform: one view can serve
// several destinations. Each says how to build its result and what its button does with it.
const PREVIEW_TARGETS=[
 {id:'article',label:'Article',name:'Article view',copyLabel:'Copy article',
  styles:[{id:'site',label:'Site style'},{id:'plain',label:'Plain'}],
  build:(plugin,file,content,style)=>plugin.wechatResult(file,content,{style}),copy:(plugin,file,style)=>plugin.copyForWechat(file,{style})},
 {id:'cards',label:'Cards',name:'Card view',copyLabel:'Save cards',
  styles:[{id:'site',label:'Site style'}],
  build:(plugin,file,content,style,options)=>plugin.cardsResult(file,content,{style,...options}),copy:(plugin,file,style,result)=>plugin.saveCards(file,result)},
];
// The result is shown the way it lands in an editor: no frame, no fixed width, filling whatever room there is.
// It sits in a shadow root so the Obsidian theme cannot restyle it: what shows is what is copied.
const PREVIEW_FRAME=':host{display:block;color-scheme:light}.page{background:#fff;color:#222;padding:20px 16px 32px;overflow-wrap:anywhere;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.title{margin:0 0 18px;font-size:22px;line-height:1.4;font-weight:700}.body img{max-width:100%}.cards{padding:12px;background:#e6e6e6}.cards img{display:block;width:100%;max-width:1080px;height:auto;margin:0 auto 12px;box-shadow:0 1px 6px rgba(0,0,0,.18)}.cards img:last-child{margin-bottom:0}';
class LayoutPreview extends ItemView{
 constructor(leaf,plugin,type='rssd-preview'){super(leaf);this.plugin=plugin;this.type=type;this.target=PREVIEW_TARGETS[0];this.style=this.target.styles[0].id;this.file=null;this.content=null;this.result=null;this.urls=[];this.seq=0;}
 /** A row of tabs; choosing one re-renders the preview. */
 tabs(parent,items,current,choose){
  parent.empty();
  for(const item of items){const tab=parent.createEl('button',{text:item.label,cls:'rssd-preview-tab'+(item.id===current?' is-active':'')});tab.setAttribute('aria-pressed',String(item.id===current));tab.addEventListener('click',()=>{if(item.id!==current)choose(item);});}
 }
 drawTabs(){
  this.tabs(this.targetTabs,PREVIEW_TARGETS,this.target.id,target=>{this.target=target;this.style=target.styles[0].id;this.copyButton.setText(target.copyLabel);this.drawTabs();void this.show(this.file,{force:true});});
  this.tabs(this.styleTabs,this.target.styles,this.style,style=>{this.style=style.id;this.drawTabs();void this.show(this.file,{force:true});});
 }
 getViewType(){return this.type;}
 getDisplayText(){return 'Layout preview';}
 getIcon(){return 'eye';}
 async onOpen(){
  const el=this.contentEl;el.empty();el.style.padding='0';
  this.targetTabs=el.createDiv({cls:'rssd-preview-tabs'});
  const bar=el.createDiv({cls:'rssd-preview-bar'});this.styleTabs=bar.createDiv({cls:'rssd-preview-tabs rssd-preview-styles'});
  this.info=bar.createDiv({cls:'rssd-preview-info'});
  bar.createEl('button',{text:'Refresh'}).addEventListener('click',()=>this.show(this.file,{force:true}));
  this.copyButton=bar.createEl('button',{text:this.target.copyLabel,cls:'mod-cta'});
  this.copyButton.addEventListener('click',()=>{if(this.file)void this.target.copy(this.plugin,this.file,this.style,this.result);});
  this.drawTabs();
  this.root=el.createDiv({cls:'rssd-preview-host'}).attachShadow({mode:'open'});
  // Links in the preview are for looking at, not for leaving the vault.
  this.root.addEventListener('click',event=>{if(event.target?.closest?.('a'))event.preventDefault();});
  this.registerEvent(this.app.workspace.on('file-open',file=>{if(file&&this.plugin.isWork(file))void this.show(file);}));
  // Cards are redrawn page by page, so they wait longer for typing to pause.
  this.registerEvent(this.app.vault.on('modify',file=>{if(file===this.file){window.clearTimeout(this.timer);this.timer=window.setTimeout(()=>this.show(this.file),this.target.id==='cards'?2500:800);}}));
  const active=this.app.workspace.getActiveFile();void this.show(active&&this.plugin.isWork(active)?active:null);
 }
 async onClose(){window.clearTimeout(this.timer);this.seq++;this.abort?.abort();this.release();}
 release(){for(const url of this.urls)URL.revokeObjectURL(url);this.urls=[];}
 message(text){this.release();this.root.replaceChildren();this.info.setText(text);}
 async show(file,{force=false}={}){
  const seq=++this.seq;
  if(!file){this.abort?.abort();this.file=null;this.content=null;this.result=null;this.message('Open a work to preview it.');return;}
  try{
   const content=await this.app.vault.read(file);
   if(seq!==this.seq||(!force&&file===this.file&&content===this.content))return;
   // A newer request replaces one still being laid out.
   this.abort?.abort();const abort=this.abort=new AbortController();
   const result=await this.target.build(this.plugin,file,content,this.style,{signal:abort.signal,
    onProgress:step=>{if(seq===this.seq)this.info.setText(step.stage==='layout'?'Laying out card '+step.count+'…':'Drawing card '+step.count+' of '+step.total+'…');}});
   if(seq!==this.seq)return;
   this.file=file;this.content=content;this.result=result;
   const scroll=this.contentEl.scrollTop,style=document.createElement('style');style.textContent=PREVIEW_FRAME;this.release();
   if(result.pages){
    // Each card is shown as the picture that will be saved.
    const list=document.createElement('div');list.className='cards';
    result.pages.forEach((page,index)=>{const url=URL.createObjectURL(page.blob),img=document.createElement('img');this.urls.push(url);img.src=url;img.alt='Card '+(index+1)+' of '+result.pages.length;list.append(img);});
    this.root.replaceChildren(style,list);
   }else{
    const page=document.createElement('div'),body=document.createElement('div');page.className='page';body.className='body';
    // The engine has already removed scripts and every attribute except its own styles, links and image sources.
    body.innerHTML=result.html;
    const title=document.createElement('div');title.className='title';title.textContent=result.title;
    page.append(title,body);this.root.replaceChildren(style,page);
   }
   this.contentEl.scrollTop=scroll;
   const look=result.styled?[this.plugin.settings.workspaceId,result.sectionId].filter(Boolean).join(' · ')+' style':'Default style';
   // The package manifest lists what this output still lacks (an author, a cover, a shortened digest…).
   const checks=result.manifest?.warnings||[];
   const count=result.pages?result.pages.length+(result.pages.length===1?' card':' cards'):result.images?result.images+(result.images===1?' image':' images'):'';
   this.info.setText([look,count,checks.length?checks.length+' to check':''].filter(Boolean).join(' · '));
   this.info.setAttribute('aria-label',[this.target.name+', '+look+'.'+(result.pages?' Cards are '+result.size.width+'×'+result.size.height+' PNG pictures.':' The title is not part of the copied body; paste it into the editor\'s title field.'),...checks.map(check=>'• '+check.message)].join('\n'));
  }catch(error){if(seq===this.seq&&error?.name!=='AbortError'){this.file=file;this.content=null;this.result=null;this.message('Could not preview: '+error.message);}}
 }
}

const LOCALE_LABELS={'zh-CN':'中文',en:'English'};
class ReaderView extends ItemView{
 constructor(leaf,plugin){super(leaf);this.plugin=plugin;this.items=null;this.query='';this.article=null;this.urls=[];this.seq=0;}
 getViewType(){return 'rssd-reader';}
 getDisplayText(){return 'RSSD reader';}
 getIcon(){return 'book-open';}
 async onOpen(){this.contentEl.addClass('rssd-reader');void this.load();}
 async onClose(){this.release();}
 release(){for(const url of this.urls)URL.revokeObjectURL(url);this.urls=[];this.articleComponent?.unload();this.articleComponent=null;}
 get s(){return this.plugin.settings;}
 async load(){
  const seq=++this.seq,el=this.contentEl;this.article=null;this.release();el.empty();
  el.createEl('p',{text:'Loading…',cls:'setting-item-description'});
  try{
   const client=this.plugin.readClient(),registry=await client.registry();
   const spaces=(registry.workspaces||[]).map(w=>({id:w.id,name:w.name||w.id}));
   if(!spaces.length)throw Error('This device is not approved for any space. Log in again and choose one.');
   if(!spaces.some(w=>w.id===this.s.readerSpace))this.s.readerSpace=spaces.some(w=>w.id===this.s.workspaceId)?this.s.workspaceId:spaces[0].id;
   const items=await readerCatalog(client,this.s.readerSpace,{locale:this.s.readerLocale||'zh-CN',drafts:!!this.s.readerDrafts});
   if(seq!==this.seq)return;
   this.spaces=spaces;this.items=items;this.renderList();
  }catch(error){if(seq===this.seq)this.renderError(error);}
 }
 renderError(error){
  const el=this.contentEl;el.empty();el.createEl('h3',{text:'RSSD reader'});el.createEl('p',{text:error.message});
  const row=new Setting(el).addButton(b=>b.setButtonText('Try again').onClick(()=>this.load()));
  if(error?.status===401||!this.plugin.token())row.addButton(b=>b.setButtonText('Log in').setCta().onClick(async()=>{try{await this.plugin.login({openBrowser:true,selectSyncSpace:false});await this.load();}catch(e){if(e?.code!=='cancelled')new Notice('Login failed: '+e.message,10000);}}));
 }
 renderList(){
  const el=this.contentEl,s=this.s;this.article=null;this.release();el.empty();
  const bar=new Setting(el).setName(this.spaces.find(w=>w.id===s.readerSpace)?.name||s.readerSpace);
  if(this.spaces.length>1)bar.addDropdown(d=>{for(const w of this.spaces)d.addOption(w.id,w.name);d.setValue(s.readerSpace).onChange(async v=>{s.readerSpace=v;await this.plugin.saveSettings();void this.load();});});
  bar.addDropdown(d=>{for(const [k,v] of Object.entries(LOCALE_LABELS))d.addOption(k,v);d.setValue(s.readerLocale||'zh-CN').onChange(async v=>{s.readerLocale=v;await this.plugin.saveSettings();void this.load();});});
  bar.addExtraButton(b=>b.setIcon('refresh-cw').setTooltip('Refresh').onClick(()=>this.load()));
  new Setting(el).setName('Include unpublished drafts').addToggle(t=>t.setValue(!!s.readerDrafts).onChange(async v=>{s.readerDrafts=v;await this.plugin.saveSettings();void this.load();}))
   .addSearch(q=>{q.setPlaceholder('Search titles').setValue(this.query).onChange(v=>{this.query=v;this.renderRows(list);});});
  const list=el.createDiv();this.renderRows(list);
 }
 renderRows(list){
  list.empty();const rows=filterCatalog(this.items,this.query);
  list.createEl('p',{text:rows.length+' of '+this.items.length+' articles',cls:'setting-item-description'});
  for(const item of rows){
   const meta=[item.dateLabel||String(item.lastmod||'').slice(0,10),item.category,item.publicationState==='published'?'':'draft'].filter(Boolean).join(' · ');
   const row=new Setting(list).setName(String(item.title||item.articleId)).setDesc(meta+(item.summary?'\n'+item.summary:''));
   row.settingEl.style.cursor='pointer';row.descEl.style.whiteSpace='pre-line';
   row.settingEl.addEventListener('click',()=>this.open(item));
  }
 }
 async open(item){
  const seq=++this.seq,el=this.contentEl,s=this.s;this.release();el.empty();
  el.createEl('p',{text:'Loading '+(item.title||item.articleId)+'…',cls:'setting-item-description'});
  try{
   const client=this.plugin.readClient(),locale=s.readerLocale||'zh-CN';
   const detail=item.publicationState==='published'?await client.published(s.readerSpace,item.articleId,locale):await client.latest(s.readerSpace,item.articleId,locale);
   if(seq!==this.seq)return;
   this.article=readerArticle(detail,item);await this.renderArticle(seq);
  }catch(error){if(seq===this.seq)this.renderError(error);}
 }
 async renderArticle(seq){
  const a=this.article,el=this.contentEl;el.empty();
  const bar=new Setting(el).addButton(b=>b.setButtonText('← All articles').onClick(()=>this.items?this.renderList():this.load()));
  if(a.url)bar.addButton(b=>b.setButtonText(a.published?'Open on site':'Site page (not published)').onClick(()=>window.open(a.url)));
  const body=el.createDiv({cls:'markdown-rendered markdown-preview-view'});body.style.padding='0 var(--size-4-4)';
  body.createEl('h1',{text:a.title});
  const meta=[a.date,a.author,a.category,a.published?'':'unpublished draft'].filter(Boolean).join(' · ');
  if(meta)body.createEl('p',{text:meta,cls:'setting-item-description'});
  const content=body.createDiv();
  this.articleComponent=new Component();this.addChild(this.articleComponent);
  await MarkdownRenderer.render(this.app,a.markdown,content,'',this.articleComponent);
  if(seq!==this.seq)return;
  for(const img of content.querySelectorAll('img')){
   const src=img.getAttribute('src')||'';if(!src.startsWith(MEDIA_HOST))continue;
   const asset=a.media[decodeURIComponent(src.slice(MEDIA_HOST.length))];if(!asset){img.removeAttribute('src');continue;}
   const bytes=Uint8Array.from(atob(asset.data),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:asset.type}));
   this.urls.push(url);img.setAttribute('src',url);
  }
 }
}
