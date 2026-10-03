import { Link, useLocation } from "react-router";
import { albumPagePath, type CatalogAlbum } from "@spotify/shared/catalog-albums";
import { CoverImage } from "@/components/CoverImage";

export function AlbumResult({ album, onSelect }: { album: CatalogAlbum; onSelect?: () => void }) {
  const location = useLocation();
  return <Link to={albumPagePath(album)} state={{ from: `${location.pathname}${location.search}` }} onClick={onSelect} aria-label={`Open album ${album.name} by ${album.artist}`}
    className="group flex min-h-20 items-center gap-3 rounded-md p-2 text-left transition hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
    <div className="h-16 w-16 shrink-0 overflow-hidden rounded bg-white/[0.06]">
      <CoverImage src={album.imageUrl ?? undefined} alt="" sizes="64px" className="h-full w-full object-cover" />
    </div>
    <div className="min-w-0 flex-1">
      <div className="truncate text-sm font-medium text-white">{album.name}</div>
      <div className="mt-0.5 truncate text-sm wf-muted">{album.artist}</div>
      <div className="mt-0.5 truncate text-xs text-white/45">{["Album", album.releaseDate?.slice(0, 4), album.provider === "youtube" ? "YouTube Music" : "Spotify"].filter(Boolean).join(" · ")}</div>
    </div>
  </Link>;
}
