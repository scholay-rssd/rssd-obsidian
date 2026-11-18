import esbuild from 'esbuild';
import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
import {wechatTemplates,wechatSites,cardTemplates,katexAssets} from './build-templates.mjs';

await mkdir('dist',{recursive:true});
// Vaults install an update only when it is signed with the private half of this key (see release.mjs).
const releaseKey=await readFile('release-key.pub','utf8').then(text=>text.trim(),()=>'');
await esbuild.build({
 entryPoints:['src/main.js'],bundle:true,format:'cjs',target:'es2020',platform:'browser',
 external:['obsidian','electron'],outfile:'dist/main.js',logLevel:'info',
 // RSSD_DEFAULT_ORIGIN=https://center.example.org npm run build pre-fills another Center.
 define:{RSSD_WECHAT_TEMPLATES:JSON.stringify(wechatTemplates()),RSSD_WECHAT_SITES:JSON.stringify(wechatSites()),RSSD_CARD_TEMPLATES:JSON.stringify(cardTemplates()),RSSD_KATEX:JSON.stringify(katexAssets()),RSSD_RELEASE_KEY:JSON.stringify(releaseKey),RSSD_BUILD_VERSION:JSON.stringify(process.env.RSSD_RELEASE_VERSION||''),...(process.env.RSSD_DEFAULT_ORIGIN?{RSSD_DEFAULT_ORIGIN:JSON.stringify(process.env.RSSD_DEFAULT_ORIGIN)}:{})},
});
// A release build carries the version the release command assigned; any other build keeps manifest.json's.
if(process.env.RSSD_RELEASE_VERSION){
 const manifest=JSON.parse(await readFile('manifest.json','utf8'));
 await writeFile('dist/manifest.json',JSON.stringify({...manifest,version:process.env.RSSD_RELEASE_VERSION},null,2)+'\n');
}else await copyFile('manifest.json','dist/manifest.json');
