// The article themes and the site name marks. A theme decides the structure of an article — how a chapter
// opens, how sub-headings, quotes, marked terms, code and pictures read — and is chosen by the kind of article,
// not by the site. The site contributes its colours and fonts (from the section template) and its name marks.
// Pasted editors keep inline styles only, so every piece is plain blocks, borders and backgrounds: no
// positioning, pseudo-elements or web fonts.
// These strings are written straight into style="…" attributes, so font names take single quotes.
const SANS="-apple-system,BlinkMacSystemFont,'PingFang SC','Helvetica Neue',Arial,sans-serif";
const SERIF="'Songti SC','STSong','Noto Serif CJK SC',Georgia,'Times New Roman',serif";
const MONO="'SF Mono',Menlo,Consolas,'Courier New',monospace";
export const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const hex=(value,fallback)=>/^#[0-9a-fA-F]{6}$/.test(value||'')?value:fallback;
export function colours(look={}){
 const ink=hex(look.ink,'#23352f'),accent=hex(look.accent,'#35695f'),muted=hex(look.muted,'#637169'),paper=hex(look.paper,'#fcfdfb');
 const [r,g,b]=[1,3,5].map(i=>parseInt(accent.slice(i,i+2),16));
 return {ink,accent,muted,paper,tint:alpha=>`rgba(${r},${g},${b},${alpha})`};
}
const two=n=>String(n).padStart(2,'0');
const ROMAN=['Ⅰ','Ⅱ','Ⅲ','Ⅳ','Ⅴ','Ⅵ','Ⅶ','Ⅷ','Ⅸ','Ⅹ','Ⅺ','Ⅻ'];
const CN=['一','二','三','四','五','六','七','八','九','十','十一','十二','十三','十四','十五','十六','十七','十八','十九','二十'];
const TRIGRAMS=['☰','☱','☲','☳','☴','☵','☶','☷'];
const cn=n=>CN[n-1]||String(n);
const title=(style,html)=>`<h2 style="margin:0;font-weight:700;${style}">${html}</h2>`;
// A heading such as 参考文献 is structure, not a chapter: every site keeps it quiet and unnumbered.
const quiet=(h,c)=>`<section style="margin:36px 0 12px;">${title(`font-family:${SANS};font-size:15px;line-height:1.6;letter-spacing:2px;color:${c.muted};`,h.html)}</section>`;
const label=s=>esc(s.category?s.name+' · '+s.category:s.name);

