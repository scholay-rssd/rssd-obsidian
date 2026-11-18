// The card view: a work laid out as fixed-size picture pages (3:4, 1080×1440), ready for any platform
// that takes a set of images. Layout and drawing are the website's own page engine (web/engine/browser-export:
// pagination.mjs fills 720×960 pages and checks that no text or picture was lost, raster.mjs draws each as a
// PNG), so cards made here match the pages downloaded from a public article. This file prepares the work
// for that engine and describes the result as a package (contracts/output-package.mjs).
import {paginate} from '../../web/engine/browser-export/pagination.mjs';
import {rasterPage} from '../../web/engine/browser-export/raster.mjs';
import {checkVisibleText} from './card-stylesheet.mjs';
import {outputManifest,outputFields,checkSource} from '../../contracts/output-package.mjs';
import {workFingerprint,localMediaPaths,bytesToBase64} from './sync-model.mjs';
import {MEDIA_HOST,mediaType} from './reader.mjs';
import {wechatSource} from './wechat.mjs';
import {extractMath,formulaIndex,formulaPictures} from './math.mjs';

// The engine lays out at 720×960; drawing at 1.5× gives the usual 1080×1440 card.
export const CARD_SCALE=1.5,CARD_SIZE=Object.freeze({width:1080,height:1440});
// Used when a section has no template of its own.
// Card themes. Text fills each card in reading order; key points give each chapter a card of its own, in larger
// type; pictures give each picture a card with its description underneath.
export const CARD_THEMES=Object.freeze({text:{label:'Text'},points:{label:'Key points',template:{fontSize:30,lineHeight:1.6}},pictures:{label:'Pictures'}});
// Sizes are measured on the 720px layout canvas before the 1.5x PNG export.
// A caption is a note on its picture, not body text: small, muted and centred under it.
const fullTextStyle=muted=>`
.rssd-page .rssd-article-heading h1{font-size:1.56em;line-height:1.23;letter-spacing:0;margin-bottom:.35em}
.rssd-page .rssd-body h2{font-size:1.25em;line-height:1.38;font-weight:700;margin:1em 0 .42em}
.rssd-page .rssd-body h3{font-size:1.09em;line-height:1.4}
.rssd-page .rssd-body table{font-size:.83em;line-height:1.45;font-variant-numeric:tabular-nums}
.rssd-page .rssd-body td,.rssd-page .rssd-body th{padding:8px 5px}
.rssd-page .rssd-body figcaption,.rssd-page .rssd-body p.rssd-caption{font-size:.69em;line-height:1.6;margin:-8px 0 20px;color:${muted};text-align:center;text-indent:0}
.rssd-page .rssd-body .rssd-indent{display:inline-block;width:2em}
`;
const CAPTION_NUMBERED=/^(?:图|表)\s*[0-9一二三四五六七八九十]+\s*[｜|：:．.]/u;
const CAPTION_LABEL=/^(?:(?:图|表)\s*[0-9一二三四五六七八九十]*\s*[｜|：:．.]|(?:figure|fig\.?|table)\s*\d*\s*[:.|｜])/iu;
/**
 * Whether a paragraph is the caption of a picture or table. A numbered label (图 1：) is one anywhere;
 * an unnumbered one (图：, Figure:) only directly under the picture or table it describes.
 */
export function isCardCaption(text,afterPicture){
 const value=String(text||'').trim();
 return CAPTION_NUMBERED.test(value)||(!!afterPicture&&CAPTION_LABEL.test(value));
}
const pictureOnly=el=>!!el&&(el.tagName==='IMG'||el.tagName==='TABLE'||(el.tagName==='P'&&!(el.textContent||'').trim()&&!!el.querySelector('img')));
/**
 * Mark the captions, and in Chinese give body paragraphs a two-character first-line indent (not captions,
 * lists, quotes, tables or the closing references). The indent is an empty leading box, not a paragraph
 * style, so a paragraph continued on the next card does not start with a second indent.
 */
