// RSSD for Obsidian, stage 1: open a space from the RSSD Center as a vault of drafts, see each work's sync
// state, and save edits back as private drafts. Publishing is never done here.
import {Plugin,PluginSettingTab,Setting,Notice,Modal,requestUrl,parseYaml,stringifyYaml,Platform,TFile,normalizePath,ItemView,MarkdownRenderer,Component,Menu,setIcon} from 'obsidian';
import {createCenterClient,centerOrigin} from './center-client.mjs';
import {OperationGate,automationRequest,recordedOperation,diagnosticError} from './operations.mjs';
import {deviceLogin} from './device-login.mjs';
import {SyncEngine} from './sync-engine.mjs';
import {StagedSyncEngine} from './staged-sync-engine.mjs';
import {canonicalPathIdentity,trackRename,trackDelete,confirmReturn} from './path-guard.mjs';
import {AutoSync,startupDelay,syncLease} from './auto-sync.mjs';
import {saveFailureMessage,saveManySummary} from './messages.mjs';
import {spaceInfo,readOnlyReason,spacesSummary} from './spaces.mjs';
import {readerCatalog,filterCatalog,readerArticle,MEDIA_HOST} from './reader.mjs';
import {workLabel,labelText} from './titles.mjs';
import {SettingsLog,baselineBucket} from './settings-log.mjs';
import {SITE_SECTIONS} from '../../contracts/site-sections.mjs';
import {wechatHtml,copyRich} from './wechat.mjs';
import {wechatTemplate,wechatSite,cardTemplate} from './wechat-template.mjs';
import {decorateWechat,ARTICLE_THEMES,defaultArticleTheme} from './wechat-designs.mjs';
import {buildCards,CARD_THEMES} from './cards.mjs';
import {DETAIL_FIELDS,IDENTITY_FIELDS,fieldText,counters,cleanValue} from './details.mjs';
import {checkSource} from '../../contracts/output-package.mjs';
import {STATE_LABELS,WORKS_FOLDER,MEDIA_FOLDER,notePath,noteToWork,workFingerprint,localMediaPaths} from './sync-model.mjs';

