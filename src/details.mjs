// The work details panel: what a work is, beside the list of works. Readers' fields (title, summary, date,
// author, category) are edited here, each measured against the limits of the outputs that use it; the fields
// that link the note to its Center work are shown but not editable, because changing one breaks the link.
import * as spec from '../../contracts/output-package.mjs';

// Limits come from the shared output spec (contracts/output-package.mjs), in either of its shapes.
const article=spec.OUTPUT_DESTINATIONS?.['wechat-official-account']?.limits||spec.OUTPUT_FORMATS?.['wechat-article']?.limits||{title:64,digest:120,author:16};
const cards=spec.OUTPUT_DESTINATIONS?.xiaohongshu?.limits||spec.OUTPUT_FORMATS?.cards?.limits||{title:20};
export const characters=value=>[...String(value??'')].length;

export const DETAIL_FIELDS=Object.freeze([
 {key:'title',label:'Title',limits:[{name:'Article',max:article.title},{name:'Cards',max:cards.title}]},
 {key:'summary',label:'Summary',multiline:true,limits:[{name:'Digest',max:article.digest}]},
 {key:'date',label:'Date',type:'date'},
 {key:'author',label:'Author',limits:[{name:'Article',max:article.author}]},
 {key:'category',label:'Category'},
]);
export const IDENTITY_FIELDS=Object.freeze([['rssd-id','ID'],['rssd-section','Section'],['rssd-locale','Language'],['rssd-kind','Kind'],['rssd-version','Center version'],['rssd-published-version','Published version']]);
export const isDetailKey=key=>DETAIL_FIELDS.some(field=>field.key===key);

/** A property's value as the panel shows it: text, with a YAML date written back as YYYY-MM-DD. */
export function fieldText(value){
 if(value instanceof Date&&!Number.isNaN(value.getTime()))return value.toISOString().slice(0,10);
 return value==null?'':String(value);
}
/** How a value measures against each output that uses the field. */
export function counters(field,value){
 const length=characters(value);
 return (field.limits||[]).filter(limit=>Number.isSafeInteger(limit.max)&&limit.max>0).map(limit=>({...limit,length,over:length>limit.max}));
}
/** The text written back for an edit: trimmed, and a date only when it is a real YYYY-MM-DD date. */
export function cleanValue(field,value){
 const text=String(value??'').replace(/\r\n?/g,'\n').trim();
 if(field.type==='date'&&text&&(!/^\d{4}-\d{2}-\d{2}$/.test(text)||Number.isNaN(Date.parse(text))))throw Object.assign(Error('Enter the date as YYYY-MM-DD'),{code:'invalid_date'});
 return field.multiline?text:text.replace(/\s*\n\s*/g,' ');
}
