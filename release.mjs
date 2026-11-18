// Release the RSSD plugin through the Center, where every vault on every device picks it up as a signed update.
//
//   node release.mjs key [--rotate]   Create the release key. The private half goes to
//                                     ~/.rssd/obsidian-plugin-release.pem (back it up); the public half to
//                                     release-key.pub, which is committed and compiled into every build.
//   node release.mjs publish          Build, sign, upload to the Center, and check what vaults will receive.
//
// Options for publish:
//   --origin <Center URL>   default: the plugin's default Center
//   --server <ssh host>     default: scholay-postiz
//   --dry-run               build and sign with a throwaway key that no vault trusts; upload nothing
//   --out <folder>          where the release goes (default: a temporary folder)
//   --plugin-ref <branch>   dry runs only: build another rssd-obsidian branch
//
// A release is built only from what GitHub holds: rssd-obsidian main, and rssd main with the themes and sites
// it pins. It is built in fresh clones with dependencies installed from the lockfile, so nothing local or
// unreviewed ends up in it. The version is manifest.json's major.minor with a patch one past both the Center's
// latest and the last release recorded on this Mac (~/.rssd/obsidian-plugin-releases.json), so no number is
// used twice, even after the Center is restored from an older backup.
import {generateKeyPairSync,createPrivateKey,createPublicKey,sign,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,mkdtemp,copyFile,rename,rm,access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {homedir,tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';

const HOME=join(homedir(),'.rssd'),KEY=process.env.RSSD_RELEASE_KEY_FILE||join(HOME,'obsidian-plugin-release.pem'),LEDGER=join(HOME,'obsidian-plugin-releases.json');
const CORE='https://github.com/scholay-rssd/rssd.git',PLUGIN='https://github.com/scholay-rssd/rssd-obsidian.git';
const HOST_FOLDER='/opt/postiz/data/config/rssd-obsidian-plugin',CENTER_FOLDER='/config/rssd-obsidian-plugin';
const FILES=['main.js','manifest.json'];
const args=process.argv.slice(2),option=(name,fallback)=>{const i=args.indexOf('--'+name);return i>=0&&args[i+1]?args[i+1]:fallback;};
const run=(command,argv,options={})=>execFileSync(command,argv,{encoding:'utf8',stdio:['ignore','pipe','inherit'],...options}).trim();
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const exists=path=>access(path).then(()=>true,()=>false);
function stop(message){throw Object.assign(Error(message),{stop:true});}
async function writeAtomically(path,text,mode=0o600){const temporary=path+'.tmp';await writeFile(temporary,text,{mode});await rename(temporary,path);}

async function createKey(){
 const rotate=args.includes('--rotate');
 if(!rotate&&(await exists(KEY)||await exists('release-key.pub')))
  stop('A release key already exists. Keep using it: vaults only install releases signed with it. (--rotate makes a new one, after which every vault needs one more manual install.)');
 if(await exists(KEY))await rename(KEY,KEY+'.retired-'+new Date().toISOString().replace(/[:.]/g,''));
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
 await mkdir(dirname(KEY),{recursive:true,mode:0o700});
 await writeFile(KEY,privateKey.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});
 await writeFile('release-key.pub',publicKey.export({type:'spki',format:'der'}).toString('base64')+'\n');
 console.log('Private key: '+KEY+'\n  Back it up. Without it, a new key needs one more manual install in every vault.\nPublic key: release-key.pub (commit it)');
}

async function readLedger(){return JSON.parse(await readFile(LEDGER,'utf8').catch(e=>{if(e.code==='ENOENT')return '{"releases":[]}';throw e;}));}

async function publish(){
 const dry=args.includes('--dry-run'),server=option('server','scholay-postiz'),ref=option('plugin-ref','main');
 if(ref!=='main'&&!dry)stop('Only main is released; --plugin-ref is for dry runs');
 const work=await mkdtemp(join(tmpdir(),'rssd-release-'));
 try{
  const core=join(work,'rssd'),plugin=join(core,'obsidian'),git=(cwd,...argv)=>run('git',['-C',cwd,...argv]);
  run('git',['clone','-q','--filter=blob:none',CORE,core]);
  git(core,'submodule','update','-q','--init','web/themes','sites');
  run('git',['clone','-q','--filter=blob:none','--branch',ref,PLUGIN,plugin]);
  const coreCommit=git(core,'rev-parse','HEAD'),commit=git(plugin,'rev-parse','HEAD');
  // Sign and check with the released code's own functions, so the signed text is exactly what its vaults verify.
  const {signedText,verifyRelease,releasePath,compareVersions,newerVersion}=await import(pathToFileURL(join(plugin,'src','self-update.mjs')).href);
  const origin=option('origin',process.env.RSSD_DEFAULT_ORIGIN||/DEFAULT_ORIGIN=.*?'(https:\/\/[^']+)'/.exec(await readFile(join(plugin,'src','main.js'),'utf8'))[1]);
  const latestResponse=await fetch(releasePath(origin)+'/latest');
  if(latestResponse.status!==404&&!latestResponse.ok)stop('The Center did not return its latest release (HTTP '+latestResponse.status+')');
  const latest=latestResponse.status===404?null:await latestResponse.json();
  const ledger=await readLedger(),recorded=ledger.releases.reduce((a,b)=>!a||compareVersions(b.version,a.version)>0?b:a,null);
  const last=[latest,recorded].filter(Boolean).reduce((a,b)=>!a||compareVersions(b.version,a.version)>0?b:a,null);
  if(recorded&&(!latest||compareVersions(latest.version,recorded.version)<0))console.warn('The Center\'s latest ('+(latest?.version||'none')+') is behind the last release made here ('+recorded.version+'); numbering continues after '+recorded.version+'.');
  // Never release code older than what vaults already run.
  if(last&&!dry)for(const [cwd,ancestor,name] of [[plugin,last.commit,'rssd-obsidian'],[core,last.coreCommit,'rssd']]){
   try{git(cwd,'merge-base','--is-ancestor',ancestor,'HEAD');}catch{stop(name+' main does not contain '+ancestor.slice(0,7)+', which release '+last.version+' was built from');}
  }
  const manifest=JSON.parse(await readFile(join(plugin,'manifest.json'),'utf8'));
  const [major,minor]=manifest.version.split('.').map(Number);let version=manifest.version;
  for(const v of [latest?.version,recorded?.version].filter(Boolean)){const [m,n,p]=v.split('.').map(Number);if(m===major&&n===minor)version=newerVersion(version,major+'.'+minor+'.'+(p+1));}
  if(last&&compareVersions(version,last.version)<=0)stop('manifest.json ('+manifest.version+') is behind the released '+last.version+'; raise its version');
  run('npm',['ci','--no-audit','--no-fund','--loglevel=error'],{cwd:plugin});
  run(process.execPath,['esbuild.config.mjs'],{cwd:plugin,env:{...process.env,RSSD_RELEASE_VERSION:version}});
  const trusted=(await readFile(join(plugin,'release-key.pub'),'utf8')).trim();
  if(!(await readFile(join(plugin,'dist','main.js'),'utf8')).includes(JSON.stringify(trusted)))stop('The build does not carry release-key.pub');
  let signer,signerKey;
  if(dry){({privateKey:signer,publicKey:signerKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}));signerKey=signerKey.export({type:'spki',format:'der'}).toString('base64');}
  else{
   signer=createPrivateKey(await readFile(KEY,'utf8').catch(()=>stop('No release key at '+KEY)));
   signerKey=createPublicKey(signer).export({type:'spki',format:'der'}).toString('base64');
   if(signerKey!==trusted)stop('The key at '+KEY+' does not match release-key.pub on main');
  }
  const files=[];
  for(const name of FILES){const bytes=await readFile(join(plugin,'dist',name));files.push({name,sha256:sha256(bytes),size:bytes.length});}
  const release={format:1,id:'rssd',version,minAppVersion:manifest.minAppVersion,commit,coreCommit,publishedAt:new Date().toISOString(),files};
  release.signature=sign('sha256',Buffer.from(signedText(release)),{key:signer,dsaEncoding:'ieee-p1363'}).toString('base64');
  if(!await verifyRelease(release,signerKey))stop('The signed release does not verify');
  const out=option('out',null)||await mkdtemp(join(tmpdir(),'rssd-release-out-'));await mkdir(out,{recursive:true});
  await writeFile(join(out,'release.json'),JSON.stringify(release,null,1)+'\n');
  for(const name of FILES)await copyFile(join(plugin,'dist',name),join(out,name));
  console.log('Built RSSD '+version+' from rssd-obsidian '+commit.slice(0,7)+' and rssd '+coreCommit.slice(0,7)+' in '+out);
  if(dry){
   await writeFile(join(out,'throwaway-key.pub'),signerKey+'\n');
   console.log('Dry run: signed with a throwaway key (throwaway-key.pub), so no vault will install it. Nothing was uploaded.');
   return;
  }
  await copyFile(join(plugin,'release-key.pub'),join(out,'release-key.pub'));
  const incoming='/incoming/'+version,ssh=command=>run('ssh',['-o','BatchMode=yes',server,command]);
  ssh('mkdir -p '+HOST_FOLDER+incoming);
  run('scp',['-q','-o','BatchMode=yes',...['release.json','release-key.pub',...FILES].map(name=>join(out,name)),server+':'+HOST_FOLDER+incoming+'/']);
  console.log(ssh('docker exec postiz node /app/rssd/obsidian-plugin-releases.cjs publish '+CENTER_FOLDER+incoming+' '+CENTER_FOLDER+' --key '+CENTER_FOLDER+incoming+'/release-key.pub; status=$?; rm -rf '+HOST_FOLDER+incoming+'; exit $status'));
  // Check what a vault will receive, not what was sent.
  const served=await (await fetch(releasePath(origin)+'/latest')).json();
  if(JSON.stringify(served)!==JSON.stringify(release))stop('The Center serves a different release from the one just published');
  for(const file of files){
   const response=await fetch(releasePath(origin)+'/files/'+file.sha256);
   if(!response.ok||sha256(Buffer.from(await response.arrayBuffer()))!==file.sha256)stop('The Center does not serve '+file.name+' as signed');
  }
  ledger.releases.push({version,commit,coreCommit,publishedAt:release.publishedAt,files});
  await mkdir(HOME,{recursive:true,mode:0o700});await writeAtomically(LEDGER,JSON.stringify(ledger,null,1)+'\n');
  console.log('Published RSSD '+version+'. Vaults install it at their next start or within three hours. Files: '+out);
 }finally{await rm(work,{recursive:true,force:true});}
}

const command=args[0];
try{
 if(command==='key')await createKey();
 else if(command==='publish')await publish();
 else stop('Usage: node release.mjs key [--rotate] | publish [--dry-run] [--out <folder>] [--origin <url>] [--server <ssh host>] [--plugin-ref <branch>]');
}catch(error){console.error(error.stop?error.message:error);process.exitCode=1;}