const TOKEN_SECRET='rssd-center-device-token';
// The Scholay Center. A build can point elsewhere with RSSD_DEFAULT_ORIGIN; the address stays editable until login.
export const DEFAULT_ORIGIN=typeof RSSD_DEFAULT_ORIGIN==='string'?RSSD_DEFAULT_ORIGIN:'https://post.linkc.cloud';
const DEFAULTS={origin:'',readerSpace:'',readerLocale:'zh-CN',readerDrafts:false,deviceName:'',workspaceId:'',baselines:{},baselinesByLocale:{},pathRecords:{},allowAutomation:false,autoSync:true,previewOpened:false,layoutVersion:0,propertiesBefore:null};
const LOCALES=['zh-CN','en'];
// The right sidebar's RSSD tabs, in order: each is one view of the open work, so Obsidian's own tab bar is
// where you choose between them.
const SIDEBAR_VIEWS=Object.freeze([['rssd-article','article'],['rssd-cards','cards'],['rssd-outline','outline'],['rssd-details','details']]);
// Work notes show their title and date; the stable ID file name stays underneath. The inline title and the
// header title are hidden for them because editing either one renames the file and would stop its sync.
const TITLE_STYLE=`
.rssd-work-note .inline-title,.rssd-work-note .view-header-title-parent,.rssd-work-note .view-header-title{display:none}
.rssd-work-header{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:var(--font-semibold);padding:0 var(--size-2-2)}
/* Two rows: the views, then the chosen output's styles, its status, refresh and its action. */
.rssd-preview-bar,.rssd-preview-controls{display:flex;align-items:center;gap:var(--size-4-2);padding:var(--size-4-1) var(--size-4-2);border-bottom:1px solid var(--background-modifier-border)}
.rssd-preview-views,.rssd-preview-actions{display:flex;align-items:center;gap:var(--size-2-1);flex:0 0 auto}
.rssd-preview-actions{margin-left:auto}
/* Theme tabs are small squares in the section's own colour: tinted when idle, solid and raised when chosen.
   --rssd-accent is set from the open work's section. */
.rssd-preview-controls{--rssd-accent:var(--interactive-accent);position:sticky;top:0;z-index:3;background:var(--background-primary)}
.rssd-preview-controls button.rssd-preview-tab{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;height:24px;min-width:24px;padding:0 8px;margin:0;border:0;border-radius:5px;background:color-mix(in srgb,var(--rssd-accent) 12%,transparent);box-shadow:inset 0 -1px 0 color-mix(in srgb,var(--rssd-accent) 22%,transparent);color:var(--rssd-accent);font-size:var(--font-ui-smaller);font-weight:var(--font-semibold);line-height:1;white-space:nowrap;cursor:pointer;transition:background .12s,box-shadow .12s,transform .12s}
.rssd-preview-controls button.rssd-preview-tab.is-number{width:24px;padding:0;font-variant-numeric:tabular-nums}
.rssd-preview-controls button.rssd-preview-tab:hover{background:color-mix(in srgb,var(--rssd-accent) 22%,transparent)}
.rssd-preview-controls button.rssd-preview-tab.is-active{background:var(--rssd-accent);color:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2),0 2px 6px color-mix(in srgb,var(--rssd-accent) 35%,transparent);transform:translateY(-1px)}
.rssd-preview-controls button.rssd-preview-tab:not(.is-number)+button.rssd-preview-tab.is-number{margin-left:var(--size-2-2)}
.rssd-preview-styles{display:flex;align-items:center;gap:var(--size-2-1);flex:0 1 auto;min-width:0;overflow-x:auto;scrollbar-width:none}
.rssd-preview-controls .rssd-preview-info{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text-muted);font-size:var(--font-ui-smaller)}
.rssd-preview-bar button.rssd-preview-icon,.rssd-preview-controls button.rssd-preview-icon{display:flex;align-items:center;justify-content:center;height:auto;padding:var(--size-2-3);border:0;border-radius:var(--radius-s);background:none;box-shadow:none;color:var(--icon-color);cursor:pointer}
.rssd-preview-bar button.rssd-preview-icon:hover,.rssd-preview-controls button.rssd-preview-icon:hover{background:var(--background-modifier-hover);color:var(--icon-color-hover)}
.rssd-preview-bar button.rssd-preview-icon.is-active{background:var(--background-modifier-active-hover);color:var(--interactive-accent)}
.rssd-preview-controls button.rssd-preview-icon.mod-cta{background:var(--interactive-accent);color:var(--text-on-accent)}
.rssd-preview-controls button.rssd-preview-icon.mod-cta:hover{background:var(--interactive-accent-hover)}
.rssd-preview-host{display:block}
.rssd-works{display:flex;flex-direction:column;padding:0!important}
.rssd-works-top{position:sticky;top:0;z-index:2;padding:var(--size-4-2) var(--size-4-2) var(--size-4-1);background:var(--background-secondary);border-bottom:1px solid var(--background-modifier-border)}
.rssd-works-search{width:100%;font-size:var(--font-ui-small)}
.rssd-works-filters{display:flex;gap:var(--size-2-2);margin-top:var(--size-4-1);flex-wrap:wrap}
.rssd-works button.rssd-works-chip{height:auto;padding:1px 8px;border-radius:999px;border:1px solid var(--background-modifier-border);background:none;box-shadow:none;color:var(--text-muted);font-size:var(--font-ui-smaller);cursor:pointer}
.rssd-works button.rssd-works-chip.is-active{background:var(--interactive-accent);border-color:var(--interactive-accent);color:var(--text-on-accent)}
.rssd-works-list{flex:1 1 auto;padding:var(--size-2-2) var(--size-2-2) var(--size-4-2)}
.rssd-works-head{display:flex;align-items:center;gap:4px;padding:6px 4px 3px;color:var(--text-muted);font-size:var(--font-ui-smaller);font-weight:var(--font-semibold);cursor:pointer;user-select:none}
.rssd-works-caret{display:flex;width:14px;height:14px;transition:transform .12s}.rssd-works-caret svg{width:14px;height:14px}
.rssd-works-group.is-collapsed .rssd-works-caret{transform:rotate(-90deg)}
.rssd-works-name{flex:1 1 auto}.rssd-works-count{font-variant-numeric:tabular-nums;font-weight:normal}
.rssd-works-row{display:flex;align-items:center;gap:6px;padding:3px 6px;border-radius:var(--radius-s);font-size:var(--font-ui-small);cursor:pointer;min-width:0}
.rssd-works-row:hover{background:var(--background-modifier-hover)}
.rssd-works-row.is-active{background:var(--background-modifier-active-hover);color:var(--text-normal)}
.rssd-works-dot{flex:0 0 7px;width:7px;height:7px;border-radius:50%;background:var(--background-modifier-border)}
.rssd-works-dot.is-synced{background:var(--color-green)}.rssd-works-dot.is-edited{background:var(--color-orange)}.rssd-works-dot.is-saving{background:var(--color-blue)}.rssd-works-dot.is-conflict{background:var(--color-red)}.rssd-works-dot.is-unlinked{background:var(--text-faint)}
.rssd-works-date{flex:0 0 auto;color:var(--text-faint);font-size:var(--font-ui-smaller);font-variant-numeric:tabular-nums}
.rssd-works-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rssd-works-langs{display:flex;margin-left:auto;border:1px solid var(--background-modifier-border);border-radius:999px;overflow:hidden}
.rssd-works button.rssd-works-lang{height:auto;padding:1px 8px;border:0;border-radius:0;background:none;box-shadow:none;color:var(--text-muted);font-size:var(--font-ui-smaller);cursor:pointer}
.rssd-works button.rssd-works-lang.is-active{background:var(--background-modifier-active-hover);color:var(--text-normal);font-weight:var(--font-semibold)}
.rssd-works-more,.rssd-works-empty{padding:4px 6px;color:var(--text-muted);font-size:var(--font-ui-smaller);cursor:pointer}
.rssd-works-empty{cursor:default;padding:var(--size-4-3) var(--size-4-2)}
.rssd-works-foot{position:sticky;bottom:0;display:flex;align-items:center;gap:var(--size-4-2);padding:var(--size-4-1) var(--size-4-2);border-top:1px solid var(--background-modifier-border);background:var(--background-secondary);color:var(--text-muted);font-size:var(--font-ui-smaller)}
.rssd-works-pulled{flex:1 1 auto}
.rssd-works button.rssd-works-pull{height:auto;padding:2px 10px;font-size:var(--font-ui-smaller)}
.rssd-details,.rssd-outline{padding:var(--size-4-2) var(--size-4-3);font-size:var(--font-ui-small)}
.rssd-outline-item{display:block;width:100%;text-align:left;padding:3px var(--size-2-2);border-radius:var(--radius-s);color:var(--text-muted);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rssd-outline-item:hover{background:var(--background-modifier-hover);color:var(--text-normal)}
.rssd-outline-item.is-level-1{color:var(--text-normal);font-weight:var(--font-semibold)}
.rssd-details-empty{color:var(--text-muted);padding:var(--size-4-2) 0}
.rssd-details-field{margin-bottom:var(--size-4-3)}
.rssd-details-label{display:block;margin-bottom:var(--size-2-1);color:var(--text-muted);font-size:var(--font-ui-smaller)}
.rssd-details-input{width:100%;font-size:var(--font-ui-small)}
textarea.rssd-details-input{resize:vertical;min-height:4.5em;line-height:var(--line-height-normal)}
.rssd-details-meter{display:flex;gap:var(--size-4-2);justify-content:flex-end;margin-top:2px}
.rssd-details-count{color:var(--text-faint);font-size:var(--font-ui-smaller);font-variant-numeric:tabular-nums}
.rssd-details-count.is-over{color:var(--text-warning)}
.rssd-details-checks{margin:var(--size-4-2) 0 var(--size-4-3);padding:var(--size-4-2);border-radius:var(--radius-s);background:var(--background-secondary)}
.rssd-details-check{color:var(--text-warning);font-size:var(--font-ui-smaller);line-height:var(--line-height-tight);margin-top:2px}
.rssd-details-link{border-top:1px solid var(--background-modifier-border);padding-top:var(--size-4-2)}
.rssd-details-link>summary{cursor:pointer;color:var(--text-muted);font-size:var(--font-ui-smaller)}
.rssd-details-state{margin:var(--size-4-2) 0;color:var(--text-normal)}
.rssd-details-row{display:flex;gap:var(--size-4-2);padding:2px 0;font-size:var(--font-ui-smaller)}
.rssd-details-key{flex:0 0 7.5em;color:var(--text-muted)}
.rssd-details-value{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;color:var(--text-normal);font-family:var(--font-monospace)}
.rssd-details-note{margin-top:var(--size-4-2);color:var(--text-faint);font-size:var(--font-ui-smaller)}
/* While a preview is built the last result stays visible, dimmed, under a spinner that follows the scroll. */
.rssd-preview-stage{position:relative;min-height:180px}
.rssd-preview-loading{position:absolute;inset:0;z-index:2;display:none;background:color-mix(in srgb,var(--background-primary) 78%,transparent)}
.rssd-preview-stage.is-loading>.rssd-preview-loading{display:block}
.rssd-preview-loading-box{position:sticky;top:56px;display:flex;align-items:center;gap:var(--size-4-2);width:max-content;max-width:calc(100% - 32px);margin:24px auto 0;padding:var(--size-4-2) var(--size-4-4);background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:var(--radius-m);box-shadow:var(--shadow-s)}
.rssd-preview-spinner{flex:0 0 auto;width:18px;height:18px;border:2px solid var(--background-modifier-border);border-top-color:var(--interactive-accent);border-radius:50%;animation:rssd-spin .8s linear infinite}
.rssd-preview-loading-text{color:var(--text-muted);font-size:var(--font-ui-small)}
@keyframes rssd-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.rssd-preview-spinner{animation-duration:2.4s}}
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
  this.addRibbonIcon('library','Works',()=>this.openWorks());
  this.addCommand({id:'works',name:'Show the Works list',callback:()=>this.openWorks()});
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
  for(const [type,id] of SIDEBAR_VIEWS)this.registerView(type,leaf=>new LayoutPreview(leaf,this,type,id));
  // Panels saved by earlier versions open as the article view until the sidebar is arranged.
  for(const type of ['rssd-preview','rssd-wechat'])this.registerView(type,leaf=>new LayoutPreview(leaf,this,type,'article'));
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
  // Work details are a view of the RSSD panel; the properties block in the article is hidden once they are there.
  this.addCommand({id:'details',name:'Show work details',callback:()=>this.openDetails()});
  this.app.workspace.onLayoutReady(()=>{void this.tidySidebar().catch(error=>console.error('RSSD sidebar',error));});
  // Obsidian's core plugins put their tabs back on every start, so they are moved out again after it settles.
  this.app.workspace.onLayoutReady(()=>{for(const delay of [800,3000])window.setTimeout(()=>this.closeDefaultTabs(),delay);});
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
 /** Show the Works list in the left sidebar (one left by an earlier version elsewhere is moved there). */
 async openWorks(){
  const workspace=this.app.workspace;let leaf=workspace.getLeavesOfType('rssd-works').find(l=>l.getRoot?.()===workspace.leftSplit);
  if(!leaf){for(const old of workspace.getLeavesOfType('rssd-works'))old.detach();leaf=workspace.getLeftLeaf(false);if(!leaf)return;await leaf.setViewState({type:'rssd-works',active:true});}
  workspace.revealLeaf(leaf);
 }
 isWork(file){return file.extension==='md'&&file.path.startsWith(WORKS_FOLDER+'/');}
 setStatus(text){this.status?.setText(text);}
 idleStatus(){return this.token()?'RSSD'+(this.settings.workspaceId?' · '+this.settings.workspaceId:''):'RSSD · log in';}
 statusMenu(){
  const menu=new Menu(),loggedIn=!!this.token(),space=this.settings.workspaceId,active=this.app.workspace.getActiveFile();
  const login=()=>this.login({openBrowser:true,selectSyncSpace:false}).then(()=>this.setStatus(this.idleStatus())).catch(error=>{if(error?.code!=='cancelled')new Notice('Login failed: '+error.message,10000);});
  if(!loggedIn)menu.addItem(item=>item.setTitle('Log in to RSSD').setIcon('log-in').onClick(login));
  menu.addItem(item=>item.setTitle('Read site articles online').setIcon('book-open').onClick(()=>this.openReader()));
  if(loggedIn&&space){
   menu.addItem(item=>item.setTitle('Works list').setIcon('library').onClick(()=>this.openWorks()));
   menu.addItem(item=>item.setTitle('Pull works from the Center').setIcon('download').onClick(()=>this.pull()));
   if(active&&this.isWork(active))menu.addItem(item=>item.setTitle('Save this work as a private draft').setIcon('upload').onClick(()=>this.save(active)));
   menu.addItem(item=>item.setTitle('Check sync state').setIcon('refresh-cw').onClick(()=>this.refreshStates()));
  }
  if(active&&this.isWork(active)){
   menu.addItem(item=>item.setTitle('Work details').setIcon('info').onClick(()=>this.openDetails()));
   menu.addItem(item=>item.setTitle('Preview layout').setIcon('file-text').onClick(()=>this.openPreview()));
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
  this.settings.lastPullAt=Date.now();
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
 /** Save several works one after another as private drafts, as one operation. A refused work does not stop
  * the rest, but a space that refuses every save or a lost connection does. Never publishes. */
 async saveEdited(files,{onProgress=()=>{}}={}){
  const outcome={saved:[],unchanged:[],failed:[]};
  try{
   await this.operations.run('save',async()=>{
    for(const [index,file] of files.entries()){
     onProgress(index+1,files.length);
     try{
      const result=await this.saveWork(this.settings.workspaceId,file.path);this.autoSync?.unblock(file.path);
      (result?.state==='unchanged'?outcome.unchanged:outcome.saved).push(file);
     }catch(error){
      console.error('RSSD save failed',file.path,error?.status,error?.code,error?.message);outcome.failed.push({file,error});
      // Show it the way automatic sync does, so the list marks it as needing attention.
      if(error?.conflict||error?.status===409)this.autoSync?.blocked?.add(file.path);
      if(['forbidden','migration_staged','network_error'].includes(error?.code))break;
     }
    }
   });
  }catch(error){new Notice(error?.code==='operation_busy'?error.message:saveFailureMessage(error),10000);return null;}
  new Notice(saveManySummary(outcome),outcome.failed.length?15000:6000);
  return outcome;
 }

 /** A work as a styled article for pasting into a rich-text editor (the WeChat official-account editor is
  * the one it is tuned for). Reads the note; changes nothing. */
 async wechatResult(file,content,{style}={}){
  style??=this.defaultStyle('article',file);
  const component=new Component();component.load();
  try{
   const adapter=this.app.vault.adapter;content??=await this.app.vault.read(file);
   // The site's own style is its section's theme signed with the site's name marks; a numbered general theme
   // carries no site marks, only the section's colours and fonts.
   const space=this.settings.workspaceId,own=style==='site',theme=own?this.sectionTheme(file):Object.prototype.hasOwnProperty.call(ARTICLE_THEMES,style)?style:null,site=own?wechatSite(space):null;
   return await wechatHtml({doc:document,content,parseYaml,template:source=>wechatTemplate(space,source.sectionId),
    decorate:(html,{look,source})=>decorateWechat(document,html,{site,look,category:source.category,theme,locale:source.work.data.locale}),
    pack:{site:wechatSite(space)||{id:space||'unknown',name:''},style:own?'site:'+theme:style,engineVersion:this.manifest?.version||'0',...this.noteVersions(file)},
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
 /** Every view starts with the site's own style. */
 defaultStyle(){return 'site';}
 /** The accent colour of a work's section, from its website template. */
 sectionAccent(file){
  const section=file?this.app.metadataCache.getFileCache(file)?.frontmatter?.['rssd-section']:'';
  const accent=wechatTemplate(this.settings.workspaceId,String(section||''))?.accent;
  return /^#[0-9a-fA-F]{6}$/.test(accent||'')?accent:null;
 }
 /** The site's name for its own style tab. */
 siteName(){return wechatSite(this.settings.workspaceId)?.name||'Site';}
 /**
  * The structure the site's own article style uses for a work: the theme that matches the layout the website
  * gives the work's section.
  */
 sectionTheme(file){
  const section=file?this.app.metadataCache.getFileCache(file)?.frontmatter?.['rssd-section']:'';
  return defaultArticleTheme(cardTemplate(this.settings.workspaceId,String(section||''))?.layout);
 }
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
 async cardsResult(file,content,{style,signal,onProgress}={}){
  style??=this.defaultStyle('cards',file);
  const component=new Component();component.load();
  try{
   const adapter=this.app.vault.adapter;content??=await this.app.vault.read(file);
   const space=this.settings.workspaceId,site=wechatSite(space);
   return await buildCards({doc:document,content,parseYaml,signal,onProgress,style,cardTheme:style==='site'?'text':style,site,url:site?.origin||centerOrigin(this.settings.origin),
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
  * Once per vault that edits works, arrange the right sidebar: the four RSSD tabs (Article, Cards, Outline,
  * Details) in that order, with Article in front, and none of Obsidian's link, tag, vault-properties or outline
  * tabs (any of them can be reopened from the command palette). On the first arrangement, now that the
  * properties have a place of their own, the properties block at the top of each note is hidden; the vault's
  * earlier choice is kept so it can be restored. Panels left by earlier versions are replaced.
  */
 async tidySidebar(){
  const version=this.settings.layoutVersion||0;
  if(version>=6||!this.settings.workspaceId||Platform.isMobile)return false;
  const workspace=this.app.workspace,created=new Set();
  if(version<5){
  // Add the new tabs before closing anything: an emptied sidebar is refilled by Obsidian with its default tabs.
  for(const [type] of SIDEBAR_VIEWS){const leaf=workspace.getRightLeaf(false);if(!leaf)break;await leaf.setViewState({type,active:false});created.add(leaf);}
  for(const type of ['rssd-preview','rssd-wechat',...SIDEBAR_VIEWS.map(([type])=>type)])for(const leaf of workspace.getLeavesOfType(type))if(!created.has(leaf))leaf.detach();
  for(const type of ['backlink','outgoing-link','tag','all-properties','outline'])for(const leaf of workspace.getLeavesOfType(type))if(leaf.getRoot?.()===workspace.rightSplit)leaf.detach();
  const first=[...created][0];if(first)workspace.revealLeaf(first);
  }
  // The Works list sits in the left sidebar, in front of the file tree.
  await this.openWorks();
  const vault=this.app.vault,before=vault.getConfig?.('propertiesInDocument');
  // Only on the first arrangement, so a vault that brought the properties back keeps them.
  if(version<2&&typeof vault.setConfig==='function'&&before!=='hidden'){this.settings.propertiesBefore=before||'visible';vault.setConfig('propertiesInDocument','hidden');}
  this.settings.layoutVersion=6;await this.saveSettings();
  return true;
 }
 /**
  * Close Obsidian's backlinks, outgoing links, tags, all-properties and outline tabs in the right sidebar, where
  * the RSSD tabs take their place. Only while the RSSD tabs are there, so the sidebar is never emptied, and
  * only when the setting is on (Settings → RSSD → Right sidebar).
  */
 closeDefaultTabs(){
  if(this.settings.tidyRightSidebar===false||!this.settings.workspaceId||Platform.isMobile)return 0;
  const workspace=this.app.workspace,inRight=leaf=>leaf.getRoot?.()===workspace.rightSplit;
  if(!SIDEBAR_VIEWS.some(([type])=>workspace.getLeavesOfType(type).some(inRight)))return 0;
  let closed=0;
  for(const type of ['backlink','outgoing-link','tag','all-properties','outline'])for(const leaf of workspace.getLeavesOfType(type))if(inRight(leaf)){leaf.detach();closed++;}
  return closed;
 }
 /** Show one of the RSSD sidebar tabs, opening it if it was closed. */
 async openView(type){
  const workspace=this.app.workspace;let leaf=workspace.getLeavesOfType(type)[0];
  if(!leaf){leaf=workspace.getRightLeaf(false);if(!leaf)return;await leaf.setViewState({type,active:true});}
  workspace.revealLeaf(leaf);
 }
 openDetails(){return this.openView('rssd-details');}
 /** The work open in the editor, even while a sidebar tab has the focus. */
 currentWork(){
  const workspace=this.app.workspace,active=workspace.getActiveFile();
  if(active&&this.isWork(active))return active;
  const recent=workspace.getMostRecentLeaf?.()?.view?.file;if(recent&&this.isWork(recent))return recent;
  return workspace.getLeavesOfType('markdown').map(leaf=>leaf.view?.file).find(file=>file&&this.isWork(file))||null;
 }
 /** Show the properties block at the top of notes again, as the vault had it before the details panel. */
 restoreProperties(){
  this.app.vault.setConfig?.('propertiesInDocument',this.settings.propertiesBefore||'visible');
  this.settings.propertiesBefore=null;return this.saveSettings();
 }
 openPreview(){return this.openView('rssd-article');}

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
  new Setting(containerEl).setName('Right sidebar').setDesc('Keep only the RSSD tabs (Article, Cards, Outline, Details) in the right sidebar. Turn off to let Obsidian keep its backlinks, outgoing links, tags, all-properties and outline tabs there.')
   .addToggle(t=>t.setValue(s.tidyRightSidebar!==false).onChange(async v=>{s.tidyRightSidebar=v;await this.plugin.saveSettings();if(v)this.plugin.closeDefaultTabs();}));
  new Setting(containerEl).setName('Properties in the article').setDesc('Work details are edited under Details in the RSSD panel in the right sidebar, so the properties block at the top of each note is hidden. Show it again here.')
   .addButton(b=>b.setButtonText('Show in article').onClick(async()=>{await this.plugin.restoreProperties();new Notice('The properties block is shown in notes again.');}));
  new Setting(containerEl).setName('Pull works').setDesc('Download new and changed works into '+WORKS_FOLDER+'/ (images go to '+MEDIA_FOLDER+'/). Notes with local changes are never overwritten.')
   .addButton(b=>b.setButtonText('Pull').onClick(()=>this.plugin.pull()));
 }
}

// The Works list: every work of the space in the left sidebar, grouped by the site's sections, newest first,
// one row per work, Chinese and English editions shown one language at a time (an English edition is a work of
// its own in the Center, with no link back to its original that the list could rely on). Read from the vault alone, so it is instant and works
// offline; "edited" means changed since the last sync with the Center.
const WORK_STATES={synced:'Synced',edited:'Edited since the last sync',saving:'Saving to the Center',conflict:'Conflict: needs attention',unlinked:'Not pulled from the Center yet'};
const WORKS_PAGE=60;
class WorksView extends ItemView{
 constructor(leaf,plugin){super(leaf);this.plugin=plugin;this.query='';this.filter='all';this.lang='zh';this.collapsed=new Set();this.limits=new Map();this.states=new Map();this.timer=null;this.filling=false;}
 getViewType(){return 'rssd-works';}
 getDisplayText(){return 'Works';}
 getIcon(){return 'library';}
 async onOpen(){
  try{this.build();}catch(error){console.error('RSSD works',error);this.contentEl.empty();this.contentEl.createDiv({cls:'rssd-works-empty',text:'Could not show the works: '+(error?.message||error)});}
 }
 build(){
  const el=this.contentEl;el.empty();el.addClass('rssd-works');
  const top=el.createDiv({cls:'rssd-works-top'});
  const search=top.createEl('input',{type:'search',cls:'rssd-works-search',attr:{placeholder:'Search titles and summaries'}});
  search.addEventListener('input',()=>{this.query=search.value;this.render();});
  this.filters=top.createDiv({cls:'rssd-works-filters'});
  this.list=el.createDiv({cls:'rssd-works-list'});
  this.foot=el.createDiv({cls:'rssd-works-foot'});
  const later=()=>{window.clearTimeout(this.timer);this.timer=window.setTimeout(()=>this.render(),300);};
  this.registerEvent(this.app.metadataCache.on('changed',file=>{this.states.delete(file.path);later();}));
  this.registerEvent(this.app.vault.on('modify',file=>{this.states.delete(file.path);later();}));
  for(const event of ['create','delete','rename'])this.registerEvent(this.app.vault.on(event,later));
  this.registerEvent(this.app.workspace.on('file-open',()=>this.mark()));
  this.registerInterval(window.setInterval(()=>this.renderFoot(),60000));
  this.app.workspace.onLayoutReady(()=>this.render());
 }
 async onClose(){window.clearTimeout(this.timer);}
 /** Every work in the vault, each edition on its own. */
 works(){
  const items=[];
  for(const file of this.app.vault.getMarkdownFiles()){
   if(!this.plugin.isWork(file))continue;
   const p=this.app.metadataCache.getFileCache(file)?.frontmatter;if(!p?.['rssd-id'])continue;
   items.push({file,id:String(p['rssd-id']),locale:String(p['rssd-locale']||'zh-CN'),title:String(p.title||file.basename),summary:String(p.summary||''),date:fieldText(p.date),
    section:String(p['rssd-section']||''),author:String(p.author??''),category:String(p.category??'')});
  }
  return items;
 }
 /** Whether a note matches its last sync, from the note and its stored baseline; nothing is sent anywhere. */
 async stateOf(work){
  const file=work.file,key=file.path+':'+file.stat.mtime,cached=this.states.get(file.path);
  if(cached?.key===key)return cached.state;
  let state='synced';
  try{
   const base=baselineBucket(this.plugin.settings,this.plugin.settings.workspaceId,work.locale)?.[work.id];
   if(this.plugin.autoSync?.blocked?.has(file.path))state='conflict';
   else if(!base)state='unlinked';
   else if(base.pending)state='saving';
   else{
    const note=noteToWork(await this.app.vault.cachedRead(file),parseYaml);
    if(note&&await workFingerprint(note.data,localMediaPaths(note.media))!==base.fingerprint)state='edited';
   }
  }catch{state='synced';}
  this.states.set(file.path,{key,state});return state;
 }
 sectionNames(){
  const site=wechatSite(this.plugin.settings.workspaceId);
  return new Map((SITE_SECTIONS[site?.id]||[]).map((section,index)=>[section.id,{name:section.name,order:index}]));
 }
 render(){
  if(!this.list)return;
  try{this.draw();}catch(error){console.error('RSSD works',error);this.list.empty();this.list.createDiv({cls:'rssd-works-empty',text:'Could not list the works: '+(error?.message||error)});}
 }
 draw(){
  const every=this.works(),english=every.filter(work=>work.locale==='en'),chinese=every.filter(work=>work.locale!=='en');
  if(this.lang==='en'&&!english.length)this.lang='zh';
  const all=this.lang==='en'?english:chinese,q=this.query.trim().toLowerCase(),names=this.sectionNames();
  const toCheck=work=>!work.author.trim()||!work.category.trim();
  const edited=work=>['edited','saving','conflict'].includes(this.states.get(work.file.path)?.state);
  this.filters.empty();
  for(const [id,label,count] of [['all','All',all.length],['edited','Edited',all.filter(edited).length],['check','To check',all.filter(toCheck).length]]){
   const chip=this.filters.createEl('button',{cls:'rssd-works-chip'+(this.filter===id?' is-active':''),text:label+' '+count});
   chip.addEventListener('click',()=>{this.filter=id;this.render();});
  }
  // One language at a time; the switch appears only when the space has English editions.
  if(english.length){
   const langs=this.filters.createDiv({cls:'rssd-works-langs'});
   for(const [id,label,count] of [['zh','中文',chinese.length],['en','English',english.length]]){
    const tab=langs.createEl('button',{cls:'rssd-works-lang'+(this.lang===id?' is-active':''),text:label});tab.setAttribute('aria-label',label+', '+count+' works');
    tab.addEventListener('click',()=>{if(this.lang===id)return;this.lang=id;this.render();});
   }
  }
  const shown=all.filter(work=>(!q||[work.title,work.summary].some(text=>text.toLowerCase().includes(q)))&&
   (this.filter==='all'||(this.filter==='edited'&&edited(work))||(this.filter==='check'&&toCheck(work))));
  this.contentEl.toggleClass('is-english',this.lang==='en');
  const groups=new Map();
  for(const work of shown){const key=work.section||'';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(work);}
  const order=key=>names.get(key)?.order??999;
  this.list.empty();
  if(!shown.length)this.list.createDiv({cls:'rssd-works-empty',text:all.length?'No works match.':'No works yet. Pull them from the Center.'});
  for(const key of [...groups.keys()].sort((a,b)=>order(a)-order(b)||a.localeCompare(b))){
   // Newest first; works of the same day by title.
   const items=groups.get(key).sort((a,b)=>b.date.localeCompare(a.date)||a.title.localeCompare(b.title));
   const name=names.get(key)?.name||items[0].category||key||'Other';
   const group=this.list.createDiv({cls:'rssd-works-group'+(this.collapsed.has(key)?' is-collapsed':'')});
   const head=group.createDiv({cls:'rssd-works-head'});
   const caret=head.createSpan({cls:'rssd-works-caret'});setIcon(caret,'chevron-down');
   head.createSpan({cls:'rssd-works-name',text:name});head.createSpan({cls:'rssd-works-count',text:String(items.length)});
   head.addEventListener('click',()=>{if(this.collapsed.has(key))this.collapsed.delete(key);else this.collapsed.add(key);this.render();});
   if(this.collapsed.has(key))continue;
   const limit=this.limits.get(key)||WORKS_PAGE;
   for(const work of items.slice(0,limit))this.row(group,work);
   if(items.length>limit){const more=group.createDiv({cls:'rssd-works-more',text:'Show '+Math.min(WORKS_PAGE,items.length-limit)+' more of '+(items.length-limit)});more.addEventListener('click',()=>{this.limits.set(key,limit+WORKS_PAGE);this.render();});}
  }
  // Save takes what the Edited filter counts: the edited works of the language on screen.
  this.edited=all.filter(work=>this.states.get(work.file.path)?.state==='edited').map(work=>work.file);
  this.mark();this.renderFoot();void this.fillStates(every);
 }
 row(group,work){
  const row=group.createDiv({cls:'rssd-works-row'});row.dataset.path=work.file.path;
  const state=this.states.get(work.file.path)?.state;
  const dot=row.createSpan({cls:'rssd-works-dot'+(state?' is-'+state:'')});if(state)dot.setAttribute('aria-label',WORK_STATES[state]);
  row.createSpan({cls:'rssd-works-date',text:work.date.slice(5)});
  row.createSpan({cls:'rssd-works-title',text:work.title});
  row.setAttribute('aria-label',[work.title,work.date,WORK_STATES[state]].filter(Boolean).join(' · '));
  row.addEventListener('click',()=>void this.openWork(work.file));
 }
 // Not named open(): that is Obsidian's own method for starting a view, and replacing it stops the view from ever opening.
 async openWork(file){await this.app.workspace.getLeaf(false).openFile(file);this.mark();}
 /** Highlight the work open in the editor. */
 mark(){
  const current=this.plugin.currentWork()?.path;
  for(const row of this.list?.querySelectorAll('.rssd-works-row')||[])row.toggleClass('is-active',row.dataset.path===current);
 }
 /** Work out each work's state in the background, a few at a time, and show it as it arrives. */
 async fillStates(all){
  if(this.filling)return;this.filling=true;let changed=false;
  try{
   for(let i=0;i<all.length;i++){
    const work=all[i],before=this.states.get(work.file.path)?.state;
    const state=await this.stateOf(work);
    if(state!==before){changed=true;const dot=this.list.querySelector(`.rssd-works-row[data-path="${CSS.escape(work.file.path)}"] .rssd-works-dot`);if(dot){dot.className='rssd-works-dot is-'+state;dot.setAttribute('aria-label',WORK_STATES[state]);}}
    if(i%40===39)await new Promise(resolve=>window.setTimeout(resolve,0));
   }
  }finally{this.filling=false;}
  // Counts depend on the states; refresh them once the pass is complete.
  if(changed)this.render();
 }
 renderFoot(){
  if(!this.foot)return;this.foot.empty();
  const at=this.plugin.settings.lastPullAt,minutes=at?Math.round((Date.now()-at)/60000):null;
  this.foot.createSpan({cls:'rssd-works-pulled',text:at?'Last pull '+(minutes<1?'just now':minutes<60?minutes+' min ago':minutes<1440?Math.round(minutes/60)+' h ago':Math.round(minutes/1440)+' d ago'):'Not pulled yet'});
  const edited=this.saving?[]:this.edited||[];
  if(this.saving||(edited.length&&!Platform.isMobile)){
   const save=this.foot.createEl('button',{cls:'rssd-works-pull rssd-works-save mod-cta',text:this.saving||'Save '+edited.length});
   save.setAttribute('aria-label',this.saving?'Saving to the Center':'Save '+edited.length+(edited.length===1?' edited work':' edited works')+' to the Center as private drafts. Nothing is published.');
   save.disabled=!!this.saving;
   save.addEventListener('click',async()=>{
    const files=[...edited];if(!files.length)return;
    this.saving='Saving…';this.renderFoot();
    try{await this.plugin.saveEdited(files,{onProgress:(done,total)=>{this.saving='Saving '+done+'/'+total;this.renderFoot();}});}
    finally{this.saving=null;for(const file of files)this.states.delete(file.path);this.render();}
   });
  }
  const pull=this.foot.createEl('button',{cls:'rssd-works-pull',text:'Pull'});pull.addEventListener('click',async()=>{pull.disabled=true;try{await this.plugin.pull();}finally{pull.disabled=false;this.render();}});
 }
}

// One preview panel for every layout a work can be exported in. The top tabs are the views and the tabs under
// them are that view's styles. Views are named for what they produce, not for a platform: one view can serve
// several destinations. Each says how to build its result and what its button does with it.
const PREVIEW_TARGETS=[
 {id:'article',label:'Article',name:'Article view',icon:'file-text',copyLabel:'Copy article',actionIcon:'copy',
  // The site's own style comes first, under the site's name; the general themes are numbered (hover for names).
  styles:[{id:'site',site:true},...Object.entries(ARTICLE_THEMES).map(([id,theme],index)=>({id,label:String(index+1),name:theme.label}))],
  build:(plugin,file,content,style)=>plugin.wechatResult(file,content,{style}),copy:(plugin,file,style)=>plugin.copyForWechat(file,{style})},
 {id:'cards',label:'Cards',name:'Card view',icon:'gallery-vertical-end',copyLabel:'Save cards',actionIcon:'download',
  styles:[{id:'site',site:true},...Object.entries(CARD_THEMES).filter(([id])=>id!=='text').map(([id,theme],index)=>({id,label:String(index+1),name:theme.label}))],
  build:(plugin,file,content,style,options)=>plugin.cardsResult(file,content,{style,...options}),copy:(plugin,file,style,result)=>plugin.saveCards(file,result)},
 // Outline and details are not outputs: they show how the work is built and what it is, beside the outputs.
 {id:'outline',label:'Outline',name:'Outline',icon:'list',styles:[],panel:'outline'},
 {id:'details',label:'Details',name:'Work details',icon:'info',styles:[],panel:'details'},
];
// The result is shown the way it lands in an editor: no frame, no fixed width, filling whatever room there is.
// It sits in a shadow root so the Obsidian theme cannot restyle it: what shows is what is copied.
const PREVIEW_FRAME=':host{display:block;color-scheme:light}.page{background:#fff;color:#222;padding:20px 16px 32px;overflow-wrap:anywhere;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}.title{margin:0 0 18px;font-size:22px;line-height:1.4;font-weight:700}.body img{max-width:100%}.cards{padding:12px;background:#e6e6e6}.cards img{display:block;width:100%;max-width:1080px;height:auto;margin:0 auto 12px;box-shadow:0 1px 6px rgba(0,0,0,.18)}.cards img:last-child{margin-bottom:0}.message{padding:24px 16px;color:#888;font-size:13px}';
class LayoutPreview extends ItemView{
 constructor(leaf,plugin,type='rssd-article',targetId='article'){super(leaf);this.plugin=plugin;this.type=type;this.target=PREVIEW_TARGETS.find(t=>t.id===targetId);this.style=this.target.styles[0]?.id||'';this.file=null;this.content=null;this.result=null;this.urls=[];this.seq=0;}
 /** An icon button; its label is read out and shown as a tooltip. */
 iconButton(parent,icon,label,cls=''){const button=parent.createEl('button',{cls:'rssd-preview-icon'+(cls?' '+cls:'')});setIcon(button,icon);button.setAttribute('aria-label',label);return button;}
 /** Draw the output's style tabs and its action icon; choosing a style re-renders the preview. */
 drawTabs(){
  this.styleTabs.empty();
  for(const style of this.target.styles){
   const label=style.site?'Default':style.label,name=style.site?'Default: '+this.plugin.siteName()+'\'s own style for this section':style.name;
   const active=style.id===this.style,tab=this.styleTabs.createEl('button',{text:label,cls:'rssd-preview-tab'+(style.site?'':' is-number')+(active?' is-active':'')});tab.setAttribute('aria-pressed',String(active));
   tab.setAttribute('aria-label',name);
   tab.addEventListener('click',()=>{if(style.id===this.style)return;this.style=style.id;this.drawTabs();void this.show(this.file,{force:true});});
  }
  // Outline and details have no styles, status or action; the controls row belongs to the outputs.
  const output=!this.target.panel;this.controls.toggle(output);
  if(output){setIcon(this.actionButton,this.target.actionIcon);this.actionButton.setAttribute('aria-label',this.target.copyLabel);}
 }
 getViewType(){return this.type;}
 getDisplayText(){return this.target.name;}
 getIcon(){return this.target.icon;}
 async onOpen(){
  const el=this.contentEl;el.empty();el.style.padding='0';
  this.controls=el.createDiv({cls:'rssd-preview-controls'});
  this.styleTabs=this.controls.createDiv({cls:'rssd-preview-styles'});
  const actions=this.controls.createDiv({cls:'rssd-preview-actions'});
  this.iconButton(actions,'refresh-cw','Refresh').addEventListener('click',()=>this.show(this.file,{force:true}));
  // Outline and details have no action; their controls row stays hidden, but the button still needs an icon.
  this.actionButton=this.iconButton(actions,this.target.actionIcon||'copy',this.target.copyLabel||'','mod-cta');
  this.actionButton.addEventListener('click',()=>{if(this.file)void this.target.copy(this.plugin,this.file,this.style,this.result);});
  this.drawTabs();
  this.stage=el.createDiv({cls:'rssd-preview-stage'});
  this.root=this.stage.createDiv({cls:'rssd-preview-host'}).attachShadow({mode:'open'});
  const overlay=this.stage.createDiv({cls:'rssd-preview-loading'}),box=overlay.createDiv({cls:'rssd-preview-loading-box'});
  overlay.setAttribute('role','status');box.createDiv({cls:'rssd-preview-spinner'});this.loadingText=box.createDiv({cls:'rssd-preview-loading-text'});
  this.detailsEl=el.createDiv({cls:'rssd-details'});this.details=new WorkDetails(this.plugin,this.detailsEl);
  this.outlineEl=el.createDiv({cls:'rssd-outline'});this.outline=new WorkOutline(this.plugin,this.outlineEl);
  // Links in the preview are for looking at, not for leaving the vault.
  this.root.addEventListener('click',event=>{if(event.target?.closest?.('a'))event.preventDefault();});
  this.registerEvent(this.app.workspace.on('file-open',file=>{if(file&&this.plugin.isWork(file))void this.show(file);}));
  // Cards are redrawn page by page, so they wait longer for typing to pause.
  this.registerEvent(this.app.vault.on('modify',file=>{if(file===this.file){window.clearTimeout(this.timer);this.timer=window.setTimeout(()=>this.show(this.file),this.target.id==='cards'?2500:800);}}));
  this.registerEvent(this.app.workspace.on('active-leaf-change',leaf=>{if(leaf===this.leaf){this.catchUp();return;}const file=leaf?.view?.file;if(file&&this.plugin.isWork(file)&&file!==this.file)void this.show(file);}));
  // Details redraw after the note changes, but never under a field that is being edited.
  this.registerEvent(this.app.metadataCache.on('changed',file=>{if(file!==this.file)return;if(this.target.panel==='details'&&!this.detailsEl.contains(document.activeElement))void this.details.show(file);if(this.target.panel==='outline')this.outline.show(file);}));
  // Choosing this tab in the sidebar shows it without making it the active pane; its size changing from
  // nothing is the dependable sign that it is on screen.
  const watch=new ResizeObserver(()=>this.catchUp());watch.observe(this.contentEl);this.register(()=>watch.disconnect());
  this.registerEvent(this.app.workspace.on('layout-change',()=>this.catchUp()));
  this.app.workspace.onLayoutReady(()=>void this.show(this.plugin.currentWork()));
 }
 /** A tab that was hidden while its work changed catches up when it is shown. */
 onResize(){this.catchUp();}
 /** Draw what a hidden tab put off, once the tab is on screen. */
 catchUp(){if(this.waiting&&this.containerEl.isShown?.()!==false){const file=this.pendingFile;this.waiting=false;this.pendingFile=null;void this.show(file,{force:true});}}
 async onClose(){window.clearTimeout(this.timer);window.clearTimeout(this.loadingTimer);this.details.seq++;this.seq++;this.abort?.abort();this.release();}
 /**
  * Show or hide the loading cover. It appears only when building takes longer than a moment, so a quick
  * refresh does not flicker; the action button waits until the result it would copy or save is ready.
  */
 loading(on,text=''){
  if(text)this.loadingText.setText(text);
  this.actionButton.disabled=on;
  if(on){if(!this.stage.hasClass('is-loading')&&!this.loadingTimer)this.loadingTimer=window.setTimeout(()=>{this.loadingTimer=null;this.stage.addClass('is-loading');},150);return;}
  window.clearTimeout(this.loadingTimer);this.loadingTimer=null;this.stage.removeClass('is-loading');
 }
 release(){for(const url of this.urls)URL.revokeObjectURL(url);this.urls=[];}
 message(text){
  this.loading(false);this.release();
  const style=document.createElement('style'),note=document.createElement('div');style.textContent=PREVIEW_FRAME;note.className='message';note.textContent=text;
  this.root.replaceChildren(style,note);
 }
 async show(file,{force=false}={}){
  // An output tab behind another is not built until it is shown; cards in particular take a while. Outline
  // and details are cheap and always drawn.
  if(!this.target.panel&&this.containerEl.isShown&&!this.containerEl.isShown()){this.waiting=true;this.pendingFile=file||null;return;}
  this.waiting=false;this.pendingFile=null;
  // A newly opened work starts with its section's usual theme; a choice holds while the same work stays open.
  if(!this.target.panel&&file&&file!==this.file){this.defaultStyle=this.plugin.defaultStyle(this.target.id,file);this.style=this.defaultStyle;this.drawTabs();
   // The theme tabs take the colour of the work's section.
   const accent=this.plugin.sectionAccent(file);if(accent)this.controls.style.setProperty('--rssd-accent',accent);else this.controls.style.removeProperty('--rssd-accent');}
  const seq=++this.seq,panel=this.target.panel;
  this.stage.toggle(!panel);this.detailsEl.toggle(panel==='details');this.outlineEl.toggle(panel==='outline');
  if(panel){
   this.abort?.abort();this.loading(false);this.file=file;this.content=null;this.result=null;this.release();this.root.replaceChildren();
   try{if(panel==='details')await this.details.show(file);else this.outline.show(file);}
   catch(error){console.error('RSSD '+panel,error);const box=panel==='details'?this.detailsEl:this.outlineEl;box.empty();box.createDiv({cls:'rssd-details-empty',text:'Could not show this: '+(error?.message||error)});}
   return;
  }
  if(!file){this.abort?.abort();this.file=null;this.content=null;this.result=null;this.message('Open a work to preview it.');return;}
  try{
   const content=await this.app.vault.read(file);
   if(seq!==this.seq||(!force&&file===this.file&&content===this.content))return;
   // A newer request replaces one still being laid out.
   this.abort?.abort();const abort=this.abort=new AbortController();
   this.loading(true,this.target.id==='cards'?'Preparing cards…':'Preparing the article…');
   const result=await this.target.build(this.plugin,file,content,this.style,{signal:abort.signal,
    onProgress:step=>{if(seq===this.seq)this.loading(true,step.stage==='layout'?'Laying out card '+step.count+'…':'Drawing card '+step.count+' of '+step.total+'…');}});
   if(seq!==this.seq)return;
   this.file=file;this.content=content;this.result=result;this.loading(false);
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
  }catch(error){if(seq===this.seq&&error?.name!=='AbortError'){this.file=file;this.content=null;this.result=null;this.message('Could not preview: '+error.message);}}
 }
}

// Work details: the readers' fields of the open work, edited in place and measured against the outputs that
// use them, then the read-only fields that link the note to its Center work and its local sync state.
// The work's headings; choosing one moves the editor there, as Obsidian's own outline does.
class WorkOutline{
 constructor(plugin,el){this.plugin=plugin;this.app=plugin.app;this.el=el;}
 show(file){
  const el=this.el;el.empty();
  if(!file){el.createDiv({cls:'rssd-details-empty',text:'Open a work to see its outline.'});return;}
  const headings=this.app.metadataCache.getFileCache(file)?.headings||[];
  if(!headings.length){el.createDiv({cls:'rssd-details-empty',text:'This work has no headings.'});return;}
  const top=Math.min(...headings.map(h=>h.level));
  for(const heading of headings){
   const item=el.createDiv({cls:'rssd-outline-item is-level-'+(heading.level-top+1),text:heading.heading});
   item.style.paddingLeft=`calc(var(--size-2-2) + ${(heading.level-top)*14}px)`;item.setAttribute('role','button');item.tabIndex=0;
   const go=()=>this.reveal(file,heading.position.start.line);
   item.addEventListener('click',go);item.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();go();}});
  }
 }
 async reveal(file,line){
  const workspace=this.app.workspace;
  let leaf=workspace.getLeavesOfType('markdown').find(l=>l.view?.file===file);
  if(!leaf){leaf=workspace.getLeaf(false);await leaf.openFile(file);}
  leaf.view.setEphemeralState?.({line});workspace.setActiveLeaf(leaf,{focus:true});
 }
}

class WorkDetails{
 constructor(plugin,el){this.plugin=plugin;this.app=plugin.app;this.contentEl=el;this.file=null;this.seq=0;}
 async show(file){
  const seq=++this.seq,el=this.contentEl;this.file=file;
  if(!file){el.empty();el.createDiv({cls:'rssd-details-empty',text:'Open a work to see its details.'});return;}
  const content=await this.app.vault.read(file);if(seq!==this.seq)return;
  const properties=this.app.metadataCache.getFileCache(file)?.frontmatter||{};
  let work=null;try{work=noteToWork(content,parseYaml);}catch{}
  el.empty();
  for(const field of DETAIL_FIELDS)this.field(el,file,field,fieldText(properties[field.key]));
  if(work){
   const checks=checkSource({...work.data,kind:work.kind,media:work.media}).warnings;
   if(checks.length){const box=el.createDiv({cls:'rssd-details-checks'});box.createDiv({cls:'rssd-details-label',text:'To check'});for(const check of checks)box.createDiv({cls:'rssd-details-check',text:check.message});}
  }
  const link=el.createEl('details',{cls:'rssd-details-link'});link.createEl('summary',{text:'Center link'});
  const state=link.createDiv({cls:'rssd-details-state',text:'Checking…'});
  for(const [key,label] of IDENTITY_FIELDS){const row=link.createDiv({cls:'rssd-details-row'});row.createSpan({cls:'rssd-details-key',text:label});row.createSpan({cls:'rssd-details-value',text:fieldText(properties[key])||'—'});}
  link.createDiv({cls:'rssd-details-note',text:'These link the note to its Center work and are not edited here.'});
  const text=await this.syncState(file,work);if(seq===this.seq)state.setText(text);
 }
 /** One editable field: label, input, and a count for each output that limits it. Saved when you leave the field. */
 field(el,file,field,value){
  const row=el.createDiv({cls:'rssd-details-field'});row.createEl('label',{cls:'rssd-details-label',text:field.label});
  const input=field.multiline?row.createEl('textarea',{cls:'rssd-details-input'}):row.createEl('input',{cls:'rssd-details-input',type:field.type==='date'?'date':'text'});
  input.value=value;if(field.multiline)input.rows=4;
  const meter=row.createDiv({cls:'rssd-details-meter'});
  const measure=()=>{meter.empty();for(const count of counters(field,input.value))meter.createSpan({cls:'rssd-details-count'+(count.over?' is-over':''),text:count.name+' '+count.length+'/'+count.max});};
  measure();input.addEventListener('input',measure);
  input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!field.multiline){event.preventDefault();input.blur();}if(event.key==='Escape'){input.value=value;measure();input.blur();}});
  input.addEventListener('change',async()=>{
   let next;try{next=cleanValue(field,input.value);}catch(error){new Notice(error.message);input.value=value;measure();return;}
   if(next===value)return;
   try{await this.app.fileManager.processFrontMatter(file,properties=>{properties[field.key]=next;});value=next;}
   catch(error){console.error('RSSD work details',error);new Notice('Could not save '+field.label.toLowerCase()+': '+error.message,10000);input.value=value;measure();}
  });
 }
 /** Whether the note matches its last sync. Read locally; nothing is sent to the Center. */
 async syncState(file,work){
  if(!work)return 'This note is not linked to a Center work.';
  try{
   const engine=this.plugin.engine(),space=this.plugin.settings.workspaceId,base=await engine.store.get(space,work.data.id,work.data.locale);
   if(!base)return 'Not pulled from the Center yet.';
   if(base.pending)return 'Saving to the Center…';
   return await engine.hasLocalChanges(space,file.path)?'Edited since the last sync; saved as a private draft automatically.':'Unchanged since the last sync.';
  }catch(error){return 'Sync state unavailable: '+error.message;}
 }
}

const LOCALE_LABELS={'zh-CN':'中文',en:'English'};
class ReaderView extends ItemView{
 constructor(leaf,plugin){super(leaf);this.plugin=plugin;this.items=null;this.query='';this.article=null;this.urls=[];this.seq=0;}
 getViewType(){return 'rssd-reader';}
 getDisplayText(){return 'RSSD reader';}
 getIcon(){return 'book-open';}
 async onOpen(){this.contentEl.addClass('rssd-reader');void this.loadCatalog();}
 async onClose(){this.release();}
 release(){for(const url of this.urls)URL.revokeObjectURL(url);this.urls=[];this.articleComponent?.unload();this.articleComponent=null;}
 get s(){return this.plugin.settings;}
 // Not named load(): that is Obsidian's own lifecycle method for every view.
 async loadCatalog(){
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
  const row=new Setting(el).addButton(b=>b.setButtonText('Try again').onClick(()=>this.loadCatalog()));
  if(error?.status===401||!this.plugin.token())row.addButton(b=>b.setButtonText('Log in').setCta().onClick(async()=>{try{await this.plugin.login({openBrowser:true,selectSyncSpace:false});await this.loadCatalog();}catch(e){if(e?.code!=='cancelled')new Notice('Login failed: '+e.message,10000);}}));
 }
 renderList(){
  const el=this.contentEl,s=this.s;this.article=null;this.release();el.empty();
  const bar=new Setting(el).setName(this.spaces.find(w=>w.id===s.readerSpace)?.name||s.readerSpace);
  if(this.spaces.length>1)bar.addDropdown(d=>{for(const w of this.spaces)d.addOption(w.id,w.name);d.setValue(s.readerSpace).onChange(async v=>{s.readerSpace=v;await this.plugin.saveSettings();void this.loadCatalog();});});
  bar.addDropdown(d=>{for(const [k,v] of Object.entries(LOCALE_LABELS))d.addOption(k,v);d.setValue(s.readerLocale||'zh-CN').onChange(async v=>{s.readerLocale=v;await this.plugin.saveSettings();void this.loadCatalog();});});
  bar.addExtraButton(b=>b.setIcon('refresh-cw').setTooltip('Refresh').onClick(()=>this.loadCatalog()));
  new Setting(el).setName('Include unpublished drafts').addToggle(t=>t.setValue(!!s.readerDrafts).onChange(async v=>{s.readerDrafts=v;await this.plugin.saveSettings();void this.loadCatalog();}))
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
   row.settingEl.addEventListener('click',()=>this.openArticle(item));
  }
 }
 // Not named open(): that is Obsidian's own method for starting a view.
 async openArticle(item){
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
  const bar=new Setting(el).addButton(b=>b.setButtonText('← All articles').onClick(()=>this.items?this.renderList():this.loadCatalog()));
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
