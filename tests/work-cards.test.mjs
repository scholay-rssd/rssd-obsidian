import test from 'node:test';
import assert from 'node:assert/strict';
import {agoText,cardChips,mediaName,textLength,lengthText,isBrandLine,noteFacts,writerOf} from '../src/work-cards.mjs';

const now=Date.parse('2026-11-12T12:00:00Z'),min=60000;
const texts=chips=>chips.map(chip=>chip.text);
const work={author:'研究方法',category:'方法百科',version:2,publishedVersion:2};

test('relative times read like the footer',()=>{
 assert.equal(agoText(now-20000,now),'just now');
 assert.equal(agoText(now-12*min,now),'12 min ago');
 assert.equal(agoText(now-3*60*min,now),'3 h ago');
 assert.equal(agoText(now-2*1440*min,now),'2 d ago');
 assert.equal(agoText(now+5*min,now),'just now','a clock a little ahead never shows a negative time');
});

test('a work with nothing to attend to has no chip, whatever the website shows',()=>{
 for(const site of [{version:2,publishedVersion:2},{version:3,publishedVersion:2},{version:1,publishedVersion:null},{version:1,publishedVersion:''}])
  assert.deepEqual(cardChips({...work,...site,state:'synced'}),[]);
 assert.deepEqual(texts(cardChips({...work,state:undefined})),[],'nothing is claimed before the state is known');
});

test('a card names what needs attention, most urgent first',()=>{
 assert.deepEqual(texts(cardChips({...work,state:'edited',version:3,publishedVersion:2})),['Edited'],'when it was edited is not the card\'s business');
 assert.deepEqual(texts(cardChips({...work,state:'edited',author:' '})),['Edited','No author']);
 assert.deepEqual(texts(cardChips({...work,state:'synced',category:''})),['No category']);
 assert.deepEqual(cardChips({...work,state:'synced',author:'',category:''}),[{text:'No author or category',tone:'danger',title:'Add the author and category in the work details'}],'one chip when both are missing');
 assert.deepEqual(texts(cardChips({...work,state:'conflict'})),['Conflict']);
 assert.deepEqual(texts(cardChips({...work,state:'saving'})),['Saving…']);
 assert.equal(cardChips({...work,state:'edited'})[0].tone,'warning');
});

test('a note not yet updated from the Center says so',()=>{
 assert.deepEqual(texts(cardChips({...work,state:'unlinked',publishedVersion:null})),['Not linked']);
});

test('only pictures in the media folder become thumbnails',()=>{
 assert.equal(mediaName('../article-media/74533b15.webp'),'74533b15.webp');
 assert.equal(mediaName('../../article-media/a.png'),'a.png','English notes are one folder deeper');
 assert.equal(mediaName('article-media/a.png|300'),'a.png');
 assert.equal(mediaName('https://metho.scholay.com/x.png'),null);
 assert.equal(mediaName('../article-media/../secret.png'),null);
 assert.equal(mediaName(undefined),null);
});

test('length counts Chinese characters and Latin words, not properties, pictures or link addresses',()=>{
 const note='---\ntitle: 很长的标题\nsummary: 摘要不算\n---\n# 生存分析\n\n研究结束时 Kaplan-Meier 曲线。\n\n![图](../article-media/a.webp)\n\n见[论文](https://example.com/a-b-c)。\n';
 // 生存分析 4, 研究结束时 5, Kaplan-Meier 1, 曲线 2, 见 1, 论文 2.
 assert.equal(textLength(note),15);
 assert.equal(textLength('The data aren’t independent.'),4);
 assert.equal(textLength(''),0);
});

test('length is short enough for a card',()=>{
 assert.equal(lengthText(860),'860 字');
 assert.equal(lengthText(9800),'9.8k 字');
 assert.equal(lengthText(2000),'2k 字');
 assert.equal(lengthText(12400),'12k 字');
 assert.equal(lengthText(1234,'en'),'1.2k words');
});

