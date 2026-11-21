// Drawing the Center's card sets as PNG pages in Obsidian, so they show and export like every other card set.
// A layout page (智能排版) is HTML and CSS: it is laid out in a sandboxed, scriptless frame kept off screen and
// drawn the way web/engine/browser-export/raster.mjs draws the plug-in's own cards. A raster page (模型生图) is
// already a picture; it is only re-encoded as PNG.
import {layoutDocument} from './cloud-cards.mjs';

const toPng=canvas=>new Promise((resolve,reject)=>{try{canvas.toBlob(value=>value?resolve(value):reject(Error('Could not make the card picture')),'image/png');}catch(error){reject(error);}});

/** A picture's bytes (WebP, PNG or JPEG) as a PNG blob. */
export async function pictureToPng(bytes,type='image/webp'){
 const bitmap=await createImageBitmap(new Blob([bytes],{type}));
 try{
  const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
  const context=canvas.getContext('2d');if(!context)throw Error('Could not make a picture canvas');context.drawImage(bitmap,0,0);
  const blob=await toPng(canvas);canvas.width=1;canvas.height=1;return blob;
 }finally{bitmap.close?.();}
}

function loaded(frame){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('The card page did not load')),20000);frame.addEventListener('load',()=>{clearTimeout(timer);resolve();},{once:true});});}

/**
 * Draw each page of a layout set as a PNG of `width`×`height`. `media` maps a media ID to a blob: URL.
 * `onPage(index)` hears each page as it starts.
 */
export async function rasterLayout({css,pages,media,width,height,signal,onPage=()=>{}}){
 const frame=document.createElement('iframe');
 // allow-same-origin without allow-scripts: the page is measured and copied from here, and nothing in it runs.
 frame.setAttribute('sandbox','allow-same-origin');frame.setAttribute('aria-hidden','true');frame.tabIndex=-1;
 frame.style.cssText='position:fixed;left:-20000px;top:0;width:'+width+'px;height:'+height+'px;border:0;visibility:hidden';
 document.body.append(frame);
 const blobs=[];
 try{
  for(const [index,page] of pages.entries()){
   signal?.throwIfAborted();onPage(index);
   const ready=loaded(frame);frame.srcdoc=layoutDocument({css,html:page.html,media});await ready;
   const doc=frame.contentDocument;if(!doc?.body)throw Error('The card page could not be read');
   await doc.fonts?.ready;
   const pictures=[...doc.images];await Promise.all(pictures.map(image=>image.decode().catch(()=>{})));
   const sheet=doc.body.firstElementChild||doc.body,box=sheet.getBoundingClientRect();
   const w=Math.max(1,Math.round(box.width)),h=Math.max(1,Math.round(box.height)),scale=width/w;
   blobs.push(await drawPage(doc,sheet,{w,h,scale,pictures,signal}));
  }
 }finally{frame.remove();}
 return blobs;
}

// A transparent pixel: a picture's stand-in in the copy, which can load nothing from outside itself.
const BLANK='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

async function drawPage(doc,sheet,{w,h,scale,pictures,signal}){
 // Pictures inside an SVG foreignObject are not painted, so they are drawn onto the canvas from the frame, where
 // they are already decoded. In the copy each keeps its place as a blank of exactly its size: a blob: address
 // does not load there, and a picture with no size would let a centred page close up and move the text away
 // from where the picture is then drawn (a cover's picture landed on its title).
 const clone=doc.documentElement.cloneNode(true);clone.setAttribute('xmlns','http://www.w3.org/1999/xhtml');
 const copies=[...clone.querySelectorAll('img')];
 doc.querySelectorAll('img').forEach((image,index)=>{
  const copy=copies[index];if(!copy)return;
  const box=image.getBoundingClientRect();
  copy.removeAttribute('srcset');copy.setAttribute('src',BLANK);
  for(const [name,value] of [['visibility','hidden'],['box-sizing','border-box'],['width',box.width+'px'],['height',box.height+'px'],['min-width','0'],['min-height','0'],['max-width','none'],['max-height','none']])copy.style.setProperty(name,value,'important');
 });
 clone.querySelectorAll('meta,script').forEach(node=>node.remove());
 const xml=new XMLSerializer().serializeToString(clone);
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'"><foreignObject x="0" y="0" width="'+w+'" height="'+h+'">'+xml+'</foreignObject></svg>';
 const img=new Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);await img.decode();signal?.throwIfAborted();
 const canvas=document.createElement('canvas');canvas.width=Math.round(w*scale);canvas.height=Math.round(h*scale);
 const context=canvas.getContext('2d');if(!context)throw Error('Could not make a picture canvas');
 context.scale(scale,scale);context.drawImage(img,0,0);
 const paper=sheet.getBoundingClientRect(),view=doc.defaultView;
 for(const picture of pictures){
  if(!picture.naturalWidth||!picture.naturalHeight)continue;
  const box=picture.getBoundingClientRect(),style=view.getComputedStyle(picture);if(!box.width||!box.height||style.visibility==='hidden'||style.display==='none')continue;
  const cover=style.objectFit==='cover',fit=(cover?Math.max:Math.min)(box.width/picture.naturalWidth,box.height/picture.naturalHeight);
  const width=picture.naturalWidth*fit,height=picture.naturalHeight*fit;
  const x=box.left-paper.left+(box.width-width)/2,y=box.top-paper.top+(box.height-height)/2;
  const radius=Math.min(parseFloat(style.borderRadius)||0,box.width/2,box.height/2);
  context.save();context.beginPath();
  if(radius&&context.roundRect)context.roundRect(box.left-paper.left,box.top-paper.top,box.width,box.height,radius);else context.rect(box.left-paper.left,box.top-paper.top,box.width,box.height);
  context.clip();context.drawImage(picture,x,y,width,height);context.restore();
 }
 const blob=await toPng(canvas);canvas.width=1;canvas.height=1;return blob;
}
