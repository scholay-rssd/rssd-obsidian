// How a Center work becomes a vault note and back, and what state each work is in. Pure: YAML, hashing and
// file access are passed in, so the same rules run in tests, on desktop and on mobile.
// A note is identified by its `rssd-id` property, never by its file name or folder.
import {synchronizationState} from '../../contracts/sync-state.mjs';
import {CHOSEN_WORK_TYPES,validateWorkTags,validateAdaptedFrom,workTypeLabel} from '../../contracts/work-types.mjs';

export const WORKS_FOLDER='Works';
export const MEDIA_FOLDER='article-media';
// Editable properties, in the order they are written. Identity properties are prefixed and must not change.
const EDITABLE=['title','summary','date','author','category'];
const IDENTITY={id:'rssd-id',sectionId:'rssd-section',locale:'rssd-locale',kind:'rssd-kind',version:'rssd-version',publishedVersion:'rssd-published-version'};
// A work's own fields (contracts/work-types.mjs): its type, for a note the long article it was rewritten from (a link
// to that article's note plus the revision it was written from) and its #tags. They are written only when the
// Center states them and read back only when the note states them, so a note without them keeps the fingerprint
// it always had. The type and tags are the writer's (Details edits them); the source link is set when the note is made.
export const WORK_FIELDS=Object.freeze({workType:'rssd-type',adaptedFrom:'rssd-adapted-from',adaptedRevision:'rssd-adapted-revision',tags:'rssd-tags'});

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
 if(typeof data.workType==='string'&&data.workType)properties[WORK_FIELDS.workType]=data.workType;
 if(data.adaptedFrom&&typeof data.adaptedFrom==='object'){properties[WORK_FIELDS.adaptedFrom]=sourceLink(data.adaptedFrom.articleId);properties[WORK_FIELDS.adaptedRevision]=data.adaptedFrom.revision;}
 if(Array.isArray(data.tags)&&data.tags.length)properties[WORK_FIELDS.tags]=data.tags.map(String);
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
 Object.assign(data,{id:text(properties[IDENTITY.id]),sectionId:text(properties[IDENTITY.sectionId]),locale,markdown:toCenterMarkdown(body,locale)},readWorkFields(properties));
 return {data,kind:text(properties[IDENTITY.kind])||'news',media:mediaNames(body,locale)};
}