export function typesetCardBody(host,locale='zh-CN'){
 const doc=host.ownerDocument,indent=/^zh/i.test(locale||'zh-CN');
 let notes=false;
 for(const el of [...host.children]){
  if(/^H[1-6]$/.test(el.tagName)){if(el.tagName==='H2'||el.tagName==='H1')notes=STRUCTURAL.test(el.textContent||'');continue;}
  if(el.tagName!=='P'||!(el.textContent||'').trim())continue;
  if(isCardCaption(el.textContent,pictureOnly(el.previousElementSibling))){el.classList.add('rssd-caption');continue;}
  if(!indent||notes)continue;
  const box=doc.createElement('span');box.className='rssd-indent';el.prepend(box);
 }
}
const BREAK='<hr class="rssd-page-break">';
const STRUCTURAL=/^\s*(参考文献|参考资料|延伸阅读|相关阅读|附录|致谢|注释|references?|further reading|notes?|appendix|acknowledge?ments?)\s*$/i;
/** Arrange a work's rendered body for a card theme. Throws when the theme has nothing to show. */
export function arrangeForCards(host,theme){
 const doc=host.ownerDocument;
 if(theme==='points'){
  // A closing section such as 参考文献 stays with the last chapter instead of taking a card of its own.
  for(const heading of [...host.querySelectorAll('h2')])if(heading.previousElementSibling&&!STRUCTURAL.test(heading.textContent||''))heading.insertAdjacentHTML('beforebegin',BREAK);
  return;
 }
 if(theme==='pictures'){
  const pictures=[...host.querySelectorAll('img')].filter(img=>!/\brssd-math/.test(img.className||''));
  if(!pictures.length)throw Object.assign(Error('This work has no pictures to make picture cards from.'),{code:'no_pictures'});
  const parts=pictures.map(img=>{const figure=doc.createElement('figure'),alt=(img.getAttribute('alt')||'').trim();figure.append(img.cloneNode());if(alt){const caption=doc.createElement('figcaption');caption.textContent=alt;figure.append(caption);}return figure.outerHTML;});
  host.innerHTML=parts.join(BREAK);
 }
}
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

// A template's colour goes into the cards' stylesheet, so only a plain hex colour is taken from it.
const mutedInk=look=>/^#[0-9a-f]{3,8}$/i.test(look?.muted||'')?look.muted:DEFAULT_CARD_TEMPLATE.muted;
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
 * `cardCss` is a column's AI stylesheet (or a function of the parsed work returning it), already checked by checkCardStylesheet: the engine measures and draws
 * with it, and a set whose text it hides, fades, shrinks or pushes off a card is refused.
 */
