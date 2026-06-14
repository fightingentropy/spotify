// Sleep-timer enforcement, shared by both audio backends. The watchdog covers the
// paused/stalled case where progress events stop firing. Extracted verbatim from
// the original engine.ts.

import { usePlayerStore } from "@/store/player";

export function enforceSleepTimer(): void {
  const s = usePlayerStore.getState();
  const endsAt = s.sleepTimerEndsAt;
  if (endsAt == null) return;
  if (Date.now() < endsAt) return;
  s.pause();
  s.cancelSleepTimer();
}

let sleepInterval: ReturnType<typeof setInterval> | null = null;

export function startSleepTimerWatchdog(): void {
  if (sleepInterval) return;
  sleepInterval = setInterval(enforceSleepTimer, 8000);
}
