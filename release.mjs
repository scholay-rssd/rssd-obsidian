// Release the RSSD plugin through the Center, where every vault on every device picks it up as a signed update.
//
//   node release.mjs key       Create the release key. The private half stays in ~/.rssd/obsidian-plugin-release.pem
//                              (back it up); the public half goes to release-key.pub and into every build.
//   node release.mjs publish   Build the merged main, sign it, upload it to the Center and check what vaults see.
//
// Options: --origin <Center URL> (default: the plugin's default Center), --server <ssh host> (default
// scholay-postiz), --dry-run (build and sign only; with --out <folder> the release is written there).
// The version is assigned here: manifest.json's major.minor, with the patch one past the Center's latest.
import {generateKeyPairSync,createPrivateKey,createPublicKey,sign,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,mkdtemp,copyFile,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {homedir,tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {signedText,verifyRelease,releasePath,compareVersions,RELEASE_FILES} from './src/self-update.mjs';

const KEY=process.env.RSSD_RELEASE_KEY_FILE||join(homedir(),'.rssd','obsidian-plugin-release.pem');
const HOST_FOLDER='/opt/postiz/data/config/rssd-obsidian-plugin',CENTER_FOLDER='/config/rssd-obsidian-plugin';
const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf('--'+name);return i>=0&&args[i+1]?args[i+1]:fallback;};
const run=(command,argv,options={})=>execFileSync(command,argv,{encoding:'utf8',stdio:['ignore','pipe','inherit'],...options}).trim();
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function stop(message){console.error(message);process.exit(1);}

async function createKey(){
 if(await access(KEY).then(()=>true,()=>false))stop('A release key already exists at '+KEY+'. Keep using it: vaults only install releases signed with it.');
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
 await mkdir(dirname(KEY),{recursive:true,mode:0o700});
 await writeFile(KEY,privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});
 await writeFile('release-key.pub',publicKey.export({type:'spki',format:'der'}).toString('base64')+'\n');
 console.log('Private key: '+KEY+'\n  Back it up. Without it, a new key needs one more manual install in every vault.\nPublic key: release-key.pub (commit it)');
}

async function latestRelease(origin){
 const response=await fetch(releasePath(origin)+'/latest');
 if(response.status===404)return null;
 if(!response.ok)stop('The Center did not return its latest release (HTTP '+response.status+')');
 return response.json();
}

async function publish(){
 const dry=args.includes('--dry-run'),server=option('server','scholay-postiz');
 const origin=option('origin',process.env.RSSD_DEFAULT_ORIGIN||/DEFAULT_ORIGIN=.*?'(https:\/\/[^']+)'/.exec(await readFile('src/main.js','utf8'))[1]);
 const publicKey=(await readFile('release-key.pub','utf8').catch(()=>stop('release-key.pub is missing; run: node release.mjs key'))).trim();
 const privateKey=createPrivateKey(await readFile(KEY,'utf8').catch(()=>stop('No release key at '+KEY)));
 if(createPublicKey(privateKey).export({type:'spki',format:'der'}).toString('base64')!==publicKey)stop('The key at '+KEY+' does not match release-key.pub');
 // Only reviewed code is released: a clean tree whose commit is on origin/main.
 if(run('git',['status','--porcelain','--untracked-files=no']))stop('The working tree has changes; commit or discard them first');
 run('git',['fetch','-q','origin','main']);
 const commit=run('git',['rev-parse','HEAD']);
 let merged=true;try{run('git',['merge-base','--is-ancestor',commit,'origin/main']);}catch{merged=false;}
 if(!merged&&!dry)stop('HEAD is not on origin/main. Release merged code only (a --dry-run works from any commit).');
 const manifest=JSON.parse(await readFile('manifest.json','utf8')),latest=await latestRelease(origin);
 const [major,minor,patch]=manifest.version.split('.').map(Number);let version=manifest.version;
 if(latest){
  const [m,n,p]=latest.version.split('.').map(Number);
  if(m===major&&n===minor)version=major+'.'+minor+'.'+Math.max(patch,p+1);
  if(compareVersions(version,latest.version)<=0)stop('manifest.json ('+manifest.version+') is behind the published '+latest.version);
 }
 run(process.execPath,['esbuild.config.mjs'],{env:{...process.env,RSSD_RELEASE_VERSION:version}});
 if(!(await readFile('dist/main.js','utf8')).includes(JSON.stringify(publicKey)))stop('The build does not carry release-key.pub');
 const files=[];
 for(const name of RELEASE_FILES){const bytes=await readFile(join('dist',name));files.push({name,sha256:sha256(bytes),size:bytes.length});}
 const release={format:1,id:'rssd',version,minAppVersion:manifest.minAppVersion,commit,publishedAt:new Date().toISOString(),files};
 release.signature=sign('sha256',Buffer.from(signedText(release)),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64');
 if(!await verifyRelease(release,publicKey))stop('The signed release does not verify with release-key.pub');
 const out=option('out',null)||await mkdtemp(join(tmpdir(),'rssd-release-'));await mkdir(out,{recursive:true});
 await writeFile(join(out,'release.json'),JSON.stringify(release,null,1)+'\n');
 for(const name of RELEASE_FILES)await copyFile(join('dist',name),join(out,name));
 console.log('Built and signed RSSD '+version+' from '+commit.slice(0,7)+(merged?'':' (not on main)')+' in '+out);
 if(dry)return;
 const incoming='/incoming/'+version;
 run('ssh',['-o','BatchMode=yes',server,'mkdir -p '+HOST_FOLDER+incoming]);
 run('scp',['-q','-o','BatchMode=yes',...['release.json',...RELEASE_FILES].map(name=>join(out,name)),server+':'+HOST_FOLDER+incoming+'/']);
 console.log(run('ssh',['-o','BatchMode=yes',server,'docker exec postiz node /app/rssd/obsidian-plugin-releases.cjs publish '+CENTER_FOLDER+incoming+' '+CENTER_FOLDER+' && rm -rf '+HOST_FOLDER+incoming]));
 // Check what a vault will receive, not what was sent.
 const served=await latestRelease(origin);
 if(JSON.stringify(served)!==JSON.stringify(release))stop('The Center serves a different release from the one just published');
 for(const file of files){
  const response=await fetch(releasePath(origin)+'/files/'+file.sha256);
  if(!response.ok||sha256(Buffer.from(await response.arrayBuffer()))!==file.sha256)stop('The Center does not serve '+file.name+' as signed');
 }
 console.log('Published RSSD '+version+'. Vaults install it at their next start or within three hours.');
}

const command=args[0];
if(command==='key')await createKey();
else if(command==='publish')await publish();
else stop('Usage: node release.mjs key | publish [--dry-run] [--out <folder>] [--origin <url>] [--server <ssh host>]');
