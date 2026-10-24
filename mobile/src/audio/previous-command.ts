// "Previous" (the Now Playing button, an AirPods triple tap, the lock screen or
// notification) restarts the song once playback is past this point. Within it,
// and always for live radio, it goes to the previous song.
const PREVIOUS_RESTART_AFTER_SECONDS = 10;

export function previousRestartsSong(positionSeconds: number, live = false): boolean {
  return !live && Number.isFinite(positionSeconds) && positionSeconds > PREVIOUS_RESTART_AFTER_SECONDS;
}
