"use client";

import { useEffect } from "react";
import { useBrowserLocalLibraryStore } from "@/store/browser-local-library";

export function BrowserLocalLibraryHydrator() {
  const hydrated = useBrowserLocalLibraryStore((state) => state.hydrated);
  const hydrateCapabilities = useBrowserLocalLibraryStore((state) => state.hydrateCapabilities);

  useEffect(() => {
    if (!hydrated) {
      hydrateCapabilities();
    }
  }, [hydrateCapabilities, hydrated]);

  return null;
}
