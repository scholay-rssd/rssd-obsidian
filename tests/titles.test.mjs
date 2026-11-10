import test from 'node:test';
import assert from 'node:assert/strict';
import {workLabel,labelText} from '../src/titles.mjs';

test('a work note is labelled by its title and date, not its ID',()=>{
 assert.deepEqual(workLabel({title:' 个人信息保护合规审计的主要规定 ',date:'2026-10-22'}),{title:'个人信息保护合规审计的主要规定',date:'10-22'});
 assert.equal(workLabel({title:'T',date:new Date('2026-11-03T00:00:00Z')}).date,'11-03');
 assert.equal(workLabel({title:'T',date:'2026-11-03T08:00:00+08:00'}).date,'11-03');
 assert.equal(workLabel({title:'T',date:'2016年2月1日'}).date,'2月1日');
 assert.equal(workLabel({title:'T'}).date,'');
});
test('a note without a title keeps its file name',()=>{
 assert.equal(workLabel({title:'  '}),null);assert.equal(workLabel(undefined),null);
 assert.equal(labelText(null),'');
});
test('tabs show the date before the title',()=>{
 assert.equal(labelText({title:'T',date:'10-22'}),'10-22 T');
 assert.equal(labelText({title:'T',date:''}),'T');
});
