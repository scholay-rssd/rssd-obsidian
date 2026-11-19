// Release the RSSD plugin through the Center, where every vault on every device picks it up as a signed update.
//
//   node release.mjs key [--rotate]   Create the release key. The private half goes to
//                                     ~/.rssd/obsidian-plugin-release.pem (back it up); the public half to
//                                     release-key.pub, which is committed and compiled into every build.
//   node release.mjs publish          Build, sign, upload to the Center, and check what vaults will receive.
//   node release.mjs starter          Package the Center's current release as a starter vault (a zip) for a new
//                                     writer: open it in Obsidian, trust the plugin, add a device token. Needs no key.
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
import {deflateRawSync,crc32} from 'node:zlib';
import {homedir,tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
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
  const origin=option('origin',/DEFAULT_ORIGIN=.*?'(https:\/\/[^']+)'/.exec(await readFile(join(plugin,'src','main.js'),'utf8'))[1]);
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
  // Only what a build needs from this shell: a stray RSSD_DEFAULT_ORIGIN or similar must not change a signed release.
  // Dependencies install without their scripts, so nothing from the lockfile runs on the Mac that holds the key.
  const env={PATH:process.env.PATH,HOME:process.env.HOME,...(process.env.TMPDIR?{TMPDIR:process.env.TMPDIR}:{})};
  run('npm',['ci','--ignore-scripts','--no-audit','--no-fund','--loglevel=error'],{cwd:plugin,env});
  // A release reaches every vault, so it is built only from code whose tests pass here, against the rssd it is built with.
  try{execFileSync('npm',['test'],{cwd:plugin,env,stdio:['ignore','inherit','inherit']});}catch{stop('The tests failed; nothing was built or released');}
  run(process.execPath,['esbuild.config.mjs'],{cwd:plugin,env:{...env,RSSD_RELEASE_VERSION:version}});
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

// A starter vault: an empty vault with the Center's current signed release installed and enabled. It holds no
// token, no settings and nothing private, so it can be sent to anyone; the plugin then updates itself.
const STARTER_GUIDE=`# 开始使用 RSSD

这个 vault 已经装好 RSSD 插件，以后的新版本会自动更新。

1. 打开这个文件夹时，Obsidian 会问是否信任插件作者：选 **信任作者并启用插件**。
2. 打开 **设置 → 钥匙串（Keychain）**，点 **+**，名字随意（例如 \`rssd\`），把你拿到的设备密钥粘贴进去。
3. 打开 **设置 → RSSD**，在 **Device token from the Keychain** 里选中刚才的名字。看到登录成功的提示就好了。
4. 左侧的 **Works** 列表点 **Update**，就会下载你能看到的空间里的作品。

没有密钥的话，也可以在 **设置 → RSSD** 点 **Log in**，在浏览器里登录 Center 并批准这台设备。

密钥只给你一个人用，不要转发。不再需要时，告诉管理员撤销它。
`;
/** A zip of [{name, bytes}], names marked UTF-8 so 开始使用.md reads right on every system. */
export function zipFiles(entries){
 const locals=[],centrals=[],now=new Date();let offset=0;
 const stamp=((((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate())<<16|((now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1)))>>>0;
 for(const {name,bytes} of entries){
  const nameBytes=Buffer.from(name,'utf8'),data=deflateRawSync(bytes),crc=crc32(bytes);
  const head=Buffer.alloc(30);head.writeUInt32LE(0x04034b50,0);head.writeUInt16LE(20,4);head.writeUInt16LE(0x0800,6);head.writeUInt16LE(8,8);
  head.writeUInt32LE(stamp,10);head.writeUInt32LE(crc,14);head.writeUInt32LE(data.length,18);head.writeUInt32LE(bytes.length,22);head.writeUInt16LE(nameBytes.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(0x031e,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x0800,8);central.writeUInt16LE(8,10);
  central.writeUInt32LE(stamp,12);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(nameBytes.length,28);
  central.writeUInt32LE((0o100644<<16)>>>0,38);central.writeUInt32LE(offset,42);
  locals.push(head,nameBytes,data);centrals.push(central,nameBytes);offset+=head.length+nameBytes.length+data.length;
 }
 const directory=Buffer.concat(centrals),end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,directory,end]);
}
async function starter(){
 const origin=option('origin',/DEFAULT_ORIGIN=.*?'(https:\/\/[^']+)'/.exec(await readFile('src/main.js','utf8'))[1]);
 const {readRelease,verifyRelease,releasePath}=await import(pathToFileURL(join(process.cwd(),'src','self-update.mjs')).href);
 const response=await fetch(releasePath(origin)+'/latest');
 if(!response.ok)stop('The Center did not return its latest release (HTTP '+response.status+')');
 const release=readRelease(await response.json());
 if(!release)stop('The Center returned an invalid release');
 // Checked exactly as a vault checks an update: the signature against release-key.pub, then every file's hash.
 if(!await verifyRelease(release,(await readFile('release-key.pub','utf8')).trim()))stop('Release '+release.version+' is not signed with release-key.pub');
 const entries=[];
 for(const file of release.files){
  const got=await fetch(releasePath(origin)+'/files/'+file.sha256);
  const bytes=Buffer.from(await got.arrayBuffer());
  if(!got.ok||bytes.length!==file.size||sha256(bytes)!==file.sha256)stop(file.name+' does not match the signed release');
  entries.push({name:'RSSD/.obsidian/plugins/rssd/'+file.name,bytes});
 }
 entries.push({name:'RSSD/.obsidian/community-plugins.json',bytes:Buffer.from(JSON.stringify(['rssd'])+'\n')},{name:'RSSD/开始使用.md',bytes:Buffer.from(STARTER_GUIDE)});
 const out=option('out','.'),zip=join(out,'rssd-starter-vault-'+release.version+'.zip');
 await mkdir(out,{recursive:true});await writeFile(zip,zipFiles(entries));
 console.log('Starter vault for RSSD '+release.version+' (rssd-obsidian '+release.commit.slice(0,7)+'): '+resolve(zip)+'\nUnzip, open the RSSD folder in Obsidian and trust the plugin; it updates itself from then on.');
}

const command=args[0];
try{
 if(command==='key')await createKey();
 else if(command==='publish')await publish();
 else if(command==='starter')await starter();
 else stop('Usage: node release.mjs key [--rotate] | publish [--dry-run] [--out <folder>] [--origin <url>] [--server <ssh host>] [--plugin-ref <branch>] | starter [--out <folder>] [--origin <url>]');
}catch(error){console.error(error.stop?error.message:error);process.exitCode=1;}
