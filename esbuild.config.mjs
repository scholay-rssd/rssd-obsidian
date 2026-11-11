import esbuild from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
import {wechatTemplates,wechatSites,cardTemplates} from './build-templates.mjs';

await mkdir('dist',{recursive:true});
await esbuild.build({
 entryPoints:['src/main.js'],bundle:true,format:'cjs',target:'es2020',platform:'browser',
 external:['obsidian','electron'],outfile:'dist/main.js',logLevel:'info',
 // RSSD_DEFAULT_ORIGIN=https://center.example.org npm run build pre-fills another Center.
 define:{RSSD_WECHAT_TEMPLATES:JSON.stringify(wechatTemplates()),RSSD_WECHAT_SITES:JSON.stringify(wechatSites()),RSSD_CARD_TEMPLATES:JSON.stringify(cardTemplates()),...(process.env.RSSD_DEFAULT_ORIGIN?{RSSD_DEFAULT_ORIGIN:JSON.stringify(process.env.RSSD_DEFAULT_ORIGIN)}:{})},
});
await copyFile('manifest.json','dist/manifest.json');
