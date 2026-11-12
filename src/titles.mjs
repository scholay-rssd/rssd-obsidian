// Readable labels for work notes. Files keep their stable `Works/<id>.md` names (sync identifies them by path),
// so the explorer, tabs and note header show the title and date from the note's properties instead.

// Month and day only: the year adds width without helping tell recent articles apart.
const dateText=value=>{
 if(value instanceof Date&&!Number.isNaN(value.getTime()))return value.toISOString().slice(5,10);
 const text=String(value??'').trim();
 if(/^\d{4}-\d{2}-\d{2}/.test(text))return text.slice(5,10);
 return text.replace(/^\d{4}\s*年\s*/,'');
};

/** {title, date} for a work note, or null when the note has no usable title. */
export function workLabel(frontmatter){
 const title=String(frontmatter?.title??'').trim();
 if(!title)return null;
 return {title,date:dateText(frontmatter?.date)};
}

/** One line for places that show plain text only, such as a tab: date first, then title. */
export const labelText=label=>label?(label.date?label.date+' ':'')+label.title:'';

/** An RSSD tab's title: what it shows, then the work's title. Empty when there is no work, so the caller falls back. */
export const tabTitle=(kind,label)=>label?.title?kind+' · '+label.title:'';
