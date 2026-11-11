// Online reading: list a space's works from the Center and prepare one for display without writing
// anything into the vault. Pure, so it runs in tests and on mobile; rendering happens in main.js.

const PAGE=100,MAX_PAGES=50;
// Rendered images point at this placeholder host; main.js swaps each for a local blob URL.
export const MEDIA_HOST='https://rssd-media.invalid/';

/** Every work in a space for one language. Published only, unless drafts are asked for. */
export async function readerCatalog(client,workspaceId,{locale='zh-CN',drafts=false}={}){
 const items=[];let after,generation;
 for(let page=0;page<MAX_PAGES;page++){
  const value=await client.catalog(workspaceId,{scope:drafts?'all':'published',limit:PAGE,locale,...(after!==undefined?{after,generation}:{})});
  if(!Array.isArray(value?.items))throw Object.assign(Error('The Center returned an invalid catalog page'),{code:'invalid_catalog'});
  generation=value.generation;items.push(...value.items);
  if(value.next==null)return sortNewest(items);
  after=value.next;
 }
 throw Object.assign(Error('This space has more works than the reader can list'),{code:'invalid_catalog'});
}
const sortNewest=items=>items.slice().sort((a,b)=>String(b.lastmod||'').localeCompare(String(a.lastmod||'')));

/** Case-insensitive match on title, summary and category. */
export function filterCatalog(items,text){
 const q=String(text||'').trim().toLowerCase();if(!q)return items;
 return items.filter(item=>[item.title,item.summary,item.category].some(v=>String(v||'').toLowerCase().includes(q)));
}

const SIGNATURES=[['iVBORw0KGgo','image/png'],['/9j/','image/jpeg'],['UklGR','image/webp'],['R0lGOD','image/gif']];
const BY_EXTENSION={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',svg:'image/svg+xml'};
export function mediaType(name,base64){
 for(const [prefix,type] of SIGNATURES)if(String(base64||'').startsWith(prefix))return type;
 return BY_EXTENSION[String(name).split('.').at(-1).toLowerCase()]||'application/octet-stream';
}

/**
 * The Markdown to render and the images it needs. Site-relative links point at the live site; images point
 * at MEDIA_HOST placeholders matched by name in `media`.
 */
export function readerArticle(detail,item={}){
 const data=detail?.data;
 if(!data||typeof data.markdown!=='string')throw Object.assign(Error('The Center returned no article body'),{code:'invalid_response'});
 let site='';try{site=new URL(item.url||detail.url||'').origin;}catch{}
 const media={};
 for(const asset of data.assets||[]){
  if(typeof asset?.path!=='string'||typeof asset.data!=='string'||!/^\/article-media\/[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(asset.path))continue;
  const name=asset.path.slice('/article-media/'.length);media[name]={type:mediaType(name,asset.data),data:asset.data};
 }
 let markdown=data.markdown.replace(/([("])\/article-media\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})/g,'$1'+MEDIA_HOST+'$2');
 if(site)markdown=markdown.replace(/(\]\()\/(?!\/)/g,'$1'+site+'/').replace(/(href=")\/(?!\/)/g,'$1'+site+'/');
 // The site shows the title above the body; avoid printing it twice.
 const title=String(data.title||item.title||'');
 const heading=/^#\s+([^\r\n]+)\r?\n+/.exec(markdown);
 if(heading&&heading[1].trim()===title.trim())markdown=markdown.slice(heading[0].length);
 return {title,summary:String(data.summary||''),author:String(data.author||''),date:String(data.date||item.dateLabel||''),
  category:String(data.category||item.category||''),url:item.url||(site&&detail.url?site+detail.url:''),markdown,media,
  published:item.publicationState?item.publicationState==='published':detail.publishedVersion!=null};
}
