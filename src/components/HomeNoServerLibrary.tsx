"use client";

import Link from "next/link";
import { SongGrid } from "@/components/SongGrid";
import { useBrowserLocalLibraryStore } from "@/store/browser-local-library";

export function HomeNoServerLibrary() {
  const songs = useBrowserLocalLibraryStore((state) => state.songs);
  const status = useBrowserLocalLibraryStore((state) => state.status);
  const directoryName = useBrowserLocalLibraryStore((state) => state.directoryName);

  if (status === "scanning") {
    return (
      <div className="opacity-70">
        {directoryName ? `Loading ${directoryName}…` : "Loading your library…"}
      </div>
    );
  }

  if (songs.length > 0) {
    return (
      <section className="mb-8">
        <div className="mb-3">
          <h2 className="text-lg font-semibold">Library</h2>
        </div>
        <SongGrid songs={songs} canLike={false} showLikeControls={false} />
      </section>
    );
  }

  return (
    <div className="opacity-70">
      No songs in your library yet.{" "}
      <Link href="/settings" className="underline">
        Set up a local folder in Settings
      </Link>{" "}
      or upload a track to get started.
    </div>
  );
}
