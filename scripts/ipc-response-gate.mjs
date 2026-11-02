// Passed directly to page.evaluate: keep this browser function self-contained.
// Tauri's bridge is read-only. Intercept the standard fetch boundary already
// used by the other native race tests, preserving real requests and responses.
export async function installWorkflowReviewGate(runId) {
 const target=window,bridge=target.__TAURI_INTERNALS__,original=target.fetch;
 if(target.__workflowReviewGate)throw Error("A workflow response gate is already installed");
 if(typeof original!=="function"||typeof bridge?.invoke!=="function"||typeof bridge?.convertFileSrc!=="function")throw Error("Workflow response gate requires native IPC and fetch");
 const reviewUrl=bridge.convertFileSrc("workflow_review","ipc"),executeUrl=bridge.convertFileSrc("workflow_execute","ipc"),probeUrl=bridge.convertFileSrc("plugin:app|version","ipc");
 let ready;
 const gate={installed:false,phase:"installing",held:false,release:null,reviews:0,executions:0,probes:0,probeResponses:0,error:null,ready:new Promise(resolve=>{ready=resolve;}),restore:null};
 const failed=message=>{gate.error=message;gate.phase="error";ready();};
 const intercepted=function(input,init){
  const url=typeof input==="string"?input:input?.url??String(input);
  if(url===executeUrl)gate.executions++;
  if(url===probeUrl){gate.probes++;return Reflect.apply(original,target,[input,init]).then(response=>{if(response.ok&&response.headers.get("Tauri-Response")==="ok")gate.probeResponses++;return response;});}
  if(url===reviewUrl){
   gate.reviews++;
   if(gate.reviews===1){
    gate.phase="awaiting-native-review";
    return Reflect.apply(original,target,[input,init]).then(async response=>{
     if(!response.ok||response.headers.get("Tauri-Response")!=="ok"){failed(`workflow_review returned an IPC error (HTTP ${response.status})`);return response;}
     try{const proof=await response.clone().json();if(proof?.runId!==runId){failed("workflow_review returned a different run ID");return response;}}
     catch{failed("workflow_review returned an unreadable response");return response;}
     return new Promise(resolve=>{gate.release=()=>{gate.phase="released";resolve(response);};gate.held=true;gate.phase="held";ready();});
    },error=>{failed("workflow_review fetch failed");throw error;});
   }
  }
  return Reflect.apply(original,target,[input,init]);
 };
 if(!Reflect.set(target,"fetch",intercepted)||target.fetch!==intercepted)throw Error("Workflow response gate could not replace window.fetch");
 gate.installed=true;
 gate.restore=()=>{
  gate.release?.();
  if(target.fetch!==intercepted)throw Error("Workflow response gate was replaced before restoration");
  if(!Reflect.set(target,"fetch",original)||target.fetch!==original)throw Error("Workflow response gate could not restore window.fetch");
  gate.installed=false;gate.phase="restored";delete target.__workflowReviewGate;
 };
 target.__workflowReviewGate=gate;
 let probeTimer;
 try{
  // Identity alone is insufficient: prove the native transport actually calls
  // the replacement. A postMessage fallback fails here, before the test waits.
  await Promise.race([
   bridge.invoke("plugin:app|version"),
   new Promise((_,reject)=>{probeTimer=setTimeout(()=>reject(Error("Native IPC fetch probe did not respond")),5000);}),
  ]);
  if(gate.probes!==1||gate.probeResponses!==1)throw Error("Native IPC did not complete the response gate's fetch probe");
  gate.phase="awaiting-review";
 }catch(error){gate.restore();throw error;}
 finally{clearTimeout(probeTimer);}
 return {installed:true,probes:gate.probes,probeResponses:gate.probeResponses};
}
