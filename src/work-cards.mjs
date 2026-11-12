// What a card in the Works list says about a work. Pure: the view passes in what it read from the vault, so the
// wording and the rules are tested without Obsidian. A card only speaks up about what needs attention; a work
// that matches the Center and is live on the site carries one plain chip.

/** "just now", "12 min ago", "3 h ago", "2 d ago". */
export function agoText(at,now=Date.now()){
 const minutes=Math.max(0,Math.round((now-at)/60000));
 return minutes<1?'just now':minutes<60?minutes+' min ago':minutes<1440?Math.round(minutes/60)+' h ago':Math.round(minutes/1440)+' d ago';
}

const count=value=>value===''||value==null?null:Number.isSafeInteger(Number(value))?Number(value):null;

/**
 * Chips for one work, most urgent first. Each is {text, tone, title}; tone is warning, danger, site or plain.
 * `state` is the local sync state (synced, edited, saving, conflict, unlinked) or undefined while unknown.
 * Version numbers come from the note as of the last update or save: `version` is the Center's latest draft and
 * `publishedVersion` the one on the site (empty when it was never published).
 */
export function cardChips({state,modified,author,category,version,publishedVersion},now=Date.now()){
 const chips=[],saved=count(version),live=count(publishedVersion);
 if(state==='edited')chips.push({text:'Edited '+agoText(modified,now),tone:'warning',title:'Changed since the last sync; not saved to the Center yet'});
 else if(state==='saving')chips.push({text:'Saving…',tone:'site',title:'Saving to the Center'});
 else if(state==='conflict')chips.push({text:'Conflict',tone:'danger',title:'Conflict: needs attention'});
 else if(state==='unlinked')chips.push({text:'Not linked',tone:'plain',title:'Not updated from the Center yet'});
 if(saved!=null&&state!=='unlinked'){
  if(live==null)chips.push({text:'Never published',tone:'site',title:'The site does not show this work yet'});
  else if(saved>live)chips.push({text:'Site shows v'+live+', draft v'+saved,tone:'site',title:'The Center has a newer draft than the version on the site'});
 }
 // Many works miss both; one chip says so without filling the card with red.
 const missing=[!String(author??'').trim()&&'author',!String(category??'').trim()&&'category'].filter(Boolean);
 if(missing.length)chips.push({text:'No '+missing.join(' or '),tone:'danger',title:'Add the '+missing.join(' and ')+' in the work details'});
 if(!chips.length&&state==='synced')chips.push({text:live!=null?'Live':'Synced',tone:'plain',title:live!=null?'Matches the Center, and the site shows this version':'Matches the Center'});
 return chips;
}

/** The file name of a picture in the media folder that an embed points to, or null. */
export function mediaName(link){
 const match=/(?:^|\/)article-media\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})$/.exec(String(link??'').split(/[#|]/)[0]);
 return match?match[1]:null;
}

/** How long the body is: Chinese characters plus Latin words, the way 字数 is usually counted. */
export function textLength(markdown){
 const body=String(markdown??'')
  .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'')
  .replace(/```[\s\S]*?```/g,' ')
  .replace(/!\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\)/g,' ')
  .replace(/\[([^\]]*)\]\([^)]*\)/g,'$1')
  .replace(/<[^>]+>/g,' ');
 const han=body.match(/[㐀-䶿一-鿿豈-﫿]/g)?.length||0;
 const words=body.match(/[A-Za-z0-9]+(?:['’.\-][A-Za-z0-9]+)*/g)?.length||0;
 return han+words;
}

/** "860 字", "9.8k 字", "12k words". */
export function lengthText(length,locale='zh-CN'){
 const unit=locale==='en'?' words':' 字';
 if(length<1000)return length+unit;
 const k=length/1000;
 return (k<10?k.toFixed(1):String(Math.round(k))).replace(/\.0$/,'')+'k'+unit;
}
