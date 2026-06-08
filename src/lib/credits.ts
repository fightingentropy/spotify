import { useEffect, useRef, useState } from "react";

export function parseCredits(artist: string): Array<{ name: string; role: string }> {
  const seen = new Set<string>();
  const names = artist
    .split(/,|&| feat\.? | ft\.? /i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .filter((part) => {
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (names.length === 0) {
    return [{ name: artist || "Unknown Artist", role: "Main Artist" }];
  }

  return names.map((name, index) => ({
    name,
    role: index === 0 ? "Main Artist, Vocalist" : "Featured Artist",
  }));
}

export type LyricsState = {
  status: "idle" | "loading" | "ready" | "error";
  text: string;
};

/**
 * Fetches lyrics for the given (offline-resolved) song. Callers should pass the
 * song id and lyrics URL from the offline-resolved playback song so cached
 * downloads resolve correctly. The fetch only runs while `enabled` is true.
 */
export function useLyrics(
  songId: string | null | undefined,
  lyricsUrl: string | null | undefined,
  enabled: boolean,
): LyricsState {
  const [lyricsState, setLyricsState] = useState<LyricsState>({
    status: "idle",
    text: "",
  });
  const loadedLyricsKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    if (!lyricsUrl) {
      setLyricsState({ status: "idle", text: "" });
      loadedLyricsKeyRef.current = null;
      return;
    }
    const lyricsKey = `${songId ?? ""}:${lyricsUrl}`;
    if (loadedLyricsKeyRef.current === lyricsKey) {
      return;
    }
    const safeLyricsUrl = lyricsUrl;

    let cancelled = false;

    async function loadLyrics() {
      setLyricsState({ status: "loading", text: "" });
      try {
        // Lyrics files are served from /api/files with an immutable cache
        // header, so the browser HTTP cache is the right layer to rely on.
        const response = await fetch(safeLyricsUrl);
        if (!response.ok) {
          throw new Error("Lyrics unavailable");
        }
        const text = (await response.text()).trim();
        if (cancelled) return;
        setLyricsState({ status: "ready", text });
        loadedLyricsKeyRef.current = lyricsKey;
      } catch {
        if (cancelled) return;
        setLyricsState({ status: "error", text: "" });
        loadedLyricsKeyRef.current = null;
      }
    }

    loadLyrics();

    return () => {
      cancelled = true;
    };
  }, [enabled, songId, lyricsUrl]);

  return lyricsState;
}
