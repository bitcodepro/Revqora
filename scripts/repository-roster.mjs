/** Self-contained for page.evaluate. Library bookmarks are not open tabs. Check
 * exact identities and finished reads, rather than a header/DOM row count alone.
 */
export function repositoryRosterState(expectedRoots) {
  const key = value => {
    let root = value.replaceAll("\\", "/");
    if (root.startsWith("//?/UNC/")) root = "//" + root.slice(8);
    else if (root.startsWith("//?/")) root = root.slice(4);
    root = root.replace(/\/+$/, "");
    return /^[a-z]:\//i.test(root) || root.startsWith("//") ? root.toLowerCase() : root;
  };
  const rows = [...document.querySelectorAll(".repository-item")].map(row => ({
    path: row.querySelector(".repository-select")?.getAttribute("title")?.split("\n")[0] ?? "",
    state: row.getAttribute("data-repository-state"), busy: row.getAttribute("aria-busy"),
  }));
  const expected = expectedRoots.map(key), opened = rows.filter(row => row.state !== "closed");
  const missing = expectedRoots.filter(root => !opened.some(row => key(row.path) === key(root)));
  const unexpected = opened.filter(row => !expected.includes(key(row.path))).map(row => row.path);
  const pending = opened.filter(row => row.state !== "open" || row.busy !== "false").map(row => ({ path:row.path, state:row.state, busy:row.busy }));
  const duplicates = opened.filter((row,index) => opened.findIndex(candidate => key(candidate.path) === key(row.path)) !== index).map(row => row.path);
  return { ready: !missing.length && !unexpected.length && !pending.length && !duplicates.length && opened.length === expected.length,
    missing, unexpected, pending, duplicates, openCount: opened.length, rowCount: rows.length, closed: rows.filter(row => row.state === "closed").map(row => row.path) };
}
