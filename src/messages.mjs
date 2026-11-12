// What to tell the person when a save is refused. The Center answers HTTP 409 for several different reasons;
// only `revision_conflict` means someone else changed the work. Every message ends with the Center's code so a
// report can name the real cause.
const REASONS={
 revision_conflict:'The Center has a newer version of this work. Your note was not changed; run "Update works" and merge by hand.',
 publication_pending:'The Center is still publishing this work. Wait a minute and save again.',
 identity_conflict:'The Center says this work\'s section, language or type differs from your note. Do not change the rssd-* properties.',
 source_conflict:'The Center cannot find the original this translation is based on.',
 stale_revision:'A newer edition exists at the Center. Run "Update works" first.',
 migration_staged:'This space is still migrating; its original site writer owns it, so the Center refuses saves until the cutover is complete. Your note was not changed.',
};
export function saveFailureMessage(error){
 const code=error?.code&&error.code!=='http_error'?error.code:'';
 if(error?.conflict){
  const reason=REASONS[code]||'The Center refused the save: '+(error.message||'conflict')+'.';
  return reason+(code?' ['+code+']':'');
 }
 if(error?.retained)return error.message+' Your save is kept; run the command again to recover it.';
 return 'Save failed: '+(error?.message||'unknown error')+(code?' ['+code+']':'');
}
/** One notice for a save of several works: how many were saved, and the first reason any could not be. */
export function saveManySummary({saved=[],unchanged=[],failed=[]}){
 const works=n=>n+(n===1?' work':' works');
 const parts=[];
 if(saved.length)parts.push('Saved '+works(saved.length)+' as private drafts. They are not published.');
 if(unchanged.length)parts.push(works(unchanged.length)+' had nothing to save.');
 if(failed.length){const first=failed[0];parts.push(works(failed.length)+' could not be saved. '+(first.file?.basename?first.file.basename+': ':'')+saveFailureMessage(first.error));}
 return parts.join(' ')||'Nothing to save';
}
