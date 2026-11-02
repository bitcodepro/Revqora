// A worktree opened by a scenario can still have native readers after switching
// tabs or restoring the session. Release the app before removing its fixtures.
export async function shutdownAndCleanup(close, cleanups) {
  await close(); // A failed shutdown must never authorize fixture deletion.
  const errors = [];
  for (const cleanup of cleanups) {
    try { await cleanup(); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Native fixture cleanup failed");
}
