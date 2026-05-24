"use client";

import { useEffect, useState } from "react";

export const SPOTIFY_COOKIE_KEY = "spotify_sp_dc_cookie";

export function readSpotifyCookie(): string {
  try {
    return localStorage.getItem(SPOTIFY_COOKIE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function writeSpotifyCookie(value: string): void {
  try {
    const trimmed = value.trim();
    if (trimmed) {
      localStorage.setItem(SPOTIFY_COOKIE_KEY, trimmed);
    } else {
      localStorage.removeItem(SPOTIFY_COOKIE_KEY);
    }
  } catch {}
}

export default function SpotifyCookieSettings() {
  const [cookie, setCookie] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setCookie(readSpotifyCookie());
  }, []);

  function handleSave() {
    try {
      const trimmed = cookie.trim();
      if (trimmed) {
        localStorage.setItem(SPOTIFY_COOKIE_KEY, trimmed);
      } else {
        localStorage.removeItem(SPOTIFY_COOKIE_KEY);
      }
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch {}
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Spotify account access</h2>
        <p className="text-sm opacity-70 mt-1">
          Required for private playlists and Liked Songs with 1000+ tracks. Paste your{" "}
          <code className="text-xs">sp_dc</code> cookie from Spotify in your browser.
        </p>
      </div>

      <div className="rounded border border-black/10 dark:border-white/10 p-4 space-y-3">
        <label className="block text-sm font-medium">Spotify sp_dc cookie</label>
        <input
          type="password"
          value={cookie}
          onChange={(event) => setCookie(event.target.value)}
          placeholder="Paste sp_dc value or full cookie string"
          className="w-full border border-white/25 rounded-xl px-3.5 py-2.5 bg-transparent focus:outline-none focus:ring-2 focus:ring-yellow-500/50"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-xs opacity-60">
          In Spotify Web: open DevTools → Application → Cookies → open.spotify.com → copy{" "}
          <span className="font-medium">sp_dc</span>. Stored only in this browser.
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            className="h-10 px-4 rounded-lg bg-foreground text-background text-sm font-medium"
          >
            Save cookie
          </button>
          {saved && <span className="text-sm text-emerald-500">Saved</span>}
        </div>
      </div>
    </section>
  );
}
