import test from 'node:test';
import assert from 'node:assert/strict';
import {clampCardIndex,stepCardZoom} from '../src/card-view.mjs';

test('a card index stays inside the set',()=>{
 assert.equal(clampCardIndex(-3,5),0);
 assert.equal(clampCardIndex(2,5),2);
 assert.equal(clampCardIndex(9,5),4);
 assert.equal(clampCardIndex(2,0),0);
 assert.equal(clampCardIndex(Number.NaN,4),0);
});

test('zooming out from the smallest size returns to fit, and fit zooms in',()=>{
 assert.equal(stepCardZoom('fit',-1),'fit');
 assert.equal(stepCardZoom('fit',1),0.5);
 assert.equal(stepCardZoom(0.5,-1),'fit');
 assert.equal(stepCardZoom(0.5,1),0.75);
 assert.equal(stepCardZoom(1,1),1.5);
 assert.equal(stepCardZoom(1.5,1),1.5);
 assert.equal(stepCardZoom(0.62,1),0.75);
});
