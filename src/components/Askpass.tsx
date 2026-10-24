import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Eye, EyeOff, KeyRound, ShieldQuestion, UserRound } from "lucide-react";
import { api } from "../lib/api";
import type { AskpassRequest } from "../lib/types";
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
  return <AskpassDialog key={current.id} req={current} onAnswer={answer} />;
}

/** Splits an OpenSSH host-key prompt into the explanation and the question. */
function splitPrompt(prompt: string): { detail: string; question: string } {
  const lines = prompt.trim().split(/\r?\n/);
  const question = lines.pop() ?? "";
  return { detail: lines.join("\n"), question };
}

function AskpassDialog({ req, onAnswer }: { req: AskpassRequest; onAnswer: (v: string | null) => void }) {
  const [value, setValue] = useState("");
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
  const title = req.kind === "username" ? "Sign in" : /passphrase/i.test(req.prompt) ? "Unlock SSH key" : secret ? "Password required" : "Git needs input";
  return (
    <Modal
      title={title}
      subtitle={host ? `Requested by git for ${host.replace(/^for '|'$/g, "")}` : "Requested by git"}
      icon={req.kind === "username" ? <UserRound size={18} /> : <KeyRound size={18} />}
      onClose={() => onAnswer(null)}
      onSubmit={() => onAnswer(value)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => onAnswer(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            Continue
          </button>
        </>
      }
    >
      <div className="field">
        <label style={{ whiteSpace: "pre-wrap", fontWeight: 500 }}>{req.prompt.trim()}</label>
        <div className="input-wrap">
          <input
            className="input"
            type={secret && !show ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            style={{ paddingRight: secret ? 36 : undefined }}
          />
          {secret && (
            <button type="button" className="icon-btn sm" style={{ position: "absolute", right: 5 }} onClick={() => setShow((s) => !s)} title={show ? "Hide" : "Show"}>
              {show ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          )}
        </div>
        <div className="help">The answer goes straight to git and is not stored by Revqora.</div>
      </div>
    </Modal>
  );
}
