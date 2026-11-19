// The topic pool: how a queued write demand of the Center becomes a vault note and back. Pure: YAML and hashing
// are passed in or built in, so the same rules run in tests, on desktop and on mobile.
//
// A pool vault shows the write demands of every space this device is authorized for, one note per topic. A topic
// is identified by its `rssd-demand` property, never by its file name or folder, so a note may be renamed or
// moved. What can be edited is the topic itself (title, brief, priority, work type, topic key, due date), and
// only while nobody has claimed it. Everything prefixed `rssd-` is the Center's and is written back on update.

export const POOL_FOLDER='Topics';
/** Work types a topic may ask for; the Center checks them again. */
export const TOPIC_WORK_TYPES=Object.freeze(['article','note']);
const IDENTITY={id:'rssd-demand',space:'rssd-space',section:'rssd-section',state:'rssd-state',generation:'rssd-generation',
 claimedBy:'rssd-claimed-by',work:'rssd-work',lead:'rssd-lead',updated:'rssd-updated'};
export const TOPIC_STATE_LABELS=Object.freeze({queued:'待认领',claimed:'已认领',blocked:'受阻',completed:'已完成',cancelled:'已撤回'});

const text=value=>value instanceof Date?value.toISOString():value==null?'':String(value);
const clean=value=>text(value).normalize('NFC').replace(/[\u0000-\u001f\u007f]/g,' ').trim();

