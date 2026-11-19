import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {OperationGate} from '../src/operations.mjs';
import {AutoSync} from '../src/auto-sync.mjs';
import {yaml} from './helpers.mjs';
const result=await build({entryPoints:['src/main.js'],bundle:true,format:'cjs',platform:'browser',external:['obsidian'],write:false});
let response,modal;
const mock={Plugin:class{},PluginSettingTab:class{},ItemView:class{},TFile:class{},Setting:class{},Notice:class{},Platform:{isMobile:false},
 Modal:class{constructor(){modal=this;}open(){}close(){this.closed=true;this.onCancel?.();}},requestUrl:async req=>response(req),parseYaml:yaml.parse,stringifyYaml:yaml.stringify};
const module={exports:{}};new Function('require','module','exports',result.outputFiles[0].text)(()=>mock,module,module.exports);
const Plugin=module.exports.default;
function plugin(){
 const p=new Plugin();p.operations=new OperationGate();p.settings={origin:'https://center.example.org',boundOrigin:'https://center.example.org',workspaceId:'metho'};
 let secret='rssd_device_'+'a'.repeat(48);p.app={secretStorage:{getSecret:()=>secret,setSecret:(_k,v)=>secret=v}};p.saveSettings=async()=>{};p.records=[];p.writeRun=async r=>p.records.push(r);return p;
}
const start={status:200,json:{verificationUriComplete:'https://center.example.org/device',userCode:'ABCD',deviceCode:'secret',expiresIn:0}};
test('failed login preserves the original error even when an old token exists',async()=>{
 response=async()=>({status:403,json:{code:'access_denied',message:'Not authorized'}});
 const p=plugin();await assert.rejects(p.login(),e=>e.code==='access_denied'&&e.status===403);
 assert.ok(p.token());assert.equal(p.operations.active,null);assert.equal(p.records.at(-1).code,'access_denied');
});
test('expired login closes its modal and clears its cancellation controller',async()=>{
 response=async()=>start;const p=plugin();await assert.rejects(p.login(),e=>e.code==='expired_token');
 assert.equal(modal.closed,true);assert.equal(modal.onCancel,null);assert.equal(p.loginController,null);
});
test('changing the Center or space refuses use of an existing credential before HTTP',()=>{
 const p=plugin();p.settings.origin='https://another.example.org';assert.throws(()=>p.client(),/different Center/);
 p.settings.origin=p.settings.boundOrigin;p.settings.boundSpace='personal';assert.throws(()=>p.client(),/bound to personal/);
});
test('mobile cannot save a private draft',async()=>{
 const p=plugin();mock.Platform.isMobile=true;
 try{await assert.rejects(p.assertWritable(),/read-only on mobile/);}finally{mock.Platform.isMobile=false;}
});
test('a failed interactive pull retains its failed work and partial progress without a token',async()=>{
 const p=plugin();p.setStatus=()=>{};
 p.client=()=>({registry:async()=>({workspaces:[{id:'metho',writable:true,migrationState:'active'}]})});
 p.engine=()=>({store:{list:async()=>[]},pull:async(_space,{onProgress})=>{
  await onProgress({articleId:'one',summary:{downloaded:[]}});
  throw Object.assign(new Error('offline rssd_device_'+'b'.repeat(48)),{code:'network_error',articleId:'two',pullSummary:{downloaded:['one']}});
 }});
 await p.pull();
 assert.equal(p.records[0].state,'running');
 assert.equal(p.records.at(-1).state,'failed');
 assert.equal(p.records.at(-1).articleId,'two');
 assert.deepEqual(p.records.at(-1).partial,{downloaded:['one']});
 assert.doesNotMatch(JSON.stringify(p.records),/rssd_device_/);
 assert.equal(p.operations.active,null);
});
test('an interactive pull records its final result after its progress',async()=>{
 const p=plugin();p.setStatus=()=>{};
 p.client=()=>({registry:async()=>({workspaces:[{id:'metho',writable:true,migrationState:'active'}]})});
 const result={downloaded:['one'],updated:[],unchanged:0,skipped:[],conflicts:[],removedFromCenter:[]};
 p.engine=()=>({store:{list:async()=>[]},pull:async(_space,{onProgress,locale})=>{await onProgress({articleId:'one',summary:{downloaded:[]}});return locale==='zh-CN'?result:{...result,downloaded:['two']};}});
 await p.pull();
 assert.equal(p.records.at(-1).state,'completed');assert.equal(p.records.at(-1).ok,true);
 assert.deepEqual(p.records.at(-1).result.downloaded,['one','en/two']);
});

