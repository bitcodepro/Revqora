import { describe, expect, it, vi } from "vitest";
import { createStartupBarrier, type StartupPhase } from "./startupReady";
function registration() {
  let resolve!: (stop: () => void) => void, reject!: (error: unknown) => void;
  const promise = new Promise<() => void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
describe("startup readiness", () => {
  it.each([true, false])("waits for both gates, listener first: %s", async listenerFirst => {
    const phases: StartupPhase[] = [], barrier = createStartupBarrier(p => phases.push(p), vi.fn()), pending = registration();
    const stop = vi.fn(); barrier.listener(pending.promise);
    if (listenerFirst) { pending.resolve(stop); await Promise.resolve(); expect(phases.at(-1)).toBe("restoring"); barrier.restored(); }
    else { barrier.restored(); expect(phases.at(-1)).toBe("connecting"); pending.resolve(stop); await Promise.resolve(); }
    expect(phases.at(-1)).toBe("ready"); expect(stop).not.toHaveBeenCalled();
  });
  it("ignores and unregisters a disposed StrictMode setup instead of declaring the new listener ready", async () => {
    const phases: StartupPhase[] = [], barrier = createStartupBarrier(p => phases.push(p), vi.fn());
    barrier.restored(); const old = registration(), next = registration(), oldStop = vi.fn(), nextStop = vi.fn();
    const dispose = barrier.listener(old.promise); dispose(); const close = barrier.listener(next.promise);
    old.resolve(oldStop); await Promise.resolve(); expect(oldStop).toHaveBeenCalledOnce(); expect(phases.at(-1)).toBe("connecting");
    next.resolve(nextStop); await Promise.resolve(); expect(phases.at(-1)).toBe("ready"); close(); expect(nextStop).toHaveBeenCalledOnce(); expect(phases.at(-1)).toBe("connecting");
  });
  it("keeps registration errors visible and never publishes a false ready state", async () => {
    const changed = vi.fn(), failed = vi.fn(), barrier = createStartupBarrier(changed, failed), pending = registration();
    barrier.restored(); barrier.listener(pending.promise); const error = Error("Listener registration failed"); pending.reject(error); await Promise.resolve();
    expect(failed).toHaveBeenCalledWith(error); expect(changed).not.toHaveBeenCalledWith("ready");
  });
});
