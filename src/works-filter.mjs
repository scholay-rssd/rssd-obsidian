// What the Works list shows, as one plain value, and the rules that apply it. Pure, so the filter panel, the
// filter button, the chips under the search box and the tests share one definition.
//
// A filter has independent facets. Within a facet several values may be chosen and any of them matches; an empty
// facet does not narrow the list. Across facets every one must match. A new facet is a field here, a rule in
// `matches`, a count in `facetCounts` and a chip in `activeChips`.

export const STATUSES=Object.freeze(['all','edited','check']);
export const LOCALES=Object.freeze(['zh-CN','en']);
/**
 * Where a work stands, from idea to website: a topic still to be written (the demand pool), a draft (never published,
 * or newer than the website), or published. Topics and works share one list; this facet chooses which are shown.
 */
export const STAGES=Object.freeze(['topic','draft','published']);
export const DEFAULT_STAGES=Object.freeze(['draft','published']);
export const STAGE_LABELS=Object.freeze({topic:'选题',draft:'草稿',published:'已发布'});
/** A work's stage from its draft and published versions; a topic is always 'topic'. */
export const stageOf=work=>work?.kind==='topic'?'topic':(Number(work?.publishedVersion)||0)>0&&(Number(work?.version)||0)<=(Number(work?.publishedVersion)||0)?'published':'draft';
export const CARD_VARIANTS=Object.freeze({'ai-image':'模型生图','ai-code':'智能排版'});
/** The agent or model value for a work whose writer the Center has no record of (or that is not read yet). */
export const NO_WRITER='';
const DATE=/^\d{4}-\d{2}-\d{2}$/;

export function emptyFilter(locale='zh-CN'){return {stages:[...DEFAULT_STAGES],status:'all',locale,cardVariants:[],spaces:[],sections:[],agents:[],models:[],machines:[],from:'',to:''};}

/** A filter read back from storage or built by the panel: anything unknown or malformed falls back to "all". */
export function normalizeFilter(value){
 const base=emptyFilter(),v=value&&typeof value==='object'?value:{};
 const list=items=>Array.isArray(items)?[...new Set(items.filter(item=>typeof item==='string'))]:[];
 let from=DATE.test(v.from)?v.from:'',to=DATE.test(v.to)?v.to:'';
 if(from&&to&&from>to)[from,to]=[to,from];
 // A filter kept by an earlier version has no stages: it shows works, as it did.
 const stages=Array.isArray(v.stages)?list(v.stages).filter(id=>STAGES.includes(id)):[...DEFAULT_STAGES];
 return {stages,status:STATUSES.includes(v.status)?v.status:base.status,locale:LOCALES.includes(v.locale)?v.locale:base.locale,
  cardVariants:list(v.cardVariants).filter(id=>Object.hasOwn(CARD_VARIANTS,id)),
  spaces:list(v.spaces),sections:list(v.sections),agents:list(v.agents),models:list(v.models),machines:list(v.machines),from,to};
}

const localeOf=work=>work.locale==='en'?'en':'zh-CN';
const dayOf=work=>String(work.date??'').slice(0,10);
/** A work's agent or model for filtering, or NO_WRITER when there is none or it is not known yet. */
const agentOf=writer=>typeof writer?.agent==='string'&&writer.agent?writer.agent:NO_WRITER;
const modelOf=writer=>typeof writer?.model==='string'&&writer.model?writer.model:NO_WRITER;
const machineOf=writer=>typeof writer?.machine==='string'&&writer.machine?writer.machine:NO_WRITER;
const statusMatches=(status,work,state)=>status==='all'||
 status==='edited'&&['edited','saving','conflict'].includes(state)||
 status==='check'&&(!String(work.author??'').trim()||!String(work.category??'').trim());

/**
 * Whether one work is listed. `state` is its local sync state, `writer` its {agent, model, machine} (null or undefined
 * when unknown), `query` the search text. `skip` names a facet to leave out, for counting that facet's options.
 */
