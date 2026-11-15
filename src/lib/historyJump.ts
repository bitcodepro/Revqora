/** What History does to reach a commit it was asked to show (after search and filters are
 *  cleared): scroll to it, load more history toward it, widen a branch scope that leaves it
 *  out (to all branches), or give up when it is in none of them. */
export function jumpStep(o: { found: boolean; moreHistory: boolean; scoped: boolean }): "scroll" | "load-more" | "widen-scope" | "not-found" {
  if (o.found) return "scroll";
  if (o.moreHistory) return "load-more";
  if (o.scoped) return "widen-scope";
  return "not-found";
}
