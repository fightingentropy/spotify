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
        {directoryName ? `Loading ${directoryName}…` : "Loading local folder…"}
      </div>
    );
  }

  if (songs.length > 0) {
    return (
      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Local Folder</h2>
          <Link href="/settings" className="text-sm opacity-70 hover:opacity-100">
            Manage folder
          </Link>
        </div>
        <SongGrid songs={songs} canLike={false} showLikeControls={false} />
      </section>
    );
  }

  return (
    <div className="opacity-70">
      No server songs available yet.{" "}
      <Link href="/settings" className="underline">
        Choose a local folder
      </Link>{" "}
      or upload a track to get started.
    </div>
  );
}
