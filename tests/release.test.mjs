import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateRawSync} from 'node:zlib';
import {starterVault,githubAssetNames,githubNotes} from '../release.mjs';

// Reads a zip written by zipFiles: names from the central directory, bytes from each local entry.
function unzip(zip){
 const end=zip.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06])),count=zip.readUInt16LE(end+10);
 let at=zip.readUInt32LE(end+16);const entries={};
 for(let i=0;i<count;i++){
  const nameLength=zip.readUInt16LE(at+28),offset=zip.readUInt32LE(at+42),name=zip.subarray(at+46,at+46+nameLength).toString('utf8');
  const size=zip.readUInt32LE(offset+18),start=offset+30+zip.readUInt16LE(offset+26)+zip.readUInt16LE(offset+28);
  entries[name]=inflateRawSync(zip.subarray(start,start+size)).toString('utf8');
  at+=46+nameLength+zip.readUInt16LE(at+30)+zip.readUInt16LE(at+32);
 }
 return entries;
}

test('the starter vault holds the release files, the plugin switched on and the guide', () => {
 const entries=unzip(starterVault({'main.js':Buffer.from('code'),'manifest.json':Buffer.from('{"id":"rssd"}')}));
 assert.deepEqual(Object.keys(entries).sort(),['RSSD/.obsidian/community-plugins.json','RSSD/.obsidian/plugins/rssd/main.js','RSSD/.obsidian/plugins/rssd/manifest.json','RSSD/开始使用.md']);
 assert.equal(entries['RSSD/.obsidian/plugins/rssd/main.js'],'code');
 assert.deepEqual(JSON.parse(entries['RSSD/.obsidian/community-plugins.json']),['rssd']);
 assert.match(entries['RSSD/开始使用.md'],/密钥/);
});

test('a GitHub release carries the plugin files, the signed descriptor and the starter vault', () => {
 assert.deepEqual(githubAssetNames('0.2.9'),['main.js','manifest.json','release.json','rssd-starter-vault-0.2.9.zip']);
 const notes=githubNotes({version:'0.2.9',commit:'9f59e4d'.padEnd(40,'0'),coreCommit:'04b104c'.padEnd(40,'0')});
 assert.match(notes,/rssd-starter-vault-0\.2\.9\.zip/);
 assert.match(notes,/`9f59e4d`/);
});
