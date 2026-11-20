// Card sets the Center keeps for each work (center/rssd/RENDITIONS.md in RSSD): 智能排版 (ai-code) and 模型生图
// (ai-image), made by the card producers and saved against one edition revision. The Works list and the card
// tab show them like the optional local samples in Card Samples/. Only a small index is synced; the pages are
// read the first time a set is opened and kept under .rssd/cloud-cards/<rendition id>/, since a rendition never
// changes. Pure, so it is tested without Obsidian.

export const CLOUD_CARD_VARIANTS=Object.freeze(['ai-code','ai-image']);
export const CLOUD_CARD_FOLDER='.rssd/cloud-cards';
const LOCALES=['zh-CN','en'];
const ID=/^[A-Za-z0-9._:-]{1,200}$/;

/** Every card set of a space as an index {"<workId>|<locale>": {"<variant>": {id, revision, representation, pages, width, height}}}, keeping the newest revision of each variant. */
export function cardIndex(items){
 const index={};
 for(const item of Array.isArray(items)?items:[]){
  if(!CLOUD_CARD_VARIANTS.includes(item?.variant)||!ID.test(String(item.id||''))||!ID.test(String(item.workId||'')))continue;
  if(!['raster','layout'].includes(item.representation))continue;
  const revision=Number(item.source?.revision??item.revision);if(!Number.isSafeInteger(revision)||revision<1)continue;
  const pages=Number(item.pageCount);if(!Number.isSafeInteger(pages)||pages<1||pages>500)continue;
  const key=item.workId+'|'+(item.locale||'zh-CN'),entry=index[key]??={},known=entry[item.variant];
  // Two sets of one revision and variant: the Center sends the website the newest; ids are hashes, so keep the
  // larger one only to stay stable between syncs.
  if(known&&(known.revision>revision||(known.revision===revision&&known.id>item.id)))continue;
  entry[item.variant]={id:item.id,revision,representation:item.representation,pages,width:Number(item.width)||1080,height:Number(item.height)||1440};
 }
 return index;
}

/** Read every card set of a space through `list({locale, after, limit})` (the Center's paginated /renditions). */
export async function readCardIndex(list,{locales=LOCALES,maxPages=50}={}){
 const items=[];
 for(const locale of locales){
  let after,pages=0;
  do{
   const result=await list({locale,limit:100,...(after?{after}:{})});
   items.push(...(Array.isArray(result?.items)?result.items:[]).map(item=>({...item,locale:item.locale||locale})));
   after=typeof result?.next==='string'&&result.next?result.next:null;
  }while(after&&++pages<maxPages);
 }
 return cardIndex(items);
}

/** The set of `variant` made for exactly this edition of the work, or null. A set of another revision is not shown: the cards would not match the article. */
export function cloudCardOf(index,{workId,locale='zh-CN',version,variant}){
 if(!index||!workId||!CLOUD_CARD_VARIANTS.includes(variant))return null;
 const found=index[workId+'|'+locale]?.[variant];
 return found&&Number(version)===found.revision?found:null;
}

/** Where page `n` (1-based) of a set is kept, inside the space. */
export const cloudCardPagePath=(id,n)=>CLOUD_CARD_FOLDER+'/'+id+'/'+String(n).padStart(2,'0')+'.png';

const MEDIA_REF=/(?:https?:\/\/[^/\s)"']+)?\/api\/rssd\/v1\/media\/([A-Za-z0-9._:-]+)\/raw/g;
/** The media IDs a layout set refers to. */
export const layoutMediaIds=recipe=>[...new Set([...(recipe?.mediaIds||[]),...[recipe?.css||'',...(recipe?.pages||[]).map(page=>page?.html||'')].flatMap(text=>[...String(text).matchAll(MEDIA_REF)].map(match=>match[1]))])];

/**
 * One page of a layout set as a document to draw. Layout strings are stored export data, not trusted code: the
 * document runs in a sandboxed frame without scripts, and its policy lets it load nothing but the given images.
 * `media` maps a media ID to the local address of its bytes; an unknown reference is dropped.
 */
export function layoutDocument({css='',html='',media={}}){
 const swap=text=>String(text).replace(MEDIA_REF,(_,id)=>Object.hasOwn(media,id)?media[id]:'');
 const policy="default-src 'none'; img-src blob: data:; style-src 'unsafe-inline'; font-src data:";
 return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="'+policy+'">'+
  '<style>'+swap(css).replace(/<\/style/gi,'<\\/style')+'</style></head><body>'+swap(html).replace(/<script\b[\s\S]*?<\/script>/gi,'')+'</body></html>';
}
