import { prisma } from "@/lib/prisma";
import { SongGrid } from "@/components/SongGrid";
import { notFound } from "next/navigation";

export const revalidate = 0;
export const runtime = "nodejs";

export default async function PlaylistPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const playlist = await prisma.playlist.findUnique({
    where: { id },
    include: { songs: { include: { song: true }, orderBy: { order: "asc" } } },
  });
  if (!playlist) return notFound();

  function toMinioUrl(url: string, kind: "audio" | "images"): string {
    if (!url) return url;
    if (url.startsWith("/api/files/")) return url;
    if (kind === "images") {
      const prefix = "/uploads/images/";
      if (url.startsWith(prefix)) {
        const name = url.slice(prefix.length);
        return `/api/files/images/${encodeURIComponent(name)}`;
      }
    }
    if (kind === "audio") {
      const prefix = "/uploads/audio/";
      if (url.startsWith(prefix)) {
        const name = url.slice(prefix.length);
        return `/api/files/audio/${encodeURIComponent(name)}`;
      }
    }
    return url;
  }

  const songs = playlist.songs.map((ps) => ({
    id: ps.song.id,
    title: ps.song.title,
    artist: ps.song.artist,
    imageUrl: toMinioUrl(ps.song.imageUrl, "images").replace(/%2F/g, "/"),
    audioUrl: toMinioUrl(ps.song.audioUrl, "audio").replace(/%2F/g, "/"),
  }));

  return (
    <div className="px-6 py-8 max-w-7xl mx-auto">
      <h1 className="text-2xl font-semibold mb-1">{playlist.name}</h1>
      <div className="text-sm opacity-70 mb-6">{songs.length} tracks</div>
      {songs.length === 0 ? (
        <div className="opacity-70">This playlist is empty.</div>
      ) : (
        <SongGrid songs={songs} />
      )}
      <div className="h-24" />
    </div>
  );
}


