import { type FormEvent, type ReactNode, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Heart, ListMusic, Music2, Plus, Podcast, RadioTower, Search, Ticket, Upload } from "lucide-react";
import { AuthButtons } from "@/components/AuthButtons";
import { CoverImage } from "@/components/CoverImage";
import { PageHeader, PageLayout, SectionHeader } from "@/components/PageLayout";
import { PageError } from "@/components/PageError";
import { PlaylistArtwork } from "@/components/PlaylistArtwork";
import { useApiData, withAccountScope, type LibraryPayload } from "@/client/api";
import { useAuth } from "@/client/auth";
import { createPlaylist } from "@/client/playlist-actions";
import { PODCAST_SHOWS, podcastMediaProxyUrl } from "@/lib/podcasts";

type LibraryFilter = "all" | "playlists" | "podcasts";

function FilterButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-active={active}
      className="wf-tab"
    >
      {label}
    </button>
  );
}

function LibraryShortcut({
  to,
  title,
  subtitle,
  artwork,
  children,
}: {
  to: string;
  title: string;
  subtitle: string;
  artwork?: {
    src?: string | null;
  };
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className="wf-list-row wf-pressable flex min-h-16 items-center gap-3 rounded-md px-2 py-2 touch-manipulation hover:bg-white/[0.045]"
    >
      <span
        className={[
          "grid shrink-0 place-items-center overflow-hidden rounded bg-white/[0.06] text-white/60",
          artwork ? "h-[62px] w-[62px]" : "h-11 w-11",
        ].join(" ")}
      >
        {artwork?.src ? (
          <CoverImage
            src={artwork.src}
            alt=""
            width={62}
            height={62}
            className="h-full w-full object-cover"
            sizes="62px"
          />
        ) : (
          children
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-[#f2f2f2]">
          {title}
        </span>
        <span className="mt-0.5 block truncate text-xs wf-muted">{subtitle}</span>
      </span>
    </Link>
  );
}

function PlaylistSkeletonRows() {
  return (
    <div className="space-y-2 px-3 py-2" aria-hidden>
      {[0, 1, 2].map((item) => (
        <div key={item} className="flex min-h-[64px] items-center gap-3 rounded">
          <div className="wf-skeleton h-14 w-14 shrink-0 rounded" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="wf-skeleton h-4 w-44 max-w-full rounded-full" />
            <div className="wf-skeleton h-3 w-24 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

function PlaylistGridSkeleton() {
  return (
    <div
      className="grid gap-x-3 gap-y-6 [grid-template-columns:repeat(auto-fill,minmax(164px,1fr))]"
      aria-hidden
    >
      {[0, 1, 2, 3, 4, 5].map((item) => (
        <div key={item} className="min-w-0">
          <div className="wf-skeleton aspect-square rounded" />
          <div className="mt-3 space-y-2">
            <div className="wf-skeleton h-4 w-4/5 rounded-full" />
            <div className="wf-skeleton h-3 w-1/2 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function LibraryPage({ playlistOnly = false }: { playlistOnly?: boolean }) {
  const { user, status } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedFilter = searchParams.get("filter");
  const filter: LibraryFilter =
    playlistOnly
      ? "playlists"
      : requestedFilter === "playlists" || requestedFilter === "podcasts"
        ? requestedFilter
        : "all";
  const [creating, setCreating] = useState(false);
  const [playlistName, setPlaylistName] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const { data, loading, error, retry } = useApiData<LibraryPayload>(
    withAccountScope("/api/library", user?.id ?? status),
    {
      playlists: [],
      userId: null,
    },
    { enabled: status !== "loading" },
  );
  // Drive the playlists section from real auth state — NOT data.userId, which is
  // null during the cold-load window (and on a fetch error) even for a signed-in
  // user, which would otherwise flash a "Sign in" prompt at them.
  const signedIn = !!user;
  const showSkeleton = status === "loading" || (signedIn && loading && data.playlists.length === 0);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const name = playlistName.trim();
    if (!name) return;
    setCreating(true);
    setActionError(null);
    try {
      const playlist = await createPlaylist(name);
      setPlaylistName("");
      retry();
      navigate(`/playlist/${playlist.id}`);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Couldn't create the playlist.");
    } finally {
      setCreating(false);
    }
  };

  const showPlaylists = filter === "all" || filter === "playlists";
  const toggleFilter = (nextFilter: LibraryFilter) => {
    const resolvedFilter = filter === nextFilter ? "all" : nextFilter;
    const nextSearchParams = new URLSearchParams(searchParams);
    if (resolvedFilter === "all") nextSearchParams.delete("filter");
    else nextSearchParams.set("filter", resolvedFilter);
    setSearchParams(nextSearchParams);
  };

  return (
    <PageLayout>
      <PageHeader
        title={filter === "playlists" ? "Playlists" : "Library"}
        description={filter === "playlists" && signedIn && !showSkeleton ? `${data.playlists.length} ${data.playlists.length === 1 ? "playlist" : "playlists"}` : undefined}
        actions={
          <>
            <div className="lg:hidden"><AuthButtons compact /></div>
            <Link to="/search" aria-label="Search" className="wf-icon-button"><Search size={18} /></Link>
            <Link to="/upload" aria-label="Add music" className="wf-icon-button"><Plus size={18} /></Link>
          </>
        }
      />

      {!playlistOnly ? (
        <div className="wf-tabs mb-6" aria-label="Library filters">
          <FilterButton label="All" active={filter === "all"} onClick={() => toggleFilter("all")} />
          <FilterButton
            label="Playlists"
            active={filter === "playlists"}
            onClick={() => toggleFilter("playlists")}
          />
          <FilterButton
            label="Podcasts"
            active={filter === "podcasts"}
            onClick={() => toggleFilter("podcasts")}
          />
        </div>
      ) : null}

      <div>
        {filter === "all" ? (
          <LibraryShortcut to="/liked" title="Liked Songs" subtitle={`Playlist • ${user?.name || "You"}`}>
            <Heart size={20} fill="currentColor" className="text-[#f2f2f2]" />
          </LibraryShortcut>
        ) : null}

        {filter === "all" ? (
          <>
            <LibraryShortcut to="/songs" title="All Songs" subtitle="Browse your full library">
              <Music2 size={20} />
            </LibraryShortcut>
            <LibraryShortcut to="/radio" title="Radio Stations" subtitle="Live streams">
              <RadioTower size={20} />
            </LibraryShortcut>
          </>
        ) : null}

        {filter === "all" ? (
          <LibraryShortcut to="/podcasts" title="Podcasts" subtitle="Shows & episodes">
            <Podcast size={20} />
          </LibraryShortcut>
        ) : null}

        {filter === "podcasts"
          ? PODCAST_SHOWS.map((podcastShow) => (
              <LibraryShortcut
                key={podcastShow.id}
                to={`/podcasts?show=${encodeURIComponent(podcastShow.id)}`}
                title={podcastShow.title}
                subtitle={`Podcast • ${podcastShow.author}`}
                artwork={{
                  src: podcastMediaProxyUrl(podcastShow.id, podcastShow.imageUrl),
                }}
              >
                <Podcast size={22} />
              </LibraryShortcut>
            ))
          : null}

        {filter === "all" ? (
          <LibraryShortcut to="/events" title="Live Events" subtitle="Concerts & venues near you">
            <Ticket size={20} />
          </LibraryShortcut>
        ) : null}

        {showPlaylists ? (
          showSkeleton ? (
            filter === "playlists" ? <PlaylistGridSkeleton /> : <PlaylistSkeletonRows />
          ) : (
            <>
              {filter === "all" ? <div className="mt-8"><SectionHeader title="Playlists" /></div> : null}

              {signedIn ? (
                <form onSubmit={handleCreate} className="mb-6 flex max-w-lg gap-2">
                  <label htmlFor="new-playlist-name" className="sr-only">New playlist name</label>
                  <input
                    id="new-playlist-name"
                    value={playlistName}
                    onChange={(event) => setPlaylistName(event.target.value)}
                    placeholder="Playlist name"
                    maxLength={80}
                    className="wf-input min-w-0 flex-1"
                  />
                  <button
                    type="submit"
                    disabled={creating || !playlistName.trim()}
                    className="wf-button-primary"
                  >
                    {creating ? "Creating..." : "Create"}
                  </button>
                </form>
              ) : null}

              {actionError ? <div className="mb-3 text-sm text-red-300">{actionError}</div> : null}

              {signedIn ? (
                filter === "playlists" ? (
                  <div className="grid gap-x-3 gap-y-6 [grid-template-columns:repeat(auto-fill,minmax(164px,1fr))]">
                    {data.playlists.map((playlist, index) => (
                      <Link
                        key={playlist.id}
                        to={`/playlist/${playlist.id}`}
                        className="wf-song-card group min-w-0 touch-manipulation"
                      >
                        <PlaylistArtwork
                          coverImageUrls={playlist.coverImageUrls}
                          imageUrl={playlist.imageUrl}
                          sizes="(max-width: 639px) 45vw, 190px"
                          loading={index < 6 ? "eager" : "lazy"}
                          className="w-full rounded"
                        />
                        <div className="min-h-12 min-w-0 px-px pt-[9px]">
                          <div className="truncate text-sm font-medium leading-5 text-[#f2f2f2]">
                            {playlist.name}
                          </div>
                          <div className="mt-px truncate text-xs leading-5 wf-muted">
                            {playlist.songsCount} {playlist.songsCount === 1 ? "track" : "tracks"}
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                ) : (
                  data.playlists.map((playlist) => (
                      <LibraryShortcut
                        key={playlist.id}
                        to={`/playlist/${playlist.id}`}
                        title={playlist.name}
                        subtitle={`Playlist • ${playlist.songsCount} tracks`}
                        artwork={{
                          src: playlist.imageUrl,
                        }}
                      >
                        <ListMusic size={22} />
                      </LibraryShortcut>
                    ))
                )
              ) : null}

              {signedIn && error ? (
                <div className="pb-2 pt-4">
                  <PageError compact message={error} onRetry={retry} />
                </div>
              ) : null}

              {signedIn && !error && data.playlists.length === 0 ? (
                <div className="wf-empty-state">You don’t have any playlists yet.</div>
              ) : null}

              {!signedIn ? (
                <div className="wf-empty-state">
                  <Link className="text-white underline" to="/signin">Sign in</Link> to view your playlists.
                </div>
              ) : null}
            </>
          )
        ) : null}

        {filter === "all" ? (
          <LibraryShortcut to="/upload" title="Import your music" subtitle="Add new music">
            <Upload size={20} />
          </LibraryShortcut>
        ) : null}
      </div>
    </PageLayout>
  );
}
