// Which spaces accept saves. A space stays read-only at the Center until its migration cutover is active,
// because the original site writer still owns it; the Center then refuses writes with `migration_staged`.
// The registry reports this per space, so the plugin can say so before anyone edits.
export function spaceInfo(registry,workspaceId){
 const space=(registry?.workspaces||[]).find(w=>w.id===workspaceId);
 if(!space)return {found:false,writable:false,migrationState:null};
 return {found:true,writable:space.writable!==false,migrationState:space.migrationState??null,name:space.name||space.id};
}
export function readOnlyReason(info,workspaceId){
 if(!info.found)return 'This device is not authorized for the space "'+workspaceId+'". Log in again and approve it.';
 if(!info.writable)return 'The space "'+workspaceId+'" is still migrating (state: '+(info.migrationState||'unknown')+'). Its original site writer owns it, so the Center refuses saves until the cutover is complete. You can pull and read here, but not save.';
 return null;
}
export function spacesSummary(registry,{stagedDraftsAvailable=false}={}){
 return (registry?.workspaces||[]).map(w=>w.id+': '+(w.writable===false?(stagedDraftsAvailable&&w.migrationState==='staged'?'private migration drafts (publication disabled)':'read-only ('+(w.migrationState||'migrating')+')'):'writable')).join('\n')||'No spaces are authorized for this device.';
}
