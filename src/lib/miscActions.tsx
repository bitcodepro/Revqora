import { save as saveFile } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { act } from "./actions";
import { toast } from "./ui";
import { useRepos } from "./store";
import { promptDialog } from "../components/dialogs";
import { shortOid } from "./format";

/** Saves the files of `rev` as a zip or tar.gz (chosen by the file name). */
export async function exportArchive(root: string, rev: string) {
  const name = (useRepos.getState().tabs[root]?.info?.name ?? "repository").replace(/[^\w.-]+/g, "-");
  const label = /^[0-9a-f]{40,64}$/i.test(rev) ? shortOid(rev) : rev.replace(/[^\w.-]+/g, "-");
  const dest = await saveFile({
    title: "Export archive",
    defaultPath: `${name}-${label}.zip`,
    filters: [{ name: "Zip archive", extensions: ["zip"] }, { name: "Gzipped tar archive", extensions: ["tar.gz", "tgz"] }],
  });
  if (!dest) return;
  const format = /\.(tar\.gz|tgz)$/i.test(dest) ? "tar.gz" : "zip";
  try {
    await api.archiveExport(root, rev, format, dest, `${name}-${label}`);
    toast.success("Archive saved", dest);
  } catch (e) {
    toast.error(e, "Could not export the archive");
  }
}

/** `git stash branch`: a new branch at the stash's base with the stash applied and dropped. */
export async function stashToBranch(root: string, index: number, oid: string) {
  const name = await promptDialog({
    title: "Restore stash on a new branch",
    label: "Branch name",
    placeholder: "rescued-work",
    confirm: "Create branch",
    help: "Checks out a new branch at the commit the stash was made on, restores the stash there (staging included) and deletes it from the list.",
    validate: (v) => (!v.trim() ? "Enter a branch name." : v.trim().startsWith("-") ? "A branch name cannot start with '-'." : null),
  });
  if (!name) return;
  const expected = useRepos.getState().tabs[root]?.status?.stateToken ?? null;
  await act(root, () => api.stashBranch(root, name.trim(), index, oid, expected), { success: `Branch ${name.trim()} created from the stash` });
}
