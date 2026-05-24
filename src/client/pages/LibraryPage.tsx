import { Link } from "react-router-dom";
import { Heart, ListMusic } from "lucide-react";
import { useApiData, type LibraryPayload } from "@/client/api";

export default function LibraryPage() {
  const { data, loading } = useApiData<LibraryPayload>("/api/library", {
    playlists: [],
    userId: null,
  });

  return (
    <div className="px-4 py-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-5">Your Library</h1>
      <div className="space-y-2">
        <Link to="/liked" className="flex items-center gap-4 min-h-[64px] px-3 rounded-xl active:bg-black/5 dark:active:bg-white/5 touch-manipulation">
          <div className="h-14 w-14 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-700 text-white grid place-items-center shrink-0">
            <Heart size={24} />
          </div>
          <div>
            <div className="font-semibold">Liked Songs</div>
            <div className="text-sm opacity-70">Your favorites</div>
          </div>
        </Link>

        {data.userId ? (
          data.playlists.length > 0 ? (
            <>
              <div className="pt-4 pb-2 text-xs uppercase tracking-wide opacity-60 px-3">Playlists</div>
              {data.playlists.map((playlist) => (
                <Link
                  key={playlist.id}
                  to={`/playlist/${playlist.id}`}
                  className="flex items-center gap-4 min-h-[64px] px-3 rounded-xl active:bg-black/5 dark:active:bg-white/5 touch-manipulation"
                >
                  <div className="h-14 w-14 rounded-lg bg-black/5 dark:bg-white/10 grid place-items-center shrink-0">
                    <ListMusic size={24} className="opacity-80" />
                  </div>
                  <div className="min-w-0">
                    <div className="font-semibold truncate">{playlist.name}</div>
                    <div className="text-sm opacity-70">{playlist.songsCount} tracks</div>
                  </div>
                </Link>
              ))}
            </>
          ) : loading ? (
            <div className="px-3 py-6 text-sm opacity-70">Loading playlists...</div>
          ) : null
        ) : (
          <div className="px-3 py-6 text-sm opacity-70">
            <Link className="underline text-emerald-500" to="/signin">Sign in</Link> to view your playlists.
          </div>
        )}

        <Link to="/upload" className="flex items-center gap-4 min-h-[64px] px-3 rounded-xl active:bg-black/5 dark:active:bg-white/5 touch-manipulation lg:hidden">
          <div className="h-14 w-14 rounded-lg bg-black/5 dark:bg-white/10 grid place-items-center shrink-0 text-lg font-semibold">+</div>
          <div>
            <div className="font-semibold">Upload</div>
            <div className="text-sm opacity-70">Add new music</div>
          </div>
        </Link>
      </div>
      <div className="h-24 lg:hidden" />
    </div>
  );
}
