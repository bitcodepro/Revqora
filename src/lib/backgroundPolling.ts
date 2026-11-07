import { useEffect, useRef } from "react";

export type PollTask = (current: () => boolean) => Promise<void>;

/** Keep one sweep in flight, including when a setting changes mid-request. */
export function useBackgroundPoll(minutes: number, task: PollTask, runNow = false, revision?: unknown) {
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
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [minutes, runNow, revision]);
}
