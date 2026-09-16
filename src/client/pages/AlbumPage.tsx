import { Link, useLocation, useParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { albumDetailPath, isYouTubeAlbumId } from "@spotify/shared/catalog-albums";
import { useAuth } from "@/client/auth";
import { useApiData, withAccountScope, type CuratedPlaylistPayload } from "@/client/api";
import { CuratedPlaylistView } from "@/client/pages/PlaylistPage";
import { PageError } from "@/components/PageError";

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
  return <>
    <div className="mx-auto max-w-5xl px-4 pt-5 sm:px-6"><Link to={backToSearch} className="inline-flex min-h-11 items-center gap-2 text-sm text-white/60 hover:text-white"><ArrowLeft size={18} /> Albums</Link></div>
    {!valid ? <PageError message="Invalid album link" /> : status === "unauthenticated" ? <div className="py-12 text-center"><Link to="/signin">Sign in to open this album</Link></div> : error ? <PageError message={error} onRetry={retry} /> : loading || !data ?
      <div role="status" className="mx-auto max-w-5xl px-6 py-10 text-white/60">Loading album…</div> : <CuratedPlaylistView data={data} />}
  </>;
}
