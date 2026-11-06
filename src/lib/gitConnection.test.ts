import {describe,it,expect} from "vitest";
import {gitTransport} from "./gitConnection";
describe("Git transports across hosting services",()=>{
  it.each(["git@github.com:owner/repo.git","git@bitbucket.org:team/repo.git","git@gitlab.com:group/repo.git","git@ssh.dev.azure.com:v3/org/project/repo","ssh://git@host:7999/TEAM/repo.git","work-alias:group/repo.git"])("recognizes SSH source %s",source=>expect(gitTransport(source)).toBe("ssh"));
  it.each(["https://github.com/o/r.git","https://bitbucket.org/w/r.git","https://gitlab.com/g/r.git","https://dev.azure.com/org/project/_git/repo"])("recognizes HTTPS source %s",source=>expect(gitTransport(source)).toBe("https"));
  it.each(["C:\\git\\repo.git","/repos/with:colon.git","file:///D:/repo.git","git clone demo.git",""])("does not misclassify literal local source %s",source=>expect(gitTransport(source)).toBe("local"));
});
