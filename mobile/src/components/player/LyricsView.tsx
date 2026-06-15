import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { seekTo } from "@/audio/actions";
import { useAudioProgress } from "@/audio/progress";
import { toAbsoluteApiUrl } from "@/lib/config";
import { hasGreek, transliterateGreek } from "@/lib/greek-phonetics";
import { apiFetch } from "@/lib/http";
import { parseLrc, type LrcLine } from "@/lib/lrc";
import { activeLyricIndex, hasSyncedTiming } from "@/lib/lyrics";
import { usePlayerStore } from "@/store/player";
import { usePreferencesStore } from "@/store/preferences";
import { colors } from "@/theme";
import type { PlayerSong } from "@/types/player";

// Highlight slightly ahead of the audio clock so the line lands on the beat
// instead of trailing it (progress ticks at ~4Hz).
const SYNC_LOOKAHEAD_SEC = 0.25;
// How long after the user scrolls before auto-centering resumes.
const USER_SCROLL_HOLD_MS = 2_600;

// Fetches and renders a song's lyrics. Synced (.lrc with timestamps) files
// highlight the line being sung and keep it centered — pausing while the user
// scrolls — and seek when a line is tapped; plain files render as static text.
type LyricsState =
  | { status: "loading" }
  | { status: "finding" }
  | { status: "ready"; lines: LrcLine[] }
  | { status: "error"; message: string };

