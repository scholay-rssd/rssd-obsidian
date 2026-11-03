// How a Center work becomes a vault note and back, and what state each work is in. Pure: YAML, hashing and
// file access are passed in, so the same rules run in tests, on desktop and on mobile.
// A note is identified by its `rssd-id` property, never by its file name or folder.
import {synchronizationState} from '../../contracts/sync-state.mjs';

export const WORKS_FOLDER='Works';
export const MEDIA_FOLDER='article-media';
// Editable properties, in the order they are written. Identity properties are prefixed and must not change.
const EDITABLE=['title','summary','date','author','category'];
const IDENTITY={id:'rssd-id',sectionId:'rssd-section',locale:'rssd-locale',kind:'rssd-kind',version:'rssd-version',publishedVersion:'rssd-published-version'};

// Center bodies link images at the site root. English notes are one directory
// deeper than legacy Chinese notes, so their relative image paths differ.
export const LOCALES=Object.freeze(['zh-CN','en']);
export function checkLocale(locale){
 if(!LOCALES.includes(locale))throw Error('Unsupported RSSD work language: '+locale);
 return locale;
}
const mediaPrefix=locale=>checkLocale(locale)==='en'?'../../':'../';
export const toVaultMarkdown=(markdown,locale='zh-CN')=>markdown.replace(/([("])\/article-media\//g,'$1'+mediaPrefix(locale)+MEDIA_FOLDER+'/');
export const toCenterMarkdown=(markdown,locale='zh-CN')=>{
 const prefix=mediaPrefix(locale).replace(/\./g,'\\.');
 return markdown.replace(new RegExp('([(\"])'+prefix+MEDIA_FOLDER+'/','g'),'$1/article-media/')
  .replace(/!\[\[article-media\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})(?:\|([^\]\r\n]*))?\]\]/g,(_,name,alt)=>'!['+(alt||'')+'](/article-media/'+name+')');
};
export const mediaNames=(markdown,locale='zh-CN')=>{
 const prefix=mediaPrefix(locale).replace(/\./g,'\\.');
 const paths=[...markdown.matchAll(new RegExp('[(\"]'+prefix+MEDIA_FOLDER+'/([A-Za-z0-9._-]+)','g'))].map(m=>m[1]);
 const embeds=[...markdown.matchAll(/!\[\[article-media\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})(?:\|[^\]\r\n]*)?\]\]/g)].map(m=>m[1]);
 return [...new Set([...paths,...embeds])].sort();
};
export const notePath=(articleId,locale='zh-CN')=>{
 if(typeof articleId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(articleId))throw Object.assign(Error('The Center returned an invalid work ID; local notes were kept'),{code:'invalid_work_id'});
 return WORKS_FOLDER+'/'+(checkLocale(locale)==='en'?'en/':'')+articleId+'.md';
};

/** A structured record keeps typed fields that must never be reconstructed from Markdown. */
export const isReadOnlyWork=detail=>!!detail?.data?.record;
const STRUCTURED_KINDS=new Set(['year','history','openSource']);
export const isStructuredKind=kind=>STRUCTURED_KINDS.has(kind);
/** Verify a trusted Center projection before using it with an existing local
 * structured baseline. Raw record fields are never sent back by the client. */
export function verifyStructuredDetail({work,base,detail,checkEdits=true}){
 const data=detail?.data,record=data?.record;
 if(!base?.readOnly||!isStructuredKind(work?.kind)||detail?.preservesStructuredDraftsOnSave!==true)
  throw Object.assign(Error('Structured records require a Center that confirms safe private-draft support; local edits were kept'),{code:'structured_draft_unavailable'});
 if(!record||record.kind!==work.kind||typeof record.documentId!=='string'||
  !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(record.documentId)||
  work.data.id!=='record-'+record.documentId||data.id!==work.data.id||data.sectionId!==work.data.sectionId||
  (data.locale||'zh-CN')!==work.data.locale)
  throw Object.assign(Error('The structured record identity changed; local edits were kept'),{code:'identity_conflict',conflict:true});
 if(checkEdits){
  for(const key of ['summary','author','date','category'])if(String(data[key]??'')!==work.data[key])
   throw Object.assign(Error('The '+key+' property is read-only for this structured record; local edits were kept'),{code:'structured_property_unmapped'});
  const heading=/^# ([^\r\n]+)(?:\r?\n|$)/.exec(work.data.markdown);
  if(!heading||heading[1]!==work.data.title||!work.data.title.trim()||work.data.title!==work.data.title.trim())
   throw Object.assign(Error('The first heading must exactly match the title property; local edits were kept'),{code:'structured_title_mismatch'});
 }
 return true;
}

