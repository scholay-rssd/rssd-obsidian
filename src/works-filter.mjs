// What the Works list shows, as one plain value, and the rules that apply it. Pure, so the filter panel, the
// filter button, the chips under the search box and the tests share one definition.
//
// A filter has independent facets. Within a facet several values may be chosen and any of them matches; an empty
// facet does not narrow the list. Across facets every one must match. A new facet is a field here, a rule in
// `matches`, a count in `facetCounts` and a chip in `activeChips`.

export const STATUSES=Object.freeze(['all','edited','check']);
export const LOCALES=Object.freeze(['zh-CN','en']);
/** The writer value for a work whose writer the Center has no record of (or that has not been read yet). */
export const NO_WRITER='';
const DATE=/^\d{4}-\d{2}-\d{2}$/;

export function emptyFilter(locale='zh-CN'){return {status:'all',locale,sections:[],writers:[],from:'',to:''};}

/** A filter read back from storage or built by the panel: anything unknown or malformed falls back to "all". */
export function normalizeFilter(value){
 const base=emptyFilter(),v=value&&typeof value==='object'?value:{};
 const list=items=>Array.isArray(items)?[...new Set(items.filter(item=>typeof item==='string'))]:[];
 let from=DATE.test(v.from)?v.from:'',to=DATE.test(v.to)?v.to:'';
 if(from&&to&&from>to)[from,to]=[to,from];
 return {status:STATUSES.includes(v.status)?v.status:base.status,locale:LOCALES.includes(v.locale)?v.locale:base.locale,
  sections:list(v.sections),writers:list(v.writers),from,to};
}

const localeOf=work=>work.locale==='en'?'en':'zh-CN';
const dayOf=work=>String(work.date??'').slice(0,10);
/** A work's writer label for filtering: the label, or NO_WRITER when there is none or it is not known yet. */
const writerValue=label=>typeof label==='string'&&label?label:NO_WRITER;
const statusMatches=(status,work,state)=>status==='all'||
 status==='edited'&&['edited','saving','conflict'].includes(state)||
 status==='check'&&(!String(work.author??'').trim()||!String(work.category??'').trim());

/**
 * Whether one work is listed. `state` is its local sync state, `writer` its writer label (null or undefined
 * when unknown), `query` the search text. `skip` names a facet to leave out, for counting that facet's options.
 */
export function matches(work,filter,{state,writer,query=''}={},skip=''){
 const q=String(query).trim().toLowerCase();
 if(q&&![work.title,work.summary].some(text=>String(text??'').toLowerCase().includes(q)))return false;
 if(skip!=='locale'&&localeOf(work)!==filter.locale)return false;
 if(skip!=='status'&&!statusMatches(filter.status,work,state))return false;
 if(skip!=='sections'&&filter.sections.length&&!filter.sections.includes(work.section||''))return false;
 if(skip!=='writers'&&filter.writers.length&&!filter.writers.includes(writerValue(writer)))return false;
 if(skip!=='dates'&&(filter.from||filter.to)){
  const day=dayOf(work);
  if(!DATE.test(day)||filter.from&&day<filter.from||filter.to&&day>filter.to)return false;
 }
 return true;
}

/**
 * How many works each option would list, counted the usual faceted way: every other facet applies, this one does
 * not. `context(work)` returns {state, writer}. Writers and sections come back as Maps of value → count.
 */
export function facetCounts(works,filter,context,query=''){
 const counts={status:{all:0,edited:0,check:0},locale:{'zh-CN':0,en:0},sections:new Map(),writers:new Map(),dates:0};
 const add=(map,key)=>map.set(key,(map.get(key)||0)+1);
 for(const work of works){
  const c={...context(work),query};
  if(matches(work,filter,c,'status'))for(const status of STATUSES)if(statusMatches(status,work,c.state))counts.status[status]++;
  if(matches(work,filter,c,'locale'))counts.locale[localeOf(work)]++;
  if(matches(work,filter,c,'sections'))add(counts.sections,work.section||'');
  if(matches(work,filter,c,'writers'))add(counts.writers,writerValue(c.writer));
  if(matches(work,filter,c))counts.dates++;
 }
 return counts;
}

/** How many facets narrow the list (the language is a choice of list, not a narrowing). */
export const narrowedBy=filter=>(filter.status!=='all')+(filter.sections.length>0)+(filter.writers.length>0)+(!!(filter.from||filter.to));

/** One removable chip per chosen value, in the panel's order. `sectionName(id)` names a section. */
export function activeChips(filter,{sectionName=id=>id}={}){
 const chips=[];
 if(filter.status!=='all')chips.push({facet:'status',value:filter.status,text:filter.status==='edited'?'Edited':'To check'});
 for(const id of filter.sections)chips.push({facet:'sections',value:id,text:sectionName(id)||'No section'});
 for(const label of filter.writers)chips.push({facet:'writers',value:label,text:label||'Writer not recorded'});
 if(filter.from||filter.to)chips.push({facet:'dates',value:'',text:dateRangeText(filter.from,filter.to)});
 return chips;
}
/** The filter without one chip's value. */
export function withoutChip(filter,{facet,value}){
 const next=normalizeFilter(filter);
 if(facet==='status')next.status='all';
 else if(facet==='dates'){next.from='';next.to='';}
 else if(facet==='sections'||facet==='writers')next[facet]=next[facet].filter(item=>item!==value);
 return next;
}
/** The filter with one value of a multi-choice facet turned on or off. */
export function toggled(filter,facet,value){
 const next=normalizeFilter(filter),list=next[facet];
 next[facet]=list.includes(value)?list.filter(item=>item!==value):[...list,value];
 return next;
}

const short=day=>day.slice(5);
export function dateRangeText(from,to){
 if(from&&to)return from===to?short(from):short(from)+' – '+short(to);
 return from?'From '+short(from):to?'Until '+short(to):'Any date';
}
const iso=date=>date.toISOString().slice(0,10);
/** Quick date ranges ending today (in UTC dates, like the works' own dates): the last 7 or 30 days, or this month. */
export function datePreset(id,today=new Date()){
 const day=new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),today.getUTCDate()));
 const back=days=>{const start=new Date(day);start.setUTCDate(start.getUTCDate()-(days-1));return {from:iso(start),to:iso(day)};};
 if(id==='7d')return back(7);
 if(id==='30d')return back(30);
 if(id==='month')return {from:iso(new Date(Date.UTC(day.getUTCFullYear(),day.getUTCMonth(),1))),to:iso(day)};
 return {from:'',to:''};
}
