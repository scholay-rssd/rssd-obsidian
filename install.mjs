// Copies the built plugin into a vault: node install.mjs /path/to/vault
import {mkdir,copyFile,access} from 'node:fs/promises';
import {join,resolve} from 'node:path';

const vault=process.argv[2];
if(!vault){console.error('Usage: node install.mjs /path/to/vault');process.exit(1);}
const root=resolve(vault);
try{await access(join(root,'.obsidian'));}catch{console.error('Not an Obsidian vault (no .obsidian folder): '+root+'\nOpen the folder in Obsidian once first.');process.exit(1);}
for(const file of ['main.js','manifest.json'])try{await access(join('dist',file));}catch{console.error('Run "npm run build" first.');process.exit(1);}
const target=join(root,'.obsidian','plugins','rssd');
await mkdir(target,{recursive:true});
for(const file of ['main.js','manifest.json'])await copyFile(join('dist',file),join(target,file));
console.log('Installed to '+target+'\nIn Obsidian: Settings → Community plugins → turn off Restricted mode → enable "RSSD".');
