import test from 'node:test';
import assert from 'node:assert/strict';
import {internalNotes,hasOpenChecks,runHistory,rowNotes,anchorMatches} from '../src/private-notes.mjs';

const record={
 internalNotes:{writing:'按 SMART 设计写',verification:'核对第 2 节的样本量',images:'  ',other:'无'},
 blockNotes:{p1:{notes:{verification:'这句需要出处'},anchor:{type:'paragraph',text:'一项治疗研究不仅可能要问**先用哪种治疗**。[^1]'}},empty:{notes:{}}},
 modelSignatures:[
  {agentName:'Codex',modelName:'6.1 Terra (max)',action:'revise',status:'completed',startedAt:'2026-11-05T13:00:00Z'},
  {agentName:'Cursor',modelId:'default[]',modelName:'Auto',action:'write',status:'completed',startedAt:'2026-11-05T12:52:00Z'},
 ],
};

test('internal notes are listed with what still needs doing first, blank ones left out',()=>{
 assert.deepEqual(internalNotes(record).map(n=>[n.label,n.text]),[['核对与待办','核对第 2 节的样本量'],['写作说明','按 SMART 设计写'],['其他备注','无']]);
 assert.equal(hasOpenChecks(record),true);assert.equal(hasOpenChecks({internalNotes:{verification:' '}}),false);
 for(const none of [null,undefined,{},{internalNotes:'x'}])assert.deepEqual(internalNotes(none),[]);
});

test('every run is listed oldest first, with its agent and model named the tidy way',()=>{
 assert.deepEqual(runHistory(record),[
  {at:'2026-11-05T12:52:00Z',action:'write',status:'completed',label:'Cursor · Auto'},
  {at:'2026-11-05T13:00:00Z',action:'revise',status:'completed',label:'Codex · 6.1 Terra'}]);
 assert.deepEqual(runHistory({}),[]);
});

test('row notes keep their anchor, and ones with nothing to say are dropped',()=>{
 const rows=rowNotes(record);
 assert.equal(rows.length,1);assert.equal(rows[0].anchor.type,'paragraph');assert.equal(rows[0].notes[0].label,'核对与待办');
});

test('a row note finds its paragraph in the rendered text, footnote markers and emphasis aside',()=>{
 assert.equal(anchorMatches('一项治疗研究不仅可能要问**先用哪种治疗**。[^1]','一项治疗研究不仅可能要问先用哪种治疗。1'),true);
 assert.equal(anchorMatches('一项治疗研究不仅可能要问**先用哪种治疗**。[^1]','一项治疗研究不仅可能要问先用哪种治疗。[1]'),true);
 const long='动态治疗策略要同时说明初始选择、何时评估、用什么信息判断，以及不同判断下采取什么后续行动。例如先给 A。';
 assert.equal(anchorMatches(long,long.replace('例如先给 A。','例如：先给 A；到第 8 周评估。')),true,'an edited ending still finds a long paragraph');
 assert.equal(anchorMatches('另一段话','一项治疗研究'),false);
 assert.equal(anchorMatches('','任何'),false);
});
