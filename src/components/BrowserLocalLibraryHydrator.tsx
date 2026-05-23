"use client";

import { useEffect } from "react";
import { useBrowserLocalLibraryStore } from "@/store/browser-local-library";

export function BrowserLocalLibraryHydrator() {
  const hydrated = useBrowserLocalLibraryStore((state) => state.hydrated);
  const directoryName = useBrowserLocalLibraryStore((state) => state.directoryName);
  const songs = useBrowserLocalLibraryStore((state) => state.songs);
  const status = useBrowserLocalLibraryStore((state) => state.status);
  const pickedFileMode = useBrowserLocalLibraryStore((state) => state.pickedFileMode);
  const hydrateCapabilities = useBrowserLocalLibraryStore((state) => state.hydrateCapabilities);
  const rescan = useBrowserLocalLibraryStore((state) => state.rescan);

  useEffect(() => {
    if (!hydrated) {
      hydrateCapabilities();
    }
  }, [hydrateCapabilities, hydrated]);

  useEffect(() => {
    if (!hydrated || pickedFileMode || status === "scanning" || songs.length > 0) {
      return;
    }
    if (!directoryName) {
      return;
    }

    const reconnect = () => {
      void rescan();
    };

    window.addEventListener("pointerdown", reconnect, { once: true });
    return () => {
      window.removeEventListener("pointerdown", reconnect);
    };
  }, [directoryName, hydrated, pickedFileMode, rescan, songs.length, status]);

  return null;
}
