"use client";

import { useEffect, useMemo, useRef, useState, type TouchEvent } from "react";
import { ChevronDown, GripVertical, X } from "lucide-react";
import { getUpcomingPlaybackIndices, usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { cn } from "@/lib/utils";
import { CoverImage } from "@/components/CoverImage";
import { useModalDialogFocus } from "@/lib/use-modal-dialog";

type QueueSheetProps = {
  open: boolean;
  onClose: () => void;
};

type QueueEntry = {
  song: PlayerSong;
  queueIndex: number;
};

export default function QueueSheet({ open, onClose }: QueueSheetProps) {
  const queue = usePlayerStore((s) => s.queue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const currentSong = usePlayerStore((s) => s.currentSong);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const shuffleRemaining = usePlayerStore((s) => s.shuffleRemaining);
  const playFuture = usePlayerStore((s) => s.playFuture);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);
  const moveQueuedSong = usePlayerStore((s) => s.moveQueuedSong);
  const lastRemoval = usePlayerStore((s) => s.lastQueueRemoval);
  const undoRemoval = usePlayerStore((s) => s.undoQueueRemoval);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const drag = useRef<{ from: number; to: number; songId: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);


  const touchStartYRef = useRef<number | null>(null);
  const swipeDismissAllowedRef = useRef(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  // Queue sheet stacks on top of the now-playing sheet, so it owns the focus
  // trap while open.
  useModalDialogFocus(open, panelRef);

  const upNext = useMemo<QueueEntry[]>(() =>
    getUpcomingPlaybackIndices(queue.length, currentIndex, queue.length, {
      shuffle, repeatMode, shuffleRemaining, playFuture,
    }).map((queueIndex) => ({ song: queue[queueIndex], queueIndex })),
    [queue, currentIndex, shuffle, repeatMode, shuffleRemaining, playFuture],
  );

  const resolveDisplaySong = useMemo(
    () => (song: PlayerSong) => song,
    [],
  );

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return;
    document.body.classList.add("wf-now-playing-open");
    return () => {
      // The now-playing sheet may still be open underneath; keep the body
      // scroll lock until every sheet has closed.
      if (document.querySelector('.wf-now-playing-panel[data-open="true"]')) return;
      document.body.classList.remove("wf-now-playing-open");
    };
  }, [open]);

  function handlePlayAt(queueIndex: number) {
    const state = usePlayerStore.getState();
    const target = state.queue[queueIndex];
    if (!target) return;
    requestImmediatePlayback(target);
    // Tapping the entry the engine would play next (top of the redo stack)
    // should consume just that entry instead of wiping the whole redo stack.
    const fromFuture = state.shuffle && state.playFuture[state.playFuture.length - 1] === queueIndex;
    state.advanceToIndex(queueIndex, fromFuture ? { fromFuture: true } : undefined);
  }

  function handleTouchStart(event: TouchEvent<HTMLElement>) {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
    const atTop = (scrollContainerRef.current?.scrollTop ?? 0) <= 0;
    swipeDismissAllowedRef.current = atTop;
  }

  function handleTouchEnd(event: TouchEvent<HTMLElement>) {
    const startY = touchStartYRef.current;
    const endY = event.changedTouches[0]?.clientY;
    const dismissAllowed = swipeDismissAllowedRef.current;
    touchStartYRef.current = null;
    swipeDismissAllowedRef.current = false;
    if (!dismissAllowed || startY == null || endY == null) return;
    if (endY - startY > 80) {
      onClose();
    }
  }

  function renderRow(entry: QueueEntry, options?: { highlighted?: boolean; removable?: boolean }) {
    const displaySong = resolveDisplaySong(entry.song);
    const highlighted = options?.highlighted === true;
    const removable = options?.removable !== false;
    return (
      <div
        key={`${entry.song.id}-${entry.queueIndex}`}
        data-queue-index={entry.queueIndex}
        className={cn(
          "wf-list-row group flex items-center gap-3 rounded-lg px-2 py-2",
          highlighted ? "bg-white/[0.045]" : "hover:bg-white/[0.035]",
          dropTarget === entry.queueIndex && "ring-1 ring-inset ring-white/40",
        )}
      >
        <button
          type="button"
          aria-label={highlighted ? `Now playing ${displaySong.title}` : `Play ${displaySong.title}`}
          disabled={highlighted}
          onClick={() => handlePlayAt(entry.queueIndex)}
          className="wf-pressable flex min-w-0 flex-1 items-center gap-3 rounded-md bg-transparent text-left focus:outline-none touch-manipulation"
        >
          <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded">
            <CoverImage
              src={displaySong.imageUrl}
              networkSrc={displaySong.networkImageUrl}
              alt={displaySong.title}
              fill
              sizes="48px"
              className="wf-song-cover object-cover"
              loading="lazy"
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className={cn("block truncate text-sm", highlighted ? "font-semibold text-white" : "font-medium")}>
              {displaySong.title}
            </span>
            <span className="block truncate text-xs opacity-70">{displaySong.artist}</span>
          </span>
        </button>
        {removable ? <button
          type="button"
          aria-label={`Move ${displaySong.title}`}
          title="Drag to reorder, or use the up and down arrow keys"
          className="grid h-11 w-9 shrink-0 cursor-grab touch-none place-items-center rounded-lg text-white/45 hover:text-white active:cursor-grabbing"
          onTouchStart={(event) => event.stopPropagation()}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { from: entry.queueIndex, to: entry.queueIndex, songId: entry.song.id };
          }}
          onPointerMove={(event) => {
            if (!drag.current) return;
            const row = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-queue-index]");
            const target = row ? Number(row.dataset.queueIndex) : NaN;
            if (upNext.some((item) => item.queueIndex === target)) {
              drag.current.to = target;
              setDropTarget(target);
            }
            const panel = scrollContainerRef.current;
            if (panel) {
              const bounds = panel.getBoundingClientRect();
              if (event.clientY > bounds.bottom - 60) panel.scrollTop += 18;
              else if (event.clientY < bounds.top + 60) panel.scrollTop -= 18;
            }
          }}
          onPointerUp={(event) => {
            const move = drag.current;
            drag.current = null;
            setDropTarget(null);
            event.currentTarget.releasePointerCapture(event.pointerId);
            if (move && usePlayerStore.getState().queue[move.from]?.id === move.songId) moveQueuedSong(move.from, move.to, upNext.map((item) => item.queueIndex));
          }}
          onPointerCancel={() => { drag.current = null; setDropTarget(null); }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            event.stopPropagation();
            const position = upNext.findIndex((item) => item.queueIndex === entry.queueIndex);
            const target = upNext[position + (event.key === "ArrowUp" ? -1 : 1)];
            if (target) moveQueuedSong(entry.queueIndex, target.queueIndex, upNext.map((item) => item.queueIndex));
          }}
        ><GripVertical size={18} /></button> : null}
        {removable ? (
          <button
            type="button"
            aria-label={`Remove ${displaySong.title} from queue`}
            title="Remove from queue"
            onClick={() => removeFromQueue(entry.queueIndex)}
            className="wf-control-button h-9 w-9 shrink-0 rounded-full grid place-items-center text-foreground/70 hover:bg-black/10 hover:dark:bg-white/10 touch-manipulation"
          >
            <X size={18} />
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 transition",
        open ? "pointer-events-auto" : "pointer-events-none",
      )}
      aria-hidden={!open}
    >
      <button
        type="button"
        className={cn(
          "wf-sheet-backdrop absolute inset-0 bg-black/60 transition-opacity lg:block",
          open ? "opacity-100" : "opacity-0",
          "hidden lg:block",
        )}
        onClick={onClose}
        aria-label="Close queue"
      />

      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Playback queue"
        tabIndex={-1}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        className={cn(
          "wf-now-playing-panel absolute overflow-hidden bg-background",
          "inset-0 lg:inset-auto lg:left-0 lg:right-0 lg:top-14 lg:bottom-[84px] lg:mx-auto lg:max-w-3xl lg:border lg:border-black/10 lg:dark:border-white/10 lg:bg-background/95 lg:backdrop-blur-lg lg:rounded-t-2xl",
          open
            ? "translate-y-0 opacity-100"
            : "translate-y-full opacity-0 lg:translate-y-8 lg:opacity-0",
        )}
        data-open={open ? "true" : "false"}
      >
        <div
          ref={scrollContainerRef}
          className="h-full overflow-y-auto overscroll-contain pt-[env(safe-area-inset-top)] pb-[calc(env(safe-area-inset-bottom)+1rem)] lg:pt-0 lg:pb-0"
        >
          <div className="p-4 sm:p-6 min-h-full flex flex-col">
            {lastRemoval ? <div role="status" className="mb-3 flex items-center gap-3 border-b border-white/10 pb-2 text-sm">
              <span className="min-w-0 flex-1 truncate text-white/60">Removed {lastRemoval.song.title}</span>
              <button type="button" onClick={undoRemoval} className="min-h-11 px-3 font-semibold text-white">Undo</button>
            </div> : null}
            <div className="flex items-center justify-between mb-4 lg:mb-4">
              <button
                type="button"
                onClick={onClose}
                className="wf-control-button h-11 w-11 -ml-1 rounded-full grid place-items-center active:bg-black/10 dark:active:bg-white/10 touch-manipulation"
                aria-label="Close queue"
              >
                <ChevronDown size={24} />
              </button>
              <div className="text-xs uppercase tracking-wide opacity-70">Queue</div>
              <div aria-hidden className="h-11 w-11 -mr-1" />
            </div>

            <div className="max-w-md mx-auto w-full lg:max-w-none">
              {currentSong && currentIndex >= 0 ? (
                <>
                  <div className="text-xs uppercase tracking-wide opacity-70 mb-2">Now playing</div>
                  {renderRow(
                    { song: currentSong, queueIndex: currentIndex },
                    { highlighted: true, removable: false },
                  )}
                </>
              ) : null}

              <div className="text-xs uppercase tracking-wide opacity-70 mb-2 mt-6">Next up</div>
              {upNext.length === 0 ? (
                <div className="text-sm opacity-60 px-2 py-2">Nothing queued</div>
              ) : (
                <div className="space-y-1">{upNext.map((entry) => renderRow(entry))}</div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