// Each site's name marks: how it signs the top and the end of an article. The site's colours and fonts come
// from its section templates; everything else about the look comes from the chosen theme.
export const SITE_MARKS={
 // 今日学术 — a journal page: double rules, serif, Roman-numbered parts.
 'scholay-today':{
  masthead:(s,c)=>`<section style="margin:0 0 26px;padding:12px 0 10px;border-top:3px double ${c.ink};border-bottom:1px solid ${c.ink};text-align:center;"><p style="margin:0;font-family:${SERIF};font-size:18px;line-height:1.5;font-weight:700;letter-spacing:8px;color:${c.ink};">${esc(s.name)}</p><p style="margin:2px 0 0;font-family:${SERIF};font-size:12px;line-height:1.6;letter-spacing:2px;color:${c.muted};">${esc([s.category,s.slogan].filter(Boolean).join(' ｜ '))}</p></section>`,
  signature:(s,c)=>`<section style="margin:40px 0 0;padding-top:14px;border-top:3px double ${c.ink};text-align:center;"><p style="margin:0;font-family:${SERIF};font-size:13px;line-height:1.8;letter-spacing:2px;color:${c.muted};">— ${esc(s.name)} · ${esc(s.slogan)} —</p></section>`,
 },
 // 研究方法 — a lab protocol: numbered steps in solid blocks, marker-pen emphasis, dashed rules.
 metho:{
  masthead:(s,c)=>`<section style="margin:0 0 24px;padding-bottom:10px;border-bottom:1px dashed ${c.tint(.55)};"><span style="display:inline-block;padding:2px 10px;background:${c.ink};color:#fff;font-family:${MONO};font-size:13px;line-height:1.7;letter-spacing:1px;">${esc(s.name)}</span><span style="font-family:${MONO};font-size:12px;color:${c.muted};"> / ${esc(s.category||s.slogan)}</span></section>`,
  signature:(s,c)=>`<section style="margin:38px 0 0;padding-top:12px;border-top:1px dashed ${c.tint(.55)};"><p style="margin:0;font-family:${MONO};font-size:12px;line-height:1.8;color:${c.muted};"><span style="color:${c.accent};">■</span> ${esc(s.name)} — ${esc(s.slogan)}</p></section>`,
 },
 // 学术之门 — a portal: every chapter is a tab standing on a bar, software names are chips.
 enter:{
  masthead:(s,c)=>`<section style="margin:0 0 24px;border-bottom:2px solid ${c.accent};"><span style="display:inline-block;padding:5px 16px 4px;border:1px solid ${c.accent};border-bottom:0;border-radius:10px 10px 0 0;font-size:15px;line-height:1.6;font-weight:700;letter-spacing:2px;color:${c.accent};">${esc(s.name)}</span><span style="font-size:12px;color:${c.muted};">　${esc(s.category||s.slogan)}</span></section>`,
  signature:(s,c)=>`<section style="margin:38px 0 0;padding:10px 14px;background:${c.tint(.1)};border-radius:10px;"><p style="margin:0;font-size:13px;line-height:1.8;color:${c.ink};"><span style="color:${c.accent};">▸</span> <span style="font-weight:700;">${esc(s.name)}</span> · ${esc(s.slogan)}</p></section>`,
 },
 // 犀术智法 — a statute: parts named 第一部分 in a ruled box, defined terms dotted underneath, a seal to sign.
 legis:{
  masthead:(s,c)=>`<section style="margin:0 0 26px;padding:10px 0;border-top:1px solid ${c.ink};border-bottom:1px solid ${c.ink};text-align:center;"><p style="margin:0;font-family:${SERIF};font-size:17px;line-height:1.6;font-weight:700;letter-spacing:6px;color:${c.ink};"><span style="color:${c.accent};">§</span> ${esc(s.name)} <span style="color:${c.accent};">§</span></p><p style="margin:0;font-family:${SERIF};font-size:12px;line-height:1.6;color:${c.muted};">${esc(s.category||s.slogan)}</p></section>`,
  signature:(s,c)=>`<section style="margin:40px 0 0;padding-top:14px;border-top:1px solid ${c.ink};text-align:right;"><span style="font-family:${SERIF};font-size:12px;color:${c.muted};">${esc(s.slogan)}　</span><span style="display:inline-block;padding:3px 9px;border:2px solid ${c.accent};font-family:${SERIF};font-size:14px;line-height:1.5;font-weight:700;letter-spacing:3px;color:${c.accent};">${esc(s.name)}</span></section>`,
 },
 // 犀术国学 — a bound volume: 卷一, a trigram that changes chapter by chapter, a seal in the site's own colour.
 xsiching:{
  masthead:(s,c)=>`<section style="margin:0 0 28px;padding:16px 12px 14px;background:${c.tint(.08)};text-align:center;"><p style="margin:0;line-height:1.6;"><span style="display:inline-block;width:34px;border-top:1px solid ${c.accent};vertical-align:middle;"></span><span style="font-family:${SERIF};font-size:18px;font-weight:700;letter-spacing:8px;padding-left:20px;padding-right:12px;color:${c.ink};vertical-align:middle;">${esc(s.name)}</span><span style="display:inline-block;width:34px;border-top:1px solid ${c.accent};vertical-align:middle;"></span></p><p style="margin:4px 0 0;font-family:${SERIF};font-size:12px;line-height:1.6;letter-spacing:3px;color:${c.muted};">${esc(s.category||s.slogan)}</p></section>`,
  signature:(s,c)=>`<section style="margin:42px 0 0;text-align:center;"><p style="margin:0 0 8px;font-family:${SERIF};font-size:12px;line-height:1.6;letter-spacing:3px;color:${c.muted};">${esc(s.slogan)}</p><span style="display:inline-block;padding:6px 8px 6px 11px;background:${c.accent};border-radius:4px;font-family:${SERIF};font-size:14px;line-height:1.4;font-weight:700;letter-spacing:3px;color:#fff;">${esc(s.name)}</span></section>`,
 },
 // 智能学堂 — a course: LESSON 01 with a bar that fills as the article goes on.
 study:{
  masthead:(s,c)=>`<section style="margin:0 0 24px;padding:12px 14px;background:${c.tint(.1)};border-radius:12px;"><p style="margin:0;font-size:16px;line-height:1.6;font-weight:700;color:${c.accent};">✎ ${esc(s.name)}</p><p style="margin:0;font-size:12px;line-height:1.6;color:${c.muted};">${esc([s.category,s.slogan].filter(Boolean).join(' · '))}</p></section>`,
  signature:(s,c)=>`<section style="margin:38px 0 0;padding:10px 14px;border:1px dashed ${c.tint(.6)};border-radius:12px;text-align:center;"><p style="margin:0;font-size:13px;line-height:1.8;color:${c.muted};">下课 · <span style="font-weight:700;color:${c.accent};">${esc(s.name)}</span> — ${esc(s.slogan)}</p></section>`,
 },
 // 犀术 IME — a keyboard: the name and chapter numbers are keycaps, shortcuts in the text are keys too.
 lingxi:{
  masthead:(s,c)=>`<section style="margin:0 0 24px;padding-bottom:12px;border-bottom:1px solid ${c.tint(.3)};"><p style="margin:0;line-height:2;">${[...String(s.name)].filter(ch=>ch.trim()).map(ch=>`<span style="display:inline-block;min-width:14px;margin-right:5px;padding:0 7px;background:#fff;border:1px solid ${c.tint(.5)};border-bottom:3px solid ${c.tint(.5)};border-radius:6px;font-family:${MONO};font-size:14px;line-height:1.7;font-weight:700;text-align:center;color:${c.ink};">${esc(ch)}</span>`).join('')}</p><p style="margin:6px 0 0;font-size:12px;line-height:1.6;color:${c.muted};">${esc(s.category||s.slogan)}</p></section>`,
  signature:(s,c)=>`<section style="margin:38px 0 0;"><section style="display:inline-block;padding:5px 6px;border:1px solid ${c.tint(.4)};border-radius:8px;"><span style="display:inline-block;padding:1px 9px;background:${c.accent};border-radius:5px;font-size:13px;line-height:1.7;color:#fff;"><span style="font-family:${MONO};">1</span> ${esc(s.name)}</span><span style="font-size:13px;line-height:1.7;color:${c.muted};">　<span style="font-family:${MONO};">2</span> ${esc(s.slogan)}　</span></section></section>`,
 },
 // 小猪盖被 — a portfolio: an oversized pale numeral, a colour swatch, plenty of air.
 piggytuck:{
  masthead:(s,c)=>`<section style="margin:0 0 30px;"><p style="margin:0;font-size:20px;line-height:1.5;font-weight:800;letter-spacing:1px;color:${c.ink};">${esc(s.name)} ${[1,.55,.25].map(a=>`<span style="display:inline-block;width:10px;height:10px;margin-left:4px;background:${c.tint(a)};border-radius:50%;"></span>`).join('')}</p><p style="margin:2px 0 0;font-size:11px;line-height:1.6;letter-spacing:3px;color:${c.muted};">${esc(s.category||s.slogan)}</p></section>`,
  signature:(s,c)=>`<section style="margin:44px 0 0;padding:16px;background:${c.tint(.1)};border-radius:18px;text-align:center;"><p style="margin:0;font-size:15px;line-height:1.6;font-weight:800;color:${c.ink};">${esc(s.name)}</p><p style="margin:2px 0 0;font-size:12px;line-height:1.6;color:${c.muted};">${esc(s.slogan)}</p></section>`,
 },
 // 学术海 — a logbook by the sea: NO.01, a serif heading, a wave underneath.
 personal:{
  masthead:(s,c)=>`<section style="margin:0 0 26px;padding-bottom:10px;border-bottom:1px solid ${c.tint(.35)};"><p style="margin:0;line-height:1.6;"><span style="font-size:13px;letter-spacing:-2px;color:${c.accent};">﹏﹏</span> <span style="font-family:${SERIF};font-size:17px;font-weight:700;letter-spacing:3px;color:${c.ink};">${esc(s.name)}</span><span style="font-size:12px;color:${c.muted};">　${esc(s.category||s.slogan)}</span></p></section>`,
  signature:(s,c)=>`<section style="margin:40px 0 0;text-align:center;"><p style="margin:0;font-family:${SERIF};font-size:13px;line-height:1.8;color:${c.muted};"><span style="letter-spacing:-2px;color:${c.tint(.6)};">﹏﹏</span>　${esc(s.name)} · ${esc(s.slogan)}　<span style="letter-spacing:-2px;color:${c.tint(.6)};">﹏﹏</span></p></section>`,
 },
 // 小猪萌宠 — a walk: paw prints count the stops, headings sit in round bubbles.
 pets:{
  masthead:(s,c)=>`<section style="margin:0 0 24px;text-align:center;"><section style="display:inline-block;padding:7px 20px;background:${c.tint(.14)};border-radius:999px;"><span style="font-size:15px;line-height:1.6;font-weight:700;color:${c.ink};">🐾 ${esc(s.name)}</span><span style="font-size:12px;line-height:1.6;color:${c.muted};">　${esc(s.category||s.slogan)}</span></section></section>`,
  signature:(s,c)=>`<section style="margin:40px 0 0;padding:12px 14px;border:1px dashed ${c.tint(.6)};border-radius:16px;text-align:center;"><p style="margin:0;font-size:13px;line-height:1.8;color:${c.muted};">🐾 <span style="font-weight:700;color:${c.ink};">${esc(s.name)}</span> · ${esc(s.slogan)}</p></section>`,
 },
};

