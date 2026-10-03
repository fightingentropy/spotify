import { getApiAuthScope, LEGACY_API_AUTH_SCOPE, normalizeAccountScope } from "@spotify/shared/account-scope";

// A late 401 is allowed to expire only the session that started its request.
// The generation also covers unscoped URLs and signing out/back into one account.
export function createApiAuthRequestGuard() {
  let scope = normalizeAccountScope(null);
  let generation = 0;
  return {
    getScope: () => scope,
    setScope(value: string | null | undefined) {
      const next = normalizeAccountScope(value);
      if (next === scope) return;
      scope = next;
      generation++;
    },
    invalidate() {
      generation++;
    },
    capture(url: string): () => boolean {
      const requestGeneration = generation;
      const requestedScope = getApiAuthScope(url);
      return () => requestGeneration === generation && (
        requestedScope === LEGACY_API_AUTH_SCOPE || requestedScope === scope
      );
    },
  };
}
