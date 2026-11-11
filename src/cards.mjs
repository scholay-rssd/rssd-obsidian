// The card view: a work laid out as fixed-size picture pages (3:4, 1080×1440), ready for any platform
// that takes a set of images. Layout and drawing are the website's own page engine (web/engine/browser-export:
// pagination.mjs fills 720×960 pages and checks that no text or picture was lost, raster.mjs draws each as a
// PNG), so cards made here match the pages downloaded from a public article. This file prepares the work
// for that engine and describes the result as a package (contracts/output-package.mjs).
import {paginate} from '../../web/engine/browser-export/pagination.mjs';
import {rasterPage} from '../../web/engine/browser-export/raster.mjs';
import {outputManifest,outputFields,checkSource} from '../../contracts/output-package.mjs';
import {workFingerprint,localMediaPaths,bytesToBase64} from './sync-model.mjs';
import {MEDIA_HOST,mediaType} from './reader.mjs';
import {wechatSource} from './wechat.mjs';

// The engine lays out at 720×960; drawing at 1.5× gives the usual 1080×1440 card.
export const CARD_SCALE=1.5,CARD_SIZE=Object.freeze({width:1080,height:1440});
// Used when a section has no template of its own.
export const DEFAULT_CARD_TEMPLATE=Object.freeze({ink:'#23352f',accent:'#35695f',muted:'#637169',paper:'#fcfdfb',family:'sans',layout:'guide',width:720,height:960,fontSize:26,lineHeight:1.65});
const CHROME='svg,button,.heading-collapse-indicator,.collapse-indicator,.list-collapse-indicator,.list-bullet,.markdown-embed-link,.frontmatter,.frontmatter-container,.mod-header,.mod-footer';

/** Remove what the editor adds around rendered Markdown, leaving plain block elements for the page engine. */
export function cleanRendered(root){
 for(const el of [...root.querySelectorAll(CHROME)])el.remove();
 // The renderer wraps every block in its own div; pages are filled block by block, so unwrap them.
 for(let changed=true;changed;){changed=false;for(const el of [...root.children])if(el.tagName==='DIV'&&!el.classList.contains('math')){el.replaceWith(...el.childNodes);changed=true;}}
 for(const el of [...root.querySelectorAll('*')])for(const attr of [...el.attributes])if(!['href','src','alt','start','colspan','rowspan'].includes(attr.name))el.removeAttribute(attr.name);
 for(const el of [...root.children])if(!el.textContent.trim()&&!el.querySelector('img')&&!['IMG','HR','TABLE'].includes(el.tagName))el.remove();
 return root;
}

/** What the page engine needs to know about a work. */
export function cardModel({source,site,url,template,html}){
 const data=source.work.data;
 return {version:1,site:{id:site?.id||'',name:site?.name||'',origin:url},sectionName:source.category,title:source.title,locale:data.locale||'zh-CN',url,
  date:String(data.date||''),author:String(data.author||''),html,templates:{pages:{...DEFAULT_CARD_TEMPLATE,...template}}};
}

// Animation frames stop while a window is hidden or covered; never let a page layout wait on one forever.
const pause=()=>new Promise(resolve=>{const timer=setTimeout(resolve,50);if(typeof requestAnimationFrame==='function')requestAnimationFrame(()=>{clearTimeout(timer);resolve();});});
const sha256=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const dataUrl=(name,bytes)=>{const data=bytesToBase64(bytes);return 'data:'+mediaType(name,data)+';base64,'+data;};

/**
 * Build the cards for a note. `render(markdown,element)` fills an element with the rendered body,
 * `readMedia(name)` returns a vault image's bytes or null, `frame()` returns an iframe attached to the page
 * for measuring. Returns {title,pages:[{name,blob}],caption,missing,manifest}. A picture that cannot be read
 * is left out and named in `missing`; the engine itself refuses to produce a set with lost text or pictures.
 */
export async function buildCards({doc,content,parseYaml,render,readMedia,frame,template=null,site=null,url,style='site',engineVersion='0',version=null,publishedVersion=null,
 signal,onProgress=()=>{},now=()=>new Date(),clean=cleanRendered,engine={paginate,rasterPage}}){
 const source=wechatSource(content,parseYaml),host=doc.createElement('div'),missing=[],images=new Map();
 // `template` is the section's page template, or a function that picks one from the parsed work.
 const look=typeof template==='function'?template(source):template;
 await render(source.markdown,host);signal?.throwIfAborted();clean(host);
 for(const img of [...host.querySelectorAll('img')]){
  const src=img.getAttribute('src')||'';let value=images.get(src)||null;
  if(!value&&src.startsWith(MEDIA_HOST)){
   let name='';try{name=decodeURIComponent(src.slice(MEDIA_HOST.length));}catch{}
   // Only images this work references are read, never an arbitrary vault path.
   const bytes=source.media.includes(name)?await readMedia(name):null;
   if(bytes)value=dataUrl(name,bytes);else missing.push(name||src);
  }else if(!value)missing.push(src||'(image without an address)');
  if(value)images.set(src,value);else img.remove();
 }
 const measure=frame();let result,blobs=[];
 try{
  const model=cardModel({source,site,url,template:look,html:host.innerHTML});
  result=await engine.paginate(measure,model,{signal,pause,onProgress:count=>onProgress({stage:'layout',count}),
   loadImage:async address=>{const value=images.get(address);if(!value)throw Object.assign(Error('A picture could not be read: '+address),{code:'image_unreadable'});return value;}});
  for(let i=0;i<result.pages.length;i++){signal?.throwIfAborted();onProgress({stage:'draw',count:i+1,total:result.pages.length});blobs.push(await engine.rasterPage(result.pages[i],result.style,{scale:CARD_SCALE,signal}));}
 }finally{measure.remove?.();}
 const width=String(Math.max(2,String(blobs.length).length)),pages=blobs.map((blob,i)=>({name:String(i+1).padStart(Number(width),'0')+'.png',blob}));
 const {work}=source,record={...work.data,kind:work.kind,media:work.media,version,publishedVersion};
 const {fields,warnings}=outputFields('cards',record,{cover:pages[0]?.name||null}),caption=[fields.title,fields.caption].filter(Boolean).join('\n\n');
 const files=[];
 for(const page of pages)files.push({path:page.name,role:'page',type:'image/png',bytes:page.blob.size,sha256:await sha256(await page.blob.arrayBuffer())});
 const captionBytes=new TextEncoder().encode(caption);files.push({path:'caption.txt',role:'text',type:'text/plain',bytes:captionBytes.length,sha256:await sha256(captionBytes)});
 const manifest=outputManifest({format:'cards',source:record,site:{id:site?.id||'unknown',name:site?.name||''},style,createdAt:now().toISOString(),engine:{name:'rssd-obsidian',version:engineVersion},
  sourceHash:await workFingerprint(work.data,localMediaPaths(work.media)),fields,files,
  warnings:[...checkSource(record).warnings,...warnings,...missing.map(name=>({code:'image_missing',message:'Picture could not be read and was left out: '+name}))]});
 return {title:source.title,pages,caption,missing,manifest,sectionId:source.sectionId,styled:!!look,size:CARD_SIZE};
}
