// AI card styles. An agent writes one stylesheet per column, `card-styles/<section>.css` in the vault, and the
// Cards tab draws the work with it as its "AI" style. The stylesheet only changes how the cards look: the
// page engine still lays the work out, measuring with this stylesheet, and still refuses a set that lost
// any text or picture; checkVisibleText then makes sure no text is hidden, faded, shrunk or pushed off a
// card by the style. Nothing is fetched: a stylesheet that would load anything is refused.

/** The vault folder that holds the column stylesheets. */
export const CARD_STYLE_FOLDER='card-styles';
/** The stylesheet for a column. */
export const cardStylePath=sectionId=>CARD_STYLE_FOLDER+'/'+sectionId+'.css';
const MAX_BYTES=24*1024,MAX_RULES=400;
/** What a stylesheet may address: everything starts at the card itself. */
export const CARD_STYLE_SCOPE='.rssd-page';

// Anything that loads, runs or escapes is refused outright rather than cleaned, so that what was checked is
// exactly what is drawn.
const REFUSED=[
 [/@/,'at-rules (@import, @font-face, @media and the like) are not used on a card'],
 [/url\s*\(|image-set\s*\(|image\s*\(|element\s*\(|expression\s*\(|attr\s*\(/i,'a card style may not load or reference anything outside itself'],
 [/\\/,'escapes are not allowed'],
 [/[<>]\s*\/?\s*style|<\/?[a-z]/i,'HTML is not allowed in a stylesheet'],
 [/javascript:|behavior\s*:|-moz-binding/i,'scripts are not allowed'],
 [/!\s*important/i,'!important would override the page engine\'s own layout'],
];
// Properties that would change the card itself, move content out of reading order or add words.
const PAGE_ONLY=new Set(['width','height','min-width','min-height','max-width','max-height','zoom','transform','scale','translate','rotate','overflow','position','inset','top','left','right','bottom']);
const NEVER=new Set(['zoom','position:fixed','position:sticky']);

function rules(css){
 const out=[];let rest=css;
 while(rest.trim()){
  const open=rest.indexOf('{');if(open<0)throw Error('a rule is missing its {');
  const close=rest.indexOf('}',open);if(close<0)throw Error('a rule is missing its }');
  const selector=rest.slice(0,open).trim(),body=rest.slice(open+1,close);
  if(body.includes('{'))throw Error('nested rules are not used on a card');
  if(!selector)throw Error('a rule has no selector');
  out.push({selector,body});rest=rest.slice(close+1);
  if(out.length>MAX_RULES)throw Error('the stylesheet has more than '+MAX_RULES+' rules');
 }
 return out;
}
function declarations(body){
 const out=[];
 for(const part of body.split(';')){
  if(!part.trim())continue;const colon=part.indexOf(':');if(colon<1)throw Error('a declaration is missing its value: '+part.trim().slice(0,60));
  out.push({property:part.slice(0,colon).trim().toLowerCase(),value:part.slice(colon+1).trim()});
 }
 return out;
}
// Strings are allowed only as font names and as empty `content` for decorations.
const STRING=/(["'])(.*?)\1/g;

/**
 * Checks a column stylesheet. Returns {css,rules} for a stylesheet that may be drawn, or throws an Error whose
 * message says what to change. Every selector must start at the card (`.rssd-page`); the card's own size,
 * position and overflow stay the engine's; `content` may only be empty, for lines, marks and shapes.
 */
export function checkCardStylesheet(text){
 if(typeof text!=='string')throw Error('the stylesheet could not be read');
 if(new TextEncoder().encode(text).length>MAX_BYTES)throw Error('the stylesheet is larger than '+(MAX_BYTES/1024)+' KB');
 const css=text.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\r\n?/g,'\n');
 if(/\/\*|\*\//.test(css))throw Error('a comment is not closed');
 for(const [pattern,reason] of REFUSED)if(pattern.test(css))throw Error(reason);
 const list=rules(css);
 for(const {selector,body} of list){
  for(const one of selector.split(',')){
   const s=one.trim().replace(/\s+/g,' ');
   if(!s.startsWith(CARD_STYLE_SCOPE))throw Error('every selector must start with '+CARD_STYLE_SCOPE+': '+s.slice(0,80));
   if(/^\.rssd-page[a-z0-9_-]/i.test(s))throw Error('every selector must start with '+CARD_STYLE_SCOPE+' itself: '+s.slice(0,80));
   if(/[`$]/.test(s))throw Error('unexpected characters in the selector: '+s.slice(0,80));
  }
  // Rules that address the card itself (not something on it) may not resize or move it.
  const onPage=selector.split(',').some(one=>/^\.rssd-page(\[[^\]]*\]|:[a-z-]+(\([^)]*\))?)*$/i.test(one.trim()));
  for(const {property,value} of declarations(body)){
   if(!/^-?[a-z][a-z0-9-]*$/.test(property))throw Error('unknown property: '+property.slice(0,40));
   if(NEVER.has(property)||NEVER.has(property+':'+value.toLowerCase().replace(/\s+/g,'')))throw Error(property+': '+value+' is not used on a card');
   if(onPage&&PAGE_ONLY.has(property))throw Error('the card\'s own '+property+' belongs to the page engine');
   if(property==='content'&&!/^(?:""|''|none|normal)$/.test(value))throw Error('content may only be empty (""), for lines and marks: a card shows only the work\'s own words');
   for(const [,,inner] of value.matchAll(STRING))if(property!=='font-family'&&property!=='content'||/[{};]/.test(inner))throw Error('text in quotes is only allowed for font names: '+property);
  }
 }
 return {css:css.trim(),rules:list.length};
}

/**
 * After layout: every piece of the work's text and the card's header and footer must be readable. Returns a
 * list of problems (empty when the cards are fine); each names the card and a short sample of the text.
 * `pages` are the laid-out cards, still in their measuring document.
 */
export function checkVisibleText(pages,{minFontSize=12,minOpacity=.6}={}){
 const problems=[];
 pages.forEach((page,index)=>{
  const view=page.ownerDocument.defaultView,box=page.getBoundingClientRect();
  const walker=page.ownerDocument.createTreeWalker(page,4);let node;
  while((node=walker.nextNode())){
   const text=node.textContent.trim();if(!text)continue;
   const el=node.parentElement,sample=text.slice(0,24),at='card '+(index+1)+' ("'+sample+'")';
   const style=view.getComputedStyle(el);
   if(style.visibility!=='visible'){problems.push(at+' is hidden');continue;}
   let opacity=1;for(let e=el;e&&e!==page.parentElement;e=e.parentElement)opacity*=Number(view.getComputedStyle(e).opacity);
   if(opacity<minOpacity){problems.push(at+' is faded');continue;}
   if(parseFloat(style.fontSize)<minFontSize){problems.push(at+' is smaller than '+minFontSize+'px');continue;}
   const colour=style.color.match(/rgba?\(([^)]+)\)/)?.[1].split(/[\s,/]+/).filter(Boolean).map(Number);
   if(colour&&colour.length>3&&colour[3]<minOpacity){problems.push(at+' is transparent');continue;}
   const range=page.ownerDocument.createRange();range.selectNodeContents(node);
   const rects=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0);
   if(!rects.length){problems.push(at+' is not drawn');continue;}
   if(rects.some(r=>r.left<box.left-1||r.top<box.top-1||r.right>box.right+1||r.bottom>box.bottom+1))problems.push(at+' runs off the card');
  }
 });
 return problems;
}

/** What is on a card, for a stylesheet's author. */
export const CARD_ELEMENTS=Object.freeze([
 ['.rssd-page','the card: 720×960 CSS pixels, saved at 1080×1440; its size, position and overflow are fixed'],
 ['.rssd-page[data-layout="…"]','the column\'s page layout, for example technical, journal or gallery'],
 ['.rssd-page-header','top line: the site name and the column name (two spans)'],
 ['.rssd-page-footer','bottom line: the site address and the card number (.rssd-page-number)'],
 ['.rssd-body','the reading area; the work flows through it and on to the next card'],
 ['.rssd-body .rssd-article-heading','first card only: .rssd-kicker (the column), h1 (the title), the summary and the byline'],
 ['.rssd-body h2, h3, p, ul, ol, li, strong, em, a','the work\'s headings, paragraphs and lists'],
 ['.rssd-body blockquote, pre, code, table, th, td, hr','quotes, code, tables and rules'],
 ['.rssd-body img, img.rssd-math, img.rssd-math-block','pictures, inline formulas and display formulas'],
 ['.rssd-body .rssd-byline','the address line at the end of the work'],
]);

/** A brief for an agent writing a column's stylesheet: the file, what is on a card, the column's colours and the rules. */
export function cardStyleBrief({siteName='',sectionId,sectionName='',look={}}){
 const colours=['ink','paper','accent'].filter(k=>look[k]).map(k=>'- '+k+': '+look[k]).join('\n');
 return ['# AI card style: '+(siteName?siteName+' · ':'')+(sectionName||sectionId),'',
  'Write one CSS file, `'+cardStylePath(sectionId)+'`, in this vault. It styles the picture cards of every work in this column. Obsidian lays each work out and draws the cards with it: the Cards tab shows it as the **AI** style.','',
  'You write only CSS. The words, their order, the pictures and the formulas are the work\'s own and must all stay readable.','',
  '## What is on a card','',...CARD_ELEMENTS.map(([selector,what])=>'- `'+selector+'`: '+what),'',
  '## This column today','',
  '- layout: '+(look.layout||'(default)'),'- body type: '+(look.fontSize||'')+'px, line height '+(look.lineHeight||''),...(colours?[colours]:[]),'',
  'Keep the column recognisable: use its colours (or close variants) and change the typography, spacing, rules, marks and the arrangement of the header, title and footer.','',
  '## Rules (a stylesheet that breaks one is refused)','',
  '- Every selector starts with `.rssd-page`.',
  '- No at-rules (`@import`, `@font-face`, `@media`), no `url()`, no escapes, no `!important`, no nesting.',
  '- Fonts are the ones on the computer: PingFang SC, Songti SC, Noto Sans CJK SC, Noto Serif CJK SC and common Latin faces.',
  '- The card itself (`.rssd-page` alone) keeps its size, position and overflow; pseudo-elements may be positioned for decoration.',
  '- `content` may only be empty (`""`): lines, marks and shapes, never words.',
  '- No text may be hidden, faded below 60% opacity, set below 12px, made transparent or pushed off a card: the cards are refused if it is.',
  '- Larger type is fine: the work simply takes more cards. Nothing is cut.','',
  '## Check your work','',
  'Open a work of this column, choose **AI** in the Cards tab, and look at every card. Save the stylesheet again after each change; the cards are drawn again on their own.',
 ].join('\n');
}
