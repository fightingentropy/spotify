import { useEffect } from "react";
import { initAudio, restorePlaybackState, startSleepTimerWatchdog } from "@/audio/engine";
import { useAuth } from "@/lib/auth";
import { useOfflineStore } from "@/store/offline";

// Boots the audio engine once and restores cross-device playback state after auth
// settles. Rendered inside AuthProvider in the root layout.
export function AudioBootstrap() {
  const { status } = useAuth();

  useEffect(() => {
    void initAudio();
    startSleepTimerWatchdog();
    void useOfflineStore.getState().hydrate();
  }, []);

  useEffect(() => {
    if (status === "authenticated") void restorePlaybackState();
  }, [status]);

  return null;
}
