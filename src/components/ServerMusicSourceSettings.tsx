"use client";

import { useEffect, useState } from "react";
import { Loader2, Music2, RefreshCw, Server } from "lucide-react";

type SourcePayload = {
  root: string;
  songsCount: number;
  scannedAt: string;
};

export default function ServerMusicSourceSettings() {
  const [source, setSource] = useState<SourcePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  async function load(refresh = false) {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await fetch(`/api/music/source${refresh ? "?refresh=1" : ""}`, {
        cache: "no-store",
        credentials: "include",
      });
      if (!response.ok) {
        setSource(null);
        return;
      }
      setSource((await response.json()) as SourcePayload);
    } catch {
      setSource(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const scannedAt =
    source?.scannedAt && Number.isFinite(Date.parse(source.scannedAt))
      ? new Date(source.scannedAt).toLocaleString()
      : "";

  return (
    <div className="rounded border border-black/10 p-4 dark:border-white/10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-emerald-500/15 text-emerald-500">
            <Server size={20} />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">Mac mini music source</div>
            <div className="truncate text-xs text-foreground/60">
              {loading ? (
                "Loading..."
              ) : source ? (
                <>
                  <Music2 size={13} className="mr-1 inline-block align-[-2px]" />
                  {source.songsCount.toLocaleString()} {source.songsCount === 1 ? "track" : "tracks"}
                  {scannedAt ? ` · Scanned ${scannedAt}` : ""}
                </>
              ) : (
                "Server source unavailable"
              )}
            </div>
            {source?.root ? (
              <div className="mt-1 truncate text-xs text-foreground/45">{source.root}</div>
            ) : null}
          </div>
        </div>

        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading || refreshing}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-black/15 px-4 text-sm font-medium disabled:opacity-60 dark:border-white/15"
        >
          {refreshing ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
          Rescan
        </button>
      </div>
    </div>
  );
}
