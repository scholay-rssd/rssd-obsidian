// What a device key makes of a vault. The key is created in the RSSD Center (/rssd?tab=workers) with the sites it
// may use and, optionally, the Center itself; pasting it into a vault decides what that vault is:
//   one site, no Center   → a vault of that one site, laid out at the root (Works/, article-media/, …)
//   several sites, or the Center ticked → each site in a folder of its own (see vault-layout.mjs)
// Pure, so the rules are tested without Obsidian.
import {SINGLE,SPACES,spaceFolderName,layoutMode} from './vault-layout.mjs';

/** Whether the key also opens the Center's own data (topic pool, publications, overview). */
export const centerAccess=identity=>identity?.center===true||(Array.isArray(identity?.grants)&&identity.grants.some(grant=>grant?.operation==='center'));

/** The sites this vault already holds, which any later key must still cover. */
export function vaultSpaces(settings){
 settings={...settings,layout:layoutMode(settings)};
 if(settings?.layout===SINGLE)return settings.workspaceId?[settings.workspaceId]:[];
 if(settings?.layout===SPACES)return Object.keys(settings.spaceFolders||{});
 return [];
}

/**
 * The settings a key leads to, or {error}. `spaces` are the key's sites, `center` whether it opens the Center,
 * `origin(space)` a site's address for naming its folder. Nothing already in the vault is dropped: a key that no
 * longer covers one of its sites is refused, so a vault never loses track of the works it holds.
 */
export function adoptKey(settings,{spaces,center=false,origin=()=>''}){
 spaces=[...new Set((spaces||[]).filter(space=>typeof space==='string'&&space))];
 if(!spaces.length)return {error:'这把密钥没有包含任何站点。'};
 const held=vaultSpaces(settings),missing=held.filter(space=>!spaces.includes(space));
 if(missing.length)return {error:'这把密钥不包含本 vault 已有的站点：'+missing.join('、')+'。请换一把包含这些站点的密钥，或者新建一个 vault。'};
 const next={spaces,center:!!center};
 let layout=layoutMode(settings);
 if(!layout)layout=spaces.length===1&&!center?SINGLE:SPACES;
 next.layout=layout;
 if(layout===SINGLE){
  // A one-site vault keeps its site; a key with more sites only adds access, not folders.
  next.workspaceId=settings?.workspaceId||spaces[0];
  return next;
 }
 const folders={...(settings?.spaceFolders||{})},sync={...(settings?.syncSpaces||{})};
 for(const space of spaces)if(!folders[space]){folders[space]=spaceFolderName(space,{origin:origin(space),taken:Object.values(folders)});sync[space]=true;}
 next.spaceFolders=folders;next.syncSpaces=sync;
 return next;
}
