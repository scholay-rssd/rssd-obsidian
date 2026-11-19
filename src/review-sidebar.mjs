import {ItemView,Notice} from 'obsidian';
import {internalNotes,rowNotes,anchorMatches} from './private-notes.mjs';
import {ANNOTATION_TAB,annotationStyle,drawAnnotation} from './annotation-tab.mjs';

export const REVIEW_VIEW='rssd-review-sidebar';
const tabs=['审阅','来源','写作记录',ANNOTATION_TAB];
const via={web:'网页',record:'资料记录',rss:'RSS'};
function safeUrl(value){
 try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}
}
export function localReferences(text){
 const links=new Map();let depth=0;
 for(const line of text.split(/\r?\n/)){
  const heading=/^(#{1,6})\s+(.+)$/.exec(line);
  if(heading){if(depth&&heading[1].length<=depth)depth=0;if(/^(参考文献|参考资料|references|bibliography)\s*$/i.test(heading[2]))depth=heading[1].length;continue;}
  if(!depth)continue;
  for(const m of line.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>)]+)/gi)){
   const url=safeUrl((m[2]||m[3]).replace(/[.,。；，]+$/,''));
   if(url&&!links.has(url))links.set(url,{title:m[1]||line.slice(0,m.index).replace(/^[\d.\s\[\]-]+/,'').trim()||url,url});
  }
 }
 return [...links.values()];
}
export function reviewSources(notebook,edition,local){
 const items=new Map(),blocks=notebook?.blocks||[];
 for(const source of [...(notebook?.sources||[]),...(edition?.sources||[]),...local]){
  const url=safeUrl(source.url);if(!url)continue;
  const entry=items.get(url)||{title:source.title||url,url,anchors:[]};
  if(source.acquiredVia)entry.via=via[source.acquiredVia]||source.acquiredVia;
  if(source.recordId&&source.publisher)entry.provider=source.publisher;
  if(source.id)for(const b of blocks)if(b.sourceIds?.includes(source.id)&&!entry.anchors.some(a=>a.id===b.id))entry.anchors.push(b);
  items.set(url,entry);
 }
 return [...items.values()];
}