export function LyricsView({ song }: { song: PlayerSong }) {
  const [state, setState] = useState<LyricsState>({ status: "loading" });
  const replaceSong = usePlayerStore((s) => s.replaceSong);
  const greekPhonetics = usePreferencesStore((s) => s.greekPhonetics);
  // The last song we auto-requested lyrics for, so a 404 doesn't loop.
  const requestedRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Has a lyrics sidecar — load and parse it.
    if (song.lyricsUrl) {
      setState({ status: "loading" });
      (async () => {
        try {
          const res = await fetch(toAbsoluteApiUrl(song.lyricsUrl), { credentials: "include" });
          if (!res.ok) throw new Error("No lyrics available");
          const raw = await res.text();
          if (!cancelled) setState({ status: "ready", lines: parseLrc(raw) });
        } catch {
          if (!cancelled) setState({ status: "error", message: "No lyrics available" });
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    // No lyrics yet — ask the server to fetch them from the provider (once).
    if (requestedRef.current === song.id) {
      setState({ status: "error", message: "No lyrics found for this track" });
      return;
    }
    requestedRef.current = song.id;
    setState({ status: "finding" });
    (async () => {
      try {
        const res = await apiFetch(`/api/songs/${encodeURIComponent(song.id)}/lyrics`, { method: "POST" });
        if (res.ok) {
          const updated = (await res.json()) as PlayerSong;
          if (cancelled) return;
          if (updated?.lyricsUrl) {
            // Persist the resolved song so the rest of the app (and reopening
            // lyrics) sees it; this re-runs the effect to load the sidecar.
            replaceSong(updated);
            return;
          }
        }
        if (!cancelled) setState({ status: "error", message: "No lyrics found for this track" });
      } catch {
        if (!cancelled) setState({ status: "error", message: "Couldn't load lyrics" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [song.id, song.lyricsUrl, replaceSong]);

  if (state.status === "finding") {
    return (
      <View className="items-center py-12">
        <ActivityIndicator color={colors.emerald} />
        <Text className="mt-3 text-sm" style={{ color: colors.muted }}>
          Finding lyrics…
        </Text>
      </View>
    );
  }
  if (state.status === "loading") {
    return (
      <View className="items-center py-12">
        <ActivityIndicator color={colors.emerald} />
      </View>
    );
  }
  if (state.status === "error") {
    return (
      <View className="items-center py-12">
        <Text style={{ color: colors.muted }}>{state.message}</Text>
      </View>
    );
  }
  if (hasSyncedTiming(state.lines)) {
    return <SyncedLyrics lines={state.lines} greekPhonetics={greekPhonetics} />;
  }
  // No usable timing data — keep the static plain-text rendering.
  return (
    <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
      {state.lines.map((line, i) => {
        const phonetic = greekPhonetics && hasGreek(line.text) ? transliterateGreek(line.text) : null;
        return (
          <View key={i} className="mb-3">
            <Text className="text-[18px] font-semibold leading-7" style={{ color: colors.foreground }}>
              {line.text || "♪"}
            </Text>
            {phonetic ? (
              <Text className="mt-0.5 text-[15px] italic leading-6" style={{ color: colors.muted }}>
                {phonetic}
              </Text>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

function SyncedLyrics({ lines, greekPhonetics }: { lines: LrcLine[]; greekPhonetics: boolean }) {
  const { position } = useAudioProgress();
  const scrollRef = useRef<ScrollView>(null);
  // Y offset of each line within the scroll content (filled via onLayout).
  const lineOffsets = useRef<number[]>([]);
  const viewportHeight = useRef(0);
  // While now < this timestamp, the user is exploring — pause auto-centering.
  const userScrollUntil = useRef(0);

  const activeIndex = useMemo(
    () => activeLyricIndex(lines, position + SYNC_LOOKAHEAD_SEC),
    [lines, position],
  );

  // Center the active line, unless the user just scrolled.
  useEffect(() => {
    if (activeIndex < 0) return;
    if (Date.now() < userScrollUntil.current) return;
    const offset = lineOffsets.current[activeIndex];
    if (offset == null || viewportHeight.current === 0) return;
    scrollRef.current?.scrollTo({
      y: Math.max(0, offset - viewportHeight.current / 2),
      animated: true,
    });
  }, [activeIndex]);

  const onViewportLayout = (e: LayoutChangeEvent) => {
    viewportHeight.current = e.nativeEvent.layout.height;
  };

  // Dragging is the user taking over; hold off auto-centering for a beat.
  const onScrollBeginDrag = (_e: NativeSyntheticEvent<NativeScrollEvent>) => {
    userScrollUntil.current = Date.now() + USER_SCROLL_HOLD_MS;
  };
  // Refresh the hold from when the drag actually ends.
  const onScrollEndDrag = (_e: NativeSyntheticEvent<NativeScrollEvent>) => {
    userScrollUntil.current = Date.now() + USER_SCROLL_HOLD_MS;
  };

  return (
    <ScrollView
      ref={scrollRef}
      onLayout={onViewportLayout}
      onScrollBeginDrag={onScrollBeginDrag}
      onScrollEndDrag={onScrollEndDrag}
      scrollEventThrottle={16}
      contentContainerStyle={{ paddingTop: "35%", paddingBottom: "55%" }}
    >
      {lines.map((line, i) => {
        const timed = line.time >= 0;
        const isActive = i === activeIndex;
        const phonetic = greekPhonetics && hasGreek(line.text) ? transliterateGreek(line.text) : null;
        return (
          <Pressable
            key={i}
            disabled={!timed}
            style={{ paddingVertical: 6 }}
            onLayout={(e: LayoutChangeEvent) => {
              lineOffsets.current[i] = e.nativeEvent.layout.y;
            }}
            onPress={() => {
              if (!timed) return;
              // Let the highlight follow the seek immediately rather than
              // waiting out the user-scroll hold from this tap.
              userScrollUntil.current = 0;
              void seekTo(line.time);
            }}
          >
            <Text className="text-[21px] font-bold leading-7" style={{ color: isActive ? colors.emerald : colors.dim }}>
              {line.text || "♪"}
            </Text>
            {phonetic ? (
              <Text
                className="mt-0.5 text-[16px] font-semibold italic leading-6"
                style={{ color: isActive ? "rgba(16,185,129,0.7)" : "rgba(255,255,255,0.32)" }}
              >
                {phonetic}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
