"use client";

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ChevronDown, LogIn, LogOut, Settings, UserRound } from "lucide-react";
import { useAuth } from "@/client/auth";
import { artworkSrcSet } from "@/lib/artwork-url";

export function AccountAvatar({
  src,
  alt,
  className,
  iconSize = 17,
  size = 40,
}: {
  src?: string | null;
  alt: string;
  className: string;
  iconSize?: number;
  size?: number;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const displaySrc = src && src !== failedSrc ? src : null;

  if (displaySrc) {
    return (
      <img
        src={displaySrc}
        srcSet={artworkSrcSet(displaySrc)}
        sizes={`${size}px`}
        decoding="async"
        alt={alt}
        className={className}
        onError={() => setFailedSrc(displaySrc)}
      />
    );
  }

  return (
    <span
      aria-label={alt}
      className={`grid place-items-center bg-white/[0.12] text-white/[0.72] ${className}`}
    >
      <UserRound size={iconSize} strokeWidth={2.2} />
    </span>
  );
}

export function AuthButtons({ compact = false }: { compact?: boolean }) {
  const { user, status, signOut } = useAuth();
  const navigate = useNavigate();

  if (compact) {
    if (status === "loading") {
      return (
        <div
          className="h-10 w-10 shrink-0 rounded-md border border-white/10 bg-white/[0.04]"
          aria-label="Checking session"
          title="Checking session"
        />
      );
    }

    if (!user) {
      return (
        <Link
          to="/signin"
          className="wf-icon-button"
          aria-label="Sign in"
          title="Sign in"
        >
          <LogIn size={20} />
        </Link>
      );
    }

    return (
      <Link
        to="/profile"
        className="wf-icon-button"
        aria-label="Open profile"
        title="Profile"
      >
        <AccountAvatar
          src={user.image}
          alt={user?.name || "Profile"}
          className="h-6 w-6 rounded-full object-cover"
          iconSize={18}
          size={24}
        />
      </Link>
    );
  }

  if (status === "loading") {
    return <div className="wf-muted truncate text-sm">Checking...</div>;
  }

  if (!user) {
    return (
      <div className="flex min-w-0 shrink-0 items-center justify-end gap-2 text-[15px] whitespace-nowrap">
        <Link className="wf-button" to="/signin">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <UserMenu
      name={user.name ?? user.email ?? "Account"}
      imageUrl={user.image}
      onSignOut={async () => {
        await signOut();
        navigate("/");
      }}
    />
  );
}

function UserMenu({
  name,
  imageUrl,
  onSignOut,
}: {
  name: string;
  imageUrl?: string | null;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    function onClickOutside(e: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Treated as a disclosure (not an ARIA menu), so items keep normal tab
  // order. On open, move focus to the first item; on close, restore focus to
  // the trigger so keyboard users aren't dropped at the top of the page.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open) {
      const first = panelRef.current?.querySelector<HTMLElement>("a, button");
      first?.focus();
    } else if (wasOpenRef.current) {
      triggerRef.current?.focus();
    }
    wasOpenRef.current = open;
  }, [open]);

  return (
    <div className="relative" ref={menuRef}>
      <button
        ref={triggerRef}
        className="wf-button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Account menu"
     >
        <AccountAvatar src={imageUrl} alt="" className="h-6 w-6 rounded-full object-cover" iconSize={15} size={24} />
        <span className="max-w-[180px] truncate">{name}</span>
        <ChevronDown size={16} className="text-white/[0.62]" />
      </button>
      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 z-50 mt-2 w-48 overflow-hidden rounded-md border border-white/[0.12] bg-[var(--surface)] p-1 text-white"
        >
          <Link
            to="/profile"
            className="flex min-h-10 items-center gap-2 rounded px-3 py-2 text-sm text-white/75 hover:bg-white/[0.07] hover:text-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white/60"
            onClick={() => setOpen(false)}
          >
            <UserRound size={16} />
            <span>Profile</span>
          </Link>
          <Link
            to="/settings"
            className="flex min-h-10 items-center gap-2 rounded px-3 py-2 text-sm text-white/75 hover:bg-white/[0.07] hover:text-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white/60"
            onClick={() => setOpen(false)}
          >
            <Settings size={16} />
            <span>Settings</span>
          </Link>
          <button
            className="flex min-h-10 w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-white/75 hover:bg-white/[0.07] hover:text-white focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white/60"
            onClick={onSignOut}
          >
            <LogOut size={16} />
            <span>Sign out</span>
          </button>
        </div>
      )}
    </div>
  );
}
