import { useEffect, useState } from "react";
import { getColors } from "react-native-image-colors";
import { toAbsoluteApiUrl } from "@/lib/config";
import { colors } from "@/theme";

// Cap a color's perceived luminance so it always reads as a dark background behind
// white text (Spotify does the same). Dark covers pass through with their hue intact;
// light/pale covers (e.g. a white album sleeve) get scaled down proportionally so the
// hue is preserved but the bar never washes out the text.
const LUMA_CAP = 85; // 0..255

function toBackgroundTint(hex: string): string {
  const m = hex.replace("#", "");
  const n = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  let r = parseInt(n.slice(0, 2), 16);
  let g = parseInt(n.slice(2, 4), 16);
  let b = parseInt(n.slice(4, 6), 16);
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  if (luma > LUMA_CAP) {
    const k = LUMA_CAP / luma;
    r = Math.round(r * k);
    g = Math.round(g * k);
    b = Math.round(b * k);
  }
  const ch = (v: number) => v.toString(16).padStart(2, "0");
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

// Pull a representative color from album art (Spotify-style) for tinting the Now
// Playing background and the mini-player. The native module downloads + samples the
// image and caches the result per-URI. NOTE: getColors needs an absolute URL —
// relative `/api/...` paths fail to download — so resolve via toAbsoluteApiUrl first
// (same as CoverImage).
export function useArtworkColor(uri?: string | null): string | null {
  const [color, setColor] = useState<string | null>(null);

  useEffect(() => {
    const abs = toAbsoluteApiUrl(uri);
    if (!abs) {
      setColor(null);
      return;
    }
    let cancelled = false;
    getColors(abs, { fallback: colors.surface, cache: true, key: abs })
      .then((res) => {
        if (cancelled) return;
        // iOS UIImageColors → `background`; Android Palette → `dominant`.
        const picked = res.platform === "ios" ? res.background : res.platform === "android" ? res.dominant : null;
        setColor(picked ? toBackgroundTint(picked) : null);
      })
      .catch(() => {
        if (!cancelled) setColor(null);
      });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  return color;
}
