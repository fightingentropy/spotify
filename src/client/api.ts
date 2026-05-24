import { useEffect, useState } from "react";
import type { PlayerSong } from "@/types/player";

export type PlaylistEntry = {
  id: string;
  name: string;
  imageUrl?: string | null;
  userId?: string;
  createdAt?: string;
  songsCount: number;
};

export function useApiData<T>(url: string, initialValue: T) {
  const [data, setData] = useState<T>(initialValue);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(url, {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error || `Request failed with ${response.status}`);
        }
        const payload = (await response.json()) as T;
        if (!cancelled) setData(payload);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Request failed");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [url]);

  return { data, loading, error, setData };
}

export type HomePayload = {
  songs: PlayerSong[];
  likedSongIds: string[];
};

export type LibraryPayload = {
  playlists: PlaylistEntry[];
  userId: string | null;
};

export type LikedPayload = {
  songs: PlayerSong[];
  likedSongIds: string[];
};

export type PlaylistPayload = {
  playlist: {
    id: string;
    name: string;
    imageUrl: string | null;
    userId: string;
    createdAt: string;
  } | null;
  songs: PlayerSong[];
  likedSongIds: string[];
};
