import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {timedExecFileSync as execFileSync} from "./ci-timing.mjs";
import {openRepository} from "./ui-readiness.mjs";

export async function fileEditingSmoke({page,work,returnRoot,shot}) {
  const root=path.join(work,"keyboard-file-editor");fs.mkdirSync(root,{recursive:true});
  const git=(...args)=>execFileSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true,env:{...process.env,GIT_OPTIONAL_LOCKS:"0"}}).trim();
  git("init","-qb","main");for(const [k,v] of [["user.name","File editor"],["user.email","edit@example.invalid"],["commit.gpgsign","false"],["core.autocrlf","false"]])git("config",k,v);
  fs.mkdirSync(path.join(root,"z"));for(const [file,text] of [["a.txt","base A\n"],["b.txt","base B\n"],["z/c.txt","base C\n"]])fs.writeFileSync(path.join(root,file),text);
  git("add",".");git("commit","-qm","Files for keyboard navigation");const head=git("rev-parse","HEAD");
  fs.writeFileSync(path.join(root,"b.txt"),"prepared B\n");git("add","b.txt");
  fs.writeFileSync(path.join(root,"b.txt"),"latest B\n");fs.writeFileSync(path.join(root,"z/c.txt"),"latest C\n");
  const initial="\uFEFF\t\talpha value\r\n\t\tbeta",file=path.join(root,"a.txt");fs.writeFileSync(file,initial);
  const index=fs.readFileSync(path.join(root,".git/index"));
  const prefs=await page.evaluate(()=>JSON.parse(localStorage.getItem("revqora.settings")).state);
  await openRepository(page,root);
  const changes=()=>page.locator(".view-tab").filter({hasText:/Changes/}).click();
  const history=()=>page.locator(".view-tab").filter({hasText:/History/}).click();
  const selected=()=>page.locator(".changes [data-file-nav].selected .fname");
  const diff=text=>page.locator(".changes .diff-body").filter({hasText:text}).waitFor();
  try {
    await changes();await page.getByTitle("Flat list",{exact:true}).click();
    await page.locator(".changes [data-file-nav]").filter({has:page.getByText("a.txt",{exact:true})}).first().click();
    await page.keyboard.press("ArrowDown");await diff("latest B");
    await page.keyboard.press("ArrowDown");await diff("latest C");
    await page.keyboard.press("ArrowDown");await diff("prepared B"); // Same path, different staging side.
    await page.keyboard.press("Home");await diff("alpha value");assert.equal(await selected().innerText(),"a.txt");
    await page.keyboard.press("ArrowUp");assert.equal(await selected().innerText(),"a.txt");
    await page.getByTitle("Group by folder",{exact:true}).click();await page.locator(".changes .folder-row").filter({has:page.getByText("z",{exact:true})}).click();
    await page.getByLabel("Changed files",{exact:true}).focus();await page.keyboard.press("End");await diff("prepared B");
    await page.keyboard.press("Home");await diff("alpha value");
    const raw=await page.locator(".changes .diff-body").textContent();
    const whitespace=page.locator(".changes").getByRole("button",{name:"Show whitespace",exact:true});
    if(await whitespace.getAttribute("aria-pressed")!=="true")await whitespace.click();
    await page.locator(".changes .ws-tab").first().waitFor();assert.equal(await page.locator(".changes .diff-body").textContent(),raw,"Whitespace markers must not replace actual source text");
    await page.getByRole("button",{name:"Edit working file",exact:true}).click();
    const content=page.getByRole("textbox",{name:"Working file content",exact:true});await content.waitFor();
    await page.getByLabel("Spaces per tab",{exact:true}).selectOption("2");await page.getByRole("button",{name:"Tabs → spaces",exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector(".working-code .cm-highlightTab"));
    assert.equal(fs.readFileSync(file,"utf8"),initial,"Conversion must remain a draft until Save");
    await content.press("Control+z");await page.locator(".working-code .cm-highlightTab").first().waitFor();
    await page.getByRole("button",{name:"Redo",exact:true}).click();await page.waitForFunction(()=>!document.querySelector(".working-code .cm-highlightTab"));
    await content.press("Control+End");await page.keyboard.insertText(" // edited");
    // Exercise the real clipboard handler with LF input in a CRLF document.
    // It must create editor lines and serialize back to the original separator.
    assert(await content.evaluate(el=>{const data=new DataTransfer();data.setData("text/plain","\n\tpasted\nend");return !el.dispatchEvent(new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:data}));}),"CodeMirror must handle the paste event");
    await page.waitForFunction(()=>document.querySelectorAll(".working-code .cm-line").length===4);
    await content.press("Alt+ArrowDown");assert.equal(await selected().innerText(),"a.txt","Editor arrows must not switch files");
    if(process.platform==="win32") {
      const externalWriter=fs.openSync(file,"r+");
      try {
        await content.press("Control+s");await page.getByRole("alert").filter({hasText:"another editor's write handle"}).waitFor();
        assert.equal(fs.readFileSync(file,"utf8"),initial,"A competing writer must prevent any save");
      } finally {fs.closeSync(externalWriter);}
    }
    await content.press("Control+s");await page.waitForFunction(()=>{const button=document.querySelector(".modal button.primary");return button?.disabled&&button.textContent==="Save file"&&document.querySelector(".modal [role='status']")?.textContent==="Saved";});
    assert.equal(fs.readFileSync(file,"utf8"),"\uFEFF    alpha value\r\n    beta // edited\r\n\tpasted\r\nend");assert(index.equals(fs.readFileSync(path.join(root,".git/index"))));
    if(shot)await shot("working-file-editor");
    await content.press("Control+End");await page.keyboard.insertText(" draft retained");
    await content.press("Escape");
    await page.waitForFunction(()=>document.querySelectorAll(".modal").length===2&&document.activeElement?.textContent==="Cancel");
    const draft=await page.locator(".working-code .cm-content").innerText();
    await page.keyboard.type("BLOCKEDINPUT");await page.keyboard.press("Control+s");
    assert.equal(await page.locator(".working-code .cm-content").innerText(),draft,"Typing under the confirmation changed the draft");
    assert.equal(fs.readFileSync(file,"utf8"),"\uFEFF    alpha value\r\n    beta // edited\r\n\tpasted\r\nend","Ctrl+S under the confirmation saved the draft");
    assert.equal(await page.locator(".modal-backdrop[inert]").count(),1);
    await page.getByRole("button",{name:"Cancel",exact:true}).click();
    await page.waitForFunction(()=>!!document.activeElement?.closest(".working-code"));
    assert((await content.innerText()).includes("draft retained"),"Cancelling Close must retain the editor draft");
    fs.writeFileSync(file,"IDE latest\n");await page.getByRole("button",{name:"Save file",exact:true}).click();
    await page.getByRole("alert").filter({hasText:"Your draft is kept"}).waitFor();assert((await content.innerText()).includes("draft retained"));assert.equal(fs.readFileSync(file,"utf8"),"IDE latest\n");
    await page.getByRole("button",{name:"Reload from disk",exact:true}).click();await page.getByRole("button",{name:"Discard draft",exact:true}).click();
    await page.waitForFunction(()=>document.querySelector(".working-code .cm-content")?.textContent.includes("IDE latest"));
    await page.locator(".modal").getByRole("button",{name:"Close",exact:true}).click();
    await history();const toggle=page.getByTitle("Toggle branches panel",{exact:true});if(await toggle.getAttribute("aria-expanded")!=="true")await toggle.click();
    await page.locator('.sidebar [data-branch-kind="local"][data-branch-name="main"]').click();
    const commitFiles=page.getByLabel("Commit files",{exact:true});await commitFiles.locator("[data-file-nav]").first().click();await page.keyboard.press("ArrowDown");
    await page.waitForFunction(()=>document.querySelector(".commit-preview [data-file-nav].selected .fname")?.textContent==="b.txt");
    await page.keyboard.press("Alt+ArrowDown");await page.waitForFunction(()=>document.querySelector(".commit-preview [data-file-nav].selected .fname")?.textContent==="c.txt");
    const historyBinding=()=>page.getByText("Show history",{exact:true}).locator("xpath=following-sibling::button[1]");
    for(const key of ["Home","End","ArrowUp","ArrowDown"]) {
      await page.getByTitle("Settings",{exact:true}).click();await historyBinding().click();await historyBinding().press(key);
      await page.locator(".modal").getByRole("button",{name:"Done",exact:true}).click();
      await changes();await page.getByLabel("Changed files",{exact:true}).focus();await page.keyboard.press(key);
      await page.locator(".changes").waitFor({state:"detached"});
    }
    await page.getByTitle("Settings",{exact:true}).click();
    if(prefs.shortcuts?.history) {await historyBinding().click();await historyBinding().press(prefs.shortcuts.history.replaceAll("Ctrl","Control"));}
    else await historyBinding().locator("xpath=following-sibling::button[1]").click();
    await page.locator(".modal").getByRole("button",{name:"Done",exact:true}).click();
    assert.equal(git("rev-parse","HEAD"),head);assert(index.equals(fs.readFileSync(path.join(root,".git/index"))));
    console.log("File navigation/editor: stage-side identity, collapsed folders, whitespace, undo, CRLF/BOM, stale-save rejection and index/HEAD preservation passed");
  } catch(error) {
    // Retain the actual UI and original failure for the caller's screenshot.
    throw error;
  }
  {
    // Restore successful-scenario preferences through normal controls.
    await changes();await page.getByTitle(prefs.fileView==="tree"?"Group by folder":"Flat list",{exact:true}).click();
    const toggle=page.locator(".changes").getByRole("button",{name:"Show whitespace",exact:true});if((await toggle.getAttribute("aria-pressed")==="true")!==!!prefs.showWhitespace)await toggle.click();
    await page.getByRole("button",{name:"Close keyboard-file-editor",exact:true}).click();await openRepository(page,returnRoot);
  }
}
