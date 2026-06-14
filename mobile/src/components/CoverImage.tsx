import { Image, type ImageContentFit, type ImageStyle } from "expo-image";
import { useEffect, useMemo, useState } from "react";
import { type StyleProp } from "react-native";
import { API_ORIGIN, toAbsoluteApiUrl } from "@/lib/config";

const FALLBACK_COVER = `${API_ORIGIN}/apple-icon.png`;

type CoverImageProps = {
  src?: string | null;
  // Remote cover to retry with when `src` (a device-local offline file) fails.
  networkSrc?: string | null;
  contentFit?: ImageContentFit;
  style?: StyleProp<ImageStyle>;
  // expo-image transition (ms) — mirrors the web cover-settle fade.
  transition?: number;
  recyclingKey?: string;
};

// RN replacement for src/components/CoverImage.tsx. expo-image caches covers and
// decodes off-thread; we keep the candidate fallback chain (src → networkSrc →
// bundled fallback) advancing on load error. The web r2 ?w= srcSet is dropped —
// /api/artwork/local serves the cover as-is (§6).
export function CoverImage({ src, networkSrc, contentFit = "cover", style, transition = 220, recyclingKey }: CoverImageProps) {
  const candidates = useMemo(() => {
    const list: string[] = [];
    if (src && src.trim()) list.push(toAbsoluteApiUrl(src));
    if (networkSrc && networkSrc.trim()) {
      const abs = toAbsoluteApiUrl(networkSrc);
      if (!list.includes(abs)) list.push(abs);
    }
    if (!list.includes(FALLBACK_COVER)) list.push(FALLBACK_COVER);
    return list;
  }, [src, networkSrc]);

  const [stage, setStage] = useState(0);
  useEffect(() => setStage(0), [candidates]);

  const uri = candidates[Math.min(stage, candidates.length - 1)];

  return (
    <Image
      style={style}
      source={{ uri }}
      contentFit={contentFit}
      transition={transition}
      recyclingKey={recyclingKey ?? src ?? undefined}
      cachePolicy="memory-disk"
      onError={() => setStage((s) => Math.min(s + 1, candidates.length - 1))}
    />
  );
}
