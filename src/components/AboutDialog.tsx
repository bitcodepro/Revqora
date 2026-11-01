import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { BookOpen, CodeXml, ExternalLink, FolderGit2, Info, MessageSquare } from "lucide-react";
import { Modal } from "./Modal";
import { api } from "../lib/api";
import { showDialog, toast } from "../lib/ui";

const PROJECT = "https://github.com/bitcodepro/Revqora";
const openLink = (url: string) => void api.openPath(url).catch((error) => toast.error(error, "Could not open link"));

export function aboutDialog() {
  return showDialog<void>((close) => <AboutBody close={close} />);
}

function AboutBody({ close }: { close: () => void }) {
  const [version, setVersion] = useState("Loading…");
  useEffect(() => {
    let active = true;
    getVersion().then(
      (value) => { if (active) setVersion(value); },
      () => { if (active) setVersion("Unavailable"); },
    );
    return () => { active = false; };
  }, []);

  return (
    <Modal title="About Revqora" icon={<Info size={18} />} onClose={close}
      footer={<button type="button" className="btn primary" onClick={close}>Close</button>}>
      <div className="about-identity">
        <FolderGit2 size={32} aria-hidden="true" />
        <div><h4>Revqora</h4><p className="muted">A desktop workspace for Git, code review and agents.</p></div>
      </div>
      <dl className="about-details" aria-label="Application information">
        <dt>Version</dt><dd aria-live="polite">{version}</dd>
        <dt>Created by</dt><dd><button type="button" className="btn sm ghost" onClick={() => openLink("https://github.com/bitcodepro")}>bitcodepro <ExternalLink size={12} /></button></dd>
        <dt>License</dt><dd><button type="button" className="btn sm ghost" onClick={() => openLink(`${PROJECT}/blob/main/LICENSE`)}>MIT <ExternalLink size={12} /></button></dd>
      </dl>
      <p className="muted">Built with Rust, Tauri, React and TypeScript. Uses your installed Git.</p>
      <div className="about-links">
        <button type="button" className="btn" onClick={() => openLink(`${PROJECT}#readme`)}><BookOpen size={14} />User guide</button>
        <button type="button" className="btn" onClick={() => openLink(PROJECT)}><CodeXml size={14} />Source code</button>
        <button type="button" className="btn" onClick={() => openLink(`${PROJECT}/issues/new`)}><MessageSquare size={14} />Report an issue</button>
      </div>
    </Modal>
  );
}