const STRUCTURAL=/^\s*(参考文献|参考资料|延伸阅读|相关阅读|附录|致谢|摘要|注释|references?|further reading|notes?|appendix|acknowledge?ments?)\s*$/i;

/**
 * Dress the engine's styled HTML in a site's design: chapter openings, the site's name above and below, and
 * its way of marking a name or term. Returns the HTML unchanged when the site has no design.
 */
const box=(style)=>`max-width:100%;box-sizing:border-box;${style}`;
export const ARTICLE_THEMES=Object.freeze({
 // Essays and reflections: quiet, serif, numbered in words.
 classic:{label:'Classic',
  chapter:(h,c)=>`<section style="margin:42px 0 18px;text-align:center;"><p style="margin:0 0 6px;font-family:${SERIF};font-size:13px;line-height:1.6;letter-spacing:4px;color:${c.accent};">第${cn(h.n)}节</p>${title(`font-family:${SERIF};font-size:19px;line-height:1.6;letter-spacing:1px;color:${c.ink};`,h.html)}</section>`,
  h3:c=>`margin:26px 0 10px;font-family:${SERIF};font-size:16px;line-height:1.7;font-weight:700;color:${c.ink};`,
  strong:c=>`font-weight:700;color:${c.ink};border-bottom:1px solid ${c.tint(.5)};`,
  code:c=>`font-family:${SERIF};font-size:15px;font-style:italic;color:${c.accent};`,
  quote:c=>`margin:22px 0;padding:4px 0 4px 16px;border-left:2px solid ${c.accent};color:${c.muted};font-family:${SERIF};font-size:15px;line-height:1.85;`,
  img:()=>`display:block;max-width:100%;height:auto;margin:22px auto;`,
  body:()=>`line-height:1.9;letter-spacing:.3px;`},
 // Academic and reference writing: Roman-numbered parts, ruled like a journal page.
 journal:{label:'Journal',
  chapter:(h,c)=>`<section style="margin:40px 0 18px;padding-bottom:8px;border-bottom:1px solid ${c.ink};"><span style="font-family:${SERIF};font-size:17px;line-height:1.6;color:${c.accent};">${ROMAN[h.n-1]||h.n}.</span><span>　</span>${title(`display:inline;font-family:${SERIF};font-size:18px;line-height:1.6;color:${c.ink};`,h.html)}</section>`,
  h3:c=>`margin:24px 0 8px;font-family:${SERIF};font-size:16px;line-height:1.7;font-weight:700;font-style:italic;color:${c.ink};`,
  strong:c=>`font-weight:700;color:${c.ink};`,
  code:c=>`font-family:${MONO};font-size:13px;color:${c.accent};`,
  quote:c=>`margin:22px 0;padding:10px 6px;border-top:1px solid ${c.tint(.6)};border-bottom:1px solid ${c.tint(.6)};color:${c.muted};font-family:${SERIF};font-size:15px;line-height:1.85;`,
  img:()=>`display:block;max-width:100%;height:auto;margin:22px auto 8px;`,
  body:()=>`line-height:1.85;text-align:justify;`},
 // News and briefs: label-style headings, compact, built to be scanned.
 briefing:{label:'Briefing',
  chapter:(h,c)=>`<section style="margin:30px 0 12px;">${title(box(`display:inline-block;padding:3px 12px;background:${c.accent};border-radius:3px;font-size:15px;line-height:1.6;color:#fff;`),(h.n<10?'0':'')+h.n+'　'+h.html)}</section>`,
  h3:c=>`margin:18px 0 6px;padding-bottom:4px;border-bottom:1px dashed ${c.tint(.45)};font-size:15px;line-height:1.6;font-weight:700;color:${c.accent};`,
  strong:c=>`font-weight:700;color:${c.accent};`,
  code:c=>`font-family:${MONO};font-size:13px;color:${c.ink};background:${c.tint(.12)};border-radius:3px;padding:1px 5px;`,
  quote:c=>`margin:16px 0;padding:10px 14px;border-left:4px solid ${c.accent};background:${c.tint(.08)};color:${c.ink};font-size:15px;line-height:1.75;`,
  img:()=>`display:block;max-width:100%;height:auto;margin:16px auto;border-radius:4px;`,
  body:()=>`line-height:1.75;`},
 // Methods, tutorials and data: numbered steps, monospace sub-heads, tip boxes.
 technical:{label:'Technical',
  chapter:(h,c)=>`<section style="margin:36px 0 16px;padding-bottom:9px;border-bottom:1px dashed ${c.tint(.55)};"><span style="display:inline-block;margin-right:10px;padding:1px 8px;background:${c.accent};color:#fff;font-family:${MONO};font-size:14px;line-height:1.7;font-weight:700;vertical-align:middle;">${two(h.n)}</span>${title(`display:inline;font-family:${SANS};font-size:18px;line-height:1.6;color:${c.ink};vertical-align:middle;`,h.html)}</section>`,
  h3:c=>`margin:22px 0 8px;font-family:${MONO};font-size:14px;line-height:1.7;font-weight:700;letter-spacing:.3px;color:${c.accent};`,
  strong:c=>`font-weight:700;color:${c.ink};background:linear-gradient(transparent 58%,${c.tint(.28)} 58%);`,
  code:c=>`font-family:${MONO};font-size:13px;color:${c.accent};border:1px solid ${c.tint(.4)};border-radius:3px;padding:0 4px;`,
  quote:c=>`margin:18px 0;padding:10px 14px;border:1px solid ${c.tint(.35)};border-radius:6px;background:${c.tint(.06)};color:${c.ink};font-size:14px;line-height:1.8;`,
  img:c=>`display:block;max-width:100%;height:auto;margin:20px auto;border:1px solid ${c.tint(.25)};border-radius:6px;`,
  body:()=>`line-height:1.8;`},
 // Picture-led stories: oversized numerals, airy spacing, rounded pictures.
 visual:{label:'Visual',
  chapter:(h,c)=>`<section style="margin:50px 0 18px;"><p style="margin:0;font-family:${SANS};font-size:44px;line-height:1;font-weight:800;letter-spacing:-1px;color:${c.tint(.22)};">${two(h.n)}</p>${title(`margin-top:6px;font-size:20px;line-height:1.5;color:${c.ink};`,h.html)}<p style="margin:10px 0 0;line-height:0;"><span style="display:inline-block;width:30px;height:4px;background:${c.accent};border-radius:2px;"></span></p></section>`,
  h3:c=>`margin:26px 0 10px;font-size:17px;line-height:1.6;font-weight:700;color:${c.ink};`,
  strong:c=>`font-weight:700;color:${c.accent};`,
  code:c=>`font-family:${SANS};font-size:13px;color:${c.accent};border:1px solid ${c.accent};border-radius:999px;padding:1px 9px;`,
  quote:c=>`margin:28px 0;padding:6px 18px;text-align:center;color:${c.muted};font-size:17px;line-height:1.8;`,
  img:()=>`display:block;max-width:100%;height:auto;margin:24px auto;border-radius:12px;`,
  body:()=>`line-height:1.9;`},
});
// Each section's default theme follows the layout the website gives it.
const THEME_FOR_LAYOUT={dispatch:'briefing',essay:'classic',ledger:'journal',archive:'journal',technical:'technical',guide:'technical',gallery:'visual'};
export const defaultArticleTheme=layout=>THEME_FOR_LAYOUT[layout]||'classic';

