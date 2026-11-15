/** A commit message draft. With Amend on it also records which commit Amend refers to and the
 *  message Revqora loaded from that commit, so both can be withdrawn when HEAD moves on. */
export interface CommitDraft {
  summary: string;
  body: string;
  amend?: boolean;
  /** HEAD when Amend was turned on. */
  amendHead?: string | null;
  /** The last commit's message, when Amend filled the empty form with it. */
  amendMessage?: { summary: string; body: string } | null;
}

/** Amend always rewrites the current HEAD. When HEAD is no longer the commit the user chose to
 *  amend (checkout, pull, a commit made elsewhere, undo), Amend turns off instead of silently
 *  rewriting a different commit. The loaded message of the old commit goes with it; text the
 *  user typed or edited stays. Returns the same object when nothing changes. */
export function reconcileAmend<T extends CommitDraft>(draft: T, head: string | null | undefined): T | CommitDraft {
  if (!draft.amend || !head) return draft;
  if (!draft.amendHead) return { ...draft, amendHead: head };
  if (draft.amendHead === head) return draft;
  const loaded = draft.amendMessage;
  const untouched = !!loaded && loaded.summary === draft.summary && loaded.body === draft.body;
  return { summary: untouched ? "" : draft.summary, body: untouched ? "" : draft.body, amend: false, amendHead: null, amendMessage: null };
}
