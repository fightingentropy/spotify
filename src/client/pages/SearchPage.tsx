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
      <div className="lg:hidden">
        <MobileSearch songs={songs} />
      </div>
      <div className="hidden lg:block px-6 py-8 max-w-7xl mx-auto">
        <h1 className="text-2xl font-semibold mb-6">Search</h1>
        <MobileSearch songs={songs} />
      </div>
      <div className="h-24 lg:hidden" />
    </>
  );
}
