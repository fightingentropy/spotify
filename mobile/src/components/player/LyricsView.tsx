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
import { parseLrc, type LrcLine } from "@/lib/lrc";
import { activeLyricIndex, hasSyncedTiming } from "@/lib/lyrics";
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
export function LyricsView({ song }: { song: PlayerSong }) {
  const [lines, setLines] = useState<LrcLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLines(null);
    setError(null);
    if (!song.lyricsUrl) {
      setError("No lyrics available");
      return;
    }
    (async () => {
      try {
        const res = await fetch(toAbsoluteApiUrl(song.lyricsUrl), { credentials: "include" });
        if (!res.ok) throw new Error("No lyrics available");
        const raw = await res.text();
        if (!cancelled) setLines(parseLrc(raw));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "No lyrics available");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [song.lyricsUrl]);

  if (error) {
    return (
      <View className="items-center py-12">
        <Text style={{ color: colors.muted }}>{error}</Text>
      </View>
    );
  }
  if (!lines) {
    return (
      <View className="items-center py-12">
        <ActivityIndicator color={colors.emerald} />
      </View>
    );
  }
  if (hasSyncedTiming(lines)) {
    return <SyncedLyrics lines={lines} />;
  }
  // No usable timing data — keep the static plain-text rendering.
  return (
    <ScrollView contentContainerStyle={{ paddingVertical: 16 }}>
      {lines.map((line, i) => (
        <Text key={i} className="mb-3 text-[18px] font-semibold leading-7" style={{ color: colors.foreground }}>
          {line.text || "♪"}
        </Text>
      ))}
    </ScrollView>
  );
}

function SyncedLyrics({ lines }: { lines: LrcLine[] }) {
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
        return (
          <Pressable
            key={i}
            disabled={!timed}
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
            <Text
              className="py-1.5 text-[21px] font-bold leading-7"
              style={{ color: isActive ? colors.emerald : colors.dim }}
            >
              {line.text || "♪"}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
