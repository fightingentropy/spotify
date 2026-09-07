"use client";

import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ChevronLeft, ChevronRight, Heart, Library, ListMusic, Music2, Podcast, RadioTower, Ticket } from "lucide-react";
import { cn } from "@/lib/utils";

type LibrarySidebarClientProps = {
  initialCollapsed: boolean;
};

const SIDEBAR_STATE_KEY = "spotify_left_sidebar_collapsed";

export default function LibrarySidebarClient({
  initialCollapsed,
}: LibrarySidebarClientProps) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  useEffect(() => {
    // Persist to localStorage only. The cookie this used to write was a
    // Next.js leftover that nothing server-side reads (the SPA renders the
    // sidebar client-side and reads initialCollapsed from localStorage).
    try {
      localStorage.setItem(SIDEBAR_STATE_KEY, collapsed ? "1" : "0");
    } catch {}
    document.documentElement.style.setProperty(
      "--wf-left-sidebar-width",
      collapsed ? "4rem" : "13.5rem",
    );
  }, [collapsed]);

  return (
    <aside
      className={cn(
        "hidden lg:flex fixed top-14 bottom-0 left-0 z-40 border-r border-white/[0.08] bg-black text-white transition-[width] duration-200",
        collapsed ? "w-16" : "w-[13.5rem]",
      )}
    >
      <div className={cn("flex-1 overflow-y-auto", collapsed ? "p-2" : "p-4")}>
        <div className={cn("mb-4 flex items-center", collapsed ? "justify-center" : "justify-between")}>
          {!collapsed && (
            <div className="inline-flex items-center gap-2 text-[16px] font-medium text-white/[0.82]">
              <Library size={18} />
              <span>Your Library</span>
            </div>
          )}

          <div className={cn("flex items-center", collapsed ? "gap-0" : "gap-1")}>
            <button
              type="button"
              aria-label={collapsed ? "Expand library sidebar" : "Collapse library sidebar"}
              title={collapsed ? "Expand" : "Collapse"}
              onClick={() => setCollapsed((value) => !value)}
              className="h-8 w-8 rounded-full grid place-items-center text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white"
            >
              {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          <Link
            to="/liked"
            title="Liked Songs"
            className={cn(
                "wf-list-row wf-pressable flex min-h-12 items-center rounded-md transition hover:bg-white/[0.09]",
              collapsed ? "justify-center px-0 py-2" : "gap-3 px-2.5 py-2",
            )}
          >
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white/[0.075] text-white">
              <Heart size={18} />
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <div className="text-[16px] font-medium leading-6 text-white">Liked Songs</div>
              </div>
            )}
          </Link>

          <Link
            to="/playlists"
            title="Playlists"
            className={cn(
              "wf-list-row wf-pressable flex min-h-12 items-center rounded-md transition hover:bg-white/[0.09]",
              collapsed ? "justify-center px-0 py-2" : "gap-3 px-2.5 py-2",
            )}
          >
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white/[0.075] text-white/60">
              <ListMusic size={18} />
            </div>
            {!collapsed && <div className="text-[16px] font-medium leading-6 text-white">Playlists</div>}
          </Link>

          <Link
            to="/songs"
            title="All Songs"
            className={cn(
              "wf-list-row wf-pressable flex min-h-12 items-center rounded-md transition hover:bg-white/[0.09]",
              collapsed ? "justify-center px-0 py-2" : "gap-3 px-2.5 py-2",
            )}
          >
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-white/[0.075] text-white/60">
              <Music2 size={18} />
            </div>
            {!collapsed && <div className="text-[16px] font-medium leading-6 text-white">All Songs</div>}
          </Link>

          <details className="group/more mt-5 border-t border-white/[0.08] pt-3">
            <summary title="More music" className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-2 text-[13px] text-white/50 hover:text-white [&::-webkit-details-marker]:hidden">
              <span>{collapsed ? "More" : "More music"}</span>
              {!collapsed ? <ChevronRight size={14} className="transition-transform group-open/more:rotate-90" /> : null}
            </summary>
            {[
              { href: "/radio", label: "Radio", Icon: RadioTower },
              { href: "/podcasts", label: "Podcasts", Icon: Podcast },
              { href: "/events", label: "Live Events", Icon: Ticket },
            ].map(({ href, label, Icon }) => (
              <Link key={href} to={href} title={label} className={cn("flex min-h-11 items-center gap-3 rounded-lg px-3 text-[14px] text-white/60 transition hover:bg-white/[0.06] hover:text-white", collapsed && "justify-center px-0")}>
                <Icon size={17} />{collapsed ? null : label}
              </Link>
            ))}
          </details>

        </div>
      </div>
    </aside>
  );
}
