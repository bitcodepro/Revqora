/** What History does to reach a commit it was asked to show (after search and filters are
 *  cleared): scroll to it, load more history toward it, widen a branch scope that leaves it
 *  out (to all branches), or give up when it is in none of them. */
export function jumpStep(o: { found: boolean; moreHistory: boolean; scoped: boolean }): "scroll" | "load-more" | "widen-scope" | "not-found" {
  if (o.found) return "scroll";
  if (o.moreHistory) return "load-more";
  if (o.scoped) return "widen-scope";
  return "not-found";
}

/** End on a paged history first loads the rest, which is a new graph. The view may render that
 *  graph before or after the load reports back: select its last row now when it is already
 *  shown, otherwise leave the request for the render that brings it. One press is enough. */
export function lastRowStep(o: { sameView: boolean; loadedKey: string | null; renderedKey: string | null }): "select" | "await-render" | "skip" {
  if (!o.sameView || !o.loadedKey) return "skip";
  return o.renderedKey === o.loadedKey ? "select" : "await-render";
}
