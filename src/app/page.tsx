import { SongGrid } from "@/components/SongGrid";
import { listObjects } from "@/lib/storage";

export const revalidate = 0;
export const runtime = "nodejs";

function parseArtistAndTitle(fileName: string): { artist: string; title: string } {
  const withoutExt = fileName.replace(/\.[^.]+$/, "");
  const withoutIndex = withoutExt.replace(/^\s*\d+\.\s*/, "");
  const sep = " - ";
  const idx = withoutIndex.indexOf(sep);
  if (idx !== -1) {
    const artist = withoutIndex.slice(0, idx).trim();
    const title = withoutIndex.slice(idx + sep.length).trim();
    return { artist: artist || "Unknown", title: title || withoutIndex };
  }
  return { artist: "Unknown", title: withoutIndex.trim() };
}

export default async function Home() {
  const prefix = "audio/top 100/";
  const objects = await listObjects(prefix).catch(() => [] as Array<{ name: string }>);
  const mp3Files = objects
    .map((o) => o.name)
    .filter((n) => n && n.toLowerCase().endsWith(".mp3"))
    .map((n) => n.replace(/^audio\//, "")) // strip leading "audio/" so we can reuse artwork path format
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const songs = mp3Files.map((key) => {
    const parts = key.split("/");
    const fileName = parts[parts.length - 1] || key;
    const folder = parts.slice(0, -1).join("/");
    const { artist, title } = parseArtistAndTitle(fileName);
    const folderEncoded = folder.split("/").map(encodeURIComponent).join("/");
    return {
      id: `top100-${fileName}`,
      title,
      artist,
      imageUrl: `/api/artwork/${folderEncoded}/${encodeURIComponent(fileName)}`,
      audioUrl: `/api/files/audio/${encodeURIComponent(key)}`.replace(/%2F/g, "/"),
    };
  });

  return (
    <div className="px-6 py-8 max-w-7xl mx-auto">
      <div className="mb-6" />
      {songs.length === 0 ? (
        <div className="opacity-70">No songs found in Top 100.</div>
      ) : (
        <SongGrid songs={songs} />
      )}
      <div className="h-24" />
    </div>
  );
}
