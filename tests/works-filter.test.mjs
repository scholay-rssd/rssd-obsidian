import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyFilter,normalizeFilter,matches,facetCounts,narrowedBy,activeChips,withoutChip,toggled,dateRangeText,datePreset,NO_WRITER} from '../src/works-filter.mjs';

const work=(id,extra={})=>({id,title:'T '+id,summary:'S '+id,date:'2026-11-10',locale:'zh-CN',section:'methods',author:'研究方法',category:'方法百科',...extra});
const works=[
 work('a',{section:'methods',date:'2026-11-11'}),
 work('b',{section:'statistics',date:'2026-11-05',author:''}),
 work('c',{section:'methods',date:'2026-10-20'}),
 work('d',{section:'frontiers',date:'2026-11-01',locale:'en'}),
];
const writers={a:'Codex · 6.1 Terra',b:'Cursor · Auto',c:null,d:'Codex · 6.1 Terra'},states={a:'edited',b:'synced',c:'conflict',d:'synced'};
const context=w=>({state:states[w.id],writer:writers[w.id]});
const ids=filter=>works.filter(w=>matches(w,filter,context(w))).map(w=>w.id);

test('an empty filter lists every work of the language on screen',()=>{
 assert.deepEqual(ids(emptyFilter()),['a','b','c']);
 assert.deepEqual(ids(emptyFilter('en')),['d']);
 assert.equal(narrowedBy(emptyFilter('en')),0,'the language is a choice of list, not a narrowing');
});

test('several sections or writers may be chosen, and any of them matches',()=>{
 assert.deepEqual(ids({...emptyFilter(),sections:['methods','statistics']}),['a','b','c']);
 assert.deepEqual(ids({...emptyFilter(),sections:['statistics']}),['b']);
 assert.deepEqual(ids({...emptyFilter(),writers:['Codex · 6.1 Terra','Cursor · Auto']}),['a','b']);
 assert.deepEqual(ids({...emptyFilter(),writers:[NO_WRITER]}),['c'],'works with no recorded writer can be listed on their own');
});

test('facets combine: every chosen facet must match',()=>{
 const filter={...emptyFilter(),status:'edited',sections:['methods'],writers:['Codex · 6.1 Terra']};
 assert.deepEqual(ids(filter),['a']);assert.equal(narrowedBy(filter),3);
 assert.deepEqual(ids({...emptyFilter(),status:'edited'}),['a','c'],'a conflict counts as edited');
 assert.deepEqual(ids({...emptyFilter(),status:'check'}),['b']);
});

test('a date range includes both ends, and a work without a date drops out once a range is set',()=>{
 assert.deepEqual(ids({...emptyFilter(),from:'2026-11-05',to:'2026-11-11'}),['a','b']);
 assert.deepEqual(ids({...emptyFilter(),from:'2026-11-01'}),['a','b']);
 assert.deepEqual(ids({...emptyFilter(),to:'2026-10-31'}),['c']);
 assert.equal(matches(work('x',{date:''}),{...emptyFilter(),from:'2026-01-01'},{}),false);
 assert.equal(matches(work('x',{date:''}),emptyFilter(),{}),true);
});

test('search narrows within the filter',()=>{
 assert.equal(matches(works[0],emptyFilter(),{query:'s a'}),true);
 assert.equal(matches(works[0],emptyFilter(),{query:'nothing'}),false);
});

test('each option is counted with every other facet applied but its own',()=>{
 const counts=facetCounts(works,{...emptyFilter(),sections:['methods'],status:'edited'},context);
 assert.deepEqual(counts.status,{all:2,edited:2,check:0},'status counts ignore the status choice but keep the section');
 assert.deepEqual(Object.fromEntries(counts.sections),{methods:2},'a section with no edited work has no count');
 assert.deepEqual(Object.fromEntries(counts.writers),{'Codex · 6.1 Terra':1,[NO_WRITER]:1});
 assert.deepEqual(counts.locale,{'zh-CN':2,en:0});
 assert.equal(counts.dates,2,'what the whole filter lists');
 const plain=facetCounts(works,emptyFilter(),context,'');
 assert.deepEqual(Object.fromEntries(plain.sections),{methods:2,statistics:1});assert.deepEqual(plain.locale,{'zh-CN':3,en:1});
});

test('stored or hand-built filters are cleaned, and an inverted range is put the right way round',()=>{
 assert.deepEqual(normalizeFilter(null),emptyFilter());
 assert.deepEqual(normalizeFilter({status:'nope',locale:'fr',sections:['a','a',3],writers:'x',from:'2026-11-10',to:'2026-11-01'}),
  {status:'all',locale:'zh-CN',sections:['a'],writers:[],from:'2026-11-01',to:'2026-11-10'});
 assert.deepEqual(normalizeFilter({from:'11/01/2026'}).from,'');
});

test('chosen values show as chips that each remove only themselves',()=>{
 const filter={...emptyFilter(),status:'check',sections:['methods','statistics'],writers:[NO_WRITER],from:'2026-11-01',to:'2026-11-10'};
 const chips=activeChips(filter,{sectionName:id=>({methods:'方法百科',statistics:'统计之美'})[id]});
 assert.deepEqual(chips.map(c=>c.text),['To check','方法百科','统计之美','Writer not recorded','11-01 – 11-10']);
 assert.deepEqual(withoutChip(filter,chips[1]).sections,['statistics']);
 assert.equal(withoutChip(filter,chips[0]).status,'all');
 assert.deepEqual([withoutChip(filter,chips[4]).from,withoutChip(filter,chips[4]).to],['','']);
 assert.deepEqual(toggled(toggled(emptyFilter(),'writers','Cursor · Auto'),'writers','Codex · 6.1 Terra').writers,['Cursor · Auto','Codex · 6.1 Terra']);
 assert.deepEqual(toggled({...emptyFilter(),sections:['methods']},'sections','methods').sections,[]);
});

test('date ranges read briefly, and quick ranges end today',()=>{
 assert.equal(dateRangeText('2026-11-01','2026-11-10'),'11-01 – 11-10');
 assert.equal(dateRangeText('2026-11-01',''),'From 11-01');assert.equal(dateRangeText('','2026-11-10'),'Until 11-10');
 assert.equal(dateRangeText('2026-11-03','2026-11-03'),'11-03');
 const today=new Date('2026-11-12T10:00:00Z');
 assert.deepEqual(datePreset('7d',today),{from:'2026-11-06',to:'2026-11-12'});
 assert.deepEqual(datePreset('30d',today),{from:'2026-10-14',to:'2026-11-12'});
 assert.deepEqual(datePreset('month',today),{from:'2026-11-01',to:'2026-11-12'});
});