/** A file or folder name made from a title or a name: no path separators or characters a file system refuses. */
export function safeName(value,fallback='untitled'){
 const name=clean(value).replace(/[\\/:*?"<>|#^\[\]]/g,' ').replace(/\s+/g,' ').replace(/^\.+/,'').trim().slice(0,80).trim();
 return name||fallback;
}

/**
 * The folder of a section's topics: Topics/<space>/<section> in a topic pool vault, or Topics/<section> inside a
 * site's folder (`flat`), where the folder already says which space. By display name when the registry gives one.
 */
export function sectionFolder(registry,workspaceId,sectionId,{flat=false}={}){
 const space=(registry?.workspaces||[]).find(w=>w.id===workspaceId),section=(space?.sections||[]).find(s=>s.id===sectionId);
 return POOL_FOLDER+'/'+(flat?'':safeName(space?.name,workspaceId)+'/')+safeName(section?.name,sectionId);
}

/**
 * Which space and section a new note belongs to. Its own `rssd-space` and `rssd-section` properties win; otherwise
 * its folder decides: Topics/<space>/<section>/…, each matched by ID or display name. Returns null when the note
 * does not sit in one section of an authorized space, so nothing is queued in the wrong place by guessing.
 */
export function topicScope(path,properties,registry,{space:fixed=''}={}){
 const spaces=registry?.workspaces||[],parts=String(path||'').split('/');
 const find=(list,key)=>{const wanted=clean(key);if(!wanted)return null;const hits=(list||[]).filter(x=>x.id===wanted||safeName(x.name,x.id)===wanted||clean(x.name)===wanted);return hits.length===1?hits[0]:null;};
 // Inside a site's folder the space is that site's, and the path is Topics/<section>/….
 const stated=clean(properties?.[IDENTITY.space]),depth=fixed?3:4,at=fixed?1:2;
 if(fixed&&stated&&stated!==fixed)return null;
 const space=fixed?spaces.find(w=>w.id===fixed):stated?find(spaces,stated):parts[0]===POOL_FOLDER&&parts.length>=4?find(spaces,parts[1]):null;
 if(!space)return null;
 const named=clean(properties?.[IDENTITY.section]);
 const section=named?find(space.sections,named):parts[0]===POOL_FOLDER&&parts.length>=depth?find(space.sections,parts[at]):null;
 return section?{workspaceId:space.id,sectionId:section.id}:null;
}

/** The editable part of a demand row, in the shape notes are compared in. */
export function topicOf(demand){
 const payload=demand?.payload||{};
 return {title:clean(demand?.title),brief:text(payload.brief).replace(/\r\n/g,'\n').trim(),priority:Number.isSafeInteger(demand?.priority)?demand.priority:0,
  workType:TOPIC_WORK_TYPES.includes(payload.workType)?payload.workType:'',topicKey:clean(payload.topicKey),dueAt:payload.dueAt?text(payload.dueAt):''};
}

/** The note of a demand: editable properties first, then the Center's own, then the brief as the body. */
export function demandToNote(demand,stringifyYaml){
 const topic=topicOf(demand),payload=demand.payload||{},lead=payload.lead;
 const properties={title:topic.title,priority:topic.priority,type:topic.workType,'topic-key':topic.topicKey,due:topic.dueAt,
  [IDENTITY.id]:demand.id,[IDENTITY.space]:demand.workspaceId,[IDENTITY.section]:demand.sectionId,[IDENTITY.state]:demand.state,
  [IDENTITY.generation]:demand.generation,[IDENTITY.claimedBy]:demand.workerId||'',[IDENTITY.work]:payload.workId||'',
  [IDENTITY.lead]:lead?[lead.platformId||lead.provider,lead.term].filter(Boolean).join(' · '):'',[IDENTITY.updated]:text(demand.updatedAt)};
 return '---\n'+stringifyYaml(properties).trimEnd()+'\n---\n'+(topic.brief?topic.brief+'\n':'');
}

/**
 * Reads a note back: {id, workspaceId, sectionId, state, generation, properties, topic}. `id` is null for a note
 * that is not yet a topic of the Center. Returns null for a file without a properties block.
 */
export function noteToTopic(content,parseYaml){
 const match=/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content||'');
 if(!match)return null;
 let properties;try{properties=parseYaml(match[1])||{};}catch{throw Object.assign(Error('The note properties cannot be read; fix the YAML before saving'),{code:'invalid_properties'});}
 if(typeof properties!=='object'||Array.isArray(properties))return null;
 const priority=properties.priority===''||properties.priority==null?0:Number(properties.priority),type=clean(properties.type);
 if(!Number.isSafeInteger(priority)||priority<-100||priority>100)throw Object.assign(Error('priority is a whole number from -100 to 100'),{code:'invalid_topic'});
 if(type&&!TOPIC_WORK_TYPES.includes(type))throw Object.assign(Error('type is '+TOPIC_WORK_TYPES.join(' or ')+', or empty for the section\'s default'),{code:'invalid_topic'});
 let dueAt='';
 if(properties.due!==''&&properties.due!=null){const time=Date.parse(text(properties.due));if(!Number.isFinite(time))throw Object.assign(Error('due is a date'),{code:'invalid_topic'});dueAt=new Date(time).toISOString();}
 const generation=Number(properties[IDENTITY.generation]);
 return {id:clean(properties[IDENTITY.id])||null,workspaceId:clean(properties[IDENTITY.space]),sectionId:clean(properties[IDENTITY.section]),
  state:clean(properties[IDENTITY.state]),generation:Number.isSafeInteger(generation)?generation:null,properties,
  topic:{title:clean(properties.title),brief:content.slice(match[0].length).replace(/\r\n/g,'\n').trim(),priority,workType:type,topicKey:clean(properties['topic-key']),dueAt}};
}

/** A stable digest of a topic's editable part, to tell whether a note was edited since it was last in step. */
export async function topicFingerprint(topic){
 const bytes=new TextEncoder().encode(JSON.stringify([topic.title,topic.brief,topic.priority,topic.workType,topic.topicKey,topic.dueAt?new Date(topic.dueAt).toISOString():'']));
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
/** What of the Center's side a note was last in step with; a difference means the demand changed there. */
export const remoteMark=demand=>[demand.generation,demand.state,demand.workerId||'',demand.payload?.workId||'',text(demand.updatedAt)].join('|');

/**
 * The `changes` of a definition edit that turns `base` (the topic as the Center has it) into `topic` (the note).
 * A cleared work type, topic key or due date is sent as null. Empty when nothing changed.
 */
export function topicChanges(base,topic){
 const changes={};
 if(topic.title!==base.title)changes.title=topic.title;
 if(topic.brief!==base.brief)changes.brief=topic.brief;
 if(topic.priority!==base.priority)changes.priority=topic.priority;
 if(topic.workType!==base.workType)changes.workType=topic.workType||null;
 if(topic.topicKey!==base.topicKey)changes.topicKey=topic.topicKey||null;
 const due=value=>value?new Date(value).toISOString():'';
 if(due(topic.dueAt)!==due(base.dueAt))changes.dueAt=topic.dueAt?due(topic.dueAt):null;
 return changes;
}

/** The body of a new demand from a note that is not yet a topic of the Center. */
export function newTopicDemand(topic,scope){
 if(!topic.title)throw Object.assign(Error('A topic needs a title property'),{code:'invalid_topic'});
 if(!topic.brief)throw Object.assign(Error('A topic needs a brief: write it as the note\'s text'),{code:'invalid_topic'});
 return {workspaceId:scope.workspaceId,sectionId:scope.sectionId,kind:'write',title:topic.title,brief:topic.brief,priority:topic.priority,
  ...(topic.workType?{workType:topic.workType}:{}),...(topic.topicKey?{topicKey:topic.topicKey}:{})};
}