/** The vault note for a Center work: properties, then the body exactly as the Center stores it (image paths aside). */
export function workToNote(detail,stringifyYaml){
 const data=detail.data,properties={},locale=checkLocale(data.locale||'zh-CN');
 for(const key of EDITABLE)properties[key]=String(data[key]??'');
 Object.assign(properties,{[IDENTITY.id]:data.id,[IDENTITY.sectionId]:data.sectionId,[IDENTITY.locale]:locale,
  [IDENTITY.kind]:data.record?.kind||'news',[IDENTITY.version]:detail.version,[IDENTITY.publishedVersion]:detail.publishedVersion??null});
 return {path:notePath(data.id,locale),content:'---\n'+stringifyYaml(properties).trimEnd()+'\n---\n'+toVaultMarkdown(data.markdown,locale),
  media:(data.assets||[]).map(asset=>{
   if(typeof asset?.path!=='string'||!/^\/article-media\/[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(asset.path)||typeof asset.data!=='string')
    throw Object.assign(Error('The Center returned an invalid media path; local files were kept'),{code:'invalid_media_path'});
   return {name:asset.path.slice('/article-media/'.length),data:asset.data};
  })};
}

const text=value=>value instanceof Date?value.toISOString().slice(0,10):value==null?'':String(value);
/** Reads a note back. Returns null for a file that is not an RSSD work. */
export function noteToWork(content,parseYaml){
 const match=/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
 if(!match)return null;
 let properties;try{properties=parseYaml(match[1])||{};}catch{throw Error('The note properties cannot be read; fix the YAML before syncing');}
 if(!properties[IDENTITY.id])return null;
 const body=content.slice(match[0].length),data={},locale=checkLocale(text(properties[IDENTITY.locale])||'zh-CN');
 for(const key of EDITABLE)data[key]=text(properties[key]);
 Object.assign(data,{id:text(properties[IDENTITY.id]),sectionId:text(properties[IDENTITY.sectionId]),locale,markdown:toCenterMarkdown(body,locale)});
 return {data,kind:text(properties[IDENTITY.kind])||'news',media:mediaNames(body,locale)};
}

/** Update only the top-level version scalar, preserving all other bytes.
 * Return null when the identity or YAML shape cannot be verified safely. */
export function updateNoteVersion(content,{articleId,sectionId,locale,version},parseYaml){
 if(typeof content!=='string'||!Number.isSafeInteger(version)||version<1)return null;
 const front=/^(---\r?\n)([\s\S]*?)(\r?\n---(?=\r?\n|$))/.exec(content);
 if(!front)return null;
 let props;try{props=parseYaml(front[2]);}catch{return null;}
 if(!props||typeof props!=='object'||Array.isArray(props)||text(props[IDENTITY.id])!==articleId||
  text(props[IDENTITY.sectionId])!==sectionId||(text(props[IDENTITY.locale])||'zh-CN')!==locale)return null;
 const keyLines=[...front[2].matchAll(/^rssd-version[ \t]*:/gm)];
 if(keyLines.length!==1)return null;
 const scalar=/^(rssd-version[ \t]*:[ \t]*)(?:"(\d+)"|'(\d+)'|(\d+))([ \t]*(?:#[^\r\n]*)?)(\r?)$/gm;
 const matches=[...front[2].matchAll(scalar)];if(matches.length!==1)return null;
 const match=matches[0],old=Number(match[2]??match[3]??match[4]);
 if(!Number.isSafeInteger(old)||old<0||old>version||Number(props[IDENTITY.version])!==old)return null;
 if(old===version)return {content,changed:false};
 const quote=match[2]!==undefined?'"':match[3]!==undefined?"'":'';
 const replacement=match[1]+quote+String(version)+quote+match[5]+match[6];
 const header=front[2].slice(0,match.index)+replacement+front[2].slice(match.index+match[0].length);
 return {content:front[1]+header+front[3]+content.slice(front[0].length),changed:true};
}

const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'
 ?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
/** What a person can change in a work. Equal fingerprints mean nothing to save. */
export async function workFingerprint(data,mediaPaths){
 const content={title:data.title,summary:data.summary,date:data.date,author:data.author,category:data.category,
  sectionId:data.sectionId,locale:data.locale||'zh-CN',markdown:data.markdown,media:[...mediaPaths].sort()};
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(content)));
 return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export const centerMediaPaths=data=>(data.assets||[]).map(a=>a.path);
export const localMediaPaths=names=>names.map(name=>'/article-media/'+name);

export async function mediaHash(bytes){
 const digest=await crypto.subtle.digest('SHA-256',bytes);
 return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

/** Convert referenced image bytes into content-addressed Center assets.
 * The local note is never rewritten; the returned data is a detached snapshot. */
export async function packWorkMedia(work,mediaBytes){
 if(/!\[\[[^\]]+\]\]/.test(work.data.markdown))throw Object.assign(Error('Use a Markdown image or an explicit ![[article-media/name.png]] image; this embed cannot be sent safely'),{code:'unsupported_embed'});
 for(const match of work.data.markdown.matchAll(/!\[[^\]\r\n]*\]\(([^)\r\n]+)\)/g)){
  const target=match[1].trim().split(/\s+/)[0];
  if(!/^(?:https?:\/\/|\/article-media\/)/i.test(target))
   throw Object.assign(Error('Move local images to article-media and use their relative Markdown path'),{code:'unsupported_local_image'});
 }
 if(work.media.length>12)throw Error('A work can contain at most 12 images');
 let total=0,markdown=work.data.markdown;const assets=[],seen=new Set();
 for(const name of work.media){
  const bytes=mediaBytes[name];if(!bytes)throw Error('The image '+name+' is missing from the vault');
  total+=bytes.length;if(total>2*1024*1024)throw Error('The images exceed the Center limit of 2 MiB');
  const png=bytes.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v);
  const jpg=bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  const webp=bytes.length>=12&&String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
  if(!png&&!jpg&&!webp)throw Error('The image '+name+' must be PNG, JPEG or WebP');
  const path='/article-media/'+await mediaHash(bytes)+'.'+(png?'png':jpg?'jpg':'webp');
  const escaped=name.replace(/\./g,'\\.');
  markdown=markdown.replace(new RegExp('([("])/article-media/'+escaped+'(?![A-Za-z0-9._-])','g'),(_,lead)=>lead+path);
  if(!seen.has(path)){assets.push({path,data:bytesToBase64(bytes)});seen.add(path);}
 }
 return {work:{...work,data:{...work.data,markdown}},assets};
}