const origin='https://metho.scholay.com';
test('references are counted under their heading, and the brand line mounted among them is counted on its own',()=>{
 const zh='---\ntitle: T\n---\n# T\n\n正文 [链接](https://example.org)\n\n- 正文里的列表\n\n### 参考文献\n\n1. [Smith 2015](https://pmc.example/1)\n\n2. Jones 2022\n\n3. [研究方法](https://metho.scholay.com) · 仪式可以模仿，理解无法伪装\n';
 assert.deepEqual(noteFacts(zh,{origin}),{length:textLength(zh),references:2,brand:true});
 const en='## Method\n\n* a list in the body\n\n## References\n\n1. One\n2. Two\n3. Three\n\n10. [Research Methods](https://metho.scholay.com/) · Rituals can be imitated\n\n## Appendix\n\n1. not a reference\n';
 assert.deepEqual(noteFacts(en,{origin}),{length:textLength(en),references:3,brand:true},'an English brand line is recognised by its link');
 const notes='Text[^1].\n\n[^1]: A footnote source.\n';
 assert.deepEqual(noteFacts(notes,{origin}),{length:textLength(notes),references:1,brand:false},'footnote sources count as references');
 assert.equal(noteFacts(zh).brand,false,'without the site address nothing is taken for the brand line');
});
test('only a line that opens with a link to the site\'s own home page is its brand line',()=>{
 assert.equal(isBrandLine('[研究方法](https://metho.scholay.com)',origin),true);
 assert.equal(isBrandLine('[研究方法](https://metho.scholay.com/news/x/)',origin),false);
 assert.equal(isBrandLine('See [研究方法](https://metho.scholay.com)',origin),false);
 assert.equal(isBrandLine('[Other](https://other.example)',origin),false);
 assert.equal(isBrandLine('[研究方法](https://metho.scholay.com)',''),false);
});
test('the writer is the agent and model of the newest completed writing run',()=>{
 const run=(agentName,action,startedAt,extra={})=>({runId:'r',agentId:'a',agentName,action,startedAt,status:'completed',modelId:null,...extra});
 assert.deepEqual(writerOf({modelSignatures:[run('Codex','write','2026-11-02T02:37:00Z',{modelId:'gpt-6.1-terra[max]',modelName:'6.1 Terra (max)'}),run('Cursor','revise','2026-11-03T00:00:00Z',{modelId:'default[]',modelName:'Auto'})]}),
  {agent:'Codex',model:'6.1 Terra',label:'Codex · 6.1 Terra'},'a later revision does not make another agent the writer');
 assert.equal(writerOf({modelSignatures:[run('Codex','write','2026-11-01T00:00:00Z',{modelId:'gpt-6.1-terra[max]'}),run('Claude','write','2026-11-02T00:00:00Z',{modelName:'Opus 5.5'})]}).label,'Claude · Opus 5.5','the newest write wins');
 assert.equal(writerOf({modelSignatures:[run('Codex','write','2026-11-01T00:00:00Z',{modelId:'gpt-6.1-terra[max]'})]}).label,'Codex · gpt-6.1-terra','a model id stands in for a missing name');
 assert.equal(writerOf({modelSignatures:[run('Cursor','write','2026-11-05T12:54:00Z',{modelId:'default[]',modelName:'Auto'})]}).label,'Cursor · Auto');
 assert.equal(writerOf({modelSignatures:[run('Cursor','organize','2026-11-05T12:54:00Z',{modelId:'default[]'})]}).label,'Cursor','with no write, the newest run; no model when none was recorded');
 assert.equal(writerOf({modelSignatures:[{...run('Codex','write','2026-11-01T00:00:00Z'),status:'interrupted'}]}),null,'an interrupted run wrote nothing');
 for(const empty of [null,undefined,{},{modelSignatures:'x'},{modelSignatures:[]}])assert.equal(writerOf(empty),null);
});
