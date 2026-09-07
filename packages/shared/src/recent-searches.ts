import { normalizeLibrarySearchQuery } from "./library-search";

export function readRecentSearches(value: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim().slice(0, 100)).slice(0, 8)
      : [];
  } catch { return []; }
}

export function rememberSearch(history: readonly string[], query: string): string[] {
  const value = query.trim().slice(0, 100);
  const key = normalizeLibrarySearchQuery(value);
  if (!key) return [...history];
  return [value, ...history.filter((item) => normalizeLibrarySearchQuery(item) !== key)].slice(0, 8);
}

export function recentSearchesKey(scope: string): string {
  return `spotify_recent_searches:${encodeURIComponent(scope)}`;
}