test('save routes active and staged spaces to separate write handlers',async()=>{
 const p=plugin();let canonical=0;
 const engine={save:async()=>{canonical++;return {state:'saved'};},noteFingerprint:async()=>null};
 p.client=()=>({registry:async()=>({workspaces:[{id:'metho',writable:true,migrationState:'active'},{id:'personal',writable:false,migrationState:'staged'}]})});
 assert.equal((await p.saveWork('metho','Works/one.md',engine)).state,'saved');assert.equal(canonical,1);
 await assert.rejects(p.saveWork('personal','Works/one.md',engine),/not an RSSD work/);assert.equal(canonical,1,'staged writes never use the canonical handler');
 await assert.rejects(p.saveWork('unknown','Works/one.md',engine),{code:'forbidden'});
});

test('a staged pull reconciles both languages through the private branch',async()=>{
 const p=plugin(),seen=[];p.settings.workspaceId='personal';
 p.client=()=>({registry:async()=>({workspaces:[{id:'personal',writable:false,migrationState:'staged'}]})});
 p.engine=()=>({client:{stagedSite:async()=>({capabilities:['staged-drafts-v1']}),stagedList:async(_space,locale)=>{seen.push(locale);return {items:[],generation:1,next:null};}},store:{list:async()=>[]},pull:async()=>({downloaded:[],updated:[],skipped:[],conflicts:[],pending:[],failed:[],metadataPending:[],removedFromCenter:[],unchanged:0})});
 const result=await p.pullAll('personal');assert.deepEqual(seen,['zh-CN','en']);assert.deepEqual(result.conflicts,[]);
});

test('moving a linked note blocks recreation until the returned identity is verified',async()=>{
 const p=plugin();p.settings.baselines={metho:{'one':{articleId:'one'}}};p.settings.pathRecords={};let marked='',unblocked='';
 p.autoSync={mark:path=>marked=path,unblock:path=>unblocked=path};
 p.app.vault={adapter:{read:async()=>"---\nrssd-id: one\nrssd-locale: zh-CN\n---\nBody"}};
 await p.recordPathChange('rename','Works/one.md','Archive/one.md');
 assert.equal(p.settings.pathRecords['zh-CN/one'].state,'moved');
 await p.recordPathChange('rename','Archive/one.md','Works/one.md');
 assert.deepEqual(p.settings.pathRecords,{});assert.equal(marked,'Works/one.md');assert.equal(unblocked,marked);
});
test('each scan queues the works whose private record waits, and a refused one is reported once until its note is edited',async()=>{
 const p=plugin(),saves=[],reports=[];let now=0,tooLarge=true;
 const dir='.rssd/private-additions',files=[dir+'/one.zh-CN.json',dir+'/two.en.json',dir+'/notes.txt'];
 p.app.vault={adapter:{exists:async path=>path===dir,list:async path=>({files:path===dir?files:[],folders:[]})}};
 // As for a work whose pictures are over the Center's limit: refused before anything is sent, with no code.
 p.autoSync=new AutoSync({now:()=>now,pull:async()=>({}),report:r=>reports.push(r),save:async path=>{
  saves.push(path);if(path==='Works/one.md'&&tooLarge)throw Error('The images exceed the Center limit of 2 MiB');return {state:'unchanged'};}});
 // Three hours as the plugin runs them: the scan and its queueing, then the next 10-second tick.
 for(let hour=0;hour<3;hour++){await p.queuePrivateAdditions();await p.autoSync.tick({scan:true});now+=10000;await p.autoSync.tick();now+=3600000;}
 assert.deepEqual(saves,['Works/one.md','Works/en/two.md'],'each waiting record queues its work once');
 assert.deepEqual(reports.map(r=>r.path),['Works/one.md']);assert.equal(p.autoSync.blocked.has('Works/one.md'),true);
 tooLarge=false;p.autoSync.mark('Works/one.md');now+=5000;await p.autoSync.tick();
 assert.deepEqual(saves.slice(2),['Works/one.md'],'an edit retries the refused work');assert.equal(p.autoSync.blocked.size,0);assert.equal(reports.length,1);
});
test('concurrent settings writes preserve pending saves and path guards in order',async()=>{
 const p=plugin();let release;const writes=[];p.saveSettings=Plugin.prototype.saveSettings.bind(p);
 p.saveData=async snapshot=>{writes.push(snapshot);if(writes.length===1)await new Promise(resolve=>release=resolve);};
 p.settings.baselines={metho:{one:{pending:{requestKey:'keep-original'}}}};const a=p.saveSettings();await new Promise(resolve=>setImmediate(resolve));
 p.settings.pathRecords={'zh-CN/one':{state:'moved'}};const b=p.saveSettings();release();await Promise.all([a,b]);
 assert.equal(writes.length,2);assert.equal(writes[1].baselines.metho.one.pending.requestKey,'keep-original');assert.equal(writes[1].pathRecords['zh-CN/one'].state,'moved');
});
test('baseline changes are journaled and folded into the settings file when a pull ends',async()=>{
 const p=plugin();const files=new Map(),writes=[];p.saveSettings=Plugin.prototype.saveSettings.bind(p);p.saveData=async snapshot=>{writes.push(snapshot);};
 p.manifest={dir:'.obsidian/plugins/rssd'};p.settings.baselines={};const journal=p.manifest.dir+'/baselines.journal';
 p.app.vault={adapter:{exists:async path=>files.has(path),read:async path=>files.get(path),append:async(path,text)=>files.set(path,(files.get(path)||'')+text),remove:async path=>files.delete(path)}};
 const store=p.engine().store;
 await store.set('metho','one',{articleId:'one',version:1});await store.set('metho','two',{articleId:'two',version:1},'en');await store.delete('metho','two','en');
 assert.equal(writes.length,0);assert.equal(files.get(journal).trim().split(/\n+/).length,3);
 assert.deepEqual(await store.get('metho','one'),{articleId:'one',version:1});assert.deepEqual(await store.list('metho','en'),[]);assert.equal(p.settings.boundSpace,'metho');
 p.client=()=>({registry:async()=>({workspaces:[{id:'metho',writable:true,migrationState:'active'}]})});
 p.engine=()=>({store:{list:async()=>[]},pull:async()=>({downloaded:[],unchanged:1})});
 await p.pullAll('metho');
 assert.equal(writes.length,1);assert.equal(writes[0].baselines.metho.one.version,1);assert.equal(files.has(journal),false);
});

