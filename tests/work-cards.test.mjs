import test from 'node:test';
import assert from 'node:assert/strict';
import {agoText,cardChips,mediaName,textLength,lengthText} from '../src/work-cards.mjs';

const now=Date.parse('2026-11-12T12:00:00Z'),min=60000;
const texts=chips=>chips.map(chip=>chip.text);
const work={author:'研究方法',category:'方法百科',version:2,publishedVersion:2,modified:now-12*min};

test('relative times read like the footer',()=>{
 assert.equal(agoText(now-20000,now),'just now');
 assert.equal(agoText(now-12*min,now),'12 min ago');
 assert.equal(agoText(now-3*60*min,now),'3 h ago');
 assert.equal(agoText(now-2*1440*min,now),'2 d ago');
 assert.equal(agoText(now+5*min,now),'just now','a clock a little ahead never shows a negative time');
});

test('a work that matches the Center and is live says so with one plain chip',()=>{
 assert.deepEqual(cardChips({...work,state:'synced'},now),[{text:'Live',tone:'plain',title:'Matches the Center, and the site shows this version'}]);
 assert.deepEqual(texts(cardChips({...work,state:undefined},now)),[],'nothing is claimed before the state is known');
});

test('a card names what needs attention, most urgent first',()=>{
 assert.deepEqual(texts(cardChips({...work,state:'edited',version:3},now)),['Edited 12 min ago','Site shows v2, draft v3']);
 assert.deepEqual(texts(cardChips({...work,state:'synced',publishedVersion:null,author:' '},now)),['Never published','No author']);
 assert.deepEqual(texts(cardChips({...work,state:'synced',publishedVersion:'',category:''},now)),['Never published','No category'],'an empty property is never published, not version 0');
 assert.deepEqual(cardChips({...work,state:'synced',author:'',category:''},now),[{text:'No author or category',tone:'danger',title:'Add the author and category in the work details'}],'one chip when both are missing');
 assert.deepEqual(texts(cardChips({...work,state:'conflict'},now)),['Conflict']);
 assert.deepEqual(texts(cardChips({...work,state:'saving'},now)),['Saving…']);
 assert.equal(cardChips({...work,state:'edited'},now)[0].tone,'warning');
});

test('a note not yet updated from the Center makes no claim about the site',()=>{
 assert.deepEqual(texts(cardChips({...work,state:'unlinked',publishedVersion:null},now)),['Not linked']);
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
