import test from 'node:test';
import assert from 'node:assert/strict';
import {isCardCaption,typesetCardBody} from '../src/cards.mjs';

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
 return {tagName,get textContent(){return text;},classList:{add:name=>classes.add(name),contains:name=>classes.has(name)},classes,children,
  querySelector:selector=>selector==='img'&&img?{}:null,prepend(node){children.unshift(node);},previousElementSibling:null};
}
function body(blocks){
 blocks.forEach((item,index)=>{item.previousElementSibling=blocks[index-1]||null;});
 return {children:blocks,ownerDocument:{createElement:tag=>({tagName:tag.toUpperCase(),className:''})}};
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
});

test('other languages keep flush paragraphs and still mark captions',()=>{
 const lead=block('P','Vets often ask for a stool sample.'),picture=block('IMG'),caption=block('P','Figure: a hookworm egg.');
 typesetCardBody(body([lead,picture,caption]),'en');
 assert.equal(indented(lead),false);assert.equal(caption.classes.has('rssd-caption'),true);
});
