import { useEffect, useId, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Eye, EyeOff, KeyRound, ShieldQuestion, UserRound } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import type { AskpassRequest, ForgeAccountsSnapshot } from "../lib/types";
import { bitbucketPromptKind } from "../lib/bitbucketCredentials";
import {gitHttpsPrompt,gitAccountMatches} from "../lib/gitCredentials";
import { Modal } from "./Modal";
import { toast } from "../lib/ui";

/** Answers credential / passphrase / host-key prompts that git and ssh send to Revqora. */
export function AskpassHost() {
  const [queue, setQueue] = useState<AskpassRequest[]>([]);
  useEffect(() => {
    const un = listen<AskpassRequest>("askpass-request", (e) => setQueue((q) => [...q, e.payload]));
    const warn = listen("git-credential-storage-warning", () => toast.warning("Could not access saved Git tokens", "Check access to the data folder beside Revqora."));
    return () => {
      un.then((f) => f());
      warn.then((f) => f());
    };
  }, []);
  const current = queue[0];
  if (!current) return null;
  const answer = (value: string | null, remember?: boolean, email?: string) => {
    api.askpassRespond(current.id, value, remember, email).catch(() => {});
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

function AskpassDialog({ req, onAnswer, onAnswered }: { req: AskpassRequest; onAnswer: (v: string | null, remember?: boolean, email?: string) => void; onAnswered: () => void }) {
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
  const [remember, setRemember] = useState(req.canRemember);
  const [addPrEmail, setAddPrEmail] = useState(false);
  const [email, setEmail] = useState("");
  const inputId = useId();
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
  const bitbucketToken = bitbucket === "secret";
  const showPrEmail = req.canRemember && remember && bitbucketToken && addPrEmail;
  const title = bitbucket ? "Sign in to Bitbucket Cloud" : /passphrase/i.test(req.prompt) ? "Unlock SSH key" : req.origin === "ssh" ? "SSH authentication" : req.kind === "username" ? "Sign in" : secret ? "Password required" : "Git needs input";
  return (
    <Modal
      title={title}
      subtitle={req.origin === "ssh" ? "Requested by SSH" : host ? `Requested by git for ${host.replace(/^for '|'$/g, "")}` : "Requested by git"}
      icon={req.kind === "username" ? <UserRound size={18} /> : <KeyRound size={18} />}
      onClose={() => { if (!sending) onAnswer(null); }}
      onSubmit={() => {
        if (sending || bitbucketToken && !value.trim()) return;
        onAnswer(value, remember, showPrEmail ? email.trim() || undefined : undefined);
      }}
      footer={
        <>
          <button type="button" className="btn" disabled={sending} onClick={() => onAnswer(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={sending || bitbucketToken && !value.trim()}>
            Continue
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor={inputId} style={{ whiteSpace: "pre-wrap", fontWeight: 500 }}>{bitbucketToken ? "Bitbucket access token (required)" : req.prompt.trim()}</label>
        <div className="input-wrap">
          <input
            className="input"
            id={inputId}
            type={secret && !show ? "password" : "text"}
            required={bitbucketToken}
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
        <div className="help">{bitbucketToken
          ? "Revqora can reuse this token for pull requests."
          : req.origin === "git"
            ? "Git-approved HTTPS credentials can also be used for pull requests."
            : "The answer goes straight to SSH and is not reused as an API token."}</div>
      </div>
      {req.canRemember && <label className="check"><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}/>Remember in Revqora on this Windows account</label>}
      {req.canRemember && remember && bitbucketToken && (
        <div className="field">
          <div>
            <button type="button" className="btn" aria-expanded={addPrEmail} onClick={() => setAddPrEmail(open => !open)}>
              {addPrEmail ? "Skip email for pull requests" : "Add email for pull requests (optional)"}
            </button>
          </div>
          {showPrEmail && (
            <>
              <label htmlFor={`${inputId}-pr-email`}>Atlassian email (optional)</label>
              <input id={`${inputId}-pr-email`} className="input" type="email" aria-describedby={`${inputId}-pr-auth`} value={email} autoComplete="email" onChange={e => setEmail(e.target.value)} />
              <div className="help" id={`${inputId}-pr-auth`}>
                With an email, Pull Requests uses Basic authentication with the email and the same token. Leave it blank to use the token by itself (Bearer).
              </div>
            </>
          )}
        </div>
      )}
      {bitbucket === "username" && (
        <p className="help">Use your Bitbucket username or <code>x-bitbucket-api-token-auth</code> for a personal API token. For an OAuth access token, use <code>x-token-auth</code>.</p>
      )}
      {!!available.length&&<div className="field"><label>Use an existing account<select className="select" aria-label="Saved Git account" value={account} disabled={sending} onChange={e=>setAccount(e.target.value)}><option value="">Choose an account…</option>{available.map(a=><option key={a.id} value={a.id}>{a.login} · {a.kind} · {a.server}</option>)}</select></label><button type="button" className="btn" disabled={!account||sending} onClick={()=>void useSaved()}>Use saved account for this request</button><small>The credential goes directly to the matching HTTPS Git server. SSH prompts cannot receive API tokens.</small></div>}
      {error && <p role="alert">{error}</p>}
    </Modal>
  );
}
