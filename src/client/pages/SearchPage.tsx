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
    return (
      <div className="px-4 py-6 max-w-7xl mx-auto">
        <div className="mb-5 text-2xl font-semibold">Search</div>
        <div className="space-y-3" aria-hidden>
          <div className="wf-skeleton h-12 rounded-full" />
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="flex min-h-[64px] items-center gap-4 rounded-xl">
              <div className="wf-skeleton h-14 w-14 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="wf-skeleton h-4 w-48 max-w-full rounded-full" />
                <div className="wf-skeleton h-3 w-28 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
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
