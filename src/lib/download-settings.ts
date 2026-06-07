export const DOWNLOAD_QUALITY_PROFILE_KEY = "spotify_download_quality_profile";
export const DOWNLOAD_PROVIDER_KEY = "spotify_download_provider";

export type DownloadQualityProfile = "cd" | "hires48" | "max";
export type DownloadProvider =
  | "auto"
  | "licensed"
  | "tidal"
  | "qobuz"
  | "amazon"
  | "deezer"
  | "apple";

export function isDownloadQualityProfile(value: string): value is DownloadQualityProfile {
  return value === "cd" || value === "hires48" || value === "max";
}

export function isDownloadProvider(value: string): value is DownloadProvider {
  return value === "auto" ||
    value === "licensed" ||
    value === "tidal" ||
    value === "qobuz" ||
    value === "amazon" ||
    value === "deezer" ||
    value === "apple";
}
