import test from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'yaml';
import {checkCardStylesheet,checkVisibleText,cardStylePath,cardStyleBrief,CARD_ELEMENTS} from '../src/card-stylesheet.mjs';
import {buildCards} from '../src/cards.mjs';

const GOOD=`/* Methods: a lab notebook */
.rssd-page{background:#f7f9f8;color:#1f2a2b;font-family:"PingFang SC",sans-serif}
.rssd-page .rssd-page-header{border-bottom:2px solid #436d70;letter-spacing:2px}
.rssd-page .rssd-body h2{font-size:30px;padding:6px 12px;background:#436d7014;border-left:6px solid #436d70}
.rssd-page .rssd-body p{font-size:25px;line-height:1.75}
.rssd-page::before{content:"";position:absolute;left:0;top:0;width:8px;height:100%;background:#436d70}
.rssd-page[data-layout="technical"] .rssd-body pre,.rssd-page .rssd-body code{font-family:"SF Mono",monospace}`;

test('a column stylesheet that only styles the card is accepted as written, comments aside',()=>{
 const {css,rules}=checkCardStylesheet(GOOD);
 assert.equal(rules,6);assert.doesNotMatch(css,/lab notebook/);assert.match(css,/^\.rssd-page\{background:#f7f9f8/);
 assert.equal(cardStylePath('methods'),'card-styles/methods.css');
});

test('anything that loads, hides words, adds words or moves the card is refused with the reason',()=>{
 const refused=[
  ['@import "x.css";.rssd-page{color:red}',/at-rules/],
  ['@font-face{font-family:x}',/at-rules/],
  ['.rssd-page{background:url(https://example.org/a.png)}',/load or reference/],
  ['.rssd-page{background:image-set("a.png" 1x)}',/load or reference/],
  ['.rssd-page h2{color:\\72 ed}',/escapes/],
  ['.rssd-page p{color:red!important}',/!important/],
  ['body{color:red}',/must start with \.rssd-page/],
  ['.rssd-page p,h2{color:red}',/must start with \.rssd-page/],
  ['.rssd-pageX{color:red}',/\.rssd-page itself/],
  ['.rssd-page{width:1080px}',/own width belongs to the page engine/],
  ['.rssd-page[data-layout="technical"]{overflow:visible}',/own overflow/],
  ['.rssd-page .rssd-body h2::after{content:"重点"}',/content may only be empty/],
  ['.rssd-page p{position:fixed}',/not used on a card/],
  ['.rssd-page{.rssd-body{color:red}}',/nested/],
  ['.rssd-page{color:red',/missing its }/],
  ['/* open .rssd-page{color:red}',/comment is not closed/],
  ['.rssd-page p{font-family:"a{b"}',/./],
  ['.rssd-page p{quotes:"«" "»"}',/only allowed for font names/],
  ['<style>.rssd-page{}</style>',/HTML|at-rules|must start/],
  [GOOD+'\n'+'.rssd-page p{color:#111}'.repeat(1200),/larger than 24 KB/],
 ];
 for(const [css,reason] of refused)assert.throws(()=>checkCardStylesheet(css),reason,css.slice(0,60));
 // Decorations may be placed freely; the reading area may change its own spacing.
 assert.doesNotThrow(()=>checkCardStylesheet('.rssd-page .rssd-page-footer::after{content:"";position:absolute;right:0;bottom:-8px;width:40px;height:4px;background:#000}'));
 assert.doesNotThrow(()=>checkCardStylesheet('.rssd-page .rssd-body{padding-top:12px;height:800px}'));
});

// Just enough of a laid-out card for checkVisibleText: elements with computed styles and text with boxes.
function card(texts,{box={left:0,top:0,right:720,bottom:960},pageStyle={}}={}){
 const styleOf=new Map(),view={getComputedStyle:el=>styleOf.get(el)};
 const doc={defaultView:view};const page={ownerDocument:doc,parentElement:null,getBoundingClientRect:()=>box};
 styleOf.set(page,{opacity:'1',...pageStyle});
 const nodes=texts.map(({text,style={},rects=[{left:60,top:100,right:400,bottom:130,width:340,height:30}]})=>{
  const el={parentElement:page};styleOf.set(el,{visibility:'visible',opacity:'1',fontSize:'24px',color:'rgb(20, 20, 20)',...style});
  return {textContent:text,parentElement:el,rects};
 });
 doc.createTreeWalker=()=>{let i=0;return {nextNode:()=>nodes[i++]||null};};
 doc.createRange=()=>{let node;return {selectNodeContents:n=>{node=n;},getClientRects:()=>node.rects};};
 return page;
}

test('after layout, text a style hides, fades, shrinks, clears or pushes off a card is reported by card',()=>{
 assert.deepEqual(checkVisibleText([card([{text:'可读的正文'},{text:'   '}])]),[]);
 const problems=checkVisibleText([card([{text:'第一段'}]),card([
  {text:'隐藏',style:{visibility:'hidden'}},{text:'变淡',style:{opacity:'.3'}},{text:'很小',style:{fontSize:'9px'}},
  {text:'透明',style:{color:'rgba(0, 0, 0, 0)'}},{text:'不画',rects:[]},{text:'出界',rects:[{left:600,top:900,right:760,bottom:990,width:160,height:90}]}])]);
 assert.deepEqual(problems,['card 2 ("隐藏") is hidden','card 2 ("变淡") is faded','card 2 ("很小") is smaller than 12px','card 2 ("透明") is transparent','card 2 ("不画") is not drawn','card 2 ("出界") runs off the card']);
 // A faded card fades everything on it.
 assert.match(checkVisibleText([card([{text:'正文'}],{pageStyle:{opacity:'.4'}})])[0],/faded/);
});

const note=body=>'---\ntitle: A title\nrssd-id: one\nrssd-section: methods\n---\n'+body;
const doc={createElement:()=>({innerHTML:'<p>body</p>',querySelectorAll:()=>[]})};
const base={doc,parseYaml:yaml.parse,render:async()=>{},clean:()=>{},readMedia:async()=>null,url:'https://metho.example',site:{id:'metho',name:'Metho'}};

test('the column stylesheet is chosen from the work, measured and drawn with it, and cards that hide text are refused',async()=>{
 let seenStyle,drawn=0,section;const frame={remove(){}};
 const result=await buildCards({...base,content:note('Text\n'),frame:()=>frame,cardCss:async source=>{section=source.sectionId;return '.rssd-page p{font-size:30px}';},
  engine:{paginate:async(_frame,_model,{extraStyle})=>{seenStyle=extraStyle;return {pages:[card([{text:'Text'}])],style:'base\n'+extraStyle};},
   rasterPage:async(_page,css)=>{drawn++;assert.match(css,/font-size:30px/);return new Blob(['x'],{type:'image/png'});}}});
 assert.equal(section,'methods');assert.equal(seenStyle,'.rssd-page p{font-size:30px}');assert.equal(drawn,1);assert.equal(result.styled,true);
 // Without a stylesheet the engine gets none and no visibility check runs on its pages.
 await buildCards({...base,content:note('Text\n'),frame:()=>frame,engine:{paginate:async(_f,_m,{extraStyle})=>{assert.equal(extraStyle,'');return {pages:['p'],style:'base'};},rasterPage:async()=>new Blob(['x'])}});
 drawn=0;
 await assert.rejects(buildCards({...base,content:note('Text\n'),frame:()=>frame,cardCss:'.rssd-page p{opacity:.2}',
  engine:{paginate:async()=>({pages:[card([{text:'Text',style:{opacity:'.2'}}])],style:'x'}),rasterPage:async()=>{drawn++;return new Blob(['x']);}}}),
  error=>error.code==='card_style_hides_text'&&/card 1 \("Text"\) is faded/.test(error.message));
 assert.equal(drawn,0,'nothing is drawn from a style that hides text');
});

test('the brief names the file, every element on a card, the column\'s colours and the rules',()=>{
 const brief=cardStyleBrief({siteName:'Metho',sectionId:'methods',sectionName:'方法',look:{layout:'technical',fontSize:24,lineHeight:1.75,ink:'#1f2a2b',paper:'#ffffff',accent:'#436d70'}});
 assert.match(brief,/card-styles\/methods\.css/);assert.match(brief,/Metho · 方法/);assert.match(brief,/accent: #436d70/);assert.match(brief,/layout: technical/);
 for(const [selector] of CARD_ELEMENTS)assert.ok(brief.includes(selector),selector);
 assert.match(brief,/starts with `\.rssd-page`/);assert.match(brief,/never words/);
});
