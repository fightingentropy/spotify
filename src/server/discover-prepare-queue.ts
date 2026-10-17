// Background staging for the song a search is most likely to play. Search
// results arrive on every pause in typing, so a song starts only after it has
// stayed on top for `settleMs`. One runs at a time; a newer song replaces one
// still waiting, and a song that just failed waits `retryMs` before another try.
export function createDiscoverPrepareQueue(options: {
  settleMs: number;
  retryMs: number;
}): (key: string, prepare: () => Promise<boolean>) => void {
  let waiting: { key: string; since: number; prepare: () => Promise<boolean> } | null = null;
  let runningKey: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failedUntil = new Map<string, number>();

  function startWhenSettled(): void {
    clearTimeout(timer);
    if (!waiting || runningKey !== null) return;
    const delay = waiting.since + options.settleMs - Date.now();
    if (delay > 0) {
      timer = setTimeout(startWhenSettled, delay);
      return;
    }
    const { key, prepare } = waiting;
    waiting = null;
    runningKey = key;
    void prepare()
      .catch(() => false)
      .then((prepared) => {
        if (prepared) return;
        if (failedUntil.size >= 256) failedUntil.delete(failedUntil.keys().next().value!);
        failedUntil.set(key, Date.now() + options.retryMs);
      })
      .finally(() => {
        runningKey = null;
        startWhenSettled();
      });
  }

  return (key, prepare) => {
    if (key === runningKey || key === waiting?.key) return;
    if ((failedUntil.get(key) ?? 0) > Date.now()) return;
    waiting = { key, since: Date.now(), prepare };
    startWhenSettled();
  };
}
