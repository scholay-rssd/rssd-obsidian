// Copy a work for the WeChat official-account editor. The styling is the website's own clipboard engine
// (web/engine/browser-export), so a work pasted from Obsidian matches one copied from its public page. This
// only fills the clipboard: nothing is sent to the Center or to WeChat.
import {wechatClipboardHtml,embedClipboardImages} from '../../web/engine/browser-export/wechat-clipboard.mjs';
import {outputManifest,outputFields,checkSource} from '../../contracts/output-package.mjs';
import {noteToWork,bytesToBase64,workFingerprint,localMediaPaths} from './sync-model.mjs';
import {MEDIA_HOST,mediaType} from './reader.mjs';
import {extractMath,formulaIndex,formulaPictures,formulaPng,formulaStyle} from './math.mjs';

/** The body to render: images point at MEDIA_HOST placeholders and a leading copy of the title is dropped. */
export function wechatSource(content,parseYaml){
 const work=noteToWork(content,parseYaml);
 if(!work)throw Object.assign(Error('This note is not an RSSD work'),{code:'unlinked_work'});
 const title=String(work.data.title||'');
 let markdown=work.data.markdown.replace(/([("])\/article-media\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})/g,'$1'+MEDIA_HOST+'$2');
 // WeChat has its own title field; the body should not repeat it.
 const heading=/^\s*#\s+([^\r\n]+)\r?\n+/.exec(markdown);
 if(heading&&title&&heading[1].trim()===title.trim())markdown=markdown.slice(heading[0].length);
 return {title,markdown,media:work.media,sectionId:String(work.data.sectionId||''),category:String(work.data.category||''),work};
}

/**
 * Render a note and return {html,plain,title,images,missing}. `render(markdown,element)` fills an element with
 * the rendered body; `readMedia(name)` returns a vault image's bytes or null. Images travel inside the HTML,
 * re-encoded as JPEG or PNG, because the WeChat editor drops WebP and cannot reach vault files. `template`
 * is the look to apply, or a function that picks one from the parsed work (null keeps the default look).
 */
export async function wechatHtml({doc,content,parseYaml,render,readMedia,template={},decorate,pack,signal,engine={wechatClipboardHtml,embedClipboardImages},
 math={extractMath,formulaPictures,formulaPng}}){
 const source=wechatSource(content,parseYaml),article=doc.createElement('article'),missing=[];
 const look=(typeof template==='function'?template(source):template)||{};
 // Formulas are drawn as pictures (see math.mjs); the editor would otherwise receive raw LaTeX.
 const formulas=math.extractMath(source.markdown),extra=[];
 if(formulas.error)extra.push({code:'formula_unreadable',message:'A formula delimiter is not closed, so formulas were left as text: '+formulas.error});
 await render(formulas.markdown,article);
 signal?.throwIfAborted();
 const pictures=await math.formulaPictures(doc,formulas.formulas,{fontSize:16,color:look.ink||'#23352f'}),placed=new Map();
 let images=0;
 for(const img of [...article.querySelectorAll('img')]){
  const src=img.getAttribute('src')||'',index=formulaIndex(src);
  if(index>=0){
   const picture=pictures[index];if(!picture){img.remove();continue;}
   const png=await math.formulaPng(doc,picture);img.setAttribute('src',png);img.setAttribute('alt',picture.tex);placed.set(png,picture);continue;
  }
  if(!src.startsWith(MEDIA_HOST)){images++;continue;}
  let name='';try{name=decodeURIComponent(src.slice(MEDIA_HOST.length));}catch{}
  // Only images this work references are read, never an arbitrary vault path.
  const bytes=source.media.includes(name)?await readMedia(name):null;
  if(!bytes){missing.push(name||src);img.remove();continue;}
  const data=bytesToBase64(bytes);img.setAttribute('src','data:'+mediaType(name,data)+';base64,'+data);images++;
 }
 await engine.embedClipboardImages(article,{signal});
 const styled=engine.wechatClipboardHtml(article,look);
 // The site's own chapter openings and name marks go on last, over the engine's plain styling.
 let html=decorate?decorate(styled,{look,source}):styled;
 // A formula keeps its own size and sits on the text baseline, not stretched like a photo.
 if(placed.size){const box=doc.createElement('div');box.innerHTML=html;for(const img of box.querySelectorAll('img')){const picture=placed.get(img.getAttribute('src'));if(picture)img.setAttribute('style',formulaStyle(picture));}html=box.innerHTML;}
 // Plain text comes from the styled result, so it has no editor buttons and keeps one block per line.
 const text=doc.createElement('div');text.innerHTML=styled;
 // In plain text a formula is its LaTeX source.
 for(const img of [...text.querySelectorAll('img')]){const picture=placed.get(img.getAttribute('src'));if(picture)img.replaceWith(picture.display?'\n'+picture.tex+'\n':picture.tex);}
 for(const el of [...text.querySelectorAll('p,h1,h2,h3,li,pre,tr,blockquote,figcaption,br')])el.after('\n');
 const plain=String(text.textContent||'').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
 // `pack` ({site,style,engineVersion,version,publishedVersion}) asks for the output's package manifest too.
 const manifest=pack?await wechatManifest({source,html,plain,missing,extra,...pack}):null;
 return {html,plain,title:source.title,images,formulas:placed.size,missing,sectionId:source.sectionId,styled:Object.keys(look).length>0,manifest};
}

const sha256=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
/**
 * The package manifest for a WeChat output (see contracts/output-package.mjs): what was exported, from which
 * source, in which style, plus the title, digest, author and cover WeChat asks for besides the body. Images
 * travel inside body.html, so the body and its plain text are the only files.
 */
export async function wechatManifest({source,html,plain,missing=[],extra=[],site,style='',engineVersion='0',version=null,publishedVersion=null,now=()=>new Date()}){
 const {work}=source,record={...work.data,kind:work.kind,media:work.media,version,publishedVersion};
 const {fields,warnings}=outputFields('wechat-article',record),bytes=text=>new TextEncoder().encode(text).length;
 return outputManifest({format:'wechat-article',source:record,site,style,createdAt:now().toISOString(),engine:{name:'rssd-obsidian',version:engineVersion},
  // The same fingerprint sync uses for "has this note changed": text and image names, not image bytes.
  sourceHash:await workFingerprint(work.data,localMediaPaths(work.media)),fields,
  files:[{path:'body.html',role:'body',type:'text/html',bytes:bytes(html),sha256:await sha256(html)},{path:'body.txt',role:'text',type:'text/plain',bytes:bytes(plain),sha256:await sha256(plain)}],
  warnings:[...checkSource(record).warnings,...warnings,...missing.map(name=>({code:'image_missing',message:'Image not found in the vault and left out: '+name})),...extra]});
}

/** Put rich HTML and its plain text on the clipboard together, as the editor expects. */
export async function copyRich({html,plain},clipboard=globalThis.navigator?.clipboard,Item=globalThis.ClipboardItem){
 if(!clipboard?.write||typeof Item!=='function')throw Object.assign(Error('This device cannot copy formatted text'),{code:'clipboard_unavailable'});
 await clipboard.write([new Item({'text/html':new Blob([html],{type:'text/html'}),'text/plain':new Blob([plain],{type:'text/plain'})})]);
}
