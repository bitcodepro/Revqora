export type StartupPhase = "restoring" | "connecting" | "ready";

/** Publish readiness only after restoration AND the current listener setup.
 * StrictMode can dispose an unresolved registration and start a newer one.
 */
export function createStartupBarrier(changed: (phase: StartupPhase) => void, failed: (error: unknown) => void) {
  let restored = false, listening = false, generation = 0;
  const publish = () => changed(!restored ? "restoring" : listening ? "ready" : "connecting");
  return {
    restored() { restored = true; publish(); },
    listener(registration: Promise<() => void>): () => void {
      const current = ++generation; listening = false; publish();
      let disposed = false, unlisten: (() => void) | null = null;
      void registration.then(stop => {
        if (disposed || current !== generation) { stop(); return; }
        unlisten = stop; listening = true; publish();
      }, error => { if (!disposed && current === generation) { listening = false; publish(); failed(error); } });
      return () => {
        disposed = true; unlisten?.(); unlisten = null;
        if (current === generation) { listening = false; publish(); }
      };
    },
  };
}
