"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Heart, Library, ListMusic, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

type PlaylistEntry = {
  id: string;
  name: string;
  songsCount: number;
};

type LibrarySidebarClientProps = {
  userId: string | null;
  playlists: PlaylistEntry[];
  initialCollapsed: boolean;
};

const SIDEBAR_STATE_KEY = "wf_left_sidebar_collapsed";

export default function LibrarySidebarClient({
  userId,
  playlists,
  initialCollapsed,
}: LibrarySidebarClientProps) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STATE_KEY, collapsed ? "1" : "0");
    } catch {}
    document.cookie = `${SIDEBAR_STATE_KEY}=${collapsed ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.style.setProperty(
      "--wf-left-sidebar-width",
      collapsed ? "4rem" : "16rem",
    );
  }, [collapsed]);

  return (
    <aside
      className={cn(
        "hidden lg:flex fixed top-14 bottom-0 left-0 z-40 border-r border-black/10 dark:border-white/10 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60 transition-[width] duration-200",
        collapsed ? "w-16" : "w-64",
      )}
    >
      <div className={cn("flex-1 overflow-y-auto", collapsed ? "p-2" : "p-4")}> 
        <div className={cn("mb-4 flex items-center", collapsed ? "justify-center" : "justify-between")}>
          {!collapsed && (
            <div className="inline-flex items-center gap-2 text-sm font-medium opacity-80">
              <Library size={16} />
              <span>Your Library</span>
            </div>
          )}

          <div className={cn("flex items-center", collapsed ? "gap-0" : "gap-1")}>
            {!collapsed && (
              <button
                title="Create playlist (coming soon)"
                className="h-7 w-7 rounded-md grid place-items-center bg-black/5 dark:bg-white/10 opacity-70 cursor-default"
                aria-disabled
              >
                <Plus size={14} />
              </button>
            )}
            <button
              type="button"
              aria-label={collapsed ? "Expand library sidebar" : "Collapse library sidebar"}
              title={collapsed ? "Expand" : "Collapse"}
              onClick={() => setCollapsed((value) => !value)}
              className="h-7 w-7 rounded-md grid place-items-center hover:bg-black/10 dark:hover:bg-white/10"
            >
              {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
            </button>
          </div>
        </div>

        <div className="space-y-1">
          <Link
            href="/liked"
            title="Liked Songs"
            className={cn(
              "flex items-center rounded hover:bg-black/5 dark:hover:bg-white/5",
              collapsed ? "justify-center px-0 py-2" : "gap-3 px-2 py-2",
            )}
          >
            <div className="h-8 w-8 rounded bg-gradient-to-br from-emerald-500 to-emerald-700 text-white grid place-items-center">
              <Heart size={16} />
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <div className="text-sm font-medium">Liked Songs</div>
              </div>
            )}
          </Link>

          {userId ? (
            playlists.length > 0 && (
              <div className="mt-3 pt-3 border-t border-black/10 dark:border-white/10">
                {!collapsed && (
                  <div className="px-2 mb-2 text-xs uppercase tracking-wide opacity-60">
                    Playlists
                  </div>
                )}
                <div className="space-y-1">
                  {playlists.map((pl) => (
                    <Link
                      key={pl.id}
                      href={`/playlist/${pl.id}`}
                      title={pl.name}
                      className={cn(
                        "flex items-center rounded hover:bg-black/5 dark:hover:bg-white/5",
                        collapsed ? "justify-center px-0 py-2" : "gap-3 px-2 py-2",
                      )}
                    >
                      <div className="h-8 w-8 rounded bg-black/5 dark:bg-white/10 grid place-items-center">
                        <ListMusic size={16} />
                      </div>
                      {!collapsed && (
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">{pl.name}</div>
                          <div className="text-xs opacity-70">{pl.songsCount ?? 0} tracks</div>
                        </div>
                      )}
                    </Link>
                  ))}
                </div>
              </div>
            )
          ) : (
            <div className="mt-3 pt-3 border-t border-black/10 dark:border-white/10">
              {!collapsed && (
                <>
                  <div className="px-2 mb-2 text-xs uppercase tracking-wide opacity-60">Playlists</div>
                  <div className="px-2 text-sm opacity-70">
                    <Link className="underline" href="/signin">
                      Sign in
                    </Link>{" "}
                    to manage playlists.
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
