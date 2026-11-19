import test from 'node:test';
import assert from 'node:assert/strict';
import {adoptKey,vaultSpaces,centerAccess} from '../src/key-vault.mjs';

const origin=space=>({pets:'https://pet.piggytuck.com',legis:'https://legis.wiki'})[space]||'';

test('a key for one site, without the Center, makes a vault of that site at the root',()=>{
 assert.deepEqual(adoptKey({},{spaces:['pets']}),{spaces:['pets'],center:false,layout:'single',workspaceId:'pets'});
});
test('a key for several sites, or with the Center, puts each site in a folder of its own',()=>{
 const several=adoptKey({},{spaces:['pets','legis'],origin});
 assert.equal(several.layout,'spaces');assert.deepEqual(several.spaceFolders,{pets:'pet.piggytuck.com',legis:'legis.wiki'});
 assert.deepEqual(several.syncSpaces,{pets:true,legis:true});
 const center=adoptKey({},{spaces:['pets'],center:true,origin});
 assert.equal(center.layout,'spaces');assert.deepEqual(center.spaceFolders,{pets:'pet.piggytuck.com'});assert.equal(center.center,true);
});
test('a later key must still cover the sites the vault holds; new sites are added',()=>{
 const single={layout:'single',workspaceId:'pets'};
 assert.match(adoptKey(single,{spaces:['legis']}).error,/pets/);
 assert.deepEqual(adoptKey(single,{spaces:['legis','pets']}),{spaces:['legis','pets'],center:false,layout:'single',workspaceId:'pets'});
 const spaces={layout:'spaces',spaceFolders:{pets:'pet.piggytuck.com'},syncSpaces:{pets:false}};
 assert.match(adoptKey(spaces,{spaces:['legis']}).error,/pets/);
 const added=adoptKey(spaces,{spaces:['pets','legis'],origin});
 assert.deepEqual(added.spaceFolders,{pets:'pet.piggytuck.com',legis:'legis.wiki'});
 assert.deepEqual(added.syncSpaces,{pets:false,legis:true},'an unticked site stays unticked');
 assert.match(adoptKey({},{spaces:[]}).error,/没有包含任何站点/);
});
test('the sites a vault holds and whether a key opens the Center',()=>{
 assert.deepEqual(vaultSpaces({}),[]);assert.deepEqual(vaultSpaces({layout:'single',workspaceId:'pets'}),['pets']);
 assert.deepEqual(vaultSpaces({layout:'spaces',spaceFolders:{a:'x',b:'y'}}),['a','b']);
 assert.equal(centerAccess({grants:[{operation:'center'}]}),true);assert.equal(centerAccess({center:true}),true);
 assert.equal(centerAccess({grants:[{operation:'publicationScheduling'}]}),false);assert.equal(centerAccess(null),false);
});
