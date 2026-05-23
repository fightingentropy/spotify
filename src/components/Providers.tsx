"use client";

import { SessionProvider } from "next-auth/react";
import { ReactNode } from "react";
import { BrowserLocalLibraryHydrator } from "@/components/BrowserLocalLibraryHydrator";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <BrowserLocalLibraryHydrator />
      {children}
    </SessionProvider>
  );
}


