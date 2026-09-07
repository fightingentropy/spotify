import { useCallback, useEffect, useState } from "react";
import { readRecentSearches, recentSearchesKey, rememberSearch } from "@spotify/shared/recent-searches";

export function useRecentSearches(scope: string) {
  const key = recentSearchesKey(scope);
  const read = useCallback(() => {
    try { return readRecentSearches(localStorage.getItem(key)); } catch { return []; }
  }, [key]);
  const [snapshot, setSnapshot] = useState(() => ({ key, items: read() }));
  useEffect(() => { setSnapshot({ key, items: read() }); }, [key, read]);
  const write = (items: string[]) => {
    try { localStorage.setItem(key, JSON.stringify(items)); } catch { /* Storage may be unavailable. */ }
    setSnapshot({ key, items });
  };
  return {
    recentSearches: snapshot.key === key ? snapshot.items : [],
    remember: (query: string) => write(rememberSearch(read(), query)),
    clear: () => write([]),
  };
}
