import test from 'node:test';
import assert from 'node:assert/strict';
import {readerCatalog,filterCatalog,readerArticle,mediaType,MEDIA_HOST} from '../src/reader.mjs';
import {b64,png} from './helpers.mjs';

test('the reader lists published works across pages, newest first, without writes',async()=>{
 const calls=[];
 const client={catalog:async(space,options)=>{calls.push([space,options]);
  return options.after===undefined?{generation:7,items:[{articleId:'old',title:'Old',lastmod:'2026-01-01T00:00:00Z'}],next:1}
   :{generation:7,items:[{articleId:'new',title:'New',lastmod:'2026-11-01T00:00:00Z'}],next:null};}};
 const items=await readerCatalog(client,'metho',{locale:'en'});
 assert.deepEqual(items.map(i=>i.articleId),['new','old']);
 assert.equal(calls[0][1].scope,'published');assert.equal(calls[0][1].locale,'en');
 assert.deepEqual([calls[1][1].after,calls[1][1].generation],[1,7]);
 await readerCatalog(client,'metho',{drafts:true});assert.equal(calls.at(-2)[1].scope,'all');
});

test('search matches title, summary and category',()=>{
 const items=[{title:'Climate data',summary:'',category:''},{title:'X',summary:'about PRISMA',category:''},{title:'Y',category:'学界'}];
 assert.equal(filterCatalog(items,'').length,3);
 assert.deepEqual(filterCatalog(items,'prisma').map(i=>i.title),['X']);
 assert.deepEqual(filterCatalog(items,'学界').map(i=>i.title),['Y']);
});

test('an article points its images at local placeholders and its links at the site',()=>{
 const detail={url:'/frontiers/a',publishedVersion:3,data:{title:'Title',summary:'S',date:'2026-11-03',author:'Ed',category:'News',
  markdown:'# Title\n\nSee [the list](/frontiers/) and [ext](https://x.org/).\n\n![a](/article-media/a.png)\n',
  assets:[{path:'/article-media/a.png',data:b64(png)},{path:'../escape.png',data:'x'}]}};
 const a=readerArticle(detail,{url:'https://metho.scholay.com/frontiers/a',publicationState:'published'});
 assert.equal(a.title,'Title');assert.ok(!a.markdown.startsWith('# Title'));
 assert.match(a.markdown,/\]\(https:\/\/metho\.scholay\.com\/frontiers\/\)/);
 assert.match(a.markdown,/\]\(https:\/\/x\.org\/\)/);
 assert.ok(a.markdown.includes('('+MEDIA_HOST+'a.png)'));
 assert.deepEqual(Object.keys(a.media),['a.png']);assert.equal(a.media['a.png'].type,'image/png');
 assert.equal(a.published,true);assert.equal(a.url,'https://metho.scholay.com/frontiers/a');
});

test('an article without a body is refused',()=>{
 assert.throws(()=>readerArticle({data:null}),e=>e.code==='invalid_response');
});

test('image types come from bytes before the file name',()=>{
 assert.equal(mediaType('a.jpg',b64(png)),'image/png');
 assert.equal(mediaType('a.webp','zzzz'),'image/webp');
 assert.equal(mediaType('a.bin','zzzz'),'application/octet-stream');
});
