import { useMemo } from "react";
import { create } from "zustand";
import { storage } from "@/lib/storage";

type CollectionPlay = { key: string; count: number; lastPlayed: number };
const historyKey = (scope: string) => `spotify_collection_history:${encodeURIComponent(scope)}`;
const useHistoryRevision = create<{ revision: number }>(() => ({ revision: 0 }));

function readHistory(scope: string): CollectionPlay[] {
  try {
    const entries: unknown = JSON.parse(storage.getItem(historyKey(scope)) ?? "[]");
    return Array.isArray(entries) ? entries.filter((entry): entry is CollectionPlay =>
      entry && typeof entry.key === "string" && Number.isFinite(entry.count) && Number.isFinite(entry.lastPlayed),
    ).slice(0, 40) : [];
  } catch { return []; }
}

export function recordCollectionPlay(scope: string, key?: string) {
  if (!key?.startsWith("playlist:")) return;
  const history = readHistory(scope);
  const previous = history.find((entry) => entry.key === key);
  const now = Date.now();
  const count = (previous?.count ?? 0) + (!previous || now - previous.lastPlayed > 30 * 60_000 ? 1 : 0);
  const entries = [{ key, count, lastPlayed: now }, ...history.filter((entry) => entry.key !== key)].slice(0, 40);
  try { storage.setItem(historyKey(scope), JSON.stringify(entries)); } catch { /* Optional preference. */ }
  useHistoryRevision.setState((state) => ({ revision: state.revision + 1 }));
}

export function useCollectionHistory(scope: string) {
  const revision = useHistoryRevision((state) => state.revision);
  return useMemo(() => readHistory(scope), [scope, revision]);
}
