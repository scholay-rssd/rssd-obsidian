// RSSD for Obsidian, stage 1: open a space from the RSSD Center as a vault of drafts, see each work's sync
// state, and save edits back as private drafts. Publishing is never done here.
import {Plugin,PluginSettingTab,Setting,Notice,Modal,requestUrl,parseYaml,stringifyYaml,Platform,TFile,normalizePath} from 'obsidian';
import {createCenterClient,centerOrigin} from './center-client.mjs';
import {deviceLogin} from './device-login.mjs';
import {SyncEngine} from './sync-engine.mjs';
import {saveFailureMessage} from './messages.mjs';
import {STATE_LABELS,WORKS_FOLDER,MEDIA_FOLDER} from './sync-model.mjs';

const TOKEN_SECRET='rssd-center-device-token';
const DEFAULTS={origin:'',deviceName:'',workspaceId:'',baselines:{}};
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
  this.status=this.addStatusBarItem();this.setStatus('RSSD');
  this.addSettingTab(new RssdSettings(this.app,this));
  this.addCommand({id:'login',name:'Log in to the RSSD Center',callback:()=>this.login()});
  this.addCommand({id:'pull',name:'Pull works from the Center',callback:()=>this.pull()});
  this.addCommand({id:'save',name:'Save this work to the Center as a private draft',checkCallback:checking=>{
   const file=this.app.workspace.getActiveFile();if(!file||!this.isWork(file))return false;if(!checking)this.save(file);return true;}});
  this.addCommand({id:'status',name:'Check sync state of all works',callback:()=>this.refreshStates()});
 }
 isWork(file){return file.extension==='md'&&file.path.startsWith(WORKS_FOLDER+'/');}
 setStatus(text){this.status?.setText(text);}
 token(){return this.app.secretStorage.getSecret(TOKEN_SECRET);}
 saveSettings(){return this.saveData(this.settings);}

 engine(){
  const token=this.token();if(!token||!this.settings.origin)throw Error('Log in to the RSSD Center first');
  if(!this.settings.workspaceId)throw Error('Choose a space in the RSSD settings');
  const adapter=this.app.vault.adapter,vault=this.app.vault;
  return new SyncEngine({
   client:createCenterClient({http,origin:this.settings.origin,token}),
   yaml:{parse:parseYaml,stringify:stringifyYaml},
   vault:{
    read:async path=>await adapter.exists(path)?adapter.read(path):null,
    readBinary:async path=>await adapter.exists(path)?new Uint8Array(await adapter.readBinary(path)):null,
    write:async(path,content)=>{await this.ensureFolder(path);const file=vault.getAbstractFileByPath(path);if(file instanceof TFile)await vault.modify(file,content);else await vault.create(path,content);},
    writeBinary:async(path,bytes)=>{await this.ensureFolder(path);if(!await adapter.exists(path))await vault.createBinary(path,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));},
   },
   store:{
    get:async(space,id)=>this.settings.baselines[space]?.[id]??null,
    set:async(space,id,value)=>{(this.settings.baselines[space]??={})[id]=value;await this.saveSettings();},
    delete:async(space,id)=>{delete this.settings.baselines[space]?.[id];await this.saveSettings();},
    list:async space=>Object.values(this.settings.baselines[space]||{}),
   },
  });
 }
 async ensureFolder(path){
  const folder=path.split('/').slice(0,-1).join('/');
  if(folder&&!await this.app.vault.adapter.exists(folder))await this.app.vault.createFolder(folder);
 }

 async login(){
  try{
   const origin=centerOrigin(this.settings.origin),controller=new AbortController();
   let modal;
   const result=await deviceLogin({http,origin,name:this.settings.deviceName||('Obsidian on '+(Platform.isMobile?'mobile':'desktop')),signal:controller.signal,
    onCode:info=>{modal=new CodeModal(this.app,info);modal.onCancel=()=>controller.abort();modal.open();}});
   if(modal){modal.onCancel=null;modal.close();}
   this.app.secretStorage.setSecret(TOKEN_SECRET,result.token);
   const spaces=result.identity?.workspaceIds||[];
   if(spaces.length===1)this.settings.workspaceId=spaces[0];
   this.settings.spaces=spaces;await this.saveSettings();
   new Notice('Logged in to the RSSD Center'+(spaces.length?'. Spaces: '+spaces.join(', '):''));
  }catch(error){new Notice('Login failed: '+error.message);}
 }

 async pull(){
  try{
   this.setStatus('RSSD: pulling…');
   const summary=await this.engine().pull(this.settings.workspaceId);
   const parts=[summary.downloaded.length+' new',summary.updated.length+' updated',summary.unchanged+' unchanged'];
   if(summary.skipped.length)parts.push(summary.skipped.length+' kept (local changes)');
   if(summary.conflicts.length)parts.push(summary.conflicts.length+' in conflict');
   new Notice('Pull finished: '+parts.join(', '));
   if(summary.conflicts.length)new Notice('Conflicts were not changed: '+summary.conflicts.join(', '),10000);
   this.setStatus('RSSD');
  }catch(error){this.setStatus('RSSD');new Notice('Pull failed: '+error.message);}
 }

 async save(file){
  try{
   const result=await this.engine().save(this.settings.workspaceId,file.path);
   new Notice(result.state==='unchanged'?'Nothing to save':'Saved as a private draft (revision '+result.revision+'). It is not published.');
  }catch(error){
   console.error('RSSD save failed',error.status,error.code,error.message);
   new Notice(saveFailureMessage(error),10000);
  }
 }

 async refreshStates(){
  try{
   const states=await this.engine().states(this.settings.workspaceId),counts={};
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
   .addText(t=>t.setPlaceholder('https://center.example.org').setValue(s.origin).onChange(async v=>{s.origin=v.trim();await this.plugin.saveSettings();}));
  new Setting(containerEl).setName('Device name').setDesc('Shown in the Center when you approve this device.')
   .addText(t=>t.setValue(s.deviceName).onChange(async v=>{s.deviceName=v.trim();await this.plugin.saveSettings();}));
  new Setting(containerEl).setName('Space').setDesc('One vault per space. Leave blank until you have logged in.')
   .addText(t=>t.setValue(s.workspaceId).onChange(async v=>{s.workspaceId=v.trim();await this.plugin.saveSettings();}));
  new Setting(containerEl).setName('Log in').setDesc(this.plugin.token()?'This device is logged in.':'Approve this device in your browser.')
   .addButton(b=>b.setButtonText('Log in').setCta().onClick(()=>this.plugin.login()));
  new Setting(containerEl).setName('Pull works').setDesc('Download new and changed works into '+WORKS_FOLDER+'/ (images go to '+MEDIA_FOLDER+'/). Notes with local changes are never overwritten.')
   .addButton(b=>b.setButtonText('Pull').onClick(()=>this.plugin.pull()));
 }
}
