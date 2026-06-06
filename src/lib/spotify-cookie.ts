export const SPOTIFY_COOKIE_KEY = "spotify_sp_dc_cookie";

export function readSpotifyCookie(): string {
  try {
    return (
      sessionStorage.getItem(SPOTIFY_COOKIE_KEY)?.trim() ||
      localStorage.getItem(SPOTIFY_COOKIE_KEY)?.trim() ||
      ""
    );
  } catch {
    return "";
  }
}

export function writeSpotifyCookie(value: string): void {
  try {
    const trimmed = value.trim();
    if (trimmed) {
      sessionStorage.setItem(SPOTIFY_COOKIE_KEY, trimmed);
      localStorage.removeItem(SPOTIFY_COOKIE_KEY);
    } else {
      sessionStorage.removeItem(SPOTIFY_COOKIE_KEY);
      localStorage.removeItem(SPOTIFY_COOKIE_KEY);
    }
  } catch {}
}
