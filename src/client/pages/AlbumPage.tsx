import { Link, useLocation, useParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { albumDetailPath, isYouTubeAlbumId } from "@spotify/shared/catalog-albums";
import { useAuth } from "@/client/auth";
import { useApiData, withAccountScope, type CuratedPlaylistPayload } from "@/client/api";
import { CuratedPlaylistView } from "@/client/pages/PlaylistPage";
import { PageError } from "@/components/PageError";
import { PageHeader, PageLayout } from "@/components/PageLayout";

export default function AlbumPage() {
  const { source, id = "" } = useParams();
  const location = useLocation();
  const from: unknown = location.state?.from;
  const backToSearch = typeof from === "string" && /^\/search(?:\?|$)/.test(from) ? from : "/search?type=albums";
  const { user, status } = useAuth();
  const valid = (source === "spotify" || source === "youtube") && (source === "youtube" ? isYouTubeAlbumId(id) : /^[A-Za-z0-9]{22}$/.test(id));
  const { data, loading, error, retry } = useApiData<CuratedPlaylistPayload | null>(
    withAccountScope(albumDetailPath({ provider: source === "youtube" ? "youtube" : "spotify", id }), user?.id ?? status), null,
    { enabled: valid && status === "authenticated", keepPreviousData: false },
  );
  const navigation = <Link to={backToSearch} className="wf-button mb-6"><ArrowLeft size={16} /> Albums</Link>;
  if (valid && status !== "unauthenticated" && !error && !loading && data) {
    return <CuratedPlaylistView data={data} navigation={navigation} />;
  }
  return (
    <PageLayout>
      {navigation}
      <PageHeader title="Album" />
      {!valid ? <PageError compact message="Invalid album link" /> : status === "unauthenticated" ? (
        <div className="wf-empty-state"><p className="mb-4">Sign in to open this album.</p><Link className="wf-button-primary" to="/signin">Sign in</Link></div>
      ) : error ? <PageError compact message={error} onRetry={retry} /> : (
        <p role="status" className="wf-muted text-sm">Loading album…</p>
      )}
    </PageLayout>
  );
}