test('a pull that changes nothing still records when it happened',async()=>{
 const p=plugin(),writes=[];p.saveSettings=Plugin.prototype.saveSettings.bind(p);p.saveData=async snapshot=>{writes.push(snapshot);};
 p.manifest={dir:'.obsidian/plugins/rssd'};p.app.vault={adapter:{exists:async()=>false,read:async()=>null,append:async()=>{},remove:async()=>{}}};
 p.client=()=>({registry:async()=>({workspaces:[{id:'metho',writable:true,migrationState:'active'}]})});
 p.engine=()=>({store:{list:async()=>[]},pull:async()=>({downloaded:[],unchanged:3})});
 const before=Date.now();await p.pullAll('metho');
 assert.equal(writes.length,1);assert.ok(writes[0].lastPullAt>=before);
 // A pull that fails is not recorded as a pull.
 p.engine=()=>({store:{list:async()=>[]},pull:async()=>{throw Object.assign(Error('offline'),{code:'network_error'});}});
 await assert.rejects(p.pullAll('metho'),{code:'network_error'});assert.equal(writes.length,1);
});

test('interactive spaces checks persist a fresh scoped receipt',async()=>{
 const p=plugin();p.client=()=>({registry:async()=>({workspaces:[{id:'metho',writable:true,migrationState:'active'}]})});
 await p.showSpaces();const r=p.records.at(-1);
 assert.equal(r.action,'spaces');assert.equal(r.workspaceId,'metho');assert.equal(r.origin,'https://center.example.org');assert.equal(r.path,'');
 assert.equal(r.state,'completed');assert.equal(r.ok,true);assert.deepEqual(r.result,[{id:'metho',writable:true,migrationState:'active'}]);
});
test('failed interactive spaces checks preserve the failure in a receipt',async()=>{
 const p=plugin();p.client=()=>({registry:async()=>{throw Object.assign(Error('offline'),{code:'network_error'});}});
 await p.showSpaces();assert.equal(p.records.at(-1).state,'failed');assert.equal(p.records.at(-1).code,'network_error');
});
test('a reader login does not choose a sync space, so nothing is downloaded',async()=>{
 const token='rssd_device_'+'c'.repeat(48);
 response=async req=>req.url.endsWith('/auth/start')?{status:200,json:{verificationUriComplete:'https://center.example.org/device',userCode:'ABCD',deviceCode:'d',expiresIn:600,interval:5}}
  :{status:200,json:{token,identity:{workspaceIds:['metho']}}};
 const realTimeout=globalThis.setTimeout;globalThis.setTimeout=(fn)=>realTimeout(fn,0);
 try{
  const p=plugin();p.settings.workspaceId='';
  await p.login({selectSyncSpace:false});assert.equal(p.settings.workspaceId,'');assert.equal(p.token(),token);
  const q=plugin();q.settings.workspaceId='';await q.login();assert.equal(q.settings.workspaceId,'metho');
 }finally{globalThis.setTimeout=realTimeout;}
});
test('reading uses the login Center without requiring the vault sync space',()=>{
 const p=plugin();p.settings.boundSpace='personal';assert.throws(()=>p.client(),/bound to personal/);
 assert.equal(p.readClient().origin,'https://center.example.org');
 p.settings.origin='https://another.example.org';assert.throws(()=>p.readClient(),/different Center/);
});
test('the layout is arranged once: the Works list on the left, RSSD tabs only next to the note, the right sidebar left to Obsidian',async()=>{
 const p=plugin(),config={propertiesInDocument:'visible'},right={},left={},root={};p.saveSettings=async()=>{};
 const leaf=(type,where,parent)=>({type,where,parent,detached:false,getRoot(){return this.where;},detach(){this.detached=true;}});
 const leaves=[leaf('rssd-preview',right),leaf('rssd-details',right),leaf('rssd-outline',right),leaf('backlink',right),leaf('outline',right),leaf('tag',left),leaf('file-explorer',left)];
 const works={setViewState:async state=>{works.state=state;}},revealed=[];
 p.app.workspace={rightSplit:right,leftSplit:left,rootSplit:root,getLeftLeaf:split=>{assert.equal(split,false);return works;},getLeavesOfType:type=>leaves.filter(l=>l.type===type&&!l.detached),
  getRightLeaf:()=>assert.fail('nothing is added to the right sidebar'),revealLeaf:l=>revealed.push(l)};
 p.app.vault={getConfig:key=>config[key],setConfig:(key,value)=>{config[key]=value;}};
 assert.equal(await p.tidySidebar(),true);
 assert.deepEqual(leaves.filter(l=>l.detached).map(l=>l.type),['rssd-preview','rssd-details','rssd-outline']);
 assert.deepEqual(leaves.filter(l=>!l.detached).map(l=>l.type),['backlink','outline','tag','file-explorer'],'Obsidian\'s own tabs are left where they are');
 assert.deepEqual(revealed,[works]);assert.deepEqual(works.state,{type:'rssd-works',active:true},'the Works list opens in the left sidebar');
 assert.equal(config.propertiesInDocument,'hidden');assert.equal(p.settings.propertiesBefore,'visible');assert.equal(p.settings.layoutVersion,9);
 assert.equal(await p.tidySidebar(),false,'arranged only once');
 await p.restoreProperties();assert.equal(config.propertiesInDocument,'visible');
 // A vault arranged by an earlier version keeps its properties choice.
 const earlier=plugin(),conf={propertiesInDocument:'visible'};earlier.saveSettings=async()=>{};earlier.settings.layoutVersion=4;
 earlier.app.workspace={rightSplit:right,leftSplit:left,rootSplit:root,getLeftLeaf:()=>({setViewState:async()=>{}}),getLeavesOfType:()=>[],revealLeaf:()=>{}};
 earlier.app.vault={getConfig:key=>conf[key],setConfig:(key,value)=>{conf[key]=value;}};
 assert.equal(await earlier.tidySidebar(),true);assert.equal(conf.propertiesInDocument,'visible');
 const reader=plugin();reader.settings.workspaceId='';assert.equal(await reader.tidySidebar(),false);
});
test('tabs Obsidian has not loaded yet are named for their work too, even before any note is loaded',()=>{
 const p=plugin(),work=Object.assign(new mock.TFile(),{path:'Works/one.md',extension:'md',basename:'one'}),texts=new Map();
 const header=name=>({setText:text=>texts.set(name,text)});
 const note={view:{},getViewState:()=>({type:'markdown',state:{file:'Works/one.md'}}),tabHeaderInnerTitleEl:header('note')};
 const article={view:{},tabHeaderInnerTitleEl:header('article')},details={view:{},tabHeaderInnerTitleEl:header('details')};
 p.app.workspace={getLeavesOfType:type=>({markdown:[note],'rssd-article':[article],'rssd-details':[details]})[type]||[],getActiveFile:()=>null,getMostRecentLeaf:()=>({view:{}})};
 p.app.vault={getAbstractFileByPath:path=>path===work.path?work:null};
 p.app.metadataCache={getFileCache:file=>file===work?{frontmatter:{title:'生存分析如何读懂未完的随访',date:'2026-10-19'}}:null};
 p.refreshTitles();
 assert.deepEqual(Object.fromEntries(texts),{note:'10-19 生存分析如何读懂未完的随访',article:'Article · 生存分析如何读懂未完的随访',details:'Details · 生存分析如何读懂未完的随访'});
});
test('a list click keeps four tabs in one section and replaces the work inside them',async()=>{
 const p=plugin(),root={},group={type:'tabs',children:[]},shown=[],revealed=[],leaves=[];
 const make=(type)=>{const leaf={type,parent:group,view:{getViewType:()=>leaf.type,show:async file=>shown.push(leaf.type+':'+file.basename)},getRoot:()=>root,detach(){leaf.detached=true;},setViewState:async state=>{leaf.type=state.type;},openFile:async file=>{leaf.type='markdown';leaf.view.file=file;}};group.children.push(leaf);leaves.push(leaf);return leaf;};
 const cards=make('rssd-cards');let front=cards;p.refreshTitles=()=>{};
 p.app.workspace={rootSplit:root,getMostRecentLeaf:()=>front,getActiveFile:()=>null,revealLeaf:leaf=>revealed.push(leaf),
  getLeavesOfType:type=>leaves.filter(leaf=>leaf.type===type&&!leaf.detached),
  createLeafInParent:(parent)=>{assert.equal(parent,group,'a new view joins the open section');return make(null);},
  getLeaf:()=>assert.fail('a new view is a tab, not another section')};
 const file=name=>Object.assign(new mock.TFile(),{path:'Works/'+name+'.md',extension:'md',basename:name});
 await p.openWorkFile(file('next'));
 const note=()=>leaves.find(leaf=>leaf.type==='markdown'&&!leaf.detached);
 assert.deepEqual(leaves.filter(leaf=>!leaf.detached).map(leaf=>leaf.type),['rssd-cards','markdown','rssd-article','rssd-outline','rssd-details']);
 assert.equal(note().view.file.basename,'next','the editable note opens beside the four views');
 assert.equal(new Set(leaves.filter(leaf=>!leaf.detached).map(leaf=>leaf.parent)).size,1);
 assert.deepEqual(shown,['rssd-article:next','rssd-cards:next','rssd-outline:next','rssd-details:next']);
 assert.equal(revealed.at(-1),note(),'the note comes forward the first time');
 shown.length=0;await p.openWorkFile(file('later'));
 assert.equal(leaves.filter(leaf=>!leaf.detached).length,5,'a later choice does not add a tab');
 assert.equal(note().view.file.basename,'later');
 assert.deepEqual(shown,['rssd-article:later','rssd-cards:later','rssd-outline:later','rssd-details:later']);
 assert.equal(revealed.at(-1),cards,'a view already in front stays in front once the note is open');
});
test('a list click opens four tabs in the editor tab bar and does not split out a new region',async()=>{
 const p=plugin(),root={type:'split',children:[]},group={type:'tabs',children:[]};root.children.push(group);
 const leaves=[],parents=[];
 const empty={type:'empty',parent:group,view:{getViewType:()=>'empty'},getRoot:()=>root,openFile:async file=>{empty.type='markdown';empty.view.file=file;empty.view.getViewType=()=>'markdown';}};
 group.children.push(empty);leaves.push(empty);
 const revealed=[];
 const make=()=>{const leaf={type:null,parent:group,view:{getViewType:()=>leaf.type,show:async()=>{}},getRoot:()=>root,detach(){leaf.detached=true;},setViewState:async state=>{leaf.type=state.type;},openFile:async file=>{leaf.type='markdown';leaf.view.file=file;}};group.children.push(leaf);leaves.push(leaf);return leaf;};
 p.refreshTitles=()=>{};
 p.app.workspace={rootSplit:root,getMostRecentLeaf:asked=>asked===root||asked===undefined?empty:null,getActiveFile:()=>null,revealLeaf:leaf=>revealed.push(leaf),
  getLeavesOfType:type=>leaves.filter(leaf=>leaf.type===type&&!leaf.detached),
  createLeafInParent:parent=>{parents.push(parent);assert.equal(parent,group,'the four views join the open tab bar');return make();},
  getLeaf:()=>assert.fail('asking for a leaf while the Works list is active opens another region'),
  createLeafBySplit:()=>assert.fail('a new region is not a tab')};
 await p.openWorkFile(Object.assign(new mock.TFile(),{path:'Works/next.md',extension:'md',basename:'next'}));
 assert.deepEqual(parents,[group,group,group,group]);
 assert.equal(empty.type,'markdown');assert.equal(empty.view.file.basename,'next','the empty tab becomes the editable note');
 assert.equal(revealed.at(-1),empty);
 assert.deepEqual(leaves.filter(leaf=>!leaf.detached&&String(leaf.type).startsWith('rssd-')).map(leaf=>leaf.type),['rssd-article','rssd-cards','rssd-outline','rssd-details']);
});
test('views that an earlier click left in their own regions are gathered back into one tab bar',async()=>{
 const p=plugin(),root={type:'split',children:[]},group={type:'tabs',children:[]};root.children.push(group);
 const leaves=[],made=[];
 const empty={type:'empty',parent:group,view:{getViewType:()=>'empty'},getRoot:()=>root,openFile:async file=>{empty.type='markdown';empty.view.file=file;}};
 group.children.push(empty);leaves.push(empty);
 const region=type=>{const leaf={type,parent:root,view:{getViewType:()=>type,show:async()=>{}},getRoot:()=>root,detach(){leaf.detached=true;},setViewState:async()=>{}};root.children.push(leaf);leaves.push(leaf);return leaf;};
 for(const type of ['rssd-article','rssd-cards','rssd-outline','rssd-details'])region(type);
 const make=()=>{const leaf={type:null,parent:group,view:{getViewType:()=>leaf.type,show:async()=>{}},getRoot:()=>root,detach(){leaf.detached=true;},setViewState:async state=>{leaf.type=state.type;}};group.children.push(leaf);leaves.push(leaf);made.push(leaf);return leaf;};
 p.refreshTitles=()=>{};
 p.app.workspace={rootSplit:root,getMostRecentLeaf:()=>empty,getActiveFile:()=>null,revealLeaf(){},
  getLeavesOfType:type=>leaves.filter(leaf=>leaf.type===type&&!leaf.detached),
  createLeafInParent:parent=>{assert.equal(parent,group);return make();},
  getLeaf:()=>assert.fail('gathering must not open another region')};
 await p.openWorkFile(Object.assign(new mock.TFile(),{path:'Works/next.md',extension:'md',basename:'next'}));
 assert.equal(made.length,4);
 assert.equal(leaves.filter(leaf=>leaf.parent===root&&!leaf.detached).length,0,'the old regions lose their views');
 assert.equal(new Set(leaves.filter(leaf=>String(leaf.type).startsWith('rssd-')&&!leaf.detached).map(leaf=>leaf.parent)).size,1);
});
test('the panel finds the open work even while a sidebar tab has the focus',()=>{
 const p=plugin(),work={extension:'md',path:'Works/one.md'},note={extension:'md',path:'Notes/x.md'};
 p.app.workspace={getActiveFile:()=>null,getMostRecentLeaf:()=>({view:{file:work}}),getLeavesOfType:()=>[]};
 assert.equal(p.currentWork(),work);
 p.app.workspace={getActiveFile:()=>note,getMostRecentLeaf:()=>null,getLeavesOfType:()=>[{view:{file:note}},{view:{file:work}}]};
 assert.equal(p.currentWork(),work);
 p.app.workspace={getActiveFile:()=>null,getMostRecentLeaf:()=>null,getLeavesOfType:()=>[]};
 assert.equal(p.currentWork(),null);
});
test('a vault arranged by an earlier version only gets the Works list added on the left',async()=>{
 const p=plugin(),right={},left={},created=[];p.saveSettings=async()=>{};p.settings.layoutVersion=5;
 const old={type:'rssd-works',detached:false,getRoot:()=>right,detach(){this.detached=true;}};
 p.app.workspace={rightSplit:right,leftSplit:left,getLeavesOfType:type=>type==='rssd-works'&&!old.detached?[old]:[],
  getRightLeaf:()=>{created.push('right');return {setViewState:async()=>{}};},getLeftLeaf:()=>{created.push('left');return {setViewState:async()=>{}};},revealLeaf:()=>{}};
 p.app.vault={getConfig:()=>'hidden',setConfig:()=>{}};
 assert.equal(await p.tidySidebar(),true);assert.deepEqual(created,['left'],'no right-sidebar tabs are created');
 assert.equal(old.detached,true,'a Works view left elsewhere by an earlier version is moved');assert.equal(p.settings.layoutVersion,9);
});
test('RSSD tabs that earlier versions put in the right sidebar or a pane of their own are closed once; ones beside a note stay',async()=>{
 for(const version of [6,7,8]){
  const p=plugin(),right={},left={},root={},noteTabs={},ownPane={};p.saveSettings=async()=>{};p.settings.layoutVersion=version;
  const leaf=(type,where,parent)=>({type,where,parent,detached:false,getRoot(){return this.where;},detach(){this.detached=true;}});
  const leaves=[leaf('markdown',root,noteTabs),leaf('rssd-article',root,noteTabs),leaf('rssd-cards',root,ownPane),leaf('rssd-article',root,ownPane),
   leaf('rssd-outline',right),leaf('rssd-details',right),leaf('backlink',right),leaf('rssd-works',left)];
  p.app.workspace={rightSplit:right,leftSplit:left,rootSplit:root,getLeavesOfType:type=>leaves.filter(l=>l.type===type&&!l.detached),
   getRightLeaf:()=>assert.fail('nothing is added to the right sidebar'),getLeftLeaf:()=>({setViewState:async()=>{}}),revealLeaf:()=>{}};
  p.app.vault={getConfig:()=>'hidden',setConfig:()=>{}};
  assert.equal(await p.tidySidebar(),true);
  assert.deepEqual(leaves.map(l=>l.detached),[false,false,true,true,true,true,false,false],'from version '+version);
  assert.equal(p.settings.layoutVersion,9);assert.equal(await p.tidySidebar(),false,'only once');
 }
});
test('the four center tabs open in the note\'s section, and an open one is shown where it is',async()=>{
 const p=plugin(),root={},group={type:'tabs',children:[]},work={extension:'md',path:'Works/one.md'},leaves=[],made=[],revealed=[];
 const leaf=(type)=>{const l={type,parent:group,getRoot:()=>root,setViewState:async state=>{l.type=state.type;l.state=state;}};group.children.push(l);leaves.push(l);return l;};
 const note=leaf('markdown');note.view={file:work,getViewType:()=>'markdown'};
 p.app.workspace={rootSplit:root,getActiveFile:()=>work,getMostRecentLeaf:()=>null,getLeavesOfType:type=>leaves.filter(l=>l.type===type),
  createLeafBySplit:()=>assert.fail('a tab never splits the editor area'),getRightLeaf:()=>assert.fail('nothing opens in the right sidebar'),
  createLeafInParent:(parent)=>{assert.equal(parent,group);made.push('tab');return leaf(null);},
  getLeaf:()=>assert.fail('a new view joins the open section'),revealLeaf:l=>revealed.push(l)};
 await p.openView('rssd-article');await p.openView('rssd-cards');await p.openDetails();await p.openOutline();await p.openView('rssd-article');
 assert.equal(made.length,4);
 assert.equal(new Set(leaves.map(l=>l.parent)).size,1);
 assert.equal(revealed.at(-1).type,'rssd-article','an open tab is shown where it is, not opened again');
});
test('no view replaces Obsidian\'s own lifecycle methods',async()=>{
 const {readFileSync}=await import('node:fs');const source=readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
 for(const [,name,body] of source.matchAll(/^class (\w+) extends ItemView\{([\s\S]*?)^\}/gm))
  for(const reserved of ['open','close','load','unload','setState','getState'])
   assert.doesNotMatch(body,new RegExp('^ (async )?'+reserved+'\\(','m'),name+' replaces '+reserved+'()');
});