/**
 * Dress the engine's styled HTML in a theme, signed with the site's name marks. With no theme the article keeps
 * the engine's plain look (still frameless and overflow-safe).
 */
const CITATION=/\[(\d+(?:\s*[,，、–-]\s*\d+)*)\]/g;
/**
 * Typography shared by every style: text a size smaller, citation markers such as [1] as small superscripts,
 * references, captions and similar notes smaller and muted, and in Chinese a two-character first-line indent
 * on body paragraphs (not on lists, quotes, captions or the notes).
 */
function typeset(doc,root,c,locale){
 const notes=new Set();
 for(const heading of root.querySelectorAll('h2'))if(STRUCTURAL.test(heading.textContent||''))for(let el=heading.nextElementSibling;el&&el.tagName!=='H2';el=el.nextElementSibling)notes.add(el);
 const add=(el,style)=>el.setAttribute('style',(el.getAttribute('style')||'')+style);
 for(const el of notes){add(el,`font-size:13px;line-height:1.7;color:${c.muted};`);for(const item of el.querySelectorAll('p,li'))add(item,`font-size:13px;line-height:1.7;color:${c.muted};text-indent:0;`);}
 for(const el of root.querySelectorAll('figcaption'))add(el,`font-size:12px;color:${c.muted};`);
 if(/^zh/i.test(locale||'zh-CN'))for(const p of root.querySelectorAll('p')){
  if(p.closest('li,blockquote,figure,table')||[...notes].some(note=>note===p||note.contains(p)))continue;
  if(!(p.textContent||'').trim())continue;
  add(p,'text-indent:2em;');
 }
 // Citation markers in running text, never inside code or a link.
 const walker=doc.createTreeWalker(root,4),texts=[];for(let node=walker.nextNode();node;node=walker.nextNode())texts.push(node);
 for(const node of texts){
  CITATION.lastIndex=0;
  if(!CITATION.test(node.nodeValue||'')||node.parentElement?.closest('code,pre,a,sup'))continue;
  CITATION.lastIndex=0;
  const box=doc.createElement('span');box.innerHTML=esc(node.nodeValue).replace(CITATION,`<sup style="font-size:11px;line-height:0;color:${c.muted};">[$1]</sup>`);
  node.replaceWith(...box.childNodes);
 }
 CITATION.lastIndex=0;
}

