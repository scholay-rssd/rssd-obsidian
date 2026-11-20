import test from 'node:test';
import assert from 'node:assert/strict';
import {cardIndex,readCardIndex,cloudCardOf,cloudCardPagePath,layoutMediaIds,layoutDocument} from '../src/cloud-cards.mjs';

const item=(over={})=>({id:'rendition-a',workId:'w1',locale:'zh-CN',variant:'ai-image',representation:'raster',source:{revision:2},pageCount:3,width:1080,height:1440,...over});

test('the index keeps the newest set of each work, language and variant',()=>{
 const index=cardIndex([item(),item({id:'rendition-b',source:{revision:1}}),item({id:'rendition-c',variant:'ai-code',representation:'layout',pageCount:7}),
  item({id:'rendition-d',locale:'en'}),item({id:'rendition-e',variant:'algorithm'}),item({id:'bad id',workId:'w2'}),item({id:'rendition-f',workId:'w3',pageCount:0})]);
 assert.deepEqual(Object.keys(index).sort(),['w1|en','w1|zh-CN']);
 assert.deepEqual(index['w1|zh-CN']['ai-image'],{id:'rendition-a',revision:2,representation:'raster',pages:3,width:1080,height:1440});
 assert.equal(index['w1|zh-CN']['ai-code'].pages,7);
 const same=cardIndex([item({id:'rendition-b'}),item({id:'rendition-a'})]);
 assert.equal(same['w1|zh-CN']['ai-image'].id,'rendition-b','two sets of one revision: the choice is stable');
});

test('the index is read page by page for both languages',async()=>{
 const asked=[];
 const index=await readCardIndex(async options=>{asked.push(options);
  if(options.locale==='en')return {items:[],next:null};
  return options.after?{items:[item({id:'rendition-z',workId:'w2'})],next:null}:{items:[item()],next:'rendition-a'};});
 assert.deepEqual(asked,[{locale:'zh-CN',limit:100},{locale:'zh-CN',limit:100,after:'rendition-a'},{locale:'en',limit:100}]);
 assert.deepEqual(Object.keys(index).sort(),['w1|zh-CN','w2|zh-CN']);
});

test('a set is shown only for the edition it was made for',()=>{
 const index=cardIndex([item()]);
 assert.equal(cloudCardOf(index,{workId:'w1',version:2,variant:'ai-image'}).id,'rendition-a');
 assert.equal(cloudCardOf(index,{workId:'w1',version:'2',variant:'ai-image'}).id,'rendition-a','frontmatter numbers may be text');
 assert.equal(cloudCardOf(index,{workId:'w1',version:3,variant:'ai-image'}),null,'the article changed since');
 assert.equal(cloudCardOf(index,{workId:'w1',locale:'en',version:2,variant:'ai-image'}),null);
 assert.equal(cloudCardOf(index,{workId:'w1',version:2,variant:'ai-code'}),null);
 assert.equal(cloudCardOf(index,{workId:undefined,version:2,variant:'ai-image'}),null);
 assert.equal(cloudCardPagePath('rendition-a',3),'.rssd/cloud-cards/rendition-a/03.png');
});

test('a layout page becomes a document that runs nothing and loads only its own images',()=>{
 const recipe={css:'.a{background:url(/api/rssd/v1/media/m2/raw)}',mediaIds:['m1'],pages:[{html:'<img src="https://post.example/api/rssd/v1/media/m1/raw">'}]};
 assert.deepEqual(layoutMediaIds(recipe).sort(),['m1','m2']);
 const doc=layoutDocument({css:recipe.css+'</style><script>x()</script>',html:recipe.pages[0].html+'<script>alert(1)</script><img src="/api/rssd/v1/media/m9/raw">',media:{m1:'blob:app://x/1',m2:'blob:app://x/2'}});
 assert.match(doc,/Content-Security-Policy" content="default-src 'none'; img-src blob: data:/);
 assert.match(doc,/<img src="blob:app:\/\/x\/1">/);assert.match(doc,/url\(blob:app:\/\/x\/2\)/);
 assert.doesNotMatch(doc,/<script>alert/);assert.doesNotMatch(doc,/<\/style><script>/);
 assert.match(doc,/<img src="">/,'an image it was not given is dropped');
});
