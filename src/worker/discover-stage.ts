import { createHash } from "node:crypto";
type StageSource<T> = { resolved: T } | { preview: true; libraryFallback?: true };

// Library saves prefer the provider download. If resolution or downloading is
// unavailable, let the mini download YouTube audio and explicitly allow keeping
// that file. Ordinary playback previews still try the providers when kept.
export async function stageDiscoverWithFallback<T>(options: {
  preview: boolean;
  allowYouTubeFallback?: boolean;
  libraryFallback?: boolean;
  youtubeVideoId?: string;
  resolve: () => Promise<T>;
  stage: (source: StageSource<T>) => Promise<Response>;
}): Promise<Response> {
  if (options.preview || options.youtubeVideoId) {
    return options.stage({ preview: true, ...(options.youtubeVideoId || options.libraryFallback ? { libraryFallback: true } : {}) });
  }
  if (options.allowYouTubeFallback === false) {
    return options.stage({ resolved: await options.resolve() });
  }
  try {
    const response = await options.stage({ resolved: await options.resolve() });
    if (response.status < 500 && response.status !== 429 && response.status !== 408) return response;
    await response.body?.cancel();
  } catch {
    // Provider timeouts and resolution failures use the same YouTube fallback.
  }
  return options.stage({ preview: true, libraryFallback: true });
}

// Explicit Downloads selections cannot reuse a differently selected provider or
// quality from playback's staging cache. The final library still deduplicates.
export function downloadStagingId(trackId: string, service: string, quality: string, preferences?: unknown): string {
  const source = service.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 30) || "auto";
  const profile = ["cd", "hires48", "max", "atmos"].includes(quality) ? quality : "max";
  const variant = preferences == null ? "" : `-${createHash("sha256").update(JSON.stringify(preferences)).digest("hex").slice(0,16)}`;
  return `download-${trackId}-${source}-${profile}${variant}`;
}
