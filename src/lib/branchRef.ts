/** The fully qualified ref of a branch shown by its short name. Git resolves a short name to a
 *  local branch first (and a full object id before any branch), so `origin/feature` could
 *  select a different object; operations pass this instead and keep the short name for display. */
export function branchRef(kind: "local" | "remote", name: string): string {
  return `refs/${kind === "local" ? "heads" : "remotes"}/${name}`;
}

/**
 * Git's default merge message names the argument it was given, so merging a fully qualified
 * ref proposes "Merge branch 'refs/heads/x'". The message offered for the merge commit uses the
 * branch's short name, as Git does for `git merge x`. Only quoted refs in the subject line are
 * rewritten; the rest of the message is unchanged.
 */
export function readableMergeMessage(message: string): string {
  const end = message.indexOf("\n");
  const subject = end < 0 ? message : message.slice(0, end);
  if (!/^Merge (?:branch|branches|remote-tracking branch|remote-tracking branches) '/.test(subject)) return message;
  const readable = subject.replace(/'refs\/(?:heads|remotes)\/([^']+)'/g, "'$1'");
  return end < 0 ? readable : readable + message.slice(end);
}
