export const SPOTIFY_COOKIE_KEY = "spotify_sp_dc_cookie";

export function readSpotifyCookie(): string {
  try {
    return localStorage.getItem(SPOTIFY_COOKIE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function writeSpotifyCookie(value: string): void {
  try {
    const trimmed = value.trim();
    if (trimmed) {
      localStorage.setItem(SPOTIFY_COOKIE_KEY, trimmed);
    } else {
      localStorage.removeItem(SPOTIFY_COOKIE_KEY);
    }
  } catch {}
}
