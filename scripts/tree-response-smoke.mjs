// Hold a real file response at the supported IPC fetch boundary. Neither the
// bridge nor repository history is replaced with artificial values.
export async function treeResponseSmoke(page) {
  await page.locator(".conflict-overlay").getByRole("button",{name:"Show files",exact:true}).click();
  await page.evaluate(async()=>{
    const original=window.fetch,bridge=window.__TAURI_INTERNALS__,url=bridge.convertFileSrc("file_text","ipc"),probe=bridge.convertFileSrc("plugin:app|version","ipc");
    const gate=window.__treeResponseGate={held:false,release:null,original,count:0,probes:0};
    gate.intercepted=async function(input,init){
      const address=typeof input==="string"?input:input?.url??String(input);
      if(address===probe)gate.probes++;
      const response=await Reflect.apply(original,window,[input,init]);
      if(address===url&&++gate.count===1){
        if(!response.ok||response.headers.get("Tauri-Response")!=="ok")throw Error("Expected native file response");
        return new Promise(resolve=>{gate.release=()=>resolve(response);gate.held=true;});
      }
      return response;
    };
    if(!Reflect.set(window,"fetch",gate.intercepted)||window.fetch!==gate.intercepted)throw Error("File response gate was not installed");
    await bridge.invoke("plugin:app|version");
    if(gate.probes!==1)throw Error("File response gate did not observe the native transport probe");
  });
  try {
    await page.locator(".conflict-overlay .sb-item").filter({hasText:"README.md"}).click();
    await page.waitForFunction(()=>window.__treeResponseGate.held);
    await page.locator(".conflict-overlay .sb-item").filter({hasText:"app.ts"}).click();
    await page.locator(".conflict-overlay .cm-content").filter({hasText:"export function greet"}).waitFor();
    const before=await page.locator(".conflict-overlay .cm-content").textContent();
    await page.evaluate(async()=>{
      window.__treeResponseGate.release();
      await window.__TAURI_INTERNALS__.invoke("plugin:app|version");
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    });
    const after=await page.locator(".conflict-overlay .cm-content").textContent();
    if(after!==before)throw Error("A late README response replaced the selected source file");
    if(await page.locator(".conflict-overlay .sb-item.selected .label").textContent()!=="app.ts")throw Error("The file selection unexpectedly changed");
  } finally {
    await page.evaluate(()=>{const gate=window.__treeResponseGate;if(!gate)return;gate.release?.();if(window.fetch!==gate.intercepted)throw Error("File response gate ownership was lost");window.fetch=gate.original;delete window.__treeResponseGate;});
  }
}
