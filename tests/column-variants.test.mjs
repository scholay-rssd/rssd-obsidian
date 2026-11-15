import test from 'node:test';
import assert from 'node:assert/strict';
import {VARIANTS,COLUMN_VARIANTS,columnVariant} from '../src/column-variants.mjs';
import {ARTICLE_THEMES,articleDesign,defaultArticleTheme,colours} from '../src/wechat-designs.mjs';
import {cardTemplates} from '../build-templates.mjs';

const c=colours({accent:'#436d70'});

test('every column the website has is given a variation, and only those',()=>{
 const templates=cardTemplates();
 assert.deepEqual(Object.keys(COLUMN_VARIANTS).sort(),Object.keys(templates).sort());
 for(const [site,columns] of Object.entries(templates)){
  assert.deepEqual(Object.keys(COLUMN_VARIANTS[site]).sort(),Object.keys(columns).sort(),site);
  for(const index of Object.values(COLUMN_VARIANTS[site]))assert.ok(Number.isInteger(index)&&VARIANTS[index],site+' names a variation that does not exist');
 }
});

test('within a site no two columns share both a theme and a variation',()=>{
 for(const [site,columns] of Object.entries(cardTemplates())){
  const seen=new Map();
  for(const [column,template] of Object.entries(columns)){
   const key=defaultArticleTheme(template.layout)+'/'+COLUMN_VARIANTS[site][column];
   assert.ok(!seen.has(key),`${site}: ${column} looks the same as ${seen.get(key)} (${key})`);seen.set(key,column);
  }
 }
});

test('variations differ from each other and stay safe to paste',()=>{
 assert.deepEqual(VARIANTS.map(v=>v.id),['plain','panel','ruled','soft']);
 for(const part of ['h3Mark','quote','img']){
  const values=VARIANTS.map(v=>v[part](c));assert.equal(new Set(values).size,VARIANTS.length,part+' repeats between variations');
  for(const value of values){
   assert.doesNotMatch(value,/class=|<script|position:|url\(|float:|white-space:nowrap/,part);
   for(const [,px] of value.matchAll(/(?:^|[;"\s])(?:min-|max-)?width:(\d+)px/g))assert.ok(Number(px)<=60,part+' has a fixed width');
  }
 }
});

test('the site\'s own style dresses a column in its variation of the theme; a general theme stays as it is',()=>{
 const statistics=articleDesign('journal',{id:'metho'},'statistics'),methods=articleDesign('technical',{id:'metho'},'methods'),experiments=articleDesign('technical',{id:'metho'},'experiments');
 assert.equal(statistics.variant,'plain');assert.equal(methods.variant,'panel');assert.equal(experiments.variant,'plain');
 assert.notEqual(methods.quote(c),experiments.quote(c),'two Technical columns of one site read differently');
 assert.ok(methods.quote(c).startsWith(ARTICLE_THEMES.technical.quote(c)),'a variation builds on the theme, not instead of it');
 assert.ok(methods.img(c).startsWith(ARTICLE_THEMES.technical.img(c)));
 assert.equal(methods.h3,ARTICLE_THEMES.technical.h3,'the sub-heading keeps the theme\'s type');
 assert.match(methods.h3Mark(c),/<span /);assert.equal(experiments.h3Mark(c),'');
 assert.equal(articleDesign('technical',null,'methods'),ARTICLE_THEMES.technical,'a numbered theme carries no column variation');
 assert.equal(columnVariant('metho','unknown').id,'plain');assert.equal(columnVariant('nowhere','methods').id,'plain');
});
