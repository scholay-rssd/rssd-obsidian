// One vault operation at a time, across buttons, commands and protocol links.
export class OperationGate {
 active = null;
 async run(action, execute) {
  if (this.active) throw Object.assign(Error('RSSD is busy: '+this.active+'. Wait for it to finish.'),{code:'operation_busy'});
  this.active=action;
  try { return await execute(); } finally { this.active=null; }
 }
}
export function automationRequest(params) {
 const action=params.do;
 if (!['login','pull','save','status','spaces'].includes(action)) throw Object.assign(Error('Unknown RSSD action'),{code:'unknown_action'});
 const id=params.requestId||crypto.randomUUID();
 if (!/^[a-zA-Z0-9_-]{1,96}$/.test(id)) throw Error('Invalid requestId');
 const path=params.path||'';
 if (action==='save'&&!/^Works\/[a-zA-Z0-9._:-]+\.md$/.test(path)) throw Error('Give the exact path Works/<id>.md');
 return {id,action,path:action==='save'?path:''};
}
export async function recordedOperation({request,read,write,execute}) {
 const previous=await read(request.id);
 if (previous) {
  if (previous.action!==request.action||previous.path!==request.path||previous.origin!==request.origin||previous.workspaceId!==request.workspaceId) throw Error('This requestId belongs to a different operation');
  // Even a running record is never replayed: a crash may have happened after a remote write.
  return previous;
 }
 const record={...request,state:'running',ok:null,at:new Date().toISOString()};
 await write(record);
 try { const result=await execute();Object.assign(record,{state:'completed',ok:true,result}); }
 catch(error) { Object.assign(record,{state:'failed',ok:false,error:error.message,code:error.code||null,status:error.status||null}); }
 record.at=new Date().toISOString();await write(record);return record;
}
