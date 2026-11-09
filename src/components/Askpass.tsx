import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Eye, EyeOff, KeyRound, ShieldQuestion, UserRound } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import type { AskpassRequest, ForgeAccountsSnapshot } from "../lib/types";
import { bitbucketPromptKind } from "../lib/bitbucketCredentials";
import {gitHttpsPrompt,gitAccountMatches} from "../lib/gitCredentials";
import { Modal } from "./Modal";

/** Answers credential / passphrase / host-key prompts that git and ssh send to Revqora. */
export function AskpassHost() {
  const [queue, setQueue] = useState<AskpassRequest[]>([]);
  useEffect(() => {
    const un = listen<AskpassRequest>("askpass-request", (e) => setQueue((q) => [...q, e.payload]));
    return () => {
      un.then((f) => f());
    };
  }, []);
  const current = queue[0];
  if (!current) return null;
  const answer = (value: string | null) => {
    api.askpassRespond(current.id, value).catch(() => {});
    setQueue((q) => q.slice(1));
  };
  return <AskpassDialog key={current.id} req={current} onAnswer={answer} onAnswered={() => setQueue(q => q.filter(item => item.id !== current.id))} />;
}

/** Splits an OpenSSH host-key prompt into the explanation and the question. */
function splitPrompt(prompt: string): { detail: string; question: string } {
  const lines = prompt.trim().split(/\r?\n/);
  const question = lines.pop() ?? "";
  return { detail: lines.join("\n"), question };
}

function AskpassDialog({ req, onAnswer, onAnswered }: { req: AskpassRequest; onAnswer: (v: string | null) => void; onAnswered: () => void }) {
  const bitbucket = bitbucketPromptKind(req.prompt, req.origin);
  const destination=gitHttpsPrompt(req.prompt,req.origin);
  const [value, setValue] = useState(bitbucket === "username" ? "x-bitbucket-api-token-auth" : "");
  const [accounts, setAccounts] = useState<ForgeAccountsSnapshot | null>(null);
  const [account, setAccount] = useState("");
  const [sending, setSending] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    if (destination) void api.forgeAccounts().then(data => { if (live) setAccounts(data); }, () => {});
    return () => { live = false; };
  }, [req.prompt,req.origin]);
  const available = destination?accounts?.accounts.filter(a=>gitAccountMatches(a,destination))??[]:[];
  const useSaved = async () => {
    if (!accounts || !account || sending) return;
    setSending(true); setError("");
    try {
      if (!await api.forgeAccountGitRespond(req.id, account, accounts.revision)) throw new Error("This Git sign-in request has expired.");
      onAnswered();
    } catch (e) { setError(errorMessage(e)); setSending(false); }
  };
  const [show, setShow] = useState(false);
  const { detail, question } = splitPrompt(req.prompt);
  const host = req.prompt.match(/(?:https?:\/\/[^'\s]+|[\w.-]+@[\w.-]+|for '([^']+)')/)?.[0];

  if (req.kind === "yesno") {
    return (
      <Modal
        title="Unknown host"
        subtitle="SSH has not connected to this server before. Check the fingerprint before you trust it."
        icon={<ShieldQuestion size={18} />}
        tone="warn"
        wide
        onClose={() => onAnswer("no")}
        onSubmit={() => onAnswer("yes")}
        footer={
          <>
            <button type="button" className="btn" onClick={() => onAnswer("no")}>
              Don't connect
            </button>
            <button type="submit" className="btn primary">
              Trust and connect
            </button>
          </>
        }
      >
        {detail && <div className="code-list" style={{ maxHeight: 220 }}>{detail}</div>}
        <div className="muted">{question}</div>
      </Modal>
    );
  }

  const secret = req.kind === "secret";
  const title = bitbucket ? "Sign in to Bitbucket Cloud" : /passphrase/i.test(req.prompt) ? "Unlock SSH key" : req.origin === "ssh" ? "SSH authentication" : req.kind === "username" ? "Sign in" : secret ? "Password required" : "Git needs input";
  return (
    <Modal
      title={title}
      subtitle={req.origin === "ssh" ? "Requested by SSH" : host ? `Requested by git for ${host.replace(/^for '|'$/g, "")}` : "Requested by git"}
      icon={req.kind === "username" ? <UserRound size={18} /> : <KeyRound size={18} />}
      onClose={() => { if (!sending) onAnswer(null); }}
      onSubmit={() => { if (!sending) onAnswer(value); }}
      footer={
        <>
          <button type="button" className="btn" disabled={sending} onClick={() => onAnswer(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={sending}>
            Continue
          </button>
        </>
      }
    >
      <div className="field">
        <label style={{ whiteSpace: "pre-wrap", fontWeight: 500 }}>{bitbucket === "secret" ? "Bitbucket access token" : req.prompt.trim()}</label>
        <div className="input-wrap">
          <input
            className="input"
            type={secret && !show ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={value}
            disabled={sending}
            onChange={(e) => setValue(e.target.value)}
            style={{ paddingRight: secret ? 36 : undefined }}
          />
          {secret && (
            <button type="button" className="icon-btn sm" style={{ position: "absolute", right: 5 }} onClick={() => setShow((s) => !s)} title={show ? "Hide" : "Show"}>
              {show ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          )}
        </div>
        <div className="help">{req.origin==="git"?"Git-approved HTTPS credentials can be reused for this repository during this session, including PR access. Revqora keeps this cache in memory; use Accounts to save a token in the encrypted vault.":"The answer goes straight to SSH and is not reused as an API token."}</div>
      </div>
      {bitbucket && <>
        <p className="help">For an API token, use your Bitbucket username or <code>x-bitbucket-api-token-auth</code> as the Git username and paste the token when Git asks for a password. For an OAuth access token, use <code>x-token-auth</code>. Git needs repository read permission for Fetch/Pull and write permission for Push.</p>
        <p className="help">Pull Requests can reuse this credential. If Bitbucket asks for your Atlassian email, open Accounts and API connections, add a Bitbucket account and select Use existing Git token.</p>
      </>}
      {!!available.length&&<div className="field"><label>Use an existing account<select className="select" aria-label="Saved Git account" value={account} disabled={sending} onChange={e=>setAccount(e.target.value)}><option value="">Choose an account…</option>{available.map(a=><option key={a.id} value={a.id}>{a.login} · {a.kind} · {a.server}</option>)}</select></label><button type="button" className="btn" disabled={!account||sending} onClick={()=>void useSaved()}>Use saved account for this request</button><small>The credential goes directly to the matching HTTPS Git server. SSH prompts cannot receive API tokens.</small></div>}
      {error && <p role="alert">{error}</p>}
    </Modal>
  );
}
