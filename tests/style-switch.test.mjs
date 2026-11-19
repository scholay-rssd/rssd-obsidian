import test from 'node:test';
import assert from 'node:assert/strict';
import {CARD_STYLE_ICONS,styleOptions,nextStyle} from '../src/style-switch.mjs';

const styles=[{id:'site',label:'算法排版'},{id:'ai-code',label:'智能排版'},{id:'ai-image',label:'模型生图'}];

test('the card styles are one group of three icons; a missing set keeps its place and says why',()=>{
 const options=styleOptions(styles,['site','ai-image'],'ai-image');
 assert.deepEqual(options.map(o=>[o.id,o.icon,o.available,o.active,o.name]),[
  ['site',CARD_STYLE_ICONS.site,true,false,'算法排版'],
  ['ai-code',CARD_STYLE_ICONS['ai-code'],false,false,'智能排版 · 暂无成品'],
  ['ai-image',CARD_STYLE_ICONS['ai-image'],true,true,'模型生图']]);
 assert.equal(new Set(Object.values(CARD_STYLE_ICONS)).size,3);
 assert.equal(styleOptions(styles,['site'],'ai-code').filter(o=>o.active).length,0);
});

test('arrow keys move between the styles that can be chosen, wrapping around',()=>{
 const options=styleOptions(styles,['site','ai-image'],'site');
 assert.equal(nextStyle(options,'site','ArrowRight'),'ai-image');
 assert.equal(nextStyle(options,'ai-image','ArrowRight'),'site');
 assert.equal(nextStyle(options,'site','ArrowLeft'),'ai-image');
 assert.equal(nextStyle(options,'ai-image','Home'),'site');
 assert.equal(nextStyle(options,'site','End'),'ai-image');
 assert.equal(nextStyle(options,'site','Enter'),null);
 assert.equal(nextStyle(styleOptions(styles,[],'site'),'site','ArrowRight'),null);
});
