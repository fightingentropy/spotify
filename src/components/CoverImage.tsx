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

  return (
    <Image
      {...props}
      alt={alt}
      src={resolvedSrc}
      onError={() => setFailed(true)}
    />
  );
}
