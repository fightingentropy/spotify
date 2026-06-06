"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  Clock3,
  ExternalLink,
  Pause,
  Play,
  Podcast,
  RefreshCw,
} from "lucide-react";
import { CoverImage } from "@/components/CoverImage";
import {
  PODCAST_SHOWS,
  parsePodcastFeed,
  type PodcastEpisode,
} from "@/lib/podcasts";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { cn, formatTime } from "@/lib/utils";
import { usePlayerStore } from "@/store/player";

type FeedStatus = "loading" | "ready" | "error";

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

function EpisodeSkeletonRows() {
  return (
    <div className="space-y-2" aria-hidden>
      {[0, 1, 2, 3].map((item) => (
        <div key={item} className="flex min-h-[88px] items-center gap-4 rounded-xl px-3 py-3">
          <div className="wf-skeleton h-14 w-14 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="wf-skeleton h-4 w-2/3 rounded-full" />
            <div className="wf-skeleton h-3 w-full rounded-full" />
            <div className="wf-skeleton h-3 w-36 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function PodcastsPage() {
  const [selectedShowId, setSelectedShowId] = useState(PODCAST_SHOWS[0]?.id ?? "");
  const show = useMemo(
    () => PODCAST_SHOWS.find((podcastShow) => podcastShow.id === selectedShowId) ?? PODCAST_SHOWS[0],
    [selectedShowId],
  );
  const [episodes, setEpisodes] = useState<PodcastEpisode[]>([]);
  const [status, setStatus] = useState<FeedStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const loadRequestIdRef = useRef(0);

  const setQueue = usePlayerStore((state) => state.setQueue);
  const toggle = usePlayerStore((state) => state.toggle);
  const currentSong = usePlayerStore((state) => state.currentSong);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const currentPodcastEpisodeId = currentSong?.source === "podcast" ? currentSong.id : null;

  const loadFeed = useCallback(
    async (signal?: AbortSignal) => {
      if (!show) return;
      const requestId = ++loadRequestIdRef.current;
      const activeShow = show;
      setStatus("loading");
      setError(null);

      try {
        const response = await fetch(activeShow.feedUrl, { signal });
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
    [show],
  );

  useEffect(() => {
    setEpisodes([]);
    setLoadedAt(null);
    const controller = new AbortController();
    void loadFeed(controller.signal);
    return () => controller.abort();
  }, [loadFeed]);

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

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-fuchsia-500/15 text-fuchsia-200">
              <Podcast size={23} />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold">Podcasts</h1>
              <div className="mt-1 text-sm text-white/[0.62]">
                {PODCAST_SHOWS.length} shows
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void loadFeed()}
            disabled={status === "loading"}
            aria-label="Refresh podcasts"
            title="Refresh podcasts"
            className="wf-control-button grid h-10 w-10 place-items-center rounded-full text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white disabled:cursor-wait disabled:opacity-60"
          >
            <RefreshCw size={18} className={cn(status === "loading" && "animate-spin")} />
          </button>
        </div>

        <div className="mb-6 grid gap-2 sm:grid-cols-2">
          {PODCAST_SHOWS.map((podcastShow) => {
            const selected = podcastShow.id === show.id;
            return (
              <button
                key={podcastShow.id}
                type="button"
                onClick={() => setSelectedShowId(podcastShow.id)}
                aria-pressed={selected}
                className={cn(
                  "wf-list-row wf-pressable flex min-h-[68px] items-center gap-3 rounded-lg border px-3 py-2 text-left transition",
                  selected
                    ? "border-emerald-500/45 bg-white/[0.08]"
                    : "border-white/[0.1] bg-white/[0.03] hover:bg-white/[0.06]",
                )}
              >
                <CoverImage
                  src={podcastShow.imageUrl}
                  alt={podcastShow.title}
                  width={48}
                  height={48}
                  loading="eager"
                  className="h-12 w-12 shrink-0 rounded-md object-cover"
                  sizes="48px"
                />
                <div className="min-w-0">
                  <div className="truncate text-[15px] font-semibold leading-5 text-white">
                    {podcastShow.title}
                  </div>
                  <div className="mt-0.5 truncate text-[13px] leading-5 text-white/[0.62]">
                    {podcastShow.author}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <section className="mb-7 overflow-hidden rounded-lg border border-white/[0.12] bg-white/[0.04]">
          <div className={cn("h-1.5 bg-gradient-to-r", show.accentClassName)} />
          <div className="flex flex-col gap-5 p-4 sm:flex-row sm:p-5">
            <CoverImage
              src={show.imageUrl}
              alt={show.title}
              width={176}
              height={176}
              loading="eager"
              className="aspect-square w-full max-w-44 shrink-0 rounded-md object-cover sm:w-44"
              sizes="176px"
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-fuchsia-200">Featured podcast</div>
              <h2 className="mt-1 text-3xl font-semibold leading-tight text-white sm:text-4xl">
                {show.title}
              </h2>
              <div className="mt-2 text-[15px] leading-6 text-white/[0.7]">{show.author}</div>
              <p className="mt-3 max-w-3xl text-[15px] leading-6 text-white/[0.66]">
                {show.description}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-white/[0.62]">
                <span>{episodes.length} latest episodes</span>
                {loadedLabel ? <span>Updated {loadedLabel}</span> : null}
                <a
                  href={show.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-white/[0.72] transition hover:text-white"
                >
                  <ExternalLink size={14} />
                  Website
                </a>
              </div>
            </div>
          </div>
        </section>

        {status === "loading" && episodes.length === 0 ? (
          <EpisodeSkeletonRows />
        ) : status === "error" && episodes.length === 0 ? (
          <div className="rounded-lg border border-red-400/20 bg-red-500/10 px-4 py-6 text-sm text-red-100">
            {error ?? "Could not load podcast feed."}
          </div>
        ) : (
          <div className="space-y-2">
            {episodes.map((episode, index) => {
              const active = currentPodcastEpisodeId === episode.id;
              const playing = active && isPlaying;
              return (
                <article
                  key={episode.id}
                  className={cn(
                    "wf-list-row flex min-h-[92px] items-center gap-3 rounded-lg px-3 py-3 transition hover:bg-white/[0.07] sm:gap-4",
                    active && "bg-white/[0.08] ring-1 ring-emerald-500/40",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => playEpisode(index)}
                    aria-label={`${playing ? "Pause" : "Play"} ${episode.title}`}
                    aria-pressed={playing}
                    className={cn(
                      "wf-control-button grid h-11 w-11 shrink-0 place-items-center rounded-full transition",
                      playing ? "bg-emerald-500 text-black" : "bg-white text-black hover:scale-105",
                    )}
                  >
                    {playing ? <Pause size={18} /> : <Play size={18} className="translate-x-[1px]" />}
                  </button>

                  <CoverImage
                    src={episode.imageUrl}
                    alt={episode.podcastTitle}
                    width={64}
                    height={64}
                    loading={index < 4 ? "eager" : "lazy"}
                    className="hidden h-16 w-16 shrink-0 rounded-md object-cover sm:block"
                    sizes="64px"
                  />

                  <button
                    type="button"
                    onClick={() => playEpisode(index)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <h3 className="line-clamp-2 text-[15px] font-semibold leading-5 text-white">
                      {episode.title}
                    </h3>
                    <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-white/[0.62]">
                      {episodeDescription(episode.description)}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-white/[0.55]">
                      <span className="inline-flex items-center gap-1">
                        <CalendarDays size={13} />
                        {formatEpisodeDate(episode.publishedAt)}
                      </span>
                      {episode.duration ? (
                        <span className="inline-flex items-center gap-1">
                          <Clock3 size={13} />
                          {formatTime(episode.duration)}
                        </span>
                      ) : null}
                    </div>
                  </button>

                  {episode.link ? (
                    <a
                      href={episode.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Open show notes for ${episode.title}`}
                      title="Open show notes"
                      className="wf-control-button grid h-10 w-10 shrink-0 place-items-center rounded-full text-white/[0.62] transition hover:bg-white/[0.09] hover:text-white"
                    >
                      <ExternalLink size={17} />
                    </a>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
