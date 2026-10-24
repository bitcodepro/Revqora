import { useEffect, useState } from "react";
import { Command, GitMerge, Keyboard, Layers, MousePointerClick, Moon, Sparkles, Sun, UserRound } from "lucide-react";
import { Modal } from "./Modal";
import { api } from "../lib/api";
import { useSettings } from "../lib/settings";
import { toast } from "../lib/ui";

/** First-run guide: theme, Git identity and the main ideas of the app. */
export function Onboarding() {
  const onboarded = useSettings((s) => s.onboarded);
  const theme = useSettings((s) => s.theme);
  const set = useSettings((s) => s.set);
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [hadIdentity, setHadIdentity] = useState(true);
  useEffect(() => {
    if (onboarded) return;
    api.identityGet(".").then(
      (i) => {
        setName(i.name ?? "");
        setEmail(i.email ?? "");
        setHadIdentity(!!i.name && !!i.email);
      },
      () => setHadIdentity(false),
    );
  }, [onboarded]);
  if (onboarded) return null;

  const finish = () => set({ onboarded: true });
  const saveIdentity = async () => {
    if (name.trim() && email.trim() && (!hadIdentity || name || email)) {
      try {
        await api.identitySet(".", name, email, true);
      } catch (e) {
        toast.error(e, "Could not save your identity");
        return;
      }
    }
    setStep(2);
  };

  const tips = [
    { icon: <Layers size={16} />, t: "Stage layers", d: "Seal what is staged into a layer and keep staging on top. Unstage, discard or commit any layer on its own." },
    { icon: <GitMerge size={16} />, t: "Merges wait for you", d: "A merge never commits by itself: review the result, resolve conflicts in the editor, then confirm — or abort." },
    { icon: <Command size={16} />, t: "Command palette", d: "Ctrl+K finds any action, branch or repository." },
    { icon: <MousePointerClick size={16} />, t: "Right-click and drag", d: "Every commit, branch, file and layer has a context menu. Drag files between Unstaged and Staged, or a branch onto another." },
    { icon: <Keyboard size={16} />, t: "Shortcuts", d: "Change any shortcut in Settings." },
  ];

  return (
    <Modal
      title={step === 0 ? "Welcome to Revqora" : step === 1 ? "Who are you?" : "A few things worth knowing"}
      subtitle={step === 0 ? "Let's set things up in under a minute." : step === 1 ? "Git records this name and email as the author of your commits." : undefined}
      icon={step === 1 ? <UserRound size={18} /> : <Sparkles size={18} />}
      wide={step === 2}
      onClose={finish}
      onSubmit={() => (step === 0 ? setStep(1) : step === 1 ? saveIdentity() : finish())}
      footer={
        <>
          <span className="faint" style={{ marginRight: "auto", fontSize: "var(--fs-xs)" }}>
            Step {step + 1} of 3
          </span>
          <button type="button" className="btn ghost" onClick={finish}>
            Skip
          </button>
          {step > 0 && (
            <button type="button" className="btn" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <button type="submit" className="btn primary">
            {step === 2 ? "Start" : "Next"}
          </button>
        </>
      }
    >
      {step === 0 && (
        <>
          <div className="field">
            <label>Theme</label>
            <div className="radio-cards" style={{ flexDirection: "row" }}>
              {(["dark", "light", "system"] as const).map((t) => (
                <label key={t} className={`radio-card ${theme === t ? "on" : ""}`} style={{ flex: 1 }}>
                  <input type="radio" checked={theme === t} onChange={() => set({ theme: t })} />
                  <div className="hstack" style={{ gap: 6 }}>
                    {t === "dark" ? <Moon size={15} /> : t === "light" ? <Sun size={15} /> : <Sparkles size={15} />}
                    <span className="rt">{t[0].toUpperCase() + t.slice(1)}</span>
                  </div>
                </label>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Text size</label>
            <div className="seg" style={{ alignSelf: "flex-start" }}>
              {[12, 13, 14, 15].map((n) => (
                <button type="button" key={n} className={useSettings.getState().uiFontSize === n ? "on" : ""} onClick={() => set({ uiFontSize: n, codeFontSize: n - 0.5 })}>
                  {n === 12 ? "Compact" : n === 13 ? "Default" : n === 14 ? "Large" : "Larger"}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      {step === 1 && (
        <>
          <div className="field">
            <label>Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" />
          </div>
          <div className="field">
            <label>Email</label>
            <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ada@example.com" />
            <div className="help">Saved in your global git config — used for all repositories.</div>
          </div>
        </>
      )}
      {step === 2 && (
        <div className="vstack" style={{ gap: 10 }}>
          {tips.map((t) => (
            <div key={t.t} className="hstack" style={{ alignItems: "flex-start", gap: 12 }}>
              <span className="big-action" style={{ padding: 8, borderRadius: 10, cursor: "default" }}>
                <span style={{ color: "var(--accent)" }}>{t.icon}</span>
              </span>
              <div>
                <div style={{ fontWeight: 650 }}>{t.t}</div>
                <div className="muted" style={{ fontSize: "var(--fs-sm)" }}>
                  {t.d}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
