// Where each space's files live in a vault (docs/obsidian-center-vault.md in RSSD).
//
// A vault made before several spaces could share one ("single") keeps one space at its root: Works/,
// article-media/, .rssd/, card-styles/, Card Samples/ and Exports/ sit at the top. A vault of several spaces
// ("spaces") gives each space a folder named after its site's host name, and inside it exactly that layout. So
// every rule written for one space, and the sync engines themselves, work on a space folder unchanged: they see
// paths relative to it through prefixedVault().
export const SINGLE='single',SPACES='spaces';

/**
 * The layout of a vault. A vault that already holds one space's works (or chose one, or is a topic pool) stays
 * single; an empty vault takes the layout of several spaces.
 */
export function layoutMode(settings){
 if(settings?.layout===SINGLE||settings?.layout===SPACES)return settings.layout;
 const synced=Object.values(settings?.baselines||{}).some(bucket=>Object.keys(bucket||{}).length);
 return settings?.mode==='pool'||settings?.boundSpace||settings?.workspaceId||synced?SINGLE:SPACES;
}

const FOLDER=/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
/** The folder a space gets: its site's host name, or the space ID when the site is unknown or the name is taken. */
export function spaceFolderName(space,{origin,taken=[]}={}){
 let name=null;try{name=new URL(origin).hostname;}catch{}
 if(!name||!FOLDER.test(name))name=space;
 if(taken.includes(name))name=name+'-'+space;
 if(!FOLDER.test(name))throw Error('No folder name for space '+space);
 return name;
}

export class VaultLayout{
 /** `space` is the single layout's space; `folders` maps each space of a spaces layout to its folder. */
 constructor({mode=SINGLE,space='',folders={}}={}){this.mode=mode;this.space=space;this.folders={...folders};}
 get single(){return this.mode===SINGLE;}
 /** The space a vault path belongs to and the path inside that space, or null. */
 locate(path){
  path=String(path??'');
  if(this.single)return this.space?{space:this.space,rel:path}:null;
  const at=path.indexOf('/');if(at<1)return null;
  const head=path.slice(0,at),space=Object.keys(this.folders).find(id=>this.folders[id]===head);
  return space?{space,rel:path.slice(at+1)}:null;
 }
 /** The vault path of `rel` inside `space`. */
 path(space,rel){
  if(this.single)return rel;
  const folder=this.folders[space];if(!folder)throw Error('Space '+space+' has no folder in this vault');
  return folder+'/'+rel;
 }
 /** The folder a space occupies, '' for a single layout. */
 root(space){return this.single?'':this.path(space,'').slice(0,-1);}
}

/** A view of a vault API ({read, readBinary, write, writeBinary, remove}) in which every path is inside `prefix`. */
export function prefixedVault(vault,prefix){
 if(!prefix)return vault;
 const inside=path=>prefix+'/'+path,out={};
 for(const [name,fn] of Object.entries(vault))out[name]=typeof fn==='function'?(path,...rest)=>fn(inside(path),...rest):fn;
 return out;
}
