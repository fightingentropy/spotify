"use client";

import { useEffect, useState } from "react";
import { Share, X } from "lucide-react";

const DISMISS_KEY = "wf_ios_install_dismissed";

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && (navigator as Navigator & { standalone?: boolean }).standalone === true)
  );
}

export default function InstallPrompt() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isIos() || isStandalone()) return;
    try {
      if (localStorage.getItem(DISMISS_KEY) === "1") return;
    } catch {}
    setVisible(true);
  }, []);

  if (!visible) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {}
    setVisible(false);
  }

  return (
    <div className="lg:hidden fixed top-[calc(3.5rem+env(safe-area-inset-top))] inset-x-3 z-[60] rounded-2xl border border-emerald-500/30 bg-emerald-500/10 backdrop-blur-lg p-4 shadow-lg">
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-xl bg-emerald-500/20 grid place-items-center shrink-0">
          <Share size={18} className="text-emerald-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm">Install Waveform</div>
          <p className="text-xs opacity-80 mt-1 leading-relaxed">
            Tap the share button in Safari, then &ldquo;Add to Home Screen&rdquo; for a full-screen app
            experience.
          </p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="h-8 w-8 rounded-full grid place-items-center hover:bg-black/10 dark:hover:bg-white/10 shrink-0"
          aria-label="Dismiss install prompt"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
