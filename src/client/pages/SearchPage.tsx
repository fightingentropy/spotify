import MobileSearch from "@/components/MobileSearch";
import { useApiData, type SearchIndexPayload } from "@/client/api";

export default function SearchPage() {
  const { data, loading, error } = useApiData<SearchIndexPayload>("/api/search-index", {
    songs: [],
  });
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
