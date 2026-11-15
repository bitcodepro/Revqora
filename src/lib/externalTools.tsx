import { api } from "./api";
import { useSettings } from "./settings";
import { toast } from "./ui";
import { useRepos } from "./store";

/** Editor command presets ({file}, {line}, {column} are filled in; no shell is involved). */
export const EDITOR_PRESETS: { label: string; command: string }[] = [
  { label: "System text editor", command: "" },
  { label: "Visual Studio Code", command: "code --goto {file}:{line}:{column}" },
  { label: "VS Code Insiders", command: "code-insiders --goto {file}:{line}:{column}" },
  { label: "Cursor", command: "cursor --goto {file}:{line}:{column}" },
  { label: "Sublime Text", command: "subl {file}:{line}:{column}" },
  { label: "Notepad++", command: "notepad++ -n{line} -c{column} {file}" },
  { label: "JetBrains IDE (idea)", command: "idea --line {line} --column {column} {file}" },
  { label: "Rider", command: "rider --line {line} --column {column} {file}" },
  { label: "Zed", command: "zed {file}:{line}:{column}" },
  { label: "Kate", command: "kate --line {line} --column {column} {file}" },
  { label: "gedit", command: "gedit +{line} {file}" },
];

/** The preset a command matches, or "Custom". */
export function editorPresetLabel(command: string): string {
  return EDITOR_PRESETS.find((p) => p.command === command.trim())?.label ?? "Custom";
}

/** Opens a repository file in the chosen editor at a line, or the system text editor. */
export async function openInEditor(root: string, path: string, line = 1, column = 1) {
  const command = useSettings.getState().externalEditor.trim();
  try {
    if (command) await api.openInEditor(root, path, line, column, command);
    else await api.openPathAsText(`${root.replace(/[\/]+$/, "")}/${path}`);
  } catch (e) {
    toast.error(e, "Could not open the editor");
  }
}

/** Compares two versions of a file in the external diff tool (returns when it is closed). */
export async function openInDiffTool(root: string, path: string, side: "unstaged" | "staged" | "commits", from: string | null = null, to: string | null = null) {
  const tool = useSettings.getState().diffTool.trim() || null;
  toast.info("Opening the external diff tool", path);
  try {
    await api.externalDifftool(root, path, side, from, to, tool);
  } catch (e) {
    toast.error(e, "External diff tool");
  }
}

/** Resolves a conflicted file in the external merge tool; Git stages it when the tool succeeds. */
export async function resolveInMergeTool(root: string, path: string) {
  const tool = useSettings.getState().mergeTool.trim() || null;
  const expected = useRepos.getState().tabs[root]?.status?.stateToken ?? null;
  toast.info("Opening the external merge tool", `${path} — Revqora waits until you close it.`);
  try {
    await api.conflictExternal(root, path, tool, expected);
  } catch (e) {
    toast.error(e, "External merge tool");
  } finally {
    await useRepos.getState().refresh(root, { status: true });
  }
}
