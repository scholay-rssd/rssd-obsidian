import test from 'node:test';
import assert from 'node:assert/strict';
import {wechatSource,wechatHtml,wechatManifest,copyRich} from '../src/wechat.mjs';
import {manifestProblems,isCurrent} from '../../contracts/output-package.mjs';
import {MEDIA_HOST} from '../src/reader.mjs';
import {yaml,png} from './helpers.mjs';
import {wechatTemplate,wechatSite} from '../src/wechat-template.mjs';
import {wechatTemplates,wechatSites} from '../build-templates.mjs';
import {WECHAT_DESIGNS,colours} from '../src/wechat-designs.mjs';
import {buildCards,cardModel,DEFAULT_CARD_TEMPLATE,CARD_SIZE} from '../src/cards.mjs';
import {cardTemplate} from '../src/wechat-template.mjs';
import {cardTemplates} from '../build-templates.mjs';

const note=(body,title='A title')=>'---\ntitle: '+title+'\nrssd-id: one\nrssd-section: frontiers\n---\n'+body;
// Just enough of an element for the orchestration; the styling engine itself needs a real browser.
function image(src){const attrs={src};return {attrs,removed:false,getAttribute:k=>attrs[k]??null,setAttribute:(k,v)=>{attrs[k]=v;},remove(){this.removed=true;}};}
function fakeDoc(images){return {createElement:()=>({textContent:' Body text \n\n\n\nMore ',querySelectorAll:selector=>selector==='img'?images.filter(i=>!i.removed):[]})};}