test('saving the edited works keeps going past a refused work and stops when the space or connection fails',async()=>{
 const notices=[],Original=mock.Notice;mock.Notice=class{constructor(message){notices.push(message);}};
 try{
  const p=plugin(),blocked=new Set(),unblocked=[],seen=[],progress=[];
  p.autoSync={blocked,unblock:path=>unblocked.push(path)};
  const file=name=>({path:'Works/'+name+'.md',basename:name});
  const answers={one:{state:'saved'},two:{state:'unchanged'},three:Object.assign(Error('newer'),{status:409,conflict:true,code:'revision_conflict'}),
   four:{state:'saved'},five:Object.assign(Error('offline'),{code:'network_error'}),six:{state:'saved'}};
  p.saveWork=async(space,path)=>{assert.equal(space,'metho');const name=path.slice(6,-3);seen.push(name);const answer=answers[name];if(answer instanceof Error)throw answer;return answer;};
  const outcome=await p.saveEdited(['one','two','three','four','five','six'].map(file),{onProgress:(done,total)=>progress.push(done+'/'+total)});
  assert.deepEqual(seen,['one','two','three','four','five'],'a lost connection stops the batch');
  assert.deepEqual(outcome.saved.map(f=>f.basename),['one','four']);assert.deepEqual(outcome.unchanged.map(f=>f.basename),['two']);
  assert.deepEqual(outcome.failed.map(f=>f.file.basename),['three','five']);
  assert.deepEqual([...blocked],['Works/three.md'],'a conflict is marked the way automatic sync marks it');
  assert.deepEqual(unblocked,['Works/one.md','Works/two.md','Works/four.md']);
  assert.deepEqual(progress,['1/6','2/6','3/6','4/6','5/6']);
  assert.equal(p.operations.active,null);
  assert.match(notices.at(-1),/^Saved 2 works as private drafts\. They are not published\. 1 work had nothing to save\. 2 works could not be saved\. three: The Center has a newer version/);
  // Another operation in progress refuses the whole batch before anything is sent.
  seen.length=0;p.operations.active='pull';
  assert.equal(await p.saveEdited([file('one')]),null);assert.deepEqual(seen,[]);assert.match(notices.at(-1),/busy: pull/);
 }finally{mock.Notice=Original;}
});

