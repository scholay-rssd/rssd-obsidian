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
/** A release as the Center serves it, or null when the value is not one. */
export function readRelease(value){
 if(!value||typeof value!=='object'||value.format!==1||value.id!=='rssd'||!VERSION.test(value.version||'')||!VERSION.test(value.minAppVersion||''))return null;
 if(!COMMIT.test(value.commit||'')||typeof value.publishedAt!=='string'||typeof value.signature!=='string'||!Array.isArray(value.files))return null;
 const files=[...value.files].sort((a,b)=>String(a?.name)<String(b?.name)?-1:1);
 if(files.length!==RELEASE_FILES.length||files.some((f,i)=>f?.name!==RELEASE_FILES[i]||!HEX.test(f.sha256||'')||!Number.isSafeInteger(f.size)||f.size<1))return null;
 return {format:1,id:'rssd',version:value.version,minAppVersion:value.minAppVersion,commit:value.commit,publishedAt:value.publishedAt,
  files:files.map(f=>({name:f.name,sha256:f.sha256,size:f.size})),signature:value.signature};
}
/** The exact text a release signature covers. The release command signs this same string. */
export function signedText(release){
 const {format,id,version,minAppVersion,commit,publishedAt,files}=readRelease({...release,signature:release.signature||''})||{};
 if(!files)throw failure('Not a plugin release','update_invalid');
 return JSON.stringify({format,id,version,minAppVersion,commit,publishedAt,files});
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
/** Whether to install a release over the running version. `skipped` is a version the user rolled back from. */
export function decide({release,current,appVersion,skipped}){
 if(compareVersions(release.version,current)<=0)return 'current';
 if(skipped&&compareVersions(release.version,skipped)<=0)return 'skipped';
 if(VERSION.test(appVersion||'')&&compareVersions(appVersion,release.minAppVersion)<0)return 'app_too_old';
 return 'install';
}
const exact=bytes=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);

/**
 * Check the Center for a newer release and install it into the plugin folder `dir`, keeping the files that run
 * now in `dir/previous/` for a rollback. Nothing is written unless the signature and every file check out.
 * Returns {state} — 'none', 'current', 'skipped', 'app_too_old' or 'installed' — and the release version.
 */
export async function updateFromCenter({origin,http,adapter,dir,current,appVersion,skipped=null,publicKey}){
 const base=releasePath(origin);
 const response=await http({url:base+'/latest',method:'GET',throw:false});
 if(response.status===404)return {state:'none'};
 if(response.status!==200)throw failure('The Center did not return the plugin release (HTTP '+response.status+')','update_unavailable');
 const release=readRelease(response.json);
 if(!release)throw failure('The Center returned an invalid plugin release','update_invalid');
 const decision=decide({release,current,appVersion,skipped});
 if(decision!=='install')return {state:decision,version:release.version};
 if(!await verifyRelease(release,publicKey))throw failure('Release '+release.version+' is not signed with the RSSD release key, so it was not installed','update_unsigned');
 const files=new Map();
 for(const file of release.files){
  const got=await http({url:base+'/files/'+file.sha256,method:'GET',throw:false});
  if(got.status!==200)throw failure('Could not download '+file.name+' (HTTP '+got.status+')','update_unavailable');
  const bytes=new Uint8Array(got.arrayBuffer);
  if(bytes.length!==file.size||await sha256Hex(bytes)!==file.sha256)throw failure(file.name+' does not match the signed release, so it was not installed','update_mismatch');
  files.set(file.name,bytes);
 }
 let manifest;try{manifest=JSON.parse(new TextDecoder().decode(files.get('manifest.json')));}catch{}
 if(manifest?.id!=='rssd'||manifest.version!==release.version)throw failure('The release manifest does not name release '+release.version,'update_mismatch');
 const previous=dir+'/previous';
 if(!await adapter.exists(previous))await adapter.mkdir(previous);
 for(const name of RELEASE_FILES)if(await adapter.exists(dir+'/'+name))await adapter.writeBinary(previous+'/'+name,await adapter.readBinary(dir+'/'+name));
 // main.js before manifest.json: if this stops halfway, the manifest still names the old version and the next
 // check installs the release again.
 for(const name of RELEASE_FILES)await adapter.writeBinary(dir+'/'+name,exact(files.get(name)));
 return {state:'installed',version:release.version};
}

/** Put back the version that ran before the last update. Returns its version. */
export async function rollback({adapter,dir}){
 const previous=dir+'/previous';
 if(!await adapter.exists(previous+'/main.js')||!await adapter.exists(previous+'/manifest.json'))throw failure('There is no previous version to roll back to','no_previous');
 let manifest;try{manifest=JSON.parse(await adapter.read(previous+'/manifest.json'));}catch{}
 if(manifest?.id!=='rssd')throw failure('The previous version is not an RSSD plugin','no_previous');
 for(const name of RELEASE_FILES)await adapter.writeBinary(dir+'/'+name,await adapter.readBinary(previous+'/'+name));
 return {version:manifest.version};
}
