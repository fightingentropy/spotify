import MobileSearch from "@/components/MobileSearch";
import { useApiData, withAccountScope, type SearchIndexPayload } from "@/client/api";
import { useAuth } from "@/client/auth";

export default function SearchPage() {
  const { user, status } = useAuth();
  const { data, loading, error } = useApiData<SearchIndexPayload>(
    withAccountScope("/api/search-index", user?.id ?? status),
    {
      songs: [],
    },
  );
  const songs = data.songs;

  if (loading) {
    return <div className="px-4 py-6 max-w-7xl mx-auto opacity-70">Loading search...</div>;
  }
  if (error) {
    return <div className="px-4 py-6 max-w-7xl mx-auto text-red-500">{error}</div>;
  }

  return (
    <>
      <MobileSearch songs={songs} />
      <div className="h-24 lg:hidden" />
    </>
  );
}
