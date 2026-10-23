// Headphone and notification "previous" (an AirPods triple tap) restarts the
// song once playback is past this point. Within it, it goes to the previous song.
const PREVIOUS_RESTART_AFTER_SECONDS = 10;

export function previousRestartsSong(positionSeconds: number): boolean {
  return Number.isFinite(positionSeconds) && positionSeconds > PREVIOUS_RESTART_AFTER_SECONDS;
}
