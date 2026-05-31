"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { LayoutGrid, Loader2, Rows3, X } from "lucide-react";
import { usePlayerStore } from "@/store/player";
import { useLikesStore } from "@/store/likes";
import type { PlayerSong } from "@/types/player";
import { cn } from "@/lib/utils";
import { SongCard } from "@/components/SongCard";
import { SongListItem } from "@/components/SongListItem";
import { EDIT_MODE_EVENT, EDIT_MODE_KEY } from "@/lib/edit-mode";
import { queueOfflineMutation } from "@/client/offline";
import {
  isBrowserLocalSong,
  saveBrowserLocalSongEdits,
  useBrowserLocalLibraryStore,
} from "@/store/browser-local-library";

type SongGridProps = {
  songs: PlayerSong[];
  likedSongIds?: string[];
  hideIfUnliked?: boolean;
  canLike?: boolean;
  showLikeControls?: boolean;
  emptyLabel?: string;
  viewToggleClassName?: string;
};

type SongSortMode = "default" | "uploaded_desc" | "uploaded_asc";
const VIRTUAL_ROW_HEIGHT = 72;
const VIRTUAL_OVERSCAN_ROWS = 8;
const VIRTUALIZATION_MIN_ITEMS = 80;

function haveSameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const counts = new Map<string, number>();
  for (const id of left) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const id of right) {
    const current = counts.get(id);
    if (!current) return false;
    if (current === 1) counts.delete(id);
    else counts.set(id, current - 1);
  }
  return counts.size === 0;
}

function normalizeSongPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function SongGrid({
  songs,
  likedSongIds = [],
  hideIfUnliked = false,
  canLike = false,
  showLikeControls = true,
  emptyLabel,
  viewToggleClassName,
}: SongGridProps) {
  const [localSongs, setLocalSongs] = useState<PlayerSong[]>(songs);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [sortMode, setSortMode] = useState<SongSortMode>("default");
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editingSong, setEditingSong] = useState<PlayerSong | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editArtist, setEditArtist] = useState("");
  const [editCoverFile, setEditCoverFile] = useState<File | null>(null);
  const [editLyricsFile, setEditLyricsFile] = useState<File | null>(null);
  const [editLyricsText, setEditLyricsText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [virtualRange, setVirtualRange] = useState({ start: 0, end: 0 });
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const setQueue = usePlayerStore((state) => state.setQueue);
  const mergeInitial = useLikesStore((state) => state.mergeInitial);
  const toggleLike = useLikesStore((state) => state.toggleLike);
  const likedLookup = useLikesStore((state) => state.likedSongIds);
  const pendingLookup = useLikesStore((state) => state.pending);
  const hydrated = useLikesStore((state) => state.hydrated);
  const replaceBrowserLocalSong = useBrowserLocalLibraryStore((state) => state.replaceSong);

  useEffect(() => {
    setLocalSongs(songs);
  }, [songs]);

  useEffect(() => {
    const readEditMode = () => {
      try {
        return localStorage.getItem(EDIT_MODE_KEY) === "1";
      } catch {
        return false;
      }
    };

    try {
      const stored = localStorage.getItem("spotify_song_view_mode");
      if (stored === "list" || stored === "grid") {
        setViewMode(stored);
      }
      const storedSort = localStorage.getItem("spotify_song_sort_mode");
      if (
        storedSort === "default" ||
        storedSort === "uploaded_desc" ||
        storedSort === "uploaded_asc"
      ) {
        setSortMode(storedSort);
      }
    } catch {}
    setEditMode(readEditMode());

    const handleStorage = (event: StorageEvent) => {
      if (!event.key || event.key === EDIT_MODE_KEY) {
        setEditMode(readEditMode());
      }
    };
    const handleEditModeChange = () => {
      setEditMode(readEditMode());
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(EDIT_MODE_EVENT, handleEditModeChange);
    setPreferencesReady(true);

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(EDIT_MODE_EVENT, handleEditModeChange);
    };
  }, []);

  const setNextViewMode = useCallback((nextMode: "grid" | "list") => {
    setViewMode(nextMode);
    try {
      localStorage.setItem("spotify_song_view_mode", nextMode);
    } catch {}
  }, []);

  const setNextSortMode = useCallback((nextMode: SongSortMode) => {
    setSortMode(nextMode);
    try {
      localStorage.setItem("spotify_song_sort_mode", nextMode);
    } catch {}
  }, []);

  // Only hydrate likes once on mount, not on every prop change
  const likedSongIdsRef = useRef<string[]>([]);
  useEffect(() => {
    if (!haveSameIds(likedSongIdsRef.current, likedSongIds)) {
      likedSongIdsRef.current = likedSongIds.slice();
      mergeInitial(likedSongIds);
    }
  }, [mergeInitial, likedSongIds]);

  const initialLookup = useMemo(() => {
    const map: Record<string, true> = {};
    for (const id of likedSongIds) {
      if (typeof id === "string" && id.length > 0) {
        map[id] = true;
      }
    }
    return map;
  }, [likedSongIds]);

  const likedMap = hydrated ? likedLookup : initialLookup;

  // Sort + dedup is expensive for large libraries but doesn't depend on
  // likedMap. Keeping it in its own memo prevents every like toggle from
  // re-running it on pages where `hideIfUnliked` is false.
  const sortedDedupedSongs = useMemo(() => {
    const sorted = sortMode === "default" ? localSongs : [...localSongs];
    if (sortMode !== "default") {
      sorted.sort((left, right) => {
        const leftTime = Date.parse(left.createdAt || "");
        const rightTime = Date.parse(right.createdAt || "");
        const a = Number.isFinite(leftTime) ? leftTime : 0;
        const b = Number.isFinite(rightTime) ? rightTime : 0;
        return sortMode === "uploaded_desc" ? b - a : a - b;
      });
    }

    const seen = new Set<string>();
    const deduped: PlayerSong[] = [];
    for (const song of sorted) {
      const key = `${normalizeSongPart(song.title)}::${normalizeSongPart(song.artist)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(song);
    }
    return deduped;
  }, [localSongs, sortMode]);

  const visibleSongs = useMemo(() => {
    if (!hideIfUnliked) return sortedDedupedSongs;
    return sortedDedupedSongs.filter((song) => !!likedMap[song.id]);
  }, [hideIfUnliked, likedMap, sortedDedupedSongs]);

  const visibleSongsRef = useRef<PlayerSong[]>([]);
  useEffect(() => {
    visibleSongsRef.current = visibleSongs;
  }, [visibleSongs]);

  const listContainerRef = useRef<HTMLDivElement | null>(null);
  const playlistId = useMemo(() => {
    const match = pathname.match(/^\/playlist\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  }, [pathname]);
  const canReorder = editMode && sortMode === "default" && viewMode === "list";
  const enableVirtualList =
    viewMode === "list" &&
    visibleSongs.length >= VIRTUALIZATION_MIN_ITEMS &&
    !canReorder;

  useEffect(() => {
    if (!enableVirtualList) {
      setVirtualRange({ start: 0, end: visibleSongs.length });
      return;
    }

    let frameId = 0;
    const updateRange = () => {
      frameId = 0;
      const el = listContainerRef.current;
      if (!el) {
        setVirtualRange({ start: 0, end: Math.min(visibleSongs.length, 40) });
        return;
      }

      const rect = el.getBoundingClientRect();
      const scrollContainer = el.closest(".wf-main") as HTMLElement | null;
      const scrollRect = scrollContainer?.getBoundingClientRect();
      const viewportTop = scrollRect?.top ?? 0;
      const viewportBottom = scrollRect?.bottom ?? window.innerHeight;
      const localViewportTop = Math.max(0, viewportTop - rect.top);
      const localViewportBottom = Math.max(0, viewportBottom - rect.top);

      const nextStart = Math.max(
        0,
        Math.floor(localViewportTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN_ROWS,
      );
      const nextEnd = Math.min(
        visibleSongs.length,
        Math.ceil(localViewportBottom / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN_ROWS,
      );

      setVirtualRange((current) =>
        current.start === nextStart && current.end === nextEnd
          ? current
          : { start: nextStart, end: Math.max(nextStart, nextEnd) },
      );
    };

    const scheduleRangeUpdate = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(updateRange);
    };

    const scrollContainer = listContainerRef.current?.closest(".wf-main") as HTMLElement | null;
    updateRange();
    scrollContainer?.addEventListener("scroll", scheduleRangeUpdate, { passive: true });
    window.addEventListener("scroll", scheduleRangeUpdate, { passive: true });
    window.addEventListener("resize", scheduleRangeUpdate);

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      scrollContainer?.removeEventListener("scroll", scheduleRangeUpdate);
      window.removeEventListener("scroll", scheduleRangeUpdate);
      window.removeEventListener("resize", scheduleRangeUpdate);
    };
  }, [enableVirtualList, visibleSongs.length]);

  const onPlayAt = useCallback((index: number) => {
    setQueue(visibleSongsRef.current, index);
  }, [setQueue]);

  const reorderVisibleSongs = useCallback(async (fromIndex: number, toIndex: number) => {
    if (!canReorder) return;
    if (fromIndex === toIndex) return;
    if (
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= visibleSongsRef.current.length ||
      toIndex >= visibleSongsRef.current.length
    ) {
      return;
    }

    setReorderError(null);
    const nextVisible = [...visibleSongsRef.current];
    const [moved] = nextVisible.splice(fromIndex, 1);
    nextVisible.splice(toIndex, 0, moved);

    const movedIds = new Set(nextVisible.map((song) => song.id));
    setLocalSongs((current) => {
      const remaining = current.filter((song) => !movedIds.has(song.id));
      return [...nextVisible, ...remaining];
    });

    if (playlistId) {
      try {
        const res = await fetch(`/api/playlist/${encodeURIComponent(playlistId)}/reorder`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ songIds: nextVisible.map((song) => song.id) }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error ?? "Failed to save playlist order");
        }
      } catch (error) {
        await queueOfflineMutation({
          type: "playlist-reorder",
          payload: { playlistId, songIds: nextVisible.map((song) => song.id) },
        }).catch(() => undefined);
        setReorderError(error instanceof Error ? error.message : "Failed to save playlist order");
      }
    }
  }, [canReorder, playlistId]);

  const onDragStartRow = useCallback((index: number) => {
    setDraggingIndex(index);
    setDragOverIndex(index);
  }, []);

  const onDragEnterRow = useCallback((index: number) => {
    setDragOverIndex(index);
  }, []);

  const onDragEndRow = useCallback(() => {
    setDraggingIndex(null);
    setDragOverIndex(null);
  }, []);

  const onDropRow = useCallback(async (index: number) => {
    if (draggingIndex == null) return;
    await reorderVisibleSongs(draggingIndex, index);
    setDraggingIndex(null);
    setDragOverIndex(null);
  }, [draggingIndex, reorderVisibleSongs]);

  const handleToggleLike = useCallback(async (songId: string, nextLiked: boolean) => {
    if (!canLike) {
      navigate("/signin");
      return;
    }
    const result = await toggleLike(
      songId,
      nextLiked,
      visibleSongsRef.current.find((song) => song.id === songId),
    );
    if (!result.ok && result.status === 401) {
      navigate("/signin");
    }
  }, [canLike, navigate, toggleLike]);

  const openEditModal = useCallback((song: PlayerSong) => {
    setEditingSong(song);
    setEditTitle(song.title);
    setEditArtist(song.artist);
    setEditCoverFile(null);
    setEditLyricsFile(null);
    setEditLyricsText("");
    setEditError(null);
  }, []);

  const closeEditModal = useCallback(() => {
    if (savingEdit) return;
    setEditingSong(null);
    setEditError(null);
  }, [savingEdit]);

  const handleSaveEdit = useCallback(async () => {
    if (!editingSong) return;
    const nextTitle = editTitle.trim();
    const nextArtist = editArtist.trim();
    if (!nextTitle || !nextArtist) {
      setEditError("Title and artist are required");
      return;
    }
    setSavingEdit(true);
    setEditError(null);

    try {
      let updatedSong: PlayerSong;
      if (isBrowserLocalSong(editingSong)) {
        updatedSong = await saveBrowserLocalSongEdits(editingSong, {
          title: nextTitle,
          artist: nextArtist,
          coverFile: editCoverFile,
          lyricsFile: editLyricsFile,
          lyricsText: editLyricsText,
        });
        replaceBrowserLocalSong(updatedSong);
      } else {
        try {
          const metaRes = await fetch(`/api/songs/${encodeURIComponent(editingSong.id)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: nextTitle, artist: nextArtist }),
          });
          const metaData = await metaRes.json().catch(() => ({}));
          if (!metaRes.ok) {
            throw new Error(metaData?.error ?? "Failed to update song");
          }

          updatedSong = metaData as PlayerSong;

          if (editCoverFile || editLyricsFile || editLyricsText.trim()) {
            const form = new FormData();
            if (editCoverFile) form.append("image", editCoverFile);
            if (editLyricsFile) form.append("lyricsFile", editLyricsFile);
            if (editLyricsText.trim()) form.append("lyricsText", editLyricsText.trim());
            const assetsRes = await fetch(
              `/api/songs/${encodeURIComponent(editingSong.id)}/assets`,
              {
                method: "POST",
                body: form,
              },
            );
            const assetsData = await assetsRes.json().catch(() => ({}));
            if (!assetsRes.ok) {
              throw new Error(assetsData?.error ?? "Failed to update cover/lyrics");
            }
            updatedSong = assetsData as PlayerSong;
          }
        } catch {
          await queueOfflineMutation({
            type: "song-edit",
            payload: {
              songId: editingSong.id,
              title: nextTitle,
              artist: nextArtist,
              coverFile: editCoverFile ?? undefined,
              lyricsFile: editLyricsFile ?? undefined,
              lyricsText: editLyricsText.trim() || undefined,
            },
          });
          updatedSong = {
            ...editingSong,
            title: nextTitle,
            artist: nextArtist,
          };
        }
      }

      setLocalSongs((current) =>
        current.map((song) =>
          song.id === editingSong.id
            ? {
                ...song,
                ...updatedSong,
                title: updatedSong.title || nextTitle,
                artist: updatedSong.artist || nextArtist,
              }
            : song,
        ),
      );
      setEditingSong(null);
    } catch (error) {
      setEditError(error instanceof Error ? error.message : "Failed to save changes");
    } finally {
      setSavingEdit(false);
    }
  }, [editArtist, editCoverFile, editLyricsFile, editLyricsText, editTitle, editingSong, replaceBrowserLocalSong]);

  const editingSongQualityLabel =
    editingSong && editingSong.audioBitDepth && editingSong.audioSampleRate
      ? `${editingSong.audioBitDepth}-bit/${Math.round(editingSong.audioSampleRate / 100) / 10}kHz`
      : "Unknown quality";

  if (visibleSongs.length === 0) {
    if (hideIfUnliked && emptyLabel) {
      return <div className="opacity-70">{emptyLabel}</div>;
    }
    return null;
  }

  return (
    <div className={cn(!preferencesReady && "opacity-0")}>
      <div className={cn("mb-3 flex w-full items-center gap-2", viewToggleClassName)}>
        {canReorder ? (
          <div className="hidden shrink-0 text-xs opacity-70 sm:block">
            Drag songs to reorder
          </div>
        ) : null}
        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none">
          <select
            value={sortMode}
            onChange={(event) => setNextSortMode(event.target.value as SongSortMode)}
            className="h-10 min-w-0 flex-1 rounded-lg border border-black/10 bg-black/5 px-3 text-sm dark:border-white/10 dark:bg-white/5 sm:w-64 sm:flex-none"
            aria-label="Sort songs"
            title="Sort songs"
          >
            <option value="default">Sort: Default</option>
            <option value="uploaded_desc">Sort: Upload date (newest)</option>
            <option value="uploaded_asc">Sort: Upload date (oldest)</option>
          </select>
          <div className="inline-flex h-10 shrink-0 items-center rounded-lg border border-black/10 bg-black/5 p-1 dark:border-white/10 dark:bg-white/5">
            <button
              type="button"
              onClick={() => setNextViewMode("grid")}
              className={cn(
                "inline-flex h-8 w-9 items-center justify-center gap-2 rounded-md text-sm transition sm:w-auto sm:px-3",
                viewMode === "grid" && "bg-black/10 font-medium dark:bg-white/10",
              )}
              aria-pressed={viewMode === "grid"}
              title="Grid view"
            >
              <LayoutGrid size={16} />
              <span className="hidden sm:inline">Grid</span>
            </button>
            <button
              type="button"
              onClick={() => setNextViewMode("list")}
              className={cn(
                "inline-flex h-8 w-9 items-center justify-center gap-2 rounded-md text-sm transition sm:w-auto sm:px-3",
                viewMode === "list" && "bg-black/10 font-medium dark:bg-white/10",
              )}
              aria-pressed={viewMode === "list"}
              title="List view"
            >
              <Rows3 size={16} />
              <span className="hidden sm:inline">List</span>
            </button>
          </div>
        </div>
      </div>

      {viewMode === "grid" ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {visibleSongs.map((song, index) => (
            <SongCard
              key={song.id}
              song={song}
              songIndex={index}
              onPlayAt={onPlayAt}
              liked={!!likedMap[song.id]}
              likePending={!!pendingLookup[song.id]}
              canLike={canLike}
              showLike={showLikeControls}
              onToggleLike={handleToggleLike}
              hideIfUnliked={hideIfUnliked}
              editMode={editMode}
              onEdit={openEditModal}
              priority={index < 6}
            />
          ))}
        </div>
      ) : (
        <div ref={listContainerRef}>
          {enableVirtualList ? (
            <div
              className="relative"
              style={{ height: `${visibleSongs.length * VIRTUAL_ROW_HEIGHT}px` }}
            >
              {visibleSongs.slice(virtualRange.start, virtualRange.end).map((song, offset) => {
                const index = virtualRange.start + offset;
                return (
                  <div
                    key={song.id}
                    className="absolute left-0 right-0 pb-2"
                    style={{ top: `${index * VIRTUAL_ROW_HEIGHT}px` }}
                  >
                    <SongListItem
                      song={song}
                      songIndex={index}
                      onPlayAt={onPlayAt}
                      liked={!!likedMap[song.id]}
                      likePending={!!pendingLookup[song.id]}
                      canLike={canLike}
                      showLike={showLikeControls}
                      onToggleLike={handleToggleLike}
                      editMode={editMode}
                      canReorder={false}
                      onEdit={openEditModal}
                      priority={index < 6}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="space-y-2">
              {visibleSongs.map((song, index) => (
                <div
                  key={song.id}
                  draggable={canReorder}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    onDragStartRow(index);
                  }}
                  onDragEnter={() => onDragEnterRow(index)}
                  onDragOver={(event) => {
                    if (canReorder) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    void onDropRow(index);
                  }}
                  onDragEnd={onDragEndRow}
                  className={cn(
                    canReorder && "cursor-grab active:cursor-grabbing",
                    draggingIndex === index && "opacity-60",
                    canReorder &&
                      dragOverIndex === index &&
                      draggingIndex !== index &&
                      "rounded-lg ring-2 ring-emerald-500/50",
                  )}
                >
                  <SongListItem
                    song={song}
                    songIndex={index}
                    onPlayAt={onPlayAt}
                    liked={!!likedMap[song.id]}
                    likePending={!!pendingLookup[song.id]}
                    canLike={canLike}
                    showLike={showLikeControls}
                    onToggleLike={handleToggleLike}
                    editMode={editMode}
                    canReorder={canReorder}
                    onEdit={openEditModal}
                    priority={index < 6}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {reorderError ? (
        <div className="mt-3 rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {reorderError}
        </div>
      ) : null}

      {editingSong && (
        <div className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-sm p-4 grid place-items-center">
          <div className="w-full max-w-2xl rounded-3xl border border-white/15 bg-zinc-950/95 shadow-[0_20px_80px_rgba(0,0,0,0.65)] p-6 md:p-7 space-y-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-2xl font-semibold tracking-tight">Edit song</h3>
                <p className="mt-1 text-sm text-white/65">
                  Update metadata, cover art, and lyrics.
                </p>
              </div>
              <button
                type="button"
                onClick={closeEditModal}
                className="h-9 w-9 rounded-full grid place-items-center border border-white/15 hover:bg-white/10 transition"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            <div className="inline-flex items-center rounded-full border border-emerald-400/25 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
              Quality: {editingSongQualityLabel}
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-sm text-white/80">Title</label>
                <input
                  value={editTitle}
                  onChange={(event) => setEditTitle(event.target.value)}
                  className="h-11 w-full rounded-xl border border-white/20 bg-white/[0.03] px-3.5 text-base outline-none transition focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-500/20"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm text-white/80">Artist</label>
                <input
                  value={editArtist}
                  onChange={(event) => setEditArtist(event.target.value)}
                  className="h-11 w-full rounded-xl border border-white/20 bg-white/[0.03] px-3.5 text-base outline-none transition focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-500/20"
                />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-dashed border-white/20 bg-white/[0.02] p-4">
                <label className="mb-2 block text-sm font-medium text-white/85">Cover image</label>
                <p className="mb-3 text-xs text-white/55">JPG, PNG, WEBP</p>
                <input
                  id="edit-cover-input"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => setEditCoverFile(event.target.files?.[0] ?? null)}
                />
                <label
                  htmlFor="edit-cover-input"
                  className="inline-flex h-9 cursor-pointer items-center rounded-lg border border-white/20 px-3 text-sm hover:bg-white/10 transition"
                >
                  Choose cover
                </label>
                <p className="mt-2 truncate text-xs text-white/65">
                  {editCoverFile ? editCoverFile.name : "No file selected"}
                </p>
              </div>
              <div className="rounded-2xl border border-dashed border-white/20 bg-white/[0.02] p-4">
                <label className="mb-2 block text-sm font-medium text-white/85">Lyrics file</label>
                <p className="mb-3 text-xs text-white/55">TXT, LRC</p>
                <input
                  id="edit-lyrics-input"
                  type="file"
                  accept=".txt,.lrc,text/plain"
                  className="hidden"
                  onChange={(event) => setEditLyricsFile(event.target.files?.[0] ?? null)}
                />
                <label
                  htmlFor="edit-lyrics-input"
                  className="inline-flex h-9 cursor-pointer items-center rounded-lg border border-white/20 px-3 text-sm hover:bg-white/10 transition"
                >
                  Choose lyrics
                </label>
                <p className="mt-2 truncate text-xs text-white/65">
                  {editLyricsFile ? editLyricsFile.name : "No file selected"}
                </p>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-sm text-white/80">Lyrics text</label>
              <textarea
                value={editLyricsText}
                onChange={(event) => setEditLyricsText(event.target.value)}
                className="min-h-32 w-full rounded-xl border border-white/20 bg-white/[0.03] px-3.5 py-2.5 text-sm outline-none transition focus:border-emerald-400/60 focus:ring-2 focus:ring-emerald-500/20"
                placeholder="Paste lyrics to replace/add"
              />
            </div>

            {editError ? (
              <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {editError}
              </div>
            ) : null}

            <div className="flex justify-end gap-2.5 pt-1">
              <button
                type="button"
                onClick={closeEditModal}
                className="h-11 px-5 rounded-xl border border-white/25 hover:bg-white/10 transition"
                disabled={savingEdit}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveEdit}
                className="h-11 px-5 rounded-xl bg-yellow-500 hover:bg-yellow-400 text-black font-semibold inline-flex items-center gap-2 transition disabled:opacity-50"
                disabled={savingEdit}
              >
                {savingEdit ? <Loader2 size={16} className="animate-spin" /> : null}
                Save changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
