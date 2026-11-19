import test from 'node:test';
import assert from 'node:assert/strict';
import {missingAnswers,answerSheet,sheetFromSaved,draftKey,unavailableReason,sheetItems} from '../src/annotation-model.mjs';
import {createCenterClient} from '../src/center-client.mjs';

// Sections in the shape the Center sends, with the item IDs of form version 1 that these tests name.
const anchors={1:'低',3:'中',5:'高'},options=[{id:'accurate',label:'准确'},{id:'two-part',label:'两截'}];
const sections=[
 {id:'article-facts',title:'事实与来源',items:[{id:'fact-spot-check',type:'check',text:'抽查',note:true},{id:'references-match',type:'check',text:'对应'}]},
 {id:'article-answer',title:'是否回答了问题',items:[{id:'title-fit',type:'choice',text:'标题',options},{id:'density',type:'scale',text:'密度',anchors}]},
 {id:'article-images',title:'配图',items:[{id:'captions',type:'check',text:'图注',optional:true}]},
];
// With the form contract at hand (a core checkout that has it), the same checks run against the real form too.
const contract=await import('../../contracts/annotation-forms.mjs').catch(()=>null);
const fill=()=>Object.fromEntries(sheetItems(sections).map(item=>[item.id,{value:item.type==='scale'?4:item.type==='check'?false:item.options.at(-1).id}]));

test('a sheet is complete when every required item of the shown sections is answered',()=>{
 assert.equal(missingAnswers(sections,{}).length,sheetItems(sections).filter(item=>!item.optional).length);
 const answers=fill();assert.deepEqual(missingAnswers(sections,answers),[]);
 const optional=sheetItems(sections).find(item=>item.optional);delete answers[optional.id];assert.deepEqual(missingAnswers(sections,answers),[]);
 answers.density={value:9};answers['title-fit']={value:'not-an-option'};answers['fact-spot-check']={value:'yes'};
 assert.deepEqual(missingAnswers(sections,answers).map(item=>item.id),['fact-spot-check','title-fit','density']);
});
test('what is sent passes the form\'s own check; notes go only where an item takes one',()=>{
 const answers=fill();answers['fact-spot-check'].note='  第三段的年份查不到出处  ';answers.density.note='这题不收备注';answers['no-such-item']={value:1};
 const sheet=answerSheet(sections,answers);
 assert.equal(sheet['fact-spot-check'].note,'第三段的年份查不到出处');assert.equal('note' in sheet.density,false);assert.equal('no-such-item' in sheet,false);
 if(contract){
  const work={workType:'article',family:'animal',cards:true},real=contract.annotationSectionsFor(contract.ANNOTATION_FORM,work);
  const full=Object.fromEntries(sheetItems(real).map(item=>[item.id,{value:item.type==='scale'?4:item.type==='check'?false:item.options.at(-1).id}]));
  assert.deepEqual(missingAnswers(real,full),[]);
  const sent=answerSheet(real,full);assert.deepEqual(contract.validateAnnotationAnswers(contract.ANNOTATION_FORM,work,sent),sent);
 }
 // A false and a 1 are answers, not blanks.
 assert.equal(sheet['fact-spot-check'].value,false);assert.equal(answerSheet(sections,{density:{value:1}}).density.value,1);
});
test('a saved sheet is read back for editing, without items the form no longer shows',()=>{
 const saved={'fact-spot-check':{value:true,note:'查到了'},density:{value:5},'legal-jurisdiction':{value:true},'title-fit':{value:'gone'}};
 assert.deepEqual(sheetFromSaved(sections,saved),{'fact-spot-check':{value:true,note:'查到了'},density:{value:5}});
 assert.deepEqual(sheetFromSaved(sections,null),{});
});
test('a draft is kept per work, language, revision and form version; refusals are explained',()=>{
 const base={origin:'https://c.example',workspaceId:'pets',articleId:'a1',locale:'zh-CN',revision:2,formVersion:'1'};
 assert.notEqual(draftKey(base),draftKey({...base,revision:3}));assert.notEqual(draftKey(base),draftKey({...base,formVersion:'2'}));assert.equal(draftKey(base),draftKey({...base}));
 assert.match(unavailableReason({status:409,code:'not_published'}),/已发布/);assert.match(unavailableReason({status:409,code:'not_annotatable'}),/不做标注/);
 assert.match(unavailableReason({status:404,code:'http_error'}),/不支持标注/);assert.match(unavailableReason({status:404,code:'not_found'}),/找不到/);
 assert.equal(unavailableReason({status:500,code:'server_error'}),null);
});
test('the Center client reaches the annotation endpoints',async()=>{
 const requests=[],http=async request=>{requests.push(request);return {status:200,json:{}};};
 const client=createCenterClient({http,origin:'https://center.example.org',token:'rssd_device_'+'a'.repeat(48)});
 await client.annotationTarget('pets','news-one','zh-CN');await client.submitAnnotation({workspaceId:'pets',articleId:'news-one',formVersion:'1',answers:{}});
 assert.equal(requests[0].url,'https://center.example.org/api/rssd/v1/annotations/target?workspaceId=pets&articleId=news-one&locale=zh-CN');
 assert.deepEqual([requests[1].method,requests[1].url],['POST','https://center.example.org/api/rssd/v1/annotations']);
});
