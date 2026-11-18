import test from 'node:test';
import assert from 'node:assert/strict';
import {PHONE_ZOOM,TILE_ZOOMS,clampCardIndex,fitCardWidth,stepCardZoom,stepTileZoom,zoomLabel} from '../src/card-view.mjs';

test('a card index stays inside the set',()=>{
 assert.equal(clampCardIndex(-3,5),0);
 assert.equal(clampCardIndex(2,5),2);
 assert.equal(clampCardIndex(9,5),4);
 assert.equal(clampCardIndex(2,0),0);
 assert.equal(clampCardIndex(Number.NaN,4),0);
});

test('a fitted card is whole in the pane and never larger than half size',()=>{
 assert.equal(fitCardWidth(1200,900),540);
 assert.equal(fitCardWidth(1200,500),351);
 assert.equal(fitCardWidth(300,900),268);
 assert.equal(fitCardWidth(0,0),120);
 assert.equal(fitCardWidth(Number.NaN,400),120);
});

test('fit takes its place among the sizes, so zooming in never shrinks the card',()=>{
 // A tall pane: fit is half size, the same as the middle step.
 assert.equal(stepCardZoom('fit',1,0.5),1);
 assert.equal(stepCardZoom('fit',-1,0.5),PHONE_ZOOM);
 assert.equal(stepCardZoom(PHONE_ZOOM,1,0.5),'fit');
 assert.equal(stepCardZoom(1,-1,0.5),'fit');
 // A short pane: fit is smaller than a phone.
 assert.equal(stepCardZoom('fit',1,0.25),PHONE_ZOOM);
 assert.equal(stepCardZoom('fit',-1,0.25),'fit');
 assert.equal(stepCardZoom(PHONE_ZOOM,-1,0.25),'fit');
 // Between a phone and half size.
 assert.equal(stepCardZoom('fit',1,0.4),0.5);
 assert.equal(stepCardZoom(0.5,-1,0.4),'fit');
 assert.equal(stepCardZoom(1,1,0.4),1);
 assert.equal(stepCardZoom(1,-1,0.4),0.5);
 // Without a pane size, fit is the smallest.
 assert.equal(stepCardZoom('fit',1),PHONE_ZOOM);
 assert.equal(stepCardZoom(PHONE_ZOOM,-1),'fit');
});

test('tiles step through their sizes and stop at the ends',()=>{
 assert.equal(stepTileZoom(TILE_ZOOMS[0],-1),TILE_ZOOMS[0]);
 assert.equal(stepTileZoom(TILE_ZOOMS[0],1),PHONE_ZOOM);
 assert.equal(stepTileZoom(PHONE_ZOOM,1),0.5);
 assert.equal(stepTileZoom(1,1),1);
 assert.equal(stepTileZoom(1,-1),0.5);
});

test('the size control names fit and phone size, and shows the rest as a percentage',()=>{
 assert.equal(zoomLabel('fit'),'适应');
 assert.equal(zoomLabel(PHONE_ZOOM),'手机');
 assert.equal(zoomLabel(0.2),'20%');
 assert.equal(zoomLabel(1),'100%');
});
