import test from 'node:test';
import assert from 'node:assert/strict';
import {latestPublications,publicationOf} from '../src/publications.mjs';
import {cardChips} from '../src/work-cards.mjs';

const rows=[
 {workId:'w1',locale:'zh-CN',revision:3,destinationId:'site-pets',state:'blocked',error:{message:'Receiver build failed with rssd_device_'+'a'.repeat(48)},title:'缅因猫',updatedAt:'2026-11-19T10:00:00Z'},
 {workId:'w1',locale:'zh-CN',revision:2,destinationId:'site-pets',state:'published',title:'缅因猫'},
 {workId:'w1',locale:'zh-CN',revision:3,destinationId:'channel-x',state:'queued',title:'缅因猫'},
 {workId:'w2',locale:'en',revision:1,destinationId:'site-pets',state:'queued',title:'Corgi'},
 {workId:'w3',locale:'zh-CN',revision:1,destinationId:'site-pets',state:'published',title:'同名'},
 {workId:'w4',locale:'zh-CN',revision:1,destinationId:'site-pets',state:'published',title:'同名'},
];
test('the newest website publication of each work and language is kept; other destinations are left out',()=>{
 const state=latestPublications(rows);
 assert.deepEqual(Object.keys(state.byWork).sort(),['w1|zh-CN','w2|en','w3|zh-CN','w4|zh-CN']);
 assert.equal(state.byWork['w1|zh-CN'].state,'blocked');assert.equal(state.byWork['w1|zh-CN'].revision,3);
 assert.doesNotMatch(state.byWork['w1|zh-CN'].error,/rssd_device_a/);
 assert.equal(publicationOf(state,{workId:'w2',locale:'en'}).state,'queued');
 assert.equal(publicationOf(state,{title:'缅因猫'}).state,'blocked','found by a title only one work has');
 assert.equal(publicationOf(state,{title:'同名'}),null,'a title two works share finds neither');
 assert.equal(publicationOf(null,{workId:'w1'}),null);
});
test('a stuck publication is a red mark on the card, one still going a quiet one, a finished one none',()=>{
 assert.deepEqual(cardChips({author:'a',category:'b',publication:{state:'blocked',revision:3,error:'build failed'}}).map(c=>[c.text,c.tone]),[['发布失败','danger']]);
 assert.match(cardChips({publication:{state:'failed',revision:3}})[0].title,/v3 没有完成/);
 assert.deepEqual(cardChips({author:'a',category:'b',publication:{state:'dispatching',revision:2}}).map(c=>c.text),['发布中']);
 assert.deepEqual(cardChips({publication:{state:'published',revision:2},author:'a',category:'b'}),[]);
});
