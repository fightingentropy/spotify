// "Has the user taken control of playback in this app session?"
//
// Until the user actively plays / pauses / skips something, the app is only a
// PASSIVE viewer of restored + cross-device resume state. In that passive phase
// it must never publish playback state to the server: restorePlaybackState()
// loads a saved snapshot into the player on launch, and the audio engine would
// otherwise auto-publish that load — overwriting the genuinely-newest state
// (e.g. what you just played on the web) and stamping it "now". That defeats
// cross-device resume and leaves the phone stuck resuming one old song.
//
// So publishPlaybackState() is gated on this flag. It flips true ONLY from
// genuine user/remote transport actions (play / toggle / next / previous and the
// playSongs / playSong / toggleSongInList entry points) — never from restore,
// which drives the store via setQueue + pause directly. It resets on
// account-scope change so one account can't publish over another's. A spurious
// reset is harmless: it only pauses publishing until the next real action (the
// gate fails safe — `false` means "don't write"), never a clobber.
//
// See restorePlaybackState() in playback-sync.ts.
let engaged = false;

export function markPlaybackEngaged(): void {
  engaged = true;
}

export function isPlaybackEngaged(): boolean {
  return engaged;
}

export function resetPlaybackEngaged(): void {
  engaged = false;
}