test('the body points images at placeholders and drops a repeated title heading',()=>{
 const source=wechatSource(note('# A title\n\nText\n\n![](../article-media/a.png)\n\n![[article-media/b.webp|wide]]\n'),yaml.parse);
 assert.equal(source.title,'A title');assert.doesNotMatch(source.markdown,/^# A title/);
 assert.ok(source.markdown.includes('![]('+MEDIA_HOST+'a.png)'));assert.ok(source.markdown.includes(MEDIA_HOST+'b.webp'));
 assert.deepEqual(source.media,['a.png','b.webp']);
 assert.match(wechatSource(note('# Another heading\n\nText\n'),yaml.parse).markdown,/^# Another heading/);
});
test('a note that is not a work is refused',()=>{
 assert.throws(()=>wechatSource('Plain note',yaml.parse),e=>e.code==='unlinked_work');
});
test('vault images are inlined, unknown ones are left out, and nothing else is read',async()=>{
 const images=[image(MEDIA_HOST+'a.png'),image(MEDIA_HOST+'gone.png'),image(MEDIA_HOST+'..%2Fsecret.png'),image('https://example.org/x.jpg')],read=[],order=[];
 const result=await wechatHtml({doc:fakeDoc(images),content:note('![](../article-media/a.png)\n\n![](../article-media/gone.png)\n'),parseYaml:yaml.parse,
  render:async(markdown,el)=>{order.push('render');assert.ok(markdown.includes(MEDIA_HOST+'a.png'));assert.ok(el);},
  readMedia:async name=>{read.push(name);return name==='a.png'?png:null;},
  engine:{embedClipboardImages:async root=>{order.push('embed');assert.equal(root.querySelectorAll('img').length,2);},wechatClipboardHtml:(root,template)=>{order.push('style');assert.deepEqual(template,{});return '<section>styled</section>';}}});
 assert.deepEqual(order,['render','embed','style']);
 assert.deepEqual(read,['a.png','gone.png']);
 assert.match(images[0].attrs.src,/^data:image\/png;base64,iVBOR/);
 assert.equal(images[1].removed,true);assert.equal(images[2].removed,true);assert.equal(images[3].attrs.src,'https://example.org/x.jpg');
 assert.deepEqual(result,{html:'<section>styled</section>',plain:'Body text\n\nMore',title:'A title',images:2,missing:['gone.png','../secret.png'],sectionId:'frontiers',styled:false,manifest:null});
});
test('rich and plain text go to the clipboard together, or the copy is refused',async()=>{
 const written=[];class Item{constructor(parts){this.parts=parts;}}
 await copyRich({html:'<p>x</p>',plain:'x'},{write:async items=>written.push(...items)},Item);
 assert.equal(written.length,1);assert.equal(written[0].parts['text/html'].type,'text/html');assert.equal(await written[0].parts['text/plain'].text(),'x');
 await assert.rejects(copyRich({html:'',plain:''},null,Item),e=>e.code==='clipboard_unavailable');
});
test('every space takes its site name and its sections\' templates from the website',()=>{
 const table=wechatTemplates(),sites=wechatSites();
 assert.deepEqual(Object.keys(table).sort(),['enter','legis','lingxi','metho','personal','pets','piggytuck','scholay-today','study','xsiching']);
 assert.deepEqual(Object.values(sites).map(s=>s.id).sort(),Object.keys(table).sort());
 assert.equal(wechatSite('academic',sites).id,'scholay-today');assert.equal(wechatSite('design',sites).id,'piggytuck');
 for(const site of Object.values(sites)){assert.ok(site.name);assert.ok(site.slogan);}
 const works=wechatTemplate('personal','works',table,sites);
 assert.match(works.accent,/^#[0-9a-f]{6}$/i);assert.ok(['serif','sans'].includes(works.family));
 assert.deepEqual(wechatTemplate('academic','briefings',table,sites),table['scholay-today'].briefings);
 assert.deepEqual(wechatTemplate('design','icons',table,sites),table.piggytuck.icons);
 assert.notEqual(wechatTemplate('metho','methods',table,sites).accent,wechatTemplate('metho','statistics',table,sites).accent);
 for(const [space,section] of [['metho','unknown'],['nowhere','works'],['__proto__','works'],['metho','constructor'],['',''],[undefined,undefined]])assert.equal(wechatTemplate(space,section,table,sites),null);
 assert.equal(wechatSite('nowhere',sites),null);assert.equal(wechatSite('__proto__',sites),null);
 assert.equal(wechatTemplate('metho','methods'),null,'a build without bundled templates keeps the default look');
 works.accent='changed';assert.notEqual(table.personal.works.accent,'changed');
});
test('every site has its own design and no two open a chapter or sign their name the same way',()=>{
 const sites=wechatSites(),c=colours({accent:'#436d70'});
 assert.deepEqual(Object.keys(WECHAT_DESIGNS).sort(),Object.values(sites).map(s=>s.id).sort());
 const seen={chapter:new Set(),masthead:new Set(),signature:new Set(),strong:new Set(),code:new Set()};
 for(const site of Object.values(sites)){
  const d=WECHAT_DESIGNS[site.id],s={name:'NAME',slogan:'SLOGAN',category:'CATEGORY'};
  const parts={chapter:d.chapter({n:2,total:5,html:'<em>Heading</em> &amp; more'},c),masthead:d.masthead(s,c),signature:d.signature(s,c),strong:d.strong(c),code:d.code(c)};
  assert.ok(parts.chapter.includes('<em>Heading</em> &amp; more'),site.id);assert.match(parts.chapter,/<h2 /,site.id);
  assert.ok(parts.masthead.includes('NAME')||site.id==='lingxi',site.id);assert.ok(parts.signature.includes('NAME')&&parts.signature.includes('SLOGAN'),site.id);
  for(const [key,value] of Object.entries(parts)){
   // WeChat drops classes, scripts and positioned boxes; a design must not depend on them.
   assert.doesNotMatch(value,/class=|<script|<style|position:|javascript:|url\(/i,site.id+' '+key);
   // Nothing is given a fixed width wider than a small ornament, so the article fits any column.
   for(const [,px] of value.matchAll(/(?:^|[;"\s])(?:min-|max-)?width:(\d+)px/g))assert.ok(Number(px)<=60,site.id+' '+key+' has a fixed width of '+px+'px');
   assert.doesNotMatch(value,/white-space:nowrap|overflow:hidden|float:/,site.id+' '+key);
   // A double quote inside a style value would end the attribute early and drop the rest of the style.
   assert.doesNotMatch(value,/="[^"]*"[^\s>]/,site.id+' '+key+' has a broken attribute');
   assert.ok(!seen[key].has(value),site.id+' repeats another site\'s '+key);seen[key].add(value);
  }
  assert.ok(d.masthead({name:'<b>&"x',slogan:'',category:''},c).indexOf('<b>')<0,site.id+' escapes its name');
 }
 assert.equal(colours({accent:'#ff0000'}).tint(.5),'rgba(255,0,0,0.5)');assert.equal(colours({accent:'red;x'}).accent,'#35695f');
});
test('decoration is applied last and plain text stays the article only',async()=>{
 const result=await wechatHtml({doc:fakeDoc([]),content:note('Text\n'),parseYaml:yaml.parse,render:async()=>{},readMedia:async()=>null,template:{accent:'#60558a'},
  decorate:(html,{look,source})=>{assert.equal(html,'<section>styled</section>');assert.equal(look.accent,'#60558a');assert.equal(source.sectionId,'frontiers');return '<section>decorated</section>';},
  engine:{embedClipboardImages:async()=>{},wechatClipboardHtml:()=>'<section>styled</section>'}});
 assert.equal(result.html,'<section>decorated</section>');assert.equal(result.plain,'Body text\n\nMore');
});
test('the look is chosen from the parsed work and reported with the result',async()=>{
 let seen;const result=await wechatHtml({doc:fakeDoc([]),content:note('Text\n'),parseYaml:yaml.parse,render:async()=>{},readMedia:async()=>null,
  template:source=>source.sectionId==='frontiers'?{accent:'#60558a'}:null,
  engine:{embedClipboardImages:async()=>{},wechatClipboardHtml:(_root,template)=>{seen=template;return '<section></section>';}}});
 assert.deepEqual(seen,{accent:'#60558a'});assert.equal(result.styled,true);assert.equal(result.sectionId,'frontiers');
});
test('a WeChat output carries a valid package manifest with what the platform asks for besides the body',async()=>{
 const content='---\ntitle: A title\nsummary: '+'很长的摘要'.repeat(30)+'\nauthor: ""\ndate: 2026-11-03\ncategory: News\nrssd-id: one\nrssd-section: frontiers\n---\nText\n\n![](../article-media/a.png)\n';
 const result=await wechatHtml({doc:fakeDoc([image(MEDIA_HOST+'a.png')]),content,parseYaml:yaml.parse,render:async()=>{},readMedia:async()=>null,
  pack:{site:{id:'metho',name:'研究方法'},style:'site',engineVersion:'0.1.1',version:3,publishedVersion:null,now:()=>new Date('2026-11-11T00:00:00Z')},
  engine:{embedClipboardImages:async()=>{},wechatClipboardHtml:()=>'<section>styled</section>'}});
 const m=result.manifest;assert.deepEqual(manifestProblems(m),[]);
 assert.equal(m.format,'wechat-article');assert.equal(m.articleId,'one');assert.equal(m.locale,'zh-CN');assert.equal(m.sectionId,'frontiers');assert.equal(m.style,'site');
 assert.deepEqual(m.site,{id:'metho',name:'研究方法'});assert.deepEqual(m.engine,{name:'rssd-obsidian',version:'0.1.1'});assert.equal(m.createdAt,'2026-11-11T00:00:00.000Z');
 assert.equal(m.source.version,3);assert.equal(m.source.publishedVersion,null);assert.match(m.source.hash,/^[a-f0-9]{64}$/);
 assert.equal(m.fields.title,'A title');assert.equal([...m.fields.digest].length,120);assert.ok(m.fields.digest.endsWith('…'));assert.equal(m.fields.cover,'a.png');assert.equal(m.fields.author,'');
 assert.deepEqual(m.files.map(f=>[f.path,f.role,f.type]),[['body.html','body','text/html'],['body.txt','text','text/plain']]);
 assert.equal(m.files[0].bytes,new TextEncoder().encode(result.html).length);assert.match(m.files[0].sha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(m.warnings.map(w=>w.code).sort(),['digest_shortened','image_missing','image_without_alt','missing_author']);
 // The same note gives the same source hash; an edit gives another, so a stale package can be told apart.
 const again=await wechatManifest({source:wechatSource(content,yaml.parse),html:'x',plain:'x',site:{id:'metho',name:''}});
 assert.ok(isCurrent(m,again.source.hash));
 const edited=await wechatManifest({source:wechatSource(content.replace('Text','Edited'),yaml.parse),html:'x',plain:'x',site:{id:'metho',name:''}});
 assert.equal(isCurrent(m,edited.source.hash),false);
});
test('every section has a page template for cards, and an unknown one falls back to the default',()=>{
 const table=cardTemplates(),sites=wechatSites();
 assert.deepEqual(Object.keys(table).sort(),Object.keys(wechatTemplates()).sort());
 const t=cardTemplate('metho','experiments',table,sites);
 for(const key of ['ink','accent','paper','family','layout','fontSize','lineHeight'])assert.ok(t[key]!==undefined,key);
 assert.deepEqual(cardTemplate('design','works',table,sites),table.piggytuck.works);assert.equal(cardTemplate('metho','unknown',table,sites),null);
 for(const site of Object.values(sites))assert.match(site.origin,/^https:\/\//);
 const source=wechatSource(note('Text\n'),yaml.parse);
 const model=cardModel({source,site:{id:'metho',name:'研究方法'},url:'https://metho.example',template:null,html:'<p>Text</p>'});
 assert.deepEqual(model.templates.pages,DEFAULT_CARD_TEMPLATE);assert.equal(model.title,'A title');assert.equal(model.url,'https://metho.example');assert.equal(model.locale,'zh-CN');
 assert.equal(cardModel({source,site:null,url:'https://x.example',template:{accent:'#111111',layout:'essay'},html:''}).templates.pages.layout,'essay');
});
test('cards are built from the note, lose no readable picture, and come with a valid package manifest',async()=>{
 const images=[image(MEDIA_HOST+'a.png'),image(MEDIA_HOST+'gone.png'),image('https://example.org/x.jpg')],removed=[];
 const doc={createElement:()=>({innerHTML:'<p>body</p>',querySelectorAll:selector=>selector==='img'?images.filter(i=>!i.removed):[]})};
 let seenModel,loaded,framed={removed:false,remove(){this.removed=true;}};const progress=[];
 const result=await buildCards({doc,content:note('![](../article-media/a.png)\n\n![](../article-media/gone.png)\n'),parseYaml:yaml.parse,render:async()=>{},clean:()=>{},
  readMedia:async name=>name==='a.png'?png:null,frame:()=>framed,site:{id:'metho',name:'研究方法'},url:'https://metho.example',template:source=>source.sectionId==='frontiers'?{layout:'dispatch'}:null,
  engineVersion:'0.1.1',version:2,now:()=>new Date('2026-11-11T00:00:00Z'),onProgress:step=>progress.push(step.stage+step.count),
  engine:{paginate:async(frame,model,{loadImage,onProgress})=>{seenModel=model;assert.equal(frame,framed);onProgress(1);loaded=await loadImage(MEDIA_HOST+'a.png');await assert.rejects(loadImage(MEDIA_HOST+'gone.png'),e=>e.code==='image_unreadable');return {pages:['p1','p2','p3'],style:'css'};},
   rasterPage:async(page,css,{scale})=>{assert.equal(css,'css');assert.equal(scale,1.5);return new Blob([page],{type:'image/png'});}}});
 assert.match(loaded,/^data:image\/png;base64,iVBOR/);assert.equal(framed.removed,true);
 assert.equal(images[0].removed,false);assert.equal(images[1].removed,true);assert.equal(images[2].removed,true);
 assert.deepEqual(result.missing,['gone.png','https://example.org/x.jpg']);assert.equal(seenModel.templates.pages.layout,'dispatch');assert.equal(seenModel.site.name,'研究方法');
 assert.deepEqual(result.pages.map(p=>p.name),['01.png','02.png','03.png']);assert.deepEqual(progress,['layout1','draw1','draw2','draw3']);
 assert.equal(result.caption,'A title');assert.deepEqual(result.size,CARD_SIZE);assert.equal(result.styled,true);
 const m=result.manifest;assert.deepEqual(manifestProblems(m),[]);assert.equal(m.format,'cards');assert.equal(m.fields.cover,'01.png');
 assert.deepEqual(m.files.map(f=>[f.path,f.role,f.bytes]),[['01.png','page',2],['02.png','page',2],['03.png','page',2],['caption.txt','text',7]]);
 assert.ok(m.warnings.some(w=>w.code==='image_missing'));assert.equal(m.source.version,2);
 // A failed layout still removes the measuring frame.
 const frame2={removed:false,remove(){this.removed=true;}};
 await assert.rejects(buildCards({doc,content:note('Text\n'),parseYaml:yaml.parse,render:async()=>{},clean:()=>{},readMedia:async()=>null,frame:()=>frame2,url:'https://x.example',engine:{paginate:async()=>{throw Error('lost text');},rasterPage:async()=>null}}),/lost text/);
 assert.equal(frame2.removed,true);
});