async function hash(text){
 const value=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
 return [...new Uint8Array(value)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
async function readEdition(plugin,front,file){
 const workspaceId=plugin.spaceOf?.(file)||plugin.settings.workspaceId,{documents}=plugin.settings,id=String(front['rssd-id']),locale=front['rssd-locale']||'zh-CN',version=Number(front['rssd-version']);
 if(!Number.isSafeInteger(version)||version<1)return null;
 const client=plugin.client();let workId=documents?.[workspaceId]?.[locale]?.[id];
 // Migrated document IDs can differ from Center work IDs.
 if(!workId||'center-'+(await hash(JSON.stringify([workId,locale]))).slice(0,48)!==id){
  const detail=await client.work(workspaceId,id,locale);
  if(detail.articleId!==id||detail.locale!==locale||!detail.workId)throw Error('来源身份不匹配');
  workId=detail.workId;
 }
 const row=await client.edition(workId,locale,version);
 if(row.locale!==locale||row.revision!==version)throw Error('版本不匹配');
 return row.payload;
}
const style=`
.rssd-review-pane{padding:12px 14px;overflow:auto;color:var(--text-normal);font-size:var(--font-ui-small)}
.rssd-review-tabs{display:flex;gap:3px;border-bottom:1px solid var(--background-modifier-border);margin-bottom:16px}
.rssd-review-tabs button{flex:1;padding:6px 2px;border:0;box-shadow:none;background:none;border-radius:0;color:var(--text-muted)}
.rssd-review-tabs button[aria-pressed=true]{color:var(--text-accent);box-shadow:inset 0 -2px var(--interactive-accent)}
.rssd-review-pane h3{font-size:1.06em;margin:0 0 5px;line-height:1.5}
.rssd-review-pane h4{font-size:.94em;margin:19px 0 6px}
.rssd-review-muted,.rssd-review-meta{color:var(--text-muted);font-size:var(--font-ui-smaller);line-height:1.5}
.rssd-review-item{border-top:1px solid var(--background-modifier-border);padding:9px 0;overflow-wrap:anywhere;white-space:pre-wrap}
.rssd-review-pane textarea{width:100%;min-height:4.4em;margin:6px 0;resize:vertical}
.rssd-review-pane input[type=text]{width:100%;margin:4px 0}
.rssd-review-pane button{cursor:pointer}
.rssd-review-jump{display:block;margin:4px 0;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;
export class ReviewSidebar extends ItemView{
 constructor(leaf,plugin){super(leaf);this.plugin=plugin;this.tab=tabs[0];this.seq=0;this.cache=new Map();this.drafts=new Map();}
 getViewType(){return REVIEW_VIEW;}
 getDisplayText(){return '文章审阅栏';}
 getIcon(){return 'list-checks';}
 async onOpen(){
  this.contentEl.addClass('rssd-review-pane');this.contentEl.createEl('style',{text:style+annotationStyle});
  const bar=this.contentEl.createDiv({cls:'rssd-review-tabs'});
  this.buttons=tabs.map(name=>{const b=bar.createEl('button',{text:name});b.onclick=()=>{this.tab=name;this.draw();};return b;});
  this.body=this.contentEl.createDiv();
  for(const event of ['active-leaf-change','file-open','layout-change'])this.registerEvent(this.app.workspace.on(event,()=>this.schedule()));
  this.registerEvent(this.app.metadataCache.on('changed',file=>{if(file===this.file)this.schedule();}));
  this.schedule();
 }
 async onClose(){clearTimeout(this.timer);this.seq++;this.body=null;this.cache.clear();this.drafts.clear();}
 schedule(){clearTimeout(this.timer);this.timer=setTimeout(()=>this.refresh().catch(()=>{if(this.body)new Notice('审阅信息读取失败');}),60);}
 async refresh(){
  if(!this.body)return;
  const ws=this.app.workspace,active=ws.activeLeaf?.view;
  const file=active?.getViewType?.()==='markdown'&&(!active.file||!this.plugin.isWork(active.file))?null:this.plugin.currentWork();
  const front=file&&this.app.metadataCache.getFileCache(file)?.frontmatter;
  const cardView=ws.getMostRecentLeaf?.(ws.rootSplit)?.view;
  const manifest=cardView?.getViewType?.()==='rssd-cards'&&cardView.file===file?cardView.result?.manifest:null;
  const key=JSON.stringify([this.plugin.settings.origin,(this.plugin.spaceOf?.(file)||this.plugin.settings.workspaceId),file?.path,file?.stat?.mtime,front?.['rssd-id'],front?.['rssd-version'],manifest?.style,manifest?.source?.hash]);
  if(key===this.key)return;
  this.key=key;this.file=file;this.front=front;this.card=manifest;this.data=null;this.storage=null;this.local=[];this.error=false;this.busy=!!front;
  const seq=++this.seq;this.draw();
  if(!front?.['rssd-id'])return;
  const text=await this.app.vault.cachedRead(file),digest=await hash(text);
  if(seq!==this.seq)return;
  const base=JSON.stringify([this.plugin.settings.origin,(this.plugin.spaceOf?.(file)||this.plugin.settings.workspaceId),front['rssd-id'],front['rssd-locale']||'zh-CN',front['rssd-version']||0]);
  this.storage='rssd-review-v1:'+JSON.stringify([this.plugin.settings.origin,(this.plugin.spaceOf?.(file)||this.plugin.settings.workspaceId),front['rssd-id'],front['rssd-locale']||'zh-CN']);this.digest=digest;this.local=localReferences(text);this.draw();
  let request=this.cache.get(base);
  if(!request){
   request=Promise.allSettled([readEdition(this.plugin,front,file),this.plugin.privateRecord(file)]);
   this.cache.set(base,request);if(this.cache.size>12)this.cache.delete(this.cache.keys().next().value);
  }
  const [edition,record]=await request;
  if([edition,record].some(r=>r.status==='rejected'))this.cache.delete(base);
  if(seq!==this.seq)return;
  this.error=[edition,record].some(r=>r.status==='rejected');this.busy=false;this.data=edition.value;this.record=record.value;this.draw();
 }
 draw(){
  if(!this.body)return;
  this.buttons.forEach((b,i)=>b.setAttribute('aria-pressed',String(this.tab===tabs[i])));
  const el=this.body;el.empty();
  if(!this.front?.['rssd-id']){el.createDiv({text:'打开一篇 RSSD 文章即可查看。'});return;}
  const front=this.front,n=this.data?.metadata?.notebook;
  el.createEl('h3',{text:front.title||this.file.basename});
  el.createDiv({cls:'rssd-review-meta',text:[front['rssd-locale']||'zh-CN','稿件 v'+(front['rssd-version']||'—'),front['rssd-published-version']?'已发布 v'+front['rssd-published-version']:'无发布版本记录'].join(' · ')});
  const record=!this.busy&&this.record;
  // The annotation tab asks the Center itself and does not wait for the edition's private record.
  if(this.tab===ANNOTATION_TAB){drawAnnotation(this,el);return;}
  if(this.tab==='审阅'){
   if(this.card)el.createDiv({cls:'rssd-review-meta',text:'当前卡片 · '+this.card.style+' · '+(this.card.source?.version?'来源 v'+this.card.source.version:'来源版本未记录')});
   if(this.storage)this.reviews(el);
   const notes=record?.privateEditorial||n;
   const entries=[...internalNotes(notes).filter(x=>x.key==='verification'),...rowNotes(notes).flatMap(r=>r.notes.filter(x=>x.key==='verification').map(x=>({...x,anchor:r.anchor})))];
   el.createEl('h4',{text:'稿件中的核对与待办'});
   if(record?.revision&&record.revision!==front['rssd-version'])el.createDiv({cls:'rssd-review-meta',text:'备注来自 v'+record.revision});
   for(const e of entries){const box=el.createDiv({cls:'rssd-review-item',text:e.text});if(e.anchor)this.jumpButton(box,e.anchor);}
   if(!entries.length&&!this.busy&&!this.error)this.hint('此版本没有记录待核事项。');
  }else if(this.tab==='来源'){
   const items=reviewSources(n,this.data,this.local);
   for(const s of items){
    const box=el.createDiv({cls:'rssd-review-item'}),link=box.createEl('a',{text:s.title,href:s.url});link.target='_blank';link.rel='noopener noreferrer';
    box.createDiv({cls:'rssd-review-meta',text:[new URL(s.url).hostname,s.via,s.provider].filter(Boolean).join(' · ')});
    if(this.storage){
     const key=this.storage+':sources:'+String(front['rssd-version']||0);
     const read=()=>this.app.loadLocalStorage(key)||{};
     const line=box.createEl('label');
     const check=line.createEl('input',{attr:{type:'checkbox'}});
     check.checked=!!read()[s.url];line.appendText(' 本机已核验');
     check.onchange=()=>{const flags=read();if(check.checked)flags[s.url]=new Date().toISOString();else delete flags[s.url];this.app.saveLocalStorage(key,flags);};
    }
    for(const b of s.anchors)this.jumpButton(box,b);
   }
   if(!items.length&&!this.busy)this.hint('没有可显示的来源链接。');
  }else{
   const runs=n?.modelSignatures?.length?n.modelSignatures:record?.privateEditorial?.modelSignatures||[];
   if(record?.revision&&!n&&record.revision!==front['rssd-version'])this.hint('历史记录来自 v'+record.revision);
   for(const r of [...runs].reverse()){
    const box=el.createDiv({cls:'rssd-review-item'});box.createEl('strong',{text:[r.agentName,r.modelName||r.modelId].filter(Boolean).join(' · ')||'写作运行'});
    const at=r.startedAt?r.startedAt.replace('T',' ').slice(0,16)+(r.startedAt.endsWith('Z')?' UTC':''):'';
    box.createDiv({cls:'rssd-review-meta',text:[r.action,r.status,at].filter(Boolean).join(' · ')});
    if(r.writingSkills?.length){box.createEl('h4',{text:'本轮挂载的 Skills'});for(const s of r.writingSkills)box.createDiv({text:s.id+(s.version?' · '+s.version:'')});}
   }
   if(!runs.length&&!this.busy)this.hint('此版本未记录写作运行。');
   for(const [label,items] of [['模板',n?.mounts?.templates],['品牌',n?.mounts?.brands]])if(items?.length){el.createEl('h4',{text:label});for(const i of items)el.createDiv({text:i.name||i.id});}
  }
  if(this.busy)this.hint('正在读取此版本的 Center 记录…');
  if(this.error){this.hint('部分 Center 记录暂时无法读取。');el.createEl('button',{text:'重试'}).onclick=()=>{this.key=null;this.schedule();};}
 }
 hint(text){this.body.createDiv({cls:'rssd-review-muted',text});}
 jumpButton(el,anchor){
  if(!anchor.text)return;
  const file=this.file,button=el.createEl('button',{cls:'rssd-review-jump',text:'定位 · '+anchor.text.slice(0,36)});
  button.onclick=async()=>{
   const lines=(await this.app.vault.cachedRead(file)).split(/\r?\n/);
   const matches=lines.map((v,i)=>v.includes(anchor.text)||anchorMatches(anchor.text,v)?i:-1).filter(i=>i>=0);
   if(matches.length!==1){new Notice('当前正文中无法唯一定位该段。');return;}
   const leaf=await this.plugin.openWorkNote(file);if(leaf){await this.app.workspace.revealLeaf(leaf);leaf.setEphemeralState({line:matches[0]});}
  };
 }
 reviews(el){
  const key=this.storage,digest=this.digest,revision=Number(this.front['rssd-version'])||0,load=()=>this.app.loadLocalStorage(key)||[];
  const commit=items=>{this.app.saveLocalStorage(key,items);this.draw();};
  el.createEl('h4',{text:'我的审阅 · 本机'});
  for(const item of load()){
   const box=el.createDiv({cls:'rssd-review-item'});box.createDiv({text:item.text});
   if(item.anchor)this.jumpButton(box,{text:item.anchor});
   box.createDiv({cls:'rssd-review-meta',text:['v'+item.revision,item.reviewer,item.updatedAt?.slice(0,10),item.digest!==digest?'正文或属性已有修改':'',item.closed?'已核对':'待核对'].filter(Boolean).join(' · ')});
   if(item.revision===revision)box.createEl('button',{text:item.closed?'重新打开':'标为已核对'}).onclick=()=>commit(load().map(x=>x.id===item.id?{...x,closed:!x.closed,digest,updatedAt:new Date().toISOString()}:x));
  }
  const draft=this.drafts.get(key)||{text:'',reviewer:''};
  const text=el.createEl('textarea',{attr:{placeholder:'记下待核事项或审阅意见','aria-label':'审阅意见'}});text.value=draft.text;
  const who=el.createEl('input',{attr:{type:'text',placeholder:'审阅人（选填）','aria-label':'审阅人'}});who.value=draft.reviewer;
  const anchor=el.createEl('input',{attr:{type:'text',placeholder:'关联的原文片段（选填）','aria-label':'关联的原文片段'}});anchor.value=draft.anchor||'';
  const remember=()=>this.drafts.set(key,{text:text.value,reviewer:who.value,anchor:anchor.value});text.oninput=remember;who.oninput=remember;anchor.oninput=remember;
  el.createEl('button',{text:'保存审阅项'}).onclick=()=>{if(!text.value.trim())return;this.drafts.delete(key);commit([...load(),{id:crypto.randomUUID(),text:text.value.trim(),anchor:anchor.value.trim(),reviewer:who.value.trim(),revision,digest,closed:false,updatedAt:new Date().toISOString()}]);};
 }
}