export function decorateWechat(doc,html,{site,look,category='',theme=null,locale='zh-CN'}={}){
 const design=theme&&Object.prototype.hasOwnProperty.call(ARTICLE_THEMES,theme)?ARTICLE_THEMES[theme]:null;
 const marks=site&&Object.prototype.hasOwnProperty.call(SITE_MARKS,site.id)?SITE_MARKS[site.id]:null;
 const host=doc.createElement('div');host.innerHTML=html;
 const root=host.firstElementChild;if(!root)return html;
 const c=colours(look);
 // The article has no frame and no width of its own: it fills the editor it is pasted into, at any width.
 // Long links and identifiers wrap, and a picture never grows past its own size or the column.
 root.setAttribute('style',(root.getAttribute('style')||'')+'font-size:15px;'+(design?design.body(c):'')+'overflow-wrap:anywhere;max-width:100%;box-sizing:border-box;');
 for(const el of [...root.querySelectorAll('img')])el.setAttribute('style',design?design.img(c):'display:block;max-width:100%;height:auto;margin:16px auto;');
 typeset(doc,root,c,locale);
 if(!design)return root.outerHTML;
 const s={name:String(site?.name||''),slogan:String(site?.slogan||''),category:String(category||'')};
 const headings=[...root.querySelectorAll('h2')],chapters=headings.filter(el=>!STRUCTURAL.test(el.textContent||''));
 for(const el of headings){
  const n=chapters.indexOf(el)+1;
  el.insertAdjacentHTML('afterend',n?design.chapter({n,total:chapters.length,html:el.innerHTML},c):quiet({html:el.innerHTML},c));el.remove();
 }
 for(const el of [...root.querySelectorAll('h3')])el.setAttribute('style',design.h3(c));
 for(const el of [...root.querySelectorAll('blockquote')])el.setAttribute('style',design.quote(c));
 for(const el of [...root.querySelectorAll('strong')])el.setAttribute('style',design.strong(c));
 for(const el of [...root.querySelectorAll('code')])if(!el.closest('pre'))el.setAttribute('style',design.code(c));
 if(marks&&s.name){root.insertAdjacentHTML('afterbegin',marks.masthead(s,c));root.insertAdjacentHTML('beforeend',marks.signature(s,c));}
 // A boxed label holding a long title must wrap inside the column like everything else.
 for(const el of [...root.querySelectorAll('[style*="display:inline-block"]')])if(!/(^|;)\s*width:/.test(el.getAttribute('style')))el.setAttribute('style',el.getAttribute('style')+'max-width:100%;box-sizing:border-box;');
 return root.outerHTML;
}
