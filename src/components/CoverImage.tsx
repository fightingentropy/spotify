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
  const {
    fill,
    width,
    height,
    sizes: _sizes,
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
      loading={loading === "eager" ? "eager" : "lazy"}
      width={fill ? undefined : width}
      height={fill ? undefined : height}
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
