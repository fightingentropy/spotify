import { useCallback, useEffect, useState } from "react";
import { storage } from "@/lib/storage";
import { readRecentSearches, recentSearchesKey, rememberSearch } from "@spotify/shared/recent-searches";

export function useRecentSearches(scope: string) {
  const key = recentSearchesKey(scope);
  const read = useCallback(() => {
    try { return readRecentSearches(storage.getItem(key)); } catch { return []; }
  }, [key]);
  const [snapshot, setSnapshot] = useState(() => ({ key, items: read() }));
  useEffect(() => { setSnapshot({ key, items: read() }); }, [key, read]);
  const write = (items: string[]) => {
    try { storage.setItem(key, JSON.stringify(items)); } catch { /* Storage may be unavailable. */ }
    setSnapshot({ key, items });
  };
  return {
    recentSearches: snapshot.key === key ? snapshot.items : [],
    remember: (query: string) => write(rememberSearch(read(), query)),
    clear: () => write([]),
  };
}
