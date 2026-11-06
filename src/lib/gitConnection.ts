import type {GitConnectionOptions} from "./types";
export const defaultGitConnection=():GitConnectionOptions=>({https:"auto",ssh:"auto",privateKey:"",sshProgram:""});
export function gitTransport(source:string):"ssh"|"https"|"local" {
  if(/^https?:\/\//i.test(source))return "https";
  if(/^(ssh|git\+ssh):\/\//i.test(source))return "ssh";
  if(/^(?:file:\/\/|[/\\]|[a-z]:[/\\])/i.test(source))return "local";
  return /^(?:[^@/:\\\s]+@)?[^/:\\\s]+:.+/.test(source)?"ssh":"local";
}
