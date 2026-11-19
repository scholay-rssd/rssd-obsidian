// The website side of each work, for a vault whose key includes RSSD Center: the newest publication of each work
// and language, read from the Center's /publications (newest first). Pure, so it is tested without Obsidian.

const site=row=>typeof row?.destinationId==='string'&&row.destinationId.startsWith('site-');
const clean=text=>String(text??'').replace(/rssd_device_[A-Za-z0-9_-]+/g,'[redacted]').replace(/\s+/g,' ').trim().slice(0,200);

/**
 * The newest website publication per work and language, as {byWork: {"<workId>|<locale>": entry}, byTitle:
 * {"<locale>|<title>": entry or null when two works share the title}}. An entry is {state, revision, error, at}.
 */
export function latestPublications(rows){
 const byWork={},byTitle={},taken=new Set();
 for(const row of Array.isArray(rows)?rows:[]){
  if(!site(row)||typeof row.workId!=='string')continue;
  const key=row.workId+'|'+(row.locale||'zh-CN');if(taken.has(key))continue;taken.add(key);
  const entry={state:String(row.state||''),revision:Number(row.revision)||0,error:clean(row.error?.message??row.error),at:String(row.updatedAt||row.createdAt||'')};
  if(!entry.error)delete entry.error;
  byWork[key]=entry;
  const title=String(row.title||'').trim();
  if(title){const t=(row.locale||'zh-CN')+'|'+title;byTitle[t]=Object.hasOwn(byTitle,t)&&byTitle[t]!==entry?null:entry;}
 }
 return {byWork,byTitle};
}

/** The publication of one work: by its Center work ID when the vault knows it, else by a title only it has. */
export function publicationOf(state,{workId,locale='zh-CN',title}={}){
 if(!state)return null;
 if(workId&&state.byWork?.[workId+'|'+locale])return state.byWork[workId+'|'+locale];
 return state.byTitle?.[locale+'|'+String(title||'').trim()]||null;
}
