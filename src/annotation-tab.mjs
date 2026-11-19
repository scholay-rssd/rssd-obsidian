// The 标注 tab of the review sidebar: the Center's questionnaire for the published revision of the open work.
// The Center decides which questions apply and checks the answers; this file draws them and keeps an unsent
// sheet on this device so that switching works or tabs loses nothing. Annotating never changes the work.
import {Notice} from 'obsidian';
import {missingAnswers,answerSheet,sheetFromSaved,draftKey,unavailableReason} from './annotation-model.mjs';

export const ANNOTATION_TAB='标注';
export const annotationStyle=`
.rssd-annotate-item{border-top:1px solid var(--background-modifier-border);padding:10px 0}
.rssd-annotate-item[data-missing=true]{box-shadow:inset 3px 0 var(--text-error);padding-left:8px}
.rssd-annotate-text{line-height:1.5;margin-bottom:6px}
.rssd-annotate-options{display:flex;flex-direction:column;gap:3px}
.rssd-annotate-options label,.rssd-annotate-scale label{display:flex;gap:6px;align-items:baseline;cursor:pointer}
.rssd-annotate-scale{display:flex;gap:10px;align-items:center}
.rssd-annotate-anchors{display:flex;justify-content:space-between;color:var(--text-muted);font-size:var(--font-ui-smaller);margin-top:2px}
.rssd-annotate-actions{position:sticky;bottom:0;background:var(--background-secondary);padding:10px 0;border-top:1px solid var(--background-modifier-border);display:flex;gap:8px;align-items:center}
`;

/** Load what to ask about the open work, once per work and published revision. */
export function loadAnnotation(view){
 const front=view.front,plugin=view.plugin,workspaceId=plugin.settings.workspaceId,articleId=String(front['rssd-id']),locale=front['rssd-locale']||'zh-CN';
 const key=JSON.stringify([plugin.settings.origin,workspaceId,articleId,locale,front['rssd-published-version']||0]);
 if(view.annotation?.key===key)return;
 const state=view.annotation={key,workspaceId,articleId,locale,loading:true};
 plugin.client().annotationTarget(workspaceId,articleId,locale).then(data=>{
  if(view.annotation!==state)return;
  state.loading=false;state.data=data;
  state.storage=draftKey({origin:plugin.settings.origin,workspaceId,articleId,locale,revision:data.target.revision,formVersion:data.formVersion});
  // An unsent sheet on this device wins over what was sent before; either may be absent.
  state.answers=view.app.loadLocalStorage(state.storage)||sheetFromSaved(data.sections,data.mine?.answers);
  view.draw();
 }).catch(error=>{
  if(view.annotation!==state)return;
  state.loading=false;state.unavailable=unavailableReason(error);state.error=state.unavailable?null:String(error?.message||error);view.draw();
 });
}

export function drawAnnotation(view,el){
 loadAnnotation(view);
 const state=view.annotation,front=view.front;
 if(state.loading){view.hint('正在向 Center 读取标注题目…');return;}
 if(state.unavailable){view.hint(state.unavailable);return;}
 if(state.error){view.hint('标注题目暂时无法读取：'+state.error);el.createEl('button',{text:'重试'}).onclick=()=>{view.annotation=null;view.draw();};return;}
 const {target,sections,formVersion,mine}=state.data,answers=state.answers;
 el.createDiv({cls:'rssd-review-meta',text:'标注对象：已发布 v'+target.revision+' · 量表第 '+formVersion+' 版'});
 if(Number(front['rssd-version'])!==target.revision)view.hint('你打开的是稿件 v'+(front['rssd-version']||'—')+'，标注针对的是读者看到的已发布 v'+target.revision+'。');
 if(mine)view.hint('你在 '+String(mine.createdAt).slice(0,10)+' 标注过这个版本。修改后重新提交会新增一条记录，以最新的为准。');
 const remember=()=>{view.app.saveLocalStorage(state.storage,answers);};
 const set=(item,patch)=>{answers[item.id]={...(answers[item.id]||{}),...patch};remember();};
 const rows=new Map();
 for(const section of sections){
  el.createEl('h4',{text:section.title});
  for(const item of section.items){
   const row=el.createDiv({cls:'rssd-annotate-item'});rows.set(item.id,row);
   row.createDiv({cls:'rssd-annotate-text',text:item.text+(item.optional?'（可不答）':'')});
   const name='rssd-annotate-'+item.id,current=answers[item.id]?.value;
   const radio=(parent,value,label)=>{
    const line=parent.createEl('label'),input=line.createEl('input',{attr:{type:'radio',name}});
    input.checked=current===value;input.onchange=()=>{if(input.checked){set(item,{value});row.removeAttribute('data-missing');}};
    line.appendText(label);
   };
   if(item.type==='scale'){
    const scale=row.createDiv({cls:'rssd-annotate-scale'});for(let value=1;value<=5;value++)radio(scale,value,String(value));
    const anchors=row.createDiv({cls:'rssd-annotate-anchors'});for(const point of ['1','3','5'])anchors.createSpan({text:point+' '+item.anchors[point]});
   }else if(item.type==='check'){
    const options=row.createDiv({cls:'rssd-annotate-scale'});radio(options,true,'是');radio(options,false,'否');
   }else{
    const options=row.createDiv({cls:'rssd-annotate-options'});for(const option of item.options)radio(options,option.id,option.label);
   }
   if(item.note){
    const note=row.createEl('input',{attr:{type:'text',placeholder:'补充说明（选填）','aria-label':'补充说明',maxlength:'500'}});
    note.value=answers[item.id]?.note||'';note.oninput=()=>set(item,{note:note.value});
   }
  }
 }
 const actions=el.createDiv({cls:'rssd-annotate-actions'}),button=actions.createEl('button',{cls:'mod-cta',text:mine?'重新提交标注':'提交标注'});
 const status=actions.createSpan({cls:'rssd-review-muted'});
 button.onclick=async()=>{
  const missing=missingAnswers(sections,answers);
  for(const row of rows.values())row.removeAttribute('data-missing');
  if(missing.length){for(const item of missing)rows.get(item.id)?.setAttribute('data-missing','true');rows.get(missing[0].id)?.scrollIntoView({block:'center'});status.setText('还有 '+missing.length+' 题没有回答');return;}
  button.disabled=true;status.setText('正在提交…');
  try{
   const saved=await view.plugin.client().submitAnnotation({workspaceId:state.workspaceId,articleId:state.articleId,locale:state.locale,revision:target.revision,editionHash:target.editionHash,formVersion,answers:answerSheet(sections,answers)});
   view.app.saveLocalStorage(state.storage,null);state.data.mine=saved;state.answers=sheetFromSaved(sections,saved.answers);
   new Notice('标注已提交。文章本身没有任何改动。');view.draw();
  }catch(error){
   button.disabled=false;
   if(error?.code==='form_changed'||error?.code==='source_conflict'||error?.code==='not_published'){new Notice('量表或已发布版本有变化，已重新读取题目。你的回答保留在本机。',8000);view.annotation=null;view.draw();return;}
   status.setText('提交失败：'+String(error?.message||error).slice(0,200));
  }
 };
}
