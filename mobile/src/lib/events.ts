// Tiny synchronous event bus, replacing the web app's `window.dispatchEvent` /
// CustomEvent channel (e.g. the API_AUTH_REQUIRED signal that forces a logout).
type Handler = (detail?: unknown) => void;

const listeners = new Map<string, Set<Handler>>();

export function on(event: string, handler: Handler): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(handler);
  return () => {
    set?.delete(handler);
  };
}

export function emit(event: string, detail?: unknown): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const handler of Array.from(set)) {
    try {
      handler(detail);
    } catch {
      // a misbehaving listener must not break the emit loop
    }
  }
}

export const API_AUTH_REQUIRED_EVENT = "spotify:api-auth-required";
