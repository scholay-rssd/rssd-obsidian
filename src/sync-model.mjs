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
 return markdown.replace(new RegExp('([(\"])'+prefix+MEDIA_FOLDER+'/','g'),'$1/article-media/');
};
export const mediaNames=(markdown,locale='zh-CN')=>{
 const prefix=mediaPrefix(locale).replace(/\./g,'\\.');
 return [...new Set([...markdown.matchAll(new RegExp('[(\"]'+prefix+MEDIA_FOLDER+'/([A-Za-z0-9._-]+)','g'))].map(m=>m[1]))].sort();
};
export const notePath=(articleId,locale='zh-CN')=>WORKS_FOLDER+'/'+(checkLocale(locale)==='en'?'en/':'')+articleId+'.md';

/** A structured record (notice, history, resource) keeps typed fields the plugin cannot edit yet. */
export const isReadOnlyWork=detail=>!!detail?.data?.record;

/** The vault note for a Center work: properties, then the body exactly as the Center stores it (image paths aside). */
export function workToNote(detail,stringifyYaml){
 const data=detail.data,properties={},locale=checkLocale(data.locale||'zh-CN');
 for(const key of EDITABLE)properties[key]=String(data[key]??'');
 Object.assign(properties,{[IDENTITY.id]:data.id,[IDENTITY.sectionId]:data.sectionId,[IDENTITY.locale]:locale,
  [IDENTITY.kind]:data.record?.kind||'news',[IDENTITY.version]:detail.version,[IDENTITY.publishedVersion]:detail.publishedVersion??null});
 return {path:notePath(data.id,locale),content:'---\n'+stringifyYaml(properties).trimEnd()+'\n---\n'+toVaultMarkdown(data.markdown,locale),
  media:(data.assets||[]).map(asset=>({name:asset.path.replace(/^\/article-media\//,''),data:asset.data}))};
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
 publishing:'Saving',invalid:'Needs check'};

const fail=message=>{throw Error(message);};
/** The exact-base private save the Center expects. Problems are reported before anything is sent. */
export function draftEnvelope({work,base,requestKey,assets}){
 const {data}=work;
 if(!base)fail('Pull this work from the Center before saving it');
 if(base.readOnly||work.kind!=='news')fail('Structured records cannot be edited in Obsidian yet');
 if(data.id!==base.articleId)fail('The rssd-id property was changed; restore it before saving');
 if(data.sectionId!==base.sectionId||data.locale!==base.locale)fail('The section or language of a work cannot be changed here');
 for(const key of ['title','summary','author','category'])if(!data[key].trim())fail('The '+key+' property is empty');
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
