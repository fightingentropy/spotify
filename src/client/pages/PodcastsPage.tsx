"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Pause,
  Play,
  RefreshCw,
} from "lucide-react";
import { useSearchParams } from "react-router";
import { CoverImage } from "@/components/CoverImage";
import { PageHeader, PageLayout, SectionHeader } from "@/components/PageLayout";
import {
  PODCAST_SHOWS,
  parsePodcastFeed,
  podcastMediaProxyUrl,
  type PodcastEpisode,
} from "@/lib/podcasts";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { cn, formatTime } from "@/lib/utils";
import { usePlayerStore } from "@/store/player";
import {
  isEpisodeFinished,
  readAllEpisodeProgress,
  type PodcastEpisodeProgress,
} from "@/client/podcast-progress";

type FeedStatus = "idle" | "loading" | "ready" | "error";

function formatEpisodeDate(value: string | undefined): string {
  if (!value) return "Unknown date";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown date";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

function episodeDescription(value: string): string {
  if (!value) return "Episode details unavailable.";
  return value.length > 260 ? `${value.slice(0, 257).trim()}...` : value;
}

function remainingLabel(progress: PodcastEpisodeProgress): string {
  const remainingMinutes = Math.max(1, Math.ceil((progress.duration - progress.time) / 60));
  return `${remainingMinutes}m left`;
}

function EpisodeSkeletonRows() {
  return (
    <div className="divide-y divide-white/[0.08]" aria-hidden>
      {[0, 1, 2, 3].map((item) => (
        <div key={item} className="flex min-h-[88px] items-center gap-4 py-4">
          <div className="wf-skeleton h-14 w-14 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="wf-skeleton h-4 w-2/3 rounded" />
            <div className="wf-skeleton h-3 w-full rounded" />
            <div className="wf-skeleton h-3 w-36 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function PodcastsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedShowId = searchParams.get("show") ?? "";
  const selectedShow = useMemo(
    () => PODCAST_SHOWS.find((podcastShow) => podcastShow.id === selectedShowId) ?? null,
    [selectedShowId],
  );
  const [episodes, setEpisodes] = useState<PodcastEpisode[]>([]);
  const [status, setStatus] = useState<FeedStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const loadRequestIdRef = useRef(0);

  const setQueue = usePlayerStore((state) => state.setQueue);
  const toggle = usePlayerStore((state) => state.toggle);
  const currentSong = usePlayerStore((state) => state.currentSong);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const currentPodcastEpisodeId = currentSong?.source === "podcast" ? currentSong.id : null;

  // Re-read on play/pause/episode change so resume positions written by the
  // player stay roughly current without subscribing to every timeupdate.
  const progressByEpisodeId = useMemo(
    () => readAllEpisodeProgress(),
    [episodes, currentPodcastEpisodeId, isPlaying],
  );

  const loadFeed = useCallback(
    async (signal?: AbortSignal) => {
      if (!selectedShow) return;
      const requestId = ++loadRequestIdRef.current;
      const activeShow = selectedShow;
      setStatus("loading");
      setError(null);

      try {
        const response = await fetch(`/api/podcast-feeds/${encodeURIComponent(activeShow.id)}`, { signal });
        if (!response.ok) throw new Error(`Podcast feed returned ${response.status}`);
        const xml = await response.text();
        const nextEpisodes = parsePodcastFeed(xml, activeShow);
        if (signal?.aborted || requestId !== loadRequestIdRef.current) return;
        setEpisodes(nextEpisodes);
        setLoadedAt(new Date().toISOString());
        setStatus("ready");
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        if (signal?.aborted || requestId !== loadRequestIdRef.current) return;
        setError(caught instanceof Error ? caught.message : "Could not load podcast feed");
        setStatus("error");
      }
    },
    [selectedShow],
  );

  useEffect(() => {
    if (!selectedShow) {
      loadRequestIdRef.current += 1;
      setEpisodes([]);
      setLoadedAt(null);
      setError(null);
      setStatus("idle");
      return;
    }

    setEpisodes([]);
    setLoadedAt(null);
    const controller = new AbortController();
    void loadFeed(controller.signal);
    return () => controller.abort();
  }, [loadFeed, selectedShow]);

  const loadedLabel = useMemo(() => {
    if (!loadedAt) return null;
    const date = new Date(loadedAt);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  }, [loadedAt]);

  function playEpisode(index: number) {
    const episode = episodes[index];
    if (!episode) return;

    if (currentPodcastEpisodeId === episode.id) {
      if (!isPlaying) requestImmediatePlayback(episode);
      toggle();
      return;
    }

    requestImmediatePlayback(episode);
    setQueue(episodes, index);
  }

  function selectShow(showId: string) {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.set("show", showId);
    setSearchParams(nextSearchParams);
  }

  return (
    <PageLayout>
      <PageHeader title="Podcasts" description={`${PODCAST_SHOWS.length} shows`} />
      <div className="grid min-w-0 grid-cols-1 gap-x-6 md:grid-cols-2">
        {PODCAST_SHOWS.map((podcastShow, index) => {
          const selected = podcastShow.id === selectedShowId;
          return (
            <button
              key={podcastShow.id}
              type="button"
              onClick={() => selectShow(podcastShow.id)}
              aria-expanded={selected}
              aria-controls={selected ? "podcast-episodes" : undefined}
              aria-label={`Show episodes for ${podcastShow.title}`}
              className={cn(
                "flex w-full min-w-0 items-center gap-4 rounded-md border-b border-white/[0.08] p-3 text-left transition-colors hover:bg-white/[0.035] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
                selected && "bg-white/[0.05]",
              )}
            >
              <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-white/[0.05]">
                <CoverImage
                  src={podcastMediaProxyUrl(podcastShow.id, podcastShow.imageUrl)}
                  alt={podcastShow.title}
                  fill
                  loading={index === 0 ? "eager" : "lazy"}
                  className="object-cover"
                  sizes="64px"
                />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-[15px] font-semibold leading-6">{podcastShow.title}</h2>
                <p className="wf-muted truncate text-sm">{podcastShow.author}</p>
                <p className="wf-muted mt-1 line-clamp-2 text-xs leading-5">{podcastShow.description}</p>
              </div>
            </button>
          );
        })}
      </div>

      {selectedShow ? (
        <section id="podcast-episodes" className="mt-8">
          <SectionHeader
            title={selectedShow.title}
            description={<span className="whitespace-normal break-words">{selectedShow.description}</span>}
            actions={(
              <>
                <a href={selectedShow.websiteUrl} target="_blank" rel="noopener noreferrer" className="wf-button">
                  <ExternalLink size={15} /> Website
                </a>
                <button
                  type="button"
                  onClick={() => void loadFeed()}
                  disabled={status === "loading"}
                  aria-label="Refresh podcasts"
                  title="Refresh podcasts"
                  className="wf-icon-button disabled:cursor-wait disabled:opacity-60"
                >
                  <RefreshCw size={18} className={cn(status === "loading" && "animate-spin")} />
                </button>
              </>
            )}
          />
          <div className="wf-muted mb-4 mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            {status === "ready" ? <span>{episodes.length} latest episodes</span> : null}
            {loadedLabel ? <span>Updated {loadedLabel}</span> : null}
          </div>

          {status === "loading" && episodes.length === 0 ? (
            <EpisodeSkeletonRows />
          ) : status === "error" && episodes.length === 0 ? (
            <div className="wf-empty-state" role="alert">{error ?? "Could not load podcast feed."}</div>
          ) : (
            <div className="divide-y divide-white/[0.08] border-t border-white/[0.08]">
              {episodes.map((episode, index) => {
                const active = currentPodcastEpisodeId === episode.id;
                const playing = active && isPlaying;
                const progress = progressByEpisodeId[episode.id];
                const finished = progress ? isEpisodeFinished(progress) : false;
                const inProgress = !finished && progress != null && progress.duration > 0 && progress.time > 0;
                return (
                  <article
                    key={episode.id}
                    className={cn(
                      "flex min-h-[92px] min-w-0 items-center gap-3 px-2 py-4 transition-colors hover:bg-white/[0.03] sm:gap-4",
                      active && "bg-white/[0.04]",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => playEpisode(index)}
                      aria-label={`${playing ? "Pause" : "Play"} ${episode.title}`}
                      aria-pressed={playing}
                      className="wf-icon-button shrink-0"
                    >
                      {playing ? <Pause size={18} /> : <Play size={18} />}
                    </button>
                    <CoverImage
                      src={episode.imageUrl}
                      alt={episode.podcastTitle}
                      width={56}
                      height={56}
                      loading={index < 4 ? "eager" : "lazy"}
                      className="hidden h-14 w-14 shrink-0 rounded-md object-cover sm:block"
                      sizes="56px"
                    />
                    <button
                      type="button"
                      onClick={() => playEpisode(index)}
                      className="min-w-0 flex-1 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                    >
                      <h3 className="line-clamp-2 text-[15px] font-medium leading-5">{episode.title}</h3>
                      <p className="wf-muted mt-1 line-clamp-2 text-[13px] leading-5">{episodeDescription(episode.description)}</p>
                      <div className="wf-muted mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                        <span className="inline-flex items-center gap-1">
                          <CalendarDays size={13} /> {formatEpisodeDate(episode.publishedAt)}
                        </span>
                        {episode.duration ? (
                          <span className="inline-flex items-center gap-1"><Clock3 size={13} /> {formatTime(episode.duration)}</span>
                        ) : null}
                        {finished ? (
                          <span className="inline-flex items-center gap-1"><CheckCircle2 size={13} /> Played</span>
                        ) : inProgress && progress ? (
                          <span className="inline-flex items-center gap-2">
                            <span className="h-1 w-16 overflow-hidden rounded-full bg-white/[0.12]">
                              <span
                                className="block h-full rounded-full bg-white/80"
                                style={{ width: `${Math.min(100, Math.max(0, (progress.time / progress.duration) * 100))}%` }}
                              />
                            </span>
                            {remainingLabel(progress)}
                          </span>
                        ) : null}
                      </div>
                    </button>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      ) : null}
    </PageLayout>
  );
}
