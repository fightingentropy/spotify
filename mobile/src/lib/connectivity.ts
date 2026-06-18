// Lightweight reachability flag derived from real API traffic — no native deps.
// The app otherwise assumes connectivity; playback uses this to decide up-front
// whether to start the full (streamed) queue or fall back to the downloaded
// subset, so offline Play doesn't flash through tracks we can't stream.
//
// Optimistic by default. Only a genuine network-level failure (the fetch
// rejecting, e.g. "Network request failed" in airplane mode) flips it offline;
// any real HTTP response — even a 4xx/5xx — flips it back online, since that
// proves the network was reachable. A request that merely times out (or is
// cancelled) does NOT mark offline, so a connected-but-slow user is never
// wrongly stranded on downloads-only.

let online = true;

export function markOnline(): void {
  online = true;
}

export function markOffline(): void {
  online = false;
}

export function getIsOnline(): boolean {
  return online;
}
