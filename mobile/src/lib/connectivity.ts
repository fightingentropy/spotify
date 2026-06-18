// Reachability flag used by playback to keep offline play on downloaded songs
// only, so it never flashes through a track it can't stream.
//
// Two sources, in priority order:
//   1. expo-network (OS-level) — authoritative and real-time. A listener catches
//      airplane-mode toggles even while the app stays foregrounded, which is the
//      exact case the traffic signal below can't see: no fetch fires, so nothing
//      would otherwise notice the network dropped between two Next presses.
//   2. API traffic (markOnline/markOffline) — a dependency-free fallback for
//      builds where the native module isn't linked yet. Ignored once (1) reports.
//
// We acquire the native module via requireOptionalNativeModule, which returns
// null (never throws) when it isn't linked into the running binary — so an older
// build degrades to the API-derived fallback instead of crashing at import.
// (The expo-network JS wrapper does `requireNativeModule(...)` at import time,
// which would throw before any guard could run, so we deliberately bypass it.)
//
// Optimistic by default: unknown reachability counts as online, so a
// connected-but-slow user is never wrongly stranded on downloads-only.

import { requireOptionalNativeModule } from "expo-modules-core";

type NetworkLike = { isConnected?: boolean; isInternetReachable?: boolean };
type ExpoNetworkModule = {
  getNetworkStateAsync: () => Promise<NetworkLike>;
  addListener: (event: string, listener: (state: NetworkLike) => void) => { remove: () => void };
};

const ExpoNetwork = requireOptionalNativeModule<ExpoNetworkModule>("ExpoNetwork");

let online = true;
let nativeActive = false; // expo-network has reported at least once → it owns the flag
let initStarted = false;

function applyNetworkState(state: NetworkLike): void {
  // Offline only on an explicit negative; `undefined` (unknown) stays online.
  online = state.isConnected !== false && state.isInternetReachable !== false;
  nativeActive = true;
}

function ensureInit(): void {
  if (initStarted) return;
  initStarted = true;
  if (!ExpoNetwork) return; // native module absent → API-derived fallback below
  try {
    // Real-time changes (airplane mode on/off, Wi-Fi drop) while the app is open.
    ExpoNetwork.addListener("onNetworkStateChanged", applyNetworkState);
    // Seed the current value immediately rather than waiting for the first event.
    ExpoNetwork.getNetworkStateAsync()
      .then(applyNetworkState)
      .catch(() => {});
  } catch {
    // Defensive: any native hiccup → stay on the API-derived fallback.
  }
}

export function markOnline(): void {
  ensureInit();
  if (!nativeActive) online = true;
}

export function markOffline(): void {
  ensureInit();
  if (!nativeActive) online = false;
}

export function getIsOnline(): boolean {
  ensureInit();
  return online;
}
