import test from 'node:test';
import assert from 'node:assert/strict';
import {postText,safeName,cardFileName,exportFolderName,exportFiles,postTextFile} from '../src/card-export.mjs';

test('the post text keeps each part whole and says when one is over its limit',()=>{
 const long='长'.repeat(25),post=postText({title:long,summary:'  一段摘要。 ',tags:['#宠物','宠物','狗 狗','']});
 const [title,body,tags]=post.parts;
 assert.equal(title.text,long,'nothing is shortened');assert.equal(title.count,25);assert.equal(title.limit,20);assert.equal(title.over,true);
 assert.equal(body.text,'一段摘要。');assert.equal(body.over,false);
 assert.equal(tags.text,'#宠物 #狗狗','tags lose a leading # and spaces, and repeat once');assert.equal(tags.count,2);
 assert.equal(post.all,long+'\n\n一段摘要。\n\n#宠物 #狗狗');
 const bare=postText({title:'只有标题'});
 assert.equal(bare.all,'只有标题','empty parts are left out of the whole');
 assert.deepEqual(bare.parts.map(part=>part.text),['只有标题','','']);
});

test('exported cards get names the computer accepts and never replace an earlier export',()=>{
 assert.equal(safeName('a/b:c*?'),'a b c');assert.equal(safeName('...'),'cards');assert.equal(safeName(''),'cards');
 assert.equal(cardFileName('比熊犬：护理',{name:'01.png'}),'比熊犬：护理-01.png','a full-width colon is a letter, not a path separator');
 const there=new Set(['work','work (2)']);
 assert.equal(exportFolderName('work',name=>there.has(name)),'work (3)');
 assert.equal(exportFolderName('work',()=>false,'en'),'work (en)');
 const blob={};
 assert.deepEqual(exportFiles({pages:[{name:'01.png',blob}],post:postText({title:'T'}),locale:'zh-CN'}),[{name:'01.png',blob},{name:'文案.txt',text:'T\n'}]);
 assert.equal(postTextFile('en'),'caption.txt');
 assert.deepEqual(exportFiles({pages:[],post:postText({}),locale:'en'}),[],'no text file when there is no text');
});
