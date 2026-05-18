"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, Library, Search, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const tabs = [
  { href: "/", label: "Home", icon: Home, match: (path: string) => path === "/" },
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
      path.startsWith("/playlist"),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
    match: (path: string) => path.startsWith("/settings"),
  },
] as const;

export default function MobileNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main navigation"
      className="lg:hidden fixed inset-x-0 bottom-0 z-40 border-t border-black/10 dark:border-white/10 bg-background/95 backdrop-blur-xl supports-[backdrop-filter]:bg-background/85 pb-[env(safe-area-inset-bottom)]"
    >
      <div className="h-[var(--wf-mobile-nav-height)] grid grid-cols-4">
        {tabs.map(({ href, label, icon: Icon, match }) => {
          const active = match(pathname);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex flex-col items-center justify-center gap-0.5 min-h-[44px] touch-manipulation transition-colors",
                active ? "text-emerald-500" : "text-foreground/60",
              )}
            >
              <Icon size={22} strokeWidth={active ? 2.5 : 2} />
              <span className="text-[10px] font-medium">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
