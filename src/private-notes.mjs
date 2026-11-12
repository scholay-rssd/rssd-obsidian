// The private part of a work's Center record, as Obsidian shows it: the internal notes, the notes pinned to a
// paragraph or picture, and every run of every agent. Read only, and never written into the note or any output.
import {INTERNAL_NOTE_FIELDS} from '../../contracts/article-internal-notes.mjs';
import {runWriter,writerLabel} from './work-cards.mjs';

// What still needs doing comes first.
const ORDER=Object.freeze(['verification','writing','supplement','images','other']);

/** The internal notes that say something, in reading order: [{key, label, text}]. */
export function internalNotes(privateEditorial){
 const notes=privateEditorial?.internalNotes;
 if(!notes||typeof notes!=='object')return [];
 return ORDER.filter(key=>typeof notes[key]==='string'&&notes[key].trim()).map(key=>({key,label:INTERNAL_NOTE_FIELDS[key],text:notes[key].trim()}));
}
/** Whether 核对与待办 holds anything. */
export const hasOpenChecks=privateEditorial=>!!String(privateEditorial?.internalNotes?.verification??'').trim();

/** Every run, oldest first: [{at, action, status, label}]. */
export function runHistory(privateEditorial){
 const runs=Array.isArray(privateEditorial?.modelSignatures)?privateEditorial.modelSignatures:[];
 return runs.filter(run=>run&&typeof run==='object'&&typeof run.agentName==='string')
  .sort((a,b)=>String(a.startedAt??'').localeCompare(String(b.startedAt??'')))
  .map(run=>({at:String(run.startedAt??''),action:String(run.action??''),status:String(run.status??''),label:writerLabel(runWriter(run))}));
}

/** Notes pinned to a paragraph, heading or picture: [{id, anchor: {type, text} | null, notes}]. */
export function rowNotes(privateEditorial){
 const entries=privateEditorial?.blockNotes;
 if(!entries||typeof entries!=='object')return [];
 return Object.entries(entries).map(([id,entry])=>({id,anchor:entry?.anchor&&typeof entry.anchor.text==='string'?{type:String(entry.anchor.type??''),text:entry.anchor.text}:null,notes:internalNotes({internalNotes:entry?.notes})}))
  .filter(entry=>entry.notes.length);
}

// Markdown and rendered text compared without links, pictures, footnote markers, emphasis or spacing.
const plain=text=>String(text??'').replace(/!\[[^\]]*\]\([^)]*\)/g,'').replace(/\[\^[^\]]+\]/g,'').replace(/\[([^\]]*)\]\([^)]*\)/g,'$1')
 .replace(/[*_`#>~]/g,'').replace(/\[\d+\]/g,'').replace(/\s+/g,'');
/** Whether a rendered paragraph is the one a row note was pinned to: the same text, or the same opening when long. */
export function anchorMatches(anchorText,renderedText){
 const a=plain(anchorText),b=plain(renderedText).replace(/\d+$/,'');
 if(!a||!b)return false;
 if(a===b||plain(renderedText)===a)return true;
 const head=a.slice(0,40);return head.length>=12&&b.startsWith(head);
}
