import { SongGrid } from "@/components/SongGrid";
import { listObjects } from "@/lib/storage";

export const revalidate = 0;
export const runtime = "nodejs";

export default async function LikedPage() {
  // Mirror the Home page against MinIO prefix
  const prefix = "audio/top 100/";
  const objects = await listObjects(prefix).catch(() => [] as Array<{ name: string }>);
  const mp3Files = objects
    .map((o) => o.name)
    .filter((n) => n && n.toLowerCase().endsWith(".mp3"))
    .map((n) => n.replace(/^audio\//, ""))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const songs = mp3Files.map((key) => {
    const parts = key.split("/");
    const fileName = parts[parts.length - 1] || key;
    const folder = parts.slice(0, -1).join("/");
    const withoutExt = fileName.replace(/\.[^.]+$/, "");
    const withoutIndex = withoutExt.replace(/^\s*\d+\.\s*/, "");
    const sep = " - ";
    const idx = withoutIndex.indexOf(sep);
    const artist = idx !== -1 ? withoutIndex.slice(0, idx).trim() : "Unknown";
    const title = idx !== -1 ? withoutIndex.slice(idx + sep.length).trim() : withoutIndex.trim();
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
      <h1 className="text-2xl font-semibold mb-6">Liked Songs</h1>
      {songs.length === 0 ? (
        <div className="opacity-70">No liked songs yet.</div>
      ) : (
        <SongGrid songs={songs} />
      )}
      <div className="h-24" />
    </div>
  );
}


