// RSSD for Obsidian, stage 1: open a space from the RSSD Center as a vault of drafts, see each work's sync
// state, and save edits back as private drafts. Publishing is never done here.
import {Plugin,PluginSettingTab,Setting,Notice,Modal,requestUrl,parseYaml,stringifyYaml,Platform,TFile,normalizePath,ItemView} from 'obsidian';
import {createCenterClient,centerOrigin} from './center-client.mjs';
import {OperationGate,automationRequest,recordedOperation} from './operations.mjs';
import {deviceLogin} from './device-login.mjs';
import {SyncEngine} from './sync-engine.mjs';
import {saveFailureMessage} from './messages.mjs';
import {spaceInfo,readOnlyReason,spacesSummary} from './spaces.mjs';
import {STATE_LABELS,WORKS_FOLDER,MEDIA_FOLDER} from './sync-model.mjs';

const TOKEN_SECRET='rssd-center-device-token';
const DEFAULTS={origin:'',deviceName:'',workspaceId:'',baselines:{},allowAutomation:false};
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

export default class RssdPlugin extends Plugin{
 async onload(){
  this.settings=Object.assign({},DEFAULTS,await this.loadData());
  this.operations=new OperationGate();
  this.settings.boundOrigin??=this.settings.origin;
  this.settings.boundSpace??=Object.keys(this.settings.baselines).find(k=>Object.keys(this.settings.baselines[k]||{}).length)||'';
  await this.saveSettings();
  this.registerView('rssd-works',leaf=>new WorksView(leaf,this));
  this.addRibbonIcon('files','RSSD works',()=>this.openWorks());
  this.addCommand({id:'works',name:'Open RSSD works',callback:()=>this.openWorks()});
  this.status=this.addStatusBarItem();this.setStatus('RSSD');
  this.addSettingTab(new RssdSettings(this.app,this));
  this.addCommand({id:'login',name:'Log in to the RSSD Center',callback:()=>this.login().catch(error=>new Notice('Login failed: '+error.message))});
  this.addCommand({id:'pull',name:'Pull works from the Center',callback:()=>this.pull()});
  this.addCommand({id:'save',name:'Save this work to the Center as a private draft',checkCallback:checking=>{
   const file=this.app.workspace.getActiveFile();if(!file||!this.isWork(file))return false;if(!checking)this.save(file);return true;}});
  this.addCommand({id:'status',name:'Check sync state of all works',callback:()=>this.refreshStates()});
  this.addCommand({id:'spaces',name:'Show which spaces accept saves',callback:()=>this.showSpaces()});
  // obsidian://rssd?vault=<vault>&do=login|pull|save|status|spaces[&path=Works/x.md] lets scripts and agents drive
  // the plugin. Any app or page can open such a link, so it only works when the vault opts in.
  this.registerObsidianProtocolHandler('rssd',params=>this.automate(params));

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
     if(request.action==='pull')return this.engine().pull(space);
     if(request.action==='status')return this.engine().states(space);
     if(request.action==='spaces')return (await this.client().registry()).workspaces?.map(w=>({id:w.id,writable:w.writable===true,migrationState:w.migrationState??null}));
     await this.assertWritable();return this.engine().save(space,request.path);
    }}));
   new Notice('RSSD '+request.action+': '+(record.error||record.state));
  }catch(error){new Notice('RSSD: '+error.message);}
 }
 async assertWritable(){
  if(Platform.isMobile)throw Error('RSSD is read-only on mobile');
  const reason=readOnlyReason(spaceInfo(await this.client().registry(),this.settings.workspaceId),this.settings.workspaceId);
  if(reason)throw Object.assign(Error(reason),{code:'migration_staged'});
 }
 assertBinding(){
  if(centerOrigin(this.settings.origin)!==centerOrigin(this.settings.boundOrigin||this.settings.origin))throw Error('This login belongs to a different Center. Use a separate vault.');
  if(this.settings.boundSpace&&this.settings.workspaceId!==this.settings.boundSpace)throw Error('This vault is bound to '+this.settings.boundSpace+'. Open a separate vault for another space.');
 }
 async openWorks(){const leaf=this.app.workspace.getLeavesOfType('rssd-works')[0]||this.app.workspace.getRightLeaf(false);await leaf.setViewState({type:'rssd-works',active:true});this.app.workspace.revealLeaf(leaf);}
 isWork(file){return file.extension==='md'&&file.path.startsWith(WORKS_FOLDER+'/');}
 setStatus(text){this.status?.setText(text);}
 token(){return this.app.secretStorage.getSecret(TOKEN_SECRET);}
 saveSettings(){return this.saveData(this.settings);}

 engine(){
  this.assertBinding();
  const token=this.token();if(!token||!this.settings.origin)throw Error('Log in to the RSSD Center first');
  if(!this.settings.workspaceId)throw Error('Choose a space in the RSSD settings');
  const adapter=this.app.vault.adapter,vault=this.app.vault;
  return new SyncEngine({
   client:createCenterClient({http,origin:this.settings.origin,token}),
   yaml:{parse:parseYaml,stringify:stringifyYaml},
   vault:{
    read:async path=>await adapter.exists(path)?adapter.read(path):null,
    readBinary:async path=>await adapter.exists(path)?new Uint8Array(await adapter.readBinary(path)):null,
    write:async(path,content,{expectedContent=null}={})=>{await this.ensureFolder(path);const file=vault.getAbstractFileByPath(path);if(file instanceof TFile)await vault.process(file,current=>{if(current!==expectedContent)throw Object.assign(Error('Local edits were kept'),{code:'local_edit_during_pull'});return content;});else{if(expectedContent!==null)throw Object.assign(Error('The local file was moved or removed'),{code:'local_edit_during_pull'});await vault.create(path,content);}},
    writeBinary:async(path,bytes)=>{await this.ensureFolder(path);if(!await adapter.exists(path))await vault.createBinary(path,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));},
   },
   store:{
    get:async(space,id)=>this.settings.baselines[space]?.[id]??null,
    set:async(space,id,value)=>{this.settings.boundSpace=space;(this.settings.baselines[space]??={})[id]=value;await this.saveSettings();},
    delete:async(space,id)=>{delete this.settings.baselines[space]?.[id];await this.saveSettings();},
    list:async space=>Object.values(this.settings.baselines[space]||{}),
   },
  });
 }
 async ensureFolder(path){
  const folder=path.split('/').slice(0,-1).join('/');
  if(folder&&!await this.app.vault.adapter.exists(folder))await this.app.vault.createFolder(folder);
 }

 async login(options={}){return this.operations.run('login',()=>this.performLogin(options));}
 async performLogin({openBrowser=false}={}){
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
   if(!space&&spaces.length===1)this.settings.workspaceId=spaces[0];
   this.settings.spaces=spaces;await this.saveSettings();
   new Notice('Logged in to the RSSD Center');
   return {loggedIn:true,spaces};
  }finally{if(modal){modal.onCancel=null;modal.close();}this.loginController=null;}
 }
 onunload(){this.loginController?.abort();}
 async pull(){
  try{
   this.setStatus('RSSD: pulling…');
   const summary=await this.operations.run('pull',()=>this.engine().pull(this.settings.workspaceId));
   const parts=[summary.downloaded.length+' new',summary.updated.length+' updated',summary.unchanged+' unchanged'];
   if(summary.skipped.length)parts.push(summary.skipped.length+' kept (local changes)');
   if(summary.conflicts.length)parts.push(summary.conflicts.length+' in conflict');
   new Notice('Pull finished: '+parts.join(', '));
   if(summary.conflicts.length)new Notice('Conflicts were not changed: '+summary.conflicts.join(', '),10000);
   this.setStatus('RSSD');
  }catch(error){this.setStatus('RSSD');new Notice('Pull failed: '+error.message);}
 }

 client(){
  this.assertBinding();
  const token=this.token();if(!token||!this.settings.origin)throw Error('Log in to the RSSD Center first');
  return createCenterClient({http,origin:this.settings.origin,token});
 }
 async showSpaces(){
  try{new Notice(spacesSummary(await this.client().registry()),15000);}
  catch(error){new Notice('Could not read spaces: '+error.message);}
 }
 async save(file){
  try{
   const result=await this.operations.run('save',async()=>{await this.assertWritable();return this.engine().save(this.settings.workspaceId,file.path);});
   new Notice(result.state==='unchanged'?'Nothing to save':'Saved as a private draft (revision '+result.revision+'). It is not published.');
  }catch(error){
   console.error('RSSD save failed',error.status,error.code,error.message);
   new Notice(saveFailureMessage(error),10000);
  }
 }

 async refreshStates(){
  try{
   const states=await this.operations.run('status',()=>this.engine().states(this.settings.workspaceId)),counts={};
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
  new Setting(containerEl).setName('Device name').setDesc('Shown in the Center when you approve this device.')
   .addText(t=>t.setValue(s.deviceName).onChange(async v=>{s.deviceName=v.trim();await this.plugin.saveSettings();}));
  new Setting(containerEl).setName('Space').setDesc(s.boundSpace?'This vault is bound to '+s.boundSpace+'. Use a separate vault for another space.':'Choose an authorized space before pulling.')
   .addDropdown(t=>{t.addOption('','Choose a space');for(const id of new Set([s.workspaceId,...(s.spaces||[])].filter(Boolean)))t.addOption(id,id);t.setValue(s.workspaceId).setDisabled(!!s.boundSpace).onChange(async v=>{if(this.plugin.operations.active||s.boundSpace)return;s.workspaceId=v;await this.plugin.saveSettings();});});
  new Setting(containerEl).setName('Log in').setDesc(this.plugin.token()?'This device is logged in.':'Approve this device in your browser.')
   .addButton(b=>b.setButtonText('Log in').setCta().onClick(()=>this.plugin.login().catch(error=>new Notice('Login failed: '+error.message))));
  new Setting(containerEl).setName('Command links').setDesc('Allow local commands to drive this vault. Each request has its own receipt.').addToggle(t=>t.setValue(!!s.allowAutomation).onChange(async v=>{s.allowAutomation=v;await this.plugin.saveSettings();}));
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
   const data=await this.plugin.operations.run('works',async()=>({registry:await this.plugin.client().registry(),states:await this.plugin.engine().states(this.plugin.settings.workspaceId)}));
   const reason=readOnlyReason(spaceInfo(data.registry,this.plugin.settings.workspaceId),this.plugin.settings.workspaceId);
   if(reason)el.createEl('p',{text:reason});
   for(const [id,state] of Object.entries(data.states)){
    const file=this.app.vault.getAbstractFileByPath(WORKS_FOLDER+'/'+id+'.md');
    const title=file?this.app.metadataCache.getFileCache(file)?.frontmatter?.title:null;
    new Setting(el).setName(String(title||id)).setDesc(STATE_LABELS[state]||state).addButton(b=>b.setButtonText(file?'Open':'Pull first').setDisabled(!file).onClick(()=>this.app.workspace.getLeaf(false).openFile(file)));
   }
  }catch(error){el.createEl('p',{text:error.message});}
 }
}