export async function buildCards({doc,content,parseYaml,render,readMedia,frame,template=null,site=null,url,style='text',engineVersion='0',version=null,publishedVersion=null,
 cardTheme='text',cardCss='',signal,onProgress=()=>{},now=()=>new Date(),clean=cleanRendered,engine={paginate,rasterPage},math={extractMath,formulaPictures}}){
 const source=wechatSource(content,parseYaml);
 if(cardTheme==='pictures'&&!source.media.length)throw Object.assign(Error('这篇稿件没有可用的正文配图。'),{code:'no_pictures'});
 const host=doc.createElement('div'),missing=[],images=new Map();
 // `template` is the section's page template, or a function that picks one from the parsed work.
 const sectionLook=typeof template==='function'?template(source):template,themeLook=CARD_THEMES[cardTheme]?.template;
 // `cardCss`, like `template`, may be chosen from the parsed work (its column's stylesheet).
 const css=typeof cardCss==='function'?await cardCss(source):cardCss||'';signal?.throwIfAborted();
 const look=sectionLook||themeLook?{...(sectionLook||{}),...(themeLook||{})}:null;
 // Formulas are drawn as vector pictures at the card's text size (see math.mjs).
 const formulas=math.extractMath(source.markdown);
 await render(formulas.markdown,host);signal?.throwIfAborted();clean(host);
 const pictures=cardTheme==='pictures'?[]:await math.formulaPictures(doc,formulas.formulas,{fontSize:Number(look?.fontSize)||DEFAULT_CARD_TEMPLATE.fontSize,color:look?.ink||DEFAULT_CARD_TEMPLATE.ink});
 for(const img of [...host.querySelectorAll('img')]){
  const src=img.getAttribute('src')||'',index=formulaIndex(src);
  if(index>=0){const picture=pictures[index];if(!picture){img.remove();continue;}images.set(src,picture.svg);img.setAttribute('alt',picture.tex);img.className=picture.display?'rssd-math-block':'rssd-math';continue;}
  let value=images.get(src)||null;
  if(!value&&src.startsWith(MEDIA_HOST)){
   let name='';try{name=decodeURIComponent(src.slice(MEDIA_HOST.length));}catch{}
   // Only images this work references are read, never an arbitrary vault path.
   const bytes=source.media.includes(name)?await readMedia(name):null;
   if(bytes)value=dataUrl(name,bytes);else missing.push(name||src);
  }else if(!value)missing.push(src||'(image without an address)');
  if(value)images.set(src,value);else img.remove();
 }
 if(style==='site'&&cardTheme==='text')typesetCardBody(host,source.work.data.locale);
 arrangeForCards(host,cardTheme);
 const measure=frame();let result,blobs=[];
 try{
  const model=cardModel({source,site,url,template:look,html:host.innerHTML});
  result=await engine.paginate(measure,model,{signal,pause,extraStyle:(style==='site'&&cardTheme==='text'?fullTextStyle(mutedInk(look)):'')+css,onProgress:count=>onProgress({stage:'layout',count}),
   loadImage:async address=>{const value=images.get(address);if(!value)throw Object.assign(Error('A picture could not be read: '+address),{code:'image_unreadable'});return value;}});
  if(css){const problems=checkVisibleText(result.pages);if(problems.length)throw Object.assign(Error('The card style hides part of the work: '+problems.slice(0,3).join('; ')+(problems.length>3?' and '+(problems.length-3)+' more':'')),{code:'card_style_hides_text',problems});}
  for(let i=0;i<result.pages.length;i++){signal?.throwIfAborted();onProgress({stage:'draw',count:i+1,total:result.pages.length});blobs.push(await engine.rasterPage(result.pages[i],result.style,{scale:CARD_SCALE,signal}));}
 }finally{measure.remove?.();}
 const warnings=[...(formulas.error?[{code:'formula_unreadable',message:'A formula delimiter is not closed, so formulas were left as text: '+formulas.error}]:[]),...missing.map(name=>({code:'image_missing',message:'Picture could not be read and was left out: '+name}))];
 return packageCardPages({source,site,style,blobs,version,publishedVersion,engineVersion,now,missing,styled:!!sectionLook||!!css,extraWarnings:warnings});
}

export async function packageCardPages({source,site,style,blobs,version,publishedVersion,engineVersion,now=()=>new Date(),missing=[],styled=true,extraWarnings=[]}){
 const width=String(Math.max(2,String(blobs.length).length)),pages=blobs.map((blob,i)=>({name:String(i+1).padStart(Number(width),'0')+'.png',blob}));
 const {work}=source,record={...work.data,kind:work.kind,media:work.media,version,publishedVersion};
 const {fields,warnings}=outputFields('cards',record,{cover:pages[0]?.name||null}),caption=[fields.title,fields.caption].filter(Boolean).join('\n\n');
 const files=[];
 for(const page of pages)files.push({path:page.name,role:'page',type:'image/png',bytes:page.blob.size,sha256:await sha256(await page.blob.arrayBuffer())});
 const captionBytes=new TextEncoder().encode(caption);files.push({path:'caption.txt',role:'text',type:'text/plain',bytes:captionBytes.length,sha256:await sha256(captionBytes)});
 const manifest=outputManifest({format:'cards',source:record,site:{id:site?.id||'unknown',name:site?.name||''},style,createdAt:now().toISOString(),engine:{name:'rssd-obsidian',version:engineVersion},
  sourceHash:await workFingerprint(work.data,localMediaPaths(work.media)),fields,files,
  warnings:[...checkSource(record).warnings,...warnings,...extraWarnings]});
 return {title:source.title,pages,caption,missing,manifest,sectionId:source.sectionId,styled,size:CARD_SIZE};
}
