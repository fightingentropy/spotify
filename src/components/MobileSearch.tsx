"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { albumSearchPath, parseAlbumLink, type AlbumSearchPayload } from "@spotify/shared/catalog-albums";
import { AlbumResult } from "@/components/AlbumResult";
import { useRecentSearches } from "@/client/recent-searches";
import { rankLibrarySongs } from "@spotify/shared/library-search";
import { Search } from "lucide-react";
import { PageHeader, PageLayout, SectionHeader } from "@/components/PageLayout";
import { AuthButtons } from "@/components/AuthButtons";
import { useAuth } from "@/client/auth";
import { useApiData, withAccountScope, type SearchCatalogPayload, type SearchIndexPayload } from "@/client/api";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";
import { CoverImage } from "@/components/CoverImage";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { dedupeSongsByTitleArtist } from "@/lib/song-dedupe";

export default function MobileSearch() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") ?? "";
  const setQuery = (value: string) => setSearchParams((params) => { params.set("q", value); return params; }, { replace: true });
  const filter = parseAlbumLink(query) ? "albums" : searchParams.get("type") ?? "top";
  const showSongs = filter !== "albums";
  const showAlbums = filter !== "songs";
  const [catalogQuery, setCatalogQuery] = useState("");
  const [libraryQuery, setLibraryQuery] = useState("");
  const { user, status } = useAuth();
  const { recentSearches, remember, clear } = useRecentSearches(user?.id ?? status);
  const setQueue = usePlayerStore((state) => state.setQueue);

  useEffect(() => {
    const trimmed = query.trim();
    const timer = window.setTimeout(() => {
      setLibraryQuery(trimmed);
      setCatalogQuery(trimmed.length >= 2 ? trimmed : "");
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const libraryState = useApiData<SearchIndexPayload>(
    withAccountScope(
      `/api/search-index?q=${encodeURIComponent(libraryQuery)}&limit=50`,
      user?.id ?? status,
    ),
    { songs: [] },
    { enabled: showSongs && status !== "loading" && libraryQuery.length > 0, keepPreviousData: true },
  );

  const catalogState = useApiData<SearchCatalogPayload>(
    withAccountScope(`/api/search/catalog?q=${encodeURIComponent(catalogQuery)}`, user?.id ?? status),
    { results: [] },
    { enabled: showSongs && status === "authenticated" && catalogQuery.length >= 2, keepPreviousData: false },
  );
  const albumState = useApiData<AlbumSearchPayload>(
    withAccountScope(albumSearchPath(catalogQuery), user?.id ?? status), { query: "", albums: [] },
    { enabled: showAlbums && status === "authenticated" && catalogQuery.length >= 2, keepPreviousData: false },
  );
  const albumsCurrent = albumState.data.query === query.trim() && catalogQuery === query.trim();
  const albums = showAlbums && albumsCurrent ? albumState.data.albums : [];
  const albumsLoading = showAlbums && query.trim().length >= 2 && (catalogQuery !== query.trim() || albumState.loading);
  const albumsUnavailable = showAlbums && albumsCurrent && Object.values(albumState.data.providers ?? {}).includes("unavailable");

  const dedupedSongs = useMemo(
    () => dedupeSongsByTitleArtist(rankLibrarySongs(libraryState.data.songs, query)),
    [libraryState.data.songs, query],
  );

  const results = useMemo(() => dedupedSongs.slice(0, 50), [dedupedSongs]);

  const libraryKeys = useMemo(
    () => new Set(dedupedSongs.map((song) => `${song.title.trim().toLowerCase()}\u0000${song.artist.trim().toLowerCase()}`)),
    [dedupedSongs],
  );
  const catalogResults = useMemo(
    () => (catalogQuery === query.trim() && catalogState.data.query === catalogQuery ? catalogState.data.results : []).filter(
      (song) => !libraryKeys.has(`${song.title.trim().toLowerCase()}\u0000${song.artist.trim().toLowerCase()}`),
    ),
    [catalogState.data, catalogQuery, query, libraryKeys],
  );

  const playQueueSong = (queue: PlayerSong[], index: number) => {
    remember(query);
    const song = setQueue(queue, index);
    if (song?.audioUrl) requestImmediatePlayback(song);
  };

  const renderSong = (song: PlayerSong, queue: PlayerSong[], index: number) => (
    <button
      key={song.id}
      type="button"
      onClick={() => playQueueSong(queue, index)}
      className="wf-list-row wf-pressable flex min-h-[64px] w-full items-center gap-3 rounded-md px-2 text-left touch-manipulation hover:bg-white/[0.045] active:bg-white/[0.06]"
    >
      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded">
        <CoverImage src={song.imageUrl} alt={song.title} sizes="48px" className="wf-song-cover h-full w-full object-cover" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-[#f2f2f2]">{song.title}</div>
        <div className="truncate text-xs text-white/60">{song.artist}</div>
      </div>
    </button>
  );

  return (
    <PageLayout>
      <PageHeader title="Search" actions={<div className="lg:hidden"><AuthButtons compact /></div>} />

      <div className="relative mb-5 max-w-2xl">
        <Search
          size={18}
          strokeWidth={2.2}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/50"
        />
        <input
          type="search"
          aria-label="Search music"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") remember(query); }}
          placeholder="Songs, albums, artists or an album link"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="wf-input pl-10"
        />
      </div>

      <div className="wf-tabs mb-6" aria-label="Search filters">
        {(["top", "songs", "albums"] as const).map((value) => <button type="button" key={value}
          aria-pressed={filter === value} onClick={() => setSearchParams((params) => { params.set("type", value); return params; }, { replace: true })}
          className="wf-tab">
          {value === "top" ? "Top" : value === "songs" ? "Songs" : "Albums"}
        </button>)}
      </div>

      <div className="space-y-7">
        {query.trim().length === 0 ? (
          <div className="py-4 text-sm text-white/60">
            {recentSearches.length ? <>
              <SectionHeader title="Recent searches" actions={<button type="button" onClick={clear} className="wf-button">Clear</button>} />
              {recentSearches.map((term) => <button type="button" key={term} onClick={() => setQuery(term)} className="block min-h-10 w-full rounded-md px-2 text-left text-sm text-white hover:bg-white/[0.04]">{term}</button>)}
            </> : <p className="wf-empty-state">Start typing to search music</p>}
          </div>
        ) : (
          <>
            {showSongs && libraryState.loading && results.length === 0 ? (
              <div className="py-5 text-sm opacity-70">Searching your library...</div>
            ) : null}
            {showSongs && libraryState.error ? (
              <div className="py-5 text-sm text-red-300">
                <p>{libraryState.error}</p>
                <button type="button" onClick={libraryState.retry} className="wf-button mt-3">Try again</button>
              </div>
            ) : null}
            {showSongs && results.length > 0 ? (
              <section>
                <SectionHeader title="In your library" />
                {results.map((song) => renderSong(song, results, results.indexOf(song)))}
              </section>
            ) : null}

            {showAlbums && query.trim().length >= 2 ? <section className="pb-5">
              <SectionHeader title="Albums" />
              {albumsLoading ? <p className="py-5 text-sm text-white/60" role="status">Searching albums…</p> : null}
              <div className="grid gap-x-6 sm:grid-cols-2">{(filter === "top" ? albums.slice(0, 4) : albums).map((album) => <AlbumResult key={`${album.provider}:${album.id}`} album={album} onSelect={() => remember(query)} />)}</div>
              {filter === "top" && albums.length > 4 ? <button type="button" onClick={() => setSearchParams((params) => { params.set("type", "albums"); return params; }, { replace: true })} className="wf-button mt-3">See all albums</button> : null}
              {albumState.error || albumsUnavailable ? <div className="py-3 text-sm text-white/60"><p>{albumState.error || "Some album results are temporarily unavailable."}</p><button type="button" onClick={albumState.retry} className="wf-button mt-2">Try again</button></div> : null}
              {!albumsLoading && !albumState.error && !albumsUnavailable && albumsCurrent && albums.length === 0 ? <p className="py-5 text-sm text-white/60">No albums found. Try the album name and artist.</p> : null}
            </section> : null}

            {showSongs && catalogQuery.length >= 2 ? (
              <section>
                <SectionHeader title="More on Spotify" />
                {catalogState.loading ? <div className="py-5 text-sm opacity-70">Searching the catalog...</div> : null}
                {catalogState.error ? (
                  <div className="py-5 text-sm text-red-300">
                    <p>{catalogState.error}</p>
                    <button type="button" onClick={catalogState.retry} className="wf-button mt-3">Try again</button>
                  </div>
                ) : null}
                {!catalogState.loading && !catalogState.error
                  ? catalogResults.map((song, index) => renderSong(song, catalogResults, index))
                  : null}
              </section>
            ) : null}

            {showSongs && albums.length === 0 && !albumsLoading && results.length === 0 && !libraryState.loading && !libraryState.error && (catalogQuery.length < 2 || (!catalogState.loading && !catalogState.error && catalogResults.length === 0)) ? (
              <div className="wf-empty-state">No songs found</div>
            ) : null}
          </>
        )}
      </div>
    </PageLayout>
  );
}
