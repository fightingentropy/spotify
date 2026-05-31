"use client";

import { useState } from "react";
import type { ImgHTMLAttributes } from "react";
import { normalizeCoverImageUrl } from "@/lib/song-utils";

type CoverImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> & {
  src: string | null | undefined;
  fallbackSrc?: string;
  fill?: boolean;
  priority?: boolean;
  quality?: number;
  placeholder?: string;
  blurDataURL?: string;
  unoptimized?: boolean;
};

const COVER_IMAGE_WIDTHS = [64, 128, 256, 384, 640];

function artworkVariantUrl(src: string, width: number): string | null {
  if (!src.startsWith("/api/files/")) return null;
  if (src.startsWith("/api/files/local/")) return null;
  const path = src.slice("/api/files/".length);
  const cleanPath = path.split(/[?#]/)[0] || "";
  if (!/\.(jpe?g|png|webp|gif)$/i.test(cleanPath)) return null;
  const encodedPath = cleanPath
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  if (!encodedPath) return null;
  return `/api/artwork/r2/${encodedPath}?w=${width}`;
}

function artworkSrcSet(src: string): string | undefined {
  const entries = COVER_IMAGE_WIDTHS
    .map((width) => {
      const url = artworkVariantUrl(src, width);
      return url ? `${url} ${width}w` : "";
    })
    .filter(Boolean);
  return entries.length > 0 ? entries.join(", ") : undefined;
}

export function CoverImage({
  src,
  fallbackSrc = "/apple-icon.png",
  alt,
  ...props
}: CoverImageProps) {
  const [failed, setFailed] = useState(false);
  const resolvedSrc = normalizeCoverImageUrl(
    failed || !src || src.trim().length === 0 ? fallbackSrc : src,
  );
  const generatedSrcSet = artworkSrcSet(resolvedSrc);
  const {
    fill,
    width,
    height,
    sizes,
    priority: _priority,
    quality: _quality,
    placeholder: _placeholder,
    blurDataURL: _blurDataURL,
    unoptimized: _unoptimized,
    loading,
    style,
    ...imgProps
  } = props;
  return (
    <img
      {...imgProps}
      alt={alt}
      src={resolvedSrc}
      loading={_priority || loading === "eager" ? "eager" : "lazy"}
      decoding="async"
      fetchPriority={_priority ? "high" : undefined}
      width={fill ? undefined : width}
      height={fill ? undefined : height}
      sizes={sizes}
      srcSet={imgProps.srcSet ?? generatedSrcSet}
      style={{
        ...(fill
          ? {
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
            }
          : null),
        ...style,
      }}
      onError={() => setFailed(true)}
    />
  );
}
