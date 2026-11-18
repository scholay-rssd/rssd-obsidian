// Signed self-update for the RSSD plugin. A vault installs a newer release from its Center only when the
// release's signature verifies against the public key compiled into the plugin it already runs, and every file
// matches the hash that signature covers, so neither the Center nor anything between can make a vault run other
// code. `http` is Obsidian's requestUrl at runtime and a stub in tests; `adapter` is the vault's file adapter.
// No Obsidian or Node dependency, so this also runs on mobile.
export const RELEASE_FILES=['main.js','manifest.json'];
const VERSION=/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/,HEX=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/;
const failure=(message,code)=>Object.assign(Error(message),{code});

export const releasePath=origin=>String(origin||'').replace(/\/+$/,'')+'/api/rssd/public/v1/obsidian-plugin';
export function compareVersions(a,b){
 const x=(VERSION.test(a)?a:'0.0.0').split('.').map(Number),y=(VERSION.test(b)?b:'0.0.0').split('.').map(Number);
 for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]<y[i]?-1:1;
 return 0;
}
export const newerVersion=(a,b)=>!a?b:!b?a:compareVersions(a,b)>=0?a:b;
/** A release as the Center serves it, or null when the value is not one. */
export function readRelease(value){
 if(!value||typeof value!=='object'||value.format!==1||value.id!=='rssd'||!VERSION.test(value.version||'')||!VERSION.test(value.minAppVersion||''))return null;
 if(!COMMIT.test(value.commit||'')||!COMMIT.test(value.coreCommit||'')||typeof value.publishedAt!=='string'||typeof value.signature!=='string'||!Array.isArray(value.files))return null;
 const files=[...value.files].sort((a,b)=>String(a?.name)<String(b?.name)?-1:1);
 if(files.length!==RELEASE_FILES.length||files.some((f,i)=>f?.name!==RELEASE_FILES[i]||!HEX.test(f.sha256||'')||!Number.isSafeInteger(f.size)||f.size<1))return null;
 return {format:1,id:'rssd',version:value.version,minAppVersion:value.minAppVersion,commit:value.commit,coreCommit:value.coreCommit,publishedAt:value.publishedAt,
  files:files.map(f=>({name:f.name,sha256:f.sha256,size:f.size})),signature:value.signature};
}
/** The exact text a release signature covers: the release without its signature. The release command and the Center build the same string. */
export function signedText(release){
 const value=readRelease({...release,signature:release.signature||''});
 if(!value)throw failure('Not a plugin release','update_invalid');
 const {signature,...signed}=value;return JSON.stringify(signed);
}
const subtle=()=>{const value=globalThis.crypto?.subtle;if(!value)throw failure('This device cannot check release signatures','update_unsupported');return value;};
const fromBase64=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
export async function sha256Hex(bytes){
 return [...new Uint8Array(await subtle().digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
/** ECDSA P-256 / SHA-256 over signedText(release); the signature is IEEE P1363 (64 bytes), base64. */
export async function verifyRelease(release,publicKey){
 if(typeof publicKey!=='string'||!publicKey)return false;
 try{
  const key=await subtle().importKey('spki',fromBase64(publicKey),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  return await subtle().verify({name:'ECDSA',hash:'SHA-256'},key,fromBase64(release.signature),new TextEncoder().encode(signedText(release)));
 }catch{return false;}
}
/** Whether to install a release over the running version. `skipped` is the highest version the user rolled back from. */
export function decide({release,running,appVersion,skipped}){
 if(compareVersions(release.version,running)<=0)return 'current';
 if(skipped&&compareVersions(release.version,skipped)<=0)return 'skipped';
 if(VERSION.test(appVersion||'')&&compareVersions(appVersion,release.minAppVersion)<0)return 'app_too_old';
 return 'install';
}
const exact=bytes=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
/** The version the plugin folder holds on disk, which differs from the running one after an install. */
export async function diskVersion(adapter,dir){
 try{const manifest=JSON.parse(await adapter.read(dir+'/manifest.json'));return manifest?.id==='rssd'&&VERSION.test(manifest.version||'')?manifest.version:null;}
 catch{return null;}
}
// Obsidian's adapter refuses to rename onto an existing file. On desktop the file system's own rename replaces
// the target in one step, so an interruption leaves the old file or the new one; elsewhere the old one is
// removed first.
async function replace(adapter,from,to){
 if(typeof adapter.fsPromises?.rename==='function'&&typeof adapter.getFullPath==='function'){await adapter.fsPromises.rename(adapter.getFullPath(from),adapter.getFullPath(to));return;}
 if(await adapter.exists(to))await adapter.remove(to);
 await adapter.rename(from,to);
}
async function writeChecked(adapter,path,bytes,hash){
 await adapter.writeBinary(path,exact(bytes));
 if(await sha256Hex(await adapter.readBinary(path))!==hash)throw failure('Could not write '+path+' completely, so the update was not installed','update_write');
}

/**
 * Check the Center for a newer release and install it into the plugin folder `dir`. `running` is the version of
 * the code that runs now. The new files are written to `dir/update/` and read back before anything changes; the
 * running files are copied to `dir/previous/` (only while the folder still holds the running version, so a
 * second install before a reload keeps the copy to roll back to); then each file is swapped in, manifest last.
 * Returns {state} — 'none', 'current', 'skipped', 'app_too_old' or 'installed' — and the release version.
 */
export async function updateFromCenter({origin,http,adapter,dir,running,appVersion,skipped=null,publicKey}){
 const base=releasePath(origin);
 const response=await http({url:base+'/latest',method:'GET',throw:false});
 if(response.status===404)return {state:'none'};
 if(response.status!==200)throw failure('The Center did not return the plugin release (HTTP '+response.status+')','update_unavailable');
 const release=readRelease(response.json);
 if(!release)throw failure('The Center returned an invalid plugin release','update_invalid');
 const decision=decide({release,running,appVersion,skipped});
 if(decision!=='install')return {state:decision,version:release.version};
 if(!await verifyRelease(release,publicKey))throw failure('Release '+release.version+' is not signed with the RSSD release key, so it was not installed','update_unsigned');
 const files=new Map();
 for(const file of release.files){
  const got=await http({url:base+'/files/'+file.sha256,method:'GET',throw:false});
  if(got.status!==200)throw failure('Could not download '+file.name+' (HTTP '+got.status+')','update_unavailable');
  const bytes=new Uint8Array(got.arrayBuffer);
  if(bytes.length!==file.size||await sha256Hex(bytes)!==file.sha256)throw failure(file.name+' does not match the signed release, so it was not installed','update_mismatch');
  files.set(file.name,{bytes,hash:file.sha256});
 }
 let manifest;try{manifest=JSON.parse(new TextDecoder().decode(files.get('manifest.json').bytes));}catch{}
 if(manifest?.id!=='rssd'||manifest.version!==release.version)throw failure('The release manifest does not name release '+release.version,'update_mismatch');
 const staging=dir+'/update',previous=dir+'/previous';
 if(!await adapter.exists(staging))await adapter.mkdir(staging);
 for(const name of RELEASE_FILES)await writeChecked(adapter,staging+'/'+name,files.get(name).bytes,files.get(name).hash);
 if(await diskVersion(adapter,dir)===running){
  if(!await adapter.exists(previous))await adapter.mkdir(previous);
  for(const name of RELEASE_FILES)if(await adapter.exists(dir+'/'+name)){
   const bytes=new Uint8Array(await adapter.readBinary(dir+'/'+name));
   await writeChecked(adapter,previous+'/'+name,bytes,await sha256Hex(bytes));
  }
 }
 for(const name of RELEASE_FILES)await replace(adapter,staging+'/'+name,dir+'/'+name);
 return {state:'installed',version:release.version};
}

/**
 * Put back the version kept in `dir/previous/`. Refuses when that copy is not older than what the folder holds.
 * Returns the restored version and the one it replaced.
 */
export async function rollback({adapter,dir}){
 const previous=dir+'/previous',restored=await diskVersion(adapter,previous),replaced=await diskVersion(adapter,dir);
 if(!restored||!await adapter.exists(previous+'/main.js'))throw failure('There is no previous version to roll back to','no_previous');
 if(replaced&&compareVersions(restored,replaced)>=0)throw failure('The kept version ('+restored+') is not older than the installed one ('+replaced+')','no_previous');
 const staging=dir+'/update';
 if(!await adapter.exists(staging))await adapter.mkdir(staging);
 for(const name of RELEASE_FILES){
  const bytes=new Uint8Array(await adapter.readBinary(previous+'/'+name));
  await writeChecked(adapter,staging+'/'+name,bytes,await sha256Hex(bytes));
 }
 for(const name of RELEASE_FILES)await replace(adapter,staging+'/'+name,dir+'/'+name);
 return {version:restored,replaced};
}
