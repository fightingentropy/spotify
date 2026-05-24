"use client";

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronDown, CircleUser, LogIn, LogOut, Settings } from "lucide-react";
import { useAuth } from "@/client/auth";

export function AuthButtons({ compact = false }: { compact?: boolean }) {
  const { user, status, signOut } = useAuth();
  const navigate = useNavigate();

  if (status === "loading") {
    if (compact) {
      return (
        <div
          className="h-9 w-9 shrink-0 animate-pulse rounded-full border border-white/[0.12] bg-white/[0.06]"
          aria-label="Checking auth"
        />
      );
    }

    return <div className="truncate text-[15px] text-white/[0.62]">Checking...</div>;
  }

  if (!user) {
    if (compact) {
      return (
        <Link
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/[0.12] text-white/[0.76] transition hover:bg-white/[0.09] hover:text-white"
          to="/signin"
          aria-label="Sign in"
          title="Sign in"
        >
          <LogIn size={18} />
        </Link>
      );
    }

    return (
      <div className="flex min-w-0 shrink-0 items-center justify-end gap-2 text-[15px] whitespace-nowrap">
        <Link className="text-white/[0.76] underline underline-offset-2 transition hover:text-white" to="/signin">
          Sign in
        </Link>
        <span className="text-white/[0.38]">/</span>
        <Link className="text-white/[0.76] underline underline-offset-2 transition hover:text-white" to="/register">
          Register
        </Link>
      </div>
    );
  }

  return (
    <UserMenu
      compact={compact}
      name={user.name ?? user.email ?? "Account"}
      onSignOut={async () => {
        await signOut();
        navigate("/");
      }}
    />
  );
}

function UserMenu({ compact, name, onSignOut }: { compact: boolean; name: string; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

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

  return (
    <div className="relative" ref={menuRef}>
      <button
        className={
          compact
            ? "grid h-9 w-9 place-items-center rounded-full border border-white/[0.12] text-white/[0.76] transition hover:bg-white/[0.09] hover:text-white"
            : "inline-flex items-center gap-2 px-3 h-9 rounded-full border border-white/[0.12] text-white/[0.76] transition hover:bg-white/[0.09] hover:text-white"
        }
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
     >
        {compact ? (
          <CircleUser size={18} />
        ) : (
          <>
            <span className="text-[15px] max-w-[180px] truncate">{name}</span>
            <ChevronDown size={16} className="text-white/[0.62]" />
          </>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-48 rounded-md border border-white/[0.12] bg-background text-white shadow-lg z-50 overflow-hidden"
        >
          <Link
            to="/settings"
            className="flex items-center gap-2 px-3 py-2.5 text-[15px] text-white/[0.76] transition hover:bg-white/[0.09] hover:text-white"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <Settings size={16} />
            <span>Settings</span>
          </Link>
          <button
            className="w-full text-left flex items-center gap-2 px-3 py-2.5 text-[15px] text-white/[0.76] transition hover:bg-white/[0.09] hover:text-white"
            role="menuitem"
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
