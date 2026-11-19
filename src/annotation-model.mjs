// The answer sheet of the annotation tab, apart from its drawing: what is still unanswered, what is sent, and
// how a saved sheet is read back. Pure, so the same rules run in tests. The Center checks every sheet again.

/** Every item of the sections shown for one work, in order. */
export const sheetItems=sections=>(sections||[]).flatMap(section=>section.items||[]);

const answered=(item,answer)=>{
 const value=answer?.value;
 if(item.type==='scale')return Number.isSafeInteger(value)&&value>=1&&value<=5;
 if(item.type==='check')return typeof value==='boolean';
 return typeof value==='string'&&(item.options||[]).some(option=>option.id===value);
};
/** The items that must be answered and are not yet, in order. */
export function missingAnswers(sections,answers){
 return sheetItems(sections).filter(item=>!item.optional&&!answered(item,answers?.[item.id]));
}
/** What is sent: each answered item's value, and its note where the item takes one and one was written. */
export function answerSheet(sections,answers){
 const out={};
 for(const item of sheetItems(sections)){
  const answer=answers?.[item.id];if(!answered(item,answer))continue;
  const note=item.note&&typeof answer.note==='string'?answer.note.trim().slice(0,500):'';
  out[item.id]=note?{value:answer.value,note}:{value:answer.value};
 }
 return out;
}
/** A sheet the Center returned, as the tab edits it; items the form no longer shows are dropped. */
export function sheetFromSaved(sections,saved){
 const out={};
 for(const item of sheetItems(sections)){const answer=saved?.[item.id];if(answered(item,answer))out[item.id]={value:answer.value,...(item.note&&answer.note?{note:String(answer.note)}:{})};}
 return out;
}
/** Where a draft sheet is kept on this device: one per work, language, revision and form version. */
export const draftKey=({origin,workspaceId,articleId,locale,revision,formVersion})=>'rssd-annotation-v1:'+JSON.stringify([origin,workspaceId,articleId,locale,revision,formVersion]);
/** Why the Center would not show the form, in the reader's words; null for anything unexpected. */
export function unavailableReason(error){
 if(error?.code==='not_published')return '这篇还没有已发布的版本。只有已发布的版本可以标注。';
 if(error?.code==='not_annotatable')return '日程、历史和资源类记录不做标注。';
 if(error?.status===404&&error?.code!=='not_found')return '这个 Center 还不支持标注。';
 if(error?.code==='not_found')return 'Center 上找不到这篇作品。';
 return null;
}
