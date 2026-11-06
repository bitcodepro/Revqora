import ssh2 from "ssh2";
import fs from "node:fs";
import path from "node:path";
import {generateKeyPairSync,createHash} from "node:crypto";
import {spawn,execFileSync} from "node:child_process";
const {Server,utils:{parseKey}}=ssh2;
export async function createSshGitFixture({bare,keys,password}){
  const clients=new Set(),children=new Set(),auth=[],commands=[];let server,port=0,keyboard=true;
  const validKeys=keys.map(({name,file})=>({name,key:parseKey(fs.readFileSync(file))}));
  const privateHost=()=>generateKeyPairSync("rsa",{modulusLength:2048,privateKeyEncoding:{type:"pkcs1",format:"pem"},publicKeyEncoding:{type:"pkcs1",format:"pem"}}).privateKey;
  let hostKey=privateHost();
  const start=async()=>{
    server=new Server({hostKeys:[hostKey]},client=>{
      clients.add(client);client.on("error",()=>{}).on("close",()=>clients.delete(client));
      client.on("authentication",ctx=>{
        if(ctx.username!=="git")return ctx.reject();
        if(ctx.method==="publickey"){
          const found=validKeys.find(({key})=>key.type===ctx.key.algo&&key.getPublicSSH().equals(ctx.key.data));
          if(!found||ctx.signature&&found.key.verify(ctx.blob,ctx.signature,ctx.hashAlgo)!==true)return ctx.reject();
          if(ctx.signature)auth.push({method:"publickey",key:found.name});return ctx.accept();
        }
        if(ctx.method==="keyboard-interactive"&&keyboard)return ctx.prompt([{prompt:"Password for 'https://bitbucket.org': ",echo:false}],answers=>{if(answers[0]===password){auth.push({method:"keyboard-interactive"});ctx.accept();}else ctx.reject();});
        if(ctx.method==="password"&&ctx.password===password){auth.push({method:"password"});return ctx.accept();}
        return ctx.reject(keyboard?["publickey","keyboard-interactive","password"]:["publickey","password"]);
      });
      client.on("ready",()=>client.on("session",accept=>{
        const session=accept();session.on("exec",(accept,reject,info)=>{
          const match=/^(git-upload-pack|git-receive-pack) ['"]?\/?(team\/repo\.git|owner\/repo\.git|workspace\/repo\.git|group\/repo\.git|v3\/org\/project\/repo)['"]?$/.exec(info.command);
          if(!match)return reject();commands.push({operation:match[1],repository:match[2]});const stream=accept();
          const child=spawn("git",[match[1]==="git-upload-pack"?"upload-pack":"receive-pack",bare],{cwd:path.dirname(bare),windowsHide:true,stdio:["pipe","pipe","pipe"]});children.add(child);
          child.on("error",()=>{stream.stderr.write("Git fixture process could not start\n");stream.exit(1);stream.end();});
          stream.pipe(child.stdin);child.stdin.on("error",()=>{});child.stdout.pipe(stream,{end:false});child.stderr.pipe(stream.stderr,{end:false});
          child.on("close",code=>{children.delete(child);if(!stream.destroyed){stream.exit(code??1);stream.end();}});
          stream.on("close",()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});
        });
      }));
    });
    await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(port,"127.0.0.1",resolve);});port=server.address().port;
  };
  const stop=async()=>{for(const client of clients)client.destroy();await new Promise(resolve=>server.close(resolve));for(const child of children){if(child.exitCode!==null||child.signalCode!==null)continue;if(process.platform==="win32"){try{execFileSync("taskkill.exe",["/PID",String(child.pid),"/T","/F"],{stdio:"ignore",windowsHide:true});}catch{child.kill();}}else child.kill();}if(children.size)await Promise.all([...children].map(child=>new Promise(resolve=>child.once("close",resolve))));};
  await start();
  return {get port(){return port;},get fingerprint(){return "SHA256:"+createHash("sha256").update(parseKey(hostKey).getPublicSSH()).digest("base64").replace(/=+$/,"");},auth,commands,setKeyboard(value){keyboard=value;},async rotateHostKey(){await stop();hostKey=privateHost();await start();},close:stop};
}
