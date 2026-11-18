import { useEffect, useRef } from "react";

export type PollTask = (current: () => boolean) => Promise<void>;

/** Keep one sweep in flight, including when a setting changes mid-request. */
/** `firstDelayMs`: run once that long after start instead of waiting a whole interval. */
export function useBackgroundPoll(minutes: number, task: PollTask, runNow = false, revision?: unknown, firstDelayMs?: number) {
  const latest = useRef(task);
  const queue = useRef(Promise.resolve());
  latest.current = task;
  useEffect(() => {
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    let active = true;
    let scheduled = false;
    const tick = () => {
      if (scheduled) return;
      scheduled = true;
      queue.current = queue.current.then(async () => {
        if (active) await latest.current(() => active);
      }).catch(() => {}).finally(() => { scheduled = false; });
    };
    const timer = setInterval(tick, minutes * 60_000);
    if (runNow) tick();
    const first = firstDelayMs === undefined ? undefined : setTimeout(tick, firstDelayMs);
    return () => {
      active = false;
      clearInterval(timer);
      clearTimeout(first);
    };
  }, [minutes, runNow, revision, firstDelayMs]);
}
