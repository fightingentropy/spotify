import { Play } from "lucide-react";
import {
  type ListeningStatsPayload,
  type ListeningWeek,
  useApiData,
  withAccountScope,
} from "@/client/api";
import { useAuth } from "@/client/auth";
import { CoverImage } from "@/components/CoverImage";
import { PageError } from "@/components/PageError";
import { PageHeader, PageLayout, SectionHeader } from "@/components/PageLayout";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { usePlayerStore } from "@/store/player";

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

function mondayUtc(date: Date): string {
  const dayOffset = (date.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - dayOffset,
  ));
  return monday.toISOString().slice(0, 10);
}

function weekHeading(weekStart: string): string | null {
  const thisMonday = mondayUtc(new Date());
  if (weekStart === thisMonday) return "This week";
  const lastMonday = new Date(`${thisMonday}T00:00:00Z`);
  lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
  return weekStart === lastMonday.toISOString().slice(0, 10) ? "Last week" : null;
}

function weekRange(week: ListeningWeek): string {
  return `${DATE_FORMAT.format(new Date(`${week.weekStart}T00:00:00Z`))} – ${DATE_FORMAT.format(
    new Date(`${week.weekEnd}T00:00:00Z`),
  )}`;
}

function WeekCard({ week }: { week: ListeningWeek }) {
  const setQueue = usePlayerStore((state) => state.setQueue);
  const heading = weekHeading(week.weekStart);
  const playTopSong = () => {
    if (!week.topSong) return;
    requestImmediatePlayback(week.topSong);
    setQueue([week.topSong], 0);
  };

  return (
    <section className="border-b border-white/[0.08] pb-6 last:border-0">
      <SectionHeader title={heading ?? weekRange(week)} description={heading ? weekRange(week) : undefined} />
      <div className="grid min-w-0 grid-cols-1 divide-y divide-white/[0.08] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <div className="min-w-0 py-4 first:pt-0 sm:px-4 sm:py-0 sm:first:pl-0">
          <p className="wf-muted text-sm">Minutes listened</p>
          <p className="mt-2 text-[28px] font-semibold tabular-nums leading-10">{week.minutesListened}</p>
        </div>

        <div className="min-w-0 py-4 first:pt-0 sm:px-4 sm:py-0 sm:first:pl-0">
          <p className="wf-muted text-sm">Top artist</p>
          {week.topArtist ? (
            <div className="mt-3 flex min-w-0 items-center gap-3">
              <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-full bg-white/[0.06]">
                <CoverImage src={week.topArtist.image ?? undefined} alt={week.topArtist.name} fill sizes="56px" />
              </div>
              <p className="min-w-0 truncate text-[15px] font-medium">{week.topArtist.name}</p>
            </div>
          ) : (
            <p className="wf-muted mt-3 text-sm">No artist yet</p>
          )}
        </div>

        <button
          type="button"
          disabled={!week.topSong}
          onClick={playTopSong}
          className="group min-w-0 rounded-md py-4 text-left sm:py-0 sm:pl-4 transition-colors hover:bg-white/[0.035] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/60 disabled:cursor-default disabled:hover:bg-transparent"
        >
          <p className="wf-muted text-sm">Top song</p>
          {week.topSong ? (
            <div className="mt-3 flex min-w-0 items-center gap-3">
              <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md bg-white/[0.06]">
                <CoverImage
                  src={week.topSong.imageUrl}
                  networkSrc={week.topSong.networkImageUrl}
                  alt={week.topSong.title}
                  fill
                  sizes="56px"
                />
                <span className="absolute inset-0 grid place-items-center bg-black/35 opacity-0 transition group-hover:opacity-100">
                  <Play size={20} fill="currentColor" />
                </span>
              </div>
              <div className="min-w-0">
                <p className="truncate text-[15px] font-medium">{week.topSong.title}</p>
                <p className="wf-muted truncate text-sm">{week.topSong.artist}</p>
              </div>
            </div>
          ) : (
            <p className="wf-muted mt-3 text-sm">No song yet</p>
          )}
        </button>
      </div>
    </section>
  );
}

export default function ListeningStatsPage() {
  const { user, status } = useAuth();
  const { data, loading, error, retry } = useApiData<ListeningStatsPayload>(
    withAccountScope("/api/stats/listening", user?.id ?? status),
    { weeks: [] },
    { enabled: status === "authenticated", keepPreviousData: true },
  );

  return (
    <PageLayout>
      <PageHeader title="Listening stats" />
      {loading && data.weeks.length === 0 ? <p className="wf-muted text-sm">Loading listening stats…</p> : null}
      {error ? <PageError compact message={error} onRetry={retry} retryLabel="Retry" /> : null}
      {!loading && !error && data.weeks.length === 0 ? (
        <div className="wf-empty-state">
          <h2 className="wf-section-title">No listening yet</h2>
          <p className="wf-muted mt-1 text-sm">Play some music and your weekly stats will show up here.</p>
        </div>
      ) : null}
      <div className="space-y-6">{data.weeks.map((week) => <WeekCard key={week.weekStart} week={week} />)}</div>
    </PageLayout>
  );
}
