import { useEffect, useRef, useState } from "react";
import { parseLyrics, type ParsedLyrics } from "@/lib/lrc";
import { resolveNativeApiUrl } from "@/lib/song-utils";

export function parseCredits(artist: string): Array<{ name: string; role: string }> {
  const seen = new Set<string>();
  // Split on commas and explicit feature/ampersand separators that have
  // surrounding spaces. Requiring spaces around "&" keeps names like "R&B"
  // and "Simon & Garfunkel" intact (the latter stays one credit, which is the
  // conservative, correct choice for a band name).
  const names = artist
    .split(/,| & | feat\.? | ft\.? /i)
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
  // Parsed form of `text`: synced lines when the file carries LRC timestamps.
  parsed: ParsedLyrics | null;
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
    parsed: null,
  });
  const loadedLyricsKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    if (!lyricsUrl) {
      setLyricsState({ status: "idle", text: "", parsed: null });
      loadedLyricsKeyRef.current = null;
      return;
    }
    const lyricsKey = `${songId ?? ""}:${lyricsUrl}`;
    if (loadedLyricsKeyRef.current === lyricsKey) {
      return;
    }
    // Relative /api URLs must point at the remote origin on native; offline
    // capacitor file URLs pass through untouched.
    const safeLyricsUrl = resolveNativeApiUrl(lyricsUrl);

    let cancelled = false;

    async function loadLyrics() {
      setLyricsState({ status: "loading", text: "", parsed: null });
      try {
        // Lyrics files are served from /api/files with an immutable cache
        // header, so the browser HTTP cache is the right layer to rely on.
        const response = await fetch(safeLyricsUrl);
        // WKWebView's scheme handler reports local offline files as status 0.
        if (!response.ok && response.status !== 0) {
          throw new Error("Lyrics unavailable");
        }
        const text = (await response.text()).trim();
        if (cancelled) return;
        setLyricsState({ status: "ready", text, parsed: parseLyrics(text) });
        loadedLyricsKeyRef.current = lyricsKey;
      } catch {
        if (cancelled) return;
        setLyricsState({ status: "error", text: "", parsed: null });
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
