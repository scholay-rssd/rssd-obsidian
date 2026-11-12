// Build-time only: collect each site's WeChat article template from the RSSD website themes so the plugin
// styles a work the way its public page does. Only the fields the clipboard engine reads are kept.
import {readdirSync,readFileSync} from 'node:fs';

const FIELDS=['ink','accent','muted','paper','family','titleFamily','heading'];
// The page (card) template of every section, whole: the page engine reads all of it.
export function cardTemplates(root=new URL('../web/themes/export/templates/',import.meta.url)){
 const table={};
 for(const site of readdirSync(root,{withFileTypes:true})){
  if(!site.isDirectory())continue;
  for(const file of readdirSync(new URL(site.name+'/',root))){
   if(!file.endsWith('.json'))continue;
   const record=JSON.parse(readFileSync(new URL(site.name+'/'+file,root),'utf8')),section=file.slice(0,-5);
   if(record.siteId!==site.name||record.sectionId!==section||!record.pages||typeof record.pages!=='object')throw Error('Invalid page template: '+site.name+'/'+file);
   (table[site.name]??={})[section]=record.pages;
  }
 }
 if(!Object.keys(table).length)throw Error('No page templates found in '+root);
 return table;
}
export function wechatTemplates(root=new URL('../web/themes/export/templates/',import.meta.url)){
 const table={};
 for(const site of readdirSync(root,{withFileTypes:true})){
  if(!site.isDirectory())continue;
  for(const file of readdirSync(new URL(site.name+'/',root))){
   if(!file.endsWith('.json'))continue;
   const record=JSON.parse(readFileSync(new URL(site.name+'/'+file,root),'utf8')),section=file.slice(0,-5);
   if(record.siteId!==site.name||record.sectionId!==section||!record.article)throw Error('Invalid article template: '+site.name+'/'+file);
   const template={};
   for(const field of FIELDS)if(typeof record.article[field]==='string')template[field]=record.article[field];
   (table[site.name]??={})[section]=template;
  }
 }
 if(!Object.keys(table).length)throw Error('No article templates found in '+root);
 return table;
}
/** Which site each space publishes as, with the name and slogan it signs with. */
export function wechatSites(file=new URL('../sites/profiles.json',import.meta.url)){
 const sites={};
 for(const profile of JSON.parse(readFileSync(file,'utf8'))){
  if(typeof profile?.id!=='string'||typeof profile.spaceId!=='string'||typeof profile.name!=='string')throw Error('Invalid site profile');
  sites[profile.spaceId]={id:profile.id,name:profile.name,slogan:typeof profile.slogan==='string'?profile.slogan:'',origin:typeof profile.origin==='string'?profile.origin:''};
 }
 return sites;
}
/**
 * KaTeX's stylesheet for drawing formulas as pictures: the rules without their fonts, and each font face on
 * its own with the WOFF2 font inside, so a picture can carry only the faces its formula uses.
 */
export function katexAssets(dist=new URL('./node_modules/katex/dist/',import.meta.url)){
 const css=readFileSync(new URL('katex.min.css',dist),'utf8'),faces=[];
 const rest=css.replace(/@font-face\{([^}]*)\}/g,(_,body)=>{
  const family=/font-family:\s*"?([^";]+)"?/.exec(body)?.[1],file=/url\((fonts\/[^)]+\.woff2)\)/.exec(body)?.[1];
  if(!family||!file)throw Error('Unexpected KaTeX font face');
  const data=readFileSync(new URL(file,dist)).toString('base64');
  faces.push({family,css:'@font-face{'+body.replace(/src:[^;}]+/,'src:url(data:font/woff2;base64,'+data+') format("woff2")')+'}'});
  return '';
 });
 if(faces.length<10)throw Error('KaTeX fonts are missing from '+dist);
 return {css:rest,faces};
}
