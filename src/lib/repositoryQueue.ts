/** Bound independent repository reads without letting a slow folder block the list. */
export function repositoryQueue(limit = 4) {
  let running = 0;
  const waiting: { key: string; run: () => Promise<void> }[] = [];
  function drain() {
    while (running < limit && waiting.length) {
      const job = waiting.shift()!;
      running++;
      void job.run().finally(() => { running--; drain(); });
    }
  }
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const result = new Promise<T>((resolve, reject) => waiting.push({ key, run: async () => {
        try { resolve(await task()); } catch (error) { reject(error); }
      } }));
      drain();
      return result;
    },
    prioritize(key: string) {
      const index = waiting.findIndex(job => job.key === key);
      if (index > 0) waiting.unshift(...waiting.splice(index, 1));
      drain();
    },
  };
}