/** The property that links a note to the long article it was rewritten from: a link to that article's note. */
export const sourceLink=articleId=>'[['+WORKS_FOLDER+'/'+articleId+']]';
/** The article ID in a source link (`[[Works/<id>]]`, with or without `.md` or a label) or a bare ID; anything else as written. */
export function sourceId(value){
 // Unquoted in YAML, [[Works/x]] reads as a list holding a list.
 if(Array.isArray(value)&&value.length===1&&Array.isArray(value[0])&&value[0].length===1)value='[['+value[0][0]+']]';
 const raw=text(value).trim(),link=/^\[\[(?:Works\/)?([^\]|#]+?)(?:\.md)?(?:\|[^\]]*)?\]\]$/.exec(raw);
 return link?link[1]:raw;
}
/** #tags as a writer may type them: trimmed, without the leading #, each once. Length and count are checked on save. */
export function normalizeTags(value){
 const list=value==null?[]:Array.isArray(value)?value:[value];
 return [...new Set(list.map(tag=>text(tag).trim().replace(/^#+/,'').trim()).filter(Boolean))];
}
/** The work fields a note states. An absent property is not stated; an emptied list of tags or source link is (it clears). */
function readWorkFields(properties){
 const fields={},has=key=>Object.prototype.hasOwnProperty.call(properties,key);
 const type=has(WORK_FIELDS.workType)?text(properties[WORK_FIELDS.workType]).trim():'';
 if(type)fields.workType=type;
 if(has(WORK_FIELDS.adaptedFrom)){
  const link=properties[WORK_FIELDS.adaptedFrom],revision=properties[WORK_FIELDS.adaptedRevision];
  fields.adaptedFrom=link==null||text(link).trim()===''?null:{articleId:sourceId(link),revision:typeof revision==='number'?revision:/^\d+$/.test(text(revision).trim())?Number(text(revision).trim()):NaN};
 }
 if(has(WORK_FIELDS.tags))fields.tags=normalizeTags(properties[WORK_FIELDS.tags]);
 return fields;
}
const sameValue=(a,b)=>canonical(a??null)===canonical(b??null);
/**
 * Which work fields a save sends, given the note's (`data`) and the Center's current values (`current`, the detail
 * data the save was checked against). Only a stated field that differs is sent: omitted, the Center keeps its value,
 * and an emptied list of tags or source link clears it. A Center without `work-types-v1` (`capable` false) gets
 * nothing new, so a note that asks for a note type, tags or a source link is refused there instead of losing them.
 * `policy` is the section's (sectionWorkPolicy): a new type must be one the section takes. `staged` drafts keep
 * their edition's values, so any change is refused before anything is sent. Throws with a code; returns the fields.
 */
export function workFieldChanges({data,current={},kind='news',capable=false,policy=null,staged=false}){
 const stated=['workType','adaptedFrom','tags'].filter(key=>data[key]!==undefined);
 // A calendar entry, historical event or resource keeps the type its record kind fixes.
 if(kind!=='news'&&(data.workType!==undefined||data.adaptedFrom))throw Object.assign(Error('A structured record keeps the type of its record kind; remove rssd-type and the source link. Local edits were kept'),{code:'invalid_work_type'});
 if(!capable){
  const asks=data.workType!==undefined&&data.workType!=='article'||data.adaptedFrom||data.tags?.length;
  if(asks)throw Object.assign(Error('This Center does not keep work types, source articles or tags yet; local edits were kept. Update the Center or remove them before saving'),{code:'work_types_unavailable'});
  return {};
 }
 const type=data.workType!==undefined?data.workType:current.workType,changes={};
 for(const key of stated){
  const value=key==='tags'?data.tags:data[key],now=key==='tags'?current.tags||[]:current[key];
  // A long article has no source link; the Center drops it when a note becomes an article.
  if(key==='adaptedFrom'&&type!=='note')continue;
  if(!sameValue(value,now))changes[key]=value;
 }
 if(staged&&Object.keys(changes).length)throw Object.assign(Error('A migration draft keeps the type, source article and tags of its edition; local edits were kept. Change them once the space is active'),{code:'staged_work_fields'});
 if(changes.workType!==undefined){
  if(!CHOSEN_WORK_TYPES.includes(changes.workType))throw Object.assign(Error('rssd-type must be '+CHOSEN_WORK_TYPES.join(' or ')+'; local edits were kept'),{code:'invalid_work_type'});
  if(policy&&!policy.workTypes.includes(changes.workType))throw Object.assign(Error('This section does not take '+workTypeLabel(changes.workType,'en').toLowerCase()+'s; local edits were kept'),{code:'invalid_work_type'});
 }
 const fail=error=>{throw Object.assign(Error(error.message+'; local edits were kept'),{code:'invalid_work_fields'});};
 if(changes.adaptedFrom)try{changes.adaptedFrom=validateAdaptedFrom(changes.adaptedFrom,{type:'note',articleId:data.id});}catch(error){fail(error);}
 if(changes.tags)try{validateWorkTags(changes.tags);}catch(error){fail(error);}
 return changes;
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
/** What the sync compares: the work's content plus the work fields the note states. Without any it equals
 * workFingerprint, so baselines recorded before work types still match. Outputs keep workFingerprint. */
export async function syncFingerprint(data,mediaPaths){
 const fields=Object.fromEntries(['workType','adaptedFrom','tags'].filter(key=>data[key]!==undefined).map(key=>[key,data[key]]));
 if(!Object.keys(fields).length)return workFingerprint(data,mediaPaths);
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical({content:await workFingerprint(data,mediaPaths),fields})));
 return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export const centerMediaPaths=data=>(data.assets||[]).map(a=>a.path);
export const localMediaPaths=names=>names.map(name=>'/article-media/'+name);

export async function mediaHash(bytes){
 const digest=await crypto.subtle.digest('SHA-256',bytes);
 return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

/** Convert referenced image bytes into content-addressed Center assets.
 * The local note is never rewritten; the returned data is a detached snapshot.
 * `stored` holds the paths of images the Center already keeps with the base edition (when it accepts them by
 * path): those go as {path} without their bytes, and only the rest count toward the 2 MiB. */
export const MEDIA_LIMIT_BYTES=2*1024*1024;
export async function packWorkMedia(work,mediaBytes,{stored=new Set()}={}){
 if(/!\[\[[^\]]+\]\]/.test(work.data.markdown))throw Object.assign(Error('Use a Markdown image or an explicit ![[article-media/name.png]] image; this embed cannot be sent safely'),{code:'unsupported_embed'});
 for(const match of work.data.markdown.matchAll(/!\[[^\]\r\n]*\]\(([^)\r\n]+)\)/g)){
  const target=match[1].trim().split(/\s+/)[0];
  if(!/^(?:https?:\/\/|\/article-media\/)/i.test(target))
   throw Object.assign(Error('Move local images to article-media and use their relative Markdown path'),{code:'unsupported_local_image'});
 }
 if(work.media.length>12)throw Object.assign(Error('A work can contain at most 12 images; this one has '+work.media.length),{code:'too_many_media'});
 let total=0,markdown=work.data.markdown;const assets=[],seen=new Set(),sent=[];
 for(const name of work.media){
  const bytes=mediaBytes[name];if(!bytes)throw Object.assign(Error('The image '+name+' is missing from the vault'),{code:'media_missing'});
  const png=bytes.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v);
  const jpg=bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  const webp=bytes.length>=12&&String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
  if(!png&&!jpg&&!webp)throw Object.assign(Error('The image '+name+' must be PNG, JPEG or WebP'),{code:'unsupported_media'});
  const path='/article-media/'+await mediaHash(bytes)+'.'+(png?'png':jpg?'jpg':'webp');
  const escaped=name.replace(/\./g,'\\.');
  markdown=markdown.replace(new RegExp('([("])/article-media/'+escaped+'(?![A-Za-z0-9._-])','g'),(_,lead)=>lead+path);
  if(seen.has(path))continue;
  seen.add(path);
  if(stored.has(path)){assets.push({path});continue;}
  assets.push({path,data:bytesToBase64(bytes)});total+=bytes.length;sent.push([name,bytes.length]);
 }
 if(total>MEDIA_LIMIT_BYTES){
  const mb=n=>(n/1024/1024).toFixed(1)+' MB';
  throw Object.assign(Error('The images to send add up to '+mb(total)+', over the Center limit of 2 MiB per save ('+sent.map(([name,size])=>name+' '+mb(size)).join(', ')+'). Make them smaller'+(stored.size?'':', or update the Center so it can keep pictures it already has')+'.'),{code:'media_too_large'});
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
export function draftEnvelope({work,base,requestKey,assets,allowEmptyOptional=false,allowStructured=false,privateAppend=null,workFields={}}){
 const {data}=work;
 if(!base)fail('Update this work from the Center before saving it');
 if(base.readOnly||work.kind!=='news')if(!allowStructured||!base.readOnly||!isStructuredKind(work.kind))fail('Structured records cannot be edited in Obsidian yet');
 if(data.id!==base.articleId)fail('The rssd-id property was changed; restore it before saving');
 if(data.sectionId!==base.sectionId||data.locale!==base.locale)fail('The section or language of a work cannot be changed here');
 for(const key of (allowEmptyOptional?['title']:['title','summary','author','category']))if(!data[key].trim())fail('The '+key+' property is empty');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(data.date))fail('The date property must look like 2026-11-03');
 if(!/^[a-zA-Z0-9_-]{12,128}$/.test(requestKey||''))fail('Invalid request key');
 return {requestKey,expectedVersion:base.version,expectedPublishedVersion:base.publishedVersion??null,
  data:{id:data.id,title:data.title,summary:data.summary,markdown:data.markdown,date:data.date,author:data.author,category:data.category,
   sectionId:data.sectionId,...(data.locale!=='zh-CN'?{locale:data.locale}:{}),assets,...(privateAppend?{privateAppend}:{}),...workFields}};
}

/** Where a work's pending private record waits for its next save (for example who drew its pictures). Hidden from the vault. */
export const privateAdditionPath=(id,locale)=>'.rssd/private-additions/'+id+'.'+(locale||'zh-CN')+'.json';
/** A private addition: completed runs and appended internal notes only. Anything else is refused, not sent. */
export function parsePrivateAddition(text){
 if(text==null)return null;let value;try{value=JSON.parse(text);}catch{fail('The private record waiting for this work is not valid JSON');}
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['modelSignatures','internalNotes'].includes(key)))fail('The private record waiting for this work has unknown fields');
 if(value.modelSignatures!==undefined&&(!Array.isArray(value.modelSignatures)||value.modelSignatures.some(run=>!run||run.status!=='completed'||typeof run.runId!=='string')))fail('The private record waiting for this work has an unfinished run');
 return value;
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
