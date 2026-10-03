type StageSource<T> = { resolved: T } | { preview: true; libraryFallback?: true };

// Library saves prefer the provider download. If resolution or downloading is
// unavailable, let the mini download YouTube audio and explicitly allow keeping
// that file. Ordinary playback previews still try the providers when kept.
export async function stageDiscoverWithFallback<T>(options: {
  preview: boolean;
  youtubeVideoId?: string;
  resolve: () => Promise<T>;
  stage: (source: StageSource<T>) => Promise<Response>;
}): Promise<Response> {
  if (options.preview || options.youtubeVideoId) {
    return options.stage({ preview: true, ...(options.youtubeVideoId ? { libraryFallback: true } : {}) });
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
