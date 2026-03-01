"use client";

import { useEffect, useState } from "react";

export const EDIT_MODE_KEY = "wf_edit_mode_enabled";
export const EDIT_MODE_EVENT = "wf:edit-mode-changed";

export default function EditModeSettings() {
  const [enabled, setEnabled] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      setEnabled(localStorage.getItem(EDIT_MODE_KEY) === "1");
    } catch {}
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(EDIT_MODE_KEY, enabled ? "1" : "0");
      window.dispatchEvent(new Event(EDIT_MODE_EVENT));
    } catch {}
  }, [enabled, hydrated]);

  return (
    <div>
      <h2 className="text-lg font-medium mb-2">Library</h2>
      <div className="rounded border border-black/10 dark:border-white/10 p-4">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>Enable edit mode for songs</span>
        </label>
      </div>
    </div>
  );
}
