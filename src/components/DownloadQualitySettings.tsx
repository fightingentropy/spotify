"use client";

import { useEffect, useState } from "react";

export const DOWNLOAD_QUALITY_PROFILE_KEY = "wf_download_quality_profile";
export const DOWNLOAD_PROVIDER_KEY = "wf_download_provider";

type QualityProfile = "cd" | "hires48" | "max";
export type DownloadProvider = "auto" | "qobuz" | "amazon" | "tidal";

const QUALITY_OPTIONS: Array<{
  value: QualityProfile;
  label: string;
  note: string;
}> = [
  {
    value: "cd",
    label: "16-bit / 44.1 kHz",
    note: "CD quality FLAC",
  },
  {
    value: "hires48",
    label: "24-bit / 48 kHz",
    note: "Hi-Res FLAC where available",
  },
  {
    value: "max",
    label: "Max available",
    note: "Best FLAC from provider",
  },
];

const PROVIDER_OPTIONS: Array<{
  value: DownloadProvider;
  label: string;
  note: string;
}> = [
  {
    value: "auto",
    label: "Auto",
    note: "Try Qobuz, then Amazon Music, then Tidal",
  },
  {
    value: "qobuz",
    label: "Qobuz",
    note: "Use Qobuz only",
  },
  {
    value: "amazon",
    label: "Amazon Music",
    note: "Use Amazon Music only",
  },
  {
    value: "tidal",
    label: "Tidal",
    note: "Use Tidal only",
  },
];

function isQualityProfile(value: string): value is QualityProfile {
  return value === "cd" || value === "hires48" || value === "max";
}

export function isDownloadProvider(value: string): value is DownloadProvider {
  return value === "auto" || value === "qobuz" || value === "amazon" || value === "tidal";
}

export default function DownloadQualitySettings() {
  const [qualityProfile, setQualityProfile] = useState<QualityProfile>("max");
  const [downloadProvider, setDownloadProvider] = useState<DownloadProvider>("auto");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(DOWNLOAD_QUALITY_PROFILE_KEY);
      if (stored && isQualityProfile(stored)) {
        setQualityProfile(stored);
      }
      const storedProvider = localStorage.getItem(DOWNLOAD_PROVIDER_KEY);
      if (storedProvider && isDownloadProvider(storedProvider)) {
        setDownloadProvider(storedProvider);
      }
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(DOWNLOAD_QUALITY_PROFILE_KEY, qualityProfile);
    } catch {}
  }, [qualityProfile]);

  useEffect(() => {
    try {
      localStorage.setItem(DOWNLOAD_PROVIDER_KEY, downloadProvider);
    } catch {}
  }, [downloadProvider]);

  return (
    <div>
      <h2 className="text-lg font-medium mb-2">Downloads</h2>
      <div className="rounded border border-black/10 dark:border-white/10 p-4 space-y-4">
        <div className="space-y-2">
          <label className="block text-sm opacity-80">Provider</label>
          <select
            value={downloadProvider}
            onChange={(e) => {
              const next = e.target.value;
              if (isDownloadProvider(next)) setDownloadProvider(next);
            }}
            className="h-10 w-full md:w-[280px] rounded-xl border border-black/15 dark:border-white/15 bg-transparent px-3"
          >
            {PROVIDER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <div className="text-xs opacity-70">
            {PROVIDER_OPTIONS.find((option) => option.value === downloadProvider)?.note}
          </div>
        </div>

        <div className="space-y-2">
          <label className="block text-sm opacity-80">Quality profile</label>
          <select
            value={qualityProfile}
            onChange={(e) => {
              const next = e.target.value;
              if (isQualityProfile(next)) setQualityProfile(next);
            }}
            className="h-10 w-full md:w-[280px] rounded-xl border border-black/15 dark:border-white/15 bg-transparent px-3"
          >
            {QUALITY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <div className="text-xs opacity-70">
            {QUALITY_OPTIONS.find((option) => option.value === qualityProfile)?.note}
          </div>
        </div>
      </div>
    </div>
  );
}
