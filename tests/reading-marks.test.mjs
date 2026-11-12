import test from 'node:test';
import assert from 'node:assert/strict';
import {OUTPUT_ATTRIBUTE,inOutput,stripReadingMarks} from '../src/reading-marks.mjs';

// Just enough of the DOM for the selectors the module uses: ".class" and "[attribute]", comma-separated.
class Node{
 constructor(classes=[],attributes={},children=[]){
  this.classList=new Set(classes);this.classList.remove=name=>Set.prototype.delete.call(this.classList,name);
  this.attributes=new Map(Object.entries(attributes));this.children=[];this.parent=null;for(const child of children)this.append(child);
 }
 append(child){child.parent=this;this.children.push(child);return child;}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);this.parent=null;}
 setAttribute(name,value){this.attributes.set(name,value);}
 removeAttribute(name){this.attributes.delete(name);}
 matches(selectors){return selectors.split(',').some(one=>{one=one.trim();return one.startsWith('.')?this.classList.has(one.slice(1)):this.attributes.has(one.slice(1,-1));});}
 querySelectorAll(selectors){const found=[];const walk=node=>{for(const child of node.children){if(child.matches(selectors))found.push(child);walk(child);}};walk(this);return found;}
 closest(selectors){for(let node=this;node;node=node.parent)if(node.matches(selectors))return node;return null;}
 count(selectors){return this.querySelectorAll(selectors).length;}
}

test('a block rendered for an output is left undecorated, a reading-view block is not',()=>{
 const host=new Node([], {[OUTPUT_ATTRIBUTE]:''}),block=host.append(new Node());
 assert.equal(inOutput(block),true);assert.equal(inOutput(host),true);
 assert.equal(inOutput(new Node().append(new Node())),false);
 assert.equal(inOutput(null),false);
});

test('an output keeps none of the reading view\'s marks, and internal row notes above all',()=>{
 const picture=new Node(['image-embed']),paragraph=new Node([],{'data-rssd-row-note':'1'});
 const host=new Node([],{[OUTPUT_ATTRIBUTE]:''},[
  new Node([],{},[new Node(['rssd-context'])]),
  new Node([],{},[picture,new Node(['rssd-figcaption','is-missing'])]),
  new Node([],{},[paragraph,new Node(['rssd-row-note-mark']),new Node(['rssd-row-note-box'],{},[new Node(['rssd-row-note-text'])])]),
  new Node(['rssd-reference-block']),
  new Node([],{},[new Node(['rssd-brand-line'])]),
 ]);
 assert.equal(stripReadingMarks(host),4);
 for(const name of ['rssd-context','rssd-figcaption','rssd-row-note-mark','rssd-row-note-box','rssd-row-note-text','rssd-reference-block','rssd-brand-line'])
  assert.equal(host.count('.'+name),0,name+' is gone');
 assert.equal(host.count('[data-rssd-row-note]'),0);
 assert.equal(host.count('.image-embed'),1,'the work\'s own content stays');
 assert.equal(host.attributes.has(OUTPUT_ATTRIBUTE),false,'the host is unmarked once rendered');
});
