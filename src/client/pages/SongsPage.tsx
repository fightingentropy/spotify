import { useAuth } from "@/client/auth";
import { type HomePayload, useApiData, withAccountScope } from "@/client/api";
import { PageHeader, PageLayout } from "@/components/PageLayout";
import { PageError } from "@/components/PageError";
import { SongGrid } from "@/components/SongGrid";
import type { PlayerSong } from "@/types/player";

export default function SongsPage() {
  const { user, status } = useAuth();
  const scope = user?.id ?? status;
  const songsState = useApiData<PlayerSong[]>(withAccountScope("/api/songs", scope), [], {
    enabled: status !== "loading",
    keepPreviousData: true,
  });
  const likesState = useApiData<HomePayload>(
    withAccountScope("/api/home", scope),
    { likedSongIds: [] },
    { enabled: status !== "loading", keepPreviousData: true },
  );

  if ((songsState.loading && songsState.data.length === 0) || status === "loading") {
    return <PageLayout><PageHeader title="All Songs" /><p role="status" className="wf-muted text-sm">Loading songs...</p></PageLayout>;
  }

  if (songsState.error) {
    return (
      <PageLayout>
        <PageHeader title="All Songs" />
        <div className="mt-3">
          <PageError compact message={songsState.error} onRetry={songsState.retry} />
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      <PageHeader title="All Songs" description={`${songsState.data.length} tracks in your library`} />
      {likesState.error ? (
        <div className="mb-4">
          <PageError
            compact
            message={`Liked songs couldn’t load. ${likesState.error}`}
            onRetry={likesState.retry}
          />
        </div>
      ) : null}
      <SongGrid
        songs={songsState.data}
        likedSongIds={likesState.loading || likesState.error ? null : likesState.data.likedSongIds}
        canLike={Boolean(user)}
        emptyLabel="Your library is empty. Upload music to get started."
      />
    </PageLayout>
  );
}
