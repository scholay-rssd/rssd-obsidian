// What the card view hands out: the pictures, and the post text (发布文案) shown beside them. Cards are looked at
// in the vault and taken out of it, never saved back into it: a set is drawn again from the work, or kept by
// the Center, so a copy in the vault would only go stale. Pure, so it is tested without Obsidian.
import {characters,outputProfile} from '../../contracts/output-package.mjs';

const LIMITS=outputProfile('cards').limits;
const clean=value=>String(value??'').trim();

/**
 * The post text of a set in its parts: title, body (the work's summary) and topic tags, each with its length
 * and the destination's limit, plus all of it joined the way it is pasted. Nothing is shortened: an over-long
 * part is shown as over, so the writer decides what to cut.
 */
export function postText({title='',summary='',tags=[]}={}){
 const list=[...new Set((Array.isArray(tags)?tags:[]).map(tag=>clean(tag).replace(/^#+/,'').replace(/\s+/g,'')).filter(Boolean))];
 const parts=[
  {id:'title',label:'标题',text:clean(title),limit:LIMITS.title},
  {id:'body',label:'正文',text:clean(summary),limit:LIMITS.caption},
  {id:'tags',label:'话题',text:list.map(tag=>'#'+tag).join(' '),limit:LIMITS.tags,count:list.length},
 ].map(part=>({...part,count:part.count??characters(part.text)})).map(part=>({...part,over:!!part.limit&&part.count>part.limit}));
 return {parts,all:parts.map(part=>part.text).filter(Boolean).join('\n\n')};
}

/** A name the computer accepts for a file or folder made from a note's name. */
export function safeName(value,fallback='cards'){
 const name=String(value??'').replace(/[\\/:*?"<>|\u0000-\u001f]/g,' ').replace(/\s+/g,' ').trim().replace(/^\.+/,'').slice(0,80).trim();
 return name||fallback;
}

/** The file name of one card when it leaves the vault: the work's name and the card's number, so cards of several works do not collide. */
export const cardFileName=(work,page)=>safeName(work)+'-'+page.name;

/** The name of the post text file in an exported set. */
export const postTextFile=locale=>locale==='en'?'caption.txt':'文案.txt';

/** A folder name for an export that does not replace one already there: "<name>", then "<name> (2)" and so on. */
export function exportFolderName(work,taken,locale='zh-CN'){
 const base=safeName(work)+(locale==='en'?' (en)':'');
 if(!taken(base))return base;
 for(let n=2;n<1000;n++){const name=base+' ('+n+')';if(!taken(name))return name;}
 throw Error('Too many exports of this work in that folder');
}

/** The files of an exported set: each card as a numbered picture, and the post text. */
export function exportFiles({pages,post,locale}){
 return [...pages.map(page=>({name:page.name,blob:page.blob})),...(post?.all?[{name:postTextFile(locale),text:post.all+'\n'}]:[])];
}
