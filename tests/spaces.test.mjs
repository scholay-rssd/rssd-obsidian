import test from 'node:test';
import assert from 'node:assert/strict';
import {spaceInfo,readOnlyReason,spacesSummary} from '../src/spaces.mjs';
import {saveFailureMessage} from '../src/messages.mjs';

const registry={workspaces:[{id:'personal',writable:false,migrationState:'staged'},{id:'metho',writable:true,migrationState:'active'},{id:'fresh',writable:true,migrationState:null}]};

test('a staged space is read-only before anything is sent',()=>{
 assert.match(readOnlyReason(spaceInfo(registry,'personal'),'personal'),/still migrating \(state: staged\)/);
 assert.equal(readOnlyReason(spaceInfo(registry,'metho'),'metho'),null);
 assert.equal(readOnlyReason(spaceInfo(registry,'fresh'),'fresh'),null);
 assert.match(readOnlyReason(spaceInfo(registry,'other'),'other'),/not authorized/);
});
test('the spaces summary lists which spaces accept saves',()=>{
 assert.equal(spacesSummary(registry),'personal: read-only (staged)\nmetho: writable\nfresh: writable');
 assert.match(spacesSummary({workspaces:[]}),/No spaces/);
});
test('a migration_staged refusal from the Center is explained',()=>{
 assert.match(saveFailureMessage(Object.assign(new Error('x'),{conflict:true,code:'migration_staged'})),/still migrating.*\[migration_staged\]$/);
});
