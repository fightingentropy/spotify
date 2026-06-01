import { Link } from "react-router-dom";
import { Download, Heart, ListMusic, RadioTower } from "lucide-react";
import { useApiData, withAccountScope, type LibraryPayload } from "@/client/api";
import { useAuth } from "@/client/auth";

export default function LibraryPage() {
  const { user, status } = useAuth();
  const { data, loading } = useApiData<LibraryPayload>(
    withAccountScope("/api/library", user?.id ?? status),
    {
      playlists: [],
      userId: null,
    },
  );

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6">
      <div className="mx-auto max-w-7xl">
        <h1 className="mb-5 text-2xl font-bold">Your Library</h1>
        <div className="space-y-2">
          <Link to="/liked" className="flex min-h-[64px] items-center gap-4 rounded-xl px-3 touch-manipulation active:bg-black/5 dark:active:bg-white/5">
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-700 text-white">
              <Heart size={24} />
            </div>
            <div>
              <div className="font-semibold">Liked Songs</div>
              <div className="text-sm opacity-70">Your favorites</div>
            </div>
          </Link>

          <Link to="/downloads" className="flex min-h-[64px] items-center gap-4 rounded-xl px-3 touch-manipulation active:bg-black/5 dark:active:bg-white/5">
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-emerald-500/15 text-emerald-300">
              <Download size={24} />
            </div>
            <div>
              <div className="font-semibold">Downloads</div>
              <div className="text-sm opacity-70">Saved for offline</div>
            </div>
          </Link>

          <Link to="/radio" className="flex min-h-[64px] items-center gap-4 rounded-xl px-3 touch-manipulation active:bg-black/5 dark:active:bg-white/5">
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-cyan-500/15 text-cyan-200">
              <RadioTower size={24} />
            </div>
            <div>
              <div className="font-semibold">Radio Stations</div>
              <div className="text-sm opacity-70">Dromos 89.8 and BBC Radio 1</div>
            </div>
          </Link>

          {data.userId ? (
            data.playlists.length > 0 ? (
              <>
                <div className="px-3 pb-2 pt-4 text-xs uppercase tracking-wide opacity-60">Playlists</div>
                {data.playlists.map((playlist) => (
                  <Link
                    key={playlist.id}
                    to={`/playlist/${playlist.id}`}
                    className="flex min-h-[64px] items-center gap-4 rounded-xl px-3 touch-manipulation active:bg-black/5 dark:active:bg-white/5"
                  >
                    <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-black/5 dark:bg-white/10">
                      <ListMusic size={24} className="opacity-80" />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{playlist.name}</div>
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
              <Link className="text-emerald-500 underline" to="/signin">Sign in</Link> to view your playlists.
            </div>
          )}

          <Link to="/upload" className="flex min-h-[64px] items-center gap-4 rounded-xl px-3 touch-manipulation active:bg-black/5 dark:active:bg-white/5 lg:hidden">
            <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-black/5 text-lg font-semibold dark:bg-white/10">+</div>
            <div>
              <div className="font-semibold">Upload</div>
              <div className="text-sm opacity-70">Add new music</div>
            </div>
          </Link>
        </div>
        <div className="h-24 lg:hidden" />
      </div>
    </div>
  );
}
