import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {timedExecFileSync as execFileSync} from "./ci-timing.mjs";
import {openRepository} from "./ui-readiness.mjs";
import {interceptClipboard} from "./name-path-copy-smoke.mjs";

export async function fileEditingSmoke({page,work,returnRoot,shot}) {
  const root=path.join(work,"keyboard-file-editor");fs.mkdirSync(root,{recursive:true});
  const git=(...args)=>execFileSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true,env:{...process.env,GIT_OPTIONAL_LOCKS:"0"}}).trim();
  git("init","-qb","main");for(const [k,v] of [["user.name","File editor"],["user.email","edit@example.invalid"],["commit.gpgsign","false"],["core.autocrlf","false"]])git("config",k,v);
  fs.mkdirSync(path.join(root,"z"));for(const [file,text] of [["a.txt","base A\n"],["b.txt","base B\nbase_token base_token base_token_extra\n"],["z/c.txt","base C\n"]])fs.writeFileSync(path.join(root,file),text);
  git("add",".");git("commit","-qm","Files for keyboard navigation");const head=git("rev-parse","HEAD");
  fs.writeFileSync(path.join(root,"b.txt"),"prepared B\n");git("add","b.txt");
  fs.writeFileSync(path.join(root,"b.txt"),"latest B\nitem_id item_id item_identifier\n");fs.writeFileSync(path.join(root,"z/c.txt"),"latest C\n");
  const initial="\uFEFF\t\talpha value\r\n\t\tbeta",file=path.join(root,"a.txt");fs.writeFileSync(file,initial);
  const index=fs.readFileSync(path.join(root,".git/index"));
  const prefs=await page.evaluate(()=>JSON.parse(localStorage.getItem("revqora.settings")).state);
  await openRepository(page,root);
  const changes=()=>page.locator(".view-tab").filter({hasText:/Changes/}).click();
  const history=()=>page.locator(".view-tab").filter({hasText:/History/}).click();
  const selected=()=>page.locator(".changes [data-file-nav].selected .fname");
  const diff=text=>page.locator(".changes .diff-body").filter({hasText:text}).waitFor();
  const checkFileCopy=async row=>{
    await interceptClipboard(page);
    try {
      for (const [label,expected] of [["Copy name","c.txt"],["Copy path","z/c.txt"]]) {
        await row.click({button:"right"});
        await page.locator(".ctx-menu").getByText(label,{exact:true}).click();
        await page.waitForFunction(text=>window.__namePathCopies.at(-1)===text,expected);
      }
    } finally { await page.evaluate(()=>window.__restoreNamePathClipboard?.()); }
  };
  const selectWord=async(scope,word)=>{
    const line=scope.locator(".diff-body .code").filter({hasText:word}).first();
    await line.scrollIntoViewIfNeeded();
    const point=await line.evaluate((code,word)=>{
      const walker=document.createTreeWalker(code,NodeFilter.SHOW_TEXT);
      for(let node=walker.nextNode();node;node=walker.nextNode()){
        const start=node.textContent.indexOf(word);
        if(start<0)continue;
        const range=document.createRange();range.setStart(node,start);range.setEnd(node,start+word.length);
        const rect=range.getBoundingClientRect();
        return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
      }
      throw Error("The test word was not rendered");
    },word);
    await page.mouse.dblclick(point.x,point.y);
    await page.waitForFunction(word=>{
      const ranges=[...(CSS.highlights.get("revqora-diff-word")??[])];
      return ranges.length===2&&ranges.every(range=>range.toString()===word)&&getSelection()?.toString().trim()===word;
    },word).catch(async error=>{
      const actual=await page.evaluate(()=>({selection:getSelection()?.toString(),matches:[...(CSS.highlights.get("revqora-diff-word")??[])].map(range=>range.toString())}));
      throw new Error(`Double-click selection for ${word}: ${JSON.stringify(actual)}`,{cause:error});
    });
  };
  try {
    await changes();await page.getByTitle("Flat list",{exact:true}).click();
    const search=page.getByRole("textbox",{name:"Find changed files",exact:true});
    const names=page.locator(".changes [data-file-nav] .fname");
    await names.filter({hasText:"b.txt"}).nth(1).waitFor();
    await search.fill("B.TXT");
    assert.deepEqual(await names.allTextContents(),["b.txt","b.txt"],"The filter should include both staging sides");
    await search.fill("absent");await page.getByText("No matching files.",{exact:true}).waitFor();
    await page.getByRole("button",{name:"Clear file search",exact:true}).click();
    assert.equal(await names.count(),4);
    await checkFileCopy(page.locator(".changes [data-file-nav]").filter({has:page.getByText("c.txt",{exact:true})}));
    await page.locator(".changes [data-file-nav]").filter({has:page.getByText("a.txt",{exact:true})}).first().click();
    await page.keyboard.press("ArrowDown");await diff("latest B");
    const changesDiff=page.locator(".changes .diff");
    await changesDiff.getByTitle("Unified",{exact:true}).click();
    await selectWord(changesDiff,"item_id");
    await changesDiff.getByTitle("Side by side",{exact:true}).click();
    await page.waitForFunction(()=>[...(CSS.highlights.get("revqora-diff-word")??[])].filter(range=>range.toString()==="item_id").length===2);
    await changesDiff.getByTitle(prefs.diffMode==="split"?"Side by side":"Unified",{exact:true}).click();
    await page.getByLabel("Changed files",{exact:true}).focus();
    await page.keyboard.press("ArrowDown");await diff("latest C");
    await page.waitForFunction(()=>!CSS.highlights.has("revqora-diff-word"));
    await page.keyboard.press("ArrowDown");await diff("prepared B"); // Same path, different staging side.
    await page.keyboard.press("Home");await diff("alpha value");assert.equal(await selected().innerText(),"a.txt");
    await page.keyboard.press("ArrowUp");assert.equal(await selected().innerText(),"a.txt");
    await page.getByTitle("Group by folder",{exact:true}).click();await page.locator(".changes .folder-row").filter({has:page.getByText("z",{exact:true})}).click();
    await search.fill("z\\C.TXT");
    assert.deepEqual(await names.allTextContents(),["c.txt"],"Search should reveal matches inside collapsed folders");
    await search.press("Escape");
    assert.equal(await names.filter({hasText:"c.txt"}).count(),0,"Clearing search should restore collapsed folders");
    await page.getByLabel("Changed files",{exact:true}).focus();await page.keyboard.press("End");await diff("prepared B");
    await page.keyboard.press("Home");await diff("alpha value");
    const raw=await page.locator(".changes .diff-body").textContent();
    const whitespace=page.locator(".changes").getByRole("button",{name:"Show whitespace",exact:true});
    if(await whitespace.getAttribute("aria-pressed")!=="true")await whitespace.click();
    await page.locator(".changes .ws-tab").first().waitFor();assert.equal(await page.locator(".changes .diff-body").textContent(),raw,"Whitespace markers must not replace actual source text");
    await page.getByRole("button",{name:"Edit working file",exact:true}).click();
    const content=page.getByRole("textbox",{name:"Working file content",exact:true});await content.waitFor();
    assert.equal(await page.locator(".modal").count(),0,"The editor should use the Changes diff pane");
    await page.locator(".changes .cm-working-change").filter({hasText:"alpha value"}).waitFor();
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
    await content.press("Control+s");await page.waitForFunction(()=>{const button=document.querySelector(".working-file-editor button.primary");return button?.disabled&&button.textContent==="Save file"&&document.querySelector(".working-file-editor [role='status']")?.textContent==="Saved";});
    assert.equal(fs.readFileSync(file,"utf8"),"\uFEFF    alpha value\r\n    beta // edited\r\n\tpasted\r\nend");assert(index.equals(fs.readFileSync(path.join(root,".git/index"))));
    if(shot)await shot("working-file-editor");
    await content.press("Control+End");await page.keyboard.insertText(" draft retained");
    await content.press("Escape");
    await page.waitForFunction(()=>document.querySelectorAll(".modal").length===1&&document.activeElement?.textContent==="Cancel");
    const draft=await page.locator(".working-code .cm-content").innerText();
    await page.keyboard.type("BLOCKEDINPUT");await page.keyboard.press("Control+s");
    assert.equal(await page.locator(".working-code .cm-content").innerText(),draft,"Typing under the confirmation changed the draft");
    assert.equal(fs.readFileSync(file,"utf8"),"\uFEFF    alpha value\r\n    beta // edited\r\n\tpasted\r\nend","Ctrl+S under the confirmation saved the draft");
    await page.getByRole("button",{name:"Cancel",exact:true}).click();
    await page.waitForFunction(()=>!!document.activeElement?.closest(".working-code"));
    assert((await content.innerText()).includes("draft retained"),"Cancelling Close must retain the editor draft");
    fs.writeFileSync(file,"IDE latest\n");await page.getByRole("button",{name:"Save file",exact:true}).click();
    await page.getByRole("alert").filter({hasText:"Your draft is kept"}).waitFor();assert((await content.innerText()).includes("draft retained"));assert.equal(fs.readFileSync(file,"utf8"),"IDE latest\n");
    await page.getByRole("button",{name:"Reload from disk",exact:true}).click();await page.getByRole("button",{name:"Discard draft",exact:true}).click();
    await page.waitForFunction(()=>document.querySelector(".working-code .cm-content")?.textContent.includes("IDE latest"));
    await page.locator(".working-file-editor").getByRole("button",{name:"Close",exact:true}).click();
    await history();const toggle=page.getByRole("button",{name:"Toggle branches panel",exact:true});if(await toggle.getAttribute("aria-expanded")!=="true")await toggle.click();
    await page.locator('.sidebar [data-branch-kind="local"][data-branch-name="main"]').click();
    await page.locator(".graph-scroll .grow.branch-member").getByText("Files for keyboard navigation",{exact:true}).click();
    const commitFiles=page.getByLabel("Commit files",{exact:true});await commitFiles.locator("[data-file-nav]").first().click();await page.keyboard.press("ArrowDown");
    await page.waitForFunction(()=>document.querySelector(".commit-preview [data-file-nav].selected .fname")?.textContent==="b.txt");
    await selectWord(page.locator(".commit-preview .diff"),"base_token");
    await commitFiles.focus();
    await page.keyboard.press("Control+ArrowDown");await page.waitForFunction(()=>document.querySelector(".commit-preview [data-file-nav].selected .fname")?.textContent==="c.txt");
    await checkFileCopy(commitFiles.locator("[data-file-nav].selected"));
    const settings=page.locator(".modal").last();
    const openShortcuts=async()=>{
      await page.getByTitle("Settings",{exact:true}).click();
      await settings.getByRole("button",{name:"Shortcuts",exact:true}).click();
      await settings.getByRole("textbox",{name:"Find shortcut",exact:true}).fill("Show history");
    };
    const historyBinding=settings.getByRole("button",{name:"Change shortcut for Show history",exact:true});
    const done=()=>settings.getByRole("button",{name:"Done",exact:true}).click();
    await openShortcuts();
    const originalBinding=await historyBinding.textContent();
    for(const key of ["Home","End","ArrowUp","ArrowDown"]) {
      await historyBinding.click();
      await historyBinding.press(key);
      await settings.getByRole("alert").filter({hasText:"Use Ctrl, Command or Alt with a key, or use a function key."}).waitFor();
      await historyBinding.getByText("Press keys…",{exact:true}).waitFor();
      await historyBinding.press("Escape");
      await historyBinding.getByText(originalBinding,{exact:true}).waitFor();
    }
    await done();

    for(const [key,label] of [["Home","Home"],["End","End"],["ArrowUp","↑"],["ArrowDown","↓"]]) {
      await openShortcuts();await historyBinding.click();await historyBinding.press(`Control+Alt+${key}`);
      await historyBinding.getByText(`Ctrl+Alt+${label}`,{exact:true}).waitFor();
      await done();
      await changes();await page.getByLabel("Changed files",{exact:true}).focus();await page.keyboard.press(`Control+Alt+${key}`);
      await page.locator(".changes").waitFor({state:"detached"});
    }
    await openShortcuts();
    if(prefs.shortcuts?.history===undefined) await settings.getByTitle("Reset shortcut for Show history",{exact:true}).click();
    else {await historyBinding.click();await historyBinding.press(prefs.shortcuts.history.replaceAll("Ctrl","Control")||"Backspace");}
    await historyBinding.getByText(originalBinding,{exact:true}).waitFor();
    await done();
    assert.equal(git("rev-parse","HEAD"),head);assert(index.equals(fs.readFileSync(path.join(root,".git/index"))));
    fs.writeFileSync(path.join(root,"encoded.txt"),Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from("UTF-16 fixture\r\nПривет","utf16le")]));
    fs.writeFileSync(path.join(root,"genuine-binary.dat"),Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,1,2]));
    await changes();
    const encoded=page.locator(".changes [data-file-nav]").filter({has:page.getByText("encoded.txt",{exact:true})});
    await encoded.click();
    const preview=page.getByRole("region",{name:"File contents preview",exact:true});
    await preview.getByText("UTF-16 fixture",{exact:false}).waitFor();
    await preview.getByText("UTF-16LE · BOM",{exact:true}).waitFor();
    await page.locator(".changes [data-file-nav]").filter({has:page.getByText("genuine-binary.dat",{exact:true})}).click();
    await preview.getByRole("heading",{name:"Binary file",exact:true}).waitFor();
    console.log("File navigation/editor: stage-side identity, collapsed folders, shortcut validation and rebinding, whitespace, undo, CRLF/BOM, stale-save rejection and index/HEAD preservation passed");
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
