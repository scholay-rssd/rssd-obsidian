import esbuild from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';

await mkdir('dist',{recursive:true});
await esbuild.build({
 entryPoints:['src/main.js'],bundle:true,format:'cjs',target:'es2020',platform:'browser',
 external:['obsidian','electron'],outfile:'dist/main.js',logLevel:'info',
});
await copyFile('manifest.json','dist/manifest.json');
