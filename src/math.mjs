// Formulas as pictures. Notes write formulas the way the website does — $…$, $$…$$, \(…\) and \[…\] — and
// the website draws them with KaTeX. Obsidian understands only the dollar forms, and neither a rich-text
// editor nor a set of picture cards can carry formula markup, so every formula in an output is drawn here
// with the website's own KaTeX version and carried as a picture: PNG in a copied article, SVG on a card.
// The fonts travel inside each picture, so it looks the same wherever it is shown.
import katex from 'katex';
import {mathSegments} from '../../scripts/article-math.mjs';
import {bytesToBase64} from './sync-model.mjs';

export const MATH_HOST='https://rssd-math.invalid/';
// Built in by build-templates.mjs: KaTeX's stylesheet without its fonts, and each font face as its own rule
// with the font inside. A build without them still draws formulas, with the system's serif font.
const ASSETS=typeof RSSD_KATEX==='object'&&RSSD_KATEX?RSSD_KATEX:{css:'',faces:[]};
// A display formula sits on its own; the picture should not carry KaTeX's page margins.
const LOCAL_CSS='.katex-display{margin:0}.rssd-formula{display:inline-block;white-space:nowrap;line-height:1.2}';

/**
 * Replace every formula in a Markdown body with a picture placeholder that Markdown keeps where the formula
 * was. Code spans and fences are left alone, so is a dollar amount. Returns {markdown,formulas,error}; on an
 * unclosed delimiter the body is returned unchanged with `error` set, so nothing is lost.
 */
export function extractMath(markdown){
 let parts;try{parts=mathSegments(markdown,{markdown:true});}catch(error){return {markdown,formulas:[],error:String(error?.message||error)};}
 const formulas=[];
 const text=parts.map(part=>{if(part.tex===undefined)return part.text;formulas.push({tex:part.tex.trim(),display:!!part.display});return '![]('+MATH_HOST+(formulas.length-1)+')';}).join('');
 return {markdown:text,formulas,error:null};
}
/** The formula a placeholder stands for, or -1. */
export const formulaIndex=src=>{const m=/^https:\/\/rssd-math\.invalid\/(\d+)$/.exec(String(src||''));return m?Number(m[1]):-1;};

const fontFamilies=el=>String(el.ownerDocument.defaultView.getComputedStyle(el).fontFamily||'').split(',').map(name=>name.trim().replace(/^["']|["']$/g,''));
const svgUrl=svg=>'data:image/svg+xml;base64,'+bytesToBase64(new TextEncoder().encode(svg));

/**
 * Draw formulas. Returns one {svg,width,height,depth,tex,display} per formula, where svg is a picture with
 * its fonts inside, width and height are its size in CSS pixels at `fontSize`, and depth is how far it
 * reaches below the text baseline (for lining an inline formula up with the words around it).
 */
export async function formulaPictures(doc,formulas,{fontSize=16,color='#222222'}={}){
 if(!formulas.length)return [];
 const host=doc.createElement('div');host.setAttribute('aria-hidden','true');
 host.style.cssText='position:fixed;left:-20000px;top:0;visibility:hidden;pointer-events:none';
 const style=doc.createElement('style');style.textContent=ASSETS.faces.map(face=>face.css).join('')+ASSETS.css+LOCAL_CSS;host.append(style);
 (doc.body||doc.documentElement).append(host);
 try{
  const boxes=formulas.map(formula=>{
   const box=doc.createElement('span');box.className='rssd-formula';box.style.cssText=`font-size:${fontSize}px;color:${color}`;
   box.innerHTML=katex.renderToString(formula.tex,{displayMode:formula.display,throwOnError:false,output:'html',strict:'ignore',trust:false});
   // A zero-size mark after an inline formula sits on its baseline.
   if(!formula.display){const mark=doc.createElement('span');mark.style.cssText='display:inline-block;width:0;height:0;vertical-align:baseline';box.append(mark);}
   host.append(box);return box;
  });
  await doc.fonts?.ready;
  return boxes.map((box,index)=>{
   const rect=box.getBoundingClientRect(),pad=Math.ceil(fontSize*.12),width=Math.ceil(rect.width)+pad*2,height=Math.ceil(rect.height)+pad*2;
   const mark=formulas[index].display?null:box.lastElementChild,depth=mark?Math.max(0,Math.round(rect.bottom-mark.getBoundingClientRect().top))+pad:0;
   mark?.remove();
   const used=new Set([box,...box.querySelectorAll('*')].flatMap(fontFamilies));
   const css=ASSETS.faces.filter(face=>used.has(face.family)).map(face=>face.css).join('')+ASSETS.css+LOCAL_CSS;
   const clone=box.cloneNode(true);clone.style.cssText=`font-size:${fontSize}px;color:${color};padding:${pad}px`;
   const body=new XMLSerializer().serializeToString(clone);
   const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject x="0" y="0" width="${width}" height="${height}"><div xmlns="http://www.w3.org/1999/xhtml"><style><![CDATA[${css}]]></style>${body}</div></foreignObject></svg>`;
   return {svg:svgUrl(svg),width,height,depth,tex:formulas[index].tex,display:formulas[index].display};
  });
 }finally{host.remove();}
}

/** A formula picture as PNG, drawn `scale` times larger than its CSS size so it stays sharp. */
export async function formulaPng(doc,picture,{scale=3}={}){
 const image=new (doc.defaultView.Image)();image.src=picture.svg;await image.decode();
 const canvas=doc.createElement('canvas');canvas.width=Math.max(1,Math.round(picture.width*scale));canvas.height=Math.max(1,Math.round(picture.height*scale));
 const context=canvas.getContext('2d');if(!context)throw Error('A formula could not be drawn');
 context.scale(scale,scale);context.drawImage(image,0,0,picture.width,picture.height);
 const url=canvas.toDataURL('image/png');canvas.width=1;canvas.height=1;return url;
}

/** How a formula picture sits in a copied article: inline on the text baseline, or centred on its own line. */
export const formulaStyle=picture=>picture.display
 ?`display:block;width:${picture.width}px;max-width:100%;height:auto;margin:12px auto;`
 :`display:inline-block;width:${picture.width}px;max-width:100%;height:auto;margin:0 1px;vertical-align:-${picture.depth}px;`;
