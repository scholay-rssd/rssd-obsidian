// The card view's ways of making cards, shown as one group of icon toggles. Pure rules, so they can be tested
// without Obsidian: which options the group shows, how each is named, and where the arrow keys move.

/** Icons for the card view's styles: laid out by the plug-in, laid out by an agent, drawn by an image model. */
// Card sets in order of preference (owner, 2026-11-21): 模型生图 first, 智能排版 next, 算法排版 as the fallback
// every long article has. The card view shows them in this order and opens on the first a work has.
export const CARD_STYLE_ORDER=Object.freeze(['ai-image','ai-code','site']);
/** The card style a work opens on: the first in CARD_STYLE_ORDER it has a set for; `has(id)` answers for the two AI sets. */
export const preferredCardStyle=has=>CARD_STYLE_ORDER.find(id=>id==='site'||has(id));
export const CARD_STYLE_ICONS=Object.freeze({site:'layout-template','ai-code':'sparkles','ai-image':'palette'});

/**
 * Every style keeps its place in the group; one without a finished set for this work is shown but unavailable,
 * and its name says so. `available` lists the ids that can be chosen now.
 */
export function styleOptions(styles,available,active){
 const usable=new Set(available);
 return styles.map(style=>{
  const ok=usable.has(style.id);
  return {id:style.id,label:style.label,icon:style.icon||CARD_STYLE_ICONS[style.id]||'square',available:ok,active:ok&&style.id===active,
   name:style.label+(ok?'':' · 暂无成品')};
 });
}

const STEP={ArrowLeft:-1,ArrowUp:-1,ArrowRight:1,ArrowDown:1};
/** The style a key moves to, skipping unavailable ones and wrapping around; null for any other key. */
export function nextStyle(options,active,key){
 const usable=options.filter(option=>option.available);
 if(!usable.length||!(key in STEP||key==='Home'||key==='End'))return null;
 if(key==='Home')return usable[0].id;
 if(key==='End')return usable[usable.length-1].id;
 const at=usable.findIndex(option=>option.id===active);
 return usable[((at<0?0:at)+STEP[key]+usable.length)%usable.length].id;
}
