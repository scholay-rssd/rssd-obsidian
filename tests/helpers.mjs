import YAML from 'yaml';
export const yaml={parse:text=>YAML.parse(text),stringify:value=>YAML.stringify(value)};
export function memoryVault(){
 const files=new Map();
 return {files,read:async p=>files.has(p)?files.get(p):null,write:async(p,c,options={})=>{
   if('expectedContent' in options&&(files.has(p)?files.get(p):null)!==options.expectedContent)
    throw Object.assign(Error('Local edits were kept'),{code:'local_edit_during_pull'});
   files.set(p,c);
  },
  readBinary:async p=>files.has(p)?files.get(p):null,writeBinary:async(p,b)=>{if(!files.has(p))files.set(p,b);}};
}
export function memoryStore(){
 const data={},byLocale={};
 const root=(locale='zh-CN')=>locale==='zh-CN'?data:(byLocale[locale]??={});
 return {data,byLocale,get:async(s,id,locale)=>root(locale)[s]?.[id]??null,
  set:async(s,id,v,locale)=>{(root(locale)[s]??={})[id]=v;},delete:async(s,id,locale)=>{delete root(locale)[s]?.[id];},
  list:async(s,locale)=>Object.values(root(locale)[s]||{})};
}
export const png=new Uint8Array([137,80,78,71,13,10,26,10,1,2,3]);
export const b64=bytes=>Buffer.from(bytes).toString('base64');
export function detail(id,{version=1,published=null,title='Title',markdown='Body\n\n![](/article-media/a.png)\n',record=null}={}){
 return {id,articleId:id,version,revision:version,publishedVersion:published,data:{id,title,summary:'Summary',markdown,date:'2026-11-03',author:'Ed',category:'News',sectionId:'frontiers',
  assets:[{path:'/article-media/a.png',data:b64(png)}],...(record?{record}:{})}};
}
// A Center holding works; `calls` records every request so tests can assert what was (not) sent.
export function stubCenter(works){
 const calls=[],state={drafts:new Map(),failNext:null};
 const client={calls,
  catalog:async(_w,options)=>{calls.push(['catalog',options]);const rows=[...works.values()];return {generation:1,items:rows.map(d=>({articleId:d.articleId,version:d.version,publishedVersion:d.publishedVersion})),next:null};},
  work:async(_w,id)=>{calls.push(['work',id]);return works.get(id);},
  saveDraft:async(_w,envelope)=>{
   calls.push(['saveDraft',envelope]);
   if(state.failNext){const e=state.failNext;state.failNext=null;throw e;}
   const current=works.get(envelope.data.id);
   if(current.version!==envelope.expectedVersion)throw Object.assign(new Error('changed'),{status:409,code:'revision_conflict'});
   const next={...current,version:current.version+1,revision:current.version+1,data:{...current.data,...envelope.data}};
   works.set(next.articleId,next);const receipt={articleId:next.articleId,requestKey:envelope.requestKey,revision:next.version};state.drafts.set(envelope.requestKey,receipt);return receipt;},
  draftReceipt:async(_w,key)=>{calls.push(['draftReceipt',key]);return state.drafts.get(key)||{};},
 };
 return {client,state,calls};
}
