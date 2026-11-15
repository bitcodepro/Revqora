import { useEffect, useState } from "react";
import { StickyNote } from "lucide-react";
import { api } from "../lib/api";
import { toast } from "../lib/ui";
import { promptDialog } from "./dialogs";

/** The commit's git note (refs/notes/commits): shown as a button, edited in a dialog. */
export function CommitNote({ root, oid }: { root: string; oid: string }) {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setNote(null);
    api.noteGet(root, oid).then((n) => { if (alive) setNote(n); }, () => {});
    return () => { alive = false; };
  }, [root, oid]);
  const edit = async () => {
    const text = await promptDialog({
      title: note ? "Edit note" : "Add a note",
      label: "Note",
      initial: note ?? "",
      multiline: true,
      confirm: "Save note",
      help: "Notes are attached to the commit without changing it. They stay local until you push refs/notes/commits. Save an empty note to remove it.",
    });
    if (text === null) return;
    try {
      await api.noteSet(root, oid, text);
      setNote(text.trim() ? text.trimEnd() : null);
      toast.success(text.trim() ? "Note saved" : "Note removed");
    } catch (e) {
      toast.error(e, "Could not save the note");
    }
  };
  return (
    <button type="button" className={`btn sm ${note ? "" : "ghost"}`} title={note ?? "Add a git note to this commit"} onClick={() => void edit()}>
      <StickyNote size={14} /> {note ? "Note" : "Add note"}
    </button>
  );
}