test('the visible wording says Update for bringing works down, never Pull',async()=>{
 const {readFileSync,readdirSync}=await import('node:fs');
 for(const name of readdirSync(new URL('../src/',import.meta.url)).filter(name=>/\.m?js$/.test(name))){
  const source=readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
  // Quoted text only; class names such as rssd-works-pulled and the internal `pull` action are not shown.
  const shown=[...source.matchAll(/'([^'\n]*)'/g)].map(match=>match[1]).filter(text=>/(?<![-\w])(Pull|pulling|pulled|pull again|the pull)\b/.test(text));
  assert.deepEqual(shown,[],name+' still shows the old wording');
 }
});

// A device token created in the Center and added to Obsidian's Keychain logs the vault in without a browser.
function keychainPlugin(secrets){
 const p=plugin();p.app.secretStorage={getSecret:name=>secrets[name]??null,setSecret:(name,value)=>{secrets[name]=value;}};
 p.setStatus=()=>{};p.idleStatus=()=>'';return p;
}
const identity=workspaceIds=>async req=>req.url.endsWith('/api/rssd/v1/identity')?{status:200,json:{protocolVersion:1,workspaceIds}}:{status:404,json:{}};
test('a Keychain device token is checked with the Center, then used by name',async()=>{
 const token='rssd_device_'+'b'.repeat(48),seen=[];
 response=async req=>{seen.push(req);return identity(['metho','pets'])(req);};
 const p=keychainPlugin({'rssd-pets':token});
 const result=await p.useKeychainToken('rssd-pets');
 assert.deepEqual(result,{loggedIn:true,spaces:['metho','pets']});
 assert.equal(p.settings.tokenSecret,'rssd-pets');assert.deepEqual(p.settings.spaces,['metho','pets']);
 assert.equal(p.token(),token);assert.equal(seen[0].headers.Authorization,'Bearer '+token);
});
test('a Keychain token for other spaces, an unknown name or a revoked token changes nothing',async()=>{
 const token='rssd_device_'+'c'.repeat(48);
 response=identity(['pets']);
 let p=keychainPlugin({'other':token});
 await assert.rejects(p.useKeychainToken('other'),/not approved for metho/);assert.equal(p.settings.tokenSecret,undefined);
 await assert.rejects(p.useKeychainToken('missing'),/no secret named missing/);
 response=async()=>({status:401,json:{code:'unauthorized',message:'Device credential revoked or unknown'}});
 p=keychainPlugin({'old':token});await assert.rejects(p.useKeychainToken('old'),/revoked/);
 assert.equal(p.settings.tokenSecret,undefined);assert.equal(p.operations.active,null);
});
test('a vault with no space takes the only space a Keychain token has',async()=>{
 response=identity(['pets']);
 const p=keychainPlugin({'pets-token':'rssd_device_'+'d'.repeat(48)});p.settings.workspaceId='';
 await p.useKeychainToken('pets-token');assert.equal(p.settings.workspaceId,'pets');
});
