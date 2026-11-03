// Local path lifecycle is distinct from Center deletion. A renamed, moved, or
// locally deleted work must never be silently recreated at its old path.
// This module has no filesystem, Obsidian, or network side effects. Callers
// persist its returned records before treating an operation as complete.
import {notePath,checkLocale} from './sync-model.mjs';

const safePath=value=>typeof value==='string'&&value.length>0&&!value.startsWith('/')&&!value.includes('\\')&&!value.includes('\0')&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
const keyOf=(id,locale)=>checkLocale(locale)+'/'+id;
export function canonicalPathIdentity(path){
 if(typeof path!=='string')return null;
 const m=/^Works\/(en\/)?([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\.md$/.exec(path);
 if(!m)return null;
 const locale=m[1]?'en':'zh-CN',articleId=m[2];
 return {articleId,locale,canonicalPath:notePath(articleId,locale)};
}

function identityForCurrentPath(records,path){
 const matches=Object.values(records||{}).filter(r=>r?.currentPath===path);
 if(matches.length>1)throw Object.assign(Error('More than one tracked work claims this path'),{code:'identity_conflict'});
 if(matches.length===1)return {articleId:matches[0].articleId,locale:matches[0].locale,canonicalPath:matches[0].canonicalPath};
 const identity=canonicalPathIdentity(path);if(!identity)return null;
 const prior=records?.[keyOf(identity.articleId,identity.locale)];
 if(prior&&prior.currentPath!==path)throw Object.assign(Error('A moved work and another file claim the same original path'),{code:'identity_conflict'});
 return identity;
}

/** Track a rename of a canonical or already tracked note. A return to the
 * canonical path stays quarantined until its frontmatter identity is checked. */
export function trackRename(records,oldPath,newPath){
 if(!safePath(oldPath)||!safePath(newPath))throw Error('Unsafe local path');
 const identity=identityForCurrentPath(records,oldPath);if(!identity)return {...records};
 const key=keyOf(identity.articleId,identity.locale);
 return {...records,[key]:{...identity,currentPath:newPath,state:newPath===identity.canonicalPath?'verify_return':'moved'}};
}

/** Track removal locally only; this deliberately never requests Center deletion. */
export function trackDelete(records,path){
 if(!safePath(path))throw Error('Unsafe local path');
 const identity=identityForCurrentPath(records,path);if(!identity)return {...records};
 return {...records,[keyOf(identity.articleId,identity.locale)]:{...identity,currentPath:null,state:'missing'}};
}

/** Clear quarantine only after reading the returned file and checking its
 * actual RSSD id and locale. Subsequent content/version checks still apply. */
export function confirmReturn(records,{articleId,locale,path,observedArticleId,observedLocale}={}){
 checkLocale(locale);const canonicalPath=notePath(articleId,locale),key=keyOf(articleId,locale),entry=records?.[key];
 if(!entry||path!==canonicalPath||observedArticleId!==articleId||observedLocale!==locale)throw Object.assign(Error('The returned work identity cannot be verified'),{code:'identity_conflict'});
 const next={...records};delete next[key];return next;
}

/** A baseline plus a missing local file may mean offline rename/delete, so a
 * normal pull must report it instead of recreating it without the user's choice. */
export function checkCanonicalPull({articleId,locale,hasBaseline,canonicalExists,records={}}){
 const canonicalPath=notePath(articleId,locale),entry=records[keyOf(articleId,locale)];
 if(entry)return {allowed:false,code:entry.state==='missing'?'local_work_missing':'local_work_moved',canonicalPath,currentPath:entry.currentPath??null};
 if(hasBaseline&&!canonicalExists)return {allowed:false,code:'local_work_missing',canonicalPath,currentPath:null};
 return {allowed:true,canonicalPath};
}
