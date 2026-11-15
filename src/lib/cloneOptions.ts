import type { CloneFilter, CloneOptions } from "./types";

/** Raw form state of the clone dialog's Advanced section. */
export interface CloneOptionsForm {
  branch: string;
  depth: string;
  noSingleBranch: boolean;
  filter: CloneFilter;
  recurseSubmodules: boolean;
  shallowSubmodules: boolean;
}

export const CLONE_FILTERS: { value: CloneFilter; label: string }[] = [
  { value: "none", label: "Full clone" },
  { value: "blob:none", label: "Blobless (blob:none)" },
  { value: "tree:0", label: "Treeless (tree:0)" },
];

export const defaultCloneOptionsForm = (): CloneOptionsForm => ({
  branch: "", depth: "", noSingleBranch: true, filter: "none", recurseSubmodules: true, shallowSubmodules: false,
});

/** Quick client-side check; Git's `check-ref-format --branch` has the final say. */
export function branchError(value: string): string {
  const b = value.trim();
  if (!b) return "";
  if (b.startsWith("-")) return "A branch name cannot start with '-'.";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.$|\.lock$|^@$/.test(b)) return "Enter a valid branch name.";
  return "";
}

/** Parses the depth field: empty means a full clone; otherwise a positive integer. */
export function parseDepth(value: string): { depth: number | null; error: string } {
  const v = value.trim();
  if (!v) return { depth: null, error: "" };
  if (!/^\d+$/.test(v)) return { depth: null, error: "Depth must be a positive whole number." };
  const depth = Number(v);
  if (depth < 1 || depth > 0x7fffffff) return { depth: null, error: "Depth must be a positive whole number." };
  return { depth, error: "" };
}

/** Builds validated options for `repo_clone`, or the first error to show. */
export function buildCloneOptions(form: CloneOptionsForm): { options: CloneOptions | null; error: string } {
  const bErr = branchError(form.branch);
  if (bErr) return { options: null, error: bErr };
  const { depth, error } = parseDepth(form.depth);
  if (error) return { options: null, error };
  const filter: CloneFilter = CLONE_FILTERS.some((f) => f.value === form.filter) ? form.filter : "none";
  return {
    options: {
      branch: form.branch.trim() || null,
      depth,
      noSingleBranch: depth !== null && form.noSingleBranch,
      filter,
      recurseSubmodules: form.recurseSubmodules,
      shallowSubmodules: depth !== null && form.recurseSubmodules && form.shallowSubmodules,
    },
    error: "",
  };
}