export function matches(work,filter,{state,writer,query=''}={},skip=''){
 const q=String(query).trim().toLowerCase();
 if(q&&![work.title,work.summary].some(text=>String(text??'').toLowerCase().includes(q)))return false;
 if(skip!=='stages'&&filter.stages.length&&!filter.stages.includes(stageOf(work)))return false;
 if(skip!=='locale'&&localeOf(work)!==filter.locale)return false;
 if(skip!=='status'&&!statusMatches(filter.status,work,state))return false;
 if(skip!=='cardVariants'&&filter.cardVariants.length&&!work.cardVariants?.some(id=>filter.cardVariants.includes(id)))return false;
 // A vault of several spaces: `space` is the work's space, and `section` is unique across spaces.
 if(skip!=='spaces'&&filter.spaces.length&&!filter.spaces.includes(work.space||''))return false;
 if(skip!=='sections'&&filter.sections.length&&!filter.sections.includes(work.section||''))return false;
 if(skip!=='agents'&&filter.agents.length&&!filter.agents.includes(agentOf(writer)))return false;
 if(skip!=='models'&&filter.models.length&&!filter.models.includes(modelOf(writer)))return false;
 if(skip!=='machines'&&filter.machines.length&&!filter.machines.includes(machineOf(writer)))return false;
 if(skip!=='dates'&&(filter.from||filter.to)){
  const day=dayOf(work);
  if(!DATE.test(day)||filter.from&&day<filter.from||filter.to&&day>filter.to)return false;
 }
 return true;
}

/**
 * How many works each option would list, counted the usual faceted way: every other facet applies, this one does
 * not. `context(work)` returns {state, writer}. Sections, agents, models and machines come back as Maps of value → count.
 */
export function facetCounts(works,filter,context,query=''){
 const counts={stages:{topic:0,draft:0,published:0},status:{all:0,edited:0,check:0},locale:{'zh-CN':0,en:0},cardVariants:new Map(),spaces:new Map(),sections:new Map(),agents:new Map(),models:new Map(),machines:new Map(),dates:0};
 const add=(map,key)=>map.set(key,(map.get(key)||0)+1);
 for(const work of works){
  const c={...context(work),query};
  if(matches(work,filter,c,'stages'))counts.stages[stageOf(work)]++;
  if(matches(work,filter,c,'status'))for(const status of STATUSES)if(statusMatches(status,work,c.state))counts.status[status]++;
  if(matches(work,filter,c,'locale'))counts.locale[localeOf(work)]++;
  if(matches(work,filter,c,'cardVariants'))for(const id of work.cardVariants||[])add(counts.cardVariants,id);
  if(matches(work,filter,c,'spaces'))add(counts.spaces,work.space||'');
  if(matches(work,filter,c,'sections'))add(counts.sections,work.section||'');
  if(matches(work,filter,c,'agents'))add(counts.agents,agentOf(c.writer));
  if(matches(work,filter,c,'models'))add(counts.models,modelOf(c.writer));
  if(matches(work,filter,c,'machines'))add(counts.machines,machineOf(c.writer));
  if(matches(work,filter,c))counts.dates++;
 }
 return counts;
}

/** How many facets narrow the list (the language is a choice of list, not a narrowing). */
export const narrowedBy=filter=>(filter.stages.length!==DEFAULT_STAGES.length||filter.stages.some(id=>!DEFAULT_STAGES.includes(id)))+(filter.status!=='all')+(filter.cardVariants.length>0)+(filter.spaces.length>0)+(filter.sections.length>0)+(filter.agents.length>0)+(filter.models.length>0)+(filter.machines.length>0)+(!!(filter.from||filter.to));

/** One removable chip per chosen value, in the panel's order. `sectionName(id)` names a section, `spaceName(id)` a space. */
export function activeChips(filter,{sectionName=id=>id,spaceName=id=>id}={}){
 const chips=[];
 if(narrowedBy({...filter,status:'all',cardVariants:[],spaces:[],sections:[],agents:[],models:[],machines:[],from:'',to:''}))for(const id of filter.stages)chips.push({facet:'stages',value:id,text:STAGE_LABELS[id]});
 if(filter.status!=='all')chips.push({facet:'status',value:filter.status,text:filter.status==='edited'?'Edited':'To check'});
 for(const id of filter.cardVariants)chips.push({facet:'cardVariants',value:id,text:CARD_VARIANTS[id]});
 for(const id of filter.spaces)chips.push({facet:'spaces',value:id,text:spaceName(id)||id});
 for(const id of filter.sections)chips.push({facet:'sections',value:id,text:sectionName(id)||'No section'});
 for(const agent of filter.agents)chips.push({facet:'agents',value:agent,text:agent||'No agent recorded'});
 for(const model of filter.models)chips.push({facet:'models',value:model,text:model||'No model recorded'});
 for(const machine of filter.machines)chips.push({facet:'machines',value:machine,text:machine||'No machine recorded'});
 if(filter.from||filter.to)chips.push({facet:'dates',value:'',text:dateRangeText(filter.from,filter.to)});
 return chips;
}
/** The filter without one chip's value. */
export function withoutChip(filter,{facet,value}){
 const next=normalizeFilter(filter);
 if(facet==='status')next.status='all';
 else if(facet==='dates'){next.from='';next.to='';}
 else if(['stages','cardVariants','spaces','sections','agents','models','machines'].includes(facet))next[facet]=next[facet].filter(item=>item!==value);
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
