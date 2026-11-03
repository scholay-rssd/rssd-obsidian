// Device login against the Center, the same flow as `rssd center login` (scripts/rssd-device-login.mjs): the
// person approves the device and its spaces in the browser; the plugin only ever sees the resulting token.
import {CenterError,centerOrigin,centerRequest} from './center-client.mjs';

export async function deviceLogin({http,origin,name,onCode,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),now=()=>Date.now(),signal}){
 origin=centerOrigin(origin);
 const start=await centerRequest(http,origin,'/auth/start',{method:'POST',body:{mode:'device',name}});
 if(new URL(start.verificationUriComplete).origin!==origin)throw Error('Authorization address does not match the Center');
 onCode({verificationUri:start.verificationUri,verificationUriComplete:start.verificationUriComplete,userCode:start.userCode,expiresIn:start.expiresIn});
 const deadline=now()+Math.min(start.expiresIn,600)*1000;let interval=Math.max(5,start.interval||5);
 while(now()<deadline){
  if(signal?.aborted)throw new CenterError('Login cancelled',{code:'cancelled'});
  await sleep(interval*1000);
  if(signal?.aborted)throw new CenterError('Login cancelled',{code:'cancelled'});
  try{return await centerRequest(http,origin,'/auth/token',{method:'POST',body:{grantType:'device_code',deviceCode:start.deviceCode}});}
  catch(error){if(error.code==='authorization_pending')continue;if(error.code==='slow_down'){interval+=5;continue;}throw error;}
 }
 throw new CenterError('Authorization expired; start login again',{code:'expired_token'});
}
