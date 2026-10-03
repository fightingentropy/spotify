const ARTWORK_WIDTHS = [64, 128, 256, 384, 640, 1024] as const;

function isWidthParameter(component: string): boolean {
  const name = component.split("=", 1)[0] ?? "";
  try {
    return decodeURIComponent(name.replace(/\+/g, " ")) === "w";
  } catch {
    return false;
  }
}

/** Keep signed local paths and auth query bytes intact; only the width changes. */
export function artworkVariantUrl(src: string, width: number): string | null {
  if (!src.startsWith("/api/") || !Number.isFinite(width) || width <= 0) return null;
  const withoutHash = src.split("#", 1)[0] ?? "";
  const queryIndex = withoutHash.indexOf("?");
  const pathname = queryIndex < 0 ? withoutHash : withoutHash.slice(0, queryIndex);
  const localArtwork = pathname.startsWith("/api/artwork/local/");
  const localFile = pathname.startsWith("/api/files/local/");
  const r2Artwork = pathname.startsWith("/api/artwork/r2/");
  if (!localArtwork && !/\.(jpe?g|png|webp|gif)$/i.test(pathname)) return null;
  let target = pathname;
  if (!localArtwork && !localFile && !r2Artwork) {
    if (!pathname.startsWith("/api/files/")) return null;
    // Existing R2 keys may encode slashes as %2F. Never decode or encode again.
    target = `/api/artwork/r2/${pathname.slice("/api/files/".length)}`;
  }
  const query = (queryIndex < 0 ? "" : withoutHash.slice(queryIndex + 1))
    .split("&")
    .filter((component) => component && !isWidthParameter(component));
  query.push(`w=${Math.ceil(width)}`);
  return `${target}?${query.join("&")}`;
}

export function artworkSrcSet(src: string): string | undefined {
  return ARTWORK_WIDTHS.map((width) => {
    const variant = artworkVariantUrl(src, width);
    return variant ? `${variant} ${width}w` : "";
  }).filter(Boolean).join(", ") || undefined;
}
