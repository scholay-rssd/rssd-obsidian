// The computer outside the vault, through the Electron that Obsidian runs in on a desktop: folder and save
// dialogs, the file manager, and dragging a card out as a real file, as from a folder. None of it exists on a
// phone or tablet, where `desktop()` is null and the card view offers copying only.

/** Electron and Node in Obsidian's window, or null where there are none. */
export function desktop(){
 try{
  const load=globalThis.window?.require;if(typeof load!=='function')return null;
  const electron=load('electron'),remote=electron?.remote;
  if(!remote?.dialog||!remote.getCurrentWebContents)return null;
  return {remote,shell:electron.shell||remote.shell,fs:load('fs'),path:load('path'),os:load('os')};
 }catch{return null;}
}

/** Ask for a folder; null when the person cancels. */
export async function chooseFolder(d,{title,defaultPath,buttonLabel}){
 const result=await d.remote.dialog.showOpenDialog(d.remote.getCurrentWindow(),{title,defaultPath,buttonLabel,properties:['openDirectory','createDirectory']});
 return result.canceled||!result.filePaths?.length?null:result.filePaths[0];
}

/** Ask where to save one file; null when the person cancels. */
export async function chooseFile(d,{title,defaultPath}){
 const result=await d.remote.dialog.showSaveDialog(d.remote.getCurrentWindow(),{title,defaultPath,filters:[{name:'PNG',extensions:['png']}]});
 return result.canceled||!result.filePath?null:result.filePath;
}

const bytesOf=async file=>file.text!=null?Buffer.from(file.text,'utf8'):Buffer.from(await file.blob.arrayBuffer());

/** Write `files` ([{name, blob|text}]) into a new folder `name` inside `parent`. Returns the folder's path. */
export async function writeFolder(d,parent,name,files){
 const folder=d.path.join(parent,name);
 await d.fs.promises.mkdir(folder,{recursive:true});
 for(const file of files)await d.fs.promises.writeFile(d.path.join(folder,file.name),await bytesOf(file));
 return folder;
}

/** Write one file at `path`. */
export async function writeFile(d,path,file){await d.fs.promises.writeFile(path,await bytesOf(file));}

/** Show a file or folder in Finder or Explorer. */
export function reveal(d,path){try{d.shell.showItemInFolder(path);}catch{}}

/**
 * Cards dragged out of Obsidian travel as files: each is written once to a folder of its own in the system's
 * temporary folder, and the drag is handed to the system as a file drag, so a browser's upload area, Finder or
 * a chat window takes it as if it came from a folder. The folder is emptied when the plug-in stops.
 */
export class CardDrag{
 constructor(d){this.d=d;this.folder=d.path.join(d.os.tmpdir(),'rssd-card-drag-'+process.pid);this.written=new Map();this.ready=new Map();this.count=0;}
 /** Have the file ready before a drag starts, which must hand over a file that is already there. */
 async prepare(key,name,blob){
  if(this.written.has(key))return this.written.get(key);
  const pending=(async()=>{
   // A folder per card: two works may give their cards the same name.
   const folder=this.d.path.join(this.folder,String(++this.count));
   await this.d.fs.promises.mkdir(folder,{recursive:true});
   const path=this.d.path.join(folder,name);
   await this.d.fs.promises.writeFile(path,Buffer.from(await blob.arrayBuffer()));
   return path;
  })();
  this.written.set(key,pending);
  try{const path=await pending;this.ready.set(key,path);return path;}catch(error){this.written.delete(key);throw error;}
 }
 /** Start a system drag of the prepared files; false when one is not ready yet. */
 start(keys){
  const files=keys.map(key=>this.ready.get(key));if(!files.length||files.some(file=>!file))return false;
  let icon;try{icon=this.d.remote.nativeImage.createFromPath(files[0]).resize({width:72});}catch{icon=files[0];}
  this.d.remote.getCurrentWebContents().startDrag({file:files[0],files,icon});
  return true;
 }
 /** Remove the drag files. */
 clear(){this.written.clear();this.ready.clear();try{this.d.fs.rmSync(this.folder,{recursive:true,force:true});}catch{}}
}
