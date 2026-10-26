import type { RepoInfo, StatusSummary } from "./types";

export interface RepositorySnapshot {
  info: RepoInfo | null;
  status: StatusSummary | null;
}

/** Only the checked-out branch's upstream is considered for a bulk fast-forward. */
export function pullBlockReason({ info, status }: RepositorySnapshot): string | null {
  if (!info || !status) return "Repository status is unavailable";
  if (info.isBare) return "Bare repository";
  if (info.head.detached || !info.head.branch) return "Detached HEAD";
  if (info.head.unborn) return "No commits yet";
  if (status.branch !== info.head.branch || status.oid !== info.head.oid) return "Branch changed — refresh first";
  if (info.state.kind !== "none" || status.conflictCount) return "An operation or conflict needs attention";
  if (status.files.length) return "Local changes";
  if (!status.upstream) return "No upstream configured";
  if (status.ahead && status.behind) return "Branches have diverged";
  if (!status.behind) return status.ahead ? "Only outgoing commits" : "Up to date";
  return null;
}

export interface BatchResult {
  root: string;
  status: "done" | "skipped" | "failed";
  message: string;
}

export interface BatchDeps {
  read: (root: string) => Promise<RepositorySnapshot>;
  fetch: (root: string) => Promise<unknown>;
  pull: (root: string) => Promise<unknown>;
  refresh: (root: string) => Promise<unknown>;
  isOpen: (root: string) => boolean;
  progress: (root: string, index: number, total: number) => void;
}

/** Sequential work keeps prompts manageable; one repository failing never stops the rest. */
export async function runRepositoryBatch(roots: string[], kind: "fetch" | "pull", deps: BatchDeps): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  const unique = [...new Set(roots)];
  for (const [index, root] of unique.entries()) {
    deps.progress(root, index + 1, unique.length);
    try {
      if (!deps.isOpen(root)) {
        results.push({ root, status: "skipped", message: "Repository was closed" });
        continue;
      }
      if (kind === "pull") {
        // The preview can be stale: re-read immediately before each actual pull.
        const reason = pullBlockReason(await deps.read(root));
        if (reason) {
          results.push({ root, status: "skipped", message: reason });
          continue;
        }
      }
      await deps[kind](root);
      results.push({ root, status: "done", message: kind === "fetch" ? "Fetched" : "Updated (fast-forward)" });
    } catch (e) {
      results.push({ root, status: "failed", message: e && typeof e === "object" && "message" in e ? String(e.message) : String(e) });
    } finally {
      await deps.refresh(root).catch(() => {});
    }
  }
  return results;
}
