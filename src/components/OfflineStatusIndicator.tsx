"use client";

import { useEffect, useState } from "react";
import { CloudOff, RefreshCw, TriangleAlert } from "lucide-react";
import { useOfflineStore } from "@/client/offline";
import { cn } from "@/lib/utils";

// Transient sync states (a like syncing right after the tap, the startup
// mutation sweep) resolve in well under this; only show the pill for states
// that actually persist, so it doesn't flash on every launch or like.
const INDICATOR_APPEAR_DELAY_MS = 600;

export default function OfflineStatusIndicator() {
  const hydrate = useOfflineStore((state) => state.hydrate);
  const online = useOfflineStore((state) => state.online);
  const pendingMutations = useOfflineStore((state) => state.pendingMutations);
  const syncStatus = useOfflineStore((state) => state.syncStatus);
  const active = !online || pendingMutations > 0 || syncStatus !== "idle";
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timeoutId = window.setTimeout(() => setVisible(true), INDICATOR_APPEAR_DELAY_MS);
    return () => window.clearTimeout(timeoutId);
  }, [active]);

  if (!active || !visible) return null;

  const failed = syncStatus === "failed" || syncStatus === "auth-required";
  const Icon = !online ? CloudOff : failed ? TriangleAlert : RefreshCw;
  const text = !online
    ? "Offline"
    : failed
      ? syncStatus === "auth-required"
        ? "Sign in to sync"
        : "Sync failed"
      : `${pendingMutations} pending`;

  return (
    <div
      className={cn(
        "fixed right-3 top-[calc(3.75rem+env(safe-area-inset-top))] z-[70] inline-flex h-9 items-center gap-2 rounded-full border px-3 text-xs font-medium shadow-lg backdrop-blur",
        failed
          ? "border-amber-300/25 bg-amber-500/15 text-amber-100"
          : "border-white/15 bg-black/45 text-white",
      )}
    >
      <Icon size={14} className={cn(syncStatus === "syncing" && "animate-spin")} />
      <span>{text}</span>
    </div>
  );
}

