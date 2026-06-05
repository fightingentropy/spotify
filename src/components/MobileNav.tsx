"use client";

import { Link, useLocation } from "react-router-dom";
import { Library, Search } from "lucide-react";
import { SpotifyIcon } from "@/components/icons/SpotifyIcon";
import { cn } from "@/lib/utils";

const tabs = [
  { href: "/", label: "Home", match: (path: string) => path === "/", home: true as const },
  {
    href: "/search",
    label: "Search",
    icon: Search,
    match: (path: string) => path.startsWith("/search"),
  },
  {
    href: "/library",
    label: "Library",
    icon: Library,
    match: (path: string) =>
      path.startsWith("/library") ||
      path.startsWith("/liked") ||
      path.startsWith("/downloads") ||
      path.startsWith("/radio") ||
      path.startsWith("/playlist"),
  },
] as const;

export default function MobileNav() {
  const { pathname } = useLocation();

  return (
    <nav
      aria-label="Main navigation"
      className="lg:hidden fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.12] bg-background text-white pb-[var(--wf-mobile-bottom-gutter)]"
    >
      <div className="h-[var(--wf-mobile-nav-height)] grid grid-cols-3">
        {tabs.map((tab) => {
          const active = tab.match(pathname);
          const Icon = "icon" in tab ? tab.icon : null;
          return (
            <Link
              key={tab.href}
              to={tab.href}
              className={cn(
                "wf-control-button flex flex-col items-center justify-center gap-0.5 min-h-[44px] touch-manipulation transition-colors",
                active ? "text-[#1ed760]" : "text-white/[0.62]",
              )}
            >
              {"home" in tab && tab.home ? (
                <SpotifyIcon
                  size={22}
                  className={cn(active && "ring-2 ring-[#1ed760]/40 ring-offset-2 ring-offset-background rounded-full")}
                />
              ) : Icon ? (
                <Icon size={22} strokeWidth={active ? 2.5 : 2} />
              ) : null}
              <span className="text-[10px] font-medium">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
