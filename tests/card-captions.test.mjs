import test from 'node:test';
import assert from 'node:assert/strict';
import {citationParts,coverPicture,isCardCaption,typesetCardBody} from '../src/cards.mjs';

test('a numbered label is a caption anywhere; an unnumbered one only under its picture',()=>{
 assert.equal(isCardCaption('图 1：犬钩虫卵',false),true);
 assert.equal(isCardCaption('表二｜三种方法的检出数',false),true);
 assert.equal(isCardCaption('图：犬钩虫卵的显微镜照片。',true),true);
 assert.equal(isCardCaption('图：犬钩虫卵的显微镜照片。',false),false);
 assert.equal(isCardCaption('表：检出样本数',true),true);
 assert.equal(isCardCaption('Figure: a hookworm egg',true),true);
 assert.equal(isCardCaption('Fig. 2: a hookworm egg',true),true);
 assert.equal(isCardCaption('图书馆在这里',true),false);
 assert.equal(isCardCaption('带猫狗体检时，兽医常会要一份粪便样本。',true),false);
 assert.equal(isCardCaption('',true),false);
});

// The smallest document the typesetter needs: block children in order, each with a tag, text and classes.
function block(tagName,text='',{img=false}={}){
 const classes=new Set(),children=[];
 const picture=img?{className:img===true?'':img,classList:{add:name=>classes.add(name)}}:null;
 return {tagName,get textContent(){return text;},classList:{add:name=>classes.add(name),contains:name=>classes.has(name)},classes,children,
  querySelector:selector=>selector==='img'?picture:null,prepend(node){children.unshift(node);},previousElementSibling:null,nextElementSibling:null};
}
function body(blocks){
 const link=()=>blocks.forEach((item,index)=>{item.previousElementSibling=blocks[index-1]||null;item.nextElementSibling=blocks[index+1]||null;});
 link();
 // Text nodes are walked in a real document; here there are none to visit.
 return {children:blocks,prepend(...moved){for(const item of moved)blocks.splice(blocks.indexOf(item),1);blocks.unshift(...moved);link();},ownerDocument:{createElement:tag=>({tagName:tag.toUpperCase(),className:''}),createTreeWalker:()=>({nextNode:()=>null})}};
}
const indented=item=>item.children[0]?.className==='rssd-indent';

test('captions are marked and Chinese body paragraphs get a leading indent, but notes and captions do not',()=>{
 const lead=block('P','带猫狗体检时，兽医常会要一份粪便样本。'),picture=block('P','',{img:true}),caption=block('P','图：犬钩虫卵的显微镜照片。'),
  heading=block('H2','三种方法分别是什么'),text=block('P','研究比较的三种检测是：'),list=block('UL','硫酸锌离心漂浮法'),
  references=block('H2','参考文献'),entry=block('P','[1] Jimenez Castro PD, et al.');
 typesetCardBody(body([lead,picture,caption,heading,text,list,references,entry]),'zh-CN');
 assert.equal(caption.classes.has('rssd-caption'),true);
 assert.deepEqual([lead,text].map(indented),[true,true]);
 assert.deepEqual([picture,caption,list,entry].map(indented),[false,false,false,false]);
 // Everything under the closing heading is a note; the heading and the body are not.
 assert.deepEqual([lead,text,list,references,entry].map(item=>item.classes.has('rssd-note')),[false,false,false,false,true]);
});

test('other languages keep flush paragraphs and still mark captions',()=>{
 const lead=block('P','Vets often ask for a stool sample.'),picture=block('IMG'),caption=block('P','Figure: a hookworm egg.');
 typesetCardBody(body([lead,picture,caption]),'en');
 assert.equal(indented(lead),false);assert.equal(caption.classes.has('rssd-caption'),true);
});

test('citation markers are cut out of running text in order',()=>{
 assert.deepEqual(citationParts('比较它们各能查出多少。[1]'),[{text:'比较它们各能查出多少。',cite:false},{text:'[1]',cite:true}]);
 assert.deepEqual(citationParts('[2, 3] 之后还有 [4–6]。'),[{text:'[2, 3]',cite:true},{text:' 之后还有 ',cite:false},{text:'[4–6]',cite:true},{text:'。',cite:false}]);
 assert.deepEqual(citationParts('没有标记，[注] 和 [a1] 不是。'),[{text:'没有标记，[注] 和 [a1] 不是。',cite:false}]);
 assert.deepEqual(citationParts(''),[]);
});

test('the closing references are notes whether their heading is h2, h3 or a bold line',()=>{
 for(const heading of [block('H2','参考文献'),block('H3','参考文献'),block('P','参考文献')]){
  const lead=block('P','正文。'),entry=block('OL','ASPCA Encourages Pet Adoption Nationwide');
  typesetCardBody(body([lead,heading,entry]),'zh-CN');
  assert.equal(entry.classes.has('rssd-note'),true);
  assert.equal(indented(heading),false);assert.equal(indented(lead),true);
 }
 // A later ordinary heading ends the notes.
 const entry=block('P','[1] 来源'),later=block('H2','后记'),after=block('P','后面的正文。');
 typesetCardBody(body([block('H2','参考文献'),entry,later,after]),'zh-CN');
 assert.equal(entry.classes.has('rssd-note'),true);assert.equal(after.classes.has('rssd-note'),false);assert.equal(indented(after),true);
});

test('the first picture and its caption move under the title for the cover',()=>{
 const lead=block('P','带猫狗体检时，兽医常会要一份粪便样本。'),formula=block('P','',{img:'rssd-math-block'}),picture=block('P','',{img:true}),
  caption=block('P','图：犬钩虫卵的显微镜照片。'),text=block('P','研究比较的三种检测是：'),second=block('P','',{img:true});
 const host=body([lead,formula,picture,caption,text,second]);
 typesetCardBody(host,'zh-CN');
 assert.equal(coverPicture(host),true);
 assert.deepEqual(host.children,[picture,caption,lead,formula,text,second]);
 assert.equal(picture.classes.has('rssd-cover-picture'),true);assert.equal(second.classes.has('rssd-cover-picture'),false);
 // A work that already opens with its picture is left in order, and one without pictures is left alone.
 const opening=block('P','',{img:true}),after=block('P','正文。'),ordered=body([opening,after]);
 assert.equal(coverPicture(ordered),true);assert.deepEqual(ordered.children,[opening,after]);
 const plain=body([block('P','只有文字。'),block('P','',{img:'rssd-math'})]);
 assert.equal(coverPicture(plain),false);
});
