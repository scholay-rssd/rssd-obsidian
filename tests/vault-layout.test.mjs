import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutMode,spaceFolderName,VaultLayout,prefixedVault,SINGLE,SPACES} from '../src/vault-layout.mjs';

test('a vault that already holds a space stays single; an empty one waits for its key',()=>{
 assert.equal(layoutMode({}),'');
 assert.equal(layoutMode({baselines:{pets:{}}}),'','an empty baseline bucket is not a synced space');
 assert.equal(layoutMode({layout:SPACES}),'','a layout fixed on first load without any folder is still undecided');
 assert.equal(layoutMode({layout:SPACES,spaceFolders:{pets:'pet.piggytuck.com'}}),SPACES);
 assert.equal(layoutMode({baselines:{pets:{a:{}}}}),SINGLE);
 assert.equal(layoutMode({workspaceId:'pets'}),SINGLE);
 assert.equal(layoutMode({boundSpace:'pets'}),SINGLE);
 assert.equal(layoutMode({mode:'pool'}),SINGLE);
 assert.equal(layoutMode({layout:SINGLE}),SINGLE,'a chosen layout is kept');
});

test('a space folder is named after its site, falling back to the space ID',()=>{
 assert.equal(spaceFolderName('pets',{origin:'https://pet.piggytuck.com'}),'pet.piggytuck.com');
 assert.equal(spaceFolderName('pets',{}),'pets');
 assert.equal(spaceFolderName('pets',{origin:'not a url'}),'pets');
 assert.equal(spaceFolderName('design',{origin:'https://www.piggytuck.com',taken:['www.piggytuck.com']}),'www.piggytuck.com-design');
});

test('paths map between the vault and each space',()=>{
 const single=new VaultLayout({mode:SINGLE,space:'pets'});
 assert.deepEqual(single.locate('Works/a.md'),{space:'pets',rel:'Works/a.md'});
 assert.equal(single.path('pets','Works/a.md'),'Works/a.md');assert.equal(single.root('pets'),'');
 assert.equal(new VaultLayout({mode:SINGLE}).locate('Works/a.md'),null,'no space chosen yet');
 const spaces=new VaultLayout({mode:SPACES,folders:{pets:'pet.piggytuck.com',legis:'legis.wiki'}});
 assert.deepEqual(spaces.locate('pet.piggytuck.com/Works/en/a.md'),{space:'pets',rel:'Works/en/a.md'});
 assert.deepEqual(spaces.locate('legis.wiki/article-media/x.png'),{space:'legis',rel:'article-media/x.png'});
 assert.equal(spaces.locate('Works/a.md'),null);assert.equal(spaces.locate('elsewhere/Works/a.md'),null);assert.equal(spaces.locate('pet.piggytuck.com'),null);
 assert.equal(spaces.path('legis','Works/a.md'),'legis.wiki/Works/a.md');assert.equal(spaces.root('legis'),'legis.wiki');
 assert.throws(()=>spaces.path('study','Works/a.md'),/no folder/);
});

test('a prefixed vault reads and writes inside its space folder',async()=>{
 const calls=[],vault={read:async p=>{calls.push(['read',p]);return 'x';},write:async(p,c,o)=>{calls.push(['write',p,c,o]);}};
 const inside=prefixedVault(vault,'legis.wiki');
 assert.equal(await inside.read('Works/a.md'),'x');await inside.write('Works/a.md','body',{expectedContent:null});
 assert.deepEqual(calls,[['read','legis.wiki/Works/a.md'],['write','legis.wiki/Works/a.md','body',{expectedContent:null}]]);
 assert.equal(prefixedVault(vault,''),vault);
});
