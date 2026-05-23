"use client";

import { useState } from "react";
import Image, { type ImageProps } from "next/image";

type CoverImageProps = Omit<ImageProps, "src" | "onError"> & {
  src: string | null | undefined;
  fallbackSrc?: string;
};

export function CoverImage({
  src,
  fallbackSrc = "/waveform.svg",
  alt,
  ...props
}: CoverImageProps) {
  const [failed, setFailed] = useState(false);
  const resolvedSrc = failed || !src || src.trim().length === 0 ? fallbackSrc : src;
  const isBrowserUrl =
    resolvedSrc.startsWith("blob:") || resolvedSrc.startsWith("data:");

  if (isBrowserUrl) {
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
        width={fill ? undefined : typeof width === "number" ? width : undefined}
        height={fill ? undefined : typeof height === "number" ? height : undefined}
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

  return (
    <Image
      {...props}
      alt={alt}
      src={resolvedSrc}
      onError={() => setFailed(true)}
    />
  );
}