/**
 * The state of one work in this space. `base` is the baseline of the last confirmed pull or save;
 * `localFingerprint` is null when the note is not in the vault.
 */
export function workState({base,localFingerprint,remote,known=true,pending=false}){
 if(localFingerprint==null)return base?'missing':'not_downloaded';
 return synchronizationState({base:base&&{fingerprint:base.fingerprint,revision:base.version},local:localFingerprint,
  remote:remote&&{version:remote.version},known,pending});
}
export const STATE_LABELS={not_downloaded:'Not downloaded',missing:'Note missing',unknown:'Not checked',unpublished:'New',
 unlinked:'Needs link',synced:'Synced',local_changed:'Local change',remote_changed:'Center newer',conflict:'Conflict',
 publishing:'Saving',staged_saved:'Private migration draft saved',invalid:'Needs check'};

const fail=message=>{throw Error(message);};
/** The exact-base private save the Center expects. Problems are reported before anything is sent. */
export function draftEnvelope({work,base,requestKey,assets,allowEmptyOptional=false,allowStructured=false}){
 const {data}=work;
 if(!base)fail('Pull this work from the Center before saving it');
 if(base.readOnly||work.kind!=='news')if(!allowStructured||!base.readOnly||!isStructuredKind(work.kind))fail('Structured records cannot be edited in Obsidian yet');
 if(data.id!==base.articleId)fail('The rssd-id property was changed; restore it before saving');
 if(data.sectionId!==base.sectionId||data.locale!==base.locale)fail('The section or language of a work cannot be changed here');
 for(const key of (allowEmptyOptional?['title']:['title','summary','author','category']))if(!data[key].trim())fail('The '+key+' property is empty');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(data.date))fail('The date property must look like 2026-11-03');
 if(!/^[a-zA-Z0-9_-]{12,128}$/.test(requestKey||''))fail('Invalid request key');
 return {requestKey,expectedVersion:base.version,expectedPublishedVersion:base.publishedVersion??null,
  data:{id:data.id,title:data.title,summary:data.summary,markdown:data.markdown,date:data.date,author:data.author,category:data.category,
   sectionId:data.sectionId,...(data.locale!=='zh-CN'?{locale:data.locale}:{}),assets}};
}

export function bytesToBase64(bytes){
 const view=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);let binary='';
 for(let i=0;i<view.length;i+=0x8000)binary+=String.fromCharCode(...view.subarray(i,i+0x8000));
 return btoa(binary);
}
export function base64ToBytes(value){
 const binary=atob(value),bytes=new Uint8Array(binary.length);
 for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
 return bytes;
}
